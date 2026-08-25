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

当前代码包含九个 workspace 的公共入口、`packages/domain` 中已实现的不可变身份、所有权工厂、Run 状态机、Agent 权威租约规则和稳定领域错误，`packages/gateway-contracts` 与 `packages/execution-contracts` 中首版严格 wire schema，以及 `packages/application` 的产品端口和 `packages/testing` 的确定性内存参考适配器。尚无应用用例、生产持久化、基础设施适配器、Pi Session 创建、网络监听器或可启动服务。

实现范围来自已确认 Spec，并按当前 Plan 的 Task 1 至 Task 4 落地：[SOURCE: docs/execution/specs/2026-08-25-agent-foundation-design.md] [SOURCE: docs/execution/plans/2026-08-25-agent-foundation-plan.md#task-1-establish-repository-and-toolchain-contracts] [SOURCE: docs/execution/plans/2026-08-25-agent-foundation-plan.md#task-2-implement-immutable-identities-and-domain-state-machines] [SOURCE: docs/execution/plans/2026-08-25-agent-foundation-plan.md#task-3-define-versioned-gateway-and-execution-contracts] [SOURCE: docs/execution/plans/2026-08-25-agent-foundation-plan.md#task-4-implement-product-ports-and-adapter-conformance-suites]

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

`scripts/check-boundaries.mjs` 从根和各 workspace 的 `package.json` 及 TypeScript import 构建依赖图，检查非精确直接外部依赖、非法方向、循环、未声明依赖和逃出 workspace 根的相对 import。任何 `@earendil-works/pi-*` 依赖或 import 只能位于 `packages/runtime-pi`；domain、contracts 和 application 不能直接 import `node:` 模块。

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

## Wire Contracts

`packages/gateway-contracts` 发布 `gateway.v1` 产品协议。它包含统一 Trigger admission，Thread 创建和关闭、Run 取消、语义审批响应，Thread/Run 快照查询、Trace 分页查询、可恢复事件订阅，Thread/Run 快照和有序流事件。Run 只能由统一 Trigger admission 启动；Gateway 不提供绕过触发接纳的新建 Run 命令。

Gateway 信封携带消息标识、schema 版本、相关关系、可空因果关系、数据等级、Owner/Agent scope 和 actor。所有改变状态的命令另带幂等键。流事件以 `messageId` 作为事件标识，并携带 cursor、Session、可选 Thread/Turn、Run、父事件、严格正数 Run 内序号、事件时间、写入时间、事件类型和可空 Payload 引用。

`packages/execution-contracts` 发布 `execution.v1` Worker 协议。请求覆盖工作执行、取消和外部结果对账；事件覆盖进度、结果、取消确认和对账结果。所有请求包含幂等键，所有消息包含相关和因果标识、Owner/Agent/Run/Worker Run scope 及数据等级。工作执行只携带输入、委派上下文、短期能力句柄和秘密引用；结果和错误正文也通过引用或稳定机器码表达。

两类协议使用零外部依赖的运行时 schema，同时导出从 schema 推导的 TypeScript 类型。解析器要求精确字段、规范 UTC 毫秒时间戳、受限枚举和有界整数；未知字段、未知消息类型及不受支持的版本会返回带固定 `CONTRACT_VALIDATION_ERROR` code 和字段路径的错误。`public`、`private`、`sensitive`、`restricted` 是当前四个数据等级。v1 JSON 兼容性夹具固定首版 wire shape；在 v1 中添加未知字段不会被静默接受。

## Application Ports and Reference Adapters

`packages/application` 当前公开以下产品端口，不包含任何具体供应商、数据库、传输或 Pi 类型：

```text
StateStore          ReliableEvent      TraceStore       PayloadStore
AuditLedger         Memory             Model            AgentRuntime
Capability          Secret             Scheduler        Attention
AuthorityLease      Clock              IdGenerator
```

端口值使用领域 branded identity、产品数据等级、稳定引用、JSON 值、`Uint8Array` Payload 和产品事件。`ApplicationPortError` 提供固定 `PORT_*` 错误码，使冲突、缺失、重复、非法操作、已撤销句柄和测试注入故障可以由应用层稳定分类。Secret Port 只签发与 Owner、Agent、Run、用途、scope 和期限绑定的 opaque handle；Agent Runtime、Model 和 Capability 事件只传 Payload 引用与机器错误码。

`packages/testing` 的 `./conformance` 子路径导出可复用 Vitest suite。每个 suite 接收 adapter harness，所以未来数据库、供应商或远程适配器可以用自己的 setup/teardown 重跑同一行为契约。当前内存参考实现覆盖全部端口，并在读写边界做防御性复制；它们是确定性测试替身，不是生产持久化或安全边界。

测试控制包括 `ManualClock`、按 namespace 递增的 `DeterministicIdGenerator` 和按命名 checkpoint/调用次数触发的 `DeterministicFailureScheduler`。Authority Lease 参考适配器使用注入时钟处理到期、续租和单一 live lease，并在每次新 claim 时递增 fencing token。故障调度在 mutation 之前触发，使失败后的状态保持未写入并可确定性重试。

Task 4 没有实现跨 State 与 Reliable Event 的原子事务、outbox 发布恢复、完整 Trace/Payload 删除传播、实际记忆排序、模型路由策略、Capability 沙箱、Secret 原值解析、生产 Scheduler 或 Attention 策略；这些仍属于后续 Plan 任务。

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

unit 项目包含 Node.js 版本下限测试，以及身份格式、所有权、全部 Run 状态组合、重复审批等待、终态不可变和单一 Agent 权威租约测试。contracts 项目验证 Gateway/Execution v1 wire schema，并用 25 个可复用端口 conformance cases 与 3 个确定性控制测试验证全部内存参考适配器。integration、e2e 和 Pi compatibility 项目仍使用 `--passWithNoTests` 作为空 workspace 基线。

## Backlog Links

- 当前后续实现顺序保留在活动 Plan 中，不另建重复 Backlog 项：[SOURCE: docs/execution/plans/2026-08-25-agent-foundation-plan.md]

## Decision Links

- Pi runtime adapter：[SOURCE: docs/adr/0001-pi-runtime-adapter.md]
- Headless Agent Gateway：[SOURCE: docs/adr/0002-headless-agent-gateway.md]
- Single logical Agent authority：[SOURCE: docs/adr/0003-single-logical-agent-authority.md]
- Replaceable Memory boundary：[SOURCE: docs/adr/0005-replaceable-memory-boundary.md]
- Policy-controlled model routing：[SOURCE: docs/adr/0007-policy-controlled-model-routing.md]
- Governed Capability Registry：[SOURCE: docs/adr/0008-governed-capability-registry.md]
- Complete Session Trace：[SOURCE: docs/adr/0010-complete-session-trace.md]
- Composable service boundaries：[SOURCE: docs/adr/0011-composable-service-boundaries.md]
- Agent, Thread and Run identity model：[SOURCE: docs/adr/0013-agent-thread-run-memory-model.md]
- Central Attention Policy：[SOURCE: docs/adr/0014-central-attention-policy.md]
- Product state over Pi runtime projection：[SOURCE: docs/adr/0015-product-state-over-pi-runtime-projection.md]
- TypeScript and Node.js runtime：[SOURCE: docs/adr/0016-typescript-node-runtime.md]
- Workspace monorepo：[SOURCE: docs/adr/0017-workspace-monorepo.md]
