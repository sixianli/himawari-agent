## 读代码后先列问题

### 1. 高：`reminder.create` 提议没有绑定主人看到的绝对时间，年度提醒会在过期后悄悄滚到明年
- 文件:行：`apps/agent-service/src/production-reminder-proposals.ts:261-273`、`:151-165`；`apps/agent-service/src/production-memory-capture.ts:268-273`
- 问题：提议时用 `schedulePreview` 算出绝对时间并展示给主人，但 `data` 只存原始 `due` 字符串，采纳时又用当时的 `now` 重算；年度重复会一直加到未来年份，于是主人看到的日期和执行出来的日期可能不是同一年。
- 证据（读代码证实）：
  - 提议时：`const schedule = context.writer.schedulePreview(input.due, repeat);`（`:261`），`const when = localTimeText(schedule.dueAt, context.timeZone);`（`:264`），说明/效果用 `when`（`:268-269`），但 `data: { text, due: input.due.trim(), repeat }`（`:273`）。
  - 采纳时：`verify` 再次 `schedulePreview(parsed.due, parsed.repeat)`（`:154`），`execute` 再调 `writer.create({ text, due: parsed.due, repeat })`（`:160-165`）。
  - 年度规则：`if (yearly) for (...) if (resolved.due <= sent) resolved = resolve(laterYear(local, years))`，最后只要求 `resolved.due > sent`（`production-memory-capture.ts:268-273`）。
  - 场景（推测，基于代码）：2026-12-01 提议“2026-12-25 09:00、每年一次”，主人看到 2026-12-25；30 天有效期内于 2026-12-30 采纳，`verify` 重算成 2027-12-25 仍通过，`execute` 实际建的是 2027 年那条。非年度提醒同样场景会报 `REMINDER_TIME_INVALID`，两者行为不一致。
- 建议：像 `reschedule` 一样在 `data` 里存提议时算好的 `dueAt`/`remindAt`（或至少存解析后的绝对日期），`verify` 核对“重算结果 === 提议时结果”，不一致就直接取代；`execute` 用存下来的绝对时间建提醒，而不是重新解析相对日期。补一条“提议后跨过年度日期再采纳”的反向用例。

### 2. 中：改时间的 `verify`/`readBack` 没有重新校验 `dueAt`/`remindAt` 的全部规则，不可信提议数据可能写出“提醒时间在到期之后”等异常值
- 文件:行：`apps/agent-service/src/production-reminder-proposals.ts:103`、`:111-120`、`:129-135`；`apps/agent-service/src/production-reminder-writer.ts:364-380`
- 问题：`verify` 只检查 `dueAt > now`，没有检查上限、格式、`remindAt` 是否有限、`remindAt` 与 `dueAt` 的关系；`execute` 只把 `remindAt` 向上夹到 `now`；`readBack` 只比较 `dueAt`，所以异常 `remindAt` 也会被记成成功。提议数据来自加密 basis，数据导出/导入会把 basis 作为不透明 JSON 原样带回（`packages/persistence-sqlite/src/data-export/schemas.ts:274`），不能假定一定由本次的 `proposeReminderReschedule` 生成。
- 证据（读代码证实）：
  - `if (Date.parse(parsed.dueAt) <= Date.parse(clock.now())) return refused(...)`（`:103`）——只有下界；`Date.parse` 为 `NaN` 时比较为 false，会放行。
  - `const remindAt = Date.parse(parsed.remindAt) > Date.parse(clock.now()) ? parsed.remindAt : new Date(clock.now()).toISOString();`（`:111-114`）——只向上夹，`remindAt > dueAt` 不会被发现。
  - `moveSchedule` 只是把 `dueAt`/`remindAt` 交给 `reminders.update`（`:371-379`）；SQLite 只校验 ISO 格式和 `status`/`dismissedAt` 关系，不校验时间前后关系（`packages/persistence-sqlite/src/sqlite-memory-reminder-operations.ts:187-192`）。
  - `readBack` 只看 `status === "scheduled" && dueAt === parsed.dueAt`（`:133`）。
- 建议：把 `reminderSchedule` 的格式、两年上限、`remindAt <= dueAt`（或精确等于 `max(dueAt - 1h, now)`）等规则抽成一个校验函数，`verify` 和 `execute` 都调用；`readBack` 至少同时核对 `remindAt`。对非法 `Date.parse` 明确拒绝。

