CLAIM|1|一致|apps/agent-service/src/production-task-proposals.ts:28|提议箱里有一种提议叫“交给我去办一件事”（`task.run`）。|export const TASK_RUN_PROPOSAL_TYPE = "task.run";
CLAIM|2|一致|apps/agent-service/src/production-task-proposals.ts:147|主人同意后，Himawari 新开一个对话，把任务说明交给一次后台运行去办。|const created = await commands.create({
CLAIM|3|一致|apps/agent-service/src/production-task-proposals.ts:155|这次运行的触发来源是 `external_event`|triggerSource: "external_event",
CLAIM|4|一致|apps/agent-service/src/owner-scope-authorization.ts:261@ec350d9a5664d994f30f40487d28c1065db97d11|授权层把这类运行一律当成带外部内容|await marks.mark(invocation.runId, "external_event");
CLAIM|5|一致|packages/application/src/rules/action-rules.ts:238@ec350d9a5664d994f30f40487d28c1065db97d11|内置规则对它的写操作直接拒绝|'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts',
CLAIM|6|一致|packages/application/src/rules/action-rules.ts:28@ec350d9a5664d994f30f40487d28c1065db97d11|不弹审批|refuse: 2,
CLAIM|7|一致|packages/application/src/rules/action-rules.ts:238@ec350d9a5664d994f30f40487d28c1065db97d11|结果是主人点了“同意”，任务只能查、读，要写入、发送就被拒|'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts',
CLAIM|8|一致|apps/agent-service/src/production-task-proposals.ts:155|同意后开的运行记成 `external_event`|triggerSource: "external_event",
CLAIM|9|一致|apps/agent-service/src/production-task-proposals.ts:155|`apps/agent-service/src/production-task-proposals.ts` 里的原文是 `triggerSource: "external_event",`|triggerSource: "external_event",
CLAIM|10|一致|apps/agent-service/src/production-task-proposals.ts:163|来源凭据是 `` sourceProofRef: `proposal:${proposalId}:${session.proofRef}`, ``|sourceProofRef: `proposal:${proposalId}:${session.proofRef}`,
CLAIM|11|一致|apps/agent-service/src/production-think-runner.ts:200|“想一想”自己的运行也记成 `external_event`|triggerSource: "external_event",
CLAIM|12|一致|apps/agent-service/src/production-think-runner.ts:208|但来源凭据不同：`apps/agent-service/src/production-think-runner.ts` 里的原文是 `` sourceProofRef: `think:${entry.id}`, ``|sourceProofRef: `think:${entry.id}`,
CLAIM|13|一致|packages/application/src/rules/action-rules.ts:239@ec350d9a5664d994f30f40487d28c1065db97d11|内置规则 `refuseBackgroundAfterExternalContent` 对“不是主人消息发起、带外部内容”的非读取动作给出 `refuse`|outcome: "refuse",
CLAIM|14|一致|packages/application/src/rules/action-rules.ts:123|`askAfterExternalContent` 对带外部内容的非读取动作给出 `ask_owner`：见 `packages/application/src/rules/action-rules.ts`|outcome: "ask_owner",
CLAIM|15|一致|packages/application/src/rules/action-rules.ts:357|两条同时命中时取更严的一条。|STRICTNESS[hit.outcome] > STRICTNESS[strictest.outcome as ActionRuleOutcome]
CLAIM|16|一致|apps/agent-service/src/production-runtime-tools.ts:644|工具读到的内容不是主人自己的数据时|if (row?.resultOrigin === "owner_data") return null;
CLAIM|17|一致|apps/agent-service/src/production-tool-actions.ts:191|例如 `web_search`、`web_fetch`，登记表里 `resultOrigin: "external"`|resultOrigin: "external",
CLAIM|18|一致|apps/agent-service/src/production-tool-actions.ts:205|例如 `web_search`、`web_fetch`，登记表里 `resultOrigin: "external"`|resultOrigin: "external",
CLAIM|19|一致|apps/agent-service/src/production-runtime-tools.ts:658|这次运行会被标上外部内容：`apps/agent-service/src/production-runtime-tools.ts` 的 `#markExternalContent`|await marker.mark(invocation.runId, origin);
CLAIM|20|一致|.agents/plan-drafts/think-step-plan.md:3|方案原文在 `.agents/plan-drafts/think-step-plan.md` 的“修订 v2”一节。|# 修订 v2（2026-11-15，Andy 答复之后；和下文冲突时听这里的）
CLAIM|21|一致|docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:148|内置规则 `refuseBackgroundAfterExternalContent`（ADR 0257 决定 3 定的）|｜ 后台发起的一轮，上下文里有外来内容，想做有后果的事 ｜ 不做，也不建等着的审批；记一条决策记录，并把“想做什么”作为提议候选交出去 ｜
CLAIM|22|一致|packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:133|给触发表加一个新的来源值：要重建表|source_type TEXT NOT NULL CHECK (source_type IN ('user_message', 'schedule', 'external_event')),
CLAIM|23|一致|packages/application/src/rules/action-rules.ts:238@ec350d9a5664d994f30f40487d28c1065db97d11|保持直接拒绝，任务只能读|'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts',
CLAIM|24|一致|apps/agent-service/src/production-task-proposals.ts:191|`task.run` 提议没有撤销入口|throw new ProposalError("PROPOSAL_NOT_UNDOABLE", "TASK_RUN_NOT_UNDOABLE");
CLAIM|25|一致|apps/agent-service/src/production-device-action-authorization.ts:59|设备动作里不允许外部内容引出的那些（例如日历、联系人、家居），读过外部内容后仍直接拒绝，和主人自己发起的运行一样，这个改动不放宽它们。|if (!intent.untrustedOriginAllowed && intent.readUntrustedContent)
CLAIM|26|一致|test/integration/tool-action-registry.test.ts:649|`test/integration/tool-action-registry.test.ts`（没读外部内容可写、读后改成问主人、没有标记仍拒绝）|it("[ADR-0278] lets a task the owner agreed to set a reminder when nothing external was read, without marking the run", async () => {
CLAIM|27|一致|test/integration/tool-action-registry.test.ts:664|`test/integration/tool-action-registry.test.ts`（没读外部内容可写、读后改成问主人、没有标记仍拒绝）|it("[ADR-0278] asks the owner, instead of refusing, when a task the owner agreed to writes after reading external content", async () => {
CLAIM|28|一致|test/integration/tool-action-registry.test.ts:683|`test/integration/tool-action-registry.test.ts`（没读外部内容可写、读后改成问主人、没有标记仍拒绝）|it("[ADR-0278] REVERSE: without the owner-approved mark the same external-event write is still refused", async () => {
CLAIM|29|一致|test/integration/task-proposals.test.ts:188|`test/integration/task-proposals.test.ts`（同意后来源带标记，撤销后不带）|ownerApprovedTask: true,
CLAIM|30|不一致|test/integration/task-proposals.test.ts:191|`test/integration/task-proposals.test.ts`（同意后来源带标记，撤销后不带）|tamper.prepare("UPDATE owner_proposals SET status = 'pending', decided_at = NULL").run();
CLAIM|31|一致|docs/product-vision.md:55|依据愿景的裁决顺序：边界与可逆性高于主动性。|*原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。*

Andy 同意的原话和协调者转述在仓库外，未能核实；方案文件“修订 v2”一节存在，但未逐字出现该段引语。Claude for Chrome 和 OpenAI 帮助页属于外部网站，未核对。
