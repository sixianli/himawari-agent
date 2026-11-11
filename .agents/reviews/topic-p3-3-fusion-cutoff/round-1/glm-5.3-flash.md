代码现状已基本摸清。现在查业界一手来源。
# P3-3 方案：记忆检索融合截断与同源去重

## 一、方案依赖的前提

**读代码证实的：**

1. 三路结果在 `fuseCandidates` 里用 RRF（k=60）合并，乘 boost 后排序，`slice(0, limit)` 截前 N 条，全程没有分数线（`packages/memory-engine/src/fusion.ts:94,99-114`，原话 `current.rrf += weight / (weights.rrfK + rank + 1)`、`.slice(0, input.limit)`）。
2. 只有向量路有门槛：SQLite 在向量分支末尾 `vector = vector.filter(({ signal }) => signal >= input.minimumSimilarity)`（`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1152`）；词法路（`-bm25`，:1155-1168）和实体路（`instr(@queryText, e.name)`，:1170-1184）原样返回。
3. `MemoryIndexCandidate` 只有 `signal`/重要度/置信度/时间字段，不带 `sourceRefs`，也不带向量相似度（`packages/application/src/ports/memory-projection.ts:225-236`）；`sourceRefs` 在 `ProductMemoryRecord` 上（:62），落库在 `memory_provenance` 表（`sqlite-memory-operations.ts:818-824`）。JS 向量引擎本来就对**全部**行算完余弦再截前 limit（:1121-1150），即对任意候选补算相似度在数据上可行。
4. 调用方与分片位置：聊天走 `DurableMemoryService.search`，向 provider 要 `limit*4` 条，过滤后 `slice(0, policy.limit)`（`packages/application/src/services/durable-memory-service.ts:380-421`）；`memory.recall` 工具直接调 provider，`limit*3`，**不传** `minimumSimilarity`（落到 provider 构造默认，`apps/agent-service/src/production-memory-recall.ts:171-180`、`hybrid-memory-provider.ts:163`）；Gmail 逐次传 `minimumSimilarity`（`apps/agent-service/src/production-proactive-memory.ts:41-54`）。
5. 向量失败时 catch 后 `embedding` 为 null，词法/实体照跑，`vectorEngine` 会是 `"none"`（`hybrid-memory-provider.ts:150-152,156-168`；`sqlite-memory-operations.ts:1097-1098`）——P3-2 退化路径成立。
6. 模型可见分级是 `public/private/sensitive`（`packages/application/src/services/model-visibility.ts:10-14`），而嵌入只对 `embeddableClassifications` 做（评测用 `["public","private"]`，`test/integration/memory-retrieval-eval/live.test.ts:223`）——**sensitive 记忆模型可见但可无向量**。
7. 模型可见的分级才建词法/实体索引（`isModelVisible`，`hybrid-memory-provider.ts:85-87`、`sqlite-memory-operations.ts:811-816`）；`sourceRefs` 允许为空（:602-603）。
8. 评测基建已能离线复算：`recordingIndex` 在 `minimumSimilarity === 0` 时把三路原始候选全量存进 `candidates.json`（`live.test.ts:97-112`），阈值走环境变量（:173-177）。
9. 配置键在 `strict-configuration.ts` 白名单校验：`memory` 只认 5 个键（:1288-1298），`proactive.memoryMinimumSimilarity` 默认 0.45（:1054-1057）；provider 构造对 `minimumSimilarity` 做范围校验（`hybrid-memory-provider.ts:51-53`）。
10. 请求开头约束：`本轮选中的记忆`属于"每轮都会变的内容，只放最后一条用户消息"（`.claude/rules/prompt-prefix.md:28`）；`npm run check:prompt-prefix` 带反向用例（:74）。

**主人提供的、我未复算的数据（材料给出）：** 基线指标与 6 行错误带出记录；离线扫描结论“在 RRF 分数上划线，低于单路第 1 名不挡、高于它召回掉到 47%–55%"（脚本在 `/mnt/project-files/p3-3-fusion/`，仓库外，未读）。

