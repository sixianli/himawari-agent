## 结论摘要

改动整体方向正确：回看是独立后台调用，没有改主对话的系统提示、工具定义或历史；新增的提示词把每天变化的日期放在最后一行。但有几处错误路径和标识长度问题会让回看永久失败、撤销不彻底或撤销后又被重写，其中“生成的 id 可能超过 128 字符”和“撤销/重试状态机”最值得在合并前修。

---

## 问题（按严重度）

### 1. 高：回看生成的 generation id / memory id 可能超过 128 字符，`createMemoryId` 会直接抛错

**文件:行**
- `apps/agent-service/src/production-memory-conversation-review.ts:757`
- `apps/agent-service/src/production-memory-conversation-review.ts:818`
- `apps/agent-service/src/production-memory-capture.ts:609`
- `packages/domain/src/identifiers.ts:39`
- `packages/persistence-sqlite/src/migrations/0091_memory_conversation_review.sql:2`
- `packages/gateway-contracts/src/contracts-v2.ts:1283,1382`

**问题**
回看把 `episode.id` 和 `message.id` 直接拼进 generation id，又用类型断言绕过了 `createMemoryGenerationId` 的校验；随后 `processCommittedRun` 用真正的 `createMemoryId` 生成 memory id，超过 128 字符就会抛 `DomainError`，整段回看失败并可能重试到 `gave_up`。

**证据**
- `production-memory-conversation-review.ts:757`：
  ```ts
  const generationId = `memory-review:${episode.id}:${message.id}` as MemoryGenerationId;
  ```
- `production-memory-conversation-review.ts:818`：
  ```ts
  const memoryId = `memory:${generationId}:${ordinal}` as MemoryId;
  ```
- `production-memory-capture.ts:609`：
  ```ts
  memoryIdFor: (generation, ordinal) => createMemoryId(`memory:${generation}:${ordinal}`),
  ```
- `packages/domain/src/identifiers.ts:39`：
  ```ts
  const MACHINE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  ```
  `createMemoryId` 在 `identifiers.ts:109-110` 会调用这个校验。
- `memory-engine/src/episodes.ts:385`：
  ```ts
  const id = `episode:${input.source}:${input.threadId}:${input.firstSequence}`;
  ```
  thread id 本身允许到 128 字符；`firstSequence` 也会随长对话增长。按正常 32 位 thread 指纹估算，消息序号到 1000 且候选 ordinal ≥ 10 时 memory id 已经到 129；序号到 10000 时 ordinal 0 就超限。
- 另一侧同样不一致：`0091` 的 review id 允许 1–300：
  ```sql
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 300),
  ```
  但网关概览和撤销命令都用 `reviewId: machineString`，而 `validation.ts:53-54` 限定最长 128。thread id 较长时，`memory-review:${episode.id}` 会让整个 memory overview 的网关响应违反契约。

**建议**
不要用可增长的 episode/message 原文拼 ID。用固定长度哈希（例如 `memory-review:` + sha256 前 32/40 位）生成 review id、generation id 和 memory id；生成时显式走 `createMemoryId` / `createMemoryGenerationId`，并统一 DB CHECK、网关 `machineString`、domain 的 128 上限。

---

### 2. 高：可以对 `failed`/`running` 批次撤销；撤销后失败的批次还会被重试并继续写入

**文件:行**
- `packages/persistence-sqlite/src/sqlite-memory-conversation-review-operations.ts:91-97`（游标只跳过 completed/gave_up）
- `packages/persistence-sqlite/src/sqlite-memory-conversation-review-operations.ts:132-144`（重试 failed 时不清 `undone_at`）
- `packages/persistence-sqlite/src/sqlite-memory-conversation-review-operations.ts:265-269`（`listWithChanges` 不筛状态）
- `packages/memory-engine/src/conversation-review.ts:24-28`（只检查 `undoneAt`，不检查 status）
- `apps/agent-service/src/production-memory-conversation-review.ts:844-862`（先逐条写 change，之后才 finish）

