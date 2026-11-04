---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 主动建议、Worker 与自我改进 Implementation Plan

**来源 Spec：** [SOURCE: docs/execution/specs/2026-08-26-proactivity-workers-self-improvement-design.md]

**v0.2 Spec 套件：** [SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]

**协同 Source Specs：**

- [SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- [SOURCE: docs/archive/specs/2026-08-26-authorization-capability-governance-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-host-files-code-workspaces-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-control-center-experience-design.md]

**依赖 Plans：**

- [SOURCE: docs/execution/plans/2026-08-26-portable-durable-web-agent-plan.md]
- [SOURCE: docs/archive/plans/2026-08-26-authorization-capability-governance-plan.md]
- [SOURCE: docs/execution/plans/2026-08-26-host-files-code-workspaces-plan.md]
- [SOURCE: docs/execution/plans/2026-08-26-control-center-experience-plan.md]

**目标：** 实现有证据、可去重、受每日额度和预算约束的主动建议与周期反思，最小权限临时 Worker 委派，以及隔离、可销毁且永不自激活的自我改进候选流程。

**架构：** application 定义 SuggestionCandidate、Reflection checkpoint、Delegation/WorkerRun 和 ImprovementCandidate；SQLite 提供 identity、quota CAS、dedupe、checkpoint、artifact metadata 和恢复；Execution Worker 使用 S4 短期 Handles；S6 提供候选 workspace 和受控命令；主 Agent 统一验证、提交 Result 和面向 Owner 交付。

---

## 执行依赖与停止点

- S1 必须提供持久 Task/Scheduler/Memory/Model/Trace/Attention/Result、Worker transport、预算和 authority fence；S4 提供最小 capability Handles；S6 提供隔离工作区/命令边界。
- 建议、反思、Worker 或候选成功永远不授权创建 Task、外部副作用、commit、push、deploy、restart、安装、启用或 trust-root 变化。
- 第一次真实模型/embedding/eval、真实 Owner data snapshot 或外部 capability 使用前，遵守精确 identity、披露、费用和 capped budget 授权。
- 候选隔离无法证明、需要生产 secret/写端点、Worker 请求扩大 scope 或候选触及 protected root 时停止并提高审查，不得降级运行。
- 本 Plan 不创建独立 Agent/Thread/长期 Worker Memory 或递归自治系统。

## 文件边界

### 新建

- packages/application/src/ports/proactivity.ts
- packages/application/src/ports/delegation.ts
- packages/application/src/ports/improvement.ts
- packages/application/src/services/suggestion-service.ts
- packages/application/src/services/reflection-service.ts
- packages/application/src/services/delegation-service.ts
- packages/application/src/services/worker-result-service.ts
- packages/application/src/services/improvement-candidate-service.ts
- packages/persistence-sqlite/src/proactivity/
- packages/persistence-sqlite/src/delegation/
- packages/persistence-sqlite/src/improvement/
- packages/platform-node/src/candidate-workspace/
- packages/testing/src/conformance/worker-delegation-suite.ts
- test/fixtures/proactivity/
- test/fixtures/improvement/
- test/integration/proactive-suggestions.test.ts
- test/integration/worker-delegation-recovery.test.ts
- test/integration/security/improvement-isolation.test.ts
- test/e2e/browser/proactivity/

### 修改

- packages/domain/src/identifiers.ts：Suggestion/Reflection/Delegation/WorkerRun/Improvement stable IDs。
- packages/application/src/ports/intelligence.ts、coordination.ts、capabilities.ts 与 scheduler/context/attention services。
- packages/gateway-contracts/src/、packages/execution-contracts/src/：suggestion/task transition、delegation/worker 和 candidate contracts。
- packages/persistence-sqlite/：migrations、quota/dedupe/checkpoint、artifacts、delete/retention hooks。
- packages/runtime-pi/：只投影主 Agent 已选 context、model 和 tools，不形成 Worker authority。
- packages/platform-node/、packages/testing、apps/agent-service、apps/execution-worker、apps/control-center：isolation、composition、fixtures 和 UI。
- Architecture/README：实测后更新。

### 测试

- packages/application/test/
- packages/gateway-contracts/test/
- packages/execution-contracts/test/
- packages/persistence-sqlite/test/
- packages/platform-node/test/
- packages/runtime-pi/test/
- packages/testing/test/
- apps/execution-worker/test/
- apps/control-center/test/
- test/integration/
- test/integration/security/
- test/e2e/browser/

## 实施任务

### Task 1：建立 S8 acceptance 映射与基线

- [x] 将 S8-A01 主动建议反思、S8-A02 Worker、S8-A03 自我改进候选绑定 tasks/evidence。
- [x] 盘点 S1 Task/Memory/Model/Scheduler/Attention/Result 与 S4/S6 Handle/workspace contracts。
- [x] 建立不自执行、不扩大权限、不直接投递、不持久 Worker Memory 和 protected-root threat matrix。
- [x] 保存现有 scheduler、context、capability、attention、recovery 和 E2E baseline。

### Task 2：冻结主动性、委派与候选产品模型

- [x] 定义 SuggestionCandidate、ReflectionCheckpoint、Delegation、WorkerRun、WorkerResult 和 ImprovementCandidate stable schemas/states。
- [x] Suggestion 保存 protected title/body、最小 evidence、watermark、goal/commitment、task draft、confidence/novelty/dedupe、capability/data/cost 和 Trace。
- [x] Delegation 冻结 parent Run、subtask/output schema、context refs、Handles、model/data/cost/time budgets。
- [x] Improvement 保存 base revision/digest、diff、reason/risk、validation/eval、comparison、protected-root facts 和 artifact。
- [x] 未知字段、cross Owner/Agent、stale fence、duplicate identity 和非法 transition fail closed。

### Task 3：实现语义去重与每日额度

- [x] semantic key 由 kind、目标实体、拟议 action 和 evidence fingerprint 形成；模型相似度只提供候选。
- [x] 产品状态检查 active/rejected/superseded 与实质新证据，防止同义/同承诺重复打扰。
- [x] 默认按 Owner IANA timezone 的 civil day 原子限制 3 条接纳建议，并支持 Owner 有界配置。
- [x] 多 Run 使用 CAS，不超过额度；去重/拒绝候选不占额，紧急 external event 不伪装 suggestion。
- [x] 额度满只保存聚合计数，不保存未接纳敏感正文。

### Task 4：实现周期反思与 checkpoint

- [x] 使用单一全局 Task definition，保存 schedule、IANA timezone、input watermark、context/cost/time/candidate limits。
- [x] 输入只选择长期目标、未解决承诺、近期 Thread/Memory 变化、Task Result 和未关闭建议的最小摘要。
- [x] 输出先 schema validation、secret exclusion、evidence validation、semantic dedupe，再提交候选或 no_change。
- [x] no_change checkpoint 持久且幂等，不为填满额度造建议。
- [x] host 离线错过直接 skip/MISSED，不补跑；模型/Memory failure 有界重试并可观察。

### Task 5：实现建议投递、过期与转 Task

- [x] 新建议只通过统一 Result/Inbox，默认 INBOX，遵守 Attention 安全下限。
- [x] 支持 delivered、approved、rejected、expired、superseded，重复 response 幂等。
- [x] 拒绝后只有新证据或 Owner 改变范围才可重开。
- [x] Owner 批准后创建普通 Task，重新冻结目标、trigger、capabilities、Grant、budget、timezone、timeout 和 revoke。
- [x] suggestion 不向 Task 传递隐式 Handle、Approval 或执行权。

### Task 6：实现最小 Worker Delegation

- [x] 主 Agent 先产生 immutable subtask 与 output schema，policy 对 context/model/disclosure/Handles 求 parent 与 Owner Grant 交集。
- [x] Worker 只接收明确 message/Memory/file refs 和短期 Handles，不能访问全部 Thread/Memory/home。
- [x] Worker runtime 无 Grant store 写、capability enable、Owner delivery、独立 Thread/Agent 或长期 Memory API。
- [x] scope/model/cost/recipient 扩大返回 proposal，由主 Agent 走普通 Approval。
- [x] 支持 deadline、budget、cancel、Handle revoke 和禁止无界递归委派。

### Task 7：实现 Worker 结果验证与恢复

- [x] WorkerResult 包含结论、citations/artifacts、未决、实际 model/usage/cost 和 execution records。
- [x] 结果先回主 Agent，验证来源、output schema、冲突、classification 和 external facts 后再合并/交付。
- [x] 冲突或引用失败保持可见，不静默选择。
- [x] Worker 结束/失败/取消后 Handles 撤销，长期事实只走正常 Memory candidate。
- [x] 在 create/execute/result commit/main merge 各边界 kill/restart，证明 identity/Trace 可恢复且不重复副作用。

### Task 8：qualification 候选 workspace 隔离

- [ ] 对 Mac/Hermes 的 candidate workspace、filesystem/network/process/secret/resource 隔离做 version-matched qualification。（本地 provider 与 fail-closed probe 已实现；真实 runtime 缺失，双平台尚未通过。）
- [x] 候选从已验证 base 创建到可销毁位置，不连接 active runtime 写端点或生产凭据。
- [x] 输入数据使用脱敏 fixture 或独立授权只读 snapshot，并继承原删除/保留。
- [x] 运行逃逸、生产 endpoint、secret、base tamper、resource exhaustion 和 cleanup negative tests。
- [x] 隔离不合格时阻止自我改进能力 active，不以普通 worktree 等同安全 sandbox。

### Task 9：实现 propose→patch→validate→compare

- [x] propose 保存可观察问题、目标、不变量、base 和允许 scope。
- [x] patch 只写 candidate workspace，生成完整 diff/artifact，不修改 active checkout。
- [x] validate 只运行冻结 CommandProfiles、static/security/boundary/tests/evals，保存命令、结果和失败项。
- [x] compare 对 base/candidate 使用相同 inputs，保存质量、性能、资源和回归差异。
- [x] artifact 有 expiry/space budget；清理遵守 Owner 数据保留且不自动永久删除未授权内容。

### Task 10：实现 protected-root 与不可自激活门禁

- [x] 身份、授权、secret、audit、model disclosure、upgrade trust root 或 capability scope 变化确定性标记 protected-root。
- [x] 产生候选的 Agent/Worker 不能批准候选、修改 risk/policy 或改变 review_required。
- [x] 所有成功候选仍禁止 commit、push、merge、deploy、restart、install 和 active version switch。
- [x] 尝试自激活、访问 production secret/endpoint 或伪造验证结果形成 security failure 和提高 Attention。
- [x] Owner 决定只可拒绝、要求修改或发起独立实施/升级流程。

### Task 11：接通控制中心

- [x] 建议 UI 显示来源、evidence、目标、范围、费用、dedupe、expiry、状态和批准后新 Task。
- [x] 反思设置显示 schedule/timezone、quota、预算、水位和 no_change/failure。
- [x] Worker Trace 显示 delegation、context/Handles、model/cost、结果和主 Agent 验证。
- [x] candidate review 显示 base、完整 diff、commands/results、eval comparison、风险和 protected-root。
- [x] 不提供直接 apply/commit/deploy 开关；任何后续动作进入独立治理流程。

### Task 12：完成安全、恢复、S0 与文档收口

- [ ] 固定历史集验证 evidence/no_change/dedupe/rejection suppression/new evidence/quota。
- [ ] 覆盖 schedule/DST/offline/budget/model blocked、Worker scope attacks、crash/cancel 和 candidate isolation attacks。
- [ ] 运行 secret scan、Trace causality、eval reproducibility、browser E2E 和 Mac/Hermes conformance。
- [ ] 映射 S8-A01–S8-A03，与 S0 J08/J09、S9 qualification、Architecture/README 对账。
- [ ] 所有硬门禁通过后才归档。

Tasks 1–7、9–11 已有本地产品实现，2026-09-03 审查进一步修复了原有顺序测试未覆盖的并发、归属和恢复问题。2026-08-29 的 `test/integration/qualification/evidence/s8-tasks1-12-autonomy-local-implementation.json` 保留为历史证据，不能将它解释为后来新增回归或真实平台资格。

本轮修复及证据边界：

- Suggestion 的决定在 CAS 内完成；批准保存固定 Task intent，Task 创建回执丢失后使用同一逻辑键恢复。反思冻结 context、模型输出与原 Run/Trace，claim 只允许当前执行者完成，过期 claim 与终态不能被旧执行者改写。
- Delegation 持久保存 progress receipt、选定模型和 output schema；迟到结果不能覆盖终态，取消端离线时仍先撤销 Handles，再重试未完成清理。
- `read(scope, id)` 将 Owner/Agent 约束落实到持久实体边界。Worker 的子任务准入、实际工具消费、调用 ID 去重、取消、期限和关闭分别有回归；底层运行时在异步准入前登记取消，避免取消丢失后继续 dispatch。
- 候选相对变更路径与绝对 mount 分开，manifest/patch/archive 位于 source mount 外；发布前复核内容和模式。`expired` 与清理完成分别保存，dispose 包括打包中断残留的受管临时资源。安全响应先保存待隔离意图，再按隔离、通知阶段恢复；通知使用固定幂等键，失败后不重复已完成隔离。旧持久记录缺失恢复字段时在存储边界显式正规化。
- 定向测试位于 application 的 autonomy/candidate tests、Worker production tests 和 platform 的 candidate/runtime tests。任务与模型端口仍要求下游实现持久幂等；本轮本地测试不证明真实模型供应商恢复、双平台隔离或完整 Browser E2E。Control Center 原有三语 surfaces 和无自激活边界保持现有产品合同。

Task 8/12 尚无真实双平台 sandbox qualification 的通过证据。已记录的资格结果中，Mac 缺少通过签名与 live probe 的 Apple container 1.2.0，Hermes 缺少 bubblewrap 0.11.2 且 `prlimit 2.37.2` 低于门禁；本轮未重新探测这些主机状态，也未同步当前 revision 到 Hermes。S8-A03 因此继续保持 inactive，本 Plan 不归档。

## 验收映射

| Acceptance ID | Spec 验收组 | 主要任务 | 必需证据 | 当前状态 |
| --- | --- | --- | --- | --- |
| S8-A01 | 主动建议与反思 | Tasks 2–5、11–12 | history set、quota CAS、DST/offline、browser | 本地实现与恢复/browser 证据通过；最终 S0/S9 对账待 Task 12 |
| S8-A02 | 内部 Worker | Tasks 2、6–7、11–12 | context/Handle canary、crash recovery、Trace | 本地最小授权、持久 progress/cancel/recovery 与 Handle 撤销通过；双平台待 Task 12 |
| S8-A03 | 自我改进候选 | Tasks 2、8–12 | isolation、diff/eval reproducibility、no activation | 候选、protected-root、validation/compare/artifact/no-activation 本地通过；S6 双平台 sandbox qualification 阻塞 active |

## 验证

- npm run check
- npm run test:unit
- npm run test:contracts
- npm run test:integration
- npm run test:e2e
- npm run check:pi-compat
- 本 Plan 新增的 proactivity、Worker、isolation、eval、security 和 browser 入口
- python3 /Users/triggerjames/.codex/skills/document-governance/scripts/validate_docs.py --strict .
- git diff --check

真实模型、Owner 私人数据、外部 capability 或 candidate execution 必须使用独立授权和有界预算；fixture/eval 成功不能授权应用候选。

## 收口清单

- [ ] S8-A01–S8-A03 全部有 fresh evidence。
- [ ] 建议有证据、可去重、受额度约束，批准后才创建重新授权的普通 Task。
- [ ] Worker 只获得最小上下文/能力，结果经主 Agent 验证，结束后无长期权限。
- [ ] 候选隔离、可复现且永久 review_required，任何路径均不能自 commit/push/deploy/activate。
- [ ] S0/S9 evidence、Architecture 和 README 已对账。
- [ ] strict document validation、全仓检查与相关测试通过。
- [ ] 本 Plan 与来源 Spec 只在工作真正关闭后归档。
