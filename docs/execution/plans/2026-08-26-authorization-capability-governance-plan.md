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

- [x] 逐项读取现有 ActionIntent、PermissionPolicyRule、GrantRecord、CapabilityDescriptor、Handle 和相关 tests，记录 confirmed/partial/missing。
- [x] 将 S4-A01 行动分类风险、S4-A02 授权/Grant、S4-A03 能力生命周期、S4-A04 统一能力类型绑定本 Plan tasks/evidence。
- [x] 保存现有 permission-grants、capability-execution、failure-recovery 和 Trace 基线。
- [x] 明确兼容升级与需要新 contract version 的边界，不把已有类型名称当作 v0.2 已完成证据。

Foundation 盘点确认 `ActionIntent`、`PermissionService`、Grant、Capability Registry/Handle 和 SQLite stores 可作为 `execution.v1` 兼容层；v0.2 使用显式 `authorization.v2`、`capability.v2` 与 `capability-handle.v2`，避免把旧类型名称当作完整实现。基线的 permission-grants、capability-execution、failure-recovery 与 SQLite conformance 均保留并重跑。

### Task 2：冻结固定 ActionKind 与 ActionIntent

- [x] 为 READ、CREATE_OR_UPDATE、DELETE、COMMUNICATE、PURCHASE_OR_FUNDS、CREDENTIAL_OR_ACCESS、PRODUCTION_OR_RECOVERY、PUBLICATION、LEGAL_COMMITMENT、PHYSICAL_SAFETY、INSTALL_OR_EXECUTE_CODE 建立严格枚举和 fixtures。
- [x] 扩展不可变 ActionIntent，覆盖 operation、targets/resources、classification/disclosure、side effects、recipients、cost/frequency、credential/access、reversibility 和 idempotency。
- [x] 保存 model classification、deterministic policy facts 和 final risk；final risk 取最高值。
- [x] 未知 kind、缺字段、自由参数注入、跨 scope 和 canonical hash 不稳定必须不可执行。
- [x] 对现有 gateway/execution compatibility 做 versioned contract tests。

新增固定 11 类 `ActionKind`、四级风险、严格字段/未知参数校验、不可变快照与包含 v0.2 全部语义的 canonical fingerprint。`assessActionIntentCompleteness()` 在目标、资源、能力、频率、费用、披露或收件人不足时返回同步 clarification 字段，不签发可执行语义。

### Task 3：实现 deterministic risk 与 ALLOW/ASK/DENY

- [x] 先建立 ActionKind baseline、CRITICAL facts、risk raising 和模型不得降低的 table-driven suite。
- [x] 按 capability active/healthy、operation、resource/data/secret scope、deterministic deny、risk floor、Grant/预算顺序实现 policy。
- [x] 只有范围有界、只读、无新披露/收件人/敏感数据/凭据变化且费用在限额内的 READ 可长期自动允许。
- [x] 任何 store、clock、secret/handle、scope 或 policy error fail closed，并保留外部真实结果。
- [x] Trace 记录输入 facts、规则版本、模型建议、最终风险和结果，不记录 secret 原值。

`ActionPolicyService` 按 active/healthy、version/operation/data scope、deterministic DENY、risk floor、Grant、有限只读 policy ALLOW 顺序决策；异常统一 fail closed。Trace 端口只记录规则版本、fact code、模型建议风险、最终风险和决定，不接收 secret 原值。

### Task 4：实现自然语言授权与冻结 Approval

- [x] 为目标、范围、能力、频率、费用、披露和收件人中适用字段定义 completeness contract。
- [x] 缺必要字段时形成同步 clarification，不生成可执行 Handle。
- [x] Approval Request 保存 ActionIntent canonical hash、expiry、risk、snapshot 和 recent-auth 要求。
- [x] Owner 只可批准、拒绝或在允许时缩小范围；语义扩大创建新 Intent/Approval。
- [x] 重复响应、hash mismatch、expired/rejected 和无 UI ASK 不得变成 ALLOW。

