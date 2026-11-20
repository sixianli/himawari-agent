# PR 576 第 1 轮复核材料

问题：主人同意“去办一件事”的提议后开的运行是 `external_event`，授权层一律当它带外部内容，内置规则对写操作直接拒绝，同意了办不成。Andy 同意的方案（A'）：读到外部内容后的写操作改成要主人批准，不是直接拒绝，也不免审批。
做法：`readRunExecutionSource` 在数据库里判断来源凭据是否指向一条“已同意”的 `task.run` 提议，是就带 `ownerApprovedTask`；授权层对它不再自动标外部内容，加事实 `run_source_owner_approved_task`；`refuseBackgroundAfterExternalContent` 第 2 版对这个事实让位，由 `askAfterExternalContent` 问主人。
作者的说法，请核对：
1. 客户端无法伪造这个标记（网关建的运行只能是 `user_message`；凭据前缀匹配不会把编号 p1 误认成 p12）。
2. 想一想运行（凭据 `think:`）、定时任务和其他外部事件运行的行为完全不变。
3. 没有任何原本要问主人的动作变成不问；唯一放宽的是“直接拒绝”变成“问主人”，以及同意过的任务在没读外部内容时按主人自己发起的运行对待。
4. 审批通过后重新判定（`approvalOutcome`）用的是冻结的事实，结果一致；提议被撤销后行为合理。
5. 不涉及发给模型的内容。
