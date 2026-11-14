## 结论摘要

我按材料核对了改动与代码。整体方向与作者说法一致：新增/修改的提示词都是 `background` 层，T7 的 `money_state`、T3 的单号校验、T4 的失败默认、T2 的失败不确认都基本落地。但有几处实质问题，其中一处会让每日费用上限被明显突破，一处会让旧的浏览器集成测试直接失败。

---

## 读代码证实的问题

### 1. 严重度：高 — 单号抽取的费用没有计入摘要预算，每日上限可被突破

文件：`packages/application/src/services/proactive-mail-check-service.ts:905-911`、`:952-956`

证据：

```ts
const referenceBudget = { spentToday, costMicros: 0 };
...
costMicros += referenceBudget.costMicros;
...
const summaryBudget = {
  spentToday: spentToday + recalled.costMicros,
  reserveMicros: judgmentReserveMicros,
  costMicros: 0,
};
```

`#summaries` 的预算检查是：

```ts
budget.spentToday + budget.costMicros + budget.reserveMicros +
  estimateCostMicros(prompt) > dailyCostMicros
```

但 `summaryBudget.spentToday` 只加了 `recalled.costMicros`，没有加刚刚花掉的 `referenceBudget.costMicros`。单号抽取费用虽然记进了总 `costMicros`，却被摘要预算当成“没花过”。在启用最近摘要时，可达上限被突破接近一倍：例如上限 1000，单号抽取花 900，摘要仍以为只花了 0，可再花约 900，总计远超 1000；之后判断循环才发现超限并停止。

同一处还有第二层问题：`#references` 自己只检查“已花 + 本批预估”，没有为后面的邮件判断预留预算。单号抽取可以花光当天额度，导致真正的邮件判断直接进入 `capped_daily`，本轮完全不判断。

建议：把 `referenceBudget.costMicros` 加进 `summaryBudget.spentToday`（或直接用当时的 `spentToday + costMicros`）；并在单号抽取前扣除/预留一次判断所需的估算费用，或给单号抽取设一个较小上限。

---

### 2. 严重度：中高 — T2 的裁判缓存键用的是 memoryId，不是 ADR 说的“规矩文本”，会复用过期结论

文件：`apps/agent-service/src/production-memory-capture.ts:164-166`、`:1130-1134`

证据：

```ts
export function supportCheckKey(memoryId: string, quote: string): string {
  return `${memoryId}\u0000${quote}`;
}
...
const cacheKey = createHash("sha256")
  .update(`${SUPPORT_JUDGE_VERSION}\u0000${check.key}`)
  .digest("hex");
```

ADR 0249 第 52 行写的是“结果按（规矩文本、引用、提示词版本）在进程内复用”。代码用的是 `memoryId + quote + 提示词版本`，没有规矩文本。记忆的 `id` 可以跨 revision 保持不变（测试里也有 `memory("flight", { revision: 2 })`），同一 id 的文字更新后，旧缓存的 `supports:true` 会被拿来确认新文字，可能错误地把一条待确认记忆转正。确认后再改回代价很大，属于安全默认应当避免的方向。

建议：缓存键至少用 `memoryText`（或 `memoryId + revision`）而不是只用 `memoryId`；补一个“同一 id、文字变了、同一句引用”的反向用例。

---

### 3. 严重度：中 — 单号抽取和“找相关邮件”共用同一个半程超时信号，可能把后者饿死

文件：`packages/application/src/services/proactive-mail-check-service.ts:901-922`

证据：

```ts
const relatedSignal = AbortSignal.any([
  controller.signal,
  AbortSignal.timeout(Math.floor(this.#options.limits.perCheckMs / 2)),
]);
...
: await this.#references(candidates, deadlineAt, relatedSignal, trace, referenceBudget);
...
await this.#related(
  token, candidates, new Set(wholeThreadHits.keys()),
  relatedSignal, trace, references,
);
```

