CLAIM|1|一致|packages/persistence-sqlite/src/migrations/20261114151010_owner_proposals.sql:1|“提议箱”表 `owner_proposals` 存的是 Himawari 想做、要主人点头的事（规则提议、确定动作等）|CREATE TABLE owner_proposals (
CLAIM|2|一致|docs/architecture-v0.1.md:420|“提议箱”表 `owner_proposals` 存的是 Himawari 想做、要主人点头的事（规则提议、确定动作等）|Himawari 想做、但要主人点头才做的事，统一存进一个“提议箱”，不按来源或场景各建一套。模型用 `rule_set` 提的、主人没明说的规则是第一种提议（类型 `owner_rule`）；以后“提议下一步”等能力往同一个箱子里放，不改表。
CLAIM|3|一致|packages/persistence-sqlite/src/migrations/20261114151010_owner_proposals.sql:1@809fb094f0f6b023ab4e089a1c5a7e0551badf67|PR 436 建表|CREATE TABLE owner_proposals (
CLAIM|4|一致|packages/persistence-sqlite/src/migrations/20261114163611_owner_proposals_execution.sql:1@f81cf9c2ce3ef2bcbd5aec458b451b765cf3047d|PR 520 加了执行层|ALTER TABLE owner_proposals ADD COLUMN exec_status TEXT NOT NULL DEFAULT 'not_started'
CLAIM|5|一致|packages/persistence-sqlite/src/migrations/20261114163611_owner_proposals_execution.sql:1@f81cf9c2ce3ef2bcbd5aec458b451b765cf3047d|决定和执行分两列|ALTER TABLE owner_proposals ADD COLUMN exec_status TEXT NOT NULL DEFAULT 'not_started'
CLAIM|6|一致|packages/persistence-sqlite/src/migrations/20261114163611_owner_proposals_execution.sql:3@f81cf9c2ce3ef2bcbd5aec458b451b765cf3047d|租约|ALTER TABLE owner_proposals ADD COLUMN lease_id TEXT
CLAIM|7|一致|packages/persistence-sqlite/src/migrations/20261114163611_owner_proposals_execution.sql:15@f81cf9c2ce3ef2bcbd5aec458b451b765cf3047d|撤销用的原样|ALTER TABLE owner_proposals ADD COLUMN execution_ref TEXT
CLAIM|8|一致|packages/persistence-sqlite/src/data-export/export.ts:751|PR 527 把这张表加进了数据导出|  put(DATA_FILES.ownerProposals, "data", jsonLines(ownerProposalLines), ownerProposalLines.length);
CLAIM|9|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56|ADR 0246 决定 4 把格式升到 v3|4. **数据导出格式升到 `himawari.data-export.v3`。**v1、v2 的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。依据“记忆可靠性”：v2 文件没有这张表，导入后待确认的提议和「拒绝过」的记录都没了，同样的话会被重新提议进来。
CLAIM|10|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56|ADR 0246 决定 4 写“v1、v2 的导出文件导入时整份拒绝”|4. **数据导出格式升到 `himawari.data-export.v3`。**v1、v2 的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。依据“记忆可靠性”：v2 文件没有这张表，导入后待确认的提议和「拒绝过」的记录都没了，同样的话会被重新提议进来。
CLAIM|11|一致|packages/persistence-sqlite/src/data-export/verify.ts:361|v3 及更早的导出文件导入时整份拒绝|    (value as { format?: unknown }).format !== FORMAT_VERSION
CLAIM|12|一致|packages/persistence-sqlite/src/data-export/types.ts:82|v3 及更早的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）|  FORMAT_UNSUPPORTED: "DATA_IMPORT_FORMAT_UNSUPPORTED",
CLAIM|13|一致|packages/persistence-sqlite/src/data-export/export.ts:891|导出的清单的版本常量是 `FORMAT_VERSION`|    format: FORMAT_VERSION,
CLAIM|14|一致|packages/persistence-sqlite/src/data-export/schemas.ts:618|结构文件的版本常量是 `FORMAT_VERSION`|  format: { type: "string", const: FORMAT_VERSION },
CLAIM|15|一致|packages/persistence-sqlite/src/data-export/verify.ts:361|导入校验的版本常量是 `FORMAT_VERSION`|    (value as { format?: unknown }).format !== FORMAT_VERSION
CLAIM|16|一致|packages/persistence-sqlite/src/data-export/export.ts:687|每行一条提议|  const ownerProposalLines: JsonValue[] = snapshot.ownerProposals.map((row) => {
CLAIM|17|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:111|全部状态都导出|        WHERE owner_id = @ownerId AND agent_id = @agentId
CLAIM|18|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:106|字段是表里的各列|          id, type, summary, effect, origin, source_ref, source_version, version, fingerprint,
CLAIM|19|一致|packages/persistence-sqlite/src/data-export/export.ts:713|加上依据 `basis`|      basis: ownerProposalText(basisRef, ownerProposalBasisKey(id)),
CLAIM|20|一致|packages/persistence-sqlite/src/data-export/export.ts:714|加上执行原样 `execution`|      execution: ownerProposalText(executionRef, ownerProposalExecutionKey(id)),
CLAIM|21|一致|docs/architecture-v0.1.md:433|依据 `basis` 和执行原样 `execution` 都是加密载荷|- **提议箱随数据导出和导入走（2026-11-14）**：导出文件多一份 `data/owner-proposals.jsonl` 和对应的结构文件，清单里有 `ownerProposals` 条数。每行带决定和执行两列状态、次数、时间和是否要本人在场、要读全文；展示给主人的依据和执行时记下的原样（撤销用）是加密载荷，导出时和别的文字一样过机密检查，含机密的只在密封文件里放原文，没有口令导入时那条提议整条跳过并计入 `ownerProposalsWithoutOriginal`。导入只往空表里写：目标库已有提议就报 `DATA_IMPORT_TARGET_NOT_EMPTY`；来源对话不带过来（置空）；说明、效果、来源和来源版本含机密时只留“已扣留”占位，原文不带（清单 `omitted` 记条数），所以这几项导出再导入后可能和原来不同；租约不带过来，导出时还在“执行中”或“已执行待核实”的一律导入成“结果不明”，不会在新库里被当成还在执行或被重新执行。依据或执行原样的加密载荷已不可读（正在删除、已删除、不存在）时，导出里写空，并在清单 `omitted` 里写条数，不悄悄丢。提议箱进入导出时格式升到 v4（[ADR 0272](adr/0272-owner-proposals-join-the-data-export-format-v4.md)）。
CLAIM|22|一致|packages/persistence-sqlite/src/data-export/export.ts:163|导出时和别的文字一样过机密检查|    if (!options.policy.hasSecret(text)) return { ...base, text };
CLAIM|23|一致|packages/persistence-sqlite/src/data-export/export.ts:167|含机密的明文层只放遮盖后的样子|    const masked = options.policy.mask(text);
CLAIM|24|一致|packages/persistence-sqlite/src/data-export/export.ts:166|原文进封存文件|    originals[key] = text;
CLAIM|25|一致|packages/persistence-sqlite/src/data-export/import.ts:864|来源对话 `thread_id` 不导出|        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
CLAIM|26|一致|packages/persistence-sqlite/src/data-export/import.ts:864|租约不导出|        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
CLAIM|27|一致|packages/persistence-sqlite/src/data-export/import.ts:100|导入只写空表|  "owner_proposals",
CLAIM|28|一致|packages/persistence-sqlite/src/data-export/import.ts:109|目标库已有提议就报 `DATA_IMPORT_TARGET_NOT_EMPTY`|      throw new DataExportError(DATA_EXPORT_ERROR_CODES.TARGET_NOT_EMPTY, table);
CLAIM|29|一致|packages/persistence-sqlite/src/data-export/import.ts:385|导出时还在“执行中”或“已执行待核实”的，导入成“结果不明”|        proposal.execStatus === "running" || proposal.execStatus === "executed_unverified"
CLAIM|30|一致|packages/persistence-sqlite/src/data-export/import.ts:385|不会在新库里被当成还在执行或被再执行一遍|        proposal.execStatus === "running" || proposal.execStatus === "executed_unverified"
CLAIM|31|一致|packages/persistence-sqlite/src/data-export/import.ts:373|含机密的依据或执行原样没有口令就整条跳过|      ownerProposalsWithout += 1;
CLAIM|32|一致|packages/persistence-sqlite/src/data-export/import.ts:441|导入报告写 `ownerProposalsWithoutOriginal` 条数|      ownerProposalsWithoutOriginal: ownerProposalsWithout,
CLAIM|33|一致|packages/persistence-sqlite/src/data-export/export.ts:158|依据或执行原样对应的加密载荷已不可读时，导出里这一项写 null|    if (payload === undefined || "unavailable" in payload || text === undefined) return null;
CLAIM|34|一致|packages/persistence-sqlite/src/data-export/export.ts:856|在清单 `omitted` 里写“提给主人的提议里读不出来的依据或执行原样”和条数|      what: "提给主人的提议里读不出来的依据或执行原样",
CLAIM|35|一致|packages/persistence-sqlite/src/data-export/export.ts:859|撤销用的原样读不出的提议，导入后不能撤销，这一点写在 `omitted` 的原因里|        "库里的加密载荷已不可读（正在删除、已删除或损坏），导出里写成空；撤销用的原样丢了的提议导入后不能撤销",
CLAIM|36|一致|packages/persistence-sqlite/src/data-export/export.ts:121|载荷存在却解不开时，整份导出照常失败|    if (!restrictedRefs.has(ref)) texts.set(ref, await read());
CLAIM|37|一致|docs/adr/0233-rule-book-joins-the-data-export.md:75|和 ADR 0233 放弃旧版照常导入的理由一样|- **v1 文件照常导入、规则当空。**主人会以为规则都带过来了；改成明确拒绝。
CLAIM|38|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:81|和 ADR 0246 放弃旧版照常导入的理由一样|- **v2 文件照常导入、提议当空。**和 ADR 0233 放弃 v1 照常导入的理由一样：Andy 会以为都带过来了。
CLAIM|39|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:11|ADR 0246 标题里的“v3”是当时的版本|# ADR 0246：其他 agent 的提议进入网页和数据导出，格式升到 v3
CLAIM|40|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56|ADR 0246 决定 4 里的“v3”是当时的版本|4. **数据导出格式升到 `himawari.data-export.v3`。**v1、v2 的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。依据“记忆可靠性”：v2 文件没有这张表，导入后待确认的提议和「拒绝过」的记录都没了，同样的话会被重新提议进来。
CLAIM|41|一致|packages/persistence-sqlite/src/data-export/verify.ts:361|旧的 v3 导出文件不能再导入|    (value as { format?: unknown }).format !== FORMAT_VERSION
CLAIM|42|一致|docs/adr/0200-portable-export-of-memories-and-decisions.md:47|ADR 0200 对应数据导出 v1|1. **格式 `himawari.data-export.v1`，一个文件夹：**
CLAIM|43|一致|docs/adr/0233-rule-book-joins-the-data-export.md:47|ADR 0233 对应数据导出 v2|1. **格式升到 `himawari.data-export.v2`。**v1 的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。依据“记忆可靠性”：v1 文件没有规则，导入后规则手册是空的，主人会以为规则还在。
CLAIM|44|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56|ADR 0246 对应数据导出 v3|4. **数据导出格式升到 `himawari.data-export.v3`。**v1、v2 的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。依据“记忆可靠性”：v2 文件没有这张表，导入后待确认的提议和「拒绝过」的记录都没了，同样的话会被重新提议进来。
CLAIM|45|一致|docs/architecture-v0.1.md:418|`docs/architecture-v0.1.md` 有提议箱一节|### 等主人决定的提议（2026-11-12）
CLAIM|46|一致|docs/architecture-v0.1.md:433|该节说明导出导入的行为|- **提议箱随数据导出和导入走（2026-11-14）**：导出文件多一份 `data/owner-proposals.jsonl` 和对应的结构文件，清单里有 `ownerProposals` 条数。每行带决定和执行两列状态、次数、时间和是否要本人在场、要读全文；展示给主人的依据和执行时记下的原样（撤销用）是加密载荷，导出时和别的文字一样过机密检查，含机密的只在密封文件里放原文，没有口令导入时那条提议整条跳过并计入 `ownerProposalsWithoutOriginal`。导入只往空表里写：目标库已有提议就报 `DATA_IMPORT_TARGET_NOT_EMPTY`；来源对话不带过来（置空）；说明、效果、来源和来源版本含机密时只留“已扣留”占位，原文不带（清单 `omitted` 记条数），所以这几项导出再导入后可能和原来不同；租约不带过来，导出时还在“执行中”或“已执行待核实”的一律导入成“结果不明”，不会在新库里被当成还在执行或被重新执行。依据或执行原样的加密载荷已不可读（正在删除、已删除、不存在）时，导出里写空，并在清单 `omitted` 里写条数，不悄悄丢。提议箱进入导出时格式升到 v4（[ADR 0272](adr/0272-owner-proposals-join-the-data-export-format-v4.md)）。

未核实部分：PR 436、520、527 的编号是通过 git log 提交信息核对的，没有访问外部 PR 页面；其余各条都在当前提交读到了对应的代码或文档证据。