### 3. 中：改时间的撤销不是幂等的，撤销成功但后续状态写入失败后，重试会永久失败
- 文件:行：`apps/agent-service/src/production-reminder-proposals.ts:137-147`；`apps/agent-service/src/production-reminder-writer.ts:364-365`；`apps/agent-service/src/production-proposals.ts:752-766`
- 问题：`undo` 用执行后的版本 `before.updatedAt` 作为条件。如果 `moveSchedule` 已把时间改回去、但随后 `store.moveExecution` 失败，提醒时间已恢复而提议仍是 `succeeded`；再次撤销时当前 `updatedAt` 已不是 `before.updatedAt`，`moveSchedule` 抛 `REMINDER_UNAVAILABLE`，撤销再也完不成。作者说“只在主人中途改过时才失败”，这里还有“撤销自身部分成功”这一条。
- 证据（读代码证实）：
  - `await writer.moveSchedule({ expectedUpdatedAt: before.updatedAt, dueAt: before.dueAt, remindAt: before.remindAt });`（`:141-146`）。
  - `moveSchedule` 中 `if (reminder.status !== "scheduled" || reminder.updatedAt !== input.expectedUpdatedAt) throw ...`（`:364-365`）。
  - `production-proposals.ts` 先 `await handler.undo(...)`（`:752`），再 `store.moveExecution(...)`（`:753-760`）；两者不是一个原子操作。
- 建议：`undo` 先读当前提醒，如果 `status === "scheduled"` 且 `dueAt`/`remindAt` 已等于 `before`，直接视为已撤销并返回；否则再按版本条件改。这样既保留“主人改过就失败”，又能重试。补一条“撤销已恢复时间但状态未落盘”的用例。

### 4. 中：通过提议新建的提醒记忆丢掉了对话来源和外部内容标记
- 文件:行：`apps/agent-service/src/production-reminder-proposals.ts:273`、`:160-165`；`apps/agent-service/src/production-reminder-writer.ts:183-184`、`:247-251`
- 问题：`reminder.create` 的 `data` 只有 `text/due/repeat`，执行时调 `create` 没有传 `sourceThreadId` 或 `externalOrigins`。同一个 `create` 被 `reminder_set` 调用时会传这两个值（`:503-506`）。结果是提议新建的提醒记忆 `sourceThreadId` 永远为 null，且没有 `external-content:` 来源引用。
- 证据（读代码证实）：
  - 提议数据：`data: { text, due: input.due.trim(), repeat }`（`:273`）。
  - 执行：`writer.create({ key, text, due, repeat })`（`:160-165`），没有来源字段。
  - `create` 支持并有条件写入：`readonly sourceThreadId?: string | null; readonly externalOrigins?: readonly string[];`（`writer:183-184`），`sourceThreadId: (input.sourceThreadId ?? null) ...`、`...externalContentSourceRefs(memoryId, input.externalOrigins ?? [])`（`writer:247-251`）。
  - 记忆召回用 `sourceRefs` 判断外部内容：`if (carriesExternalContent(memory.sourceRefs)) externalContent = true;`（`apps/agent-service/src/production-memory-recall.ts:264`）。缺少外部引用时，这条来自外部内容的提醒记忆会被当成普通内部记忆。
- 建议：在提议数据中带上 `threadId` 和外部来源（或让 `execute` 拿到提议行的 `threadId`），执行时传给 `create`；同时确保 `externalContentSeen` 对应的来源引用真正落到记忆上。补一条外部内容提议新建的用例。

### 5. 中低：提议入口没有按导出结构校验 `source.ref`/`source.version`（I-73 同一类）
- 文件:行：`apps/agent-service/src/production-reminder-proposals.ts:275`（以及 `:248` 的默认来源）；`packages/persistence-sqlite/src/data-export/schemas.ts:251-260`
- 问题：`context.source` 原样交给 `box.propose`；`box.propose` 只校验提议编号、类型、说明和效果，不校验来源长度（`production-proposals.ts:365-372`），SQLite 的 `propose` 也只校验“有版本必须有来源”（`sqlite-owner-proposal-operations.ts:152-153`）。导出结构声明 `sourceRef` 1–256、`sourceVersion` 1–128、`type` 1–64、`summary/effect` 1–200。
- 证据（读代码证实）：`...(context.source ? { source: context.source } : {})`（`:275`）；导出 schema 的 `sourceRef: nullable(text(1, 256))`、`sourceVersion: nullable(text(1, 128))`（`schemas.ts:258-259`），导入时 `parseLines(..., OWNER_PROPOSAL_SCHEMA)` 会按 schema 校验（`data-export/verify.ts:503-507`）。
- 建议：像 `production-owner-rules.ts:612-622` 的 `ruleSource` 一样，在入口截断或拒绝超长来源；`box.propose` 也可以统一加长度校验，避免每个提议方各自记得。

