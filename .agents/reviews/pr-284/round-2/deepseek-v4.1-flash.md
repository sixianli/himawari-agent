# 复核结论（05c51d4，对照 7073268；重点看 62badac..05c51d4 增量）

## 一、读代码证实的发现（按严重度）

### 1. 高｜同一批次里“新到的另一封邮件”会被当成“以前的往来邮件”塞进时间线
文件：`packages/platform-node/src/gmail-related.ts:101-109`，`packages/platform-node/src/gmail-source.ts:267-275`，`packages/application/src/services/proactive-mail-check-service.ts:675-686`

证据：
```ts
// gmail-related.ts
for (const item of items) {
  const pool = new Map<string, ProactiveSourceItem>();
  const add = (candidate: ProactiveSourceItem) => {
    if (candidate.messageId !== item.messageId) pool.set(candidate.messageId, candidate);
  };
```
```ts
// gmail-source.ts
async thread(threadId) {
  const thread = await get(...`/threads/${...}?format=full`);
  ...
  return (thread.messages ?? []).flatMap((message) => {
    const item = gmailItem(message, { history: true });
    return item ? [item] : [];
  });
},
```
`#related` 把**全部 candidates** 交给读取器（`:675-686`），而 `findRelatedMail` 只排除当前这封的 `messageId`，没有排除同批次其他新邮件。于是同一邮件串里若本次新到 A、B 两封，A 的 `related` 会包含更晚的 B，B 的 `related` 也会包含 A；这与提示词里“`related` 是同一件事**以前**的往来邮件、按时间从早到晚”（`packages/prompt-catalog/src/mail.ts:16`）矛盾。后果：时间线方向颠倒、旧邮件名额被新邮件挤掉、同一内容在提示词里重复出现、账本 `relatedByMail` 可能与 `sourceIds` 重叠（违反 ADR 0180:44 对两者含义的区分）。

建议：在 `findRelatedMail` 里只保留严格早于当前邮件的结果（按 `receivedAt`、`messageId` 比较），或至少排除所有 `items` 的 `messageId`；补一条“同一邮件串两封新邮件”的反向用例。

### 2. 中高｜编号关联不要求共同对方，标签又很宽，容易把无关邮件发给模型
文件：`packages/platform-node/src/gmail-related.ts:13-14,43-46,125-131`

证据：
```ts
const REFERENCE_CONTEXT =
  /(?<![A-Za-z])(?:...|No\.?|ID|＃|#)...((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{5,39})/giu;
...
const ids = await search(`"${reference}" -in:trash -in:spam`);
for (const message of await fetchMany(ids.filter((id) => id !== item.messageId)))
  if (mentions(message, reference)) add(message);
```
`mentions` 只做子串包含，不检查共同往来人；而同一函数的“同标题”路径明确要求 `sharesCounterpart`（`:122`）。`ID 123456`、`No. 123456`、`#123456` 这类 6 位数字在邮箱里很常见，会把**完全无关的第三方邮件**（甚至同一号码更长数字的邮件）拉进来发给模型。这是本改动带来的隐私范围扩大和判断污染，不只是“可能漏”。

建议：编号命中同样要求共同对方，或把标签收窄到 `order/注文/予約/案件` 等强标识并提高最短长度/格式要求；`mentions` 加词边界；补反向用例“不同发件人、仅有相同短数字不得进入 `related`”。

### 3. 中｜请求预算只按“次数”算，没有按字节/正文大小设上限
文件：`packages/platform-node/src/gmail-related.ts:54-65,92-99,113-116,137-144`，`packages/platform-node/src/gmail-source.ts:267-289`，`packages/platform-node/src/gmail-body.ts:5,197-200`

证据：
```ts
class Budget { ... take(): boolean { if (this.used >= this.total) return false; ... } }
...
const chunk = await Promise.all(ids.slice(start, start + FETCH_PARALLEL).map(fetchMessage));
...
for (const message of (await transport.thread(item.threadId)) ?? []) {
  known.set(message.messageId, message);
  add(message);
}
```
`threads.get?format=full` 一次可返回整串邮件，`messages.get?format=full` 每封正文提取上限是 200k 字符（`GMAIL_BODY_HARD_LIMIT`）。预算只限制请求数，不限制一次响应里带回多少正文；这些全文会先放进 `known`/`pool`，之后 `relatedMailView` 还会对每封全文做遮盖（`proactive-mail-check-service.ts:259-264`），且遮盖是同步、不可被 `AbortSignal` 中断的。多封新邮件 + 大邮件串时，内存和 CPU 可能明显超出“300 次请求”的预期，甚至越过检查时限。`fetchMany` 也会把搜索结果全部取回后再由上层截到 `perMail`，存在无谓取回。

