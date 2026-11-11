# 复核结论

先说明：以下“读代码证实”的结论都来自我亲自读过的当前工作区内容；没有运行测试（工具限制），也没有做动态复现。标注为“推测/未核实”的部分不再当作结论使用。

## 一、读代码证实的问题（按严重度）

### 1. 低：同源去重的数字保护对中文数字不认正负号，可能把正负金额当成重复合并
- 文件：`packages/application/src/services/same-source-dedupe.ts:11-16`、`:28-32`
- 问题：正则只有第一支允许正负号，第二支（中文数字）不允许。`-三百` 里的 `-` 不会进入数字串；随后 `normalized()` 又删掉了 `-`，于是 `余额-三百元` 与 `余额三百元` 归一化后完全相同、数字串也完全相同，被判为重复。
- 证据：
  ```ts
  11: const NUMBER_RUN =
  12:   /[+\-\u2212]?\p{Nd}+|[〇零一二两三四五六七八九十百千万亿壹贰叁肆伍陆柒捌玖拾佰仟]+/gu;
  ...
  28: export function nearDuplicateText(left: string, right: string): boolean {
  29:   if (numberRuns(left) !== numberRuns(right)) return false;
  ...
  32:   if (a === b) return true;
  ```
  `normalized` 位于 `:4-9`，`-` 属于 `\p{P}`/`\p{S}`，会被删掉。于是 `numberRuns("-三百") === numberRuns("三百") === "三百"`，且 `a === b`，直接返回 `true`。
  同一处还有反向的轻微问题：阿拉伯数字正负号被计入数字串，但依赖“符号紧贴数字”。`余额-500` 与 `余额- 500` 归一化后正文相同，数字串却是 `-500` vs `500`，会被判为不重复，降低去重命中。现有测试 `same-source-dedupe.unit.test.ts:23-29` 只测了 `-500` vs `500` 和“两份/三份”，没有覆盖这两个方向。
- 建议：把符号放进两支共用的前缀，例如 `[+\-\u2212]?(?:\p{Nd}+|[...]+)`；同时补“负中文数字”和“符号与数字间有空格”的用例。如果产品上就只保护阿拉伯数字的正负号，在 ADR 里写明这一限制。

### 2. 低：`memory.recall` 里已确认替下待确认后，不会用剩余待确认候选补满名额
- 文件：`apps/agent-service/src/production-memory-recall.ts:244-261`
- 问题：待确认候选只扫一遍，达到 `tentativeLimit` 或扫完就结束；之后已确认候选替换掉一个待确认时只做了 `splice`，没有回头从 `tentativeHits` 里补一个待确认。名额不会超限，但会少返回。
- 证据：
  ```ts
  245:    for (const hit of tentativeHits) {
  246:      if (tentativeKept.length >= tentativeLimit) break;
  ...
  257:      const twin = duplicateOf(tentativeKept, shownHit.memory, shownHit.text);
  258:      if (twin) tentativeKept.splice(tentativeKept.indexOf(twin), 1);
  259:      else if (room <= 0) continue;
  260:      confirmedKept.push(shownHit);
  ```
  按代码推演（未用测试复现）：`limit=4`、`tentativeLimit=2`、`tentativeHits=[T1,T2,T3]`、只有一个已确认 `C1` 且 `C1` 与 `T1` 同源近重复时，待确认阶段停在 `T1,T2`；已确认阶段用 `C1` 替掉 `T1` 后返回 `C1,T2` 两条，而不是 `C1,T2,T3` 三条。第一版 `collect()` 也有同样的欠填，所以这不是第 2 轮新引入的回归，但本轮把“名额已满时替下”写进目标后，这个边界仍然没有补满。
- 建议：把待确认和已确认放进同一个按检索顺序的候选流处理，或者在已确认替换后允许再补扫一次剩余待确认；至少补一个“候选数多于限额 + 已确认替下待确认”的用例。

