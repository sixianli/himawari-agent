## 读代码后的问题清单（按严重度）

### 1、高：仍在进行的运行会被当成“卡住”重新排队或判失败，可能重复执行有后果的动作
文件：`apps/agent-service/src/production-inbox-worker.ts:88-90`、`apps/agent-service/src/production-inbox.ts:255-264`、`packages/persistence-sqlite/src/sqlite-inbox-operations.ts:319-338`、`packages/application/src/ports/configuration.ts:398`、`:408`

问题：`maintain()` 每个领任务周期都会跑一次，而“卡住”的唯一依据是 `updated_at`（只在领任务时写一次，没有心跳）。新的 `InboxLoop` 一边并发处理，一边在空闲定时器到点后继续调用 `claim()`，所以一个正在跑的长任务超过 `stalledAfterMinutes` 就会被 `recoverStalled` 抢走：`attempts >= maxAttempts` 时直接记 `failed`，否则改回 `queued`，随后可能被第二次领走并再次交给 delivery。旧 `ThinkLoop` 是严格串行的，不会在运行中对自己做维护，这个冲突是新并发循环引入的。

读代码证实的证据：
```ts
// production-inbox-worker.ts:88-90
async claim(): Promise<InboxClaim | undefined> {
  const { store, scope, clock } = this.#options;
  await this.#options.inbox.maintain().catch(...);
```
```ts
// production-inbox.ts:259-264
const recovered = await this.#options.store.recoverStalled({
  ...this.#options.scope,
  stalledBefore: new Date(at - limits.stalledAfterMinutes * 60_000).toISOString(),
  maxAttempts: limits.maxAttempts,
  now,
});
```
```ts
// sqlite-inbox-operations.ts:325-336
UPDATE inbox_events SET status = 'failed', reason_code = 'stalled' ...
WHERE ... status = 'running' AND updated_at <= ? AND attempts >= ?
...
UPDATE inbox_events SET status = 'queued' ...
WHERE ... status = 'running' AND updated_at <= ? AND attempts < ?
```
配置允许独立设置：`stalledAfterMinutes` 1–1440，`runTimeoutMinutes` 1–120（`configuration.ts:398`、`:408`），没有任何“stalled 必须大于运行时限”的校验。只要用户把卡住时间调到 1 分钟或把运行时限调到 60 分钟，正常但较慢的运行就会被抢走。

推测/未核实：本 PR 生产里没有 delivery，循环不启动（`service-main.ts` 没传 delivery，`production-inbox-composition.ts:50` 返回 `loop: undefined`），所以眼下不会触发；一旦后续 PR 接上 delivery，问题就会变成真实重复投递。是否已有运行槽位/心跳能避免，未核实。

建议：不要把 `stalledAfterMinutes` 和 `runTimeoutMinutes` 当成两个独立设置用；要么强制 `stalledAfter > runTimeout + 余量`，要么在 delivery 运行期间写心跳（或租约），只把真正没有心跳的 `running` 行恢复。另一个最小修法是：同一个进程内维护 `#inflight` 的 entry 集合，`maintain` 跳过本进程正在处理的 id。

### 2、中：delivery 返回的 outcome/reasonCode/runId 与存储层校验不一致，成功投递会被当成失败重试
文件：`apps/agent-service/src/production-inbox-worker.ts:160-162`、`:170-180`、`:18-27`；`packages/persistence-sqlite/src/sqlite-inbox-operations.ts:268-277`

问题：`InboxDeliveryResult.outcome` 只是 `string`，而 `finish` 要求 outcome 匹配 `/^[a-z][a-z0-9_]{0,31}$/u`、reasonCode 非空且不超过 64、runId 1–256。delivery 成功返回后，`settle` 抛出的任何校验错误都会落进 `catch`，然后 `putBack(true, "delivery_failed")` 把整批重新排队。也就是说，后续 delivery 只要返回 `outcome: "SubThread"`、`outcome: ""`、`reasonCode: ""` 或超长 runId，一次已经成功、可能已经发出邮件/写了日历的运行会被重做。设计文档 `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:613` 明确要求为“收件箱结束时的结局”加“用真实数据库把每个新值插一遍”的自动检查，本 PR 没有加。

