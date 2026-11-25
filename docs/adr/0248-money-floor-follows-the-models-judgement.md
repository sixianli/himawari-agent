---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0209-rule-book-with-cel-expressions-and-judge.md"
date: "2026-11-12"
covers: "packages/application/src/rules/field-catalog.ts, packages/application/src/services/proactive-rules.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0248：邮件“涉钱”地板规则改由模型判断，不再读词表

> 2026-11-25 补：Gmail 检查不再调用模型逐封判断，新邮件改为进收件箱、由主对话里的她自己决定要不要告诉主人（[ADR 0285](0285-one-main-thread-subthreads-and-one-inbox.md) 第 1 步，PR 648）。本文里关于邮件判断提示词、判断结果和判断前带给模型的内容的部分已不再执行；规则手册、决策记录等其余部分照旧。

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

内置规则 `floor_money_words` 原来靠“钱相关词”判断邮件涉不涉钱（`docs/adr/0209-rule-book-with-cel-expressions-and-judge.md` 第 42 行：“写死了三条‘地板规则’（重要发件人、公共机构域名后缀、钱相关词）”）。凭词判断认不出词表外的说法，也会被促销文案里的同一个词骗到。Andy 在 2026-11-12 定的 agent 开发基本原则是：理解用户或邮件意思一律交给模型判断，不用关键词表或正则。设计线程的整合方案把这一条列为 T7，Andy 同意。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 规则 id 已写进决策记录，不能改：`docs/adr/0209-rule-book-with-cel-expressions-and-judge.md` 第 42 行，“三条地板规则的 id（`floor_important_sender`、`floor_public_domain`、`floor_money_words`）已写进决策记录，所以保持不变。”
2. 地板的作用是“判断模型已经给出结论后，涉钱邮件至少升到要知道”：`packages/application/src/services/proactive-rules.ts` 的 [applyFloor](https://github.com/sixianli/himawari-agent/blob/9a395ec730b7c96519309bf1199355a04d8199aa/packages/application/src/services/proactive-rules.ts)，`ignore` 命中地板变 `know`，`unsure` 或 `check` 变 `check`，`act` 不动。
3. 先例：邮件金额由模型给、规则读：`packages/application/src/rules/field-catalog.ts` 的 `amount_state` 字段和 `rules/amount.ts` 的 `parseMailAmount`，`suppress_small_amount` 规则读它。
4. 地板命中在判断之后计算：`proactive-mail-check-service.ts` 里逐封邮件先取 `judged.get(item.messageId)` 再算 `floorHitIds`；判断之前用同一份邮件事实算的是 `outcomeHits`（要读整串、一定提醒），它们不读涉钱事实。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 邮件判断提示词（`mail.judgment`）要求每封邮件（包括判 `ignore` 的）多写一项 `"money"`：`"yes"` 表示涉及主人要付出、被扣、可收回或已入账的具体钱款事项，`"no"` 表示不涉及，促销里的标价、折扣和积分不算。
2. 规则事实新增 `money_state`（`yes`、`no`、`unknown`，永远存在）。解析严格：只认 `yes` 和 `no`，别的值、缺字段都是 `unknown`；判断之前、判断失败、模型没给时也是 `unknown`。
3. `floor_money_words` 的表达式改为 `money_state == "yes"`，规则 id 不变，版本升到 2，来源加上本 ADR。删掉 [MONEY_SUBSTRINGS](https://github.com/sixianli/himawari-agent/blob/8d83c29ea88633f1990b7c0ae4d1460d57e00a6b/packages/application/src/rules/rule-book.ts)、[MONEY_WORDS](https://github.com/sixianli/himawari-agent/blob/8d83c29ea88633f1990b7c0ae4d1460d57e00a6b/packages/application/src/rules/rule-book.ts) 两张词表和 `BUILT_IN_RULE_VALUES` 里对应的项。规则自带的例子改成带 `money_state` 的事实：账单类 `yes` 命中；“billingual newsletter”“Lunch on Friday”这类 `no` 不命中；`unknown` 不命中。
4. 失败默认是“不命中”，等于没有这条地板，判断模型自己的结论照常生效；不因此放行或拦截别的事。每次命中的事实和模型原答照旧记进决策记录（[ADR 0147](0147-keep-model-prompt-and-answer-of-each-gmail-check-with-the-ledger.md)）。
5. 每日成本用尽、没有判断的邮件没有涉钱事实，所以不再因词表被抬到“要看”；这是接受的取舍，见后果。
6. 旧的“新旧实现 2 万封逐字等价”测试只保留重要发件人和公共机构域名两条；涉钱这条换成解析与规则的确定性测试，以及“扣款成功通知”这类词表命中、模型答 `no` 时不命中的反向用例。
7. 界面和数据导出里这条规则的说明文字改成“模型逐封判断是否涉及钱款”，不再显示词表。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

用模型从文本里抽取结构化字段、程序校验字段格式再交给规则引擎，是 OpenAI 和 Anthropic 文档里的通用做法（<https://developers.openai.com/api/docs/guides/structured-outputs>）。本项目的 `amount_state` 已经是这个形状，`money_state` 沿用它。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **保留词表当第二道保险（词表命中或模型答是都算）。**词表误命中的促销邮件会继续被抬高，且没有解决词表认不出新说法的问题，和“理解意思交给模型”的原则冲突。
- **让判断模型自己把 ignore 改成 know。**地板是程序执行的硬规则，要在决策记录里留下规则编号；让模型直接改结论就没有这一层。
- **另开一次模型调用专门判涉钱。**多一次调用、多一份费用；判断提示词本来就在读每封邮件，顺带多写一项即可。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：认得出词表外的说法，促销里的“账单”“折扣”不再误命中。
- 代价：模型漏答或答错时这条地板失效（失败默认不命中）；每日成本用尽那一轮没有模型判断，涉钱邮件不再靠词表被抬成“要看”。旧决策记录里已存的 `floor_money_words@1`，在界面上显示“这一版的规则内容查不到”，因为版本 1 的词表已删。已存的、没有 `floorHit` 记录的旧提醒行在读取时无法再按词表补判。
- 判断提示词变了：只影响后台的邮件判断调用，不属于对话请求的开头，属于 `.agents/instructions/prompt-prefix.md` 第 15 条说的后台调用。

[返回阅读导航](#contents)
