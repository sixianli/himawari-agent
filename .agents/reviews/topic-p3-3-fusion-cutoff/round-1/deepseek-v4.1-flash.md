## 一、方案依赖的前提

### 已读代码或来源证实的

1. **记忆检索结果只进入每轮最后一条用户消息，不进入请求开头。**
   依据：`docs/architecture-v0.1.md:454`：“本轮请求时间……和全部材料放在最后一条用户消息的 `<himawari-context>` 标签里，主人的话单独包在其后的 `<owner-message>` 里……”；`.claude/rules/prompt-prefix.md:28`：“每轮都会变的内容只放在最后一条用户消息里。例如当前时间、本轮选中的记忆、本轮资料……”。
   所以本任务只改“本轮选中的记忆”，不改系统提示、工具定义和历史消息。

2. **当前融合是纯 RRF + boost，且只按条数截断。**
   `packages/memory-engine/src/fusion.ts:20-30` 默认 `rrfK=60`；`:83-98` 三路各算 `weight/(k+rank+1)`；`:99-114` 乘 boost 后排序并 `slice(0, limit)`，没有分数线。

3. **只有向量路有相似度门槛。**
   `packages/persistence-sqlite/src/sqlite-memory-operations.ts:1152`：`vector = vector.filter(({ signal }) => signal >= input.minimumSimilarity);`。关键词 `:1154-1168` 和实体 `:1170-1184` 只按 `LIMIT` 截断，没有任何门槛。

4. **关键词路是 OR 查询，常见虚词/单字已过滤，但仍会因一个通用词命中。**
   `sqlite-memory-operations.ts:164-171`：`ftsQuery` 把最多 64 个词用 `"term" OR "term"` 连接；`packages/memory-engine/src/segmentation.ts:118-125` 会过滤停用词和单字汉字，但“生日”“喜欢”“周末”“日语”这类通用词仍会命中。
   这解释了题目里“给苏晴挑个生日礼物”撞上“主人的生日是3月14日”一类泄漏。

5. **`MemoryIndexCandidate` 目前不带 `sourceRefs`，但 `ProductMemoryRecord.sourceRefs` 已有。**
   `packages/application/src/ports/memory-projection.ts:225-236` 只有 `signal` 等字段；`:53-72` 的 `ProductMemoryRecord` 有 `sourceRefs`。
   `sqlite-memory-operations.ts:455-462` 从 `memory_provenance` 按 `source_type, source_id` 排序读出，`:465-475` 放进 `ProductMemoryRecord`。

6. **调用方和候选池。**
   - 聊天：`DurableMemoryService.search` 向 provider 要 `limit*4`，再过滤、排序、截到 `policy.limit`（`packages/application/src/services/durable-memory-service.ts:380-421`）。
   - `memory.recall` 工具：直接调 `provider.search`，要 `limit*3`（`apps/agent-service/src/production-memory-recall.ts:171-195`）。
   - Gmail：`DurableMemoryService.search`，逐次传 `minimumSimilarity`（`apps/agent-service/src/production-proactive-memory.ts:40-54`）。

7. **向量失败时 provider 会继续走关键词/实体。**
   `packages/memory-engine/src/hybrid-memory-provider.ts:139-153`：embed 失败只调用 `onVectorFailure`，`embedding` 仍为 `null`，后续 `index.search` 照常执行。

8. **向量路只返回前 `max(50, limit)`、最多 200 条，且只返回高于门槛的。**
   `hybrid-memory-provider.ts:162`；`sqlite-memory-operations.ts:1117`、`:1150`、`:1152`。

9. **评测基线。**
   `evals/memory-retrieval/history.jsonl` 生产门槛 0.6：`hitRate 0.8`、`recall 0.774`、`precision 0.854`、`unrelatedLeakRate 0.021`。
   题目给出的 7 条泄漏全部只来自关键词路，相似度 0.281–0.586。

10. **配置入口。**
    聊天门槛：`packages/platform-node/src/strict-configuration.ts:1287-1298` 的 `configuration.memory.minimumSimilarity`；Gmail：`:1054-1057` 的 `runPolicy.proactive.memoryMinimumSimilarity` 默认 0.45。
    新增配置必须同时改这里的 `rejectUnknown` 白名单、类型和消费端，否则会像 I-73 一样“清单里的值后端不认”。

### 推测或未核实

