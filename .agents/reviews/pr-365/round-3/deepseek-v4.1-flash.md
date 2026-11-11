# 复核结论

未发现可绕过新金额守卫的求值路径；主要问题集中在“用原始表达式文本判断字段”造成的误跳过，以及 ADR、测试与代码之间的不一致。以下按严重度排列。

## 读代码证实的问题

### 1. 中：正则扫原始表达式，字符串字面量里的 `amount_*` 也会让规则被误跳过

**文件:行**：`packages/application/src/rules/rule-book.ts:333-337`、`packages/application/src/rules/rule-judge.ts:28`

**问题**：`usesAmountFields` 对原始表达式做正则匹配，不区分字段引用、字符串字面量和注释。一条只把 `amount_minor` 当普通文字搜索的规则，也会被当成“读了金额字段”，在 `amount_state != "known"` 时被静默跳过。上一轮删除的正是这类用例：

```ts
// 删除前的测试
expect(() =>
  assertRuleShape({ ...rule, expression: 'text.contains("amount_minor") && size(text) > 0' }),
).not.toThrow();
```

旧实现还会先剥掉字符串再判断：

```ts
// 删除前的 assertRuleShape
const bare = rule.expression.replace(/"(?:[^"\\]|\\.)*"/gu, '""');
if (!AMOUNT_FIELD.test(bare)) return;
```

现在的实现：

```ts
const AMOUNT_FIELD = /\bamount_(?:state|minor|currency)\b/u;

export function usesAmountFields(rule: Pick<RuleRecord, "expression">): boolean {
  return AMOUNT_FIELD.test(rule.expression);
}
```

```ts
if (usesAmountFields(rule) && facts["amount_state"] !== "known") continue;
```

这与 ADR 的措辞也不一致。ADR 写的是“表达式里出现任何 `amount_*` **字段**的规则”，而代码匹配的是“原始文本里出现这三个字样”。这不是安全绕过（方向是更保守），但会让正常规则静默失效，包括 `raise_floor` 地板规则；排查时很难看出原因。

**建议**：不要用原始文本正则。按编译后的 AST 中实际引用的变量名判断，或者在匹配前剥掉字符串字面量和注释（旧实现的做法）。同时补一条运行期反向用例：表达式只在字符串里提到 `amount_minor` 时，无论 `amount_state` 是什么都应按原表达式求值。

---

### 2. 低：ADR 说“任何 `amount_*` 字段”，代码只硬编码了三个名字

**文件:行**：`packages/application/src/rules/rule-book.ts:333`、`docs/adr/0210-hard-rules-step2-amount-field-and-push-suppression.md:52`

**问题**：ADR 的保证是“表达式里出现任何 `amount_*` 字段的规则”都受保护，但正则只枚举了 `state|minor|currency`。当前字段目录确实只有这三个，所以今天没有漏洞；以后若在 `field-catalog.ts` 加第四个金额字段（如 `amount_source`），新字段不会触发守卫，而 ADR 仍然宣称“任何”。这是文档与代码的边界不一致。

**建议**：让守卫从 `field-catalog.ts` 或共享的金额字段清单派生，避免两处维护；或者把 ADR 改成明确的三个字段名。

---

### 3. 低：自动检查只证明“不会被绕过”，没有证明“不会误跳过”

**文件:行**：`packages/application/test/rule-registry.unit.test.ts:259-297`、`package.json:58`

**问题**：反向用例确实覆盖了十种写法和缺失/不确定事实，而且如果删掉 `rule-judge.ts:28` 的守卫，第一条表达式 `amount_minor < 1000 || amount_state == "known"` 在缺失金额（`amount_minor = 0`）下就会命中，测试会失败。所以这条守卫有真实的反向保护。

但它没有覆盖“非金额规则被字符串字面量误跳过”：旧的 `text.contains("amount_minor")` 用例被直接删了，也没有替代的运行期用例。因此第 1 条问题不会被 CI 捕获。`assertRuleExamples` 也走原始求值、不应用守卫，注册期和运行期对“字符串里出现字段名”的规则行为不一致：

```ts
export function assertRuleExamples(rule: RuleRecord): void {
  assertRuleShape(rule);
  const compiled = compileRuleExpression(rule.gate, rule.expression);
  for (const example of rule.examples) {
    if (compiled.evaluate(example.facts) !== example.hit)
      throw new Error(`规则 ${rule.id} 的例子不符：${JSON.stringify(example.facts)}`);
  }
}
```

**建议**：在 `rule-registry.unit.test.ts` 增加运行期用例，明确“只在文字里出现 `amount_minor` / `amount_state`”的规则在金额缺失时仍按原表达式求值；如果确实希望连文字提及也跳过，则应在 ADR 和测试里明确写出这个更宽的语义。

---

## 推测 / 未核实

- **推测**：若将来第 4 步从存储加载 `ownerRules` 时只调用 `assertRuleShape` 而不调用 `assertRuleExamples`，坏表达式不会被编译检查；现在 `assertRuleShape` 已不再编译表达式，只剩闸门结果检查。当前生产路径在 `ProactiveMailCheckService` 构造函数里对每条 `ownerRules` 调用了 `assertRuleExamples`，所以今天不构成问题。
- **推测**：金额守卫用 `facts["amount_state"]` 判断，未来若有其他调用方直接构造 `RuleFacts` 并谎报 `known`，守卫就失去意义。当前所有运行期事实都由 `mailItemFacts` 和 `suppressPushHits` 生成，没有这种入口。
- **未核实**：`prompt-manifest.json` 中新的 sha256 是否等于新提示词文本的实际哈希。我没有运行 `check:prompt-catalog`，也没有计算哈希；只能确认 golden 文件已同步更新。
- **未核实**：`cel-js` 是否支持反引号标识符或转义标识符从而在源码层面避开正则。仓库里没有 `node_modules`，我没读库源码。按现有允许的 AST 结构和函数白名单，没有发现动态变量名解析，因此未发现绕过路径。

