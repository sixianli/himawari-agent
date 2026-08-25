---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# ADR 0009: 将 Agent 自我改进与生效信任根分离

## Context

具备编程和部署能力的 Agent 可以发现自身缺陷并生成改动。如果同一个运行中的 Agent 同时决定规则、修改规则、批准改动并部署改动，任何误判或攻击都可能永久改变权限和审计边界。

## Decision

Agent 可以分析问题、生成候选补丁、在隔离环境运行测试和评估，并准备可回滚版本；候选版本只有在所有者批准后才能进入正式运行环境。

身份认证、授权策略、秘密管理、审计记录、系统级行为约束和升级机制构成 Agent 无权自行修改或绕过的信任根。普通技能、工作流和人格偏好可以在明确授权范围内更灵活地调整，但不能间接改变信任根。

## Options Considered

### Agent 直接自我修改并上线

- Benefits: 改进闭环最快。
- Costs: 规则制定、执行和审批集中于同一不确定主体，难以恢复信任。

### 完全禁止 Agent 生成自身改动

- Benefits: 信任边界最简单。
- Costs: 放弃自动诊断、候选实现和持续评测能力。

### 可提出和验证但不可自行生效

- Benefits: 获得自我改进效率，同时保留人类控制和回滚。
- Costs: 需要隔离评测、发布审批和版本证据。

## Consequences

- Positive: 正式 Agent 不能通过修改自身绕过现有规则。
- Negative: 改进上线需要明确审批步骤。
- Follow-up: 后续 Spec 必须定义候选版本、评测证据、批准和回滚状态机。

## Links

- [SOURCE: docs/prd-v0.1.md#agent-topology-and-capabilities]
