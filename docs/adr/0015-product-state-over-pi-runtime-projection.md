---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# ADR 0015: 以产品状态为权威并将 Pi Session 视为运行时投影

## Context

`pi-coding-agent` 提供自己的 SessionManager、消息树、压缩和 JSONL 持久化。Himawari Agent 同时需要 Agent、Thread、Run、长期授权、后台任务、完整 Trace 和多端一致性。如果产品数据库与 Pi Session 都能独立写入权威会话状态，恢复、分支、压缩和失败重试会形成双重事实来源。

## Decision

由 Himawari Agent 的产品状态存储持有 Agent、Thread、Run、消息、授权和业务事件的权威记录。每次执行时，Pi 适配器从产品状态构建执行所需上下文，使用内存或受控的 Pi Session 作为运行时投影，并将 Pi 事件映射回产品事件和 Trace。

Pi 的压缩、消息转换和运行时便利能力可以复用，但不能绕过产品提交协议独立改变权威状态。Pi Session 文件可以作为开发诊断或兼容性工件，不是多端产品的事实来源。

## Options Considered

### Pi Session 是唯一权威状态

- Benefits: 最大程度复用 Pi 会话恢复、分支和压缩。
- Costs: 难以承载产品身份、授权、后台运行和多端事务，产品协议受 Pi 会话格式约束。

### 产品状态和 Pi Session 双写且都可恢复

- Benefits: 两边都保留完整本地能力。
- Costs: 产生双重事实来源，失败时难以确定哪一边正确。

### 产品状态权威、Pi Session 为运行时投影

- Benefits: 产品领域和多端一致性保持单一来源，同时复用 Pi 执行能力。
- Costs: 需要可靠的上下文构建、事件映射和 Pi 压缩结果回写策略。

## Consequences

- Positive: Pi 升级和会话格式变化不会直接成为产品数据迁移边界。
- Negative: 不能直接把 Pi 的 JSONL Session 当作完整产品持久化方案。
- Follow-up: 用集成测试证明恢复、压缩和工具事件不会丢失语义。

## Links

- [SOURCE: docs/adr/0001-pi-runtime-adapter.md]
- [SOURCE: docs/adr/0003-single-logical-agent-authority.md]
- [SOURCE: docs/adr/0010-complete-session-trace.md]
- [SOURCE: docs/adr/0013-agent-thread-run-memory-model.md]
