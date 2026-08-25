---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# ADR 0014: 集中管理主动结果的注意力策略

## Context

后台任务和外部事件会持续发现潜在有用信息。若每个客户端或模型自行判断是否打断，用户会收到重复、矛盾或过度频繁的通知；把所有结果都静默保存又无法实现主动服务。

## Decision

权威 Agent 服务统一把结果分类为 `SILENT`、`INBOX`、`DIGEST`、`NOTIFY` 或 `INTERRUPT`。Agent 可以提出相关性、紧急度和置信度，但确定性注意力策略结合长期授权、安静时间、设备状态、重复程度和频率限制决定最终交付级别。

客户端只负责按照统一交付请求呈现结果。立即打断仅允许用于所有者明确授权的高优先级条件。

## Options Considered

### 模型或客户端即时决定

- Benefits: 反应直接，适配单一客户端容易。
- Costs: 多端不一致，难以控制频率和打扰边界。

### 所有结果只进入被动历史

- Benefits: 不会打扰用户。
- Costs: 无法实现后台主动服务。

### 集中注意力策略

- Benefits: 主动性、安静时间和多端一致性可以统一治理。
- Costs: 需要优先级、去重、频率和交付状态模型。

## Consequences

- Positive: 新 UI 不需要重新实现主动性判断。
- Negative: 策略错误可能压低重要结果或产生不必要通知，需要可解释和可调试。
- Follow-up: Spec 必须定义注意力请求、去重键、交付确认和升级规则。

## Links

- [SOURCE: docs/prd-v0.1.md#attention-and-delivery]
