# 记忆抽取整轮事务方案

## 结论摘要

1. **事务边界放在持久化层的一次写 worker 请求里**，新增 `memoryCapture.commitRound` 操作；应用层只负责“抽取 + 生成一份完整写计划”，随后一次调用提交。事务在 better-sqlite3 的写连接上同步执行，绝不在多个 async 端口调用之间开事务。
2. **读、写两个连接的问题用“计划时读、提交时在写事务里重新校验”解决**：计划阶段可以走只读连接拿当前状态；真正决定提交的读取全部在写 worker 的事务内用写连接做，版本不符就整轮回滚并重新计划。
3. **幂等靠三层**：已有确定性 ID + 各写入的 `ON CONFLICT`/重复检查 + 同一事务末尾写一条按 `generationId` 的“本轮已提交”标记。重试先查标记，已提交就直接返回，不重复写历史、提醒、人物、审批和决策记录。
4. **写失败不再按候选逐条放弃**：事务回滚后整轮可重新计划并重试；待补队列保留该轮。这样才达到 Andy 的“失败后整轮可安全重试，重试不产生重复”。这需要取代 [ADR 0222](../../docs/adr/0222-retry-and-queue-failed-memory-capture.md) 决定 4 中“存记忆失败直接放弃”的做法。
5. 涉及新增一张幂等标记表，属于改表任务，必须按约束排队，并与 PR 395（做梦记忆）协调。

---

## 一、方案依赖的前提

### 已读代码 / 一手来源证实的

**P1. 当前整轮写入确实是多次独立写库调用。**
`apps/agent-service/src/production-memory-capture.ts:1188-1205`：

```ts
async #commit(plan: CapturePlan, parsed: ParsedMemoryCandidates): Promise<void> {
  ...
  await service.processCommittedRun({...});
}
```

`packages/application/src/services/automatic-memory-service.ts:164-252` 按候选循环；每次调用 `commitCandidate`。`commitCandidate` 内分别调用 `content.store`（第 452、488 行）、`product.applyProposal`（第 549 行）、`ledger.append`（第 478 行）、`onCommitted`（第 552 行）。`requestApproval` 里还调用 `approvals.create`（第 416 行）和 `candidates.store`（第 440 行）。这些调用当前没有共同事务。

**P2. `saveWithProjection` 只覆盖“单条记忆”的原子写，不覆盖整轮。**
`packages/persistence-sqlite/src/sqlite-memory-operations.ts:694-730`：

```ts
return this.database
  .transaction(() => {
    const saved = this.save(input);
    this.proposeJob({ job: input.job, requeueCompleted: false });
    if (input.ledger) insertLedgerRow(this.database, input.ledger);
    if (input.consolidation)
      insertConsolidationWrite(this.database, input.consolidation, this.fail);
    return saved;
  })
  .immediate();
```

它用 `expectedRevision` 检查并发（`sqlite-memory-operations.ts:806-815`）：

```ts
if (
  input.expectedRevision !== current.revision ||
  input.memory.revision !== current.revision + 1 ||
  ...
) {
  this.fail("PORT_CONFLICT", `Memory ${input.memory.id} revision or lifecycle conflict`);
}
```

`durable-memory-service.ts:164` 的取代仍是另一次调用：

```ts
if (proposal.supersedes) await this.supersede(proposal.supersedes, saved, generationId);
```

**P3. 数据库访问是一个写 worker + 多个只读 worker，每次端口调用都是一条 worker 消息。**
`packages/persistence-sqlite/src/sqlite-execution-context.ts:125-147`：

```ts
request<TResult>(operation: string, payload: unknown): Promise<TResult> {
  ...
  this.worker.postMessage({ id, operation, payload });
}
```

`packages/persistence-sqlite/src/product-state-repository.ts:696-728`：读请求选择只读 context，写请求走唯一写 context：

```ts
return chosen.request<TResult>(operation, payload);
...
return await this.context.request<TResult>(operation, payload);
```

`packages/persistence-sqlite/src/durable-adapters.ts:904-915`：

```ts
read: (memoryId) => this.context.read("memory.read", { memoryId }),
...
saveWithProjection: (input) => this.context.write("memory.saveWithProjection", input),
```

**P4. better-sqlite3 的事务函数必须同步跑完，不能跨 `await` 或事件循环。**
官方 API 文档：<https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md>，原文：

> “Transaction functions do not work with async functions. Technically speaking, async functions always return after the first `await`, which means the transaction will already be committed before any async code executes. Also, because SQLite serializes all transactions, it's generally a very bad idea to keep a transaction open across event loop ticks anyways.”

同页还写：

> “Transaction functions can be called from inside other transaction functions. When doing so, the inner transaction becomes a savepoint.”

**P5. SQLite 同一时刻只有一个写事务，读连接看到的是自己的快照。**
SQLite 官方文档：<https://www.sqlite.org/lang_transaction.html>，原文：

> “SQLite supports multiple simultaneous read transactions coming from separate database connections, possibly in separate threads or processes, but only one simultaneous write transaction.”

