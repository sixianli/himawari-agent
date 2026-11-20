我会先阅读 ADR 文件，并核对其中关于代码和文档现状的说法。
CLAIM|1|一致|apps/agent-service/src/production-mcp-read.ts:143-148|外部 agent（例如 Muse、Claude）经 MCP（让 agent 调用外部工具的协议）的写工具 `propose_memory`、`propose_memories` 推来记忆|export const MCP_WRITE_TOOL_NAMES = [ "propose_memory", "propose_memories",
CLAIM|2|一致|apps/agent-service/src/production-mcp-read.ts:1300@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|本 ADR 之前一律先存进“待确认”|const { proposal } = await proposals.submit({
CLAIM|3|不一致|apps/agent-service/src/production-mcp-read.ts:1314@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|主人在 Himawari 里点过才保存|return await this.#askConfirmation(
CLAIM|4|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:139|ADR 0242 决定 9 早已设计了每个接入一个“先问我 / 直接存，可整批撤销”的开关，默认先问，只有主人能改|记忆和规则提议都是。每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。
CLAIM|5|一致|packages/persistence-sqlite/src/migrations/20261115113156_mcp_connections.sql:15|接入记录里也已经有 `push_policy` 一列|push_policy TEXT NOT NULL CHECK (push_policy IN ('ask', 'direct')),
CLAIM|6|一致|apps/agent-service/src/production-mcp-connections-control.ts:289@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|网关一直拒绝把它设成“直接存”（`MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE`）|if (pushPolicy !== "ask") throw new ApplicationPortError( PORT_ERROR_CODES.INVALID_OPERATION, "MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE",
CLAIM|7|一致|apps/agent-service/src/production-mcp-read.ts:1579@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|写工具也不看这一列|return { id, entry, callKey: typeof callKey === "string" ? callKey : null };
CLAIM|8|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:139|决定 9 的原文是“每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。”|记忆和规则提议都是。每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。
CLAIM|9|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:140|“直接存”只管记忆。规则提议不管开关怎么设，都要主人在 Himawari 里点头才生效|2026-11-12 补：“直接存”只管记忆。规则提议不管开关怎么设，都要主人在 Himawari 里点头才生效
CLAIM|10|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:1|待确认表已经存在|CREATE TABLE external_memory_proposals (
CLAIM|11|一致|apps/agent-service/src/production-mcp-memory-writer.ts:502-505|整批撤销已经存在|async undoBatch( batchId: string, trash: (memoryId: MemoryId) => Promise<void>,
CLAIM|12|一致|apps/agent-service/src/production-mcp-memory-writer.ts:507|`ProductionMcpMemoryWriter.undoBatch` 按批次号撤销|const members = await this.#options.proposals.listBatch({ ...this.#scope(), batchId });
CLAIM|13|一致|apps/agent-service/src/production-memory-control.ts:1780|网关操作 `memory.external.undo`|async #externalUndo(command: Command<"memory.external.undo">) {
CLAIM|14|一致|apps/agent-service/src/production-mcp-connections-control.ts:288-292@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|改动前网关拒绝“直接存”：改动前的 `apps/agent-service/src/production-mcp-connections-control.ts` 里 `askFirstOnly` 对 `pushPolicy !== "ask"` 抛 `MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE`|function askFirstOnly(pushPolicy: string): void { if (pushPolicy !== "ask") throw new ApplicationPortError( PORT_ERROR_CODES.INVALID_OPERATION, "MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE",
CLAIM|15|一致|AGENTS.md:17|愿景 v2.2 起规则是 Andy 定的硬设定：`AGENTS.md` 产品愿景一节|自 v2.2 起，Andy 定的规则是硬性设定，不是记忆：规则写进程序、必定执行、每条有回归测试；记忆只保存规则的出处和修改历史。
CLAIM|16|一致|docs/adr/0227-mcp-entry-checks-cloudflare-access-sign-in.md:71|`runPolicy.mcpRead.proposals` 仍决定写工具出不出现（ADR 0227）|`proposals` 这个全局开关仍然决定写工具出不出现
CLAIM|17|一致|apps/agent-service/src/production-mcp-connections-control.ts:120-123|只有主人在设置页能改|throw new ApplicationPortError( PORT_ERROR_CODES.NOT_AUTHORITATIVE, "MCP_CONNECTIONS_OWNER_REQUIRED",
CLAIM|18|一致|apps/agent-service/src/production-mcp-connections-control.ts:289@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|已有接入保持原来的“先问我”|if (pushPolicy !== "ask")
CLAIM|19|一致|packages/gateway-contracts/src/contracts-v2.ts:1382|接口层新建仍必须明写 `pushPolicy`，不靠隐含默认|pushPolicy: enumeration(MCP_CONNECTION_PUSH_POLICY_NAMES),
CLAIM|20|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:151-157|先照常提交：去重|const seen = this.database .prepare( `SELECT 1 FROM external_memory_proposals WHERE owner_id = ? AND agent_id = ? AND text_sha256 = ? AND status <> 'superseded'`,
CLAIM|21|一致|apps/agent-service/src/production-mcp-memory-writer.ts:187|先照常提交：机器密钥拒收|proposalHasMachineSecret(text) ||
CLAIM|22|一致|apps/agent-service/src/production-mcp-memory-writer.ts:200|先照常提交：分级|const dataClassification = proposalClassification(text, input.category);
CLAIM|23|一致|apps/agent-service/src/production-mcp-memory-writer.ts:228-231|决策记录 `pending`|this.#ledgerWrite( submitted.proposal, null, "pending",
CLAIM|24|一致|apps/agent-service/src/production-mcp-read.ts:1278-1284|`propose_memories` 里被同一次调用后面同 `key` 条目替换的，不保存，仍回 `replaced`|for (const result of results) if ( result["status"] === "pending" && typeof result["proposalId"] === "string" && replaced.has(result["proposalId"]) ) result["status"] = "replaced";
CLAIM|25|一致|packages/application/src/ports/decision-ledger.ts:104|决策记录的原因码仍以 `mcp_proposal_` 开头|export const EXTERNAL_PROPOSAL_REASON_PREFIX = "mcp_proposal_";
CLAIM|26|一致|packages/calibration/src/index.ts:665-666|自动记忆校准照旧排除|AND NOT (decision.kind = 'memory_candidate' AND COALESCE(decision.reason_code, '') LIKE '${EXTERNAL_PROPOSAL_REASON_PATTERN}' ESCAPE '!')
CLAIM|27|一致|apps/agent-service/src/production-mcp-read.ts:981-983|`propose_rule` 不看 `pushPolicy`|return this.#counted(connection, "propose_rule", client, () => this.#proposeRule(rules, args, client, connection.id, handlerContext), );
CLAIM|28|一致|apps/agent-service/src/production-mcp-read.ts:1062-1067|仍要主人在客户端确认框里同意才生效|return await this.#askRuleConfirmation( rules, { tool: "propose_rule", proposalId: randomUUID(), argsHash, client }, { ...parsed, type: parsed.type as ExternalRuleType, reason, client }, context, );
CLAIM|29|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:85|ADR 0242 决定 1 写明全局配置 `runPolicy.mcpRead.proposals` 管写工具出不出现、接入上的设置只能在它之内再收窄|和 ADR 0227 决定 3 的关系：全局配置 `runPolicy.mcpRead.proposals` 仍然决定写工具出不出现；接入上的设置只能在它之内再收窄（某个接入能不能推、推来的要不要先问、能读到哪一级），不能放宽。
CLAIM|30|一致|AGENTS.md:17|愿景 v2.2 起“Andy 定的规则是硬性设定”|自 v2.2 起，Andy 定的规则是硬性设定，不是记忆：规则写进程序、必定执行、每条有回归测试；记忆只保存规则的出处和修改历史。
CLAIM|31|一致|apps/agent-service/src/production-mcp-connections-control.ts:289@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|部署后已有的接入（例如 Muse）还是“先问我”|if (pushPolicy !== "ask")
CLAIM|32|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:208-214|同一个 `key` 带来新内容，只替换还在待确认的旧内容；已经直接存下的旧记忆不会被改写|`UPDATE external_memory_proposals SET status = 'superseded', decided_at = ?, superseded_by = ? WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'pending'
CLAIM|33|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:103|更新版本留给 `sync_memories`，ADR 0242 决定 6|6. **推：新工具 `sync_memories`，取代 `propose_memory` 和 ADR 0228 计划中的 `propose_memories`。**
CLAIM|34|一致|apps/agent-service/src/production-mcp-memory-writer.ts:94-97|敏感与否目前由 `proposalClassification` 判|export function proposalClassification( text: string, category: ExternalProposalCategory, ): "private" | "sensitive" {
CLAIM|35|一致|apps/agent-service/src/production-mcp-memory-writer.ts:98-100|外部 agent 自己声明的分类是健康或财务，才升敏感|return (MEMORY_SENSITIVE_CATEGORY_NAMES as readonly string[]).includes(category) ? "sensitive" : classificationWithIdentifiers(text, "private");
CLAIM|36|一致|packages/sensitive-capture/src/identifiers.ts:24-26|正文里有证件号、银行卡号这类标识，或有密码、验证码等凭据，才升敏感|return (classification === "private" || classification === "public") && (containsRestrictedIdentifier(text) || containsCredential(text)) ? "sensitive"
CLAIM|37|一致|apps/agent-service/src/production-mcp-memory-writer.ts:94-101|敏感分级只认外部 agent 自己声明的分类、正文里的证件号和银行卡号，以及密码、验证码等凭据|export function proposalClassification( text: string, category: ExternalProposalCategory, ): "private" | "sensitive" { return (MEMORY_SENSITIVE_CATEGORY_NAMES as readonly string[]).includes(category) ? "sensitive" : classificationWithIdentifiers(text, "private"); }
CLAIM|38|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:160-168|直接存的条目提交的瞬间仍计入待确认和暂存的条数上限，保存后不再计入|`SELECT SUM(status = 'pending') AS pending, COUNT(*) AS held FROM external_memory_proposals WHERE owner_id = ? AND agent_id = ? AND status <> 'committed' AND content_ref IS NOT NULL`
CLAIM|39|一致|apps/agent-service/src/bearer-admission.ts:4|另外还受每分钟调用次数|export const AUTHORIZED_PER_MINUTE = 30;
CLAIM|40|一致|apps/agent-service/src/production-mcp-read.ts:149|每次 50 条的限制|export const MCP_PROPOSE_MEMORIES_MAXIMUM = 50;
CLAIM|41|一致|test/integration/mcp-write.test.ts:2278|`test/integration/mcp-write.test.ts` 里标了 `[direct]` 的用例|it("[direct] saves a proposed memory at once on a connection set to direct save, with no confirmation box", async () => {
CLAIM|42|一致|test/integration/mcp-write.test.ts:2311|含反向用例（设成先问的接入仍进待确认、敏感留在待确认）|it("[direct] still holds sensitive proposals for the owner, and a connection set to ask keeps asking", async () => {
CLAIM|43|一致|test/integration/mcp-write.test.ts:2388|规则不会自己生效|it("[direct] never turns a proposed rule into a rule without the owner, even on a connection set to direct save", async () => {
CLAIM|44|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:101|ADR 0228 业界一节引用过|Claude 的「导入记忆」是直接存，事后在记忆面板里查看和删除（<https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude>）。

未核实：仓库外的 `/mnt/project-files/p5-memory-hub/coding-tasks.md`、外部网站与 Andy 的聊天/决定卡记录无法读取；生产库中实际名为 Muse 的接入是否存在也无从核对。
