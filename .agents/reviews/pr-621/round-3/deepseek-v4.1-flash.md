本轮复核范围：`git diff 8b5522..90dc397` 的增量（实际只有 review 记账、文档/原型、以及把 main 的 PR 405/618/619 合并进来），以及当前代码里 PR 621 的收件箱、迁移、设置、worker、集成测试；另外抽查了 gateway 契约、Swift 设置页和相关规则文档。

结论先说：**`8b5522..90dc397` 没有改动任何 PR 621 收件箱文件**（对 `production-inbox*.ts`、`inbox.ts`、`sqlite-inbox-operations.ts`、`inbox_events.sql`、`inbox.test.ts` 的 diff 为空）。因此上一轮意见的代码状态与 `8b5522` 完全相同，本次无法从增量确认“已改好”。

### 1. 中：增量没有 PR 621 代码，不能据此认定上一轮意见已修好

文件:行：无具体行；`git diff 8b5522..90dc397 -- apps/agent-service/src/production-inbox.ts apps/agent-service/src/production-inbox-worker.ts apps/agent-service/src/production-inbox-composition.ts apps/agent-service/src/production-inbox-settings.ts packages/application/src/ports/inbox.ts packages/persistence-sqlite/src/sqlite-inbox-operations.ts packages/persistence-sqlite/src/migrations/20261124153216_inbox_events.sql test/integration/inbox.test.ts` 输出为空。

问题：这一轮要求先看“上一轮意见是否真的改好了”，但增量里 PR 621 的代码一行没动；`8b5522..90dc397` 里的提交主要是 `Merge remote-tracking branch 'origin/main'`、PR 405/618/619 和 review 记账。把主分支合进来不等于修了上一轮的收件箱意见。

证据（读代码证实）：`git diff --stat 8b5522..90dc397` 中出现的代码文件是 `context-external-content.ts`、`owner-scope-authorization.ts`、`action-rules.ts`、设备动作等，没有任何 `inbox` 文件；收件箱文件只在 `ed3f8d0..90dc397` 的整份 PR 差异里出现。

建议：如果上一轮有收件箱意见，应按当前代码逐条重新核对；本次报告只能确认“相对于 8b5522 没有回归/新增”，不能确认旧意见已修。

### 2. 中：收件箱的关键错误路径缺少自动反向用例

文件:行：`test/integration/inbox.test.ts:355-371`（重试/yield）、`:475-507`（只在写入后唤醒）、`:287-309`（20 件分批，时间戳用 `index * 1000`）。

问题：作者说法 1、2、3 都有实现，但对应最容易回归的分支没有自动检查：
- 说法 1 的“同毫秒按 `rowid` 排序”没有用例；分批测试里每条相隔 1 秒。
- 说法 2 的“服务关闭（`signal.aborted`）时放回、不记尝试”没有用例；现有测试只覆盖 `delivery` 抛普通错误、`retry`、`yield`。
- 说法 3 的“重复写入不唤醒”和“恢复卡住条目后唤醒”没有反向用例；唤醒测试只覆盖新写入 `woken` 一条。

证据（读代码证实）：重试测试用 `{ status: "retry" }` 和 `{ status: "yield" }`（`:359`、`:367`），没有传 `AbortSignal`；唤醒测试只提交一次 `mail("woken")` 并等待送达（`:502-503`）；分批测试用 `new Date(Date.parse(START) + index * 1000)`（`:291`）。worker 的 abort 分支在 `production-inbox-worker.ts:202-206`，`#announce` 只在 `outcome === "queued"` 时调用（`production-inbox.ts:240-242`），`maintain` 只在 `recovered > 0` 时调用（`:282`）。

建议：补三条测试：同一毫秒两条的取用顺序；`handle` 中途 abort 后行回到 `queued` 且 `attempts` 不变；重复 `submit` 不触发监听、`recoverStalled` 恢复后触发监听。这样反向改坏实现时会真的失败。

### 3. 低：`InboxLoop` 可无上限并发处理，`yield` 还可能被同一循环连续取回

文件:行：`apps/agent-service/src/production-inbox-worker.ts:279-301`、`:194-197`。

问题：`#tick` 在 `for(;;)` 里 `claim()` 后立即启动 `handle()` 并把 promise 放进 `#inflight`，从不等待也不限制数量。不同对话会同时跑很多批。更麻烦的是 `yield` 会把行放回 `queued` 且不记尝试；循环没有因为 `yield` 停下，下一轮 `claim()` 可能马上又取到同一行，形成快速的取回—放回循环。生产现在没有 delivery，所以还没触发；接上 delivery 后会变成资源耗尽风险。

