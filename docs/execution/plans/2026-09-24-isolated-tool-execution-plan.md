---
status: active
document_type: plan
supersedes: "docs/archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md"
superseded_by: ""
date: "2026-09-24"
---

# Agent 任务级隔离工具执行实施计划

**Source Spec：** [SOURCE: docs/execution/specs/2026-09-24-isolated-tool-execution-design.md]

**继承的产品合同：** [SOURCE: docs/execution/specs/2026-09-16-workspace-authorization-lifecycle-design.md]

**架构决定：** [SOURCE: docs/adr/0031-isolated-tool-execution.md]

**目标：** 从按 invocation 绑定的 SRT / Job Host 路径迁移到任务级隔离环境，在不破坏既有授权、结果与持久释放事实的前提下，以环境整体终止证明控制 workspace 交接。

**状态：** 隔离执行改造待实施；2026-09-24 已完成旧计划的任务和验收责任转交。本 Plan 是两个来源 Spec 的唯一后续实施入口。旧计划已有局部实现与证据继续有效，见[逐项转交表](#transfer-tasks)；新增阶段的未勾选项表示适配或剩余验证，不表示从零重建全部能力。本次整合仅修改文档，不启动代码实施、真实服务调用或部署。

<a id="contents"></a>

## 阅读导航

- [基线、范围与依赖](#baseline)
- [旧计划转交与证据](#transfer)：[55 项任务](#transfer-tasks)、[68 项验收](#transfer-acceptance)、[过期表述](#obsolete-guidance)
- [文件边界](#files)
- [分阶段实施](#phases)：[P0](#p0)、[P1](#p1)、[P2](#p2)、[P3](#p3)、[P4](#p4)、[P5](#p5)、[P6 自动审查](#p6)、[P7 页面验收](#p7)、[P8 迁移交付](#p8)
- [验证命令与证据](#verification)
- [切换、回退与停止条件](#rollout)
- [完成清单](#closure)
- [ADR 初稿自审记录](#document-review)
- [计划转交自审记录](#transfer-review)

<a id="baseline"></a>

## 基线、范围与依赖

源码核查基线为 `506a91d56ab28ee6daa72f629dd85c1e3bcaee84` 加读取时在途改动。开始实施前重新盘点 Git、适用指令、当前依赖及已有变更，只复核与本 Plan 有关的变化。不得覆盖现有 workspace lifecycle / UI 工作，可把它们作为继承实现的历史证据，但不得把旧 backend 的通过结果算作新环境验收。

先阅读 [Spec 的代码差距表](../specs/2026-09-24-isolated-tool-execution-design.md#baseline)。优先处理的结构性问题是任务环境身份与每调用身份分离；直接替换 `spawn` 不足以达成新架构。

相关既有工作：

- [SRT Plan](2026-09-07-srt-unified-execution-plan.md)：[SOURCE: docs/execution/plans/2026-09-07-srt-unified-execution-plan.md]。保留既有实现及历史证据；新任务环境、严格停止与 backend 路线由本 Plan 接续，不重新执行旧 Host-first 目标。
- [Workspace lifecycle 历史 Plan](../../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md)：[SOURCE: docs/archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md]。旧计划以“任务转交”结束独立实施，55 项任务及 68 项验收由本 Plan 接续；未完成项不因归档变为完成。原 Spec 保持 active，审批、文件发布、队列与展示合同不被 ITE 验收取代。
- ADR 0030 释放事实及现有 reservation stop fence 必须保留。任何在途实现若仍以子调用完成释放全部环境占用，须在 P1/P3 完成集成后才能开启新 backend。

本 Plan 的执行改造主线实现一个本地 Docker-compatible backend 及现有工具迁移；浏览器只做 containment fixture 与绕过拒绝测试，不新增浏览器产品功能。Remote browser、MicroVM、远端工作区同步及跨 Run 常驻服务留在扩展边界，不要求本轮实现。旧计划尚未完成的自动审查、页面与真实端到端、迁移交付纳入 P6～P8。实施、安装、生产迁移、真实外部服务调用分别按当时授权执行；本次文档整合请求不授权这些操作。

<a id="transfer"></a>

## 旧计划转交与证据

转交核查基于 `27255477231a020d81212e99d7a3a21e334c2f92` 及本轮开始时的在途改动。新隔离 backend 尚未接入；生产 `production-sandbox-services.ts` 仍从 invocation 派生 job/environment，SQLite 已有永久 release receipt。旧 Plan 的局部完成证据与其顶部旧汇总不完全同步，因此以逐项记录和代码确定继承范围，不用勾选比例表示产品就绪程度。

**转交规则：** 下表编号 `旧 Pn-Txx` 按旧计划“分阶段实施任务”内的原始顺序分配，便于追溯；不是新增产品需求。保留原勾选和历史结论，不把新回归任务追写成旧实现失败。下表“原勾选”取自本次读取的工作树，包含任务前尚未提交的旧 Plan 进展更新；这些原有更新保留为归档文件的在途改动，不连同产品代码纳入本次文档提交。状态“保留/适配”说明已有能力的处理方式；“待验收”表示已有局部实现、完整证据不足；“替代路线”只替代执行机制，不取消安全要求。每行的新主责阶段对适配与最终验收负责。

<a id="transfer-evidence"></a>

### 继承证据及其边界

- [P2 完成记录](../../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p2-completed)：生产审批、真实 Worker、额度和撤权已局部验收；不能推断共享环境权限安全已验证。
- [P3 证据](../../../test/qualification/evidence/workspace-authorization-lifecycle/p3-completion-01/README.md)与[P4 证据](../../../test/qualification/evidence/workspace-authorization-lifecycle/p4-completion-01/README.md)：文件提交、恢复、可选副本已完成相应 Mac/Linux 固定执行器验证。新容器挂载、任意 Bash 后代和安装资格必须另验。
- [9 月 23 日自动审查修复](../../archive/plans/2026-09-23-automatic-review-defect-repair-plan.md)：TypeSafe 实际 Choice 协议、用量、预算、模型身份和超时的本地修复已有受控测试；真实服务、实际费用和生产启用仍未验证，早期错误替身证据不能覆盖此次修复。
- [旧 Plan 的 P1 页面记录](../../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p1-next-action)及[P6 资源投影](../../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p6-resource-projection)：已有局部分类与投影，仍有在途源码/证据；真实 DOM 与完整用户路径尚不能宣布通过。
- 旧 Plan 引用的 OrbStack `setsid` 候选探针仅证明受限探针中的环境停止；未接产品 Job Host、父 lease 或持久释放证明，不能代替 ITE-03/05/06。

<a id="obsolete-guidance"></a>

### 过期表述的处理

| 旧表述、汇总或需要限定的迁移语义 | 本次处理与当前责任 |
| --- | --- |
| macOS best effort 已接受，不需要新 backend 路线 | 作为历史结论保留；未来严格生命周期按 ADR 0031 与本 Plan P1～P4，不再执行旧 Host-first 目标 |
| 不把 Apple container 作为前置条件 | 不绑定某一产品仍有效；不能由此推断禁止 Docker-compatible backend 或必须仅用 SRT |
| P4 可选副本/逐文件应用仍未完成 | 被后面的 P4 完成证据更新；继承实现，仅迁移执行入口并重新验收，不从零重写 |
| P2 顶部仍把真实 Worker/重启联合验证列为剩余项 | 后续 P2 完成记录已证明局部实现；共享环境授权和真实完整 UI 验收仍待做 |
| P5 早期配置待定及接入项未勾选 | 已有 JEV 选择、本地适配及 9/23 修复；具体真实服务授权、费用核对及启用仍保留门禁 |
| 将原文件级并发与短提交语义直接用于长寿命环境 | 仅在实际可强制的能力范围不冲突时并发；全目录可写环境持有相交范围父 lease 到 verified stopped，结束子 claim 不能释放父环境 |
| 原 P0～P7 顺序和“继续本 Plan”指示 | 全部退为历史记录；实施顺序、待办、停止条件由本 Plan 统一管理 |

<a id="transfer-tasks"></a>

### 55 项原任务逐项转交

每组链接包含原任务全文及其局部证据。原勾选只描述转交时工作树中旧路线的实施记录，不能替代新 backend 回归；未勾选不等于完全没有代码。

#### 旧 P0：[历史 P0 任务及身份合同](../../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p0)

| 转交编号 | 原任务要点 | 原勾选 | 处理 | 新主责 | 必须保留或补验的内容 |
| --- | --- | --- | --- | --- | --- |
| 旧 P0-T01 | 基线和调用链 | 已勾选 | 保留 | [P0](#p0) | 继承读取范围，实施前刷新当前 revision 与 dirty 输入 |
| 旧 P0-T02 | 11ms/151ms ACK 故障复现 | 已勾选 | 保留 | [P1](#p1) | 保留原复现；新增父环境释放后的 ACK 回归 |
| 旧 P0-T03 | 操作与调用身份合同 | 已勾选 | 适配 | [P1](#p1) | 新增 executionJobId/generation，保留旧 invocation 含义 |
| 旧 P0-T04 | 数据与读写迁移顺序 | 未勾选 | 待完成 | [P1](#p1) | 与 P8 合并一次迁移矩阵，不能沿用单调用终态释放父 lease |
| 旧 P0-T05 | ADR 0030 持久释放决定 | 已勾选 | 保留 | [P1](#p1) | 保持原释放事实，ADR 0031 补环境边界 |
| 旧 P0-T06 | r3 新场景批准 | 已勾选 | 保留 | [P7](#p7) | 沿用已确认交互，不重新申请相同视觉批准 |
| 旧 P0-T07 | 首次加载测试入口 | 已勾选 | 保留 | [P7](#p7) | 保留 fixture 回归，补真实服务启动路径 |

#### 旧 P1：[历史 P1 实施及恢复记录](../../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p1)

| 转交编号 | 原任务要点 | 原勾选 | 处理 | 新主责 | 必须保留或补验的内容 |
| --- | --- | --- | --- | --- | --- |
| 旧 P1-T01 | 永久释放回执 | 已勾选 | 适配 | [P1](#p1) | 保留事务与不可变事实，新增父环境证明 |
| 旧 P1-T02 | 结果 ACK 与控制分离 | 已勾选 | 保留 | [P4](#p4) | 重复交付不重跑、不反锁 |
| 旧 P1-T03 | 停止后代与迟到派发 | 未勾选 | 替代路线 | [P2](#p2) | 用环境整体停止证明，经 P3/P4 集成；PID tree 不能签发新资格 |
| 旧 P1-T04 | 持久恢复调度 | 已勾选 | 适配 | [P4](#p4) | 复用 owner/revision/期限与结果补交，核查父环境 |
| 旧 P1-T05 | 错误与效果分类 | 已勾选 | 保留 | [P7](#p7) | 保留本地分类实现，完整 DOM 联合路径待验 |
| 旧 P1-T06 | 期限、无进展与安全重试 | 已勾选 | 适配 | [P2](#p2) | 环境期限覆盖后台程序；恢复仍不得重放未知写操作 |
| 旧 P1-T07 | 页面错误分类 | 未勾选 | 待验收 | [P7](#p7) | 已有局部投影不等于真实执行与页面联合通过 |

#### 旧 P2：[P2 六项完成记录](../../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p2-completed)

| 转交编号 | 原任务要点 | 原勾选 | 处理 | 新主责 | 必须保留或补验的内容 |
| --- | --- | --- | --- | --- | --- |
| 旧 P2-T01 | 生产 ActionPolicy/审批装配 | 已勾选 | 适配 | [P3](#p3) | 保留生产准入，接入共享环境执行 |
| 旧 P2-T02 | 不可变请求和并发决定 | 已勾选 | 保留 | [P3](#p3) | 两设备真实页面路径由 P7 补验 |
| 旧 P2-T03 | 额度预约与派发承诺 | 已勾选 | 适配 | [P1](#p1) | 环境创建与每调用额度分离，原请求只消费一次 |
| 旧 P2-T04 | 出队与派发前权限重验 | 已勾选 | 适配 | [P3](#p3) | 共享环境下一调用也检查；撤权停止存量能力 |
| 旧 P2-T05 | 单次批准与范围授权 | 已勾选 | 适配 | [P3](#p3) | 一次批准不能累加成环境常驻权限 |
| 旧 P2-T06 | 执行中撤销 | 已勾选 | 适配 | [P3](#p3) | 撤权触发整体 stop 与出口关闭，P4 验迟到竞争 |

#### 旧 P3：[P3 七项完成记录](../../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p3-completed)

| 转交编号 | 原任务要点 | 原勾选 | 处理 | 新主责 | 必须保留或补验的内容 |
| --- | --- | --- | --- | --- | --- |
| 旧 P3-T01 | 具体文件资源集合 | 已勾选 | 适配 | [P3](#p3) | 子 claim 继续细化，但实际全目录写能力由父 lease 覆盖 |
| 旧 P3-T02 | 公平队列与并发 | 已勾选 | 适配 | [P3](#p3) | 保留受限文件并发；整目录 writer 阻止相交新任务 |
| 旧 P3-T03 | 目录改名协议 | 已勾选 | 适配 | [P3](#p3) | 父环境仍持路径能力时不能仅结束子 claim 后改名 |
| 旧 P3-T04 | 完整候选与短时提交 | 已勾选 | 保留 | [P3](#p3) | 保留版本/身份/no-replace，并验证新挂载语义 |
| 旧 P3-T05 | 逐文件持久阶段与恢复 | 已勾选 | 适配 | [P4](#p4) | 保持部分结果；停止环境不等于文件回滚 |
| 旧 P3-T06 | 冲突保留与 Pi 重生成 | 已勾选 | 保留 | [P3](#p3) | 复用 Pi 循环，候选等待不占提交锁；父 lease 独立 |
| 旧 P3-T07 | 完整版本读取 | 已勾选 | 适配 | [P3](#p3) | 新 backend 文件系统重新 qualification；不夸大外部写者 CAS |

#### 旧 P4：[P4 七项完成记录](../../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p4-completed)

| 转交编号 | 原任务要点 | 原勾选 | 处理 | 新主责 | 必须保留或补验的内容 |
| --- | --- | --- | --- | --- | --- |
| 旧 P4-T01 | 工具分类与 Pi Operations | 已勾选 | 适配 | [P3](#p3) | 工具及内部 I/O 进入 executor；注解不是权限 |
| 旧 P4-T02 | Bash 目录与网络上限 | 已勾选 | 替代路线 | [P2](#p2) | 由 backend policy 强制，保留拒绝部分授权升级 Shell |
| 旧 P4-T03 | 真实协调范围 | 已勾选 | 适配 | [P3](#p3) | 全目录写能力全目录占用；副本仍可选 |
| 旧 P4-T04 | 纯联网搜索隔离 | 已勾选 | 适配 | [P3](#p3) | 进入任务环境但无用户目录 grant/mount/claim，保存单独准入 |
| 旧 P4-T05 | 候选环境和 Git 当前输入 | 已勾选 | 适配 | [P3](#p3) | 保留 dirty/untracked 内容及输入基线，不修改 Pi 上游 |
| 旧 P4-T06 | 可选副本逐文件保存 | 已勾选 | 适配 | [P3](#p3) | 已实现 save_copy 继续复用；原队列与独立读回重新验 |
| 旧 P4-T07 | 端口/Git/数据库/后台 owner | 已勾选 | 适配 | [P4](#p4) | 环境终止与远端效果分别核实，不把启动返回当释放 |

#### 旧 P5：[P5 本地接入记录](../../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p5-batch-contract)

| 转交编号 | 原任务要点 | 原勾选 | 处理 | 新主责 | 必须保留或补验的内容 |
| --- | --- | --- | --- | --- | --- |
| 旧 P5-T01 | ActionPolicy 自动审查入口 | 已勾选 | 保留 | [P6](#p6) | 保留默认关闭、硬拒绝优先与合法人工路径 |
| 旧 P5-T02 | 结构化批准与范围校验 | 已勾选 | 保留 | [P6](#p6) | 保留摘要和政策版本，不让模型授予广泛执行权 |
| 旧 P5-T03 | 模型边界/披露/预算 | 未勾选 | 待验收 | [P6](#p6) | 本地接入与 9/23 修复已有证据；真实费用与外发未验 |
| 旧 P5-T04 | 结果分支与注入防护 | 未勾选 | 待验收 | [P6](#p6) | 保留 9/23 协议修复测试，重新核对 R01～R07 的完整覆盖 |
| 旧 P5-T05 | 审查等待/迟到/重复结果 | 未勾选 | 待验收 | [P6](#p6) | 适配无本次子 claim；已有父环境能力不能忽略 |
| 旧 P5-T06 | 真实配置启用 | 未勾选 | 待授权验证 | [P6](#p6) | 已有 JEV 选择记录保留；具体外发目的地/额度/启用另按授权 |

#### 旧 P6：[P6 部分投影记录](../../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p6-resource-projection)

| 转交编号 | 原任务要点 | 原勾选 | 处理 | 新主责 | 必须保留或补验的内容 |
| --- | --- | --- | --- | --- | --- |
| 旧 P6-T01 | 统一后端状态投影 | 未勾选 | 待验收 | [P7](#p7) | 已有 Run/资源投影；补全部会话与文件阶段 |
| 旧 P6-T02 | 信息/动作/窄屏 | 未勾选 | 待验收 | [P7](#p7) | 保留 v4+r3，无独立审批页和虚假红点 |
| 旧 P6-T03 | 全部阶段真实计时 | 未勾选 | 待验收 | [P7](#p7) | 补审查/等待/执行/核验/清理，时间区间不简单相加 |
| 旧 P6-T04 | 宽度/明暗/键盘/缩放 | 未勾选 | 待验收 | [P7](#p7) | 保留已有浏览器证据，补 200% 与键盘联合覆盖 |
| 旧 P6-T05 | 首次加载/重连/重复发送 | 未勾选 | 待验收 | [P7](#p7) | 真实服务立即操作；不以全局等待掩盖首次加载 |
| 旧 P6-T06 | 真实完整执行链 | 未勾选 | 待完成 | [P7](#p7) | Gateway→ActionPolicy→SQLite→Worker→环境→文件→页面，关键边界不模拟 |
| 旧 P6-T07 | 效果与归属独立读回 | 未勾选 | 待验收 | [P7](#p7) | 批准前零、批准后一次、拒绝零；补串会话和失败续接 |
| 旧 P6-T08 | 真实服务测试与 CI | 未勾选 | 待完成 | [P7](#p7) | 保留启动/就绪/清理方法与报告，确保 runner 收集 |

#### 旧 P7：[P7 任务与门禁](../../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p7)

| 转交编号 | 原任务要点 | 原勾选 | 处理 | 新主责 | 必须保留或补验的内容 |
| --- | --- | --- | --- | --- | --- |
| 旧 P7-T01 | 数据库与混合版本 | 未勾选 | 待完成 | [P8](#p8) | P1 设计，P4 故障测试，P8 统一迁移演练 |
| 旧 P7-T02 | 历史只读清单与修复候选 | 未勾选 | 待完成 | [P8](#p8) | 复用已有只读审计；无现场停止证明不得解锁 |
| 旧 P7-T03 | 备份/暂停/CAS/恢复 | 未勾选 | 待完成 | [P8](#p8) | 新旧数据一起演练，不替用户重跑旧失败请求 |
| 旧 P7-T04 | 切换与回退 Runbook | 未勾选 | 待完成 | [P8](#p8) | 依据实际实现更新，禁止 Host fallback |
| 旧 P7-T05 | Hermes 资源与数据盘 | 未勾选 | 保留门禁 | [P8](#p8) | 需要该主机时按现行指令检查 /data，不清理无关任务 |
| 旧 P7-T06 | 现场部署验证 | 未勾选 | 待授权验证 | [P8](#p8) | 仅有具体目标部署授权才执行，非文档整合动作 |
| 旧 P7-T07 | 回退保护新数据 | 未勾选 | 待完成 | [P8](#p8) | 旧 writer 不接管新 schema，不用旧备份覆盖新增事实 |

[↑ 返回阅读导航](#contents)

<a id="transfer-acceptance"></a>

### 68 项原验收的责任映射

原验收含义继续以[Workspace Spec](../specs/2026-09-16-workspace-authorization-lifecycle-design.md)和[原测试入口与断言](../../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#acceptance)为准。下表完整保留 ID 与必须证明的结果；ITE 是新增隔离边界的关联，不代表同义替换。标为“独立产品验收”的条目仍是必做项，不因没有 ITE 对应而删除。所有条目在新组合路径下均待最终验收；历史局部通过见上文证据，不在本轮伪造通过状态。

| 原 ID | 必须读回或证明的结果 | 新主责阶段 | 相关 ITE / 独立要求 |
| --- | --- | --- | --- |
| A01 | 硬拒绝优先；有效授权执行一次 | [P3](#p3) | ITE-02、10 |
| A02 | 批准前无 invocation、文件效果或本次占用 | [P3](#p3) + [P7](#p7) | ITE-02、10 |
| A03 | 两设备仅一个决定和一个逻辑执行 | [P3](#p3) + [P7](#p7) | ITE-02、10 |
| A04 | 边界时刻以服务端为准，过期零派发 | [P3](#p3) + [P7](#p7) | ITE-02、10 |
| A05 | 新内容新 intent；只有真实范围覆盖可复用 | [P3](#p3) | ITE-02、10 |
| A06 | 取消先提交时迟到批准不启动 | [P3](#p3) | ITE-02、10 |
| A07 | 出队失效后不执行，预约按事实释放 | [P3](#p3) | ITE-02、10 |
| A08 | 撤销无后续派发；真实停止和已有效果分别记录 | [P3](#p3) + [P7](#p7) | ITE-02、10 |
| A09 | 旧 grant 失效仍可 inspect/stop，不获得新业务权限 | [P3](#p3) | ITE-02、10 |
| A10 | 搜索记住选择范围保持不变，拒绝不产生长期 grant | [P3](#p3) + [P7](#p7) | ITE-02、10 |
| A11 | 未生效/收紧阻止，放宽不复活已拒绝请求 | [P3](#p3) | ITE-02、10 |
| A12 | 错误主体与串会话零决定；重新认证只读回现状 | [P3](#p3) + [P7](#p7) | ITE-02、10 |
| A13 | 目标替换后拒绝旧提交，不覆盖不同对象 | [P3](#p3) | ITE-02、10 |
| W01 | 用可控并发屏障证明两读同时在执行 | [P3](#p3) | ITE-05、07；原并发/版本合同独立验收 |
| W02 | 冲突区间不重叠，排队可取消且无饥饿 | [P3](#p3) | ITE-05、07；原并发/版本合同独立验收 |
| W03 | 两个不同文件可同时推进，无全目录串行；仅适用于可强制的不相交能力范围，整目录 writer 遵守父 lease | [P3](#p3) | ITE-05、07；原并发/版本合同独立验收 |
| W04 | 相反申请次序也不会各持部分资源死等 | [P3](#p3) | ITE-05、07；原并发/版本合同独立验收 |
| W05 | 持续新 reader 不越过先到冲突 writer | [P3](#p3) | ITE-05、07；原并发/版本合同独立验收 |
| W06 | 无进程且派发已撤销才释放；迟到派发被阻止；新环境须整体停止证明，PID 退出不够 | [P4](#p4) | ITE-03、05、10 |
| W07 | 真实链接/挂载/身份变化不绕开协调 | [P3](#p3) | ITE-07、15 |
| W08 | 搜索无用户目录 grant/挂载/claim，保存另行准入 | [P3](#p3) | ITE-07、08 |
| W09 | 11ms/151ms 及等于到期边界；历史释放不反锁 | [P4](#p4) | ITE-11 |
| W10 | 丢失与重复 ACK 只重交结果，执行计数不增 | [P4](#p4) + [P7](#p7) | ITE-06、11 |
| W11 | 实际后代仍可写时，第二个冲突 writer 被拦住 | [P4](#p4) | ITE-03、05 |
| W12 | PID/boot/fence 变化不接管或误杀无关进程 | [P4](#p4) | ITE-06、14 |
| W13 | 服务启动返回后仍有 owner 和必要 claim；默认 Run 内后台服务，跨 Run 常驻不在本轮范围 | [P4](#p4) | ITE-01、03、05 |
| W14 | 已停稳定部分文件可获准诊断读取，不全区冻结 | [P4](#p4) | ITE-05、15 |
| W15 | 新风险另记保护；旧 released_at/凭据不被抹掉 | [P4](#p4) | ITE-11 |
| W16 | 真实并发读取只有完整版本；依赖最新值时等提交 | [P3](#p3) | ITE-05、07；原并发/版本合同独立验收 |
| W17 | 中断无正式半成品，新建同名竞争不覆盖 | [P3](#p3) | ITE-07、15 |
| W18 | 同基线两个 writer 一个提交、另一个冲突 | [P3](#p3) | ITE-05、07；原并发/版本合同独立验收 |
| W19 | 硬链接/大小写/目录别名正确协调，不同文件仍并行 | [P3](#p3) | ITE-05、07；原并发/版本合同独立验收 |
| W20 | 候选环境耗时或等待确认不占主目录；普通命令无强制副本 | [P3](#p3) + [P7](#p7) | ITE-07、15 |
| W21 | 逐文件部分结果持久；恢复不覆盖之后外部编辑 | [P3](#p3) | ITE-07、15 |
| W22 | 双平台 no-replace/跨盘条件不支持时明确阻止 | [P3](#p3) | ITE-07、15 |
| W23 | 只读安全重试有界；非幂等未知不重发 | [P4](#p4) | ITE-06；原安全重试合同独立验收 |
| W24 | 改名等待当前冲突操作；新冲突排后，无关继续 | [P3](#p3) | ITE-05、07；原并发/版本合同独立验收 |
| W25 | 改名后身份/目标重验，跨盘操作不冒充原子改名 | [P3](#p3) | ITE-05、07；原并发/版本合同独立验收 |
| W26 | 真实尝试越界失败；协调范围覆盖可写上限 | [P3](#p3) | ITE-07、08 |
| W27 | 非 Git 与有未提交/未跟踪内容的 Git 均不丢现有输入 | [P3](#p3) | ITE-07、15 |
| W28 | 虚假工具注解及间接子进程不能绕过宿主限制 | [P3](#p3) | ITE-07、08 |
| W29 | 新 intent 重新检查版本；模型生成时不持提交锁 | [P3](#p3) + [P7](#p7) | ITE-05、07；原并发/版本合同独立验收 |
| W30 | 确切批准不扩大；持续冲突/预算耗尽有明确终点 | [P3](#p3) | ITE-05、07；原并发/版本合同独立验收 |
| R01 | 模型建议通过也不能越过硬拒绝 | [P6](#p6) | ITE-02；硬拒绝与审查顺序独立验收 |
| R02 | 已有覆盖授权时审查调用次数为零 | [P6](#p6) | 独立产品验收 |
| R03 | 审查决定绑定并经原 Pi/Worker/沙箱执行，范围不扩大 | [P6](#p6) | ITE-01、02、07、10 |
| R04 | 各结果分支准确；安全替代重新准入，故障不默认放行 | [P6](#p6) + [P7](#p7) | ITE-02；审查分支与安全替代独立验收 |
| R05 | 迟到和重复结果不复活失效请求或重复执行 | [P6](#p6) | ITE-06、10；迟到审查决定独立验收 |
| R06 | 未配置/超委托范围无外发和费用，回到合法人工/拒绝路径 | [P6](#p6) | 独立产品验收 |
| R07 | 不可信文本无法更改授权规则或指令来源 | [P6](#p6) | ITE-02；注入防护独立验收 |
| E01 | 事务中断不丢额度、不产生孤儿占用 | [P4](#p4) | ITE-04、06 |
| E02 | 崩溃后区分未发送和可能发送；不盲重发 | [P4](#p4) | ITE-04、06 |
| E03 | 真实修改后结果丢失，按原身份核验且不重复修改 | [P4](#p4) | ITE-06、15 |
| E04 | 实际非零退出带部分修改，不能显示未执行 | [P4](#p4) + [P7](#p7) | ITE-15；效果展示独立验收 |
| E05 | 取消和完成竞争保留真实效果和停止意图 | [P4](#p4) + [P7](#p7) | ITE-03、06、10 |
| E06 | 故障注入前后分别验证阻止或证据恢复；不损伤真实工作目录 | [P4](#p4) | ITE-05、06、15 |
| E07 | 服务重启、旧 epoch、事件乱序重复无倒退或重跑 | [P4](#p4) | ITE-06、12 |
| E08 | 核验达到边界显示待确认，不假解锁或无限转圈 | [P4](#p4) + [P7](#p7) | ITE-05、06 |
| E09 | 未知非幂等接口调用计数不增加 | [P4](#p4) | ITE-06；远端效果不重放独立验收 |
| U01 | 首次打开立即操作也有反馈、草稿与归属正确 | [P7](#p7) | 独立产品验收 |
| U02 | 断线完成/审批后快照恢复，不重复提交 | [P7](#p7) | ITE-06、11；页面恢复独立验收 |
| U03 | 顶部、工具行、红点与按钮反映同一后端事实 | [P7](#p7) | ITE-05、10；统一展示独立验收 |
| U04 | 真实分段及并行区间；60 秒等待不计入 2 秒写入 | [P7](#p7) | 独立产品验收 |
| U05 | 四档宽度、明暗、缩放、键盘与可访问性有截图/断言 | [P7](#p7) | 独立产品验收 |
| U06 | 停止目标后台服务不取消无关会话或偷换 owner | [P7](#p7) | ITE-02、03、10；停止对象归属独立验收 |
| U07 | 主信息简洁、细节可展开、需用户行动才点红点 | [P7](#p7) | 独立产品验收 |
| M01 | 只读预览→新核验证据→逐条修复；未证实不释放 | [P8](#p8) | ITE-06、12 |
| M02 | 旧 reader/writer/Worker 遇不兼容合同明确阻止而非降级 | [P8](#p8) | ITE-06、12 |

[↑ 返回阅读导航](#contents)

<a id="files"></a>

## 文件边界

下表为实施定位，不保证每个文件都需要改动；新文件名在同一模块内可按当时约定细化。

| 目的 | 修改 / 新建边界 | 复用测试 |
| --- | --- | --- |
| 产品环境合同 | `packages/execution-contracts/src/` 的版本化环境与执行合同；`packages/application/src/ports/sandbox-execution*.ts`，新增 `execution-backend.ts` 产品 port | `packages/execution-contracts/test/execution-v2.contract.test.ts`，新增环境合同测试 |
| 任务身份与路由 | `apps/agent-service/src/production-sandbox-services.ts`、`production-runtime-tools.ts`；application 生命周期与资源服务 | `test/integration/sandbox-execution-v2.test.ts`、`sandbox-execution-preparation.test.ts` |
| Lease 与持久化 | `packages/persistence-sqlite/src/sqlite-sandbox-*.ts`、`migrations/` 追加下一可用 migration；workspace admission/claims | `sqlite-sandbox-execution-v2.test.ts`、`sandbox-resource-recovery-scheduling.test.ts`、workspace 集成测试 |
| Backend 适配 | Worker 组合与 `packages/runtime-sandbox/src/` 内独立 `execution-backend/` 模块；legacy Job Host 保持可核查 | Worker service tests、`sandbox-v2-worker-lifecycle.test.ts`，新增 container 合同测试 |
| 工具 runner | `packages/runtime-pi/src/sandboxed-coding-executor.ts`、平台受控文件 operations 与 runner 打包入口 | `sandboxed-coding-executor.compat.test.ts`、既有 Pi compatibility |
| 安全与资格 | `runtime-sandbox` policy/egress、平台 host verifier、qualification 合同与安装清单 | 网络拒绝、scope、真实主机 qualification；新增真实容器策略矩阵 |
| Recovery 与投影 | `sandbox-execution-reconciliation.ts`、`sandbox-startup-recovery.ts`、resource recovery、Run reconciler、thread execution resources/state | `sandbox-control-evidence.test.ts`、`sandbox-resource-recovery-scheduling.test.ts`、状态投影测试 |
| 自动审查继承 | `automatic-action-review.ts`、`production-automatic-review.ts`、既有 JEV transport/configuration/budget 组合 | 9/23 修复 Plan 的受控测试与原 R01～R07；真实服务单列 |
| 页面与用户反馈 | `thread-execution-state.ts`、`thread-execution-resources.ts`、Control Center 现有组件与语言资源 | 原 B 测试入口、执行链/授权反馈浏览器脚本；保留在途工作 |
| 迁移与现场交付 | 现有 migration engine、workspace audit CLI、安装/备份/停止/恢复 Runbook | 原 M/J/S 兼容测试及隔离备份演练 |
| 用户路径与证据 | 新增 `test/e2e/isolated-tool-execution.test.ts`；故障注入置于 `test/integration/`；必要 qualification 注册在 `ci/policy.json` | 沿现有 Vitest projects，不另建测试运行系统 |

运行时依赖只能精确固定；Pi imports 仍只存在于 runtime-pi。不修改 sibling pi-mono，不使用本地链接替代提交的发布依赖，不手改 dist。

<a id="phases"></a>

## 分阶段实施

每阶段先列相关不变量、边界及失败模式，优先在真实入口新增可重放 E2E；只有故障不易稳定触发时才补隔离测试。先运行测试确认命中旧缺陷/缺口，再实施最小完整变化。没有旧失败证据时记录原因，不虚构 red run。阶段内仅跑 focused tests，最终运行全项目 E2E 及必需检查。

<a id="p0"></a>

### P0：建立当前基线与 qualification 输入

- [ ] 读取当前 AGENTS、相关 Spec/Plan、Git 状态、已安装 Pi/SRT 和生产路由；核对代码差距表，记录版本与局部 diff 摘要。
- [ ] 盘点所有工具入口：Pi 七工具、后台任务、network-only/Web Search、Git/发布适配、浏览器/第三方 CLI。分类为环境工具或固定可信中介，查明是否存在 Host 任意代码旁路。
- [ ] 核查候选 Docker-compatible runtime 的环境整体停止、restart、inspect identity、策略与资源能力；不把 `docker info` 成功作为 qualification。镜像、挂载方式和工具链纳入资格输入。
- [ ] 按转交表核对旧 55 项任务的代码与证据输入，确定既有测试中原 68 项及 ITE-01～15 的覆盖和缺口，建立本 Plan 的验收记录，不复用旧绿色日志证明新环境。
- [ ] 以当前可重放 fixture 留存“单次调用环境身份”“Mac 已启动环境 unknown”和 lease 阻塞基线；历史 setsid 证据可作为动机，新的前后对比要有本次日志。

完成条件：当前路径、版本、现有 dirty 工作、可用 runtime 与必须拒绝的策略模式均有记录。若 runtime 不可用，可继续实现不依赖实机的合同，但不得标记后端验证完成；需要新外部安装或权限时按实际授权停止。

<a id="p1"></a>

### P1：任务级环境身份、持久 lease 与协议

覆盖 ITE-01、02、05、06、10、11、12、14。

- [ ] 先写环境父 lease 与调用子 claim 的验收：两个调用共享环境；一个调用结束后后台 writer 仍持有占用；同任务内部不被自己的父 lease 误阻塞；跨任务冲突仍阻塞。
- [ ] 覆盖 create response 丢失、延迟 create/start、stop fence 竞争、generation 替换、旧 writer 不识别新记录、证明接纳后 ACK 到期的失败窗口。
- [ ] 在现有产品数据库追加 execution job、环境/generation、调用关联、create/stop intents、环境 lease 和 immutable release receipt；不得改写旧 job 含义或历史 migration。
- [ ] 定义产品 backend port、能力声明和协议版本；解析失败禁止尝试较弱合同。增加读写兼容门禁，旧程序不得清除新父 lease。
- [ ] 实现幂等 create intent 与绑定 CAS、停止 fence；在新后端尚未合格时保持新任务执行不可启用。

完成条件：真实 SQLite 并发/重启验证通过；旧记录按原版本读回；原批准只消费一次；每个未知窗口保留占用。测试 stub 只支持持久化协议证据，不代表真实隔离。

<a id="p2"></a>

### P2：本地 container backend 与最小权限

覆盖 ITE-03、04、07、08、09、13、14、15。

- [ ] 在真实容器 fixture 先建立负向矩阵：邻仓/假秘密/Host socket、symlink、外置 gitdir、网络旁路、privilege、pids/内存/磁盘上限、挂载写回与用户 dirty 保留。
- [ ] 实现可信 runtime 管理适配、固定镜像/runner 摘要、non-root 与只读根文件系统、显式限额 mount、任务私有 HOME/tmp/cache；任务不获得 daemon/control socket。
- [ ] 建立 task-scoped egress 与 broker 生命周期，复用地址校验规则；证明直连和 DNS/IPv6/UDP 旁路被限制。若替换 SRT，验证相同策略，不能用特权运行化解 nested sandbox 问题。
- [ ] 实现 create/inspect/stop/verifyStopped/destroy；禁自动 restart，先保存证据后删除；后台 watchdog 在 Worker/Agent 死亡时仍强制原期限。
- [ ] 验证 stop 在 setsid/double fork/daemon 场景覆盖整个环境，并区分错误 runtime、not-found、paused、重启、超时与可信 stopped。
- [ ] 用实际 browser fixture 验证进程、profile、下载与出口一并纳管；未注册 browser backend 的产品入口继续拒绝。
- [ ] 记录 bind mount 的磁盘/嵌套敏感文件保护支持矩阵；无法强制则拒绝该模式，不能签发全面合格。

完成条件：可信 backend 合同与实机策略矩阵通过；资格严格绑定版本/镜像/模式。此时仍不切换产品默认路由。

<a id="p3"></a>

### P3：Pi 与 Worker 多调用共享环境、停止释放集成

覆盖 ITE-01、02、03、05、07、10、11、15。

- [ ] 先建立中等复杂度真实用户路径：授权 workspace → 写入 fixture 项目 → 安装本地 fixture 包 → 构建 → 启动后台 watcher → 修改文件并测试 → 读取 Git 状态 → 停止 → 新冲突任务接管。每步核对同一环境 ID、独立调用身份和实际文件结果。
- [ ] 在上述路径停止时注入 detached writer；独立宿主读回及后端观察证明停止，未收到 proof 时新任务不能执行。
- [ ] 将完整 Pi 工具实现及其内置搜索/临时 I/O 移入任务 executor；复用现有工厂、Operations、输出保护和 artifact 导出，不在 Control Plane 执行默认本地 I/O。
- [ ] Agent 首次工具准入创建父环境，Worker 后续调用复用；保持逐次授权、预算、期限及停止检查，权限变化只能显式安全轮换。
- [ ] Run 正常结束/取消/撤权接整体 stop，后端证明经现有 evidence reader 接纳，再在同一事务释放父 lease。逐调用 result 不再替代环境终态。
- [ ] 原目录与工作副本分别验证，保留候选发布/版本冲突合同；可信中介不能成为任意命令旁路。

- [ ] 逐项回归旧 P2/P3/P4：批准前零效果、一次消费、出队重验、目录改名、公平队列、文件身份/版本、候选重生成、部分恢复、save_copy 与 dirty/untracked 保留。按转交表保留 A01～A13、W01～W30，不把代表场景当作全部通过。
- [ ] 建立父 lease 与文件并发的双向反例：两个能力被严格限制到不同文件的任务可并发；持有全 workspace 写能力的环境即使前台调用结束，也阻止相交新任务。等待新审批或审查无本次子 claim，不代表已有父环境可以提前释放。
- [ ] 验证一次内容批准不扩大环境权限上界；旧环境内后台程序不得取得下一次批准新增的权限。能力变化按 Spec 轮换，撤权/过期停止原能力，network-only 任务不挂载用户 workspace。

完成条件：真实产品准入、SQLite、认证通信、Pi runner 与容器共同通过代表场景；不能以手工 `docker exec` 成功替代此阶段。

<a id="p4"></a>

### P4：恢复、故障窗口与安全回退

覆盖 ITE-04、05、06、10、11、12、14。

- [ ] 用可控同步点测试 create 前后、bind 前后、execute 持久化前后、stop/proof/lease release 前后 Agent 与 Worker 崩溃；真实断线/重启可重复且不会破坏其他任务。
- [ ] 验证 runtime 失联和重启，旧环境不自动复活；旧 authority、旧 generation、迟到输出/exec 不获得新执行资格。
- [ ] 接入既有 startup/reconciliation/recovery scheduler；恢复器只能 inspect/stop，不接受任意执行参数，不重新消费批准。
- [ ] legacy SRT unknown 与新 container 环境同时读回：只在相应证据满足时释放；新凭据不能为旧进程补造停止事实。
- [ ] 投影清楚显示未派发、停止中、核查未知和仍占用；保留已知工具结果；接口及 UI 变动遵循现有冻结交互，不新增独立审批入口。
- [ ] 回退演练证明停止新准入且保留核查能力；不降回 Host execution，不用旧 writer 处理新 lease。

完成条件：故障矩阵和恢复后独立状态 readback 通过；未知保留、ACK 不反锁、无自动重放均有断言。

<a id="p5"></a>

### P5：完整验证、启用资格与文档交付

覆盖全部 ITE-01～15，以及转交表的 68 项原验收；P6/P7/P8 的相关证据进入本阶段总体验收。

- [ ] focused 场景通过后，运行完整项目 E2E 与必需 lint/type/build/integration/compatibility 等检查，留存成功和失败证据。
- [ ] Mac + 选定 Docker-compatible runtime 与 Linux 分别完成 qualification；Host 专有工具、不同挂载模式和未覆盖后端明确标为不可用或未验证。
- [ ] 检查是否已有项目 verification skill；本变更显著改变共享执行前提，若存在则按 `maintain-verification-skill` 更新并实际验证；不存在不自动创建。
- [ ] 根据真实实现更新 Architecture、README、安装/停止/恢复 Runbook；Runbook 必须按 document-governance 重核静态合同与操作步骤后 seal，不把本文当运行手册。
- [ ] 收集 P8 的迁移/回退演练与启用条件；实际部署安排在本阶段必需验证通过之后。未部署只报告本地交付；自动审查未启用只报告默认关闭路径与本地验证。
- [ ] 核对所有验收与剩余 gap；只提交任务内完成的变化，保持用户其他 dirty 工作。

完成条件：本地交付与平台资格边界明确；若必需实机或全量检查被阻塞，则 Plan 保持 active，不将未执行项勾选完成。

[↑ 返回阅读导航](#contents)

<a id="p6"></a>

### P6：继承自动审查并完成独立资格

接续旧 P5 与 R01～R07；与隔离执行准备可分别推进，不用真实模型配置阻塞 P0～P4。复用 ActionPolicy、runtime-pi 访问边界、已有 JEV transport 与预算治理，不新建模型协议。

- [ ] 核对 9/23 修复后的生产组合与既有受控测试覆盖：hard deny、已有授权零审查、准确 Choice 协议/用量、低置信/无效输出、注入、超时、取消、模糊网络结算、安全替代的新 intent。
- [ ] 经新执行入口验证审查批准仍受逐次授权与环境上界限制；等待审查不产生本次子 claim，迟到/重复结果不复活撤销、取消或过期请求。已有环境 lease 另按实际能力保留。
- [ ] 保留 JEV 选择与配置提案，核对当次具体模型身份、披露接收方、委托范围和费用上限；只有这些真实调用及启用的授权成立后才执行真实请求、用量/费用独立读回和启用。
- [ ] 未配置、未获授权或真实资格不足时维持合法人工/拒绝路径；在验收记录区分本地通过、真实服务待验和未启用，不将 R01～R07 静默标成完成或删除。

完成条件：本地审查合同与新执行边界逐项通过；真实服务证据单独记录。可先交付默认关闭的隔离执行路径，但本 Plan 的自动审查真实资格任务保留，不能宣布两份 Spec 全部完成。

<a id="p7"></a>

### P7：补齐统一页面状态与真实用户路径

接续旧 P1 页面未完成项及旧 P6 八项任务，主责 U01～U07，联合 A/E/W/R 的用户反馈验收。沿用 v4 与已批准 r3，不扩展视觉设计。

- [ ] 保留已实现的 Run/Trace/资源投影，补全部会话 needsAttention、文件阶段及统一 reason/actions/effect/revision；顶部、工具行、Stop 与红点读取同一事实。
- [ ] 验证未派发、部分效果、停止中、unknown/blocked、已释放但待交付；不把 Run.cancelled 当环境死亡，不无限旋转，不抹掉成功结果。
- [ ] 补审查、批准、排队、准备、执行、核验、清理的真实起止与并行区间，刷新/恢复最终时长；没有来源的数据保持不可用。
- [ ] 扩展既有 Playwright runner：320/390/1024/1440、明暗、200% 缩放、键盘、长路径与窄屏动作可达；保留每条场景的 trace/断言及持久结果。
- [ ] 经真实 Gateway→ActionPolicy→SQLite→认证 Worker→隔离环境→文件→页面恢复验证：首次访问立即发送、慢配置/连接失败恢复、重复发送、创建中切换、断线批准/完成、两设备竞争、撤权及停止 unknown。模型输入可受控，关键准入、文件、停止及状态回传不可模拟。
- [ ] 独立读回文件与 SQLite，断言批准前零效果、批准后一次、拒绝后零效果；检查归属、无串会话/内容丢失、失败后的可用动作、环境及 lease 的实际清理。
- [ ] 在原 runner/CI policy 注册场景，记录准确启动、就绪、隔离数据和清理步骤。fixture-only 浏览器证据只作为局部回归，不替代真实执行链。

完成条件：原 68 项中涉及 UI 的条目与 ITE 用户路径均有可重复证据；页面通过与真实 provider、平台 qualification 分开报告。

<a id="p8"></a>

### P8：统一迁移、历史恢复与交付

接续旧 P0 数据兼容未完成项、旧 P7 七项及 M01/M02；与 P1 schema 设计和 P4 recovery 使用同一套迁移方案，不同时维护两套切换顺序。

- [ ] 在隔离备份上演练扩展 schema，覆盖旧 claim/receipt/barrier/queue 与新 executionJob/environment/父 lease 共存，验证旧/新 reader、writer、Worker 矩阵；不理解新合同的 writer 拒绝写入。
- [ ] 复用只读历史 audit 清单，补新环境信息与逐条 dry-run 修复候选；只有现场核验原身份和迟到派发不可再写，才允许 CAS 修复。新容器通过不能替旧 Mac unknown 补造证明。
- [ ] 演练备份、暂停写入调度、核查/停止、修复、恢复及 read/search→write；保留候选内容、发布状态、审批和新增消息，不重发原失败/未知非幂等请求。
- [ ] 依据实际代码制定构建、兼容、切换、观测、停止和回退 Runbook，完成静态合同核对；数据回退不能覆盖上线后新增事实，Host execution 不能作为故障回退。
- [ ] 需要 Hermes 时读取当时主机规范，核实 /data 和资源；使用隔离路径与端口，备份/证据不落拥挤根盘，不清理无关资源。
- [ ] P5 必需验证通过且取得具体部署目标与效果的授权后，完成当次只读 preflight、备份、受控切换和独立读回；将本地演练、平台资格与实际部署分别记录。缺少现场证明保持 blocked，不强制解锁。

完成条件：M01/M02 与 ITE-06/12 的演练通过，部署按真实结果报告；所有 unknown 有持续责任和恢复入口。历史任务不会因 Plan 转交自动取得新的执行或部署授权。

<a id="verification"></a>

## 验证命令与证据

已核对 `package.json`、`vitest.workspace.ts` 与 `ci/policy.json`：项目有 contracts、integration、e2e、pi-compat 等 runner。新增 E2E 文件需先在 P1/P3 创建；下面引用它的命令是**实施后的目标命令，当前未运行**。

| 时点 | 命令 |
| --- | --- |
| 环境合同与持久化 focused | `npx vitest run --config vitest.workspace.ts --project contracts packages/execution-contracts/test/execution-v2.contract.test.ts`；新增环境测试使用同一 project |
| 既有释放与恢复回归 | `npx vitest run --config vitest.workspace.ts --project integration test/integration/sqlite-sandbox-execution-v2.test.ts test/integration/sandbox-resource-recovery-scheduling.test.ts test/integration/sandbox-control-evidence.test.ts` |
| 新用户路径 focused | `npm run test:e2e -- test/e2e/isolated-tool-execution.test.ts --reporter=default --reporter=json --outputFile=test/qualification/evidence/isolated-tool-execution/<run-id>/focused.json` |
| 最终完整 E2E | `npm run test:e2e -- --reporter=default --reporter=json --outputFile=test/qualification/evidence/isolated-tool-execution/<run-id>/e2e.json` |
| 项目必需静态与构建 | `npm run check`、`npm run build` |
| 合同、集成、Pi 与项目测试 | `npm run test:contracts`、`npm run test:integration`、`npm run check:pi-compat`、`npm test`；复用输入未变的通过结果，避免无依据重复运行 |
| 文档 | `python3 /Users/triggerjames/.codex/skills/document-governance/scripts/validate_docs.py --strict .`、`git diff --check`；其他机器解析实际技能路径 |

`<run-id>` 必须替换为本次真实验证 ID，不得把占位文本作为路径直接运行。实际命令和 runtime fixture 开启方式由 P0/P2 接入既有 runner 后记录，不能编造当前不存在的 `qualify:container` 命令。环境缺失应导致必需 qualification 明确失败/blocked，不用 skip 获得绿色结论。

每次 E2E 均在 `test/qualification/evidence/isolated-tool-execution/<run-id>/` 留存：

1. exact command、Git revision、相关 local diff 摘要、OS/runtime/镜像/runner/策略摘要、fixture 准备与销毁方法；不保存凭据。
2. ITE ID、场景、断言与 test runner report；失败输出、trace、必要截图及 network error 不丢弃。
3. 独立 SQLite lease/release/barrier readback、环境 inspect 与停止证据、文件/下载/网络 canary 结果；单独日志“stopped”或截图不足以证明释放。
4. 测试拥有的 runtime 资源清单及清理 readback；清理仅删除 fixture 自有容器/volume/网络，不碰用户 workspace；验证 evidence 不在清理目录内。

实机强制限制与容器退出证据须真实执行；stub/fake clock 仅用于稳定制造 journal/CAS 竞态，不 mock 掉正在验证的隔离或停止机制。Hermes 运行前按项目指令读取运维约束、核查 `/data` 挂载、容量与 runtime；不因本 Plan 自动获得远端写入或安装权限。

<a id="rollout"></a>

## 切换、回退与停止条件

执行改造主线为 P0 → P1 → P2 → P3 → P4；P6 的本地审查核对可提前开展，P7 的真实环境路径依赖 P3/P4，P8 的兼容设计从 P1 开始、迁移演练在 P4 后完成，最终全部证据汇入 P5。真实自动审查与部署各自按授权执行，不作为合同开发的前置条件；只有 P1/P2 的门禁成立才接通 P3 的隔离测试执行；P3/P4、相关 P6/P7 本地合同与 P8 迁移演练通过后，由 P5 完成全量检查及平台 qualification，之后才能在另行授权的目标执行 P8 启用步骤。共享 schema / 授权 / 持久化变更不与正在修改同一文件的工作并行写入。

切换时先阻止新的旧路径高副作用准入，排空并核查旧环境，unknown 保留原占用；只把满足新 qualification 的任务派到新 backend。无需全站停机，但相交 workspace 不得在旧风险未清除时迁移。即使新 runtime 健康，也不能把旧 Mac unknown 当作已停止。

失败回退为关闭新执行入口、保存现有记录、保留当前或兼容版本的 recovery；**不允许 Host fallback、清空占用、改写历史证明、回滚到不识别新 lease 的 writer**。若 backend 安全保证失效，停止新准入并针对相关环境建立 incident；不删除资源以隐藏故障。

必须停止启用的情形：必需 policy 无法强制、身份/证明不可信、停止后仍有 writer/连接、全量验收缺失、未知占用被提前释放、runtime/socket 暴露给任务、历史数据被升级成无依据的 confirmed。测试故障要先诊断，不能放宽断言或增加无理由重试来通过。

<a id="closure"></a>

## 完成清单

- [ ] ADR 0031 的全部不变量与 ITE-01～15 有实现及可重放证据。
- [ ] 55 项转交责任逐项核销，原 68 项验收与 ITE-01～15 分别记录证据、范围和未验证原因；不以归档、阶段勾选或容器探针替代产品验收。
- [ ] 当前工具入口不存在未声明的 Host 任意代码旁路。
- [ ] 所有必需检查真实运行，未验证平台、模式和原因逐项说明。
- [ ] workspace lease 释放、迟到 ACK、恢复、混合版本 writer 与回退已验证。
- [ ] 用户数据和验证证据在 cleanup 后保留；无任务自有残留执行资源。
- [ ] 当前事实文档与 Runbook 根据实现更新；必要 verification skill 已维护。
- [ ] 未完成但另有范围的后续能力按需要记录 Backlog，不用空占位掩盖未交付要求。
- [ ] 完成后才按 document-governance 归档本 Spec/Plan；ADR 留在 `docs/adr/`。

<a id="document-review"></a>

## ADR 初稿自审记录（历史）

2026-09-24：先完成 ADR 0031，自审其架构图、十项核心原则、0025/0026 的逐条修正范围和 0030 的保留关系，再编写 Spec；复核 Spec 的身份、lease、授权边界、stop proof 与错误合同后编写本 Plan。自审不等同独立外部评审或实现验收。

| 审核项 | 结论 |
| --- | --- |
| ADR 与实现计划分离 | ADR 固定原则、边界和权衡；API 语义、字段、文件与迁移任务分别位于 Spec/Plan |
| 单任务多工具 | 明确现有 invocation 级身份的差距、父环境 lease、状态共享与权限变更轮换 |
| 全树停止与外部效果 | 环境整体停止及不可复活是必要条件；已发生效果、数据完整性与 ACK 独立处理 |
| 部分修正 | 保留 0025/0026 原文，以双向 amendment 及限定范围消除冲突，不整份废弃 |
| 当前事实 | 代码证据注明 revision 与 dirty 边界；历史 Mac 反例、用户 OrbStack 验证和本轮静态检查不冒充新实机资格 |
| 实施路径 | 合同/持久化先行，容器隔离资格后接产品，再做恢复与完整验收；切换失败不得恢复 Host 执行 |

文档治理修改前全仓基线发现四份既有未跟踪 `docs/runbooks/* 2.md` 的合同指纹不匹配，本任务不修改或重新 seal 它们。最终全仓严格检查仍仅报告这四项既有错误，未新增治理错误。本次九份文档的 frontmatter、SOURCE、Plan 结构、全部 ADR 替代关系及双向 amendment 检查通过，三份新文档的 60 个本地链接及其锚点静态检查通过；未宣称已在阅读器逐个点击或验证 Mermaid 渲染。

`git diff --check` 在普通及扩展只读环境均因 `.git/objects/pack/pack-50f4a0848e9eb170fc7b4df6f553a76b8ce0bb0d.pack` 无法正常读取而失败，报 `is far too short to be a packfile` 和 `unable to read 6df0af5eeefb5b12197c71a5178d67df6c6cad36`；文件元数据长度非零但直接读取返回空，根因未确定。后续核查确认该 pack 及对应 `.rev` 带有 macOS `dataless` 标记；Apple FileManager 返回 iCloud `NotDownloaded`。通过官方文件下载 API 定向下载原文件后，Git diff 恢复可读，无需重建或替换 Git 对象。继续复核本次九份文档并完成本地提交；具体提交标识与最终检查结果见交付记录。这些文档检查不代表本 Plan 已实施，也没有运行产品 E2E 或实机容器资格。

[↑ 返回阅读导航](#contents)

<a id="transfer-review"></a>

## 计划转交自审记录

2026-09-24：本次仅整合文档，未实施 backend、未运行产品测试、未启用真实审查服务或部署。旧计划按“被接续计划替代”结案，通过 document-governance 的 archive 工具移动；归档原因不是所有功能完成。

| 核对项 | 结果与范围 |
| --- | --- |
| 任务完整性 | 旧 P0～P7 共 55 项按原顺序分配转交编号，每项保留工作树读取时的勾选状态、处理方式、新主责及剩余要求 |
| 验收完整性 | A 13、W 30、R 7、E 9、U 7、M 2，共 68 项 ID 与原断言保留；ITE-01～15 另外追踪，不缩减原验收 |
| 现有能力 | P2/P3/P4 完成记录和 9/23 审查修复优先于旧顶部汇总；局部、替身、平台、真实服务和生产证据分别保留 |
| 安全合同 | 父环境 lease 不被子 claim 完成释放；整目录写能力限制并发；单次批准不累加为环境权限；unknown 与 backend 故障不得放行 |
| 文档职责 | ADR 0031 决策不改，两个 Spec 保持 active；新 Plan 接续全部后续实施，旧 Plan 仅作历史证据 |
| 历史与导航 | 归档历史正文除链接保持不变，勾选不重写；修复指向原路径的受跟踪文档链接。19 份范围内 Markdown 的 1,009 个本地链接/锚点静态检查通过，未在阅读器逐个点击 |
| Runbook | 五份正式 Runbook 仅修复历史引用，执行步骤和授权门禁未改。分别基于待提交源码和当前在途源码核对静态合同；原 HEAD 的 Hermes Runbook 指纹已与其源码不匹配，修正引用后按对应源码重新核对和 seal，两种内容均检查通过。此结果不证明现场可执行或允许部署 |
| 治理限制 | 全仓 strict 校验仍只有任务前已有四份未跟踪 `docs/runbooks/* 2.md` 指纹错误；不删除或重新 seal 这些副本，不把全仓校验报告为通过。范围内 frontmatter、SOURCE、Plan 结构、历史保留和逐项映射检查通过 |
| 在途改动 | 原代码、页面、证据与旧 Plan 进展更新保留；旧 Plan 更新随文件移至 archive 后仍未提交。待提交内容单独检查，不把原有产品改动夹入本次文档提交 |

下一次获准实施时，从 [P0](#p0)刷新工具入口、任务身份与 qualification 输入，再进入 P1。不要从归档 Plan 的历史批次续跑，也不要只把 SRT spawn 替换成 Docker CLI。

[↑ 返回阅读导航](#contents)
