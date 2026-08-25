---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# ADR 0005: 将长期记忆作为可替换外部能力

## Context

产品要求长期记忆主动参与判断，但 Mem0、OpenViking、知识图谱和未来方案都可能提供不同的数据模型、召回和更新语义。把产品领域直接建立在某一记忆供应商类型上会使迁移困难，并把讨论重新拉回已经成熟的存储内部实现。

## Decision

Himawari Agent 通过产品自有的记忆端口使用长期记忆服务。端口表达产品需要的写入、检索、纠正、删除、来源和上下文选择语义，不暴露供应商专有对象。

所有触发源都通过同一个上下文形成流程使用记忆。显式记忆工具和自动上下文检索可以并存，但最终注入内容、来源和后续写入都必须进入 Session Trace。

## Options Considered

### 自建完整记忆引擎

- Benefits: 对所有细节拥有控制权。
- Costs: 偏离 Agent 主体目标，重复成熟开源方案的工作。

### 直接采用单一供应商 SDK 类型

- Benefits: 初始接入代码少。
- Costs: 产品语义、迁移和测试被供应商 API 锁定。

### 产品端口加供应商适配器

- Benefits: 保持产品行为稳定，可并行评估和替换后端。
- Costs: 需要定义跨供应商可实现的最小语义。

## Consequences

- Positive: 记忆系统可以独立替换、迁移和对比评测。
- Negative: 某些供应商高级能力只能通过可选扩展暴露。
- Follow-up: Spec 必须定义检索请求、候选、选中上下文、写入建议和删除结果的产品语义。

## Links

- [SOURCE: docs/prd-v0.1.md#memory-and-context]