**问题**
`runDue` 只把 `completed`/`gave_up` 当作已处理，`failed` 会被重试。`begin` 重试时只更新 `status/attempts/day/started_at/finished_at`，不清 `undone_at`。于是这条路径可发生：

1. 回看失败，但已经写入了部分 change；
2. 用户在记忆页看到这批 change，点撤销；`undoConversationReview` 只检查 `undoneAt`，于是把部分批次标成已撤销；
3. 下一次 `runDue` 仍会把这条 `failed` 回看重新 `begin`（`undone_at` 仍在），复用旧模型输出继续写 change；
4. 结果：界面显示“已撤销”，但记忆又被改了，且因为 `undone_at` 已设置永远不能再撤销。

`running` 批次也可能在 overview 中出现并显示撤销按钮，因为 `listWithChanges` 不筛 status，而 change 是在 `finish("completed")` 之前写入的。

**证据**
- `operations.ts:139-142` 重试更新没有 `undone_at`：
  ```sql
  UPDATE memory_conversation_reviews SET status = 'running',
    attempts = min(attempts + 1, 100), day = ?, started_at = ?, finished_at = NULL,
    episode_created_at = ?
  WHERE id = ?
  ```
- `operations.ts:265-269`：
  ```sql
  SELECT ... FROM memory_conversation_reviews r
  WHERE owner_id = ? AND agent_id = ? AND EXISTS (...)
  ORDER BY coalesce(finished_at, started_at) DESC, id ASC LIMIT ?
  ```
- `conversation-review.ts:27-28`：
  ```ts
  if (review.undoneAt !== null)
    throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Conversation review undone");
  ```
- `production-memory-conversation-review.ts:844-862` 在 `#commit` 内写 `recordChange`，而 `finish({status:"completed"})` 在 `production-memory-conversation-review.ts:495-500` 才执行。

**建议**
撤销只允许 `status === "completed"` 且 `undoneAt === null`；`begin` 遇到 `undoneAt !== null` 必须拒绝恢复（把该段视为终态/`gave_up` 并推进游标）；概览只展示可撤销的终态批次，或明确区分 running/failed。

---

### 3. 中高：撤销不是原子的，失败后可能永久停在“部分撤销”

**文件:行**
- `packages/memory-engine/src/conversation-review.ts:35-63`

**问题**
先逐条校验全部记忆，再逐条 `memory.revise`，最后才 `markUndone`。中间任何一次 `revise` 失败（并发修改、数据库错误、authority 失效等）都会留下：

- 前面的记忆已归档/已恢复；
- 整批仍标记为“未撤销”；
- 重试时前面记忆的 revision 已经变了，`isReviewChangeUndoable` 永远失败，整批再也无法撤销。

这违反 ADR 的“要么全做要么不做”。

**证据**
`conversation-review.ts:45-63`：
```ts
for (const { change, memory, generationId } of planned)
  await options.memory.revise({ ... });
const undoneAt = options.now();
if (!(await options.store.markUndone({ id: review.id, undoneAt })))
  throw new ApplicationPortError(...);
```
校验在 `35-44` 一次完成，但真正写库在 `45-60` 循环里，没有数据库事务。

**建议**
把“校验 revision + 全部 revise + markUndone”做成一个持久化端口里的单事务操作；或者写入一个撤销计划先占位，再逐条执行，失败时按计划做补偿。至少要在失败时回滚已执行的 revise。

---

### 4. 中：回看写入也不是原子的，失败会留下没有 change 记录的孤立记忆

**文件:行**
- `packages/application/src/services/automatic-memory-service.ts:164-252`
- `apps/agent-service/src/production-memory-conversation-review.ts:795-862`

**问题**
`processCommittedRun` 在一个循环里逐条 `commitCandidate`，每条 `applyProposal` 各自写库；回看的 `#commit` 要等它全部返回后才计算并写 `memory_conversation_review_changes`。如果第二个候选写库时失败：

