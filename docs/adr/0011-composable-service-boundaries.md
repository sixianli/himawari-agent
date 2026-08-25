---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# ADR 0011: 按信任和故障边界拆分可组合服务

## Context

开发量不是系统架构的限制，但把每个模块机械拆成网络微服务会引入分布式事务、一致性和运维风险；把所有能力放入一个高权限进程又无法隔离不可信代码、秘密和高风险工具。

## Decision

系统先定义稳定的逻辑服务边界，再根据信任、故障、扩展和部署需求决定是否跨进程或跨节点。可信控制面组件在本地模式可以组合到一个前台进程；不可信执行和秘密管理从一开始保持隔离。

目标逻辑边界包括客户端网关、Agent 控制面、执行面、模型网关、记忆网关、调度和事件、Trace 和审计、秘密管理。边界之间使用产品契约而不是共享上游内部对象。

## Options Considered

### 所有功能单进程且无内部边界

- Benefits: 调用和部署最直接。
- Costs: 权限、故障和扩展互相耦合，后续拆分代价高。

### 一个模块一个微服务

- Benefits: 部署粒度最细。
- Costs: 无意义的网络边界、分布式事务和运维复杂度。

### 按信任和故障边界拆分、部署可组合

- Benefits: 保留本地简单部署，同时获得必要隔离和云端扩展能力。
- Costs: 需要明确进程内与进程间实现遵守相同契约。

## Consequences

- Positive: 架构不会因开发成本假设而牺牲长期边界，也不会引入无必要的分布式复杂度。
- Negative: 同一逻辑边界需要支持不同传输和部署适配。
- Follow-up: Spec 必须标记每个组件的信任级别、故障影响和本地组合方式。

## Links

- [SOURCE: docs/prd-v0.1.md#deployment-and-engineering-quality]
