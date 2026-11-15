本轮增量是 `3c4eefa..2c8c61f`（提交 `cee1702a6`），实质改动 12 个文件。对照代码核对后：上一轮第 1 条（冻结快照指纹）已改好，恢复和到期结算两处都比对前去掉 `ownerApprovedTask`；上一轮第 2 条只改好一半，ADR 0257 的事实代码清单补上了，ADR 0278 的 `amends` 仍为空。增量本身没有发现新的功能性错误，只有错误路径和测试覆盖两类问题，按严重度列出如下。

### 1. 低：ADR 0278 的 `amends` 仍为空，上一轮第 2 条只改了一半

- 文件:行：`docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:7`、同文件 `:48`
- 问题：ADR 0278 的决定 3 明确改的是 ADR 0257 决定 3 定的内置规则，并把规则升到第 2 版，按仓库其他 ADR 的惯例应把 0257 写进 `amends`。上一轮第 2 条要求的就是这一点，本轮只补了 ADR 0257 的事实代码清单，`amends` 没有改。
- 证据：ADR 0278 头部仍是 `amends: ""`（第 7 行）；决定 3 原文：“内置规则 `refuseBackgroundAfterExternalContent`（ADR 0257 决定 3 定的）升到第 2 版……”（第 48 行）。ADR 0257 的清单已经补上 `run_source_owner_approved_task`（`docs/adr/0257-...md:216`），这一半是真改好了。
- 建议：把 `amends` 写成 `"docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md"`，或在 ADR 里说明为何不算 amend。`check:adr-numbers` 只校验编号、标题和链接，不会发现这个空字段。

### 2. 低：到期结算那条改动没有自动测试，回归只覆盖恢复路径

- 文件:行：`apps/agent-service/src/production-run-expiry.ts:62-66`、`docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:77`
- 问题：这次把 `frozenRunSourceIdentity` 用在两个生产路径上，但新增测试只覆盖了 `RunExecutionInputService` 的恢复路径（`test/integration/thread-run-lifecycle.test.ts:2437-2447`）和 helper 的单元测试；整个仓库没有任何测试 import 或驱动 `createProductionRunExpiry`。如果以后有人在到期结算这处去掉 strip，或者又往 `RunExecutionSource` 加派生字段，不会有测试失败。上一轮问题的原始描述恰好包括“到期结算”。
- 证据：`production-run-expiry.ts` 的比对是 `canonicalAuthorizationSnapshot(frozenRunSourceIdentity(frozen.source)) !== canonicalAuthorizationSnapshot(frozenRunSourceIdentity(source))`（第 65-66 行）。用 grep 找 `createProductionRunExpiry` 只找到 `production-run-composition.ts:814` 这一个生产调用方；`test/integration/sqlite-sandbox-execution-v2.test.ts:1509` 等用的是更底层的 `recovery.settleExpired`，不经过这个 wrapper。ADR 0278 的回归测试清单也只写了 `thread-run-lifecycle` 和单元测试（第 77 行）。
- 建议：补一个直接调用 `createProductionRunExpiry` 的集成或单元用例：v2 快照里没有 `ownerApprovedTask`、数据库重新读出的来源有，期望照常结算；再加一条反向用例，把 `sourceId` 等存储字段改成不同值，期望抛 `RUN_EXPIRY_INPUT_INVALID`。

### 3. 低：畸形的 `frozen.source` 现在抛 TypeError，而不是原来的受控错误

- 文件:行：`packages/application/src/ports/run-execution-source.ts:33-35`、`apps/agent-service/src/production-run-expiry.ts:65`、`packages/application/src/services/run-execution-input-service.ts:236`
- 问题：`frozenRunSourceIdentity` 直接解构入参；如果快照 version 是 v2 但 `source` 缺失或为 `null`，会先抛 `TypeError: Cannot destructure ...`，走不到后面原有的 `RUN_EXPIRY_INPUT_INVALID` / `ApplicationPortError`。旧代码对 `undefined` 调 `canonicalAuthorizationSnapshot` / `threadCommandFingerprint` 会得到可比较的值并最终落入受控错误，所以这是错误路径的行为变化。它仍然 fail-closed，不会恢复或结算，但诊断信息变差，调用方会看到未预期异常。
- 证据：`const { ownerApprovedTask: _derivedFromProposalState, ...identity } = source;`（`run-execution-source.ts:34`）；两个调用点都在 `frozen?.version !== "run-execution-input.v2" ||` 之后直接调用 `frozenRunSourceIdentity(frozen.source)`（`production-run-expiry.ts:65`、`run-execution-input-service.ts:236`），没有先校验 `frozen.source` 是对象。
- 建议：在 helper 里先判断入参是对象且非 `null`，或在这两个调用点加 `frozen.source && typeof frozen.source === "object"` 的检查，让畸形快照仍转成原有的受控错误。
- 推测：可达性低。快照是加密载荷，到期结算路径还先核对 `contentDigest` 和内容哈希；要出现“摘要对得上但结构畸形”的 v2 快照，需要服务端写入 bug 或手工篡改。因此这是防御性/诊断问题，不是当前可触发的事故。

## 侧重检查

