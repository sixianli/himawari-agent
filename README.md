# Himawari Agent

Himawari Agent 是一个本地优先、无头、长期个人记忆驱动的私人 Agent。Foundation Plan 的 Task 1 至 Task 20 已在确定性参考配置中完成：产品身份与状态、Gateway/Execution contracts、应用端口、状态/outbox、完整 Trace、Permission/Grant、Capability/Worker、Memory、Model Router、Pi Runtime 投影、Run Coordinator、Scheduler、Attention、Agent Gateway、本地组合根、牛肉餐厅 E2E 和故障恢复矩阵。

当前交付是可编程的架构验证平台，不是生产服务。它没有网络 listener、`npm start` 守护进程、生产数据库/Memory/Vault、真实远程 Worker 沙箱、地图/预订供应商或通知客户端；默认 local composition 使用进程内参考适配器，退出后数据不会保留。完整边界和限制见 [Architecture v0.1](docs/architecture-v0.1.md)。

## Toolchain

- Node.js 要求：`>=22.19.0`
- npm 锁定工具版本：`11.8.0`
- 2026-08-25 本地验证基线：Node.js `v25.6.0`、npm `11.8.0`
- TypeScript：`5.9.3`
- Biome：`2.3.5`
- Vitest：`4.1.9`
- `@earendil-works/pi-coding-agent`：`0.84.2`

安装锁文件中的依赖：

```bash
npm ci --ignore-scripts
```

正式依赖始终来自 npm 发布物。仓库不提交指向相邻 `../pi-mono` 的 `file:` 依赖；本地 Pi 源码学习只通过下面的 developer-local link 模式选择。

## Local reference composition

`apps/execution-worker` 和 `apps/agent-service` 公开程序化 process API。参考启动顺序是先独立启动 Worker，再把它的 `execution.v1` client 注入前台 Agent composition；Agent process 不会隐式启动 Worker。启动诊断只包含 component、adapter identity、schema version 和 readiness，不包含 credential 或 Secret reference。

这两个入口当前用于自动化测试和本地架构验证，没有命令行 main 或网络 transport。可运行的生命周期与边界验证是：

```bash
npm run test:unit -- local-execution-worker local-composition-root
npm run test:integration -- agent-gateway external-action-reconciliation
npm run test:e2e -- beef-restaurant
```

关闭 Agent process 会先拒绝新请求，再等待登记的 in-flight Run settlement；Worker 由调用方单独关闭。`SecretPort`、Gateway Control Plane/Read Model 和 Worker client 都是显式注入边界，因此未来远程或持久适配器不需要修改 domain contracts。

## Local Pi source debugging

正常安装和 CI 始终使用 published `0.84.2`：

```bash
npm ci --ignore-scripts
npm run check:pi-compat
```

若同级目录存在同版本 `../pi-mono`，先只读检查版本与构建入口，再临时链接：

```bash
npm run check:local-pi
npm run link:local-pi
NODE_OPTIONS=--enable-source-maps npm run check:pi-compat
npm run unlink:local-pi
npm run check:local-pi
```

`link:local-pi` 和 `unlink:local-pi` 只管理 `node_modules` 中的 symlink、published backup 与 recovery state；运行前后都会验证 `packages/runtime-pi/package.json` 和 `package-lock.json` 哈希。若脚本发现版本不一致、构建入口缺失、unmanaged symlink 或 backup 冲突，会 fail closed。无论调试是否成功，结束时都应执行 unlink；最终 check 应显示 `mode: "published"`。

VS Code 可以用下列 launch 配置在 Vitest 中断进 sibling TypeScript source map：

```json
{
  "type": "node",
  "request": "launch",
  "name": "Himawari Pi compatibility",
  "cwd": "${workspaceFolder}",
  "program": "${workspaceFolder}/node_modules/vitest/vitest.mjs",
  "args": ["run", "--config", "vitest.workspace.ts", "--project", "pi-compat"],
  "sourceMaps": true,
  "outFiles": ["${workspaceFolder}/../pi-mono/packages/*/dist/**/*.js"],
  "resolveSourceMapLocations": [
    "${workspaceFolder}/../pi-mono/**",
    "!**/node_modules/**"
  ],
  "skipFiles": ["<node_internals>/**"]
}
```

