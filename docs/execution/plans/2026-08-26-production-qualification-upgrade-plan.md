---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 生产资格、兼容性与核心升级 Implementation Plan

**来源 Spec：** [SOURCE: docs/execution/specs/2026-08-26-production-qualification-upgrade-design.md]

**协同 Source Specs：**

- [SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-owner-thread-conversation-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-control-center-experience-design.md]
- [SOURCE: docs/archive/specs/2026-08-26-authorization-capability-governance-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-web-research-browser-actions-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-host-files-code-workspaces-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-apple-calendar-integration-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-proactivity-workers-self-improvement-design.md]

**v0.2 集成 Plan：** [SOURCE: docs/execution/plans/2026-08-26-v0.2-spec-suite-integration-plan.md]

**全部领域 Plans：**

- [SOURCE: docs/execution/plans/2026-08-26-portable-durable-web-agent-plan.md]
- [SOURCE: docs/execution/plans/2026-08-26-owner-thread-conversation-plan.md]
- [SOURCE: docs/execution/plans/2026-08-26-control-center-experience-plan.md]
- [SOURCE: docs/archive/plans/2026-08-26-authorization-capability-governance-plan.md]
- [SOURCE: docs/execution/plans/2026-08-26-web-research-browser-actions-plan.md]
- [SOURCE: docs/execution/plans/2026-08-26-host-files-code-workspaces-plan.md]
- [SOURCE: docs/execution/plans/2026-08-26-apple-calendar-integration-plan.md]
- [SOURCE: docs/execution/plans/2026-08-26-proactivity-workers-self-improvement-plan.md]

**目标：** 建立可机器核验的 v0.2 release qualification 与手动核心升级实现，使同一不可变候选在 Mac、Hermes、六类浏览器、WCAG 2.2 AA、设计规模、性能、恢复和两次 7 天 soak 全部通过后，才可能由 Owner 签署 qualified_v0.2。

**架构：** qualification tooling 聚合 PRD→Spec→Plan→implementation→evidence，不重新定义领域行为。UpgradeOperation 使用 S1 的权威、SQLite、恢复点、drain、migration 和 fencing，在明确状态机中执行；release artifact、evidence manifest 和签署都绑定同一 candidate revision/digests。

本 Plan 可以先实现 evidence/qualification/upgrade harness，但正式 RC、真实平台、7 天 soak、升级、回退、生产标识和签署必须等待 S0–S6、S8 的必需范围全部完成并取得逐项授权；S7 仅在候选启用 Calendar 时成为必需。创建本 Plan 不授权生产或外部变更。

---

## 执行依赖与停止点

- 任一必需 PRD 条款无 active/closed Spec、Plan、实现或 fresh evidence，任一必需领域 Plan 未完成，或任一核心 journey 有失败，都阻止 candidate_ready。S7 未启用时记录为可选未配置；启用时其 Plan 和 J07 必须完整通过。
- Mac/Hermes 必须运行同一 product version/schema/contracts 并分别通过；不得 waiver、unsupported 或用单平台替代。
- 浏览器 major 在每个 RC 通过官方发布渠道 fresh 发现并冻结；不可在 Plan 中写死会过期版本。
- WCAG 自动检查不能替代人工与辅助技术；规模/性能平均值不能替代样本、p50/p95/p99/max 和失败项。
- 第一次真实 model/provider、browser lab、Cloudflare/GitHub/Calendar、Mac/Hermes service、7 天 soak、升级/恢复/回退或生产签署前，展示精确 candidate、目标、资源/费用、变更顺序和回退边界并取得授权。
- 任何升级 preflight 或 recovery point 验证失败时不 drain、不安装；migration/validation 失败保持 ingress fenced 并进入人工 recovery decision。

## 文件边界

### 新建

