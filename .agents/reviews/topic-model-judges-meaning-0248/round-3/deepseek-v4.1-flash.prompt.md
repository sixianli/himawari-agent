你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 e82d7f26ae55b1f55f19b508cd6e9c5b51299062。
待核对的方案：
方案文件：docs/adr/0248-money-floor-follows-the-models-judgement.md（在提交 e82d7f26ae55b1f55f19b508cd6e9c5b51299062 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0209-rule-book-with-cel-expressions-and-judge.md"
date: "2026-11-12"
---

# ADR 0248：邮件“涉钱”地板规则改由模型判断，不再读词表

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
2. 地板的作用是“判断模型已经给出结论后，涉钱邮件至少升到要知道”：`packages/application/src/services/proactive-rules.ts` 的 `applyFloor`，`ignore` 命中地板变 `know`，`unsure` 或 `check` 变 `check`，`act` 不动。
3. 先例：邮件金额由模型给、规则读：`packages/application/src/rules/field-catalog.ts` 的 `amount_state` 字段和 `rules/amount.ts` 的 `parseMailAmount`，`suppress_small_amount` 规则读它。
4. 地板命中在判断之后计算：`proactive-mail-check-service.ts` 里逐封邮件先取 `judged.get(item.messageId)` 再算 `floorHitIds`；判断之前用同一份邮件事实算的是 `outcomeHits`（要读整串、一定提醒），它们不读涉钱事实。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 邮件判断提示词（`mail.judgment`）要求每封邮件（包括判 `ignore` 的）多写一项 `"money"`：`"yes"` 表示涉及主人要付出、被扣、可收回或已入账的具体钱款事项，`"no"` 表示不涉及，促销里的标价、折扣和积分不算。
2. 规则事实新增 `money_state`（`yes`、`no`、`unknown`，永远存在）。解析严格：只认 `yes` 和 `no`，别的值、缺字段都是 `unknown`；判断之前、判断失败、模型没给时也是 `unknown`。
3. `floor_money_words` 的表达式改为 `money_state == "yes"`，规则 id 不变，版本升到 2，来源加上本 ADR。删掉 `MONEY_SUBSTRINGS`、`MONEY_WORDS` 两张词表和 `BUILT_IN_RULE_VALUES` 里对应的项。规则自带的例子改成带 `money_state` 的事实：账单类 `yes` 命中；“billingual newsletter”“Lunch on Friday”这类 `no` 不命中；`unknown` 不命中。
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
- 判断提示词变了：只影响后台的邮件判断调用，不属于对话请求的开头，属于 `.claude/rules/prompt-prefix.md` 第 15 条说的后台调用。

[返回阅读导航](#contents)
