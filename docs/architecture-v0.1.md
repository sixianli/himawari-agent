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

当前代码包含九个 workspace 的公共入口，以及 `packages/domain` 中已实现的不可变身份、所有权工厂、Run 状态机、Agent 权威租约规则和稳定领域错误。尚无应用用例、持久化、基础设施适配器、Pi Session 创建、网络监听器或可启动服务。

实现范围来自已确认 Spec，并按当前 Plan 的 Task 1 和 Task 2 落地：[SOURCE: docs/execution/specs/2026-08-25-agent-foundation-design.md] [SOURCE: docs/execution/plans/2026-08-25-agent-foundation-plan.md#task-1-establish-repository-and-toolchain-contracts] [SOURCE: docs/execution/plans/2026-08-25-agent-foundation-plan.md#task-2-implement-immutable-identities-and-domain-state-machines]

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

领域层以不同的 branded string 类型表示 Owner、Agent、Thread、Session、Run、Turn、Trigger、幂等键、权威 holder 和权威 lease。工厂只接受 1–128 个字符的机器标识，不生成标识，也不依赖数据库、传输或 Node.js API。

实体的所有权链如下：

```text
Owner
  └── Agent
        ├── Thread
        ├── Session ── optional Thread
        └── Trigger ── optional Thread + IdempotencyKey
              Session + Trigger ── ownership check → Run
                                                    └── Turn
```

所有实体是冻结的只读值。Session 和 Trigger 只能关联同一 Owner/Agent 的 Thread；Run 要求 Session 与 Trigger 的 Owner/Agent 相同，且 Trigger 显式指定 Thread 时必须与 Session Thread 相同。没有 Thread 的 Trigger 可以在接纳过程中关联到新建 Session 的 Thread。

Run 从 `accepted` 开始，当前合法转换为：

```text
accepted → building_context | failed | cancelled
building_context → running | failed | cancelled
running → awaiting_approval | reconciling_external_result | completed | failed | cancelled
awaiting_approval → running | failed | cancelled
reconciling_external_result → completed | failed | cancelled
completed | failed | cancelled → no next state
```

因此 `running → awaiting_approval → running` 可以重复，而 `completed`、`failed` 和 `cancelled` 是不可再转换的终态。

Agent 权威租约是一个纯领域单槽位规则。同一 Agent 的同一 lease/holder 重申是幂等的；不同 lease 或 holder 同时声明会返回冲突；释放必须匹配当前 lease ID。当前模型不包含时间、到期、续租、fencing token 或持久化原子性，这些属于后续应用端口和适配器。

## Main Flows

当前可执行流程仍限于工程验证和纯领域转换：

```text
npm ci --ignore-scripts
  → format check
  → lint
  → strict TypeScript check
  → dependency-boundary check
  → selected Vitest project
```

unit 项目包含 Node.js 版本下限测试，以及身份格式、所有权、全部 Run 状态组合、重复审批等待、终态不可变和单一 Agent 权威租约测试。contracts、integration、e2e 和 Pi compatibility 项目已配置但尚无功能测试，使用 `--passWithNoTests` 作为空 workspace 基线。

## Backlog Links

- 当前后续实现顺序保留在活动 Plan 中，不另建重复 Backlog 项：[SOURCE: docs/execution/plans/2026-08-25-agent-foundation-plan.md]

## Decision Links

- Pi runtime adapter：[SOURCE: docs/adr/0001-pi-runtime-adapter.md]
- Single logical Agent authority：[SOURCE: docs/adr/0003-single-logical-agent-authority.md]
- Agent, Thread and Run identity model：[SOURCE: docs/adr/0013-agent-thread-run-memory-model.md]
- TypeScript and Node.js runtime：[SOURCE: docs/adr/0016-typescript-node-runtime.md]
- Workspace monorepo：[SOURCE: docs/adr/0017-workspace-monorepo.md]