- 未实际运行 live 评测；下文 recall 风险是推断，必须在实现前用同一份 `dataset.json` 扫描确认。
- `/mnt/project-files/p3-3-fusion/sweep.mjs` 不在仓库内，我无法读它；只采用题目转述的“单路第 1 名附近有断崖”。
- 生产里 `sourceRefs` 的重复率未测量；去重实际能删多少条、是否会造成结果不足，未核实。
- SQLite `vec_distance_cosine` 对 `embedding IS NULL` 的相关子查询写法未实测。

---

## 二、方案

### 2.1 核心判断：不能对原始 RRF 分数划线

原始 RRF 只保留名次，丢掉原始分数。一个“单路第 1 名”的关键词命中和一个“单路第 1 名”的向量命中分数几乎一样（都是 `1/(60+1)`），所以任何在 RRF 分数上的绝对线都无法同时做到：

- 挡住关键词撞上的无关记忆；
- 不伤排在第 2、第 3 名的向量命中。

题目里的扫描也已经显示：线放在单路第 1 名附近，召回从 77.4% 掉到 47%–55%。因此，**截断分数必须引入可比的原始相关度，RRF 只负责排序和“没有向量分数时”的兜底**。

业界也是这个方向：Elastic 的 RRF 分数本身不适合直接当相似度阈值，官方建议在 RRF 混合里只对语义子查询设 `min_score`；Weaviate 的 `relativeScoreFusion` 保留并归一化原始分数；mem0 v3 的源码明确写着“阈值在合并前先过语义分数，低于阈值的候选即使 BM25/实体能加分也排除”。

### 2.2 推荐的融合分数

给每个候选补一个字段：

```
vectorSimilarity: number | null
```

含义：这条记忆对当前查询的真实余弦相似度，不管它是被哪一路找到的。
- 向量路候选：就是 `signal`。
- 关键词/实体路候选：用 `memory_search_index.embedding` 和查询向量现算；有 `sqlite-vec` 时在 SQL 里算，JavaScript 向量引擎时在 TS 里算。
- 没有 embedding（不可嵌入的分级、或索引时嵌入失败）：`null`。

定义：

```
s* = 场景向量门槛
    聊天 = memory.minimumSimilarity（qwen3-embedding-8b 默认 0.6）
    Gmail = proactive.memoryMinimumSimilarity（默认 0.45）

v_i = 候选 i 的 vectorSimilarity
r_i = 现有 RRF 分数 Σ_s w_s / (k + rank_{i,s} + 1)
u_i = min(1, r_i / ((w_lexical + w_entity) / (k + 1)))    // 没有向量时的归一化兜底
b_i = 现有 boost

relevance_i =
    v_i                  , 如果 v_i != null
    u_i                  , 如果 v_i == null

rankScore_i = b_i * relevance_i
```

**截断规则：**

```
如果 v_i != null：relevance_i >= fusionMinimumScore
如果 v_i == null：relevance_i >= noVectorMinimumScore
```

**排序规则：**

```
rankScore_i 降序，再按 relevance_i 降序，再按 r_i 降序，最后按 memoryId 的字节序升序
```

关键点：

- **截断看的是未乘 boost 的 `relevance`，排序才乘 boost。**
  否则一条重要度低但很相关的旧记忆，会因为 `boost < 1` 被分数线误杀；这会把“新近/重要”变成隐性的相关度门槛。
- **有向量分数时，关键词/实体只做排序信号，不能把低于向量线的候选“救”上来。**
  这正是挡住 7 条泄漏的关键：它们的 `v` 都低于 0.6，关键词路再强也不能越过 `fusionMinimumScore`。
- **没有向量分数时，关键词/实体是唯一召回源，用独立的兜底线。**
  不能把 `relevance` 当成 0，否则 P3-2 的“向量失败继续回答”会变成永远不返回记忆。

### 2.3 默认参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `memory.minimumFusionScore` | 等于 `memory.minimumSimilarity`（qwen3 聊天 0.6） | 截断分数线，按余弦相似度解释 |
| `proactive.memoryMinimumFusionScore` | 等于 `proactive.memoryMinimumSimilarity`（0.45） | Gmail 单独覆盖，不能沿用 0.6 |
| `memory.minimumNoVectorScore` | `0.5` | 没有向量时的归一化 RRF 兜底线；单路第 1 名约 0.5，双路第 1 名约 1.0 |
| `memory.dedupeSameSource` | `true` | 同源近重复去重开关 |
| `memory.dedupeSimilarity` | `0.9` | 同源内容“几乎相同”的 Dice 阈值 |

