---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
covers: "apps/agent-service/test/production-memory-recall.unit.test.ts, evals/memory-retrieval/candidates-qwen3-embedding-8b.json, evals/memory-retrieval/dataset.json, evals/memory-retrieval/history.jsonl, packages/application/test/same-source-dedupe.unit.test.ts, packages/memory-engine/src/fusion.ts, packages/memory-engine/src/relevance.ts, packages/platform-node/test/startup-configuration.unit.test.ts, test/integration/durable-memory-projection.test.ts, test/integration/memory-engine-index.test.ts, test/integration/memory-retrieval-eval/fixture.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0221：记忆检索三路融合后按相关分截断，同源且几乎相同的记忆只留一条

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [参数和评测](#parameters)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#links)

<a id="context"></a>

## 背景

每轮找相关记忆走三路：向量（按意思找，比的是余弦相似度，0 到 1，越大越像）、关键词（SQLite 全文检索的 bm25 打分）、实体（记忆里记下的人名、地名等名字出现在这句话里）。三路结果用 RRF（倒数排名融合：每路按名次给分 `1/(60+名次)`，再相加）合并，乘上重要度、新近程度等加成后排序，取前 N 条（`packages/memory-engine/src/fusion.ts`）。

[ADR 0115](0115-memory-search-relevance-threshold-and-retrieval-eval.md) 只给向量路设了最低相似度（聊天 0.6；Gmail 检查按 [ADR 0158](https://github.com/sixianli/himawari-agent/blob/9a395ec730b7c96519309bf1199355a04d8199aa/docs/adr/0158-bring-related-memories-into-gmail-checks.md) 用 0.45）。关键词路和实体路没有任何门槛：一个关键词撞上，再不相关的记忆也会带出来。2026-11-11 在 `evals/memory-retrieval/dataset.json` 上实跑（24 条合成记忆、40 句相关、48 句无关），生产门槛下准确率（带上的记忆里该带的比例）85.4%，错带的 7 条全部只被关键词找到，与问题的相似度只有 0.28 到 0.59，例如“我住在哪里”带出“主人的母亲住在成都”。

另一件事是“同源重复”：同一句原话可能派生出几条几乎一样的记忆，检索时会一起被带出来。Andy 2026-11-11 选定的定义是：来源（`sourceRefs`）有交集**且**内容几乎相同才算重复；同一句话拆出的不同事实都保留。

不能直接在 RRF 分数上划线：RRF 只保留名次，一条只被关键词找到、排第 1 的记忆和一条只被向量找到、排第 1 的记忆分数一样。离线复算证实，线在“单路第 1 名”附近是断崖：低于它什么都挡不住，高于它召回从 77% 掉到 50% 左右。Azure AI Search 的文档也说明 RRF 分数上限随融合的路数变化（<https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking>），Elastic 的做法是只对语义子查询设最低分（<https://www.elastic.co/search-labs/blog/semantic-precision-minimum-score>）。

[返回目录](#contents)

<a id="decision"></a>

## 决定

1. **排序不变，截断看“相关分”。** 每个候选算一个相关分：

   `相关分 = 相似度 + 关键词权重 × (这条的 bm25 / 本句最高的 bm25) + 实体权重 × (是否命中实体，0 或 1)`

   相关分低于“本次检索的向量门槛 − 截断余量”就不要。排序仍是 RRF 乘加成；加成不参与截断，免得重要度低、时间旧的相关记忆被误截。向量门槛以上的记忆相关分一定过线，所以向量路的行为不变；Gmail 检查自动用它自己的 0.45。
2. **每个候选都有相似度。** 存储层给只被关键词或实体找到的候选也算出余弦相似度（`MemoryIndexCandidate.similarity`），包括不在向量前 50 名里的，用的是索引里已存的向量，不多发嵌入请求。
3. **没有相似度就不截。** 查询向量失败（只剩关键词和实体，见 ADR 0115 和检索降级记录）、或这条记忆没有当前向量模型算出的向量（不做向量的分级、写索引时嵌入失败、换向量模型或维度后还没重算完）时，保持截断前的行为，并写一行 `memory.relevance_unknown` 诊断日志（只记条数）。
4. **只在产品检索打开截断。** 记忆引擎只在调用方显式要求（`relevanceCutoff: true`）时截断。`DurableMemoryService.search` 固定要求截断，所以经它的聊天自动带记忆和 Gmail 检查都截断；`memory.recall` 工具也要求截断；整理记忆时找已有记忆的那次检索（`service-main.ts` 的 consolidation search）不打开，因为它要找的正是可能重复、需要合并的旧记忆。
5. **同源且几乎相同才去重。** 两条记忆的 `sourceRefs` 有交集，才读两边正文比较：统一全半角和大小写、去掉空白和标点后完全相同，或者相邻三个字一组的重合度（Dice 系数）不低于 0.9，算几乎相同；规范化后少于 8 个字的只认完全相同；两条里的数字串（阿拉伯数字或“两”“三”“十”这类中文数字，连同前面的正负号，符号和数字之间的空格不算）只要有一处不同就不算重复（只差一个日期、金额或份数的是两条事实）。排在前面的留下，后面的跳过，并由后续候选补满名额；被跳过的不记“最近使用”。比较时正文读不出来，按不重复处理（`memory.recall` 本来就跳过读不出正文的记忆，这一点不变）。`memory.recall` 工具把已确认和待确认的记忆合在一起去重，已确认的优先：名额已满时，已确认的记忆仍会替下与它重复的待确认记忆，空出的待确认名额从剩下的待确认候选里补，已确认的记忆保持检索排序。去重只影响这次检索结果，不改存储。服务层（`DurableMemoryService`、`memory.recall`）不传开关时也按打开处理，和配置默认值一致。
6. **“相关记忆”里的“相关”** 从此指相关分达到截断线；界面文字不变，[界面设计指南](../ui-ux-design-guide.md)同步改定义。

[返回目录](#contents)

<a id="parameters"></a>

## 参数和评测

配置在 `memory.retrieval` 下，全部可选，不写就用代码里的默认值（`packages/memory-engine/src/relevance.ts`），启动时校验，非法值拒绝启动：

| 配置项 | 默认 | 范围 | 作用 |
| --- | --- | --- | --- |
| `keywordWeight` | 0.15 | 0 ≤ 值 < 1 | 关键词命中的加分上限 |
| `entityWeight` | 0.15 | 0 ≤ 值 < 1 | 命中实体的加分 |
| `cutoffMargin` | 0.05 | 0 ≤ 值 < 1 | 截断线比向量门槛低多少 |
| `dedupeSameSource` | true | 布尔 | 同源近重复去重开关 |

去重的 0.9 和 8 个字是代码常量，不做配置，少一个可以被调到过拟合的旋钮。生产配置模板不写这一段，用代码默认值。

评测（`npm run eval:memory-retrieval`，生产门槛 0.6，每句取 5 条；记录在 `evals/memory-retrieval/history.jsonl`）：

| | 相关问题命中 | 召回（recall@5） | 准确率 | 无关问题带出 |
| --- | --- | --- | --- | --- |
| 截断前 | 80% | 77.4% | 85.4% | 2.1%（1 句） |
| 截断后（默认参数） | 80% | 77.4% | 89.1% | 2.1%（1 句） |

- 默认值是怎么选的：同一套题离线复算了两次独立实跑的原始候选（同一模型两次返回的相似度会差约 0.01）。余量 0.03 时准确率可到 93% 到 95%，但召回降 1.9 个点，离“最多降 2 个点”只差 0.1，嵌入的小抖动就可能越线；余量 0.05 在两次实跑上召回都不降、准确率都上升，所以取 0.05。关键词、实体权重在 0.15 到 0.2、余量在 0.02 到 0.06 的一片区域里都满足完成标准，不是单点。
- 剩下的无关带出是“把刚才那段改成日语”带出“主人在准备日语 N2 考试”（相似度 0.586，离门槛只差 0.014），任何不伤召回的线都挡不住它。
- 评测集只有 24 条记忆，过拟合的风险用两件事控制：参数取在稳定区域中间；另一个线程（P4-5）在建真实数据的评测集，届时复核。
- 自动检查：两次实跑之一的原始候选存成 `evals/memory-retrieval/candidates-qwen3-embedding-8b.json`，`test/integration/memory-retrieval-eval/fixture.test.ts`（`[P3-3]`）在 `npm test` 里离线复算，默认参数下准确率不上升、召回降超过 2 个点、或无关问题带出的句数或条数增加就失败；反向用例确认“只认向量门槛、不给关键词和实体加分”会让召回掉超过 2 个点。

[返回目录](#contents)

<a id="options"></a>

## 比较过的方案

### 方案 A：相关分（相似度加关键词、实体加分）截断，RRF 排序不变（选用）

- 好处：用唯一可以跨查询比较的分数（余弦相似度）做门槛，关键词和实体只补一点分；向量路行为不变；不新增请求、不改表。
- 代价：权重和余量要靠评测选；换向量模型要和门槛一起重新校准。

### 方案 B：只认相似度达到向量门槛，关键词和实体只参与排序（DeepSeek 提出）

- 好处：最简单，准确率 100%。
- 代价：评测里大量正确记忆只被一个关键词或人名找到、相似度又低于 0.6（例如直接问人名），召回从 77.4% 掉到 50.9%，不满足完成标准。否决。

### 方案 C：相似度达到门槛，或命中两路以上且相似度不低于 0.45（GLM 提出）

- 代价：召回掉到 52.8%，原因同 B。否决。

### 方案 D：直接在 RRF 分数上划线

- 代价：见[背景](#context)的断崖。否决。

### 方案 E：Weaviate 式按每路分数最小最大归一后加权（<https://docs.weaviate.io/weaviate/concepts/search/hybrid-search>）

- 代价：每路都把本句最好的那条归一成 1，一句话只有一条关键词命中时，再无关也是满分，挡不住本次要挡的情况。否决。

### 方案 F：加重排模型（给“问题和这条记忆有多相关”打分的小模型）

- 好处：Anthropic 的 Contextual Retrieval 实测重排能进一步减少检索失败（<https://www.anthropic.com/news/contextual-retrieval>）。
- 代价：每轮多一次模型调用和延迟，属于改检索架构，本次不做；已有待办 [BL-20261029-003](../backlog/BL-20261029-003-memory-search-reranker.md)。

### 去重：同源 + 字面几乎相同（选用），对比写入时去重

- 业界多在写入时去重（mem0 由模型判断新增、更新还是忽略，<https://arxiv.org/abs/2504.19413>），Himawari 的写入去重已有（记忆捕获时的重申和取代）。本决定只处理检索时仍会同时出现的同源近重复，不调模型、不改存储，可以随时关掉。
- 只按来源去重（同源只留一条）否决：同一句话拆出的“妻子叫苏晴”“女儿叫小禾”会丢一条。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 好处：关键词撞上的无关记忆少带，评测里准确率 85.4% → 89.1%，召回不降；主动提醒因无关记忆误扰的机会变少；同源重复不再挤占名额。
- 代价：带出“相关记忆”的口径变成相关分；换向量模型（P3-1）时要用同一套评测重新看门槛和余量。
- 门槛：`test/integration/memory-retrieval-eval/fixture.test.ts`（离线复算完成标准）、`fusion.unit.test.ts`、`hybrid-memory-provider.unit.test.ts`、`packages/application/test/same-source-dedupe.unit.test.ts`、`test/integration/durable-memory-projection.test.ts`、`test/integration/memory-engine-index.test.ts`、`apps/agent-service/test/production-memory-recall.unit.test.ts`、`packages/platform-node/test/startup-configuration.unit.test.ts`。
- 后续：真实数据评测集（P4-5）建好后，用它复核默认参数。

[返回目录](#contents)

<a id="links"></a>

## 关联文档

- [ADR 0115：记忆搜索设相关度门槛](0115-memory-search-relevance-threshold-and-retrieval-eval.md)
- [ADR 0158：Gmail 检查带上相关记忆](https://github.com/sixianli/himawari-agent/blob/9a395ec730b7c96519309bf1199355a04d8199aa/docs/adr/0158-bring-related-memories-into-gmail-checks.md)
- [界面设计指南](../ui-ux-design-guide.md)
- 方案讨论记录：`.agents/reviews/topic-p3-3-fusion-cutoff/`
