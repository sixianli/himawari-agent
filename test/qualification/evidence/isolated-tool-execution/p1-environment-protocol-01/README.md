# P1 第一批：任务级环境身份、环境级占用与持久协议

日期：2026-09-25 UTC。对应[隔离执行实施计划的 P1](../../../../../docs/execution/plans/2026-09-24-isolated-tool-execution-plan.md#p1)。本批只做数据库记录、产品接口和协调服务，用来保证“同一轮对话里的多次工具调用共用一个隔离环境”在崩溃、响应丢失和并发时仍然记得清楚、不提前放行。容器后端要到 P2 才实现，所以这里的后端是测试替身（只模拟后端应答的测试程序），**不证明任何真实隔离**。

<a id="contents"></a>

## 目录

- [用词](#terms)
- [版本与输入](#inputs)
- [本批覆盖的行为](#coverage)
- [故障窗口](#fault-windows)
- [数据库与合同](#schema)
- [改前失败与反向检查](#red-runs)
- [验证命令与结果](#verification)
- [没有覆盖的范围](#gaps)

<a id="terms"></a>

## 用词

| 用词 | 意思 |
| --- | --- |
| Run（一轮） | 用户每发一条消息，产品就启动一个 Run，直到这条消息处理完 |
| 执行作业（`executionJobId`） | 一轮只有一个，本轮所有需要隔离环境的工具调用都挂在它下面 |
| 环境、第几个环境（`environmentGeneration`） | 执行作业下的隔离环境；权限变化或故障时换一个新环境，编号加一 |
| 环境级占用（`lease`） | 整个环境持有的工作目录占用登记；释放之前，会冲突的其他任务不能动这些目录 |
| 单次调用占用（`claim`） | 一次工具调用对具体文件的占用登记，调用结束就解除，比环境级占用更细 |
| 创建记录、停止记录（intent） | 调用后端创建或停止环境之前，先写进数据库的“准备做这件事”的记录 |
| 停止标记（stop fence） | 数据库里的递增编号；请求停止时加一，之后带旧编号的请求一律被拒 |
| 停止证明与释放回执 | 后端给出的“环境确实已整体停下”的记录；数据库接收后保存为不可修改的释放回执，同时释放环境级占用 |
| ACK | 停止请求已被后端收到的确认；它不是停止证明 |
| SRT 路线 | 现有生产执行方式：每次调用启动一个 Job Host 进程，用 SRT（`@anthropic-ai/sandbox-runtime`，进程级沙箱）运行工具 |

[↑ 返回目录](#contents)

<a id="inputs"></a>

## 版本与输入

- 基于提交 `2876c66`（分支 `claude/isolated-tool-execution`）加上本批改动；测试运行时本批改动尚未提交，提交后以本目录所在的提交为准。
- Node.js 22.22.3，macOS（Darwin 27.2.0），真实 SQLite（`better-sqlite3` 12.11.1，产品数据库的正式迁移和工作线程）。
- 测试夹具沿用现有的 `test/fixtures/sqlite-capability-invocation-fixture.ts` 和 `test/fixtures/production-sandbox-scope.ts`：真实的 Owner、Agent、部署控制权、Run、能力句柄和已消费的调用回执。没有凭据，也没有访问网络。

[↑ 返回目录](#contents)

<a id="coverage"></a>

## 本批覆盖的行为

测试文件：[`task-execution-environment.test.ts`](../../../../integration/task-execution-environment.test.ts)（12 项）、[`production-sandbox-environment-identity.test.ts`](../../../../integration/production-sandbox-environment-identity.test.ts)（2 项，其中 1 项是 P0 基线 1）、[`workspace-lifecycle-audit.test.ts`](../../../../integration/workspace-lifecycle-audit.test.ts) 新增 1 项、[`execution-environment.contract.test.ts`](../../../../../packages/execution-contracts/test/execution-environment.contract.test.ts)（4 项）、[`migration-engine.contract.test.ts`](../../../../../packages/persistence-sqlite/test/migration-engine.contract.test.ts) 新增 1 项。

| ITE | 本批验证的部分 | 对应测试 |
| --- | --- | --- |
| 01 同一 Run 共用环境 | 两次调用拿到同一个执行作业和环境，后端只创建一次；每次调用关联自己的回执；同一回执不能关联第二次调用；重新打开数据库后读回一致 | “shares one environment across calls of one Run…” |
| 02 不同任务不共享 | 另一个 Run 得到另一个执行作业和环境；把本轮的回执关联到别的 Run 的环境被拒绝（`EXECUTION_BINDING_CHANGED`）；重叠的工作目录被拒绝（`WORKSPACE_OCCUPIED`） | “never lets another Run use or overlap…” |
| 05 旧环境可能仍在写入 | 调用结束后环境级占用仍挡住其他任务；停止未确认时占用不释放；现有 SRT 路线的预约与环境级占用互相排斥（两个方向） | “keeps the environment lease after a call ends…”、“hands over…”、“keeps SRT reservations and task environment leases…” |
| 06 崩溃恢复（数据库部分） | 创建记录已发出但结果未知时保持“未知”，重启后按原记录核查并绑定，不重建 | “keeps the lease and never recreates…” |
| 11 迟到的 ACK | 释放回执接收后，迟到、重复的 ACK 和证明过期都不改变释放状态；再交一份新证明也不覆盖原回执 | “keeps an accepted release immutable…” |
| 12 新旧记录并存 | Schema 47 的写入程序被拒绝；没有释放回执时数据库拒绝释放环境级占用；环境定位写入后不能改；审计脚本能列出环境记录 | “prevents writers that do not know…”、迁移合同测试、审计测试 |
| 14 可替换后端 | 后端能力声明严格解析：缺少必需能力、出现未知能力、协议版本不同都拒绝，且拒绝时不写任何记录 | “rejects backends that are unavailable…”、合同测试 |

另外两项行为：
- **Run 结束前的核对**：主环境或网络辅助环境只要有一个没释放，Run 就不能结束（“keeps the Run from completing…”）。两个都释放后，挡住结束的变成夹具本身缺少助手回答这一条后续检查，说明资源检查已经放行。
- **权限上限的保存**：每个环境保存权限上限、每项能力的来源授权、决定来源和期限；换新环境的原因和被停掉的后台程序清单随停止记录保存。

[↑ 返回目录](#contents)

<a id="fault-windows"></a>

## 故障窗口

| 计划列出的窗口 | 测试中的做法 | 结果 |
| --- | --- | --- |
| 创建响应丢失 | 后端已经创建，但返回前连接断开，核查也连不上 | 环境记为“未知”，占用保留；再次请求不会重新创建；恢复连接后按原创建记录找到环境并绑定 |
| 创建失败且环境从未存在 | 后端拒绝创建 | 先加停止标记挡住迟到的创建，再接收后端的“从未创建”证明并释放；之后迟到的创建结果被拒绝；本轮下一个环境编号为 2，原因为故障 |
| 迟到的 create | 停止标记已加一之后，后端才返回创建结果 | 定位被记录，但环境不能再接收调用；停止流程用这个定位停止并取得证明 |
| 停止标记的竞争 | 两个停止请求同时到达 | 只有一个生效，停止标记只加一次；旧控制权的停止请求被拒绝（`PORT_NOT_AUTHORITATIVE`） |
| 换到下一个环境时的交接 | 上一个环境停止未确认时申请下一个 | 返回原环境、不建新环境，占用仍在；证明接收后才建出第 2 个环境；数据库规则也不允许在上一个未释放时插入下一个 |
| 旧写入方不认识新记录 | Schema 47 的写入程序、直接改表 | 迁移账本拒绝旧写入程序；没有释放回执的释放、修改环境定位都被数据库拒绝 |
| 停止证明接收后 ACK 到期 | 证明接收后一小时，ACK 才到达并重复一次，再交一份新证明 | 释放回执和释放时间不变，ACK 时间被记录；证明在接收时已过期的情况则被拒绝（`EXECUTION_STOP_UNCONFIRMED`） |

[↑ 返回目录](#contents)

<a id="schema"></a>

## 数据库与合同

- 迁移 [`0048_task_execution_environments.sql`](../../../../../packages/persistence-sqlite/src/migrations/0048_task_execution_environments.sql) 追加六张表：执行作业、环境、停止记录、环境级占用、调用关联、释放回执。旧表的含义和已发布迁移都不变。
- 数据库自带的保护规则：环境身份和已写入的定位不能改；停止标记不能倒退；加了停止标记后不能再发出创建；没有释放回执就不能释放占用或把环境标为已释放；释放回执不能改；上一个环境没释放不能插入下一个；未释放的环境不能删除。
- 合同 [`execution-environment-v1.ts`](../../../../../packages/execution-contracts/src/execution-environment-v1.ts) 定义环境身份、权限上限、后端能力声明（协议 `execution-backend.v1`）、环境定位和停止证明，全部严格解析，不补默认值。
- 产品接口 [`execution-backend.ts`](../../../../../packages/application/src/ports/execution-backend.ts) 定义后端的 capabilities、create、execute、inspect、stop、verifyStopped、destroy。本批只用到其中五项，execute 和 destroy 由 P2/P3 实现。
- 协调服务 [`task-environment-coordinator.ts`](../../../../../packages/application/src/services/task-environment-coordinator.ts) 负责：核对后端能力、保存创建记录后再调用后端、处理未知结果、停止并接收证明。生产组装没有接入它，也没有可用的新后端，所以新任务执行仍然关闭。
- 现有 SRT 路线的占用检查增加了一步：同一主机上未释放的环境级占用也算冲突。Run 结束检查增加一步：本轮所有环境都要有释放回执。
- 工作区历史占用只读核查脚本支持 Schema 48，新增 `environments` 分区；对应 Runbook 已同步。四个涉及数据库升级的 Runbook 增加了 Schema 48 的升级、备份和回退说明。
- 新增的调用超出环境上限时，数据库返回原因码 `EXECUTION_ENVELOPE_EXCEEDED`。这是给调用方判断“需要扩权并换新环境”的内部原因码，不直接显示给用户；扩权流程属于 P1 后续任务。

[↑ 返回目录](#contents)

<a id="red-runs"></a>

## 改前失败与反向检查

改前失败（均为实际运行）：
- 合同测试在合同模块存在之前运行，4 项全部失败。原因是导出不存在，这只证明测试在实现之前写好，不证明行为。
- Run 结束检查：先加测试再改检查。改之前，第一个断言失败：有未释放的环境时，Run 结束没有被“资源未释放”挡住，而是继续到后面的线程检查。这说明原检查不看环境。
- 审计脚本：数据库升到 48 版后、脚本修改之前，审计测试 17 项全部失败，错误是 `WORKSPACE_AUDIT_SCHEMA_UNSUPPORTED`。这说明只加迁移不改审计，审计工具会整体不可用。
- 协议测试第一次运行时 11 项全部失败，但原因是测试夹具写错（调用了夹具没有返回的对象），不是产品行为。修正夹具后，协议测试首次运行就全部通过，因此没有改前失败的记录。

为了确认这些首次就通过的测试确实能发现缺陷，逐项临时破坏实现后重跑，再按原样恢复（恢复后逐字节比对一致）：

| 临时破坏 | 失败的测试 |
| --- | --- |
| 现有占用检查不看环境级占用 | 协议测试 4 项，以及“SRT 预约与环境级占用互相排斥” |
| 删除“没有释放回执不能释放占用”的数据库规则 | “prevents writers that do not know…” |
| 同一环境内重叠的调用不再排队 | “keeps the environment lease after a call ends…” |

[↑ 返回目录](#contents)

<a id="verification"></a>

## 验证命令与结果

本批的针对性测试在开发过程中反复运行；下表是全部改动定稿后的最终一轮。测试套件在本机沙箱之外运行，因为沙箱禁止监听本机端口和套接字，会让 UDS、HTTP 类测试以 `listen EPERM` 失败；在沙箱内的那次运行已停止，结果作废。

| 命令 | 结果 |
| --- | --- |
| `npm run build` | 通过 |
| `npm run typecheck`、`npm run check:boundaries`、`npm run check:v0.2-coverage`、`npm run check:v0.2-invariants`、`npm run check:secrets`、`npm run check:ci-policy` | 全部通过 |
| 受跟踪文件和本批新文件的 `biome format` 与 `biome lint --error-on-warnings` | 通过。整仓 `npm run check` 的格式和 lint 两步各报 1 个错误，都来自原本就有、与本批无关的未跟踪文件 `docs/assets/control-center/2026-09-16-state-review/verify.cjs` |
| `npm run test:contracts` | 24 个文件，354 项通过 |
| `npm run test:unit` | 136 个文件，1953 项通过 |
| `npm run test:integration` | 89 个文件 1771 项通过；另外 2 个文件共 6 项没有运行，见下文 |
| `npm run test:e2e` | 1 个文件，3 项通过 |
| `npm run check:pi-compat` | 12 个文件，130 项通过 |
| `python3 <document-governance>/scripts/validate_docs.py --strict .` | 通过（5 个 Runbook 重新封存后） |

**没有运行的 2 个集成测试文件**：`installable-node-services.test.ts` 和 `production-http-composition-process.test.ts` 需要预先打好的安装包，只能经 `npm test` 提供（报错 `INSTALL_TEST_REQUIRES_PREBUILT_ARTIFACT`）。`npm test` 又要求先用 `npm run ci:tools` 准备 CI 工具目录，这一步会从 PyPI 等站点下载固定版本的工具，本批没有得到下载许可，因此没有运行。其中 `installable-node-services.test.ts` 本批只把期望的数据库版本号从 47 改为 48，这处改动没有经过实际运行。

改前失败和反向检查的运行只保留在开发过程中，没有单独留日志。

完整输出和 JSON 报告在 [`raw-logs.tar.gz`](raw-logs.tar.gz)。去掉了本机沙箱打印的、与测试无关的 `failed to copy trust settings of system certificate` 行。

[↑ 返回目录](#contents)

<a id="gaps"></a>

## 没有覆盖的范围

- **后端是测试替身。** 停止、证明和定位都是测试程序给的，不代表任何容器运行时的行为；真实后端和资格验证在 P2。
- **P1 其余四项未做**：环境权限上限规则的验收与实现、扩权分类、审批请求携带当前能力和会被停掉的后台程序、撤权或过期时缩小上限。
- ITE-02 要求的“拒绝并记入审计”：本批只有拒绝，没有写审计记录。
- 并发只验证了同一进程内同时到达的请求。产品数据库只允许一个写入进程，多进程并发写入由现有的状态目录锁挡住，本批没有另行测试。
- 没有接入生产路径，也没有从 Worker、Pi 或页面发起的端到端测试；这些属于 P3。

[↑ 返回目录](#contents)
