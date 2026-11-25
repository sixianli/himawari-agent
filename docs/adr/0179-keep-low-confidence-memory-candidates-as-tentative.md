---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0143-decision-ledger-for-model-gate-decisions.md"
date: "2026-11-08"
covers: "packages/application/src/services/automatic-memory-service.ts, packages/application/src/services/proactive-mail-check-service.ts, packages/application/test/tentative-memory-capture.unit.test.ts, packages/calibration/src/thresholds.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0179：分数不够自动存入门槛的记忆候选，存成「待确认」记忆，只给主动检查当线索

> 2026-11-25 补：Gmail 检查不再调用模型逐封判断，新邮件改为进收件箱、由主对话里的她自己决定要不要告诉主人（[ADR 0285](0285-one-main-thread-subthreads-and-one-inbox.md) 第 1 步，PR 648）。本文里关于邮件判断提示词、判断结果和判断前带给模型的内容的部分已不再执行；规则手册、决策记录等其余部分照旧。

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-decisions)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

每轮对话结束后，后台抽取（`AutomaticMemoryService`）会让模型提出若干条想记住的候选，每条带一个置信度分数（千分制）：主人亲口说的高，模型推测的低（推测类最高只给 700）。分数低于自动存入门槛 850 的候选，原来直接丢掉，只在决策账本里留一行 `confidence_below_threshold`（`packages/application/src/services/automatic-memory-service.ts`）。

结果是 Himawari 用不上主人没特意强调过的偏好。例子：主人聊天时说过「今天又去抱持服部拿信件」「好家里只喝明治的牛奶」，模型推出「主人偏好明治乳制品」，这是推测，被丢掉；之后收到超市打折邮件，主动检查就没有这条线索。Muse（Andy 每天在用的对照组）会用上这类偏好，这是「追平线」里 PA 组的一个已知差距。

记忆里本来就有「待确认」标记（`attributes.tentative`）：它不进主人档案块（`owner-profile-service.ts` 的 `currentlyValid`）、默认不进向量检索（`sqlite-memory-operations.ts` 的 `indexScope`，现在是 `@includeTentative = 1 OR m.tentative = 0`）、不触发提醒；主人再次说起同一件事（`unchanged`）时自动转正（本 ADR 决定 6 起要求带原话）。

