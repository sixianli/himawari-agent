CLAIM|1|一致|apps/agent-service/src/production-task-proposals.ts:28|提议箱里有一种提议叫“交给我去办一件事”（`task.run`）。|export const TASK_RUN_PROPOSAL_TYPE = "task.run";
CLAIM|2|一致|apps/agent-service/src/production-task-proposals.ts:147|主人同意后，Himawari 新开一个对话|const created = await commands.create({
CLAIM|3|一致|apps/agent-service/src/production-task-proposals.ts:154|把任务说明交给一次后台运行去办|await commands.admitOwnerMessage({
CLAIM|4|一致|apps/agent-service/src/production-task-proposals.ts:155|这次运行的触发来源是 `external_event`|triggerSource: "external_event",
CLAIM|5|一致|apps/agent-service/src/owner-scope-authorization.ts:261@9fa3f97e451be1779313eb6fdb59c5d0c412d874|授权层把这类运行一律当成带外部内容|await marks.mark(invocation.runId, "external_event");
CLAIM|6|一致|packages/application/src/rules/action-rules.ts:238@9fa3f97e451be1779313eb6fdb59c5d0c412d874|内置规则对它的写操作直接拒绝，不弹审批|'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts',\n    outcome: "refuse",
CLAIM|7|一致|packages/application/src/rules/action-rules.ts:238@9fa3f97e451be1779313eb6fdb59c5d0c412d874|结果是主人点了“同意”，任务只能查、读，要写入、发送就被拒|'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts',
CLAIM|8|一致|.agents/plan-drafts/think-step-plan.md:10|方案 v2 写明：同意过的任务，读到外部内容之后，写操作由“直接拒绝”改成“要主人批准”|- A'：同意过的任务，读到外部内容之后，写操作由“直接拒绝”改成“要主人批准”（规则的结果值 `ask_owner` 已经有，`packages/application/src/rules/action-rules.ts:123`）。每个有后果的动作仍要主人点一下，所以人工闸门还在，但任务不会被一刀切死。内置的“拒绝”规则对 `schedule`、普通 `external_event` 这类后台运行保持不变。
CLAIM|9|一致|.agents/plan-drafts/think-step-plan.md:10|每个有后果的动作仍要主人点一下|- A'：同意过的任务，读到外部内容之后，写操作由“直接拒绝”改成“要主人批准”（规则的结果值 `ask_owner` 已经有，`packages/application/src/rules/action-rules.ts:123`）。每个有后果的动作仍要主人点一下，所以人工闸门还在，但任务不会被一刀切死。内置的“拒绝”规则对 `schedule`、普通 `external_event` 这类后台运行保持不变。
CLAIM|10|一致|.agents/plan-drafts/think-step-plan.md:7|不造绕过审批的口子|**我的理解和一处要先说清的**：写操作放开，但仍走现有审批规则，对外发送、花钱、删除照常弹审批，不造绕过审批的口子。这和下面“选项 A”稍有不同，我改成 A'：
CLAIM|11|一致|apps/agent-service/src/production-task-proposals.ts:155|同意后开的运行记成 `external_event`|triggerSource: "external_event",
CLAIM|12|一致|apps/agent-service/src/production-task-proposals.ts:155|`production-task-proposals.ts` 里的原文是 `triggerSource: "external_event",`|triggerSource: "external_event",
CLAIM|13|一致|apps/agent-service/src/production-task-proposals.ts:163|来源凭据是 `sourceProofRef: `proposal:${proposalId}:${session.proofRef}`,`|sourceProofRef: `proposal:${proposalId}:${session.proofRef}`,
CLAIM|14|一致|apps/agent-service/src/production-think-runner.ts:200|“想一想”自己的运行也记成 `external_event`|triggerSource: "external_event",
CLAIM|15|一致|apps/agent-service/src/production-think-runner.ts:208|`production-think-runner.ts` 里的原文是 `sourceProofRef: `think:${entry.id}`,`|sourceProofRef: `think:${entry.id}`,
CLAIM|16|一致|packages/application/src/rules/action-rules.ts:238@9fa3f97e451be1779313eb6fdb59c5d0c412d874|`refuseBackgroundAfterExternalContent` 对“不是主人消息发起、带外部内容”的非读取动作给出 `refuse`|'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts',\n    outcome: "refuse",
CLAIM|17|一致|packages/application/src/rules/action-rules.ts:122|`askAfterExternalContent` 对带外部内容的非读取动作给出 `ask_owner`|expression: `action_kind != "READ" && target_type != "managed-task" && "context_external_content" in facts && !(${OWNER_INTENT_CONFIRMED_EXPRESSION})`,\n    outcome: "ask_owner",
CLAIM|18|一致|packages/application/src/rules/action-rules.ts:357|两条同时命中时取更严的一条|STRICTNESS[hit.outcome] > STRICTNESS[strictest.outcome as ActionRuleOutcome]
CLAIM|19|一致|apps/agent-service/src/production-tool-actions.ts:191|`web_search`、`web_fetch`，登记表里 `resultOrigin: "external"`|resultOrigin: "external",
CLAIM|20|一致|apps/agent-service/src/production-tool-actions.ts:205|`web_search`、`web_fetch`，登记表里 `resultOrigin: "external"`|resultOrigin: "external",
CLAIM|21|一致|apps/agent-service/src/production-runtime-tools.ts:658|这次运行会被标上外部内容：`apps/agent-service/src/production-runtime-tools.ts` 的 `#markExternalContent`|await marker.mark(invocation.runId, origin);
CLAIM|22|一致|.agents/plan-drafts/think-step-plan.md:3|方案原文在 `.agents/plan-drafts/think-step-plan.md` 的“修订 v2”一节|# 修订 v2（2026-11-15，Andy 答复之后；和下文冲突时听这里的）
CLAIM|23|一致|docs/product-vision.md:55|依据愿景的裁决顺序：边界与可逆性高于主动性|*原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。*
CLAIM|24|一致|packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:133|给触发表加一个新的来源值：要重建表|  source_type TEXT NOT NULL CHECK (source_type IN ('user_message', 'schedule', 'external_event')),
CLAIM|25|一致|test/integration/tool-action-registry.test.ts:649|`test/integration/tool-action-registry.test.ts`（没读外部内容可写）|it("[ADR-0278] lets a task the owner agreed to set a reminder when nothing external was read, without marking the run", async () => {
CLAIM|26|一致|test/integration/tool-action-registry.test.ts:664|`test/integration/tool-action-registry.test.ts`（读后改成问主人）|it("[ADR-0278] asks the owner, instead of refusing, when a task the owner agreed to writes after reading external content", async () => {
CLAIM|27|一致|test/integration/tool-action-registry.test.ts:683|`test/integration/tool-action-registry.test.ts`（没有标记仍拒绝）|it("[ADR-0278] REVERSE: without the owner-approved mark the same external-event write is still refused", async () => {
CLAIM|28|一致|test/integration/task-proposals.test.ts:188|`test/integration/task-proposals.test.ts`（同意后来源带标记）|ownerApprovedTask: true,
CLAIM|29|一致|test/integration/task-proposals.test.ts:193|`test/integration/task-proposals.test.ts`（撤销后不带）|expect(await runSource.read(runId)).not.toHaveProperty("ownerApprovedTask");

未核实：Andy 2026-11-15 的同意原话和“约 0.6 美元可以花”属于仓库外协调者转述，未在仓库文档里找到逐字记录；Anthropic/OpenAI 等外部网页内容不在核对范围内。
