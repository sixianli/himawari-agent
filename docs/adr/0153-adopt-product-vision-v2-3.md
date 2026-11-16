---
status: superseded
document_type: adr
decision_status: superseded
supersedes: docs/adr/0134-adopt-product-vision-v2-2.md
superseded_by: docs/adr/0284-adopt-product-vision-v2-4.md
date: "2026-11-02"
---

# ADR 0153：采纳产品愿景 v2.3，「决策账本」改称「决策记录」

> 2026-11-16 被 [ADR 0284](0284-adopt-product-vision-v2-4.md) 取代：愿景换为 v2.4（去掉「以 Muse 为对照组量化」），地位决定在 0284 里重述。下文是采纳 v2.3 时的记录，不再改写。

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-11-02（日本时间），全系统统一产品名称：同一个东西在界面、文档里只用一个名字，词表见 [docs/glossary.md](../glossary.md)。其中 Himawari 每次拿主意留下的一行，定名为「决策记录」；愿景 v2.2 把它写作「决策账本」，是护城河四样资产之一。

愿景正文只有 Andy 能改。Andy 在项目线程里原话授权：

> 我授权你去改

<a id="decision"></a>

## 决定

1. 采纳愿景 v2.3：`docs/product-vision.md` 整篇替换，相对 v2.2，正文只有两处文字不同（第 3 章第 4 样护城河的名字、第 4 章“不追求功能广度”一条里的名字，由「决策账本」改为「决策记录」）；另外文档头日期改为 2026-11-02、仓库注指向本 ADR、附录加第 18 条记录。含义、四样资产的构成和其余正文不变。
2. 本 ADR 取代 [ADR 0134](0134-adopt-product-vision-v2-2.md)。0134 里关于愿景地位的全部决定（愿景是最上层产品文档、正文只由 Andy 修改、新版本整篇替换并由新 ADR 取代旧 ADR、不再称“本地优先”）和 v2.2 新增的 9 条内容决定原样沿用，0134 的“后果”里列出的下游冲突仍是已知缺口，不随本 ADR 改变。
3. 0134 按治理规则标为 superseded，除顶部加一段“被 0153 取代”的说明（和 0101 被取代时的做法一样）外，正文不改。

<a id="options"></a>

## 比较过的方案

- **不改愿景，只在词表里写“愿景里的决策账本就是决策记录”**：改动最小，但同一个东西在最上层文档里还是另一个名字，违背“整个系统只用一个名字”。不采用。
- **直接在 v2.2 上原地改两个词，不开新 ADR**：违反愿景自己定的规矩（新版本整篇替换、附录记改动、新 ADR 取代旧 ADR）。不采用。
- **采用的方案**：按规矩出 v2.3 和本 ADR。

<a id="consequences"></a>

## 后果

- 愿景、AGENTS.md、界面、现行文档对这一项统一叫「决策记录」。
- 旧 ADR 正文仍写「决策账本」（例如 0134、0143、0147），不重写，词表登记了旧叫法；其中 0143、0147 仍是现行 ADR，它们的决定不受影响，只是用词沿用旧称。
- 不涉及代码、数据库和接口。

<a id="references"></a>

## 关联文档

- [SOURCE: docs/product-vision.md]
- [SOURCE: docs/adr/0134-adopt-product-vision-v2-2.md]
- [SOURCE: docs/glossary.md]
