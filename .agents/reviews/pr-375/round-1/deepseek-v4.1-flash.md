## 侧重检查（错误路径 / 不可信输入 / 安全 / 资源 / 不可撤销操作 / 文档一致性）

- **相似度未知、空候选、最高 bm25 为 0 或负值、仅实体命中**：`fusion.ts:141-147` 用 `Math.max(0, …)` 取本句最高关键词分，最高为 0 时关键词加分为 0；`fusion.ts:151-157` 对没有 `similarity` 的候选直接放行并计数。SQLite 的关键词分是 `-bm25(...)`（`sqlite-memory-operations.ts:1186`），正常为正值，负值/0 不会崩溃，只是没有关键词加分。空候选得到空结果，无异常。
- **去重回填与 markUsed**：`durable-memory-service.ts:462-481` 在 `markUsed` 之前去重，只标记最终 `selected`，集成测试也检查了 `lastUsedAt`。`production-memory-recall.ts` 没有 markUsed，但存在下面第 1 条的槽位/顺序问题。
- **补算相似度的 SQL**：`sqlite-memory-operations.ts:1243-1278` 用 `json_each(@ids)` 传 id，并限定 `embedding_model`、`embedding_dimensions`、`embedding IS NOT NULL`；sqlite-vec 与 JS 两条路都把非有限值过滤掉。未发现注入问题；缺向量/维度不一致会落到“未知相似度”而放行。没有新增嵌入请求。
- **配置非法值**：`strict-configuration.ts:121-141` 拒绝未知键、非布尔和不在 `[0,1)` 的数值；`relevance.ts:13-16` 与 `hybrid-memory-provider.ts:61-65` 再校验一次，范围一致。
- **不可信输入 / 资源耗尽**：`same-source-dedupe.ts` 的规范化、三字组计算是线性的，但去重两两比较在候选很多且同源时是 O(N²)，没有限制同源候选数量或正文长度。正常聊天/Gmail 限额很小，风险低，但属于可被大量同源大文本放大的 CPU/内存开销。
- **不可撤销操作**：去重只读正文，不写库；只有最终保留的记忆会 `markUsed`。
- **规则 / 文档一致性**：`prompt-prefix.md` 第 2 条要求“本轮选中的记忆只放最后一条用户消息”，本改动没有改变注入位置或格式。ADR 0115、0158、界面设计指南已同步。发现 ADR 0221 声称评测写入 `history.jsonl`，但该文件没有本次结果（见第 2 条）。

## 读代码证实的问题

### 1. 中：`memory.recall` 的“已确认优先”在名额已满时不成立，且替换会打乱已确认记忆的分数顺序

**文件:行**：`apps/agent-service/src/production-memory-recall.ts:234-235, 249-250, 273`

**问题**：
- 循环一开始就 `if (room() <= 0) break;`，之后才检查重复。若名额已被其他已确认记忆占满，后面的已确认重复项不会有机会替换掉待确认项。
- 替换是对待确认项在 `kept` 中的旧位置做 `splice`，因此已确认记忆会被插到待确认项原来的位置，输出时 `kept.filter(...)` 不再保持 provider 返回的分数顺序。

**证据**：
```ts
234:      for (const hit of candidates) {
235:        if (room() <= 0) break;
...
249:          if (earlier.wanted === "tentative" && wanted === "confirmed")
250:            kept.splice(kept.indexOf(earlier), 1, { memory, text, wanted });
...
273:    const confirmedMemories = kept.filter(({ wanted }) => wanted === "confirmed").map(present);
```
例子：`limit=2` 时 `tentativeLimit=1`，待确认 T 先占 1 个名额，已确认 C1 再占 1 个，随后已确认 C2 与 T 近重复；此时 `room()===0`，C2 被直接跳过，最终仍返回待确认 T。另一个例子：`kept=[T]`，C1 非重复入列，C2 与 T 重复并替换 T，最终已确认顺序变成 `[C2, C1]`，而 provider 顺序是 `[C1, C2]`。

**建议**：把重复检查/替换放在 `room()` 判断之前，允许已确认项在满额时替换待确认项；替换后按最终 confirmed 的原排序重建输出（或重新按 score 排序），不要复用待确认项的位置。补一条“名额已满时已确认仍能替换待确认”和“替换后 confirmed 顺序不变”的测试。