- scripts/qualification/
- scripts/qualification/check-coverage.mjs
- scripts/qualification/build-evidence-manifest.mjs
- scripts/qualification/discover-browser-matrix.mjs
- scripts/qualification/verify-candidate.mjs
- apps/admin-cli/src/qualification/
- apps/admin-cli/src/upgrade/
- packages/application/src/ports/qualification.ts
- packages/application/src/ports/upgrade.ts
- packages/application/src/services/release-qualification-service.ts
- packages/application/src/services/upgrade-operation-service.ts
- packages/persistence-sqlite/src/qualification/
- packages/persistence-sqlite/src/upgrade/
- test/fixtures/scale/
- test/integration/qualification/browser/
- test/integration/qualification/accessibility/
- test/integration/qualification/platform/
- test/integration/qualification/performance/
- test/integration/qualification/soak/
- test/integration/qualification/upgrade/

只有升级操作实现、恢复演练和静态契约完成后，才从 Runbook 模板创建 docs/runbooks/core-upgrade-runbook.md；本 Plan 不预先创建或 seal 不可执行 Runbook。

### 修改

- package.json、vitest.workspace.ts：增加 coverage、candidate、browser、accessibility、scale、platform、soak 和 upgrade checks。
- packages/domain/src/：Qualification/Upgrade stable IDs 与状态。
- packages/gateway-contracts/src/、packages/execution-contracts/src/：只读 qualification/upgrade status 与受控操作 contracts。
- packages/persistence-sqlite/：evidence metadata、qualification/upgrade state、lock/checkpoint、migration 与 recovery refs。
- apps/agent-service、apps/admin-cli、apps/control-center：状态、preflight、操作和 evidence UI。
- packaging/ 与 build artifact manifest：只在 S1 已建立正式可安装产物后扩展。
- README.md、docs/architecture-v0.1.md 与已验证 Runbooks：只在当前事实成立后更新。

### 测试

- scripts/qualification/ 对应 unit/fixture tests
- packages/application/test/
- packages/gateway-contracts/test/
- packages/persistence-sqlite/test/
- apps/admin-cli/test/
- apps/control-center/test/
- test/integration/qualification/
- S0 与全部领域 Plans 的完整测试入口。

## 实施任务

### Task 1：建立 S9 acceptance 与 release requirement catalog

- [ ] 将 S9-A01 版本资格、S9-A02 浏览器无障碍、S9-A03 规模性能恢复、S9-A04 连续运行、S9-A05 核心升级绑定 tasks/evidence。
- [ ] 消费 S0 的 PRD/S0–S9/acceptance/journey manifest，拒绝无 owner、无 Plan Task、无实现 revision 或无 evidence 的 requirement。
- [ ] 区分结构准备、fixture evidence、platform evidence、live external readback、manual evidence 和 production sign-off。
- [ ] 保存当前 foundation 与全部 active Plans 的 baseline；不得把 active Plan 文档当实现完成。

### Task 2：实现不可变 candidate 与 artifact provenance

- [ ] 定义 candidate 由 source revision、npm lock、Node/npm、build inputs、artifact digests、migration digests、config schema 和 test/evidence digests唯一确定。
- [ ] clean install/build 生成 machine-readable artifact manifest 和 checksums，不依赖源码 checkout/sibling pi-mono。
- [ ] 验证 direct dependencies exact、lockfile、Pi published version、schema/migrations 和 package boundaries。
- [ ] candidate 任一输入/digest 变化使旧 evidence 失效并返回 evidence_collecting。
- [ ] 对 tamper、mixed revision、missing artifact 和 non-reproducible build fail closed。

### Task 3：实现 ReleaseQualification 产品状态

- [ ] 定义 draft→evidence_collecting→candidate_ready→owner_review→qualified/rejected/expired。
- [ ] 保存 candidate、Spec/Plan/implementation coverage、Mac/Hermes、browser、accessibility、scale/performance、soak、安全/删除/迁移/升级证据和 blockers。
- [ ] evidence record 绑定 command/status/environment/time/artifact/log/screenshot digest；不同 candidate/platform 不可混合。
- [ ] 只有全部 required entries fresh 且无 blocker 才进入 owner_review；只有 Owner 签署后进入 qualified。
- [ ] production label 只接受 qualified manifest hash，任何后续变化撤回为 blocked/evidence_collecting。

