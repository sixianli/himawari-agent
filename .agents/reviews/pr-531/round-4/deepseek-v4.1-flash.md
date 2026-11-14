## 上一轮意见复核

**ds-6（proposal 不受延后靠枚举）已改好。** `packages/application/src/services/web-push-gate.ts:18-23` 已把 `"proposal"` 加进 `PUSH_RULE_PROTECTED_CLASSES`；`apps/agent-service/src/production-web-push.ts:580` 在读取规则前直接短路。`PUSH_QUIET_CLASSES` 仍不包含 proposal，正好与设计里“要改规则类型和发给模型的工具说明，另行处理”的说法一致。**但这条保证没有自动检查**，见意见 1。

**ds-7（静音仍高优先级、仍算角标）已改好。** 读代码证实：
- `production-apple-push.ts:383` `priority: item.kind === "run" || built.quiet === true ? 5 : 10`
- `production-apple-push.ts:98-106` quiet 时不带 `sound`、不带 `badge`，`interruption-level: passive`
- `production-apple-push.ts:296` quiet 时不再调用 `input.badge()`
- `production-web-push.ts:564` quiet 时徽标为 0，不调用 `awaitingCount`
- `production-web-push.ts:797` quiet 时 `urgency: "normal"`
- `apps/control-center/public/sw.js:20` 把 `silent` 传给 `showNotification`

**但网页侧和“不读角标”的声称缺少集成断言**，见意见 1；真机是否真的静音仍未核实。

## 意见

### 1. 中 — 提议“受保护、不读角标、网页静音”几个关键点没有对应的自动检查

文件：`test/integration/push-channels.test.ts:975-993`、`:1061-1082`、`:1084-1094`；`packages/application/src/services/web-push-gate.ts:18-23`；`apps/agent-service/src/production-web-push.ts:564,580,797`

问题：上一轮两条意见的代码已经改对，但新增/修改的用例没有把这几条行为钉住。

证据（读代码证实）：
- 静音用例只断言 APNs 侧：`push-channels.test.ts:986-992` 检查 `apns-priority: 5`、`passive`、无 `sound`/`badge`/按钮、只有一条；没有任何 `awaiting.calls` 断言，所以“静音时不读角标数”即使被改回仍会通过。
- 原来的 proposal 延后用例删掉了 `gate` 和 `readPushRules`（diff 中 `push-channels.test.ts` 约 1069 行附近），现在 `:1063-1072` 只注入 proposal source。设置里没有 `readPushRules` 时，`#deferred` 本来就会直接返回 false，因此即使把 `"proposal"` 从受保护类删掉，这个用例仍可能通过。
- 静音用例虽然 `context.subscribe("laptop")`（`:980`），但同轮注册了 iPhone，`sqlite-apple-push-operations.ts:306-316` 会把整条 outbox 路由到 `apns`，网页通道不会收到这条提议，所以 `production-web-push.ts:564`、`:797` 的静音网页路径没有被端到端覆盖。
- 只有一个纯函数用例 `:1084-1094` 验证 `webPushPayload` 的 `silent`，没有验证提议内容确实产生 `quiet: true` 并走到网页发送。

建议：补三类反向用例：① 在静默时段内配置一条本会延后的 `push_quiet_hours` 规则，断言 proposal 仍立即发送；② 静音-only 场景断言 `context.awaiting.calls === 0`；③ 只注册网页订阅时，断言收到的请求带 `silent: true` 且 `Urgency: normal`（或对 `#send` 用假 sender 断言头）。

### 2. 低 — 网页推送的正式说明仍写“三类来源/Urgency 按上表”，与新增 proposal 来源不一致

文件：`docs/execution/specs/2026-10-26-web-push-design.md:34,106-114,160,162-168`；`docs/execution/specs/2026-11-11-apple-device-body-design.md:705-758`

问题：代码已经有第四种来源 `proposal:`，但网页推送的正式 Spec 没更新。

证据（读代码证实）：
- 文档 `:34` 写“三类事经网页推送送到……到期的记忆提醒、等他审批、一轮任务完成或失败”。
- `:108` 写“每 10 秒扫一遍下面三类来源”，`:110-114` 的来源表只有记忆提醒、审批、任务结束；Urgency 写 `high`/`normal`，没有提议的 `normal`。
- `:162-168` 的通知内容表没有“提议”行；`:160` 仍写每条通知都带角标，而提议是明确不带角标的例外。
- 苹果设备 Spec 的“新值清单”（`:709-758`）也没有登记 `proposal:` source key、`quiet`、`silent` 这几个新值，和它自己写的“每个新出现的值，都写明谁产生、谁使用、两端怎样校验”不一致。

