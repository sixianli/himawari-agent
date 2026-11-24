## 上一轮意见核对

- **意见 1（长轮索引不完）**：部分改好。`#readTurns` 现在会翻页读到线程末尾或下一个主人消息，单条 >200 的长轮能一次读到结尾（`test:530` 覆盖）。但若这个长轮后面还有新的主人轮，会卡死，见下面第 1 条。
- **意见 2（读取/嵌入失败被吞、推进水位）**：主要问题改好。`strict` 模式下 `readText` 拒绝会向上抛，`indexDue` 捕获后不写行、不推进水位，`onIndexFailure` 有日志（`conversation-turns.ts:96-98,166-192,232`；`service-main.ts:1846-1869`；测试 `test:567` 逻辑上会因旧实现失败）。但一个读不出的轮会永久阻塞该线程后面所有轮，见第 2 条。
- **意见 4（upsert/attach 无版本校验）**：改好。`upsert` 增加 `last_sequence > ?` 的 newer 判断（`sqlite-conversation-turn-operations.ts:156-162`），`attachEmbedding` 用 `WHERE id=? AND last_sequence=?`（`:382-391`），并有测试 `test:584`。
- **意见 10（service-main 追赶循环）**：部分改好。`listUnembedded` 加了 `threads.status='open' AND origin='owner'`（`:350-351`），也加了“回收站轮不占补向量名额”的测试（`test:630`）。但“坏轮占住队头导致后面的健康轮永远补不上”的饥饿仍在，见第 3 条。
- **意见 6（search 查询向量/全文预算）**：部分改好。查询向量加了 `embeddableClassifications.includes("private")` 门（`:331`）；但“返回全文没有字符预算”没改，见第 5 条。

**本轮查过的范围**：只对 `3c98db1..f8da845` 增量逐行核对（`service-main.ts`、`production-run-composition.ts`、`production-memory-episodes.ts`、`packages/application/src/ports/conversation-turns.ts`、`packages/memory-engine/src/conversation-turns.ts`、`sqlite-conversation-turn-operations.ts`、两个测试），并顺藤跟了被增量用到/改到行为的旧代码：`sqlite-thread-operations.ts:1493-1515`（`sequence >` 语义）、`migrations/20261124132117_conversation_turns.sql`、`sqlite-thread-operations.ts:334-335,439-440`（DB `open` ↔ active/archived）、`20261115045512_thread_origin.sql`、`production-titled-runtime.ts:39-66`、`local-vector-catch-up.ts`。未核实：没有运行任何测试（不能运行测试命令）；`git show` 读取 `.agents/reviews/pr-614/round-1/*` 被仓库规则拒绝，只能按题目给的上一轮摘要核对；没有通读 ADR 0286 和设计文档全文。

### 1、中高、长轮后面若还有新的主人轮，后面的轮永远建不了索引，而且每轮都重复嵌入前面的长轮

文件：`packages/memory-engine/src/conversation-turns.ts:167-189`、`197-220`；`packages/persistence-sqlite/src/sqlite-conversation-turn-operations.ts:317-323`

问题：`#readTurns` 一旦在某个“满 200 条”的页里看到起始消息之后的第一个 owner，就 `return reachedEnd=false` 并停止翻页；`indexDue` 随后 `turns.slice(0, -1)` 把最后那轮（新主人轮）丢掉。但下一次水位的读取起点是 `indexedFrom - 1`，而 `indexedFrom = max(first_sequence)`（`:317-320`）。当最后被索引的恰好是一个长轮 A（≥200 条消息）时，从 A 的第一条重读又会读满 200 条、在第二页看到 B 的 owner，于是再把 B 丢掉；A 的 `first_sequence` 不变，水位永远不前进，B 及其后的内容永远不进索引，A 每轮被重复 delete+insert 并重新嵌入（消耗嵌入预算）。

证据：

```ts
// conversation-turns.ts:214-218
const last = page.at(-1);
if (!last || page.length < MESSAGES_PER_READ) return { messages, reachedEnd: true };
if (messages.slice(1).some((message) => message.role === "owner"))
  return { messages, reachedEnd: false };
```