读代码证实的证据：
```ts
// production-inbox-worker.ts:160-162
if (result.status === "handled") {
  await settle(deliveredIds, "done", result.outcome, result.reasonCode, result.runId);
```
```ts
// production-inbox-worker.ts:178-180
try {
  await putBack(true, "delivery_failed");
  return { status: "done", entryIds: ids, result: "retry" };
```
```ts
// sqlite-inbox-operations.ts:272-277
if (
  input.outcome !== null &&
  (typeof input.outcome !== "string" || !OUTCOME.test(input.outcome))
)
  this.invalid("Inbox outcome is invalid");
const runId = input.runId === null ? null : this.text(input.runId, 256, "run");
```

建议：给 outcome 定义明确的枚举/常量（例如 `silent | told | proposed | subthread ...`），在 delivery 边界就校验或规范化；把“delivery 失败”和“结果值不合法”分成两种错误，后者不要重试 delivery。补一条真实数据库测试，把每个允许的 outcome、最长 runId 和空 reasonCode 都插一遍，再加一条反向用例断言非法 outcome 不会导致重投。

### 3、中：`submit` 接受任意 `threadId`，不校验它属于同一 owner/agent
文件：`apps/agent-service/src/production-inbox.ts:131-160`、`:223-232`；`packages/persistence-sqlite/src/migrations/20261124153216_inbox_events.sql:11`

问题：`submit` 只检查 `threadId` 是 1–256 的字符串，随后原样写入 `inbox_events.thread_id`。数据库外键只验证该 id 在 `threads` 表存在，不验证该线程属于同一个 `owner_id/agent_id`。一个来源（将来邮件、感知、子线程适配器）如果把别的租户的线程编号带进来，行会成功落库；之后 `claimBatch` 和 delivery 会把 `threadId` 交给运行。虽然下游线程读取也许会再校验 owner/agent（未核实），但这是典型的“两端只校验了一端”的问题。

读代码证实的证据：
```ts
// production-inbox.ts:156-160
if (
  typeof input.threadId === "string" &&
  (input.threadId.length < 1 || input.threadId.length > 256)
)
  return { accepted: false, reason: "INBOX_THREAD_INVALID" };
```
```ts
// production-inbox.ts:223-232
outcome = await this.#options.store.enqueue({
  ...this.#options.scope,
  id,
  ...
  threadId: input.threadId ?? null,
```
```sql
-- migration:11
thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
```

建议：落库前用 `ownerId + agentId + threadId` 读一次线程并核对其归属；或者在存储层加触发器/组合外键，确保 `inbox_events(owner_id, agent_id, thread_id)` 只能指向同租户线程。补一条反向用例：把另一个 owner 的 threadId 提交进来必须被拒（且不是抛 SQLite 外键错误）。

### 4、中：新解析器会拒绝旧的 `runPolicy.thinkInbox`，旧生产配置可能导致启动失败
文件：`packages/platform-node/src/strict-configuration.ts:1815`、`:1892`

问题：`runPolicy` 允许键现在是 `inbox`，`parseRunPolicy` 用 `rejectUnknown` 白名单；旧的 `thinkInbox`（尤其 `thinkInbox.worth`）会被当成未知键抛错。仓库里没有生产配置模板可核对，但旧版本要启用“想一想”必然配置了 `runPolicy.thinkInbox.worth`。如果部署配置没有同步改名，升级后服务会直接启动失败，而不是“暂时没有处理方”。

读代码证实的证据：
```ts
// strict-configuration.ts:1815
"inbox",
],
"configuration.runPolicy",
);
...
// :1892
...(input["inbox"] === undefined ? {} : { inbox: parseInbox(input["inbox"]) }),
```

