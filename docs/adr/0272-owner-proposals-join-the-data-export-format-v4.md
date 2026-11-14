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

“提议箱”表 `owner_proposals` 存的是 Himawari 想做、要主人点头的事（规则提议、确定动作等）。这张表已经进了数据导出，本 ADR 补记那次的格式决定。[ADR 0246](0246-external-proposals-join-the-data-export-and-web.md) 决定 4 把格式升到 v3 并写“v1、v2 的导出文件导入时整份拒绝”，本 ADR 沿用同一做法，格式升到 v4。

<a id="decision"></a>

## 决定

1. **格式升到 `himawari.data-export.v4`。**v3 及更早的导出文件导入时整份拒绝（`DATA_IMPORT_FORMAT_UNSUPPORTED`）。依据“记忆可靠性”和项目“不顾旧数据兼容”的规则：清单新增必填的 `ownerProposals` 条数，旧文件照常导入会让主人以为提议都带过来了。导出的清单、结构文件和导入校验的版本常量是同一个 `FORMAT_VERSION`（`packages/persistence-sqlite/src/data-export/schemas.ts`）。
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
