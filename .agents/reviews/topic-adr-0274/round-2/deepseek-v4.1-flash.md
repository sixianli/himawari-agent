CLAIM|1|一致|apps/agent-service/src/production-proposals.ts:358|提议箱已经能存提议|  async propose(input: {
CLAIM|2|一致|apps/agent-service/src/production-proposals.ts:789|让主人采纳|  async adopt(
CLAIM|3|一致|apps/agent-service/src/production-reminder-proposals.ts:141|执行确定动作（改提醒时间、新建提醒）|      const moved = await writer.moveSchedule({
CLAIM|4|一致|apps/agent-service/src/production-reminder-proposals.ts:208|执行确定动作（改提醒时间、新建提醒）|        created = await writer.create({ ...request, sourceThreadId: parsed.threadId });
CLAIM|5|一致|apps/agent-service/src/production-task-proposals.ts:154|开一次“去办一件事”的运行|      await commands.admitOwnerMessage({
CLAIM|6|一致|apps/agent-service/src/production-proposals.ts:97|`apps/agent-service/src/production-proposals.ts` 的 `ProposalActionHandler`|export interface ProposalActionHandler {
CLAIM|7|一致|apps/agent-service/src/production-proposals.ts:269|提议箱已有两类处理方|  readonly #handlers = new Map<string, ProposalHandler | ProposalActionHandler>();
CLAIM|8|一致|apps/agent-service/src/production-proposals.ts:100|接口里的 `verify`|  verify(input: {
CLAIM|9|一致|apps/agent-service/src/production-proposals.ts:651|核对、领取、执行、读回、撤销五步中的领取|    const claimed = await store.claim({
CLAIM|10|一致|apps/agent-service/src/production-proposals.ts:105|接口里的 `execute`|  execute(input: {
CLAIM|11|一致|apps/agent-service/src/production-proposals.ts:111|接口里的 `readBack`|  readBack(input: {
CLAIM|12|一致|apps/agent-service/src/production-proposals.ts:116|接口里的 `undo`|  undo(input: {
CLAIM|13|一致|apps/agent-service/src/production-task-proposals.ts:154|`apps/agent-service/src/production-task-proposals.ts` 的 `execute` 调 `admitOwnerMessage`|      await commands.admitOwnerMessage({
CLAIM|14|一致|apps/agent-service/src/production-task-proposals.ts:155|调 `admitOwnerMessage` 时传 `triggerSource: "external_event"`|        triggerSource: "external_event",
CLAIM|15|一致|packages/persistence-sqlite/src/migrations/0001_initial_product_schema.sql:133|`CHECK (source_type IN ('user_message', 'schedule', 'external_event'))`|  source_type TEXT NOT NULL CHECK (source_type IN ('user_message', 'schedule', 'external_event')),
CLAIM|16|一致|packages/application/src/rules/action-rules.ts:238|来源不是主人消息的运行，读到外部内容之后，非读取、也不是管理任务的动作会被内置规则拒绝|      'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts',
CLAIM|17|一致|packages/application/src/rules/action-rules.ts:234|`refuseBackgroundAfterExternalContent`|    id: ACTION_RULE_IDS.refuseBackgroundAfterExternalContent,
CLAIM|18|一致|apps/agent-service/src/owner-scope-authorization.ts:250|`external_event` 来源的运行一律被标成有外来内容|      await marks.mark(invocation.runId, "external_event");
CLAIM|19|一致|apps/agent-service/src/production-runtime-tools.ts:437|一轮运行出工具的地方不按运行来源收窄、没有读运行来源的分支|  async listAuthorized(
CLAIM|20|一致|apps/agent-service/src/production-runtime-tools.ts:447|先放读、编码工具|              name: "read",
CLAIM|21|一致|apps/agent-service/src/production-runtime-tools.ts:461|先放读、编码工具|      for (const name of coding.enabledTools)
CLAIM|22|一致|apps/agent-service/src/production-runtime-tools.ts:507|再按配置逐个追加联网搜索、读网页、记忆检索、提醒、规则、感知工具|    if (this.#options.publicSearch)
CLAIM|23|一致|apps/agent-service/src/production-runtime-tools.ts:524|再按配置逐个追加联网搜索、读网页、记忆检索、提醒、规则、感知工具|    if (this.#options.publicFetch)
CLAIM|24|一致|apps/agent-service/src/production-runtime-tools.ts:599|再按配置逐个追加联网搜索、读网页、记忆检索、提醒、规则、感知工具|    if (this.#options.memoryRecall) descriptors.push(memoryRecallDescriptor());
CLAIM|25|一致|apps/agent-service/src/production-runtime-tools.ts:600|再按配置逐个追加联网搜索、读网页、记忆检索、提醒、规则、感知工具|    if (this.#options.reminders) descriptors.push(...reminderToolDescriptors());
CLAIM|26|一致|apps/agent-service/src/production-runtime-tools.ts:601|再按配置逐个追加联网搜索、读网页、记忆检索、提醒、规则、感知工具|    if (this.#options.ownerRules) descriptors.push(...ownerRuleToolDescriptors());
CLAIM|27|一致|apps/agent-service/src/production-runtime-tools.ts:602|再按配置逐个追加联网搜索、读网页、记忆检索、提醒、规则、感知工具|    if (this.#options.perception) descriptors.push(...perceptionToolDescriptors());
CLAIM|28|一致|apps/agent-service/src/production-tool-actions.ts:143|动作登记表里每个工具有动作类别|export const PRODUCTION_TOOL_ACTION_ROWS: readonly ToolActionRow[] = Object.freeze([
CLAIM|29|一致|apps/agent-service/src/production-tool-actions.ts:52|`READ_DEFAULTS`、`codingRead` 等行带 `actionKind: "READ"`|  actionKind: "READ",
CLAIM|30|一致|apps/agent-service/src/production-tool-actions.ts:90|`READ_DEFAULTS`、`codingRead` 等行带 `actionKind: "READ"`|    actionKind: "READ",
CLAIM|31|一致|apps/agent-service/src/production-tool-actions.ts:107|写文件、执行命令等行的 `actionKind` 不是 `READ`（例如 `CREATE_OR_UPDATE`、`INSTALL_OR_EXECUTE_CODE`）|    actionKind: "CREATE_OR_UPDATE",
CLAIM|32|一致|apps/agent-service/src/production-tool-actions.ts:156|写文件、执行命令等行的 `actionKind` 不是 `READ`（例如 `CREATE_OR_UPDATE`、`INSTALL_OR_EXECUTE_CODE`）|    actionKind: "INSTALL_OR_EXECUTE_CODE",
CLAIM|33|一致|packages/platform-node/src/memory-import-duplicate-decision.ts:81|已有 Jev 的三处现成调用：`packages/platform-node/src/memory-import-duplicate-decision.ts`|    const response = await (this.#options.fetch ?? globalThis.fetch)(`${base}/decisions`, {
CLAIM|34|一致|packages/platform-node/src/owner-intent-decision.ts:84|已有 Jev 的三处现成调用：`owner-intent-decision.ts`|    const response = await (this.#options.fetch ?? globalThis.fetch)(`${base}/decisions`, {
CLAIM|35|一致|packages/platform-node/src/voice-addressee-decision.ts:99|已有 Jev 的三处现成调用：`voice-addressee-decision.ts`|    const response = await (this.#options.fetch ?? globalThis.fetch)(`${base}/decisions`, {
CLAIM|36|一致|packages/platform-node/src/memory-import-duplicate-decision.ts:82|都走 `POST {gateway}/decisions`|      method: "POST",
CLAIM|37|一致|packages/platform-node/src/memory-import-duplicate-decision.ts:64|带 `providerOptions: { gateway: { zeroDataRetention: true } }`|    providerOptions: { gateway: { zeroDataRetention: true } },
CLAIM|38|一致|packages/application/src/services/owner-intent-answer.ts:118|每道选择题返回 `choice`|  const choice = answer["choice"];
CLAIM|39|一致|packages/application/src/services/owner-intent-answer.ts:121|每道选择题返回 `confidence`|  unitProbability(answer["confidence"]);
CLAIM|40|一致|packages/application/src/services/owner-intent-answer.ts:122|和各选项的 `probabilities`|  const table = probabilityTable(answer["probabilities"]);
CLAIM|41|一致|scripts/check-egress-redaction.mjs:81|`scripts/check-egress-redaction.mjs` 里登记了每个对外发文字的文件|export const ALLOWED_EXTERNAL_EGRESS_FILES = Object.freeze(
CLAIM|42|一致|scripts/check-egress-redaction.mjs:103|要求这些文件里有 `redactForExternalText(` 调用|    ["packages/platform-node/src/typesafe-jev-transport.ts", ["redactForExternalText"]],
CLAIM|43|一致|scripts/check-egress-redaction.mjs:223|发给外部服务的文字必须先过出口遮盖|                `${relative}: 发往外部服务（${name}）前要先遮敏感值，缺少 ${required}(…) 调用`,
CLAIM|44|一致|packages/prompt-catalog/prompt-manifest.json:3|提示词有摘要登记|    "sha256": "afce65646dc2f8bdc9076fd00806baa60eaee67805e089047ea244da805af01c",
CLAIM|45|一致|apps/agent-service/test/prompt-catalog.unit.test.ts:185|`apps/agent-service/test/prompt-catalog.unit.test.ts` 检查每条提示词有登记|    if (!row) problems.push(`PROMPT_MANIFEST_MISSING ${entry.id}`);
CLAIM|46|一致|apps/agent-service/test/prompt-catalog.unit.test.ts:187|摘要对得上|      if (row.sha256 !== digest(entry)) problems.push(`PROMPT_MANIFEST_STALE ${entry.id}`);
CLAIM|47|一致|docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md:11|规则：理解用户意思交给模型，程序只校验|# ADR 0249：几处靠词表猜意思的判断改由模型判断，程序只做校验
CLAIM|48|一致|docs/adr/0264-a-decision-model-decides-whether-a-name-call-is-meant-for-himawari.md:56|按 ADR 0264 记的每百万输入 token 0.042 美元算|Jev 在 Vercel 上的名字是 `typesafe-ai/jev`，每百万输入 token 0.042 美元，输出不收钱。来源：<https://vercel.com/ai-gateway/models/jev>。
CLAIM|49|一致|docs/adr/0271-memory-import-duplicates-judged-by-the-model.md:73|和 ADR 0271 一致|4. **门槛。**所选条目的概率达到 70% 才判 `same`，高于 30% 但不到 70% 判 `unsure`，不高于 30% 或选了 `none` 判 `different`。两个数都是配置项，写在服务配置里，网页上没有改它们的界面（`runPolicy.importDuplicates`，范围和默认值写在 `packages/application/src/ports/configuration.ts` 的 `IMPORT_DUPLICATE_DEFAULTS` 和 `IMPORT_DUPLICATE_RANGES`）。网页上：`same` 标“已经记着，跳过”并且不能勾选；`unsure` 标“可能已经记着，默认不导入”，主人可以自己勾；`skipped` 标“没能核对是否重复，默认不导入”。

未核对的部分：PR 520、533、534 与 ADR 0272 的先后只看了 git log，未按文件:行证据核对；Andy 2026-11-14/15 的两次答复和业界页面原话也未核实。决定部分的实现内容（含本 PR 新增的 worth/worker）属于方案内容，未按现状逐条列入。