### 2. 中：评测结果没有按 ADR 所说的写入 `history.jsonl`，89.1% 的声明无法从仓库复核

**文件:行**：`docs/adr/0221-memory-retrieval-relevance-cutoff-and-same-source-dedupe.md:69-74`；`evals/memory-retrieval/history.jsonl:1`

**问题**：ADR 表格称截断后准确率 89.1%、召回 77.4%，并写明“记录在 `evals/memory-retrieval/history.jsonl`”。但该文件仍只有 2026-10-29 的旧记录，生产门槛那轮的准确率是 0.854、召回 0.774；本次 diff 没有修改 `history.jsonl`。离线 fixture 测试只断言“准确率上升、召回下降不超过 2 个点”，并不校验 89.1% 这个具体数字。

**证据**：
- ADR：`截断后（默认参数） | 80% | 77.4% | 89.1%`，上一行写明“记录在 `evals/memory-retrieval/history.jsonl`”。
- `history.jsonl` 唯一一行：`"recordedAt":"2026-10-29T07:26:19.229Z"`，生产门槛结果 `"precision":0.854,"recall":0.774`。
- `retrieval-eval-fixture.unit.test.ts:82-84` 只检查 `after.precision > before.precision` 和 `before.recall - after.recall <= 0.02`。

**建议**：把本次实跑结果追加到 `history.jsonl`，或把 ADR 改成“尚未写入历史记录、只有离线复算”；同时确认 89.1% 是否来自可复现的同一套 fixture/实跑。

### 3. 低：去重的数字保护只覆盖 Unicode 十进制数字，符号和中文数字仍可能被合并

**文件:行**：`packages/application/src/services/same-source-dedupe.ts:4-12, 26-29`

**问题**：`normalized` 去掉 `\p{P}`，连负号也会被去掉；`digitRuns` 只匹配 `\p{Nd}`。因此“余额 -5 元”和“余额 5 元”在规范化后可能完全相同；“两个/三个”这类中文数字也不参与数字差异判断。作者的说法“数字串不同不算重复”对 ASCII 数字成立，但这些边界仍可能把不同事实当重复。

**证据**：
```ts
8:    .replace(/[\p{P}\p{S}\p{Z}\s]/gu, "");
12:   return (text.normalize("NFKC").match(/\p{Nd}+/gu) ?? []).join(",");
26:   if (digitRuns(left) !== digitRuns(right)) return false;
```

**建议**：至少把负号、正号纳入数字比较，或明确“只处理阿拉伯数字”的限制；若要覆盖中文数字，增加对应归一化。补“符号不同”“中文数字不同”的反向测试。

### 4. 低：内存索引测试实现的 `similarity` 是点积，不是余弦，可能掩盖截断行为差异

**文件:行**：`packages/testing/src/in-memory/memory-index.ts:39-47`

**问题**：新字段 `MemoryIndexCandidate.similarity` 在接口和 fusion 中按“余弦相似度”使用，但内存索引直接返回点积。嵌入未归一化时，该值可能大于 1 或为负，导致测试中的截断行为与 SQLite 生产实现不一致。

**证据**：
```ts
39:      const similarity = (document: MemoryIndexDocument): number | undefined => {
...
44:        let dot = 0;
45:        for (let index = 0; index < left.length; index += 1)
46:          dot += (left[index] ?? 0) * (right[index] ?? 0);
47:        return dot;
```
`fusion.ts:158-162` 直接把该值当相似度与 `minimumScore` 比较。

**建议**：内存索引改为与生产一致的 cosine（除以两个范数），或复用 SQLite 的 `cosineSimilarity` 逻辑；至少补一个非单位向量用例。

## 推测 / 需确认

