# Himawari Agent

Himawari Agent 是一个本地优先、无头、长期个人记忆驱动的私人 Agent。当前仓库只完成了基础平台 Plan 的 Task 1：TypeScript/Node.js workspace、包边界、测试分组和固定版本的 Pi 依赖；领域状态机、应用用例、Pi 运行时适配器和可启动服务尚未实现。

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
| `packages/gateway-contracts` | 可序列化的客户端协议类型 | 无 |
| `packages/execution-contracts` | 可序列化的执行协议类型 | 无 |
| `packages/application` | 用例和产品端口 | domain、两类 contracts |
| `packages/runtime-pi` | 产品 Agent Runtime 端口的 Pi 适配器 | application、固定版本 Pi |
| `packages/platform-node` | Node.js 基础设施适配器 | application、domain、两类 contracts |
| `packages/testing` | 端口契约夹具和确定性测试替身 | application、domain、两类 contracts |
| `apps/agent-service` | Agent Gateway 和控制平面组合入口 | application、contracts、runtime-pi、platform-node |
| `apps/execution-worker` | 隔离执行工作进程入口 | application、execution-contracts、platform-node |

`npm run check:boundaries` 会检查根和 workspace 清单以及 TypeScript import，拒绝非精确的直接外部依赖、非法反向依赖、依赖环、未声明的内部依赖、纯产品层的 `node:` import，以及 `packages/runtime-pi` 之外的直接 Pi import。

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

Task 1 只包含一项 Node.js 版本基线单元测试。contracts、integration、e2e 和 Pi compatibility 命令目前以“没有测试文件”为成功基线，后续 Plan 任务必须逐步替换为真实验证，不能把当前空基线视为功能已实现。

## Project documents

- 当前实现：[Architecture v0.1](docs/architecture-v0.1.md)
- 已确认设计：[Foundation Spec](docs/execution/specs/2026-08-25-agent-foundation-design.md)
- 实施顺序：[Foundation Plan](docs/execution/plans/2026-08-25-agent-foundation-plan.md)