### Task 4：实现 RC browser matrix fresh discovery

- [ ] 从 Safari、Chrome、Edge、Firefox、iOS Safari、Android Chrome 的官方稳定发布渠道解析当前 stable majors、查询时间和来源。
- [ ] 为每个 RC 冻结最新两个稳定大版本；新 major 只在下一 RC 重新发现。
- [ ] 保存 OS/device/browser 支持关系和实际可复现环境，不把 user-agent 字符串当完整证据。
- [ ] 官方来源不可解析或环境不可获得时阻止矩阵完成，不凭记忆填值。
- [ ] discovery 只读；使用 browser cloud/device lab 前另行授权费用与数据披露。

### Task 5：编排完整 browser、三语与 WCAG 验收

- [ ] 在冻结矩阵覆盖登录后 Thread/恢复、Approval、Task、Inbox、Memory、Capability/Grant、Trace、Settings、Health、delete、migration/upgrade 状态。
- [ ] 桌面/移动覆盖代表性 zh-CN/en/ja 与 Thread answer locale 独立组合。
- [ ] 聚合 keyboard、focus、screen reader、contrast、zoom/reflow、touch、non-color 和 reduced-motion 自动与人工证据。
- [ ] 自动通过但人工/辅助技术关键流失败时以失败为准。
- [ ] 记录实际 OS/device/browser、candidate、artifact、操作者、步骤、观察和缺陷。

### Task 6：建立可重复规模数据生成器

- [ ] 用固定 seed/schema/digest 生成至少 20 万 Message、1 万 Thread、50 万 Run、100 active Task 和 50 Repository。
- [ ] 数据形状覆盖长短 Thread、active/archive/Trash、不同 Payload/Trace、Task states、Memory versions/tombstones 和跨对象 refs。
- [ ] 生成数据不含生产私人信息或 secret，并可从 artifact 独立重建。
- [ ] 删除、迁移和 upgrade 使用独立副本，不污染 soak authority。
- [ ] 验证生成 row counts、references、classifications 和 expected query fixtures。

### Task 7：实现混合负载与性能证据

- [ ] 同时运行对话、search、Approval、Task scheduling、GitHub ingress、Memory、Trace、delete 和 transfer，保留前台容量。
- [ ] 测量 Web command/GitHub event 从入口到持久 commit/明确拒绝的 2 秒目标。
- [ ] 在主机/预算/model/external service 可用时测量 GitHub 分析到 Attention 10 分钟目标。
- [ ] 测量正常重启后 2 分钟查询/消息接纳和 5 分钟 Task 恢复/blocked。
- [ ] 报告样本、数据、硬件/OS/browser/model 条件、p50/p95/p99/max、资源和所有不满足项。

### Task 8：编排双平台 production conformance

- [ ] Mac 与 Hermes 使用同一 immutable artifact、schema、config contract 和 test manifest 独立安装。
- [ ] 分别执行功能、安全、migration、deletion、browser、Task、Memory、Web/file/code 和 authority transfer suites；候选启用 Calendar 时，两平台再执行完整 Calendar suite。
- [ ] 记录 actual sqlite version、adapter/model identities、host resources、service manager、secret refs status 和 health。
- [ ] 一个平台失败使整体 blocked；不得复制另一平台 evidence 或标为 not applicable。
- [ ] 将 host-specific credential/permission reconfiguration 与 product data migration 分开证明。

### Task 9：完成 fault、重启与存储压力矩阵

- [ ] 注入 model/adapter/database/disk/network、budget/capacity、credential revoke、SSE disconnect、process/host restart 和 coverage gap。
- [ ] 检查每个 accepted work 到终态或稳定 blocked reason，无 silent loss、duplicate side effect、double authority 或 unexplained data diff。
- [ ] 存储压力保持只读、transfer 和人工清理，拒绝自动删除 Owner 数据。
- [ ] normal restart 与 crash/recovery 分别报告，不以一次恢复覆盖全部 kill points。
- [ ] 运行 secret scan、orphan work、duplicate effect、authority conflict 和 deletion resurrection checks。