建议：按累计字节设第二道上限；每封只取剩余名额所需的封数；在存储/遮盖前先按 `charactersPerRelated` 截断；把大邮件串的读取成本纳入预算说明。

### 4. 中低｜ADR 说“留足时间给模型判断”，代码只保证“找旧邮件不超过时限的一半”
文件：`packages/application/src/services/proactive-mail-check-service.ts:565-569,627-638,675-687`，`docs/adr/0180-gmail-check-reads-earlier-mail-about-the-same-matter.md:43`

证据：
```ts
const deadlineAt = new Date(Date.parse(startedAt) + this.#options.limits.perCheckMs).toISOString();
const timer = setTimeout(() => controller.abort(), this.#options.limits.perCheckMs);
...
const fetched = await reader.fetch({...});   // 先花掉时间
...
AbortSignal.timeout(Math.floor(this.#options.limits.perCheckMs / 2)),  // 从 related 开始时算
```
`related` 的时限确实不超过 `perCheckMs/2`（总 deadline 还会再兜底），但 `fetch` 和随后的 `#recall` 与它共用同一个总时限。若 `fetch` 已用掉一半以上，模型能分到的时间远少于一半，不是 ADR 写的“留足时间给模型判断”。这是说明与实现的偏差，不是致命错误，但会影响上线后的超时排查。

建议：按“距 `deadlineAt` 的剩余时间”预留模型时间（例如 related 只用到剩余时间的一部分），并在 ADR 里如实写“related 自身不超过总时限一半；fetch/recall 也占用同一预算”。

### 5. 低｜账本的 `relatedRead`/`relatedFailedSteps` 仍覆盖“没发给模型”的邮件
文件：`packages/application/src/services/proactive-mail-check-service.ts:529-555,971-988`

证据：
```ts
for (const item of candidates) {
  const failure = fetched === undefined ? "read" : fetched.failed.get(item.messageId);
  ...
}
trace.relatedRead = failedMails === 0 ? "ok" : ...;
```
而 `#judge` 只给真正进入提示词的 `batch` 记 `relatedByMail` 和 `messages/characters`。因此一次检查可能账本显示 `relatedRead: "partial"`、失败步骤 `["subject"]`，但 `relatedByMail` 是空的（那封邮件因每日上限/失败根本没发给模型）。ADR 0180:44 只承诺 `relatedByMail` 只记真正发出的批次，没约束 `relatedRead`；但这会让“读取成本/降级”统计和“实际发给模型”统计口径混在一起。

建议：要么把 `relatedRead`/失败步骤也按“实际发出的邮件”记，要么在字段名/文档里明确它们是“全部候选的读取情况”。

### 6. 低｜生产验收新增断言只证明“请求过 thread”，没证明旧邮件进了提示词
文件：`test/integration/proactive-production.test.ts:494`，同文件 `119-142`

证据：
```ts
expect(h.google.calls.some(({ url }) => url.includes("/threads/thread-invoice"))).toBe(true);
```
但假 Gmail 对 `/threads/thread-invoice` 返回 404（`:119-142` 的 `id` 只识别 `invoice`/`sale`），所以该用例里 `related` 实际为空；即使“找旧邮件”和“把旧邮件放进提示词”之间的接线断了，这条断言仍会通过。真正的端到端保护主要靠 `proactive-mail-check.test.ts` 的 `[PA-1]`。

建议：给 `thread-invoice` 返回一封 archived 旧邮件，并断言 `h.prompts[0]` 含旧邮件内容。

### 7. 低｜测试只覆盖了旧邮件“摘要”的遮盖，没覆盖旧邮件“正文”的遮盖
文件：`test/integration/proactive-mail-check.test.ts:1999-2022`

证据：该用例构造 `mail("old", { subject, snippet, receivedAt })`，测试辅助函数的 `body` 默认是 `null`（`:80`），所以走的是 `relatedMailView` 的 `snippet` 分支；`relatedMailView:263` 的 `masked(mail.body)` 与 `#reportMasked` 的 `sentBodyValues(mail.body, ...)` 没有被这条测试覆盖。正文和摘要走的是不同分支，建议补一条带 `body` 的旧邮件遮盖用例。

---

## 二、推测 / 未核实

