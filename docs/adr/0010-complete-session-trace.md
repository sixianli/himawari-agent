---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# ADR 0010: 持久化完整可观察的 Session Trace

## Context

所有者要求按需查看每个 Session 中每一轮发生的模型调用、工具调用、记忆检索、内部委派和人工审批。普通文本日志不能稳定表达因果关系，单纯保存聊天消息也无法解释外部行动。永久保存凭证明文则会让 Trace 成为新的秘密泄露源。

## Decision

每个 Session 使用结构化事件形成 `Session → Turn → Run → Span/Event` 的完整可观察时间线。记录触发、上下文、记忆、模型、工具、委派、策略、审批、状态写入、外部行动、错误、重试和补偿之间的父子及因果关系。

Trace 不尝试保存模型服务商内部不可见计算或隐藏思维过程。秘密在事件写入之前替换为引用、版本和用途。详细 Trace 默认长期保留并允许归档查询；所有者删除内容后只保留不含原文的最小审计墓碑。

诊断遥测可以使用 Pi 的显式 Telemetry 接口，但遥测是被动诊断数据，不能替代产品级 Session Trace 或业务状态。

## Options Considered

### 仅保存聊天消息和普通日志

- Benefits: 存储和实现简单。
- Costs: 无法可靠还原工具、审批、重试和外部副作用的因果链。

### 永久保存所有原始负载和秘密

- Benefits: 表面信息最完整。
- Costs: 复制凭证并扩大泄露影响，不符合秘密隔离要求。

### 结构化完整 Trace 加秘密分离

- Benefits: 可查询、可审计且不复制凭证明文。
- Costs: 需要事件规范、归档、删除传播和访问控制。

## Consequences

- Positive: 所有客户端可以基于同一事实呈现完整 Session 过程。
- Negative: Trace 具有高敏感度和持续增长特征，需要分层存储与严格访问控制。
- Follow-up: Spec 必须定义事件信封、因果标识、敏感字段处理和删除传播。

## Links

- [SOURCE: docs/prd-v0.1.md#session-visibility-and-lifecycle]