> “While a read transaction is active, any changes to the database that are implemented by separate database connections will not be seen by the database connection that started the read transaction.”

WAL 文档：<https://www.sqlite.org/wal.html>，原文：

> “since there is only one WAL file, there can only be one writer at a time.”

**P6. 现有 ID 基本已经是确定性的。**
`apps/agent-service/src/production-memory-capture.ts:1053`：

```ts
const generationId = createMemoryGenerationId(`memory-capture:${sourceRunId}`);
```

`production-memory-capture.ts:609-610`：

```ts
memoryIdFor: (generation, ordinal) => createMemoryId(`memory:${generation}:${ordinal}`),
approvalIdFor: (generation, ordinal) => `memory-approval:${generation}:${ordinal}`,
```

`automatic-memory-service.ts:119-121`：

```ts
function ledgerId(key: string): string {
  return `ledger:${bytesToHex(sha256(utf8ToBytes(key))).slice(0, 40)}`;
}
```

载荷 ref 是 `memory-content:${generation}:${ordinal}`（`production-memory-capture.ts:588`），候选载荷 ref 是 `memory-candidate:${request.id}`（第 536-538 行）。

**P7. 当前写失败是“放弃”，因为过去没有整轮事务。**
`production-memory-capture.ts:867-880`：

```ts
async #save(plan: CapturePlan, parsed: ParsedMemoryCandidates): Promise<void> {
  const { backlog } = this.options;
  try {
    await this.#commit(plan, parsed);
  } catch (error) {
    if (!backlog) throw error;
    await this.#recordFailure(plan, "capture_gave_up", captureErrorCode(error), "save").catch(
      this.options.onFailure,
    );
    await this.#settle(plan.generationId);
    throw error;
  }
```

ADR 0222 第 56 行明确解释了原因：

> “模型已经给出结果、开始写记忆之后失败……这一次存可能已经写进一部分：存记忆是按候选逐条写的，外面没有整体事务。”

**P8. 生成记录 / checkpoint 记录当前在 `#commit` 之前就写了。**
`production-memory-capture.ts:1150-1185` 的 `#prepare` 在模型结果之后先调用：

```ts
await this.options.generations.request({
  jobId: createCheckpointJobId(`checkpoint:memory-capture:${plan.sourceRunId}`),
  generationId: plan.generationId,
  ...
});
```

`packages/persistence-sqlite/src/sqlite-checkpoint-operations.ts:280-380` 在事务中先插 `thread_checkpoint_jobs`（第 327-347 行），再插 `memory_generations`（第 350-363 行）。这意味着即使后面记忆写失败，生成记录也会残留。

**P9. 单项写入大多幂等，但并非所有写入都幂等。**
- 决策记录：`sqlite-decision-ledger-operations.ts:128-133`，`INSERT ... ON CONFLICT (id) DO NOTHING`。
- 审批：`sqlite-memory-operations.ts:1966-1993` 按 `(generation_id, source_ref, candidate_ordinal)` 查重并比较字段，相同则返回已有。
- 提醒：`sqlite-memory-reminder-operations.ts:94-100`，`ON CONFLICT (memory_id) DO UPDATE`。
- 人物：`sqlite-memory-book-operations.ts:338-341`、`381-384` 多处 `ON CONFLICT DO NOTHING`。
- 但 `unchanged` 候选会追加历史：`durable-memory-service.ts:112-117` 的 `appendHistory` 没有幂等键，重复执行会多出 `reaffirmed` 历史。
因此“所有单条写入都天然幂等”不成立，必须有整轮提交标记。

**P10. 载荷加密使用随机 nonce，同一明文重试会得到不同密文。**
`packages/platform-node/src/payload-protector.ts:203`：

```ts
const nonce = this.#secureRandom(12);
```

第 191 行默认 `secureRandomBytes`。因此不能把“密文逐字节相同”当作幂等条件；应比较 `ref`、作用域和分级，或比较明文 `contentDigest`。

**P11. `onAudit` 目前是诊断回调，不写数据库。**
`apps/agent-service/src/service-main.ts:2377-2385`：

```ts
onAudit: (record) => {
  writeServiceDiagnostic(errorOutput, {
    component: "agent-service",
    event: "memory-capture.audit",
    ...
  });
},
```

`apps/agent-service/src/production-http-composition.ts:1092` 只是传给组合层。生产主路径已核实；其他组合是否也纯诊断，未全部核实。

**P12. 提示词规则要求只追加、会变的值放最后。**
`.claude/rules/prompt-prefix.md:27-28`：

> “固定的在前，会变的在后。”
>
> “每轮都会变的内容只放在最后一条用户消息里。例如当前时间、本轮选中的记忆、本轮资料、工具状态、运行环境说明。”

第 35 行：

> “已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。”

`docs/adr/0199-show-memory-dates-to-the-model.md:42` 也写明记忆日期只放最后一条消息。

**P13. I-73 的教训：产生值的一端和使用值的一端必须逐项核对校验。**
`docs/incidents-and-gates.md:112` 原文：