适配器操作对应的上游源码如下：

| Adapter operation | `../pi-mono` source |
| --- | --- |
| `createAgentSession()`、tool allowlist、model/session 注入 | `packages/coding-agent/src/core/sdk.ts` |
| Session lifecycle、subscribe、abort、settled、compaction | `packages/coding-agent/src/core/agent-session.ts` |
| 内存 Session projection 与 entry tree | `packages/coding-agent/src/core/session-manager.ts` |
| provider/tool lifecycle hook 类型与分发 | `packages/coding-agent/src/core/extensions/types.ts`, `packages/coding-agent/src/core/extensions/runner.ts` |
| custom ToolDefinition 到 Agent tool 的包装 | `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts` |
| compaction result 生成 | `packages/coding-agent/src/core/compaction/compaction.ts` |
| Agent message/turn/tool event loop | `packages/agent/src/types.ts`, `packages/agent/src/agent-loop.ts` |
| 自动化测试使用的 faux provider | `packages/ai/src/providers/faux.ts` |

## Workspace boundaries

| Workspace | Responsibility | Allowed internal dependencies |
| --- | --- | --- |
| `packages/domain` | 领域身份、状态和不变量 | 无 |
| `packages/gateway-contracts` | `gateway.v1` 客户端协议 schema、类型与兼容性夹具 | 无 |
| `packages/execution-contracts` | `execution.v1` Worker 协议 schema、类型与兼容性夹具 | 无 |
| `packages/application` | 产品端口和 Gateway、Run/Worker、Trace、授权、Memory、Model、Scheduler、Attention、对账应用服务 | domain、两类 contracts |
| `packages/runtime-pi` | 产品 Agent Runtime 端口的 Pi 适配器 | application、固定版本 Pi |
| `packages/platform-node` | Node.js 基础设施适配器 | application、domain、两类 contracts |
| `packages/testing` | 可复用 conformance suites、确定性内存适配器、故障注入和 E2E fixture | application、domain、两类 contracts |
| `apps/agent-service` | in-process Gateway 与可信前台 local composition | application、contracts、runtime-pi、platform-node、testing reference adapters |
| `apps/execution-worker` | 独立 `execution.v1` Worker process 边界 | application、execution-contracts、platform-node；测试期使用 testing |

`npm run check:boundaries` 会检查根和 workspace 清单以及 TypeScript import，拒绝非精确的直接外部依赖、非法反向依赖、依赖环、未声明的内部依赖、逃出 workspace 根的相对 import、纯产品层的 `node:` import，以及 `packages/runtime-pi` 之外的直接 Pi import。

## Domain foundation

`packages/domain` 当前公开：

- Owner、Agent、Thread、Session、Run、Turn 和 Trigger 的 branded ID 工厂；机器标识必须以 ASCII 字母或数字开头，之后只能使用 ASCII 字母、数字、点、下划线、冒号或连字符，总长 1–128 个字符，且不会被自动规范化。
- 从 Owner 到 Turn 的冻结实体，以及 Session、Trigger 和 Run 创建时的所有权一致性检查。
- `accepted`、`building_context`、`running`、`awaiting_approval`、`reconciling_external_result`、`completed`、`failed`、`cancelled` Run 状态机。
- 每个 Agent 单槽位的逻辑权威租约规则：同一租约可幂等重申，第二个同时存在的租约会失败，只有当前 lease ID 可以释放。
- `DomainError` 和固定的 `DOMAIN_*` 机器错误码。

领域层不生成 ID、不读取时钟，也不持久化租约。参考适配器已在应用端口外侧实现租约到期、续租和 fencing token，并在 Task 5 的产品状态提交路径校验当前 fence；生产级持久化仍未实现。

## Protocol contracts