- 第一个候选已经创建/取代成功；
- 但整个 `#commit` 抛错，没有为它写 change 行；
- 若重试三次后 `gave_up`，这条记忆永久存在且无法通过“整批撤销”撤回。

**证据**
`automatic-memory-service.ts:164-252` 是逐个候选调用 `commitCandidate`，没有外层事务；`production-memory-conversation-review.ts:795-808` 调用完 `processCommittedRun` 后，到 `834-862` 才重新读取并写 change。

**建议**
同一次回看批次的候选写入和 change 记录应在同一个事务里；或者先持久化待写清单，再逐条执行并可用清单恢复/撤销。

---

### 5. 中：重试时 `beforeSupersededBy` / `beforeValidTo` 可能取到“已被取代后”的值，撤销会恢复错误

**文件:行**
- `apps/agent-service/src/production-memory-conversation-review.ts:739-748`
- `apps/agent-service/src/production-memory-conversation-review.ts:820-826`

**问题**
`before` 值来自 `current`（在 `#commit` 开头重新读取的当前记忆），而不是回看计划时的快照。如果第一次尝试已经成功取代了旧记忆，但在写 change 行之前失败，重试时旧记忆的 `supersededBy` 已经是新记忆 id；此时记录下来的 `beforeSupersededBy` 就是新 id，而不是原来的 `null`。之后撤销会把旧记忆的 `supersededBy` 恢复成新 id，旧记忆仍然显示被取代。

**证据**
`production-memory-conversation-review.ts:739-748`：
```ts
const current = new Map(
  (touched.length === 0 ? [] : await this.#options.state.readMany({ ... }))
    .map((record) => [record.id as string, record]),
);
```
`production-memory-conversation-review.ts:820-826`：
```ts
planned.push({
  memoryId: candidate.supersedes,
  action: "superseded",
  before: current.get(candidate.supersedes),
});
```
这里的 `current` 在重试时已经包含第一次写入的 `supersededBy`。

**建议**
`beforeSupersededBy` / `beforeValidTo` 应来自计划时快照 `known`（`plan.existing`），`current` 只用于比较 revision 是否变化；或者把 before 值作为幂等写入的一部分落库。

---

### 6. 中：freshness 检查和写库之间仍有 TOCTOU 窗口，主人在回看期间修改的记忆可能被覆盖

**文件:行**
- `apps/agent-service/src/production-memory-conversation-review.ts:751-755`
- `apps/agent-service/src/production-memory-conversation-review.ts:795`

**问题**
代码先读取 `current` 并比较 revision，然后在 `processCommittedRun` 里再次读记忆并写库。两步之间如果主人通过记忆页修改了旧记忆，`applyProposal` 的取代仍会基于最新 revision 覆盖这次修改。现有测试只在 `onGenerate`（进入 `#commit` 之前）修改记忆，没有覆盖这个窗口。

**证据**
`production-memory-conversation-review.ts:751-755`：
```ts
const candidates = group.parsed.candidates.filter((candidate) => {
  const fresh = unchanged(candidate.supersedes) && unchanged(candidate.existingMemoryId);
  ...
});
```
真正写入在 `795` 的 `service.processCommittedRun(...)`。

**建议**
在 `applyProposal` / `supersede` 上支持“expected revision”比较并交换，或在同一个事务里完成“校验 revision + 写入”；冲突时整段回看跳过并记录 `not_a_change`。

---

### 7. 低：`alsoSeenIn` 接受“另一天的消息 id”，与 ADR 的“另一天记下的旧记忆”不一致

**文件:行**
- `apps/agent-service/src/production-memory-conversation-review.ts:227-233`
- `docs/adr/0231-review-past-conversations-to-fix-memory.md` 第 6 条

