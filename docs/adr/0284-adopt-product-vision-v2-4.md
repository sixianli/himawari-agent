---
status: active
document_type: adr
decision_status: accepted
supersedes: docs/adr/0153-adopt-product-vision-v2-3.md
superseded_by: ""
date: "2026-11-16"
---

# ADR 0284：采纳产品愿景 v2.4，去掉「以 Muse 为对照组量化」

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

愿景 v2.3 的 3.3 节说追平线「以 Muse 为对照组量化」，3.7 节的配套指标里有一项「与对照组的差距」：同一时期 Himawari 与 Muse 的主动提醒命中率差、误扰率差、记忆回忆准确率差，三个差不为负才算追平。

2026-11-16（日本时间），Andy 在审 PRD v0.3 大纲时说这一项没法评测（评论原话）：

> 我想改一下记忆和主动提醒。我感觉追平 Muse 没办法评测。

线程回复他：业界有公开的记忆评测集（LongMemEval、LoCoMo），主动提醒还没有公认的评测标准；建议以自己对标自己为主，并指出愿景 3.7 仍写着以 Muse 为对照组，愿景正文只有他能改。他随即回复：

> 那就把“以 Muse 为对照组量化”这个点，从 PRD 还有愿景里面去掉

愿景正文只有 Andy 能改；这句话就是他对这次改动的授权。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 采纳愿景 v2.4：`docs/product-vision.md` 整篇替换。相对 v2.3，正文只有两处不同：
   - 3.3 节「追平与否不靠感觉，以 Muse 为对照组量化（见 3.7 的配套指标）」删掉「以 Muse 为对照组量化」，成为「追平与否不靠感觉（见 3.7 的配套指标）」。
   - 3.7 节配套指标删掉「与对照组的差距」一项（三个与 Muse 的差，以及「追平线的定义是这三个差不为负」）。不补新指标：Andy 的授权只有“去掉”。

   另外文档头日期改为 2026-11-16，仓库注和“用法”一行指向 v2.4 和本 ADR，附录加第 19 条记录。3.3 对比表和对 Muse 使用体验的描述不变，其余正文不变。
2. 本 ADR 取代 [ADR 0153](0153-adopt-product-vision-v2-3.md)。0153 及其沿用的 [ADR 0134](0134-adopt-product-vision-v2-2.md) 里关于愿景地位的全部决定（愿景是最上层产品文档、正文只由 Andy 修改、新版本整篇替换并由新 ADR 取代旧 ADR、不再称“本地优先”），以及 v2.2、v2.3 的内容决定，除上面这一处外原样沿用；0134「后果」里列出的下游冲突仍是已知缺口，不随本 ADR 改变。
3. 0153 标为 superseded，除顶部加一段“被 0284 取代”的说明外，正文不改。

[返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **只在 PRD 里推后，不改愿景**：PRD 可以推迟愿景的内容，但 Andy 要的是这一项不再作为目标，留在愿景里会让以后的 PRD 和设计继续按它去做。不采用。
- **把对照组换成公开评测集（例如 LongMemEval）**：公开评测集测的是编造的陌生人的聊天，测不出 Himawari 记不记得主人的事；主动提醒也没有公认的公开标准。它可以作为一次性的外部参照，不写进愿景当长期指标。不采用。
- **采用的方案**：按愿景自己定的规矩出 v2.4 和本 ADR，只删不补。评测怎么做不写进愿景：用真实记忆出题、分数只和自己的历史比，已经写在 [ADR 0239](0239-real-memory-eval-sets.md)；具体到这一版怎么验收，由 PRD v0.3 来写，它在本 ADR 写成时还在起草，尚未进仓库。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 愿景、AGENTS.md 指向 v2.4。PRD v0.3 的目标按 v2.4 写，不再以追平 Muse 为验收。
- 现有和 Muse 对照的功能不随本 ADR 改动：[ADR 0154](0154-weekly-calibration-report-and-muse-mail-pairing.md)、[ADR 0187](0187-weekly-gap-lines-and-cases-against-muse.md) 定的周报对照线和 Muse 数据接收（[ADR 0162](0162-receive-muse-data-through-a-service-token-and-an-app-secret.md)）仍在代码里。要不要拿掉它们，另作决定。
- 已知缺口：3.3 仍叫「追平线」，但 3.7 里已经没有能直接判断“追上平台没有”的指标，剩下的指标只能看 Himawari 自己有没有变好。要不要改写「追平线」，由 Andy 另定。
- 不涉及代码、数据库和接口。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: docs/product-vision.md]
- [SOURCE: docs/adr/0153-adopt-product-vision-v2-3.md]
- [SOURCE: docs/adr/0239-real-memory-eval-sets.md]