对标：OpenAI 的 ChatGPT 把主人明说要记的「已保存记忆」和从聊天历史里推断出的内容分开，推断的部分由「引用聊天记录」开关控制，回答下方的 Sources 按钮显示影响了这次回答的记忆和历史对话（[Memory in ChatGPT](https://help.openai.com/en/articles/8590148-memory-in-chatgpt)）。做法一致的地方是：推测的内容与明说的分开存、能看到用了什么。Claude 一侧我没有查到一手来源，未核实。

<a id="owner-decisions"></a>

## Andy 的原话

任务块 PA-2（2026-10-31 写成，2026-11-07 Andy 交给线程）：「这些候选不丢，存成「待确认」记忆，带上来自 Andy 哪句话和置信度；主动检查可以拿待确认记忆当参考，并在决策账本里记下这次用了哪几条；普通聊天里每轮自动带上的「主人档案」仍不放待确认记忆，避免把猜的当事实说出口；待确认记忆什么时候转成正式记忆，等 Andy 对提醒的评价数据放出来再定，这块不动。」

2026-11-08 Andy 对线程贴的变更清单回复：「同意」。

2026-11-08 复核后，线程在决策卡上问「待确认记忆被模型 unchanged 或 update 转正时，要不要求带主人原话？」，Andy 选了「要求带原话」。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

依据的原则：愿景原则 3「记忆可靠性」与原则 4「主动性与效率」的权衡，靠来源和决策账本保持可逆。

1. **低分候选改存为待确认记忆。** 同时满足这些条件才存：①候选是新建（`create`）；②抽取时在主人原话里核对到了引用（`quote` 非空，即 `evidenceVerified`）；③不带提醒、不带人物（待确认记忆不登记提醒和人物，而主人之后点「确认」也不会补登记，所以这类候选继续丢弃，行为与以前相同）；④不是密钥、不是受限，不是暂时性内容，不是敏感类（敏感类仍走审批）。存下来的记忆带 `tentative: true`、`inference`、置信度、来源线程和原话引用；决策账本记 `kept`，原因码 `kept_tentative`，抽取审计记 `tentative_kept`。自动存入门槛 850 不变。
2. **其余低分候选照旧丢弃。** 对已有记忆的更新、合并、不变类，低分猜测不得覆盖正式记忆，也不得因「不变」而把已有待确认记忆转正；没有原话引用的说不清来自哪句话，不存。待确认记忆不顶替正式记忆（候选带的 `supersedes` 去掉）；不登记提醒和人物（跳过提交后的副作用）。
3. **向量检索加一个默认关闭的开关 `includeTentative`。** 主动检查的记忆召回（[production-proactive-memory.ts](https://github.com/sixianli/himawari-agent/blob/9a395ec730b7c96519309bf1199355a04d8199aa/apps/agent-service/src/production-proactive-memory.ts)）和聊天里的记忆检索工具（`production-memory-recall.ts`）打开；档案块、提醒、记忆整理都不变。聊天检索返回的待确认记忆多一个 `tentative: true` 字段，结果里再附一句固定说明（提示词 `tool-result.recall-tentative`）：这是系统推测、主人没确认过，只能当线索，不能当事实说出口。做法是两次检索：一次和原来完全一样（不含待确认），一次带 `includeTentative` 加 `tentativeOnly`，在索引层只取待确认的；结果里正式记忆在前、待确认在后，待确认最多占请求条数的一半（正式记忆因此最多少返回这么多条，请求 1 条时不检索待确认）。待确认记忆不会改变正式记忆的名次，没有待确认记忆时与原来逐字节相同；代价是每次聊天检索多一次对同一问题的向量化。这些字段和说明只出现在工具返回值里，不改工具定义和系统提示；没有待确认记忆时，返回值与原来逐字节相同（Andy 2026-11-08 重发 PA-2 任务块，要求聊天检索返回时标「待确认」，回「同意」）。
4. **主动检查的提示里，待确认记忆单独标出。** 该条目多一个 `"tentative":true` 字段，并在记忆段后追加一句固定说明（提示词 `mail.judgment.tentative-note`）：这是系统推测、主人没确认过，只能当线索，不能单凭它判 `act`。这条约束只在提示词里，代码不强制（没有「只凭待确认记忆就降级」的兜底）；误判的成本由账本的 `tentativeMemoryIds`（本次送给模型的待确认记忆；真正用上的是它与 `usedMemoryIds` 的交集） 加主人评价来观察。没有待确认记忆时，提示与原来逐字节相同；确认过的记忆条目的字节也不变。
5. **账本记引用。** 主动检查的账本输入沿用 `memoryIds`、`usedMemoryIds`、`memoryByMail`（用了哪几条），另加 `tentativeMemoryIds`（本次送给模型的待确认记忆），使以后能单独统计「待确认记忆有没有帮上忙」，记忆转正后这条历史也不丢。
6. **转正必须有主人自己的原话（Andy 2026-11-08 选定）。** 抽取时，模型对一条待确认记忆输出 `unchanged`、`update` 或 `merge`，必须带在主人本次消息里逐字核对到的原话引用，没有就丢弃（记为原话未核实，同「原话校验不过」），不转正；有原话还要和那条记忆相关：原话与那条待确认记忆自己的文字（不用模型这次输出的候选文字，它可以被抄进去绕过）去掉「主人」「喜欢」「的」这类到处都有的词后，至少共享一个连续两个字（中文）或一个单词，否则同样丢弃、不转正（Andy 2026-11-08 听过「拿无关的话当证据」的例子后说“肯定不行”）。字面判断对不上同义词（「牛奶」对「乳制品」），误拦的代价只是少转正一次。通过这两关才走现有的转正逻辑。主人在记忆页手动点「确认」不受影响。自动存入门槛 850 和其他转正逻辑不动。（2026-11-11 起，P4-7：通过这两关后，候选还要过「待确认记忆转正」门槛（`memory_candidate.confirm_tentative`，登记在 `packages/calibration/src/thresholds.ts`，默认 850、可按分类覆盖），不再用自动存入门槛；`unchanged` 按那条记忆原有的分类查门槛，`update`、`merge` 按候选给出的新分类查。账本原因码为 `tentative_confirmed` 和 `confirm_below_threshold`。默认值与原来相同，转正与否不变。）

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **把门槛调低**：低分的猜测直接成为正式记忆，会进档案块，被当成事实说出口，违反原则 3。放弃。
- **另建一张「线索」表**：要迁移和一套新的读写，而待确认标记已经存在并且已被档案块、检索、提醒排除。放弃。
- **本方案**：复用现有标记，只给主动检查开一个入口。

<a id="consequences"></a>

## 后果

- 记忆会多出推测类条目，本次不加上限和过期，只靠账本观察数量。
- 记忆整理产生的「洞察」（`reflect`，本来就标待确认）也可能被主动检查召回，作为线索使用（`rule` 类仍被排除，且受相似度门槛和条数限制）。
- 召回时待确认记忆与正式记忆按分数同权排序，可能占用名额；记忆抽取给模型看的「最近记忆」列表里，正式记忆排在待确认记忆之前，避免新增的待确认记忆把正式记忆挤出前 20 条。
- 抽取给模型的已有记忆列表里看不出哪条是待确认，模型对待确认记忆输出不带原话的 `unchanged`、`update`、`merge` 会被丢弃；这类候选每次丢弃都记在账本里，可以据此观察有多少次被挡。
- 抽取的审计记录多一种结果 `tentative_kept`；账本里 `kept` 的原因码多一种 `kept_tentative`。
- 主动检查的提示多一段固定说明，只在有待确认记忆时出现，属于后台调用，不改变任何对话已发出的开头。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0158](https://github.com/sixianli/himawari-agent/blob/9a395ec730b7c96519309bf1199355a04d8199aa/docs/adr/0158-bring-related-memories-into-gmail-checks.md)：主动检查带相关记忆
- [产品愿景](../product-vision.md)
- 代码：`packages/application/src/services/automatic-memory-service.ts`、[apps/agent-service/src/production-proactive-memory.ts](https://github.com/sixianli/himawari-agent/blob/9a395ec730b7c96519309bf1199355a04d8199aa/apps/agent-service/src/production-proactive-memory.ts)、`packages/application/src/services/proactive-mail-check-service.ts`
- 测试：`packages/application/test/tentative-memory-capture.unit.test.ts`、[test/integration/proactive-mail-check.test.ts](https://github.com/sixianli/himawari-agent/blob/9a395ec730b7c96519309bf1199355a04d8199aa/test/integration/proactive-mail-check.test.ts) 里的 `[PA-2]` 用例
