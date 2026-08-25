---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# ADR 0013: 分离 Agent、Thread、Run 和 Memory

## Context

把所有交互放入一条无限对话会污染短期上下文并阻碍并行任务；把每个会话当作独立 Agent 又会失去统一的所有者关系、长期记忆和授权。后台任务还需要独立于聊天轮次的运行记录。

## Decision

领域模型明确区分：持续存在并归属于所有者的 Agent、承载一项对话或任务上下文的 Thread、一次具体推理和工具执行的 Run，以及跨线程共享的长期 Memory。

一个 Thread 可以包含多个 Run；后台触发也必须创建可识别的 Run，并关联到目标或 Thread。Session 是面向交互和 Trace 的聚合视图，不替代这些领域身份。

## Options Considered

### 一条无限全局对话

- Benefits: 用户表面上永远处于同一上下文。
- Costs: 无关任务互相污染，无法清晰并行、取消或审计。

### 每个会话都是独立 Agent

- Benefits: 会话隔离直接。
- Costs: 私人身份、记忆和授权被重复或割裂。

### 一个 Agent、多个 Thread 和 Run、共享 Memory

- Benefits: 保持同一私人 Agent，同时支持任务隔离和跨设备继续。
- Costs: 需要明确跨层引用和生命周期规则。

## Consequences

- Positive: 短期上下文、长期状态和执行记录各有清晰归属。
- Negative: API 和存储不能再用一个 `session_id` 表达所有概念。
- Follow-up: Spec 必须定义身份、关联、并发和关闭语义。

## Links

- [SOURCE: docs/prd-v0.1.md#ownership-and-identity]