对 Gmail：**用 0.45，不要用 0.6。**
依据是 ADR 0158：0.6 在 Gmail 合成集上只命中 20%，0.45 命中 71%。新截断只负责挡“低于 0.45 的关键词撞车”，不应把 Gmail 的语义召回重新收紧到聊天水平。

### 2.4 三种缺失情况

| 情况 | 做法 |
| --- | --- |
| 向量服务失败，整次查询没有 embedding | 所有候选 `v=null`，用 `u_i` 和 `minimumNoVectorScore=0.5`。只保留关键词/实体结果的头部队列；写一行 `memory.fusion.no_vector` 诊断日志（不含原文）。这样 P3-2 仍能回答，但精度会比有向量时低，文档要写明。 |
| 某条记忆没有向量（不可嵌入的分级、索引时嵌入失败） | 该候选 `v=null`，同样用 `u_i` 和 `minimumNoVectorScore`。它不会被当成“相似度 0”直接删掉；通过兜底线后参与排序。若担心它被大量向量结果挤掉，可另加“无向量配额”（见待拍板）。 |
| 关键词/实体候选不在向量前 `limit` 名里 | 现在为它单独算 `vectorSimilarity`。算出来低于 `fusionMinimumScore` 就删；高于则保留（即使向量路因 top-limit 截断没返回它）。这样不需要扩大向量 `limit`，也不会把“没进向量前 50 名”误当成“没有向量分数”。 |

### 2.5 同源去重

**判定：**

两个候选 `a`、`b` 只有在同时满足下面两条时才算重复：

1. `sourceRefs` 有交集；
2. 内容几乎相同。

内容相似度用 **字符 3-gram Dice 系数**：

```
normalize(text) = NFKC → 小写 → 去掉空白和标点/符号
dice3(a,b) = 2 * |trigram(a) ∩ trigram(b)| / (|trigram(a)| + |trigram(b)|)
```

默认 `dice3 >= 0.9` 才算“几乎相同”。
短文本（规范化后少于 8 个字符）不启用 n-gram，直接要求规范化后完全相等，避免 3-gram 在极短句上误判。

为什么用字符 3-gram：
- 中文没有空格分词，字符 n-gram 对中文、日文、英文都适用；
- 对 punctuation、全半角、大小写不敏感；
- 完全确定性，不增加模型调用，不依赖前后文；
- 能把“主人住在东京”和“主人住在东京都北区”判为不同（Dice 明显低于 0.9），符合“同一句话拆出的不同事实都保留”。

**在哪一层做：应用层，不在索引层。**

- 聊天和 Gmail 走 `DurableMemoryService.search`：它已经用 `readMany` 拿到了每条 `ProductMemoryRecord`，`sourceRefs` 就在手上；只有发现 `sourceRefs` 有交集的分组才去 `content.readText(contentRef)` 读原文。绝大多数候选 `sourceRefs` 不重叠，额外全文读取接近 0。
- `memory.recall` 工具：它本来就要读每条候选的文本用于渲染，去重可以复用已经读到的文本。
- 不在 SQLite 索引里存文本或 SimHash：避免迁移、避免把明文复制进索引、也避免短文本 SimHash 的误判。

**保留哪条：**

按 `rankScore` 从高到低扫描；遇到与已保留项同源且 `dice3 >= dedupeSimilarity` 的候选就跳过。分数相同则保留 `updatedAt` 更新的一条，再相同按 `memoryId` 字节序。
**不合并文本、不改写内容**；只是不把第二条送给模型。

**时机：**

先按截断线过滤，再去重，最后 `slice(0, policy.limit)`。
因为调用方本来就多要了 3–4 倍候选，去重后通常仍能填满；若某个池子里重复极多导致不足 N 条，宁可少返回，不回头放宽分数线。

**开关关闭时：**

`dedupeSameSource=false` 时完全跳过 `sourceRefs` 分组和文本读取，行为与今天一致。

### 2.6 要改的文件

**核心检索：**

- `packages/application/src/ports/memory-projection.ts`
  - `MemoryIndexCandidate` 增加 `vectorSimilarity: number | null`。
  - `MemoryProviderProjectionPort.search` 和 `MemoryIndexStorePort.search` 增加可选的 `minimumFusionScore` / `minimumNoVectorScore`（或统一放在 fusion options）。
