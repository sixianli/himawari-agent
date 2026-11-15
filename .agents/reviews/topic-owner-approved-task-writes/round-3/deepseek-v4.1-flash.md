CLAIM|1|一致|apps/agent-service/src/production-task-proposals.ts:28|提议箱里有一种提议叫“交给我去办一件事”（`task.run`）。|export const TASK_RUN_PROPOSAL_TYPE = "task.run";
CLAIM|2|一致|apps/agent-service/src/production-task-proposals.ts:147|主人同意后，Himawari 新开一个对话。|      const created = await commands.create({
CLAIM|3|一致|apps/agent-service/src/production-task-proposals.ts:154|把任务说明交给一次后台运行去办。|      await commands.admitOwnerMessage({
CLAIM|4|一致|apps/agent-service/src/production-task-proposals.ts:155|这次运行的触发来源是 `external_event`。|        triggerSource: "external_event",
CLAIM|5|一致|apps/agent-service/src/owner-scope-authorization.ts:260|没有下面决定 1 的标记时，授权层把触发来源是 `external_event` 的运行当成带外部内容。|    const eventIsExternal = source.sourceType === "external_event" && !source.ownerApprovedTask;
CLAIM|6|一致|packages/application/src/rules/action-rules.ts:249|没有下面决定 1 的标记时，内置规则对它的写操作直接拒绝，不弹审批。|      'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts && !("run_source_owner_approved_task" in facts)',
CLAIM|7|一致|apps/agent-service/src/production-task-proposals.ts:155|同意后开的运行记成 `external_event`。|        triggerSource: "external_event",
CLAIM|8|一致|apps/agent-service/src/production-task-proposals.ts:163|同意后开的运行的来源凭据是 `sourceProofRef: \`proposal:${proposalId}:${session.proofRef}\`,`。|        sourceProofRef: `proposal:${proposalId}:${session.proofRef}`,
CLAIM|9|一致|apps/agent-service/src/production-think-runner.ts:200|“想一想”自己的运行也记成 `external_event`。|      triggerSource: "external_event",
CLAIM|10|一致|apps/agent-service/src/production-think-runner.ts:208|“想一想”运行的来源凭据是 `sourceProofRef: \`think:${entry.id}\`,`。|      sourceProofRef: `think:${entry.id}`,
CLAIM|11|一致|packages/application/src/rules/action-rules.ts:249|`refuseBackgroundAfterExternalContent` 对“不是主人消息发起、带外部内容”的非读取动作给出 `refuse`。|      'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts && !("run_source_owner_approved_task" in facts)',
CLAIM|12|一致|packages/application/src/rules/action-rules.ts:122|`askAfterExternalContent` 对带外部内容的非读取动作给出 `ask_owner`。|    expression: `action_kind != "READ" && target_type != "managed-task" && "context_external_content" in facts && !(${OWNER_INTENT_CONFIRMED_EXPRESSION})`,
CLAIM|13|一致|packages/application/src/rules/action-rules.ts:357|两条同时命中时取更严的一条。|      STRICTNESS[hit.outcome] > STRICTNESS[strictest.outcome as ActionRuleOutcome]
CLAIM|14|一致|apps/agent-service/src/production-runtime-tools.ts:644|工具读到的内容不是主人自己的数据时，这次运行会被标上外部内容（`#markExternalContent`）。|    if (row?.resultOrigin === "owner_data") return null;
CLAIM|15|一致|apps/agent-service/src/production-tool-actions.ts:191|登记表里 `web_search` 的 `resultOrigin` 是 `"external"`。|    resultOrigin: "external",
CLAIM|16|一致|apps/agent-service/src/production-tool-actions.ts:205|登记表里 `web_fetch` 的 `resultOrigin` 是 `"external"`。|    resultOrigin: "external",
CLAIM|17|一致|.agents/plan-drafts/think-step-plan.md:10|方案 v2 写明：同意过的任务，读到外部内容之后，写操作由“直接拒绝”改成“要主人批准”，每个有后果的动作仍要主人点一下，不造绕过审批的口子。|- A'：同意过的任务，读到外部内容之后，写操作由“直接拒绝”改成“要主人批准”（规则的结果值 `ask_owner` 已经有，`packages/application/src/rules/action-rules.ts:123`）。每个有后果的动作仍要主人点一下，所以人工闸门还在，但任务不会被一刀切死。内置的“拒绝”规则对 `schedule`、普通 `external_event` 这类后台运行保持不变。
CLAIM|18|一致|.agents/plan-drafts/think-step-plan.md:3|方案原文在 `.agents/plan-drafts/think-step-plan.md` 的“修订 v2”一节。|# 修订 v2（2026-11-15，Andy 答复之后；和下文冲突时听这里的）
CLAIM|19|找不到|-|Andy 2026-11-15 同意了“想一想”方案 v2。|-|-
CLAIM|20|找不到|-|Andy 的同意经协调者转来：“按 v2 方案做，上线前评测约 0.6 美元可以花，残留风险已知情。复核轮次也都同意。模型调用和 A' 两个 PR 合并前仍等他说合并。”|-|-
CLAIM|21|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:248|读运行来源时用 `thread.readRunExecutionSource`。|      case "thread.readRunExecutionSource": {
CLAIM|22|一致|apps/agent-service/src/production-task-proposals.ts:191|`task.run` 提议没有撤销入口。|      throw new ProposalError("PROPOSAL_NOT_UNDOABLE", "TASK_RUN_NOT_UNDOABLE");
CLAIM|23|一致|packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:356|主人同意时领取就把它标成“已同意”。|          `UPDATE owner_proposals SET status = 'accepted', decided_at = ?, exec_status = 'running',
CLAIM|24|一致|packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:399|之后没有代码再改它的状态。|          `UPDATE owner_proposals SET exec_status = ?,
CLAIM|25|一致|apps/agent-service/src/production-proposals.ts:682|开运行失败只把执行状态记成失败。|        .moveExecution({
CLAIM|26|一致|apps/control-center/src/governance-control-center.tsx:358|控制中心的治理页列出的是这个代码本身，不显示它的说明文字“这一轮是你同意过的一件任务”。|              value={<Values values={snapshot.payload.intent.deterministicFactCodes} />}
CLAIM|27|一致|apps/agent-service/src/production-device-action-authorization.ts:59|设备动作里不允许外部内容引出的那些（例如日历、联系人、家居），读过外部内容后仍直接拒绝，和主人自己发起的运行一样。|      if (!intent.untrustedOriginAllowed && intent.readUntrustedContent)
CLAIM|28|一致|test/integration/tool-action-registry.test.ts:649|回归测试覆盖了“没读外部内容可写”。|it("[ADR-0278] lets a task the owner agreed to set a reminder when nothing external was read, without marking the run", async () => {
CLAIM|29|一致|test/integration/tool-action-registry.test.ts:664|回归测试覆盖了“读后改成问主人”。|it("[ADR-0278] asks the owner, instead of refusing, when a task the owner agreed to writes after reading external content", async () => {
CLAIM|30|一致|test/integration/tool-action-registry.test.ts:683|回归测试覆盖了“没有标记仍拒绝”。|it("[ADR-0278] REVERSE: without the owner-approved mark the same external-event write is still refused", async () => {
CLAIM|31|一致|test/integration/task-proposals.test.ts:186|回归测试覆盖了“同意后来源带标记”。|    expect(await runSource.read(runId)).toMatchObject({
CLAIM|32|一致|test/integration/task-proposals.test.ts:201|回归测试覆盖了“来源凭据改指一条还在待定的 `task.run` 提议后不带”。|    expect(await runSource.read(runId)).not.toHaveProperty("ownerApprovedTask");

未核对到的部分：Andy 的口头同意及“0.6 美元可以花、残留风险已知情、复核轮次都同意”在仓库里没有记录；`.agents/plan-drafts/think-step-plan.md` 的“修订 v2”自己写的是 Andy 选 A、作者改成 A'，并把 0.6 美元列为要先报 Andy 同意。
