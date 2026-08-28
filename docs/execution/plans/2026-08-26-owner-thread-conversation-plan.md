---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 Owner Thread 与对话 Implementation Plan

**来源 Spec：** [SOURCE: docs/execution/specs/2026-08-26-owner-thread-conversation-design.md]

**v0.2 Spec 套件：** [SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]

**协同 Source Specs：**

- [SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-control-center-experience-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-authorization-capability-governance-design.md]

**基础 Plan：** [SOURCE: docs/execution/plans/2026-08-26-portable-durable-web-agent-plan.md]

**目标：** 在 S1 的持久权威、SQLite、HTTP/SSE、Memory 和模型基础上，实现跨浏览器与正常重启稳定的 Thread/Message/Run 对话体验，包括生命周期、搜索、Fork、回答语言、可恢复摘要和删除前任务协调。

**架构：** Thread 继续是产品自有聚合，正文保存在受保护 Payload，Run、Approval、Task 和 Memory 通过稳定 ID 关联。gateway contracts 暴露兼容命令、查询和事件；application 实现幂等与 revision 控制；SQLite adapter 提供权威存储和可重建搜索投影；控制中心只呈现 committed read model。

本 Plan 只实施 S2 主责语义。SSE transport、SQLite 基础、Memory provider 和模型路由由 S1 负责；视觉系统、三语资源和 WCAG 由 S3 负责；后台任务与授权状态机由各自主责 Plan 负责。

---

## 执行依赖与停止点

- S1 必须先冻结稳定 product IDs、Payload、SQLite migration/outbox、gateway versioning、authority fence 和 persistent cursor contracts；本 Plan 不复制这些基础。
- Thread/Message 对 gateway.v1 的不兼容变化必须新增明确 schema version 和 fixture，不能改写已冻结 v1 语义。
- 搜索实现必须先证明加密/数据等级/删除边界；不能为方便全文检索把私人正文以明文落盘。
- 自动标题、摘要、跨 Thread 检索和回答语言模型调用遵守 S1 的精确模型、披露、费用和授权门禁。
- 发现 Thread 删除与 Task、Memory 或迁移 canonical semantics 冲突时停止，先协调对应 Spec；不得在本 Plan 私自决定。

## 文件边界

### 新建

- packages/domain/src/thread.ts
- packages/domain/src/message.ts
- packages/application/src/ports/threads.ts
- packages/application/src/services/thread-command-service.ts
- packages/application/src/services/thread-query-service.ts
- packages/application/src/services/thread-fork-service.ts
- packages/application/src/services/thread-checkpoint-service.ts
- packages/persistence-sqlite/src/thread/
- packages/testing/src/conformance/thread-suite.ts
- test/integration/thread-lifecycle.test.ts
- test/integration/thread-checkpoint-recovery.test.ts
- test/integration/thread-search-projection.test.ts
- test/integration/performance/thread-query.test.ts

具体文件可按实施时已存在的模块拆分；不得为了匹配本清单复制已有职责。

### 修改

- packages/domain/src/identifiers.ts、entities.ts 与 index.ts：增加稳定 Thread/Message/Turn 与 lineage 类型，不暴露 provider row ID。
- packages/gateway-contracts/src/：增加 Thread mutation/query/event 与兼容 fixtures。
- packages/application/src/ports/、services/ 与 index.ts：接通 admission、context、summary、task/deletion 协调。
- packages/persistence-sqlite/：增加规范化 Thread/Message/checkpoint/search projection 与 immutable migration。
- packages/testing/：增加 reference adapter、conformance、fault 和规模 fixture。
- apps/agent-service/src/：接通权威命令、查询和 SSE read model。
- apps/control-center/src/：在 S3 组件/本地化边界内接通 Thread 列表、对话和设置。
- README.md 与 docs/architecture-v0.1.md：只在对应行为实现并验证后更新。

### 测试