### 3. 低：离线评测 fixture 的来源与 live 评测的候选记录逻辑不一致，自动检查无法按当前代码复现
- 文件：`test/integration/memory-retrieval-eval/live.test.ts:107-110`、`evals/memory-retrieval/candidates-qwen3-embedding-8b.json:3` 与 `:283-285`、`test/integration/memory-retrieval-eval/fixture.test.ts:58-76`
- 问题：live 评测在 `minimumSimilarity === 0` 时记录 `index.search` 的原始结果（向量路此时不按 0.6 过滤）；但入库的 fixture 明确写着“向量路已按 0.6 门槛过滤”。重跑 live 评测并拿 `candidates.json` 当 fixture，基线和提交的 fixture 会不同。
- 证据：
  ```ts
  107:    search: async (input) => {
  108:      const result = await index.search(input);
  109:      if (input.minimumSimilarity === 0) recorded.set(input.queryText, result);
  110:      return result;
  ```
  ```json
  3:  "note": "2026-11-11 ... 每句话三路的原始候选（向量路已按 0.6 门槛过滤）...",
  ...
  283:    "我住在哪里": {
  284:      "vector": [],
  285:      "lexical": [["mother", 2.39302, 0.482], ["home", 2.25883, 0.51424]],
  ```
  `home` 在 lexical 里带着相似度 `0.51424`，说明它有同模型同维度的已存向量；若 `minimumSimilarity=0`，`vector` 不可能为空。可见提交的 fixture 是额外按 0.6 裁剪过的，而 live 记录器不会做这个裁剪。
- 建议：让记录器在写 `candidates.json` 时也按生产门槛裁剪 `vector`（或直接记录 `minimumSimilarity === 0.6` 的结果），并在文件 note 里写清裁剪步骤；否则加一个校验，确认 fixture 与记录器输出一致。这个问题不影响当前 fixture 表达“生产门槛下的 before/after”，但影响自动检查的可复现性和“录下的候选”这一说法。

### 4. 低：`dedupeSameSource` 的默认值在服务层与 ADR 不一致
- 文件：`packages/application/src/services/durable-memory-service.ts:33`、`:462-463`、`apps/agent-service/src/production-memory-composition.ts:126`、`docs/adr/0221-memory-retrieval-relevance-cutoff-and-same-source-dedupe.md:65`
- 问题：ADR 把 `dedupeSameSource` 的默认值写成 `true`，但该默认只在生产组装层施加；`DurableMemoryService` 自身是可选字段且用 `=== true` 判断，未传就默认关闭。直接构造服务的调用方（包括若干集成测试）会静默得到“去重关闭”，与文档的默认值不一致。
- 证据：
  ```ts
  // durable-memory-service.ts
  33:  readonly dedupeSameSource?: boolean;
  ...
  462:    const selected =
  463:      this.options.dedupeSameSource === true
  ```
  ```ts
  // production-memory-composition.ts
  126:    dedupeSameSource: retrieval?.dedupeSameSource ?? true,
  ```
- 建议：若 ADR 的默认值应适用于所有产品入口，就在 `DurableMemoryService` 层也用 `?? true`（或显式默认参数）；若坚持只在组装层控制，就在 ADR 里写明“默认值只在生产组装层生效”。

## 二、推测 / 未核实

- `blobVector()` 使用 `new Float32Array(copy.buffer, 0, dimensions)`（`sqlite-memory-operations.ts:216-220`）。如果数据库里的 embedding blob 长度与 `embedding_dimensions` 不一致（损坏或非本代码写入），这里会抛 `RangeError`。正常写入路径有长度校验，所以我没有把它算作已证实问题；属于健壮性推测。
- `dropSameSourceDuplicates` 的正文读取与两两比较是 O(n²)，并且会解密候选正文；当前调用方 `policy.limit` 很小（Gmail 3、聊天几到几十），所以实际资源开销有限。如果以后 `policy.limit` 放大，这里值得重新评估。未实测。
- 我无法运行测试，因此“现有全量测试是否全绿”未核实；我只核对了新增/相关测试的断言方向。

## 三、侧重检查