- `packages/persistence-sqlite/src/sqlite-memory-operations.ts`
  - `indexCandidate` 映射 `vectorSimilarity`。
  - 向量查询把 `signal` 同时作为 `vectorSimilarity`。
  - 关键词/实体查询为每条候选计算 `vectorSimilarity`（sqlite-vec 用 `1 - vec_distance_cosine`；JS 引擎读 embedding 后算余弦）。
  - 保留现有 `signal >= minimumSimilarity` 的向量路过滤（主人要求保留向量门槛），但融合截断是第二道、全局的线。
- `packages/memory-engine/src/fusion.ts`
  - 增加 `minimumFusionScore`、`minimumNoVectorScore`。
  - 计算 `relevance`、`rankScore`，先截断再排序再 `slice`。
  - 排序用确定性比较，不用依赖 locale 的 `localeCompare`。
- `packages/memory-engine/src/hybrid-memory-provider.ts`
  - 从 options/input 传两个分数线；把 `vectorSimilarity` 从 index 结果带进 fusion。
- `packages/testing/src/in-memory/memory-index.ts`
  - 测试用内存索引同步产生 `vectorSimilarity`（I-73 的双端核对点）。

**去重：**

- 新增 `packages/application/src/services/memory-dedupe.ts`：纯函数 `selectSameSourceUnique(items, { similarity, readText })`，包含规范化、3-gram Dice、源交集判断。
- `packages/application/src/services/durable-memory-service.ts`
  - `DurableMemoryServiceOptions` 增加 `dedupeSameSource`、`dedupeSimilarity`。
  - `search` 在状态/分级过滤后调用去重，再截 `policy.limit`。
- `apps/agent-service/src/production-memory-recall.ts`
  - 在 `render` 中复用同一去重函数；confirmed 和 tentative 各自去重，不跨状态合并。

**配置与组装：**

- `packages/application/src/ports/configuration.ts`
  - `ConfiguredMemoryDescriptor` 增加 `minimumFusionScore?`、`minimumNoVectorScore?`、`dedupeSameSource?`、`dedupeSimilarity?`。
  - `ProactiveConfiguration` 增加 `memoryMinimumFusionScore?`、`memoryMinimumNoVectorScore?`。
- `packages/platform-node/src/strict-configuration.ts`
  - `configuration.memory` 的 `rejectUnknown` 白名单、类型校验、默认值。
  - `parseProactive` 的 `rejectUnknown` 白名单、默认值。
  - 校验：分数线 `0..1`（0 表示关闭截断）；`dedupeSimilarity` `0..1`；布尔严格。
- `apps/agent-service/src/production-memory-composition.ts`
  - 聊天 provider 的 fusion 分数线默认继承 `minimumSimilarity`。
- `apps/agent-service/src/service-main.ts`
  - Gmail 调 `DurableMemoryService.search` 时传 `minimumFusionScore: proactive.memoryMinimumFusionScore`。
  - 创建 `DurableMemoryService` 时传去重配置。

**文档：**

- 新增 ADR，例如 `docs/adr/0213-fusion-score-cutoff-and-same-source-dedupe.md`，记录公式、默认值、Gmail 取值、评测结果。
- 更新 `docs/adr/0115-memory-search-relevance-threshold-and-retrieval-eval.md` 的“后续”或新增一节。
- 更新 `docs/agent-rulebook-inventory.md` C-8 的 Gmail 参数表。
- 配置说明里写清：`minimumFusionScore` 降低会重新放行低于向量线的关键词撞车，不建议低于场景向量门槛。

### 2.7 测试和评测

**不花模型费用的自动检查（放进 `npm run check` 或现有 `check:memory-relevance`）：**

1. `packages/memory-engine/test/fusion.unit.test.ts`
   - 关键词单路第 1 名、`vectorSimilarity=0.40`、`minimumFusionScore=0.6` → 结果为空。
   - 同一候选把分数线改成 0 → 结果出现；证明反向用例失败。
   - 向量单路第 20 名、`vectorSimilarity=0.61` → 保留；证明不是按 RRF 名次划线。
   - 低重要度但 `vectorSimilarity=0.60` 的向量命中 → 保留；证明截断没乘 boost（如果把 boost 乘进截断，这条失败）。
   - 关键词候选 `vectorSimilarity=null`、双路第 1 名 → 用 `minimumNoVectorScore` 保留；单路第 2 名 → 删除。
   - 关键词候选不在向量前 limit 名、但有 `vectorSimilarity=0.6` → 保留；如果实现漏算 `vectorSimilarity`，它会走兜底并被误留/误删，这条失败。

