---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 生产资格、兼容性与核心升级设计 Spec

## 目标

定义 Himawari Agent 何时可以被标记为 v0.2 生产版，以及 Mac、Hermes、浏览器、无障碍、长期规模、可感知性能、正常重启、存储压力和连续运行所需的可复验证据；同时定义由 Owner 或运维人员主动发起、可观察且具有明确回退边界的核心程序升级流程。

## 来源上下文

- 产品目标：[SOURCE: docs/prd-v0.2.md#产品目标]
- 产品范围与明确排除：[SOURCE: docs/prd-v0.2.md#产品范围]
- 核心升级：[SOURCE: docs/prd-v0.2.md#核心升级与适配器演进]
- 浏览器兼容性：[SOURCE: docs/prd-v0.2.md#浏览器兼容性]
- 长期规模：[SOURCE: docs/prd-v0.2.md#长期规模]
- 可感知性能：[SOURCE: docs/prd-v0.2.md#可感知性能]
- 长期运行：[SOURCE: docs/prd-v0.2.md#长期运行]
- 生产上线验收：[SOURCE: docs/prd-v0.2.md#生产上线]
- 可恢复版本与更新：[SOURCE: docs/adr/0009-protected-agent-trust-root.md]
- 跨主机可移植性：[SOURCE: docs/adr/0012-portable-local-first-deployment.md]
- 权威迁移：[SOURCE: docs/adr/0019-offline-authority-transfer.md]
- 持久基础设计：[SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- 控制中心体验：[SOURCE: docs/execution/specs/2026-08-26-control-center-experience-design.md]
- 授权与能力治理：[SOURCE: docs/execution/specs/2026-08-26-authorization-capability-governance-design.md]
- v0.2 Spec 总纲：[SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]
- WCAG 2.2 规范：[EXTERNAL: https://www.w3.org/TR/WCAG22/]

## 范围

### 本 Spec 包含

- v0.2 全能力完成、跨 Spec 集成和无未关闭阻塞项的版本资格门禁。
- Mac 与 Hermes 分别执行的相同生产 conformance 与长期运行验收。
- 发布时正式浏览器矩阵最新两个稳定大版本的发现、冻结和证据。
- 桌面/移动关键流程的 WCAG 2.2 AA 自动检查和人工辅助技术验证。
- 5 年设计规模、20 万消息、1 万 Thread、50 万 Run、100 启用任务和 50 GitHub 仓库的数据/负载验证。
- 2 秒命令/GitHub 接纳、10 分钟 GitHub 分析投递、重启后 2 分钟 Web/消息和 5 分钟任务恢复目标。
- 连续 7 天 soak、模型故障、外部服务故障、正常重启、覆盖缺口、预算和存储压力路径。
- 手动核心升级的 preflight、恢复点、drain、install/migrate、validate、activate 和明确 rollback boundary。
- 不可变 release artifact、evidence manifest、签署、失败阻塞和生产标识。

### 本 Spec 不包含

- 百分比可用性 SLA、RPO/RTO、异地灾难恢复或权威主机与存储完全损毁后的恢复保证。
- 零停机升级、自动核心更新、自动跨主机故障切换、双活或多主写入。
- 以“预览”“部分可用”“仅 Mac 通过”或关闭失败测试来标记 v0.2 生产版。
- 把应用版本回退自动扩张为数据库恢复、外部副作用补偿、凭据回滚或权威迁移回切。
- 对未来 IM、本地模型、原生客户端或新 provider 的隐式批准；这些需要新的产品范围和验收。

## 验收标准

### 版本资格

- v0.2 PRD 中所有“本版本包含”能力、安全规则、数据保护、兼容性目标和关键验收路径必须由一个 active Spec 负责，并有已确认的 Spec、完成的 Plan、实现 revision 和通过证据。
- 所有跨切片不变量和完整用户旅程必须通过；任一必需 adapter、平台或浏览器被标记 unsupported、waived 或 untested 都阻止 v0.2 生产签署。
- Mac 与 Hermes 使用同一产品版本、schema、行为 contract 和 conformance，分别产生独立报告；一个平台的通过不能替代另一个。
- release candidate 必须由不可变 source revision、lockfile、构建输入、artifact digest、migration set、配置 schema 和测试/evidence digest 唯一确定。

### 浏览器与无障碍

- 发布候选冻结时查询并记录 Safari、Chrome、Edge、Firefox、iOS Safari 和 Android Chrome 当时最新两个稳定大版本；不得在长期文档中硬编码会过期版本。
- 每个正式版本覆盖 Owner 初始化后登录、Thread 对话/恢复、审批、任务、收件箱、Memory、能力/授权、Trace、设置、健康、删除和迁移/升级状态关键流程。
- 键盘、可见焦点、屏幕阅读器名称/状态/错误、对比度、缩放/重排、触摸目标、非颜色提示和 reduced motion 必须以 WCAG 2.2 AA 为目标，记录自动检查与人工检查证据。
- 三种 UI locale 和 Thread 回答语言独立性在桌面/移动矩阵中至少覆盖代表性组合；文本扩展和日文输入不能破坏关键操作。

### 规模、性能与恢复

- 生产等价 schema 在至少 20 万 Message、1 万 Thread、50 万 Run、100 active Task 和 50 Repository 的数据集中，核心对话、搜索、审批、任务、Memory、Trace、删除和迁移仍可完成并保持身份/引用一致。
- Web 命令与有效在线 GitHub event 在 2 秒内持久接纳或明确拒绝，并返回稳定 ID；测量以权威入口收到请求至 commit/拒绝响应为准。
- 满足主机在线、预算可用、模型/外部服务可用前提时，普通 GitHub event 从持久接纳至分析结果和 attention delivery 的目标为 10 分钟内完成。
- 正常重启从进程/主机可用开始，2 分钟内 Web 查询和新消息可接纳，5 分钟内任务恢复执行或显示明确 blocked 原因。
- 性能报告必须给出样本量、数据形状、硬件/OS、浏览器、模型/provider 条件、p50/p95/p99、最大值和未满足项；不能只报告平均值。

### 连续运行

- Mac 和 Hermes 各完成一次连续 7×24 小时 soak；候选 revision、schema 和关键配置在窗口中固定，必要修复会使该平台窗口重新开始。
- soak 必须包含持续对话、计划任务、外部事件、模型主备故障、adapter/credential 失败、正常服务/主机重启、浏览器断线重连、预算/容量阻塞和受控存储压力。
- 所有已接受工作可追踪到终态或明确 blocked，不能出现静默丢失、重复副作用、双权威、secret 泄漏或不可解释数据差异。
- 产品展示自动重启、当前健康、停机记录、coverage gaps 和具体 blocked reason；不以该证据宣称 SLA。

### 核心升级

- 升级只能由 Owner/运维人员显式发起，展示 source/target version、artifact identity、schema changes、预计停止范围、资源需求、preflight 和回退边界，并作为关键行动逐次批准。
- 升级前必须验证单一权威、磁盘、秘密/配置引用、依赖兼容、migration path 和当前健康，并创建位于同一权威存储上的经过恢复演练的本地恢复点。
- drain 后停止接纳新写入/行动，明确结束或 checkpoint 已接受 Run；安装、migration 和验证过程全部持久记录。
- 目标版本只有在 schema、identity、读写、关键 smoke、任务恢复和 external ingress fence 验证通过后才能 active；失败不得留下部分激活版本。
- 应用回退、数据库恢复、外部配置回退和外部副作用补偿是不同操作。执行预先声明边界之外的恢复必须重新确认。

## 设计

### ReleaseQualification

~~~text
qualification_id、product_version、candidate revision/artifacts
Spec/Plan/implementation coverage manifest
Mac report、Hermes report、browser matrix、accessibility report
scale/performance report、7-day soak reports
security/secret/deletion/migration/upgrade evidence
open blockers、approved_by、signed_at、status
~~~

状态为 `draft → evidence_collecting → candidate_ready → owner_review → qualified | rejected | expired`。只有 `qualified` 可以写入生产版本标识。任何 evidence digest 变化、candidate revision 变化或 required check 失效都会返回 `evidence_collecting`。

### 覆盖与证据 Manifest

总纲 Spec 提供 PRD→Spec ownership；每个 Implementation Plan 提供 Spec acceptance→task/test evidence。release manifest 将两层合并为可机器检查的 requirement IDs，记录 source anchor、实现 revision、测试 artifact、平台和结果。没有 owner、没有证据或证据来自不同 candidate 的条目均为 blocker。

测试 artifact 包含命令、exit status、结构化结果、日志/截图引用、环境、开始结束时间和 digest。人工验收记录操作者、步骤、观察结果与缺陷；不能由“曾经通过”或另一个 commit 的结果替代。

### 浏览器矩阵冻结

在每个 RC 开始时，从各浏览器官方稳定发布渠道解析当前 stable majors，保存查询时间和来源。矩阵冻结到该 RC；RC 周期内新 major 不强制中途扩张，但下一个 RC 重新解析。设备/OS 选择必须覆盖官方支持且可重现的桌面与移动组合。

### 规模和负载模型

数据集包含长/短 Thread、归档/Trash、不同 Message/Run/Trace 大小、活跃/暂停/阻塞 Task、Memory 版本/墓碑、Repository mirror metadata 和跨对象引用。生成器保存 seed、schema version 和 digest；删除/迁移测试使用独立副本，不污染 soak 权威。

负载同时包含前台交互、搜索、审批、background scheduling、GitHub ingress 和 Trace 读取，验证前台保留容量。模型延迟与费用通过可控 stub 建立确定性基线，再用已批准真实模型做有限端到端确认并单独标注外部波动。

### UpgradeOperation

~~~text
proposed
  → preflight
  → recovery_point_verified
  → draining
  → installing
  → migrating
  → validating
  → active

任一步骤失败 → blocked_recovery_decision
                      ├─ retry same step
                      ├─ application rollback
                      └─ separately approved data/config recovery
~~~

Upgrade lock、authority epoch 和 ingress fence 共同阻止旧/新版本同时写入。每一步有 idempotency key、expected prior state、checkpoint 和 operator-visible result。migration 必须提供 forward compatibility contract 和明确的可逆/不可逆边界；不可逆 migration 在执行前单独显示。

### 生产标识与失败呈现

版本页面显示 `development`、`internal_trial`、`release_candidate`、`qualified_v0.2` 或 `blocked`，并链接 evidence。内部试用可以缺少能力，但不能使用 `qualified_v0.2` 标签。blocked 展示具体 requirement、平台、证据和最小下一步，不用笼统“部分可用”掩盖缺口。

## 错误处理

| 失败 | 必需行为 |
| --- | --- |
| PRD 条款无 active Spec/Plan/证据 | 阻止资格签署并列出缺口 |
| Mac 或 Hermes 单平台失败 | 整体 v0.2 未通过，不降级生产声明 |
| 浏览器版本或证据过期 | 重新冻结矩阵并重跑受影响组合 |
| WCAG 自动通过但人工关键流失败 | 以失败为准并修复；不能 waiver 为 AA |
| 性能目标不满足 | 保留真实测量，阻止签署或修改 PRD 后重新确认 |
| soak 中修改 candidate | 当前平台 7 天窗口失效并重新开始 |
| 已接受工作无终态/blocked reason | 视为数据可靠性 blocker |
| upgrade preflight 失败 | 不 drain、不安装，保持当前 active version |
| migration/validation 失败 | 保持 ingress fenced，进入人工 recovery decision |
| rollback 超出预授权边界 | 停止并请求新的关键行动批准 |
| 恢复点无法验证 | 不开始升级，不能以备份存在代替恢复证据 |

## 验证策略

- 运行机器可读 PRD→Spec→Plan→evidence completeness check，人工逐条复核产品包含项、排除项和验收。
- 在独立 Mac 与 Hermes production-like 环境执行同一 conformance、security、migration、deletion、calendar、browser 和 task suites。
- 每个 RC 从官方发布渠道解析浏览器 majors，执行矩阵化 Browser E2E、三语视觉/交互回归与人工辅助技术检查。
- 用固定 seed 数据集运行规模、混合负载、查询计划、存储增长、删除和迁移验证；保存 p50/p95/p99 与硬件条件。
- 使用可控 fault injection 覆盖模型/adapter/数据库/磁盘/网络失败、重启、kill points、预算和容量阻塞。
- 在两个平台各运行连续 7 天 soak，并自动检查孤儿 accepted work、重复 side effect、authority conflict、secret scan 和 coverage gap。
- 对升级每个状态边界执行 kill/restart、artifact tamper、schema mismatch、恢复点损坏、不可逆 migration 和 rollback-scope 负面测试。
- 最终运行全仓 `npm run check`、全部测试、构建、依赖/secret/security scan、`git diff --check` 和 strict document validation。

## 确认记录

- 确认人：Owner
- 确认日期：2026-08-26
- 确认范围：“完整能力才可标记 v0.2”、双平台、浏览器、WCAG、规模、连续 7 天运行硬门禁，以及手动升级与回退边界。
- 授权边界：允许从本 Spec 派生 Implementation Plan；本次确认不授权创建 Plan/Runbook、执行资格测试、升级、回退、部署或其他生产操作。
