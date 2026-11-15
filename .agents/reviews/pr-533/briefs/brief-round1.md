# PR 533 第 1 轮作者说明

问题：PR 520 给提议箱加了确定动作的执行层（`ProposalActionHandler`：verify、execute、readBack、undo），但还没有具体动作。“主动提议下一步”第一版要有两种：改一条提醒的时间、新建一条提醒（方案仓库外 `/mnt/project-files/ambient-sensing/proposed-actions-plan.md`，Andy 2026-11-12 已同意）。

改动：
- 新文件 `apps/agent-service/src/production-reminder-proposals.ts`：`registerReminderProposalHandlers`（登记 `reminder.reschedule`、`reminder.create`）、`proposeReminderReschedule`、`proposeReminderCreate`。
- `apps/agent-service/src/production-reminder-writer.ts`：新增 `describe`、`schedulePreview`、`moveSchedule`（带 `expectedUpdatedAt` 的 `update`）、`withdraw`（取消提醒并删除它挂着的记忆）。
- `apps/agent-service/src/production-http-composition.ts`：有记忆服务时登记两个处理方。
- 测试 `test/integration/reminder-proposals.test.ts`；文档 `docs/architecture-v0.1.md`。

约束：不调模型；不改表；不改发给模型的内容；规则（`owner_rule`）提议不变；不写代码注释；没有网页界面。没做的：谁来调提议入口（后续的“想一想”步骤）、“去办一件事”开运行（下一个 PR）。

作者的说法（请核对，不要照信）：
1. 改时间只在提议时那条提醒的 `updatedAt` 没变、状态仍是 `scheduled`、新时间在将来时才执行，否则 `verify` 返回不通过（提议标成被取代，什么都不改）。
2. `moveSchedule` 通过存储层 `update` 的 `expectedUpdatedAt` 条件做并发控制；撤销也带改后的版本，主人中途改过就失败。
3. 新建提醒用 `proposal:<提议编号>` 当去重键，同一个提议重复执行只会得到同一条提醒。
4. 新建的撤销先取消提醒再删记忆，任何一步失败后重试都安全。

请重点核对：
1. `execute` 中 `remindAt` 的处理（`max(提议时算好的 remindAt, 现在)`）和 `schedulePreview` 的时间规则（`reminderSchedule`）是否一致，有没有会把提醒改到过去或改乱的输入（年度重复的提醒、只有日期没有时间的提醒）。
2. `undo` 把时间改回去时用 `dismissedAt: null`、`status: "scheduled"`：原本状态就是 `scheduled`，是否会误改别的字段。
3. `withdraw` 里 `memory.delete` 是 `Partial<Pick<...>>` 可选：生产里是否总是有；`remove.call(this.#options.memory, ...)` 的用法。
4. `readBack` 在改时间后用 `dueAt === parsed.dueAt`，年度重复提醒触发后会不会让读回误判（读回发生在采纳后几毫秒内）。
5. 提议编号（内容的 sha256 前 32 位）撞号或被别的类型占用的可能。
