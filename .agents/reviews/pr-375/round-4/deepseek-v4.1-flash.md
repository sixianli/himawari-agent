## 复核结论

### 读代码证实的问题（按严重度从高到低）

**1.【中】向量模型/维度不一致的记忆会整条绕过新截断，且没有测试覆盖**

- 文件:行：`packages/persistence-sqlite/src/sqlite-memory-operations.ts:1248`、`packages/memory-engine/src/fusion.ts:151`
- 问题：补算相似度的 SQL 要求 `embedding_model = @model AND embedding_dimensions = @dimensions`；换向量模型或维度后，旧记忆补不到相似度，融合层把“相似度未知”直接放行。于是这些记忆又回到“关键词一撞就带出、没有任何门槛”的旧行为，正好是本次要解决的问题。ADR 只写了“没有向量/查询向量失败”两种情况，没有覆盖“有向量但模型或维度对不上”。
- 证据：
  - `sqlite-memory-operations.ts:1248-1250`：`i.memory_id IN (...) AND i.embedding_model = @model AND i.embedding_dimensions = @dimensions AND i.embedding IS NOT NULL`
  - `fusion.ts:152-156`：`const value = similarity.get(memoryId); if (value === undefined) { unknown += 1; admitted.add(memoryId); continue; }`
- 建议：把“模型/维度不一致”与“确实没有向量”区分开（至少写不同的诊断原因），或在模型切换后的重投影完成前不要让这类候选进入关键词/实体结果；补一条“旧模型向量 + 关键词命中”的用例，明确期望。若这是有意的降级，应在 ADR 和案例里写清。

**2.【低】ADR 0221 的自动检查描述漏了“无关问题带出不得增加”**

- 文件:行：`docs/adr/0221-memory-retrieval-relevance-cutoff-and-same-source-dedupe.md:79`
- 问题：ADR 只说“准确率不上升、或召回降超过 2 个点就失败”，但实际测试和案例 88 都有第三条“无关问题带出句数/条数不得增加”。
- 证据：
  - ADR `:79`：`默认参数下准确率不上升、或召回降超过 2 个点就失败`
  - `test/integration/memory-retrieval-eval/fixture.test.ts:97-98`：`expect(after.unrelatedQueriesWithMemory).toBeLessThanOrEqual(before.unrelatedQueriesWithMemory); expect(after.unrelatedMemories).toBeLessThanOrEqual(before.unrelatedMemories);`
- 建议：把 ADR 的自动检查描述补齐为三项，和案例、测试一致。

**3.【低】单次门槛允许 `1`，构造器和配置却拒绝 `1`；测试名称与实际范围也不一致**

- 文件:行：`packages/memory-engine/src/hybrid-memory-provider.ts:62`、`:174`、`packages/memory-engine/test/hybrid-memory-provider.unit.test.ts:266`
- 问题：构造器用 `minimum >= 1` 拒绝 1；单次调用校验用 `minimumSimilarity > 1`，允许 1。配置里 `memory.minimumSimilarity` 是“大于 0、小于 1”。同一个门槛三种口径。
- 证据：
  - `:62`：`if (!Number.isFinite(minimum) || minimum < 0 || minimum >= 1)`
  - `:174`：`if (!Number.isFinite(minimumSimilarity) || minimumSimilarity < 0 || minimumSimilarity > 1)`
  - 测试名：`refuses a per-call floor that is not a finite number from 0 to 1`，但用例只测 `NaN、-0.1、1.1`，没测 1。
- 建议：统一为 `0 <= x < 1` 或统一允许 1，并把测试名和用例对齐。

**4.【低】非法单次门槛在发出嵌入请求之后才校验**

- 文件:行：`packages/memory-engine/src/hybrid-memory-provider.ts:156`、`:173`
- 问题：`minimumSimilarity` 的合法性校验在 `embedder.embed(...)` 之后。传入非法值时仍会调用一次向量模型（或触发 `onVectorFailure`），属于错误的错误路径：本该在出网之前拒绝。
- 证据：`:156-170` 先 `await embedder.embed(...)`，`:173-175` 才校验 `minimumSimilarity`。
- 建议：把门槛校验移到 `search` 开头（至少移到嵌入调用之前）。

