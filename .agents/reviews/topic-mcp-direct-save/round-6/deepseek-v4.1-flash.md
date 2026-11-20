CLAIM|1|一致|apps/agent-service/src/production-mcp-read.ts:144|外部 agent（例如 Muse、Claude）经 MCP（让 agent 调用外部工具的协议）的写工具 `propose_memory`、`propose_memories` 推来记忆|  "propose_memory",
CLAIM|2|不一致|apps/agent-service/src/production-mcp-read.ts:1354|现在一律先存进“待确认”|        if (direct && (await proposals.ready())) {
CLAIM|3|不一致|apps/agent-service/src/production-mcp-read.ts:1356|主人在 Himawari 里点过才保存|          if (kept === "saved") return proposalReply(MCP_PROPOSE_MEMORY_SAVED_DIRECT.text, false);
CLAIM|4|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:139|ADR 0242 决定 9 早已设计了每个接入一个“先问我 / 直接存，可整批撤销”的开关，默认先问，只有主人能改|   - 记忆和规则提议都是。每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。
CLAIM|5|一致|packages/persistence-sqlite/src/migrations/20261115113156_mcp_connections.sql:15|接入记录里也已经有 `push_policy` 一列|  push_policy TEXT NOT NULL CHECK (push_policy IN ('ask', 'direct')),
CLAIM|6|一致|apps/agent-service/src/production-mcp-connections-control.ts:289@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|网关一直拒绝把它设成“直接存”|  if (pushPolicy !== "ask")
CLAIM|7|一致|apps/agent-service/src/production-mcp-connections-control.ts:292@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|网关拒绝时抛 `MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE`|      "MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE",
CLAIM|8|一致|apps/agent-service/src/production-mcp-read.ts:1579@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|写工具也不看这一列|  return { id, entry, callKey: typeof callKey === "string" ? callKey : null };
CLAIM|9|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:139|开关已设计好：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md` 决定 9 的原文是“每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。”|   - 记忆和规则提议都是。每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。
CLAIM|10|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:140|“直接存”只管记忆：同文件决定 9 的 2026-11-12 补注原文是““直接存”只管记忆。规则提议不管开关怎么设，都要主人在 Himawari 里点头才生效”|   - 2026-11-12 补：“直接存”只管记忆。规则提议不管开关怎么设，都要主人在 Himawari 里点头才生效（[ADR 0213](0213-owner-sentence-becomes-a-standing-rule.md)：“模型推断出来的只生成提议，主人点头才生效”）。
CLAIM|11|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:1|待确认表已经存在|CREATE TABLE external_memory_proposals (
CLAIM|12|一致|apps/agent-service/src/production-mcp-memory-writer.ts:502|整批撤销已经存在：`ProductionMcpMemoryWriter.undoBatch`（`apps/agent-service/src/production-mcp-memory-writer.ts`）按批次号撤销|  async undoBatch(
CLAIM|13|一致|apps/agent-service/src/production-memory-control.ts:108|网关操作 `memory.external.undo`|  "memory.external.undo",
CLAIM|14|不一致|apps/agent-service/test/production-http-composition.unit.test.ts:1206|现在网关拒绝“直接存”|      expect((await read()).connections[0]?.pushPolicy).toBe("direct");
CLAIM|15|一致|apps/agent-service/src/production-mcp-connections-control.ts:289@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|改动前的 `apps/agent-service/src/production-mcp-connections-control.ts` 里 `askFirstOnly` 对 `pushPolicy !== "ask"` 抛错|  if (pushPolicy !== "ask")
CLAIM|16|一致|apps/agent-service/src/production-mcp-connections-control.ts:292@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|抛的错误码是 `MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE`|      "MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE",
CLAIM|17|一致|AGENTS.md:17|愿景 v2.2 起规则是 Andy 定的硬设定：`AGENTS.md` 产品愿景一节|- 自 v2.2 起，Andy 定的规则是硬性设定，不是记忆：规则写进程序、必定执行、每条有回归测试；记忆只保存规则的出处和修改历史。护城河是四样资产：记忆图谱、Agent 规则手册、长尾工具库、决策记录。把规则当记忆条目存储或注入的现有设计是已知缺口，列在 [ADR 0134](docs/adr/0134-adopt-product-vision-v2-2.md) 里，不是目标；现行愿景 v2.3 的采纳记录是 [ADR 0153](docs/adr/0153-adopt-product-vision-v2-3.md)。
CLAIM|18|一致|apps/agent-service/src/service-main.ts:2684|`runPolicy.mcpRead.proposals` 仍决定写工具出不出现（ADR 0227）|          ...(mcpReadConfiguration.proposals
CLAIM|19|一致|packages/gateway-contracts/src/contracts-v2.ts:1382|接口层新建仍必须明写 `pushPolicy`，不靠隐含默认|    pushPolicy: enumeration(MCP_CONNECTION_PUSH_POLICY_NAMES),
CLAIM|20|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:155|先照常提交（去重、机器密钥拒收、分级、决策记录 `pending`）中的“去重”|          WHERE owner_id = ? AND agent_id = ? AND text_sha256 = ? AND status <> 'superseded'`,
CLAIM|21|一致|apps/agent-service/src/production-mcp-memory-writer.ts:187|先照常提交（去重、机器密钥拒收、分级、决策记录 `pending`）中的“机器密钥拒收”|      proposalHasMachineSecret(text) ||
CLAIM|22|一致|apps/agent-service/src/production-mcp-memory-writer.ts:200|先照常提交（去重、机器密钥拒收、分级、决策记录 `pending`）中的“分级”|    const dataClassification = proposalClassification(text, input.category);
CLAIM|23|一致|apps/agent-service/src/production-mcp-memory-writer.ts:229|先照常提交（去重、机器密钥拒收、分级、决策记录 `pending`）中的“决策记录 `pending`”|          "pending",
CLAIM|24|一致|apps/agent-service/src/production-mcp-read.ts:1289|`propose_memories` 里被同一次调用后面同 `key` 条目替换的，不保存|          if (result["status"] !== "pending" || typeof result["proposalId"] !== "string") continue;
CLAIM|25|一致|apps/agent-service/src/production-mcp-read.ts:1284|`propose_memories` 里被同一次调用后面同 `key` 条目替换的，仍回 `replaced`|          result["status"] = "replaced";
CLAIM|26|一致|packages/application/src/ports/decision-ledger.ts:104|决策记录的原因码是 `mcp_proposal_kept_direct`（仍以 `mcp_proposal_` 开头，自动记忆校准照旧排除）中的“仍以 `mcp_proposal_` 开头”|export const EXTERNAL_PROPOSAL_REASON_PREFIX = "mcp_proposal_";
CLAIM|27|一致|packages/calibration/src/index.ts:666|决策记录的原因码是 `mcp_proposal_kept_direct`（仍以 `mcp_proposal_` 开头，自动记忆校准照旧排除）中的“自动记忆校准照旧排除”|        AND COALESCE(decision.reason_code, '') LIKE '${EXTERNAL_PROPOSAL_REASON_PATTERN}' ESCAPE '!')
CLAIM|28|一致|apps/agent-service/src/production-mcp-read.ts:982|`propose_rule` 不看 `pushPolicy`|            this.#proposeRule(rules, args, client, connection.id, handlerContext),
CLAIM|29|一致|apps/agent-service/src/production-mcp-read.ts:1062|`propose_rule` 仍要主人在客户端确认框里同意才生效|        return await this.#askRuleConfirmation(
CLAIM|30|一致|apps/agent-service/src/production-mcp-read.ts:830|外部 agent 的工具定义不随设置变|          description: MCP_TOOL_PROPOSE_MEMORY.text,
CLAIM|31|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:210|同一个 `key` 带来新内容，只替换还在待确认的旧内容|          WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'pending'
CLAIM|32|一致|apps/agent-service/src/production-mcp-memory-writer.ts:362|已经直接存下的旧记忆不会被改写|            decision: "create",
CLAIM|33|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:108|更新版本留给 `sync_memories`，ADR 0242 决定 6|   - 可以重复推：同编号同内容不产生任何东西；同编号新内容算更新，留历史版本。
CLAIM|34|一致|apps/agent-service/src/production-mcp-memory-writer.ts:94|敏感与否目前由 `proposalClassification` 判|export function proposalClassification(
CLAIM|35|一致|packages/gateway-contracts/src/contracts-v2.ts:2014|外部 agent 自己声明的分类是健康或财务|export const MEMORY_SENSITIVE_CATEGORY_NAMES = ["health", "finance"] as const;
CLAIM|36|不一致|packages/sensitive-capture/src/identifiers.ts:25|或正文里有证件号、银行卡号这类标识才升敏感|    (containsRestrictedIdentifier(text) || containsCredential(text))
CLAIM|37|不一致|packages/sensitive-capture/src/identifiers.ts:25|敏感分级只认外部 agent 自己声明的分类和正文里的证件号、银行卡号|    (containsRestrictedIdentifier(text) || containsCredential(text))
CLAIM|38|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:162|直接存的条目不占待确认和暂存的条数上限|        WHERE owner_id = ? AND agent_id = ? AND status <> 'committed' AND content_ref IS NOT NULL`,
CLAIM|39|不一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:167|只受每分钟调用次数和每次 50 条的限制|      ((held.pending ?? 0) >= EXTERNAL_PROPOSAL_PENDING_MAXIMUM ||
CLAIM|40|一致|test/integration/mcp-write.test.ts:2278|自动检查：`test/integration/mcp-write.test.ts` 里标了 `[direct]` 的用例|  it("[direct] saves a proposed memory at once on a connection set to direct save, with no confirmation box", async () => {
CLAIM|41|一致|test/integration/mcp-write.test.ts:2311|含反向用例（设成先问的接入仍进待确认、敏感留在待确认）|  it("[direct] still holds sensitive proposals for the owner, and a connection set to ask keeps asking", async () => {
CLAIM|42|一致|test/integration/mcp-write.test.ts:2388|含反向用例（规则不会自己生效）|  it("[direct] never turns a proposed rule into a rule without the owner, even on a connection set to direct save", async () => {
CLAIM|43|找不到|-|愿景 v2.2“规则是主人定的”|-
CLAIM|44|不一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:94|ADR 0242 决定 3 的方向是全局配置管写工具出不出现、接入上的设置在它之内再收窄|3. **`find_memories` 加两个可选参数。** `project`：只搜某个项目的项目笔记（见决定 8）。`auto`：调用方是钩子时用，最多 3 条，相关度不够就返回空（也不带“没有找到记忆”这类提示文字），门槛沿用 [ADR 0221](0221-memory-retrieval-relevance-cutoff-and-same-source-dedupe.md) 已有的那个。两个参数在 MCP 这一层处理，不原样交给检索代码。

未能核对的部分：`愿景 v2.2“规则是主人定的”` 的原文在仓库文档中没有找到，因此判为找不到；方案中属于新增或修改的行为（如 `batch-direct-` 批次号、新回执和工具说明改动、`Himawari` 自身请求一个字节都不变）不属于现状，未逐条列入核对。
