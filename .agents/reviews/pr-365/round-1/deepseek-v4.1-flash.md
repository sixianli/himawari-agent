## 侧重检查

我按你的侧重检查了这些路径（均为静态阅读，未运行 `npm run check`）：

- **不可信输入/金额解析**：模型输出不是字符串、币种不认识、负数、千分位、指数、超过 15 位、超出安全整数时，`toMinorUnits` 都会返回 `undefined`，`parseMailAmount` 降为 `missing`；不会误算成小额。正文不完整时降为 `uncertain`。
- **错误路径**：正文没读到、截断、他币种、正好等于门槛、地板规则命中，都不应被拦；代码路径与测试用例一致。
- **资源耗尽**：`ownerRules` 没有数量/表达式求值次数上限（ADR 已写明求值上限留到第 4 步）；`ruleHits` 生产者没有上限，而持久化校验有 16 条上限，见下文问题。
- **安全/不可撤销操作**：金额只参与当次判断，没有落库；`suppress_push` 只阻止推送，提醒页仍保留；没看到新的秘密值写日志。
- **规则/文档一致性**：`AttentionPolicyService` 确实没有生产构造点，静默窗口删除与 ADR 前提一致；但 ADR 关于金额规则“机械防线”和“默认行为逐字相同”的说法与代码不完全一致。

## 读代码证实的问题（按严重度）

### 1. 中 — `assertRuleShape` 只做文本匹配，挡不住 OR/否定式绕过

文件：`packages/application/src/rules/rule-book.ts:329`

问题：它只检查表达式里是否“出现过”`amount_state == "known"`，并不保证它是金额字段的必要条件。

证据：

```ts
const bare = rule.expression.replace(/"(?:[^"\\]|\\.)*"/gu, '""');
if (
  /\bamount_(?:minor|currency)\b/u.test(bare) &&
  !/\bamount_state\s*==\s*"known"/u.test(rule.expression)
)
```

反例：`amount_minor < 1000 || amount_state == "known"`。`bare` 仍含 `amount_minor`，原文也含 `amount_state == "known"`，所以通过检查；但金额缺失时 `amount_minor` 固定为 0，条件为真，会拦下“金额读不出来”的邮件。这正是 ADR 0210 第 52 行声称要防的情况。现有反向用例只测了 `amount_minor < 1000` 和 `amount_state == "missing"`，没有测 OR/否定（`packages/application/test/rule-registry.unit.test.ts:251`）。

建议：改成语义检查，而不是文本检查。最简单的做法是：规则只要引用了 `amount_minor`/`amount_currency`，就强制要求包含 `amount_state: "missing"`、`"uncertain"` 且预期为 `false` 的例子；更严格可以解析 AST，要求 `amount_state == "known"` 是所有金额字段引用的必要条件。并补 OR、否定、三目表达式的反向用例。

### 2. 中低 — `ruleHits` 生产端可超过或重复，持久化端会整条拒绝

文件：`packages/application/src/services/proactive-rules.ts:65`、`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:645`

问题：`suppressPushHits` 返回所有命中的 `id@revision`，不截断、不去重；而持久化校验要求每条邮件最多 16 个、且字符串去重后长度不变。超过 16 条命中，或两条规则同 id 同 revision，会让整次决策记录写入失败。

证据：

```ts
return JUDGE.decide("mail_item", mailItemFacts(item, amount), rules)
  .hits.filter(({ outcome }) => outcome === "suppress_push")
  .map(({ id, revision }) => `${id}@${revision}`);
```

```ts
const ids = (value: unknown, max: number) =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 256) &&
  new Set(value).size === value.length;
...
!ids(rules, 16)
```

后果是模型调用已经发生、结果也判断完了，最后记录失败。当前生产没有接 `ownerRules`，所以是潜在问题；但第 4 步接存储后会变成真实错误路径。另外规则 id 过长（`id@revision` 超过 256）也会触发同样结果，`assertRuleExamples` 并不检查 id 长度。

建议：在 `suppressPushHits` 或服务层截断/去重；在构造函数里校验 `id`、`revision` 生成后的长度；补 17 条命中、重复 id、超长 id 的用例。

### 3. 低 — “超出安全整数”分支没有真正被测试覆盖

文件：`packages/application/src/rules/amount.ts:39`、`packages/application/test/rule-registry.unit.test.ts:203`

证据：

```ts
const match = /^(\d{1,15})(?:\.(\d{1,15}))?$/u.exec(value.trim());
...
const minor = Number(`${match[1]}${fraction.padEnd(exponent, "0")}`);
return Number.isSafeInteger(minor) ? minor : undefined;
```

测试里的 `toMinorUnits("9".repeat(16), "USD")` 是被正则的 15 位上限挡掉的，没有走到 `Number.isSafeInteger`。要覆盖安全整数溢出，需要像 KWD 这种 3 位小数币种，例如 `toMinorUnits("100000000000000.5", "KWD")`，正则通过但 `Number` 结果不安全。代码本身看起来是正确的，问题只是门槛没有真正覆盖作者声称的“超出安全整数”。

建议：补一个 15 位整数 + 小数的 KWD 用例，并确认返回 `undefined`。

### 4. 低 — “默认设置下逐字相同/不改变任何现有行为”与提示词改动矛盾

文件：`packages/prompt-catalog/src/mail.ts:32`、`docs/adr/0210-hard-rules-step2-amount-field-and-push-suppression.md:94`

代码证实：新金额说明无条件追加到所有邮件判断请求；`apps/agent-service/src/production-proactive.ts:161` 构造服务时并没有传 `ownerRules`，所以推送闸门本身在生产里是空的，但提示词已经变了。模型输出不保证不变，额外指令也可能改变判断、增加输出 token。

ADR 写的是：