- **错误路径**：正文读不出时 `dropSameSourceDuplicates` 用 `.catch(() => null)` 按不重复处理（`same-source-dedupe.ts:58-65`、`:77`）；`memory.recall` 的待确认检索失败会 `.catch(() => [])`（`production-memory-recall.ts:199`）；`readText` 失败返回 `undefined` 并跳过该候选（`:241-242`）。这些路径符合“失败不放大、不误删”的方向。
- **不可信输入**：`memory.retrieval` 通过 `record()`/`rejectUnknown()`/`unitInterval()`/`boolean()` 校验，拒绝非对象、未知键、非有限数、负数、`>=1` 和类型错误（`strict-configuration.ts:122-143`、`:1309-1321`）；provider 构造时再次用 `validRelevanceTuning` 校验（`hybrid-memory-provider.ts:61-65`、`relevance.ts:10-16`）。
- **安全 / 隐私**：补算相似度的 SQL 全部走参数（`json_each(@ids)`、`@model`、`@dimensions`），没有拼接候选 id（`sqlite-memory-operations.ts:1243-1258`）；去重只处理已经过状态、分类、来源过滤的候选；`memory.relevance_unknown` 只传条数，不传正文（`service-main.ts:365-370`）。
- **资源耗尽**：本次新增没有递归、没有无界循环；`NUMBER_RUN` 是无嵌套量词的线性正则；候选数受 provider 的 `limit*4`/`min(1000,...)` 和 `Math.min(200, Math.max(50, limit))` 约束。O(n²) 去重是已知上限风险，但当前调用规模很小。
- **不可撤销操作**：本改动没有删除或改写记忆；去重只影响本次返回，`markUsed` 只对最终 `selected` 执行（`durable-memory-service.ts:477-481`）。
- **规则/文档一致性**：ADR 0221 的四处调用点与代码一致（`DurableMemoryService.search:429`、`memory.recall:181/194`、整理检索 `service-main.ts:1971` 不传）；配置范围、默认值、0.9/8 字常量与代码一致；ADR 0115、0158、界面设计指南已同步；第 2 轮把 ADR 里的 fixture 路径改到了 `test/integration/memory-retrieval-eval/fixture.test.ts`，与文件位置一致。唯一需要留意的就是上面第 4 条的服务层默认值，以及中文数字符号的边界。

## 四、必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这个改动只改变“本轮选中哪些记忆”。记忆作为 `contextBlocks` 里的 `kind: "memory"` 条目，最终由 `turnPrompt()` 渲染在 `<himawari-context>` 中、紧跟最后一条用户消息的 `<owner-message>` 之前（`packages/runtime-pi/src/pi-runtime-adapter.ts:623-641`）。系统提示、工具定义、历史消息、遮盖逻辑都不在这次 diff 里。发给模型的内容仍然只在末尾追加，每轮会变的记忆选择都在最后一条用户消息里；`markUsed` 更新的是数据库里的 `lastUsedAt`，不进入请求开头。符合 `.claude/rules/prompt-prefix.md#rules` 第 1、2、4 条。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   已发送的开头不会。单独一条记忆的正文仍然来自 `contentRef`，字节不变；变化的是“本轮是否选中它、和谁一起选中”。需要承认的新增性质是：同源去重让“是否显示某条记忆”依赖同一查询里的其他候选，`readText` 失败时也会按“不重复”处理，因此同一轮重试/不同轮次的选择可能不同。但这只影响最后一条用户消息里的记忆块，不影响前缀；排序仍是检索顺序 + `memoryId.localeCompare` 的确定性 tie-break（`durable-memory-service.ts:459-460`），没有新增时间字段或随机字段。`onRelevanceUnknown` 只写诊断日志，不进入提示。结论：没有引入“已发送内容跨请求变字节”的新风险。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有，而且多数反向用例是有效的：
   - `fusion.unit.test.ts`：关键词噪声被截、实体加分、实体权重为 0 时被截、相似度未知放行并回调；若去掉截断，这些期望会失败。
   - `hybrid-memory-provider.unit.test.ts`：调用方不要求时不截、要求时按本次门槛减余量截、配置权重生效、非法 tuning 被拒。
   - `same-source-dedupe.unit.test.ts`：同源近重复、不同来源保留、读不出正文保留、无同源不读正文；第 2 轮新增的 `-500/500`、`两份/三份` 用例在旧实现（只匹配 `\p{Nd}+`、不识别中文数字）下会失败，是真反向用例。
   - `in-memory-memory-index.unit.test.ts`：旧点积实现返回 50 而不是 1，维度不同返回 6 而不是 `undefined`，会失败。
   - `durable-memory-projection.test.ts` 的 `it.each([true,false])`：同时验证去重开关和 `markUsed` 只作用于最终留下的记忆。
   - `production-memory-recall.unit.test.ts`：plain vs dedupe、已确认替下待确认后的输出顺序。
   - `startup-configuration.unit.test.ts`：负数、1、NaN、Infinity、字符串、未知键、非布尔都被拒绝。
   - `fixture.test.ts`：默认参数下 precision 必须上升、recall 降幅不超过 2 点；反向用例把截断线设为向量门槛且不给关键词/实体加分，要求 recall 掉超过 2 点。
   缺口：fixture 只验证截断，不验证去重；并且如上文第 3 条，fixture 与 live 记录器不一致，重新生成的候选会改变基线。另，`candidateSimilarities` 的 sqlite-vec / JS 两条分支是否都被执行取决于测试环境的向量扩展加载；测试用 `describe.each(["worker","direct"])`（`memory-engine-index.test.ts:313` 外层的 describe.each）看起来覆盖两种模式，但我没有运行，未核实。