推测/未核实：生产配置文件不在仓库里（全仓检索 `thinkInbox` 只有测试和文档），无法确认是否已经改名；`config: strict` 的启动检查会拒绝未知键这一点是确定的。

建议：在此 PR 或上线操作里明确要求同时更新生产配置（把 `runPolicy.thinkInbox` 改成 `runPolicy.inbox`，删掉 `worth`），并加一条启动配置反向用例：带 `thinkInbox` 的旧配置必须报具体的迁移提示，而不是泛泛的 unknown key。

### 5、中：`InboxLoop` 没有全局并发上限，会为每个不同对话同时启动一个 handle
文件：`apps/agent-service/src/production-inbox-worker.ts:249-271`

问题：循环只按“同一 thread_id 不并行”做约束，不同对话完全不等；`#tick` 里 `handle()` 启动后不等待，直接继续 `claim()` 下一批，`#inflight` 只是收集 Promise，没有上限。设计文档说服务器当前最多同时跑 3 趟、其中 1 趟留给主对话（设计 `:265`）。如果未来的 delivery/运行调度器自己不排队，这里可以同时启动很多模型运行；即使 delivery 内部排队，被领走的收件箱行会长时间处于 `running`，又回到第 1 条的卡住恢复问题。

读代码证实的证据：
```ts
// production-inbox-worker.ts:260-270
const handling = this.#worker
  .handle(claim, signal)
  .then(
    () => undefined,
    (error: unknown) => this.#fail(error),
  )
  .finally(() => {
    this.#inflight.delete(handling);
    this.wake();
  });
this.#inflight.add(handling);
```

推测/未核实：delivery 是否会在运行时调度层限流，本 PR 没有实现 delivery，无法核实；如果限流由下一层保证，这里只是“把压力推给下游”的风险。

建议：给 `InboxLoop` 加一个显式的并发额度（例如可配置的 `maxActiveBatches`），达到额度后停止 claim，等有 handle 完成再继续；或者在文档/接口里明确“只允许一个并发 handle，由 delivery 内部排队”，不要让代码依赖未写下的约定。

### 6、中：删除的测试文件里同时覆盖了仍保留的服务，`DelegationService` 现在全仓没有测试
文件：已删除 `packages/application/test/autonomy-services.unit.test.ts`；仍保留 `packages/application/src/services/delegation-service.ts`

问题：这个被删的 1249 行文件里除了已删的 `SuggestionService`/`ReflectionService`，还有 `describe("DelegationService")` 和 `describe("ImprovementCandidateService")`。`DelegationService` 仍然在 `packages/application/src/services/index.ts` 导出，但全仓 `*.test.ts` 里已经没有任何 `\bDelegationService\b` 引用（只有 `WorkerDelegationService` 保留着测试）。这不是“删掉的服务和测试”，而是连带删掉了保留代码的回归覆盖。

读代码证实的证据：我用 `git show ed3f8d0…:packages/application/test/autonomy-services.unit.test.ts` 读到 `describe("DelegationService", () => {`，并用检索确认当前测试里没有 `DelegationService` 的引用。

建议：把 `DelegationService`（以及 `ImprovementCandidateService` 中仍有价值的部分）的测试迁到单独文件再删旧文件；或者在同一 PR 里明确记录“这些服务也准备删除”，避免保留代码无测试。

### 7、低：删除服务后仍有残留引用和陈旧说明，与“没有任何剩余引用”的说法不符
文件：`scripts/check-egress-redaction.mjs:93`、`:109`；`ci/operations-pending.json:5`、`:10`、`:21`、`:25`

问题：`check-egress-redaction.mjs` 仍登记已删除的 `packages/platform-node/src/think-worth-decision.ts`；`ci/operations-pending.json` 里 delegation/improvement/reflection/suggestion 的理由仍写“autonomy-gateway-adapter 已实现”，而这个文件本 PR 已删除。