> “#207 让模型清单从 Magpie 动态获取……但发送消息、保存偏好、沙箱合约里所有 `modelRef` 字段共用的 `machineString` 规则只允许字母数字和 `._:-`，不允许斜杠。……双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」”

### 未核实

- 没有运行任何测试；下面的测试建议是设计，不是已执行结果。
- PR 395（做梦记忆）的具体 diff 没有读；只知道它也改 `durable-memory-service.ts`、`sqlite-memory-operations.ts`、`automatic-memory-service.ts`、`production-memory-capture.ts`。
- 新增表是否必须进入数据导出清单，未读完 `data-export` 的全部表清单，未核实。
- `onAudit` 在除 `service-main` / `production-http-composition` 之外的组合里是否也纯诊断，未全部核实。

---

## 二、方案

### 2.1 事务边界：放在 persistence-sqlite 的写 worker

新增一个应用端口：

```ts
export interface MemoryCaptureRoundCommitPort {
  commit(round: MemoryCaptureRoundWrite): Promise<MemoryCaptureRoundResult>;
}
```

生产实现通过 `SqliteDurableAdapters` 调一次：

```ts
this.context.write("memoryCapture.commitRound", { round });
```

`SqliteDurableOperations.execute` 增加 `memoryCapture.commitRound` 分支，交给新的 `SqliteMemoryCaptureRoundOperations`。整个 `commitRound` 是一个同步方法，内部一次性：

```ts
const now = round.committedAt;
return this.database.transaction(() => {
  const marker = this.readCommitMarker(round.generationId);
  if (marker) return this.replayResult(marker, round);

  this.insertGenerationAndCheckpoint(round.generation);
  for (const payload of round.payloads) this.putPayloadIfAbsent(payload);
  for (const memory of round.memories) this.applyMemoryWrite(memory);
  for (const approval of round.approvals) this.createApproval(approval.request);
  for (const payload of round.candidatePayloads) this.putPayloadIfAbsent(payload);
  for (const ledger of round.ledger) insertLedgerRow(this.database, ledger);
  for (const reminder of round.reminders) this.schedule(reminder);
  for (const people of round.people) this.recordPeople(people);

  this.insertCommitMarker(round, now);
  return round.result;
}).immediate();
```

关键点：

- 这是**一个 worker 请求**，不是多个端口调用。
- better-sqlite3 内部再调用已有的 `saveWithProjection` 等事务函数时会变成 savepoint（P4 官方文档原话），所以可以复用现有 `save` / `createApproval` / `insertLedgerRow` 等核心写函数；更稳妥的做法是把它们的“事务外壳”拆成 `...Core`，外层只开一次事务。
- 事务内不允许出现 `await`。worker 收到消息后同步跑完、返回结果。

为什么不把事务放在应用层、用 Prisma 式交互事务跨端口调用：端口每次调用都是一条 worker 消息（P3），而 better-sqlite3 明确说事务不能跨 async/事件循环（P4）；同时 SQLite 只有一个写者（P5），把事务挂在 worker 上等待主线程下一条消息，会让其他写请求被阻塞或误入同一事务。Prisma 文档也直接警告：

> “Queries on `db` run on their own connection, outside the open transaction, so they commit immediately and won't roll back with the rest of the callback.”
>
> 来源：<https://www.prisma.io/docs/orm/fundamentals/transactions>

这正对应本项目“读走只读连接、写走写连接”的风险。

### 2.2 应用层只做“计划”，不直接写

把 `AutomaticMemoryService.processCommittedRun` 拆成两段：

1. **抽取与决策**：沿用现有 `extract`、敏感分级、阈值、tentative、审批判断。
2. **生成写计划**：对每个候选计算出：
   - 需要写入的载荷（memory content、quote、discarded content、候选文本），载荷由 `protector.protect` 在事务外生成；
   - 记忆提议 `ProductMemoryProposal`；
   - `expectedRevision`（更新/合并时，从当前状态读出；创建时为 `null`）；
   - 决策记录 `DecisionLedgerWrite`；
   - 审批请求、候选载荷 ref；
   - 提醒、人物；
   - 生成/checkpoint 记录；
   - 一个统一的 `committedAt` / 各操作时间（全部来自同一轮计划，保证计划内部一致）；
   - 预计算的返回结果（committed/tentative/approval ids）。
3. **一次提交**：`commitRound(plan)`。
4. **提交成功后才发审计**：`onAudit` 记录在计划里先收集，`commitRound` 成功返回后再逐条发出；失败则只发失败审计。否则事务回滚了，诊断里却写着 `auto_committed`，会误导。

计划阶段的读取可以继续走只读连接；这些读取只用于生成“预期值”，不能作为提交依据。真正的提交依据在 worker 事务里重新读。

### 2.3 写事务里的重新校验

worker 在事务内重新读权威状态，规则如下：

