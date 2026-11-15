CLAIM|1|一致|apps/agent-service/src/production-task-proposals.ts:28|提议箱里有一种提议叫“交给我去办一件事”（`task.run`）。|export const TASK_RUN_PROPOSAL_TYPE = "task.run";
CLAIM|2|一致|apps/agent-service/src/production-task-proposals.ts:147|主人同意后，Himawari 新开一个对话，把任务说明交给一次后台运行去办。|const created = await commands.create({
CLAIM|3|一致|apps/agent-service/src/production-task-proposals.ts:155|这次运行的触发来源是 `external_event`。|triggerSource: "external_event",
CLAIM|4|一致|apps/agent-service/src/owner-scope-authorization.ts:260|没有下面决定 1 的标记时，授权层把触发来源是 `external_event` 的运行当成带外部内容|const eventIsExternal = source.sourceType === "external_event" && !source.ownerApprovedTask;
CLAIM|5|一致|packages/application/src/rules/action-rules.ts:249|内置规则对它的写操作直接拒绝，不弹审批|'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts && !("run_source_owner_approved_task" in facts)',
CLAIM|6|一致|.agents/plan-drafts/think-step-plan.md:10|“想一想”方案 v2（`.agents/plan-drafts/think-step-plan.md` 的“修订 v2”一节，见前提 5）写明：同意过的任务，读到外部内容之后，写操作由“直接拒绝”改成“要主人批准”|- A'：同意过的任务，读到外部内容之后，写操作由“直接拒绝”改成“要主人批准”（规则的结果值 `ask_owner` 已经有，`packages/application/src/rules/action-rules.ts:123`）。
CLAIM|7|一致|.agents/plan-drafts/think-step-plan.md:10|每个有后果的动作仍要主人点一下，不造绕过审批的口子|每个有后果的动作仍要主人点一下，所以人工闸门还在，但任务不会被一刀切死。
CLAIM|8|一致|apps/agent-service/src/production-task-proposals.ts:155|同意后开的运行记成 `external_event`：`apps/agent-service/src/production-task-proposals.ts` 里的原文是 `triggerSource: "external_event",`|triggerSource: "external_event",
CLAIM|9|一致|apps/agent-service/src/production-task-proposals.ts:163|来源凭据是 `` sourceProofRef: `proposal:${proposalId}:${session.proofRef}`, ``。|sourceProofRef: `proposal:${proposalId}:${session.proofRef}`,
CLAIM|10|一致|apps/agent-service/src/production-think-runner.ts:208|“想一想”自己的运行也记成 `external_event`，但来源凭据不同：`apps/agent-service/src/production-think-runner.ts` 里的原文是 `` sourceProofRef: `think:${entry.id}`, ``。|sourceProofRef: `think:${entry.id}`,
CLAIM|11|一致|packages/application/src/rules/action-rules.ts:249|内置规则 `refuseBackgroundAfterExternalContent` 对运行来源不是 `user_message`、带外部内容、目标不是 `managed-task`、也不带 `run_source_owner_approved_task` 的非读取动作给出 `refuse`|'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts && !("run_source_owner_approved_task" in facts)',
CLAIM|12|一致|packages/application/src/rules/action-rules.ts:122|`askAfterExternalContent` 对带外部内容、目标不是 `managed-task` 的非读取动作给出 `ask_owner`，只有运行来源是 `user_message`、主人确认过意图、风险为中等、可撤回、不对外的写入除外|`action_kind != "READ" && target_type != "managed-task" && "context_external_content" in facts && !(${OWNER_INTENT_CONFIRMED_EXPRESSION})`,
CLAIM|13|一致|packages/application/src/rules/action-rules.ts:357|两条同时命中时取更严的一条|STRICTNESS[hit.outcome] > STRICTNESS[strictest.outcome as ActionRuleOutcome]
CLAIM|14|一致|apps/agent-service/src/production-tool-actions.ts:191|工具读到的内容不是主人自己的数据时（例如 `web_search`，登记表里 `resultOrigin: "external"`）|resultOrigin: "external",
CLAIM|15|一致|apps/agent-service/src/production-tool-actions.ts:205|工具读到的内容不是主人自己的数据时（例如 `web_fetch`，登记表里 `resultOrigin: "external"`）|resultOrigin: "external",
CLAIM|16|一致|apps/agent-service/src/production-runtime-tools.ts:658|这次运行会被标上外部内容：`apps/agent-service/src/production-runtime-tools.ts` 的 `#markExternalContent`|await marker.mark(invocation.runId, origin);
CLAIM|17|一致|.agents/plan-drafts/think-step-plan.md:3|方案原文在 `.agents/plan-drafts/think-step-plan.md`，标题是“修订 v2（2026-11-15，Andy 答复之后；和下文冲突时听这里的）”|# 修订 v2（2026-11-15，Andy 答复之后；和下文冲突时听这里的）
CLAIM|18|一致|.agents/plan-drafts/think-step-plan.md:10|其中写着“A'：同意过的任务，读到外部内容之后，写操作由“直接拒绝”改成“要主人批准””。|- A'：同意过的任务，读到外部内容之后，写操作由“直接拒绝”改成“要主人批准”（规则的结果值 `ask_owner` 已经有，`packages/application/src/rules/action-rules.ts:123`）。
CLAIM|19|一致|packages/application/src/rules/action-rules.ts:253|内置规则 `refuseBackgroundAfterExternalContent`（ADR 0257 决定 3 定的）|"ADR 0257 决定 3；苹果端设计“指令和数据的界线”：后台一律不做；ADR 0278：主人同意过的任务改为问主人",
CLAIM|20|一致|packages/application/src/services/run-execution-input-service.ts:256|运行开始时冻结的运行输入快照里也有来源|source,
CLAIM|21|一致|apps/agent-service/src/production-device-action-authorization.ts:59|设备动作里不允许外部内容引出的那些（例如日历、联系人、家居），读过外部内容后仍直接拒绝，和主人自己发起的运行一样，这个改动不放宽它们。|if (!intent.untrustedOriginAllowed && intent.readUntrustedContent)
CLAIM|22|一致|docs/product-vision.md:55|依据愿景的裁决顺序：边界与可逆性高于主动性。|*原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。*
CLAIM|23|一致|packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:133|给触发表加一个新的来源值：要重建表|source_type TEXT NOT NULL CHECK (source_type IN ('user_message', 'schedule', 'external_event')),
CLAIM|24|一致|apps/agent-service/src/production-task-proposals.ts:191|`task.run` 提议没有撤销入口|throw new ProposalError("PROPOSAL_NOT_UNDOABLE", "TASK_RUN_NOT_UNDOABLE");
CLAIM|25|一致|packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:356|主人同意时领取就把它标成“已同意”|`UPDATE owner_proposals SET status = 'accepted', decided_at = ?, exec_status = 'running',
CLAIM|26|一致|apps/agent-service/src/production-proposals.ts:885|之后没有代码再改它的状态|if (row.status === "accepted") throw new ProposalError("PROPOSAL_ACCEPTED");
CLAIM|27|一致|apps/agent-service/src/production-proposals.ts:685|开运行失败只把执行状态记成失败|to: "failed",
CLAIM|28|一致|apps/agent-service/src/owner-scope-authorization.ts:179|新事实的代码 `run_source_owner_approved_task` 记在动作意图里|if (source.ownerApprovedTask) factCodes.push(POLICY_FACT_CODES.runSourceOwnerApprovedTask);
CLAIM|29|一致|apps/control-center/src/governance-control-center.tsx:358|控制中心的治理页列出的是这个代码本身，不显示它的说明文字“这一轮是你同意过的一件任务”|value={<Values values={snapshot.payload.intent.deterministicFactCodes} />}
CLAIM|30|一致|test/integration/tool-action-registry.test.ts:649|回归测试 `test/integration/tool-action-registry.test.ts`（没读外部内容可写）|it("[ADR-0278] lets a task the owner agreed to set a reminder when nothing external was read, without marking the run", async () => {
CLAIM|31|一致|test/integration/tool-action-registry.test.ts:664|回归测试 `test/integration/tool-action-registry.test.ts`（读后改成问主人）|it("[ADR-0278] asks the owner, instead of refusing, when a task the owner agreed to writes after reading external content", async () => {
CLAIM|32|一致|test/integration/tool-action-registry.test.ts:683|回归测试 `test/integration/tool-action-registry.test.ts`（没有标记仍拒绝）|it("[ADR-0278] REVERSE: without the owner-approved mark the same external-event write is still refused", async () => {
CLAIM|33|一致|test/integration/task-proposals.test.ts:188|回归测试 `test/integration/task-proposals.test.ts`（同意后来源带标记）|ownerApprovedTask: true,
CLAIM|34|一致|test/integration/task-proposals.test.ts:201|回归测试 `test/integration/task-proposals.test.ts`（来源凭据改指一条还在待定的 `task.run` 提议后不带）|expect(await runSource.read(runId)).not.toHaveProperty("ownerApprovedTask");
CLAIM|35|一致|test/integration/thread-run-lifecycle.test.ts:2444|冻结快照里没有 `ownerApprovedTask`、重新读出的来源有|return live ? { ...live, ownerApprovedTask: true as const } : live;
CLAIM|36|一致|test/integration/thread-run-lifecycle.test.ts:2448|运行照常恢复|expect(frozenBeforeOwnerApprovedTask).toEqual(original);
CLAIM|37|一致|test/integration/thread-run-lifecycle.test.ts:4252|过了截止时间照常经 `createProductionRunExpiry` 结算|it("[R2-D3] settles an expired snapshot frozen before ownerApprovedTask existed and still refuses a changed stored source", async () => {
CLAIM|38|一致|test/integration/thread-run-lifecycle.test.ts:4303|来源的其他字段不同仍被拒|expiry(liveSource((source) => ({ ...source, sourceId: `${source.sourceId}-changed` })))(
CLAIM|39|一致|packages/application/test/frozen-run-source-identity.unit.test.ts:50|快照里的来源缺失或不是对象时，单元测试核对它和重新读出的来源比对为不一致|expect(canonicalAuthorizationSnapshot(frozenRunSourceIdentity(malformed))).not.toBe(
CLAIM|40|找不到|-|快照里的来源缺失或不是对象时，单元测试核对它和重新读出的来源比对为不一致，没有端到端核对错误码|-

方案里 Andy 在项目聊天中的原话不在仓库内，未能核对；“没有端到端核对错误码”属于缺席判断，我未能在全仓库证明不存在这样的端到端用例。行业网页及相关第三方说法按题意未计入核对。