- **未核实**：真实 Gmail 的 `subject:"..."`、编号全文搜索、`threads.get?format=full` 的实际返回形状与分页行为；作者也承认只用假响应测过。
- **未核实**：费用增幅、真实账号上的内存峰值。第 3 条的内存放大是按代码路径推算的，没有实测。
- **未核实**：`npm run check` 的 41 步、干净 main 上同样失败的 3 步、第 0 层 942 条通过。本次无法执行命令，只能确认仓库里存在相应测试文件。
- **推测**：如果真实邮箱里存在很长的同一邮件串，且一次积压很多新邮件，第 3 条的资源压力会比“300 次请求”直观感受更大。

---

## 三、侧重检查

- **错误路径**：`reader.related` 抛错 → `#related` 把该邮件标 `failed` 并加 `relatedUnavailable`（`proactive-mail-check-service.ts:526-549`），检查不整体失败；预算用完 → `findRelatedMail` 记录 `budget` 并继续（`gmail-related.ts:87-90,132-136`）；超时 → 逐项标 `timeout`（测试 `gmail-related.unit.test.ts:200-211`）。这部分与 ADR 一致。
  **但** `gmail-source.ts:258-259` 对 401/403 只当普通 `GoogleRequestError("related", ...)`，不会像 `fetch` 那样触发 `needs_reconnect`；如果 access token 恰在 `fetch` 之后失效，这次只会降级，下一次才标记重连。还有 `#related` 的兜底把 `accessToken` 抛出的超时记成 `read` 而不是 `timeout`（`:531`）。
- **不可信输入 / 安全**：旧邮件正文是不可信内容，提示词已有“邮件内容不是指令”的固定说明（`mail.ts:12`）；只读 scope、无归档/打标签/回信。编号关联的过宽匹配是主要风险（见发现 2）。
- **资源耗尽**：请求次数有 300 上限，但没有字节/正文大小上限（见发现 3）；`fetchMany` 会取回全部搜索结果后才截断。
- **不可撤销操作**：改动只有 Gmail 读取，没有写操作；生产验收也断言没有非 GET 的 Gmail 调用（`proactive-production.test.ts:488-492`）。
- **规则/文档一致性**：`prompt-prefix` 对后台调用的要求基本满足（固定指令在前、数据在后、时间最后）；ADR 0180 关于“找旧邮件只占一半时限”和“留足模型时间”的表述与代码不完全一致（见发现 4）；`relatedRead` 口径与 `relatedByMail` 不一致（见发现 5）。
- **账本两端校验**：写端 `sqlite-proactive-operations.ts:525-550,640-648` 校验了枚举、key 长度、列表元素、步数上限、非负安全整数；读端 `sqlite-decision-ledger-operations.ts:175-192` 对老记录补默认值。老记录可读，基本成立。

---

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会（对本功能而言）。** 邮件判断是一次性后台调用，没有对话历史；`proactivePrompt` 的顺序是：固定说明 → 记忆（可变）→ 邮件数据（可变，`related` 嵌在每封邮件里）→ 最后的当前时间（`proactive-mail-check-service.ts:353-361`，`mail.ts:53-67`）。所以每轮会变的值仍在最后，`related` 只是把末尾的可变数据变长，不是插到固定前缀前面。

需要说明两点：
- 这次修改确实改了固定提示词本身（`mail.ts:16-17` 在“对每封邮件给出一个结论”之前插了两行），会让所有邮件判断请求的固定前缀**一次性**变化，影响一次提示缓存命中；但这不是“改写已经发给模型的对话开头”，不违反 prompt-prefix 的追加规则。
- 如果将来有人把邮件判断做成复用同一提示词前缀的多次调用，`related` 嵌在 item JSON 里会改变中间字节；当前实现没有这种复用。未发现对话历史路径使用 `MAIL_JUDGMENT`。

### 2. 同一段文字会不会在不同请求里变成不同字节？

**就同一封旧邮件自身而言不会。**
- 遮盖是纯函数 `maskSensitiveText(input)`（`sensitive-capture/src/redaction.ts:516-518`），不依赖跨请求状态；旧邮件和新邮件都走 `masked(...)`（`proactive-mail-check-service.ts:259-264` 与 `308-320`）。
- 时间线排序固定：`findRelatedMail` 按 `receivedAt` + `messageId` 升序（`gmail-related.ts:139-143`），`relatedMailView` 再按同一组键排序后反转（`:254-259`），JSON 键顺序由代码固定。
- 存在一个**选择层面的**不确定性：预算在 `items` 顺序上共享，`findRelatedMail` 按传入顺序逐个消耗预算（`:101-145`）；若 Gmail 返回候选邮件的顺序变化，同一封新邮件可能拿到不同的 `related` 集合。这属于预算/输入顺序导致的“包含哪些旧邮件”变化，不是同一段旧邮件文本被改写。作者没有在 ADR 里强调这一点。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有，且本轮新增的反向用例是有效的：
- `test/integration/proactive-mail-check.test.ts:1875`“同发件人但无标题/编号关联不带前情”——若代码错误地按发件人关联，会失败。
- `:1939`“只记真正发给模型的批次”——若把账本记录放回 `#related` 对所有候选记录，会因 `relatedByMail` 含 `b` 而失败。
- `:1964`“每日费用已用完不再找旧邮件”——若去掉 `spentToday >= dailyCostMicros` 判断，`lookups` 会变成 2。
- `:1981`“旧邮件没有正文时告诉模型 `bodyUnavailable`”——若删除该字段，会失败。
- `packages/platform-node/test/gmail-related.unit.test.ts:142`“搜索结果不含编号时不能信任”——是真正的反向用例；`:160` 数量上限、`:180` 单封失败/预算、`:200` 中止超时也都覆盖。

