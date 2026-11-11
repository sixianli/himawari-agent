## 读代码证实的

### 1. 严重度：中
`test/integration/memory-retrieval-eval/fixture.test.ts:57-58,71-77`

**问题：** 离线评测把“无关问题”全部跳过，无法验证本次改动最核心的目标（关键词撞上的无关记忆是否被挡住），也无法防止 `unrelatedLeakRate` 回退。

**证据：**
```ts
for (const query of dataset.queries) {
  if (query.expected.length === 0) continue;
  ...
  returned += hits.length;
  correct += hits.filter((id) => query.expected.includes(id)).length;
}
return { recall: found / expected, precision: correct / returned };
```
同一个文件第 88-102 行的反向用例也只统计 recall。`test/integration/memory-retrieval-eval/metrics.ts:58-62` 明明有 `unrelatedLeakRate`、`unrelatedMemoriesBrought`，但 fixture 测试没有用。因此“准确率上升”只是相关问题的 precision，上述 48 条无关问题的带出量不在自动门槛里。

**建议：** 对 `query.expected.length === 0` 的 fixture 查询增加断言：截断后 `hits` 必须为空；或者直接复用 `retrievalMetrics`，把 `unrelatedLeakRate` 纳入 `expect`。否则以后只改坏相关问题的排序、却让无关问题重新大量带出记忆，这个测试仍会通过。

### 2. 严重度：中低
`packages/memory-engine/src/hybrid-memory-provider.ts:173,196`

**问题：** 构造时校验了 `options.minimumSimilarity`（第 61-63 行），但每次调用传入的 `input.minimumSimilarity` 没有校验，新代码却直接拿它计算截断线。

**证据：**
```ts
const minimumSimilarity = input.minimumSimilarity ?? this.#options.minimumSimilarity ?? 0;
...
cutoff: {
  minimumScore: minimumSimilarity - relevance.cutoffMargin,
```
调用方传入 `NaN` 时 `relevance >= NaN` 恒为 false，所有有相似度的候选都会被静默剔除；传入 `1` 或负数时截断线也会超出预期。Gmail 的 `memoryMinimumSimilarity` 在 `strict-configuration.ts:1076-1079` 走的是允许 1 的 `unitInterval`，而这里没有拒绝。

**建议：** 对 `input.minimumSimilarity` 采用与构造函数相同的校验（有限数且 `0 <= x < 1`），或在 `HybridMemoryProvider.search` 里先校验再计算 `minimumScore`。同时补一条非法覆盖值的反向测试。

### 3. 严重度：低
`apps/agent-service/test/service-orchestration.unit.test.ts:712-719`

**问题：** 这里 mock 的 `ProductionMemoryComposition` 没有新字段 `dedupeSameSource`；`service-main.ts:1169`、`1256` 读取到的是 `undefined`，两个服务都会按默认值打开去重。这个测试无法发现“配置开关没有透传”这类回归。

**证据：**
```ts
const memory = {
  projection: {},
  bindEmbeddingBoundary: vi.fn(),
  descriptor: configuration.modelDescriptors[1],
  close: vi.fn(async () => {
```
而 `service-main.ts` 中：
```ts
dedupeSameSource: memoryComposition.dedupeSameSource,
```

**建议：** 在 mock 里显式加 `dedupeSameSource: false`，并断言构造 `DurableMemoryService` / `ProductionMemoryRecall` 时收到 false；或者给 `boundary.memoryComposition` 加类型，让缺失字段在编译期暴露。

### 4. 严重度：低（文档与实现）
`docs/adr/0221-memory-retrieval-relevance-cutoff-and-same-source-dedupe.md:49`、`apps/agent-service/src/production-memory-recall.ts:241-242`

**问题：** ADR 写“正文读不出来时按不重复处理”，但 `memory.recall` 的实现是直接跳过这条记忆，而不是保留它。

**证据：**
ADR：
```md
正文读不出来时按不重复处理。
```
实现：
```ts
const text = await this.#options.readText(memory).catch(() => undefined);
return text ? { memory, text, wanted } : undefined;
```
`dropSameSourceDuplicates` 确实把读失败当“不重复”（`same-source-dedupe.ts:63`、`79`），但 `memory.recall` 不是。这是既有行为，但本次 ADR 新写了这句笼统定义，容易误导。

**建议：** 把 ADR 改成“存储层去重遇到读不出的正文按不重复；`memory.recall` 仍会跳过无法读取正文的候选”，或让 `memory.recall` 的行为与 ADR 一致。