- **创建**：
  - 若同一 `memoryId` 不存在：按 `revision: 1` 插入，写历史、投影任务、决策记录。
  - 若已存在且是同一提议（owner、agent、contentRef、classification、policyVersion、inference、confidence、sourceRefs 集合都相同）：复用该记录，确保投影任务存在，不重复写历史。
  - 若已存在但内容不同：`PORT_CONFLICT`，整轮回滚。
  - 创建成功且计划带 `supersedes`：在**同一事务内**读被取代记忆；只有它仍是 active、未被取代、同 owner/agent 时，才用事务内读到的 `current.revision` 走一次 `saveWithProjection` 标为被取代。若期间已被别人取代，则跳过取代（与现有 `supersede` 的语义一致）。
- **更新/合并**：
  - 事务内读当前记录；
  - `current.revision !== expectedRevision` 就 `PORT_CONFLICT`；
  - 否则按现有 `nextRecord` 逻辑写新 revision、历史、投影、决策记录。
- **unchanged**：
  - 事务内读当前记录；active 且未被取代则追加 `reaffirmed` 历史；tentative 则确认。
  - 幂等性由整轮提交标记保证，不依赖历史表。
- **审批**：
  - 先插生成记录（满足 `memory_approval_requests.generation_id` 外键）；
  - `createApproval` 的重复检查按 `(generation_id, source_ref, candidate_ordinal)`，同内容返回已有；
  - 同事务写候选载荷。
- **提醒 / 人物**：
  - 必须排在记忆插入之后，因为它们都要检查 `memory_records` 存在（`sqlite-memory-reminder-operations.ts:88-91`、`sqlite-memory-book-operations.ts:317-320`）。
- **决策记录**：
  - `INSERT ... ON CONFLICT (id) DO NOTHING`（P9）。
- **生成 / checkpoint**：
  - 建议也放进同一事务。否则“整轮失败”后仍会残留 `thread_checkpoint_jobs` / `memory_generations`，不满足“整轮所有写库全回滚”。
  - 由 worker 按现有 `threadDistillation.request` 的校验和插入逻辑执行；同一 identity 已存在且一致则复用，不一致则 `PORT_CONFLICT`。

### 2.4 读写两个连接

- **事务内所有决定提交的读取，一律用写连接 / 当前 `database` 对象**：载荷是否存在、记忆当前 revision、审批是否重复、提醒/人物指向的记忆是否存在、生成记录是否存在。
- **只读连接只用于计划阶段的“预读”和提交后的查询**。计划阶段的预读可能过期，所以 worker 必须重新校验；提交成功后新的读事务能看到 WAL 已提交内容。
- 禁止在事务内调用 `this.context.read(...)`，也禁止在事务内调用任何会路由到只读 worker 的端口。Prisma 文档对“在事务里用 `db` 而不是 `tx`”的警告就是这个问题的一手说明。

### 2.5 跨调用的异步

事务外完成的异步工作：

- 读取原消息、前一条助手消息、当前相关记忆、现有记忆、人物、子分类；
- 调用模型抽取；
- 出口遮盖 / 占位符处理；
- `protector.protect` 生成密文载荷；
- `clock.now()` 取时间；
- 读取记忆设置（暂停开关）。

事务内只做同步 SQLite 操作。这样事务持续时间是毫秒级，不包含模型调用，不会长时间占住唯一写者。

### 2.6 失败与重试：保证不重复

新增一张“本轮已提交”标记表，例如 `memory_capture_rounds`：

```sql
CREATE TABLE memory_capture_rounds (
  generation_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  source_run_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  result_json TEXT NOT NULL
) STRICT;
```

- 标记在**同一事务的最后一步**写入；此前任何失败都整轮回滚，标记不存在。
- 重试时 worker **先读标记**：
  - 标记存在且 `thread_id` / `source_run_id` / owner / agent 与请求一致：直接返回 `result_json`，不再执行任何写操作。
  - 标记存在但作用域不一致：`PORT_CONFLICT`，防止 `generationId` 被错误复用。
- 标记必须最后写，不能先写；先写会变成“未完成也标记已完成”。
- 不让标记外键指向 `memory_generations`，因为只有 rejected candidate 的轮次可能没有生成记录（`#prepare` 只有在 `parsed.candidates.length > 0` 时才请求生成，见 `production-memory-capture.ts:1153-1156`）。用 `thread_id` 外键负责线程删除时级联清理。
- 该表是运维幂等表，不是主人数据；是否导出建议和 `memory_capture_backlog` 一样排除。具体导出清单未核实。

重试策略：

- `#save` 遇到写事务失败：
  - `PORT_CONFLICT`：用同一份 `parsed` 结果重新读状态、重新生成计划，同轮最多重试 1 次；不要重新调用模型。
  - worker 退出 / 数据库忙 / 提交结果未知：保留待补队列，记录 `capture_queued`，下一轮补做；不要立即 `capture_gave_up`。
  - 补做仍按现有 `MEMORY_CAPTURE_BACKLOG_MAX_ATTEMPTS` 限次，超过才 `capture_gave_up`。
