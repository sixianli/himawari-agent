---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 行动授权与能力治理 Implementation Plan

**来源 Spec：** [SOURCE: docs/execution/specs/2026-08-26-authorization-capability-governance-design.md]

**v0.2 Spec 套件：** [SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]

**协同 Source Specs：**

- [SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-control-center-experience-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-web-research-browser-actions-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-host-files-code-workspaces-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-apple-calendar-integration-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-proactivity-workers-self-improvement-design.md]

**基础 Plan：** [SOURCE: docs/execution/plans/2026-08-26-portable-durable-web-agent-plan.md]

**目标：** 把 Foundation 的 Permission/Grant 与 Capability 边界升级为 v0.2 完整治理：固定 ActionKind 与风险下限、持久 Approval/Grant、统一 Capability Manifest/Handle、严格更新与回退，以及 Tool、Skill、MCP、本地程序、第三方 API 和 adapter 的同一 conformance。

**架构：** application 维护产品自有 ActionIntent、deterministic policy、Approval、Grant 和 capability lifecycle；SQLite 负责 fenced 原子状态、预算/次数 CAS 和审计；Execution Worker 只消费短期 Handle；各 capability adapter 只声明领域 facts，不能改变授权结果。控制中心通过 read model 展示冻结语义和 Owner 操作。

---

## 执行依赖与停止点

- S1 必须先提供 SQLite authority/outbox、Payload/secret refs、Worker transport、Trace、identity/session 和 recent re-auth 基础。
- 本 Plan 先审计并保留现有 ActionIntent、PermissionService、Grant 与 CapabilityRegistry 可复用语义；不得为“重新实现”删除已验证 Foundation 行为。
- 隔离、签名、artifact、MCP、program 或 API runtime 的具体第三方技术在 Spec 中未决定。引入前必须完成 version-matched qualification；若会形成 durable architecture choice，先治理 ADR。
- 任何真实 capability 安装、启用、更新、外部服务连接、凭据或权限变化需要独立 Owner 授权；本 Plan 文档不授权。
- Policy/store/clock/secret/fence 不确定时一律 fail closed；不得用模型建议或 fallback adapter 绕过。

## 文件边界

### 新建

- packages/application/src/services/action-policy-service.ts
- packages/application/src/services/approval-service.ts
- packages/application/src/services/grant-service.ts
- packages/application/src/services/capability-lifecycle-service.ts
- packages/application/src/services/capability-handle-service.ts
- packages/persistence-sqlite/src/authorization/
- packages/persistence-sqlite/src/capabilities/
- packages/platform-node/src/capabilities/
- packages/testing/src/conformance/authorization-suite.ts
- packages/testing/src/conformance/capability-suite.ts
- test/integration/authorization-policy.test.ts
- test/integration/capability-lifecycle.test.ts
- test/integration/capability-execution-recovery.test.ts
- test/integration/security/capability-isolation.test.ts

具体文件按实施时已有模块合并，避免与现有 permission-service.ts、capability-registry-service.ts 重复职责。

### 修改

- packages/application/src/ports/authorization.ts、capabilities.ts、services/permission-service.ts、capability-registry-service.ts 与 exports。
- packages/gateway-contracts/src/：Approval、Grant、Capability read/mutation contracts 和 fixtures。
- packages/execution-contracts/src/：CapabilityExecutionHandle、execute/reconcile 与 stable failure fixtures。
- packages/persistence-sqlite/：migrations、stores、outbox、audit 和 recovery。
- packages/platform-node/：artifact verification、program/MCP/API execution adapters 与 isolation boundary。
- packages/runtime-pi/：只把已授权短期 tool list/handles 和显式 Extension/Skill/prompt paths 投影给 Pi；关闭 ambient discovery，并复用 Pi built-in tool definitions 加产品 Operations。
- packages/testing/、apps/agent-service、apps/execution-worker、apps/control-center：conformance、composition 和 Owner UI。
- scripts/check-boundaries.mjs、package manifests 与 lockfile：仅在获批依赖/包存在后更新。
- Architecture/README：行为实证后再对账。

### 测试

- packages/application/test/
- packages/gateway-contracts/test/
- packages/execution-contracts/test/
- packages/persistence-sqlite/test/
- packages/platform-node/test/
- packages/runtime-pi/test/
- packages/testing/test/
- apps/agent-service/test/
- apps/execution-worker/test/
- apps/control-center/test/
- test/integration/
- test/integration/security/

## 实施任务

### Task 1：盘点 Foundation 差距与建立 S4 acceptance 映射

- [ ] 逐项读取现有 ActionIntent、PermissionPolicyRule、GrantRecord、CapabilityDescriptor、Handle 和相关 tests，记录 confirmed/partial/missing。
- [ ] 将 S4-A01 行动分类风险、S4-A02 授权/Grant、S4-A03 能力生命周期、S4-A04 统一能力类型绑定本 Plan tasks/evidence。
- [ ] 保存现有 permission-grants、capability-execution、failure-recovery 和 Trace 基线。
- [ ] 明确兼容升级与需要新 contract version 的边界，不把已有类型名称当作 v0.2 已完成证据。