- `gateway.v1`：统一 Trigger admission，Thread 创建/关闭、Run 取消、审批响应，Thread/Run 快照与查询、Trace 查询、事件订阅和有序流事件。启动 Run 必须经过 Trigger admission。
- `execution.v1`：Worker 执行、取消和外部结果对账请求，以及进度、结果、取消确认和对账事件。
- 两类信封都显式携带 schema 版本、消息标识、correlation、causation、数据等级和产品 scope；改变状态的 Gateway 命令及全部 Worker 请求另带幂等键。
- wire payload 只承载稳定机器值和受控引用。大型或敏感内容、执行输入/输出、能力句柄和秘密都用引用表示；协议不公开 Pi runtime 类型或凭证明文。
- `gatewayMessageSchema` 与 `executionMessageSchema` 提供严格 `parse`、`parseJson` 和 `serialize`，并拒绝未知字段、未知版本及自相矛盾的执行结果。

## Application ports

`packages/application` 公开 State、Reliable Event、Product State Repository、Reliable Event Sink、Trace、Payload、Audit、Memory、Model、Agent Runtime、Runtime Projection/Tool、Capability、Secret、External Action Reconciliation、Scheduler、Attention、Gateway Access/Control Plane/Read Model、Authority Lease、Clock 和 ID Generator 端口。端口只依赖产品领域和契约类型，不公开数据库、供应商、传输或 Pi 对象。

Task 5 新增的提交路径具有以下语义：

- `RunStateCommitCoordinator` 使用领域状态机形成下一版 Run 状态，并把状态、命令结果和 outbox 事件交给一次原子提交。
- 新的 Agent 状态写命令必须携带当前 authority lease ID 和 fencing token；过期或已被替换的 fence 返回 `PORT_NOT_AUTHORITATIVE`，不产生部分写入。
- 幂等结果按 Owner、Agent 和 idempotency key 共同定址；相同 command type/fingerprint 返回原提交结果，不同命令复用同一键返回冲突，并发重复接纳也只产生一个状态版本和一个事件。
- `ReliableEventPublisher` 在提交后独立发布 pending 事件。投递前失败会保留 outbox；投递成功但标记失败会重投同一事件 ID，由 Sink 去重后完成标记。
- 新建协调器可以从同一个产品状态参考适配器恢复 Run 和 pending 事件，不读取或依赖 Pi Session 文件。

`packages/testing` 提供：

- `@himawari-agent/testing/conformance`：未来适配器可以复用的 Vitest harness 和行为 suite。
- `createReferenceAdapterSet()`：全部端口的隔离内存参考实现。
- `ManualClock` 和 `DeterministicIdGenerator`：可重复的时间与 ID。
- `DeterministicFailureScheduler`：按 checkpoint 和调用次数安排预写入失败，用于稳定重现崩溃/重试路径。
- `createBeefRestaurantFixture()`：固定 Owner/Agent/Thread/Run、Tokyo/牛肉偏好、模型、搜索、监控 Grant、预订和 37-event Session Trace 基准。
- `ScriptedExternalActionReconciliationPort`：以 reference-only lookup 验证 `result_unknown → work.reconcile → work.reconciled`。

这些适配器只用于测试和本地架构验证。内存 Product State Repository 提供可验证的 transaction/outbox 等价语义，但不提供跨进程生产耐久性、生产加密或进程隔离。

## Validation

```bash
npm run check
npm run test:unit
npm run test:contracts
npm run test:integration
npm run test:e2e
npm run check:pi-compat
```

测试按文件名和目录分组：

- unit：`apps/**/*.unit.test.ts`、`packages/**/*.unit.test.ts`
- contracts：`apps/**/*.contract.test.ts`、`packages/**/*.contract.test.ts`
- integration：`test/integration/**/*.test.ts`
- e2e：`test/e2e/**/*.test.ts`
- Pi compatibility：`packages/runtime-pi/**/*.compat.test.ts`

当前 fresh completion 基线为 101 个 unit、69 个 contract、71 个 integration、3 个 E2E 和 6 个 Pi compatibility 测试。E2E 覆盖完整牛肉餐厅参考旅程；integration 包含 8 类恢复矩阵和独立 external-action reconciliation。全部自动化测试使用确定性替身，不访问网络、付费模型、外部账户或生产凭据。

## Project documents

- 当前实现：[Architecture v0.1](docs/architecture-v0.1.md)
- 已关闭设计：[Foundation Spec](docs/archive/specs/2026-08-25-agent-foundation-design.md)
- 已完成计划：[Foundation Plan](docs/archive/plans/2026-08-25-agent-foundation-plan.md)
