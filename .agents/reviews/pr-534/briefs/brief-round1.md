# PR 534 第 1 轮作者说明

问题：PR 520 的提议箱有“动作类处理方”，PR 533 登记了两种确定动作。“主动提议下一步”还缺第二类：主人同意一条“交给她去办一件事”的提议后，新开一个对话并开一次运行（方案仓库外 `/mnt/project-files/ambient-sensing/proposal-run-trigger-plan.md`，计划原文 `proposed-actions-plan.md` 第 255、363 行）。

改动：
- 新文件 `apps/agent-service/src/production-task-proposals.ts`：`registerTaskProposalHandler`（登记 `task.run`）、`proposeTaskRun`、`taskRunMessage`。
- `AdmitOwnerMessageInput` 和 `ThreadCommandService.admitOwnerMessage` 加可选 `triggerSource`（`user_message` 默认，或 `external_event`）；`sqlite-thread-operations.ts` 的触发表插入用它；非默认值才进语义指纹，所以老的指纹不变。
- `ProposalResponder` 加 `session`，`ProposalActionHandler.verify/execute` 的入参加可选 `session`；`production-proposal-control.ts` 用命令的 `authentication.sessionId` 和 `authenticationRef` 填它。
- `production-http-composition.ts` 始终登记 `task.run` 处理方。
- 测试 `test/integration/task-proposals.test.ts`；文档 `docs/architecture-v0.1.md`。

约束：不调模型；不改表；不改系统提示和工具；不写代码注释；没有网页界面；没有来源调用 `proposeTaskRun`（下一步）。不加迁移的理由：触发表 `source_type` 已允许 `external_event`（`0001_initial_product_schema.sql:133`）。

作者的说法（请核对，不要照信）：
1. 触发来源是 `external_event` 的运行，会自动被首页“正在做的”取到（`sqlite-run-lifecycle-operations.ts:956-962` 的 `t.source_type != 'user_message'`），而且普通主人消息仍是 `user_message`、不会被列入。
2. 开对话、开运行的幂等键都由提议编号算出，重复同意只开一次；失败后重放不会开第二次。
3. 任务说明原样作为第一条消息，只在前面加抬头，任务说明里的 `<<<`、`>>>` 换成相近符号，防止伪造块边界。
4. 没有登录会话时 `verify`/`execute` 抛 `PROPOSAL_INVALID`，不会标成被取代，也不会开运行。
5. 不做撤销：`undo` 一律抛 `PROPOSAL_NOT_UNDOABLE`。

请重点核对：
1. `external_event` 触发的运行，在上下文投影、运行派发、审批、模型选择（`modelSelection` 为空）、线程标题生成等下游，有没有哪处假设触发来源必是 `user_message`，会让这次运行卡住、拒绝或被错误对待（例如没有 `schedule`/`external_event` 的提示渲染或审批规则）。
2. `execute` 中途失败（payload 已存、对话已建、运行未开；或运行已开、返回前崩溃）后，租约到期恢复只做读回、不重做执行：这种状态下会不会留下孤儿对话或永远“未知”的提议。
3. 提议编号 `task:<sha256 前 32 位>`、对话 id、运行 id 都由提议编号派生：不同提议撞号、同一提议换会话再同意，会不会出错。
4. `readBack` 只在对话里查到这条消息和这次运行就算成功：会不会在运行已被取消或失败时仍判成功，这样算不算符合“succeeded 指已经开始办”。
5. 抬头里的时间用 `timeZone`（默认 UTC）：配置里没有时区时显示 UTC 是否会误导。