### Task 2：冻结固定 ActionKind 与 ActionIntent

- [ ] 为 READ、CREATE_OR_UPDATE、DELETE、COMMUNICATE、PURCHASE_OR_FUNDS、CREDENTIAL_OR_ACCESS、PRODUCTION_OR_RECOVERY、PUBLICATION、LEGAL_COMMITMENT、PHYSICAL_SAFETY、INSTALL_OR_EXECUTE_CODE 建立严格枚举和 fixtures。
- [ ] 扩展不可变 ActionIntent，覆盖 operation、targets/resources、classification/disclosure、side effects、recipients、cost/frequency、credential/access、reversibility 和 idempotency。
- [ ] 保存 model classification、deterministic policy facts 和 final risk；final risk 取最高值。
- [ ] 未知 kind、缺字段、自由参数注入、跨 scope 和 canonical hash 不稳定必须不可执行。
- [ ] 对现有 gateway/execution compatibility 做 versioned contract tests。

### Task 3：实现 deterministic risk 与 ALLOW/ASK/DENY

- [ ] 先建立 ActionKind baseline、CRITICAL facts、risk raising 和模型不得降低的 table-driven suite。
- [ ] 按 capability active/healthy、operation、resource/data/secret scope、deterministic deny、risk floor、Grant/预算顺序实现 policy。
- [ ] 只有范围有界、只读、无新披露/收件人/敏感数据/凭据变化且费用在限额内的 READ 可长期自动允许。
- [ ] 任何 store、clock、secret/handle、scope 或 policy error fail closed，并保留外部真实结果。
- [ ] Trace 记录输入 facts、规则版本、模型建议、最终风险和结果，不记录 secret 原值。

### Task 4：实现自然语言授权与冻结 Approval

- [ ] 为目标、范围、能力、频率、费用、披露和收件人中适用字段定义 completeness contract。
- [ ] 缺必要字段时形成同步 clarification，不生成可执行 Handle。
- [ ] Approval Request 保存 ActionIntent canonical hash、expiry、risk、snapshot 和 recent-auth 要求。
- [ ] Owner 只可批准、拒绝或在允许时缩小范围；语义扩大创建新 Intent/Approval。
- [ ] 重复响应、hash mismatch、expired/rejected 和无 UI ASK 不得变成 ALLOW。

### Task 5：实现持久 Grant 与原子消耗

- [ ] 实现一次性 intent-hash Grant 和有界长期 Grant schema。
- [ ] 保存 capability/version、operations、resource identities/prefixes、classification/disclosure、side effects、recipients、费用、频率、次数、expiry、Approval 和 revision。
- [ ] 使用 SQLite transaction/CAS 原子消耗次数和预算，与授权结果、Run/Trace/outbox 保持因果一致。
- [ ] 缩小范围匹配、扩大重新 ASK、过期、撤销、并发消耗和重启全部可恢复。
- [ ] 禁止 whole home、所有账户/收件人、未知未来 operation 等无界通配。

### Task 6：实现 Capability Manifest 与持久生命周期

- [ ] 规范化 stable ID、type、source、artifact digest/signature、version、operations、permissions、data/network/file/secret scopes、isolation、cost、health 和 approval history。
- [ ] 实现 discovered→review_required→installation_proposed→installation_approved→active→disabled/uninstalled/revoked。
- [ ] 未审查/未批准能力不能进入 active、Pi tool list、Worker registry、Web execution control 或后台 Task。
- [ ] active/disabled/revoked transition 与 dependent task/Handle invalidation 原子可观察。
- [ ] 外部 manifest、Skill 指令或 MCP declaration 只作为不可信输入，不能自证来源或修改 trust root。

### Task 7：实现短期 CapabilityExecutionHandle

- [ ] Handle 绑定 Owner/Agent/Run、当前 authority fence、capability/version、operation、input/context/secret refs、classification、deadline 和 authorization。
- [ ] Worker 每次调用前重新验证 active version、Grant、expiry、scope、budget 和 fence。
- [ ] Handle 单次/有界使用，撤销、停用、版本切换、deadline 或 Worker 结束立即失效。
- [ ] 结果 unknown 进入 reconcile；有副作用 operation 不盲目重试。
- [ ] 对 stale/replayed/forged Handle、duplicate result 和 authority transfer 运行 contract/recovery tests。

### Task 8：建立统一 capability conformance

