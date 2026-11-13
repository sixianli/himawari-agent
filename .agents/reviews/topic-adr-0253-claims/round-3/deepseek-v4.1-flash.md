CLAIM|1|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:11|[ADR 0246](0246-external-proposals-join-the-data-export-and-web.md) 让其他 agent 的提议（其他 agent 通过 MCP 送来、等 Andy 确认的记忆）进了网页和数据导出。|# ADR 0246：其他 agent 的提议进入网页和数据导出，格式升到 v3
CLAIM|2|找不到|-|那个 PR 留下了五条没做的改进|-|
CLAIM|3|找不到|-|下面第一条是 PR 420 交付时另外列出的低风险|-|
CLAIM|4|找不到|-|其余四条是复核意见，见 `.agents/reviews/pr-420/round-1/judgments.md` 的 glm-4|-|
CLAIM|5|找不到|-|和 `.agents/reviews/pr-420/round-5/judgments.md` 的 ds5-5 到 ds5-7|-|
CLAIM|6|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:900-902|受限（restricted）记忆被彻底删除后，保存进它的那条提议的正文摘要还留在库里|UPDATE external_memory_proposals SET status = 'rejected', memory_id = NULL, content_ref = NULL, batch_id = NULL WHERE id = ?
CLAIM|7|一致|packages/persistence-sqlite/src/data-export/export.ts:545|下一次导出会以明文写出|textSha256: withheld ? null : digest,
CLAIM|8|一致|packages/persistence-sqlite/src/data-export/export.ts:156|被排除的提议仍参与占位编号的扫描|snapshot.externalProposals,
CLAIM|9|一致|packages/persistence-sqlite/src/data-export/export.ts:169|导出里的占位编号会跳号|number = existingPlaceholderMax + shortTextNumbers.size + 1;
CLAIM|10|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:82|受限记忆的原话（主人当时说的那句话）没有参与比较|AND memory.classification = 'restricted' AND history.content_ref IS NOT NULL
CLAIM|11|一致|packages/persistence-sqlite/src/data-export/export.ts:524|和原话同文的提议会被导出|const exportedProposals = snapshot.externalProposals.filter((row) => !restrictedProposal(row));
CLAIM|12|找不到|-|被排除的提议的固定编号、替换链接没有专门测试|-|
CLAIM|13|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:454|一批里拒绝满 30 天、正文已删的条目，撤销时恢复不了|if (wanted.has(member.id) && member.contentRef !== null) {
CLAIM|14|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:390-394;apps/control-center/src/components/external-proposals.tsx:207-225|网页却仍把它算在可以撤销的那一批里|SUM(status = 'rejected') AS rejected
CLAIM|15|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:900-902|彻底删除一条记忆时，指向它的提议只被改成已拒绝，摘要保留。|UPDATE external_memory_proposals SET status = 'rejected', memory_id = NULL, content_ref = NULL, batch_id = NULL WHERE id = ?
CLAIM|16|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:57,65|删除提议行时，固定编号和「不带编号送过」两张表跟着删|proposal_id TEXT NOT NULL REFERENCES external_memory_proposals(id) ON DELETE CASCADE
CLAIM|17|一致|packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:23|指着它的替换链接置空。|superseded_by TEXT REFERENCES external_memory_proposals(id) ON DELETE SET NULL,
CLAIM|18|一致|packages/persistence-sqlite/src/data-export/snapshot.ts:74-83|导出比较受限记忆时只读当前文字和历史版本。|AND memory.classification = 'restricted' AND history.content_ref IS NOT NULL
CLAIM|19|一致|packages/persistence-sqlite/src/data-export/export.ts:156|占位编号扫描用的是全部提议。|snapshot.externalProposals,
CLAIM|20|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:492|拒绝满 30 天时只清掉正文，批次号保留。|"UPDATE external_memory_proposals SET content_ref = NULL WHERE id = ?",
CLAIM|21|一致|packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:454-457|撤销时没有正文的条目不恢复。|} else if (input.complete) detach.run(member.id, input.ownerId, input.agentId);
CLAIM|22|一致|packages/persistence-sqlite/src/sqlite-governed-deletion.ts:549-550|删除在一个同步的数据库事务里做|.transaction(() => {
CLAIM|23|一致|packages/platform-node/src/payload-protector.ts:231|读密文要走异步的解密|async unprotect(request: PayloadUnprotectionRequest): Promise<Uint8Array> {
CLAIM|24|一致|packages/persistence-sqlite/src/data-export/export.ts:511-525|和受限记忆同文、但不是保存进它的提议，在受限记忆还在时导出就已经排除|const exportedProposals = snapshot.externalProposals.filter((row) => !restrictedProposal(row));
CLAIM|25|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:61|本 ADR 补充它的决定 6|6. **机密：**正文按 ADR 0200 的规则处理，像机密的正文在明文层只放遮盖后的样子，原文进封存文件
CLAIM|26|一致|docs/adr/0246-external-proposals-join-the-data-export-and-web.md:62|本 ADR 补充它的决定 7|7. **链接：**正文和任何一条受限（restricted）记忆相同的提议
CLAIM|27|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:60|待确认表|1. **新表 `external_memory_proposals`（迁移 0093）。** 一行是一条提议：
CLAIM|28|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:90|30 天删正文|6. **保存期限。** 待确认不自动过期：过期等于悄悄丢掉主人的数据。拒绝的条目 30 天后清掉正文（删掉 payload），只留摘要，用来挡重复提议。
CLAIM|29|一致|docs/adr/0228-external-memory-proposals-wait-for-owner-confirmation.md:84|撤销一批|- 新网关操作 `memory.external.undo`：撤销一个批次，删掉（移进回收站）这批新建的记忆，这些条目和这批拒绝的条目回到待确认；

标注“本 PR 之前的 main”的背景和前提，我按父提交 0d989adb5 核对；当前 HEAD 上这些位置已被 PR 改成 ADR 决定后的写法。`.agents/reviews/pr-420/round-1/judgments.md` 和 `round-5/judgments.md` 在稀疏检出中读不到、`git show` 也被拒绝，因此 glm-4、ds5-5 至 ds5-7 及“PR 420 交付时列出”的出处标找不到；“被排除的提议的固定编号、替换链接没有专门测试”属于测试缺失，也没法仅靠阅读证明，标找不到。