读代码证实的证据：
```js
// scripts/check-egress-redaction.mjs:93
["packages/platform-node/src/think-worth-decision.ts", ["AI Gateway decision request"]],
// :109
["packages/platform-node/src/think-worth-decision.ts", ["redactForExternalText"]],
```
```json
// ci/operations-pending.json:5
"delegation.list": "…autonomy-gateway-adapter 已实现，生产没有装配…",
```

我按脚本逻辑核对过：`findEgressViolations` 只遍历现存源码文件，不读取登记里已删除的文件，所以这道检查不会因此报错；这是陈旧说明，不是会变红的引用。但“删掉的服务和测试没有任何剩余引用”的说法在仓库层面不成立。

建议：删除 `check-egress-redaction.mjs` 里两处 `think-worth-decision.ts` 登记；把 `operations-pending.json` 中相关理由改成“实现已删除、仍缺调用方/测试/整组待定”，或者按 Andy 的决定把整组操作移出。

### 8、低：设置存储层只校验键名和正整数，不校验设置清单和范围，坏值可让循环永久失败
文件：`packages/persistence-sqlite/src/sqlite-inbox-operations.ts:105-117`、`:223-225`；`apps/agent-service/src/production-inbox-worker.ts:92-94`

问题：`changeSettings` 允许任意 `[a-zA-Z]{1,64}` 键和任意非负安全整数，不检查它是不是 `INBOX_SETTING_DEFINITIONS` 里的键、也不检查 min/max。网关层 `ProductionInboxSettings.change` 会做范围校验，但 store port 本身也被持久化适配器暴露给其他调用方；迁移/损坏数据也可以写入 `eventsPerRun = 100000`。随后 `claim()` 把这个值传给 `claimBatch`，`limit` 超过 `MAX_BATCH` 会抛错，`InboxLoop` 每个空闲周期都会失败一次，收件箱永远不前进。

读代码证实的证据：
```ts
// sqlite-inbox-operations.ts:110-117
entries.length > 32 ||
entries.some(
  ([key, value]) =>
    !/^[a-zA-Z]{1,64}$/u.test(key) || !Number.isSafeInteger(value) || value < 0,
)
```
```ts
// sqlite-inbox-operations.ts:225
const limit = this.limit(input.limit, MAX_BATCH);
```
```ts
// production-inbox-worker.ts:92-94
const limit =
  overrides["eventsPerRun"] ?? this.#options.eventsPerRun ?? INBOX_LOOP_DEFAULTS.eventsPerRun;
```

建议：存储层直接用 `INBOX_SETTING_DEFINITIONS` 的键、min、max 校验 overrides；或者至少把 `eventsPerRun`、`maxAttempts`、`runTimeoutMinutes` 限制在定义范围内，并在 worker 侧对越界值回退默认值而不是抛错。

### 9、低：删除想一想保留清理后，旧的 `origin='think'` 对话不再被自动删除
文件：`apps/agent-service/src/production-thread-deletion-retry.ts:1-67`；旧 `production-think-retention.ts` 已删除；迁移保留旧 think 线程数据

问题：`ThreadDeletionRetry` 只重试“没删完”的删除，不再扫描 `threads.origin='think'` 到期删除。迁移只搬 `think_inbox` 行，不删除旧 think 对话；因此如果第 1 步上线时没有按设计执行“以前的对话全部删掉”的生产动作，旧的想一想对话和它们的载荷会永久保留，和 ADR 0277 被删、设计里说“子线程不到期删”不是一回事。

推测/未核实：设计文档 `:72` 说第 1 步上线时会在生产里删除旧对话，属于仓库外的生产动作；仓库里的代码不会自动清理它们。未核实该生产动作是否已经执行。