- packages/domain/test/
- packages/gateway-contracts/test/
- packages/application/test/
- packages/persistence-sqlite/test/
- packages/testing/test/
- apps/agent-service/test/
- apps/control-center/test/
- test/integration/
- test/e2e/browser/
- test/integration/performance/

## 实施任务

### Task 1：记录基线与建立 S2 acceptance 映射

- [x] 记录 Git、workspace、S1 contracts/migrations、Architecture limitations 和现有测试基线。
- [x] 将 S2-A01 稳定身份、S2-A02 生命周期查找、S2-A03 Fork、S2-A04 回答语言上下文、S2-A05 压缩审批任务分别绑定本 Plan tasks 和 evidence。
- [x] 标出 S1/S3/Task/Memory 依赖的输入输出，不把尚未实现的 supporting behavior 计为 S2 完成。
- [x] 运行现有 check、tests 和 strict document validation，保存 fresh baseline。

Task 1 的本次基线与 Tasks 2–9 实施证据记录在 `test/integration/qualification/evidence/s2-tasks1-9-owner-thread.json`；控制中心、任务删除协调、完整浏览器和规模资格仍属于 Tasks 10–12，不计入本轮完成。

### Task 2：扩展 Thread、Message、Turn 产品模型

- [x] 先为 Thread status、title source/revision、pin order、answer locale、fork lineage、watermark 和 revision 编写 domain tests。
- [x] 保留 Foundation 的 ThreadId/RunId 身份，增加 Message/Turn 等稳定 ID；不得使用 SQLite row、Pi Session 或浏览器 ID 代替。
- [x] 实现 active、archived、trashed、deletion_pending、deleted_verified 合法 transition 和 expected revision。
- [x] 让正文、summary 和模型输出只保存 protected refs；任务、审批、Grant 和 Memory 只保存稳定关联。
- [x] 对非法 locale、跨 Owner/Agent 引用、已删来源和 stale revision fail closed。

### Task 3：冻结 Thread gateway contracts 与 read model

- [x] 为 create、rename、pin、archive、restore、fork、set_answer_locale、trash 和 delete_permanently 定义严格命令 schema。
- [x] 为列表、详情、搜索、筛选、关联 Task、lineage、checkpoint 和 answer locale 定义 scope-safe 查询。
- [x] 命令携带 idempotency key 与 expected revision；事件携带稳定 ID、revision、cursor 和因果链。
- [x] 增加 unknown field/version、重复命令、跨 scope、cursor expiry 和 revision conflict fixtures。
- [x] 若 v1 无法兼容，新增明确版本并保留旧 fixture。

Thread 新契约使用独立 `gateway.thread.v3`，没有改写既有 `gateway.v1`/`gateway.v2`；跨 scope、cursor 和旧版本行为继续复用既有 Gateway contract suites，Thread v3 增加严格字段与 revision fixtures。

### Task 4：实现 SQLite Thread/Message 权威存储

- [x] 在 S1 migration 机制内增加 Thread、Message、Turn、lineage、checkpoint 和 search projection schema。
- [x] 把 Thread mutation、idempotent result 和 outbox event 放进同一 fenced transaction。
- [x] 正文与摘要只引用受保护 Payload；search projection 遵守 classification、scope、Trash 和永久删除过滤。
- [x] 实现 projection rebuild、水位和版本；projection 丢失不能损坏权威历史或扩大披露。
- [x] 运行 fresh create、upgrade、duplicate、concurrent revision、kill/restart 和 deletion propagation tests。

### Task 5：实现消息接纳与最终 assistant commit

- [x] 让带幂等键的用户消息只创建一个 Message、Trigger 和 Run。
- [x] 模型流式片段属于 Run，只有产品 commit 后的最终 assistant message 才进入 Thread 历史。
- [x] 失败或取消保留真实片段引用、终态和 Trace，不伪造完整回答。
- [x] Pi Session 重建、compaction 或 Run 终止不得改变 Thread/Message/Turn/Run identity。
- [x] 在接纳、Run 创建、stream、最终提交各边界注入重复和进程终止。

