CLAIM|1|一致|apps/agent-service/src/production-mcp-read.ts:828|外部 agent 经 MCP 的写工具 `propose_memory` 推来记忆|"propose_memory",
CLAIM|2|一致|apps/agent-service/src/production-mcp-read.ts:852|外部 agent 经 MCP 的写工具 `propose_memories` 推来记忆|"propose_memories",
CLAIM|3|不一致|apps/agent-service/src/production-mcp-read.ts:1314@c56494f89add7510fb35914ab02db1f4ee414112|现在一律先存进“待确认”，主人在 Himawari 里点过才保存|return await this.#askConfirmation(
CLAIM|4|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:139|ADR 0242 决定 9 早已设计了每个接入一个“先问我 / 直接存，可整批撤销”的开关，默认先问，只有主人能改|    - 记忆和规则提议都是。每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。
CLAIM|5|一致|packages/persistence-sqlite/src/migrations/20261115113156_mcp_connections.sql:15|接入记录里也已经有 `push_policy` 一列|  push_policy TEXT NOT NULL CHECK (push_policy IN ('ask', 'direct')),
CLAIM|6|一致|apps/agent-service/src/production-mcp-connections-control.ts:292@c56494f89add7510fb35914ab02db1f4ee414112|网关一直拒绝把它设成“直接存”（`MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE`）|      "MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE",
CLAIM|7|一致|apps/agent-service/src/production-mcp-read.ts:835@c56494f89add7510fb35914ab02db1f4ee414112|写工具也不看这一列|            this.#proposeMemory(proposals, args, client, subjectRef, handlerContext),
CLAIM|8|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:139|决定 9 的原文是“每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。”|    - 记忆和规则提议都是。每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。
CLAIM|9|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:140|同文件决定 9 的 2026-11-12 补注原文是““直接存”只管记忆。规则提议不管开关怎么设，都要主人在 Himawari 里点头才生效”|    - 2026-11-12 补：“直接存”只管记忆。规则提议不管开关怎么设，都要主人在 Himawari 里点头才生效（[ADR 0213](0213-owner-sentence-becomes-a-standing-rule.md)：“模型推断出来的只生成提议，主人点头才生效”）。
CLAIM|10|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:1|待确认表和整批撤销已经存在|CREATE TABLE external_memory_proposals (
CLAIM|11|一致|apps/agent-service/src/production-mcp-memory-writer.ts:502|`ProductionMcpMemoryWriter.undoBatch`（`apps/agent-service/src/production-mcp-memory-writer.ts`）按批次号撤销|  async undoBatch(
CLAIM|12|一致|apps/agent-service/src/production-memory-control.ts:107|网关操作 `memory.external.undo`|  "memory.external.undo",
CLAIM|13|一致|apps/agent-service/src/production-mcp-connections-control.ts:289@c56494f89add7510fb35914ab02db1f4ee414112|改动前的 `apps/agent-service/src/production-mcp-connections-control.ts` 里 `askFirstOnly` 对 `pushPolicy !== "ask"` 抛 `MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE`|  if (pushPolicy !== "ask")
CLAIM|14|一致|AGENTS.md:17|愿景 v2.2 起规则是 Andy 定的硬设定：`AGENTS.md` 产品愿景一节|- 自 v2.2 起，Andy 定的规则是硬性设定，不是记忆：规则写进程序、必定执行、每条有回归测试；记忆只保存规则的出处和修改历史。护城河是四样资产：记忆图谱、Agent 规则手册、长尾工具库、决策记录。把规则当记忆条目存储或注入的现有设计是已知缺口，列在 [ADR 0134](docs/adr/0134-adopt-product-vision-v2-2.md) 里，不是目标；现行愿景 v2.3 的采纳记录是 [ADR 0153](docs/adr/0153-adopt-product-vision-v2-3.md)。
CLAIM|15|一致|apps/agent-service/src/service-main.ts:2684|`runPolicy.mcpRead.proposals` 仍决定写工具出不出现（ADR 0227）|          ...(mcpReadConfiguration.proposals
CLAIM|16|一致|apps/agent-service/src/service-main.ts:2684|关掉它就没有写工具，也就没有直接存|          ...(mcpReadConfiguration.proposals
CLAIM|17|一致|packages/gateway-contracts/src/contracts-v2.ts:1378|接口层新建仍必须明写 `pushPolicy`，不靠隐含默认|    pushPolicy: enumeration(MCP_CONNECTION_PUSH_POLICY_NAMES),
CLAIM|18|一致|packages/application/src/ports/decision-ledger.ts:104|仍以 `mcp_proposal_` 开头|export const EXTERNAL_PROPOSAL_REASON_PREFIX = "mcp_proposal_";
CLAIM|19|一致|packages/calibration/src/index.ts:648|自动记忆校准照旧排除|export const EXTERNAL_PROPOSAL_REASON_PATTERN = "mcp!_proposal!_%";
CLAIM|20|一致|apps/agent-service/src/production-mcp-read.ts:982|`propose_rule` 不看 `pushPolicy`|            this.#proposeRule(rules, args, client, connection.id, handlerContext),
CLAIM|21|一致|apps/agent-service/src/production-mcp-read.ts:1105|仍要主人在客户端确认框里同意才生效|        if (outcome === "accepted") {
CLAIM|22|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:101|ADR 0228 业界一节引用过|- ChatGPT 和 Claude 的记忆都只来自自家对话。Claude 的「导入记忆」是直接存，事后在记忆面板里查看和删除（<https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude>）。两家都没有「外部 agent 写入、先审后存」的先例。
CLAIM|23|不一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:85|一个全局开关放宽了 ADR 0242“接入上的设置只能在全局之内收窄”的方向|    - 和 ADR 0227 决定 3 的关系：全局配置 `runPolicy.mcpRead.proposals` 仍然决定写工具出不出现；接入上的设置只能在它之内再收窄（某个接入能不能推、推来的要不要先问、能读到哪一级），不能放宽。
CLAIM|24|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:108|更新版本留给 `sync_memories`，ADR 0242 决定 6|    - 可以重复推：同编号同内容不产生任何东西；同编号新内容算更新，留历史版本。
CLAIM|25|一致|apps/agent-service/src/production-mcp-memory-writer.ts:94|敏感与否目前由 `proposalClassification` 判|export function proposalClassification(
CLAIM|26|一致|packages/gateway-contracts/src/contracts-v2.ts:2010|外部 agent 自己声明的分类是健康或财务|export const MEMORY_SENSITIVE_CATEGORY_NAMES = ["health", "finance"] as const;
CLAIM|27|一致|packages/sensitive-capture/src/identifiers.ts:7|正文里有证件号、银行卡号这类标识才升敏感|  return RESTRICTED_IDENTIFIER.test(text.replace(/[\s-]/gu, ""));
CLAIM|28|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:162|直接存的条目不占待确认和暂存的条数上限|        WHERE owner_id = ? AND agent_id = ? AND status <> 'committed' AND content_ref IS NOT NULL
CLAIM|29|一致|apps/agent-service/src/bearer-admission.ts:4|只受每分钟调用次数的限制|export const AUTHORIZED_PER_MINUTE = 30;
CLAIM|30|一致|apps/agent-service/src/production-mcp-read.ts:149|每次 50 条的限制|export const MCP_PROPOSE_MEMORIES_MAXIMUM = 50;
CLAIM|31|不一致|test/integration/mcp-write.test.ts:2277,2310,2328,2363,2372,2387|`test/integration/mcp-write.test.ts` 的四个 `[direct]` 用例|  it("[direct] saves a proposed memory at once on a connection set to direct save, with no confirmation box", async () => {
CLAIM|32|一致|test/integration/mcp-write.test.ts:2310|含反向用例（设成先问的接入仍进待确认、敏感留在待确认|  it("[direct] still holds sensitive proposals for the owner, and a connection set to ask keeps asking", async () => {
CLAIM|33|一致|test/integration/mcp-write.test.ts:2387|规则不会自己生效）|  it("[direct] never turns a proposed rule into a rule without the owner, even on a connection set to direct save", async () => {
CLAIM|34|找不到|-|任务清单 `/mnt/project-files/p5-memory-hub/coding-tasks.md`（仓库外）里也有同样一条|-

未能核对：`/mnt/project-files/p5-memory-hub/coding-tasks.md` 在仓库外，未读到，故第 34 条标为找不到。背景和前提 4 中描述改动前行为的句子按基线提交 c56494f89add7510fb35914ab02db1f4ee414112 核对，其余按当前提交 dc4bcf9929d281473e5d43bb1db0e19ea9797772 核对。
