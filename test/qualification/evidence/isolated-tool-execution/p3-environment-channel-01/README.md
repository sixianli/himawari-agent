# P3 第一批：环境操作经 Agent–Worker 认证通道转发

日期：2026-09-26 UTC。对应[隔离执行实施计划的 P3](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p3)，是“Agent 在本轮第一次需要工具时创建主环境，Worker 后续调用复用它”这一项的前置部分。依据 Spec 的[组件职责与后端合同](../../../../../docs/execution/specs/2026-09-24-isolated-tool-execution-design.md#backend)：协调服务、数据库和 `lease` 留在 Agent 一侧；调用 Docker 的容器适配器在 Worker 一侧；两边沿现有 execution.v2 通道扩展版本通信，application 层不直接调用 Docker。

本批只加通道和两端的处理代码，产品里还没有装配它们，新任务执行仍然关闭。协调服务接入产品是第三批的内容。

## 用词

| 用词 | 意思 |
| --- | --- |
| execution.v2 | Agent Service 与 Worker 之间带版本的消息格式，经本机认证通道传输 |
| 防重复键 | 请求里的 `idempotencyKey`；Worker 看到同一个键的请求只执行一次 |
| 协调服务 | P1 做好的 `TaskEnvironmentCoordinator`，负责预留、创建、复用、停止和释放环境，并把状态记在 SQLite 里 |
| `ExecutionBackendPort` | application 层定义的执行后端接口，七个操作：`capabilities`、`create`、`execute`、`inspect`、`stop`、`verifyStopped`、`destroy` |

## 做了什么

- **合同** [`environment-operation-v2.ts`](../../../../../packages/execution-contracts/src/environment-operation-v2.ts)，登记在 [`contracts-v2.ts`](../../../../../packages/execution-contracts/src/contracts-v2.ts)：
  - 新增请求 `environment.operation.execute` 和结果事件 `environment.operation.result`。
  - 每种操作只接受自己的字段。环境身份、权限上限、定位信息、能力声明和停止证明复用 P1 的 `execution-environment.v1` 结构；结果按操作分别校验，停止证明必须覆盖全部五项。
  - 请求范围必须带 owner 和 agent；除了查询后端能力以外，还必须带 run 和 Worker run，并且和环境身份里的 owner、agent、run 完全一致，一轮对话不能操作另一轮的环境。
  - `execute` 必须带本次调用的授权引用；应用层接口的 `execute` 相应多了 `authorizationRef` 字段。
- **Worker** [`production-execution-worker.ts`](../../../../../apps/execution-worker/src/production-execution-worker.ts)：
  - 新增可选配置 `environments`（类型就是 `ExecutionBackendPort`，容器适配器可以直接传入）。
  - 收到请求后，和其他消息一样先核对就绪状态、控制权、截止时间和防重复键，再把字段一一转成对后端的调用，结果作为带游标的事件发回；后端报错时发出带原错误码的失败事件。
  - 没有配置时报 `WORKER_ADAPTER_NOT_REGISTERED`。`execute` 缺少授权引用时报新增的 `WORKER_AUTHORIZATION_REQUIRED`，不以空值代替。
- **Agent 一侧** [`remote-execution-backend.ts`](../../../../../packages/application/src/services/remote-execution-backend.ts)：`RemoteExecutionBackend` 实现 `ExecutionBackendPort`，协调服务不用改动就能用它。
  - 会改变状态的操作（`create`、`execute`、`stop`、`destroy`）的防重复键由环境编号和本次意图固定生成，重发时从先前的事件里取回结果，不会执行第二次；只读操作每次用新键。
  - 只接受请求编号、因果编号、关联编号、操作名和请求范围都对得上的结果事件；Worker 报失败时原样带出错误码；等不到结果或结果未知时报 `EXECUTION_ENVIRONMENT_RESULT_UNKNOWN`，由协调服务按“状态未知”处理。

调用参数和输出目前只以引用编号传递，Worker 一侧怎样读取参数、Agent 一侧怎样取回输出，留到第二批接入 runner 时实现。

## 测试

都是先写测试再实现，新测试在实现前都失败过。

| 测试 | 内容 | 结果 |
| --- | --- | --- |
| [`execution-v2.contract.test.ts`](../../../../../packages/execution-contracts/test/execution-v2.contract.test.ts) | 七种操作的请求和结果都能原样解析；12 种反例被拒绝 | 合同项目 145 项通过 |
| [`production-execution-worker.unit.test.ts`](../../../../../apps/execution-worker/test/production-execution-worker.unit.test.ts) | 没配置时拒绝；字段原样转给后端；重发不再调用；后端报错成为失败事件；过期请求不调用 | 16 项通过 |
| [`remote-execution-backend.unit.test.ts`](../../../../../packages/application/test/remote-execution-backend.unit.test.ts) | 消息字段和请求范围；重发取回旧结果；只读操作用新键；错误码、未知结果和他人事件 | 4 项通过 |
| [`task-execution-environment.test.ts`](../../../../integration/task-execution-environment.test.ts) | 新增两项：真实 SQLite 上的协调服务经远程后端和真实 Worker 调用后端，创建、复用、停止并释放环境；创建响应丢失时经 Worker 查询后登记，不重复创建 | 17 项通过 |

12 种反例逐一核对过拒绝原因，每一种都是被它针对的那条规则拒绝的，例如“请求范围和环境身份的 run 不一致”报的是 `$.scope` 上的范围不一致，而不是别的字段错误。

反向检查：临时让远程后端对会改变状态的操作也每次生成新键，2 项测试失败；临时去掉请求范围的核对，1 项测试失败；之后按 SHA-256 核对恢复了原文件。

其他：Worker 与传输相关的集成测试（`execution-worker-process`、`failure-recovery-matrix`、`external-action-reconciliation`）和 UDS 传输合同测试照常通过；`unit` 与 `contracts` 两个项目共 2388 项通过；`format:check`、`typecheck`、`lint`、`check:boundaries`、`check:ci-policy`、`check:v0.2-coverage`、`check:v0.2-invariants`、`check:secrets` 通过。

**正式的 `npm test`**：提交 `5a88eee` 之后在本机沙箱外运行，构建和测试两步都通过：contracts 368 项、unit 2020 项、integration 1781 项、e2e 3 项、pi-compat 130 项，没有失败或跳过。和上一次（`a15e4ba`）相比，contracts 多 13 项、unit 多 5 项、integration 多 2 项，正是本批新增的测试。报告在 [`npm-test-5a88eee.tar.gz`](npm-test-5a88eee.tar.gz)，安装包只记录了 SHA-256。

## 没有覆盖的部分

- 产品装配：Agent 用 `RemoteExecutionBackend`、Worker 按配置启用容器适配器，都还没有接入，第三批做。
- 调用参数和输出的读取，第二批做。
- Worker 的结果事件只保存在内存里，Worker 重启后丢失；Agent 那时会等到超时并按“状态未知”处理，由协调服务再查询环境。本批没有另测 Worker 重启。
- 真实容器上经通道的端到端运行，放到第三批和产品一起验证。

## 后续修正（2026-09-26）

第二批做完后发现，Worker 读写调用参数和输出的 Payload 方法，都绑定在某一次工具调用的授权上（`readInput(request)`、`writeOutput(request, …)`）。每次工具调用因此必须照旧走 `work.execute` 的 v2 流程（执行计划里本来就有 `backendRef` 和 `environmentId`），才能保留调用授权、回执、披露检查和执行记录。

如果环境通道再单独提供 `execute`，就成了一条绕开这些检查的平行路径。所以修正如下：

- 环境通道只保留生命周期操作：`capabilities`、`create`、`inspect`、`stop`、`verifyStopped`、`destroy`。带 `execute` 的环境请求，现在在合同层面就被当作未知操作拒绝。
- application 层新增 `ExecutionEnvironmentLifecyclePort`（执行后端接口去掉 `execute`）。协调服务和 `RemoteExecutionBackend` 都改用它。协调服务本来就不调用 `execute`。
- Worker 去掉 `execute` 分支，以及只为它加的错误码 `WORKER_AUTHORIZATION_REQUIRED`。

上文“测试”一节里，关于 `execute` 的那几项已相应调整。反例里保留了一条“带 `execute` 的环境请求被拒绝”。