**推测（标注）：** `sim("我妈住在哪", 母亲住在成都)` 约 0.5 且低于 0.6 —— 由此推测存在“单路词法命中的金标”会被任何截断伤到，量级需实跑评测确认。

## 二、方案

### 1. 「融合分数截断」怎么定义（问题 1）

**先说结论性判断：在 RRF·boost 分数上直接划线不可行，不应照做。** 三个独立证据：① 主人的离线扫描已在现有 RRF 分数上试过所有划线位置，只有断崖（材料）；② Azure AI Search 官方明确说 RRF 分数不能当门槛："RRF scores are inherently lower than similarity scores. A score of 0.03 can still indicate a strong match"（https://learn.microsoft.com/en-us/azure/search/hybrid-search-how-to-query ）；③ Weaviate 官方干脆不提供混合分门槛："There is no equivalent threshold parameter for the keyword (BM25) component of hybrid search or the final combined scores. This is because BM25 scores are not normalized or bounded... making a universal threshold less meaningful"（https://docs.weaviate.io/weaviate/concepts/search/hybrid-search ）。原因很直白：RRF 只保留名次，单路第 1 名的垃圾（1/61·boost）和单路第 1 名的金标分数相同，划线必然同时杀掉两者。

所以把「融合分数截断」重新定义为**带校准证据的共识准入规则**：排序分不动（RRF·boost，行为兼容），截断改在准入层做，且用**校准过的向量相似度**而不是 RRF 分数作门槛：

> **准入公式**（在 `fuseCandidates` 截断前逐候选判定）：
> ```
> admit(c) ⟺ vectorEngine = "none"                      （退化：不设线）
>          ∨  sim(c) ≥ minimumSimilarity                 （场景门槛，对所有候选生效）
>          ∨  |routes(c)| ≥ 2 ∧ (sim(c) 未定义 ∨ sim(c) ≥ fusionMinimumScore)
> ```
> 其中 `sim(c)` = 该候选与查询向量的真实余弦相似度（新增补算，见下）；`routes(c)` = 命中的路数；`minimumSimilarity` = 现有场景门槛（聊天 0.6 / Gmail 0.45，原值保留）。

配套改动一条：SQLite 对词法/实体路候选**补算余弦相似度**，放进 `MemoryIndexCandidate` 新可选字段 `similarity`。JS 引擎本来就算全量（:1121-1150）；sqlite-vec 引擎对 ≤200 条候选从 blob 在 JS 里算点积（复用 `blobVector`），4096 维 × 200 条是微秒级。这样“关键词候选不在向量前 limit 名里拿不到相似度”的问题（材料已核对的事实第 3 条）一并消除。

**为什么这样挡得住垃圾、不伤金标：**
- 6 行错误带出全部是单路词法命中且 sim < 0.6（材料表格），既不过场景门槛也无双路共识 → 全被挡，无关带出 2.1% → 0（推测待验证）。
- 向量路成员按构造 sim ≥ 0.6，规则第一条即放行，行为与今天完全一致（场景门槛字面保留）。
- 双路命中的候选（词法+实体、向量+词法）只要 sim ≥ fusionMinimumScore 就放行——共识本身就是证据，这正是 Weaviate 放弃 BM25 门槛、Azure 用 L2 reranker 补证据的同款思路。
- boost（重要度/置信度/新近/时间窗）**不参与准入**，只参与排序：重要度不该能降低相关性门槛。

