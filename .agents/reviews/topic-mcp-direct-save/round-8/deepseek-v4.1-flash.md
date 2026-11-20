CLAIM|1|一致|apps/agent-service/src/production-mcp-read.ts:144|外部 agent（例如 Muse、Claude）经 MCP（让 agent 调用外部工具的协议）的写工具 `propose_memory`、`propose_memories` 推来记忆|  "propose_memory",
CLAIM|2|一致|apps/agent-service/src/production-mcp-read.ts:145|外部 agent（例如 Muse、Claude）经 MCP（让 agent 调用外部工具的协议）的写工具 `propose_memory`、`propose_memories` 推来记忆|  "propose_memories",
CLAIM|3|一致|apps/agent-service/src/production-mcp-read.ts:1342|在接入设为“先问我”时一律先存进“待确认”|        const { proposal } = await proposals.submit({
CLAIM|4|不一致|apps/agent-service/src/production-mcp-read.ts:1364|主人在 Himawari 里点过才保存|        return await this.#askConfirmation(
CLAIM|5|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:139|ADR 0242 决定 9 早已设计了每个接入一个“先问我 / 直接存，可整批撤销”的开关，默认先问，只有主人能改|   - 记忆和规则提议都是。每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。
CLAIM|6|一致|packages/persistence-sqlite/src/migrations/20261115113156_mcp_connections.sql:15|接入记录里也已经有 `push_policy` 一列|  push_policy TEXT NOT NULL CHECK (push_policy IN ('ask', 'direct')),
CLAIM|7|一致|apps/agent-service/src/production-mcp-connections-control.ts:289@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|网关一直拒绝把它设成“直接存”|  if (pushPolicy !== "ask")
CLAIM|8|一致|apps/agent-service/src/production-mcp-connections-control.ts:292@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|（`MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE`）|      "MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE",
CLAIM|9|一致|apps/agent-service/src/production-mcp-read.ts:1579@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|写工具也不看这一列|  return { id, entry, callKey: typeof callKey === "string" ? callKey : null };
CLAIM|10|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:139|每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。|   - 记忆和规则提议都是。每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。
CLAIM|11|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:140|“直接存”只管记忆。规则提议不管开关怎么设，都要主人在 Himawari 里点头才生效|   - 2026-11-12 补：“直接存”只管记忆。规则提议不管开关怎么设，都要主人在 Himawari 里点头才生效（[ADR 0213](0213-owner-sentence-becomes-a-standing-rule.md)：“模型推断出来的只生成提议，主人点头才生效”）。
CLAIM|12|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:1|待确认表已经存在|CREATE TABLE external_memory_proposals (
CLAIM|13|一致|apps/agent-service/src/production-mcp-memory-writer.ts:502|整批撤销已经存在|  async undoBatch(
CLAIM|14|一致|apps/agent-service/src/production-mcp-memory-writer.ts:507|`ProductionMcpMemoryWriter.undoBatch`（`apps/agent-service/src/production-mcp-memory-writer.ts`）按批次号撤销|      const members = await this.#options.proposals.listBatch({ ...this.#scope(), batchId });
CLAIM|15|一致|packages/gateway-contracts/src/contracts-v2.ts:107|网关操作 `memory.external.undo`|  "memory.external.undo",
CLAIM|16|一致|apps/agent-service/src/production-mcp-connections-control.ts:289@3633e576b582a2d5eb5b93cda61aa6fb195bfc6a|此前网关不接受把接入设成“直接存”|  if (pushPolicy !== "ask")
CLAIM|17|一致|AGENTS.md:17|愿景 v2.2 起规则是 Andy 定的硬设定：`AGENTS.md` 产品愿景一节|  - 自 v2.2 起，Andy 定的规则是硬性设定，不是记忆：规则写进程序、必定执行、每条有回归测试；记忆只保存规则的出处和修改历史。护城河是四样资产：记忆图谱、Agent 规则手册、长尾工具库、决策记录。把规则当记忆条目存储或注入的现有设计是已知缺口，列在 [ADR 0134](docs/adr/0134-adopt-product-vision-v2-2.md) 里，不是目标；现行愿景 v2.3 的采纳记录是 [ADR 0153](docs/adr/0153-adopt-product-vision-v2-3.md)。
CLAIM|18|一致|apps/agent-service/src/service-main.ts:2684|`runPolicy.mcpRead.proposals` 仍决定写工具出不出现（ADR 0227）|          ...(mcpReadConfiguration.proposals
CLAIM|19|一致|apps/agent-service/src/production-mcp-read.ts:818|关掉它就没有写工具|      proposals &&
CLAIM|20|一致|packages/gateway-contracts/src/contracts-v2.ts:1382|接口层新建仍必须明写 `pushPolicy`，不靠隐含默认|    pushPolicy: enumeration(MCP_CONNECTION_PUSH_POLICY_NAMES),
CLAIM|21|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:155|去重|          WHERE owner_id = ? AND agent_id = ? AND text_sha256 = ? AND status <> 'superseded'
CLAIM|22|一致|apps/agent-service/src/production-mcp-memory-writer.ts:187|机器密钥拒收|      proposalHasMachineSecret(text) ||
CLAIM|23|一致|apps/agent-service/src/production-mcp-memory-writer.ts:200|分级|    const dataClassification = proposalClassification(text, input.category);
CLAIM|24|一致|apps/agent-service/src/production-mcp-memory-writer.ts:229|决策记录 `pending`|          "pending",
CLAIM|25|一致|apps/agent-service/src/production-mcp-read.ts:1284|`propose_memories` 里被同一次调用后面同 `key` 条目替换的，不保存，仍回 `replaced`|          result["status"] = "replaced";
CLAIM|26|一致|apps/agent-service/src/production-mcp-read.ts:982|`propose_rule` 不看 `pushPolicy`|            this.#proposeRule(rules, args, client, connection.id, handlerContext),
CLAIM|27|一致|apps/agent-service/src/production-mcp-read.ts:1058|仍要主人在客户端确认框里同意才生效|        if (!elicitationSupported(context.mcpReq.envelope))
CLAIM|28|一致|apps/agent-service/src/production-mcp-read.ts:830|外部 agent 的工具定义不随设置变|          description: MCP_TOOL_PROPOSE_MEMORY.text,
CLAIM|29|一致|packages/application/src/ports/decision-ledger.ts:104|仍以 `mcp_proposal_` 开头|export const EXTERNAL_PROPOSAL_REASON_PREFIX = "mcp_proposal_";
CLAIM|30|一致|packages/calibration/src/index.ts:648|自动记忆校准照旧排除|export const EXTERNAL_PROPOSAL_REASON_PATTERN = "mcp!_proposal!_%";
CLAIM|31|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:85|ADR 0242 决定 1 写明全局配置 `runPolicy.mcpRead.proposals` 管写工具出不出现、接入上的设置只能在它之内再收窄|   - 和 ADR 0227 决定 3 的关系：全局配置 `runPolicy.mcpRead.proposals` 仍然决定写工具出不出现；接入上的设置只能在它之内再收窄（某个接入能不能推、推来的要不要先问、能读到哪一级），不能放宽。
CLAIM|32|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:210|同一个 `key` 带来新内容，只替换还在待确认的旧内容|          WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'pending'
CLAIM|33|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:210|已经直接存下的旧记忆不会被改写|          WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'pending'
CLAIM|34|一致|packages/gateway-contracts/src/contracts-v2.ts:2014|外部 agent 自己声明的分类是健康或财务|export const MEMORY_SENSITIVE_CATEGORY_NAMES = ["health", "finance"] as const;
CLAIM|35|一致|packages/sensitive-capture/src/identifiers.ts:6|正文里有证件号、银行卡号这类标识|export function containsRestrictedIdentifier(text: string): boolean {
CLAIM|36|一致|packages/sensitive-capture/src/identifiers.ts:16|有密码、验证码等凭据|export function containsCredential(text: string): boolean {
CLAIM|37|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:162|直接存的条目提交的瞬间仍计入待确认和暂存的条数上限，保存后不再计入|        WHERE owner_id = ? AND agent_id = ? AND status <> 'committed' AND content_ref IS NOT NULL
CLAIM|38|一致|apps/agent-service/src/production-mcp-read.ts:1261|接近上限时直接存也会返回已满|          results.push({ index, status: "full" });
CLAIM|39|一致|apps/agent-service/src/bearer-admission.ts:4|还受每分钟调用次数|export const AUTHORIZED_PER_MINUTE = 30;
CLAIM|40|一致|apps/agent-service/src/production-mcp-read.ts:149|每次 50 条的限制|export const MCP_PROPOSE_MEMORIES_MAXIMUM = 50;
CLAIM|41|一致|test/integration/mcp-write.test.ts:2278|`test/integration/mcp-write.test.ts` 里标了 `[direct]` 的用例|  it("[direct] saves a proposed memory at once on a connection set to direct save, with no confirmation box", async () => {
CLAIM|42|一致|test/integration/mcp-write.test.ts:2311|设成先问的接入仍进待确认|  it("[direct] still holds sensitive proposals for the owner, and a connection set to ask keeps asking", async () => {
CLAIM|43|一致|test/integration/mcp-write.test.ts:2311|敏感留在待确认|  it("[direct] still holds sensitive proposals for the owner, and a connection set to ask keeps asking", async () => {
CLAIM|44|一致|test/integration/mcp-write.test.ts:2388|规则不会自己生效|  it("[direct] never turns a proposed rule into a rule without the owner, even on a connection set to direct save", async () => {
CLAIM|45|一致|apps/agent-service/src/production-mcp-memory-writer.ts:287|外部 agent 把健康、财务内容标成别的分类时，会以 private 不经确认直接入库|      if (proposal.status === "pending" && proposal.dataClassification !== "private")

未核对的部分：外部网站与 MCP 规范、Andy 在聊天和决定卡上的原话、仓库外的任务清单，以及方案中打算新增或修改的行为（如直接存流程、`batch-direct-` 编号、新回执、设置页新默认值）按题意未当作现状核对；已有 Muse 接入的运行时数据也未核实。
