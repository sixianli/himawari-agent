## 本轮查过的范围

- 增量：`git diff 8c1606b6..0ff9cc1f`，实际改到的代码只有 `apps/agent-service/src/production-reminder-proposals.ts`、`apps/agent-service/src/production-reminder-writer.ts`（`withdraw` 4 行）和 `test/integration/reminder-proposals.test.ts`。
- 为核对两端行为跟读的旧代码：`production-proposals.ts`（`adopt`/`undo`/`propose`/指纹/编号格式）、`production-memory-capture.ts` 的 `reminderSchedule`、`sqlite-memory-reminder-operations.ts` 的 `update`/`valid`、`sqlite-memory-operations.ts` 的 `save`（`sourceThreadId` 校验）、`sqlite-owner-proposal-operations.ts` 的 `propose`（同编号刷新）、`data-export/import.ts`/`verify.ts`、`production-http-composition.ts` 的登记处、`durable-memory-service.ts` 的 `delete`。
- 没有运行测试（工具受限），测试是否通过标「未核实」；反向用例是否会失败是按代码路径推出来的。

## 上一轮意见核对（增量是否真的改好）

- 1（年度提醒绑定展示日期）：改好了。`schedule.dueAt` 进了数据、提议编号和 `verify` 比较，反向用例在 `reminder-proposals.test.ts:271`。
- 3（撤销幂等）：改时间侧改好了（`undo` 发现已是旧时间就直接返回），新建侧 `withdraw` 的 `cancel` 本身幂等；只有改时间有重试用例（`:301`）。
- 4（来源丢失）：改好了，`threadId`/`externalOrigins` 进了数据和执行，用例在 `:287`。
- 2（verify/readBack 全量校验）：只改好一部分，见下面第 3 条。
- 7（缺 `memory.delete` 静默跳过）：代码改好了，但没有自动检查，见下面第 4 条。
- 8（撤销抛 `ReminderInputError`）：主要写入路径改好了，解析路径仍会漏，见下面第 3 条。

## 侧重检查

- **不可信输入/导入**：提议的 `data` 存在加密 basis 里，数据导入只校验外层字段，不按类型校验 basis（`data-export/verify.ts:148` 只查编号/时间/状态），导入后的 `data.threadId` 原样保留。这是下面第 1 条。
- **错误路径**：`execute` 的错误会被 `#adoptAction` 记成执行失败；`undo` 只把 `ReminderInputError` 包成 `ProposalError`，解析/端口错误仍会直接冒出去（第 3 条）。
- **资源耗尽**：`externalOrigins` 的数量没有上限，只对单个 origin 做 256 截断并去重（`context-external-content.ts:37-54`）；持久层只要求 `sourceRefs` 非空（`sqlite-memory-operations.ts:672-673`），通过篡改导入的提议可以塞入大量来源行。仅在恶意导入/篡改时可达，判低。
- **不可撤销操作**：新建提醒的撤销会软删记忆（`delete`），可恢复；没有发现硬删。
- **规则/文档一致性**：`docs/architecture-v0.1.md:434` 的撤销描述没有覆盖新加的“已是旧时间就直接成功”，也没写新建提议的展示日期绑定，见第 6 条。

## 意见

### 1. 中：`reminder.create` 把来源对话编号写进提议数据，来源对话被永久删除或经导出导入后，采纳会失败

**文件:行**：`apps/agent-service/src/production-reminder-proposals.ts:308-315`、`:192-199`；`apps/agent-service/src/production-reminder-writer.ts:247`；`packages/persistence-sqlite/src/sqlite-memory-operations.ts:778-783`；`packages/persistence-sqlite/src/data-export/import.ts:857-866`、`:599-607`。

**问题**：增量把 `threadId` 写进提议 `data`，执行时再作为 `sourceThreadId` 落记忆。存储层要求这个对话在目标库里存在；但对话可以被永久删除，数据导入又明确不导入原对话、还把提议行的 `thread_id` 置成 `NULL`。结果是：主人同意后执行 `reminder.create` 会报 `PORT_NOT_FOUND`，提议变成执行失败，提醒不会创建；而修复前（来源置空）这条提议是能执行的。

**证据（读代码证实的）**：

```ts
// production-reminder-proposals.ts
data: {
  text, due: input.due.trim(), repeat,
  dueAt: schedule.dueAt,
  threadId: context.threadId,          // 写进提议数据
  externalOrigins: context.externalOrigins ?? [],
},
// execute
const created = await writer.create({ ..., sourceThreadId: parsed.threadId, ... });

// sqlite-memory-operations.ts
if (input.memory.sourceThreadId) {
  const sourceThread = this.database
    .prepare("SELECT 1 FROM threads WHERE id = ? AND owner_id = ? AND agent_id = ?")
    .get(input.memory.sourceThreadId, input.memory.ownerId, input.memory.agentId);
  if (!sourceThread) this.fail("PORT_NOT_FOUND", "Memory source Thread not found");
}

// data-export/import.ts：owner_proposals 的 thread_id 固定写 NULL
) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ...
```

