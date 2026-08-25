---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# ADR 0012: 默认本地优先并保持云端可移植

## Context

私人 Agent 会持有完整个人资料、长期记忆、工具凭证和主动任务。所有者希望默认运行在自己控制的设备上，同时接受核心状态直接托管在第三方云中，因此系统不能把本地或云端任一位置写死为唯一模式。

## Decision

默认部署配置在所有者控制的设备或自托管服务器上。相同服务边界也必须支持第三方云托管，且部署位置变化不改变所有权、权限、Trace、数据分类和单一逻辑权威语义。

外部模型和云服务是可替换适配器。数据发送遵守最小披露规则。除非使用并验证了相应技术机制，托管模式必须明确把运行服务和云运营环境纳入真实信任边界。

## Options Considered

### 仅本地离线产品

- Benefits: 数据边界最直观。
- Costs: 无法满足持续在线、多设备和云托管需求。

### 仅第三方云 SaaS

- Benefits: 可用性和远程访问统一。
- Costs: 数据主权和自托管能力丢失，形成供应商锁定。

### 本地优先、部署位置可移植

- Benefits: 默认保护数据主权，同时支持云端可用性和迁移。
- Costs: 需要可移植配置、迁移、备份和密钥策略。

## Consequences

- Positive: 用户可以按信任和可用性需要选择部署位置。
- Negative: 不同部署配置必须通过同一兼容性和安全验证。
- Follow-up: 后续 Runbook 分别描述本地、自托管和云端操作，但不得改变产品语义。

## Links

- [SOURCE: docs/prd-v0.1.md#deployment-and-engineering-quality]
