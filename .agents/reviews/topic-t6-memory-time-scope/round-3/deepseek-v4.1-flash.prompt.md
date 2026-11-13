你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 01547efdcb61be365db3ed7de96042b3397c8659。
待核对的方案：
方案文件：docs/adr/0262-memory-time-scope-comes-from-the-model.md（在提交 01547efdcb61be365db3ed7de96042b3397c8659 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md"
date: "2026-11-13"
---

# ADR 0262：搜记忆的时间范围只用模型填的日期，不再用正则从问题里猜

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [实测](#evaluation)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

Andy 在 2026-11-12 定的原则是：理解用户的意思一律交给模型判断，不用关键词表、正则或写死的词典。搜记忆时，问题里的“上周三”“去年”“以前”原先由 `parseTimeScope`（一组正则）换算成时间范围；模型在 recall 工具里填了 from、to 时用模型的，没填时用正则兜底。设计线程的整合方案把它列为任务 T6（[ADR 0249](0249-the-model-judges-meaning-where-word-lists-guessed-it.md) 写明 T6 另记）。本 ADR 先实测再删，Andy 2026-11-13 同意用 OpenCode Go 套餐跑实测。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 删除之后，recall 不再从问题文字推时间：`apps/agent-service/test/production-memory-recall.unit.test.ts` 的用例“[T6] reads the time window only from what the model filled, never from the words of the query”，查询“我以前用什么手机，昨天说过的”时检索范围是 `{ includeHistory: false, from: null, to: null }`。
2. recall 工具早已让模型填日期：`packages/prompt-catalog/src/tools.ts` 的 `TOOL_RECALL` 在本 ADR 之前就有“问到具体时间时填 from、to（YYYY-MM-DD，按主人所在时区）”。
3. 对外 MCP 工具 `find_memories` 在本 ADR 之前已有 from、to（`apps/agent-service/src/production-mcp-read.ts` 第 501 行起的参数定义），本 ADR 加上 includeHistory。
4. 改提示词文字只对新对话生效：`.claude/rules/prompt-prefix.md` 第 43 行“改了提示词文字，**只对新对话生效**”。老对话里冻结的旧文字从此按外来内容检查（同文件第 53 行），旧 recall 说明里没有会被认成敏感信息的数字。
5. 检索评测集：`test/fixtures/memory-evaluation/dataset.json`，时间相关的题是 temporal 15 题、history 10 题、time_window 12 题、episode 8 题；第二阶段关口在 `test/integration/memory-evaluation.test.ts` 的“answers history, time-window and past-conversation questions”用例。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **删掉 `parseTimeScope` 和它的两处调用。**recall 工具只用模型填的 from、to、includeHistory：填了日期时一并看历史（沿用原来的做法，某段时间里当时有效、现在已失效的记忆也要找得到）；只填 includeHistory 时按它；都没填就不按时间过滤，也不看历史。每轮自动召回不再猜时间，纯按意思召回；要按时间找时由模型自己调 recall。
2. **日期的历法校验。**新函数 `requestedTimeScope`（`packages/memory-engine/src/time-scope.ts`）把模型给的本地日期换成主人时区的整天范围；`2026-13-40`、`2026-02-30` 这类不存在的日期，或 from 晚于 to，一律拒绝，recall 回 `MEMORY_RECALL_INPUT_INVALID`，工具结果的说明告诉模型怎么改正后重查（新提示词 `tool-result.recall-input-invalid`，MCP `find_memories` 同样回这句），不再悄悄换算成别的日子或空窗口。`localDayStart` 同样拒绝不存在的日期。整天的起点取当地日期的第一个时刻，夏令时在午夜切换的时区（例如 America/Santiago）不会多算前一天的最后一小时；`packages/memory-engine/test/time-scope.unit.test.ts` 逐个时区核对 2026 年每个切换日前后三天。
3. **MCP `find_memories` 加 includeHistory。**外部 agent 的模型也能自己说“要看旧情况”；工具说明同步补一句。
4. **recall 工具说明补一句。**“问以前的情况（已经变了的旧情况）时 includeHistory 填 true，问现在的情况时不填。”整合方案原本不打算改这段文字，补之前的实测里模型常在问“现在”时也填 true，补这一句后改善（见[实测](#evaluation)）。只对新对话生效。
5. **评测改用模型的真实回答。**`scripts/evals/memory-time-scope-live.eval.ts` 用 recall 工具的真实定义和每轮的时间说明请模型填参数，结果存进 `test/fixtures/memory-evaluation/model-time-scopes.json`；检索评测用这份记录代替正则，并加一条反向检查：不给时间范围时，“某段时间”和“问以前”两类必须明显变差。

[返回阅读导航](#contents)

<a id="evaluation"></a>

## 实测

模型：`deepseek-v4.1-flash`（OpenCode Go 套餐），45 道时间类题每题两遍。下表是补一句说明之后的实测，模型回答记在 `evals/memory-time-scope/result.json`（90 次调用、约 0.01 美元），检索对比记在 `evals/memory-time-scope/retrieval-comparison.json`（`qwen4096/*` 四组）。检索用评测集自带的 4096 维真实向量，数字是前 5 条召回率（括号里是“问现在时旧记忆没排到前面”的比例，即 staleFree）。

| 做法 | 问现在 | 问以前 | 某段时间 | 对话摘要 |
| --- | --- | --- | --- | --- |
| 正则 | 1.00（1.00） | 1.00 | 1.00 | 1.00 |
| 不给时间范围 | 1.00（1.00） | 0.00 | 0.00 | 1.00 |
| 模型 | 1.00（0.91） | 0.90–1.00 | 1.00 | 0.875–1.00 |

两遍填得完全相同的题 30/45。正则在这套题上满分，部分原因是它就是照这套题写的；模型在“某段时间”和“对话摘要”上与正则持平，“问以前”和“问现在”还有小幅回退，两遍之间也有波动。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

LongMemEval（<https://arxiv.org/abs/2410.10813> 第 5.4 节）由模型从问题里抽时间范围再过滤，召回提升 6.8%–11.3%，并指出小模型会漏判。OpenAI 结构化输出指南（<https://developers.openai.com/api/docs/guides/structured-outputs>）的做法是模型给结构化参数、程序校验格式和业务规则。本 ADR 照这个做：时间的意思由模型判断，程序只校验日期真实存在、范围先后正确。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **保留正则兜底。**违背 Andy 定的原则；正则认不出没写进去的说法，在这套题上的满分也不代表真实问题。
- **每轮自动召回前加一次模型调用抽时间。**整合方案经 Andy 同意不给每轮自动召回加模型调用；需要按时间找时，回答的模型本来就会调 recall。
- **不改 recall 说明。**补之前问“现在”时多填 includeHistory 的情况更多，补这一句花费不到 1 分钱。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 每轮自动召回不再按时间过滤，问“九月中旬我去哪出差了”时，自动带上的记忆不一定含那一条，要等模型调 recall 填日期才找到；实测里模型对 45 个时间类问题全部调了 recall。
- “问以前”偶尔漏填 includeHistory，旧记忆不会出现；“问现在”偶尔多填，已失效的旧记忆会带“历史”标记一起返回。
- 老对话冻结的是旧的 recall 说明，要新对话才用上补的那一句。
- 评测记录的是某一天某个模型的回答；换回答模型或改 recall 说明后，要重跑实测并更新记录。

[返回阅读导航](#contents)
