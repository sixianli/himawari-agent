---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# ADR 0006: 使用一个主 Agent 和受限工作单元

## Context

通用任务会涉及研究、编程、规划和外部操作。将这些能力建模为多个长期平级人格会分裂所有者关系、记忆、授权和责任边界，也会让用户难以判断谁代表自己。

## Decision

产品只向所有者呈现一个持续存在的主 Agent。主 Agent 可以为具体运行委派专业工作单元；工作单元默认临时存在，只获得任务必需的上下文、工具、时间、费用和数据范围。

工作单元不默认拥有独立私人长期记忆，不能直接扩大权限，所有外部行动仍经过统一授权和审计。需要真正独立所有权、记忆和行为边界时，创建新的 Agent 身份，而不是把工作单元隐式升级为平级 Agent。

## Options Considered

### 多个长期平级 Agent

- Benefits: 专业人格清晰，可独立运行。
- Costs: 记忆和授权分裂，责任归属不清，容易产生竞争行动。

### 一个主 Agent 加受限工作单元

- Benefits: 保持单一用户关系和责任边界，同时支持并行专业能力。
- Costs: 主 Agent 需要协调、预算和结果整合机制。

## Consequences

- Positive: 用户始终面对同一个了解自己的 Agent。
- Negative: 内部委派必须携带明确的上下文和能力裁剪。
- Follow-up: Spec 必须定义委派、取消、结果合并和工作单元 Trace 的父子关系。

## Links

- [SOURCE: docs/prd-v0.1.md#agent-topology-and-capabilities]
