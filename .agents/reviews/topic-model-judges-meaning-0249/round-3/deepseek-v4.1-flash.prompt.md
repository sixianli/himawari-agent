你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 16f7090321176e2ef58f5a09b49be9dbaa3cc771。
待核对的方案：
方案文件：docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md（在提交 16f7090321176e2ef58f5a09b49be9dbaa3cc771 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0239-real-memory-eval-sets.md, docs/adr/0180-gmail-check-reads-earlier-mail-about-the-same-matter.md, docs/adr/0179-keep-low-confidence-memory-candidates-as-tentative.md"
date: "2026-11-12"
---

# ADR 0249：几处靠词表猜意思的判断改由模型判断，程序只做校验

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

Andy 在 2026-11-12 定的 agent 开发基本原则是：理解用户的意思（意图、时效、是否明说等）一律交给模型判断，不用关键词表、正则或写死的词典。全面体检找出的一批判断仍靠词表猜意思：待确认规矩的引用是否真的在说同一件事、邮件里的订单号、评测题干有没有泄题。设计线程的整合方案（两个低价模型各出方案、互相审核、线程核对代码后整合）把它们拆成任务 T1 到 T6，Andy 同意，其中“每轮自动召回不加每轮模型调用”。本 ADR 记 T1 到 T4：共用的判断辅助、待确认规矩的确认裁判、邮件单号抽取、评测防泄露。分类与敏感判断（T5）、搜记忆的时间范围（T6）各有自己的取舍，另记。邮件“涉钱”规则（T7）见 [ADR 0248](0248-money-floor-follows-the-models-judgement.md)。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 自 v2.2 起 Andy 定的规则是硬性设定：`AGENTS.md` 写明“规则写进程序、必定执行、每条有回归测试”；确认的现有代码在 `apps/agent-service/src/production-memory-capture.ts` 的 `evidenceRejected`，原先用 `GENERIC_TERMS` 去掉虚词后比较两句话有没有共同的两字词。
2. 待确认记忆转正“有原话还要和那条记忆相关”的规则出自 [ADR 0179](0179-keep-low-confidence-memory-candidates-as-tentative.md) 第 59 行：“原话与那条待确认记忆自己的文字……去掉「主人」「喜欢」「的」这类到处都有的词后，至少共享一个连续两个字（中文）或一个单词，否则同样丢弃、不转正”，并写明“字面判断对不上同义词（「牛奶」对「乳制品」），误拦的代价只是少转正一次”。Andy 当时要防的是“拿无关的话当证据”，裁判模型照样防得住，还认得出同义词。
3. 逐字核对 `quoteFromOwnerMessage` 只看引用是否出自主人原话，不看是否在说同一件事：同文件，原话必须在归一化后逐字出现在主人消息里。
4. 邮件单号原先由正则 `REFERENCE_CONTEXT` 在 `packages/platform-node/src/gmail-related.ts` 里抽取，要求“订单、预约、案件”等标签紧挨着号码；[ADR 0180](0180-gmail-check-reads-earlier-mail-about-the-same-matter.md) 第 41 行写明规则：“单独的 ID、No.、# 不算”。
5. 取相关邮件在判断模型调用之前、每日成本上限之外：`packages/application/src/services/proactive-mail-check-service.ts` 的 `#related` 先于 `#judge`；本 ADR 把抽取放进同一个每日上限和每次检查的时间窗。
6. 评测题防泄露原先用 n-gram、数字重叠，再加 `chineseNumber`、`PART_OF_DAY`、`dateTokens` 这套日期时刻词典：`packages/application/src/services/real-memory-eval.ts`；[ADR 0239](0239-real-memory-eval-sets.md) 决定 2 写明了这套规则。
7. 模型输出一律严格解析、失败走安全默认，是 OpenAI、Anthropic 结构化输出文档的通用做法：<https://developers.openai.com/api/docs/guides/structured-outputs>。
8. 请求开头只追加：`.claude/rules/prompt-prefix.md` 第 4、6 条。本 ADR 新增的三个提示词都是后台单独调用，不改任何对话请求的系统提示和工具定义。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **共用判断辅助（T1）。**`apps/agent-service/src/auxiliary-judgment.ts` 的 `judgeWithModel`：问一次模型，严格解析，解析失败再问一次，仍失败就抛出；`judgeOrDefault` 在失败时返回调用方给的安全默认值。每个判断各自有提示词（放在 `packages/prompt-catalog`，固定指令在前、数据在后）和各自的解析函数，不共用一个大提示词。模型调用仍走原有的出口遮盖和准入。
2. **待确认规矩的确认裁判（T2）。**删掉 `GENERIC_TERMS`、`relevanceTokens`、`quoteRelatesToMemory`（取代 ADR 0179 第 59 行的“共享两字词”规则）。逐字核对保留。只在“决定是 unchanged、update 或 merge、指向待确认规矩、引用逐字出自原话”时，发一次独立裁判调用（提示词 `memory.confirmation-judge`）：输入只有引用和该规矩原文，输出 `supports` 是或否，只有 `true` 才确认。失败、超时、格式错一律不确认。结果按（规矩文本、引用、提示词版本）在进程内复用，同一轮重试不重复花钱；失败的结果不复用。输入当不可信数据，提示词写明不执行其中的指令。
3. **邮件单号由模型抽取（T3）。**删掉 `REFERENCE_CONTEXT`。取相关邮件之前，对本次候选邮件按批抽取单号（提示词 `mail.reference-extraction`），费用计入每日成本上限，预估超限、超时、失败时不搜单号，只靠线程和同标题同参与人。程序校验全部保留并移到 `packages/application/src/services/proactive-references.ts`：只认 `[A-Z0-9-]{8,40}`、含数字、不是日期、必须作为完整片段逐字出现在这封邮件里、每封最多 3 个；只有校验后的串才拼进 Gmail 查询；搜回的邮件仍要逐字含该单号才算。对 [ADR 0180](0180-gmail-check-reads-earlier-mail-about-the-same-matter.md) 的修改：不再要求标签紧挨号码，只写“No. 12345678”的号码以后也能串起来。
4. **评测防泄露改由裁判判断语义（T4）。**保留 n-gram 与数字重叠两道确定性检查，删掉 `chineseNumber`、`PART_OF_DAY`、`dateTokens`。出题后、入库前，对每道题（含拒答题）再发一次裁判调用（提示词 `eval.real-memory.leak-judge`）：输入只有题干和该记忆、原话，输出 `leaks` 是或否。失败、格式错、答非所问都当成泄露，沿用 `rejected: "leak"`，不加新枚举值；预算用尽照旧中止，不当成泄露。只在评测开着时运行。对 [ADR 0239](0239-real-memory-eval-sets.md) 决定 2 的修改：日期时刻的等价判断（“十二月”和“12 月”、“七点”和“7 点”）和“一点”的特殊处理不再由程序做，交给裁判。
5. **模型选择不写死。**这些调用沿用各自调用方已有的模型配置，不在代码里写死模型名；提示词写进目录并登记在 `prompt-manifest.json`。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

