你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。方案里讲“原来”“已删除”“改之前”的旧代码，在材料里给出的基线提交里找：证据位置写成 文件:行@完整提交哈希，代码原文取自那个提交里的文件；这样写只限于当前提交里已经没有这段原文的旧代码，讲现状的句子仍然用当前提交里的文件和行。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行 或 文件:行@完整提交哈希>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 dab825db531c82e137df7730718ec035c7b00f36。
本 PR 的基线提交是 a87954eeeb7361a67d3f5c50598d9232325caa69（main 与 dab825db531c82e137df7730718ec035c7b00f36 的共同祖先）。
待核对的方案：
方案文件：docs/adr/0272-owner-proposals-join-the-data-export-format-v4.md（在提交 dab825db531c82e137df7730718ec035c7b00f36 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0246-external-proposals-join-the-data-export-and-web.md"
date: "2026-11-14"
---

# ADR 0272：提给主人的提议进入数据导出，格式升到 v4

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

“提议箱”表 `owner_proposals` 存的是 Himawari 想做、要主人点头的事（规则提议、确定动作等），PR 436 建表，PR 520 加了执行层（决定和执行分两列、租约、撤销用的原样）。这张表还没进数据导出：主人导出再导入，待采纳的提议和已执行动作的撤销原样都会丢。[ADR 0246](0246-external-proposals-join-the-data-export-and-web.md) 决定 4 把格式升到 v3 并写“v1、v2 的导出文件导入时整份拒绝”，本 ADR 沿用同一做法，格式升到 v4。

<a id="decision"></a>

## 决定

1. **格式升到 `himawari.data-export.v4`。**v3 及更早的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。依据“记忆可靠性”和项目“不顾旧数据兼容”的规则：清单新增必填的 `ownerProposals` 条数，旧文件没有这个数，也没有这张表的数据，照常导入会让主人以为都带过来了。导出的清单、结构文件和导入校验的版本常量是同一个 `FORMAT_VERSION`（`packages/persistence-sqlite/src/data-export/schemas.ts`）。
2. **新增 `data/owner-proposals.jsonl` 和 `schema/owner-proposals.schema.json`。**每行一条提议，全部状态都导出。字段是表里的各列，加上依据 `basis` 和执行原样 `execution`（都是加密载荷，导出时和别的文字一样过机密检查：含机密的明文层只放遮盖后的样子，原文进封存文件）。来源对话 `thread_id` 和租约不导出。
3. **导入只写空表。**目标库已有提议就报 `DATA_IMPORT_TARGET_NOT_EMPTY`。导出时还在“执行中”或“已执行待核实”的，导入成“结果不明”，不会在新库里被当成还在执行或被再执行一遍。含机密的依据或执行原样没有口令就整条跳过，导入报告写 `ownerProposalsWithoutOriginal` 条数。
4. **读不出的原文要写明，不能悄悄写空。**依据或执行原样对应的加密载荷已不可读（正在删除、已删除、不存在）时，导出里这一项写 null，同时在清单 `omitted` 里写“提给主人的提议里读不出来的依据或执行原样”和条数。撤销用的原样读不出的提议，导入后不能撤销，这一点写在 `omitted` 的原因里。载荷存在却解不开时，整份导出照常失败，不静默写空。
5. 不改表结构、不调模型。

<a id="options"></a>

## 放弃的做法

- **v3 文件照常导入、提议当空。**和 [ADR 0246](0246-external-proposals-join-the-data-export-and-web.md)、[ADR 0233](0233-rule-book-joins-the-data-export.md) 放弃旧版照常导入的理由一样。
- **读不出原文时整份导出失败。**一条库内本来就不一致的行不该拖垮整份导出；写进 `omitted` 并给条数，主人看得到少了什么。

<a id="consequences"></a>

## 后果

- 旧的 v3 导出文件不能再导入，要用新版重新导出一次。
- [ADR 0246](0246-external-proposals-join-the-data-export-and-web.md) 标题和决定 4 里的“v3”是当时的版本，现行格式以本 ADR 为准。
- 事故清单不加行：新功能，不是事故修复。

<a id="references"></a>

## 关联文档

- [ADR 0246](0246-external-proposals-join-the-data-export-and-web.md)、[ADR 0233](0233-rule-book-joins-the-data-export.md)、[ADR 0200](0200-portable-export-of-memories-and-decisions.md)：数据导出 v1 到 v3。
- `docs/architecture-v0.1.md` 提议箱一节：导出导入的行为说明。

[返回阅读导航](#contents)
