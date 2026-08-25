---
status: active
document_type: architecture
version: "0.1"
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---

# Himawari Agent Architecture v0.1

## Current System

仓库当前实现是一个私有 npm workspace monorepo 基础。根工具链要求 Node.js `>=22.19.0`，以 npm `11.8.0` 管理锁文件，以 TypeScript `5.9.3` 做 strict、`erasableSyntaxOnly` 类型检查，以 Biome `2.3.5` 做格式和 lint，并以 Vitest `4.1.9` 提供 unit、contracts、integration、e2e 和 Pi compatibility 五个测试项目。

当前代码仅包含九个 workspace 的公共入口和一项工具链基线测试；尚无领域对象、应用用例、基础设施适配器、Pi Session 创建、网络监听器或可启动服务。

实现范围来自已确认 Spec，并按当前 Plan 的 Task 1 落地：[SOURCE: docs/execution/specs/2026-08-25-agent-foundation-design.md] [SOURCE: docs/execution/plans/2026-08-25-agent-foundation-plan.md#task-1-establish-repository-and-toolchain-contracts]

## Boundaries

允许的 workspace 依赖方向是：

```text
apps/* → application + contracts + selected adapters
platform-node → application + domain + contracts
runtime-pi → application + @earendil-works/pi-coding-agent
application → domain + product contracts
contracts → no internal dependency
domain → no internal dependency
testing → application + domain + product contracts
```

`scripts/check-boundaries.mjs` 从根和各 workspace 的 `package.json` 及 TypeScript import 构建依赖图，检查非精确直接外部依赖、非法方向、循环和未声明依赖。任何 `@earendil-works/pi-*` 依赖或 import 只能位于 `packages/runtime-pi`；domain、contracts 和 application 不能直接 import `node:` 模块。

`packages/runtime-pi` 直接固定 `@earendil-works/pi-coding-agent` `0.84.2`；提交的 manifest 和 lockfile 不引用相邻的 `../pi-mono`。该隔离边界落实了产品自有 Pi 适配层决策：[SOURCE: docs/adr/0001-pi-runtime-adapter.md]

## Data Model

尚未实现产品数据模型、状态机或持久化 schema。Task 1 只建立将来承载 domain、contracts、application 和 adapters 的编译边界。

## Main Flows

当前唯一可执行流程是工程验证：

```text
npm ci --ignore-scripts
  → format check
  → lint
  → strict TypeScript check
  → dependency-boundary check
  → selected Vitest project
```

unit 项目包含一项 Node.js 版本下限测试。contracts、integration、e2e 和 Pi compatibility 项目已配置但尚无功能测试，使用 `--passWithNoTests` 作为空 workspace 基线。

## Backlog Links

- 当前后续实现顺序保留在活动 Plan 中，不另建重复 Backlog 项：[SOURCE: docs/execution/plans/2026-08-25-agent-foundation-plan.md]

## Decision Links

- Pi runtime adapter：[SOURCE: docs/adr/0001-pi-runtime-adapter.md]
- TypeScript and Node.js runtime：[SOURCE: docs/adr/0016-typescript-node-runtime.md]
- Workspace monorepo：[SOURCE: docs/adr/0017-workspace-monorepo.md]
