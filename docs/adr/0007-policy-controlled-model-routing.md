---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# ADR 0007: 使用策略控制的模型路由

## Context

单一固定模型难以同时覆盖通用推理、编程、视觉、语音、隐私和可用性需求；完全由模型临时选择提供商又会导致行为、费用和数据披露不可预测。

## Decision

指定一个主要推理模型负责主 Agent 的整体判断、用户交互和最终回答。受限子任务可以由产品自有的模型路由策略选择专业、本地或备用模型。

路由候选必须经过系统批准，并考虑能力、数据等级、可靠性、延迟和费用。故障降级不能静默降低隐私等级或扩大数据发送范围。每次选择和调用都必须进入 Session Trace。

## Options Considered

### 始终使用单一模型

- Benefits: 行为和调试较一致。
- Costs: 无法充分利用专业、本地和备用能力，故障域集中。

### 由模型自由选择任意提供商

- Benefits: 表面灵活度最高。
- Costs: 隐私、费用和行为不可预测，模型可能绕过系统策略。

### 受策略控制的混合路由

- Benefits: 保持主行为一致，同时按需使用合适能力。
- Costs: 需要路由策略、兼容性评测和降级规则。

## Consequences

- Positive: 模型提供商和部署位置可替换。
- Negative: 同一任务跨模型的语义一致性需要评测。
- Follow-up: Spec 必须定义数据等级、路由请求、失败分类和不可降级条件。

## Links

- [SOURCE: docs/prd-v0.1.md#models-and-data-protection]