**5.【低】`service-main` 到 `ProductionMemoryRecall` 的去重开关没有自动断言**

- 文件:行：`apps/agent-service/src/service-main.ts:1261`、`apps/agent-service/test/service-orchestration.unit.test.ts:828`
- 问题：编排测试只断言了 `dedupeSameSource` 传到 `DurableMemoryService`，没有断言传到 `ProductionMemoryRecall`。如果 1261 行被写死成 `true`，现有测试不会失败。
- 证据：
  - `service-main.ts:1261`：`dedupeSameSource: memoryComposition.dedupeSameSource`
  - `service-orchestration.unit.test.ts:828-830` 只断言 `boundary.durableMemory`。
- 建议：为 `ProductionMemoryRecall` 增加同样的透传断言（mock 构造参数或从工具调用结果反推），否则“不传开关默认打开、传 false 关闭”只在直接单元测试里成立。

**6.【低，非本 PR 引入】交付包里的 qualification 副本调用参数落后于主测试**

- 文件:行：`scripts/delivery-mode/packet-template/acceptance/cloud/probe-source/test/qualification/sandbox-install-restart-model.mjs:320`
- 问题：主测试 `test/qualification/sandbox-install-restart-model.mjs:320-322` 已传 `onVectorFailure` 和 `egress`，交付包里的副本仍只传 `configuration/secretSource/index/fetch`。如果这份副本被实际执行，会得到 `egress: undefined`；`onVectorFailure` 因 provider 侧可选不会立即报错，但出口遮盖/嵌入会缺失。base 提交里已经是这样，不是本 PR 造成；但它是 `createProductionMemoryCompositionFromConfiguration` 的使用点，按“每个使用它的地方都能接受吗”应核对。
- 证据：副本 `:320-331` 无 `egress`/`onVectorFailure`；主测试 `:320-322` 有。
- 建议：确认这份副本是否需要随主测试同步；若只是历史快照，最好在文件或生成脚本里写明不会执行，避免以后误用。

---

### 推测 / 未核实

- **推测（低）**：`nearDuplicateText` 的流式去重只和已保留项比较（`same-source-dedupe.ts:69-84`、`production-memory-recall.ts:278-299`）。如果 A≈B、B≈C 但 A 与 C 的 Dice 低于 0.9，会保留 A 和 C，丢掉 B 后仍留下两条相近记忆；`memory.recall` 增量补位也不会重新检查此前因与已移除的待确认重复而跳过的候选。现有测试没有覆盖这种链式情形。影响有限，但和“同源近重复只留一条”的直觉不完全一致。
- **推测（低）**：数字保护只认 ASCII/Unicode 正负号（`same-source-dedupe.ts:11-12`），不认中文“负”“正”；“负500”和“500”在长文本里仍可能被判为近重复。日期写成 `2026-11-11` 与 `2026/11/11` 会因数字串不同而不合并（这是保守方向，不会误合并，但会降低去重效果）。
- **未核实**：`.agents/reviews/pr-375/round-*` 的复核记录无法读取（工具以 `REVIEW_GIT_REFUSED records-path` 拒绝），所以“按第 1/2/3 轮意见逐条修改”只能对照代码和测试，不能对照 judgments 原文。
- **未核实**：案例 88 的“错带的 7 条”“0.28 到 0.59”“0.03 余量准确率 95.2%/召回 75.5%”“0.35 美元方案讨论费、0.48 美元累计复核费”等，依赖 `sweep-result.txt`、`.agents` 账本或生产记录，仓库里没有可复算的完整数据。可核实的是历史评测行和 fixture 测试。
- **未核实**：“两次独立实跑”只有一条 `history.jsonl` 汇总行；fixture 注明的来源 run（02:36:25）与 history 记录（03:10:43）不同，能支持“跑过两次”，但两次的完整指标和原始候选只保留了一份。

---

## 侧重检查