- 补做进入 `#save` 前先查提交标记；若已提交，只删队列行，不再问模型、不再写记忆。这样解决“提交成功但响应丢失”的重复问题。
- 事务回滚后，因为数据库里没有任何本轮记录，重新抽取/重新计划是安全的；即使模型输出顺序变化，也不会与半轮残留冲突。
- 不再采用“用同一份结果逐条续做”的旧思路；ADR 0222 已指出它会把“取代没做完”当成成功（ADR 0222 第 84 行）。

### 2.7 事务里允许做什么、不允许做什么

**允许：**

- 同步 SQLite `SELECT` / `INSERT` / `UPDATE`；
- 复用现有同步核心写函数（`save`、`saveWithProjection`、`createApproval`、`insertLedgerRow`、`schedule`、`recordPeople`）；
- 嵌套 savepoint；
- 纯内存的校验和拼装。

**不允许：**

- 模型调用、网络、文件读写、加解密、出口遮盖；
- `await`、定时器、事件循环让出；
- 通过只读连接或 `this.context.read` 读数据；
- 在事务内捕获错误后继续写；
- 在事务内做重试循环；
- 事务内调用外部副作用（推送、邮件、审计回调、`onCommitted` 外部动作）。数据库写入都在事务内；真正的“提交后副作用”如果在将来出现，应使用 transactional outbox：<https://microservices.io/patterns/data/transactional-outbox.html>，原文：

> “The solution is for the service that sends the message to first store the message in the database as part of the transaction that updates the business entities. A separate process then sends the messages to the message broker.”

本任务的提醒、人物、审批、决策记录、载荷都在同一个数据库里，不需要 outbox；只有跨进程/外部系统的副作用才需要。

---

## 三、测试方案（含反向用例）

### 3.1 正向：整轮全部写入

在 `test/integration/production-memory-capture.test.ts` 或 `test/integration/automatic-memory-golden.test.ts` 用真实 `SqliteProductStateRepository` + 真实 worker + 真实文件 SQLite（现有测试已是这种做法，见 `production-memory-capture.test.ts:98-118`）。

构造一轮同时包含：

- 普通 create；
- create + supersedes；
- update / merge；
- unchanged；
- tentative；
- sensitive → 待批准请求 + 候选载荷；
- 提醒；
- 人物与人物关系；
- 决策记录；
- 生成 / checkpoint 记录。

断言所有表都有对应行，且 `memory_capture_rounds` 只有一条。

### 3.2 反向：中途失败必须整轮回滚

不要去 mock 数据库。直接把一个**手工构造的完整写计划**交给 `commitRound`，让前几个操作合法、最后一个操作必然失败。例如最后一个 reminder 的 `dueAt` 是非 ISO 字符串，`schedule` 会抛 `PORT_INVALID_OPERATION`（`sqlite-memory-reminder-operations.ts:81-87`）。

断言失败后：

- `memory_records`、`memory_history_events`、`memory_projection_jobs`、`memory_provenance`、`decision_ledger`、`memory_approval_requests`、`payloads`、`memory_reminders`、`memory_people`、`memory_person_mentions`、`thread_checkpoint_jobs`、`memory_generations`、`memory_capture_rounds` 中本轮相关行数全部为 0；
- 再次提交同一 generation 的成功计划，只产生一份结果。

这个用例的真正反向保护是：**如果有人去掉外层 `.transaction(...)`、改成逐操作提交，这个用例会失败**，因为前面的行会留下。这是最关键的自动检查。

### 3.3 反向：幂等标记不能被绕过

同一份已提交计划连续调用两次 `commitRound`（模拟“提交成功但响应丢失”），断言：

- `memory_records` 仍只有一条；
- `memory_history_events` 没有重复的 `reaffirmed` / `created`；
- `memory_reminders` 只有一行；
- `memory_people` / `memory_person_mentions` 没有重复；
- `decision_ledger`、`memory_approval_requests`、`payloads` 没有重复；
- 第二次返回结果与第一次一致。

去掉提交标记后，这个用例必须失败；尤其是 `unchanged` 候选会多出 `reaffirmed` 历史，这是现有单项幂等不覆盖的地方（P9）。

### 3.4 反向：读写连接混用会失败

构造一个“计划阶段读到旧 revision，提交前另一个写入把它改掉”的用例：如果 `commitRound` 错误地信任计划里的 `expectedRevision` 而不在写事务里重读，或错误地通过只读连接读状态，最终要么丢更新，要么读到旧快照。断言返回 `PORT_CONFLICT` 或最终数据正确。这个用例保护“所有提交判断都在写事务里”。

### 3.5 事务边界与自动检查

- 目标测试：`npm run test:integration -- test/integration/production-memory-capture.test.ts`。
- `npm run check:memory-capture-retry`：现有脚本要求至少 19 条 `[P3-5]` 通过（`scripts/check-memory-capture-retry.mjs:13`）。本方案会改变“写失败放弃”的断言，需要更新这些用例和计数，否则检查会失败。
- `npm run check`：typecheck、lint、边界检查等。
- `npm run check:prompt-prefix`：本方案不改提示词，应保持通过。
- 可再加一个轻量静态检查：在写阶段源码中禁止出现 `content.store`、`ledger.append`、`approvals.create`、`candidates.store`、`onCommitted` 等直接写入调用，只允许通过 `commitRound`。这类检查能防止未来有人绕过事务，但它不是替代数据库回滚测试。