`ApprovalService` 校验冻结 hash、revision、expiry、范围不扩张和 CRITICAL recent-auth；无 UI 继续保存 `queued_no_ui` ASK。recent-auth reference 随最终审批记录持久化，重复、过期、拒绝和 hash 不匹配均不能形成 ALLOW。

### Task 5：实现持久 Grant 与原子消耗

- [x] 实现一次性 intent-hash Grant 和有界长期 Grant schema。
- [x] 保存 capability/version、operations、resource identities/prefixes、classification/disclosure、side effects、recipients、费用、频率、次数、expiry、Approval 和 revision。
- [x] 使用 SQLite transaction/CAS 原子消耗次数和预算，与授权结果、Run/Trace/outbox 保持因果一致。
- [x] 缩小范围匹配、扩大重新 ASK、过期、撤销、并发消耗和重启全部可恢复。
- [x] 禁止 whole home、所有账户/收件人、未知未来 operation 等无界通配。

`GrantService` 生成一次性 intent-hash Grant 和只允许有界安全 READ 的长期 Grant，拒绝 whole-home、全账户、全收件人和未知 operation 通配。SQLite 在同一事务内以 revision CAS 消耗 Grant、写入稳定 `authorization_usage`，同一 usage identity 重试只记一次。

### Task 6：实现 Capability Manifest 与持久生命周期

- [x] 规范化 stable ID、type、source、artifact digest/signature、version、operations、permissions、data/network/file/secret scopes、isolation、cost、health 和 approval history。
- [x] 实现 discovered→review_required→installation_proposed→installation_approved→active→disabled/uninstalled/revoked。
- [x] 未审查/未批准能力不能进入 active、Pi tool list、Worker registry、Web execution control 或后台 Task。
- [x] active/disabled/revoked transition 与 dependent task/Handle invalidation 原子可观察。
- [x] 外部 manifest、Skill 指令或 MCP declaration 只作为不可信输入，不能自证来源或修改 trust root。

`CapabilityLifecycleService` 引入来源审查门和完整 manifest；未审查、未批准或不健康能力不能 active。SQLite 的 `invalidateCapabilityAuthority` 在同一事务内保存 disabled/revoked/uninstalled、撤销活动 Handle，并撤销引用该 capability 的持久任务。

### Task 7：实现短期 CapabilityExecutionHandle

- [x] Handle 绑定 Owner/Agent/Run、当前 authority fence、capability/version、operation、input/context/secret refs、classification、deadline 和 authorization。
- [x] Worker 每次调用前重新验证 active version、Grant、expiry、scope、budget 和 fence。
- [x] Handle 单次/有界使用，撤销、停用、版本切换、deadline 或 Worker 结束立即失效。
- [x] 结果 unknown 进入 reconcile；有副作用 operation 不盲目重试。
- [x] 对 stale/replayed/forged Handle、duplicate result 和 authority transfer 运行 contract/recovery tests。

`CapabilityHandleService` 签发绑定 Owner/Agent/Run、authority fence、version、operation、protected refs、classification、authorization、deadline、次数和费用的短期 Handle；内存与 SQLite store 都提供 revision/fence/幂等原子消耗。`ExecutionWorkerService` 对 v0.2 Handle 重新读取 active version 和 Grant，并在调用 adapter 前拒绝 stale fence、过期、撤销或越界请求；未知外部结果继续沿用既有 reconcile 语义。

### Task 8：建立统一 capability conformance

- [x] 为 Tool、Skill、MCP、本地 program、第三方 API 和 adapter 建立相同 manifest、authorization、secret、budget、revoke、health、Trace 和 result suite。
- [x] Skill/网页/外部资源指令不能修改 policy、Grant、manifest 或 trust root。
- [x] runtime 只通过 `DefaultResourceLoader` additional paths 加载已授权资源；不得复制 Pi discovery/resource protocol。
- [x] MCP 只暴露 manifest 映射且批准的 tools/resources/prompts，server identity/transport/scope 变化按 update 处理。
- [x] 本地 program 强制 argv/env/workdir/stdin/stdout/network/filesystem contract，未声明子进程/联网/path/secret fail closed。
- [x] API/adapter 只接收最小 Handle 与 protected refs，不接收产品 store 写权限。
- [x] 文件与命令类能力复用 Pi read/bash/edit/write/grep/find/ls ToolDefinition，并以受治理 Operations 通过同一 conformance。

