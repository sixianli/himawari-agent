**本轮范围说明**：`git diff 11a6ca4ee..11a6ca4ee` 输出为空，即本轮没有新提交；工作树干净。因此本轮实际核对的是 `a87954e..11a6ca4` 两个提交（`f95ed4b45` 功能 + `11a6ca4ee` 修正）相对基准的最终状态，重点是作者列出的五条第 2 轮说法。结论：第 1、2、3、4 条说法与代码不符，第 5 条只在文档层面成立，代码层面没有强制。

### 1. 高 — 积压时给每条待处理提议各入队一条通知，并非“只为最新一份”
- 文件:行：`apps/agent-service/src/production-web-push.ts:430`、`apps/agent-service/src/service-main.ts:2836`
- 问题：清单一律按 200 条读取，随后逐条入队；没有取最新一条、也没有整体折叠。30 份积压会生成 30 条同样的“有一条建议等你看”，最多 200 条（再按每台设备各发）。作者说法“积压时只为最新一份待处理提议入队一条通知”不成立。
- 证据：
  - `production-web-push.ts:430-440`：`const { rows: proposals } = await this.#readyProposals(now); for (const proposal of proposals) items.push({ ... sourceKey: \`proposal:${proposal.id}:${proposal.proposedAt}\` ... })`
  - `service-main.ts:2839-2844`：`listPending({ ..., limit: 200 })` 后 `.proposals.map(...)`，把全部待处理提议交给推送层。
  - `packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:276-279`：`WHERE status = 'pending' ORDER BY proposed_at, id LIMIT ?`，返回的是最早的一批，不是最新一份。
- 读代码证实的：没有 `slice(-1)`、没有只保留最新一条的逻辑；“同一份只发一次”靠 `web_push_outbox` 的 `ON CONFLICT (owner_id, agent_id, source_key) DO NOTHING` 成立（`sqlite-web-push-operations.ts:271-276`），但积压不会合并。
- 推测：哪怕通知是静音的，同屏几十条相同文案仍会打扰主人；这是本次改动最直接的体验风险。
- 建议：在 `#readyProposals` 或 `#collect` 里只取最新一条（并固定 `sourceKey` 语义），或明确改成“所有积压合成一条、按最新 proposedAt 计 24 小时”，再补 30 条积压只出 1 条的用例。

### 2. 中 — 提议读取没有 try/catch，同步抛出会中断整轮推送
- 文件:行：`apps/agent-service/src/production-web-push.ts:465`、`:339`
- 问题：作者说法是“改成 async 加载函数里 try/catch”，实际用的是 `.then(成功, 失败)`，只能接住 Promise 拒绝。若 `listReady(now)` 同步抛出，异常在赋值缓存前就冒泡，`#collect` 抛错，`#run` 的下一句 `#deliver` 被跳过，整轮推送（含审批、提醒）都发不出去。现有反向用例只覆盖 `async () => { throw ... }`。
- 证据：
  - `production-web-push.ts:468-481`：`const result = source ? source.listReady(now).then(...) : Promise.resolve(...)`，调用本身不在 try 中。
  - `production-web-push.ts:430` 调用 `await this.#readyProposals(now)`；`:359-360` 是 `await this.#collect(...); await this.#deliver(...);`，中间没有 try。
  - `test/integration/push-channels.test.ts:1010-1014` 用的是 `listReady: async () => { throw ... }`，不是同步抛出。
- 读代码证实的：`service-main.ts:2837` 的生产适配器确实是 `async (now) => ...`，所以当前生产实现不会同步抛；这是接口允许、但实现未防御的路径。
- 推测：将来若有非 async 适配器或包装层在返回 Promise 前做参数校验并同步抛，就会触发上述整轮停摆。
- 建议：用 `try { const rows = await source.listReady(now) } catch` 包住调用（或 `Promise.resolve().then(() => source.listReady(now))`），并补一个同步抛出的反向用例。

### 3. 中 — 读取上限仍写死 200，`PENDING_PROPOSAL_CEILING` 既没导出也没被使用
- 文件:行：`apps/agent-service/src/production-proposals.ts:17`、`apps/agent-service/src/service-main.ts:2843`
- 问题：作者说法“读取上限用导出的 PENDING_PROPOSAL_CEILING”不成立。常量是私有的 `const PENDING_PROPOSAL_CEILING = 200`，调用端写死 `limit: 200`，两处会漂移。
- 证据：
  - `production-proposals.ts:17`：`const PENDING_PROPOSAL_CEILING = 200;`（没有 `export`）。
  - `service-main.ts:2843`：`limit: 200,`。
