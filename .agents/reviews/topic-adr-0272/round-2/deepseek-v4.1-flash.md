CLAIM|1|一致|docs/architecture-v0.1.md:420|“提议箱”表 `owner_proposals` 存的是 Himawari 想做、要主人点头的事|Himawari 想做、但要主人点头才做的事，统一存进一个“提议箱”，不按来源或场景各建一套。
CLAIM|2|一致|docs/architecture-v0.1.md:420|规则提议|模型用 `rule_set` 提的、主人没明说的规则是第一种提议（类型 `owner_rule`）
CLAIM|3|一致|docs/architecture-v0.1.md:430|确定动作等|执行这一层只给“确定动作”类的处理方（`ProposalActionHandler`，登记时带 `kind: "action"`）
CLAIM|4|一致|packages/persistence-sqlite/src/migrations/20261114151010_owner_proposals.sql:1@809fb094f0f6b023ab4e089a1c5a7e0551badf67|PR 436 建表|CREATE TABLE owner_proposals (
CLAIM|5|一致|packages/persistence-sqlite/src/migrations/20261114163611_owner_proposals_execution.sql:1@f81cf9c2ce3ef2bcbd5aec458b451b765cf3047d|PR 520 加了执行层（决定和执行分两列）|ALTER TABLE owner_proposals ADD COLUMN exec_status TEXT NOT NULL DEFAULT 'not_started'
CLAIM|6|一致|packages/persistence-sqlite/src/migrations/20261114163611_owner_proposals_execution.sql:3@f81cf9c2ce3ef2bcbd5aec458b451b765cf3047d|PR 520 加了执行层（租约）|ALTER TABLE owner_proposals ADD COLUMN lease_id TEXT
CLAIM|7|一致|packages/persistence-sqlite/src/migrations/20261114163611_owner_proposals_execution.sql:15@f81cf9c2ce3ef2bcbd5aec458b451b765cf3047d|PR 520 加了执行层（撤销用的原样）|ALTER TABLE owner_proposals ADD COLUMN execution_ref TEXT
CLAIM|8|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:38@d5ef89946c426840d5a4e9211dce3ee1766725c6|PR 527 之前这张表不在数据导出里|readonly externalProposals: readonly Row[]; readonly externalProposalKeys: readonly Row[];
CLAIM|9|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:39@a87954eeeb7361a67d3f5c50598d9232325caa69|PR 527 把它加进了导出|readonly ownerProposals: readonly Row[];
CLAIM|10|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56|ADR 0246 决定 4 把格式升到 v3|4. **数据导出格式升到 `himawari.data-export.v3`。**
CLAIM|11|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56|ADR 0246 决定 4 写“v1、v2 的导出文件导入时整份拒绝”|v1、v2 的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。
CLAIM|12|一致|packages/persistence-sqlite/src/data-export/schemas.ts:5|格式升到 `himawari.data-export.v4`|export const FORMAT_VERSION = "himawari.data-export.v4" as const;
CLAIM|13|一致|packages/persistence-sqlite/src/data-export/verify.ts:361|v3 及更早的导出文件导入时整份拒绝|(value as { format?: unknown }).format !== FORMAT_VERSION
CLAIM|14|一致|packages/persistence-sqlite/src/data-export/types.ts:82|（整份拒绝的代码是 `DATA_IMPORT_FORMAT_UNSUPPORTED`）|FORMAT_UNSUPPORTED: "DATA_IMPORT_FORMAT_UNSUPPORTED",
CLAIM|15|一致|packages/persistence-sqlite/src/data-export/schemas.ts:683|清单新增必填的 `ownerProposals` 条数|"ownerProposals",
CLAIM|16|一致|packages/persistence-sqlite/src/data-export/schemas.ts:598@d5ef89946c426840d5a4e9211dce3ee1766725c6|旧文件没有这个数|externalProposals: integer(0), ruleHistoryVersions: integer(0),
CLAIM|17|一致|packages/persistence-sqlite/src/data-export/schemas.ts:683@d5ef89946c426840d5a4e9211dce3ee1766725c6|旧文件也没有这张表的数据|externalProposals: "data/external-memory-proposals.jsonl", } as const);
CLAIM|18|一致|packages/persistence-sqlite/src/data-export/schemas.ts:5|导出的清单、结构文件和导入校验的版本常量是同一个 `FORMAT_VERSION`（`packages/persistence-sqlite/src/data-export/schemas.ts`）|export const FORMAT_VERSION = "himawari.data-export.v4" as const;
CLAIM|19|一致|packages/persistence-sqlite/src/data-export/export.ts:751|每行一条提议|put(DATA_FILES.ownerProposals, "data", jsonLines(ownerProposalLines), ownerProposalLines.length);
CLAIM|20|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:110|全部状态都导出|FROM owner_proposals WHERE owner_id = @ownerId AND agent_id = @agentId
CLAIM|21|一致|docs/architecture-v0.1.md:423|依据 `basis` 是加密载荷|**依据在加密载荷里**，表里只存载荷引用。
CLAIM|22|一致|docs/architecture-v0.1.md:430|执行原样 `execution` 是加密载荷|执行后先记成“已执行待核实”并把原样存进加密载荷
CLAIM|23|一致|packages/persistence-sqlite/src/data-export/export.ts:683|导出时和别的文字一样过机密检查|const value = exportedText(ref, key);
CLAIM|24|一致|packages/persistence-sqlite/src/data-export/export.ts:167|含机密的明文层只放遮盖后的样子|const masked = options.policy.mask(text);
CLAIM|25|一致|packages/persistence-sqlite/src/data-export/export.ts:166|原文进封存文件|originals[key] = text;
CLAIM|26|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:106|来源对话 `thread_id` 不导出|SELECT id, type, summary, effect, origin, source_ref, source_version, version, fingerprint,
CLAIM|27|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:106|租约不导出|SELECT id, type, summary, effect, origin, source_ref, source_version, version, fingerprint,
CLAIM|28|一致|packages/persistence-sqlite/src/data-export/import.ts:100|导入只写空表|"owner_proposals",
CLAIM|29|一致|packages/persistence-sqlite/src/data-export/import.ts:109|目标库已有提议就报 `DATA_IMPORT_TARGET_NOT_EMPTY`|throw new DataExportError(DATA_EXPORT_ERROR_CODES.TARGET_NOT_EMPTY, table);
CLAIM|30|一致|packages/persistence-sqlite/src/data-export/import.ts:385|导出时还在“执行中”或“已执行待核实”的，导入成“结果不明”|proposal.execStatus === "running" || proposal.execStatus === "executed_unverified"
CLAIM|31|一致|packages/persistence-sqlite/src/data-export/import.ts:373|含机密的依据或执行原样没有口令就整条跳过|ownerProposalsWithout += 1;
CLAIM|32|一致|packages/persistence-sqlite/src/data-export/import.ts:441|导入报告写 `ownerProposalsWithoutOriginal` 条数|ownerProposalsWithoutOriginal: ownerProposalsWithout,
CLAIM|33|一致|packages/persistence-sqlite/src/data-export/export.ts:158|依据或执行原样对应的加密载荷已不可读（正在删除、已删除、不存在）时，导出里这一项写 null|if (payload === undefined || "unavailable" in payload || text === undefined) return null;
CLAIM|34|一致|packages/persistence-sqlite/src/data-export/export.ts:856|在清单 `omitted` 里写“提给主人的提议里读不出来的依据或执行原样”和条数|what: "提给主人的提议里读不出来的依据或执行原样",
CLAIM|35|一致|packages/persistence-sqlite/src/data-export/export.ts:859|撤销用的原样读不出的提议，导入后不能撤销，这一点写在 `omitted` 的原因里|撤销用的原样丢了的提议导入后不能撤销
CLAIM|36|一致|packages/persistence-sqlite/src/data-export/export.ts:121|载荷存在却解不开时，整份导出照常失败，不静默写空|if (!restrictedRefs.has(ref)) texts.set(ref, await read());
CLAIM|37|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:11|ADR 0246 标题里的“v3”是当时的版本|# ADR 0246：其他 agent 的提议进入网页和数据导出，格式升到 v3
CLAIM|38|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56|ADR 0246 决定 4 里的“v3”是当时的版本|4. **数据导出格式升到 `himawari.data-export.v3`。**
CLAIM|39|一致|docs/adr/0200-portable-export-of-memories-and-decisions.md:47|ADR 0200：数据导出 v1|1. **格式 `himawari.data-export.v1`，一个文件夹：**
CLAIM|40|一致|docs/adr/0233-rule-book-joins-the-data-export.md:10|ADR 0233：数据导出 v2|# ADR 0233：规则手册进入数据导出，格式升到 v2
CLAIM|41|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:11|ADR 0246：数据导出 v3|# ADR 0246：其他 agent 的提议进入网页和数据导出，格式升到 v3
CLAIM|42|一致|docs/architecture-v0.1.md:433|`docs/architecture-v0.1.md` 提议箱一节：导出导入的行为说明|**提议箱随数据导出和导入走（2026-11-14）**

未核对：ADR 里“本 ADR 补记那次的格式决定”属于元叙述，无法用文件内容判定；“事故清单不加行”只按改动清单看没有涉及事故清单文件，未逐条核对清单内容。另：材料基线 a87954e 本身已是 PR 527 提交，所以“PR 527 之前”的旧状态我用其父提交 d5ef89946 核对。