---

## 推测

### 1. 严重度：低
`apps/agent-service/src/production-memory-recall.ts:246-261,271-278`

**推测问题：** `fillTentative` 使用单调递增的 `nextTentative`。当某个待确认候选此前因“与 A 重复”被跳过，之后 A 又被已确认记忆替下时，这个候选不会被重新考虑，可能留下空名额。

**证据：**
```ts
let nextTentative = 0;
const fillTentative = async (): Promise<void> => {
  while (nextTentative < tentativeHits.length && ...) {
    const hit = tentativeHits[nextTentative];
    nextTentative += 1;
    ...
    if (shownHit && !duplicateOf(tentativeKept, ...) && !duplicateOf(confirmedKept, ...))
      tentativeKept.push(shownHit);
  }
};
...
if (twin) {
  tentativeKept.splice(tentativeKept.indexOf(twin), 1);
  replaced = true;
}
...
if (replaced) await fillTentative();
```
是否真会留下空名额取决于非传递的近重复关系，属于边界场景。正常同源近重复下，被跳过的候选通常也会与替上的已确认记忆重复，因此影响有限。

**建议：** 若要求严格“从剩下的待确认补满”，可在替下后允许从已扫描过的候选重新检查，或记录被跳过原因并在其重复对象被移除时重新评估；否则在 ADR 中写明“不回看已扫描候选”。

### 2. 严重度：低（资源）
`packages/application/src/services/same-source-dedupe.ts:69-84`、`packages/application/src/services/durable-memory-service.ts:424`

**推测问题：** `dropSameSourceDuplicates` 对保留候选做双层循环，并逐条读取正文；`DurableMemoryService.search` 最多把 `policy.limit * 4` 放大到 1000。若大量候选同源且正文很长，最坏情况是接近 O(n²) 次近重复比较和最多 n 次正文读取。

**证据：**
```ts
for (const candidate of ranked) {
  if (kept.length >= limit) break;
  ...
  for (const earlier of kept) {
    if (!earlier.sourceRefs.some((source) => sources.has(source))) continue;
    ...
    if (left !== null && right !== null && nearDuplicateText(left, right)) {
```
```ts
limit: Math.min(1000, Math.max(input.policy.limit * 4, input.policy.limit)),
```
生产实际限额通常很小，但这属于边界输入下的资源放大点。

**建议：** 对同源比较次数或正文长度设上限，或只对已确定同源的少量候选做精确比较；同时补一条“候选很多、正文很长”的基准或护栏测试。

### 3. 严重度：低
`packages/application/src/services/durable-memory-service.ts:463-476`、`apps/agent-service/src/production-proactive-memory.ts:41-53`

**推测问题：** `DurableMemoryService.search` 的去重按融合排名保留靠前者，没有“已确认优先”。Gmail 检查传入 `includeTentative: true`，如果待确认记忆排在同源的已确认记忆前面，已确认那条会被当成重复丢掉。`memory.recall` 有专门的已确认优先逻辑，这两条路径的行为不一致。

**证据：**
```ts
const selected =
  this.options.dedupeSameSource !== false
    ? await dropSameSourceDuplicates(ranked.map(...), input.policy.limit, ...)
    : ranked.slice(0, input.policy.limit);
```
`dropSameSourceDuplicates` 只保留排名靠前者，不区分 tentative。ADR 只承诺 `memory.recall` 已确认优先，因此不算明确违约，但值得确认 Gmail 场景是否可接受。

**建议：** 若 Gmail 也希望已确认优先，可在 `DurableMemoryService.search` 排序时让 confirmed 优先于同分/近重复 tentative；否则在 ADR 明确写出“仅 memory.recall 有已确认优先，Gmail 按检索顺序”。

---

## 侧重检查

