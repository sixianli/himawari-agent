---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# ADR 0003: 每个 Agent 只允许一个逻辑权威

## Context

同一个私人 Agent 可能从本地设备、服务器和云端访问。若多个实例可以独立写入记忆、执行定时任务和产生外部副作用，网络分区或离线运行会造成重复通知、重复预订、冲突授权和互相矛盾的状态。

## Decision

每个 Agent 身份在任意时刻只有一个逻辑权威。部署可以迁移、热备或故障切换，但只有当前权威实例能够提交长期状态和外部副作用。

非权威设备可以作为客户端、缓存或输入队列。离线输入可以稍后同步，但默认不能以同一 Agent 身份独立执行外部副作用。未来需要离线自治时，使用具有独立身份、明确权限和同步契约的从属 Agent，而不是同一身份多主写入。

## Options Considered

### 多主 Agent

- Benefits: 每个设备可完全离线自治。
- Costs: 需要解决无法普遍自动合并的行动、授权、定时任务和记忆冲突。

### 单一逻辑权威

- Benefits: 一致的行为责任、审批、调度和审计语义。
- Costs: 需要可用性、迁移、租约和故障切换机制。

## Consequences

- Positive: 避免同一 Agent 重复执行不可逆行动。
- Negative: 权威服务不可用时，部分能力只能排队而不能完成。
- Follow-up: 实现必须定义租约、幂等键、故障切换和外部行动对账。

## Links

- [SOURCE: docs/prd-v0.1.md#ownership-and-identity]