证据（读代码证实）：
```ts
const handling = this.#worker
  .handle(claim, signal)
  ...
this.#inflight.add(handling);
```
以及
```ts
if (result.status === "yield") {
  await store.release({ ...scope, ids: deliveredIds, countAttempt: false, now: clock.now() });
  return { status: "done", entryIds: ids, result: "yield" };
}
```
`#inflight` 只用于 `stop()`，没有任何上限判断。

推测：如果 delivery 在预算耗尽时立即返回 `yield`，这个循环会持续调度同一行；即使不是死循环，也会同时压很多次运行，和设计里“服务器最多同时跑 3 趟”的约束只靠 delivery 层兜底。

建议：给 `#inflight` 设上限，或至少在 `yield` 后不再立即取同一批/同一行，等下一次定时或显式唤醒。

### 4. 低：`ruleSource` 在 base 很长时仍会截掉对话来源，和这次修复意图相反

文件:行：`apps/agent-service/src/production-owner-rules.ts:621-627`。

问题：这次增量把“出处超长时保留对话来源”改成了保留 `tail = "|" + base`，但当 `base` 很长时 `room` 会小于等于 17，代码走 `kept = origins`，最后 `slice(0, 256)` 从前面截断，仍会把 `base` 整个切掉。

证据（读代码证实）：
```ts
const tail = `|${base}`;
const room = RULE_SOURCE_LIMIT - EXTERNAL_CONTENT_SOURCE_REF_PREFIX.length - tail.length;
const kept =
  origins.length <= room || room <= RULE_SOURCE_DIGEST + 1
    ? origins
    : `${origins.slice(0, room - RULE_SOURCE_DIGEST - 1)}~${hash(origins).slice(0, RULE_SOURCE_DIGEST)}`;
return `${EXTERNAL_CONTENT_SOURCE_REF_PREFIX}${kept}${tail}`.slice(0, RULE_SOURCE_LIMIT);
```
`EXTERNAL_CONTENT_SOURCE_REF_PREFIX` 是 `"external-content:"`（`packages/gateway-contracts/src/memory-source.ts:5`），所以 `base.length >= 221` 时 `room <= 17`。

推测：实际 `Proposal.source` 多数是 `chat:<threadId>` 或 MCP 连接前缀，通常到不了 221，所以生产上可能碰不到；但新测试只覆盖了长 origins、短 base，没覆盖这个分支。

建议：`room` 不够时改为截断 `base` 或对 `base` 也加摘要，保证“来源种类+摘要+对话来源尾部”至少保留；补一条长 base 的用例。

### 5. 低：设置错误码从 `THINK_*` 改成 `INBOX_*`，外部按错误码分支的客户端未核实

文件:行：`apps/agent-service/src/production-inbox-settings.ts:158、202、207、210、245、267、268`。

问题：gateway 命令名确实没变，但错误码变了：`THINK_SETTING_UNKNOWN` → `INBOX_SETTING_UNKNOWN`、`THINK_SETTING_OUT_OF_RANGE` → `INBOX_SETTING_OUT_OF_RANGE`、`THINK_SETTINGS_CHANGED` → `INBOX_SETTINGS_CHANGED`、`THINK_OWNER_REQUIRED` → `INBOX_OWNER_REQUIRED`、`THINK_OPERATION_NOT_INSTALLED` → `INBOX_OPERATION_NOT_INSTALLED`。

证据（读代码证实）：新文件上述行分别 `refuse("INBOX_SETTING_UNKNOWN")`、`"INBOX_SETTING_OUT_OF_RANGE"`、`"INBOX_SETTINGS_CHANGED"`、`"INBOX_OWNER_REQUIRED"`；`git show ed3f8d0:apps/agent-service/src/production-think-settings.ts` 里对应的是 `THINK_*`。仓库内 Swift 端只按 `think.settings.read/change` 命令名和 `TuningItem.key` 字符串工作（`clients/apple/Sources/HimawariManage/Settings/TuningModels.swift:9-24、52-94`），没有搜到对旧错误码的引用。

推测：仓库外或未纳入搜索的 iPhone 代码如果通过错误码决定是否提示“设置已被别人改过”，改字符串会掉进未知错误分支。建议至少确认客户端只按 `PORT_CONFLICT`/HTTP 状态处理，不按具体 message 字符串处理。

