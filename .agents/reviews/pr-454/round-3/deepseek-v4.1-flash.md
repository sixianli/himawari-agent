## 读代码证实的发现

### 1. 中：`reopen` 的总转换量仍没有上限，`settle()` 会先无界转换
- 文件：`packages/application/src/services/device-action-service.ts:552-564`、`packages/persistence-sqlite/src/sqlite-device-action-operations.ts:233-268`
- 问题：作者的说法 3 只对 `forget` 成立。`reopen` 第一行 `await this.settle()` 会让 `settleDue` 把**所有**已到期动作一次性转换，`settleDue` 的查询没有 `LIMIT`，随后 `settle` 为每条记录写一条 ledger。设备离线很久、积累大量已到期 `delivered` 动作后调用一次 `actions/open`，仍可能一次完成大量更新和 ledger 写入，绕过 `actionClaimBatch` 的限流。
- 证据：
  ```ts
  // device-action-service.ts:552-555
  async reopen(deviceId: string): Promise<readonly DeviceActionDelivery[]> {
    await this.settle();
    const now = this.#options.now();
    const reopening = await this.#options.store.forget({
  ```
  ```ts
  // sqlite-device-action-operations.ts:236-241
  `SELECT id, state FROM device_actions
    WHERE owner_id = ? AND agent_id = ? AND expires_at <= ?
      AND state IN ('waiting_owner', 'queued', 'delivered')
    ORDER BY created_at, id`,
  ```
  这里没有 `LIMIT`；`device-action-service.ts:283-286` 又对全部结果逐条 `#ledger`。
- 建议：给 `settleDue` 增加上限并分批推进，或在 `reopen` 中只做有界结算；补一条“到期动作数大于 `actionClaimBatch`，一次 `actions/open` 只处理一批”的反向用例。

### 2. 中：`pending` 取的是全部旧 `result_unknown`，本次刚转换的动作可能永远轮不到返回
- 文件：`packages/persistence-sqlite/src/sqlite-device-action-operations.ts:353-379`
- 问题：`forget` 先按 `LIMIT` 选出一批 `delivered` 转成 `result_unknown`，然后 `pending` 却从**全部** `result_unknown` 里按 `created_at, id` 取前 `limit` 条，而不是优先返回本次 `forgotten`。如果设备上已有至少 `limit` 条更老的 `result_unknown`，本次新转换出来的动作不会出现在响应里。设备若只调用一次 `actions/open`，这些动作永远不会被读回核实；多次调用时还会反复拿回同一批最老记录，新转换的继续被压在后面。
- 证据：
  ```ts
  // 353-359：转换本次选中的 delivered
  `SELECT id FROM device_actions
    WHERE owner_id = ? AND agent_id = ? AND device_id = ? AND state = 'delivered'
    ORDER BY created_at, id LIMIT ?`
  ```
  ```ts
  // 370-378：返回的却是全部 result_unknown 的最老一批
  `SELECT ${columns} FROM device_actions
    WHERE owner_id = ? AND agent_id = ? AND device_id = ? AND state = 'result_unknown'
    ORDER BY created_at, id LIMIT ?`
  ```
- 建议：让本次 `forgotten` 优先进入响应（例如先返回 `forgotten`，剩余名额再取旧 `pending`），或用游标分页推进旧 `result_unknown`，避免永远重复最老一批。测试应覆盖“已有 `result_unknown` 数量 ≥ limit”以及连续两次 `actions/open` 的推进。

### 3. 低-中：重放保护只在 `readInvocation` 分支生效，`insert` 的重放路径可绕过；参数也没校验
- 文件：`packages/application/src/services/device-action-service.ts:320-326`、`:434-439`，`packages/persistence-sqlite/src/sqlite-device-action-operations.ts:128-134`
- 问题：顺序重放会检查设备编号和动作名，但并发或重试进入 `store.insert` 时，存储层只按 `run_id + tool_call_id` 找旧记录就返回 `replayed`，服务层 `inserted.kind !== "created"` 分支直接返回旧结果，没有再比较设备和动作。这样作者说法 1 的“设备编号或动作名不同就不返回旧记录”在该路径不成立。另外，同一工具调用换了参数（动作名相同）也会直接返回旧结果，未比较参数或指纹。
- 证据：
  ```ts
  // device-action-service.ts:434-439
  if (inserted.kind !== "created") {
    await this.#options.content.discard(argumentsRef);
    if (inserted.record.state === "result_unknown" || inserted.record.state === "queued")
      this.#options.delivery.announce(inserted.record.deviceId);
    return this.#outcome(inserted.record);
  }
  ```
  ```ts
  // sqlite-device-action-operations.ts:128-134
  `SELECT ... FROM device_actions
    WHERE owner_id = ? AND agent_id = ? AND run_id = ? AND tool_call_id = ?`
  if (replayed) return { kind: "replayed", record: toRecord(replayed) };
  ```