```ts
// conversation-turns.ts:173-174
const turns = groupTurns(messages);
for (const turn of reachedEnd ? turns : turns.slice(0, -1)) {
```

```sql
-- sqlite-conversation-turn-operations.ts:317-323
LEFT JOIN (SELECT thread_id, max(first_sequence) AS indexed_from,
    max(last_sequence) AS indexed_through
  FROM conversation_turns ...) i ...
AND m.last_sequence > COALESCE(i.indexed_through, 0)
```

复现条件（静态推演）：线程含长轮 A（例如 390 条）后接新一轮 B（例如 ≥11 条），使“从 A 第一条起算的第 2 页满 200 条且该页出现 B 的 owner”。此时 `indexDue` 每轮只写回 A，B 永不写入；`test:530` 的长轮用例只放了单个长轮、没有后续 owner，覆盖不到。

建议：不要用“页先看到 owner”来判定线程未结束；改为读到线程真正末尾（或读到固定上限后以真正的读取游标为水位），并允许把当前最后一轮也写入（同 id 覆盖 + 现有 newer 校验本来就能处理增长）；或单独持久化一个“读到哪一条”的前进游标，不再用 `max(first_sequence)` 反推。补一条“长轮 A + 后续主人轮 B”的用例，断言 B 最终可被搜到且第二次 `indexDue` 不再重写 A。

### 2、中、一个永久读不出的轮会阻塞该线程之后所有轮，后面的内容永远缺索引

文件：`packages/memory-engine/src/conversation-turns.ts:166-192`、`232`

问题：`try/catch` 包住了整个 `for (const turn of ...)` 循环，`#index` 在 strict 模式下任一消息读取抛错，就会跳出该线程剩余所有轮；而水位只按已成功写下的行推进，于是下一轮又从坏轮之前重读、再次在坏轮抛出。结果是：坏轮之后的轮在坏轮修好之前永远不会被索引；如果坏载荷永久损坏，它们永远不可搜，而且每轮重复读取/重新嵌入前面的轮。测试 `test:567` 实际证明了这一点（清空不可读后 `indexDue` 才返回 2、turn2 才出现），但没有覆盖“后面还有健康轮、坏轮一直坏”的持续饥饿。

证据：

```ts
// conversation-turns.ts:166-192
try {
  const { messages, reachedEnd } = await this.#readTurns(...);
  ...
  for (const turn of ...) {
    ...
    await this.#index(...);      // 第 k 轮抛错
    indexed += 1;
  }
} catch (error) {
  this.#options.onIndexFailure?.(error);   // 整个线程剩余轮被跳过
}
```

```ts
// conversation-turns.ts:232
const lines = await this.#lines(ownerId, agentId, turn.messages, true);
```

建议：把失败限定在单轮（记录一个可重试的失败标记/游标），后续轮继续索引；或者至少把“永久坏轮”记录为可见的失败态并允许跳过，避免一个坏载荷拖死整条线程。补“首轮不可读、后轮可读且长时间保持不可读”的用例，断言后轮仍能索引。

### 3、中、补向量队列按 `indexed_at,id` 取前 N 条且无游标，队头若有若干读不出/嵌不出的轮，后面的健康轮永远补不上

文件：`packages/memory-engine/src/conversation-turns.ts:264-295`；`packages/persistence-sqlite/src/sqlite-conversation-turn-operations.ts:344-365`；`apps/agent-service/src/service-main.ts:1982-1992`

问题：`listUnembedded` 没有 offset/游标，固定 `ORDER BY c.indexed_at, c.id LIMIT @limit`；`backfillEmbeddings` 对读取失败只记日志、不计数。于是若排在最前的 100 条可嵌入轮全部读取失败（坏载荷）而其后还有健康轮，`embedded` 返回 0，`service-main` 的 `for(;;) { ... if (embedded === 0) break; }` 直接退出，`createLocalVectorCatchUp` 之后把状态置为 `done` 且只在启动时跑一次，健康轮就永远没有向量；每轮 `ProductionMemoryEpisodes` 的 `backfillEmbeddings(limit:20)` 也会被同一批坏队头挡住。这正是上一轮意见 10 里“异常情况下的饥饿边界”，增量只补了“回收站/think 不进队”，没有解决坏队头占位。

