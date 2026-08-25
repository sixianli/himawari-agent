---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# ADR 0001: 通过产品自有运行时适配层使用 Pi

## Context

Himawari Agent 需要复用 Pi 的模型、Agent 循环、会话、工具和扩展能力，同时保持产品领域模型、协议和长期演进独立。开发过程中还需要能够阅读和单步调试相邻的 `pi-mono` 源码。把产品直接写入上游仓库会混合产品逻辑与通用框架，直接暴露 Pi 类型则会让上游变化扩散到整个产品。

## Decision

Himawari Agent 保持为独立仓库，通过产品自有的 Agent 运行时端口和 Pi 适配器使用 `pi-coding-agent` SDK。产品领域层不直接依赖 Pi 类型。

开发环境允许将适配器连接到相邻的 `pi-mono` 源码以便跳转和调试；正式发布固定到明确的已发布 Pi 版本。仅当改动具有上游通用价值时才修改 `pi-mono`。如果 `pi-coding-agent` 的编码场景假设成为真实障碍，可以在不改变产品端口的前提下将适配器下沉到 `pi-agent-core`。

## Options Considered

### 直接在 pi-mono 中开发产品

- Benefits: 调试路径最短，可以直接访问所有内部实现。
- Costs: 产品与上游生命周期耦合，难以升级、发布和贡献通用改动。

### 独立产品直接使用 pi-agent-core

- Benefits: 运行时边界更小，产品控制力最大。
- Costs: 需要立即重建成熟的会话、模型认证、资源加载、Skills 和 Extensions 外壳。

### 独立产品通过自有适配层使用 pi-coding-agent

- Benefits: 复用完整 SDK，同时保持可替换边界和本地源码学习能力。
- Costs: 需要明确隔离编码 Agent 的默认工具和项目假设。

## Consequences

- Positive: 产品发布、数据模型和客户端协议不受 Pi 内部 API 直接支配。
- Positive: 可以逐步学习 Pi，并将真正通用的改进单独贡献上游。
- Negative: 需要维护一层适配代码和上游兼容性测试。
- Follow-up: 首个 Spec 必须定义运行时端口、错误映射、事件映射和本地源码调试方式。

## Links

- [SOURCE: docs/prd-v0.1.md#scope]