- **不同数据分类的同源近重复被去重后，结果分类可能变低**。`production-memory-recall.ts:247-253` 只按重复关系替换/跳过，不比较 `dataClassification`；`present` 只把最终保留项的分类加入 `shown`（`production-memory-recall.ts:259-260`）。若敏感记忆与私有记忆同源且几乎相同，而私有项排在前面，敏感项可能被丢掉，最终 `contentClassification` 只反映私有项。Durable 路径同样在 `durable-memory-service.ts:462-476` 去重后返回。是否为问题取决于“同内容不同分类”的产品定义，建议明确要求去重时保留最高分类，或禁止跨分类去重。这是推测，未找到规则文件对该场景的明确规定。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本 diff 没有修改系统提示、工具定义、历史消息或遮盖逻辑；变化的只是 `DurableMemoryService.search` 选中的记忆和 `memory.recall` 的返回值。`durable-memory-service.ts:429` 只是把 `relevanceCutoff: true` 传给 provider，`production-memory-recall.ts:181,194` 也只是改变传给 provider 的参数。按 `prompt-prefix.md` 第 2 条，本轮选中的记忆属于本轮末尾内容；我没有读 `production-run-memory.ts` 之外更下游的 prompt 组装实现，**具体注入位置的实现未核实**，但本改动没有改变注入位置或格式，因此不构成请求开头变化。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会对已有文字做重写。去重时 `nearDuplicateText` 只用于比较，发送的仍是 `contentRef` 原文；没有新增时间字段，也没有把 Set/Map 序列化进输出。`candidateSimilarities` 的 `missing.sort()` 只影响查询，不影响输出顺序。需要说明的是：去重会在两个**近似但字节不同**的副本之间选一个，选择依赖本轮排序（含 `now`/`lastUsedAt`），所以不同轮次可能选到不同副本；但这属于“本轮追加内容”的变化，不是改写已发出的前缀。

3. **有没有对应自动检查，反向用例真的会失败？** 有：
   - `retrieval-eval-fixture.unit.test.ts`：默认参数下准确率必须上升、召回下降不得超过 2 个点；反向用例要求“只认向量门槛、无关键词/实体加分”召回下降超过 2 个点。
   - `fusion.unit.test.ts`：关键词噪声被截断、实体加分可抬高、`entityWeight=0` 时被截断、未知相似度放行、无 cutoff 不截断。
   - `hybrid-memory-provider.unit.test.ts`：调用方门槛与 margin、非法 tuning 抛错。
   - `same-source-dedupe.unit.test.ts`：同源近重复保留第一条并回填、不同来源保留、读不出正文保留、没有同源时不读正文、数字不同不合并。
   - `durable-memory-projection.test.ts`：去重开关两种结果、只对保留项记 `lastUsedAt`、请求带 `relevanceCutoff`。
   - `memory-engine-index.test.ts`：关键词/实体候选补算相似度，未嵌入记忆没有 similarity。
   - `production-memory-recall.unit.test.ts`：两次搜索都请求 cutoff、去重与回填、confirmed 替换 tentative。
   - `startup-configuration.unit.test.ts`：`memory.retrieval` 的范围、类型和未知键。

   **缺口**：没有覆盖第 1 条的“名额已满时 confirmed 仍应替换 tentative”和“替换后 confirmed 顺序”；没有测试 `memory.retrieval` 从配置解析后真正进入 `ProductionMemoryComposition`/`HybridMemoryProvider` 的联动（解析测试和 provider 构造测试是分开的）。因此第 1 条不会被现有测试发现。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `keywordWeight` / `entityWeight` / `cutoffMargin`：`strict-configuration.ts` 产出 `[0,1)`，`production-memory-composition.ts:114-118` 消费并传给 provider，`hybrid-memory-provider.ts:64-65` 再校验 `[0,1)`，两端一致。
   - `dedupeSameSource`：配置解析为布尔，production composition 默认 `true`，`service-main.ts:1169` 传给 DurableMemoryService、`service-main.ts:1256` 传给 ProductionMemoryRecall；其他直接构造 DurableMemoryService 的地方（主要是测试）不传，等于关闭。没有发现生产路径绕过。
   - `MemoryIndexCandidate.similarity`：SQLite 两种引擎和内存索引都会产出；fusion 通过可选字段消费，worker 使用 structured clone，字段能保留。唯一不一致是内存索引返回点积（第 4 条）。
   - `memory.relevance_unknown` 诊断事件：`service-main.ts:364-370` 提供 `component`、`event`、`candidates`，与 `writeServiceDiagnostic` 接受的值类型匹配。
   - `relevanceCutoff`：已加入端口，其他测试用 provider 不实现也不会破坏类型；生产组装传入。
   - `history.jsonl` 的评测记录：没有随本次结果更新，见第 2 条。
