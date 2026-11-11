## 读代码证实的问题

### 1.【中】实算检查只用一个固定的合成 item，非金额字段的分支可绕过

- 文件：`packages/application/src/rules/rule-book.ts:335-342`、`packages/application/src/rules/rule-book.ts:354-357`
- 问题：`unreadableAmountFacts()` 只用固定的 `{ fromAddress: "a@b.com", subject: "x", snippet: "" }` 生成“缺失/不确定”事实，因此只能证明该规则在“这一封特定合成邮件”上不命中，不能证明金额读不出来时任何真实邮件都不命中。带 `amount_minor` 的规则只要用 `||`/三目把真正的命中条件挂在 `text`、`sender_domain`、`text_words` 等字段上，就能通过检查。
- 证据：

```ts
335: function unreadableAmountFacts(): readonly RuleFacts[] {
336:   const item = { fromAddress: "a@b.com", subject: "x", snippet: "" };
337:   return [
338:     mailItemFacts(item),
...
354:   const compiled = compileRuleExpression(rule.gate, rule.expression);
355:   for (const facts of unreadableAmountFacts())
356:     if (compiled.evaluate(facts))
```

例如：

```text
amount_state == "known" && amount_minor < 1000 || text.contains("invoice")
```

合成 item 的 `text` 是 `"x\n"`，不含 `"invoice"`，所以检查通过；真实发票邮件金额缺失时该表达式会命中并 `suppress_push`。同理，`text_words.all(w, size(w) > 100)` 在合成 item 的 `["x"]` 上为假，但在空 `text_words` 的真实邮件上会因 `all` 空集为真而命中。这直接削弱 ADR 0210 第 2 条“金额读不出来时，任何金额规则都不命中”的保证。

- 建议：把其它字段也纳入对抗事实矩阵（至少 `text` 空/非空、`text_words` 空/非空、不同 `sender_address/domain`），或改成 AST 结构检查，要求 `amount_state == "known"` 及金额条件在整个表达式中起支配作用；并为 `|| text.contains(...)`、三目、空 `text_words` 增加反向用例。

### 2.【中】只引用 `amount_state` 的规则会在实算检查前直接放行

- 文件：`packages/application/src/rules/rule-book.ts:333`、`packages/application/src/rules/rule-book.ts:348-349`
- 问题：`AMOUNT_FIELD` 只匹配 `amount_minor`/`amount_currency`；一旦表达式不引用这两个字段，`assertRuleShape` 立即 `return`，根本不会用“缺失/不确定”事实求值，也不会要求 `amount_state == "known"`。因此只引用 `amount_state` 的规则可以命中金额缺失或不确定的邮件。
- 证据：

```ts
333: const AMOUNT_FIELD = /\bamount_(?:minor|currency)\b/u;
...
348:   const bare = rule.expression.replace(/"(?:[^"\\]|\\.)*"/gu, '""');
349:   if (!AMOUNT_FIELD.test(bare)) return;
```

例如下面这些规则都会被接受：`amount_state == "uncertain"`、`amount_state != "known"`、`amount_state == "missing" && text.contains("invoice")`。第一条在 `parseMailAmount` 返回 `uncertain` 时会命中，第二、三条在 `missing` 时会命中，和 ADR 0210 第 2 条及作者“命中就拒绝”的说法不一致。现有 `[HR-2]` 用例全部使用 `amount_minor`/`amount_currency`，没有覆盖这个缺口。

- 建议：把 `amount_state` 也纳入“金额相关规则”的判定；更稳妥的是对所有可能产生 `suppress_push` 的规则都跑“缺失/不确定”事实（或至少对所有引用任一 `amount_*` 字段的规则跑）。补一条 `amount_state == "uncertain"` 必须被拒绝的用例。

### 3.【低】文字检查只认双引号，可能误拒绝正常金额规则