建议：在 PR 说明/上线清单里明确“旧 think 对话由生产删除动作处理”，或者加一次性迁移/脚本处理；不要只依赖口头约定。

## 侧重检查

- **错误路径**：delivery 抛异常、`retry`、`yield`、abort、超时、缺少摘要、未登记来源都逐条读过。`abort` 的 release 只对 `status='running'` 生效，`attempts` 回退逻辑看起来正确，但**没有自动测试**；delivery 成功但 outcome/runId 不合规会被当成 delivery 失败，这是第 2 条。
- **不可信输入**：`submit` 对类型、sourceRef/sourceVersion/threadId 长度、owner 来源与外部内容冲突做了检查；缺少 threadId 租户归属校验（第 3 条）。`changeSettings` 存储层校验比定义松（第 8 条）。网关 `execute` 校验 owner actor 和 scope，`query` 不校验（与旧 `ProductionThinkControl` 一致，不是本 PR 新增）。
- **安全**：`readOnlyRun` 从 `source === undefined || isThinkRunSource(source)` 改成 `source === undefined`（`service-main.ts:1720-1722`），删掉 think 强制只读是合理的，但后续 inbox delivery 的运行不会自动只读；按设计第 3 步要由权限规则负责，本 PR 没有 delivery，暂时不影响。跨 owner 的 `threadId` 是第 3 条。
- **资源耗尽**：`InboxLoop` 没有全局并发上限（第 5 条）；每批最多 `MAX_BATCH=1000`、`eventsPerRun` 定义上限 200，但存储层可写入更大值导致 claim 持续失败（第 8 条）。
- **不可撤销操作**：迁移在同一事务里创建 `inbox_events`、删 `think_inbox`/`think_inbox_declined`、删索引、改名 `think_settings`，没有回滚脚本；迁移测试验证了数据映射和删除，属于不可逆但方向符合设计要求。旧 think 线程不自动清理见第 9 条。
- **规则/文档/代码一致**：`prompt-manifest.json` 与 `prompt-catalog` 删除同步；`TRUSTED_PROMPT_TEXTS` 不再包含 think 提示，旧 think 对话若被重发，出口遮盖的“固定文字”判定可能变化（规则文件第 11 条提到这一点），但 think 运行路径已删，是否有其他重发路径未核实。`scripts/check-egress-redaction.mjs` 和 `operations-pending.json` 有陈旧引用（第 7 条）。设计文档 I-73 清单要求给新 outcome 值加自动检查，本 PR 未加（第 2 条）。iPhone 动态读取设置项，所以新键能显示；但 `ManageDemo.swift` 仍硬编码旧键，且 `enabled=false` 时 iPhone 设置页显示“未开启”并禁用，实际 App 里还改不了这些设置——这是“可在 App 改”与当前接线状态的差异，属于设计第 1 步的预期还是遗漏，未核实。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

本 PR 没有把收件箱内容送进模型的路径：`service-main.ts` 只传 `inbox.onDiagnostic`，没有传 `delivery`；`production-inbox-composition.ts:50` 在没有 delivery 时返回 `{ inbox, worker: undefined, loop: undefined }`，生产不会启动循环。主对话的系统提示、工具定义、历史消息、出口遮盖代码都没有改动，所以主对话仍然只追加，本 PR 也没有新增“每轮会变的值”。

删除的 `think.*` 提示词只被已删除的 `production-think-runner.ts` 使用，不属于主对话开头。唯一需要留意的是规则文件第 11 条的固定文字清单：`THINK_*` 从 `TRUSTED_PROMPT_TEXTS` 移出后，旧的想一想对话如果再次发给模型，遮盖判定可能和以前不同；但 think 运行路径已删，是否有别的重发路径未核实。结论：**主对话的请求开头不变，新增内容也没有进入模型；未来 delivery PR 需要重新回答这个问题。**

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

