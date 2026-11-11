## 结论

方案想解决“无关记忆被带出”，但当前设计把**召回**和**过滤**混在一个手工加权分数里，并且去重放在截断之后。按方案文字实施，至少有三处会直接影响正确性或可用性：去重后不回填、模糊去重会把只差一个数字的两条事实合并、去重把正文读取带进 search 导致单条 payload 损坏就能让整次检索失败。建议先不要按现方案上生产，改成“召回保持宽、过滤用可校准信号（优先重排）、去重用显式键”的结构。

---

## 证实的（按严重度）

### 1. 高｜去重放在截断/切片之后，且可能晚于 `markUsed`，会少返回且违反“不改存储”

**问题**：方案写“留哪条：排在前面的（截断后、按现有排序）”。如果先在 `DurableMemoryService.search` 的 `.slice(0, input.policy.limit)` 之后去重，被去掉的重复项无法用后面的候选回填，最终条数会少于 limit；更严重的是，若去重发生在 `markUsed` 之后，被去重掉、根本没给模型看的记忆仍会被写成“最近使用”，后续排序会因此变化，违背方案“只影响这次检索结果，不改存储，可逆”的承诺。

**证据**：
- `packages/application/src/services/durable-memory-service.ts:401-426`：先过滤、排序、`.slice(0, input.policy.limit)`，然后对 `selected` 调 `markUsed`。
- `packages/memory-engine/src/fusion.ts:113-114`：融合结果也先 `.slice(0, input.limit)`。
- 方案原文：“留哪条：排在前面的（截断后、按现有排序）”。

**建议**：顺序改为“分类/状态过滤 → 相关分截断 → 同源去重 → 按现有排序取前 limit → 只对最终保留的 id 调 `markUsed`”。`memory.recall` 的 render 也一样，去重要在填充循环里做，去掉一条就继续从后续候选补，不能先去重数组再截前 N。加测试：有重复时仍能补满；被去重掉的 id 的 `lastUsedAt` / `useCount` 不变。

### 2. 高｜同源 3-gram 模糊去重会把“只差一个数字/标识符”的两条事实合并

**问题**：同源判定是 `sourceRefs` 有交集。同一次记忆抽取产生的所有候选都带同一个 `input.sourceRef`，所以“同源”实际是“同一批抽取”，不是“同一条事实”。在这些同源记忆上再用字符 3-gram Dice ≥ 0.9 判“几乎相同”，对长文本会把只改了一个数字的两条不同事实判成重复。例如 500 字左右的记忆（抽取上限就是 500 字）只改一个数字，Dice 约为 `1 - 3/n`，n 接近 500 时远高于 0.9；电话号码、账号、日期、金额、地址门牌号都可能被合并。如果排在前面的恰好是旧值，模型会看不到当前正确值。

**证据**：
- `packages/application/src/services/automatic-memory-service.ts:460`、`:480`：同一批抽取的每条记忆都带 `input.sourceRef`。
- `apps/agent-service/src/production-memory-capture.ts:63`：`MAXIMUM_MEMORY_CHARACTERS = 500`，长文本完全可能。
- 方案：“sourceRefs 有交集……字符 3-gram Dice ≥ 0.9 算几乎相同”。
- 业界更常见的显式折叠做法是按一个明确的 collapse key 取每组第一条，而不是用模糊文本相似度决定是否折叠：[Elasticsearch collapse](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/collapse-search-results)：“The collapsing is done by selecting only the top sorted document per collapse key.”

**建议**：不要把“同源 + 模糊相似”作为删除依据。优先在写入或整理时给完全重复/被取代的记忆写显式的 `canonicalMemoryId` / `duplicateOf` 关系，检索时按这个键折叠；如果必须在读取时做，至少要求规范化后**完全相同**才折叠，或增加“数字串/实体串有任何不同就绝不折叠”的守卫。补一条反向用例：500 字、只差一个数字的同源记忆必须保留 2 条。

### 3. 高｜去重把正文读取引入 `search`，任何一条 payload 读失败会让整次记忆检索失败

**问题**：现在 `DurableMemoryService.search` 只读元数据和 `sourceRefs`，不读正文；正文是在后面渲染阶段读的，读失败只影响那一条。方案让 `search` 为了比较正文去读两边正文，如果某条 payload 丢失、解密失败或内容类型不是文本，`readText` 会抛错，整个 search 失败。聊天路径会把整步记忆报成不可用，Gmail 路径则可能整批失败。