**默认参数与防过拟合：**
- `fusionMinimumScore` 默认 **0.45**。理由：它是仓库里另一个已校准的“相关"下限（`proactive.memoryMinimumSimilarity`，`strict-configuration.ts:1054-1057`），不是从 24 条记忆、48 个无关句上扫出来的值；≥2 路共识是结构性要求，不是拟合值。评测只用于**验证**完成标准，不用于调参。
- **Gmail 取值**：不加 per-scene 键。Gmail 场景 `minimumSimilarity = 0.45`，此时规则第二条（sim ≥ 0.45）与第三条的 sim 分支完全重合，规则退化为"`sim ≥ 0.45` 或（≥2 路且无 sim）"，即 Gmail 行为 ≈ 现状 + 挡掉 sub-0.45 的单路词法/实体命中——方向正确（邮件检查要精确），无需新参数。若 Gmail 评测掉点，再补 `proactive.fusionMinimumScore`（预留同款写法）。

### 2. 三种"没有向量分数”的情形（问题 2)

| 情形 | 处理 | 依据 |
| --- | --- | --- |
| **向量服务失败**（P3-2 退化，embedding 为 null） | `vectorEngine = "none"` → 整条准入规则跳过，词法/实体结果照今天返回。理由：截断的目的是压精度，退化时唯一校准信号已丢失，再截有全空风险；`onVectorFailure` 已记日志（`hybrid-memory-provider.ts:151`），退化频率可监控 | :150-152,:1097 |
| **记忆本身无嵌入**（sensitive 等非嵌入分级、upsert 失败暂缺） | 走共识分支：≥2 路命中才放行；单路不放行。比“无 sim 一律放行”更利于边界（用户主权 > 边界 > 记忆可靠），且 sensitive 记忆少露出是安全方向的偏差 | :811-816（sensitive 不建实体索引与否取决于分级集合）、:97（嵌入条件） |
| **词法/实体命中但不在向量前 limit 名** | 补算相似度后与向量成员同一规则判，不再依赖“是否在向量列表里" | :1121-1150 |

### 3. 同源去重怎么判定（问题 3）

**层次：应用层，不在 provider/SQLite 层。** 判定需要 `sourceRefs`（只在 `ProductMemoryRecord` 上）和记忆正文（payload 解密后才有），两者都在 `DurableMemoryService.search`（`readMany` 已拿 records，`content.readText` 端口已在，:379,391-396）和 `production-memory-recall.ts`（:197-223 同样两者齐备）的现成位置可用。放 provider 层就得跨抽象传加密内容或改索引表，不值。

**判定规则（纯函数，放 `packages/application`，两处共用）：**
1. 先比 `sourceRefs` 是否有交集（零 I/O，O(候选²×refs)，聊天 ≤20 条候选）；无交集不比内容——严格符合主人选的定义“同源且内容几乎相同才留一条，同一句话拆出的不同事实都保留"（同源但内容不同的事实对不被去重）。
2. 对有交集的对，读双方正文（只在这时发生 I/O，本地 SQLite），NFKC 归一 + 去空白/标点后：完全相等，或归一化编辑相似度 ≥ **0.9**（代码常量，不设配置键）。0.9 与 Letta 社区讨论里“cosine > 0.9/0.92 只抓字面近似重复"同量级（https://github.com/letta-ai/letta/issues/3116 ）。
3. 留谁：融合分高者；平分则 `memoryId` 字典序小者（与 `fusion.ts:113` 的 tie-break 一致，保证确定性）。
4. 只在**本次检索结果内**去重，不动存储——天然可逆，符合“边界与可逆”。`sourceRefs` 为空的记忆（:602 允许）无交集，永不参与去重。

**代价：** 交集比较可忽略；文本读取只发生在存在同源对时（典型 0 次）；编辑距离在百字内字符串可忽略。逐请求有界。

**开关：** `memory.deduplicateSameSource`（默认 true），Gmail/recall 工具路径同样生效。

### 4. 改哪些文件、怎么测、评测要不要改（问题 4）

**代码（每处新值的产生端/消费端成对列）：**

