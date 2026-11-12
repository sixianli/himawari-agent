CLAIM|1|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:37|ADR 0228 定了后端|本 ADR 定后端：新表、MCP 工具的行为、确认和撤销的网关操作。
CLAIM|2|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:1|提议的记忆先存进 `external_memory_proposals` 表|CREATE TABLE external_memory_proposals (
CLAIM|3|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:10|表叫「待确认」|# ADR 0228：其他 agent 写进来的记忆先存「待确认」，主人在 Himawari 里确认后才保存（部分取代 ADR 0225 决定 2、3、6）
CLAIM|4|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:10|Andy 在 Himawari 里确认后才保存|# ADR 0228：其他 agent 写进来的记忆先存「待确认」，主人在 Himawari 里确认后才保存（部分取代 ADR 0225 决定 2、3、6）
CLAIM|5|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:122|那个 PR 把网页、每天打分里的提示和数据导出留给了下一个 PR|- **下一个 PR 要做的**（不改表，所以拆出来，好让改表队列先放行）：
CLAIM|6|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:122|ADR 0228 把剩下的三件事写明了|- **下一个 PR 要做的**（不改表，所以拆出来，好让改表队列先放行）：
CLAIM|7|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:123|网页「设置 → 记忆」顶部的「来自其他 agent」一节：勾选后「保存所选」「不要所选」、全选、单条改了再保存、撤销一批；来源按「自称：Muse」显示；数字按第 4 条的定义。|  - 网页「设置 → 记忆」顶部的「来自其他 agent」一节：勾选后「保存所选」「不要所选」、全选、单条改了再保存、撤销一批；来源按「自称：Muse」显示；数字按第 4 条的定义。
CLAIM|8|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:124|每日回顾在待确认条数大于 0 时加一行提示。|  - 每日回顾在待确认条数大于 0 时加一行提示。
CLAIM|9|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:125|数据导出带上这张表。|  - 数据导出带上这张表。在那之前，导出清单的 `omitted` 里写明这张表还没导出、有几行。
CLAIM|10|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:24|CHECK ((status = 'pending') = (decided_at IS NULL))|  CHECK ((status = 'pending') = (decided_at IS NULL)),
CLAIM|11|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:26|CHECK (content_ref IS NOT NULL OR status IN ('rejected', 'superseded'))|  CHECK (content_ref IS NOT NULL OR status IN ('rejected', 'superseded')),
CLAIM|12|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:25|只有已保存的能指向记忆|  CHECK (memory_id IS NULL OR status = 'committed'),
CLAIM|13|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:27|只有被替换的能指向替换它的提议|  CHECK (superseded_by IS NULL OR status = 'superseded'),
CLAIM|14|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:28|只有已保存或已拒绝的能属于一批|  CHECK (batch_id IS NULL OR status IN ('committed', 'rejected'))
CLAIM|15|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:31-33|CREATE UNIQUE INDEX external_memory_proposals_text_index ON external_memory_proposals(owner_id, agent_id, text_sha256) WHERE status <> 'superseded'|CREATE UNIQUE INDEX external_memory_proposals_text_index   ON external_memory_proposals(owner_id, agent_id, text_sha256)   WHERE status <> 'superseded'
CLAIM|16|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:52|客户端固定编号有一张表|CREATE TABLE external_memory_proposal_keys (
CLAIM|17|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:64|「不带编号送过」有一张表|CREATE TABLE external_memory_proposal_unkeyed (
CLAIM|18|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:58|external_memory_proposal_keys 的主键是 (owner_id, agent_id, client, source_key)|  PRIMARY KEY (owner_id, agent_id, client, source_key)
CLAIM|19|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:67|external_memory_proposal_unkeyed 的主键是 (proposal_id, client)|  PRIMARY KEY (proposal_id, client)
CLAIM|20|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:492|拒绝的正文 30 天后删掉，只留摘要|        "UPDATE external_memory_proposals SET content_ref = NULL WHERE id = ?",
CLAIM|21|一致|apps/agent-service/src/production-mcp-memory-writer.ts:45|EXTERNAL_PROPOSAL_REJECTED_TEXT_DAYS = 30|export const EXTERNAL_PROPOSAL_REJECTED_TEXT_DAYS = 30;
CLAIM|22|一致|apps/agent-service/src/production-memory-control.ts:1083|网关命令只回一个结果编号|  async execute(command: GatewayV2Command): Promise<{ resultRef: string; replayed: boolean }> {
CLAIM|23|不一致|packages/gateway-contracts/src/contracts-v2.ts:2314|网关命令只回一个结果编号。`packages/gateway-contracts/src/contracts-v2.ts:2332`：“`resultRef: nullable(machineString)`”。|export const delegationSnapshotSchema = object({
CLAIM|24|一致|apps/agent-service/src/production-memory-control.ts:1067|memory.external.respond 的结果编号就是这一批的批次号|    return { resultRef: batchId, replayed: false };
CLAIM|25|一致|apps/agent-service/src/production-memory-control.ts:421|概况里的 externalProposals.batches 按批次给出保存和不要各几条|        ({ batchId, decidedAt, committed, rejected }) => ({
CLAIM|26|一致|docs/adr/0233-rule-book-joins-the-data-export.md:47|[ADR 0233 决定 1]：格式升到 `himawari.data-export.v2`。v1 的导出文件导入时整份拒绝|1. **格式升到 `himawari.data-export.v2`。**v1 的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。依据“记忆可靠性”：v1 文件没有规则，导入后规则手册是空的，主人会以为规则还在。
CLAIM|27|一致|docs/adr/0200-portable-export-of-memories-and-decisions.md:54|机密原文只进口令加密的封存文件|原文只进封存文件的 `originals`。
CLAIM|28|一致|docs/adr/0200-portable-export-of-memories-and-decisions.md:59|导入只进空库|只导入到没有任何记忆、决定记录、人物、导入批次、整理记录、来源洞察、已处理邮件记录和 Muse 校准记录的空库
CLAIM|29|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:60|ADR 0228：待确认表和确认、撤销的后端|1. **新表 `external_memory_proposals`（迁移 0093）。** 一行是一条提议：
CLAIM|30|一致|docs/adr/0200-portable-export-of-memories-and-decisions.md:47|ADR 0200：数据导出 v1|1. **格式 `himawari.data-export.v1`，一个文件夹：**
CLAIM|31|一致|docs/adr/0233-rule-book-joins-the-data-export.md:47|ADR 0233：数据导出 v2|1. **格式升到 `himawari.data-export.v2`。**v1 的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。依据“记忆可靠性”：v1 文件没有规则，导入后规则手册是空的，主人会以为规则还在。
CLAIM|32|一致|docs/adr/0242-external-agents-join-the-memory-hub-through-one-entry.md:11|ADR 0242：记忆中心总方案|# ADR 0242：外部 agent 经一个入口接入记忆中心：专属网址定身份，`start_here` 读，`sync_memories` 推，按能力分档触发
CLAIM|33|一致|apps/control-center/src/components/external-proposals.tsx:96|代码：apps/control-center/src/components/external-proposals.tsx|export function ExternalProposalsSection({
CLAIM|34|一致|packages/persistence-sqlite/src/data-export/export.ts:86|代码：packages/persistence-sqlite/src/data-export/export.ts|export async function buildPortableExport(options: ExportOptions): Promise<ExportResult> {
CLAIM|35|一致|packages/persistence-sqlite/src/data-export/verify.ts:355|代码：packages/persistence-sqlite/src/data-export/verify.ts|export function parsePortable(
CLAIM|36|一致|packages/persistence-sqlite/src/data-export/import.ts:102|代码：packages/persistence-sqlite/src/data-export/import.ts|export async function importPortableExport(
CLAIM|37|一致|apps/control-center/src/components/memory-page.tsx:2350-2351|放在原来的「需要你确认」上面|<ExternalProposalsSection memory={memory} message={message} /> <ConfirmSection memory={memory} message={message} />
CLAIM|38|一致|packages/gateway-contracts/src/contracts-v2.ts:1532|最多 2000 字，和后端上限一致|export const EXTERNAL_PROPOSAL_TEXT_MAXIMUM = 2000;
CLAIM|39|一致|packages/persistence-sqlite/src/data-export/schemas.ts:455-462（fed6ae92^ 的 v2 版本）|v2 文件没有这张表|export const DATA_FILES = Object.freeze({ memories: "data/memories.jsonl", people: "data/people.jsonl", importBatches: "data/import-batches.jsonl", consolidations: "data/consolidations.jsonl", decisions: "data/decisions.jsonl", rules: "data/rules.jsonl", } as const);
CLAIM|40|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:19-20|收到和处理时间是库里存的格式（`2026-11-12T00:00:00.000Z` 这样，同表上的 `GLOB` 约束）|  received_at TEXT NOT NULL CHECK (received_at GLOB '????-??-??T??:??:??.???Z'),   decided_at TEXT CHECK (decided_at IS NULL OR decided_at GLOB '????-??-??T??:??:??.???Z'),
CLAIM|41|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:63|待确认的提议不进任何发给模型的请求|这张表只有 MCP 写工具和记忆页的确认操作读写，没有任何组装发给模型内容的代码读它。依据「用户主权」：确认前 Himawari 不用它。
CLAIM|42|一致|docs/adr/0200-portable-export-of-memories-and-decisions.md:62|网页导出不设口令|网页导出不设口令，所以不带加密封存文件和证据

决定一节里计划新增或修改的行为（格式升到 v3、新增导出文件、导入校验、测试与布局门槛等）按题意不算现状，未纳入逐条核对；没有其他未能核对的部分。