新增的单号抽取先使用 `relatedSignal`。如果模型调用耗到半程超时，`relatedSignal` 已经 abort，紧接着 `#related` 会拿着已 abort 的信号去读邮件，所有邮件都会被标成 `timeout`，核心的“找同一件事的旧邮件”功能反而被这个可选功能挤掉。

建议：给单号抽取单独的、更短的超时（例如 `perCheckMs / 6`），并让 `#related` 使用剩余时间重新构造信号；或者先给 `#related` 留足固定窗口，再决定单号抽取能用多少时间。

---

### 4. 严重度：中 — 浏览器集成测试和夹具没有跟着改，CI 会失败

文件：`test/integration/decision-chain-browser.test.ts:137-140`、`test/e2e/fixtures/control-center-browser-server.mjs:1246-1256`、`apps/control-center/src/i18n/resources/zh-CN.ts:1050`

证据：测试仍然断言：

```ts
const money = drawer.locator('[data-rule-id="floor_money_words"]');
await uiExpect(money).toContainText("词表：账单、扣款、invoice");
await uiExpect(money).toContainText("出处：ADR 0106 第 4 条；ADR 0209 · 第 1 版");
```

而新的中文文案已经是：

```ts
money_words {模型逐封判断“是否涉及你要付出、被扣、可收回或已入账的钱款”，答是就命中}
```

新文案不再渲染 `wording.values`，夹具却仍给 `revision: 1` 和 `wording: { values: ["账单", "扣款", "invoice"] }`。`decision-chain-browser.test.ts` 在 `ci/policy.json` 的 `integration` 项目包含范围内（`test/integration/**/*.test.ts`，未排除），所以这条断言会失败。夹具还伪造了 revision 1 仍有说明文字的状态，和真实 `describeRuleVersion` 对 revision 1 返回 `wording: null` 的行为不符，等于掩盖了 ADR 0248 说的“旧版本查不到”。

建议：夹具改成 revision 2、`wording.values: []`（或直接验证旧 revision 显示“这一版的规则内容查不到”），测试断言改成新文案；顺便检查 `weekly-report.unit.test.ts:1352-1361` 里同样陈旧的夹具。

---

### 5. 严重度：中 — T2 并发发出开头相同的裁判请求，违反 prompt-prefix 第 17 条，并会在同一批里重复调用

文件：`apps/agent-service/src/production-memory-capture.ts:1129-1163`

证据：

```ts
await Promise.all(
  checks.map(async (check, index) => {
    const known = this.#supportCache.get(cacheKey);
    if (known !== undefined) { ... return; }
    ...
    const verdict = await judgeOrDefault({ ask: ... }, false, ...);
```

所有 `checks` 的固定提示词完全相同，只有末尾 JSON 不同。`.claude/rules/prompt-prefix.md` 第 17 条要求“并发发出、开头相同的请求，要等第一个请求开始返回，再发后面的”。这里用 `Promise.all` 一次性全部发出，缓存还没热就并发，浪费缓存收益。

另外缓存是“先查、await、后写”，同一批里若两条 check 生成同一个 `cacheKey`（同一待确认记忆、同一句引用出现两次），两条都会在写入前查不到缓存，导致重复付费调用。

建议：改为按顺序串行（或第一批先发、后续晚一点），并在批内先按 `cacheKey` 去重；补一个重复 check 的反向用例。

---

### 6. 严重度：低 — T4 里“拒答题泄露”没有计入 rejected 统计，和 ADR 说法不一致

文件：`packages/application/src/services/real-memory-eval-service.ts:333-334`

证据：

```ts
if (generated.abstainQuestion !== null && !(await leaksToModel(generated.abstainQuestion)))
  entries.push(["abstain", generated.abstainQuestion]);
```

主问题泄露时会 `rejected["leak"] += 1`；拒答题泄露时只是不加进 `entries`，没有计数。ADR 0249 第 54 行说失败、答非所问都“沿用 `rejected: "leak"`”，这里的摘要计数与文档不一致。

建议：拒答题泄露时也 `rejected["leak"] += 1`（可考虑单独加 `leak_abstain`，但不要静默丢弃）。

---