| 值 | 产生处 | 使用处 | 两端校验 |
| --- | --- | --- | --- |
| `similarity` 字段 | `sqlite-memory-operations.ts` searchIndex 补算 | `fusion.ts` 准入 | 端口类型 `memory-projection.ts` 同步；有限值校验（`Number.isFinite`，复用 ：1085 模式） |
| `fusionMinimumScore` | `strict-configuration.ts`（加进 ：1290 白名单 + `unitInterval` 0<x<1 校验）、`configuration.ts:77` 旁 | `production-memory-composition.ts:97-110` → `HybridMemoryProvider` options → `fuseCandidates` | provider 构造 RangeError（仿 ：51-53）；默认 0.45 由 memory-engine 常量给出 |
| `deduplicateSameSource` | `strict-configuration.ts` 白名单 + 布尔校验 | `DurableMemoryService` options、`ProductionMemoryRecall` options | 构造处布尔断言 |
| 去重键 | `memory_provenance`（:818-824）+ payload 正文 | dedup 纯函数 | 空/sourceRefs 非法已在 ：602-603 挡 |
| 评测 round schema | `live.test.ts` | `live.mjs` 的 history 对比 | 旧记录缺新字段需 `??` 兜底 |

**测试与反向用例（真会失败的写法）：**
- `fusion.unit.test.ts`：单路词法 sim 0.40 → 被挡（若实现回退成纯 RRF 此用例失败）；双路 sim 0.46 → 放行；向量成员 sim 0.61 → 放行；`vectorEngine:"none"` → 全放行；无 sim 双路 → 放行；同分确定性。反向用例：把 `fusionMinimumScore` 设 0 再断言垃圾被挡 → 必失败，证明检查有效。
- SQLite 契约测试：补算的 similarity 与向量路 signal 一致（两引擎同值）。
- `strict-configuration` 反例：未知键、越界值（0、1、1.5）被拒。
- dedup 单测：同源同文→留 1；同源异文（不同事实）→留 2；异源同文→留 2；0.9 边界；输出顺序确定。
- `npm run check:prompt-prefix` 照跑（本改动不触碰请求头，但它必须继续通过）。

**评测脚本：要改，但少改。** `live.test.ts` 的 `thresholds` 维度扩展为同时扫 `fusionMinimumScore`（新环境变量）；`candidates.json` 机制（:108）已经存了门槛 0 时的三路原始候选，**离线即可复算任何准入参数组合，不必每次重花钱调 embedding**；`outcomes.json` 增加每条返回的 routes/similarity 归因，方便核对 6 行错误是否真被挡。评测集一个字不改。完成标准（精度↑、recall@5 降幅 ≤2pp、参数记文档）以此实跑验收；recall 掉幅大于 2pp 时的处置见“需要拍板”。

## 三、考虑过但不选的做法