证据：

```sql
-- sqlite-conversation-turn-operations.ts:354
ORDER BY c.indexed_at, c.id LIMIT @limit
```

```ts
// conversation-turns.ts:276-292
try {
  const lines = await this.#turnLines(turn, true);
  ...
  if (!embedding) continue;      // 不计 embedded
  ...
} catch (error) {
  this.#options.onIndexFailure?.(error);   // 坏轮留在队头
}
```

```ts
// service-main.ts:1983-1991
for (;;) {
  const embedded = await conversationTurns.backfillEmbeddings({
    ownerId: configuration.ownerId, agentId: configuration.agentId,
    limit: 100, within: maintenanceWithin,
  });
  if (embedded === 0) break;
}
```

建议：给 `listUnembedded` 增加游标/分页或“失败重试时间”字段，跳过暂时的坏轮而不是每次从同一队头重试；或在 service-main/补向量循环里遇到“本轮 0 成功但队列非空”时记为错误并按退避重试，且不能因队头坏而永远不再扫描后面的行。补一条“前 100 条不可读、第 101 条可嵌”的用例。

### 4、低、search 的查询向量门用的是字面量 `"private"`，不是查询内容的真实密级（推测）

文件：`packages/memory-engine/src/conversation-turns.ts:329-341`

问题：`if (embedder && this.#options.embeddableClassifications.includes("private"))` 只判断“private 是否可嵌入”，就按 `("private", ...)` 去调 `embedder.embedQuery`。当 `embeddableClassifications` 为 `["public"]` 时确实不再发（测试覆盖），但当它是 `["public","private"]` 时，从 sensitive 内容衍生出的查询仍会以 private 的准入发给嵌入服务。这是否可接受取决于“查询一律算 private”的约定，代码和 ADR 里我未看到明确依据，故标推测；搜索工具还没接模型，实际影响现在为零。

证据：

```ts
if (embedder && this.#options.embeddableClassifications.includes("private")) {
  ...
  vector: await (input.within ?? direct)("private", () => embedder.embedQuery(input.query)),
```

建议：明确查询的分类来源（例如由调用方传入 `queryClassification`），或让搜索在“查询可能含高密级”时退化为纯词检索，并在 ADR 写清。

### 5、低、search 命中后仍返回整轮全文，没有字符预算（上一轮意见 6 的后半未改）

文件：`packages/memory-engine/src/conversation-turns.ts:351-368`、`301-315`

问题：`limit` 最大被放大到 500，逐条 `turnLines`，每个轮最多取 `min(1000, last-first+1)` 条消息，再全部返回；没有总字符预算。虽然本 PR 没有调用方（模型工具下一 PR），但一旦接上就是一次可能返回数十万行的大响应。

证据：

```ts
limit: Math.min(500, Math.max(20, input.limit * 2)),
...
const lines = await this.turnLines(turn);
if (lines.length > 0) hits.push(...);
```

```ts
Math.min(1000, turn.lastSequence - turn.firstSequence + 1),
```

建议：给 `search` 增加跨命中的总字符/总行预算，或让调用方按 `limit` 和窗口分页取正文，避免一次性返回整轮。

### 6、低、每轮把对话轮索引放在每日摘要前面，admission 屏障会被索引/补向量的网络调用拖长

文件：`apps/agent-service/src/production-memory-episodes.ts:112-114`、`44-65`；`apps/agent-service/src/production-titled-runtime.ts:49-64`

问题：`#summarize` 现在先 `await this.#indexTurns(request)`（最多 20 条补向量 + 20 条索引，含网络嵌入），然后才走到每日摘要的 `generate`（`onAdmitted` 在 generate 里才 resolve）。`production-titled-runtime` 在 `ADMISSION_BARRIER_EVENTS` 处 `await memoryAdmission`，而 `memoryAdmission` 就是 `start()` 返回的 `admitted`。因此在没有到期摘要时，主运行也要等索引和补向量全部结束才越过屏障。这不是错误，但改变了每轮延迟；作者说法只强调了“不影响每日摘要那条路”。

证据：

```ts
// production-memory-episodes.ts:112-114
async #summarize(request, onAdmitted) {
  await this.#indexTurns(request);
  await this.#options.service.backfillEmbeddings(...)
```