**证据**：
- `packages/application/src/services/durable-memory-service.ts:391-421`：当前 search 不调用 `content.readText`。
- `apps/agent-service/src/service-main.ts:1166-1176`：`readText` 找不到 payload 时直接 `throw new Error("MEMORY_PAYLOAD_MISSING")`。
- `apps/agent-service/src/production-memory-recall.ts:223`：recall 的 render 对读正文用了 `.catch(() => undefined)`，说明这里本来就预期可能失败。

**建议**：去重函数本身不碰 I/O，只接收已经读到的文本；`search` 里的每次 `readText` 都必须按条 `catch`，失败时按“不是重复”保留两条并记录 `memory.dedupe_read_failed`。或者把去重放到已经读正文的地方（recall 的 render），自动记忆块则先做有上限的预读并缓存。加测试：一条 payload 缺失时，其余记忆照常返回，search 不抛。

### 4. 中｜`sim` 未知就放行，会让缺向量或降级路径完全绕过新门槛

**问题**：方案规定查询向量失败或记忆没有向量时不截断。结果是：索引里所有嵌入失败/不可嵌入的记忆，只要关键词或实体命中，就永远不受新门槛约束；查询向量失败时，整个新门槛对关键词/实体路完全不生效。这不是“最差和现在一样”那么简单：它让新功能在降级时静默失效，而且没有任何指标能看出有多少条走的是“无门槛”路径。

**证据**：
- 方案：“sim 未知时不截……保持今天的行为，最差和现在一样。”
- `packages/memory-engine/src/hybrid-memory-provider.ts:137-153`：嵌入失败时只调用 `onVectorFailure`，然后继续用 `embedding: null` 搜索。
- `packages/persistence-sqlite/src/sqlite-memory-operations.ts:1099-1152`：只有 `input.embedding` 存在时才计算/过滤向量。

**建议**：把“未知”当成一种明确的降级策略，而不是无声放行：例如 `sim` 未知时，只有同时命中 ≥2 路才保留，或只保留向量路（未知就不进），并记录 `memory.similarity_missing` / `memory.cutoff_skipped` 指标。补测试：嵌入失败时关键词候选的行为符合预期，不会静默全部放行。另：P3-2 的“降级”在当前仓库里未核实，当前聊天路径在向量失败时是整步报错（`production-run-memory.ts:362-368`），方案引用 P3-2 前要确认它到底改成什么。

### 5. 中｜“人名命中”不成立：实体路是通用的 `attributes.entities`，信号还是计数

**问题**：方案把实体路写成“0.15×人名命中”“[命中人名]”，但存储层匹配的是 `memory_entities` 里的所有实体名，来源是 `attributes.entities`；人物名另有 `memory_people` 表，而检索根本没有用它。实体路当前的 signal 是命中名字数（COUNT），不是 0/1。用“人名”来解释这个权重会误导实现：实现者可能去接 people 表，或者把所有实体命中都当成 0.15，导致常见地名/项目名也能给低相似度记忆加分。另外“[命中人名]”到底是二值还是计数的归一化，方案没定义。

**证据**：
- `packages/persistence-sqlite/src/sqlite-memory-operations.ts:1169-1184`：`FROM memory_entities e ... COUNT(*) AS signal`。
- `packages/application/src/ports/memory-projection.ts:28-41`：`attributes.entities` 是通用实体数组，不是人物表。
- `docs/adr/0196-index-sensitive-memory-after-masking-and-stop-idle-archiving.md:59`：人物名写进 `memory_people`，`attributes.entities` 是另一套。
- 全仓库检索 `memory_people` 只出现在记忆簿/导出/导入，不在 `searchIndex`。

**建议**：把名字改成“实体命中”，并明确信号是二值还是 `count / maxCount`；如果要利用人物名，单独接 `memory_people` 并单独校准。加多实体命中和常见实体名的反向测试。

### 6. 中｜配置校验必须拒绝负权重/非有限值，否则“向量路行为不变”不成立

**问题**：方案说“向量命中 rel 一定过线，所以向量路行为不变”。这个结论只在 `keywordWeight`、`entityWeight` 非负且有限时成立。如果配置允许负数，一条 `sim = 0.61` 的向量命中同时命中关键词，`rel` 可能被减到 0.57 以下而被截掉，直接违反方案的核心保证。方案只写了“范围校验”，没有写清权重的最小值和 `cutoffMargin` 的上界。

**证据**：
- 方案公式和“向量路行为不变”的结论。
- `packages/memory-engine/src/hybrid-memory-provider.ts:50-54`：当前构造只校验 `minimumSimilarity`，没有权重字段。
- `packages/platform-node/src/strict-configuration.ts:1287-1298`：`memory` 当前只校验 `minimumSimilarity`，新增键需要显式范围规则。

