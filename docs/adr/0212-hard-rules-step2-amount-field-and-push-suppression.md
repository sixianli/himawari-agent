---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
---

# ADR 0212：硬规则第 2 步，金额字段和“不推送”结果，通知闸门只管邮件

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [和最终方案文档不同的三处](#deviations)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md) 落地了规则手册、字段目录和裁判，并写明第 2 步要做通知闸门、金额字段、合并两套静默时段实现，以及“字段缺失怎么算”。最终方案文档（Andy 2026-11-10 22:21 JST 回复“文档里面要我定的那些，按照你的建议来”）把第 2 步写成“五类推送统一经过一道通知闸门，静默时段延后做进出站队列”。动手前把源码逐处核对，并让两个模型各自出方案、再审线程的方案（花费约 0.29 美元，原文在 `/mnt/project-files/hard-rules-architecture/step2/`），发现其中一块现在做不合适，改成下面的范围。本 ADR 记录实际落地的决定。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 五类推送由 `apps/agent-service/src/production-web-push.ts` 的 `#collect` 入队，`#deliver` 发送；入队对已有的 `source_key` 是 `ON CONFLICT DO NOTHING`；提醒窗口 `REMINDER_WINDOW_MS = 6 * 3_600_000`。
2. 邮件推送在 `packages/application/src/services/proactive-mail-check-service.ts` 创建推送时用 `quietEnd(...)` 算 `readyAt`，那里已有规则手册、设置和地板规则命中。
3. `evaluate` 对缺字段直接报错：`packages/application/src/rules/rule-expression.ts`；ADR 0209 决定 4：“字段缺失或类型不对时直接报错，不当作‘没命中’悄悄放过”。
4. `rule_book_rules` 表没有 `gate` 列，闸门由代码按规则 id 决定：`packages/persistence-sqlite/src/migrations/0086_rule_book.sql`。
5. 邮件判断提示词在 `packages/prompt-catalog/src/mail.ts`，有 golden 快照，检查是 `npm run check:prompt-catalog`。
6. `AttentionPolicyService` 的静默窗口在生产里没有人用：除测试和夹具外，没有任何生产代码构造 `AttentionPolicyService`（`grep -rn "AttentionPolicyService("` 在非测试代码里没有结果）；四处测试和夹具把静默窗口设成 `null`，一个单元测试打开过它。
7. 发给模型的内容只能往后追加：`.agents/instructions/prompt-prefix.md`；后台调用是“固定的在前、会变的在后”。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **金额字段。**邮件判断的输出每封可选带 `"amount":{"value":"100.00","currency":"CNY","confidence":"sure|unsure"}`，只在 act、know、check 里有明确主金额时写。提示词说明追加在 `MAIL_JUDGMENT` 固定文字的末尾（邮件数据和当前时间仍在最后）。程序按固定的币种小数位表（JPY、KRW、VND 0 位；CNY、USD、EUR、GBP、HKD、TWD、SGD、AUD、CAD 2 位；KWD 3 位）把十进制字符串换成整数最小单位，不让模型换算。币种不在表里、格式不对（负数、千分位、指数、超过 15 位）、小数位超过币种、超出安全整数，一律当没有金额。正文被截断、没取到或根本没有时，不管模型怎么写，置信度强制降为不确定。
2. **字段目录给 `mail_item` 加三个永远存在的字段：**`amount_state`（`known`、`uncertain`、`missing`）、`amount_minor`（整数，不是 `known` 时固定为 0）、`amount_currency`（没有金额时为空文字）。“缺失”是字段的值，不是字段缺席，所以 ADR 0209 的“缺字段报错”不变；这就是“字段缺失怎么算”的答案：金额读不出来时，任何金额规则都不命中，邮件照常推送。裁判（`RuleJudge`）在代码里保证：表达式里出现任何 `amount_*` 字段的规则，只有在 `amount_state` 是 `known` 时才会被计算，否则直接跳过、不算命中，不管表达式怎么写（`amount_state != "known"` 这类写法也不会命中读不出金额的邮件）。这是程序保证，不靠规则作者写对，也不靠文字检查。
3. **结果加一种 `suppress_push`**（这封不进推送，仍在提醒页），只允许 `mail_item` 闸门用；每个闸门允许的结果有固定表（`mail_item`：`raise_floor`、`suppress_push`；`mail_delivery`：`defer_to_quiet_hours`），注册检查（`assertRuleShape`）拒绝对不上的。命中地板规则的邮件不会被 `suppress_push` 拦下：地板规则命中就是“不能被降级”。
4. **邮件检查在创建推送时问裁判。**对每条本会进推送、且不是地板规则命中的提醒，用判断出的金额问一次裁判；命中 `suppress_push` 的不进推送、也不计入这次的推送数，提醒仍显示。命中的规则 id 和修订号（`规则id@修订号`，排序后）写进决策记录输入的新字段 `ruleHits`（按邮件 id 分组，旧记录没有这个字段，读出来是空），只记改变结果的命中，原有的 `floorHits`、`ruleIds` 不变。
5. **金额门槛规则生成器。**`amountThresholdRule({currency, minor})`：表达式由代码生成，固定带 `amount_state == "known" && amount_currency == "…"`，自带例子（低于门槛命中；正好等于、高于、币种不同、金额不确定、没有金额都不命中）。本步不接设置界面，只有测试和以后的第 4 步会创建它；邮件检查服务通过选项 `ownerRules` 接收额外的规则（第 4 步会把它接到存储），构造时对每条规则跑一遍例子检查。
6. **静默时段只剩一份实现。**删掉 `AttentionPolicyService` 里没人用的静默窗口（`quietHours` 配置、`isQuietHours`、`quiet_hours` 降级）；邮件的静默延后继续是规则手册加 `quietEnd`，行为不变。
7. **门槛：**`npm run check:rule-registry`（金额换算、字段永远存在、门槛规则正反向例子、裁判跳过未知金额下的金额规则（含各种绕过写法的反向用例），注册检查拒绝不对口的结果）、`npm run check:prompt-catalog`（更新 `mail.judgment` 的 golden 和清单）、`test/integration/proactive-mail-check.test.ts` 里的 `[HR-2]` 用例（正向：小额被拦、提醒页仍在、`ruleHits` 写入；反向：不确定、缺失、他币种、正好等于门槛、币种不认识、数值乱写、没有正文、正文被截断、地板规则命中、没有规则时，都照常推送）。

[返回阅读导航](#contents)

<a id="deviations"></a>

## 和最终方案文档不同的三处

1. **没做“五类推送统一闸门”和出站队列延后。**四个出处（两个模型、线程的核对）都指出：把静默延后做到五类推送，要同时解决已入队项绕过闸门、提醒 6 小时窗口让“23:30 延到 07:00”根本发不出去、审批在静默里过期、决策记录每轮重复写；而第 2 步没有任何会作用于这四类的规则。现在做就是没人用的代码，留到第 4 步第一条真会作用于它们的规则（例如主人说“夜里别提醒我”）出现时一起做。
2. **静默默认只管邮件，其余四类行为不变。**主人自己设的 06:30 提醒是明确指令，不该被默认静默推到 07:00；待审批有时效；Muse 中断是故障告警。最终方案文档里“23:30 到点的提醒延后到 07:00”的例子，要改成第 4 步主人一句话生成的规则。
3. **没有迁移 0087，金额不落库。**金额只在邮件判断出结果、创建推送的那一刻参与规则，不写进明文列，避免财务数据明文扩散；规则命中写进已有的决策记录 JSON。第 4 步需要展示金额时再设计加密存储。迁移号 0087 仍空着，留给下一个要改表结构的步骤。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- 货币金额按“最小货币单位的整数”存，不用浮点：Stripe 文档写明金额以最小货币单位表示（“in the smallest currency unit”），日元这类零小数位币种直接用整数；币种小数位以 ISO 4217 为准（JPY 0、USD 2、KWD 3）。本步照此用固定表，不让模型换算。
- 通知里“重要的不能被规则降级”：本方案沿用现有的地板规则语义，`suppress_push` 绕不过它。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- 让模型直接给整数最小单位：模型不会稳定地处理各币种小数位，换算由程序做。
- 缺金额时让规则报错或当作 0：报错会让一封普通邮件的整次检查失败，当作 0 会让“小于 1000 日元就不推”把读不出金额的邮件也拦掉。
- 现在就接设置界面和存储：第 2 步没有会改变行为的默认规则，接了就是没人用的界面；第 4 步和一句话变规则一起做。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 默认设置、没有金额规则时，给定同一份模型判断，推送逻辑和结果与改动前相同；但邮件判断的固定提示词末尾多了一段金额说明，模型的判断可能因此有细微变化、输出多几个 token，上线后那一个提示词的缓存失效一次。
- 决策记录输入多了可选的 `ruleHits`，旧记录读出来是空对象；写入时有数量和长度校验，程序端写入前去重并最多留 16 条。本步只在决策记录里记，网页的决策链和邮件详情还不展示它，展示留到第 4 步。
- `suppress_push` 现在也会作用于主人自己发出的邮件的提醒（它们不走地板规则）；是否该排除，第 4 步接设置时再定。
- `ProactiveMailCheckService` 多了选项 `ownerRules`，第 4 步把它接到存储，并在那时加上求值次数上限（ADR 0209 已写明）。
- `amountThresholdRule` 现在固定用一个规则 id，第 4 步给不同币种、门槛建多条规则时要自己给 id。
- 通知闸门的其余部分（五类推送统一、出站延后）和对应的规则留给第 4 步。
- 愿景和 ADR 0209 中“通知闸门”的说法，以本 ADR 的范围为准。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md)：规则手册、字段目录、裁判。
- [ADR 0106](0106-proactive-loop-v1-gmail-read-only.md)：决策记录。
- [.agents/instructions/prompt-prefix.md](../../.agents/instructions/prompt-prefix.md)：发给模型的内容只追加。

[返回阅读导航](#contents)
