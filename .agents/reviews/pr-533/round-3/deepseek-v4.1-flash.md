范围：本轮核对了增量 `0ff9cc1..99f2632` 涉及的 `production-reminder-proposals.ts`、`production-reminder-writer.ts`、`production-http-composition.ts`（增量未改，仅看登记点）、`docs/architecture-v0.1.md`、`test/integration/reminder-proposals.test.ts`；为追证据又读了 proposal 箱、SQLite 记忆/提醒/删除、data-export 导入、worker 错误包装。未运行测试（本轮只允许 git 命令）；上一轮记录文件在稀疏检出中不存在，按题面摘要核对。未核实：测试在实际运行中的通过情况、生产真实账号的删除流程。

### 1. 中：来源对话被永久删除且没有剩余记忆代次时，新建提醒采纳仍会失败，新加的回退根本走不到

文件:行：`apps/agent-service/src/production-reminder-writer.ts:224`、`apps/agent-service/src/production-reminder-proposals.ts:207`、`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:662`、`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:789`、`packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:386`、`test/integration/reminder-proposals.test.ts:372`

问题：生产删除线程时强制 `foreign_keys = ON`，而 `memory_generations.thread_id` 是 `ON DELETE CASCADE`；线程被删后，它对应的记忆代次也一起消失。`writer.create` 在进入 `applyProposal` 之前就先查 `latestGeneration`，查不到直接抛 `ReminderInputError("REMINDER_MEMORY_NOT_READY")`；`execute` 的新回退只捕获 `ApplicationPortError` 的 `PORT_NOT_FOUND`，捕获不到这个更早的 `ReminderInputError`，所以“来源对话删除后照建、来源置空”在“已无任何记忆代次”的账号里不成立。新测试用 `foreign_keys = OFF` 直接删线程，故意保留了 `generation-1`，没有模拟生产删除的级联，因此测试通过掩盖了这条路径。

证据：
```ts
// production-reminder-writer.ts:224-227
const generation: GenerationId | undefined = await this.#options.book.latestGeneration(
  this.#scope(),
);
if (!generation) throw new ReminderInputError("REMINDER_MEMORY_NOT_READY");
```
```sql
-- 0001_initial_product_schema.sql:386
thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
```
```ts
// sqlite-governed-deletion.ts:662,789
database.pragma("foreign_keys = ON");
...
database.prepare("DELETE FROM threads WHERE id = ?").run(objectId);
```
```ts
// test/integration/reminder-proposals.test.ts:372-373
raw.pragma("foreign_keys = OFF");
raw.prepare("DELETE FROM threads WHERE id = ?").run(THREAD_ID);
```
```ts
// production-reminder-proposals.ts:210-216
if (
  parsed.threadId === null ||
  !(error instanceof ApplicationPortError) ||
  error.code !== "PORT_NOT_FOUND"
)
  throw error;
created = await writer.create({ ...request, sourceThreadId: null });
```

建议：先定产品语义。若确实承诺“照建”，需要让 `create` 在没有记忆代次时也能落库（或改用不随线程删除而消失的代次），并让测试走真实的 governed deletion/级联删除路径；否则把文档改成“还有可用记忆代次时照建”，并在 `execute` 里显式处理 `REMINDER_MEMORY_NOT_READY`，不要让它表现成普通执行失败。

### 2. 低：`withdraw` 先取消提醒再查代次，取消成功后会半途失败，重试也可能一直失败

文件:行：`apps/agent-service/src/production-reminder-writer.ts:387`

问题：顺序是先 `cancel`，再 `latestGeneration`，再判断记忆是否已经删除。没有代次时，提醒已经被取消，但随即抛 `REMINDER_MEMORY_NOT_READY`，记忆没有删；提案撤销失败。之后只要仍然没有代次，重试会重复“已取消 + 抛错”，撤销永远完不成，被删记忆的正文继续留在活动记忆里。即使记忆已是 `deletion_pending`/`deleted_verified`，也会因为先查代次而多抛一次错。

证据：
```ts
const remove = this.#options.memory.delete;
if (remove === undefined) throw new ReminderInputError("REMINDER_MEMORY_NOT_READY");
const reminder = await this.cancel(reminderId);
const generation = await this.#options.book.latestGeneration(this.#scope());
if (!generation) throw new ReminderInputError("REMINDER_MEMORY_NOT_READY");
const memory = await this.#options.state.read(reminder.memoryId);
if (
  memory === undefined ||
  memory.status === "deletion_pending" ||
  memory.status === "deleted_verified"
)
  return;
await remove.call(this.#options.memory, reminder.memoryId, generation);
```
建议：先读记忆状态，只有确实需要发起删除时才要求 `generation`；或者让删除不依赖“最新代次”。补一条“取消成功、删除失败、再重试”的测试；这条与上一轮第 4 条直接相关，目前没覆盖。

### 3. 低：改时间的 `execute` 可能在 `dueAt` 已过后把 `remindAt` 写成晚于 `dueAt`

文件:行：`apps/agent-service/src/production-reminder-proposals.ts:137`、`apps/agent-service/src/production-reminder-writer.ts:357`、`packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:187`