导入只插入一条合成对话（`data-import-thread-...`，`import.ts:599-607`），不搬运原 `threads`；永久删除走 `DELETE FROM threads`（`sqlite-governed-deletion.ts:789`）。**推测**：因此“对话被永久删除”与“导出再导入”两种场景都会让这条约定失效。

**建议**：执行前确认 `data.threadId` 仍属于本 owner/agent 且存在；不存在就按 `null` 落库（或 `verify` 直接给出可读理由、标成被取代），而不是先 claim 再在执行阶段失败。也可在导出/导入时把该类型 basis 里的 `threadId` 置空，与 `owner_proposals.thread_id` 的处理保持一致。需要补一个“导入后采纳提醒提议”的用例。

### 2. 低：新建提醒的 `execute` 会重新按当前时间算日期，verify 与 execute 之间跨过展示日期时年度提醒会写成下一年，读回仍报成功

**文件:行**：`apps/agent-service/src/production-reminder-proposals.ts:180-188`、`:189-206`、`:296-298`；`apps/agent-service/src/production-reminder-writer.ts:205-208`。

**问题**：`verify` 用 `schedulePreview` 比较了 `dueAt`，但 `execute` 不比较，直接把 `due` 交给 `writer.create` 再算一次。两次调用之间（`verify` 之后还要 claim、读 basis）如果时钟跨过展示日期，年度提醒会滚到下一年；`readBack` 只检查 `status === "scheduled"`，于是仍报成功。窗口很短，但这是“年度提醒在过期后悄悄滚到明年”在高并发/临界时刻的残留。

**证据**：

```ts
// verify
const schedule = writer.schedulePreview(parsed.due, parsed.repeat);
if (!schedule) return refused("提醒的时间已经过了");
if (schedule.dueAt !== parsed.dueAt) return refused("提醒的时间已经变了，和提议时看到的不一样");
// execute
const created = await writer.create({ ..., due: parsed.due, repeat: parsed.repeat, ... });
// readBack
return found?.reminder.status === "scheduled" ? "matches" : "differs";
```

**建议**：`execute` 里再取一次 `schedulePreview` 并与 `parsed.dueAt` 比较，不一致就抛错；或让 `writer.create` 接受期望的 `dueAt`，不一致时拒绝。`readBack` 最好也核对 `dueAt`。

### 3. 低：`undo` 的数据解析错误仍是 `ReminderInputError`，第 8 条只修了一半；`verify` 也仍接受非规范时间

**文件:行**：`apps/agent-service/src/production-reminder-proposals.ts:93-101`、`:157-176`、`:208-212`、`:119-123`；`packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:14-17`。

**问题**：`unlessInputError` 只包住写入调用；`undo` 开头解析 `data`/`original` 失败时直接抛 `ReminderInputError`，经 `ProductionProposalControl.#failure` 原样传出（只有 `ProposalError` 会映射成 `ApplicationPortError`）。另外 `verify` 只用 `Date.parse` 判有限性，非规范 ISO（如无毫秒）或超出horizon 的值能过 `verify`，到存储层 `valid()` 才失败；`moveSchedule` 这里抛出的是端口错误而非 `ReminderInputError`，`undo` 也不会包装。

**证据**：

```ts
async function unlessInputError<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    if (error instanceof ReminderInputError) throw new ProposalError("PROPOSAL_NOT_UNDOABLE", error.code);
    throw error;
  }
}
// undo 里在包装之外：
if (!parsed || !before) throw new ReminderInputError("REMINDER_INPUT_INVALID");
```

```ts
// sqlite-memory-reminder-operations.ts
function valid(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
```

**建议**：`undo` 的解析错误也抛 `ProposalError("PROPOSAL_NOT_UNDOABLE", "REMINDER_INPUT_INVALID")`；`verify` 直接复用与存储一致的规范时间检查（含 `dueAt > now`、`remindAt <= dueAt`、horizon）。

### 4. 低：新增的“缺 `memory.delete` 就报错”没有自动检查，新建提醒撤销的重试路径也没测

**文件:行**：`apps/agent-service/src/production-reminder-writer.ts:384-398`；`test/integration/reminder-proposals.test.ts:230-252`、`:301-319`。

**问题**：第 7 条（缺 `memory.delete` 会静默留下记忆）改成了先检查再取消，但没有任何用例构造“没有 `delete` 的 writer”去确认它确实报 `PROPOSAL_NOT_UNDOABLE` 且没有先取消提醒。第 3 条对新建提醒的重试安全也只测了正常撤销，没有“取消/删记忆已成功但状态写入失败，再次撤销”的用例。搜索 `REMINDER_MEMORY_NOT_READY` 只命中 `writer.create` 的既有测试，不涉及 `withdraw`。

**证据（读代码证实的）**：

```ts
async withdraw(reminderId: string): Promise<void> {
  const remove = this.#options.memory.delete;
  if (remove === undefined) throw new ReminderInputError("REMINDER_MEMORY_NOT_READY");
  const reminder = await this.cancel(reminderId);
  ...
}
```