### 7. 严重度：低 — T3 的“电话号码/账号不是单号”只靠提示词，程序校验不拒绝出现在正文里的电话/账号形状

文件：`packages/application/src/services/proactive-references.ts:5-6`、`:32-43`、`test/integration/proactive-mail-check.test.ts:2655-2666`

证据：

```ts
const REFERENCE_SHAPE = /^(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{7,39}$/u;
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/u;
...
if (!REFERENCE_SHAPE.test(reference) || DATE_SHAPE.test(reference)) continue;
```

程序只排除日期；纯数字的电话、账号、信用卡号只要长度 8–40、含数字且逐字出现在邮件里，就会被接受。反向测试里虽然写了 `"03-1234-5678"`，但测试邮件正文只含 `ORDER`，这个号码并不在正文里，因此通过的原因是“不在原文”，不是“程序认得出这是电话”。这条反向用例没有真正覆盖目标行为。

建议：如果确实要排除电话/账号/验证码，程序再加白名单式形状检查（例如纯数字长度、常见电话分组），并把反向用例改成“号码确实出现在正文里也必须被拒绝”；否则在 ADR 或测试标题里明确这是提示词负责、程序不负责。

---

### 8. 严重度：低 — 盘点文档和测试覆盖说明仍写着旧词表行为

文件：`docs/agent-rulebook-inventory.md:72`、`:207`、`:211`

证据：

- H-3 仍把 `PG-9（“お引落し”）` 列为覆盖测试；但 PG-9 的银行邮件发件人是 `smbc.co.jp`，测试夹具默认 `importantSenders: ["smbc.co.jp"]`（`proactive-mail-check.test.ts:183`、`:850-852`），命中来自重要发件人，不是金钱地板。
- 同文件第 207 行仍写“提示词写‘账单和金钱’，程序是一张具体的中日英词表”；第 211 行仍写“金钱词表现在是规则手册里的内置规则……”。这两句在本次改动后已不成立。

建议：更新 H-3 的覆盖测试编号（改指向新 T7 测试），并把 findings 第 207、211 行的“词表”描述改成 `money_state` 模型判断。

---

## 推测 / 未核实

- 我无法运行测试，只能读代码；因此“浏览器测试会失败”是依据断言、夹具和 i18n 文案确定的推导，未实际执行。
- `prompt-manifest.json` 里三个新提示词的 sha256 是否与 `segments` 完全匹配，我未核实；`apps/agent-service/test/prompt-catalog.unit.test.ts:175-195` 会检查 `PROMPT_MANIFEST_STALE`，如果哈希不对会在 CI 报错。
- `mail.judgment` 的固定文字变了，`TRUSTED_PROMPT_TEXTS` 会随之变化。按 `.claude/rules/prompt-prefix.md` 第 11 条，如果老对话的历史里恰好逐字包含旧固定文字、且其中会被识别为敏感值，那个对话的遮盖字节可能变化一次。我在对话链路里没有看到 `MAIL_JUDGMENT.text` 被写入历史，判断为极低风险，未完全核实全部历史来源。
- T2 的裁判调用经由 `generateTextOnce`，其输入/输出 payload 在 finally 中 release（`production-model-composition.ts:633-635`），所以裁判原答没有像邮件检查那样留在决策记录里。若“每次命中记进决策记录”也要求保存裁判原答，这里需要补记录；我未确认该政策是否只针对规则地板命中。

---

## 侧重检查

