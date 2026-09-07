---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-09-07"
---

# ADR 0023：通用人工审批与持久执行恢复

## Context

文件读取、删除文件、执行 Shell、发送邮件及高风险 MCP 都可能在 Agent 的工具调用期间需要 Owner 确认。为每个工具分别实现等待和重启恢复，会产生不同的取消、超时、重复执行与结果核查行为。Owner 已明确要求建设通用 durable agent execution / suspend-resume 状态机，文件读取只是第一个接入场景，验收必须包含受控的副作用工具。

## Decision

沿用产品数据库为权威、Pi Session 为运行时投影的既有决定。由产品工具端口统一返回类型化的 `awaiting_approval`，由 Runtime 保存受保护的恢复记录，由 Run Coordinator 以执行租约保护 checkpoint 和 Run 状态转换；审批等待不以存活进程、浏览器连接或内存 Promise 为前提。

批准、拒绝或过期后，调度器读取持久审批记录并竞争新的执行租约。审批决定本身不执行动作。恢复须保留原任务、动作参数、模型身份、部署权威和总期限，重新验证当前权限。拒绝一个动作可以作为工具失败结果交回 Pi；取消整个 Run 则阻止后续执行。

Pi 继续负责工具参数验证、批次调度与 Agent loop。固定版本公开接口的薄适配保存已完成的 assistant 工具调用消息和此前上下文，在新 Session 中本地回放该消息，使 Pi 处理原工具批次；下一次真实 Provider 请求沿用持久调用序号。历史回放不发起 Provider 请求、不重新计费，也不把暂停时用于结束内存执行的错误当作工具结果交给模型。

具体工具复用已有动作授权、Capability Handle、Worker 执行意图、回执及受保护结果账本。已确认阶段回读结果，已派发但缺少确认结果的阶段进入 `reconciling_external_result`，不因批准或重启自动重派。该机制不承诺任意外部系统的副作用恰好发生一次；邮件、Shell 或 MCP 适配器仍须声明幂等与结果核查能力。

## Options Considered

### 每个工具自行等待并恢复

实现容易局限于首个用例，长期会重复维护审批、租约、取消和结果核查规则，不采用。

### 始终保留内存中的 Pi 工具 Promise

可以支持短时交互，但进程退出后缺少可靠恢复依据，也会持续占用执行槽位，不作为正确性的基础。

### 产品持久状态与 Pi 恢复适配

复用产品授权和执行账本，保持统一状态转换，并沿用 Pi 的工具调度；代价是需要保护并验证恢复记录、维护固定 Pi 版本兼容性，以及明确区分历史回放与新模型请求。采用此方案。

## Consequences

- Run 管理整体任务；审批请求和工具执行账本分别描述动作的等待、执行及结果，不把拒绝一个动作直接等同于取消整个任务。
- 等待审批释放执行租约与运行槽位。现有 `deadlines.runMs` 是任务总墙钟期限，`providerRequestMs` 和 `workerRequestMs` 分别限制实际请求；审批也有自己的 `expiresAt`。恢复不重置总期限或累计费用。
- 只允许完整、已持久保存的审批暂停点自动恢复；中断的 `runtime_running` 保持结果核查语义，旧终结 Run 不复活。
- 版本迁移保留既有 checkpoint 与 Worker 结果。Pi 升级时必须重新验证原工具批次、消息和调用序号的恢复兼容性。
- 文件读取与受控副作用测试提供不同层次的验证；它们不替代正式 Mac 隔离资格、真实模型和 ego Lite 的完整验收，也不表示 Shell、邮件或 MCP 产品适配器已全部接入。

Run 状态转换与 Thread 版本及持久事件在同一事务提交，使浏览器可及时刷新等待、恢复和取消状态。审批等待也受原 Run 总期限限制；到达总期限时调度器领取并终止请求，不等待更晚的审批过期时间。

## Links

- [SOURCE: docs/adr/0015-product-state-over-pi-runtime-projection.md]
- [SOURCE: docs/adr/0004-deterministic-authorization.md]
- [SOURCE: docs/architecture-v0.1.md]
- [SOURCE: docs/execution/specs/2026-09-07-real-file-summary-agent-loop-design.md]
