你是独立的方案审核者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面是一份还没动手实施的方案。逐条对照代码和一手来源核对：有没有漏掉的场景、判断错的地方、和业界成熟做法不一致的地方。方案作者的说法可能有错。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.claude/rules/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
你的额外侧重：错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销的操作，以及规则文件、说明文档和代码是否一致。有时另有一个复核者侧重别的方面，有时只有你一个，所以你都要回答全部必答问题、报告你发现的任何问题；侧重只决定你先查什么。在结论之前单独写一节「侧重检查」，列出你查过的这类路径和结论。
输出格式：按严重度从高到低排列，每条写：严重度、问题、证据（文件:行引用的代码，或网址和原话）、你建议怎么改。把「证实的」和「推测」分开写。最后写：如果由你来定，你会怎样改这份方案，并逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 82486ba0f61b47f983bea0b47ea42394c27c5879。
待审核的方案：
# P3-3 线程方案：融合后按“相关分”截断 + 同源近重复去重

## 前提（均已核对）
- 融合：`packages/memory-engine/src/fusion.ts:83-114`，RRF(k=60)×boost，`slice(0, limit)`，无分数线。
- 只有向量路有门槛：`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1152`。关键词路 -bm25（:1155-1168），实体路命中名字数（:1170-1184）。
- 场景门槛：聊天 `memory.minimumSimilarity`（qwen3 默认 0.6，`apps/agent-service/src/production-memory-composition.ts:92-95`）；Gmail `proactive.memoryMinimumSimilarity` 默认 0.45（`packages/platform-node/src/strict-configuration.ts:1054-1057`），由 `production-proactive-memory.ts:47` 逐次传入。
- 候选不带 sourceRefs；`DurableMemoryService.search` 已用 `readMany` 拿到 `ProductMemoryRecord.sourceRefs`（`durable-memory-service.ts:391-396`）。
- 评测基线（2026-11-11 实跑，与 10-29 记录一致）：命中 80%，召回 77.4%，准确率 85.4%，无关带出 2.1%。

## 评测数据：三种截断规则（同一份原始候选离线复算）
| 规则 | 命中 | 召回 | 准确率 | 无关带出 |
| --- | --- | --- | --- | --- |
| 基线 | 80% | 77.4% | 85.4% | 2.1% |
| A：只认相似度 ≥ 场景门槛（关键词/实体只参与排序） | 57.5% | 50.9% | 100% | 0% |
| B：相似度 ≥ 门槛，或命中 ≥2 路且相似度 ≥ 0.3~0.45 | 60% | 52.8% | 100% | 0% |
| C（本方案）：相似度 + 0.15×关键词分 + 0.15×人名命中 ≥ 门槛 − 0.03 | 80% | 75.5% | 95.2% | 2.1% |

A、B 都让召回掉 24 个点以上，不满足“recall@5 下降不超过 2 个百分点”：评测集里有大量正确记忆只被一路关键词或人名找到，而且相似度低于 0.6（例如问人名、问“我妻子叫什么”）。C 在 wl 0.15–0.2、we 0.1–0.3、线 0.55–0.58 一片区域里都满足完成标准，不是单点拟合。丢的 1 条是“周末推荐个地方去玩”→“主人不喜欢人多的地方”（相似度 0.422）。剩下的无关带出是“把刚才那段改成日语”→“准备日语 N2 考试”（相似度 0.586，离门槛只差 0.014，任何不伤召回的线都挡不住）。

## 截断
- 排序不变：仍是 RRF × boost。截断只决定留不留，不改顺序（boost 不参与截断，避免重要度变成隐性门槛）。
- 相关分 `rel = sim + keywordWeight × (本句 bm25 / 本句最高 bm25) + entityWeight × [命中人名]`；`rel < 场景门槛 − cutoffMargin` 截掉。默认 keywordWeight 0.15、entityWeight 0.15、cutoffMargin 0.03。
- 场景门槛 ≥ 门槛的向量命中 rel 一定过线，所以向量路行为不变；Gmail 自动用 0.45 − 0.03，不新增 Gmail 专用键。
- sim 来源：存储层对关键词/实体候选补算余弦相似度（新可选字段 `similarity`；JS 引擎本来就全量算，sqlite-vec 引擎对 ≤200 个候选读 blob 算）。不新增嵌入请求。
- sim 未知时不截：查询向量失败（P3-2 降级，已有决策记录）或这条记忆本身没有向量（不可嵌入的分级、索引时嵌入失败）。理由：没有唯一可校准的信号时，截了会让降级回答拿不到记忆；保持今天的行为，最差和现在一样。
- 配置：`memory.retrieval.keywordWeight`、`entityWeight`、`cutoffMargin`（strict-configuration 白名单 + 范围校验），provider 构造时再校验一次。

## 同源去重（Andy 已选：同源且内容几乎相同）
- 位置：应用层 `DurableMemoryService.search`（聊天、Gmail）和 `production-memory-recall.ts` 的 render（memory.recall 工具），共用一个纯函数，放 `packages/application`。
- 判定：两条记忆 `sourceRefs` 有交集，才读两边正文比较；正文 NFKC + 小写 + 去空白标点后，字符 3-gram Dice ≥ 0.9 算“几乎相同”；规范化后少于 8 个字的只认完全相同。
- 留哪条：排在前面的（截断后、按现有排序）；只影响这次检索结果，不改存储，可逆。
- 开关：`memory.retrieval.dedupeSameSource`（默认 true）；阈值 0.9 做成常量（少一个可过拟合的旋钮）。
- 评测集每条记忆来源唯一，去重不影响评测数字；用单独的单元测试覆盖：同源近重复→留 1；同源不同事实→留 2；不同源同文→留 2；关开关→留 2。

## 改的文件
- `packages/memory-engine/src/fusion.ts`、`hybrid-memory-provider.ts`、`index.ts`
- `packages/application/src/ports/memory-projection.ts`（候选加 `similarity?`）、`ports/configuration.ts`、`services/durable-memory-service.ts`、新 `services/same-source-dedupe.ts`
- `packages/persistence-sqlite/src/sqlite-memory-operations.ts`（补算 similarity）、`packages/testing/src/in-memory/memory-index.ts`
- `packages/platform-node/src/strict-configuration.ts`
- `apps/agent-service/src/production-memory-composition.ts`、`service-main.ts`、`production-memory-recall.ts`
- 评测：`live.test.ts` 加 `HIMAWARI_MEMORY_EVAL_FUSION` 参数扫描，`live.mjs` 透传；history 每个 run 多可选字段。
- 新 ADR（号开 PR 前用 check:adr-numbers 核对）+ docs 参数说明。
- 不动 `production-run-memory.ts`（P3-2 在改）。

## 测试
- fusion 单测：单路关键词 sim 0.40 被截；单路人名 sim 0.50 + 0.15 留；向量 0.61 留；sim 未知留；boost 低不影响截断；反向：把 weights 置 0 时“人名命中 0.50”被截。
- SQLite 契约测试：两种向量引擎补算的 similarity 与向量路 signal 一致。
- strict-configuration：未知键、越界值被拒。
- 去重单测 4 条 + DurableMemoryService 集成用例。
- 评测实跑一轮记 history，作为完成标准的证据。
