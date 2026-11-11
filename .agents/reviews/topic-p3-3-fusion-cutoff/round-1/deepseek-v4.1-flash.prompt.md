你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 82486ba0f61b47f983bea0b47ea42394c27c5879。
问题、目标和约束：
# P3-3：记忆检索三路融合后按分数截断、同源去重

## 问题

Himawari 每轮找相关记忆走三路：向量（语义相似）、关键词（SQLite FTS5 的 bm25）、人名/实体（`instr` 子串匹配）。三路结果在 `packages/memory-engine/src/fusion.ts` 用 RRF（倒数排名融合，k=60）合并，再乘一个 boost（重要度、置信度、新近程度、时间窗口），排序后只截前 N 条，没有分数线。

只有向量路有最低相似度（`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1152`，`signal >= minimumSimilarity`）。这个门槛按场景可配：聊天用 `memory.minimumSimilarity`（qwen3-embedding-8b 默认 0.6），Gmail 检查用 `proactive.memoryMinimumSimilarity`（默认 0.45，`packages/platform-node/src/strict-configuration.ts:1054`）。关键词和实体两路没有任何门槛：一个关键词或人名撞上，再不相关的记忆也会被捞出来。

主人的要求（原话摘录）：“检索结果不按单路设门槛，改为三路融合排名后按融合分数截断，并做同源去重；截断分数和去重开关可配。”完成标准：“在仓库的检索评测集上精度上升，且 recall@5 下降不超过 2 个百分点；参数记文档。”注意事项：“向量路按场景可配的门槛已有，保留。不换向量库、不重写检索架构。”

同源去重的定义已由主人选定：**同一来源（记忆的 `sourceRefs` 有交集）且内容几乎相同**才只留一条；同一句话拆出的不同事实都保留。开关可配。

## 已核对的事实

- 调用方：聊天自动带记忆走 `DurableMemoryService.search`（`packages/application/src/services/durable-memory-service.ts:366`），它向 provider 要 `limit*4` 条，再按状态、分级等过滤，截到 `policy.limit`（聊天 5）。`memory.recall` 工具（`apps/agent-service/src/production-memory-recall.ts:173`）直接调 `HybridMemoryProvider.search`。Gmail 检查（`apps/agent-service/src/production-proactive-memory.ts:41`）调 `DurableMemoryService.search` 并逐次传 `minimumSimilarity`。
- `MemoryIndexCandidate`（`packages/application/src/ports/memory-projection.ts:225`）只带 `signal`（向量为余弦相似度、关键词为 -bm25、实体为命中名字数）、重要度、置信度、时间字段，不带 `sourceRefs`。来源记在 `ProductMemoryRecord.sourceRefs`（指向产生这条记忆的原话）。
- 向量路在 SQLite 里只返回前 `limit`（provider 传 `max(50, limit)`，最多 200）条；只被关键词/实体找到、又不在向量前 limit 名里的记忆，目前拿不到它的相似度。
- 被改过的旧记忆会设 `valid_to`，检索默认不返回（`indexScope`，`sqlite-memory-operations.ts:242`）。
- 另一个任务（P3-2）正在让向量服务失败时退化为只用关键词和实体继续回答（`hybrid-memory-provider.ts:150` 的 catch 已在），所以截断必须考虑“没有向量分数”的情况。
- 有些分级的记忆不做向量（`embeddableClassifications`），它们只能被关键词/实体找到。

## 评测数据（2026-11-11，main aa1b0b0，qwen3-embedding-8b，`evals/memory-retrieval/dataset.json`：24 条记忆、40 句相关、48 句无关；每句取 5 条）

生产门槛 0.6 的基线：相关问题命中 80%，召回（recall@5）77.4%，准确率 85.4%，无关问题带出 2.1%（1 句）。

基线里所有错误带出的记忆都只来自关键词路，向量相似度都低于门槛：

| 问题 | 错带的记忆 | 相似度 |
| --- | --- | --- |
| 给苏晴挑个生日礼物 | 主人的生日是3月14日 | 0.404 |
| 我住在哪里 | 主人的母亲住在成都 | 0.481 |
| 我最喜欢什么颜色 | 主人不喜欢人多的地方 / 我喜欢喝拿铁 | 0.375 / 0.421 |
| 我妈住在哪 | 主人住在大阪市北区 | 0.448 |
| 给我女儿准备个周末活动 | 主人在准备日语 N2 考试 / 主人周末常去图书馆 | 0.281 / 0.407 |
| 把刚才那段改成日语（无关句） | 主人在准备日语 N2 考试 | 0.586 |

离线扫描（同一份原始候选，脚本 `/mnt/project-files/p3-3-fusion/sweep.mjs`，结果 `sweep-result.txt`）：直接在现有 RRF 分数上划线，线在“单路第 1 名”的分数附近有断崖：低于它什么都不挡，高于它召回从 77.4% 掉到 47%–55%。

## 约束

- 不换向量库、不重写检索架构；向量路按场景的门槛保留。
- 新发给模型或嵌入服务的请求必须走仓库统一出口（本任务预计不新增请求）。
- 发给模型的内容只能往后追加（`.claude/rules/prompt-prefix.md`）；本任务只改检索结果，不改提示词。
- 不许写死能动态获取的值；参数可配并写进文档。
- 评测集只有 24 条记忆，要防止参数过拟合。
- 主人的原则排序：用户主权 > 边界与可逆 > 记忆可靠 > 主动与效率。

## 请你回答

1. 截断用的“融合分数”应该怎么定义，才能挡住只被关键词/人名撞上的无关记忆，同时不伤需要联想的向量命中？给出公式和默认参数，并说明对 Gmail 检查（门槛 0.45）怎么取值。
2. 向量服务失败（只剩关键词和实体）、记忆没有向量、关键词候选不在向量前 limit 名里时，各怎么处理？
3. “同源且内容几乎相同”怎么判定（用什么相似度、阈值多少、在哪一层做），代价多大？
4. 改哪些文件、怎么测、评测脚本要不要改。
5. 业界（Elastic、Weaviate、Azure AI Search、Pinecone、Vespa、mem0、Letta 等）是怎么做混合检索截断和去重的，请附一手链接。