建议：更新网页推送 Spec 的来源表、Urgency、通知内容、角标例外，并把 proposal source key、`quiet`、`silent` 补进苹果 Spec 的新值清单。

### 3. 低 — 导出的 `PENDING_PROPOSAL_CEILING` 和持久层的 `MAX_LISTED` 是两份独立的 200，当前能通过，但改动一端会静默不一致

文件：`apps/agent-service/src/production-proposals.ts:17`；`apps/agent-service/src/service-main.ts:2843`；`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:13,271`

问题：当前两端都接受，但“导出常量”并不真正保证持久层接受同一个上限。

证据（读代码证实）：
- `production-proposals.ts:17`：`export const PENDING_PROPOSAL_CEILING = 200;`
- `service-main.ts:2843`：`limit: PENDING_PROPOSAL_CEILING`
- `sqlite-owner-proposal-operations.ts:13`：`const MAX_LISTED = 200;`
- `sqlite-owner-proposal-operations.ts:271`：`const limit = Math.min(Math.max(1, Math.trunc(input.limit)), MAX_LISTED);`

今天 200 等于 200，所以 `listPending` 接受；但如果以后只把 `PENDING_PROPOSAL_CEILING` 调大，持久层会静默截断到 200，`reduce` 选出的“最新一份”可能只是前 200 条里的最新一条；反之，`ProductionProposalBox` 的构造校验会接受更大的配置，而 `propose` 到持久层才拒绝。这正是 I-73 那类“两端各自认一个值”的问题。

建议：让上限只有一个来源（由持久层导出并被应用层引用），或在启动/测试中显式断言两者相等；持久层最好对超限抛错而不是静默截断。

### 4. 低 — 提议的 24 小时窗口按 `proposedAt` 算，而刷新已有待处理提议不会更新 `proposed_at`，旧提议可能永远不提醒（需确认是否为设计取舍）

文件：`apps/agent-service/src/production-web-push.ts:431-445,482-484`；`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:158-186`

问题：读代码证实的行为是：来源筛选和 outbox 过期都用 `proposedAt + 24h`；刷新一条已经 pending 的提议时，UPDATE 不更新 `proposed_at`。

证据（读代码证实）：
- `production-web-push.ts:482-484`：
  ```ts
  rows.filter(
    ({ proposedAt }) => Date.parse(now) - Date.parse(proposedAt) < PROPOSAL_WINDOW_MS,
  )
  ```
- `production-web-push.ts:439-444`：source key 和 `expiresAt` 都从 `proposal.proposedAt` 算。
- `sqlite-owner-proposal-operations.ts:161-166`：刷新 pending 时更新 `expires_at`、`origin`、`summary` 等，**没有 `proposed_at`**。

推测的影响：若一份旧提议在 24 小时后被刷新，它仍会因旧的 `proposedAt` 被筛掉；若它此前因为“最新一份只提醒一次”而被别的、已被忽略超过 24 小时的提议压住，之后也不会再有机会提醒。文档写的是“待处理的提议有好几份时只为最新一份发一条”，如果意图是“每份最终最多提醒一次”，这里会漏；如果意图是“整个积压只提醒最新一次”，则这是可接受取舍，建议在文档里写明。

建议：确认产品语义。若刷新后应可提醒，刷新时更新 `proposed_at`（或改用 `expiresAt`/刷新时间判断窗口）；若保持现状，在 Spec 里明确“超过 24 小时的待处理提议即使仍 pending 也不再提醒”。

## 侧重检查

