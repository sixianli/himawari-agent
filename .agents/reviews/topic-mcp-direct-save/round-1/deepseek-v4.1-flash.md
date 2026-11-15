CLAIM|1|一致|apps/agent-service/src/production-mcp-read.ts:789|外部 agent 经 MCP 的写工具 `propose_memory` 推来记忆|"propose_memory",
CLAIM|2|一致|apps/agent-service/src/production-mcp-read.ts:813|外部 agent 经 MCP 的写工具 `propose_memories` 推来记忆|"propose_memories",
CLAIM|3|不一致|apps/agent-service/src/production-mcp-read.ts:1221|现在一律先存进“待确认”，主人在 Himawari 里点过才保存。|if (direct) {
CLAIM|4|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:139|ADR 0242 决定 9 早已设计了每个接入一个“先问我 / 直接存，可整批撤销”的开关|- 记忆和规则提议都是。每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。
CLAIM|5|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:139|默认先问|- 记忆和规则提议都是。每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。
CLAIM|6|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:139|只有主人能改|- 记忆和规则提议都是。每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。
CLAIM|7|一致|packages/persistence-sqlite/src/migrations/20261115113156_mcp_connections.sql:15|接入记录里也已经有 `push_policy` 一列|push_policy TEXT NOT NULL CHECK (push_policy IN ('ask', 'direct')),
CLAIM|8|一致|apps/agent-service/src/production-mcp-connections-control.ts:289@5834935d102709955c38e76220c6ed8a6df5cc51|网关一直拒绝把它设成“直接存”（`MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE`）|if (pushPolicy !== "ask")
CLAIM|9|一致|apps/agent-service/src/production-mcp-read.ts:1446@5834935d102709955c38e76220c6ed8a6df5cc51|写工具也不看这一列|return { id, entry, callKey: typeof callKey === "string" ? callKey : null };
CLAIM|10|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:139|开关已设计好：`docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md` 决定 9 的原文是“每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。”|- 记忆和规则提议都是。每个接入有一个开关“先问我 / 直接存，可整批撤销”，默认先问；只有主人能改。
CLAIM|11|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:140|“直接存”只管记忆。|- 2026-11-12 补：“直接存”只管记忆。规则提议不管开关怎么设，都要主人在 Himawari 里点头才生效（[ADR 0213](0213-owner-sentence-becomes-a-standing-rule.md)：“模型推断出来的只生成提议，主人点头才生效”）。
CLAIM|12|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:140|规则提议不管开关怎么设，都要主人在 Himawari 里点头才生效。|- 2026-11-12 补：“直接存”只管记忆。规则提议不管开关怎么设，都要主人在 Himawari 里点头才生效（[ADR 0213](0213-owner-sentence-becomes-a-standing-rule.md)：“模型推断出来的只生成提议，主人点头才生效”）。
CLAIM|13|找不到|-|敏感内容一律待确认：`docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md` 任务 C 清单里写的是“写入时同步判敏感，敏感一律待确认”（`/mnt/project-files/p5-memory-hub/coding-tasks.md`）。|-
CLAIM|14|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:1|待确认表已经存在|CREATE TABLE external_memory_proposals (
CLAIM|15|一致|apps/agent-service/src/production-mcp-memory-writer.ts:490|`ProductionMcpMemoryWriter.undoBatch` 按批次号撤销|async undoBatch(
CLAIM|16|一致|packages/gateway-contracts/src/contracts-v2.ts:106|网关操作 `memory.external.undo`|"memory.external.undo",
CLAIM|17|一致|apps/agent-service/src/production-mcp-connections-control.ts:289@5834935d102709955c38e76220c6ed8a6df5cc51|改动前的 `apps/agent-service/src/production-mcp-connections-control.ts` 里 `askFirstOnly` 对 `pushPolicy !== "ask"` 抛 `MCP_CONNECTION_PUSH_POLICY_NOT_AVAILABLE`。|if (pushPolicy !== "ask")
CLAIM|18|一致|AGENTS.md:17|愿景 v2.2 起规则是 Andy 定的硬设定：`AGENTS.md` 产品愿景一节。|- 自 v2.2 起，Andy 定的规则是硬性设定，不是记忆：规则写进程序、必定执行、每条有回归测试；记忆只保存规则的出处和修改历史。护城河是四样资产：记忆图谱、Agent 规则手册、长尾工具库、决策记录。把规则当记忆条目存储或注入的现有设计是已知缺口，列在 [ADR 0134](docs/adr/0134-adopt-product-vision-v2-2.md) 里，不是目标；现行愿景 v2.3 的采纳记录是 [ADR 0153](docs/adr/0153-adopt-product-vision-v2-3.md)。
CLAIM|19|一致|apps/agent-service/src/service-main.ts:2668|`runPolicy.mcpRead.proposals` 仍决定写工具出不出现（ADR 0227）|...(mcpReadConfiguration.proposals
CLAIM|20|一致|apps/agent-service/src/service-main.ts:2668|关掉它就没有写工具，也就没有直接存。|...(mcpReadConfiguration.proposals
CLAIM|21|一致|packages/gateway-contracts/src/contracts-v2.ts:1378|接口层新建仍必须明写 `pushPolicy`，不靠隐含默认。|pushPolicy: enumeration(MCP_CONNECTION_PUSH_POLICY_NAMES),
CLAIM|22|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:31|先照常提交（去重|CREATE UNIQUE INDEX external_memory_proposals_text_index
CLAIM|23|一致|apps/agent-service/src/production-mcp-memory-writer.ts:305|先照常提交（机器密钥拒收|if (proposalHasMachineSecret(text))
CLAIM|24|一致|apps/agent-service/src/production-mcp-memory-writer.ts:199|先照常提交（分级|const dataClassification = proposalClassification(text, input.category);
CLAIM|25|一致|apps/agent-service/src/production-mcp-memory-writer.ts:228|先照常提交（决策记录 `pending`）|"pending",
CLAIM|26|一致|apps/agent-service/src/production-mcp-memory-writer.ts:287|按网页确认同一套代码保存|await this.#keep(proposalId, { ...input, direct: true });
CLAIM|27|一致|apps/agent-service/src/production-mcp-read.ts:1156|`propose_memories` 里被同一次调用后面同 `key` 条目替换的，不保存，仍回 `replaced`。|result["status"] = "replaced";
CLAIM|28|一致|packages/application/src/ports/decision-ledger.ts:104|决策记录的原因码……仍以 `mcp_proposal_` 开头|export const EXTERNAL_PROPOSAL_REASON_PREFIX = "mcp_proposal_";
CLAIM|29|一致|packages/calibration/src/index.ts:648|自动记忆校准照旧排除|export const EXTERNAL_PROPOSAL_REASON_PATTERN = "mcp!_proposal!_%";
CLAIM|30|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:208|同一个 `key` 带来新内容，只替换还在待确认的旧内容|WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'pending'
CLAIM|31|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:208|已经直接存下的旧记忆不会被改写|WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'pending'
CLAIM|32|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:108|更新版本留给 `sync_memories`，ADR 0242 决定 6|- 可以重复推：同编号同内容不产生任何东西；同编号新内容算更新，留历史版本。
CLAIM|33|一致|apps/agent-service/src/production-mcp-read.ts:891|`propose_rule` 不看 `pushPolicy`|this.#proposeRule(rules, args, client, connection.id, handlerContext),
CLAIM|34|一致|apps/agent-service/src/production-mcp-read.ts:1001|规则仍要主人在客户端确认框里同意才生效|[MCP_PROPOSAL_CONFIRM_KEY]: inputRequired.elicit({
CLAIM|35|一致|apps/agent-service/src/production-mcp-read.ts:791|外部 agent 的工具定义不随设置变|description: MCP_TOOL_PROPOSE_MEMORY.text,
CLAIM|36|一致|apps/agent-service/src/production-mcp-memory-writer.ts:285|风险由敏感分级一律待确认兜住|if (proposal.status === "pending" && proposal.dataClassification !== "private")
CLAIM|37|一致|apps/agent-service/src/production-mcp-memory-writer.ts:305|风险由机器密钥拒收兜住|if (proposalHasMachineSecret(text))
CLAIM|38|一致|apps/agent-service/src/production-mcp-memory-writer.ts:490|风险由整批撤销兜住|async undoBatch(
CLAIM|39|一致|test/integration/mcp-write.test.ts:2091|自动检查：`test/integration/mcp-write.test.ts` 的四个 `[direct]` 用例|it("[direct] saves a proposed memory at once on a connection set to direct save, with no confirmation box", async () => {
CLAIM|40|一致|test/integration/mcp-write.test.ts:2134|含反向用例（设成先问的接入仍进待确认）|expect((await asking.propose(muse, { text: COFFEE })).text).toContain("待确认");
CLAIM|41|一致|test/integration/mcp-write.test.ts:2129|含反向用例（敏感留在待确认）|expect(sensitive.text).toContain("待确认");
CLAIM|42|一致|test/integration/mcp-write.test.ts:2179|含反向用例（规则不会自己生效）|expect(await f.storedRules()).toEqual([]);

前提 3 引用的 `/mnt/project-files/p5-memory-hub/coding-tasks.md` 不在仓库内，仓库里的 ADR 0228 也读不到“任务 C 清单”那段原文，因此该项只能标找不到。另有“这些只发给外部客户端，Himawari 自己发给模型的请求一个字节都不变”这类绝对说法，未逐字节核对。