### Task 6：实现生命周期、标题、置顶与查询

- [x] 实现新 Thread 默认 active、未置顶和 zh-CN answer locale。
- [x] 自动标题使用稳定派生任务和 revision guard；Owner 手动命名后拒绝迟到结果。
- [x] 实现重命名、稳定置顶排序、归档/恢复和 multi-client revision conflict。
- [x] 实现按标题/授权正文、时间、归档和任务状态搜索筛选；Trash/删除/不可解密内容不返回。
- [x] 搜索 UI 查询不自动进入模型 context；被模型采用的跨 Thread 引用进入 Trace。

### Task 7：实现 Fork 快照与 lineage 删除边界

- [x] Fork transaction 只接受已提交来源 Turn，冻结来源 Thread/Turn/watermark、summary refs 和当时 policy refs。
- [x] 新 Thread 不复制任务、审批、Grant、长期 Memory 或未提交输入。
- [x] 原 Thread 后续变化不得改写 Fork snapshot；长期 Memory 由新 Thread 普通检索获得。
- [x] 来源永久删除后保留非正文 lineage marker，并使来源正文不可解析。
- [x] 覆盖来源未提交、已删、并发变化、重复 Fork 和 kill/restart。

### Task 8：实现回答语言与最小 Context Formation

- [x] 支持 zh-CN、en、ja 显式 Thread setting，并持久到多设备和重启。
- [x] 自然语言修改解析为显式设置意图并在回复前提交；输入语言检测和 UI locale 不修改字段。
- [x] 将 answer locale 作为 policy ref 注入 context；回答/摘要遵守该语言，代码、日志、引用和专名保持原文。
- [x] Context Formation 只选择当前必要历史、相关摘要/片段、Owner Profile、Memory 和有效 policy refs。
- [x] 记录候选、采用、排除、披露和 source refs；用中英日组合验证三个语言来源独立。

### Task 9：实现可恢复 checkpoint 与摘要

- [x] 使用 ThreadId、source watermark 和 policy version 形成稳定 generation identity。
- [x] 支持 explicit、controlled idle、pre-compaction 和 source-size threshold 四类触发。
- [x] 原子提交 covered range、retained start、source refs、model/policy version、classification、Trace 和 protected summary ref。
- [x] pre-compaction 直接提交 Pi 已保护的同一 summary ref，派生模型只提取候选；禁止第二次摘要生成。其他 trigger 仍走显式 summary model。
- [x] 迟到结果只在 watermark 仍匹配时成为 current summary；失败保留 transcript 和旧 summary。
- [x] 原始消息不因压缩删除；context 使用 summary 后仍可按相关性回取更早片段。
- [x] 对每个 generation checkpoint 运行 kill/restart 和 exactly-once tests。

### Task 10：协调审批、Task、归档与删除

- [x] Thread archive 不修改已批准 Task、Approval 或 Grant。
- [x] Approval 只按自身 expiry 失效；过期后必须形成新 ActionIntent，不复用旧批准。
- [x] trash/delete 前查询 stable active task refs，并要求 cancel、pause 或 rebind 独立命令全部收敛。
- [x] 未解决关联时保持 deletion_pending，不删除 Thread；跨 Thread/Memory 引用在永久删除后失去正文解析。
- [x] 验证恢复、重复命令、部分失败和 authority fence 失效。

`ThreadDeletionCoordinationService` 现在通过同一 SQLite 权威 writer 提供删除影响查询、独立 task pause/cancel/rebind 和 Trash/永久删除请求。每个 mutation 都绑定 Owner/Agent、revision、authority fence、幂等 receipt 与结果引用；active task 未收敛时删除原子拒绝，永久删除还要求逐次 authorization 与 recent-auth。离线物理删除不再替 Owner 自动暂停 task，已暂停、取消或重新绑定的 task 保留自身状态，删除来源 Thread 时只移除失效绑定。归档、恢复和审批过期测试证明 Task、Approval、Grant 只由各自生命周期命令改变。实现与证据位于 `test/integration/thread-deletion-coordination.test.ts` 和 `test/integration/qualification/evidence/s2-task10-thread-deletion-coordination.json`。