- 建议：抽出一个统一的 `#replay(record, input)` 校验，`readInvocation` 和 `insert` 的 `replayed` 分支都走它；至少校验 `deviceId`、`action`，并用已保存参数或 `fingerprint` 校验参数是否一致。

### 4. 低：`forget` 提交后才写 ledger，ledger 失败会永久漏记
- 文件：`packages/application/src/services/device-action-service.ts:555-564`
- 问题：`store.forget` 在数据库事务里完成 `delivered -> result_unknown` 后，服务层才逐条 `#ledger`。如果某次 ledger 写入失败，转换已经提交；设备重试 `actions/open` 时 `forgotten` 为空，这些动作不会再被补记，作者说法 3 的“每条被转换的动作都写一条决策记录”在错误路径上不成立。`delivery.settled` 也会被跳过。
- 证据：
  ```ts
  const reopening = await this.#options.store.forget({...});
  for (const record of reopening.forgotten) {
    await this.#ledger(record);
    this.#options.delivery.settled(record.id);
  }
  ```
- 建议：把 ledger 写入放进同一个事务，或让 `forget` 返回“已转换但未记 ledger”的记录并在重试时补记；补一条 ledger 写入失败的用例。

### 5. 低：`insert` 非 `created` 分支的 `discard` 没有保护，会盖掉真实结果
- 文件：`packages/application/src/services/device-action-service.ts:434-435`
- 问题：本轮给 `insert` 抛错和 `report` 抛错的清理加了 `.catch(() => undefined)`，但 `insert` 返回 `replayed` / `open_duplicate` 时，这里的 `discard(argumentsRef)` 仍可能抛错，导致一个已经成功重放的动作被清理错误掩盖。
- 证据：
  ```ts
  if (inserted.kind !== "created") {
    await this.#options.content.discard(argumentsRef);
  ```
- 建议：同样改为 `.catch(() => undefined)`（或记录日志后继续返回既有结果），保持错误路径一致。

### 6. 低：新增测试没有覆盖“清理自身失败”和“旧 `pending` 挤占”的反向路径
- 文件：`test/integration/device-actions.test.ts:704-780`，另见 `:672-700`
- 问题：作者说法 2 的重点是“清理即使自己出错，上抛的仍是原来的错误”，但新增的 report 反向用例用的是正常的 content/payload 端口，`discard` 实际会成功，所以去掉新加的 `.catch(() => undefined)` 这条用例仍会通过。它证明的是“清理发生了”，不是“清理失败时原始错误不被覆盖”。同样，reopen 用例只测第一次调用且此前没有 `result_unknown`，没有覆盖发现 2 的旧记录挤占；也没有覆盖发现 1 的 `settleDue` 无界。
- 证据：
  ```ts
  // 759-775：store 失败，但 payloads/protector 仍用正常仓库
  store: full.deviceActions(),
  payloads: h.repository.payloadStore(ownerId, agentId),
  protector: h.protector,
  ```
- 建议：注入一个 `discard` 会 reject 的 content 端口，断言仍抛原始 `disk_headroom`；再加“已有 ≥ limit 条 `result_unknown`”和“第二次 `actions/open`”的用例。

### 7. 低：设计文档说重装后“全部按结果未知处理，不执行”，代码只处理 `delivered`
- 文件：`docs/execution/specs/2026-11-11-apple-device-body-design.md:545-546`、`packages/persistence-sqlite/src/sqlite-device-action-operations.ts:355-358`
- 问题：文档第 6 条要求设备重装后把“自己名下还没了结的动作全部按结果未知处理，不执行”。`forget` 只查询 `state = 'delivered'`，`queued` / `waiting_owner` 不会被转换；之后 `claim` 仍可能把 `queued` 动作下发给重装后的设备执行。这与文档不一致，且涉及“重装后是否还执行旧动作”的产品决定。
- 证据：
  ```sql
  WHERE owner_id = ? AND agent_id = ? AND device_id = ? AND state = 'delivered'
  ```
- 建议：确认产品意图。若要遵守文档，`forget` 应同时处理 `queued` / `waiting_owner` 的未了结动作；若只处理已送达动作，则应改文档，说明重装后排队动作仍会执行。

## 推测 / 未核实

- 发现 1 的“大量到期动作”实际规模取决于设备积压量，未在测试或生产数据中复现。
- 发现 3 的 `insert` 重放竞态需要同一 `run_id + tool_call_id` 的并发或异常重试，属于代码路径推断，未实际并发复现。
- 发现 4 的 ledger 失败依赖决策记录写入失败，未触发。
- 未运行任何测试，也未运行 `npm run check:prompt-prefix`；以上都是读代码结论。
- iOS/Swift 侧是否会多次调用 `actions/open`、是否依赖“全部未了结动作都返回”，本仓库内未核实。

