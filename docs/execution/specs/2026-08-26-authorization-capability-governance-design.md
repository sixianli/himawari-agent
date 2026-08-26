---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 行动授权与能力治理设计 Spec

## 目标

定义所有模型提议、Tools、Skills、MCP、本地程序、第三方 API 和经过审查的 adapters 共用的行动分类、风险下限、`ALLOW / ASK / DENY`、Grant、能力生命周期、更新、撤销、隔离和可观察执行语义，保证任何模型、客户端或扩展都不能自行批准、扩大权限或绕过信任根。

## 来源上下文

- Owner 决策责任：[SOURCE: docs/prd-v0.2.md#目标用户]
- 行动风险与授权：[SOURCE: docs/prd-v0.2.md#行动风险与授权]
- 正式能力与边界：[SOURCE: docs/prd-v0.2.md#正式能力与授权边界]
- 主动 Worker 与自我改进：[SOURCE: docs/prd-v0.2.md#主动建议周期反思与内部-worker]
- 风险验收：[SOURCE: docs/prd-v0.2.md#风险与行动授权]
- 正式能力验收：[SOURCE: docs/prd-v0.2.md#正式能力]
- 当前授权与能力实现：[SOURCE: docs/architecture-v0.1.md#permission-approval-and-grants]
- 确定性授权：[SOURCE: docs/adr/0004-deterministic-authorization.md]
- 能力注册表：[SOURCE: docs/adr/0008-governed-capability-registry.md]
- 受保护信任根：[SOURCE: docs/adr/0009-protected-agent-trust-root.md]
- 完整 Trace：[SOURCE: docs/adr/0010-complete-session-trace.md]
- 受限 Worker：[SOURCE: docs/adr/0006-primary-agent-scoped-workers.md]
- v0.2 Spec 总纲：[SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]

## 范围

### 本 Spec 包含

- 固定 ActionKind、`LOW / MEDIUM / HIGH / CRITICAL` 和确定性风险下限。
- `ALLOW / ASK / DENY`、Approval Request、一次性/长期 Grant、过期、消耗、撤销和范围变化。
- 自然语言任务指令何时可以形成授权，以及不足信息如何补问。
- Capability Manifest、来源审查、版本/完整性、权限、预算、数据范围、秘密需求、隔离和健康。
- Tools、Skills、MCP、本地程序、第三方 API 与 adapter 的统一生命周期和执行 Handle。
- 同源兼容更新、权限扩张更新、停用、撤销、卸载和回退。
- 能力管理与审批 UI 所需的只读视图和语义字段。

### 本 Spec 不包含

- Web、文件、代码工作区、Calendar 或 GitHub 的具体业务操作设计。
- 任意插件市场、自动下载后执行、通用不可信代码平台或能力自行发现后自激活。
- 具体容器、虚拟机、sandbox 产品或包分发技术选择；实施前必须通过隔离和平台兼容验证。
- 模型 provider routing、秘密原值存储、生产部署或核心升级流程。
- 把第三方 manifest、MCP declaration 或模型输出当作可信授权事实。

## 验收标准

### 行动分类与风险

- 每个拟执行行动必须形成固定结构的 `ActionIntent`，至少包含 kind、operation、targets、resources、data classification、disclosure、side effects、recipients、cost、frequency、credential/access change、reversibility 和 idempotency。
- 模型只能在固定 ActionKind 和风险等级中提出语义分类与理由；未知 kind、缺字段或解析失败不能到达执行。
- 确定性规则可以提高风险并设置最低等级，模型永远不能把风险降低到下限以下。
- 不可逆删除、真实资金或购买、凭据/访问控制、生产部署或回滚、公开发布、法律签署和可能影响人身安全的物理行动最终风险必须为 `CRITICAL`，逐次 `ASK`。

### 授权结果与 Grant

- 最终结果只能是 `ALLOW`、`ASK` 或 `DENY`；模型、能力或 Worker 不能增加结果类型、修改 policy 或批准自己的行动。
- 一条自然语言指令只有在目标、范围、工具/能力、频率、费用/上限、数据披露和收件人中适用字段足够明确时，才可形成该任务授权；缺失的必要字段进入同步补问。
- 低风险只读长期 Grant 可以持续到撤销；有副作用、付费、敏感数据或高权限 Grant 必须有明确 expiry、预算和使用次数/频率边界。
- 缩小范围可以沿用仍有效 Grant；扩大目标、operation、工具、频率、费用、数据范围、权限、披露或收件人必须创建新的 ActionIntent 和 Approval Request。
- Approval 到期进入 `EXPIRED`；相同请求重试或进程重启不能把过期、拒绝或无 UI 的 `ASK` 变为允许。

### 能力生命周期

- 每项能力展示稳定 ID、类型、来源、签名/完整性、精确版本、operations、permission refs、数据/网络/文件范围、secret refs、隔离、费用、健康和批准历史。
- 未经来源审查、首次授权或所需批准的能力不能进入 active，也不能出现在 Pi authorized tool list 或 Worker registry。
- 同一可信来源、签名有效、兼容、没有 permission/operation/data/secret 扩张的更新可以按 Owner 已启用策略自动应用，但必须记录、验证并可回退。
- 来源、主要版本、完整性不可验证、权限/operation/data/secret 扩张或新增可执行代码的更新必须 `ASK`；拒绝后旧 active version 保持原状态。
- 停用或撤销立即使新执行和旧短期 Handle 失效，并暂停依赖该能力的任务；不得自动改用相似能力绕过。

### 统一能力类型

- Tool、Skill、MCP、本地程序、第三方 API 和 adapter 只改变装载/调用方式，不改变授权、数据分类、预算、撤销、健康与 Trace 语义。
- Skill 或外部内容中的指令属于不可信数据，不能修改系统 policy、Owner Grant、能力 manifest 或信任根。
- MCP server 只暴露经过产品 manifest 映射和批准的 tools/resources/prompts；远端 server 身份、transport 与权限变化按能力更新处理。
- 本地程序只能通过声明的 argv/env/workdir/stdin/stdout/network/filesystem contract 执行；未声明的子进程、联网、路径或 secret 请求 fail closed。

## 设计

### 固定行动类别

v0.2 使用以下 ActionKind；新增类别属于产品语义变化，必须修改 PRD/Spec 并重新确认：

| ActionKind | 含义 | 默认风险基线 |
| --- | --- | --- |
| `READ` | 读取已授权本地或远端数据，无新披露和副作用 | `LOW` |
| `CREATE_OR_UPDATE` | 创建或修改可恢复对象 | `MEDIUM` |
| `DELETE` | 删除或失活对象 | `HIGH`；不可逆为 `CRITICAL` |
| `COMMUNICATE` | 向外部收件人提交、发送、评论或发帖 | `HIGH` |
| `PURCHASE_OR_FUNDS` | 真实购买、付款、转账或资金承诺 | `CRITICAL` |
| `CREDENTIAL_OR_ACCESS` | 凭据、身份、权限、会话或访问控制变化 | `CRITICAL` |
| `PRODUCTION_OR_RECOVERY` | 生产部署、回滚、恢复、迁移激活或运行控制 | `CRITICAL` |
| `PUBLICATION` | 面向公众发布内容或状态 | `CRITICAL` |
| `LEGAL_COMMITMENT` | 签署或接受法律约束 | `CRITICAL` |
| `PHYSICAL_SAFETY` | 可能影响人身安全的现实动作 | `CRITICAL` |
| `INSTALL_OR_EXECUTE_CODE` | 安装依赖/能力、运行新命令或不可信代码 | `HIGH`，权限扩大时 `CRITICAL` |

一个 ActionIntent 可以有一个 primary kind 和多个 deterministic facts。最终风险取模型建议、类别基线、事实下限和当前 policy 中的最高值。

### ActionIntent 与冻结快照

ActionIntent 是不可变语义对象：

~~~text
intent_id、Owner/Agent/Thread/Run
action_kind、capability/version、operation
targets/resources、data/disclosure、recipients
side_effects、cost/frequency、credential/access change
reversibility、idempotency、requested_at、expires_at
model_classification + policy facts + final risk
~~~

Approval Request 保存 ActionIntent 的 canonical hash。Owner 的批准、拒绝或范围缩小响应必须引用同一 hash；目标或语义改变时旧响应无效。

### 确定性 Policy

Policy 执行顺序：能力 active/healthy → manifest 支持 operation → resource/data/secret 范围 → deterministic deny → risk floor → 已有 Grant 匹配与预算消耗 → `ALLOW` 或 `ASK`。任何 store、policy、clock、secret/handle 或 scope 验证错误都 fail closed。

只有同时满足能力已启用、目标获批、范围有界、只读、无新收件人、无敏感披露、无凭据/权限变化和费用在上限内的 `READ` 才能在长期 Grant 内自动执行。

### Grant

Grant 保存 capability/version constraint、operations、resource prefixes/identities、最大数据等级与披露、允许副作用、收件人、每次/累计费用、频率、次数、有效期、来源 Approval 和 revision。每次使用通过 compare-and-swap 原子消耗预算和次数。

一次性 Grant 精确绑定一个 ActionIntent hash。长期 Grant 不允许通配到整个 home、所有账户、所有收件人或未知未来 operation。撤销后，依赖它的 pending/running job 在下一个执行边界进入 `blocked_approval` 或安全取消。

### Capability Manifest 与生命周期

~~~text
discovered
  → review_required
  → installation_proposed
  → installation_approved
  → active
  → disabled
  → uninstalled

active → update_proposed → update_approved → active(new version)
active/disabled → revoked
~~~

Manifest 的来源和权限声明经过产品规范化；外部 manifest 不能自证可信。产品保存 artifact digest/signature result、reviewer、approval snapshot 和 rollback artifact reference。

运行时只签发短期 `CapabilityExecutionHandle`，绑定 Owner/Agent/Run、版本、operation、input refs、delegated context refs、secret refs、最大 classification、deadline 和 authorization reference。Worker 每次调用前重新验证 active version、Grant、expiry 和 fence。

### 更新与回退

更新比较 source identity、semantic major、artifact integrity、operations、permission/data/network/file/secret scopes、isolation 和 contract compatibility。只有全部不扩张且已通过 conformance 的更新才可自动应用；否则形成 CRITICAL 或 HIGH ActionIntent。

激活新版本先保留旧 artifact 与 manifest，运行 compatibility/readiness 验证后原子切换。失败回退只恢复能力版本，不自动回滚其已经产生的外部副作用或产品 schema。

### 能力管理视图

Read Model 为 UI 提供来源、精确版本、完整性、权限、数据范围、secret refs、隔离、健康、依赖任务、Grant、更新差异和回退可用性。任何 secret 只显示稳定引用和状态，不显示原值。

## 错误处理

| 失败 | 必需行为 |
| --- | --- |
| 模型分类缺失或未知 | `DENY` 或不可执行 `ASK`，不猜测类别 |
| Policy/Authorization Store 不可用 | fail closed，已有外部副作用保持可见 |
| Approval hash 不匹配 | 拒绝响应并展示新旧语义差异 |
| Grant 预算并发消耗 | CAS 收敛；超出预算的调用进入 `ASK`/blocked |
| 能力来源或完整性失效 | 停用并撤销 Handle，通知受影响任务 |
| 更新权限扩张 | 保持旧版本 active，创建新 Approval |
| Worker 使用过期 Handle | 拒绝执行并记录 stable error，不续签绕过 |
| 能力执行结果未知 | 进入 reconcile，不盲目重试副作用动作 |
| 回退 artifact 不可验证 | 阻止更新激活，不删除当前可用版本 |

## 验证策略

- 对所有 ActionKind、risk floor、deterministic facts 和 `ALLOW / ASK / DENY` 运行 table-driven tests。
- 验证自然语言授权的完整/缺失字段、范围缩小、范围扩大、expiry、revoke、预算与并发消耗。
- 对 Tool、Skill、MCP、本地程序、第三方 API 和 adapter 重跑统一 capability conformance suite。
- 注入 manifest 伪造、签名失败、artifact tamper、source/major/permission 扩张、旧 Handle 和 registry outage。
- 验证未批准能力不进入 Pi tool list、Worker registry、Web control 或后台任务执行。
- 运行 update/rollback tests，区分能力版本回退与外部副作用/数据库回滚。
- Browser E2E 覆盖 approval snapshot、recent re-auth、Grant 查看/撤销、capability review/update/disable/rollback 和 blocked task。
- 运行 secret scan、Trace causality、unit/contract/integration/security、`npm run check` 和 strict document validation。

## 确认记录

- 确认人：Owner
- 确认日期：2026-08-26
- 确认范围：固定 ActionKind、风险下限、`ALLOW / ASK / DENY`、Grant 和统一能力生命周期及其验收边界。
- 授权边界：允许从本 Spec 派生 Implementation Plan；本次确认不授权创建 Plan、启用或更新能力、修改产品实现或执行任何外部行动。
