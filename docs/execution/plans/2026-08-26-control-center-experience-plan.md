---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 Web 控制中心、三语与无障碍 Implementation Plan

**来源 Spec：** [SOURCE: docs/execution/specs/2026-08-26-control-center-experience-design.md]

**v0.2 Spec 套件：** [SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]

**协同 Source Specs：**

- [SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-owner-thread-conversation-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-authorization-capability-governance-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-web-research-browser-actions-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-host-files-code-workspaces-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-apple-calendar-integration-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-proactivity-workers-self-improvement-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-production-qualification-upgrade-design.md]

**关键依赖 Plans：**

- [SOURCE: docs/execution/plans/2026-08-26-portable-durable-web-agent-plan.md]
- [SOURCE: docs/execution/plans/2026-08-26-owner-thread-conversation-plan.md]
- [SOURCE: docs/execution/plans/2026-08-26-authorization-capability-governance-plan.md]

**目标：** 实现完整、响应式、三语且达到 WCAG 2.2 AA 验收边界的 Web 控制中心，使 Owner 在桌面和手机浏览器中管理对话、审批、任务、结果、Memory、能力、Grant、Trace、设置、设备和健康。

**架构：** apps/control-center 只消费 Gateway 的权威 snapshot 与 durable event stream；本地持久状态限于 UI locale、布局偏好、未发送草稿和最后 cursor。稳定 message keys、共享语义组件和统一 mutation state machine 支撑 zh-CN/en/ja、桌面/移动和辅助技术；业务状态机仍由 S1/S2/S4–S8 拥有。

---

## 执行依赖与停止点

- S1 先提供受认证 Gateway、session/device、HTTP/SSE、read model、cursor 和 public-origin 安全基础。
- 每个页面只有在主责 Spec 的 read/mutation contract 冻结后接通；占位 UI、fixture-only route 或 mock 数据不能计为对应能力完成。
- 新增前端、构建、i18n、测试或无障碍直接依赖前，核验精确版本、许可证、维护状态、浏览器支持、CSP 影响和 lockfile，取得 Owner 对依赖变更的授权。
- 第一次真实 Cloudflare、公共 URL、浏览器云、设备实验室或付费测试服务操作前，展示外部变化、数据披露、费用和回退边界并取得授权。
- 任一关键流程无法由键盘或目标辅助技术完成、三语资源不完整、私人 API 响应被离线缓存或 browser matrix 缺平台时，阻止本 Plan 收口。

## 文件边界

### 新建

- apps/control-center/src/app/
- apps/control-center/src/components/
- apps/control-center/src/features/
- apps/control-center/src/gateway/
- apps/control-center/src/i18n/
- apps/control-center/src/styles/
- apps/control-center/src/accessibility/
- apps/control-center/test/
- test/e2e/browser/control-center/
- test/fixtures/i18n/
- test/integration/qualification/accessibility/

若 S1 已创建同名骨架，直接扩展现有目录，不重复 package。

### 修改

- apps/control-center/package.json、tsconfig 与构建配置：只加入获批精确依赖和安全 production build。
- package.json、vitest.workspace.ts、biome.json 与 scripts/check-boundaries.mjs：增加 browser、i18n 和 accessibility 入口及 browser/Node 边界。
- packages/gateway-contracts/src/：只消费领域 Plans 已冻结的 query/mutation/event types。
- apps/agent-service/src/：仅增加经过身份、CSRF、scope 和 read model 保护的控制中心 routes。
- README.md、docs/architecture-v0.1.md：行为和支持矩阵实测后再更新。

### 测试

- apps/control-center/test/
- apps/agent-service/test/
- packages/gateway-contracts/test/
- test/e2e/browser/control-center/
- test/integration/qualification/accessibility/
- 各领域 Plan 的 browser journey tests。

## 实施任务

### Task 1：冻结信息架构、API inventory 与 S3 acceptance 映射

- [ ] 将 S3-A01 完整操作面、S3-A02 三语/回答语言、S3-A03 响应式实时、S3-A04 Attention、S3-A05 WCAG/浏览器绑定 tasks 和 evidence。
- [ ] 逐页列出主责 Spec、稳定对象、查询、mutation、revision、授权/re-auth、empty/loading/error/degraded/offline 状态。
- [ ] 标记尚未冻结的领域 contract 并阻止页面接入，不用前端自建临时业务语义。
- [ ] 保存当前浏览器 app、Gateway 和安全测试基线。

### Task 2：完成前端栈与构建兼容性 preflight

- [ ] 从官方 release/registry 证据评估 UI、router、ICU i18n、schema client、browser test、axe 类检查和必要构建依赖。
- [ ] 核验 Safari/Chrome/Edge/Firefox/iOS Safari/Android Chrome 支持、Node.js engine、CSP、bundle、许可证和安全公告。
- [ ] 建立最小 spike 验证 SSR/SPA 选择的实际 Gateway/SSE、deep link、code splitting、source map 和 production CSP 行为。
- [ ] 展示精确依赖与 lockfile diff，获批后才写入 manifests；失败时停止并修订实施选择，不缩减浏览器或 WCAG 范围。

