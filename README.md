# Himawari Agent

Himawari Agent 是一个本地优先、无头、长期个人记忆驱动的私人 Agent。当前仓库已完成基础平台 Plan 的 Task 1 至 Task 3：TypeScript/Node.js workspace、包边界、测试分组、固定版本 Pi 依赖，不可变领域身份、所有权约束、Run 状态机和单一逻辑权威租约，以及首版 Gateway/Execution wire contracts。应用用例、持久化、Pi 运行时适配器和可启动服务尚未实现。

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

正式依赖始终来自 npm 发布物。仓库不提交指向相邻 `../pi-mono` 的 `file:` 依赖；本地 Pi 源码学习和可逆链接将在 Plan Task 12 中实现。

## Workspace boundaries

| Workspace | Responsibility | Allowed internal dependencies |
| --- | --- | --- |
| `packages/domain` | 领域身份、状态和不变量 | 无 |
| `packages/gateway-contracts` | `gateway.v1` 客户端协议 schema、类型与兼容性夹具 | 无 |
| `packages/execution-contracts` | `execution.v1` Worker 协议 schema、类型与兼容性夹具 | 无 |
| `packages/application` | 用例和产品端口 | domain、两类 contracts |
| `packages/runtime-pi` | 产品 Agent Runtime 端口的 Pi 适配器 | application、固定版本 Pi |
| `packages/platform-node` | Node.js 基础设施适配器 | application、domain、两类 contracts |
| `packages/testing` | 端口契约夹具和确定性测试替身 | application、domain、两类 contracts |
| `apps/agent-service` | Agent Gateway 和控制平面组合入口 | application、contracts、runtime-pi、platform-node |
| `apps/execution-worker` | 隔离执行工作进程入口 | application、execution-contracts、platform-node |

`npm run check:boundaries` 会检查根和 workspace 清单以及 TypeScript import，拒绝非精确的直接外部依赖、非法反向依赖、依赖环、未声明的内部依赖、纯产品层的 `node:` import，以及 `packages/runtime-pi` 之外的直接 Pi import。

## Domain foundation

`packages/domain` 当前公开：

- Owner、Agent、Thread、Session、Run、Turn 和 Trigger 的 branded ID 工厂；机器标识必须以 ASCII 字母或数字开头，之后只能使用 ASCII 字母、数字、点、下划线、冒号或连字符，总长 1–128 个字符，且不会被自动规范化。
- 从 Owner 到 Turn 的冻结实体，以及 Session、Trigger 和 Run 创建时的所有权一致性检查。
- `accepted`、`building_context`、`running`、`awaiting_approval`、`reconciling_external_result`、`completed`、`failed`、`cancelled` Run 状态机。
- 每个 Agent 单槽位的逻辑权威租约规则：同一租约可幂等重申，第二个同时存在的租约会失败，只有当前 lease ID 可以释放。
- `DomainError` 和固定的 `DOMAIN_*` 机器错误码。

领域层不生成 ID、不读取时钟，也不持久化租约；租约到期、续租、fencing token 和存储原子性属于后续应用端口及适配器任务。

## Protocol contracts

- `gateway.v1`：统一 Trigger admission，Thread 创建/关闭、Run 取消、审批响应，Thread/Run 快照与查询、Trace 查询、事件订阅和有序流事件。启动 Run 必须经过 Trigger admission。
- `execution.v1`：Worker 执行、取消和外部结果对账请求，以及进度、结果、取消确认和对账事件。
- 两类信封都显式携带 schema 版本、消息标识、correlation、causation、数据等级和产品 scope；改变状态的 Gateway 命令及全部 Worker 请求另带幂等键。
- wire payload 只承载稳定机器值和受控引用。大型或敏感内容、执行输入/输出、能力句柄和秘密都用引用表示；协议不公开 Pi runtime 类型或凭证明文。
- `gatewayMessageSchema` 与 `executionMessageSchema` 提供严格 `parse`、`parseJson` 和 `serialize`，并拒绝未知字段、未知版本及自相矛盾的执行结果。

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

unit 项目覆盖 Node.js 版本基线和 Task 2 的领域行为。contracts 项目已有 Gateway/Execution v1 的 JSON 兼容性、往返和非法输入测试。integration、e2e 和 Pi compatibility 命令目前仍以“没有测试文件”为成功基线，后续 Plan 任务必须逐步替换为真实验证，不能把当前空基线视为功能已实现。

## Project documents

- 当前实现：[Architecture v0.1](docs/architecture-v0.1.md)
- 已确认设计：[Foundation Spec](docs/execution/specs/2026-08-25-agent-foundation-design.md)
- 实施顺序：[Foundation Plan](docs/execution/plans/2026-08-25-agent-foundation-plan.md)
