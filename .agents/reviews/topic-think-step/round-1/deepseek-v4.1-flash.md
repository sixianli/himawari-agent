CLAIM|1|一致|apps/agent-service/src/production-proposals.ts:267|第 1 步已经做完：提议箱|export class ProductionProposalBox {
CLAIM|2|一致|docs/architecture-v0.1.md:434|第 1 步已经做完：两种确定动作|`apps/agent-service/src/production-reminder-proposals.ts` 登记 `reminder.reschedule` 和 `reminder.create` 两个确定动作处理方
CLAIM|3|一致|apps/agent-service/src/production-task-proposals.ts:155|第 1 步已经做完：“去办一件事”开运行|triggerSource: "external_event",
CLAIM|4|不一致|apps/control-center/src/i18n/resources/zh-CN.ts:925|我们已经是这个形态（一句问话、肯定按钮、“不用”、为什么、风险档位）|"proposals.reject": "不要",
CLAIM|5|一致|docs/architecture-v0.1.md:434|第 1 步已做好|这一步还没有来源调用它们，所以现在界面上不会出现这两种提议
CLAIM|6|一致|docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:148|后台运行读到外来内容后，写操作要拦住，这和我们已有的做法（ADR 0257）一致|| 后台发起的一轮，上下文里有外来内容，想做有后果的事 | 不做，也不建等着的审批；记一条决策记录，并把“想做什么”作为提议候选交出去 |
CLAIM|7|一致|docs/architecture-v0.1.md:434|现在她只会等人问|这一步还没有来源调用它们，所以现在界面上不会出现这两种提议
CLAIM|8|一致|docs/architecture-v0.1.md:432|没有一个统一入口：新知道一件事时，没有地方判断“要不要主动说一句”|入口表和对话外想一想要在后面的步骤里接上；这一步没有调模型
CLAIM|9|一致|apps/agent-service/src/production-proposals.ts:309|提议箱已有两类处理方，一步动作和“去办一件事”都能登记|register(type: string, handler: ProposalHandler | ProposalActionHandler): void {
CLAIM|10|一致|apps/agent-service/src/production-proposals.ts:97|ProposalActionHandler（接口里的 verify、execute、readBack、undo）|export interface ProposalActionHandler {
CLAIM|11|一致|apps/agent-service/src/production-task-proposals.ts:231|合并的提交 8fc09d2b3（PR 534）|export async function proposeTaskRun(
CLAIM|12|一致|apps/agent-service/src/production-reminder-proposals.ts:269|合并的提交 e2af70416（PR 533）|export async function proposeReminderReschedule(
CLAIM|13|一致|docs/architecture-v0.1.md:434|现在没有任何来源调用 proposeReminderReschedule、proposeReminderCreate、proposeTaskRun|这一步还没有来源调用它们，所以现在界面上不会出现这两种提议
CLAIM|14|一致|apps/agent-service/src/production-task-proposals.ts:231|这三个函数在 apps/agent-service/src 里只被定义和被测试引用|export async function proposeTaskRun(
CLAIM|15|一致|apps/agent-service/src/production-model-composition.ts:531|后台模型调用的现有写法是“一段提示进、一段文字出”，不带工具：apps/agent-service/src/production-model-composition.ts:531（async prepare({ invocationId, prompt, deadlineAt, dataClassification })）|async prepare({ invocationId, prompt, deadlineAt, dataClassification }) {
CLAIM|16|一致|packages/application/src/services/unified-trigger-ingestion-service.ts:13|应用层有“定时、外部事件也能当触发来源”的类型：packages/application/src/services/unified-trigger-ingestion-service.ts:13（export type UnifiedTriggerSource = "user_message" ｜ "schedule" ｜ "external_event";）|export type UnifiedTriggerSource = "user_message" | "schedule" | "external_event";
CLAIM|17|一致|packages/application/src/services/unified-trigger-ingestion-service.ts:45|生产服务没有接线|private readonly admission: TriggerAdmissionPort;
CLAIM|18|一致|packages/platform-node/src/memory-import-duplicate-decision.ts:81|POST ${base}/decisions，经 Vercel AI Gateway|const response = await (this.#options.fetch ?? globalThis.fetch)(`${base}/decisions`, {
CLAIM|19|一致|packages/platform-node/src/memory-import-duplicate-decision.ts:64|带 zeroDataRetention: true，同文件第 64 行|providerOptions: { gateway: { zeroDataRetention: true } },
CLAIM|20|一致|packages/platform-node/src/owner-intent-decision.ts:84|权限审批用的是 packages/platform-node/src/owner-intent-decision.ts:84|const response = await (this.#options.fetch ?? globalThis.fetch)(`${base}/decisions`, {
CLAIM|21|一致|apps/agent-service/src/owner-scope-authorization.ts:250|这类运行里不管读没读外部内容，授权这一步都会把它标成“有外来内容”：apps/agent-service/src/owner-scope-authorization.ts:249（if (source.sourceType === "external_event") await marks.mark(invocation.runId, "external_event");）|await marks.mark(invocation.runId, "external_event");
CLAIM|22|一致|packages/application/src/rules/action-rules.ts:238|内置规则拒绝其中的写操作：packages/application/src/rules/action-rules.ts:238（action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts → 拒绝）|'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts',
CLAIM|23|一致|packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:133|触发来源只有三种|source_type TEXT NOT NULL CHECK (source_type IN ('user_message', 'schedule', 'external_event')),
CLAIM|24|一致|packages/persistence-sqlite/src/sqlite-run-lifecycle-operations.ts:958|首页“正在做的”取的是来源不是 user_message 的运行：packages/persistence-sqlite/src/sqlite-run-lifecycle-operations.ts:958（AND t.source_type != 'user_message'）|AND t.source_type != 'user_message')
CLAIM|25|找不到|-|第 1 步计划原文规定提议类型、按钮字数、不写死：/mnt/project-files/ambient-sensing/proposed-actions-plan.md（“审核后改的地方”一节优先）|-
CLAIM|26|一致|.claude/rules/owner-standing-rules.md:62|不用词表判断“用户想要什么”：判断全部交给模型，程序只校验格式和白名单（符合 owner-standing-rules.md 里的规定）|判断用户一句话的意图、时效、是否明说、两句话是不是同一件事，一律交给模型，程序只做校验
CLAIM|27|不一致|docs/execution/specs/2026-09-07-real-file-summary-agent-loop-design.md:77|没有仓库里的价格表|| 角色 | 模型与路由 | 输入 / 输出 / 缓存读取价格，美元每百万 token |
CLAIM|28|不一致|docs/adr/0264-a-decision-model-decides-whether-a-name-call-is-meant-for-himawari.md:56|Jev 实际价格没有查到，要查|Jev 在 Vercel 上的名字是 `typesafe-ai/jev`，每百万输入 token 0.042 美元，输出不收钱。
CLAIM|29|不一致|packages/application/src/rules/action-rules.ts:238|现状（前提 6）：同意后开的运行记成 external_event，授权一律当它有外来内容，所以它一切非读取动作被直接拒绝，不弹审批|'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts',
CLAIM|30|一致|apps/agent-service/src/production-task-proposals.ts:163|触发的来源凭据已经写着提议编号（PR 534 的 sourceProofRef: proposal:<编号>:<凭据>）|sourceProofRef: `proposal:${proposalId}:${session.proofRef}`,
CLAIM|31|一致|packages/application/src/rules/action-rules.ts:238|因为 refuseBackgroundAfterExternalContent 的条件没变，只是不再无条件标上|'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts',
CLAIM|32|一致|.agents/instructions/prompt-prefix.md:55|提示词登记（走 prompt-catalog…）|Himawari 自己写的固定文字（提示词目录 `packages/prompt-catalog` 里不少于 24 个字符
CLAIM|33|一致|.agents/instructions/prompt-prefix.md:10|对着 prompt-prefix.md 的规则只追加|相关决定见 [ADR 0149](../../docs/adr/0149-append-only-model-requests.md)（只追加）
CLAIM|34|找不到|-|删掉 v0.2 没接上线的“主动建议”代码和合约（计划里的前提 21、22）|-
CLAIM|35|不一致|packages/platform-node/src/voice-addressee-decision.ts:99|只读了现有的两处调用代码|const response = await (this.#options.fetch ?? globalThis.fetch)(`${base}/decisions`, {

没能核对的部分：`/mnt/project-files/ambient-sensing/proposed-actions-plan.md` 及其“审核后改的地方”和前提 21、22 无法读取；v0.2“主动建议”的代码和合约在仓库里没有找到对应内容；模型花费预估里的复核账数字也未逐项核对。
