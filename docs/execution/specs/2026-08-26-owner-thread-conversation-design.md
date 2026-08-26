---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 Owner Thread 与对话体验设计 Spec

## 目标

定义 v0.2 中 Owner 直接感知的长期 Thread 与对话语义：Thread 如何创建、继续、命名、检索、置顶、归档、Fork、压缩和删除，Thread 级回答语言如何持续生效，以及多浏览器、重启和后台任务存在时如何保持同一身份和历史。

本 Spec 只拥有 Thread 与对话产品语义。SQLite、HTTP/SSE、Memory 提炼、模型路由和权威迁移由持久基础 Spec 负责；完整页面布局、三语 UI 资源与 WCAG 验收由控制中心 Spec 负责。

## 来源上下文

- 产品需求：[SOURCE: docs/prd-v0.2.md#thread-run-与内部稳定边界]
- Thread 生命周期：[SOURCE: docs/prd-v0.2.md#thread-生命周期与上下文压缩]
- 回答语言：[SOURCE: docs/prd-v0.2.md#web-ui-语言回答语言与无障碍]
- 持久恢复验收：[SOURCE: docs/prd-v0.2.md#持久-thread-与-web-恢复]
- 保留与删除：[SOURCE: docs/prd-v0.2.md#数据保留归档与删除]
- 当前系统：[SOURCE: docs/architecture-v0.1.md]
- Thread/Run 身份决策：[SOURCE: docs/adr/0013-agent-thread-run-memory-model.md]
- 产品状态权威：[SOURCE: docs/adr/0015-product-state-over-pi-runtime-projection.md]
- 完整 Trace：[SOURCE: docs/adr/0010-complete-session-trace.md]
- 可替换 Memory：[SOURCE: docs/adr/0005-replaceable-memory-boundary.md]
- 持久基础设计：[SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- v0.2 Spec 总纲：[SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]

## 范围

### 本 Spec 包含

- Thread、Message、Turn、Run 和内部 Session 的用户可见关系。
- 新建、自动标题、重命名、置顶、归档、恢复、搜索、筛选、Fork 和删除前协调。
- Thread 级模型回答语言及其与浏览器 UI 语言的独立性。
- Thread 内短期上下文、跨 Thread 相关引用、长期 Memory 和 Owner Profile 的选择边界。
- 带来源范围、水位线和策略版本的可恢复摘要与上下文压缩。
- 待审批行动、后台任务和 Thread 生命周期之间的独立关系。
- 多浏览器、多设备、断线和正常重启下的 Thread 一致性。

### 本 Spec 不包含

- 具体数据库 schema、SSE transport、模型 provider 或 Memory provider 实现。
- Web 控制中心的视觉系统、三语翻译资源和 WCAG conformance claim。
- 后台任务调度、Attention 判定或能力执行语义。
- 原生客户端、站外通知、共享 Thread、多 Owner 或团队协作。
- 消息编辑、多人实时协作或把历史 Thread 导出为通用格式。

## 验收标准

### 稳定身份与继续对话

- 给定任意已存在 Thread，当浏览器关闭、空闲、上下文压缩、Agent Service 重启或 Owner 换设备后再次打开时，必须继续同一个 ThreadId、消息历史、Run、Trace、审批、任务引用和可恢复摘要。
- 给定一次带幂等键的消息提交，当客户端重试或多个连接重复发送时，只能创建一个 accepted Trigger、一个稳定 Run 和一条用户消息。
- Thread 不因内部 Session 重建、Pi compaction 或 Run 终止而自动结束；内部 Session 不出现在 Owner 必须管理的层级中。

### 生命周期与查找

- 新 Thread 默认 active、未置顶、回答语言为简体中文，并可以异步生成可被 Owner 覆盖的标题。
- Owner 可以重命名、置顶或取消置顶、归档和恢复 Thread；归档可逆、默认从主列表隐藏，但不删除内容或取消关联任务。
- Owner 可以按标题和有权访问的消息内容搜索，并按时间、归档状态和任务状态筛选；被 Trash、永久删除或无权解密的内容不能出现在结果中。
- 删除 Thread 前必须展示关联 active tasks，并要求 Owner 选择取消、暂停或重新绑定；未解决前不得完成删除。

### Fork 与来源

- Owner 可以从任意已提交历史轮次 Fork 新 Thread；新 Thread 保存来源 Thread、来源 Turn、来源消息水位线和当时可恢复上下文快照。
- Fork 不复制原 Thread 的任务、审批、Grant、长期 Memory 对象或未提交输入；新 Thread 只通过普通 Owner Profile、长期 Memory 与仍有效授权规则获得共享上下文。
- 原 Thread 后续变化不得悄悄改写 Fork 的来源快照；来源关系和使用过的引用进入 Trace。

### 回答语言与上下文

- 每个新 Thread 默认模型回答语言为简体中文。Owner 通过可见选择或明确自然语言指令修改后，该设置持续到再次修改。
- 浏览器 UI 语言改变、输入一段外语或引用外文资料都不能自动永久改变 Thread 回答语言。
- Agent 生成的回答、摘要和解释使用当前 Thread 回答语言；代码、日志、原始引用和专有名词保持原文，只有明确要求时才另行翻译。
- Context Formation 只选择当前 Thread 必需历史、相关跨 Thread 摘要或片段、Owner Profile、长期 Memory 和有效 policy references；不得无差别发送全部历史。

### 压缩、审批与任务

- 压缩生成的摘要必须保存覆盖范围、source watermark、policy/model version、生成 Trace 和恢复引用；不得创建新 Thread、删除 transcript 或改变 Thread 生命周期。
- explicit checkpoint、受控 idle、compaction 前和 source-size threshold 可以触发稳定边界，但不会取消任务、结束 Thread 或使审批提前过期。
- 待审批行动保留到自身有效期结束；过期后必须形成新的 ActionIntent 和 Approval Request，不能复用旧批准。
- 归档 Thread、离开页面或压缩上下文不能自动取消已经批准的后台任务。

## 设计

### Thread 聚合

Thread 是产品自有聚合，至少保存：

~~~text
ThreadId、OwnerId、AgentId
status: active | archived | trashed | deletion_pending | deleted_verified
title、title_source、title_revision
pin_state、pin_order
answer_locale
fork_source_thread_id、fork_source_turn_id、fork_watermark
message_head、checkpoint_watermark、revision
created_at、updated_at、archived_at、trashed_at
~~~

Thread 只保存产品身份和引用。Message 正文、summary 正文与模型输出仍使用受保护 Payload；Run、Approval、Task 和 Memory 通过稳定 ID 关联，不嵌入 Thread record。

### 命令与幂等

生命周期命令包括 `thread.create`、`thread.rename`、`thread.pin`、`thread.archive`、`thread.restore`、`thread.fork`、`thread.set_answer_locale`、`thread.trash`、`thread.delete_permanently`。每个 mutation 都携带 Owner/Agent scope、expected revision 和 idempotency key，并通过统一 Control Plane 提交。

自动标题是可恢复派生任务。它只能更新仍处于 `auto` 来源且 revision 未变化的标题；Owner 手动命名后，迟到的自动标题结果必须被拒绝。置顶顺序使用稳定有序值并支持幂等重排。

### 消息、Turn、Run 与内部 Session

一条被权威接受的用户消息产生稳定 Message 和 Trigger，随后通过统一接纳形成 Run。模型流式片段只属于该 Run；最终 assistant message 在产品 commit 后才成为 Thread 历史。失败或取消 Run 保留真实已提交片段、终态和 Trace，不伪造完整回答。

内部 Session 只聚合一段运行时 Trace 或稳定处理边界。Session 可以重建、轮换或因 Pi runtime 重置而变化，但不能改变 ThreadId、MessageId、TurnId 或 RunId。

### 搜索与筛选

产品数据库保存可重建的 Thread metadata 与受保护 search projection。索引输入先执行数据等级和删除过滤；查询结果只返回当前 Owner/Agent scope 内的 active 或按请求包含的 archived Thread。搜索 projection 丢失时可以重建，不能成为唯一历史来源。

搜索结果返回命中类型、ThreadId、消息或摘要引用、时间和高亮用的最小派生片段。Trace 记录跨 Thread 命中和最终是否进入模型上下文；UI 搜索本身不自动把结果披露给模型。

### Fork 快照

Fork transaction 固定来源 Turn 已提交时的消息水位线、当时有效 summary 引用和 Owner 可见 policy references，创建新的空任务/审批集合。长期 Memory 不复制；后续 Context Formation 按新 Thread 的普通规则重新检索。

来源 Thread 被永久删除后，Fork 保留非正文 lineage marker，但不得通过来源快照继续访问已删除正文。若某段正文已经作为新 Thread 的独立已提交消息存在，则按新 Thread 自身生命周期管理。

### 回答语言

`answer_locale` 使用产品支持的语言标识，v0.2 初始允许 `zh-CN`、`en`、`ja`。自然语言修改必须被解析为显式设置意图并在回复前提交；仅检测输入语言不能更新该字段。

Context Formation 把回答语言作为 policy reference 注入模型。摘要、Memory 展示解释和主动结果在关联 Thread 存在时使用该 Thread 语言；没有关联 Thread 的全局结果使用 Owner 当前明确设置的全局展示默认值，初始为简体中文，但不反向修改任何 Thread。

### 上下文压缩

压缩 job 由 ThreadId、source watermark 和 policy version 唯一确定。summary commit 同时保存 covered range、保留起点、来源 refs、生成模型、classification 和 Trace。重试复用同一 generation identity，迟到结果只有在 watermark 仍匹配时才能成为 current summary。

原始消息永不因压缩自动删除。构建上下文时优先使用 current summary 加 summary 后消息，并在需要时按相关性回取更早片段；所有选择和排除理由可观察。

### 生命周期与关联任务

归档只改变默认可见性。Task 保存自己的 Thread binding 和授权；Thread archive 不触发 Task mutation。Thread trash/delete 前由 Control Plane 查询 active task references，Owner 明确选择后以独立命令取消、暂停或重新绑定。

Thread 永久删除的级联和保留 Memory 的 deleted-source marker 遵循持久基础 Spec。其他 Thread 仅保存的相关引用必须失去正文解析能力。

## 错误处理

| 失败 | 必需行为 |
| --- | --- |
| 重复消息或生命周期命令 | 返回原幂等结果，不创建第二个 Message、Run 或 Thread |
| expected revision 冲突 | 返回当前快照并要求客户端重新应用意图，不覆盖较新修改 |
| 自动标题迟到 | Owner 已命名时丢弃自动结果并记录 stale derivation |
| Fork 来源未提交或已删除 | 拒绝 Fork，不创建部分新 Thread |
| 搜索 projection 不可用 | 明确降级并排队重建，不扫描或披露无权正文 |
| summary 生成中断 | 保留 transcript 与旧 current summary；同 identity 有界重试 |
| answer locale 无效 | 保持原设置并返回受支持值，不根据输入语言猜测写入 |
| Thread 有 active tasks | 阻止删除并返回必须处理的稳定 task references |
| authority 或 fence 失效 | 拒绝 mutation；只允许安全读取已提交状态 |

## 验证策略

- 为每个 Thread 命令运行 idempotency、revision conflict、multi-client 和 restart contract tests。
- 在 1 万个 Thread、20 万条消息和混合 active/archived/trashed 数据上验证列表、搜索、筛选、置顶和恢复性能。
- Browser E2E 覆盖新建、自动标题与手动覆盖、重命名、置顶、归档/恢复、Fork、语言切换、压缩、任务关联和删除前协调。
- 对四类 checkpoint 触发和每个 summary commit checkpoint 做 kill/restart，验证原始历史、watermark 与 exactly-once generation。
- 验证跨 Thread 检索只注入相关引用，Trace 包含候选、选择和来源，删除来源后无法解析正文。
- 用中英日输入组合证明 UI locale、输入语言和 Thread answer locale 相互独立。
- 在两个浏览器和正常主机重启后验证同一 Thread、Run、审批、任务和 cursor 的一致恢复。
- 运行 unit、contract、integration、browser E2E、规模测试、`npm run check` 和 strict document validation。

## 确认状态

本 Spec 已按 PRD v0.2 完整编写，当前等待 Owner 对 Thread 生命周期、Fork、回答语言和压缩语义整体确认。确认前不从本 Spec 创建 Implementation Plan，也不修改产品实现。