**建议**：`keywordWeight`、`entityWeight` 必须是有限数且 ≥ 0；`cutoffMargin` 有限且建议 `0 ≤ margin < 1`；`dedupeSameSource` 必须是布尔。strict-configuration 和 provider 构造各校验一次，并加反向测试：负权重、NaN、Infinity、字符串、越界 margin 都拒绝启动。顺便校验 `similarity` 本身是有限数，防止存储层返回 NaN 时比较恒为 false。

### 7. 中｜Gmail 直接套用聊天校准出来的权重和 margin，且有效门槛 0.45 必须传进 fusion

**问题**：方案的权重/margin 是在聊天的 88 题上校准的，但 Gmail 用的是 0.45 门槛和“发件人 + 标题 + 摘要”的查询分布。ADR 0158 明确说 0.45 是只按向量一路在 159 封合成邮件上定的，没有验证过关键词/实体加分后的复合线。另外，`cutoff` 必须用本次调用的有效门槛（Gmail 0.45），不能误用 provider 构造时的聊天默认 0.6，否则 Gmail 召回会大幅下降。

**证据**：
- `apps/agent-service/src/production-memory-composition.ts:92-100`：provider 默认门槛来自 `memory.minimumSimilarity`（聊天 0.6）。
- `apps/agent-service/src/production-proactive-memory.ts:41-47`：Gmail 每次传 `minimumSimilarity: options.minimumSimilarity`（0.45）。
- `packages/memory-engine/src/hybrid-memory-provider.ts:163`：index 用 `input.minimumSimilarity ?? provider 默认`；fusion 目前没有门槛参数，新增时必须同样取有效值。
- `docs/adr/0158-bring-related-memories-into-gmail-checks.md:35`：0.45 是只算向量一路的 Gmail 校准。

**建议**：在 `HybridMemoryProvider.search` 里把 `effectiveMinimumSimilarity` 同时传给 index 和 fusion；加一个 Gmail 路径的集成测试（0.45 生效，不是 0.6）。Gmail 的权重/margin 要么单独校准，要么先保持 Gmail 只按现有向量门槛，不要未经评测就改。

### 8. 中｜调参和验收用同一套 88 题，没有留出集；评测是一次性付费运行，不是自动门槛