```ts
// production-titled-runtime.ts:55-64
await memoryEpisodes?.start(request);
...
if (ADMISSION_BARRIER_EVENTS.has(event.type)) {
  ...
  await memoryAdmission;
}
```

建议：如果只是想“这轮结束后顺带索引”，可把 `#indexTurns` 放到 `onAdmitted` 之后、或独立于 `admitted` 的后台任务，避免把嵌入网络调用放进本轮屏障路径；若这是有意的，请在 PR 说明/ADR 写明延迟代价。

## 侧重检查

- **错误路径**：`indexDue` 的 `try/catch` 位置（包住整轮循环）导致单轮失败阻塞整线程（第 2 条）；`backfillEmbeddings` 的 `continue` 与无游标查询导致队头饥饿（第 3 条）；`readText` 被拒会抛（已改好），但返回 `undefined` 仍按“没这行”静默跳过，`#index` 的 `classifications` 只统计进入 `lines` 的消息（`conversation-turns.ts:235-240`）——若某个 model-visible 的高密级消息在某次索引时读到 `undefined`、之后又能读到，该轮会被低密级入库，而 `search` 的 `turnLines` 会按真实消息重新读取并把高密级原文放进 `lines`，存在“降级密级”的窄口径泄漏风险。此条是**推测**，需要“先 undefined 后成功”的异常时序，且搜索工具尚未接模型；已在上一轮指出的旧代码范围内，一并记录。
- **不合规范/不可信输入**：`sqlite-conversation-turn-operations.upsert/attachEmbedding/search/listUnembedded` 都有类型/范围校验（`limitWithin`、`validTime`、`validEmbedding`、`Number.isSafeInteger(lastSequence)`），新增 `lastSequence` 也被校验；`search` 的 `allowedClassifications` 仍只接受 `MODEL_VISIBLE`（`restricted` 不能被搜）。
- **安全/密级**：索引只对 `isModelVisible` 的消息计入 `terms`/向量/密级；`restricted` 轮即使写行也无词、无向量且不在可嵌入集合；`searchScope` 只允许 model-visible 结果。未发现新泄漏路径（除上面的推测时序）。
- **资源耗尽**：`#readTurns` 对单个超长轮会整轮读进内存（`197-220`），没有条数上限；`search` 无字符预算（第 5 条）；长轮卡死时会每轮重复嵌入（第 1 条）。这些都是新增/保留的风险点。
- **不可撤销操作**：本增量没有新增删除/覆盖类不可逆操作；`upsert` 的 delete+insert 仍在事务内，且 newer 校验避免旧结果覆盖新结果。删线程的级联由 `ON DELETE CASCADE` + `AFTER DELETE` 触发器完成（`migrations/20261124132117_conversation_turns.sql:6,31-35`），`threads` 状态/`origin` 的映射与查询一致（`sqlite-thread-operations.ts:334-335,439-440`；origin 默认 `owner`）。
- **规则文件/文档与代码一致性**：`prompt-prefix.md` 规则 4/10/11 约束的是发给模型的内容；本增量只写检索表、读加密载荷、发嵌入请求，没有改系统提示/工具/历史/遮盖（全量 diff 也无 `packages/prompt-catalog` 或 prompt 相关文件）。作者说的“不改发给模型内容”与代码一致。
- **I-73 教训**：新增的 `attachEmbedding.lastSequence`、`onIndexFailure`、`conversation-turn.failed`、`listUnembedded` 的线程过滤都逐个找到产生端与使用端，见下方第 4 问答；没有发现像 I-73 那样“清单 id 过不了后端校验”的两端不匹配。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不涉及。这个增量没有改系统提示、工具定义、历史消息或遮盖；新增的只是检索索引、诊断日志、嵌入调用和测试/文档。`prompt-prefix.md` 规则 4 要求的“只追加、会变的值放最后一条”在这里没有被触碰，`ConversationTurnService` 的输入输出都不进入模型请求（`packages/memory-engine/src/conversation-turns.ts` 全文；`production-memory-episodes.ts` 只做后台索引）。因此“发给模型的内容是否仍然只在末尾追加、每轮变的值是否都在最后一条消息”仍然成立，且本 PR 没有改变它。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不涉及模型请求。增量里唯一“会变”的新值是被持久化到 DB 的 `indexed_at = now()`（`conversation-turns.ts:252`），它只用于 `listUnembedded` 的排序，不进入模型；`terms` 由 `indexableTerms(text)` 生成、`lines` 按 `sequence` 顺序拼接，没有依赖前后文的遮盖或无序集合进入模型字节。存储层每次重索引 `indexed_at` 会变，但不影响同一段原文在模型侧序列化。