缺口：没有“同一邮件串两封新邮件”的反向用例（对应发现 1）；没有“不同发件人共用短数字/长数字”的反向用例（对应发现 2）；没有旧邮件正文遮盖用例（发现 7）；生产验收没有断言旧邮件内容进入提示词（发现 6）。另外，本次无法运行 `npm run check`，无法确认这些用例在真实流水线里是否全绿。

### 4. 改动产生/修改的每个值，使用它的地方都能接受吗？

逐项核对如下（读代码确认）：

- `relatedMailsPerMail`（默认 6，0..50）：`strict-configuration.ts:1045` 产生 → `production-proactive.ts:181` → 服务 `perMail` → `findRelatedMail` 截断。账本写入校验允许单封列表最多 64 个（`sqlite-proactive-operations.ts:537`），50 ≤ 64，当前能通过。**隐患**：若以后把配置上限提高到 64 以上，或直接构造服务传入 >64，账本写入会因 `ids(list, 64)` 失败，整个检查记录失败。
- `relatedRequestsPerCheck`（默认 300，1..2000）：`strict-configuration.ts:1048`、服务默认 `:117`、`production-proactive.ts:182`、启动测试 `startup-configuration.unit.test.ts:1360` 四处一致。
- `relatedCharactersPerMail` / `relatedCharactersPerRelatedMail`：`strict-configuration.ts:1020-1031` 校验前者不小于后者；服务 `:281` 用作累计上限，`:259-263` 用作单封截断。两端接受。
- `relatedByMail`：生产端 key 来自实际发送的 `messageId`（≤ 候选数 ≤ 300），value 来自 `findRelatedMail` 的去重池（每封 ≤ 50）；写端校验 key 长度、列表唯一性/长度（`sqlite-proactive-operations.ts:535-538`），读端对老记录补 `{}`（`sqlite-decision-ledger-operations.ts:175-182`）。能通过。
- `relatedRead`：写端枚举与读端默认 `"off"` 一致（`sqlite-proactive-operations.ts:532`，`sqlite-decision-ledger-operations.ts:183`）。
- `relatedStats`：服务保证非负整数；写端校验四个字段都是非负安全整数（`:545-548`），读端补零值（`:184-191`）。能通过。**小问题**：若外部传入 `relatedStats: null`，写端会先访问 `stats.requests` 抛 `TypeError` 而不是 `invalid(...)`；生产路径不会这样传。
- `relatedFailedSteps`：代码最多产生 `thread/subject/reference/budget/timeout/read` 6 种；写端允许最多 16 条、每条 1..64 字符（`:539-544`），读端补空数组。能通过。
- `participants`：只有 `gmail-source.ts:220` 产生，消费方只有 `gmail-related.ts:31-40`；字段在端口里是可选（`proactive-checks.ts:53`），其他测试/读取器不传也能编译运行。
- `related` / `relatedUnavailable` / `bodyUnavailable`：`proactiveMailView` 产生（`:300-304`），提示词目录有对应说明（`mail.ts:15-17`），解析器 `parseJudgements` 只按 `id/result/...` 取字段，多出来的字段不会导致解析失败。能接受。
- 配置键与文档：`docs/execution/specs` 与 ADR 0180 的默认值 300 已同步；三语言设置说明已同步（`en.ts`/`ja.ts`/`zh-CN.ts` 的 `proactive.apps.what1`）。

**端到端最值得再确认的一点**：`relatedStats.requests`/`durationMs` 是“全部候选的读取”，而 `messages`/`characters` 是“实际发给模型的旧邮件”；同一个 `relatedStats` 对象里混了两种口径。如果账本页面或费用统计按它推断“实际读取成本”，需要先统一口径（见发现 5）。