---

## 四、考虑过但不选的做法

1. **应用层开一个跨端口交互事务（Prisma `$transaction` 风格）**
   不选。端口调用是 worker 消息，事务不能跨 async/事件循环；读走只读连接会看不到事务内写入；写 worker 只有一个，挂起事务会阻塞其他写。依据 P3、P4、P5。

2. **每个候选一个事务，最后再写一个“整轮完成”标记**
   不选。仍然是半轮可见状态；中途失败后标记不存在，但前面的记忆已经写进去了，不满足 Andy 的“要么全成功，要么全回滚”。

3. **只在 SQLite 里逐条 `INSERT OR IGNORE`，不新增提交标记**
   不选。`unchanged` 的 `reaffirmed` 历史不幂等（P9）；提交成功但响应丢失后重放会重复写历史、重复更新、重复安排提醒。确定性 ID 只能防主键重复，防不了追加型写入。

4. **用 `memory_generations.status = 'completed'` 当提交标记**
   不选。自动记忆捕获的 generation 当前是 `pending`，而且只有候选数 > 0 才创建；rejected-only 轮次没有 generation 行。把捕获 generation 改成 completed 还可能干扰整理/蒸馏对 generation 状态的假设（未完全核实，但风险明确）。

5. **把整轮变成一个 append-only 事件，再异步投影到记忆表（event sourcing / outbox）**
   不选。对内部同库写入来说增加了第二套状态和延迟；本轮结束后下一轮就要读到记忆，异步投影会引入新的不一致窗口。outbox 只在需要跨进程/外部副作用时才有必要。

6. **写失败继续按 ADR 0222 直接 `capture_gave_up`**
   不选。那是“没有事务时唯一安全的选择”；有整轮事务和提交标记后，整轮重试才是更符合目标的方案。需要更新 ADR 和产品文案。

7. **把解析后的候选计划先单独写进待补队列，再提交记忆**
   暂不选。能减少重试时重新调用模型，但会在事务外多一次写库，并且引入“计划已存、记忆未提交”的新状态。可以作为后续优化；当前目标是先把整轮写库做成一个事务。

---

## 五、风险与反例

1. **计划阶段读到旧数据、事务内又不重读** → 丢更新。反例：用户在两轮之间手动编辑了某条记忆，捕获计划仍按旧 revision 更新，覆盖用户编辑。必须用 `expectedRevision` 在写事务里重读。
2. **事务里出现 `await`** → 事务已提交但后续代码还在跑，或者其他写请求被卷进同一个事务。反例：在 `commitRound` 里 `await this.schedule(...)`，better-sqlite3 会按 P4 的方式提前提交。
3. **用只读连接做事务内判断** → 看不到本事务刚插入的记忆/载荷，或看到旧快照；提醒/人物会误报“Memory not found”。
4. **载荷幂等按密文比较** → 同一明文每次随机 nonce 不同（P10），重试会误判冲突或覆盖。应按 `ref` + owner/agent + classification 判断。
5. **提交标记先写后做** → 中途失败留下“已完成”标记，后续重试直接跳过，整轮丢失。
6. **提交标记外键指向 `memory_generations`** → rejected-only 轮次没有 generation 行，标记插入失败。应挂 `thread_id`。
7. **审计在事务内/提交前发出** → 回滚后诊断仍显示 `auto_committed`。应提交成功后再发。
8. **忘记把生成/checkpoint 行放进事务** → 记忆全回滚，但 `thread_checkpoint_jobs` / `memory_generations` 残留，仍不是“整轮回滚”。
9. **`recordPeople` / `schedule` 排在记忆插入之前** → 外键检查失败。
10. **外部副作用放进事务** → 回滚不会撤销推送/邮件。将来需要时用 outbox（P 的 outbox 来源）。
11. **与 PR 395 的文件/迁移冲突** → 两个线程都改 `durable-memory-service.ts`、`sqlite-memory-operations.ts`、`automatic-memory-service.ts`、`production-memory-capture.ts`；迁移号也可能冲突。必须等改表任务排队，并先合并/重放 395 的“重试时补做取代、版本检查与写库之间的空隙”。

---

## 六、需要人拍板的取舍

1. **是否接受新增 `memory_capture_rounds` 表。** 这是保证“提交成功但响应丢失”不重复的最干净做法，但属于改表，必须排队，并与 PR 395 协调。
2. **是否把生成 / checkpoint 记录也纳入整轮事务。** 我建议纳入；代价是 `memoryBook.latestGeneration` 等读取生成记录的地方，看到这一轮的时间会从“模型调用后”推迟到“记忆事务提交后”。是否属于“整轮所有写库”，需要 Andy 确认。
3. **是否改掉 ADR 0222 的“写失败直接放弃”。** 本方案要求改成“失败保留待补队列、整轮重试”。这会改变网页/周报文案和 `[P3-5]` 测试数量。
4. **审计回调的时机。** 建议全部改成提交成功后发；如果现有诊断依赖“处理到哪个候选就立刻记一条”，需要确认可接受顺序变化。
5. **重试时是否重新调用模型。** 本方案在“事务回滚”后重新抽取是安全的，但会多花一次模型钱；如果不想再花钱，需要额外设计“计划持久化”，那是另一个事务外写入问题。建议先接受重抽。

