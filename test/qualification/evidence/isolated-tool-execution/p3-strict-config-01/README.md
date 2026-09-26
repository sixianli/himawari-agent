# 严格模式配置：runner 摘要自动计算

日期：2026-09-27 UTC。对应[隔离执行实施计划的 P3 补充](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p3-modes)中“严格模式的配置尽量少”一项，要求见 [Spec 的两种执行模式](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#modes)。

## 用词

| 用词 | 意思 |
| --- | --- |
| 严格模式 | 配置里写了 `taskEnvironments` 段时，工具在每轮对话专用的 Docker 容器里运行 |
| runner 摘要 | 容器里固定的启动脚本、环境变量、工作目录和挂载的产品运行时算出的 SHA-256 值，用来确认容器按产品规定的布局启动 |
| 签名安装声明 | 安装时生成并签名的工具清单（capability 快照），其中每个沙箱主机绑定都写明产品运行时的摘要（`runtimeDigest`） |
| `dockerHost` | Docker 服务的连接地址 |

## 改了什么

- 配置（[`strict-configuration.ts`](../../../../../packages/platform-node/src/strict-configuration.ts)）：`taskEnvironments` 不再接受 `runnerDigest`，写了会以 `CONFIGURATION_UNKNOWN_FIELD` 拒绝启动；`dockerHost` 可以不写，不写等于 `null`，即使用 Docker 自己的默认连接。`backendRef`、Docker 程序绝对路径、执行镜像、出网代理镜像仍须填写，缺少时以 `CONFIGURATION_INVALID_VALUE` 拒绝。
- Agent Service（[`production-task-environments.ts`](../../../../../apps/agent-service/src/production-task-environments.ts)）：创建任务环境时，用本次调用的签名绑定里的 `runtimeDigest` 计算 runner 摘要，写进环境记录和发给 Worker 的创建请求。
- Worker（[`production-task-environment-backend.ts`](../../../../../apps/execution-worker/src/production-task-environment-backend.ts)）：去掉与配置值的比较和 `TASK_ENVIRONMENT_RUNNER_MISMATCH`；各绑定运行时不一致时仍以 `TASK_ENVIRONMENT_RUNTIME_AMBIGUOUS` 拒绝启动。容器后端创建环境时仍把请求里的 runner 摘要与自己算出的值比较，不同就拒绝，所以 Agent 与 Worker 算法不一致时仍会被挡住。
- 计算函数移到 [`container-runner.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/container-runner.ts)，由 Agent 唯一允许使用的 `@himawari-agent/runtime-sandbox/control` 入口转出；依赖边界规则没有改，Agent 仍不引入 SRT 或容器执行代码。

## 自动测试

| 测试 | 断言 | 结果 |
| --- | --- | --- |
| [`startup-configuration.unit.test.ts`](../../../../../packages/platform-node/test/startup-configuration.unit.test.ts) | 不写 `runnerDigest` 能解析；写了按未知字段拒绝；不写 `dockerHost` 得到 `null`；四个必填项分别缺少时拒绝 | [`unit.log`](unit.log)：与下一行合计 44 项通过 |
| [`production-task-environment-backend.unit.test.ts`](../../../../../apps/execution-worker/test/production-task-environment-backend.unit.test.ts) | 配置里没有 runner 摘要时 Worker 正常组装；原有的绑定缺失、运行时不一致检查不变；删除了“配置摘要与运行时不符”这一项，因为配置里已没有这个值 | 同上 |
| [`production-task-environment-route.test.ts`](../../../../integration/production-task-environment-route.test.ts) | 经生产准入流程和真实 SQLite，环境记录里的 runner 摘要等于用签名安装声明里的 `runtimeDigest` 算出的值；其余 5 项容器路线场景不变 | [`integration.log`](integration.log)：6 项通过 |

- 功能实现前，两项单元测试按预期失败：配置解析因缺少 `runnerDigest` 报 `CONFIGURATION_INVALID_VALUE`，Worker 组装报 `TASK_ENVIRONMENT_RUNNER_MISMATCH`。
- 集成测试的夹具要在 `/tmp` 下建临时目录，Claude 的命令沙箱不允许，所以由用户在本机终端运行：`npx vitest run --config vitest.workspace.ts --project integration test/integration/production-task-environment-route.test.ts --reporter verbose`。
- 代码版本：提交 `64ea356` 加本次改动（即本证据所在提交）。`npm run typecheck`、`npm run lint`、`npm run check:boundaries`、`npm run check:ci-policy`、`npm run check:secrets` 通过。日志去掉了终端颜色控制字符。

## 完整 npm test 第一次运行（提交 `39a454f`，失败）

由用户在本机终端运行 `npm test -- --output .ci-output/npm-test-39a454f`（`39a454f` 包含本次提交 `e155106`，之后只多了一个补交旧证据文件的提交）。结果：contracts 379、unit 2048、e2e 3、pi-compat 130 全部通过；integration 1829 项中 1 项失败，报告在 [`npm-test-39a454f-failed.tar.gz`](npm-test-39a454f-failed.tar.gz)。

- 失败的是 [`workspace-boundaries.test.ts`](../../../../integration/workspace/workspace-boundaries.test.ts) 的 “limits Agent imports to risk-reducing sandbox control”。它逐个列出 Agent 允许使用的 `@himawari-agent/runtime-sandbox/control` 入口导出了哪些名字，本次新增的 `containerRunnerDigest` 不在列表里。
- 这是本次改动造成的测试失败，不是环境问题。提交前运行的 `npm run check:boundaries` 只检查引用路径，不检查这个名单，所以没有发现。
- 处理：把 `containerRunnerDigest` 加进这份名单。它只按固定内容计算摘要，不启动、不控制任何进程，符合这个入口“只做降低风险的只读操作”的用途；此前加入 `readMachineBootId` 时（提交 `d5b22e9`）也是这样处理的。修改后该测试文件 217 项通过。

## 完整 npm test 第二次运行（提交 `bc6b134`，通过）

修复后由用户在本机终端运行 `npm test -- --output .ci-output/npm-test-bc6b134`，全部通过：contracts 379 项、unit 2048 项、integration 1829 项、e2e 3 项、pi-compat 130 项，报告在 [`npm-test-bc6b134.tar.gz`](npm-test-bc6b134.tar.gz)。控制台输出去掉了本机沙箱打印的、与测试无关的 `failed to copy trust settings` 行。

## 未验证的部分

- 没有用真实 Docker 走一遍严格模式；容器路线的真实安装资格本来就尚未完成。
- 严格模式下拒绝走 SRT 的工具（ITE-25）不在本次范围。
