CLAIM|1|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:11|ADR 0246 让其他 agent 的提议（其他 agent 通过 MCP 送来、等 Andy 确认的记忆）进了网页和数据导出。|# ADR 0246：其他 agent 的提议进入网页和数据导出，格式升到 v3
CLAIM|2|找不到|-|它的 PR 复核留下了五条没做的意见|-
CLAIM|3|找不到|-|`.agents/reviews/pr-420/round-1/judgments.md` 的 glm-4|-
CLAIM|4|找不到|-|`.agents/reviews/pr-420/round-5/judgments.md` 的 ds5-5 到 ds5-7|-
CLAIM|5|找不到|-|以及交付报告里列出的“受限记忆删掉以后摘要留在明文导出里”|-
CLAIM|6|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:901|受限（restricted）记忆被彻底删除后，保存进它的那条提议的正文摘要还留在库里|content_ref = NULL, batch_id = NULL
CLAIM|7|一致|packages/persistence-sqlite/src/data-export/export.ts:545|下一次导出会以明文写出|textSha256: withheld ? null : digest,
CLAIM|8|一致|packages/persistence-sqlite/src/data-export/export.ts:156|被排除的提议仍参与占位编号的扫描|snapshot.externalProposals,
CLAIM|9|一致|packages/persistence-sqlite/src/data-export/export.ts:169|导出里的占位编号会跳号|number = existingPlaceholderMax + shortTextNumbers.size + 1;
CLAIM|10|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:82|受限记忆的原话（主人当时说的那句话）没有参与比较|AND memory.classification = 'restricted' AND history.content_ref IS NOT NULL
CLAIM|11|一致|packages/persistence-sqlite/src/data-export/export.ts:512|和原话同文的提议会被导出|for (const row of snapshot.restrictedMemoryTexts) {
CLAIM|12|一致|test/integration/data-export-external-proposals.test.ts:407|被排除的提议的固定编号、替换链接没有专门测试。|it("[reverse] writes no key, unkeyed client or replacement link of a left-out proposal, and numbers placeholders without it", async () => {
CLAIM|13|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:454|一批里拒绝满 30 天、正文已删的条目，撤销时恢复不了|if (wanted.has(member.id) && member.contentRef !== null) {
CLAIM|14|一致|apps/control-center/src/components/external-proposals.tsx:220|网页却仍把它算在可以撤销的那一批里|void memory.externalUndo(batch.batchId).then((ok) => {
CLAIM|15|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:900|彻底删除一条记忆时，指向它的提议只被改成已拒绝|UPDATE external_memory_proposals SET status = 'rejected', memory_id = NULL,
CLAIM|16|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:901|摘要保留|content_ref = NULL, batch_id = NULL
CLAIM|17|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:57|删除提议行时，固定编号和「不带编号送过」两张表跟着删|proposal_id TEXT NOT NULL REFERENCES external_memory_proposals(id) ON DELETE CASCADE,
CLAIM|18|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:23|指着它的替换链接置空|superseded_by TEXT REFERENCES external_memory_proposals(id) ON DELETE SET NULL,
CLAIM|19|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:82|导出比较受限记忆时只读当前文字和历史版本|AND memory.classification = 'restricted' AND history.content_ref IS NOT NULL
CLAIM|20|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:82|没有 `quote_ref`|AND memory.classification = 'restricted' AND history.content_ref IS NOT NULL
CLAIM|21|一致|packages/persistence-sqlite/src/data-export/export.ts:156|占位编号扫描用的是全部提议。|snapshot.externalProposals,
CLAIM|22|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:492|拒绝满 30 天时只清掉正文，批次号保留。|"UPDATE external_memory_proposals SET content_ref = NULL WHERE id = ?",
CLAIM|23|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:457|撤销时没有正文的条目不恢复。|} else if (input.complete) detach.run(member.id, input.ownerId, input.agentId);
CLAIM|24|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:900|删除非受限记忆仍按原来的做法：提议改成已拒绝，只留摘要|UPDATE external_memory_proposals SET status = 'rejected', memory_id = NULL,
CLAIM|25|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:32|用来挡住同样的话被再次提议。|ON external_memory_proposals(owner_id, agent_id, text_sha256)
CLAIM|26|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:60|待确认表|1. **新表 `external_memory_proposals`（迁移 0093）。** 一行是一条提议：
CLAIM|27|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:90|30 天删正文|拒绝的条目 30 天后清掉正文（删掉 payload），只留摘要，用来挡重复提议。
CLAIM|28|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:84|撤销一批|新网关操作 `memory.external.undo`：撤销一个批次，删掉（移进回收站）这批新建的记忆，这些条目和这批拒绝的条目回到待确认

标注「本 PR 之前的 main」的代码说法，我按 6a62b987f^ 这个提交核对；`.agents/reviews/pr-420` 下的复核记录和交付报告不在当前检出（git 读取也被拒绝），相关出处未能核实。`放弃的做法` 里关于同步事务、异步解密等理由性描述未逐条核对。
