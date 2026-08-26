---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 Web 控制中心、三语与无障碍设计 Spec

## 目标

定义 v0.2 完整响应式 Web 控制中心的产品信息架构、交互状态、三语本地化、桌面与移动适配和 WCAG 2.2 AA 验收。Owner 应当只通过这一控制中心就能完成对话、审批、任务、收件箱、Memory、能力、授权、Trace、设置、身份设备和健康管理。

## 来源上下文

- 产品目标与范围：[SOURCE: docs/prd-v0.2.md#产品目标]
- 控制中心与身份：[SOURCE: docs/prd-v0.2.md#web-控制中心身份与设备]
- 语言与无障碍：[SOURCE: docs/prd-v0.2.md#web-ui-语言回答语言与无障碍]
- 注意力与投递：[SOURCE: docs/prd-v0.2.md#注意力与-web-投递]
- 浏览器兼容性：[SOURCE: docs/prd-v0.2.md#浏览器兼容性]
- 生产上线：[SOURCE: docs/prd-v0.2.md#生产上线]
- 无头 Gateway：[SOURCE: docs/adr/0002-headless-agent-gateway.md]
- 集中 Attention：[SOURCE: docs/adr/0014-central-attention-policy.md]
- 公共身份网关：[SOURCE: docs/adr/0020-public-web-identity-gateway.md]
- 持久基础设计：[SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- Thread 语义：[SOURCE: docs/execution/specs/2026-08-26-owner-thread-conversation-design.md]
- 授权与能力治理：[SOURCE: docs/execution/specs/2026-08-26-authorization-capability-governance-design.md]
- 主动性与 Worker：[SOURCE: docs/execution/specs/2026-08-26-proactivity-workers-self-improvement-design.md]
- v0.2 Spec 总纲：[SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]

### 外部规范证据

- 无障碍验收以 [W3C Web Content Accessibility Guidelines 2.2](https://www.w3.org/TR/WCAG22/) 的 A 与 AA success criteria 为规范来源。自动化检查只能覆盖其中一部分，最终 conformance 需要人工与辅助技术验证。

## 范围

### 本 Spec 包含

- 桌面和手机浏览器的完整信息架构、导航、详情页、全局状态和关键交互。
- 简体中文、英文和日文 UI 资源、浏览器本地 locale、格式化和 fallback。
- Thread 级回答语言的可见控制，但不重新定义 Thread 语义。
- SSE 恢复、离线草稿、pending/accepted/rejected/replayed 状态和多标签页一致性。
- `SILENT / INBOX / DIGEST / NOTIFY / INTERRUPT` 的 Web 呈现与持久结果消费。
- 键盘、屏幕阅读器、焦点、对比度、触摸、缩放、动态内容和非颜色提示。
- Safari、Chrome、Edge、Firefox、iOS Safari 与 Android Chrome 的发布矩阵。

### 本 Spec 不包含

- 公共身份 JWT、CSRF、session/device repository 或 break-glass 的服务端实现。
- Thread、授权、Memory、任务、能力或 Trace 的业务状态机。
- 原生应用、桌面壳、站外 IM、移动 push、语音或硬件客户端。
- 面向公众的注册、多 Owner、团队空间或共享私人状态。
- 对未完成页面做部分 WCAG conformance claim。

## 验收标准

### 完整操作面

- Owner 可以从全局导航进入 Thread/对话、审批、任务、收件箱与 Digest、Memory、能力与适配器、授权与 Grant、Trace、设置、sessions/devices 和健康状态。
- 每个对象详情必须显示稳定身份、当前状态、来源、范围、授权/费用/数据披露、时间、错误与可用下一步；UI 不得把模型解释当作最终授权结果。
- 关键 mutation 在提交前显示目标、操作、范围、外部副作用、数据披露、费用、收件人和有效期中适用的字段，并在提交后展示 accepted、blocked、completed 或需要 readback 的真实状态。

### 三语与回答语言

- 所有产品 UI、状态、错误、表单、帮助、空状态和关键安全说明完整提供 `zh-CN`、`en`、`ja`，不能只翻译导航或主要按钮。
- UI locale 只保存在当前浏览器 profile；首次打开可以用浏览器首选语言初始化，换浏览器或设备不自动同步。
- UI locale 与 Thread answer locale 使用两个独立控件和状态来源。切换 UI 不改变模型回答语言；输入外语也不改变长期回答语言。
- Agent 摘要与解释按 Thread answer locale 显示；原始代码、日志、引用、命令和专有名词保持原文，并提供显式翻译动作而非静默替换。

### 响应式与实时状态

- 桌面宽屏提供可调整的列表、主内容和详情布局；手机使用单列导航、可返回的详情和不遮挡主要操作的底部/顶部控制。
- 浏览器断线时只保存未发送草稿和最后 cursor；所有发送、审批、任务创建和撤销操作必须等待权威接受。
- SSE 断线重连从 durable cursor 恢复；超出 retention 时执行有界 snapshot refresh，并明确区分“未发送”“已接受但未完成”和“结果已完成”。
- 多标签页对同一对象的 mutation 冲突显示最新 revision 和可理解的重新应用选择，不做 last-write-wins 静默覆盖。

### Attention、Inbox 与 Digest

- `SILENT` 只进入活动记录；`INBOX` 进入普通收件箱；`DIGEST` 进入持久日汇总；`NOTIFY` 在在线浏览器展示明显横幅；`INTERRUPT` 使用最高优先级但仍不绕过身份和授权。
- 浏览器离线期间的所有级别结果持久保存；重新打开后按确定性优先级和未读状态展示，不发送站外消息。
- Digest 只聚合已有结果，不重新执行任务；Owner 可以配置时间和关联任务时区，并查看每项来源。
- Owner 可以降低普通任务期望提醒级别，但 UI 必须显示确定性安全下限及无法降低的原因。

### WCAG 2.2 AA 与浏览器

- 所有关键流程可以只用键盘完成，并保持可见且不被遮挡的焦点；焦点顺序与视觉/语义顺序一致。
- 动态消息流、审批出现、任务状态和通知使用合适 live-region/状态语义，避免重复朗读并提供暂停或减少动态效果的方式。
- 文字、图标、图表和状态达到 AA 对比度；错误、风险、成功和优先级不只依赖颜色。
- 触摸目标、拖动替代、缩放/reflow、表单标签、错误定位、重复输入和认证流程满足适用的 WCAG 2.2 A/AA 条款。
- 发布时在 PRD 指定六类浏览器的最新两个稳定大版本记录实际测试矩阵；只在一个浏览器或桌面通过不能声明控制中心完成。

## 设计

### 信息架构

~~~text
全局 Shell
├── Threads
├── Approvals
├── Tasks
├── Inbox / Digest
├── Memory
├── Capabilities / Adapters
├── Authorizations / Grants
├── Trace
├── Settings
│   ├── UI language
│   ├── models / budgets
│   ├── attention / digest
│   └── integrations
├── Sessions / Devices
└── Health / Deployment
~~~

每个列表使用可恢复查询状态和稳定对象 ID；深链接只能在重新认证和 scope 检查后加载私人数据。移动端保留相同功能，不创建“只能桌面操作”的关键安全流程。

### 客户端状态边界

浏览器允许持久保存的本地状态只有 UI locale、主题/布局偏好、未发送草稿和 last accepted cursor。Thread、消息、审批、任务、Memory、Grant、session/device、Attention 和 health 都以权威 read model 为准。

客户端 mutation 使用生成一次并持久到结果确定的 idempotency key。刷新页面或网络重试复用原 key；用户明确发起新动作才生成新 key。

### 本地化架构

所有 UI 文案使用稳定 message key 和 ICU 风格参数，不在组件中拼接句子。资源按 `zh-CN`、`en`、`ja` 完整维护；CI 对 key 集合、变量、复数/选择分支、未翻译 fallback 和超长文本布局做检查。

日期、时间、数字、费用和数据大小按 UI locale 格式化，但底层 IANA timezone、UTC 时间和模型/版本字面量不转换。缺少翻译时 production build 失败，不能静默混用语言。

### 回答语言控制

Thread header 明确展示 answer locale，并通过 Thread 命令修改。自然语言修改由 Agent 形成可观察意图；UI 只展示最终已提交设置。全局 UI locale 菜单不得调用 Thread 设置接口。

### Approval 与高风险交互

审批卡片显示冻结的 ActionIntent snapshot、deterministic risk floor、模型建议风险、最终风险、授权结果、目标、scope、费用、披露、副作用、收件人、可逆性和 expiry。Owner 可以批准、拒绝或在产品允许时缩小范围；任何扩大都形成新提案。

CRITICAL 行动、凭据/权限、生产、永久删除、公开发布、资金、法律或人身安全操作必须要求 recent re-auth，并且不能通过批量“全部批准”绕过逐次确认。

### 实时与离线

SSE reducer 以 durable cursor、event ID、object revision 和 Run sequence 去重。客户端从 snapshot 加 event stream 生成 view state；发现序列缺口、scope 变化或 cursor 过期时停止局部应用并重新取有界 snapshot。

Service Worker 或浏览器离线机制不得缓存私人 API 响应供离线浏览，也不得在离线时接受命令。静态资源可以受版本与 CSP 控制缓存，私人正文只在当前页面内存中短暂存在。

### 无障碍工程契约

组件库在建立时固定语义角色、键盘行为、焦点恢复、错误关联、live-region 策略、触摸尺寸和高对比状态。虚拟化列表必须保留可访问名称、总数/位置和键盘导航；流式文本提供节流，避免每个 token 触发朗读。

自动化覆盖 lint、axe 类规则、键盘路径、颜色/缩放和截图差异，但 conformance evidence 还必须包含 VoiceOver、至少一个非 Apple 屏幕阅读器、键盘-only、触摸和人工认知检查。

## 错误处理

| 失败 | 必需行为 |
| --- | --- |
| locale 资源缺失 | production build 失败；开发环境显示稳定缺失 key，不静默使用错误文案 |
| SSE 序列缺口 | 停止应用增量，执行 bounded snapshot refresh 并保留草稿 |
| mutation revision 冲突 | 显示最新状态与差异，要求 Owner 明确重新应用 |
| session 撤销或 recent-auth 失效 | 清除内存中的私人 view state，跳转重新认证，不丢未发送草稿 |
| 浏览器离线 | 禁止命令/审批本地生效，明确标记草稿与未发送状态 |
| 依赖健康降级 | 展示脱敏稳定错误码、影响能力和下一步，不泄漏 secret/path |
| 辅助技术无法完成关键流程 | 作为 release blocker，不以“可用鼠标完成”降级通过 |
| 不支持浏览器 | 提供明确说明和安全只读降级；不能声称正式支持 |

## 验证策略

- 建立三语 key 完整性、变量一致性、伪本地化、长文本、RTL 非目标防回归和截图布局检查。
- Browser E2E 覆盖全部导航面、Thread/chat、审批、任务、Inbox/Digest、Memory、Capabilities、Grants、Trace、Settings、Sessions/Devices 与 Health。
- 在桌面与手机运行 keyboard-only、VoiceOver、非 Apple screen reader、200%/400% zoom、reflow、touch target、contrast 和 reduced-motion 检查。
- 按发布时实际版本运行 Safari、Chrome、Edge、Firefox、iOS Safari 与 Android Chrome 最新两个稳定大版本矩阵。
- 注入 SSE disconnect、cursor expiry、duplicate event、multi-tab revision conflict、session revoke 和 authority degradation。
- 验证浏览器存储中不存在消息、Memory、审批正文、secret、Cookie 副本或离线命令队列。
- 输出 WCAG 2.2 A/AA success criteria 适用性矩阵，区分自动化、人工、辅助技术和不适用证据。
- 运行 `npm run check`、browser tests、security tests、accessibility tests 和 strict document validation。

## 确认记录

- 确认人：Owner
- 确认日期：2026-08-26
- 确认范围：控制中心信息架构、三语边界、Web-only 投递、响应式体验、浏览器矩阵和 WCAG 2.2 AA 验收方式。
- 授权边界：允许从本 Spec 派生 Implementation Plan；本次确认不授权创建 Plan、修改产品实现、调用外部服务或执行生产变更。