### Task 3：建立语义组件与无障碍工程契约

- [ ] 为按钮、链接、表单、dialog、menu、tabs、table/list、status、toast/banner、risk、diff 和 virtualized list 固定语义与键盘行为。
- [ ] 固定焦点进入/恢复、错误关联、live-region 节流、reduced-motion、触摸目标、非颜色状态和高对比 token。
- [ ] 为高风险审批、recent re-auth、revision conflict 和 destructive confirmation 建立不可绕过的组件 contract。
- [ ] 用组件级 keyboard、name/role/state、contrast、zoom/reflow 和 screen-reader smoke tests 固定基础。

### Task 4：实现完整三语资源与 locale runtime

- [ ] 建立稳定 ICU 风格 message keys，覆盖导航、状态、错误、帮助、空状态、表单和安全说明。
- [ ] 完成 zh-CN、en、ja 同键集合、参数、plural/select 分支和专业字面量策略。
- [ ] UI locale 只保存在当前浏览器 profile；首次可从浏览器首选语言初始化，不跨设备同步。
- [ ] 日期、时间、数字、费用和大小按 UI locale 格式化；IANA timezone、UTC、model/version 和原始代码不转换。
- [ ] production build 对缺 key、变量不一致和未翻译 fallback 失败；运行伪本地化、长文本和日文输入布局检查。

### Task 5：实现响应式全局 Shell 与导航

- [ ] 实现 Threads、Approvals、Tasks、Inbox/Digest、Memory、Capabilities/Adapters、Authorizations/Grants、Trace、Settings、Sessions/Devices、Health/Deployment 全入口。
- [ ] 桌面提供可调整列表/内容/详情，移动保持同功能的单列导航和可返回详情。
- [ ] 每个深链接在身份、recent-auth 和 scope 检查后加载；撤销 session 时清空内存私人 view state。
- [ ] 列表查询状态、筛选、分页/cursor 和对象 ID 可恢复，关键操作不限定桌面。

### Task 6：接通 Thread/对话与回答语言

- [ ] 消费 S2 的 Thread list/detail/search/fork/archive/checkpoint 和 committed message stream。
- [ ] 显示独立 UI locale 与 answer locale 控件；切换任一方不调用另一方接口。
- [ ] 展示未发送、accepted/running/blocked/completed、stream sequence、reconnect 和 snapshot refresh 状态。
- [ ] 原始代码、日志、引用和命令保持原文，翻译是显式动作。
- [ ] 覆盖桌面/移动、多标签、断线、重启和 revision conflict。

### Task 7：接通审批、能力与 Grant 管理

- [ ] 审批卡显示冻结 ActionIntent、risk floor、模型建议、最终风险、目标、scope、披露、费用、收件人、可逆性和 expiry。
- [ ] 只允许批准、拒绝或受支持的缩小范围；扩大形成新提案。
- [ ] CRITICAL、凭据、生产、永久删除、公开发布、资金、法律和人身安全操作逐次 recent re-auth，禁用批量批准。
- [ ] 能力详情显示来源、精确版本、完整性、permissions、secret refs、健康、更新差异、依赖任务和回退。
- [ ] Grant 撤销后刷新受影响任务和 Handle 状态，不把模型解释显示为授权结果。

### Task 8：接通 Tasks、Inbox、Digest 与 Attention

- [ ] 实现 Task 列表/详情、触发、预算、时区、Run、blocked reason、pause/cancel 和结果关联。
- [ ] SILENT、INBOX、DIGEST、NOTIFY、INTERRUPT 使用确定性呈现，离线结果持久且不发送站外消息。
- [ ] Digest 只聚合既有 Result，展示每项来源，不重新执行 Task。
- [ ] 普通期望提醒可降低，但显示不可降低的安全下限与原因。
- [ ] 在离线、预算阻塞、重复事件和恢复后验证未读/优先级稳定。

### Task 9：接通 Memory、Trace、设置、设备与健康

- [ ] Memory 页面支持来源、版本、分类、敏感审批、纠正、archive/delete 和不可恢复状态，不展示 machine secret。
- [ ] Trace 页面显示可观察因果链、实际 model/provider、授权、能力、费用、重试和结果，不伪造 hidden reasoning。
- [ ] Settings 接通 models/budgets、attention/digest 和 integrations；secret 只显示 ref/status。
- [ ] Sessions/Devices 支持查看、撤销和 recent-auth；Health/Deployment 显示脱敏稳定错误、影响能力和下一步。
- [ ] 删除、迁移、升级等长操作显示实际 checkpoint 和 readback，不能用 optimistic success 代替。

### Task 10：实现权威客户端状态、SSE 与多标签冲突