1. **在 RRF 分数上直接划线（主人的原设计）。** sweep 已证明断崖；Azure/Weaviate 均不给这种门槛（见前引）。不选。
2. **Weaviate 式 relativeScoreFusion**（每路 min-max 归一再加权求和，https://docs.weaviate.io/weaviate/concepts/search/hybrid-search ；源码 https://github.com/weaviate/weaviate/blob/main/usecases/traverser/hybrid/hybrid_fusion.go ）。min-max 归一在“词法结果只有 1 条”时把垃圾归一成 1.0，且 Azure 社区文章点名其缺陷："Min-max normalising each list per query makes the top result of a terrible list look as good as the top of a great one"（https://michaeljohnpena.com/blog/2024-01-27-hybrid-search-optimization/ ，二手，仅作旁证）。不选。
3. **Pinecone 式 α 凸组合**（`combined = α·dense + (1-α)·sparse`，https://docs.pinecone.io/guides/legacy/vectors-api/hybrid-search-single-index ）。BM25 无界、需重标定，等于重写融合层，违反“不重写检索架构”。不选。
4. **Vespa 式两段排序**（first-phase 便宜表达式 + second-phase 重排 + `rank-score-drop-limit`，https://docs.vespa.ai/en/ranking/phased-ranking.html ；混合教程用 `closeness×(1+bm25)`，https://docs.vespa.ai/en/learn/tutorials/hybrid-search.html ）。思想可借鉴（便宜证据过滤 + 贵证据确认），但 Vespa 有全局 second-phase 基础设施，本仓库没有；本方案本质就是它的单机版：词法命中 → 向量相似度确认。采纳思想、不搬机制。
5. **mem0 式写时去重**（LLM 在 ADD/UPDATE/DELETE/NOOP 里判重，https://arxiv.org/html/2504.19413 ）。业界主流确在写时做、读时不做（Letta 档案记忆至今没有去重，https://docs.letta.com/v1-sdk/memory/archival-memory/index.md ），但那是存储级合并，与主人定义“检索结果内、可逆、同源才去重”不同；且每条多一次 LLM 调用，违背“本任务不新增请求”。不选，但记下：若未来检索去重不够，写时整理是下一步。
6. **给词法/实体路各设一个 bm25/命中数门槛。** 直接违反主人“不按单路设门槛”，且 bm25 跨查询不可比（Weaviate 拒绝 BM25 门槛的理由同）。不选。
7. **P3-3 里顺带解决“我妈→母亲成都”这类语义改写。** 那是向量门槛 0.6 本身的问题，属另一任务；本任务只保证不使其更差。

## 四、风险与反例

- **反例 1（最大风险）：** 「我妈住在哪」→「主人的母亲住在成都」。推测其 sim ≈ 0.5（未核实），单路词法 → 被共识规则挡 → recall 掉。sweep 显示裸 RRF 划线 recall 掉 22–30pp；本规则的损失 = “单路词法的金标数”，必须实跑评测量化。若 >2pp，处置见拍板项 2。
- **反例 2：** sensitive 记忆被单个人名实体命中（“张三上次说了什么”）→ 无 sim、单路 → 被挡。安全方向偏差，但可能丢可用记忆。
- **反例 3：** 退化模式（向量失败）下垃圾词法命中重新出现——这是接受的设计（能回答 > 精度），靠日志监控频率。
- **反例 4：** 24 条记忆的评测集上任何调参都是过拟合风险——本方案默认值全部取自既有校准值或结构常数，且用 candidates.json 离线复算而不是反复实跑。
- **工程反例：** `similarity` 补算让 SQLite 返回结构变化，所有 `MemoryIndexSearchResult` 消费者（评测 recordingIndex、契约测试）都要过一遍——正好是 I-73 的教训：不能只看 diff，要核对每个消费端。

## 五、需要人拍板的取舍

1. **准入规则替代字面“按 RRF 分数截断”**：主人的原话按字面实施已被 sweep 证伪，改为“共识 + 校准相似度准入、排序分不动”。需要 Andy 认可这个重新定义。
2. **recall 与精度的拨杆方向**：若实跑 recall@5 掉幅 >2pp，选项 A = 下调 `fusionMinimumScore`（0.45→0.40，有过拟合嫌疑）；选项 B = 允许“单路 + sim ≥ minimumSimilarity"（已被第一条准入覆盖，实际等于不动）；选项 C = 放弃共识、只按 sim ≥ 0.45 截（会把 sim 0.481 的垃圾「我住在哪里→母亲住成都」放回来）。默认走 A，上限一次。
3. **无 sim 单路实体命中是否放行**（人名被明确点名的 sensitive 记忆）。方案默认不放行（边界优先），可加特例。
4. **去重阈值 0.9 做成常量还是配置键**。方案默认常量（少一个可过拟合的旋钮）。

## 六、必答问题逐条

