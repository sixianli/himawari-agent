---
status: superseded
document_type: adr
decision_status: superseded
supersedes: docs/adr/0101-adopt-product-vision-v2-1.md
superseded_by: docs/adr/0153-adopt-product-vision-v2-3.md
date: "2026-10-31"
---

# ADR 0134：采纳产品愿景 v2.2，规则成为硬性设定，护城河从三样改为四样

> 2026-11-02 被 [ADR 0153](0153-adopt-product-vision-v2-3.md) 取代：愿景换为 v2.3（只把「决策账本」改称「决策记录」），地位决定在 0153 里重述。下文是采纳 v2.2 时的记录，不再改写。

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
  - [受影响的下游文档：逐一核对，只列不改](#downstream)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-31（日本时间），Andy 交来产品愿景 v2.2 定稿，要求整篇替换 `docs/product-vision.md`，原话：

> 先把这一个 production vision V 二点二的内容更新到项目项目的那个 production 杠 vision 点 md 文档里面去。v2.2是最新内容。

v2.1 由 [ADR 0101](0101-adopt-product-vision-v2-1.md) 采纳，并定下规矩：愿景正文只由 Andy 修改，新版本整篇替换、在附录记录改动，ADR 0101 本身不随之改写。v2.2 的改动理由写在愿景附录「v2.2 相对 v2.1」第 10–17 条，起因有两件事：

1. 2026-10-31 的代码核对发现，v2.1 把「涉及钱的邮件一律重要」这类判定标准归入记忆，而记忆是软的：`rule` 类记忆（主人对 Himawari 的要求）进不进每轮上下文，取决于 `packages/application/src/services/owner-profile-service.ts` 的 2000 字档案预算（`OWNER_PROFILE_CHARACTER_BUDGET`，第 12 行）；超出预算的排队不注入。`rule` 类不受普通档案条目的重要度 600 门槛（`PROFILE_MINIMUM_IMPORTANCE`，第 16 行）限制，第 183 行先于档案直接选取，但预算是共用的。产品承诺的是确定性，实现是概率性。只有 Gmail 第一刀的地板规则（[ADR 0106](0106-proactive-loop-v1-gmail-read-only.md) 决定第 4 条）是确定性的。
2. 2026 年 9–10 月，平台型个人 Agent（Muse、dots、Duet 等）已把长期记忆、主动提醒、个人规则和审批门做得很好。Andy 自己用了一周，认为 Muse 的记忆与主动性是目前体验最好的。v2.1 对比表里「通用产品主动性弱、记忆浅黑盒」的说法已不成立。

<a id="decision"></a>

## 决定

本 ADR 取代 [ADR 0101](0101-adopt-product-vision-v2-1.md)（Andy 2026-10-31 定：「supersede」）。ADR 0101 关于愿景地位的决定全部沿用，在此重述，并加上 v2.2 的内容决定：

**沿用 ADR 0101 的部分**

1. 愿景放在 `docs/product-vision.md`，正文一字不改照原文保存，只加文档头（`status` 等生命周期字段）、跳转锚点、一行目录和一段「仓库注」说明它的地位；带通用生命周期字段，不设 `document_type`。
2. 它是最上层的产品文档。各版本 PRD 决定先做哪些、暂不做哪些，但不得违背愿景、原则和原则冲突的优先顺序（用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率）；PRD、架构文档、ADR 和设计规格之间原有的权威顺序不变。
3. 正文只由 Andy 修改。出新版本时整篇替换，并在附录记录改动；采纳记录由新 ADR 取代旧 ADR，仓库注指向现行的采纳 ADR。
4. [AGENTS.md](../../AGENTS.md#product-vision) 的 "Product Vision" 一节继续要求所有会话在设计或修改面向用户的功能、记忆、主动行为、工具、权限或自我改进前先读愿景，权衡原则时写明依据哪一条。
5. 不再把 Himawari 描述为「本地优先」（local-first），说法是「自有优先、数据自持」。
6. ADR 0101 的补记「原则 8 的成本上限和 ADR 0076 的关系」继续成立：[ADR 0076](0076-no-model-cost-budget-limits.md) 删的是全局累计上限，原则 8 要的是按任务的上限，记在 [BL-20261028-002](../backlog/BL-20261028-002-per-task-budget-for-unattended-work.md)。

**v2.2 新增的部分**（共 9 条，均由 Andy 确认）

采纳 v2.2 为现行愿景，`docs/product-vision.md` 整篇替换、正文一字不改，仓库注指向本 ADR。

1. **规则成为独立的护城河资产，并定义为「硬性设定」**（原则 3、3.5、第 4 章）。记忆只保存一条规则的出处和修改历史；规则本身写进程序、必定执行，每条都有回归测试守着。
2. **护城河从三样改为四样**：个人记忆图谱、Agent 规则手册、长尾工具库、决策账本。决策账本同时记录记忆层自己的门槛决策（记什么、丢什么、合并什么）。
3. **原则 2 补入每日注意力预算与规则手册预授权**：常规判断由规则手册预先授权，不逐次确认；每日需要 Andy 介入的次数与时间有上限，超限的事项排队等待。
4. **原则 5 补入「其他 Agent 通过 Himawari 认识我」**：Claude Code、Codex 等是 Andy 的工具，也是 Himawari 的消费者；Himawari 是 Andy 所有 AI 工具认识他的唯一事实源。
5. **3.3 对比表与对手名单按 2026 年 10 月现状改写**，Muse 为主要对手。新增**追平线**：平台有的记忆与主动能力做到一样好，以 Muse 为对照组量化；差异化只押在平台结构上做不到的地方。**「拥有」落成三件可检验的事**：拿得走（记忆、规则、工具可导出）、测得了（每条规则有回归测试，主动性有命中率与误扰率曲线）、说得清（任意一次开口或沉默能追溯到规则出处与记忆原话）。
6. **3.4.4「主动性的信号上限」改为「校准主权」**：信号数量不再是差异，差异在校准只对 Andy 一个人调、过程看得见、数据拿得走。
7. **3.4.3 区分造工具的流水线与工具库**：流水线是通用能力，差异在产出的只对 Andy 有用的工具库和决定什么能进库的评测门。
8. **Jarvis Test 加 #11 决策可解释、#12 可携带；#10 扩展为「打扰与门槛校准」**，覆盖所有由模型做出的门槛决策并附样本量。
9. **量化指标加**：决策可解释率、每周需 Andy 介入的分钟数、与对照组（Muse）的三个差距（主动提醒命中率差、误扰率差、记忆回忆准确率差；追平线的定义是三个差不为负）。

本 ADR 不改 Jarvis Test 任何条目的文字；条目原文以愿景 3.7 为准。

<a id="options"></a>

## 比较过的方案

- **补充（amend）ADR 0101**：新 ADR 只记 v2.2 的内容变化，0101 保持 active。好处是 0101 第 3 条自己写明「本 ADR 不随之改写，除非地位本身变化」，而 v2.2 没改地位。坏处是采纳记录分在两个 ADR 里，读者要先读 0101 再读本 ADR 才知道现行愿景是哪一版、地位是什么。线程推荐这个方案，Andy 2026-10-31 选了取代。
- **不开 ADR，只靠愿景附录**：附录已经写了改动理由。但治理规则要求持久的产品决定有 ADR，而且下游文档和愿景的冲突（下文）需要一处记录谁已核对、为什么暂不改。不采用。
- **采用的方案：取代（supersede）ADR 0101**：本 ADR 重述 0101 仍然有效的地位决定，加上 v2.2 的内容决定，成为愿景唯一现行的采纳记录；0101 按治理规则标为 superseded，内容不改。以后每个新版本照此办理：新 ADR 取代上一版的采纳 ADR。

<a id="consequences"></a>

## 后果

- 好处：以后设计记忆、主动提醒、规则、工具和评测时，有一处写明「规则不是记忆」「追平线以 Muse 量化」「拥有 = 拿得走、测得了、说得清」，可以直接引用。
- 代价：愿景和现状的差距比 v2.1 时更大。规则手册、注意力预算、决策可解释、可携带导出都还没有实现；Jarvis Test #10 的扩展要求记忆层也记门槛决策，现有的决策日志只记主动提醒。读者仍要分清「目标」和「现状」，现状以架构文档和代码为准。
- 后续：哪些差距记成 Backlog、先做哪一项，由 Andy 决定；本 ADR 和 ADR 0101 一样不替他做这个决定。

<a id="downstream"></a>

### 受影响的下游文档：逐一核对，只列不改

每一条都在 2026-10-31 打开原文核对过，均与 v2.2 有冲突或缺口。本 ADR 只记录，不改这些文档；改法等 Andy 决定 Backlog 顺序后，由对应的 Spec 或 ADR 处理。

| 文档 | 位置 | 现在写的 | 和 v2.2 的关系 |
| --- | --- | --- | --- |
| 自建记忆引擎 Spec | [`2026-10-25-self-built-memory-engine-design.md`](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/specs/2026-10-25-self-built-memory-engine-design.md) 第 42 行、第 58 行 | 「规矩」层「提炼为 `rule` 类别时」写入，「每轮常驻，排在档案前」；`rule` 是记忆 `category` 的一个取值 | v2.2 原则 3：规则不是记忆，记忆只保存规则的出处和修改历史。「每轮常驻」在代码里也不成立：`rule` 类和档案共用 2000 字预算，超出排队 |
| 记忆页 ADR | [ADR 0112](0112-memory-page-carried-memories-and-topic-browsing.md) 第 79 行 | 手动添加的要求类（`rule`）记忆重要度 800 | 同上：规则仍按记忆条目存储和挑选 |
| 主人档案代码 | `packages/application/src/services/owner-profile-service.ts` 第 12、16、183 行 | `rule` 类记忆先于档案选取，不受 600 门槛限制，但受 2000 字预算限制 | 愿景附录第 10 条已按代码写法修正 |
| PRD v0.2 | [`prd-v0.2.md`](../prd-v0.2.md) 第 227–242 行「注意力与 Web 投递」、第 375 行「注意力与提醒」 | 注意力只有 `SILENT / INBOX / DIGEST / NOTIFY / INTERRUPT` 五档；所有者可以降低等级 | 没有每日介入次数与时间上限，没有「规则手册预先授权、不逐次确认」（v2.2 原则 2） |
| 架构文档 | [`architecture-v0.1.md`](../architecture-v0.1.md) 第 534–536 行 | Run 完成后产生 `AttentionCandidate`，Attention decision 按 Owner/Agent policy revision 决定投递等级 | 同上，缺注意力预算 |
| 主动闭环 v1 第一刀 | [ADR 0106](0106-proactive-loop-v1-gmail-read-only.md) 决定第 3 条；Spec [`2026-10-29-proactive-loop-v1-gmail-design.md`](../execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md) 第 87 行；代码 `packages/platform-node/src/gmail-source.ts` 第 311 行（`format=metadata&metadataHeaders=From&metadataHeaders=Subject`）与第 194 行（`snippet` 前 500 字） | 模型只看发件人、标题和 Gmail 一行摘要，不看正文和附件；这是 Andy 2026-10-28 23:18 的批注 | 愿景 3.6「邮件状态判断」：对退款、预订、付款是否办结，「必须读完线程全文并搜后续确认/收据才下结论，绝不只看标题」。两者都是 Andy 的决定，分别管「要不要提醒」和「判断办结状态」，但第一刀的实现做不到 3.6 的要求；v2.2 的追平线又以 Muse「把这件事以前的邮件串起来看完整个历史」为对照。要不要让主动检查读正文，由 Andy 决定 |

<a id="references"></a>

## 关联文档

- [SOURCE: docs/product-vision.md]
- [SOURCE: docs/adr/0101-adopt-product-vision-v2-1.md]
- [SOURCE: docs/adr/0076-no-model-cost-budget-limits.md]
- [SOURCE: docs/backlog/BL-20261028-002-per-task-budget-for-unattended-work.md]
- [SOURCE: docs/adr/0106-proactive-loop-v1-gmail-read-only.md]
- [SOURCE: docs/adr/0112-memory-page-carried-memories-and-topic-browsing.md]
- [2026-10-25-self-built-memory-engine-design.md（已删除，链接指向删除前的版本）](https://github.com/sixianli/himawari-agent/blob/208007462f99e16c5c8cd4daac2acc10fa9f5f36/docs/execution/specs/2026-10-25-self-built-memory-engine-design.md)
- [SOURCE: docs/execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md]
- [SOURCE: docs/prd-v0.2.md]
- 工程案例库：[案例 37](../engineering-casebook.md#case-product-vision)（v2.1 的采纳；v2.2 不另开案例，Andy 2026-10-31 定）

[返回目录](#contents)
