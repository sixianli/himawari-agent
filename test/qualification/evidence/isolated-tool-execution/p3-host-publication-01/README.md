# 严格模式下由宿主一侧发布文件

日期：2026-09-27 UTC。对应[隔离执行实施计划的 P3 补充](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p3-modes)中“严格模式下的固定目标文件发布”一项（原 C3），做法按 [ADR 0033](../../../../../docs/adr/0033-process-sandbox-default-and-optional-containers.md#decision) 中用户批准的方案：发布不进容器、不运行命令，由 Worker 在宿主一侧完成，但登记在本轮任务环境名下。

## 用词

| 用词 | 意思 |
| --- | --- |
| 严格模式 | 配置里写了 `taskEnvironments` 段时，所有工具都必须经每轮对话专用的容器（任务环境）执行 |
| 准备好的候选 | 写入或编辑在准入前就生成好的新文件内容和结果（`pi-coding-tool` 版本 `3`，范围里的 `preparedFile`）；发布时只把它放到目标位置，不再运行模型给出的工具 |
| 环境级 `lease` | 任务环境对整个工作目录的占用，挡住其他任务在同一目录上的调用 |
| 停止标记 | 任务环境收到停止请求后写下的文件；写下后该环境不再接受任何调用 |
| SRT 路线 | 默认模式：每次调用启动一个 Job Host 进程，在本机进程级沙箱（`@anthropic-ai/sandbox-runtime`）里运行工具 |

## 改了什么

- 共用的发布程序（[`pi-host-publication.ts`](../../../../../packages/platform-node/src/files/pi-host-publication.ts)）：把 SRT 路线 runner 里写入/编辑候选发布、另存副本、移动目录三段代码原样移到 `platform-node`，两条路线共用，输出格式和私有目录（`<privateRoot>/<jobId>`）不变，所以 Agent 一侧的核对和恢复不用改。[`pi-coding-main.ts`](../../../../../apps/agent-service/src/capability-programs/pi-coding-main.ts) 改为调用它，[`pi-foreground-result.ts`](../../../../../apps/agent-service/src/capability-programs/pi-foreground-result.ts) 只负责把结果写到标准输出。
- 容器后端（[`container-execution-backend.ts`](../../../../../packages/runtime-sandbox/src/execution-backend/container-execution-backend.ts)）新增 `publishOnHost`：先登记“发布进行中”，再依次检查停止标记、期限、容器身份未变、磁盘保护、容器在运行，然后用 `wx` 写下本次调用的开始标记（同一调用第二次发布即拒绝），执行发布，写下结果摘要。发布进行中时 `verifyStopped` 和 `destroy` 以 `CONTAINER_NOT_STOPPED` 拒绝，所以不会在发布途中给出“已停止”的证明。
- Worker（[`production-sandbox-execution-v2.ts`](../../../../../apps/execution-worker/src/production-sandbox-execution-v2.ts)、[`production-task-environment-backend.ts`](../../../../../apps/execution-worker/src/production-task-environment-backend.ts)）：容器路线接受版本 `3`（写入、编辑，且必须有候选和固定目标）、`4`（移动目录）、`5`（另存副本）三种 `verified_effect` 契约；在 Worker 进程内发布（不另起子进程，这样 Worker 崩溃时发布也一起终止，不会有脱离管理的发布进程），用与 SRT 路线相同的 `verifyPiWriteEvidence` 核对输出：成功记为结果、效果已核验；目标文件已被改动记为 `FILE_VERSION_CONFLICT`、效果已核验（确定没写）；发布被拒、回复丢失或输出核对不过都记为结果未知、效果未知，随后沿用已有步骤停止环境。没有候选的写入（版本 `2`）仍然拒绝。
- Agent（[`production-sandbox-services.ts`](../../../../../apps/agent-service/src/production-sandbox-services.ts)）：取得任务环境时改用整个工作目录的占用，而不是单个文件的占用；单次调用仍按自己的文件占用登记，并须被环境级 `lease` 覆盖。
- [安装与启停 Runbook](../../../../../docs/runbooks/install-start-stop-runbook.md) 补写这三类发布在严格模式下的行为；它和另外三个以这些文件为来源的 Runbook 一起重新核对并封存。

## 自动测试

| 测试 | 断言 | 结果 |
| --- | --- | --- |
| [`production-task-environment-route.test.ts`](../../../../integration/production-task-environment-route.test.ts) 新增 5 项 | 经真实 Agent 准入、真实 SQLite 和真实 Worker（容器由测试替身代替）：候选写入由宿主发布、不在容器里执行、交给后端的只有环境身份、停止编号、调用编号和期限，文件内容变为候选，结果和效果已核验，资源释放并带任务环境的释放依据；发布前用户改了文件时保留用户内容并记为版本冲突；环境拒绝发布时不写文件、结果未知；回复丢失时效果未知；没有候选的写入在容器路线被拒绝、文件不变 | [`focused.log`](focused.log)：与下几行合计 12 个文件 213 项通过 |
| [`container-execution-backend.unit.test.ts`](../../../../../packages/runtime-sandbox/test/container-execution-backend.unit.test.ts) 新增 4 项 | 发布只执行一次且不调用 `docker exec`，第二次以 `CONTAINER_IDENTITY_CONFLICT` 拒绝；期限已过、容器被替换、容器重启过、已停止四种情况都不调用发布；发布进行中停止证明被拒绝，发布结束后才给出；与停止同时发生时，要么发布被拒，要么发布完成后才能证明已停止 | 同上 |
| [`production-task-environment-backend.unit.test.ts`](../../../../../apps/execution-worker/test/production-task-environment-backend.unit.test.ts) 新增 1 项 | Worker 交给后端的只有环境目标和发布动作，不带授权编号 | 同上 |
| SRT 路线已有测试：[`prepared-file-runner.test.ts`](../../../../integration/prepared-file-runner.test.ts)、[`production-copy-save.test.ts`](../../../../integration/production-copy-save.test.ts)、[`production-sandbox-lineage.test.ts`](../../../../integration/production-sandbox-lineage.test.ts)、[`production-queued-run-restart.test.ts`](../../../../integration/production-queued-run-restart.test.ts)、[`production-coding-workflow.unit.test.ts`](../../../../../apps/agent-service/test/production-coding-workflow.unit.test.ts)、[`sandbox-v2-container-route.test.ts`](../../../../integration/sandbox-v2-container-route.test.ts) | 发布代码搬到共用模块后，SRT 路线的写入、冲突、另存副本、移动目录、重启恢复断言不变 | 同上 |
| [`production-sandbox-environment-identity.test.ts`](../../../../integration/production-sandbox-environment-identity.test.ts)（未改动） | 同一目录上 SRT 预约与任务环境占用互相排斥（两个方向） | 同上 |

- 功能实现前，新增测试按预期失败：路由测试 5 项全部在取得任务环境时以 `SANDBOX_TASK_ENVIRONMENT_UNSUPPORTED` 失败（[`integration-route-before.log`](integration-route-before.log)）；后端测试 4 项因 `publishOnHost` 不存在失败（[`unit-backend-before.log`](unit-backend-before.log)）。
- 失败记录之后对路由测试做了两处调整：一是版本冲突一项里用户改文件的时间，从“准备之后”挪到“发布之前”。准备之后、Worker 核对之前改文件，Agent 会在核对时直接拒绝、什么都不执行，这是已有行为，SRT 路线相同，所以那样测不到冲突分支。二是写入各项把 `Date` 固定为夹具时间，因为发布程序和 SRT runner 一样按系统时钟检查目录授权是否过期，而夹具时间在 8 月。两处都不改变“实现前失败”的原因。
- 代码版本：提交 `ac2e50e` 加本次改动（即本证据所在提交）。`npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run check:boundaries`、`npm run check:ci-policy`、`npm run check:secrets` 通过。日志去掉了终端颜色控制字符和本机沙箱打印的 `failed to copy trust settings` 行。
- 重跑：`npx vitest run --config vitest.workspace.ts test/integration/production-task-environment-route.test.ts packages/runtime-sandbox/test/container-execution-backend.unit.test.ts apps/execution-worker/test/production-task-environment-backend.unit.test.ts`（集成夹具要在 `/tmp` 下建目录、监听本机端口，须在本机沙箱之外运行）。

## 完整 npm test

- 提交 `02dbfc6`：由 Claude 在本机运行 `npm test -- --output .ci-output/npm-test-02dbfc6`，运行期间没有改动工作区。unit 有 10 项失败，其余通过：contracts 380、unit 2059/2069、integration 1852、e2e 3、pi-compat 130，报告在 [`npm-test-02dbfc6-failed.tar.gz`](npm-test-02dbfc6-failed.tar.gz)。10 项都在 [`pi-coding-program.unit.test.ts`](../../../../../apps/agent-service/test/pi-coding-program.unit.test.ts)，属于测试缺陷，不是产品缺陷：这个测试把整个 `@himawari-agent/platform-node` 换成只含两个函数的替身，而本次把结果格式化和 `isPiHostPublication` 移进了 `platform-node`，替身里没有它们，runner 在测试里一开始就出错。修正方法是保留真实的 `platform-node`，只替换它原来就替换的两个边界（沙箱文件操作和完整输出导出），断言不变；修正后该文件 84 项通过。这个文件不在上面的重点测试里，是完整运行才发现的。
- 提交 `b95a76b`（上述测试修正）：由 Claude 在本机运行 `npm test -- --output .ci-output/npm-test-b95a76b`，运行期间没有改动工作区，全部通过：contracts 380、unit 2069、integration 1852、e2e 3、pi-compat 130，报告在 [`npm-test-b95a76b.tar.gz`](npm-test-b95a76b.tar.gz)。这次运行覆盖 `02dbfc6` 的全部产品改动。托管的 GitHub 检查没有运行（`hosted gate: not_executed`）。

## 未验证的部分

- 路由测试里的容器是测试替身，没有在真实 Docker 上跑过严格模式的发布；后端测试用的是模拟的 `docker` 命令。
- 另存副本和移动目录在容器路线上只有契约和范围检查，没有单独的产品路径测试；它们的发布代码与 SRT 路线共用，由上面的 SRT 测试覆盖。