**1. 会不会改变模型已经见过的请求开头？** 不会。【证实】本任务只改每轮检索出哪些记忆、去重后留哪条；记忆块属于“本轮选中的记忆/本轮资料”，规则明文要求这类每轮都变的值只放最后一条用户消息（`.claude/rules/prompt-prefix.md:28`），系统提示、工具定义、历史消息、遮盖规则一概不触碰；不新增模型请求（去重的文本比较用本地 `content.readText`，不调模型/嵌入）。发给模型的内容仍只追加：每轮记忆块整体替换在最后一条消息里，之前的消息逐字节不变。逐轮变化仅来自检索输入（本轮 query、`now()`），落在末尾。【未核实】记忆块在 prompt 中的具体组装点（`context-formation-service.ts:120` 消费 `MemoryPort.search`，渲染细节未读）；`npm run check:prompt-prefix` 实跑通过为准。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。【证实】准入是候选自身字段的纯函数（routes、sim、分数）；RRF/boost 排序已带确定性 tie-break（`fusion.ts:113` `localeCompare`）；去重是同一请求结果集内的纯函数（sourceRefs 交集 + 归一化编辑相似度），不依赖历史请求、不依赖前后文遮盖；输出顺序由确定性排序决定（`durable-memory-service.ts:418-421`）；无带时间字段或无序集合进入请求内容（`now()` 只影响选哪些记忆，属于每轮合法变化，且在末尾消息）。遮盖结果不受影响（检索不触碰遮盖管线）。

**3. 有没有对应的自动检查、反向用例真会失败？** 有，需新增。列在"测试与反向用例”节：fusion 准入用例（含“阈值置 0 后垃圾被挡”的反向断言，实现回退即失败）；strict-configuration 未知键/越界反例（I-73 的教训落到这里：新增键的白名单遗漏会被“合法配置被拒”和“非法配置被收”两侧用例夹住）；dedup 全分支用例；SQLite 补算一致性契约测试。现有 `check:prompt-prefix` 不覆盖本改动但必须继续通过。【未核实】仓库是否已有 strict-configuration 的专用测试文件位置（未逐一定位）。

**4. 每个新值/改值的两端核对。** 见“代码”节表格：`similarity`（SQLite 产生 ↔ fusion 消费，端口类型同步）；`fusionMinimumScore`（strict-configuration 校验产生 ↔ provider 构造 RangeError 二次校验 ↔ fuseCandidates 消费）；`deduplicateSameSource`（strict-configuration ↔ 两个服务构造）；去重键（memory_provenance/payload ↔ 纯函数，空 sourceRefs 不参与）。这正是 I-73 要求的“产生端与使用端都核对校验”，清单键必须能通过下游校验才准入配置。

**（附）问题 5 业界小结（一手来源）：** 截断方面，各家的共识是“不要在 RRF 分数上划线”：Azure 明说 RRF 分数低是正常现象、要门槛就用 L2 语义 reranker 分数（0–4）或向量子查询加权（https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking ）；Weaviate 干脆不提供 BM25 或混合分的门槛参数，默认 `relativeScoreFusion` 保留分数幅度、α=0.75 偏向量（https://docs.weaviate.io/weaviate/concepts/search/hybrid-search ）；Pinecone 推荐“先过滤再排序”（"an out-of-scope document can't compete for a result slot"）或客户端 RRF（https://docs.pinecone.io/guides/search/hybrid-search ）；Vespa 用两段排序，便宜的 first-phase 过滤、贵的 second-phase 确认（https://docs.vespa.ai/en/ranking/phased-ranking.html ）。去重方面，业界都做在**写时**不做在检索时：mem0 由 LLM 在 ADD/UPDATE/DELETE/NOOP 四操作里判重（https://arxiv.org/html/2504.19413 ）；Letta 档案记忆只有语义检索、无去重，去重是开放中的功能请求，社区方案是“嵌入近似（≈0.9+）抓字面重复 + LLM 判主张等价”两段式（https://github.com/letta-ai/letta/issues/3116 ）。本方案的读时去重（同源 + 字面近似 0.9、可逆、不调模型）是对主人定义的忠实实现，也与其上“先便宜后贵”的过滤思路一致。
