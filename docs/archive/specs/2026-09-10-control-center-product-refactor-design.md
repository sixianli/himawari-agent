---
status: "archived"
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-09-10"
---

# 控制中心正式产品重构

## 目标与来源

将已确认视觉与交互应用于正式 React 控制中心，并依据真实执行记录呈现每轮过程。

- 视觉与原始资源：[SOURCE: docs/execution/specs/2026-09-10-control-center-visual-baseline-design.md]
- 原有业务与三语、无障碍：[SOURCE: docs/execution/specs/2026-08-26-control-center-experience-design.md]
- 对话语义：[SOURCE: docs/execution/specs/2026-08-26-owner-thread-conversation-design.md]

## 实施前核查

2026-09-10 起点为 `codex/web-page-refactor` 的 `67a4abb`，工作区干净。本地 `codex/srt-unified-execution` 是 HEAD 祖先，左右差异为 0 / 3；这个结论不代表远端或主线状态。

| 分类 | 当前证据 | 实施方式 |
| --- | --- | --- |
| 直接复用 | Thread v3 创建、提交、重命名、置顶、归档、搜索、分支对话；浏览器草稿和游标；审批 v2 | 保持命令、幂等、revision 与授权边界 |
| 已有记录尚未展示 | Pi 适配器捕获消息更新、工具输入输出；RunCoordinator 经 SessionTraceRecorder 写入加密 Payload 与 Trace | 从持久化记录提供有边界的展示投影；不在浏览器解析并暴露任意 Trace JSON |
| 需要补齐 | 聊天流式投影、停止入口、执行过程与计时恢复 | 扩展现有 Gateway 与 Run 路径，复用既有取消和审计 |
| 配置边界缺口 | 生产 run-policy 当前固定 primary，Pi 会话固定 thinking off；提交无选择字段 | 选择必须绑定本次提交和持久化 Run，按实际模型能力校验；历史轮不得读取当前选择冒充实际模型 |
| 需要明确的产品语义 | 当前提交仅文本；没有附件及执行模式合同 | 用户已确认仅 UTF-8 文本附件并入 private 正文；仅提供真实“执行”模式 |

## 设计

### 界面与状态

Shell 管理品牌、导航、页面标题、偏好、按需详情及手机视图。聊天组件管理阅读位置、逐轮展示和输入；领域 mutation 继续由现有控制中心模型负责。管理模块沿用既有入口和流程。

Light / Dark 与六种主题色在 `ControlCenterBrowserStorage` 偏好内保存。旧 system 偏好迁移为 Dark；切换主题色只改变链接、焦点与选择标记。背景、文字、状态色使用独立 token。原始图片保持完整，RGB Logo 作为明确有浅色底的品牌图标使用，不冒充透明资源。

### 轮次、模型与执行

一个用户提交对应产品 Turn 与 Run；Pi 内部多次 turn 是该轮的执行过程，不能替代产品轮次。过程以 Run 和持久化 sequence 标识，按事件去重和顺序恢复。停止、失败、等待审批和连接中断分别展示，连接中断不推断执行已停止。

只显示明确可公开给当前 Owner 的模型内容和真实工具记录。缺少记录、时间或授权时显示缺失原因；不从总时长猜测工作与等待时间，不生成 thinking。模型能力来自固定 Pi 0.84.2 API 与实际部署配置；Himawari 负责选择冻结、预算、披露、授权、持久化和审计。

### 参考 Codex 的边界

应用户要求核查 OpenAI 官方 [Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)。参考其 Thread / Turn / Item、最终条目为准、持久化历史加实时通知、每轮模型与 effort 覆盖、服务端审批的组织方式。此处是机制参考，不复制其协议，也不改变 Himawari 的 Owner/Agent 身份与授权职责。

- 追加 `thread.execution` 查询和受限 snapshot，只接受 Thread/Run 身份及页游标。服务端核查 Thread 状态、Run 归属和每条 Trace 的 Owner/Agent/Thread/Run；只能通过服务端记录中的 Payload 引用读取 JSON，不提供任意 JSON Payload URL。仅抽取 assistant 的 text、工具名称与说明、脱敏参数、结果中的文本及事件时间。thinking、签名、图片、系统提示和 provider 元数据不进入投影。记录不可读时返回 unavailable 条目。
- Pi 0.84.2 当前适配记录没有独立、明确标记为可展示摘要的 thinking 事件，因此展示“模型未提供可展示的 thinking 摘要”，不能把原始 thinking 改名为摘要。
- Trace 与 `thread.execution.updated` 通知在同一 SQLite 事务追加，复用原 Thread SSE 游标；页面以事件身份去重，以 sequence 排序，重连重新读持久化投影。revision 为零的内部初始 Thread 尚不满足公开 Thread Gateway 合同，不产生浏览器通知，Trace 本身照常保存。
- 新增 `thread.message.submit_configured`，保持旧提交合同可用。提交时核查配置中的 generation descriptor、private 披露与 Pi 支持的思考深度；migration 0030 将选择保存到本次 Run。RunExecutionInputService 冻结执行策略后仍复用预算、授权和 checkpoint 恢复。
- `thread.run.cancel` 进入既有 RunCoordinator 取消链，继续使用其持久化幂等取消与真实 runtime/Worker 停止；不在前端直接把 Run 写成 cancelled。

### 数据和错误

不增加浏览器的持久化执行历史缓存。已持久化事件由服务恢复，未持久化信息不得声称可恢复。原有 private Payload、会话身份、CSRF、幂等键和 revision 检查继续生效；技术标识和错误详情可以打开查看。

## 验收

正式页面在 1280 × 820 与 320 × 820 检查布局、字体、中性色、主题色、输入和详情。逐项验证新建/继续、多轮保留、流式/停止、模型生效、审批、重连、刷新、草稿和无障碍。受控 fixture、真实服务、真实模型分别记录，不相互替代。

## 本轮验收范围补充

用户于本轮明确“还没有，先完成本机版本”。本轮交付正式源码、构建、本机受控浏览器入口和验证证据；真实部署、外部模型与主机工具资格不作为本次已完成结论。测试服务仅放在 test 目录，需显式 `HIMAWARI_EXECUTION_FIXTURE=1` 启用测试事件入口，产品构建不包含它。

## 已确认的审批交互适配

冻结原型可在聊天内直接批准或拒绝。当前实现从当前 Run 查找真实待处理审批，再进入已有审批详情及确认流程，继续保留风险说明、近期认证、revision 和幂等检查。已通过受控浏览器验证原有批准、拒绝和恢复路径。用户在查看此交互差异后明确回复“接受”，本轮采用聊天跳转现有完整审批确认页的方式。冻结原型保持原样，以本 Spec 和本轮验收截图记录正式实现的适配。