- 文件：`packages/application/src/rules/rule-book.ts:348`、`packages/application/src/rules/rule-book.ts:350`
- 问题：`bare` 只去掉双引号字符串，`known` 检查也只匹配 `amount_state == "known"`。项目自己的规则表达式用例把单引号字符串 `'1'` 当作可解析内容（期望因 `string()` 被禁而报 `not_allowed`），说明 CEL 解析器很可能接受单引号；于是语义正确的 `amount_state == 'known' && amount_minor < 1000` 会被误拒绝。反过来，`text.contains('amount_minor')` 这种只是搜索文字的规则又会被 `bare` 误认成金额规则。`"known" == amount_state`、`amount_state in ["known"]` 这类等价写法也会被误拒绝。
- 证据：

```ts
348:   const bare = rule.expression.replace(/"(?:[^"\\]|\\.)*"/gu, '""');
350:   if (!/\bamount_state\s*==\s*"known"/u.test(rule.expression))
```

```ts
63:       ["mail_delivery", "string(local_minutes) == '1'"],
...
77:       expect(rejected(gate, source), source).toBe("not_allowed");
```

单引号是否被解析器接受是根据项目用例推断的，未直接运行验证。

- 建议：不要用源码正则判断字段和 `known`，改为解析 AST 后检查 `id` 节点和 `value` 字面量；这样能同时处理单双引号、反向相等和 `in`，也不会把字符串里的文字当成字段引用。至少补上单引号、反向相等的合法金额规则用例。

## 推测 / 未核实

- **推测（未来步骤）**：`amountThresholdRule` 固定返回 `id: "suppress_small_amount"`（`rule-book.ts:31,316`）。规则表主键是 `(owner_id, agent_id, rule_id)`（`migrations/0086_rule_book.sql:10`），如果第 4 步为不同币种/门槛创建多条规则，直接使用生成器会产生同一个 `rule_id`，发生主键冲突或互相覆盖；本 PR 的测试也是手工改写 id 后才造出多条规则（`rule-registry.unit.test.ts:302-303`）。本步没有接存储，所以不是当前线上问题。
- **未核实**：`prompt-manifest.json` 的新 sha256 是否确实等于新 `MAIL_JUDGMENT` 文本；本轮不能运行哈希命令。golden 文件的差异与 `mail.ts` 新增文字一致。
- **未核实**：本轮没有运行任何测试、lint 或 typecheck，只做了代码阅读和 git 差异比对。`.agents/reviews/pr-365/round-1/` 的判定原文不在工作树且被 git 拒绝读取，作者对第 1 轮处理情况的转述只能按代码结果核对。

## 侧重检查

