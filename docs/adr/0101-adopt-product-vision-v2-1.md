---
status: superseded
document_type: adr
decision_status: superseded
supersedes: ""
superseded_by: docs/adr/0134-adopt-product-vision-v2-2.md
date: "2026-10-28"
---

# ADR 0101：采纳产品愿景 v2.1，作为贯穿开发周期的顶层产品文档

> 2026-10-31 被 [ADR 0134](0134-adopt-product-vision-v2-2.md) 取代：愿景换为 v2.2，地位决定在 0134 里重述。下文是采纳 v2.1 时的记录，不再改写。

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
  - [原则 8 的成本上限和 ADR 0076 的关系](#per-task-budget)
- [关联文档](#references)

<a id="context"></a>

## 背景

2026-10-28 13:55（日本时间），Andy 交来他修订的产品愿景 v2.1（愿景、8 条核心原则和原则冲突时的优先顺序、差异化与护城河、Jarvis Test 10 个场景、反愿景、附录），原话：

> 这是我最近刚刚修订的himawari的产品远景和产品目标。请把它放在项目的合适位置，这些愿景和产品目标是贯穿整个himawari的开发周期，请认真对待。

在此之前，仓库里没有一份单独的愿景文档。愿景只散在几处：README 第一句写“本地优先”，[PRD v0.2](../prd-v0.2.md) 的“产品目标”一节写 v0.2 这一版的目标，系统提示里的身份说明（[ADR 0084](0084-himawari-identity-system-prompt.md)）写了“只属于主人一个人”“同一个 Agent”“记忆最重要”等几条。三处互不引用，也没有一处写原则冲突时谁优先。

v2.1 还把“本地优先”（local-first，数据的主副本放在用户自己的设备上）改成“自有优先、数据自持”（self-hosted，自托管：运行环境和数据由所有者控制，可以是自己租的服务器）。这和实际部署一致：生产运行在 Andy 自租的 Contabo 云主机上，经 Cloudflare 隧道对外提供 Himawari 网页。

文档治理规则（document-governance SOP，`.claude/skills/document-governance/references/sop.md`，现已不在仓库里）的文档类型里没有“愿景”这一类。PRD 回答“这一版做什么、为什么”，每版一份、会被新版取代；愿景要跨越所有版本。

<a id="decision"></a>

## 决定

1. 愿景放在 `docs/product-vision.md`，正文一字不改照原文保存，只加文档头（`status` 等生命周期字段）、几个跳转锚点、一行目录和一段“仓库注”说明它的地位。和[工程案例库](../engineering-casebook.md)一样，它带通用生命周期字段，不设 `document_type`，因为治理规则没有这一类型。
2. 地位：它是最上层的产品文档。各版本 PRD 决定先做哪些、暂不做哪些，但不得违背愿景、原则和原则冲突的优先顺序（用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率）；PRD、架构文档、ADR 和设计规格之间原有的权威顺序不变。[PRD v0.2](../prd-v0.2.md) 开头加一句指向它。
3. 正文只由 Andy 修改。出新版本时整篇替换，并按原文的做法在附录里记录改动；本 ADR 不随之改写，除非地位本身变化。
4. 项目说明 [AGENTS.md](../../AGENTS.md#product-vision) 新增 “Product Vision” 一节：所有会话（包括云端线程）在设计或修改面向用户的功能、记忆、主动行为、工具、权限或自我改进前先读愿景；权衡原则时写明依据哪一条。
5. “本地优先”的说法改为“自有优先、数据自持”：README 第一句、案例库开头的项目介绍同步修改；AGENTS.md 写明不再把 Himawari 描述为 local-first。历史 ADR、Spec、Plan 里的旧说法是当时的记录，不改。

<a id="options"></a>

## 比较过的方案

- **合进 PRD，出 PRD v0.3**：符合现有文档类型；但 PRD 是“一版的范围”，会被下一版取代，愿景跟着一起被取代就不再是“贯穿整个开发周期”；而且 PRD 还有 v0.2 的大量功能细节，愿景会被淹没。不采用。
- **只写在 README 里**：最显眼；但 README 主要是安装、运行和接口说明，近 300 行，治理校验也不管它，以后容易被改动冲掉。不采用。
- **在治理规则里新增“愿景”文档类型**：最规整；但要改 document-governance 技能本身，按 Andy 的规定技能只能在 `sixianli/agent-skills` 仓库改，本仓库的是快照。不采用；如以后多个项目都需要，再在技能仓库提。
- **采用的方案**：`docs/` 顶层单独一份，带通用生命周期字段，PRD 和 AGENTS.md 指向它。不改技能，校验照常通过。

<a id="consequences"></a>

## 后果

- 好处：以后讨论“该不该做”“两条原则冲突怎么办”时有一处可引用的依据；云端线程通过 AGENTS.md 一定会读到它。
- 代价：愿景里不少内容现在还没做到（例如自造工具、跨表面连续、30 天打扰统计），读者要分清“目标”和“现状”。现状仍以架构文档和代码为准。
- 后续：愿景和现状的差距、以及把 Jarvis Test 做成可运行评测集等建议，写在本次评审网页 <https://claude.ai/artifact/G7qKTu3gw38PFGpWVzohZF> 里，由 Andy 决定哪些记成 Backlog；本 ADR 不替他做这个决定。

<a id="per-task-budget"></a>

### 原则 8 的成本上限和 ADR 0076 的关系（2026-10-28 补记）

评审指出原则 8 “推进受成本、资源与时间预算约束，超限即停”和 [ADR 0076](0076-no-model-cost-budget-limits.md) “不设费用上限”字面上相反。Andy 当天 14:11（日本时间）定：保留成本上限，原话：“我的意思是，这里还是要加一个成本上限，不然的话，一个后台任务如果无限期跑的话，我的那个模型的 token 额度，还有模型 token 的这个费用，我可能接受不了。”

两者不矛盾，管的是不同的东西：

- ADR 0076 删掉的是**全局累计上限**：全站所有调用加起来用满就一律拦住，当时正是它把所有对话拦死。
- 原则 8 要的是**按任务的上限**：每个后台任务或无人值守推进各带自己的费用、token 和时间预算，超限只停这一个任务并汇报，不影响其他对话。

所以 ADR 0076 继续有效，不被取代；按任务的上限作为新功能记在 [BL-20261028-002](../backlog/BL-20261028-002-per-task-budget-for-unattended-work.md)，默认值上线前问 Andy。正文不改。

<a id="references"></a>

## 关联文档

- [SOURCE: docs/product-vision.md]
- [SOURCE: docs/prd-v0.2.md]
- [SOURCE: docs/adr/0076-no-model-cost-budget-limits.md]
- [SOURCE: docs/backlog/BL-20261028-002-per-task-budget-for-unattended-work.md]
- [SOURCE: docs/adr/0084-himawari-identity-system-prompt.md]
- [SOURCE: docs/adr/0083-isolated-instance-per-person-with-owner-entry.md]
- 工程案例库：[案例 37](../engineering-casebook.md#case-product-vision)
- 业界资料：Ink & Switch《Local-first software》（Kleppmann 等，2019）把本地设备上的数据当作“primary copy”，七条理想的最后一条是 “You retain ultimate ownership and control”，<https://www.inkandswitch.com/essay/local-first/>。Himawari 取的是最后一条（所有权和控制权），不取“主副本在本地设备”。

[返回目录](#contents)
