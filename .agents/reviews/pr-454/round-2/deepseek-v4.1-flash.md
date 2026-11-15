## 结论概览

本轮增量没有发现会改变模型请求开头的改动；但发现 **1 条行为回归（重放不再通知设备）**、**1 条重放边界问题**，以及几条错误路径/测试覆盖和资源边界问题。测试未运行（工具限制），以下“会失败/不会失败”均按代码推断。

---

## 问题（按严重度从高到低）

### 1. 中 — 同 `tool_call_id` 的重放不再向设备发 `device.actions` 信号，排队动作可能不送达、`result_unknown` 可能不被读回核实

- 文件：`packages/application/src/services/device-action-service.ts:315-320`
- 问题：新增的提前重放直接返回结果，绕过了原来在 `insert` 返回 `replayed` 时的 `delivery.announce`。设备只有在收到 `device.actions` 帧后才 claim/verify（测试夹具里就是如此）。
- 证据：
  ```ts
  // device-action-service.ts:315-320（新）
  const replayed = await store.readInvocation({ ...scope, runId: input.runId, toolCallId: input.toolCallId });
  if (replayed) return this.#outcome(replayed);

  // device-action-service.ts:428-432（旧逻辑仍在，但正常重放走不到）
  if (inserted.kind !== "created") {
    await this.#options.content.discard(argumentsRef);
    if (inserted.record.state === "result_unknown" || inserted.record.state === "queued")
      this.#options.delivery.announce(inserted.record.deviceId);
    return this.#outcome(inserted.record);
  }
  ```
  `readInvocation` 和 `insert` 的查找条件完全相同（`sqlite-device-action-operations.ts:127-133,193-200`），所以正常重放都会在 `:315-320` 返回；`:428-432` 只剩并发竞争时才有机会执行。测试夹具只在 `event: device.actions` 时 claim（`test/fixtures/perception-test-client.ts:238-239`）。
- 影响：例如动作已 `result_unknown` 后模型用同一 `tool_call_id` 重试，旧代码会再次通知设备去核实；新代码只把旧状态返回给模型，设备可能一直不去 verify。排队动作同理可能延迟送达。
- 建议：在提前重放分支保留 `queued`/`result_unknown` 的 `delivery.announce(replayed.deviceId)`，并补一条“同一 `tool_call_id` 重放后设备收到新的 `device.actions` 帧”的测试。

### 2. 中低 — 重放只按 `run_id + tool_call_id` 命中，不校验设备、动作名或参数是否与当前请求一致

- 文件：`packages/application/src/services/device-action-service.ts:315-320`；`packages/persistence-sqlite/src/sqlite-device-action-operations.ts:193-200`
- 问题：SQL 只按 `owner_id, agent_id, run_id, tool_call_id` 查记录，没有比较 `device_id`、`action` 或参数。提前重放又发生在 `registry.get`、参数校验、目标解析之前，所以同一个 `tool_call_id` 被用于另一个设备/另一个动作时，会把原动作的 `state`、`reason`、`evidence`、`detail` 当作当前动作的结果返回。
- 证据：
  ```sql
  -- sqlite-device-action-operations.ts:193-200
  SELECT ... FROM device_actions
   WHERE owner_id = ? AND agent_id = ? AND run_id = ? AND tool_call_id = ?
  ```
  ```ts
  // device-action-service.ts:315-320
  const replayed = await store.readInvocation({ ... });
  if (replayed) return this.#outcome(replayed);
  ```
  旧实现至少会先经过动作名、参数和目标校验，再在 `insert` 内重放；现在未知动作名或目标已消失也会先命中旧记录。
- 影响：如果运行时的 `tool_call_id` 出现碰撞、被复用，或调用方伪造历史工具调用，模型会收到另一个动作的结果；同一 owner 内还可能跨设备返回错误结果。跨租户风险没有（有 `owner_id/agent_id` 限定）。
- 建议：至少校验 `replayed.deviceId === input.device.id` 且 `replayed.action === input.action`，不匹配时返回 `invalid`/冲突，而不是静默重放；如要严格按参数幂等，可再比对指纹。