Tool、Skill、MCP、program、remote API 与 adapter 现在共用 `CapabilityManifest`、source identity、artifact/signature、scope、cost、health、review 和 isolation contract。program 强制声明 argv/env/workdir/stdin/stdout/subprocess/network/filesystem；MCP 强制 identity/transport/mapped resources；API/adapter 只接收 protected references。Pi 文件/命令 Tool 继续复用现有 `createRead/Bash/Edit/Write/Grep/Find/LsToolDefinition`，Extension/Skill/prompt 继续只通过 `DefaultResourceLoader` additional paths 投影；没有复制 Pi discovery 或工具协议。实际 sandbox/MCP/program runtime adapter 由 Task 9 实现并通过非生产 fixture；当前实测 Mac 与 Hermes 均不满足本地进程能力的生产资格，因此没有安装或启用真实能力。

### Task 9：资格验证并实现隔离与 runtime adapters

- [x] 对 Mac/Hermes 候选 isolation、artifact verification、MCP transport 和 program runner 做官方/版本匹配研究与隔离 spike。
- [x] 记录精确依赖、许可证、维护、安全、Node/platform 支持、资源限制和逃逸边界，Owner 批准后再安装。
- [x] 用非生产 fixture 验证 filesystem/network/process/secret/resource ceilings 和 termination。
- [x] 任一平台无法满足 manifest contract 时阻止对应能力 active，不以 testing adapter 替代。
- [x] durable 选择需要时先创建/接受 ADR，再完成 production composition。

已接受 ADR 0021 固定平台资格门禁。Node 运行时精确锁定官方 `@modelcontextprotocol/client@2.0.0`；测试 server 同样使用官方 `@modelcontextprotocol/server@2.0.0`，二者均为 MIT、要求 Node `>=20`，项目 Node `>=22.19.0` 满足。Linux 后端要求非 setuid `bubblewrap >=0.11.2`、可用非特权 user namespace、`util-linux prlimit >=2.38`、不得 group/other writable 的受管 runtime root、沙箱内只读 root、精确 executable/filesystem binding、无网络和无本地 secret scope；低于一秒而无法由 `RLIMIT_CPU` 精确表达的 CPU ceiling 会直接拒绝，Worker 继续约束 wall/output/progress 并监督进程组终止。Mac `sandbox-exec` 非生产 spike 实测文件 allow/deny、网络 deny 和终止，但因其不是稳定公开产品边界且当前没有签名 App Sandbox/XPC helper，资格固定为 false。Hermes 只读实测为 Linux `5.15.0-185-generic x86_64`，缺少 `bwrap` 且 `prlimit 2.37.2` 低于门禁，因此也不能激活本地 program/stdio MCP；没有修改主机。远程 API/adapter 只允许精确 HTTPS 或明确 loopback qualification、同源路径、禁止 redirect、短期 Secret Handle、deadline 和响应字节上限；有副作用请求在断连、非成功响应、响应超限或结果持久化失败后只产生 `result_unknown`。实现与 fresh 证据位于 `packages/platform-node/src/capabilities/`、`scripts/qualify-macos-capability-spike.mjs` 和 `test/integration/qualification/evidence/s4-tasks9-10-capability-runtime-update.json`。

### Task 10：实现更新、回退与兼容门禁

- [x] 比较 source identity、major、integrity、operations、permission/data/network/file/secret scopes、isolation 和 compatibility。
- [x] 只有同可信来源、完整性有效、兼容且无任何扩张的更新可按 Owner policy 自动应用并可观察。
- [x] source/major/integrity 不明、新执行代码或 scope 扩张形成 HIGH/CRITICAL Approval；拒绝后旧 active version 保持。
- [x] 新 artifact 通过 conformance/readiness 后原子切换，保留可验证 rollback artifact。
- [x] 回退只恢复 capability version，不伪装回滚已产生副作用、数据库或外部配置。