- **错误路径**：`#loadProposals` 的 `try/catch` 会调用 `onFailure` 并返回 `{ ok: false, rows: [] }`（`production-web-push.ts:475-490`）；`#content` 只在 `pending.ok` 为真时才判过期（`:651-669`），所以读取失败时已入队的提议仍会发。读代码证实，和作者说法一致。
- **不可信/异常输入**：提议 id 和 `proposedAt` 来自数据库或导入。推送层本身不校验 id 格式；`Date.parse` 失败的 `proposedAt` 会被过滤掉。导入校验（`data-export/verify.ts:148-169`）只校验时间格式，不校验 `proposedAt` 不能在未来；未来时间会被当作“最新”并长期压住其它提议。这一影响属于推测，但缺少范围校验是读代码证实的。
- **安全/隐私**：提议通知文字固定、不含提议内容，`navigate` 为站点根，按钮为空；读代码证实没有把提议正文带进锁屏。
- **资源耗尽**：每次扫描最多读 200 条提议，且同一轮 `#run` 内缓存一次（`production-web-push.ts:343,468-473`），没有无界增长；每 10 秒一次 `listPending` 是有界开销。
- **不可撤销操作**：本改动只发通知，没有不可撤销的外部写操作。
- **规则/文档一致性**：`proposal` 已由代码保证不受静默时段延后；但网页推送 Spec 和苹果 Spec 的新值清单有上面意见 2 的缺口。
- **未核实**：没有运行任何测试，作者报告的 56 步 `check`、26/304/170 条测试结果未核实；没有 iOS 客户端代码，`passive`/`silent` 在真机和各浏览器是否真的静音未核实；当前 sparse checkout 里没有 `.agents/instructions/prompt-prefix.md`，问题 1 按题目给出的规则和实际改动路径判断。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次增量只改推送发送路径、测试和文档，没有改系统提示、工具定义、历史消息或遮盖逻辑。新增的 `"proposal"` 只加到 `PUSH_CLASSES`/`PUSH_RULE_PROTECTED_CLASSES`（`web-push-gate.ts:7-23`），没有加到 `PUSH_QUIET_CLASSES`（`rule-types.ts:47`），所以生成的规则类型/工具说明不变。发给模型的内容没有新增末尾之外的任何东西；这一条不涉及“只追加”规则。

2. **不会让模型看到的同一段文字变成不同字节。** 改动不进入模型请求路径。就推送本身而言，提议标题/正文是固定文案，source key 由 `proposalId + proposedAt` 决定，`listPending` 有确定排序（`ORDER BY proposed_at, id`，`sqlite-owner-proposal-operations.ts:278`），同一份提议的 source key 稳定。唯一的时间相关字段是通知 TTL/过期时间，不在模型上下文里；`proposedAt` 刷新和未来时间的边界见意见 4。

3. **有自动检查，反向用例按代码推演确实会失败，但覆盖不完整。** 已覆盖：只取最新一份（30 份只发 1 条）、超过 24 小时不产 outbox 行、读取抛错不影响其它通知、已入队通知在发送时读取失败仍发、`webPushPayload` 的 `silent`、Service Worker 的 `silent`。这些反向用例在对应逻辑被删掉时会失败。缺口是没有测试 `proposal` 受保护类、静音不读角标、网页 `Urgency: normal`，见意见 1。测试实际是否全部通过未核实。

4. **增量产生/修改的值当前都能被使用端接受，但有两处需要留意。**
   - `PENDING_PROPOSAL_CEILING = 200`（`production-proposals.ts:17`）：`service-main.ts:2843` 传给 `listPending`，持久层上限也是 200（`sqlite-owner-proposal-operations.ts:13,271`），当前接受；但两份 200 独立，见意见 3。
   - `"proposal"` 推送类：`pushClassOf` 产生（`web-push-gate.ts:37`），`PUSH_RULE_PROTECTED_CLASSES` 和 `PushGate.decide` 接受（`:18-23,78`）；`PUSH_QUIET_CLASSES` 不接受它是刻意的，和“另行处理规则类型”一致。
   - `quiet`：只在 `#content` 的 proposal 分支产生 `true`（`production-web-push.ts:668`）；网页 `webPushPayload`、网页 urgency/badge、Apple priority/payload/badge 都按 `=== true` 接受，当前一致。
   - `silent`：`webPushPayload` 产生 boolean（`production-web-push.ts:156`），`sw.js:20` 只认 `=== true`，一致。
   - `proposal:<id>:<proposedAt>`：outbox 校验只要求非空且长度不超过 256（`sqlite-web-push-operations.ts:303-316`），真实 id 长度和 `:proposedAt` 组合远低于上限；`pushClassOf` 按 `proposal:` 前缀识别；`#content` 按完整字符串匹配，当前接受。
   - 新增三语言文案键满足 `WEB_PUSH_TEXT` 的 locale 约束；`quiet`/`silent` 在 iOS 客户端是否被正确消费未核实。