2. `packages/application/test/memory-dedupe.unit.test.ts`
   - 同源 + 文本只差标点/空白 → 只留一条。
   - 同源 + “主人住在东京”/“主人住在东京都北区” → 两条都留。
   - 不同源 + 文本完全相同 → 两条都留。
   - 同源 + 一条文本读取失败 → 两条都留（不因读取失败丢记忆）。
   - 关闭开关 → 不去重；反向去掉 `sourceRefs` 交集判断 → “不同源相同文本”用例失败。

3. `packages/memory-engine/test/hybrid-memory-provider.unit.test.ts`
   - embed 抛错时 `v=null`，仍能返回关键词/实体头部；`onVectorFailure` 被调用。
   - 没有 embedding 的记忆不会被当成相似度 0 直接丢弃。

4. `apps/agent-service/test/production-model-composition.unit.test.ts`
   - 聊天默认 `minimumFusionScore=0.6`；配置 `memory.minimumSimilarity=0.7` 时 fusion 默认跟随 0.7。
   - Gmail 默认 `memoryMinimumFusionScore=0.45`；不传时不会误用 0.6。

**评测脚本：**

- 扩展 `test/integration/memory-retrieval-eval/live.test.ts`：
  - 现在只按 `minimumSimilarity` 跑；增加按 `fusionMinimumScore` 和 `dedupe` 跑。
  - 记录 `fusionMinimumScore`、`dedupeSameSource`、`vectorAvailable` 到 `round.json` 和 `history.jsonl`。
- 扩展 `scripts/memory-retrieval-eval/live.mjs`：
  - 增加 `--fusion-scores=0.45,0.5,0.55,0.6`、`--dedupe=on|off`。
  - 输出与上一次生产基线的 precision/recall/leak 对比。
- 用 `candidates.json` 做离线扫描，不重复调用嵌入服务：
  - 对每个分数线计算 recall@5、precision、unrelated leak。
  - 要求生产配置：**precision 高于 85.4%，recall@5 不低于 75.4%**（77.4% - 2pp）。
  - 至少扫 `0.50/0.55/0.58/0.60/0.62`，看曲线是否在 0.6 附近有可用平台，而不是只挑一个点。
- 去重对评测集不会触发，因为 `dataset.json` 每条记忆的 `sourceRefs` 是唯一的 `message-<id>`；去重必须靠单独的 fixture 测试，不要假装评测集覆盖了它。

---

## 三、考虑过但不选的做法

| 做法 | 不选原因 |
| --- | --- |
| 直接在现有 `rrf * boost` 上划线 | RRF 只有名次信息，关键词单路第 1 名和向量单路第 1 名不可区分；题目扫描已显示在单路第 1 名附近划线会把 recall 打到 47%–55%。 |
| 给关键词路加 `bm25` 绝对阈值 | `bm25` 的尺度随查询长度、词频变化，和余弦不可比；等于新增一个单路门槛。 |
| 把 FTS 的 OR 改成 AND / `minimum_should_match` | “给苏晴挑个生日礼物”这类查询会直接丢掉“苏晴”相关记忆；而且改的是召回集合，不是融合截断。 |
| 用 LLM/reranker 做二阶段判断 | 每轮多一次模型调用，增加延迟和费用；本任务明确预计不新增请求。 |
| 每查询 min-max 归一化后加权求和 | 候选集很小（最多 200 条），最高分永远归一成 1，分数线会随查询漂移；Elastic 也提醒 min-max 对关键词不总是合适。 |
| 在 SQLite 索引里存 SimHash/文本指纹做去重 | 需要迁移和回填；短文本 SimHash 容易误判；明文指纹进索引还要考虑分级和删除。应用层已有 `sourceRefs` 和按需读文本，代价更低。 |
| 在写入记忆时按来源合并 | 同一来源可能在后续对话里增加新事实；写入时合并会破坏“同一句话拆出的不同事实都保留”。 |
| 用 Elastic `collapse` 的思路在 SQL 里按单字段折叠 | `sourceRefs` 是多值集合，Elastic 的 `collapse` 要求单值 keyword 字段；直接照搬会错误合并不同来源。 |
| 把 boost 乘进去再截断 | 低重要度、低置信度但语义相关的旧记忆会被误杀；boost 应只影响排序。 |
| 全局把向量门槛降到 0.45 | 会重新放行题目里 0.45–0.586 的泄漏；Gmail 的 0.45 是邮件场景单独评测出来的，不能搬到聊天。 |