**问题**
ADR 和提示词都写 habit 需要指向另一天的**旧记忆** id，但代码同时接受 `owners` 里的消息 id：
```ts
const message = owners.get(id);
if (message) return localDay(message.message.committedAt, input.timeZone) !== sourceDay;
const memory = existing.get(id);
return memory !== undefined && memory.recordedOn !== sourceDay;
```
这会让“同一段对话里跨午夜的另一条消息”也能支撑习惯判断，削弱“至少两个不同日期”的硬规则，也让规则依赖日摘要段落边界。

**建议**
只接受 `existing` 里的记忆 id；如果确实允许消息 id，同步修改 ADR、提示词和测试，说明理由。

---

### 8. 低：`replacesOlder` 用字符串比较日期和完整时间戳，同一天可能判断反

**文件:行**
- `packages/memory-engine/src/consolidation.ts:130-137`
- `apps/agent-service/src/production-memory-conversation-review.ts:319`

**问题**
`statedAt(older) < newer.statedAt` 是字符串比较。回看传入的 `statedAt` 可能是 `validFrom` 的日期（`YYYY-MM-DD`），而旧的 `statedAt` 是完整 ISO 时间戳。同一天时 `"2026-11-10" < "2026-11-10T..."` 会成立，导致“当天的新说法”被当成更晚；反过来如果旧的是日期、新的是当天时间戳，也会出现不一致。

**证据**
`consolidation.ts:130-137`：
```ts
return (
  statedAt(older) < newer.statedAt &&
  newer.confidencePermille >= autoCommitThreshold(newer.category, gates)
);
```
`production-memory-conversation-review.ts:319`：
```ts
statedAt: candidate.attributes?.validFrom ?? source.message.committedAt,
```

**建议**
比较前把日期统一成同一个时刻（例如 `validFrom` 补 `T00:00:00.000Z`，或都解析为 `Date.parse` 的数值）；明确“日期粒度”和“时间戳粒度”的先后规则。

---

## 侧重检查

我按“错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档与代码一致”逐项查了：

- **不可信模型输出**：`parseConversationReview` 先用 `jsonObject` 取 JSON，再校验 `memories` 数组、`messageId` 必须属于本段 owner 消息、`existingMemoryId` 必须属于 `plan.existing`、`quote` 复用 `parseMemoryCandidates` 做逐字证据校验；`pattern` 的 `alsoSeenIn` 也做成员检查。整体边界比较完整。问题集中在上面的 id 长度和 `alsoSeenIn` 过宽。
- **敏感/受限内容**：`#plan` 用 `isModelVisible(classification)` 和分级 rank 过滤消息（`production-memory-conversation-review.ts:538-558`）；`parseConversationReview` 跳过 sensitive/restricted 候选（`273-280`）；集成测试覆盖 restricted 消息不进 prompt。`knownPeople` 没有按分级过滤，但每轮抽取 `production-memory-capture.ts:1050` 也是同样做法，属于既有设计，不是本次新增。
- **失败重试**：模型输出按 `review.id + attempts` 存 payload，重试优先读旧输出（`#output` 661-685），这部分正确。但写库幂等只依赖 `applyProposal` 的“同 contentRef 返回已有记录”，没有覆盖部分写入后的 before 值问题；测试也没有真正跑到“写入后失败”的路径。
- **不可撤销操作**：撤销逻辑不是事务，且允许撤销 running/failed 批次；失败批次被撤销后还会被重试。见问题 2、3。
- **资源耗尽**：消息数上限 120、单条 1500 字符、总字符数可配、相关记忆 30、输出 token 1024，边界都在代码里。一个小的点是 `#readText` 先完整解密/解码整条 payload 再 `slice`，超大单条消息会有瞬时内存峰值，但没有新增放大效应。
- **文档与代码一致**：ADR 的配置默认值、重试次数、提示词顺序、分级过滤、敏感候选跳过、`processCommittedRun` 复用、费用用途都与代码一致；发现的偏差是 `alsoSeenIn` 接受消息 id、以及“测试保证不读摘要正文”实际只是 `proactive-summaries-scope.unit.test.ts` 对源码字符串 `episode.contentRef` 的检查，不是行为级测试。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会改变主对话的开头。** 本次改动没有改主对话的系统提示、工具定义或历史消息；`memory.capture` 的文字被抽成 `MEMORY_FIELD_RULES` 常量，但 `prompt-manifest.json` 里 `memory.capture` 的 sha256 没有变，文字顺序也与原文一致。回看是独立后台请求：`conversationReviewPrompt` 自己组装“固定指令 + 本段数据 JSON + 最后一行日期”，只用于新的 `generate` 调用，不往 `thread_messages` 追加或改写任何主对话历史。