- [ ] reducer 以 snapshot、durable cursor、event ID、object revision 和 Run sequence 去重。
- [ ] cursor gap/expiry、scope change 或序列冲突时停止局部应用，执行 bounded snapshot refresh。
- [ ] mutation idempotency key 在结果确定前持久复用；刷新或网络重试不创建新动作。
- [ ] 多标签 mutation 冲突展示最新 revision 和差异，要求 Owner 明确重新应用。
- [ ] 对 duplicate/out-of-order event、session revoke、authority degradation 和 normal restart 运行 browser recovery tests。

### Task 11：实现离线与浏览器隐私边界

- [ ] 浏览器只持久 UI locale、主题/布局、未发送草稿和 last cursor。
- [ ] Service Worker 只缓存受版本/CSP 控制的静态资源，不缓存私人 API、Memory、Trace 或审批正文。
- [ ] 离线时所有命令、审批、任务和撤销保持未发送，不在本地生效或排队伪装 accepted。
- [ ] 重连后保留草稿，明确区分未发送、已接纳未完成和已完成。
- [ ] 自动扫描 IndexedDB、local/session storage、Cache API 和日志，证明无私人正文、secret、Cookie 副本和离线命令队列。

### Task 12：建立 WCAG 2.2 AA 证据

- [ ] 生成适用 success criteria 矩阵，逐项标记自动、人工、辅助技术或有理由不适用。
- [ ] 自动运行 lint、axe 类规则、keyboard path、focus、contrast、zoom/reflow、touch target、reduced-motion 和 screenshot regression。
- [ ] 人工运行 keyboard-only、VoiceOver、至少一个非 Apple screen reader、触摸和认知可理解性检查。
- [ ] 动态消息、审批、任务和通知验证 live-region 节流、暂停与不重复朗读。
- [ ] 任一关键流程辅助技术失败保持 release blocker，不用自动化通过覆盖。

### Task 13：执行正式浏览器与设备矩阵

- [ ] 由 S9 在 RC 时冻结六类浏览器最新两个稳定大版本，本 Plan 使用同一矩阵。
- [ ] 每个正式版本覆盖登录后全导航、Thread、approval、task、Inbox、Memory、capability/Grant、Trace、settings、health、delete 和 migration/upgrade 状态。
- [ ] 桌面与移动覆盖代表性 zh-CN/en/ja 与 answer locale 组合、长文本、日文输入和方向/布局回归。
- [ ] 记录实际 browser/OS/device、candidate revision、artifact、结果与截图/日志 digest。
- [ ] 不支持组合或只有安全只读降级时明确阻止正式支持声明。

### Task 14：对账文档与 S0/S9 证据

- [ ] 映射 S3-A01–S3-A05 到 fresh browser、security、i18n、accessibility 和 manual evidence。
- [ ] 将 J01–J15 的 Owner-facing 步骤接入 S0 journey harness，不复制领域 fixture-only 行为。
- [ ] 将浏览器/WCAG/locale 证据交给 S9 release qualification manifest。
- [ ] 更新 Architecture/README 只描述已验证 build、状态边界、支持矩阵和限制。
- [ ] 所有硬门禁通过后才归档本 Plan 与来源 Spec。

## 验收映射

| Acceptance ID | Spec 验收组 | 主要任务 | 必需证据 | 当前状态 |
| --- | --- | --- | --- | --- |
| S3-A01 | 完整操作面 | Tasks 5–9、13 | 全导航 browser E2E、状态/安全 readback | 待实施 |
| S3-A02 | 三语与回答语言 | Tasks 4、6、13 | key checks、伪本地化、三语/answer locale 组合 | 待实施 |
| S3-A03 | 响应式与实时状态 | Tasks 5、10–11、13 | 桌面/移动、SSE、多标签、offline | 待实施 |
| S3-A04 | Attention、Inbox 与 Digest | Tasks 8、10、13 | 五级呈现、离线恢复、来源 | 待实施 |
| S3-A05 | WCAG 2.2 AA 与浏览器 | Tasks 3、12–14 | 自动、人工、辅助技术、六类浏览器矩阵 | 待实施 |

## 验证

- npm run check
- npm run test:unit
- npm run test:contracts
- npm run test:integration
- npm run test:e2e
- 本 Plan 新增的 i18n、browser、security 和 accessibility 入口
- python3 /Users/triggerjames/.codex/skills/document-governance/scripts/validate_docs.py --strict .
- git diff --check

真实公共身份、浏览器云或设备实验室检查必须另有授权并记录费用/数据边界；开发服务器、单浏览器截图或自动 axe 通过不能单独证明完成。

## 收口清单

- [ ] S3-A01–S3-A05 全部有 fresh 自动、人工、辅助技术和 browser evidence。
- [ ] 所有页面和关键安全说明完整提供 zh-CN、en、ja。
- [ ] 桌面与移动功能等价，离线/重连/多标签不制造权威状态。
- [ ] 浏览器持久存储和缓存不含私人 API 正文或 secret。
- [ ] S0 journeys、S9 qualification、Architecture 和 README 已对账。
- [ ] strict document validation、全仓检查与相关测试通过。
- [ ] 本 Plan 与来源 Spec 只在工作真正关闭后归档。