---

## 四、风险和反例

1. **最大的风险：recall 可能下降超过 2pp。**
   新公式相当于把向量门槛也应用到“本来只靠关键词/实体捞出来的、但有 embedding 的记忆”。如果评测集里确实有一批 `v<0.6` 但关键词命中的相关记忆，它们会被删掉。
   **必须先用现有 `candidates.json` 离线扫描确认。** 如果超过 2pp，两个备选：
   - 只对“关键词覆盖率 ≥ 0.75 且 `v >= s* - 0.03`”的候选开一个小口；
   - 或把 `minimumFusionScore` 降到 `s* - 0.02`，但这会重新放行 0.586 那条日语泄漏，需要同时加覆盖率条件。
   我不建议直接降分数线而不加覆盖率，因为题目里最接近线的那条错误是 0.586。

2. **0.586 那条是边界反例。**
   它低于 0.6 只有 0.014。新方案能挡住它，但余量很小。换 embedding 模型后必须重新标定 `minimumSimilarity` 和 `minimumFusionScore`；不能把 0.6 写死给别的模型。

3. **没有向量时的兜底会漏出关键词垃圾。**
   向量服务失败或整条记忆没有 embedding 时，只有 RRF 名次可用，单路第 1 名约 0.5，默认 `minimumNoVectorScore=0.5` 会放行它。这是“P3-2 继续回答”与“精度”的取舍，文档要写明，并用日志观察发生率。

4. **不可嵌入的记忆可能被向量结果挤掉。**
   它们的 `relevance` 最高是 1.0（双路第 1 名）、单路第 1 名只有 0.5；在 limit=5 且向量结果很多时可能进不了最终列表。是否需要给它们保留配额，是待拍板事项。

5. **去重的误判/漏判。**
   - 3-gram Dice 0.9 对“只改一个数字/日期”的文本可能仍判为重复，例如“生日是3月14日”和“生日是3月15日”。如果来源相同，这可能是两条需要保留的不同事实。
     缓解：默认阈值 0.9；对含数字/日期的文本可以要求更高（例如 0.95）或把数字 token 加入“必须相等”的检查。是否要做，待拍板。
   - 同源但内容改写较大（同义句）会漏去重，保留两条。按“几乎相同”定义，这是可接受的漏判，比误删安全。

6. **去重导致返回条数不足。**
   调用方多要 3–4 倍候选，通常够；但如果某个查询的候选大量同源，可能不足 N 条。方案选择“宁可少返回”，不回头放宽分数线。

7. **确定性和前缀。**
   新分数依赖 `now`（recency）和 `lastUsedAt`，但这些只影响本轮最后一条消息里的记忆选择，不改变已发历史。去重只看当前候选集合，可能因查询不同而保留不同的一条，但不会改写任何已发出的文本。
   为了避免同一输入在不同机器上因 locale 排序不同，新增排序用字节序比较，不用 `localeCompare`；`sourceRefs` 来自数据库已按 `source_type, source_id` 排序，去重分组前再排序一次。

8. **未核实：** `MemoryProviderHit.score` 从 RRF 量级（约 0.02）变成余弦量级（0–1），我 grep 到的消费方只有排序，没有绝对阈值；但 trace/decision ledger 是否对 score 范围有隐含假设，未逐表核实。

---

## 五、需要人拍板的取舍

1. **截断分数线默认是否等于场景向量门槛。**
   我建议等于（聊天 0.6，Gmail 0.45），这是唯一能挡住 0.586 又不误杀 0.61 向量命中的简单做法。代价是可能损失 `v<0.6` 的关键词召回。要不要接受，需要看离线扫描的 recall。

2. **没有向量时的兜底线 0.5 是否合适。**
   0.5 会放行单路第 1 名；如果更看重精度，可以调到 0.75（只放行双路命中），但 P3-2 的可用性会下降。

3. **不可嵌入记忆是否保留配额。**
   例如每次最多保留 1 条 `v=null` 但关键词/实体头部命中的记忆。好处是记忆可靠，坏处是可能带回一条弱相关。

4. **去重相似度用 0.9 还是 0.95；数字/日期是否必须完全相等。**
   0.9 更积极去重，可能误删“3月14日/3月15日”这种同源不同事实；0.95 更保守。

