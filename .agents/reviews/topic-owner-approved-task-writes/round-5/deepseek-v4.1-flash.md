CLAIM|1|一致|apps/agent-service/src/production-task-proposals.ts:28|提议箱里有一种提议叫“交给我去办一件事”（`task.run`）。|export const TASK_RUN_PROPOSAL_TYPE = "task.run";
CLAIM|2|一致|apps/agent-service/src/production-task-proposals.ts:147|主人同意后，Himawari 新开一个对话，把任务说明交给一次后台运行去办。|const created = await commands.create({
CLAIM|3|一致|apps/agent-service/src/production-task-proposals.ts:155|这次运行的触发来源是 `external_event`。|triggerSource: "external_event",
CLAIM|4|一致|apps/agent-service/src/owner-scope-authorization.ts:260|没有下面决定 1 的标记时，授权层把触发来源是 `external_event` 的运行当成带外部内容|const eventIsExternal = source.sourceType === "external_event" && !source.ownerApprovedTask;
CLAIM|5|一致|packages/application/src/rules/action-rules.ts:249|内置规则对它的写操作直接拒绝，不弹审批。|'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts && !("run_source_owner_approved_task" in facts)',
CLAIM|6|一致|.agents/plan-drafts/think-step-plan.md:10|同意过的任务，读到外部内容之后，写操作由“直接拒绝”改成“要主人批准”|- A'：同意过的任务，读到外部内容之后，写操作由“直接拒绝”改成“要主人批准”（规则的结果值 `ask_owner` 已经有，`packages/application/src/rules/action-rules.ts:123`）。每个有后果的动作仍要主人点一下，所以人工闸门还在，但任务不会被一刀切死。内置的“拒绝”规则对 `schedule`、普通 `external_event` 这类后台运行保持不变。
CLAIM|7|一致|.agents/plan-drafts/think-step-plan.md:10|每个有后果的动作仍要主人点一下，不造绕过审批的口子。|每个有后果的动作仍要主人点一下，所以人工闸门还在，但任务不会被一刀切死。
CLAIM|8|一致|apps/agent-service/src/production-task-proposals.ts:155|同意后开的运行记成 `external_event`：`apps/agent-service/src/production-task-proposals.ts` 里的原文是 `triggerSource: "external_event",`|triggerSource: "external_event",
CLAIM|9|一致|apps/agent-service/src/production-task-proposals.ts:163|来源凭据是 `` sourceProofRef: `proposal:${proposalId}:${session.proofRef}`, ``|sourceProofRef: `proposal:${proposalId}:${session.proofRef}`,
CLAIM|10|一致|apps/agent-service/src/production-think-runner.ts:200|“想一想”自己的运行也记成 `external_event`|triggerSource: "external_event",
CLAIM|11|一致|apps/agent-service/src/production-think-runner.ts:208|来源凭据不同：`` sourceProofRef: `think:${entry.id}`, ``|sourceProofRef: `think:${entry.id}`,
CLAIM|12|一致|packages/application/src/rules/action-rules.ts:249|内置规则 `refuseBackgroundAfterExternalContent` 对运行来源不是 `user_message`、带外部内容、目标不是 `managed-task`、也不带 `run_source_owner_approved_task` 的非读取动作给出 `refuse`|'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts && !("run_source_owner_approved_task" in facts)',
CLAIM|13|一致|packages/application/src/rules/action-rules.ts:122|`askAfterExternalContent` 对带外部内容、目标不是 `managed-task` 的非读取动作给出 `ask_owner`|expression: `action_kind != "READ" && target_type != "managed-task" && "context_external_content" in facts && !(${OWNER_INTENT_CONFIRMED_EXPRESSION})`,
CLAIM|14|不一致|packages/application/src/rules/action-rules.ts:16|只有运行来源是 `user_message`、主人确认过意图的低风险可撤回写入除外|'action_kind == "CREATE_OR_UPDATE" && risk == "MEDIUM" && reversible == 1 && disclosure == "none" && recipient_count == 0 && run_source == "user_message" && "context_external_content" in facts && "owner_intent_confirmed" in facts && !("owner_presence_required" in facts) && !("standing_rule_change" in facts)';
CLAIM|15|一致|packages/application/src/rules/action-rules.ts:357|两条同时命中时取更严的一条。|STRICTNESS[hit.outcome] > STRICTNESS[strictest.outcome as ActionRuleOutcome]
CLAIM|16|一致|apps/agent-service/src/production-tool-actions.ts:191|工具读到的内容不是主人自己的数据时（例如 `web_search`、`web_fetch`，登记表里 `resultOrigin: "external"`）|resultOrigin: "external",
CLAIM|17|一致|apps/agent-service/src/production-runtime-tools.ts:658|这次运行会被标上外部内容：`apps/agent-service/src/production-runtime-tools.ts` 的 `#markExternalContent`。|await marker.mark(invocation.runId, origin);
CLAIM|18|一致|.agents/plan-drafts/think-step-plan.md:1|方案原文在 `.agents/plan-drafts/think-step-plan.md`|# 第 2 步「想一想」方案（草案，等 Andy 同意才动工）
CLAIM|19|一致|.agents/plan-drafts/think-step-plan.md:3|标题是“修订 v2（2026-11-15，Andy 答复之后；和下文冲突时听这里的）”|# 修订 v2（2026-11-15，Andy 答复之后；和下文冲突时听这里的）
CLAIM|20|一致|.agents/plan-drafts/think-step-plan.md:10|其中写着“A'：同意过的任务，读到外部内容之后，写操作由“直接拒绝”改成“要主人批准””|- A'：同意过的任务，读到外部内容之后，写操作由“直接拒绝”改成“要主人批准”（规则的结果值 `ask_owner` 已经有，`packages/application/src/rules/action-rules.ts:123`）。每个有后果的动作仍要主人点一下，所以人工闸门还在，但任务不会被一刀切死。内置的“拒绝”规则对 `schedule`、普通 `external_event` 这类后台运行保持不变。
CLAIM|21|找不到|-|Andy 2026-11-15 在项目聊天回这份方案的原话是：“这里按照你的建议来”。|-
CLAIM|22|一致|packages/application/src/rules/action-rules.ts:253|内置规则 `refuseBackgroundAfterExternalContent`（ADR 0257 决定 3 定的）|"ADR 0257 决定 3；苹果端设计“指令和数据的界线”：后台一律不做；ADR 0278：主人同意过的任务改为问主人",
CLAIM|23|一致|packages/application/src/services/device-action-registry.ts:503|设备动作里不允许外部内容引出的那些（例如日历、联系人、家居）|untrustedOriginAllowed: false,
CLAIM|24|一致|apps/agent-service/src/production-device-action-authorization.ts:60|在设备动作授权层照旧直接拒绝，到不了这两条规则。|return { decision: "deny", reasonCode: "authorization_denied" };
CLAIM|25|一致|apps/agent-service/src/production-task-proposals.ts:191|`task.run` 提议没有撤销入口|throw new ProposalError("PROPOSAL_NOT_UNDOABLE", "TASK_RUN_NOT_UNDOABLE");
CLAIM|26|一致|packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:356|主人同意时领取就把它标成“已同意”|UPDATE owner_proposals SET status = 'accepted', decided_at = ?, exec_status = 'running',
CLAIM|27|一致|packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:399|之后没有代码再改它的状态|UPDATE owner_proposals SET exec_status = ?,
CLAIM|28|一致|apps/agent-service/src/production-proposals.ts:685|开运行失败只把执行状态记成失败|to: "failed",
CLAIM|29|一致|packages/persistence-sqlite/src/sqlite-thread-operations.ts:1531|所以这次运行一直带着标记。|AND op.type = 'task.run' AND op.status = 'accepted'
CLAIM|30|一致|test/integration/task-proposals.test.ts:201|数据库里核对“已同意”，管的是来源凭据指向另一条还没同意的提议的情况，这时不带标记。|expect(await runSource.read(runId)).not.toHaveProperty("ownerApprovedTask");
CLAIM|31|一致|apps/agent-service/src/owner-scope-authorization.ts:179|新事实的代码 `run_source_owner_approved_task` 记在动作意图里|if (source.ownerApprovedTask) factCodes.push(POLICY_FACT_CODES.runSourceOwnerApprovedTask);
CLAIM|32|一致|apps/control-center/src/governance-control-center.tsx:358|控制中心的治理页列出的是这个代码本身，不显示它的说明文字“这一轮是你同意过的一件任务”|value={<Values values={snapshot.payload.intent.deterministicFactCodes} />}
CLAIM|33|一致|apps/control-center/src/components/run-approval-card.tsx:1（git diff --name-only 未见此文件）|审批卡片本身这次没有改。|import type { ContentPreviewValue } from "./content-preview.js";
CLAIM|34|一致|apps/agent-service/src/production-device-action-authorization.ts:60|设备动作里不允许外部内容引出的那些（例如日历、联系人、家居），读过外部内容后仍直接拒绝，和主人自己发起的运行一样，这个改动不放宽它们。|return { decision: "deny", reasonCode: "authorization_denied" };
CLAIM|35|一致|test/integration/tool-action-registry.test.ts:649|`test/integration/tool-action-registry.test.ts`（没读外部内容可写）|it("[ADR-0278] lets a task the owner agreed to set a reminder when nothing external was read, without marking the run", async () => {
CLAIM|36|一致|test/integration/tool-action-registry.test.ts:664|`test/integration/tool-action-registry.test.ts`（读后改成问主人）|it("[ADR-0278] asks the owner, instead of refusing, when a task the owner agreed to writes after reading external content", async () => {
CLAIM|37|一致|test/integration/tool-action-registry.test.ts:683|`test/integration/tool-action-registry.test.ts`（没有标记仍拒绝）|it("[ADR-0278] REVERSE: without the owner-approved mark the same external-event write is still refused", async () => {
CLAIM|38|一致|test/integration/task-proposals.test.ts:188|`test/integration/task-proposals.test.ts`（同意后来源带标记）|ownerApprovedTask: true,
CLAIM|39|一致|test/integration/task-proposals.test.ts:201|`test/integration/task-proposals.test.ts`（来源凭据改指一条还在待定的 `task.run` 提议后不带）|expect(await runSource.read(runId)).not.toHaveProperty("ownerApprovedTask");
CLAIM|40|一致|test/integration/thread-run-lifecycle.test.ts:2444|`test/integration/thread-run-lifecycle.test.ts` 和 `packages/application/test/frozen-run-source-identity.unit.test.ts`（冻结快照里没有 `ownerApprovedTask`、重新读出的来源有，运行照常恢复）|return live ? { ...live, ownerApprovedTask: true as const } : live;
CLAIM|41|一致|test/integration/thread-run-lifecycle.test.ts:4301|`test/integration/thread-run-lifecycle.test.ts` 和 `packages/application/test/frozen-run-source-identity.unit.test.ts`（过了截止时间照常经 `createProductionRunExpiry` 结算）|clock.set(target.deadlineAt);
CLAIM|42|一致|test/integration/thread-run-lifecycle.test.ts:4306|`test/integration/thread-run-lifecycle.test.ts` 和 `packages/application/test/frozen-run-source-identity.unit.test.ts`（来源的其他字段不同仍被拒）|).rejects.toThrow("RUN_EXPIRY_INPUT_INVALID");
CLAIM|43|一致|packages/application/test/frozen-run-source-identity.unit.test.ts:47|`test/integration/thread-run-lifecycle.test.ts` 和 `packages/application/test/frozen-run-source-identity.unit.test.ts`（快照里的来源缺失或不是对象时，仍报原来的“快照不一致”错误）|it("leaves a malformed frozen source as it is so the snapshot comparison still fails", () => {

Andy 2026-11-15 在项目聊天中的原话“这里按照你的建议来”在仓库里找不到对应记录，未核实。审批卡片未改动一条是用 git diff --name-only 核对的，不是逐行读取卡片行为的证据。
