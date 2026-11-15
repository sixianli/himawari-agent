你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 6a62b987f4d665e2f0361408078db6a2b3eb8bd2。
待核对的方案：
方案文件：docs/adr/0253-external-proposals-follow-restricted-deletion-and-expiry.md（在提交 6a62b987f4d665e2f0361408078db6a2b3eb8bd2 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
amends: "docs/adr/0246-external-proposals-join-the-data-export-and-web.md"
superseded_by: ""
date: "2026-11-12"
---

# ADR 0253：删除受限记忆时一并删掉同文的提议，导出比较也算原话，过期的拒绝条目移出批次

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

[ADR 0246](0246-external-proposals-join-the-data-export-and-web.md) 让其他 agent 的提议（其他 agent 通过 MCP 送来、等 Andy 确认的记忆）进了网页和数据导出。它的 PR 复核留下了五条没做的意见，协调者按 Andy 的长期规则（“可以更好”的意见直接改）要求一起做掉：

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
5. 拒绝满 30 天时只清掉正文，批次号保留。`packages/persistence-sqlite/src/sqlite-external-memory-proposal-operations.ts:492`（本 PR 之前的 main）：“`UPDATE external_memory_proposals SET content_ref = NULL WHERE id = ?`”。撤销时没有正文的条目不恢复。同文件 455 行：“`} else if (input.complete) detach.run(member.id, input.ownerId, input.agentId);`”。

<a id="decision"></a>

## 决定

1. **彻底删除受限记忆时，删掉保存进它的提议，以及和那条提议摘要相同的提议。**提议行连同固定编号、「不带编号送过」的记录一起删，正文密文按原来的规则清掉。删除非受限记忆仍按原来的做法：提议改成已拒绝，只留摘要，用来挡住同样的话被再次提议。依据“用户主权”和“边界与可逆性”：受限的东西 Andy 删了，就不该再留下能被试出原文的痕迹；代价是同样的话之后会被重新提议，Andy 要再拒一次。
2. **导出时，受限记忆历史版本的原话也参与比较。**和原话同文的提议整条不导出，计入 ADR 0246 决定 7 那一项 `omitted` 条数。
3. **占位编号只扫描要导出的提议**和它们的固定编号、「不带编号送过」的客户端，被排除的提议不影响编号。
4. **拒绝满 30 天、正文清掉时，同时清掉它的批次号。**这一批的「不要 Y 条」随之变少；整批都没有可恢复的条目时，这一批不再列出，也就没有「撤销这一批」按钮。这样网页上能撤销的就是真能恢复的。
5. 不加迁移。

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