### Task 10：实现 7 天 soak harness

- [ ] 固定 candidate revision/schema/config，分别为 Mac 与 Hermes 创建独立 7×24 小时计划和 evidence stream。
- [ ] 持续覆盖对话、计划 Task、external events、primary/fallback failure、adapter/credential failure、正常 service/host restart、browser reconnect、budget/capacity 和受控存储压力。
- [ ] 自动记录 downtime、health、coverage gaps、blocked reasons、accepted-work reconciliation、resource growth 和 secret/security alerts。
- [ ] 中途修改 candidate 或 required config 使该平台窗口失效并从零开始。
- [ ] soak 不宣称 SLA；任一 silent loss/duplicate/double authority/secret leak 为 release blocker。

### Task 11：冻结 UpgradeOperation contracts 与状态

- [ ] 定义 proposed→preflight→recovery_point_verified→draining→installing→migrating→validating→active 或 blocked_recovery_decision。
- [ ] 每一步有 idempotency key、expected prior state、artifact/config/schema refs、checkpoint、operator result 和 authority/ingress fence。
- [ ] Proposal 显示 source/target version、digests、schema changes、downtime/resources、preflight 和 application/data/config/external/transfer 回退边界。
- [ ] 不可逆 migration 单独标记并在执行前逐次批准。
- [ ] old/new artifact、stale command 和 duplicate operation 不能同时写。

### Task 12：实现 upgrade preflight、恢复点与 drain

- [ ] 验证单一权威、disk、secret/config refs、dependency compatibility、migration path、current health 和 target artifact。
- [ ] 创建同一 authority store 的一致本地 recovery point，并实际恢复到隔离位置验证 authentication、schema、rows、Payload 和 outbox。
- [ ] preflight/recovery point 任一失败时保持当前 active，不 drain。
- [ ] drain 先撤销 readiness/admission，再停止 scheduling/publisher，结束或 checkpoint accepted Runs，最后关闭 stores。
- [ ] 为每个阶段注入失败并证明可重复恢复、无半 drain 或双写。

### Task 13：实现 install/migrate/validate/activate

- [ ] 在 inactive target location 验证 artifact digest、permissions、config、dependencies 和 startup compatibility。
- [ ] migration 使用 S1 immutable ledger 与 expand/backfill/verify/contract 边界，保存实际结果。
- [ ] 验证 schema、Owner/Agent identity、read/write smoke、Task recovery、external ingress fence、Web/Worker readiness。
- [ ] 全部通过后原子 activate target version；失败保持 fenced 并进入 blocked_recovery_decision。
- [ ] 不自动执行 database downgrade、external config rollback 或 side-effect compensation。

### Task 14：实现人工 recovery decision 与 rollback

- [ ] 支持 retry same step、预声明 application rollback 和另行批准 data/config recovery。
- [ ] 每个选择显示当前真实状态、可能丢失/保留内容、不可逆边界和所需授权。
- [ ] 回滚 artifact、recovery point 或 schema 不可验证时停止，不删除当前可恢复证据。
- [ ] 外部副作用补偿与 authority reverse transfer 始终形成独立 CRITICAL ActionIntent。
- [ ] 在 artifact tamper、schema mismatch、recovery corruption 和 kill points 下验证不部分激活。

### Task 15：接通资格/升级控制面与生产标识

- [ ] 版本页面只显示 development、internal_trial、release_candidate、qualified_v0.2 或 blocked。
- [ ] qualification UI 显示 requirement、平台、candidate、evidence、freshness、blocker 和最小下一步。
- [ ] upgrade UI 显示 preflight、recovery point、drain、migration、validation、rollback boundaries 和 recent re-auth。
- [ ] 内部试用可以缺能力但绝不显示 qualified_v0.2。
- [ ] Owner 签署绑定完整 manifest hash、candidate 和时间；无批量/自动签署。

### Task 16：创建已验证升级 Runbook 并完成 RC