**侧重检查**

- **错误路径**：`#accept` 的 payload 写失败会重新读一次再决定是否抛（`production-inbox.ts:204-219`），enqueue 失败会清理未被引用的 summary（`:236-239`），重复写入不唤醒（`:240-245`）；worker 的普通失败计入尝试、到 `maxAttempts` 记失败（`production-inbox-worker.ts:143-151、198-214`），abort 时放回不记尝试（`:202-206`）。这部分代码逻辑自洽，但 abort、重复不唤醒、恢复唤醒没有测试（见意见 2）。
- **不可信输入**：`submit` 校验类型、来源是否登记、ref/version/thread 长度、owner 来源不能标成外来内容（`production-inbox.ts:139-165`）；summary 会裁到设置上限并按 `classificationWithIdentifiers` 分级（`:164、211`）；delivery 返回的 `outcome/reasonCode/runId` 用正则和长度校验（`production-inbox-worker.ts:17-26`）。没有对 `threadId` 做“属于当前 owner/agent”的检查，只靠数据库全局外键 `threads(id)`；`submit` 目前是内部调用，不是 gateway 入口，我没看到外部可直接影响线程归属的路径，标为未发现可实际利用的点。
- **安全/权限**：设置写命令要求 `actorType === "owner"` 且 owner/agent 与 scope 一致（`production-inbox-settings.ts:261-268`）；读查询没有在控制类里再做 actor 检查，和旧实现一致，依赖 gateway 层查询鉴权，未核实。
- **资源耗尽**：收件箱故意不设排队/每天上限；`settledSummaries` 每轮最多清 50 条（`production-inbox.ts:21、268-271`）。真正的风险是意见 3 的并发与 `yield` 循环，接 delivery 前应处理。
- **不可撤销操作**：本 PR 没有新增不可撤销动作；`ThreadDeletionRetry` 只是重试已存在的删除（`production-thread-deletion-retry.ts:27-33`），没有新增删除条件。
- **规则/文档一致性**：`docs/architecture-v0.1.md:438` 已改成 `inbox_settings` 和 6 项设置；`ci/operations-pending.json` 已把删掉实现的操作改成“已在 PR 621 删除”。设计文档里仍有旧的 `THINK_SETTING_DEFINITIONS`、`think-inbox.ts` 路径，但那几处是在讲“要删什么”，我按历史引用看，不算代码与文档矛盾。`apps/control-center` 三种语言的规则说明已加上新规则 id，Swift 设置页能接受新 `key`、新 `kind/storageUnit`（`TuningFormat.swift:3-27`）。

**作者说法核对**