- [ ] 为 Tool、Skill、MCP、本地 program、第三方 API 和 adapter 建立相同 manifest、authorization、secret、budget、revoke、health、Trace 和 result suite。
- [ ] Skill/网页/外部资源指令不能修改 policy、Grant、manifest 或 trust root。
- [ ] runtime 只通过 `DefaultResourceLoader` additional paths 加载已授权资源；不得复制 Pi discovery/resource protocol。
- [ ] MCP 只暴露 manifest 映射且批准的 tools/resources/prompts，server identity/transport/scope 变化按 update 处理。
- [ ] 本地 program 强制 argv/env/workdir/stdin/stdout/network/filesystem contract，未声明子进程/联网/path/secret fail closed。
- [ ] API/adapter 只接收最小 Handle 与 protected refs，不接收产品 store 写权限。
- [ ] 文件与命令类能力复用 Pi read/bash/edit/write/grep/find/ls ToolDefinition，并以受治理 Operations 通过同一 conformance。

### Task 9：资格验证并实现隔离与 runtime adapters

- [ ] 对 Mac/Hermes 候选 isolation、artifact verification、MCP transport 和 program runner 做官方/版本匹配研究与隔离 spike。
- [ ] 记录精确依赖、许可证、维护、安全、Node/platform 支持、资源限制和逃逸边界，Owner 批准后再安装。
- [ ] 用非生产 fixture 验证 filesystem/network/process/secret/resource ceilings 和 termination。
- [ ] 任一平台无法满足 manifest contract 时阻止对应能力 active，不以 testing adapter 替代。
- [ ] durable 选择需要时先创建/接受 ADR，再完成 production composition。

### Task 10：实现更新、回退与兼容门禁

- [ ] 比较 source identity、major、integrity、operations、permission/data/network/file/secret scopes、isolation 和 compatibility。
- [ ] 只有同可信来源、完整性有效、兼容且无任何扩张的更新可按 Owner policy 自动应用并可观察。
- [ ] source/major/integrity 不明、新执行代码或 scope 扩张形成 HIGH/CRITICAL Approval；拒绝后旧 active version 保持。
- [ ] 新 artifact 通过 conformance/readiness 后原子切换，保留可验证 rollback artifact。
- [ ] 回退只恢复 capability version，不伪装回滚已产生副作用、数据库或外部配置。

### Task 11：接通控制中心和 read model

- [ ] Approval UI 显示冻结 intent、hash、risk、scope、披露、费用、expiry、recent-auth 和真实结果。
- [ ] Capability UI 显示来源、精确版本、完整性、权限、secret refs、isolation、health、依赖、更新 diff 和 rollback。
- [ ] Grant UI 支持查看、撤销、expiry/usage/budget 和受影响 Task，不显示 secret 原值。
- [ ] 所有 mutation 使用 idempotency/revision，multi-tab conflict 不静默覆盖。
- [ ] 验证未批准能力没有隐藏执行 route。

### Task 12：完成安全、恢复与文档收口

- [ ] 注入 store outage、manifest tamper、signature failure、source/permission expansion、stale Handle、budget race、Worker crash 和 unknown result。
- [ ] 运行 Pi tool allowlist、Worker registry、program/MCP isolation、secret scan 和完整 Trace causality。
- [ ] 映射 S4-A01–S4-A04 到 fresh unit/contract/integration/security/browser/platform evidence。
- [ ] 与 S0 的 J04–J09、J11–J12 和共同授权不变量对接。
- [ ] 更新 Architecture/README 只描述已验证治理和 runtime 边界；完成后再归档。

## 验收映射

| Acceptance ID | Spec 验收组 | 主要任务 | 必需证据 | 当前状态 |
| --- | --- | --- | --- | --- |
| S4-A01 | 行动分类与风险 | Tasks 2–3、12 | table-driven、negative contracts、Trace | 待实施 |
| S4-A02 | 授权结果与 Grant | Tasks 4–5、11–12 | hash/expiry/CAS/revoke/browser | 待实施 |
| S4-A03 | 能力生命周期 | Tasks 6–7、9–12 | lifecycle/update/Handle/platform recovery | 待实施 |
| S4-A04 | 统一能力类型 | Tasks 8–10、12 | Tool/Skill/MCP/program/API/adapter conformance | 待实施 |

## 验证

- npm run check
- npm run test:unit
- npm run test:contracts
- npm run test:integration
- npm run test:e2e
- npm run check:pi-compat
- 本 Plan 新增的 authorization、capability、isolation、security 和 browser 入口
- python3 /Users/triggerjames/.codex/skills/document-governance/scripts/validate_docs.py --strict .
- git diff --check

真实能力安装、MCP/API 连接、凭据、付费调用或外部副作用必须另行授权；fixture conformance 不能替代生产 adapter、Mac/Hermes isolation 和外部 readback。

## 收口清单

- [ ] S4-A01–S4-A04 全部有 fresh 证据。
- [ ] 所有 capability 类型共用同一授权、Grant、Handle、secret、预算、撤销和 Trace 语义。
- [ ] 模型、Worker、外部内容和 capability 均不能自批或扩大权限。
- [ ] 更新/回退与外部副作用/数据库恢复边界明确且实测。
- [ ] S0 journeys、Architecture、README 和相关领域 Plans 已对账。
- [ ] strict document validation、全仓检查与相关测试通过。
- [ ] 本 Plan 与来源 Spec 只在工作真正关闭后归档。
