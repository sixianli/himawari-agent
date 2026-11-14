CLAIM|1|一致|docs/architecture-v0.1.md:420|“提议箱”表 `owner_proposals` 存的是 Himawari 想做、要主人点头的事（规则提议、确定动作等）|Himawari 想做、但要主人点头才做的事，统一存进一个“提议箱”，不按来源或场景各建一套。
CLAIM|2|一致|packages/persistence-sqlite/src/migrations/20261114151010_owner_proposals.sql:1|PR 436 建表|CREATE TABLE owner_proposals (
CLAIM|3|一致|packages/persistence-sqlite/src/migrations/20261114163611_owner_proposals_execution.sql:1|PR 520 加了执行层|ALTER TABLE owner_proposals ADD COLUMN exec_status TEXT NOT NULL DEFAULT 'not_started'
CLAIM|4|一致|packages/persistence-sqlite/src/migrations/20261114163611_owner_proposals_execution.sql:1|决定和执行分两列|ALTER TABLE owner_proposals ADD COLUMN exec_status TEXT NOT NULL DEFAULT 'not_started'
CLAIM|5|一致|packages/persistence-sqlite/src/migrations/20261114163611_owner_proposals_execution.sql:3|租约|ALTER TABLE owner_proposals ADD COLUMN lease_id TEXT
CLAIM|6|一致|packages/persistence-sqlite/src/migrations/20261114163611_owner_proposals_execution.sql:15|撤销用的原样|ALTER TABLE owner_proposals ADD COLUMN execution_ref TEXT
CLAIM|7|不一致|packages/persistence-sqlite/src/data-export/schemas.ts:744|这张表还没进数据导出|ownerProposals: "data/owner-proposals.jsonl",
CLAIM|8|不一致|packages/persistence-sqlite/src/data-export/export.ts:751|主人导出再导入，待采纳的提议和已执行动作的撤销原样都会丢|put(DATA_FILES.ownerProposals, "data", jsonLines(ownerProposalLines), ownerProposalLines.length);
CLAIM|9|不一致|packages/persistence-sqlite/src/data-export/export.ts:714|主人导出再导入，待采纳的提议和已执行动作的撤销原样都会丢|execution: ownerProposalText(executionRef, ownerProposalExecutionKey(id)),
CLAIM|10|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56|ADR 0246 决定 4 把格式升到 v3|4. **数据导出格式升到 `himawari.data-export.v3`。**
CLAIM|11|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56|ADR 0246 写“v1、v2 的导出文件导入时整份拒绝”|v1、v2 的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。
CLAIM|12|一致|packages/persistence-sqlite/src/data-export/schemas.ts:593@9ad2138b644cc19d781a91f317de8c65381338e7|旧文件没有这个数|externalProposals: integer(0),
CLAIM|13|一致|packages/persistence-sqlite/src/data-export/schemas.ts:678@9ad2138b644cc19d781a91f317de8c65381338e7|旧文件也没有这张表的数据|externalProposals: "data/external-memory-proposals.jsonl",
CLAIM|14|一致|packages/persistence-sqlite/src/data-export/schemas.ts:5|导出的清单、结构文件和导入校验的版本常量是同一个 `FORMAT_VERSION`（`packages/persistence-sqlite/src/data-export/schemas.ts`）|export const FORMAT_VERSION = "himawari.data-export.v4" as const;
CLAIM|15|一致|packages/persistence-sqlite/src/data-export/export.ts:891|导出的清单、结构文件和导入校验的版本常量是同一个 `FORMAT_VERSION`（`packages/persistence-sqlite/src/data-export/schemas.ts`）|format: FORMAT_VERSION,
CLAIM|16|一致|packages/persistence-sqlite/src/data-export/schemas.ts:618|导出的清单、结构文件和导入校验的版本常量是同一个 `FORMAT_VERSION`（`packages/persistence-sqlite/src/data-export/schemas.ts`）|format: { type: "string", const: FORMAT_VERSION },
CLAIM|17|一致|packages/persistence-sqlite/src/data-export/verify.ts:361|导出的清单、结构文件和导入校验的版本常量是同一个 `FORMAT_VERSION`（`packages/persistence-sqlite/src/data-export/schemas.ts`）|(value as { format?: unknown }).format !== FORMAT_VERSION
CLAIM|18|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:106|字段是表里的各列|SELECT id, type, summary, effect, origin, source_ref, source_version, version, fingerprint,
CLAIM|19|一致|apps/agent-service/src/production-proposals.ts:327|依据 `basis` 和执行原样 `execution`（都是加密载荷|await this.#options.protector.protect({
CLAIM|20|一致|apps/agent-service/src/production-proposals.ts:490|依据 `basis` 和执行原样 `execution`（都是加密载荷|await this.#options.protector.protect({
CLAIM|21|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:11|ADR 0246 标题和决定 4 里的“v3”是当时的版本|# ADR 0246：其他 agent 的提议进入网页和数据导出，格式升到 v3
CLAIM|22|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56|ADR 0246 标题和决定 4 里的“v3”是当时的版本|4. **数据导出格式升到 `himawari.data-export.v3`。**
CLAIM|23|一致|docs/adr/0200-portable-export-of-memories-and-decisions.md:47|ADR 0246、ADR 0233、ADR 0200：数据导出 v1 到 v3|1. **格式 `himawari.data-export.v1`，一个文件夹：**
CLAIM|24|一致|docs/adr/0233-rule-book-joins-the-data-export.md:47|ADR 0246、ADR 0233、ADR 0200：数据导出 v1 到 v3|1. **格式升到 `himawari.data-export.v2`。**v1 的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。依据“记忆可靠性”：v1 文件没有规则，导入后规则手册是空的，主人会以为规则还在。
CLAIM|25|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56|ADR 0246、ADR 0233、ADR 0200：数据导出 v1 到 v3|4. **数据导出格式升到 `himawari.data-export.v3`。**
CLAIM|26|一致|docs/architecture-v0.1.md:418|`docs/architecture-v0.1.md` 提议箱一节|### 等主人决定的提议（2026-11-12）
CLAIM|27|一致|docs/architecture-v0.1.md:433|`docs/architecture-v0.1.md` 提议箱一节：导出导入的行为说明|- **提议箱随数据导出和导入走（2026-11-14）**：导出文件多一份 `data/owner-proposals.jsonl` 和对应的结构文件，清单里有 `ownerProposals` 条数。
CLAIM|28|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:81|**v3 文件照常导入、提议当空。**和 ADR 0246、ADR 0233 放弃旧版照常导入的理由一样|- **v2 文件照常导入、提议当空。**和 ADR 0233 放弃 v1 照常导入的理由一样：Andy 会以为都带过来了。

PR 436/520 与建表/执行层迁移的对应关系通过 git log 确认（809fb094f0f6b023ab4e089a1c5a7e0551badf67、f81cf9c2ce3ef2bcbd5aec458b451b765cf3047d）。决定 1–5 中属于新增或修改的内容按题目要求未当作现状核对；背景中“还没进数据导出”若指功能合入前（9ad2138b644cc19d781a91f317de8c65381338e7）则成立，但在给定基线 a87954ee 与当前提交已不成立。