`CapabilityLifecycleService` 保存结构化 update assessment；可执行 package/MCP/program 的 digest 变化机械归类为新执行代码并要求 CRITICAL Approval，scope 扩张、source/major/runtime/executable/signer/compatibility 变化不能自动通过。更新提议和等待批准期间，当前已资格版本继续保持执行权；拒绝只清除 candidate。激活前同时验证当前 rollback artifact 与 candidate artifact/runtime，SQLite 在同一 transaction 内切换版本并撤销旧 Handle。回退重新验证旧 artifact/runtime 后执行相同原子切换，并把 `externalEffectsRolledBack` 与 `productStateRolledBack` 固定为 false。Foundation `CapabilityRegistryService` 拒绝接收 `capability.v2`，不存在绕过资格门禁的旧入口。

### Task 11：接通控制中心和 read model

- [x] Approval UI 显示冻结 intent、hash、risk、scope、披露、费用、expiry、recent-auth 和真实结果。
- [x] Capability UI 显示来源、精确版本、完整性、权限、secret refs、isolation、health、依赖、更新 diff 和 rollback。
- [x] Grant UI 支持查看、撤销、expiry/usage/budget 和受影响 Task，不显示 secret 原值。
- [x] 所有 mutation 使用 idempotency/revision，multi-tab conflict 不静默覆盖。
- [x] 验证未批准能力没有隐藏执行 route。

Gateway v2 现在提供 Agent-scoped Approval、Capability 与 Grant 权威 list/detail snapshot 和严格治理命令；SQLite schema 0017 保存 `executing/completed` mutation receipt，并用不含 command body 的语义指纹、`expectedRevision` 和调用方持久化 `idempotencyKey` 保证重试与恢复。控制中心三类 surface 只从权威 readback 更新状态，409 强制刷新，离线不 mutation，storage event 协调多 tab，401 清除旧身份状态，高风险操作要求 recent-auth。Chromium 151 与 WebKit 26.5 已覆盖批准/拒绝、review/install、更新批准/拒绝、rollback/disable、Grant 冲突/撤销、离线与隐藏执行 route 负例；fixture 只向浏览器投影 protected secret reference。生产 Agent Service composition、真实身份提供方与真实 capability 资格不在此本地证据内，由 Task 12 和后续 S0/S9 生产资格收口。

### Task 12：完成安全、恢复与文档收口

- [ ] 注入 store outage、manifest tamper、signature failure、source/permission expansion、stale Handle、budget race、Worker crash 和 unknown result。
- [ ] 运行 Pi tool allowlist、Worker registry、program/MCP isolation、secret scan 和完整 Trace causality。
- [ ] 映射 S4-A01–S4-A04 到 fresh unit/contract/integration/security/browser/platform evidence。
- [ ] 与 S0 的 J04–J09、J11–J12 和共同授权不变量对接。
- [ ] 更新 Architecture/README 只描述已验证治理和 runtime 边界；完成后再归档。

## 验收映射

| Acceptance ID | Spec 验收组 | 主要任务 | 必需证据 | 当前状态 |
| --- | --- | --- | --- | --- |
| S4-A01 | 行动分类与风险 | Tasks 2–3、12 | table-driven、negative contracts、Trace | Tasks 2–3 本地完成；待 Task 12 收口 |
| S4-A02 | 授权结果与 Grant | Tasks 4–5、11–12 | hash/expiry/CAS/revoke/browser | Tasks 4–5、11 本地完成；待 Task 12 收口 |
| S4-A03 | 能力生命周期 | Tasks 6–7、9–12 | lifecycle/update/Handle/platform recovery | Tasks 6–11 本地完成；待 Task 12 收口 |
| S4-A04 | 统一能力类型 | Tasks 8–10、12 | Tool/Skill/MCP/program/API/adapter conformance | Tasks 8–10 本地完成；待 Task 12 收口 |

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