**建议**：加一个 fixture 让 `memory` 只有 `applyProposal`、没有 `delete`，断言撤销报 `PROPOSAL_NOT_UNDOABLE` 且提醒仍 `scheduled`；再加一个“先手动执行 `withdraw`、再 `undo`”的用例，确认重试能走到 `undone`。

### 5. 低：提议编号不含 `threadId`/`externalOrigins`，但指纹含它们，同一提醒换来源重提会在原编号上刷新版本和来源

**文件:行**：`apps/agent-service/src/production-reminder-proposals.ts:298`、`:308-315`；`apps/agent-service/src/production-proposals.ts:399-410`；`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:156-187`。

**问题**：编号只由 `text, due, repeat, schedule.dueAt` 算出，`data` 里的 `threadId`/`externalOrigins` 不进编号，但进指纹。同一条提醒从不同对话/不同外部来源再提一次，会命中同一条 pending 提议并被原地刷新（`thread_id`、basis、`version` 都变）。主人如果正拿着旧版本采纳会得到 `PROPOSAL_CHANGED`，记忆的来源也会被改成后一次。

**证据（读代码证实的）**：

```ts
const id = proposalId("reminder-create", [text, input.due.trim(), repeat, schedule.dueAt]);
// production-proposals.ts 指纹
.update(canonicalJson([input.type, input.summary, input.effect, origin, input.evidence, input.data]))
// sqlite-owner-proposal-operations.ts：existing.status === "pending" 时 UPDATE，version 依指纹 +1
```

**建议**：确认这是不是想要的行为。若来源差异应当算不同提议，把 `threadId`/`externalOrigins`（排序后）纳入编号；若希望同一条提醒只有一条提议，至少让刷新不改变来源，或在指纹里去掉不参与展示的字段。

### 6. 低：架构文档对撤销幂等和新建时间绑定的描述与增量代码不完全一致

**文件:行**：`docs/architecture-v0.1.md:434`；`apps/agent-service/src/production-reminder-proposals.ts:161-167`、`:180-187`。

**问题**：文档写“撤销只在提醒还是改后的那一版时才恢复，主人在这之间又改过就失败”，但增量代码在提醒已经等于撤销目标时间时直接返回成功（用于重试），即使版本已变。文档也没有写新建提议会把“提议时算好的绝对时间”存进数据、采纳时重新比对，而这正是第 1 条修复的核心。

**建议**：补一句“已是撤销目标时间时视为已完成”，并说明新建提议在采纳时要求重新算出的时间与提议时一致。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 这个改动完全没有组装/修改模型请求，不调模型、不动系统提示、工具定义、历史或遮盖；新增字段只进提议的加密 basis。按 `prompt-prefix.md` 第 4 条，仍然只追加，这一改动不涉及。

2. **不会让模型请求里同一段文字变成不同字节。** 改动不进入模型请求文本。会随时间变化的是提议编号里的 `schedule.dueAt`（年度提醒跨年后会变，这是有意绑定）和 `execute` 里按 `clock.now()` 重算/钳制的 `remindAt`；它们不进模型请求。同一提议重复执行最大的时间差异见第 2 条。

3. **有自动检查，且列出的反向用例按代码路径确实会失败。** 年度过期用例（`:271`，注意默认 TTL 是 30 天，11 天的推进不会让它因过期而假通过）、撤销幂等用例（`:301`）、撤销错误码用例（`:321`）、来源保留用例（`:287`）分别能在没有对应修复时失败。缺口：第 7 条的缺 `delete` 路径、新建撤销的重试路径、`remindAt > dueAt`/非规范时间的反向用例都没有；测试是否实际通过未核实（无法运行）。

4. **逐个核对两端：**
   - `dueAt`（新建）：`proposeReminderCreate` 产生，`createData` 解析、`verify` 与 `schedulePreview` 比较、编号参与哈希；存储层要求规范 ISO，正常路径由 `schedulePreview` 产生规范值。可用，但 `execute` 没有二次绑定（第 2 条）。
   - `threadId`（新建）：`context.threadId` 产生，`execute` → `writer.create` → `applyProposal` 要求对话存在。存在第 1 条的问题。
   - `externalOrigins`（新建）：经 `externalContentSourceRefs` 进 `sourceRefs`，无外键、无条数上限；正常来源可用，恶意导入时可能放大来源行数。
   - `ProposalError`/`REMINDER_MEMORY_NOT_READY`（`unlessInputError` 产出）：`ProductionProposalControl.#failure` 能接受，映射成 `ApplicationPortError` 的 code；但解析路径仍会漏（第 3 条）。
   - 提议编号前缀：`reminder-create`/`reminder-reschedule` 都满足 `/^[a-z][a-z0-9-]{0,31}:[0-9a-f]{32}$/`，类型前缀不同，128 位摘要撞号可忽略；但编号没有覆盖全部指纹字段（第 5 条）。