3. **有没有对应的自动检查，反向用例真的会失败？** 有新增用例：长轮读到末尾且第二次不重复（`test:530`）、不可读轮不上报不写行且之后能补（`test:567`）、旧索引/旧向量晚到不覆盖新轮（`test:584`）、回收站线程不占补向量名额（`test:630`），以及 `service-orchestration` 里 `conversation-turn.failed` 必须带 `siteField`（`test:1180-1190`）。按静态推演，这些用例在旧实现上会失败（旧 `#line` 吞错会让 `turn1` 以 restricted 行写入，`test:567` 的 `turnRows=[OTHER]` 不成立；旧 `upsert` 会把 `[3,5]` 覆盖成 `[3,4]`，`test:584` 不成立）。但我**没有运行测试**，无法确认它们真的在 CI 的测试项目里执行、也无法确认“反向用例”是实跑失败而非仅逻辑上失败。另外，长轮用例没有覆盖“长轮后面还有新主人轮”的反向场景（第 1 条）。

4. **每个新值的使用端能不能接受？逐端核对：**
   - `ConversationTurnStorePort.attachEmbedding.lastSequence`：产生端只有 `ConversationTurnService.backfillEmbeddings`，传 DB 读出的 `turn.lastSequence`（`conversation-turns.ts:284-287`）；使用端 `durable-adapters.ts:1440` 原样透传，`SqliteConversationTurnOperations.attachEmbedding` 校验 `Number.isSafeInteger` 并用于 `WHERE last_sequence=?`（`:367-391`）。仓库内没有别的 `ConversationTurnStorePort` 实现或 mock 缺少该字段（`grep attachEmbedding` 只命中真实仓储和测试）。可接受。
   - `onIndexFailure`：产生端 `conversation-turns.ts` 三处调用（`:191,291` 及通过 `#embed` 的 `onEmbeddingFailure`）；使用端 `service-main.ts:1869` 映射到 `conversation-turn.failed` 诊断（不写消息正文，符合 I-94 的 `siteField` 习惯），测试 `test:162` 收集错误。可接受。
   - 诊断事件 `conversation-turn.failed`：使用端是 `service-orchestration.unit.test.ts:1185` 的源码断言；没有别的 event 目录/白名单需要登记。可接受。
   - `listUnembedded` 新增的 `EXISTS (... t.status='open' AND t.origin='owner')`：产生端 `sqlite-conversation-turn-operations.ts:350-351`；使用端是 `backfillEmbeddings` 与 `service-main`/`ProductionMemoryEpisodes` 的补向量，行为是排除回收站/think，测试 `test:630` 覆盖。DB 侧 `open` 涵盖 active+archived（`sqlite-thread-operations.ts:334-335,439-440`），origin 默认 `owner`（`20261115045512_thread_origin.sql`），因此正常对话不会被误排除。可接受。
   - `#readTurns` 的 `reachedEnd`、`strict`、`newer` 判断：都只在 `conversation-turns.ts` / `sqlite-conversation-turn-operations.ts` 内部消费，未改导出接口（`turnLines` 从 `async` 改为返回 Promise，签名等价，且仓库内只有自身调用）。可接受，但 `#readTurns` 的行为本身有第 1 条的缺陷。
   - `ProductionRunCompositionOptions.episodes.turns` / `ProductionMemoryEpisodesOptions.turns`：产生端 `service-main.ts:3251` 只在 `conversationTurns` 存在时传；使用端 `production-run-composition.ts:585` 透传；两者都在 `memoryComposition && episodeProtector` 同一条件下创建，不会出现“有 turns 没主线”或反之。可接受。