> 默认设置、没有金额规则时，邮件检查和推送的结果与改动前逐字相同

严格说只能保证“给定同一份模型判断结果时，推送逻辑相同”；不能保证模型判断结果逐字相同。建议改成“推送逻辑不变；提示词变化可能导致模型判断漂移并增加输出 token，上线时缓存失效一次”。

### 5. 低 — `ruleHits` 已写入和读出，但没有展示消费方；通用 append 路径还会丢弃它

文件：`apps/agent-service/src/production-observation.ts:322`、`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:98`

证据：`production-observation` 的 `forMail` 只接受 `floorHits`、`memoryByMail`、`relatedByMail`，邮件详情里的 `ruleIds` 也只取 `floorHits`：

```ts
const forMail = (field: "floorHits" | "memoryByMail" | "relatedByMail") => ...
...
ruleIds: forMail("floorHits"),
```

因此“因为金额规则没有推送”这个原因不会出现在现有决策链/邮件详情里。另一方面，`ruleHits` 被加进了共享的 `DecisionInputs`，但非 proactive 的 `insertLedgerRow` 只写 `memoryIds`、`ruleIds`、`batchId`、`resultMemoryIds`，会静默丢掉 `ruleHits`。

建议：要么明确文档写“本步仅内部记录，不展示”，要么把 `ruleHits` 接到决策链/邮件详情；如果保留在共享 `DecisionInputs`，要么让通用 append 也持久化它，要么把它移进 proactive 专用类型，避免类型承诺与实现不一致。

### 6. 低 — 最大安全整数阈值会生成非法例子

文件：`packages/application/src/rules/rule-book.ts:298`

`amountThresholdExpression` 接受 `Number.MAX_SAFE_INTEGER`，但生成器随后构造 `known(parameters.minor + 1)`；这个值不再是安全整数，`assertRuleExamples` 求值时会抛“字段 amount_minor 缺失或不是整数”。阈值这么极端不现实，但代码内部前后不一致。

建议：在 `amountThresholdExpression` 里限制上限，或生成例子时避免 `minor + 1` 溢出。

## 推测/未核实

- CEL 是否支持单引号字符串、从而进一步绕过 `bare` 擦除；我没有运行 CEL，无法确认。上面的 OR 绕过不依赖这一点，已经足够。
- 第 4 步接存储后是否会出现超过 16 条同时命中的金额规则，属于推测；当前生产没有接 `ownerRules`。
- 提示词改动实际造成多大的模型判断漂移，无法从代码确认；测试用的是脚本化模型输出。
- `prompt-manifest.json` 的新 sha256 没有复算；`npm run check` 的结果也没有实际运行验证。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   会话侧没有改：系统提示、工具定义、历史消息都没动，`MAIL_JUDGMENT` 只用于后台邮件判断。后台判断的固定文字末尾追加了一行，插入点之前的字节不变；邮件数据、记忆、当前时间仍在后面，新增文字不包含时间等每轮变化值。所以符合“只在固定前缀末尾追加、变量留在最后”的规则。
   但“不会改变模型已经见过的请求开头”只能理解为“插入点之前不变”；严格说后台固定提示词本身变了，插入点之后（新行及其后的数据）会重算一次缓存。ADR 也承认了这次缓存失效。

2. **同一段文字会不会在不同请求里变成不同字节？**
   模型请求侧不会：新增的是固定文字，没有时间/路径等变化值；`ruleHits` 不进提示词；`suppressPushHits` 结果写入前排序。`amount` 解析对同一输入是确定的。
   唯一可注意的是：`ruleHits` 对象里的邮件 key 顺序沿用候选邮件顺序，数组虽排序但对象 key 没有排序；它只写入决策记录，不发给模型，因此不影响请求字节，和现有 `floorHits` 的做法一致。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有：`[HR-2]` 单元测试覆盖金额换算、字段永远存在、门槛规则正/反向例子；集成测试覆盖小额被拦、提醒页保留、`ruleHits` 写入，以及不确定/缺失/他币种/边界/未知币种/乱写/无正文/正文截断/地板命中/无规则时照常推送；提示词有 golden 和 manifest。
   不足：`assertRuleShape` 的反向用例没有覆盖 OR/否定，因此上面第 1 条不会被现有测试抓住；安全整数溢出分支、旧记录没有 `ruleHits` 的读取、`ruleHits` 超过 16 条或重复 id 的写入校验也没有直接用例。测试未实际运行，无法确认“去掉修复后是否真失败”。

4. **每个新值的使用方都能接受吗？**
   - `amount_state`/`amount_minor`/`amount_currency`：`senderFacts` 永远提供三者；`compileRuleExpression.evaluate` 要求该闸门所有字段都存在，所有邮件事实都经 `mailItemFacts` 构造，测试里的手工事实也已补齐。两端匹配。
   - `suppress_push`：`GATE_OUTCOMES` 允许 `mail_item` 使用，`suppressPushHits` 只取该结果；没有其他 switch 需要扩展。匹配。
   - `ruleHits`：当前生成的 `suppress_small_amount@3` 能通过 SQLite 的 key/value 长度和去重校验，旧记录 `?? {}` 读成空。但生产端没有上限/去重，和消费者的 16 条/唯一性约束不一致；共享 `DecisionInputs` 的通用 append 路径也不会持久化它。
   - 提示词清单：golden 已同步，sha256 未复算。
   - `quietHours` 配置键：生产代码确实没有 `AttentionPolicyService` 构造点，测试和夹具已移除；删除后没有遗留的 `quiet_hours` reason 消费者。匹配。
   - ADR 0210：金额字段、闸门结果表、不迁移/金额不落库、静默窗口删除基本与代码一致；但“机械防线”和“默认设置逐字相同”两处说法过强，见上面第 1、4 条。