---

## 七、必答问题逐条回答

### 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**不会改变已发出的请求开头。**

依据：

- 改动只发生在模型调用完成后的写库阶段。记忆抽取请求由 `#plan` 的 `memoryCapturePrompt(...)` 构建（`production-memory-capture.ts:1088-1095`），本方案不动它。
- 提示词里会变的“已有记忆、人物、时间”等本来就是按固定顺序放入本次后台调用；记忆日期按 [ADR 0199](../../docs/adr/0199-show-memory-dates-to-the-model.md) 只出现在最后一条消息的数据块里。
- 新增的事务字段（提交标记、`result_json`、计划里的 `committedAt`）不会进入任何发给模型的内容。
- `onAudit` 延后到提交后只影响诊断日志，不影响模型请求。
- 因此 `npm run check:prompt-prefix` 应继续通过。

需要说明的一个副作用：以前半轮写入可能让下一轮“本轮选中的记忆”里出现半条结果；改成原子提交后，下一轮只会看到整轮全部或全部没有。这改变的是**后续轮次最后一条消息里的记忆资料**，不是已发历史的改写；仍然符合“只在末尾追加、会变的值在最后一条消息”。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**模型可见的文字不会。** 但数据库里的载荷字节可能不同，原因和边界如下：

- **密文不同**：`payload-protector.ts:203` 每次 `protect` 生成随机 12 字节 nonce，同一明文重试会得到不同密文。这是数据库内部字节，不发给模型；`contentRef` 是确定性的，提交时按 `ref` + 作用域判断是否已存在，不按密文比较。
- **时间字段不同**：计划里的 `now()` 在每次重试时可能不同；同一事务内使用同一份计划时间。时间字段不进入模型提示词。
- **集合顺序**：`sourceRefs` 在应用层 `[...new Set(...)].sort()`（`automatic-memory-service.ts:508`、`528`），实体也做了排序/去重（`sqlite-memory-operations.ts:864`）。新增的计划构建必须继续显式排序，不能依赖数据库返回顺序。
- **ID 确定性**：记忆 id、载荷 ref、决策记录 id、审批 id、提醒 id 都由 generationId + 序号 + 结果/原因确定（P6），不依赖随机数或时间。
- **提交结果 JSON**：如果存 `result_json`，它的键顺序应由代码固定；它只用于重放返回，不进入模型。

因此，对“同一段文字发给模型”这一层：没有变化。对“数据库里同一明文的密文”：可能不同，但这是加密随机 nonce 的既有属性，不会造成模型请求字节漂移。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，建议如下：

- **整轮回滚正向用例**：真实 SQLite、真实 worker，最后一个写操作故意失败；断言所有相关表 0 行。
- **反向保护**：去掉外层事务、改成逐操作提交时，这条用例必须失败（前面的行会留下）。这正是“反向用例真的会失败”的检查。
- **幂等正向用例**：同一 generation 提交两次；断言没有重复的历史、提醒、人物、决策记录、审批、载荷。
- **反向保护**：去掉提交标记后，`unchanged` 候选会多出 `reaffirmed` 历史，这条用例必须失败。
- **读写连接反向用例**：事务内改用只读连接或信任计划里的旧 revision，会读到旧快照/丢更新，用例必须失败。
- **现有检查**：`npm run check`、`npm run test:integration`、`npm run check:memory-capture-retry`、`npm run check:prompt-prefix`。
- 注意：`scripts/check-memory-capture-retry.mjs:13` 目前要求至少 19 条 `[P3-5]` 通过；改掉“写失败放弃”的语义后，相关断言必须更新，否则检查本身会失败。

未运行测试，以上是应新增/应更新的检查设计，未核实实际通过情况。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

下面逐个核对“产生端”和“使用端”。新增方案里容易踩 I-73 类问题的地方如下。

