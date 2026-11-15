CLAIM|1|一致|docs/architecture-v0.1.md:420|“提议箱”表 `owner_proposals` 存的是 Himawari 想做、要主人点头的事（规则提议、确定动作等）。|Himawari 想做、但要主人点头才做的事，统一存进一个“提议箱”，不按来源或场景各建一套。模型用 `rule_set` 提的、主人没明说的规则是第一种提议（类型 `owner_rule`）；以后“提议下一步”等能力往同一个箱子里放，不改表。\n- **表 `owner_proposals` 只存索引**：提议编号、类型（任意字符串，箱子不解释）、一句话说明、采纳后会发生什么（提议方写好存下来的一句话）、来源标记（主人说的、模型推断的、外部 agent 提的）、来源对话、来源记录和来源版本（可空，给以后按来源清理用）、版本号、内容指纹、状态（待采纳、已采纳、已拒绝、已过期）、产生和过期时间、被提议和被拒绝的次数。类型、来源标记、状态的取值在代码里校验，表里只限长度，以后加取值不用改表。
CLAIM|2|一致|packages/persistence-sqlite/src/data-export/schemas.ts:744|这张表已经进了数据导出|ownerProposals: "data/owner-proposals.jsonl",
CLAIM|3|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56|ADR 0246 决定 4 把格式升到 v3|4. **数据导出格式升到 `himawari.data-export.v3`。**v1、v2 的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。依据“记忆可靠性”：v2 文件没有这张表，导入后待确认的提议和「拒绝过」的记录都没了，同样的话会被重新提议进来。
CLAIM|4|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56|并写“v1、v2 的导出文件导入时整份拒绝”|v1、v2 的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。
CLAIM|5|一致|packages/persistence-sqlite/src/data-export/schemas.ts:5|格式升到 `himawari.data-export.v4`|export const FORMAT_VERSION = "himawari.data-export.v4" as const;
CLAIM|6|一致|packages/persistence-sqlite/src/data-export/verify.ts:358|v3 及更早的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）|if (\n    typeof value === "object" &&\n    value !== null &&\n    (value as { format?: unknown }).format !== FORMAT_VERSION\n  )\n    throw new DataExportError(\n      DATA_EXPORT_ERROR_CODES.FORMAT_UNSUPPORTED,\n      String((value as { format?: unknown }).format),\n    );
CLAIM|7|一致|packages/persistence-sqlite/src/data-export/types.ts:82|v3 及更早的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）|FORMAT_UNSUPPORTED: "DATA_IMPORT_FORMAT_UNSUPPORTED",
CLAIM|8|一致|docs/product-vision.md:55|依据“记忆可靠性”|*原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。*
CLAIM|9|一致|docs/adr/0215-decision-record-points-at-the-rule-version.md:85|项目“不顾旧数据兼容”的规则|- **把旧记录里的丢弃原因清掉。**抽屉对记忆候选记录本来就不显示规则一环；Andy 定过不顾旧数据兼容，旧行不动。
CLAIM|10|一致|packages/persistence-sqlite/src/data-export/schemas.ts:656|清单新增必填的 `ownerProposals` 条数|ownerProposals: integer(0),
CLAIM|11|一致|packages/persistence-sqlite/src/data-export/schemas.ts:683|清单新增必填的 `ownerProposals` 条数|"ownerProposals",
CLAIM|12|一致|packages/persistence-sqlite/src/data-export/schemas.ts:618|导出的清单、结构文件和导入校验的版本常量是同一个 `FORMAT_VERSION`（`packages/persistence-sqlite/src/data-export/schemas.ts`）|format: { type: "string", const: FORMAT_VERSION },
CLAIM|13|一致|packages/persistence-sqlite/src/data-export/schemas.ts:612|导出的清单、结构文件和导入校验的版本常量是同一个 `FORMAT_VERSION`（`packages/persistence-sqlite/src/data-export/schemas.ts`）|format: { type: "string", const: FORMAT_VERSION },
CLAIM|14|一致|packages/persistence-sqlite/src/data-export/verify.ts:361|导出的清单、结构文件和导入校验的版本常量是同一个 `FORMAT_VERSION`（`packages/persistence-sqlite/src/data-export/schemas.ts`）|(value as { format?: unknown }).format !== FORMAT_VERSION
CLAIM|15|一致|packages/persistence-sqlite/src/data-export/schemas.ts:744|新增 `data/owner-proposals.jsonl` 和 `schema/owner-proposals.schema.json`|ownerProposals: "data/owner-proposals.jsonl",
CLAIM|16|一致|packages/persistence-sqlite/src/data-export/schemas.ts:718|新增 `data/owner-proposals.jsonl` 和 `schema/owner-proposals.schema.json`|{ path: "schema/owner-proposals.schema.json", schema: OWNER_PROPOSAL_SCHEMA },
CLAIM|17|一致|packages/persistence-sqlite/src/data-export/export.ts:751|每行一条提议|put(DATA_FILES.ownerProposals, "data", jsonLines(ownerProposalLines), ownerProposalLines.length);
CLAIM|18|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:111|全部状态都导出|WHERE owner_id = @ownerId AND agent_id = @agentId
CLAIM|19|一致|packages/persistence-sqlite/src/data-export/export.ts:713|字段是表里的各列，加上依据 `basis`|basis: ownerProposalText(basisRef, ownerProposalBasisKey(id)),
CLAIM|20|一致|packages/persistence-sqlite/src/data-export/export.ts:714|和执行原样 `execution`|execution: ownerProposalText(executionRef, ownerProposalExecutionKey(id)),
CLAIM|21|一致|docs/architecture-v0.1.md:423|字段是表里的各列，加上依据 `basis` 和执行原样 `execution`（都是加密载荷，导出时和别的文字一样过机密检查：含机密的明文层只放遮盖后的样子，原文进封存文件）。|**依据在加密载荷里**，表里只存载荷引用。
CLAIM|22|一致|docs/architecture-v0.1.md:430|字段是表里的各列，加上依据 `basis` 和执行原样 `execution`（都是加密载荷，导出时和别的文字一样过机密检查：含机密的明文层只放遮盖后的样子，原文进封存文件）。|执行后先记成“已执行待核实”并把原样存进加密载荷，再读回，一致记成功，不一致记失败，读回出错记结果不明
CLAIM|23|一致|packages/persistence-sqlite/src/data-export/export.ts:166|含机密的明文层只放遮盖后的样子，原文进封存文件|originals[key] = text;
CLAIM|24|一致|packages/persistence-sqlite/src/data-export/export.ts:170|含机密的明文层只放遮盖后的样子，原文进封存文件|text: options.policy.hasSecret(masked) ? WITHHELD_PLACEHOLDER : masked,
CLAIM|25|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:106|来源对话 `thread_id` 不导出|`SELECT id, type, summary, effect, origin, source_ref, source_version, version, fingerprint,\n          status, exec_status, proposed_at, expires_at, decided_at, proposed_count, reject_count,\n          last_rejected_at, attempts, executed_at, requires_full_read, requires_presence,\n          evidence_ref, execution_ref
CLAIM|26|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:106|租约不导出|`SELECT id, type, summary, effect, origin, source_ref, source_version, version, fingerprint,\n          status, exec_status, proposed_at, expires_at, decided_at, proposed_count, reject_count,\n          last_rejected_at, attempts, executed_at, requires_full_read, requires_presence,\n          evidence_ref, execution_ref
CLAIM|27|一致|packages/persistence-sqlite/src/data-export/import.ts:100|导入只写空表|"owner_proposals",
CLAIM|28|一致|packages/persistence-sqlite/src/data-export/import.ts:109|目标库已有提议就报 `DATA_IMPORT_TARGET_NOT_EMPTY`|throw new DataExportError(DATA_EXPORT_ERROR_CODES.TARGET_NOT_EMPTY, table);
CLAIM|29|一致|packages/persistence-sqlite/src/data-export/types.ts:90|目标库已有提议就报 `DATA_IMPORT_TARGET_NOT_EMPTY`|TARGET_NOT_EMPTY: "DATA_IMPORT_TARGET_NOT_EMPTY",
CLAIM|30|一致|packages/persistence-sqlite/src/data-export/import.ts:385|导出时还在“执行中”或“已执行待核实”的，导入成“结果不明”|proposal.execStatus === "running" || proposal.execStatus === "executed_unverified"\n          ? "unknown"\n          : proposal.execStatus,
CLAIM|31|一致|packages/persistence-sqlite/src/data-export/import.ts:369|含机密的依据或执行原样没有口令就整条跳过|if (\n      (proposal.basis !== null && basis === null) ||\n      (proposal.execution !== null && execution === null)\n    ) {\n      ownerProposalsWithout += 1;\n      continue;\n    }
CLAIM|32|一致|packages/persistence-sqlite/src/data-export/import.ts:441|导入报告写 `ownerProposalsWithoutOriginal` 条数|ownerProposalsWithoutOriginal: ownerProposalsWithout,
CLAIM|33|一致|packages/persistence-sqlite/src/data-export/export.ts:158|依据或执行原样对应的加密载荷已不可读（正在删除、已删除、不存在）时，导出里这一项写 null|if (payload === undefined || "unavailable" in payload || text === undefined) return null;
CLAIM|34|一致|packages/persistence-sqlite/src/data-export/export.ts:684|同时在清单 `omitted` 里写“提给主人的提议里读不出来的依据或执行原样”和条数|if (value === null) unreadableOwnerProposalTexts += 1;
CLAIM|35|一致|packages/persistence-sqlite/src/data-export/export.ts:856|同时在清单 `omitted` 里写“提给主人的提议里读不出来的依据或执行原样”和条数|what: "提给主人的提议里读不出来的依据或执行原样",\n      count: unreadableOwnerProposalTexts,
CLAIM|36|一致|packages/persistence-sqlite/src/data-export/export.ts:859|撤销用的原样读不出的提议，导入后不能撤销，这一点写在 `omitted` 的原因里|"库里的加密载荷已不可读（正在删除、已删除或损坏），导出里写成空；撤销用的原样丢了的提议导入后不能撤销",
CLAIM|37|一致|packages/persistence-sqlite/src/data-export/export.ts:121|载荷存在却解不开时，整份导出照常失败，不静默写空|if (!restrictedRefs.has(ref)) texts.set(ref, await read());
CLAIM|38|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:353|依据或执行原样对应的加密载荷已不可读（正在删除、已删除、不存在）时|if (\n          !row ||\n          row.storage_kind !== "sqlite_blob" ||\n          row.ciphertext === null ||\n          row.lifecycle_state === "deletion_pending" ||\n          row.lifecycle_state === "deleted_verified"\n        ) {\n          payloads.set(ref, { unavailable: true });\n          continue;\n        }
CLAIM|39|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:81|和 ADR 0246 放弃旧版照常导入的理由一样|- **v2 文件照常导入、提议当空。**和 ADR 0233 放弃 v1 照常导入的理由一样：Andy 会以为都带过来了。
CLAIM|40|一致|docs/adr/0233-rule-book-joins-the-data-export.md:75|和 ADR 0233 放弃旧版照常导入的理由一样|- **v1 文件照常导入、规则当空。**主人会以为规则都带过来了；改成明确拒绝。
CLAIM|41|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:11|ADR 0246 标题和决定 4 里的“v3”是当时的版本|# ADR 0246：其他 agent 的提议进入网页和数据导出，格式升到 v3
CLAIM|42|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56|ADR 0246 标题和决定 4 里的“v3”是当时的版本|4. **数据导出格式升到 `himawari.data-export.v3`。**
CLAIM|43|一致|docs/adr/0200-portable-export-of-memories-and-decisions.md:47|ADR 0246、ADR 0233、ADR 0200：数据导出 v1 到 v3|1. **格式 `himawari.data-export.v1`，一个文件夹：**
CLAIM|44|一致|docs/adr/0233-rule-book-joins-the-data-export.md:47|ADR 0246、ADR 0233、ADR 0200：数据导出 v1 到 v3|1. **格式升到 `himawari.data-export.v2`。**v1 的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。依据“记忆可靠性”：v1 文件没有规则，导入后规则手册是空的，主人会以为规则还在。
CLAIM|45|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56|ADR 0246、ADR 0233、ADR 0200：数据导出 v1 到 v3|4. **数据导出格式升到 `himawari.data-export.v3`。**
CLAIM|46|一致|docs/architecture-v0.1.md:433|`docs/architecture-v0.1.md` 提议箱一节：导出导入的行为说明|- **提议箱随数据导出和导入走（2026-11-14）**：导出文件多一份 `data/owner-proposals.jsonl` 和对应的结构文件，清单里有 `ownerProposals` 条数。

未核对：方案中纯属流程或意图的表述（如“不改表结构、不调模型”“事故清单不加行”“现行格式以本 ADR 为准”）未作为现状逐条核对；ADR 0246 的“当时版本”只核对了其字面仍写 v3，未独立核实其历史时间。