---

## 侧重检查

查过的错误路径、不可信输入、安全和资源相关点：

- **模型返回的金额不可信**：`parseMailAmount` 校验类型、币种白名单、十进制格式、15 位上限、小数位、安全整数；正文截断/缺失时强制降为 `uncertain`（`packages/application/src/rules/amount.ts:35-55`）。结论：没有直接注入或数值溢出的路径。
- **规则表达式不可信/未来来自设置**：表达式有长度、AST 节点数、深度、列表元素、调用参数上限（`rule-expression.ts:10,31-37`）；`ownerRules` 在服务构造时跑例子检查（`proactive-mail-check-service.ts:519-521`）。结论：当前入口有校验。
- **错误路径**：金额守卫在编译前 `continue`，所以金额未知时坏表达式不会报错；金额已知时才暴露。当前 `ownerRules` 在构造时已编译过，因此生产路径暂时安全；参见上面的“推测”。
- **资源耗尽**：`usesAmountFields` 对每条规则、每封邮件重新跑正则，表达式上限 512 KiB，`ownerRules` 数量没有上限；ADR 已明确把“求值次数上限”推迟到第 4 步。结论：没有新增强制限制，但存在放大成本，属于已记录的延后项。
- **不可撤销操作**：本次增量没有新增写入、删除或推送动作；金额不落库，`ruleHits` 只写决策记录 JSON。没有发现不可逆副作用。
- **规则/文档一致性**：ADR 与代码的两处差异见第 1、2 条；作者说明中“删掉文字检查和合成事实检查”“十种写法 × 两种事实”与代码一致。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？是否仍然只在末尾追加？

- **主对话的系统提示、工具定义、历史消息、遮盖结果没有改动**。本次增量只改规则引擎、ADR 和测试；完整 PR 里与模型输入相关的只有 `mail.judgment` 这个后台提示词。
- `mail.judgment` 的新金额说明加在固定文字的**最后一行**（`packages/prompt-catalog/src/mail.ts:32`），后面仍然依次是记忆、邮件数据、当前时间（`proactive-mail-check-service.ts:389-410`），会变的值仍在最后。
- 但要说准确：这不是“整条请求末尾追加”。旧固定文字是新固定文字的**字节前缀**（旧 `F_old`，新 `F_old + "\n" + 新行`），所以旧缓存能复用到旧固定文字结束处；从新行开始，后面的动态数据全部要重算。ADR 第 94 行也明确写了“上线后那一个提示词的缓存失效一次”。这属于一次性的提示词版本变更，不是每轮变化，也没有改历史消息。若按规则文件第 84 行“会让模型已经见过的请求开头变化就停下来”的字面标准，这次变更确实需要 ADR 记录；ADR 已记录，但是否获得 Andy 同意不在代码里，未核实。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

- 没有发现新的非确定性来源。新增的提示词行是常量；`ruleHits` 在 `suppressPushHits` 里先 `Set` 去重、再 `sort()`、再截断 16 条（`proactive-rules.ts:70-73`），顺序确定；金额不是提示词内容，也不落库。
- 需要区分：同一封邮件文字在不同请求里可能因为模型给出的 `amount`/正文完整性不同而命中不同规则，这是数据状态不同，不是序列化字节不稳定；而且这正是金额规则的设计目的。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

- 有。`npm run check:rule-registry` 显式包含 `packages/application/test/rule-registry.unit.test.ts`（`package.json:58`）；该文件用 10 种表达式 × 缺失/不确定两组事实验证守卫（`rule-registry.unit.test.ts:259-297`）。
- 反向用例会失败：如果删掉 `rule-judge.ts:28`，第一条表达式在缺失金额下会因 `amount_minor = 0` 命中；`amount_state != "known"`、`amount_state == "missing" && text.contains("Invoice")` 等也会命中。因此它能证明守卫不是摆设。
- 缺口在第 3 条问题：没有覆盖“字符串字面量里的字段名”这种误跳过，也没有覆盖 `assertRuleExamples` 与运行期守卫的一致性。

### 4. 新值/改动值在产生端和使用端都能被接受吗？

- **`usesAmountFields`**：只在 `rule-judge.ts:28` 使用；正则没有 `g` 标志，不存在 `lastIndex` 状态问题。没有其他调用方。
- **删除的 `currencyCodes`**：全仓库已无引用，删除安全。
- **`ruleHits`**：产生端是 `suppressPushHits`，返回去重、排序、最多 16 条、每条 `${id}@${revision}` 截到 256 字符；持久化端 `sqlite-proactive-operations.ts:645-649,672-679` 要求数组长度 ≤16、每项字符串 1..256、无重复，消息 key 1..256。两端一致。读取端 `sqlite-decision-ledger-operations.ts:175-182` 对旧记录缺省为 `{}`。`floorHits` 原有的 key 长度限制也适用于 `ruleHits`，没有新增格式约束。
- **`amount` 对象**：产生端是模型输出，使用端 `parseMailAmount` 做完整校验；不落库，因此后端没有新的校验面。
- **提示词清单项**：`prompt-manifest.json` 的 `mail.judgment.sha256` 已改，golden 已改；哈希计算未核实（见“未核实”）。
- **`ruleIds` 与 `ruleHits` 的分工**：`ruleIds` 仍只来自 `floorHits`，不包含 `suppress_push` 规则；ADR 明确说“原有的 `floorHits`、`ruleIds` 不变”，两者一致。