5. **去重放在应用层还是索引层。**
   我推荐应用层，无迁移、无明文复制；如果以后候选池很大，再考虑索引层指纹。

6. **`memory.recall` 工具是否跨 confirmed/tentative 去重。**
   我建议各自去重，不跨状态合并；否则一条待确认记忆可能被已确认记忆吞掉。

---

## 六、业界做法（每条附一手链接）

| 来源 | 做法与原话 | 对本方案的启示 |
| --- | --- | --- |
| Elastic RRF | “RRF requires no tuning… score += 1.0 / (k + rank(result(q), d))”；[RRF 文档](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion) | RRF 分数是名次和，不适合当绝对相似度阈值。 |
| Elastic `min_score` | “When using `min_score` with compound retrievers (such as `rrf` or `linear`), documents are filtered after the compound scoring has been applied.”；[Retriever 文档](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers) | 融合后过滤是可行的，但要知道分数线落在什么尺度上；RRF 上划线没有语义。 |
| Elastic 语义阈值实践 | “RRF gets around the challenge of comparing scores… In this scenario, the `min_score` is only applied to the semantic retriever.”；[Elastic Labs](https://www.elastic.co/search-labs/blog/semantic-precision-minimum-score) | 和我们一致：把绝对分数线放在可比的语义分数上，不要放在 RRF 总分上。 |
| Weaviate | `relativeScoreFusion` “each object is scored by normalizing the metrics output by the vector search and keyword search… highest value becomes 1, lowest 0”；`rankedFusion` 只保留位置；[Hybrid search 概念](https://docs.weaviate.io/weaviate/concepts/search/hybrid-search) | 保留原始分数分布比只保留名次更能做截断；默认 `relativeScoreFusion`。 |
| Azure AI Search | “RRF score… Upper limit is bounded by the number of queries being fused, with each query contributing a maximum of approximately `1/k`”；[Hybrid search scoring](https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking) | RRF 分数的上限随融合路数变化，不能当跨查询的绝对阈值。 |
| Pinecone | “Because sparse (BM25-style) scores are unbounded, you set the balance between the two signals client-side, by scaling the query vectors… `combined = alpha * dense + (1 - alpha) * sparse`”；[Hybrid search](https://docs.pinecone.io/guides/search/hybrid-search/single-index)；“Because only rank position matters, scores never need to be normalized”；[RRF](https://docs.pinecone.io/guides/search/reciprocal-rank-fusion) | BM25 和余弦尺度不同；要么归一化，要么只用名次。我们选择用余弦作锚点，RRF 做排序/兜底。 |
| Vespa | `rank-score-drop-limit`: “Drop all hits with a first-phase rank score less than or equal to this floating-point number. Use this to implement a rank cutoff.”；[Schema reference](https://docs.vespa.ai/en/reference/schemas/schemas.html) | 按统一 rank score 截断是成熟做法；关键是 rank score 必须可解释、可跨查询比较。 |
| mem0 v3 | “V3 uses multi-signal retrieval: semantic, BM25 keyword, and entity matching scored in parallel and fused. The returned `score` is a combined `[0, 1]` value.”；[Search Memories](https://docs.mem0.ai/api-reference/memory/search-memories)。源码注释：“Threshold gates the semantic score BEFORE combining -- candidates below the threshold are excluded even if BM25/entity would boost them.”；“BM25 is a boost signal, not a recall expander.”；[scoring.ts](https://github.com/mem0ai/mem0/blob/2274b5ac/mem0-ts/src/oss/src/utils/scoring.ts) | 这正是本方案的核心先例：三路融合，但语义分数先过门槛，关键词/实体只加分不“捞回”低于语义线的候选。 |
| Letta | “Archival memory is a semantically searchable database… Semantic search - Find information by meaning, not exact keywords.”；[Archival memory](https://docs.letta.com/v1-sdk/memory/archival-memory/index.md) | Letta 主要是向量检索，没有可对照的三路融合截断/同源去重；不适合作为本任务的主要参照。 |
| Elastic collapse（去重） | “collapsing is done by selecting only the top sorted document per collapse key.”；[Collapse search results](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/collapse-search-results) | “每个 key 保留最高分一条”是成熟做法；但 `sourceRefs` 是多值集合，不能直接用单值 `collapse`，所以我们在应用层做集合交集 + 文本相似度。 |

---

## 七、逐条回答必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。**
发给模型的内容仍然只在末尾追加；本轮检索到的记忆只出现在最后一条用户消息的资料块里。依据：`docs/architecture-v0.1.md:454` 和 `.claude/rules/prompt-prefix.md:28`。
系统提示、工具定义、历史消息、遮盖结果都不因本改动变化。每轮会变的值（本轮选中的记忆、分数排序、去重结果）都在最后一条消息里。
需要额外保证：排序必须确定（不能用 `localeCompare` 或无序 Set 迭代），否则同一轮内不同调用可能生成不同顺序；这属于规则第 10 条“字节必须确定”（`.claude/rules/prompt-prefix.md:51`）。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会改变记忆文本本身的字节。**
本方案只决定“哪几条记忆进入本轮资料”，不修改记忆文本、不合并文本、不改写历史。
可能变的是“这一轮选哪几条”，它依赖查询、`now`、`lastUsedAt` 和候选集合；这些只影响最后一条消息，不影响已发前缀。
需要避免的非确定性来源：
- `sourceRefs` 分组用排序后的数组，不用 Set 直接迭代输出；
- 排序用 `memoryId` 字节序，不用 locale 相关比较；
- 文本规范化只用 NFKC/小写/去标点，不依赖前后文；
- 去重阈值是固定数字，不依赖时间或随机数。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有，且应按“先红后绿”提交：

- 分数线单测：关键词单路第 1 名 + `v=0.40` 必须被删；把分数线设 0 后必须出现——证明反向用例会失败。
- 向量保 recall 单测：向量第 20 名 + `v=0.61` 必须保留；如果实现改成按 RRF 名次划线，这条失败。
- boost 单测：`v=0.60` 但 `importance=0` 必须保留；如果把 boost 乘进截断，这条失败。
- 缺失向量单测：无 embedding 的关键词/实体头部候选必须能通过兜底线；如果 `v=null` 被当成 0，这条失败。
- 去重单测：同源近重复只留一条；同源不同事实保留两条；不同源相同文本保留两条；关开关后保留两条。去掉 `sourceRefs` 交集判断时“不同源相同文本”失败；去掉相似度判断时“同源不同事实”失败。
- 生产组装测试：聊天默认 0.6、Gmail 默认 0.45；如果 Gmail 误用聊天 0.6，Gmail 测试失败。
- 真实评测：`npm run eval:memory-retrieval` 记录 precision/recall；要求 precision 上升、recall@5 不低于基线 2pp。这个不进 `npm run check`（要真实嵌入费用），但必须作为合并前的证据写进 ADR/history。

### 4. 改哪些文件、怎么测、评测脚本要不要改？

改的文件见 2.6。核心是：`memory-projection.ts`、`sqlite-memory-operations.ts`、`fusion.ts`、`hybrid-memory-provider.ts`、`durable-memory-service.ts`、`production-memory-recall.ts`、配置解析与生产组装、测试用的内存索引。

评测脚本**要改**：
- `test/integration/memory-retrieval-eval/live.test.ts`：除 `minimumSimilarity` 外，增加 `minimumFusionScore`、`minimumNoVectorScore`、`dedupe` 维度，并把结果写进 `round.json`/`history.jsonl`。
- `scripts/memory-retrieval-eval/live.mjs`：增加 `--fusion-scores`、`--dedupe` 参数，输出与上一次生产基线的对比。
- 离线 `candidates.json` 扫描：先不花嵌入费用，扫 0.50/0.55/0.58/0.60/0.62，确认 0.6 附近有没有满足“precision 升、recall 降 ≤2pp”的平台。

### 5. 业界怎么处理混合检索截断和去重？

见第六节。一句话总结：

- **RRF 适合排序，不适合直接当绝对阈值**：Elastic、Azure、Pinecone 都说明 RRF 分数尺度随融合路数/查询变化。
- **分数截断要放在可比的原始相关度上**：Elastic 建议对语义子查询设 `min_score`；Weaviate 默认用归一化原始分数的 `relativeScoreFusion`；Vespa 用统一的 rank score + `rank-score-drop-limit`。
- **mem0 v3 最接近本任务**：三路融合，但语义分数先过门槛，BM25/实体只加分，不把低于语义线的候选捞回来。
- **去重用“每个 key 保留最高分一条”是成熟模式**（Elastic collapse），但 `sourceRefs` 是多值集合，需要应用层做交集 + 文本近重复判断；这也是本方案选择应用层而不用 SQLite SimHash/迁移的原因。
