CLAIM|1|一致|apps/agent-service/src/production-proposals.ts:358|“主动提议下一步”的提议箱已经能存提议|async propose(input: {
CLAIM|2|一致|apps/agent-service/src/production-proposals.ts:80|让主人采纳|adopt(input: {
CLAIM|3|一致|apps/agent-service/src/production-reminder-proposals.ts:234|执行确定动作（改提醒时间）|box.register(REMINDER_RESCHEDULE_PROPOSAL_TYPE, reschedule);
CLAIM|4|一致|apps/agent-service/src/production-reminder-proposals.ts:235|执行确定动作（新建提醒）|box.register(REMINDER_CREATE_PROPOSAL_TYPE, create);
CLAIM|5|一致|apps/agent-service/src/production-task-proposals.ts:194|开一次“去办一件事”的运行|box.register(TASK_RUN_PROPOSAL_TYPE, handler);
CLAIM|6|找不到|-|Himawari 新知道一件事（一封邮件、一条新存下的记忆、一个提醒）时，没有统一的地方判断“要不要主动对主人说一句”|-
CLAIM|7|一致|apps/agent-service/src/production-proposals.ts:309|提议箱已有两类处理方|register(type: string, handler: ProposalHandler | ProposalActionHandler): void {
CLAIM|8|一致|apps/agent-service/src/production-proposals.ts:100|动作类处理方有核对|verify(input: {
CLAIM|9|一致|apps/agent-service/src/production-proposals.ts:651|动作类处理方有领取|const claimed = await store.claim({
CLAIM|10|一致|apps/agent-service/src/production-proposals.ts:105|动作类处理方有执行|execute(input: {
CLAIM|11|一致|apps/agent-service/src/production-proposals.ts:111|动作类处理方有读回|readBack(input: {
CLAIM|12|一致|apps/agent-service/src/production-proposals.ts:116|动作类处理方有撤销|undo(input: {
CLAIM|13|一致|apps/agent-service/src/production-task-proposals.ts:154|同意后开的运行，execute 调 admitOwnerMessage|await commands.admitOwnerMessage({
CLAIM|14|一致|apps/agent-service/src/production-task-proposals.ts:155|调 admitOwnerMessage 时传 triggerSource: "external_event"|triggerSource: "external_event",
CLAIM|15|一致|packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:133|触发表的来源只允许三种|source_type TEXT NOT NULL CHECK (source_type IN ('user_message', 'schedule', 'external_event')),
CLAIM|16|不一致|packages/application/src/rules/action-rules.ts:238|后台运行里任何非读取的动作会被内置规则拒绝|'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts',
CLAIM|17|一致|packages/application/src/rules/action-rules.ts:234|规则是 refuseBackgroundAfterExternalContent|id: ACTION_RULE_IDS.refuseBackgroundAfterExternalContent,
CLAIM|18|一致|apps/agent-service/src/owner-scope-authorization.ts:250|external_event 来源的运行一律被标成有外来内容|await marks.mark(invocation.runId, "external_event");
CLAIM|19|一致|apps/agent-service/src/production-runtime-tools.ts:437|一轮运行出工具的地方不按运行来源收窄，没有读运行来源的分支|async listAuthorized(
CLAIM|20|一致|apps/agent-service/src/production-runtime-tools.ts:448|给一轮运行出工具的函数先放读工具|definition: "builtin-read",
CLAIM|21|一致|apps/agent-service/src/production-runtime-tools.ts:454|先放读、编码工具中的编码工具|const coding = this.#options.coding;
CLAIM|22|一致|apps/agent-service/src/production-runtime-tools.ts:507|再按配置逐个追加联网搜索、读网页、记忆检索、提醒、规则、感知工具|if (this.#options.publicSearch)
CLAIM|23|一致|packages/application/src/services/tool-action-registry.ts:42|动作登记表里每个工具有动作类别|readonly actionKind: ActionKind;
CLAIM|24|一致|apps/agent-service/src/production-tool-actions.ts:52|READ_DEFAULTS 等行带 actionKind: "READ"|actionKind: "READ",
CLAIM|25|一致|apps/agent-service/src/production-tool-actions.ts:90|codingRead 等行带 actionKind: "READ"|actionKind: "READ",
CLAIM|26|不一致|apps/agent-service/src/production-tool-actions.ts:156|写类行是 CREATE_OR_UPDATE|actionKind: "INSTALL_OR_EXECUTE_CODE",
CLAIM|27|一致|packages/platform-node/src/memory-import-duplicate-decision.ts:68|是非题的判断已有 Jev 的三处现成调用之一：memory-import-duplicate-decision.ts|export class MemoryImportDuplicateDecision implements ImportDuplicateDecisionPort {
CLAIM|28|一致|packages/platform-node/src/owner-intent-decision.ts:75|是非题的判断已有 Jev 的三处现成调用之一：owner-intent-decision.ts|export class OwnerIntentDecision implements OwnerIntentCheckPort {
CLAIM|29|一致|packages/platform-node/src/voice-addressee-decision.ts:78|是非题的判断已有 Jev 的三处现成调用之一：voice-addressee-decision.ts|export class VoiceAddresseeDecision implements VoiceAddresseeModel {
CLAIM|30|一致|packages/platform-node/src/memory-import-duplicate-decision.ts:81|都走 {gateway}/decisions|const response = await (this.#options.fetch ?? globalThis.fetch)(`${base}/decisions`, {
CLAIM|31|一致|packages/platform-node/src/memory-import-duplicate-decision.ts:82|都走 POST|method: "POST",
CLAIM|32|一致|packages/platform-node/src/owner-intent-decision.ts:68|带 providerOptions: { gateway: { zeroDataRetention: true } }|providerOptions: { gateway: { zeroDataRetention: true } },
CLAIM|33|一致|packages/application/src/services/owner-intent-answer.ts:118|每道选择题返回 choice|const choice = answer["choice"];
CLAIM|34|一致|packages/application/src/services/owner-intent-answer.ts:121|每道选择题返回 confidence|unitProbability(answer["confidence"]);
CLAIM|35|一致|packages/application/src/services/owner-intent-answer.ts:122|每道选择题返回各选项的 probabilities|const table = probabilityTable(answer["probabilities"]);
CLAIM|36|一致|scripts/check-egress-redaction.mjs:221|发给外部服务的文字必须先过出口遮盖|`${relative}: 发往外部服务（${name}）前要先遮敏感值，缺少 ${required}(…) 调用`,
CLAIM|37|不一致|scripts/check-egress-redaction.mjs:219|scripts/check-egress-redaction.mjs，调用 redactForExternalText|if (!new RegExp(`\\b${required}\\(`, "u").test(text))
CLAIM|38|一致|apps/agent-service/test/prompt-catalog.unit.test.ts:325|模型要看的提示词都登记在目录里|it("finds no prompt-like literal outside the catalog", () => {
CLAIM|39|一致|packages/prompt-catalog/prompt-manifest.json:3|有摘要登记：prompt-manifest.json|"sha256": "afce65646dc2f8bdc9076fd00806baa60eaee67805e089047ea244da805af01c",
CLAIM|40|一致|apps/agent-service/test/prompt-catalog.unit.test.ts:185|prompt-catalog.unit.test.ts 检查每条提示词有登记|if (!row) problems.push(`PROMPT_MANIFEST_MISSING ${entry.id}`);
CLAIM|41|一致|apps/agent-service/test/prompt-catalog.unit.test.ts:187|prompt-catalog.unit.test.ts 检查摘要对得上|if (row.sha256 !== digest(entry)) problems.push(`PROMPT_MANIFEST_STALE ${entry.id}`);
CLAIM|42|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|规则：理解用户意思交给模型，程序只校验（ADR 0249）|Andy 在 2026-11-12 定的 agent 开发基本原则是：理解用户的意思（意图、时效、是否明说等）一律交给模型判断，不用关键词表、正则或写死的词典。
CLAIM|43|一致|docs/adr/0271-memory-import-duplicates-judged-by-the-model.md:73|和 ADR 0271 一致|所选条目的概率达到 70% 才判 `same`，高于 30% 但不到 70% 判 `unsure`，不高于 30% 或选了 `none` 判 `different`。
CLAIM|44|一致|docs/adr/0264-a-decision-model-decides-whether-a-name-call-is-meant-for-himawari.md:56|按 ADR 0264 记的每百万输入 token 0.042 美元算|Jev 在 Vercel 上的名字是 `typesafe-ai/jev`，每百万输入 token 0.042 美元，输出不收钱。
CLAIM|45|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:28|用词表判断“值不值得提”。违反 ADR 0249|Andy 在 2026-11-12 定的 agent 开发基本原则是：理解用户的意思（意图、时效、是否明说等）一律交给模型判断，不用关键词表、正则或写死的词典。

未核实：背景里“没有统一的地方判断”是缺席性说法，仓库里没有读到能证明它的内容；Andy 的两次日期决定、PR 520/533/534 编号及业界页面也未核对。方案中 think_inbox、ThinkSourceRegistry、ProductionThinkWorker、runPolicy.thinkInbox 等属于计划新增，按要求未当作现状；方案没有“原来/已删除/改之前”的旧代码，因此未使用基线提交。