问题：`verify` 在采纳开始时检查 `dueAt > now`，但 `claim` 与 `execute` 之间会再读一次时钟。`execute` 只对 `remindAt` 取 `max(提议里的提醒时间, 现在)`，没有再次检查 `dueAt` 是否已过；若此间 `dueAt` 过期，会得到 `remindAt = now > dueAt`。`moveSchedule` 只核对归属、状态和 `updatedAt`，存储层 `update` 只校验时间能规范解析以及 `status`/`dismissedAt` 一致，都不校验 `remindAt <= dueAt`，于是会把提醒写成提醒时刻晚于事情时刻。

证据：
```ts
const remindAt =
  Date.parse(parsed.remindAt) > Date.parse(clock.now())
    ? parsed.remindAt
    : new Date(clock.now()).toISOString();
const moved = await writer.moveSchedule({
  reminderId: parsed.reminderId,
  expectedUpdatedAt: parsed.expectedUpdatedAt,
  dueAt: parsed.dueAt,
  remindAt,
});
```
```ts
// writer.moveSchedule 只查：
if (reminder.status !== "scheduled" || reminder.updatedAt !== input.expectedUpdatedAt)
  throw new ReminderInputError("REMINDER_UNAVAILABLE");
```
```ts
// sqlite-memory-reminder-operations.ts:187-192
if (
  !valid(input.dueAt) ||
  !valid(input.remindAt) ||
  (input.status === "scheduled") !== (input.dismissedAt === null)
)
  this.fail("PORT_INVALID_OPERATION", "Memory reminder update is invalid");
```
建议：`execute` 里在调用 `moveSchedule` 前重新确认 `dueAt > now`（否则抛 `REMINDER_TIME_INVALID`/`REMINDER_UNAVAILABLE`），或在 `moveSchedule` 里强制 `remindAt <= dueAt`。补一条“`verify` 后时间跨过 `dueAt`”的反向测试。

### 4. 低：新增规范时间校验、导入路径、取消后删除失败重试都还没有自动检查

文件:行：`apps/agent-service/src/production-reminder-proposals.ts:121`、`test/integration/reminder-proposals.test.ts:363`

问题：新增的 `toISOString()` 规范时间校验没有专门反向用例；来源对话删除只用 `foreign_keys = OFF` 的“假删除”测试；撤销重试只测了“`withdraw` 已经完全成功后再 undo”，没有测“取消成功、删除失败、再重试”。这些新保护被删掉时，现有测试不一定失败。

证据：
```ts
// production-reminder-proposals.ts:121-128
if (
  !Number.isFinite(dueAt) ||
  !Number.isFinite(remindAt) ||
  remindAt > dueAt ||
  new Date(dueAt).toISOString() !== parsed.dueAt ||
  new Date(remindAt).toISOString() !== parsed.remindAt
)
  return refused("提议里的时间不对");
```
测试里现有的反向用例是 `expectedDueAt` 不匹配（381-392）、缺 `memory.delete`（394-406）、“`withdraw` 已跑过再 undo”（408-420），没有构造非规范 `dueAt/remindAt`，也没有注入“删除记忆失败”。

建议：增加 handler 层构造 `"2026-11-20T01:40:00Z"` 之类非规范字符串的 `verify` 用例；用 governed deletion 或至少 `foreign_keys = ON` 模拟删除；给 `memory.delete` 注入一次失败，验证 `cancel` 后重试能删掉记忆。

### 5. 低：文档把执行阶段的时间不一致也说成“标成被取代”，实际是执行失败

文件:行：`docs/architecture-v0.1.md:434`、`apps/agent-service/src/production-proposals.ts:654`

问题：`verify` 阶段不一致确实会被 `#adoptAction` 标成 `superseded`；但 `execute` 中 `writer.create` 的 `expectedDueAt` 不一致抛 `ReminderInputError`，会被记录成 `failed` 并抛 `PROPOSAL_EXECUTION_FAILED`，不是“被取代”。文档没有说明第二次核对失败的结果。

证据：
```md
采纳时重新算出的到期时间和它不一致就标成被取代，建提醒时再核对一次
```
```ts
// production-proposals.ts:654-675
} catch (error) {
  ...
  await store.moveExecution({ ... to: "failed", ... });
  throw new ProposalError("PROPOSAL_EXECUTION_FAILED", ...);
}
```
建议：文档写清“`verify` 不一致→被取代；`execute` 再核对不一致→执行失败”，或者让 `execute` 的这类不一致也走被取代的路径。

**推测（未证实）**
- `execute` 对 `PORT_NOT_FOUND` 一律回退为 `sourceThreadId: null`，理论上如果 `PORT_NOT_FOUND` 来自别的原因（例如 payload 丢失后被重新写入），会误丢掉来源关联；我没找到生产上可达的具体路径，所以只作提示。
- `readBack`（create）只核对 `status === "scheduled"`，不核对 `dueAt`；只有在该 `proposal:<id>` 键下已经存在一条不同到期时间的旧提醒时才会误判成功，正常新代码路径下不成立。
- `undo` 的 `original` 只做字符串类型检查，不复核规范格式和 `remindAt <= dueAt`；执行原样是服务端加密载荷，未发现外部不可信输入路径。

