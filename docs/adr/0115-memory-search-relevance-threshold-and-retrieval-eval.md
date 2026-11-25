---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-29"
covers: "apps/agent-service/src/production-memory-composition.ts, apps/agent-service/src/production-run-memory.ts, evals/memory-retrieval/dataset.json, evals/memory-retrieval/history.jsonl, packages/memory-engine/src/hybrid-memory-provider.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0115：记忆搜索设相关度门槛，没有相关记忆就一条不带也不显示；用固定评测集记录检索基线

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [门槛怎么定的](#threshold)
- [检索评测集和基线](#eval)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-29 11:55（日本时间），Andy 在生产网页（第十八版）发“写到一个pdf文件”，过程区显示“按这句话找到 3 条相关记忆”，带出的是前同事的名字和“两人是好朋友”，与这句话毫无关系。他问：是不是根本没做记忆搜索。

查代码确认（事故 [I-23](../incidents-and-gates.md#incidents)）：

- 记忆搜索是做了的：主人的话先转成向量（把一句话变成一串数字，意思越近数字越接近），再和每条记忆比相似度（0 到 1，越大越像），同时做关键词匹配和人名匹配，三路合并排序（`packages/memory-engine/src/hybrid-memory-provider.ts`、`fusion.ts`）。
- 但是“够不够像”没有门槛。`HybridMemoryProvider` 有最低相似度参数 `minimumSimilarity`，生产组装（`apps/agent-service/src/production-memory-composition.ts`）从没设，默认是 0，等于多远都算相关。主人一共只有十几条记忆，所以每一轮都会把最不远的几条当成“相关记忆”带给模型，界面也照写“找到 N 条相关记忆”。
- 向量请求失败时不会退化成随便取几条：整步报“记忆暂时不可用”（`apps/agent-service/src/production-run-memory.ts`）。所以这次不是额度事故的副作用。

[返回目录](#contents)

<a id="decision"></a>

## 决定

1. **记忆搜索必须有相关度门槛。** 向量这一路只留相似度不低于门槛的记忆。`alibaba/qwen3-embedding-8b` 的门槛是 0.6（常量 [QWEN3_MEMORY_MINIMUM_SIMILARITY](https://github.com/sixianli/himawari-agent/blob/54e1bec4fb4df525ecf3f87143e917a748d2b0fa/apps/agent-service/src/production-memory-composition.ts)），配置里可以用 `memory.minimumSimilarity`（大于 0、小于 1）改。换成其他向量模型又没配门槛时，服务拒绝启动（[MEMORY_MINIMUM_SIMILARITY_REQUIRED](https://github.com/sixianli/himawari-agent/blob/54e1bec4fb4df525ecf3f87143e917a748d2b0fa/apps/agent-service/src/production-memory-composition.ts)），因为不同模型的相似度分布不同，不能沿用 0.6。（关键词和实体两路的截断已由 [ADR 0221](0221-memory-retrieval-relevance-cutoff-and-same-source-dedupe.md) 补上：融合后按相关分截断，向量门槛不变。）
2. **关键词这一路不再用单个汉字。** “用”“叫”“吃”这类单字几乎每条记忆都有，评测里“git rebase 怎么用”会因为“用”带出“主人用的电脑是 MacBook Air”。人名、地名这类实体匹配不变。
3. **没有相关记忆就一条不带，过程区也不出现这一步。** 带给模型的记忆和过程区显示的是同一份结果（`memory.selection` 记录）。0 条时不显示“找到 0 条”，整步隐藏（Andy 2026-10-29 15:51：“没有记忆的话就不要在过程中显示！否则就是此地无银三百两！”）。档案为 0 条时同样隐藏。
4. **档案步骤改名。** 主人档案（重要度不低于 0.6 的身份类记忆，每轮都带，上限 2000 字）是常驻资料，不是按这句话找出来的。步骤名从“带上档案里的 N 条记忆”改为“常驻档案 N 条（每轮都带）”，三语同步。
5. **检索能力用固定评测集记录基线。** `npm run eval:memory-retrieval -- --confirm-cost=<美元上限>` 用真实向量模型、真实 SQLite 索引和生产的检索代码，跑 `evals/memory-retrieval/dataset.json` 里的合成记忆和问题，结果追加到 `evals/memory-retrieval/history.jsonl`。以后改检索（换模型、加重排、调门槛）都先跑这套题和基线比。

[返回目录](#contents)

<a id="threshold"></a>

## 门槛怎么定的

做法参照 Cohere 的建议（见[关联文档](#references)）：拿有代表性的问题实测分数，再定门槛，不照搬别人的数字。

1. 校准：用与 Andy 生产记忆同样形态的 11 条记忆，配 32 句该找到某条记忆的话和 55 句不该带任何记忆的话（命令、闲聊、“继续”“好的”等），共 87 句，经评测专用的低额度密钥调用 `alibaba/qwen3-embedding-8b`，花费约 0.00003 美元。
2. 结果：不该带记忆的话，与最近一条记忆的相似度最高到 0.57（“再来一个”对“我喜欢喝美式”这种很短的第一人称记忆）；该找到的话分布在 0.33 到 0.85。两者有重叠，没有完美的分界线。
3. 取 0.6：校准集里不该带记忆的 55 句全部为 0 条，该找到的 32 句留下 18 句；漏掉的多是需要联想的问题（“晚饭吃什么”对“喜欢吃鱼”），而这类记忆大多已在常驻档案里，每轮都会带上。优先级依据产品愿景的“记忆可靠性”：宁可这一轮少带一条，也不带无关内容误导模型。

[返回目录](#contents)

<a id="eval"></a>

## 检索评测集和基线

- 数据：24 条合成记忆（人物、家人、住处、偏好、饮食、健康、作息、项目），40 句该找到记忆的话（31 句直接问，9 句需要联想）和 48 句不该带记忆的话。全部是合成数据，不含 Andy 的真实记忆。
- 指标：相关问题命中率（至少带上一条该带的）、召回率（该带的记忆带上了多少）、准确率（带上的记忆里有多少是该带的）、无关问题带出率（不该带的话里有多少句带出了记忆）。每句最多取 5 条，和生产 `maxSelectedMemories` 一致。
- 费用：一轮 112 次向量请求，约 0.0001 美元；脚本不带 `--confirm-cost` 不开跑，开跑前先发一次试探请求，被网关拒绝就停（与事故 I-11 的规则一致）。
- 2026-10-29 第一轮（同一套题，门槛 0 即修改前的行为）：

| 门槛 | 相关问题命中 | 其中直接问 | 其中需要联想 | 召回 | 准确率 | 无关问题带出 |
| --- | --- | --- | --- | --- | --- | --- |
| 0（修改前） | 100% | 100% | 100% | 98.1% | 26% | 100%（240 条） |
| 0.55 | 90% | 100% | 55.6% | 84.9% | 86.5% | 4.2%（2 条） |
| 0.6（生产） | 80% | 93.5% | 33.3% | 77.4% | 85.4% | 2.1%（1 条） |

剩下的 1 条带出是关键词“日语”：“把刚才那段改成日语”带出“主人在准备日语 N2 考试”。需要联想的问题命中率低是已知短板，下一步可以加重排模型（专门给“问题和这条内容有多相关”打分的小模型）再比较，见 [BL-20261029-003](../backlog/BL-20261029-003-memory-search-reranker.md)。

[返回目录](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：只按相似度门槛过滤（选用）

- 好处：改动小，向量这一路已有 `minimumSimilarity` 参数；不多花一次模型调用，不增加延迟。
- 代价：门槛和向量模型绑定，换模型要重新校准；需要联想的问题会漏。

### 方案 B：先多取候选，再用重排模型筛（Anthropic、Google 的做法）

- 好处：Anthropic 实测“重排 + 关键词 + 向量”比只用向量少一大半检索失败；重排分数比向量相似度更能区分“相关”和“沾边”。
- 代价：每轮多一次模型调用和延迟（Google 的重排服务标称不到 100 毫秒，用大模型重排 1 到 2 秒），而且重排分数同样需要定门槛。先用方案 A 止住问题，再用评测集比较是否值得加。

### 方案 C：不在每轮自动搜，让模型自己决定要不要调用记忆搜索工具（Letta 的长期记忆）

- 好处：模型不问就不带，无关问题天然不会带出记忆。
- 代价：全靠模型判断，漏查时主人会觉得它“忘了”；每次搜索多一轮模型调用。Himawari 已有 `memory.recall` 工具可供模型主动查，本次不改自动带记忆的整体设计。

### 方案 D：固定取前 3 条，不设门槛（修改前）

- 否决：个人记忆和文档问答不同，大多数话本来就没有相关记忆，必须允许返回 0 条。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 好处：无关的话不再带记忆，过程区不再把“最不远的几条”说成“相关记忆”；每轮少带几条无关文字，省 token。
- 代价：需要联想的问题少带记忆，靠常驻档案和模型主动调用 `memory.recall` 补。
- 门槛：`npm run check` 新增 `check:memory-relevance`，运行带 `[I-23]` 标记的 3 条测试，少于 3 条通过或有失败就不通过；发布走查新增必过项 `accept-unrelated-no-memory`，没过 `deploy.sh` 拒绝上线。
- 后续：第十九版须重新出包并跑新的发布走查；以后每次改检索都先跑 `npm run eval:memory-retrieval` 与本 ADR 的基线比较。

[返回目录](#contents)

<a id="references"></a>

## 关联文档

- [事故 I-23](../incidents-and-gates.md#incidents)
- [工程案例 57](../engineering-casebook.md#case-memory-relevance-threshold)
- [ADR 0075：自研长期记忆](0075-self-built-memory-engine.md)
- [ADR 0109：花钱的评测要先报费用、设上限、先试探](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0109-paid-eval-runs-need-cost-cap-and-preflight.md)
- [界面与交互设计指南](../ui-ux-design-guide.md#bad)
- [Control Center v4 设计规格](../execution/specs/2026-09-15-control-center-v4-design.md)
- Anthropic, Introducing Contextual Retrieval：<https://www.anthropic.com/news/contextual-retrieval>
- Google Vertex AI RAG Engine, Retrieval and ranking：<https://docs.cloud.google.com/vertex-ai/generative-ai/docs/rag-engine/retrieval-and-ranking>
- Cohere, Reranking best practices：<https://docs.cohere.com/docs/reranking-best-practices>
- Letta, Agent memory：<https://docs.letta.com/guides/agents/memory>