### 3. 低（推测）— 写入失败清理会在“已提交但响应丢失”时误删仍在使用的参数或结果载荷

- 文件：`packages/application/src/services/device-action-service.ts:424-427,620-623`
- 问题：`catch` 对任何 `insert`/`report` 异常都无条件 `discard` 刚保存的载荷，但 SQLite 写操作在 worker 中执行；worker 可能已提交事务、随后在回传响应前退出，调用方仍收到异常。
- 证据：
  ```ts
  .catch(async (error: unknown) => {
    await this.#options.content.discard(argumentsRef);
    throw error;
  });
  ```
  ```ts
  // sqlite-execution-context.ts:90-100
  worker.on("exit", (code) => {
    this.exited = true;
    if (this.pending.size > 0) this.failAll(...WORKER_EXITED...);
  });
  ```
  这种情况下 `device_actions` 行可能已经提交并引用 `argumentsRef`；删除载荷要么被 `REFERENCES payloads(ref) ON DELETE RESTRICT` 拒绝（并掩盖原始错误），要么留下一个缺少参数/结果的已提交动作。`report` 同理，可能删掉已提交记录引用的 `resultRef`。
- 建议：只在确定是应用层拒绝（例如 `PORT_INVALID_OPERATION`、设备不活跃等）时丢弃；对 worker 退出、超时等不确定失败，先重新读取记录，确认没有记录引用该 `ref` 再删，或把载荷与记录写入放进同一事务。
- 严重度说明：这是代码推断，未构造 worker 提交后崩溃的用例；但属于不可撤销动作的错误路径，值得确认。

### 4. 低 — 作者声称的 `store.report` 失败清理没有对应的自动检查

- 文件：`test/integration/device-actions.test.ts:604-700`
- 问题：新增的失败清理测试只有 `store.insert` 抛错（`:667` 的 `[reverse] an action that could not be recorded ...`）。没有 `store.report` 抛错时删除结果载荷的反向用例，claim 3 的后半句目前只靠代码阅读，没有被测试锁住。
- 建议：用一个让 `store.report` 抛 `ApplicationPortError` 的 stub，或在持久层强制 `assertDiskHeadroom`/SQL 失败，断言 `device-action:*:result:*` 载荷被删除且没有留下记录。

### 5. 低 — `/actions/open` 无上限返回所有 `result_unknown` 记录

- 文件：`packages/platform-node/src/device-api-routes.ts:626-631`；`packages/application/src/services/device-action-service.ts:546-560`；`packages/persistence-sqlite/src/sqlite-device-action-operations.ts:345-367`
- 问题：`reopen` 调 `forget`，`forget` 先更新该设备所有 `delivered`，再 `SELECT ... state = 'result_unknown'` **没有 LIMIT**；`reopen` 又对每条记录调用 `#delivery` 读取参数和明细。设备记录多或反复调用 `/actions/open` 时，响应、数据库读取和解密工作量无上限。
- 证据：
  ```sql
  -- sqlite-device-action-operations.ts:361-365
  SELECT ... FROM device_actions
   WHERE owner_id = ? AND agent_id = ? AND device_id = ? AND state = 'result_unknown'
   ORDER BY created_at, id
  ```
- 建议：像 `claim` 一样加 `LIMIT`，并在 route/service 层限制单次返回数量；或让设备分页拉取。

### 6. 低（迁移兼容）— 旧记录不会按新规则重算指纹

- 文件：`packages/application/src/services/device-action-registry.ts:153-162`
- 问题：指纹算法从“列表按原顺序”改为“列表排序后”。部署前已存在的同参数、不同列表顺序的开放记录仍保留旧指纹；部署后用不同 `tool_call_id` 再发起同一组值时，不会命中 `open_duplicate`，可能多出一条动作。
- 证据：
  ```ts
  return [key, Array.isArray(value) ? [...(value as string[])].sort() : value];
  ```