- **错误路径**
  - `memory.recall` 入参：`argumentsOf` 校验 query、日期、limit、未知键，非法输入抛 `MEMORY_RECALL_INPUT_INVALID`（`production-memory-recall.ts:92-118`）。核对通过。
  - 查询向量失败：provider 捕获并调用 `onVectorFailure`，索引继续关键词/实体；融合层遇到未知相似度放行并记 `onRelevanceUnknown`（`hybrid-memory-provider.ts:156-170`、`fusion.ts:151-164`）。符合“未知不截”的声明。
  - 空候选、最高 bm25 为 0/负：`Math.max(0, ...)` 和 `strongestKeyword > 0 ? ... : 0` 处理正确（`fusion.ts:141-147`）。
  - 只有实体命中：若相似度已知，按“相似度 + 0.15”判线；未知则放行。符合设计。
  - 读正文失败：`dropSameSourceDuplicates` 按不重复处理（`.catch(() => null)`，`same-source-dedupe.ts:63`、`:79`）；`memory.recall` 则跳过读不出正文的记忆（`production-memory-recall.ts:264-265`），ADR 已注明这一差异。
  - 非法门槛：如上第 3、4 条，存在口径不一致和校验时机问题。
- **不合规范 / 不可信输入**
  - 记忆正文会进入 `normalized` / `NUMBER_RUN` / 三字组计算；正则无嵌套量词、逐字符线性，没有明显 ReDoS。
  - 配置 `memory.retrieval` 拒绝未知键、非有限值、越界值、非布尔开关，测试覆盖 `-0.1`、`1`、`NaN`、`Infinity`、字符串、未知键（`startup-configuration.unit.test.ts:165-199`）。核对通过。
  - 补算相似度的 SQL 全部参数化；`memory_search_index.memory_id` 在迁移里是 `UNIQUE`（`0052_memory_engine.sql:20`），所以未加 owner/agent 条件的 `WHERE` 目前不会跨作用域取错行；未来若去掉唯一约束需要补作用域条件。
- **资源耗尽**
  - `candidateSimilarities` 的 `missing` 最多是两路候选各 `limit` 条（索引层 limit 上限 200，实际 50），SQL 参数只有 4 个，JSON id 列表有界。
  - `dropSameSourceDuplicates` 最多对 `limit*4` 个候选、与已保留项做同源比较，正文读取按 contentRef 记忆化；但三字组每次比较都重算，最坏 `O(保留数 × 文本长度)`，量级有界。
  - `memory.recall` 最多各取 `limit*3`（limit≤10），会对候选逐个解密正文，单次上限约 60 次解密；可接受，但模型可重复调用 recall，值得留意。
- **不可撤销操作**
  - 去重在截取名额和 `markUsed` 之前（`durable-memory-service.ts:463-479`），被跳过的记忆不会记“最近使用”，测试覆盖（`durable-memory-projection.test.ts:460-520`）。没有删除/覆盖存储的操作。
- **规则 / 文档 / 代码一致性**
  - 发给模型的内容仍只追加：记忆以 `contextBlocks` 形式进入本轮最后一条消息（`context-formation-service.ts:646-653`、`packages/runtime-pi/src/pi-runtime-adapter.ts:623-644`），系统提示和工具仍取冻结值（`pi-runtime-adapter.ts:1357-1372`）。符合 `prompt-prefix.md`。
  - 案例 88 的 85.4% → 89.1%、召回 77.4%、无关带出 2.1%（1 句）与 `history.jsonl` 新行一致；dataset sha、24 条记忆、88 句问题也一致。
  - ADR 自动检查描述与测试不一致（上文第 2 条）；其余“默认 0.15/0.15/0.05、范围、去重开关、默认打开、整理记忆不截断”与代码一致。

---

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**

不会。改动只改变“本轮选哪些记忆”和 `memory.recall` 本次工具结果的 id/正文，不碰系统提示、工具定义、历史消息或遮盖规则。选中的记忆在 `context-formation-service.ts:646-653` 作为 `contextBlocks` 进入上下文，`pi-runtime-adapter.ts:623-644` 的 `turnPrompt` 把这些块和本轮用户内容一起组成最后一条用户消息；系统提示来自 `projection.systemInstruction`，工具来自冻结定义（`pi-runtime-adapter.ts:1357-1372`）。所以仍然只在末尾追加，每轮会变的记忆仍在最后一条消息里。需要注意：最后一条用户消息的字节本来就会随本轮记忆变化，这是规则允许的。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**