- [ ] 只有 UpgradeOperation 实现、故障测试和真实 staging rehearsal 后，读取 document-governance Runbook 工作流并从模板创建升级 Runbook。
- [ ] 写入 static contract、fresh target preflight、effective risk、授权、evidence、stop、mutation 和 rollback boundaries，semantic reconciliation 后显式 seal/check。
- [ ] 执行完整必需 PRD→Spec→Plan→evidence、全部核心 journey、双平台、browser/WCAG、scale/performance、fault、7 天 soak 和 upgrade checks；候选启用 Calendar 时加入 S7/J07。
- [ ] 对真实外部服务、平台和生产目标做完成后 readback，区分命令成功与目标事实。
- [ ] 所有 required evidence fresh 且无 blocker 后进入 Owner review；未获签署前不写 production label。

### Task 17：对账当前事实与文档收口

- [ ] 更新 Architecture 只描述实际 release artifact、schema/process/adapters、qualification/upgrade 状态与已知限制。
- [ ] 更新 README 的 verified install/doctor/qualification/upgrade 入口，不写 secret、临时 URL 或本机配置。
- [ ] 对账所有 active/closed Specs/Plans、Backlog 和 Runbooks；不得用 waiver、Backlog 或 docs/TODO.md 推迟 v0.2 必需范围。S7 只可按 PRD 记录为可选未配置，不能在已启用后规避证据。
- [ ] 映射 S9-A01–S9-A05 与 S0 manifest，记录 verified/partial/unverified 和 blocker。
- [ ] 只有真实关闭后归档本 Plan 与来源 Spec；保留 release/evidence history 的治理位置与不可变引用。

## 验收映射

| Acceptance ID | Spec 验收组 | 主要任务 | 必需证据 | 当前状态 |
| --- | --- | --- | --- | --- |
| S9-A01 | 版本资格 | Tasks 1–3、8、15–17 | complete manifest、双平台、Owner signature | 待实施 |
| S9-A02 | 浏览器与无障碍 | Tasks 4–5、15–17 | fresh majors、Browser E2E、人工/辅助技术 | 待实施 |
| S9-A03 | 规模、性能与恢复 | Tasks 6–9、16–17 | fixed seed、p50/p95/p99/max、recovery | 待实施 |
| S9-A04 | 连续运行 | Tasks 9–10、16–17 | Mac/Hermes 各 7×24h、candidate 固定 | 待实施 |
| S9-A05 | 核心升级 | Tasks 11–16 | preflight/recovery/drain/migrate/activate/rollback matrix | 待实施 |

## 验证

- npm ci --ignore-scripts
- npm run check
- npm run test
- npm run check:pi-compat
- 由 Tasks 1–4 新增的 coverage/candidate/browser discovery checks
- 由 Tasks 5–10 新增的 browser/accessibility/platform/scale/performance/soak checks
- 由 Tasks 11–14 新增的 upgrade/recovery checks
- python3 /Users/triggerjames/.codex/skills/document-governance/scripts/validate_docs.py --strict .
- git diff --check

正式 RC 与升级执行必须从对应 Runbook 开始，先做 current static check、fresh target preflight 和 effective-risk authorization。历史测试、单平台通过、HTTP 200、备份文件存在或平均性能不能替代本 Plan 的完整证据。

## 收口清单

- [ ] S9-A01–S9-A05 全部绑定同一 immutable candidate 的 fresh evidence。
- [ ] S0–S6、S8 必需范围全部完成，全部核心 journey 和所有排除/安全不变量通过；候选启用 Calendar 时 S7/J07 也全部完成。
- [ ] Mac/Hermes、六类浏览器、三语、WCAG、规模/性能、恢复和两次 7 天 soak 无 blocker。
- [ ] UpgradeOperation、recovery decision 和独立 rollback boundaries 已故障注入与真实演练。
- [ ] Owner 已审阅完整 manifest 并显式签署；生产标识绑定同一 hash。
- [ ] Architecture、README、Runbook 与实际实现/平台状态一致。
- [ ] strict document validation、全仓检查与全部相关测试通过。
- [ ] 本 Plan 与来源 Spec 只在工作真正关闭后归档。