4. **改动产生或修改的每个值，每个使用它的地方都能接受吗？**
   - `memory.retrieval.keywordWeight/entityWeight/cutoffMargin`：解析端限制 `0 ≤ x < 1`（`strict-configuration.ts:132-136`），组装端用 `?? DEFAULT` 保留 `0`（`production-memory-composition.ts:111-122`），provider 端再次 `validRelevanceTuning`（`hybrid-memory-provider.ts:61-65`、`relevance.ts:10-16`）。两端一致。
   - `memory.retrieval.dedupeSameSource`：解析端只接受布尔（`strict-configuration.ts:138-139`），组装端默认 `true`，`DurableMemoryService` 和 `ProductionMemoryRecall` 都用 `=== true` 判断；生产入口 `service-main.ts:1169`、`:1256` 都传了组装值，能接受。唯一遗留是服务层默认值不一致（上文第 4 条）。
   - `MemoryIndexCandidate.similarity`：sqlite 端对 vector 用 signal、对 lexical/entity 补算余弦（`sqlite-memory-operations.ts:1212-1279`）；内存测试索引也补了余弦并处理维度不同（`memory-index.ts:39-69`）；消费端 `fusion.ts:135-162` 只把它当数值用，缺失即视为未知放行。字段是可选，其他实现不接受/不产生也不会坏。
   - `RelevanceCutoff.minimumScore`：由已校验的 `minimumSimilarity` 减已校验的 `cutoffMargin` 得到（`hybrid-memory-provider.ts:196`），消费端只做 `>=` 比较。一个小的边界：provider 没有校验每次调用传入的 `minimumSimilarity` 范围，但 sqlite 会拒绝非有限值，生产调用方只会传 `0.45`、`0.6` 或 `undefined`，所以当前接线可接受；若以后开放外部传入，建议在 provider 入口同样限制范围。
   - `onRelevanceUnknown` 的计数值：`writeServiceDiagnostic` 接受 `string | number | boolean | readonly string[]`（`service-runtime.ts:67-73`），且只记条数，不泄露正文。
   - `dropSameSourceDuplicates` 的返回类型从 `{kept,dropped}` 改为数组：唯一生产调用方 `durable-memory-service.ts:465-475` 已同步改为直接 `.map`，测试也全部改为接收数组；没有遗留按 `.kept`/`.dropped` 读取的调用。
   - `similarity` 补算 SQL 的输入 `ids`、`model`、`dimensions` 都来自已校验/已限定范围的内部值，`json_each` 走参数绑定；候选很多时是单条 IN 查询，向量维度不一致、缺向量都被 `embedding_model`/`embedding_dimensions`/`embedding IS NOT NULL` 过滤成“未知”，不会误判为低相似度。
   总体：生产接线两端校验能互相接受；没有发现“新增 id/字段/配置键在某一端被拒”的 I-73 类问题。