按本 PR 的代码没有发现模型可见的不确定字节：`entryKey` 是对 `[ownerId, agentId, sourceKind, sourceRef, sourceVersion]` 做 SHA-256，`id`/`summaryRef` 确定；摘要写入时按 `clip` 固定裁剪并加密存储，读取后解密得到相同明文；设置 overrides 写入前按 key 排序（`sqlite-inbox-operations.ts:123`）；收件箱批次顺序由 `priority, created_at, rowid`（head）和 `created_at, rowid`（batch）决定；`usage.byStatus` 也有 `ORDER BY status`。`ProductionInboxControl.query` 的 `generatedAt` 是网关响应的时钟值，不是模型请求内容。结论：**当前不进入模型，故不影响请求字节；未来把事件拼进最后一条消息时，事件顺序和摘要内容已经确定了确定的来源。**

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

有：
- `packages/persistence-sqlite/test/inbox-events-migration.contract.test.ts` 验证了旧行状态映射、旧表/索引/设置键删除、settings 迁移。
- `test/integration/inbox.test.ts` 覆盖了去重、不设上限（121 行）、一次 20 件、设置改变、owner/外部内容不混、同对话串行/不同对话并行、失败重试和 maxAttempts、yield 不耗尝试、抛错算重试、未登记来源失败、写入后立即叫醒、循环在 claim 抛错后继续、旧设置键拒收、iPhone 查询。
- `packages/platform-node/test/startup-configuration.unit.test.ts` 覆盖了 `inbox` 配置范围和旧 `thinkInbox` 键拒收。

不足：
- `abort`（服务关闭）放回不记尝试的路径没有测试。
- `recoverStalled` 恢复卡住条目、以及恢复后 `onQueued` 的路径没有测试；重复写入不通知 `onQueued` 也没有测试。
- 第 1 条的“运行中但有 handle 在飞时被 maintain 抢走”没有反向用例。
- 第 2 条的非法 outcome/reasonCode/runId、第 3 条的跨租户 threadId、第 8 条的越界 overrides 都没有反向用例。
- 作者说“typecheck、lint 通过”我无法验证（只允许读代码和 git 命令），仓库内没看到编译/类型错误来源，但这属于**未核实**。

**4. 每个产生或修改的值，每个使用它的地方都能接受吗？**

- `inbox_events` 各列：迁移定义、`schema-catalog.ts`、`sqlite-inbox-operations.ts` 三处字段和约束一致；`migration-engine.contract.test.ts` 会比对目录表和实际表。`outcome` 有一处不一致，见第 2 条。
- `inbox_events.priority/from_owner/thread_id`：`InboxSourceRegistry` 限制 priority 1–9、禁止同时 owner+外部内容；DB 约束接受。`thread_id` 的**租户归属**没有两端校验，见第 3 条。
- `inbox_settings` 键：`INBOX_SETTING_DEFINITIONS`、严格配置解析、`INBOX_SETTING_TEXT`、网关 snapshot schema、iPhone 动态解码都接受六个新键；旧键从迁移里删除。iPhone 的 demo 仍硬编码旧键，正式 App 是动态读取，未发现正式 App 拒收；`enabled=false` 时页面被禁用，是接线状态问题，不是 schema 拒收。
- `runPolicy.inbox`：类型、解析器、组合层都使用新键；旧的 `runPolicy.thinkInbox` 会被解析器拒绝，生产配置是否已更新**未核实**，见第 4 条。
- 清单项/脚本：`ci/operations-pending.json` 与 `scripts/check-egress-redaction.mjs` 仍有已删服务的说明，见第 7 条；它们不会让检查变红，但两端文档不一致。
- 迁移的 `meta.json`：`alters` 五个对象与实际删除/改名对象一致，`removes` 覆盖旧 `think_inbox` 的时间 GLOB 字面量和 `think_settings` 的 `'object'`，按 `scripts/migration-conflicts/analyze.mjs` 的规则看起来能通过（未实际运行该脚本）。