LongMemEval 一类评测和 Mem0 的记忆更新，都让模型判断“两句话是不是同一件事”，程序负责校验结构和原文出处；OpenAI、Anthropic 的结构化输出指南是“模型给结构化答案，程序校验模式和业务规则”。本 ADR 照这个做法：意思交给模型，逐字核对、格式、白名单、额度仍由程序把关。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **让抽取模型在同一次回答里自己填“相关”。**同一个模型自己确认自己，而确认会让规矩变成硬规则，所以另发独立裁判调用。
- **在判断提示词里顺带抽单号。**单号抽取发生在判断之前（`#related` 先于 `#judge`），判断时才抽就晚了。
- **评测防泄露撤回、只留确定性检查。**GLM 认为它不是“理解用户意思”可以撤回，DeepSeek 主张保留确定性第一道；采取折中：时间说法等价是语言含义，交给裁判，其余确定性检查保留。
- **共用一个大提示词或一个万能端口。**各判断的输入输出、安全默认不同，共用会让一处改动牵动多处；只共用“严格解析、重试、失败默认”这一层。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 待确认规矩的确认多一次裁判调用，只在“会让规矩生效”的少数情形发生；裁判出错时规矩保持待确认，主人下次再说一遍即可。
- 邮件每次检查多一次（每批一次）抽取调用，计入每日成本；每日成本用尽那一轮不抽取，只靠线程和同标题同参与人串邮件。
- 评测每道题多一到两次小调用，计入每周 0.5 美元上限；裁判不稳定时更多题会被丢弃（宁可少出题，不泄题）。主问题被判泄露或裁判故障时，那条记忆的这个版本进入 declined 名单，之后一段时间不再出题，和已有的出题失败处理一致；拒答题被判泄露只丢这道题，两种情况都计入 `rejected.leak`。
- 邮件单号抽取先于判断，所以它的预算检查给判断留出一批的预估费用，费用也计入摘要预算的已花部分；它用检查时间窗的六分之一做超时，不占相关邮件读取的半窗。
- “明天下午开会”这类和那条记忆无关的话，由裁判判否；这些反向用例写成自动化测试。

[返回阅读导航](#contents)