## 侧重检查

- **错误路径**：`insert` / `report` 的清理错误已被吞掉，但 `insert` 非 `created` 分支（`:435`）仍会外抛；`forget` 的 ledger 在事务外，存在转换成功但审计缺失的窗口。
- **不合规范输入**：`forget` 的 `limit` 在存储层要求安全整数且 `1..500`，配置层 `actionClaimBatch` 的范围是 `1..200`，两端兼容；`report` 的 id、outcome、readBack、evidence、reason 长度和 64 KiB 上限均仍在入口校验。
- **安全 / 作用域**：`forget` / `report` 的 SQL 都按 `owner_id + agent_id + device_id` 限定，`forget` 的更新虽只按 `id`，但 `id` 来自已限定作用域的查询，未发现跨租户更新。
- **资源耗尽**：`forget` 本身受 `limit` 限制，但 `reopen` 先调用无界 `settleDue`（发现 1）；`pending` 最多返回 `limit` 条，但旧记录会挤占新记录（发现 2）。
- **不可撤销操作**：`delivered -> result_unknown` 是单向转换；`actions/open` 可批量触发，当前没有除 `limit` 之外的速率限制，设备被攻破或客户端异常时可能把自己的在途动作全部变成未知。
- **规则/文档一致性**：`device_action`、`perception_read` 的工具定义仍是固定文字，动态设备/动作列表只出现在 `describe` 工具结果里，符合 `.claude/rules/prompt-prefix.md` 第 7 条；但重装语义与设计文档第 6 条不一致（发现 7）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会（本轮 diff 范围内）。本轮没有改系统提示或工具定义；新增的原因文字在 `packages/prompt-catalog/src/perception.ts` 中登记为 `layer: "tool-result"` 的固定文字，由 `device-action-service.ts` 放进工具结果。设备/动作列表仍是 `describe` 的工具结果，不是工具定义。按代码结构，发给模型的内容仍只在末尾追加，每轮变化的值（设备动作结果、读回证据、原因）都在工具结果里。未运行 `check:prompt-prefix`。

2. **同一段文字会不会在不同请求里变成不同的字节？**
   不会由本轮改动引入。`forget` 的查询有 `ORDER BY created_at, id`，`limit` 是确定的；ledger id 由记录 id 和状态拼成；数据导出也按 `created_at, id` 排序。没有新增时间字段、随机集合或依赖前后文的遮盖。`forget` 返回哪些记录会依赖调用历史，但同一记录每次序列化的字段和值不变。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有 3 条新增集成用例。按代码路径，撤掉“重放时 `announce`”会让重放用例等不到第二次 `claim`；撤掉 `forget` 的 `limit` 会让 reopen 用例看到 3 条 `result_unknown`、3 条 ledger，从而失败。
   但清理相关的反向用例只证明“清理会执行、原始错误会保留”，没有让 `discard` 自身失败，因此没有覆盖本轮新加的 `.catch(() => undefined)`；也没有覆盖“已有旧 `result_unknown` 挤占新转换记录”和“`settleDue` 无界转换”。这些点没有对应的失败用例。

4. **每个新值两端都能接受吗？**
   - `limit`：产生端是 `settings().claimBatch` → `configuration.actionClaimBatch`（`production-device-actions.ts:104`），配置范围 `[1,200]`（`perception.ts:418`）；消费端 `sqlite-device-action-operations.ts:349` 校验安全整数且 `1..500`，兼容。
   - `DeviceActionReopening`：端口定义在 `device-actions.ts:102-105,162-168`，生产端 SQLite 返回，唯一调用方是 `DeviceActionService.reopen`（grep 未发现其他 `forget(` 调用方），两端字段一致。
   - `forgotten` / `pending`：都是 `DeviceActionRecord`；`forgotten` 的状态 `result_unknown` 在 `DEVICE_ACTION_RECORD_STATES`、decision ledger 允许的 device_action outcome、`MODEL_REASONS` 和数据库 CHECK 中都有登记。`pending` 进入 `#delivery` 后按 `result_unknown` 生成 `verify`，类型匹配。
   - HTTP：`actions/open` 仍返回 `DeviceActionDelivery[]`，路由未改形状（`device-api-routes.ts:626-631`）。
   - 数据导出：`deviceActions` / `devicePolicies` 的 schema 枚举直接复用应用层常量，snapshot/export 列名对应；没有发现字段名或枚举不一致，但没有运行导出校验测试。
   - `actionClaimBatch` 的配置键、`deviceActions.forget` 的持久化操作名、ledger 的 `device_lost_record` 原因码都在现有清单里，未发现 I-73 式的“一端产生、另一端校验不接受”问题。