- 建议：如果这个 PR 上线前已有 device action 数据，迁移时重算/回填指纹，或接受旧记录到期后自然消失；如果从未上线过该功能，可忽略。

---

## 侧重检查

- **错误路径**：`insert` 失败清理有测试且能触发（设备已吊销）；`report` 失败清理无测试。两者都采用“任何异常即删除载荷”，存在上面第 3 条的提交/响应不确定问题。
- **不合规范或不可信输入**：`report` 校验了额外字段、`id` 格式、`outcome` 枚举、`readBack` 类型、`reason` 长度 500、`evidence` 64 KiB（`device-action-service.ts:566-584`）；`reportSupported` 把设备上报的任意动作名过滤到登记表（`:635-651`）；`changePolicy` 要求动作名在登记表内且不重复（`:676-685`）。SQL 全部参数化，未发现注入。
- **安全**：新增设备路由都在 `DEVICE_API_ROUTES` 标为 `signed: true`（`device-api-routes.ts:46-70`）；策略修改要求 `authenticated.confirmed`（`:669-686`）。重放不校验设备/动作是上面第 2 条的边界风险。
- **资源耗尽**：`/actions/open` 无上限是主要一项；另外 `#action` 会为每台设备调用一次 `service.offered`（每次读策略），设备多时是 N 次读，但通常有配对上限。
- **不可撤销的操作**：重放不再通知设备（第 1 条）会延迟不可撤销动作的送达/核实；清理误删（第 3 条）则可能让已排队动作缺少参数。两者都建议在合入前确认。
- **规则/文档与代码一致性**：
  - `DEVICE_ACTION_TRANSITIONS`、`deviceActionTransitionAllowed` 全仓库已无引用（grep 无结果），作者说法 4 成立；SQL 中的 `WHERE state` 与旧转换表一致。
  - `perceptionToolDescriptors()` 仍是固定文字，不随设备/策略变化（`production-perception-tools.ts:98-143`），符合 `prompt-prefix.md` 第 46 行。
  - 未发现文档再引用已删除的转换常量；`docs/execution/specs/2026-11-11-apple-device-body-design.md:733` 只说“状态只按登记的几种转换”，与 SQL 约束不冲突。
  - `prompt-manifest.json` 新增的 11 条 reason 文本哈希未能计算核对（只读工具无法跑 sha256），标“未核实”。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**没有发现会改变。** 本次唯一模型可见的变化是未知动作分支里的 `availableActions`，它只作为 `device_action` 的 tool result 值返回（`production-perception-tools.ts:485-494`），并且新增的原因文本都是 `layer: "tool-result"`（`packages/prompt-catalog/src/perception.ts:305` 起），由 `DeviceActionService.#outcome` 放进结果（`device-action-service.ts:289-303`）。工具定义仍是固定文字（`production-perception-tools.ts:98-143`），没有改系统提示、历史消息或工具定义。
**发给模型的内容仍然只在末尾追加**；`availableActions` 取决于当前设备和策略，但它只出现在本次追加的工具结果里。前提是现有运行时确实把工具结果追加在末尾；本次改动没有把它挪到前面。
**注意**：新增固定提示词会改变“固定文字白名单”，理论上若旧历史里的外部内容恰好与这些新文本逐字相同，遮盖可能变化；这种碰撞未发现，标“未核实”。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会因本次改动产生新的不确定序列化。** `availableActions` 来自按名字排序的登记表（`production-perception-tools.ts:448-450`）和 `supportedBy` 的排序结果；`deviceActionFingerprint` 现在对顶层数组排序（`device-action-registry.ts:153-162`），同一组字符串列表值得到相同指纹。指纹、ID、时间、`resultRef` 都不进入模型可见正文。`device_policies.blockedActions` 写入时也排序去重（`sqlite-device-action-operations.ts:101-109`）。
唯一会随请求变化的是设备支持/策略本身，但那是新追加的工具结果，不是改写旧文字。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