- 读代码证实的：持久层 `sqlite-owner-proposal-operations.ts:271` 对 limit 做 `Math.min(..., MAX_LISTED)`，`MAX_LISTED = 200`（`:13`），所以当前 200 恰好能通过，不是立即错误。
- 建议：把 `PENDING_PROPOSAL_CEILING` 导出，`service-main.ts` 改为引用它；若本来就是另一套上限，则在持久层导出 `MAX_LISTED` 并引用，避免三处各写 200。

### 4. 中 — 窗口反向用例测不到入队过滤，“永远成立的断言”也还在
- 文件:行：`test/integration/push-channels.test.ts:991`、`:994`
- 问题：作者说法“窗口反向用例改成断言 outbox 里没有 proposal 行；去掉永远成立的断言”两项都没做。现有反例只断言 APNs 没有 alert，删掉 `#readyProposals` 里的 24 小时过滤它仍然会绿，因为 `expiresAt = proposedAt + 24h` 也会让条目在发送时过期。
- 证据：
  - `push-channels.test.ts:991`：`expect(context.awaiting.calls).toBeGreaterThanOrEqual(0);`（恒真）。
  - `push-channels.test.ts:994-1003`：只断言 `expect(context.apns.ofType("alert")).toEqual([])` 和 `failures` 为空，没有检查 outbox。
  - `production-web-push.ts:472-474` 的过滤一旦删除，`:439` 仍会让旧提议在 `:536` 被判过期，因此用例无法区分“没入队”和“入队后过期”。
  - 文件在 `:1072` 结束，新增提议用例只有 4 条 + 1 条 web payload 用例，没有 30 份积压的用例。
- 读代码证实的：用 `at(T0, -90_000)` 表示 90,000 秒前（`push-channels.test.ts:58-59` 乘 1,000），确为 25 小时，但正是这一点让 expiresAt 单独就能兜底。
- 建议：断言 outbox 的 `listDue`/`enqueue` 里没有 `proposal:` 行（或注入 store spy），并在删掉 24 小时过滤时让用例失败；同时补上 30 条积压用例。

### 5. 低 — 缓存按 `now` 保存且从不按轮清空，与“每轮开头清空”不符
- 文件:行：`apps/agent-service/src/production-web-push.ts:463`
- 问题：作者说法“缓存每轮开头清空（不再按 now 缓存）”，实际是显式按 `now` 缓存，且没有任何清空点。若两次 `#run` 拿到同一个 `now`（例如测试里连续两次 `tick` 都固定在 `T0`），第二轮会复用上一轮的成功或失败结果，不再真正读取。
- 证据：
  - `production-web-push.ts:466`：`if (this.#proposalRead?.now === now) return this.#proposalRead.result;`
  - `production-web-push.ts:482`：`this.#proposalRead = { now, result };`；全文件再无对 `#proposalRead` 的清空赋值（grep 仅这三处）。
  - 测试 `push-channels.test.ts:982-983`、`:1000-1001` 确实连续两次 `tick` 用同一 `T0`。
- 读代码证实的：生产里 `#run` 每轮重新取 `now`（`:342`），通常每次不同，所以多数情况等价于“每轮缓存”；但实现不是作者描述的样子，且同 `now` 跨轮会复用旧结果。
- 建议：在 `#run` 开头置 `this.#proposalRead = undefined`，或把它改成只在单次 `#run` 内有效的局部变量/按轮序号缓存。

### 6. 低 — `proposal` 既不在受保护类、也不在静默规则类，文档“不受延后”靠枚举而非代码保证
- 文件:行：`packages/application/src/services/web-push-gate.ts:12`、`:18`、`packages/application/src/rules/rule-types.ts:47`
- 问题：新值 `proposal` 加进了运行时 `PUSH_CLASSES`，但既没进 `PUSH_RULE_PROTECTED_CLASSES`，也没进发给模型/规则编辑器的 `PUSH_QUIET_CLASSES`。文档说“提议通知不受不推送时段延后”，这只靠“规则类型不能写 proposal”成立；任何绕过类型枚举、直接写入 `push_class == "proposal"` 的规则仍会让它被延后。同时提交 `f95ed4b45` 的说明写的是“so owner quiet-hour rules can defer it”，与修正后的设计文档相反。
- 证据：
  - `web-push-gate.ts:12`：`"proposal",` 在 `PUSH_CLASSES` 中。
  - `web-push-gate.ts:18-22`：`PUSH_RULE_PROTECTED_CLASSES = ["approval","muse_outage","unknown"]`，无 `proposal`。
  - `rule-types.ts:47`：`PUSH_QUIET_CLASSES = ["scheduled_reminder","run_result","mail_reminder"]`，无 `proposal`。
  - `docs/execution/specs/2026-11-11-apple-device-body-design.md:489` 写“提议通知不受它延后”。
