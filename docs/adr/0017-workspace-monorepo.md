---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# ADR 0017: 使用工作区 monorepo 组织产品核心

## Context

目标系统包含可组合服务、共享领域契约、Pi 适配器、测试工具和未来客户端 SDK。这些部分需要独立边界和发布可能性，但早期分散到多个仓库会增加跨仓库原子变更和兼容性管理成本。

## Decision

将 `himawari-agent` 组织为 TypeScript workspace monorepo。领域契约、应用服务、基础设施适配器和可部署入口分别作为工作区包；逻辑服务是否独立部署不由包是否位于同一仓库决定。

非 TypeScript 原生客户端未来可以独立仓库或独立工程存在，只依赖版本化的 Agent Gateway 契约。

## Options Considered

### 单一无边界应用包

- Benefits: 初始文件结构最少。
- Costs: 依赖方向和可部署边界容易退化为隐式约定。

### 从第一天使用多个仓库

- Benefits: 发布和所有权边界最强。
- Costs: 共享契约和原子重构需要跨仓库协调。

### 工作区 monorepo

- Benefits: 原子变更和共享验证方便，同时可以建立严格包边界。
- Costs: 需要依赖规则防止包之间形成循环或越层访问。

## Consequences

- Positive: 适合同时维护领域核心、Pi 适配器、服务入口和测试夹具。
- Negative: 必须通过检查工具执行依赖方向，而不是依赖目录命名。
- Follow-up: 首个 Plan 需要定义包边界和依赖约束验证。

## Links

- [SOURCE: docs/adr/0011-composable-service-boundaries.md]
- [SOURCE: docs/adr/0016-typescript-node-runtime.md]