1. 说法 1 属实：`sqlite-inbox-operations.ts:227-253` 的 head 查询按 `priority, created_at, rowid`，并排除同对话 `running` 行；随后按 `thread_id IS ? AND from_owner = ? ORDER BY created_at, rowid LIMIT ?` 取同对话同类来源。但“同毫秒 rowid”没有自动用例。
2. 说法 2 基本属实：普通抛错走 `putBack(true)`，`attempts >= maxAttempts` 记 `failed`（`production-inbox-worker.ts:143-151、208-214`）；`signal.aborted` 时 `release(..., countAttempt:false)`（`:202-206`）。保留一点：只有异常被 catch 到才走 abort 分支，若 delivery 在 abort 后正常返回 `retry`，仍会按重试计。
3. 说法 3 属实：`#accept` 只在 `outcome === "queued"` 时 `#announce`（`production-inbox.ts:240-242`），`maintain` 只在 `recovered > 0` 时 `#announce`（`:282`）。反向用例缺失。
4. 说法 4 属实：迁移里 `thinking`→`queued`，`proposed`→`done`/`proposed`，`skipped`/`expired`→`done`/`silent`（`20261124153216_inbox_events.sql:31-34`），迁移契约测试逐条断言（`inbox-events-migration.contract.test.ts:69-82`）。
5. 说法 5 部分可核实：在 `apps`、`packages`、`test` 的 `.ts` 里没有搜到已删服务/旧 `ThinkInbox`/`thinkInbox.`/`claimNext`/`expireQueued`/`deleteExpiredThinkThreads` 的引用；唯一出现的 `thinkInbox` 是 `startup-configuration.unit.test.ts:2018` 的负向用例（要求旧配置键被拒），`evaluateDurableSchedule` 是有意保留并改名到 `durable-schedule.ts`。`typecheck`、`lint` 我无法运行，未核实。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 对 PR 621 收件箱本身：不会，因为生产仍未接 delivery，`service-main.ts:3454-3457` 只传诊断回调，`production-inbox-composition.ts:43` 在无 delivery 时直接返回无 worker/loop，`production-http-composition.ts:1286` 的 `enabled` 也为 false，收件箱没有产出任何模型内容。增量里唯一的模型可见改动是合并进来的 `packages/prompt-catalog/src/chat.ts` 新增一行系统提示；按 `prompt-prefix.md:42-44` 规则 6，系统提示按对话冻结，改提示词文字只对新对话生效，老对话不会自动换新，因此不改已经发过的开头；新增文字也没有每轮会变的值。结论：不需要把会变的值移到最后一条消息，因为本增量没有新增这类值。
2. **会不会让同一段文字在不同请求里变成不同字节？** 本次增量没有发现这种问题。`external_event:<sourceId>` 按事件固定；`ruleSource` 先 `Set` 去重、按 `localeCompare(..., "en")` 排序再 `hash`（`production-owner-rules.ts:617-626`）；设置 overrides 在 SQL 里按 key 排序后序列化（`sqlite-inbox-operations.ts:123`）；收件箱 id/summaryRef 由固定输入的 SHA-256 派生（`production-inbox.ts:58-63`）。时间只出现在 API 快照的 `generatedAt`，不进入模型内容。
3. **有没有对应自动检查，反向用例是否真的会失败？** 有：`test/integration/inbox.test.ts`（重复、owner/外来不混、20 件分批、重试/yield、未登记来源、非法结果、存储失败、claim 抛错）、`inbox-events-migration.contract.test.ts`（迁移映射和表的删除）、`startup-configuration.unit.test.ts`（旧配置键/越界值被拒）、`tool-action-registry.test.ts` 和 action-rules 例子（新规则）。现有反向用例若实现被改坏大体上会失败；但“abort 不记尝试”“重复不唤醒”“恢复唤醒”“同毫秒 rowid”没有对应用例，见意见 2。`typecheck`/`lint` 未核实（不能运行）。
4. **改动产生或修改的每个值，使用端都能接受吗？**
   - `inbox_events`：`status` 只写 `queued/running/done/failed`；`outcome` 由 `^[a-z][a-z0-9_]{0,31}$` 校验，数据库是 `length 1..32`；`reasonCode` 切到 64，数据库 `<=64`；`runId` 校验为 null 或 1..256，数据库一致；`priority` 1..9、`source_kind` 1..64、`source_ref` 1..256、`source_version` <=256、`thread_id` <=256、`id` <=128 都与迁移约束一致（`sqlite-inbox-operations.ts:168-220`、`inbox_events.sql:1-21`）。
   - `inbox_settings`：新设置键都在 `INBOX_SETTING_DEFINITIONS` 里，严格配置解析器 `parseInbox` 接受这些键并拒绝旧键（`strict-configuration.ts` 的 `parseInbox`）；gateway 快照 schema 的 `key` 是 `machineString`，`storageUnit` 允许 `count/min/s`（`contracts-v2.ts:569-570、911-934`）；Swift `TuningItem` 的 `key` 是字符串、`kind/storageUnit` 是可选枚举，能接受新项（`TuningModels.swift:52-94`、`TuningFormat.swift:3-27`）。
   - 迁移值：`from_owner` 统一写 0、`priority` 写 5、`thread_id` 写 NULL（`inbox_events.sql:28-36`）。旧 `think_inbox` 没有这些列，且旧表只用于“想一想”外来事件，所以 0/5/NULL 能通过新约束；如果历史上有从主人消息来的 `think_inbox` 行，它们会被当成非主人来源，这一点是推测，未在旧数据上核实。
   - 错误码：`INBOX_*` 是本 PR 新产生的值；仓库内没有旧错误码引用，Swift 端没搜到按错误码分支，但仓库外客户端未核实（见意见 5）。
   - 删除项：`inbox_events.summary_ref` 指向 payloads；`thread_id ON DELETE CASCADE` 会在对话删除时连行一起删。我没有在本次改动里找到清理被级联删掉后遗留 summary payload 的路径（`maintain` 只扫还存在的事件行），这是推测性的潜在载荷泄漏，旧实现没有对话外键所以没这个问题，建议后续确认。
