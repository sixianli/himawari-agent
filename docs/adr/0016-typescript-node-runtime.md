---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# ADR 0016: 使用 TypeScript 和 Node.js 构建首个服务端运行时

## Context

Pi 的公开 SDK、事件类型和扩展系统以 TypeScript 提供，并要求现代 Node.js。Himawari Agent 可以通过跨语言服务调用 Pi，但这会在最早阶段引入额外协议、类型转换和调试断点，使边开发边学习 Pi 源码的目标变得困难。

## Decision

使用 TypeScript 和与当前 Pi 要求兼容的 Node.js 版本构建首个 Agent 服务、产品领域包和 Pi 适配器。只使用可直接擦除的 TypeScript 语法，保持运行时行为接近源码并便于单步调试。

该选择不要求所有未来客户端使用 TypeScript；原生 macOS、移动设备和语音设备仍通过 Agent Gateway 使用任意合适技术。

## Options Considered

### TypeScript 与 Pi 同进程集成

- Benefits: 类型和事件映射最直接，可跳转和调试 Pi 源码。
- Costs: 服务端主要运行时受 Node.js 生态约束。

### 使用另一种语言并远程调用 Pi

- Benefits: 可以选择其他语言生态和运行模型。
- Costs: 需要先建立额外协议，源码学习和调试链路更长。

## Consequences

- Positive: 首个垂直链路可以直接复用 Pi 类型和测试工具，但仍被产品适配层隔离。
- Negative: 后续若替换服务端语言，需要保留产品协议并重写适配器。
- Follow-up: Implementation Plan 固定最低 Node.js 版本和 TypeScript 编译约束。

## Links

- [SOURCE: docs/adr/0001-pi-runtime-adapter.md]
