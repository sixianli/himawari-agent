你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 b55101ec8e0722a42102e2daca6dcd7fcc9862cb。
待核对的方案：
方案文件：docs/adr/0260-memory-classification-on-the-server.md（在提交 b55101ec8e0722a42102e2daca6dcd7fcc9862cb 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md"
date: "2026-11-13"
---

# ADR 0260：手动添加和导入的记忆由服务端的模型判断类别和是否敏感

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

Andy 在 2026-11-12 定的 agent 开发基本原则是：理解用户的意思一律交给模型判断，不用关键词表、正则或写死的词典。网页上“添加记忆”和“导入记忆”原先用 `guessCategory` 这张词表猜类别和是否敏感（例如见到“药”就归“健康”并标敏感，“我不吃药”也会被标成健康敏感），导入时还用一条正则猜一行是不是“规矩”。设计线程的整合方案把它列为任务 T5，Andy 同意；[ADR 0249](0249-the-model-judges-meaning-where-word-lists-guessed-it.md) 记了 T1 到 T4，并写明 T5 另记。协调者按 Andy 的新方向限定了范围：只改服务端和网页上的调用，网页不加新的操作，新的界面（例如“这不是敏感信息”的纠正）放到 iPhone 端做。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 网页原先的词表：`apps/control-center/src/memory-import.ts` 的 `guessCategory`，以及同文件的 `RULE` 正则；添加表单在 `apps/control-center/src/components/memory-page.tsx` 的 `AddForm` 里用 `guessCategory(text).category` 实时填类别。
2. 记忆的敏感级别在浏览器调用 `protectText` 时就定了，`memory.create` 和 `memory.import.commit` 的契约原先没有 topic 字段（`packages/gateway-contracts/src/contracts-v2.ts` 的 `memoryCreateCommandSchema`、`memoryImportItemsSchema`），服务端存敏感记忆时只能按类别推 topic（`production-memory-control.ts` 的 `sensitiveTopicFor`，健康和财务以外都成了 other）。
3. 敏感记忆不能改类别：`production-memory-control.ts` 的 `#setCategory` 抛 `MEMORY_CATEGORY_LOCKED`。所以类别和敏感级别必须在保存前定好。
4. 对话里自动记下的记忆，敏感级别由模型给、程序再用 `classificationWithIdentifiers` 取高：`apps/agent-service/src/production-memory-capture.ts` 的 `parseMemoryCandidates`，“classification”和“topic”的写法在 `packages/prompt-catalog/src/memory.ts` 的 `MEMORY_FIELD_RULES`。
5. 证件号、银行卡号、密码、密钥的确定性检测是安全过滤，整合方案写明保留：`packages/sensitive-capture/src/identifiers.ts` 的 `classificationWithIdentifiers`、`mentionsSensitiveMaterial`。
6. 网页这一侧的服务进程里，后台模型调用的现成做法是 `proactiveModel` 加 `createRealEvalModel`：`apps/agent-service/src/service-main.ts`、`apps/agent-service/src/production-real-eval.ts`；它们经同一条模型传输层发出，出口遮盖在 `packages/runtime-pi/src/pi-model-transport.ts` 的 `exchange.wrapFetch`。
7. 模型用量表 `model_usage_observations` 的 `purpose` 列有 CHECK 约束，只认现有的几个值：`packages/persistence-sqlite/src/migrations/0091_decision_prereviews.sql`。新加一个值要改表，改表要排队。
8. 请求开头只追加：`.claude/rules/prompt-prefix.md` 第 4、6 条。本 ADR 的分类调用是后台单独调用，不改任何对话请求的系统提示和工具定义。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **新增查询 `memory.classify.read`。**网页把每条文字先按确定性检测的级别存成受保护的内容，再把引用（最多 500 条）发给服务端；服务端读出文字，逐条回答类别、`private` 或 `sensitive`、敏感时的 topic，以及是否判断失败。回答的结构在契约里定死（`memory.classify.snapshot`）。
2. **服务端怎么判断。**`apps/agent-service/src/production-memory-classification.ts`：命中确定性检测（证件号、卡号、密码、密钥及其字样）的条目直接标敏感，不发给模型；其余按总字数分批（每批字数是一个构造参数，不按固定条数切），每批一次调用，提示词 `memory.classification`（复用对话记忆的类别和敏感规则写法），用 [ADR 0249](0249-the-model-judges-meaning-where-word-lists-guessed-it.md) 的判断辅助做严格解析和一次重试。解析规则：不认识的类别归 other；classification 不是 `private` 或 `sensitive` 的条目、模型漏掉的条目、整批失败、每日额度用完，都当成“判断失败”，按敏感处理；类别是健康或财务时一律敏感。
3. **花费上限。**分类调用用主动检查配置的模型（`runPolicy.proactive.modelRef`）和它的每日成本上限 `dailyCostMicros`（主人能看到、能改），但单独计数；预估超出就不再调用，剩下的条目按判断失败处理。计数在服务进程内存里，服务重启后当天重新计数（不改表的代价，见后果）。用量记在 `memory-capture` 用途下。
4. **提交时服务端取高。**`memory.create` 和 `memory.import.commit` 的每条增加 `topic`。服务端存记忆前，如果受保护内容的级别低于敏感，而类别是健康或财务，或文字命中确定性检测，就把这段文字另存一份敏感级别的受保护内容，记忆按敏感存，防止网页少报。敏感记忆的 topic 用网页给的值，没给时按类别推。网页报的 topic 不能把普通记忆变敏感，敏感与否只看级别。
5. **网页的改动。**删掉 `guessCategory` 和 `RULE` 正则。添加表单的类别默认“让 Himawari 判断”，保存时先问服务端，主人手选的类别优先；导入预览先显示“分类中”，判断完再按结果勾选，判断失败的条目标“分类失败，已先保密，默认不导入”。从 Himawari 自己导出的文件导入时，类别和敏感标记是导出时就有的，不再判断。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