### 6. 中低：显示用 `context.timeZone`、计算用 writer 自己的 `timeZone`，两处没有一致性检查
- 文件:行：`apps/agent-service/src/production-reminder-proposals.ts:221`、`:229-236`、`:261-269`；`apps/agent-service/src/production-reminder-writer.ts:350-352`
- 问题：`schedulePreview` 用 `this.#options.timeZone` 计算 `dueAt`，说明和效果句用 `context.timeZone` 格式化。如果以后的调用方传入的 `context.timeZone` 和 writer 构造时的 `timeZone` 不一致，主人看到的“几点”就不是实际要触发的几点。
- 证据（读代码证实）：`const schedule = context.writer.schedulePreview(input.due, ...)`（`:221`），随后 `localTimeText(schedule.dueAt, context.timeZone)`（`:229-230`）；writer 内 `return reminderSchedule(due, repeat, this.#options.clock.now(), this.#options.timeZone);`（`writer:351`）。两个时区来源相互独立。
- 建议：只保留一个来源。可以让 writer 暴露只读的 `timeZone` 给提议入口，或让 `proposeReminder*` 直接接收并校验与 writer 一致；文档里“按主人时区算好”才真正成立。

### 7. 低：`withdraw` 在 `memory.delete` 缺失时静默跳过删除，撤销会报成功但留下记忆
- 文件:行：`apps/agent-service/src/production-reminder-writer.ts:125-126`、`:384-398`；`apps/agent-service/src/production-reminder-proposals.ts:174-178`
- 问题：`delete` 被声明为可选；`withdraw` 取消提醒后如果 `remove === undefined` 就直接返回，提议箱会把创建撤销记成成功，但那条记忆仍然存在。当前 HTTP composition 传的是完整 `DurableMemoryService`，所以生产路径有 `delete`；但类型允许构造“不能完整撤销”的 writer，而且注册函数不检查。
- 证据（读代码证实）：`readonly memory: Pick<DurableMemoryService, "applyProposal"> & Partial<Pick<DurableMemoryService, "delete">>;`（`:125-126`）；`const remove = this.#options.memory.delete; if (remove === undefined) return;`（`:386-387`）。
- 建议：给提议处理方用的 writer 类型要求必须有 `delete`，或在缺失时抛错而不是静默成功；至少加日志/测试覆盖。

### 8. 低：撤销失败时抛出的是 `ReminderInputError`，没有映射成 `ProposalError`
- 文件:行：`apps/agent-service/src/production-proposals.ts:752`；`apps/agent-service/src/production-proposal-control.ts:116-125`、`:184-186`
- 问题：`handler.undo` 的异常在 `ProductionProposalBox.#undoOnce` 里没有包装；而控制层只把 `ProposalError` 转成稳定的应用错误码，其他异常原样抛给网关。主人中途改过提醒时，客户端收到的是 `REMINDER_UNAVAILABLE` 之类的实现错误，而不是稳定的“不可撤销/已改变”错误码。
- 证据（读代码证实）：`await handler.undo({ ... });` 没有 try/catch（`production-proposals.ts:752`）；`#failure` 只处理 `error instanceof ProposalError`（`production-proposal-control.ts:117-124`）。
- 建议：在 `#undoOnce` 捕获 handler 异常并抛 `ProposalError("PROPOSAL_NOT_UNDOABLE", detail)`，或在处理方里统一抛 `ProposalError`；补一条“提醒被主人改过后撤销”的 API 级用例，确认错误码稳定。

## 侧重检查