| 值 | 产生处 | 使用/校验处 | 结论 |
|---|---|---|---|
| `memoryCapture.commitRound` 操作名 | 新 `SqliteDurableAdapters.memoryCaptureCommit()` | `SqliteDurableOperations.execute` 的分支、worker 默认分发（`sqlite-worker.ts:1108-1110`） | 必须显式加 case；否则会落到“Unknown durable SQLite operation”。 |
| `generationId` | `createMemoryGenerationId("memory-capture:" + runId)`（`production-memory-capture.ts:1053`） | `createIdentifier` 正则 `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`（`identifiers.ts:39`）；`memory_approval_requests.generation_id`、`memory_projection_jobs.generation_id` 外键；新提交标记表 | 事务内必须先插 `memory_generations` 行，再插审批和投影；标记表不要用 generation 外键，否则 rejected-only 轮次会失败。 |
| `memoryId` | `createMemoryId("memory:" + generationId + ":" + ordinal)`（第 609 行） | `memory_records.id`；审批 `product_memory_id`；`reminder:<memoryId>`；`person:<memoryId>:<ordinal>`；投影任务 id | 现有长度可能接近 128 上限；不要在本改动中额外拼接更长的前缀。worker 必须按同一正则/长度接受。 |
| `contentRef`（`memory-content:...`） | `createProductionAutomaticMemory` 的 `content.store`（第 588 行） | `payloads.ref`；`save` 检查 payload 存在且分类一致（`sqlite-memory-operations.ts:743-756`）；历史 quote 检查（885-896） | 事务内 `putIfAbsent` 必须保留 owner/agent/classification；载荷已存在时不能按密文覆盖。 |
| `approvalId`（`memory-approval:...`） | `approvalIdFor`（第 610 行） | `memory_approval_requests.id`；候选载荷 `memory-candidate:<approvalId>` | 存储端没有对 id 做正则校验，但按 `(generation_id, source_ref, candidate_ordinal)` 查重；保持现有格式即可。 |
| `ledgerId`（`ledger:<40 hex>`） | `ledgerId`（`automatic-memory-service.ts:119-121`） | `validateLedgerWrite` 检查 id 1-128、outcome、reasonCode、category、confidence、时间（`sqlite-decision-ledger-operations.ts:53-117`）；`insertLedgerRow` ON CONFLICT | 现有值可接受；不要新增 outcome，否则要重建决策记录表（ADR 0222 第 58 行）。 |
| `reminder:<memoryId>` | `createProductionAutomaticMemory` 的 `onCommitted`（第 616-626 行） | `memoryReminders.schedule` 校验 dueAt/remindAt/status/repeat，并要求 memory 存在（`sqlite-memory-reminder-operations.ts:79-91`）；`ON CONFLICT (memory_id)` | 事务内必须排在记忆插入之后；id 本身没有额外校验。 |
| `person:<memoryId>:<ordinal>` | `recordPeople` 内部（`sqlite-memory-book-operations.ts:334-335`） | `memory_people.id`；后续 mentions/links；`recordPeople` 要求 memory 存在（317-320） | 事务内必须排在记忆插入之后；无显式长度校验，保持现有格式。 |
| 投影任务 id（`memory-projection:<memoryId>:<revision>:<op>`） | `durable-memory-service.ts:47-49` | `saveWithProjection` 校验 job 与 memory 的 id/revision/operation/providerRecordId（`sqlite-memory-operations.ts:712-720`）；DB 外键 | 必须与事务内实际保存后的 revision 一致；否则整轮失败。 |
| `committedAt` / `decidedAt` / `requestedAt` / `dueAt` 等时间 | 计划里的 `clock.now()` | 各存储校验 `validIsoTimestamp`（审批、决策记录、提醒、历史） | 必须使用 ISO 字符串；同一轮计划可复用同一时间，但不能用非 ISO 的本地时间。 |
| 提交标记的 `generationId` / `threadId` / `sourceRunId` / `result_json` | 计划 | 新表主键/外键；worker 重放时比对作用域 | `threadId` 用 `threads(id)` 外键级联删除；重放时作用域不一致要 `PORT_CONFLICT`，防止 generationId 复用。 |
| 返回结果里的 memory/approval ids | 计划计算 / worker 返回 | `AutomaticMemoryService` 返回值；测试断言；`#commit` 当前不读取结果 | 类型上是 `MemoryId` / `string`，没有额外 DB 校验；保持确定性即可。 |
| 错误码 | `captureErrorCode` / worker 错误 | `SAME_TURN_RETRYABLE_CAPTURE_ERRORS`（`production-memory-capture.ts:678-688`）、待补队列 `ERROR_CODE` 正则（`sqlite-memory-capture-backlog-operations.ts:6`） | 继续使用已有 `PORT_CONFLICT`、`PORT_INVALID_OPERATION`、`PORT_NOT_FOUND`、`PORT_UNAVAILABLE`；不要引入不符合大写正则的新码。 |
| 决策记录 outcome | 若新增“事务失败”结果值 | `DECISION_OUTCOMES` / 数据库 CHECK；网页/周报分组 | 建议不新增，复用 `capture_queued` / `capture_gave_up`。新增 outcome 需要重建决策记录表和相关子表（ADR 0222 第 58 行），代价大。 |
| 新表是否进入数据导出 | 迁移/`schema-catalog` | `data-export` 的表清单/校验 | 未核实。建议按 `memory_capture_backlog` 的做法排除，因为它只是幂等/待办，不是主人数据。 |

**结论**：最容易漏的是
1）新操作名没有加入 worker dispatch；
2）审批/投影外键要求 `memory_generations` 行必须先于它们插入；
3）提交标记若错误地外键到 `memory_generations`，rejected-only 轮次会失败；
4）提醒/人物必须排在记忆插入之后；
5）载荷幂等不能按密文比较。
这五点都要在实现和测试里逐项核对，不能只看改动本身。