- 读代码证实的：`pushClassOf` 对 `proposal:` 返回 `"proposal"`，因此 `#deferred` 不会因 `unknown` 而短路，是否延后完全取决于能否有规则命中该字符串。
- 建议：明确取舍后落到代码——若确定不受延后，把 `proposal` 加进 `PUSH_RULE_PROTECTED_CLASSES`；若希望以后可延后，把 `proposal` 加进 `PUSH_QUIET_CLASSES` 并同步字段说明与工具说明。无论哪种，修正 `f95ed4b45` 的提交说明或文档以免自相矛盾。

### 7. 低 — 静音通知仍走 high urgency / priority 10，Apple 侧仍计算角标
- 文件:行：`apps/agent-service/src/production-web-push.ts:791`、`apps/agent-service/src/production-apple-push.ts:295`、`:382`
- 问题：web 推送对提醒统一 `urgency: "high"`，Apple 对非 run 统一 `priority: 10`；静音的提议也照用。并且 Apple 推送无条件 `await input.badge()`，即使 `quiet` 最终会丢弃 badge；web 端已用 `content.build("en").quiet === true ? 0 : ...` 特意跳过，两端不一致。
- 证据：
  - `production-web-push.ts:791`：`urgency: item.kind === "run" ? "normal" : "high",`
  - `production-apple-push.ts:295`：`await input.badge(),`（无条件）
  - `production-apple-push.ts:382`：`priority: item.kind === "run" ? 5 : 10,`
  - `production-web-push.ts:558`：web 端对 quiet 已跳过 `awaiting()`。
- 读代码证实的：badge 值虽被 `applePushAlertPayload` 在 `quiet` 时丢弃（`:99`），但计算已经发生；测试 `push-channels.test.ts:991` 是恒真断言，抓不到这一点。
- 推测：`high`/`10` 可能让推送服务立即唤醒设备，削弱“不急”的意图；未查各平台对 urgency 与 passive 的实际投递行为，属未核实。
- 建议：静音通知改用较低 `urgency`（如 `normal` 或 `low`）和 APNs `priority 5`，并让 Apple 侧同样在 quiet 时跳过 badge 计算；把恒真断言换成 `expect(awaiting.calls).toBe(0)`（网页侧）或针对具体路径断言。

**侧重检查（错误路径、不可信输入、安全、资源耗尽、不可撤销、规则/文档一致性）**

- 错误路径：异步抛出已被 `.then` 的拒绝分支接住并 `onFailure`（`production-web-push.ts:476-479`），已核实；同步抛出未接住，见意见 2。读取失败时已入队的提议仍会发送，见 `production-web-push.ts:647-654`，与作者说法一致。
- 不可信/畸形输入：`silent` 在 Service Worker 用 `notification.silent === true` 严格判断，字符串 `"true"` 不会生效，并有 `service-worker-feedback.test.ts:89-96` 覆盖；提议的 `proposedAt` 若非法，`Date.parse` 得 `NaN`，过滤表达式 `NaN < WINDOW` 为假，条目在计算 `expiresAt` 前就被丢弃（`production-web-push.ts:472-474`），不会触发 `toISOString` 的 RangeError；`sourceKey` 长度按提案 id（最多约 65 字符）加 ISO 时间约 99 字符，低于 `sqlite-web-push-operations.ts:308-311` 的 256 上限，`sourceRef` 同样合规，`kind: "reminder"` 在 `:307` 白名单内——这些都已核实。
- 安全/隐私：推送标题和正文是固定文案（`production-web-push.ts:52-53` 等），不含提议内容；`sourceKey`/`tag` 只含 id、时间及其哈希，payload 的 `himawari` 只有 tag/kind/navigate/actions（`production-apple-push.ts:109-115`）；未发现内容泄露。
- 资源耗尽：积压最多 200 条入队，`SEND_BATCH = 50`（`production-web-push.ts:35`）分轮发送，最终 200 条通知，见意见 1；`#content` 对每条提议做一次 `rows.some`，最多 O(200×200)，可忽略。
- 不可撤销：本次只增加通知入队和发送，没有删除/覆盖数据的不可逆操作；通知本身发出去不可撤回，但设计就是一次性提示。
- 规则/文档一致性：设计文档 `2026-11-11-apple-device-body-design.md:489` 与执行计划 `2026-11-11-apple-device-body-plan.md:163` 已写入“passive/无声音/无角标/silent/不受静默时段延后”，与代码的 passive、无 sound、无 badge、`silent` 基本一致；不一致处是提交 `f95ed4b45` 的说明与文档相反，以及 `proposal` 类未在规则枚举/保护枚举中显式落位（见意见 6）。未核实“不上手表”和各浏览器是否真正静音，文档自己也标注了“没核实”。