- **错误路径**：查了 `verify -> claim -> execute -> readBack -> undo` 全链路（`production-proposals.ts:594-719`、`:735-766`）。发现撤销不是幂等（问题 3）、撤销异常未映射（问题 8）、`verify` 与 `execute` 之间的时间窗口没有在 `execute` 再检查 `dueAt` 仍为将来（问题 2）。
- **不合规范/不可信输入**：查了 `rescheduleData`/`createData` 的解析、提议 basis 从导入恢复的路径、`reminderSchedule` 的格式/上限规则。发现 `verify` 对 `dueAt`/`remindAt` 的校验弱于生成端（问题 2），以及 `source` 长度与导出结构不一致（问题 5）。
- **安全/来源**：查了 `describe`/`cancel`/`moveSchedule`/`withdraw` 的 owner/agent 校验，确认都按 scope 过滤；查了外部内容标记传播，发现提议新建的记忆没有带上 `sourceThreadId`/外部引用（问题 4）。未发现越权改别人提醒或删别人记忆的路径。
- **资源耗尽**：新建文字限制 500、长文全文门槛 120、待采纳提议上限 20、提议时可改时间上限两年；但 `verify` 没有重复执行两年上限检查（问题 2），`context.reason` 也没有长度上限，未来调用方传入大段说明会原样进入加密载荷。
- **不可撤销/破坏性操作**：撤销新建会取消提醒并 `delete` 记忆；取消可重试，删除在 `deletion_pending` 时会提前返回（依赖事务里已排的投影任务）。未发现重复删除或删错 scope 的路径，但 `delete` 可选会导致静默不删（问题 7）。
- **规则/说明文档一致性**：`prompt-prefix` 相关代码未被改动；`docs/architecture-v0.1.md` 的描述大体与代码相符，但“撤销只在提醒还是改后的那一版时才恢复”没有提到“撤销已恢复但状态落盘失败”的情形；文档说“按主人时区算好”，实现有两处独立时区输入（问题 6）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会（读代码证实）。这个 diff 只改了 `production-http-composition.ts` 的提议处理方注册、新增 `production-reminder-proposals.ts`、给 writer 加方法、加测试和文档；没有改 `packages/prompt-catalog`、`production-run-composition.ts`、Pi 请求组装、工具描述或历史存储。新增的两个处理方只写提议箱和提醒表，不进入模型消息。因此发给模型的内容仍然只有系统提示、工具、历史、末尾消息，没有新增每轮会变的值。以后接“想一想”入口时，提醒提议如果要告诉模型，必须按 `prompt-prefix` 追加到末尾，不能写进系统提示；本 PR 没有接入口，所以目前没有这个问题。

2. **同一段文字会不会在不同请求里变成不同字节？**
   对模型请求没有影响。提议子系统里，`proposalId` 由固定输入哈希得到，说明/效果句由固定时区和绝对时间格式化，没有新增无序集合。但 `schedulePreview` 依赖 `now`：年度重复提醒的同一个原始 `due` 字符串在不同日期会解析到不同年份；这不影响模型请求字节，但正是问题 1 的根因。`expectedUpdatedAt` 会随提醒被修改而变，这是有意的并发依据。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有 `test/integration/reminder-proposals.test.ts`，覆盖改时间成功/读回/撤销、提议后被主人改过、过去时间/未变/未知提醒、新建成功/撤销、空文字/过去时间/长文全文。按代码推断：如果删掉 `verify` 的 `updatedAt` 检查，“主人改过后采纳”用例不会得到 `PROPOSAL_SUPERSEDED`，会失败；如果删掉提议阶段的过去/未变/未知检查，对应用例也会失败；长文 `requiresFullRead` 用例同理。
   但未实际运行测试（本环境只允许读和限定 git 命令）。也有明显缺口：`verify` 自己的“新时间在将来”检查没有单独的“提议后时间过期再采纳”反向用例；新建去重没有真的执行两次；年度跨年滚动的用例没有；撤销部分失败/重试没有；外部来源传播没有。问题 1、3、4 因此目前不会被现有检查拦住。

4. **每个新产生的值，使用它的地方都能接受吗？**
   - 提议编号：`proposalId()` 生成 `prefix:[0-9a-f]{32}`（`production-reminder-proposals.ts:184-187`），通过 `ProductionProposalBox` 的 `PROPOSAL_ID_PATTERN`（`production-proposals.ts:25`）和导出校验的 `OWNER_PROPOSAL_ID`（`data-export/verify.ts:138`）；前缀 `reminder-reschedule`/`reminder-create` 长度和字符都合法。跨类型占用：现在没有别的类型使用这两个前缀，128 位哈希撞号可忽略；但代码没有登记表强制前缀唯一，未来新增类型时仍有重复前缀风险。
   - 提议类型：`reminder.reschedule`/`reminder.create` 通过 `sentence` 的 64 字符限制，也通过导出 schema 的 `text(1, 64)`；`box.register` 与 `box.propose` 使用同一常量，能对上。
   - 提醒 ID/记忆 ID/内容 ref：`reminderKey` 保证加上 `reminder:memory:reminder:` 后不超过 128（`production-reminder-writer.ts:48-57`），新建键 `proposal:<52 字符>` 远低于上限。
   - `sourceRef`/`sourceVersion`：**两端不一致**——入口不校验，导出 schema 要求 1–256/1–128（问题 5）。
   - `dueAt`/`remindAt`/`expectedUpdatedAt`/`text`/`repeat`：生成端正常，但执行端 `verify` 没有按生成端的全部规则重新校验（问题 2）；`expectedUpdatedAt` 只做字符串相等，配合 SQLite 的条件更新本身是对的。
   - 新建记忆的来源字段：**没有传**，所以 `sourceThreadId`/外部来源引用缺失（问题 4）。
   - `memory.delete`：生产 composition 传完整服务，能接受；但 writer 类型把它设为可选，存在静默不删的路径（问题 7）。