按代码推断：

- 指纹列表顺序：`test/integration/device-actions.test.ts:605` 的 `[reverse]` 用例会失败于“未排序指纹导致第二条记录/第二次 perform”的场景——会失败。
- 同一 `tool_call_id` 重放：`:646` 用例会失败于“目标已从 mirror 删除时旧实现返回 target unknown”——会失败。
- `insert` 抛错清理：`:667` 用例会失败于“payloads 里仍留有 `device-action:%`”——会失败。
- 未知动作按策略过滤：`:888-894` 用例会失败于旧实现仍列出被策略关掉的动作——会失败。
- 缺少的检查：**`store.report` 抛错清理无测试**；**同一 `tool_call_id` 重放时是否重新 announce 无测试**；**重放参数/设备不匹配无测试**。
- 我未能运行测试，只能按代码路径判断。

### 4. 每个产生/修改的值，使用它的地方都能接受吗？

核对结果：

- **新 ledger kind `device_action`**：`DECISION_KINDS` 包含（`ports/decision-ledger.ts:32-44`），`DECISION_OUTCOMES.device_action` 包含 9 种 outcome（`:78-88`），持久层 `validateLedgerWrite` 用它校验（`sqlite-decision-ledger-operations.ts:53-60`），迁移 0097 的 `decision_ledger` CHECK 包含该 kind 和 outcome（`0097_device_actions.sql:24-90`），导出 `DECISION_SCHEMA` 用 `DECISION_KINDS`，gateway contracts 也加了 `device_action`（`contracts-v2.ts:1431-1434`），三语 i18n 和 `daily-review` 排除也同步。一致。
- **`policy_changed`**：只出现在 ledger outcome，不在 `device_actions.state` CHECK；迁移和 `DECISION_OUTCOMES` 都允许，一致。
- **11 个 reason code**：`MODEL_REASONS` 是穷尽 `Record<DeviceActionReasonCode, ...>`（`device-action-service.ts:53-65`），导出 schema 用 `DEVICE_ACTION_REASON_CODES`，DB reason_code CHECK 与它一致；prompt-manifest 有 11 条对应条目（哈希未核实）。
- **`readInvocation` 操作名**：端口、`SqliteDurableAdapters`、`SqliteDeviceActionOperations.execute`、`SqliteDurableOperations` 前缀路由都已加；未发现其他 `DeviceActionStorePort` 实现。
- **新导出文件/字段**：`snapshot.ts` 的 SQL 列与 `export.ts` 读取的字段对齐；`schemas.ts`、`types.ts`、`MANIFEST_SCHEMA`、`PERCEPTION_FILE_KEYS` 都同步；`result`/`request` 在 schema 里是可空的 `exportedPayload`。一致。
- **HTTP 路由**：`DEVICE_API_ROUTES` 与 `registerDeviceApiRoutes` 里的路径一一对应且签名；生产组合按 owner/agent 返回服务实例。一致。
- **边界值**：`approvalId` 由授权端口产生，DB 限制 1–128，服务层未校验；当前 `ReadOnlyDeviceActionAuthorization` 不会产生 approval，但以后接审批时需补。`toolCallId` 来自运行时，DB 限制 1–256，服务层也未校验；若 provider 产生超长 ID，会在 `insert` 失败并触发清理。这两点标“需要确认”，未发现现有调用会越界。

---

## 未核实

- `prompt-manifest.json` 新增 11 条 reason 文本的 SHA-256 是否正确（无法运行 sha256 校验）。
- worker 在事务提交后、回传响应前退出的清理场景（第 3 条）是代码推断，未构造实际用例。
- 生产设备是否还有 SSE 之外的 claim 机制；如果存在轮询，第 1 条的严重度会降低。
