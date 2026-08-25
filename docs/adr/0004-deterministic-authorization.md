---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# ADR 0004: 将授权判断置于模型之外

## Context

Himawari Agent 会读取私人数据、运行工具并产生外部副作用。语言模型的概率输出不能作为访问控制或自我批准机制；仅在提示词中要求“先询问”也无法形成可验证的安全边界。

## Decision

所有行动在执行前由确定性的授权组件判定为 `ALLOW`、`ASK` 或 `DENY`。模型只能提出语义行动及理由，不能批准自己、修改生效策略或把无 UI 的 `ASK` 自动升级为允许。

授权以语义行动为边界，而不是要求用户理解底层每次工具调用。一次性批准和长期授权都必须形成范围明确、可过期、可撤销、可审计的能力。Pi 的工具前置钩子可以作为运行时强制点，但产品授权状态和策略属于 Himawari Agent。

## Options Considered

### 仅靠系统提示词约束

- Benefits: 实现简单，交互自然。
- Costs: 无法形成确定性保证，模型可能忽略或误解约束。

### 每个底层工具调用都询问

- Benefits: 表面上控制最严格。
- Costs: 审批疲劳，用户难以判断调用序列的真实语义和副作用。

### 确定性语义授权

- Benefits: 可验证、可审计，并支持长期授权而不牺牲边界。
- Costs: 需要行动分类、策略引擎和审批状态机。

## Consequences

- Positive: 模型、工具和 UI 都不能绕过统一授权边界。
- Negative: 新能力必须提供准确的权限声明和副作用描述。
- Follow-up: Spec 必须定义授权请求、长期授权、等待、拒绝、过期和撤销状态。

## Links

- [SOURCE: docs/prd-v0.1.md#proactivity-and-authorization]