发给模型的内容仍然符合“只在末尾追加”的规则：主对话没有新增中间内容；回看请求自己的每轮变化值只有 `day`，位于最后一行（`production-memory-conversation-review.ts:128`，golden 文件 `memory.conversation-review.txt:27`）。`production-titled-runtime.ts:60-64` 会在 `runtime.completed` 前等待 `memoryAdmission`，可能延迟运行收尾事件，但不改变模型请求开头，也不改历史；是否可接受要看产品对“不阻塞”的定义。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

主对话：不会。本次没有改主对话的遮盖输入、遮盖规则或历史序列化。

回看请求：固定指令部分字节确定；同一份数据在测试中两次生成的 prompt 字节相同（`memory-conversation-review.test.ts:386-399`）。但严格说有三点：

- `existingMemories` 的顺序来自检索结果（`production-memory-conversation-review.ts:573-581`），没有显式按 id 或固定 tie-break 排序；生产检索若同分排序不稳定，同一组记忆可能以不同顺序序列化。**这是推测，当前测试里的检索桩按 id 排序，所以没覆盖。**
- `subCategories` 的键顺序来自 `listSubCategories` 的 SQL，SQL 有 `ORDER BY category, count DESC, sub_category`，是确定的。
- 回看把旧消息放到新的后台上下文中重新遮盖，同一句原话在“原对话请求”和“回看请求”中的遮盖字节不保证相同；但它不会写回历史，也不影响主对话的 KV 缓存。

`messageSentAt` 是历史消息的 `committedAt`，不是当前时间；没有把当前时间放进 id 或请求开头。`day` 在最后一行。

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

有，而且多数反向用例是有效的：

- `test/integration/memory-conversation-review.test.ts`：12 条，覆盖取代+整批撤销、重复读取、模型输出复用、习惯两天证据、逐字证据反向、敏感/健康推断反向、旧记忆更新时 hold、回看期间修改记忆、撤销锁定、restricted 不进 prompt、每日上限、关闭开关。
- `test/integration/data-export.test.ts`：回看往返 + 反向“change 指向不存在的 memory 必须 `REFERENCE_BROKEN`”。
- `apps/control-center/test/memory-interactions.unit.test.ts` 和 `test/integration/memory-source-browser.test.ts`：批次展示、撤销命令、锁定不显示按钮。
- `prompt-rendering-golden.unit.test.ts`、`prompt-output-contracts.unit.test.ts`：提示词固定部分和解析器契约。
- `proactive-summaries-scope.unit.test.ts`：新增 `listDaySummariesAfter` 使用点和“源码里不出现 `episode.contentRef`”的检查。

确实会失败的反向用例：证据不逐字、只有 agent 消息、敏感候选、健康推断、旧记忆更新、回看期间修改、撤销前修改、restricted 消息、每日上限、关闭开关、导出指向不存在记忆。这些逻辑我对照代码看过，断言和实现一致。

**但有一条不成立：** “失败重试不能重复写入同一条记忆”没有被真正测到。测试 `memory-conversation-review.test.ts:406` 用 `failAssertActiveAt: 3`，而 `production-memory-conversation-review.ts` 的第 3 次 `assertActive()` 在 `#commit` 的 `758` 行，位于 `generations.request` 和 `processCommittedRun` 之前。也就是说失败发生在任何写入之前，只证明了“模型输出被复用”，没有证明“写库幂等/不会重复写”。同时也没有覆盖 running/failed 批次撤销、部分写入后重试、长 id 越界。