**上一轮意见核对**
- 第 1 条（来源对话删除/导入后采纳失败）：部分改好。线程外键缺失的常见情况已由 `PORT_NOT_FOUND` 回退覆盖；但“唯一记忆代次被级联删除”的情况仍失败，且测试用 `foreign_keys = OFF` 没有模拟真实删除（见第 1 条）。
- 第 2 条（年度提醒跨日后写成下一年、读回仍报成功）：改好。`verify` 比对 `schedule.dueAt`，`writer.create` 增加 `expectedDueAt` 二次核对，测试覆盖了不匹配。
- 第 3 条（undo 解析错误码、verify 接受非规范时间）：改好。`unlessInputError` 覆盖了两个处理方的 `undo`，`reschedule.verify` 增加规范 ISO 比对；但缺自动反向用例（见第 4 条）。
- 第 4 条（缺 `memory.delete` 无检查、撤销重试无测试）：部分改好。新增了 writer 级“缺 delete 报错且提醒仍 scheduled”和“`withdraw` 后再 undo”的测试；仍缺“取消成功后删除失败再重试”，且缺 delete 的测试只测 writer，不测 `box.undo` 的错误码映射。
- 第 6 条（架构文档与代码不一致）：基本改好。文档补了“已是撤销目标时间视为完成”和绝对 `dueAt` 绑定；残留“被取代”措辞不准（见第 5 条）。

**侧重检查**
- 错误路径：来源对话删除→记忆代次级联删除（第 1 条，确认）；`withdraw` 先取消再查代次（第 2 条，确认）；`execute` 跨过 `dueAt`（第 3 条，确认）；`undo` 的 `ReminderInputError` 已统一成 `PROPOSAL_NOT_UNDOABLE`，但 `ApplicationPortError` 会原样透传（`production-proposal-control.ts:116-125`），这是既有行为，未新增缺陷。
- 不可信/不合规输入：`data` 只做类型检查，但 `reschedule.verify` 现在要求规范 ISO，`writer.create` 仍校验 `DUE_FORMAT` 和长度；`original` 未复核，但来自服务端加密载荷。
- 安全/隐私：删除线程时 `memory_records.source_thread_id` 被置空，提醒正文继续存在是设计使然；第 2 条会在无代次时留下活动记忆正文，属于残留风险。
- 资源耗尽：回退只重试一次；文本限制 500；无新增无界循环。
- 不可撤销操作：新建撤销会永久删除记忆；`withdraw` 的 cancel 幂等、delete 走 `deletion_pending` 后可重试；第 2 条的无代次场景是例外。
- 规则/文档一致性：`docs/architecture-v0.1.md:434` 与代码有两处偏差（第 1 条“照建”的适用范围、第 5 条“被取代”）。

**必答问题**
1. 发给模型的内容：本次增量没有改系统提示、工具定义、历史消息或遮盖逻辑；`registerReminderProposalHandlers` 只在组合根登记处理方，不调用模型，也不改 prompt 构建。因此仍应满足“只在末尾追加、每轮变化的值在最后一条消息”的约束。依据代码：增量只涉及提议箱/提醒写入和测试，`production-reminder-proposals.ts` 没有模型端口。
2. 同一段文字跨请求字节不同：模型可见内容不涉及。提议数据层面的 `dueAt`/`remindAt` 是从当前时钟和时区算出的绝对时间，年度提醒/只有日期的提醒在不同时刻会算出不同值，`proposalId`（含 `schedule.dueAt`）也随之不同；这是预期的时间绑定，不在模型前缀里。`externalOrigins` 按传入顺序保存，顺序不同会导致提议字节不同，但同样不影响模型请求。
3. 自动检查：新增的 `expectedDueAt` 反向用例、缺 `memory.delete` 用例、`withdraw` 后再 undo 用例、来源线程删除用例都能在对应保护被去掉时失败；但规范时间校验、真实级联删除、取消后删除失败重试没有对应用例（见第 4 条）。
4. 值的产生端与使用端：`expectedDueAt` 由 `schedulePreview` 的 `schedule.dueAt` 产生，只在 `writer.create` 消费，两边都来自同一个 `reminderSchedule`，格式一致；`reschedule.verify` 的 `dueAt/remindAt` 也由 `reminderSchedule` 的 `toISOString()` 产生，与 `toISOString()` 比对一致；回退的 `sourceThreadId: null` 被 `create` 的 `string | null` 接受；`proposalId` 通过 `PROPOSAL_ID_PATTERN` 和 `reminderKey` 的长度/格式检查。唯一断裂的两端是“来源线程删除后无记忆代次”时的产生/消费链（第 1 条）和 `remindAt <= dueAt` 这个未被任何一端校验的隐含不变量（第 3 条）。`memory.delete` 在生产组合类型里是必有的，`remove.call(this.#options.memory, ...)` 的绑定方式对 `DurableMemoryService` 正确。
