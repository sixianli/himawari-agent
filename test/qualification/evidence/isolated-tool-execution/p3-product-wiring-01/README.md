# P3 第三批：任务环境接入产品

日期：2026-09-26 UTC。对应[隔离执行实施计划的 P3](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p3)中“把任务环境接入产品的工具调用路线”这一项。本批分几步提交，本文按提交顺序记录每一步和对应的测试结果。

## 用词

| 用词 | 意思 |
| --- | --- |
| 任务环境 | 一轮对话（Run）专用的容器，本轮的工具调用都在里面执行，由 P1 的 `TaskEnvironmentCoordinator` 记录和管理 |
| 容器路线 | Worker 收到工具调用后，不再启动本机沙箱进程，而是在已绑定的任务环境里执行 Pi runner 的分支 |
| `resolve` 应答 | Worker 执行前向 Agent 询问本次调用范围时，Agent 通过本机认证通道返回的应答；本批在里面加了任务环境的绑定信息 |
| 单次调用的释放 | 某一次工具调用的占用被标记为释放；在容器路线里意思是这次调用的目录占用已由任务环境的 `lease`（目录租用记录）覆盖，并不表示容器已经停止 |

## 第一步：Worker 在绑定的任务环境里执行（提交 `a756946`）

- 合同：执行事实新增 `container` 类环境和 `task_environment` 类监督证据主体；`resolve` 应答新增 `environment` 字段，只允许主环境、且 owner、agent、run、主机、后端和创建意图都与执行计划一致。
- Worker：[`production-sandbox-execution-v2.ts`](../../../../../apps/execution-worker/src/production-sandbox-execution-v2.ts) 在计划的后端与配置的容器后端相同时走容器路线；只支持前台的 `read`、`bash`、`find`、`grep`、`ls`，其他情况明确拒绝。执行结果丢失时记为结果未知、资源失去监督，由 Agent 停止整个环境。
- 测试：[`task-environment-sandbox-execution.test.ts`](../../../../../test/integration/task-environment-sandbox-execution.test.ts) 10 项，[`sandbox-v2-container-route.test.ts`](../../../../../test/integration/sandbox-v2-container-route.test.ts) 11 项。
- 这一步新增了 `resolve` 应答的必填字段，Agent 和 Worker 必须一起升级。

提交后运行的 `npm test` 全部通过：contracts 379 项、unit 2022 项、integration 1802 项、e2e 3 项、pi-compat 130 项，报告在 [`npm-test-a756946.tar.gz`](npm-test-a756946.tar.gz)。

## 第二步：Agent 取得和停止任务环境（提交 `7c04b72`）

- Agent：[`production-task-environments.ts`](../../../../../apps/agent-service/src/production-task-environments.ts) 在工具调用的后端等于配置的容器后端时，经 `TaskEnvironmentCoordinator` 和 `RemoteExecutionBackend`（通过 Worker 连接远程操作环境的适配层）取得本轮的任务环境，并在 `resolve` 应答里把环境绑定交给 Worker；Worker 登记执行前，Agent 把这次调用挂到环境上，执行结束后标记完成。未配置任务环境时，这类调用直接以 `SANDBOX_TASK_ENVIRONMENT_UNAVAILABLE` 拒绝。
- 环境身份：每次调用仍保留自己的环境编号（数据库要求唯一），任务环境编号放在执行事实的 `taskEnvironmentId` 字段里传递。
- 目录占用：同一轮对话自己的主环境占用的目录，不再阻挡本轮后续的调用；其他轮次仍被阻挡。
- 停止：一轮对话结束或取消时，`stopRun` 带上原因（`run_finished` 或 `run_cancelled`）停止本轮全部环境。已预留但从未开始执行的容器调用，用新的释放证明 `task_environment_released` 解除预留；数据库只在该轮在此后端上的全部主环境都有释放回执、且证明列出的环境与记录一致时才接受。
- 测试：[`production-task-environment-route.test.ts`](../../../../../test/integration/production-task-environment-route.test.ts) 6 项，覆盖正常执行并在结束时释放、结果丢失时停止环境、两次调用复用同一环境、未配置时拒绝、取消时解除未开始的预留、环境仍在运行时拒绝伪造的释放证明。

提交后运行的 `npm test` 全部通过：contracts 379 项、unit 2022 项、integration 1808 项、e2e 3 项、pi-compat 130 项，报告在 [`npm-test-7c04b72.tar.gz`](npm-test-7c04b72.tar.gz)。