- **错误路径：** 检查了 embedding 失败、单条记忆无向量、正文读失败、`readText` 抛错、tentative search 失败。`HybridMemoryProvider` 在 embedding 失败时传 `embedding=null`，存储层不补相似度，融合层按 unknown 放行并回调；`dropSameSourceDuplicates` 的读失败被 `.catch(() => null)` 转成“不重复”。基本符合 ADR。`production-memory-recall` 的读失败是跳过候选，与 ADR 文字不完全一致（见上）。
- **不合规范/不可信输入：** `memory.recall` 的 query、日期、limit 校验仍存在；`memory.retrieval` 通过 `strict-configuration` 的 `rejectUnknown` + `unitInterval` 校验，provider 构造时再次用 `validRelevanceTuning` 校验。发现 `HybridMemoryProvider.search` 的调用级 `minimumSimilarity` 未校验。
- **安全/隐私：** 去重发生在分类过滤之后（`DurableMemoryService` 先检查 `allowedClassifications`，`memory.recall` 先经过 `eligible` 的 `isModelVisible`），未发现受限记忆正文被读取或写入日志；`memory.relevance_unknown` 只记录数量。SQL 的 `candidateSimilarities` 使用 `@ids` 参数和 `json_each`，没有拼接字符串；按 `memoryId`、模型、维度过滤，未发现跨 owner/agent 读取路径。
- **资源耗尽：** `nearDuplicateText` 的 trigram 计算和正则都是线性，无明显 ReDoS；主要风险是去重双层循环和最多 1000 条候选/长正文的边界放大（见推测 2）。
- **不可撤销操作：** `markUsed` 只在 `DurableMemoryService.search` 最终选中的记忆上调用，去重在被跳过项之前完成；`memory.recall` 本身不写“最近使用”。未发现被去重掉的记忆被误记使用。
- **规则/文档一致性：** 核对了 `.claude/rules/prompt-prefix.md`、ADR 0221、ADR 0115/0158、UI 设计指南。相关分公式、截断线、配置范围、默认去重与代码一致；发现“正文读不出来”的表述在 `memory.recall` 下不一致。fixture 的实跑来源（run 时间戳、候选从门槛 0 过滤到 0.6）只能看到 JSON 注释，仓库里没有对应的原始运行产物，标记为**未核实**。
- **工作进程边界（I-73 类型）：** `MemoryIndexCandidate.similarity` 通过 `SqliteExecutionContext` 的 `postMessage`/结构化克隆返回，没有额外 schema 白名单，因此新字段不会在 worker 边界被丢掉。配置新键也只被 `parseProductConfiguration` 和 `createProductionMemoryCompositionFromConfiguration` 消费，没有找到另一个会拒绝或丢弃它的序列化/解析入口。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会（基于代码路径核对）。**

- 本改动只改变“本轮选中哪些记忆”和“选中的记忆如何排序/去重”，没有改系统提示、工具定义、历史消息或遮盖规则。
- 选中的记忆由 `context-formation-service.ts:608-615` 放进 `contextBlocks` 的 `kind: "memory"` 块。
- 真正发给模型时，`pi-runtime-adapter.ts:623-641` 的 `turnPrompt()` 把这些块放在 `<himawari-context>` 里，随后才是 `<owner-message>`，即最后一条用户消息；系统提示和工具在 `himawariRequestHead`/`himawariRequestContext` 中单独处理，本 PR 未改。
- 每轮会变的值（本轮时间、本轮记忆、运行环境）仍在最后一条用户消息里；本 PR 新增的 `memory.relevance_unknown` 只写服务诊断日志，不进入 prompt。
- 因此仍是“只在末尾追加”：同一对话已有的系统提示、工具和历史不会被改写。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会因本改动新增这种问题。**

- `nearDuplicateText`、`dropSameSourceDuplicates`、`fuseCandidates` 的过滤和排序都是确定性的：输入相同（查询、候选集合、记忆正文、配置）时结果相同。
- 没有新增时间戳、随机数、哈希或依赖对象遍历顺序的输出。
- `Set`/`Map` 只用于成员判断（`similarity.has`、`entity.has`、`texts.get`），最终输出顺序仍由 `ranked` 数组、`hits` 数组以及 `score`/`memoryId` 的显式排序决定。
- 同一段记忆被选中时，其正文原样进入 `contextBlockContent`，本 PR 没有改写正文。不同请求因查询不同而选中不同记忆，属于检索语义变化，不是同一段文字被序列化成不同字节。
- 唯一需要留意的是：去重/截断依赖查询相关量（本句最高 bm25、实体命中），因此同一记忆在不同查询下可能被保留或剔除；但一旦被选中，发送的字节不变。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

**有，且覆盖较广；但我没有运行测试，以下是按代码推断。**