OpenAI、Anthropic 的结构化输出指南都是“模型给结构化答案，程序校验模式和业务规则”（<https://developers.openai.com/api/docs/guides/structured-outputs>）。本 ADR 照这个做：意思交给模型，证件号和密钥这类确定性检测、类别白名单、敏感级别只升不降由程序把关。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **在浏览器里继续用词表，只把词表做大。**词表认不出否定和同义说法，这是要去掉的根因。
- **提交时由服务端顺手判断、不单独提供查询。**导入预览要在提交前就告诉主人哪些敏感、默认不勾，只在提交时判断就来不及。
- **新加一个用量用途 `memory-classify`。**要改 `model_usage_observations` 的 CHECK 约束，属于改表，要排队；先记在 `memory-capture` 下，以后有改表批次时再拆开。
- **每日额度存进数据库。**同样要改表；服务重启后多出的最多是一天的额度，这个上限是安全网，不是计费依据。
- **网页上做“这不是敏感信息”的纠正。**按协调者转达的方向，新界面放到 iPhone 端；失败时按敏感处理的代价是这条记忆不会自动带进对话，主人仍可以手动勾选导入。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 每次手动添加多一次小调用，每次导入每批多一次调用；模型或额度出问题时，条目一律按敏感、默认不导入，宁可多保密。
- 服务端多存一份敏感级别的受保护内容时，网页先存的那份普通级别的内容仍在，和以前一样只由内容引用指向，不被记忆使用。
- 判断失败的记忆没有网页上的纠正入口，要等 iPhone 端的纠正操作；在那之前主人可以删掉重新添加并手选类别。
- 网页的类别选择多了一个“让 Himawari 判断”的默认项，这是原有下拉框里的一项，不是新操作。

[返回阅读导航](#contents)