**问题**：方案用同一份 88 题同时选权重/margin、又用它报告“完成标准”，这只能证明在这套题上拟合得好，不能证明泛化。方案说“wl 0.15–0.2、we 0.1–0.3、线 0.55–0.58 一片区域都满足”，但整片区域都在同一个测试集上搜出来的。Google 的 ML 规则明确要求用之后的数据测试，而不是在训练/调参数据上验收：[Rules of ML #33](https://developers.google.com/machine-learning/guides/rules-of-ml#rule_33_if_you_produce_a_model_based_on_the_data_until_january_5th_test_the_model_on_the_data_from_january_6th_and_after)：“If you produce a model based on the data until January 5th, test the model on data from January 6th and after.”

另外，`npm run eval:memory-retrieval` 需要付费 key、手动运行，`live.mjs` 只打印对比并写 `history.jsonl`，不设通过/失败门槛；方案说“实跑一轮记 history 作为完成标准的证据”，这是一次性证据，不是防回归的自动检查。

**证据**：
- `docs/adr/0115-memory-search-relevance-threshold-and-retrieval-eval.md:66-77`：24 条记忆、88 句、基线表。
- `scripts/memory-retrieval-eval/live.mjs:93-108`：只打印和追加记录，不失败。
- 方案表格和“一片区域”说明。

**建议**：把数据集拆成调参集/留出集（或另建一套不同来源的题）；报告留出集指标。把 `candidates.json` 固化成确定性 fixture，在 CI 里跑一个不花钱的截断/去重复算测试，断言召回下降不超过阈值；实时评测只作为上线证据。补上按 `kind`（直接/联想/无关）分组的指标，避免总体数字掩盖某一类退化。

### 9. 中｜方案不能减少“无关问题带出”，而且把关键词加分放进门槛会奖励关键词误命中

**问题**：方案自己的数字是：无关带出 2.1% → 2.1%，没有下降；“把刚才那段改成日语”→“准备日语 N2 考试”（0.586）、“周末推荐个地方去玩”→“主人不喜欢人多的地方”（0.422）都还在。方案也承认“任何不伤召回的线都挡不住”。如果目标是 I-23 的“无关问题带出记忆”，这个方案没有达成；它主要提升了相关问题内部的 precision。更结构性的问题是：`rel` 给关键词命中加 0.15，等于让“关键词撞上但语义不相关”的候选更容易过线，正好强化了这类误命中。

**证据**：
- 方案表格：C 的“无关带出”仍是 2.1%，与基线相同。
- `docs/incidents-and-gates.md:62`（I-23）：问题是“找到 3 条相关记忆”，带出前同事。
- Anthropic《Introducing Contextual Retrieval》把过滤单独交给 reranker：“Reranking is a commonly used filtering technique to ensure that only the most relevant chunks are passed to the model”，并指出“Embeddings+BM25 is better than embeddings on their own”，但 BM25 是召回信号、不是校准过的相关度门槛：<https://www.anthropic.com/news/contextual-retrieval>。

**建议**：先明确目标是“减少无关问题带出”还是“提高相关问题 precision”。如果是前者，复合加分不是正确工具。推荐：召回保持宽（RRF 取 top N，包含关键词/实体），过滤用一个小重排模型/交叉编码器对 query-memory 对打分，再按留出集校准门槛；这也是 Anthropic 文章和项目 backlog `BL-20261029-003` 的方向。Google Vertex 的重排服务也标称低延迟：<https://docs.cloud.google.com/vertex-ai/generative-ai/docs/rag-engine/retrieval-and-ranking>。如果暂时不引入重排，至少先修关键词路的停用词/IDF 和实体匹配，而不是给关键词加分。

### 10. 中｜UI/规则里“相关”的定义会变，文档没有同步

**问题**：`docs/ui-ux-design-guide.md` 要求“‘找到 N 条相关记忆’里的‘相关’必须有相似度门槛”。方案改成 `sim + 0.15×关键词 + 0.15×实体` 的复合线，一条相似度 0.3、仅靠关键词/实体加分的记忆也会被 UI 说成“相关”。这会违反现有规则的字面要求，也会让主人无法理解“相关”到底按什么算。

**证据**：
- `docs/ui-ux-design-guide.md:56`：“‘找到 N 条相关记忆’里的‘相关’必须有相似度门槛；没有门槛、凑够 3 条就叫‘相关’，是不良设计（I-23）。”
- 方案公式和“不新增 Gmail 专用键”。

**建议**：要么保持“相关”= 向量相似度 ≥ 场景门槛，复合分只用于“是否补充召回”；要么明确修改 ADR/UI 指南，定义“相关”为复合分，并在界面/文档里说清。不要静默改变这个词的含义。

### 11. 中｜`memory.recall` 的 confirmed/tentative 跨列表去重没有定义

**问题**：recall 是两次检索：先正式记忆，再待确认记忆，且待确认最多占一半。方案说在 `production-memory-recall.ts` 的 render 里共用去重函数，但没定义“正式记忆和待确认记忆互为同源近重复时留哪个”“去重发生在两个列表合并前还是合并后”。如果分别 render 各自去重，跨列表重复不会被去掉；如果合并后去重，可能用待确认记忆挤掉正式记忆，或者把 `shown` 的分类记录弄错。

**证据**：
- `apps/agent-service/src/production-memory-recall.ts:206-246`：`render(tentativeHits, "tentative", tentativeLimit)` 和 `render(hits, "confirmed", input.limit - tentativeMemories.length)` 分开处理，`shown.push(memory.dataClassification)` 在每次 push 时发生。
- 方案：“production-memory-recall.ts 的 render（memory.recall 工具），共用一个纯函数。”

**建议**：明确去重作用在最终合并列表上，优先级“confirmed > tentative”，并且只在确定保留某条后才 `shown.push`；被去重的条数不应占用 tentative/confirmed 配额，应该从后续候选补。加跨列表重复的测试。

### 12. 低｜`similarity` 回填在两个存储引擎上都有实现缺口，方案里的“≤200”也不准确

**问题**：方案说“JS 引擎本来就全量算，sqlite-vec 引擎对 ≤200 个候选读 blob 算”。但 JS 路径现在虽然对所有带匹配模型/维度的行算了 signal，排序后只保留 `.slice(0, limit)` 的向量列表，关键词/实体候选如果不在这个切片里，已经没有现成的 similarity 可用；sqlite-vec 路径的向量列表也只返回前 `limit`。另外 `limit` 在每个路都是最多 200，关键词 + 实体两路合起来可能是 400 个候选，不是“≤200 个候选”。

**证据**：
- `packages/persistence-sqlite/src/sqlite-memory-operations.ts:1121-1151`：JS 引擎算完所有行后 `.slice(0, input.limit)`，被切掉的 signal 不保留。
- `packages/memory-engine/src/hybrid-memory-provider.ts:162`：索引层 `limit = min(200, max(50, input.limit))`，是每路的上限。
- 方案：“JS 引擎本来就全量算，sqlite-vec 引擎对 ≤200 个候选读 blob 算”。

**建议**：在 JS 路径保留 `Map<memoryId, similarity>`（或对所有带 embedding 的行建 map），给 lexical/entity 候选查表；sqlite-vec 路径用一次 SQL join 或批量 blob 读取，并且按“关键词候选 + 实体候选”的实际数量计上限。契约测试要覆盖：两种引擎给同一候选的 similarity 与向量路 signal 一致；非向量路的候选也能拿到 similarity。

### 13. 低｜去重的读放大和比较成本需要上限，`sourceRefs` 数量没有显式上限

**问题**：如果按“每两条 sourceRefs 有交集就读正文比较”实现，最坏是 O(n²) 次比较和最多 n 次正文解密；`DurableMemoryService.search` 的 provider 候选上限是 4×limit（最高 1000），`sourceRefs` 每个元素虽有 512 字符上限，但数组条数没有在存储层看到显式上限。正常聊天/ Gmail 的 limit 很小，问题不大；但如果以后有调用方用大 limit，或导入的记忆 sourceRefs 很大，会放大延迟和内存。

**证据**：
- `packages/application/src/services/durable-memory-service.ts:384`：provider 取 `Math.min(1000, Math.max(limit * 4, limit))`。
- `packages/gateway-contracts/src/contracts-v2.ts:20,1154`：`MEMORY_SOURCE_REF_MAX_LENGTH = 512`，只限单个元素。
- 方案：“两条记忆 sourceRefs 有交集，才读两边正文比较”。

**建议**：先按 `sourceRef` 建 `Map<string, records[]>`，只比较同一组内的记录；正文按 `contentRef` 缓存一次；对比较条数和正文长度设上限；去重放在最终 limit 内时直接复用已经要读的正文。加一个大量同源候选的基准/上限测试。

### 14. 低｜配置模板、ADR 0115/0158 和参数文档没有列全

**问题**：方案列了 strict-configuration 和 docs 参数说明，但没有列 `scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json`（生产配置模板的 `memory` 段）以及 ADR 0115（`memory.minimumSimilarity` 的说明）、ADR 0158（Gmail 0.45 的说明）。新增 `memory.retrieval.*` 后，这些地方会与代码不一致；UI 里“相关”的定义也需要同步（见第 10 条）。

**证据**：
- `scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:123-128`：`memory` 段目前只有 adapter/version/storagePath/dimensions。
- `docs/adr/0115-memory-search-relevance-threshold-and-retrieval-eval.md:42`：只说 `memory.minimumSimilarity`。
- `docs/adr/0158-bring-related-memories-into-gmail-checks.md:35`：Gmail 门槛只按向量一路校准。

**建议**：在改动清单里加上配置模板、ADR 0115/0158、UI 指南、参数文档和新 ADR；新 ADR 编号用 `check:adr-numbers` 核对（当前仓库最新已到 0212，见 `git log` 的 0210→0212 记录）。

---

## 推测/未核实

- **生产里同源近重复的实际比例**：未核实。方案说评测集每条记忆来源唯一，所以去重不影响评测数字；但这恰恰意味着去重对生产的真实影响没有被评测覆盖。需要拿一份脱敏的生产记忆元数据/正文样本统计“同 sourceRefs 且 Dice ≥ 0.9”的规模，尤其是数字/日期只差一点的情况。
- **P3-2 的降级行为**：未核实。仓库当前聊天路径向量失败是整步报错（`production-run-memory.ts:362-368`），Gmail 才退化为关键词（ADR 0158:59）。
- **“问人名”究竟走哪一路**：未核实。实体路是 `memory_entities`，人物表 `memory_people` 没有进检索；方案把它称为“人名命中”，需要先用评测候选数据确认人名查询实际由实体、关键词还是向量命中。
- **评测数字**：未复跑，未核实。方案说 2026-11-11 实跑与 10-29 一致；仓库 `history.jsonl` 只有 10-29 的 0/0.55/0.6 三行，没有 C 的原始 `candidates.json` 可供复核。
- **`sourceRefs` 数组规模**：未核实是否存在很大的导入/整理记录。

---

## 侧重检查

**错误路径**
- 去重读正文失败：确认当前 `search` 不读正文，`readText` 会抛 `MEMORY_PAYLOAD_MISSING`；方案新增读路径必须按条降级（第 3 条）。
- 嵌入失败/缺向量：确认 `hybrid-memory-provider.ts:137-153` 会继续走关键词/实体；方案“sim 未知不截”会让门槛失效（第 4 条）。
- `markUsed`：确认当前在切片后写 `lastUsedAt`；去重若晚于它会把未展示的记忆写成已使用（第 1 条）。
- `memory.recall` 两次检索/两个列表：确认 `production-memory-recall.ts:206-246` 分开渲染，跨列表去重未定义（第 11 条）。

**不合规范或不可信的输入**
- 配置值：确认 `strict-configuration.ts:1287-1298` 当前只校验 `minimumSimilarity`；新增 `retrieval` 需要拒绝未知键、负数、NaN、Infinity、字符串和越界 margin（第 6 条）。
- 记忆正文：`MAXIMUM_MEMORY_CHARACTERS = 500`（`production-memory-capture.ts:63`），但 NFKC/大小写/去标点后仍可能很长；数字差异是模糊去重的高风险输入（第 2 条）。
- `sourceRefs`：单元素 512 字符上限（`gateway-contracts/src/contracts-v2.ts:20,1154`），但没有看到数组条数上限；去重前应分组并设上限（第 13 条）。
- `similarity`：新增可选数值来自存储层，fusion 应校验 `Number.isFinite`，否则 NaN 比较会静默放行。

**安全**
- 去重只应读已经通过 `status`、`allowedClassifications`、`providerRecordId` 校验的记录；方案说“截断后”但没写清是否在分类过滤之后，实施时必须把去重放在分类过滤之后，避免读取/比较 restricted 记忆。
- 没有新增模型出口和嵌入请求（方案明确“不新增嵌入请求”），这点是好的；正文只在进程内解密，不新增日志/网络。
- 去重丢弃的是展示，不是存储；但 `markUsed` 是写操作，必须按第 1 条处理。

**资源耗尽**
- 去重读放大：按 source 分组、缓存正文、限制条数（第 13 条）。
- similarity 回填：sqlite-vec 路径最多 400 个 lexical/entity 候选的 blob 读取，不是 200；应做批量查询/上限（第 12 条）。
- 没有新增嵌入调用，成本可控；但 review 时应确认实现没有为了补 similarity 偷偷再调嵌入。

**不可撤销的操作**
- 去重本身可逆（开关 + 不改存储）；风险在 `markUsed` 的隐式写入（第 1 条）。
- 没有删除/归档/覆盖记忆的操作，符合方案“可逆”的表述。

**规则、说明文档和代码一致性**
- `prompt-prefix.md:27-29,35-36,50-54`：记忆块在最后一条用户消息、按固定顺序；方案排序不变、只在末尾追加，方向一致。
- `ui-ux-design-guide.md:56`：现有“相关”必须有相似度门槛；复合线会改变定义，必须同步文档/UI（第 10 条）。
- `production-shape-config-template.json:123`、ADR 0115/0158：新增配置/参数需要同步（第 14 条）。

---

## 如果由我来定，我会怎样改

1. **不在生产配置里暴露 `keywordWeight`/`entityWeight` 这类可过拟合旋钮。** 如果要做实验，先放在评测脚本的环境变量里；生产只保留一个明确的开关（去重）和经过留出集验证的固定门槛。原因：当前仓库的评测是 24 条记忆/88 句，且调参和验收同集，生产可调权重会放大过拟合和误配置风险。

2. **把召回和过滤拆开。** 召回继续用 RRF 取 top N（向量 + 关键词 + 实体，保留关键词/实体-only 的正确记忆）；过滤不要再把 `sim` 和 BM25/实体计数相加，而是对 top N 做一个小重排（交叉编码器或低延迟 reranker），用留出集校准 rerank 门槛。这正对应 Anthropic《Introducing Contextual Retrieval》的“先宽召回、再重排过滤”，也是项目 backlog `BL-20261029-003` 的方向。若短期不能上重排，就先只修关键词路的停用词/IDF 和实体匹配，并保持“向量相似度”作为唯一硬门槛；关键词/实体只作为“补充召回”，不要直接给低相似度候选加正分。

3. **去重改成显式键，不做读取时模糊去重。** 在整理/写入时给完全重复或确定被取代的记忆记录 `canonicalMemoryId`/`duplicateOf`（或至少存一个规范化正文的稳定摘要），检索时按这个键在**切片前**折叠，保留排序最高且当前有效的记录。这样不需要在 search 里解密正文，也不会有“只差一个数字”的误合并。若 Andy 坚持要运行时模糊去重，至少：规范化后完全相同才折叠；数字/实体串不同绝不折叠；读正文失败保留两条；去重在 `markUsed` 之前；记录 `memory.dedupe_same_source` 指标和测试。

4. **配置与门槛只保留一份来源。** `strict-configuration` 解析后把 `dedupeSameSource` 和（如保留）权重/margin 放进 `ConfiguredMemoryDescriptor`，provider 构造再校验一次；`cutoff` 用本次调用的有效 `minimumSimilarity`（Gmail 0.45），并补 Gmail 集成测试。权重非负有限，margin 有界，`similarity` 有限。

5. **测试补到能反向失败。** 至少加：
   - 去重后仍能补满 limit；被去重掉的 id 的 `lastUsedAt`/`useCount` 不变。
   - 500 字同源、只差一个数字 → 保留 2 条。
   - 一条 payload 缺失 → 其余记忆返回，search 不抛。
   - Gmail 0.45 有效门槛 → fusion 用 0.45 而不是 0.6。
   - 负权重/NaN/Infinity/margin 越界 → 拒绝启动。
   - `similarity` 回填在 sqlite-vec 和 JS 两种引擎一致；lexical/entity-only 候选也能拿到。
   - confirmed/tentative 跨列表去重优先级。
   - 用 `candidates.json` 做确定性截断/去重重算，CI 里断言召回下降不超过阈值；实时评测只作为上线证据。

6. **文档同步。** 新 ADR（编号用 `check:adr-numbers` 核对，当前最新 0212）、ADR 0115/0158、`ui-ux-design-guide.md` 的“相关”定义、生产配置模板和参数说明一起改；不要只改 strict-configuration 白名单。

---

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**

不会，前提是按方案只改“本轮选中的记忆”和 `memory.recall` 的新工具结果，不改历史。
- 自动记忆块在最后一条用户消息里：`packages/runtime-pi/src/pi-runtime-adapter.ts:623-641` 把 `contextBlocks` 渲染进 `<himawari-context>`，再拼 `<owner-message>`；`context-formation-service.ts:403-435` 只把这些块放进本次 context envelope。
- `memory.recall` 的结果是工具结果，按追加方式进入历史，不会改前面已经发出的内容。
- 系统提示、工具定义、历史消息都不变；新配置键也不进提示。
- 规则依据：`.claude/rules/prompt-prefix.md:27-29`（固定的在前，会变的在最后一条用户消息）、`:35-36`（历史只能追加、存实际发出去的那条）、`:50-54`（字节确定、遮盖确定）。Anthropic 的缓存文档也说明缓存是完整前缀：“Prompt caching caches the full prefix”，且 tools/system/messages 变化会失效：<https://platform.claude.com/docs/en/build-with-claude/prompt-caching>。

所以：发给模型的内容仍然只在末尾追加；自动记忆块在最后一条消息里；`recall` 是末尾追加的工具结果，也在缓存前缀之后。**除非**实现时去重/截断改写了已存的历史或重新渲染了旧的 context envelope；方案没有这个必要，也不应该做。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

不会影响缓存前缀；但方案需要把确定性写清楚。
- 去重/截断只决定“这一轮最后一条消息里放不放这条记忆”，不会改写存储的历史；同一段记忆文字在历史里保持原样。
- 排序和 tie-break 是确定的：`fusion.ts:113` 按 `score` 降序、`memoryId.localeCompare` 升序；`durable-memory-service.ts:418-420` 同样按 `score` + `memory.id`。去重的“留前面的”因此是确定的。
- 正文规范化应使用 locale-independent 的 `normalize("NFKC")` + `toLowerCase()`（不是 `toLocaleLowerCase`），标点集合固定，不能依赖对象/Set 遍历顺序；`sourceRefs` 交集只做成员判断，不参与输出顺序。
- 但有一个方案文字不够明确的地方：`keywordWeight × (本句 bm25 / 本句最高 bm25)` 的“本句最高 bm25”如果取自当前候选集合/limit，那么随着索引增长，同一段文字可能在不同请求里被保留或截掉。它只影响最后一条消息，不影响前缀，但会影响可复现性和评测。建议把归一化定义成固定函数（例如按查询的确定最大值，且候选集固定为每路 top N），或直接用不依赖集合的变换。
- 如果去重晚于 `markUsed`，`lastUsedAt` 会变，后续 recency boost 和排序会变；这仍然只影响最后一条消息，但会让同一段文字在不同请求里时有时无，且违背“不改存储”。所以按第 1 条把去重放到 `markUsed` 之前。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

有部分，但不够。
- 方案已有：fusion 单测（关键词 0.40 被截、人名 0.50+0.15 保留、向量 0.61 保留、sim 未知保留、boost 不影响、weights=0 时人名 0.50 被截）；SQLite 契约测试；strict-configuration 未知键/越界；去重 4 条单测；DurableMemoryService 集成用例；评测实跑记 history。
- “weights 置 0 时人名 0.50 被截”这个反向用例在未实现截断时会失败，能证明截断逻辑存在；这是好的。
- 但还缺：`sim` 未知的降级路径、Gmail 0.45 有效门槛、去重后回填 limit、去重不写 `markUsed`、payload 读失败不导致 search 失败、500 字只差一个数字不被去重、confirmed/tentative 跨列表去重、负权重/NaN/margin 越界、similarity 在两种引擎一致、确定性字节输出。现有 `check:memory-relevance.mjs` 的 `[I-23]` 3 条测试也必须继续通过（`apps/agent-service/test/production-model-composition.unit.test.ts` 的 0.55 无关句应仍返回 0）。
- 评测不是自动门槛：`live.mjs:93-108` 只打印对比和追加 `history.jsonl`，没有断言失败。建议把 `candidates.json` 固化成确定性 fixture，在 `npm run check` 里做不花钱的重算断言；实时评测只作为上线证据。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

逐个核对如下：

- **`MemoryIndexCandidate.similarity?: number`**：生产者是 `sqlite-memory-operations.ts` 的 `indexCandidate` 和 `packages/testing/src/in-memory/memory-index.ts`；消费者是 `fusion.ts`。它是应用内部端口字段，没有外部 schema；但所有构造点都要按需补上或允许缺省，fusion 必须校验 `Number.isFinite`。JS 路径的 lexical/entity 候选目前拿不到保留下来的 similarity（`sqlite-memory-operations.ts:1121-1151`），实施时要补 Map，否则非向量候选永远“未知”而绕过门槛。
- **`memory.retrieval.keywordWeight` / `entityWeight` / `cutoffMargin`**：生产者是 `strict-configuration.ts`（当前 `rejectUnknown` 只允许 `adapter/version/storagePath/dimensions/minimumSimilarity`，见 `:1288-1298`）；消费者是 `ConfiguredMemoryDescriptor`（`ports/configuration.ts:72-78`）、`production-memory-composition.ts:92-100` 的 provider 构造、`service-main.ts:1153-1181` 的 DurableMemoryService 构造。两端都要校验：strict-configuration 管类型/范围/未知键，provider 构造再校验一次；`production-shape-config-template.json:123` 和文档也要同步。否则配置里写了键但被 `rejectUnknown` 拒掉，或 provider 收到负值破坏“向量路不变”。
- **`memory.retrieval.dedupeSameSource`**：生产者是 strict-configuration；消费者有两个：`DurableMemoryService.search` 和 `ProductionMemoryRecall`。后者当前没有这个 options 字段（`production-memory-recall.ts:47-61`），`service-main.ts:1239-1270` 构造时需要显式传入；不能只给 DurableMemoryService 加而漏掉 recall。
- **去重用的 `sourceRefs`**：不是新值，但语义被新用途依赖。存储层只校验非空（`sqlite-memory-operations.ts:602-603`），合约限单元素 512 字符（`gateway-contracts/src/contracts-v2.ts:20,1154`），没有看到数组条数上限；去重函数要按 source 分组并设上限，且只在分类/状态过滤之后使用，避免读不该读的正文。
- **Gmail 的有效 `minimumSimilarity`**：生产者是 `strict-configuration.ts:1054-1057` 的 `proactive.memoryMinimumSimilarity`（默认 0.45），消费者是 `production-proactive-memory.ts:41-47` → `DurableMemoryService.search` → `HybridMemoryProvider.search`。fusion 必须用 `input.minimumSimilarity ?? provider 默认`，不能只用 provider 默认 0.6；否则 Gmail 的 0.45 被当成 0.6，召回会掉。
- **评测 history 的可选字段**：消费者是 `scripts/memory-retrieval-eval/live.mjs:84-108`，它只读 `minimumSimilarity/production/metrics`；新增可选字段向后兼容。但 `live.test.ts:108` 只在 `minimumSimilarity === 0` 时记录原始候选，新增参数扫描时要保留这条 0 门槛运行，否则 `candidates.json` 不完整，离线复算不了。
- **新 ADR 编号**：`check:adr-numbers` 会检查文件名、标题编号、链接和路径；按当前仓库最新 0212 往后取，并在 PR 前跑该检查。
- **`similarity` 的序列化**：`candidates.json` 会多出一个字段；这是评测输出，不是合约，消费者只有本仓库脚本，向后兼容。若担心格式，保持可选字段并更新文档即可。

---

**总评**：方案对“保留关键词/实体召回”的认识是对的，但用 `sim + 加权关键词 + 加权实体` 的硬线把两个不同量纲混在一起，既不能解决无关问题带出，又引入了去重误合并和 payload 读失败两条新风险。建议先做重排/显式去重的方案，至少把去重改成“切片前、显式键、读失败保留、markUsed 前”的安全版本，再用留出集验收。
