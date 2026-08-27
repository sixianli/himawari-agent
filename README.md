# Himawari Agent

Himawari Agent 是一个本地优先、无头、长期个人记忆驱动的私人 Agent。Foundation Plan 的 Task 1 至 Task 20 已在确定性参考配置中完成；当前 portable durable web-agent Plan 已补齐模型路由、GitHub webhook/只读 monitor、持久 receipt 去重、浏览器 disclosure preview、真实进程恢复和规模资格的本地实现与证据。真实 paid model、GitHub/Cloudflare 账户、跨主机 transfer 和最终 production composition 仍按证据单独验收。

当前交付是可安装、可运行的架构验证平台，不是 production-ready 服务。Node runtime 已有 Agent Service、Execution Worker 和 admin CLI 的 `main`、受保护 UDS、持久 SQLite、doctor/db status 及信号 drain；最终公网 listener、生产 Vault/Memory/Model/GitHub 组合、真实远程 Worker 沙箱、地图/预订供应商和通知客户端仍未完成。默认 local composition 使用进程内参考适配器，退出后数据不会保留。完整边界和限制见 [Architecture v0.1](docs/architecture-v0.1.md)。

## Toolchain

- Node.js 要求：`>=22.19.0`
- npm 锁定工具版本：`11.8.0`
- 2026-08-27 Mac 验证基线：Node.js `v25.6.0`、npm `11.8.0`
- TypeScript：`5.9.3`
- Biome：`2.3.5`
- Vitest：`4.1.9`
- `@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`：`0.84.2`

安装锁文件中的依赖：

```bash
npm ci --ignore-scripts
```

正式依赖始终来自 npm 发布物。仓库不提交指向相邻 `../pi-mono` 的 `file:` 依赖；本地 Pi 源码学习只通过下面的 developer-local link 模式选择。

## Local reference composition

`apps/execution-worker` 和 `apps/agent-service` 同时公开程序化 process API 与可安装 `main`。参考启动顺序是先独立启动 Worker，再把它的 `execution.v2` client 注入前台 Agent Service；Agent process 不会隐式启动 Worker。启动诊断只包含 component、adapter identity、schema version 和 readiness，不包含 credential 或 Secret reference。

程序化组合用于自动化测试和本地架构验证；可安装入口使用受保护的 `execution.v2` UDS，但最终 public HTTP 组合尚未接入生产 `main`。可运行的生命周期、边界与规模验证是：

```bash
npm run test:unit -- local-execution-worker local-composition-root
npm run test:integration -- agent-gateway external-action-reconciliation
npm run test:e2e -- beef-restaurant
npm run qualify:scale
npm run build
```

安装已构建的 Node runtime 到绝对临时前缀：

```bash
tmp_prefix="$(mktemp -d)"
npm run install:node-runtime -- --prefix "$tmp_prefix"
"$tmp_prefix/bin/himawari" db status --config /absolute/path/configuration.json
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
| 内置 coding tool schemas 与可注入 Operations | `packages/coding-agent/src/core/tools/` |
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

## Portable durable web-agent qualification

`packages/integration-github` 的当前实现只允许 read-oriented GitHub capability：App private key、webhook secret 和短期 installation token 通过 host secret source，webhook 先做 raw-byte HMAC、安装/仓库 scope、事件 allowlist 和 rate/body 限制，再以 SQLite transaction 持久化 receipt、protected payload reference 与 occurrence。只读 mirror 使用 bounded content-addressed cache；离线只记录 coverage gap，预算不足产生 `BUDGET_BLOCKED`，不会 polling、history scan 或静默确定性过滤。

控制中心在启用仓库前显示 primary provider/model/version/ref、仓库范围和披露分类，并单独标出机器秘密排除；确认会随 `gateway.v2` 的 `github.monitor.set_state` 命令提交，服务端再次校验 Owner/Agent scope、CAS revision、模型/仓库/分类后才改变 monitor 状态。撤销会先停止 monitor 和对应 scheduler job、清理 bounded mirror，再把 Owner 选择的 retain/delete 交给 history policy port；真实生产组合、历史记录 durable 清理/保留 readback、GitHub App 安装、权限 readback、外部 webhook、Cloudflare public path 与 paid model 尚未验证。

规模切片可以用确定性临时 SQLite 重跑，精确生成 200,000 条消息、10,000 个 Thread、500,000 个 Run、100 个 active jobs 和 50 个仓库 monitor，并记录 query/search/approval/Memory/Trace/delete 与 snapshot transfer 的 p50/p95/p99：

```bash
npm run qualify:scale
```

这项命令会把生成数据和 snapshot 限制在临时目录并在结束时清理；当前结果见 [S1-T28 scale evidence](test/integration/qualification/evidence/s1-task28-scale.json)。Hermes 新隔离目录也已用同一源码/锁文件 runtime manifest 完成 Linux 构建和安装后服务资格测试，但 native 产物按平台分别构建；这些结果不代表 Mac/Hermes 双向 authority transfer、完整加密迁移、7 天 soak 或 production readiness。

## Validation

```bash
npm run check
npm run test:unit
npm run test:contracts
npm run test:integration
npm run test:e2e
npm run check:pi-compat
npm run qualify:scale
```

测试按文件名和目录分组：

- unit：`apps/**/*.unit.test.ts`、`packages/**/*.unit.test.ts`
- contracts：`apps/**/*.contract.test.ts`、`packages/**/*.contract.test.ts`
- integration：`test/integration/**/*.test.ts`
- e2e：`test/e2e/**/*.test.ts`
- Pi compatibility：`packages/runtime-pi/**/*.compat.test.ts`

普通 Vitest project 会跳过需要显式开关的规模资格测试；最终 fresh 测试数量、构建产物 checksum、SQLite 版本和外部 readback 以本轮命令及对应 qualification evidence 为准。E2E 覆盖完整牛肉餐厅参考旅程；integration 包含恢复矩阵、GitHub durable state、模型重复结果和安装后服务路径。除明确的 Hermes 主机只读盘点外，自动化测试不访问网络、付费模型、外部账户或生产凭据。

## Project documents

- 当前实现：[Architecture v0.1](docs/architecture-v0.1.md)
- 已关闭设计：[Foundation Spec](docs/archive/specs/2026-08-25-agent-foundation-design.md)
- 已完成计划：[Foundation Plan](docs/archive/plans/2026-08-25-agent-foundation-plan.md)
