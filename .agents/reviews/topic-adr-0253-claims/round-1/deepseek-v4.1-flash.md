CLAIM|1|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:11|ADR 0246 让其他 agent 的提议（其他 agent 通过 MCP 送来、等 Andy 确认的记忆）进了网页和数据导出。|# ADR 0246：其他 agent 的提议进入网页和数据导出，格式升到 v3
CLAIM|2|找不到|-|它的 PR 复核留下了五条没做的意见|-
CLAIM|3|不一致|AGENTS.md:52|协调者按 Andy 的长期规则（“可以更好”的意见直接改）要求一起做掉|可以更好的不修改，列给 Andy，他说采纳才改，改完同样再复核。
CLAIM|4|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:900-902（PR 前）|受限（restricted）记忆被彻底删除后，保存进它的那条提议的正文摘要还留在库里|`UPDATE external_memory_proposals SET status = 'rejected', memory_id = NULL,
CLAIM|5|一致|packages/persistence-sqlite/src/data-export/export.ts:549|下一次导出会以明文写出|      textSha256: withheld ? null : digest,
CLAIM|6|一致|packages/persistence-sqlite/src/data-export/export.ts:156（PR 前）|被排除的提议仍参与占位编号的扫描|      snapshot.externalProposals,
CLAIM|7|一致|packages/persistence-sqlite/src/data-export/export.ts:156（PR 前）|导出里的占位编号会跳号|      snapshot.externalProposals,
CLAIM|8|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:82（PR 前）|受限记忆的原话（主人当时说的那句话）没有参与比较|          AND memory.classification = 'restricted' AND history.content_ref IS NOT NULL
CLAIM|9|一致|packages/persistence-sqlite/src/data-export/export.ts:522（PR 前）|和原话同文的提议会被导出|    return text !== undefined && restrictedDigests.has(proposalTextDigest(text));
CLAIM|10|一致|test/integration/data-export-external-proposals.test.ts:406|被排除的提议的固定编号、替换链接没有专门测试。|  it("[reverse] writes no key, unkeyed client or replacement link of a left-out proposal, and numbers placeholders without it", async () => {
CLAIM|11|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:454|一批里拒绝满 30 天、正文已删的条目，撤销时恢复不了|        if (wanted.has(member.id) && member.contentRef !== null) {
CLAIM|12|一致|apps/control-center/src/components/external-proposals.tsx:207|网页却仍把它算在可以撤销的那一批里|          {external.batches.map((batch) => (
CLAIM|13|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:900-902（PR 前）|彻底删除一条记忆时，指向它的提议只被改成已拒绝，摘要保留。|`UPDATE external_memory_proposals SET status = 'rejected', memory_id = NULL,
CLAIM|14|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:57|删除提议行时，固定编号和「不带编号送过」两张表跟着删|  proposal_id TEXT NOT NULL REFERENCES external_memory_proposals(id) ON DELETE CASCADE
CLAIM|15|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:23|指着它的替换链接置空|  superseded_by TEXT REFERENCES external_memory_proposals(id) ON DELETE SET NULL
CLAIM|16|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:82（PR 前）|导出比较受限记忆时只读当前文字和历史版本。|          AND memory.classification = 'restricted' AND history.content_ref IS NOT NULL
CLAIM|17|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:82（PR 前）|没有 `quote_ref`|          AND memory.classification = 'restricted' AND history.content_ref IS NOT NULL
CLAIM|18|一致|packages/persistence-sqlite/src/data-export/export.ts:156（PR 前）|占位编号扫描用的是全部提议。|      snapshot.externalProposals,
CLAIM|19|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:492（PR 前）|拒绝满 30 天时只清掉正文，批次号保留。|        "UPDATE external_memory_proposals SET content_ref = NULL WHERE id = ?",
CLAIM|20|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:454|撤销时没有正文的条目不恢复。|        if (wanted.has(member.id) && member.contentRef !== null) {
CLAIM|21|不一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:457|同文件 455 行：“`} else if (input.complete) detach.run(member.id, input.ownerId, input.agentId);`”。|        } else if (input.complete) detach.run(member.id, input.ownerId, input.agentId);
CLAIM|22|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:900-902（PR 前）|删除非受限记忆仍按原来的做法：提议改成已拒绝，只留摘要|`UPDATE external_memory_proposals SET status = 'rejected', memory_id = NULL,
CLAIM|23|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:33|用来挡住同样的话被再次提议|  WHERE status <> 'superseded';
CLAIM|24|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:56|导入后同样的话会被重新提议，违背 ADR 0246 决定 4 的理由。|同样的话会被重新提议进来。
CLAIM|25|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:900-902（PR 前）|而且已经没法分辨哪些来自受限记忆。|`UPDATE external_memory_proposals SET status = 'rejected', memory_id = NULL,
CLAIM|26|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:550|删除在一个同步的数据库事务里做|          .transaction(() => {
CLAIM|27|一致|packages/persistence-sqlite/src/data-export/export.ts:102|读密文要走异步的解密|        await options.protector.unprotect({
CLAIM|28|一致|packages/persistence-sqlite/src/data-export/export.ts:519-522（PR 前）|和受限记忆同文、但不是保存进它的提议，在受限记忆还在时导出就已经排除|    return text !== undefined && restrictedDigests.has(proposalTextDigest(text));
CLAIM|29|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:61-62|ADR 0246：本 ADR 补充它的决定 6、7。|7. **链接：**正文和任何一条受限（restricted）记忆相同的提议
CLAIM|30|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:60|ADR 0228：待确认表、30 天删正文和撤销一批。|1. **新表 `external_memory_proposals`（迁移 0093）。**
CLAIM|31|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:90|ADR 0228：待确认表、30 天删正文和撤销一批。|拒绝的条目 30 天后清掉正文（删掉 payload），只留摘要，用来挡重复提议。
CLAIM|32|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:84|ADR 0228：待确认表、30 天删正文和撤销一批。|新网关操作 `memory.external.undo`：撤销一个批次

说明：标注「本 PR 之前」的代码按父提交 0d989adb5 核对；PR 复核那五条意见的来源在仓库里没有找到复核记录，故判「找不到」。「短正文光凭摘要就可能被逐个试出来」属于一般密码学推断，未作为仓库现状核对；方案里的决定/计划、GDPR 等外部内容也未计入。
