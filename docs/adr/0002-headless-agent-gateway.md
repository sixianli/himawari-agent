---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# ADR 0002: 使用产品自有的无头 Agent Gateway

## Context

Himawari Agent 必须同时支持网页、桌面、命令行、移动设备、带屏小设备和纯语音终端。任何客户端特有状态或 Pi 实验性远程协议一旦成为产品协议，都会限制未来客户端并把兼容性责任交给上游实验接口。

## Decision

所有客户端只连接产品自有的无头 Agent Gateway。Gateway 定义稳定的命令、查询、事件流、审批和 Trace 读取契约；客户端不直接持有权威 Agent 状态，也不直接依赖 Pi 类型或 Pi 的实验性 protocol/client/server。

本地前台模式可以让客户端在同一进程中调用同一应用核心，但必须经过相同的 Gateway 应用契约。未来替换为 Unix socket、HTTP、WebSocket、语音适配器或远程服务时，不改变领域语义。

## Options Considered

### 每个 UI 内嵌自己的 Agent

- Benefits: 单个 UI 的原型直接。
- Costs: 多端状态冲突，权限和主动任务行为不一致。

### 直接采用 Pi 实验性远程协议

- Benefits: 可以复用现有 wire 类型和部分连接代码。
- Costs: 上游明确不承诺长期兼容，且不包含完整产品认证、权限和领域契约。

### 产品自有 Gateway

- Benefits: 客户端稳定，传输和上游运行时可替换。
- Costs: 产品需要维护协议版本和兼容性策略。

## Consequences

- Positive: 所有 UI 共享一致的会话、授权、主动任务和 Trace 行为。
- Negative: 即使本地单进程模式也需要遵守应用边界。
- Follow-up: Spec 必须定义流式事件、幂等命令、断线恢复和版本协商语义。

## Links

- [SOURCE: docs/prd-v0.1.md#goals]
- [SOURCE: docs/prd-v0.1.md#scope]