- 失败路径：T1 严格解析、失败重试一次、仍失败抛错；T2 `judgeOrDefault(..., false)`，失败不确认；T3 `parseMailReferences` 抛错被 `#references` 的 `catch {}` 吞掉，退化为不搜单号；T4 预算错误重抛、其他错误当泄露。整体失败默认方向正确。
- 不可信输入：邮件正文在 `mail.reference-extraction`、`mail.judgment` 里都被明示为数据；单号最终只允许 `[A-Z0-9-]` 且必须逐字出现在原邮件，再拼进 Gmail 查询，未发现查询注入。Gmail 搜回邮件还要过 `mentions()` 整词复核（`gmail-related.ts:30-42`）。
- 安全：未见新增记录秘密或把秘密写入日志；T2 裁判使用 `plan.request.dataClassification`（由来源消息决定），pending memory 已被 `allowed()` 过滤到不高于来源分级，未发现新的分级降级泄露。T3 提示词发送邮件正文时固定用 `"private"`，与原有邮件判断一致，未发现新增越权。
- 资源耗尽：新增的每个候选最多 3 个单号、按批调用、有每日估算检查、输出有字节上限；T2 缓存上限 500。发现并发同前缀请求和重复调用两处浪费。
- 不可撤销操作：T7 只是把邮件抬到“值得知道”，可恢复；T2 会把手猜的记忆转正，风险最高，缓存键问题是这里的主要隐患。
- 文档一致性：发现 `docs/agent-rulebook-inventory.md` 和浏览器夹具/测试仍描述旧词表行为。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。新增和修改的四个提示词（`mail.judgment`、`mail.reference-extraction`、`memory.confirmation-judge`、`eval.real-memory.leak-judge`）全部是 `layer: "background"` 的后台调用；对话请求的系统提示、工具定义、历史消息没有改动。后台提示词的组装都是“固定指令在前、本次 JSON 数据在后”，每轮会变的数据都在末尾。唯一的理论风险是固定文字变化会改变 `TRUSTED_PROMPT_TEXTS` 白名单，从而在极端情况下影响包含该固定文字的旧对话遮盖；我未发现该文字进入对话历史。依据与这条风险相符，见 `.claude/rules/prompt-prefix.md` 第 4、6、11、15 条。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   没有发现。新提示词都使用 `JSON.stringify` 固定键顺序，数据数组按候选/批次顺序生成，没有时间、随机数或无序集合；出口遮盖使用内容确定的 `maskSensitiveText`。T2 的 `Promise.all` 会让 `verdicts` Map 的插入顺序不确定，但后续只按键查找，不影响发出的字节或候选顺序。缓存键问题影响的是“判断结论是否过期”，不是字节确定性。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有，但不完整。确实会失败的反向用例包括：T7 模型答 `no`/缺字段/非法值时不抬升；T2 裁判答 `false` 或输出非法时不确认；T3 发明号码、非逐字、日期、过短号码不被采用；T4 裁判输出非法或抛错时按泄露处理；预算超限相关用例。缺口是：浏览器集成测试没有更新且会失败；T3 的“电话”反向用例没有让电话真正出现在正文里；T4 测试桩把 leak judge 的成本固定为 0，未覆盖“裁判费用计入预算”的记账；T2 未覆盖“同一 id、文字变了、缓存复用”；未覆盖单号抽取费用遗漏到摘要预算、以及单号抽取饿死判断/相关邮件读取。T1 的 `judgeWithModel`/`judgeOrDefault` 没有独立单测，只有间接集成覆盖。

4. **每个新产生的值，产生方和使用方两端都能接受吗？**
   - `money_state`：`rule-book.ts:76` 产生，`field-catalog.ts` 声明，`rule-book.ts` 的 `money_state == "yes"` 和 `proactive-rules.ts:33` 使用；规则例子、导出标签、测试均已同步，旧规则版本读取也会安全退化。基本一致。
   - 模型输出 `money`：提示词产生，`parseMailMoney`/`parseJudgements` 严格解析，非法值转 `unknown`，`floorHitIds` 使用；两端一致。
   - 规则修订号 1→2：`BUILT_IN_RULES` 产生，`describeRuleVersion` 对 revision 1 返回不可用是设计内行为；数据导出和 i18n 已改。但浏览器夹具和测试仍按 revision 1 旧文案断言，这一端没有接受新值，见问题 4。
   - 新提示词 id/parser/manifest：目录、`usedBy`、`parser`、`prompt-output-contracts` 都已登记；哈希是否匹配未核实，但 manifest 测试会兜底。
   - T2 的 `SupportCheck.key`：产生处用 `memoryId + quote`，ADR 约定用“规矩文本 + 引用 + 版本”，两端不一致，见问题 2。
