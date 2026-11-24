本轮范围已核对：PR 621 自身在 `52a49dbe..7643ca48` 之间只有 `e1188c7b9`（`production-inbox-worker.ts`、`ports/inbox.ts`、`sqlite-inbox-operations.ts`、`test/integration/inbox.test.ts`）；`7643ca48` 的其余内容是 merge 进来的 main（PR 620/624/626），`git diff e1188c7b9..7643ca48 -- <上述 PR621 文件>` 为空，说明合并没有改到本次改动。下面先报增量里的问题，再给侧重检查与必答问题。

### 1. 中低：skip 列表被按 `MAX_BATCH`（1000 个对话）硬上限校验，积压超过 1000 个对话时同一轮会抛错并提前停
文件:行：`packages/persistence-sqlite/src/sqlite-inbox-operations.ts:15`、`:226-236`；`apps/agent-service/src/production-inbox-worker.ts:281-306`
问题：`started` 在每一轮 tick 里每认领一个对话就 `push` 一项，并原样作为 `skip` 传给下一次 `claimBatch`；而 `claimBatch` 用“单批条目数”的常量 `MAX_BATCH` 来限制“要跳过的对话数”。超过 1001 个对话时，第 1002 次认领会抛 `PORT_INVALID_OPERATION: Inbox conversations to skip are invalid`，`InboxLoop` 捕获后 `#fail` 并 `break`，这一轮不再继续。
证据：
```ts
const MAX_BATCH = 1000;                       // sqlite-inbox-operations.ts:15
...
if (
  !Array.isArray(skip) ||
  skip.length > MAX_BATCH ||
  ...
) this.invalid("Inbox conversations to skip are invalid");   // :227-236
...
started.push({ threadId: claim.threadId, fromOwner: claim.fromOwner }); // worker:306
claim = await this.#worker.claim(started);                     // worker:286
```
后果：收件箱“不设排队上限、来多少收多少”时，只要积压超过约 1000 个不同对话，每个 tick 都会先处理 1001 个对话、报一次 `inbox.loop_failed`，然后等下一个 idle 间隔；吞吐被这个与需求无关的常量卡住。另外 `started` 同时携带全部历史 skip，每认领一次都重建并 `prepare` 一条更长的 SQL（参数数随 n 增长），大积压时开销偏大。
建议：`skip` 的上限不要复用 `MAX_BATCH`；给“一轮最多认领多少个对话”单独设一个明确的业务上限，达到上限时正常结束本轮并立即安排下一轮（不是抛错），或分段清空 `started` 后继续。这样既能给出错误输入的上界，又不会把正常积压当非法输入。

### 2. 低：skip 元素校验不是 null-safe，坏元素会抛原生 TypeError 而不是可识别的端口错误
文件:行：`packages/persistence-sqlite/src/sqlite-inbox-operations.ts:230-234`
问题：校验直接读 `conversation.threadId`，没有先判断元素是对象；`skip` 里出现 `null`/`undefined` 时会在 `skip.every` 里抛 `TypeError: Cannot read properties of null`，不会走 `this.invalid(...)`，错误类型和上层诊断（`inbox.loop_failed` / `inbox.failed`）对不上。另外 `threadId` 只校验类型，未像 `enqueue` 那样限长。
证据：
```ts
!skip.every(
  (conversation) =>
    (conversation.threadId === null || typeof conversation.threadId === "string") &&
    typeof conversation.fromOwner === "boolean",
)
```
建议：先 `typeof conversation === "object" && conversation !== null`，再校验字段；`threadId` 复用 `this.text(conversation.threadId, 256, ...)`（null 单独放行）。

### 3. 低（推测）：`InboxLoop` 的终止现在依赖 `claim` 真的实现 skip，旧代码的“重复即 break”保护被完全删掉
文件:行：`apps/agent-service/src/production-inbox-worker.ts:280-307`（构造函数类型见 `:240`）
问题：旧代码里 `if (started.has(conversation)) break;` 是循环的保底出口；现在只有“claim 返回 undefined”“signal aborted”“claim 抛错”三个出口。`InboxLoop` 的构造参数是结构类型 `Pick<ProductionInboxWorker, "claim" | "handle">`，一个忽略可选 `skip` 参数的 `claim`（测试替身或将来别的实现）同样能通过类型检查。只要它持续返回同一个 yield 对话，循环就会在同一 tick 里不停地 `handle` 它，直到进程被停掉。
证据：
```ts
async #tick(signal: AbortSignal): Promise<void> {
  const started: InboxConversation[] = [];
  for (;;) {
    ...
    claim = await this.#worker.claim(started);
    ...
    started.push({ ... });
  }
```
这条是推测：当前唯一生产实现是 `ProductionInboxWorker`，它确实把 skip 传到 SQLite，所以现有生产路径不会发生；风险在替身/未来实现和契约本身。
建议：保留一个廉价的防御性检查（例如本次 claim 的对话已在 `started` 里就 `break`），或把 `claim(skip)` 写进显式接口并加一条“claim 必须认领非 skip 对话”的契约测试。