- 授权与安全（读代码证实）：`OwnerScopeAuthorization.authorize` 每次都重新读来源，`const source = await this.#options.source.read(invocation.runId);`（`owner-scope-authorization.ts:155`），随后在 `:179` 用 `source.ownerApprovedTask` 加事实，在 `:260` 用 `source.sourceType === "external_event" && !source.ownerApprovedTask` 决定是否标外部内容。去字段只用于恢复/结算的指纹比对，不参与授权，所以没有放宽任何授权。
- 不可信输入与伪造来源（读代码证实）：SQL 的派生条件是 `t.source_type = 'external_event' AND EXISTS (... op.type = 'task.run' AND op.status = 'accepted' AND substr(t.source_proof_ref, 1, length(op.id) + 10) = 'proposal:' || op.id || ':')`（`sqlite-thread-operations.ts:1528-1533`）。生产里写 `external_event` 的只有 task（`proposal:...`）和 think（`think:...`，`production-think-runner.ts:208`），think 的固定前缀不可能匹配 `proposal:`；`schedule` 被 `source_type` 条件挡住。
- 状态不可逆（读代码证实）：`claim` 只从 `pending` 改成 `accepted`（`sqlite-owner-proposal-operations.ts:356-359`）；`transition` 的调用方只从 `pending` 出发（`production-proposals.ts:639、819、868、910`）。因此 `ownerApprovedTask` 正常不会从 true 变回 false。即使发生，授权读的是实时来源，只会变得更严格（回到“直接拒绝”）。
- 资源耗尽（读代码证实）：`owner_proposals_pending_index` 是 `(owner_id, agent_id, status, proposed_at, id)`（`20261114151010_owner_proposals.sql:30-31`），EXISTS 可用这个索引按 owner/agent/status 收窄，没有新增表或迁移。accepted 的 task.run 提议长期累积会让匹配变慢，这是既有 SQL 的特性，不是本轮增量引入的；未做进一步压力核实。
- 规则/文档与代码一致性（读代码证实）：ADR 0257 的事实代码清单（第 216 行）与 `POLICY_FACT_CODES` / `POLICY_FACT_REGISTRY` 里的三语标签一致；ADR 0278 决定 5 描述的两处比对与代码一致；回归清单漏了到期结算测试（见第 2 条）。`run-execution-source.ts` 删掉了原有注释“Canonical source of an admitted Run; never inferred from the latest Thread message.”，没有功能影响，但少了一句有价值的约束说明。
- 未核实：ADR 0278 前提 5 里 Andy 在项目聊天说的“这里按照你的建议来”不在仓库里，无法核对；测试没有实际运行（工具被限制为只读和 git），测试结论来自读代码；滚动部署期间新快照被旧进程读取的相反方向未核实，按仓库“每人一个数据库文件”的单实例假设未展开。

本轮查过的范围：`3c4eefa..2c8c61f` 的 12 个实质文件（两个生产比对点、helper、ADR 0257/0278、两个测试）；并顺着证据读了 `sqlite-thread-operations.ts` 的来源查询、`owner-scope-authorization.ts`、`production-task-proposals.ts`、提议的 claim/transition、`production-run-expiry.ts` 的调用方、迁移里的索引、包的导出和 vitest 配置。未重读增量没有碰到的旧代码全文。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。这次增量只改恢复/结算的指纹比对、ADR 和测试；`ownerApprovedTask` 没有进入 `RunExecutionInputService.create` 返回的 `context.trigger`（那里只有 `id`、`sourceType`、`payloadRef`、`occurredAt`），新事实代码只进动作意图、审批和决策记录，不进系统提示、工具定义或历史。发给模型的内容仍然只在末尾追加，每轮会变的值仍只在最后一条消息里；本轮不涉及提示组装代码。

2. **同一段文字会不会在不同请求里变成不同字节？** 不会。`frozenRunSourceIdentity` 是纯函数、无时间字段；两个调用方用的 `threadCommandFingerprint` 和 `canonicalAuthorizationSnapshot` 都对对象键排序，所以返回对象的键顺序不影响结果。SQL 派生只取决于数据库当前状态，没有无序集合或时变字段进入序列化。标记本身会随提议状态变化，但那是授权事实，不是模型请求里的文字；一旦变化导致审批意图快照不同，审批匹配会失败而不是静默复用。

3. **有没有对应的自动检查，反向用例真的会失败？** 恢复路径有：`test/integration/thread-run-lifecycle.test.ts:2437-2447` 在实时来源上补 `ownerApprovedTask: true`，去掉 strip 就会抛 “Run execution snapshot source changed”；`frozen-run-source-identity.unit.test.ts` 第一条会因两个指纹不同而失败，第二条反向用例在 helper 误删其他字段（例如 `sourceId`）时会失败。事实代码由 `test/tooling/policy-fact-codes.test.ts` 和 `policy-fact-registry.unit.test.ts` 守护。到期结算路径没有测试（见意见 2），这是本次检查的主要缺口。以上是读代码判断，未实际运行。

4. **每个值的产生端和使用端都能接受吗？** 能。`frozenRunSourceIdentity` 由 `ports/run-execution-source.ts:33` 产生，经 `ports/index.ts:70` 和 `src/index.ts:2` 导出，使用端是 `run-execution-input-service.ts:236`、`production-run-expiry.ts:65` 和新单元测试，签名和导出都匹配。`ownerApprovedTask` 由 `sqlite-thread-operations.ts:1560-1562` 产生，使用端是 `owner-scope-authorization.ts:179、260`，该字段在 `RunExecutionSource` 里是可选的 `true`，其他来源实现不填也合法。SQL 里的 `'accepted'` 与 `STATUSES`（`sqlite-owner-proposal-operations.ts:16`）和 `claim` 写入的值一致。ADR 0257 清单里的 `run_source_owner_approved_task` 能在事实代码表里找到，且中英日三种文字齐全。增量没有新增配置键或序列化格式；唯一两端核对不完整的是到期结算缺少测试，已单列为意见 2。