- **不可信模型输入**：`parseMailAmount`/`toMinorUnits` 对非对象、非字符串、负数、千分位、指数、超过 15 位、未知币种、超过安全整数、正文不完整都返回 `missing` 或 `uncertain`（`amount.ts:39-59`），正则锚定且长度有界，未发现注入或类型混淆问题。
- **错误路径**：`suppressPushHits` 先截断到 256、再去重并封顶 16（`proactive-rules.ts:70-73`），能避免 `sqlite-proactive-operations.ts:672-679` 的 `ids(rules, 16)` 和长度 1 到 256 校验失败；构造 `ownerRules` 时 `assertRuleExamples` 失败会直接拒绝启动，属于 fail-closed。但问题 2 的提前返回属于 fail-open。
- **资源耗尽**：`ownerRules` 条数没有上限，`suppressPushHits` 对每条候选邮件都遍历全部规则求值；ADR 0210 已写明第 4 步才加求值次数上限。当前 `ownerRules` 尚未接到生产存储，风险暂时较低。
- **不可撤销操作**：`suppress_push` 只是不创建推送，提醒仍在提醒页；`ruleHits` 写决策记录是追加数据；没有删除或改写历史。提示词变更会造成一次性的固定提示词缓存失效，ADR 已记录。
- **规则/文档/代码一致性**：ADR 0210 第 2 条说“任何金额规则都不命中”，但代码只对引用 `amount_minor`/`amount_currency` 的规则做实算，且只用一个固定 item（问题 1、2）。`ruleHits` 的“去重、最多 16、单条最长 256”与持久化校验两端一致；`amount_state`/`amount_minor`/`amount_currency` 三字段在所有 `mail_item` facts 构造函数中已补齐，编译求值端也要求三字段齐全。
- **静默时段删除**：`AttentionPolicyConfig` 的 `quietHours`、`isQuietHours` 已删除，仓库内剩余构造点不再传该键，非测试生产代码没有其它构造点；未发现遗漏的消费者。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   会改变邮件判断这个后台调用的固定指令段：`MAIL_JUDGMENT.text` 末尾新增了一行（`packages/prompt-catalog/src/mail.ts:32`）。从固定段看是在末尾追加，旧的第 1 到 31 行字节不变；但严格说旧请求的完整字节不是新请求的前缀，因为新行插在“记忆/邮件数据/当前时间”之前。每轮会变的记忆、邮件数据、当前时间仍在固定段之后，`MAIL_JUDGMENT_NOW` 仍是最后一行（`proactive-mail-check-service.ts:389-410`）。工具定义、历史消息、遮盖逻辑均未改。该后台调用没有按对话冻结，所以每次都会使用新固定文字；ADR 0210 已说明这会带来一次缓存失效。按“固定在前、变化在后”的后台调用规则是合规的；但不应把它描述成“整段请求只在末尾追加”。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   没有发现新增的不确定性。`currencyCodes()` 依赖对象字符串键的插入顺序（`amount.ts:31-33`），稳定；`suppressPushHits` 的去重、排序、截断都是确定性的（`proactive-rules.ts:70-73`）；`ruleHits` 排序后写入；新增提示词是固定文字，不包含时间、路径或本轮数据；没有改变遮盖规则或依赖后续上下文的遮盖。因此同样的输入会产生同样的字节。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有新增用例，但覆盖不完整，且本轮未运行：
   - `rule-registry.unit.test.ts` 的 `[HR-2]` 用例覆盖了缺失/不确定命中、`MAX_SAFE_INTEGER` 上限、`toMinorUnits` 溢出、去重和封顶。移除实算循环后第一个用例会失败；移除阈值上限后第二个会失败；去重用例中只看 `toHaveLength(16)` 在“不去重但封顶”时仍可能通过，但 `[one, one]` 的相等断言会让不去重失败，所以这两层都有反向覆盖。
   - `test/integration/proactive-mail-check.test.ts` 的 `[HR-2]` 正向/反向用例覆盖了不确定、缺失、他币种、边界、未知币种、乱写、无正文、正文截断、地板规则和没有规则的情况。
   - 缺口：没有“只引用 `amount_state`”的拒绝用例，也没有“带 `text`/`text_words` 分支或三目绕过固定事实”的用例，也没有单引号/反向相等的合法规则用例；问题 1、2、3 因此不会被现有测试发现。`prompt-catalog` 的 golden 和清单已更新，但我没有运行。
4. **每个值的生产端和使用端是否都能接受？**
   - `amount_state`/`amount_minor`/`amount_currency`：只由 `MISSING_AMOUNT`、`parseMailAmount`、`senderFacts` 产生；`rule-expression.ts` 求值时要求三字段齐全且类型正确；所有 `mail_item` facts 构造点和测试已补齐；字段目录也有说明。三字段本身没有问题，但 `amount_state` 在注册检查里被问题 2 漏掉。
   - `ruleHits`：生产端 `suppressPushHits` 已排序、去重、单条截断到 256、总数封顶 16；持久化端 `sqlite-proactive-operations.ts:672-679` 用 `ids(rules, 16)` 要求唯一且每条长度 1 到 256，两端匹配；旧记录读取端用 `ruleHits ?? {}` 兼容为空对象。主键长度没有新增不一致。
   - `ownerRules`：构造时逐条跑 `assertRuleExamples`，并合并进规则列表；表达式会被编译，失败会拒绝启动。
   - `currencyCodes`：只用于生成“不确定”事实，不进入持久化或提示词。
   - `amountThreshold` 的规则 id：固定为 `suppress_small_amount`，当前只出现在测试和 `ruleHits` 字符串中，尚无存储消费者；未来接规则表时要解决多门槛规则的 id 唯一性问题（见“推测”）。
   - 提示词清单：`changedIn`/`reason` 与改动一致，`mail.judgment.txt` golden 与 `mail.ts` 文本一致；新 sha256 未实际计算验证。
