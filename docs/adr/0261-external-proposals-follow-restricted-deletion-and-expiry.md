---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
amends: "docs/adr/0246-external-proposals-join-the-data-export-and-web.md"
superseded_by: ""
date: "2026-11-12"
covers: "packages/persistence-sqlite/src/data-export/export.ts, packages/persistence-sqlite/src/data-export/snapshot.ts, packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql, packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts, packages/persistence-sqlite/src/sqlite-governed-deletion.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0261：删除受限记忆时一并删掉同文的提议，导出比较也算原话，过期的拒绝条目移出批次

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0246](0246-external-proposals-join-the-data-export-and-web.md) 让其他 agent 的提议（其他 agent 通过 MCP 送来、等 Andy 确认的记忆）进了网页和数据导出。那个 PR 留下了五条没做的改进，协调者要求一起做掉。下面第一条是 PR 420 交付时另外列出的低风险；其余四条是复核意见，见 `.agents/reviews/pr-420/round-1/judgments.md` 的 glm-4 和 `.agents/reviews/pr-420/round-5/judgments.md` 的 ds5-5 到 ds5-7：

- 受限（restricted）记忆被彻底删除后，保存进它的那条提议的正文摘要还留在库里，下一次导出会以明文写出；短的正文光凭摘要就可能被逐个试出来。
- 被排除的提议仍参与占位编号的扫描，导出里的占位编号会跳号。
- 受限记忆的原话（主人当时说的那句话）没有参与比较，和原话同文的提议会被导出。
- 被排除的提议的固定编号、替换链接没有专门测试。
- 一批里拒绝满 30 天、正文已删的条目，撤销时恢复不了，网页却仍把它算在可以撤销的那一批里。

本 ADR 不改表。

<a id="premises"></a>

## 前提

1. 彻底删除一条记忆时，指向它的提议只被改成已拒绝，摘要保留。`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:900-902`（本 PR 之前的 main）：“`UPDATE external_memory_proposals SET status = 'rejected', memory_id = NULL, content_ref = NULL, batch_id = NULL WHERE id = ?`”。
2. 删除提议行时，固定编号和「不带编号送过」两张表跟着删，指着它的替换链接置空。`packages/persistence-sqlite/src/migrations/0093_external_memory_proposals.sql:57` 和 65 行：“`proposal_id TEXT NOT NULL REFERENCES external_memory_proposals(id) ON DELETE CASCADE`”；同文件 23 行：“`superseded_by TEXT REFERENCES external_memory_proposals(id) ON DELETE SET NULL`”。
3. 导出比较受限记忆时只读当前文字和历史版本。`packages/persistence-sqlite/src/data-export/snapshot.ts:82`（本 PR 之前的 main）：“`AND memory.classification = 'restricted' AND history.content_ref IS NOT NULL`”，没有 `quote_ref`。
4. 占位编号扫描用的是全部提议。`packages/persistence-sqlite/src/data-export/export.ts:156`（本 PR 之前的 main）：“`snapshot.externalProposals,`”。
5. 拒绝满 30 天时只清掉正文，批次号保留。`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:492`（本 PR 之前的 main）：“`UPDATE external_memory_proposals SET content_ref = NULL WHERE id = ?`”。撤销时没有正文的条目不恢复。同文件 457 行：“`} else if (input.complete) detach.run(member.id, input.ownerId, input.agentId);`”。

<a id="decision"></a>

## 决定

1. **彻底删除受限记忆时，删掉保存进它的提议，以及和那条提议摘要相同的提议。**提议行连同固定编号、「不带编号送过」的记录一起删，正文密文按原来的规则清掉。删除非受限记忆仍按原来的做法：提议改成已拒绝，只留摘要，用来挡住同样的话被再次提议。依据“用户主权”和“边界与可逆性”：受限的东西 Andy 删了，就不该再留下能被试出原文的痕迹；代价是同样的话之后会被重新提议，Andy 要再拒一次。
2. **导出时，受限记忆历史版本的原话也参与比较。**和原话同文的提议整条不导出，计入 ADR 0246 决定 7 那一项 `omitted` 条数。
3. **占位编号只扫描要导出的提议**和它们的固定编号、「不带编号送过」的客户端，被排除的提议不影响编号。
4. **拒绝满 30 天、正文清掉时，同时清掉它的批次号。**这一批的「不要 Y 条」随之变少；整批都没有可恢复的条目时，这一批不再列出，也就没有「撤销这一批」按钮。这样网页上能撤销的就是真能恢复的。
5. **导出和导入也照这个规则：**没有正文的提议，`batchId` 一律置空，免得导入一份旧文件又把“正文已清、仍属于一批”的行带回库里。
6. **导入时核对正文和摘要：**有正文的提议（被扣留的用封存文件里的原文），按提议的规范化方式重算摘要，和 `textSha256` 不一致就整份拒绝（`DATA_IMPORT_SEAL_MISMATCH`）。决定 1 按摘要删除提议，摘要必须真是那段正文的摘要，不能由导入文件随意指定。
7. 不加迁移。

<a id="industry"></a>

## 业界怎么做

- GDPR 第 17 条把删除定义为“the erasure of personal data concerning him or her without undue delay”（[Art. 17](https://gdpr-info.eu/art-17-gdpr/)）。摘要能对着候选文字逐个试出原文，所以按受限数据的标准，摘要也算这段数据的一部分，跟着删。

<a id="options"></a>

## 放弃的做法

- **导出时把没有正文、没有记忆链接的已拒绝提议一律不写摘要。**这样会连带丢掉普通的拒绝记录：导入后同样的话会被重新提议，违背 ADR 0246 决定 4 的理由。而且已经没法分辨哪些来自受限记忆。
- **删除受限记忆时，再解密所有提议、逐条比较正文。**删除在一个同步的数据库事务里做，读密文要走异步的解密；和受限记忆同文、但不是保存进它的提议，在受限记忆还在时导出就已经排除，记忆删掉以后，那段话只是其他 agent 自己送来的提议。
- **撤销时补一条“有几条恢复不了”的提示。**要改概况的批次格式和网页，比直接让批次只含能恢复的条目复杂。

<a id="consequences"></a>

## 后果

- 删掉受限记忆以后，同样的话可以被其他 agent 重新提议，Andy 需要再决定一次。
- 拒绝满 30 天的条目不再属于任何一批；撤销一批只影响还能恢复的条目。
- 不改发给模型的内容，不改网关协议，不改表。
- 事故清单不加行：这些是复核提出的改进，不是线上事故。

<a id="references"></a>

## 关联文档

- [ADR 0246](0246-external-proposals-join-the-data-export-and-web.md)：本 ADR 补充它的决定 6、7。
- [ADR 0228](0228-external-memory-proposals-wait-for-owner-confirmation.md)：待确认表、30 天删正文和撤销一批。

[返回阅读导航](#contents)