### 4. 每个新产生或修改的值，使用它的地方都能接受吗？

逐项核对结果：

- **`configuration.memory.conversationReview`**：`strict-configuration.ts:144-150` 接受六个字段，`parseProductConfiguration` 把它放进 `configuration.memory`，`service-main.ts:2244-2248` 合并默认值后使用；键名和类型一致。我特别验证了 `maximumRelatedMemories: 0`：虽然 `searchIndex` 拒绝 `<1`，但 `HybridMemoryProvider.search` 在 `hybrid-memory-provider.ts:151-153` 对 0 直接返回 `[]`，所以这个配置值不会触发后端校验错误。
- **网关命令 `memory.conversationReview.undo`**：`contracts-v2.ts` 的消息类型、schema、fixture，`production-memory-control.ts` 的操作清单和 handler，`control-center/src/memory.ts` 的发送端都加了；两端一致。
- **网关概览 `conversationReviews`**：server 的 `ProductionMemoryControl` 始终输出该数组，client 类型和 fixture 也更新了。但 `reviewId` 用 `machineString`（≤128），而 DB 允许 300、生成规则又没有限制，见问题 1。
- **memory id / generation id**：`createMemoryId` 和 domain 标识符都要求 ≤128；回看用类型断言绕过了 generation id 校验，并在下游 `createMemoryId` 处可能失败，见问题 1。
- **数据导出/导入/校验**：`data/conversation-reviews.jsonl`、`CONVERSATION_REVIEW_SCHEMA`、manifest counts、`parsePortable`、`importPortableExport`、`verify` 都成对更新；反向用例覆盖了 `REFERENCE_BROKEN`。旧导出缺少新 counts/file 会被拒绝，但 `verifyIntegrity` 本来就要求 `manifest.migrationSequence === expectedMigrationSequence`（`verify.ts:232-235`），跨迁移版本的旧导出本来就不能导入，所以这不是本次额外引入的兼容性破坏；如果以后希望跨版本恢复，需要另做版本升级而不是只加必填字段。
- **迁移号**：`migration-engine.ts` 加 91，`schema-catalog.ts` 加两张表，`workspace-lifecycle-audit.mjs` 的 `SUPPORTED_SCHEMA_MAX` 改为 91，迁移契约测试同步，使用一致。
- **提示词 id / manifest / golden / parser**：`memory.conversation-review`、`memory.conversation-review.day` 在 catalog 和 manifest 里成对登记，golden 文件和 `parseConversationReview` 契约测试都更新。
- **DB 约束**：
  - `status` 集合 `running/completed/failed/gave_up` 与 TypeScript 类型一致；
  - `attempts` DB 允许 1–100，业务最大 3，导入 schema 允许 1–100，一致；
  - `error_code` DB 1–128，业务用大写正则，导入 schema 只校验长度，这是宽松但不会让导入失败；
  - `before_superseded_by` 无 FK，导出/verify 会检查它指向导出文件里的记忆，导入时不在文件里的会置 null，使用端能接受；
  - `id` 的 300 vs 网关 128 是唯一明确不一致，见问题 1。
- **导入的合成 episode id**：`import.ts:509-510` 写入 `data-import-episode:${item.id}` 和 `episode_created_at = item.startedAt`，而 `position` 会用 `(episode_created_at, episode_id)` 做全局游标。导入的合成记录因此也参与游标。**这是推测性风险**：如果导入的时间晚于目标实例真实日摘要，可能让后续回看跳过真实段落；如果目标实例已有更晚的 episode，则影响较小。建议导入的回看记录不要参与游标，或给它们一个不会与真实 episode 冲突的排序键。