### Task 11：接通控制中心与多客户端恢复

- [ ] 在 S3 组件契约中实现 Thread 列表、详情、搜索、筛选、pin、archive/restore、Fork、answer locale 和删除协调。
- [ ] 客户端使用 committed snapshot+events、durable cursor、revision 和 mutation idempotency key。
- [ ] 浏览器关闭、断线、多标签和正常主机重启后恢复同一 Thread、Run、Approval、Task 和 cursor。
- [ ] 冲突展示最新 revision 和可理解重新应用，不做 silent last-write-wins。
- [ ] 不在浏览器持久存储私人历史、搜索正文或权威状态。

### Task 12：完成规模、恢复和文档收口

- [ ] 在 1 万 Thread、20 万 Message 和混合 active/archived/trashed 数据上测量列表、搜索、筛选、pin、Fork 和恢复。
- [ ] 运行两个浏览器、多设备、Pi Session 重建、summary 与 projection rebuild 的 recovery matrix。
- [ ] 映射 S2-A01–S2-A05 到 fresh unit/contract/integration/browser/performance evidence。
- [ ] 更新 Architecture/README 只描述已验证 Thread 当前事实和限制。
- [ ] 与 S0 的 J01–J03、J13 对接，领域或集成缺口全部关闭后再归档。

## 验收映射

| Acceptance ID | Spec 验收组 | 主要任务 | 必需证据 | 当前状态 |
| --- | --- | --- | --- | --- |
| S2-A01 | 稳定身份与继续对话 | Tasks 2–5、11 | domain/contract、重复接纳、process recovery | 部分验证（Tasks 2–5；控制中心 Task 11 未实施） |
| S2-A02 | 生命周期与查找 | Tasks 4、6、10–12 | query/search、multi-client、规模 | 部分验证（Tasks 4、6、10；控制中心、浏览器与规模未实施） |
| S2-A03 | Fork 与来源 | Tasks 4、7、12 | lineage、delete、restart | 部分验证（Tasks 4、7；完整恢复矩阵与规模未实施） |
| S2-A04 | 回答语言与上下文 | Tasks 8、11 | 中英日组合、context/Trace、browser | 部分验证（Task 8；控制中心与浏览器未实施） |
| S2-A05 | 压缩、审批与任务 | Tasks 9–12 | checkpoint crash matrix、task/delete coordination | 部分验证（Tasks 9–10；控制中心与规模未实施） |

## 验证

- npm run check
- npm run test:unit
- npm run test:contracts
- npm run test:integration
- npm run test:e2e
- npm run check:pi-compat
- 本 Plan 新增的 Thread browser、recovery、search 和 performance 入口
- python3 /Users/triggerjames/.codex/skills/document-governance/scripts/validate_docs.py --strict .
- git diff --check

真实模型或跨主机验证必须遵守 S1 的身份、费用、披露和平台授权；确定性 provider 与内存 adapter 通过不能替代 SQLite、真实进程和浏览器恢复证据。

## 收口清单

- [ ] S2-A01–S2-A05 均有 fresh 实现、测试、平台和未验证项记录。
- [ ] Thread/Message/Run identity 在多浏览器、正常重启、压缩和 Fork 后保持稳定。
- [ ] 搜索、summary 和跨 Thread context 不扩大私人正文披露，删除后不复活。
- [ ] Task、Approval、Grant 与 Thread 生命周期保持独立且删除前协调完整。
- [ ] Architecture、README 和 S0 journey evidence 已对账。
- [ ] strict document validation、全仓检查与相关测试通过。
- [ ] 本 Plan 与来源 Spec 只在工作真正关闭后归档。