**必答问题**

1. **不会改变模型已见过的请求开头。** 本改动只触及出站推送、推送分类与文档；`packages/prompt-catalog`、工具定义、历史落盘/遮盖组装均未改。`PUSH_QUIET_CLASSES`（会进入 Rule 工具说明的那份清单，`rule-types.ts:47`）也没有新增 `proposal`，所以发给模型的工具说明和示例没有变化。结论：改动不涉及“只在末尾追加、每轮变化值放最后一条消息”的模型请求路径，仍满足 `prompt-prefix.md` 的要求（不涉及即不破坏）。
2. **不会让模型请求里的同一段文字变成不同字节。** 本改动不产生模型请求；推送文案固定，`sourceKey` 由提议 id 和固定的 `proposedAt` 组成，与 `now` 无关，没有无序集合。随 `now` 变化的只有“哪些提议落入 24 小时窗口”和 TTL/expiresAt，不改变同一份提议的文本字节。
3. **有自动检查，但关键反向用例不会在错误时失败。** 正向用例覆盖 passive/无 sound/无 badge/无 actions 和 web `silent`；`service-worker-feedback` 覆盖 `silent` 严格布尔。但窗口反例只断言没有 APNs alert，删掉入队窗口过滤仍会通过（见意见 4）；正面用例保留恒真断言；没有 30 条积压用例；没有同步抛出用例。因此“反向用例真的会失败”对窗口过滤和同步抛出不成立。作者所说“tsc、lint、26 条通过”本轮无法运行命令，未核实。
4. **逐个使用端核对**：
   - `quiet`：`WebPushNotification.quiet`（`production-web-push.ts:128`）→ `webPushPayload`（`:156`）→ `sw.js:20` 严格布尔；`PushContent.build` 返回类型含 `quiet`（`:170-175`）→ `applePushAlertPayload`（`production-apple-push.ts:91,98-106,394`）用 `=== true`，两端都能接受。
   - `silent`：Service Worker 接受布尔并拒绝字符串 `"true"`（`sw.js:20`，测试 `service-worker-feedback.test.ts:89-96`），可接受。
   - `proposal` 类：`PUSH_CLASSES`（`web-push-gate.ts:12`）新增后，`pushClassOf`（`:36`）使用它没有类型问题；但 `PUSH_RULE_PROTECTED_CLASSES`（`:18-22`）和 `PUSH_QUIET_CLASSES`（`rule-types.ts:47`）都没有它，导致“不受延后”只靠规则编辑器枚举约束，见意见 6。
   - `ProposalPushSource`/`proposals`：只有 `service-main.ts:2836` 和测试注入；类型可选，缺省时返回空行，使用端能接受。
   - 上限值：`service-main.ts:2843` 的 `200` 能通过 `sqlite-owner-proposal-operations.ts:271` 的 clamp（`MAX_LISTED = 200`），但 `PENDING_PROPOSAL_CEILING` 未导出、未复用，见意见 3。
   - `sourceKey`/`sourceRef`/`kind`：`proposal:<id>:<proposedAt>` 与 `sourceRef = id` 均满足 `sqlite-web-push-operations.ts:303-316` 的长度与 kind 校验；`expiresAt` 由合法 ISO 的 `proposedAt + 24h` 得到，可接受。
   - 文档：设计/计划文档已同步，提交说明与文档相反（意见 6），未发现把新值写进模型可见清单的地方。

**本轮查过的范围**：`git diff a87954e..11a6ca4` 全部 14 个文件；逐条核对了 `production-apple-push.ts`、`production-web-push.ts`、`service-main.ts`、`sw.js`、`web-push-gate.ts`、`production-proposals.ts`、`sqlite-owner-proposal-operations.ts`、`sqlite-web-push-operations.ts`、`rule-types.ts`、`field-catalog.ts`、两份新测试和两份设计/计划文档，并读取了 `.agents/instructions/prompt-prefix.md`。`git diff 11a6ca4..11a6ca4` 为空，因此没有“增量新错”可报告；`.agents/reviews/pr-531/round-1/*` 在 diffstat 里显示为二进制，未展开阅读。