没有引入新的来源。相似度补算、截断、去重、排序都是确定函数；排序有 `score` 和 `memoryId.localeCompare` 兜底，没有新增时间字段、随机值或依赖对象遍历顺序的集合。`memory.relevance_unknown` 只记条数，不记正文。唯一的状态性影响是 `markUsed` 仍会更新 `lastUsedAt`（原有行为），而去重现在会让被跳过的重复项不再更新使用时间；这会使后续检索的排序随状态变化，但不是同一段文字被改写成不同字节，也不是本次新增的遮盖/时间依赖。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

有，且反向用例是有意义的：
- 完成标准：`test/integration/memory-retrieval-eval/fixture.test.ts:91-114` 断言准确率上升、召回降≤2 个点、无关带出不增加；反向用例把关键词/实体加分设为 0，要求召回下降超过 2 个点，删除截断逻辑会失败。
- 去重：`same-source-dedupe.unit.test.ts` 覆盖同源近重复、不同源相同文本、读不出正文、数字/正负号/中文数字差异；`durable-memory-projection.test.ts` 覆盖 `dedupeSameSource` 三态、截断开关和 `markUsed` 范围。
- `memory.recall`：`production-memory-recall.unit.test.ts` 覆盖默认打开、显式关闭、已确认替下待确认、满名额替换、从剩余待确认补位、读不出正文跳过。
- 配置：`startup-configuration.unit.test.ts` 覆盖非法权重/开关/未知键；`hybrid-memory-provider.unit.test.ts` 覆盖非法单次门槛和非法 tuning；`in-memory-memory-index.unit.test.ts` 覆盖维度不同不算相似。
- 缺口：没有“旧模型/旧维度记忆绕过截断”的反向用例；`service-main` 到 `ProductionMemoryRecall` 的开关透传没有断言；链式近似重复没有用例。

**4. 每个产生/使用的值，两端都能接受吗？**

- `memory.retrieval.{keywordWeight,entityWeight,cutoffMargin,dedupeSameSource}`：由 `strict-configuration.ts:119-141` 产生并校验，`production-memory-composition.ts:100-126` 消费；键白名单、范围、布尔校验齐全，`file-summary-configuration.unit.test.ts:168-236` 验证透传。接受。
- `relevanceCutoff`：接口新增于 `memory-projection.ts:209`，只有 `HybridMemoryProvider` 消费（`hybrid-memory-provider.ts:145/195`）；`DurableMemoryService` 和 `memory.recall` 传 `true`，整理记忆直接调 `consolidationProjection.search` 不传。接受。
- `minimumSimilarity`：配置/构造器要求 `0 < x < 1`，单次调用却允许 `x = 1`（上文第 3 条），这是唯一明显的两端不一致。
- `similarity`：SQLite（sqlite-vec 与 JS）和内存索引产生，融合层消费（`fusion.ts:136-140`）；生产者和消费者都按可选字段处理，缺失时回退 signal 或按未知放行。接受，但旧模型/维度缺失会绕过截断（上文第 1 条）。
- `dedupeSameSource`：配置 → `production-memory-composition.ts:126` → `DurableMemoryService`（`service-main.ts:1174`）和 `ProductionMemoryRecall`（`:1261`）；两个服务都用 `!== false` 实现默认打开。接受，但后者缺少编排测试。
- `RecallResult.memoryIds`：`production-memory-recall.ts:302-305/352-356` 只对最终展示的记忆写入，`production-mcp-read.ts:217-274` 读取并记入账本；去重后不会包含被跳过的 id。接受。
- 配置调用点：所有 TypeScript 调用 `createProductionMemoryCompositionFromConfiguration` 的地方都补了必填 `onVectorFailure`（含 `openrouter-embedding-live.test.ts:115`、`file-summary-live-probe.ts:206`）；只有交付包里的 `.mjs` 副本仍缺 `egress`/`onVectorFailure`（上文第 6 条），且不是本 PR 引入。