**上一轮意见复核（均读代码证实已改好）**
- 上一轮 3（重复对话直接 break 挡住后面的对话）：已修。`InboxLoop` 不再 break，改为 `claim(started)`；测试 `test/integration/inbox.test.ts:509-537` 明确期望 `["busy","behind"]`，被挡住的 “behind” 现在会被处理。
- 上一轮 1（yield 后同一轮重复交付，测试把“最多两次”当通过）：已修。`claimBatch` 新增 `skip` 并按 `thread_id/from_owner` 排除；`test/integration/inbox.test.ts:539-549` 验证了同一对话被 skip 后取到别的对话。这两个改动在旧代码上都会失败：旧 loop 不会把 skip 传给 claim，旧 SQL 也不会排除已交出的对话。

**侧重检查**
- 错误路径：`claimBatch` 非法输入的 fail 路径、`InboxLoop` claim 抛错后继续存活（`:551-578` 测试仍在）、`handle` 抛错/abort 时 `release(countAttempt:false)`，均读过；本增量未引入新的丢数据路径。
- 不可信/不合规范输入：`skip` 只由进程内 `InboxLoop` 生成，不是外部输入；校验不完整的问题见意见 2。
- 安全：skip 只用于拼接固定模板 `AND NOT (... IS ? AND ... = ?)`，对话值全部走绑定参数，没有把任何文本拼进 SQL，无注入。
- 资源耗尽：见意见 1（skip 无界增长被错误地硬性截断、每轮重建 SQL）；生产里本步尚未接 delivery，loop 不启动，所以目前不可触发。
- 不可撤销操作：无新增。
- 规则/文档与代码一致：PR 621 增量没有动提示词或规则文件。顺带抽查了 merge 进来的 CLEAR-6/7（属于 PR 624/626）：`namesRememberedValue` 确实调 `redactForEgress`、不传 `trusted`、不传 `ruleset`（即当前规则集），与 `prompt-prefix.md` 第 14 条和设计文档的说法一致；`dispatchState: "accepted"` 与 `[CLEAR-6]` 测试一致，未发现不一致。

**必答问题**
1. 不涉及。PR 621 的增量只决定“本轮把哪些收件箱对话交给 delivery”，不修改系统提示、工具定义或历史消息的拼装；delivery 仍是在对话末尾追加，`skip`、`now` 这些每轮会变的值也只用于数据库选择/时间戳，不进模型请求。
2. 不涉及。`skip` 是本次 tick 内确定的、按认领顺序生成的内部数组；没有新增依赖前后文的遮盖、时间字段进入提示词，也没有把无序集合写进请求。合并进来的 CLEAR-7 抽查也是确定性的（同一段工具结果文本每次算出的结果相同）。
3. 有自动检查，且反向用例真的会失败。改动同时覆盖 loop 与 store 两层：`inbox.test.ts:509-537`（loop 传 skip、能到 behind）、`:539-549`（SQLite 按 skip 取下一对话）。旧代码一个会重复交出 “busy”、到不了 “behind”，另一个会取到 “first”，两条断言都会失败。小瑕疵：`:547` 的 `toBeUndefined()` 同时也能被 “thread-b 已 running”满足，单看这一行不能证明 skip 生效；真正证明 skip 的是 `:546` 和 `:548` 两条。
4. 增量新增/修改的值有 `InboxConversation` 类型、`InboxStorePort.claimBatch` 的 `skip?` 字段、`ProductionInboxWorker.claim(skip)` 参数。使用端逐个查过：`ports/index.ts:59` 导出 `inbox.js`；`ProductionInboxWorker.claim` → `store.claimBatch`（`worker:114`）→ `durable-adapters.ts:1090` 原样透传 → `sqlite-inbox-operations.ts` 绑定参数进 SQL；测试端 `test/integration/inbox.test.ts`。`InboxStorePort` 只有 SQLite 一个实现，没有别的实现会忽略 `skip`。两端基本能对上，唯一不一致就是意见 1 的 `MAX_BATCH` 上限。