已有的检查：
- `packages/memory-engine/test/fusion.unit.test.ts:99-179`：低相似度关键词命中被剔除、实体加分过线、entityWeight 为 0 时实体命中被剔除、无相似度候选放行并报告数量、加成不会把相关记忆压下线。
- `packages/memory-engine/test/hybrid-memory-provider.unit.test.ts:238-264`：默认不截断、显式 `relevanceCutoff` 才截断、每次调用覆盖门槛、非法权重拒绝。
- `packages/application/test/same-source-dedupe.unit.test.ts`：同源近重复、不同来源保留、读不出正文保留、无同源时不读正文、数字/正负号/中文数字差异。
- `apps/agent-service/test/production-memory-recall.unit.test.ts`：去重默认打开、已确认替下待确认、名额满时仍替下、替下后从剩余待确认补位、两次搜索都要求截断。
- `test/integration/durable-memory-projection.test.ts:463-526`：`dedupeSameSource` 为 true/false/undefined 三种情况，且只给最终保留项记最近使用。
- `packages/platform-node/test/startup-configuration.unit.test.ts:165-199`：配置合法/非法值。
- `test/integration/memory-retrieval-eval/fixture.test.ts:80-102`：默认参数下 precision 上升、recall 降幅不超过 2 点；反向用例把关键词/实体权重设为 0，要求 recall 掉超过 2 点。

反向用例的判断：
- `hybrid-memory-provider.unit.test.ts:239-240` 明示了无截断返回 3 条、截断后只返回 1 条，去掉截断逻辑该用例会失败。
- fixture 反向用例的中文/数字/正负号用例能抓住旧实现：旧正则 `[+\-]?\p{Nd}+|[中文数字]+` 会把 `-三百` 和 `三百` 都提取成 `三百`，从而错误合并；新用例期望 false，旧代码会失败。
- fixture 的“只认向量门槛、不给关键词/实体加分”用例按 `history.jsonl` 中 0.6 门槛 recall 0.774、无截断 recall 0.981 推断，会掉超过 2 点，反向用例应能失败。

**缺口：**
- 如“读代码证实的 1”所述，fixture 测试跳过无关问题，因此无法抓住“无关问题重新带出记忆”的回归。
- `service-orchestration.unit.test.ts` 的 mock 没有 `dedupeSameSource`，无法验证配置透传。
- 我没有执行测试，测试是否实际通过、fixture 的实跑数据是否完全来自注释所说的 run，均**未核实**。

### 4. 新产生的每个值，使用它的地方都能接受吗？

逐项核对结果：

| 产生的值 | 产生处 | 使用处 / 校验 | 结论 |
|---|---|---|---|
| `memory.retrieval.keywordWeight/entityWeight/cutoffMargin` | `strict-configuration.ts:122-141`，校验 `0 <= x < 1` | `production-memory-composition.ts:100,114-118` 合并默认值；`HybridMemoryProvider` 构造时 `validRelevanceTuning` 再次校验 `relevance.ts:13-17` | 两端都接受 [0,1)，一致 |
| `memory.retrieval.dedupeSameSource` | `strict-configuration.ts:138-139`，布尔 | `production-memory-composition.ts:126` → `service-main.ts:1169,1256` → `DurableMemoryService` / `ProductionMemoryRecall`，两者用 `!== false` 处理 | 一致；但测试 mock 缺字段（见低危项） |
| `MemoryIndexCandidate.similarity` | SQLite `sqlite-memory-operations.ts:1212-1278`；内存索引 `memory-index.ts:39-63` | `fusion.ts:135-162` 把 `undefined` 当“未知”放行，数值参与相关分；worker 通过结构化克隆返回，无 schema 剥离 | 一致；两个生产实现都只在能算出余弦时给值 |
| `relevanceCutoff` | `DurableMemoryService.search` 固定 `true`；`ProductionMemoryRecall` 两次搜索显式 `true` | `HybridMemoryProvider.search` 只在 `=== true` 时构造 cutoff | 一致 |
| `memory.relevance_unknown` 事件 | `service-main.ts:365-370`，`candidates: number` | `writeServiceDiagnostic` 接受 `string \| number \| boolean \| readonly string[]`（`service-runtime.ts:67-72`） | 一致 |
| `MEMORY_RELEVANCE_TUNING_INVALID` | `hybrid-memory-provider.ts:64-65` | 启动构造时抛出 RangeError，无其他序列化消费者 | 一致 |
| `dedupeSameSource` 新返回字段 | `production-memory-composition.ts:41,126` | 仅 `service-main` 读取 | 生产一致；测试 mock 未跟上 |

未发现类似 I-73 的“生产值通过了前端/清单校验但被后端拒绝”的断点。唯一需要补的是测试 mock 的类型/字段，以及 `input.minimumSimilarity` 的调用级校验。
