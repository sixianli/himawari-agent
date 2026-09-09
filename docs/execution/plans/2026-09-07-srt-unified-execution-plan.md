---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-09-07"
---

# Pi 工具复用与 SRT 受管理执行实施计划

**来源 Spec：** [SOURCE: docs/execution/specs/2026-09-07-srt-unified-execution-design.md]

**已批准决定：** [SOURCE: docs/adr/0025-pi-tools-and-managed-execution-lifecycles.md]

**目标：** 在现有 Pi、Capability、Grant/Handle、Worker 和 SQLite 权威上实现通用工具执行；分别管理操作结果、副作用、后台任务/服务和环境释放，交付本次文件/编码、Shell、后台任务、联网与 Web Search。

2026-09-09 按 Owner 已批准方案重排实施任务。本文 R1–R12 是当前执行顺序，替代原 Task 3–10 未完成待办；不将历史 v1 组件测试勾选成 v2 完成。设计重排提交仅修改文档；随后按 Owner 指令完成 R1 的合同、端口和纯判断函数。当前范围内的后续任务仍待实施；R7、R10 已按 Owner 指令移出本次范围，未执行真实外部动作。原 Task 1–2 设计和 v1 组件交付事实保留在历史验证段；两项能力仍是后续产品需求，不计入本批完成条件。

## 当前基线与复用边界

| 已有内容 | 当前证据与后续使用 |
|---|---|
| Pi 0.84.2 的工厂及按调用 Operations | 保留 `createGovernedPiCodingTools`、`createPiOperationsFromGovernedHostPort`、`executeGovernedPiRead`；补齐 runner 和模式，不再设计工具身份库 |
| Capability invocation、授权、文件 context 和保护结果 | 是调用身份及授权来源；补其他能力 scope 投影，不能因单条 event 缺字段就重做存储 |
| sandbox-execution.v1、原子准入/启动、SQLite 0027 | 保留历史读回及原意；v2 使用追加迁移，不改旧 migration 或伪造已消费凭证 |
| SRT 0.0.75、Job Host、scope/host verifier、UDS 和 Worker 组合 | 组件已存在且 root scope 目前仅 inspect/read；v1 对已启动任务始终 cleanup/effect unknown，不是正常成功链路已完成 |
| 恢复核查 | 已能保留隔离且不重放；仍须实现环境/目录占用与可消除风险的核查，不把重新创建 Worker 的测试当真正进程崩溃 |
| Mac 受控探针 | 已有策略、资源阈值、取消及隔离不重放证据，仍为 productionSuitable:false；不自动转换为 v2 或安装资格 |
| Pi SRT/SSH/Gondolin 示例 | 用作接口和风险依据；不直接安装或复制回退/默认权限；Gondolin 后端不在当前实施关键路径 |

产品需求保留；本次实施范围按 Owner 指令排除 MCP 接入与 GitHub 已有 commit 推送。Runbook 仍对应现有二进制和旧运行合同，R1 新增类型端口后已核对安装 Runbook 的 v1 运行边界，操作步骤不变；其选定源码变化需要重新计算静态 seal。架构记录当前实现与目标差距，历史图保留并注明时间，目标图使用仓库内 Mermaid。

## 文件与调用方边界

| 责任 | 实际入口/改动位置 | 迁移要求 |
|---|---|---|
| Pi 定义和执行 | `packages/runtime-pi/src/governed-coding-tools.ts`、`governed-host-operations.ts`、`pi-runtime-adapter.ts`、`governed-read-executor.ts` | 只有 runtime-pi 导入 Pi；Agent 只接纳请求，实际工具算法进受限 runner |
| 产品合同 | `packages/execution-contracts/src/sandbox-execution-v1.ts`、同目录 `sandbox-execution-v2.ts` 及导出；`packages/application/src/ports/sandbox-execution.ts` | v1 只保留原解释；v2 结果/效果/资源严格区分，外层 execution.v2 不被混淆 |
| 授权来源 | `apps/agent-service/src/production-runtime-tools.ts`、`production-file-read-workflow.ts`、`production-sandbox-services.ts`；既有 Worker 准入/委托服务 | 沿既有服务补能力投影、父范围和同 Grant 检查，不重建准入框架 |
| 生命周期与恢复 | `packages/application/src/services/sandbox-job-lifecycle-service.ts`、现有 RuntimeContinuationService/RunCoordinator；生产恢复入口 | 独立判断结果/续接/资源释放；核查没有启动能力，Run 状态复用 |
| SQLite 权威 | `packages/persistence-sqlite/src/sqlite-capability-invocation-operations.ts`、现有作业实现及下一条 migration | 原子身份关联、观察 CAS、资源占用和有界分页；不改 0020/0027 |
| Worker/认证通道 | `apps/execution-worker/src/production-sandbox-execution.ts`、`production-sandbox-worker.ts`、`broker-sandbox-execution.ts`、`production-payload-broker-client.ts`；Agent `production-payload-broker-handler.ts` | 版本匹配、任务管理请求与保护输出；Worker 无数据库准入 authority |
| SRT/Job Host | `packages/runtime-sandbox/src/job-host*.ts`、策略/资源观测模块；`apps/execution-worker/src/product-job-host.ts` | 每权限固定环境一 manager，完整观察与停止，不自动放宽 unknown |
| 受限程序 | `apps/agent-service/src/capability-programs/host-file-read*.ts`、HostFileReadService；拟新增同安装体系的 coding runner | 复用真实 Pi；搜索器、临时文件、图片等隐含 I/O 都受限 |
| 工作区与既有入口 | `packages/platform-node/src/capabilities/node-capability-runtime.ts`、`isolation.ts`、workspaces 与 candidate-workspace 模块 | 审查 program/Git/archive/tar/import/export 的全部调用方；MCP 仅保留既有入口的安全归属，不实施接入 |
| 外部工具 | `packages/integration-web`、WebCapabilityService、既有 host secret source | 真实搜索 provider、页面核实和披露；不增加专用 Git 传输 |
| 展示/安装 | `apps/control-center` 的现有 Run/Trace/工具结果视图；`scripts/package-node-runtime.mjs`、主机资格加载器/验证器、边界/覆盖检查及现有 Runbook | UI 分别显示结果和资源异常；资格按 mode/主机；新实现后语义核对 Runbook |

## 依赖顺序

`R1 合同 → R2 持久化 → R3 准入与版本 → R4 监督与核查 → R5 前台工具 → R6 后台任务`。

`R8 联网` 依赖 R3–R5，可与 R6 的不冲突部分分别推进；`R9 Web` 依赖 R5/R8 及已有适配；`R11 产品验收` 汇集 R5、R6、R8、R9；`R12 安装与交付` 汇集本次全部有效任务。顺序表示技术依赖，不自动创建并行任务。

**R7（MCP 接入）与 R10（GitHub 已有 commit 推送）移出本次范围，保留编号，不取消产品需求。** 对应 EX-08、EX-16 不计入本批验收、依赖或关闭条件，其余编号不变。后续另行制定 Spec/Plan；本批不实现或验收 MCP 协议/工具接入和专用 GitHub 推送通道。R1 已有通用 service/remote 合同和测试保留；后台任务、非 MCP 测试服务、授权联网及 Web Search 仍须交付。

## 实施任务

### R1：完成事实与模式合同（已完成）

依据 Spec §2、§3.2–3.4、§4，验证 EX-01、EX-06–EX-10、EX-12。

- [x] 先以只读、写入、前台 Shell、后台启动、MCP 多请求及取消未知六种调用绘制合同测试输入/期望，明确结果发布、续接、环境复用、Run 完成的不同判定。
- [x] 新增 sandbox-execution.v2 严格 schema 与现有端口升级；保留 v1 parser 及旧读回，拒绝 mode/result/readiness 分支混用、任意句柄/输出、跨调用和策略摘要替换。
- [x] 定义操作 contract 描述与效果验证责任：固定读 not_applicable、普通正常命令 not_asserted、写入/push 必需 verified、中断或缺失必需证据 unknown；禁止用弱合同掩盖未决效果。
- [x] 在一个产品投影实现中落实 Spec §3.4 判断表；Worker/Run/UI 使用同一投影，不各自判断 cleanup===confirmed 即成功。
- [x] 从失败用例开始验证：result 已知/cleanup pending、已有结果后 lost、empty output、迟到结果、ready 与 started 差异、Run cancel 后禁止模型续接。

完成条件：合同/投影测试通过，v1 旧样本语义不变；新增枚举不能让缺少真实监督证据的适配器自动返回 controlled 或 released。

R1 实现位于 `packages/execution-contracts/src/sandbox-execution-v2.ts`、现有 `packages/application/src/ports/sandbox-execution.ts` 及 `packages/application/src/services/sandbox-execution-projection.ts`。现有端口以 `SandboxExecutionPortV2` 显式选择版本；原 v1 实现及读回不改变。统一的 `projectSandboxExecution` 和 `projectSandboxRunCompletion` 可供 Worker/Run/UI 接入，实际持久化、CAS、证据读取及生产调用方接入按 R2–R4/R11 实施；本阶段没有将纯函数的测试冒充正式派发验证。

| 合同测试输入 | 结果与继续判断 | 环境与 Run 判断 |
|---|---|---|
| 固定只读，保护输出长度为零，监管有效、清理 pending | succeeded，可披露并续接；空输出不是结果丢失 | 不复用，不正常终结 Run |
| 写入或专用 push 的合同，匹配 verifier/target 的可信效果证据 | verified 才确定成功；必需证据缺失为 unknown，不能换成普通命令合同 | 未清理仍保留资源义务 |
| 前台 Shell 正常退出、完整输出 | effect=not_asserted，仅判断退出/输出；非零退出为失败，中断效果须核查 | 退出不代表清理确认 |
| 后台启动已登记 running 句柄 | started，不代表后台工作完成 | 存活期保留资源义务 |
| MCP ready 与同一环境的两个请求 | readiness 必须独立核验；两个请求分别绑定 invocation/Handle，未 ready 不派发 | 共享环境，保持独立调用结果 |
| 取消时 ack 未知或结果迟到，以及已有结果后 lost | 不自动重试或续接；已知且获准披露的输出仍可展示 | 隔离和清理继续，不正常完成或复用 |

验证证据（2026-09-09）：

- 失败基线：在旧 parser 输入 succeeded/confirmed-effect/cleanup-pending 记录，实际以 `terminal result requires confirmed cleanup and effect` 拒绝。旧规则保留；新测试在 v2 验证相同的结果/清理分离语义。
- 新增回归先失败：同时替换回执和资源观察的句柄引用，最初未被拒绝（1 failed / 31 passed）；环境关联新增冻结 resourceRef 后拒绝该替换。
- 新增回归先失败：远程连接使用本地进程证据，最初未被拒绝（1 failed / 27 passed）；补充监督证据主体的 local_process/remote_connection 严格分支及连接绑定后通过。
- `sandbox-execution-v2.test.ts` 与原 `sandbox-execution-contract.test.ts`：33 + 17 项通过；旧 `job-host.unit.test.ts` 7 项通过，未赋予旧适配器 controlled/released 默认值。
- 类型检查、Node/合同构建、修改文件 Biome、依赖边界、v0.2 覆盖映射/不变量、秘密扫描、CI policy 和 docs strict 均通过；安装 Runbook 已核对 v1 运行边界并重新 seal。这些是本地合同证据，不是主机监督资格或实际工具验收。
- 全仓 `npm run check` 的格式检查通过，但 lint 失败（182 errors、988 warnings）。本次修改的 6 个 TypeScript 文件单独执行 `biome lint --error-on-warnings` 通过；诊断路径核对确认这些错误和警告均不在本次改动文件中，未在 R1 中扩展修复。

### R2：追加持久关联、占用与迁移

依赖 R1；依据 Spec §3.1、§3.2、§4.4、§10.2，验证 EX-02、EX-07、EX-09、EX-11、EX-12。

- [x] 核对迁移最新编号，追加环境、后台 task/service 与 invocation 的关联及隔离占用；放在现有产品 SQLite，不新增授权库或调度 Task 状态机。
- [x] 原子准入保留 Handle 消费/语义指纹/作业初观察；后台创建关联同事务保存，失败整体回滚。首次 starting CAS 固定 policyDigest，争用失败方只能清理自己的预备资源。
- [x] OperationResult 保留原保护结果权威；资源观察独立 sequence/CAS 追加，可在结果产生后继续更新，不能替换已发布结果。继续意图与最新资源 sequence/Run/fence 同事务复核，派发前再检查；派发后发现故障保存在途不确定性。
- [x] 原目录写环境整个存活期保有范围占用；lost/unknown 保守阻止相交操作，跨进程重启后恢复占用。使用当前目录身份和范围算法，不使用字符串前缀锁。
- [x] v1 升级覆盖正常历史结果、未启动、启动意图丢失、quarantined 和缺少身份情况；不把默认迁移值当清理/效果证明。
- [x] 用真实 SQLite 证明重开、CAS 冲突、事务回滚、分页、取消后清理追加、结果保留、旧记录不得重新执行。

完成条件：升级不会重消费或重跑；已知结果与未释放资源同时可读，未知目录在新进程准入前即受保护。

#### R2 实施与验证（2026-09-09）

实现使用 `SandboxExecutionJournalPort`、现有 `SqliteProductStateRepository.sandboxExecutionJournal()` 和 `sqlite-sandbox-execution-operations.ts`，追加 migration `0028_sandbox_execution_resources.sql`，不修改 0020/0027。环境和 task/service 创建引用与消费凭证一起提交；结果引用继续查验既有受保护 Run artifact，不建立第二套授权、结果存储或调度 Task。

资源观察使用 sequence，操作结果/效果使用独立 revision；迟到结果可在资源释放后保存，已知结果不可改写；新的 verified 效果必须先通过绑定证据核验，不能只凭声明写成确认事实。继续意图冻结两个编号与权威，派发前重新检查 Run/租约/fence。派发后未收到确认回执即持久视为不确定，后续错误保留历史；单次派发重放不会再次获得启动权限。资源已释放仍有未知效果或在途派发时保留占用；后到的未知效果会重新保留占用。

范围占用按主机与 device/inode 祖先链比较，覆盖同一目录的别名及父子目录；活跃只读范围可并存，写范围与未知资源阻止相交操作。主机身份链来自可信组合端口，正式目录解析、授权绑定与真实监督证据读取仍属 R3/R4；本阶段测试使用合成目录身份和监督证据，不宣称实际主机资格。v1 没有可信目录链时保守占用整个主机，主机身份缺失时阻止所有主机的新准入；原行、观察和迁移摘要不改写，不自动补造 v2 记录。未解决的占用不能随 Run 删除，旧 Worker 也不能绕过 v2 占用。

验证：

- 新增 `test/integration/sqlite-sandbox-execution-v2.test.ts` 的真实 SQLite 测试覆盖事务回滚、单次消费/启动、并发 CAS、独立结果历史、晚到未知效果、目录冲突、数据库重开/分页、取消与 fence 改变后的派发拒绝、清理后结果保留和在途派发回执。
- schema 27 的 prepared、starting、quarantined、completed、failed、缺主机身份及缺状态七类数据分别通过已验证快照升级到 28；核对旧行与 1–27 迁移账本不变、无默认 v2 执行、保守占用和外键一致性。
- 回归先失败：派发已提交但回执缺失，资源释放后待核查列表错误变为空（1 failed / 9 passed）。修复为持久等待确认，并在占用释放时检查在途派发；同一回归通过。
- 现有 state-root 所有权锁继续拒绝第二个数据库所有者；并发验证通过唯一 SQLite Worker 发起竞争请求，没有绕过锁建立第二个产品权威。
- 最终相关 integration/contracts 回归 9 个文件、185 项全部通过，其中新增 R2 测试 26 项；保留原有测试时限。全仓格式检查通过，lint 仍有既有的 182 errors / 988 warnings；本次修改的 TypeScript 文件分别执行 lint 均无 error/warning，未扩展修复全仓历史问题。
- 类型检查、Node/合同构建、依赖边界、v0.2 覆盖/不变量、秘密扫描、CI policy、docs strict 和暂存差异检查通过；打包产物实际加载 SQLite 模块、v2 journal 导出和 schema 28 成功。三个受影响 Runbook 已完成内容核对并重新 seal，静态通过不代替目标机器 preflight。
- 本次只使用专用测试数据库和假数据，未升级现有运行数据库。备份恢复和权威迁移测试属于同机测试夹具，不是实际安装或跨主机验收。正式 v2 组合、真实进程停止/核查、模型续接与 UI 仍待 R3–R6/R11。

### R3：正式 scope、调用模式与版本接入

依赖 R2；依据 Spec §3.1、§3.3、§10.2–10.3，验证 EX-02、EX-03、EX-12。

- [x] 在现有 production-sandbox-services 中补 file/edit/write/search/bash/后台任务的可信范围来源，复用各自已有授权输入/调用回执，保留文件 context 和父子调用检查。
- [x] 沿已经批准的同 Grant 网络 targets 映射；逐请求验证 Grant 状态/指纹、目录版本/根、模型披露、主机上界和原期限。查询/停止不重复消费原执行 Handle，新执行动作消费自己的 Handle 一次；MCP 请求接入不在本任务。
- [x] 扩展既有认证 Payload broker 的 v2 内部 binding、任务/服务控制请求、资源查询和输出 cursor；验证 boot/epoch/fence、消息长度与执行目标，禁止 Worker 指定数据库 authority。
- [x] Agent/Worker/runner/qualification 声明并匹配支持的 mode/schema；不支持 v2 的安装在消费/启动前拒绝，不把 v2 数据标为 v1。
- [x] 准备结束和首笔实际启动前重核当前授权、产物与原期限；旧观察读回或过期停止不得恢复执行权。

完成条件：真实 UDS+SQLite 测试覆盖撤权竞态、跨 Grant/主机/父调用、旧凭证、未知版本、重投递及单次消费；不依赖注入的 allow 布尔值证明正式授权。

#### R3 阶段记录：接入核实与已批准修正（2026-09-09）

以下是 R4 接入前的历史状态，最新结论见本节完成证据。当时 R3/R4 尚未完成，已实现版本声明、真实目录祖先身份、v2 broker 合同/传输、预留与绑定 CAS；`service-main` 已组合 v2 观察处理器和 Worker 握手支持查询。Worker 当前仍只声明 v1 foreground，明确拒绝 v2 执行，不能经普通适配器或 v1 路径降级执行；完整 v2 启动及资源控制仍未启用。不得据此勾选上述完成条件。

已确认一个跨 R1/R2 的准备顺序冲突：Spec 规定 Worker 在准备阶段编译策略，并在首笔原子启动时固定摘要；但 `sandboxEnvironmentSchema` 在准入 facts 中强制要求非空 `policyDigest`，SQLite v2 `start` 又只接受与已保存 environment 相同的摘要，且后续观察不能改变 environment。新增负向测试实际验证了空摘要被拒绝、启动时换成后来编译的摘要同样被拒绝、`startedAt` 保持空值。这说明现有 R1/R2 静态夹具预填摘要掩盖了正式准备顺序的问题，不是允许使用占位摘要的理由。

**Owner 当时批准的修正，现已实施：** 将“已准入的执行预留”与“已取得实际运行绑定的环境”区分为明确阶段。准入事务继续消费同一个 Handle 一次、保留 invocation/job/environment 定位及目录占用，并冻结授权、scope、模式、资格和原期限；此时不虚构策略摘要、Job Host 实际 boot 或私有目录所有权。Worker 通过现有认证通道取得范围并完成真实准备，在首笔启动请求中提交实际准备绑定；Agent 重核当前授权、主机产物和期限，SQLite 用一次 CAS 固定该绑定并登记启动，只有赢家可以启动。固定后的绑定不可替换；重投递、ack 丢失和重启只能读取或核查原预留，不产生新的启动资格。

影响范围是 R1 合同/投影、R2 journal/SQLite、R3 broker 与 R4 Worker/Job Host；仍沿用现有授权库、回执、Run 和通道。需要迁移时追加新 migration，不改 0027/0028；既有已绑定记录保留原文及含义，未绑定或来源不明的记录不自动补成可运行状态。准备失败或绑定提交后失联仍保留占用，直到可信核查证明风险消除。验证须补未准备准入、唯一绑定、绑定替换拒绝、绑定期间撤权、启动 ack 丢失及旧记录读回。

Owner 已明确批准本项涉及 R1/R2 的结构调整，无须就同一范围重复请求批准。这里不改变已批准的 Worker 独占策略编译原则，也不把编译挪给 Agent 或将初始化字段硬填成假证据。

追加 migration `0029_sandbox_execution_preparation`，在既有账本中区分 `reserved`、`bound` 和保留历史语义的 `legacy_bound`；不修改 0027/0028。预留阶段保存 `sandbox-preparation.v1`，不生成 policyDigest、supervisor 或 privateDirectory 的占位值；首笔绑定固定实际 facts，绑定替换与重放不产生启动权。真实 UDS+SQLite 已覆盖首次绑定并发、绑定中撤权、重复请求、单次消费；数据库重开测试覆盖未绑定预留和已固定绑定。通用工具目录/网络映射与输出证据读取仍需完成正式组合的完整验证，不能据这些局部测试勾选 R3。

#### R3 完成证据（2026-09-09）

逐项核对 R4 提交后，通用 `grant_targets` 来源、父子调用约束、版本匹配、准备后复核及限定控制已存在；本次复用这些实现，补足正式组合验收和遗漏的 `output` 分页处理，没有新增权限库、调用身份库、状态机或迁移。

- `production-sandbox-scope.test.ts` 在真实 SQLite 中保存审批快照、已批准且已消费的 Grant、未消费 Handle、目录授权及受保护调用意图。Mac 上使用真实目录/runner 摘要检查和受控测试资格，经 production-sandbox-services 与真实认证 UDS 验证 read/edit/write/search/bash/后台模式范围。新执行只消费一次 Handle，scope 解析、重复准入和查询不会再次消费 Grant 或 Handle。
- 负向验收分别覆盖跨 Grant、主机、网络上界、模型披露对象、Thread、操作及父调用；版本/模式不匹配在消费前拒绝。scope 解析期间撤权后，UDS 返回前的实时复核仍拒绝。准备后替换真实 runner 内容或目录 inode，启动复核拒绝并保持 reserved。已有 file inspect/read context、父子调用和网络 fingerprint 单元/集成回归继续运行。
- broker 的资源 `output` 请求已连接 `createProductionSandboxOutput`。分页只读取账本已绑定的受保护输出快照；cursor 绑定原调用、语义摘要、资源和输出摘要，保存在既有受保护 Run trace。页正文仍是受保护 Payload；游标不能表示宿主路径或执行许可。重复查询返回原页，数据库重开可以继续游标；跨资源/调用、未签发游标和原输出缺失均拒绝。真实空输出与尚无已知输出分别返回零字节页与 null。
- task/service 的资源查询与限定停止沿已有认证通道、原资源关联和当前 Agent 权威，不接收 Worker 提供的数据库 authority；旧 Worker 的执行/输出权限不因新 boot 核查而复活。固定消息上限、旧 boot、未知命令、错误目标、过期启动、绑定竞态、重投递和单次消费继续由真实 UDS/SQLite 测试覆盖。

最终验证：16 个测试文件、276 项相关回归通过；测试夹具适配 Mac/Linux 后重跑新增及相关三组共 29 项通过。`npm run check`（含类型、依赖边界、CI policy）、`npm run build:node`、改动文件 Biome 与文档严格检查通过。正式 scope 组合本次实际在 Mac 运行；夹具已适配 Linux 路径，但本轮未做 Linux 实测，不以平台跳过测试隐藏缺口。

R3 完成的是通用范围、版本、准备复核和资源控制/已保存输出的接口接入。后台模式的范围测试不启用后台执行；运行中输出采集与持续分页生产、任务/服务真正启动归 R6。Pi 七工具 runner 归 R5，目标平台联网及安装资格归 R8。MCP 与 GitHub 推送仍在本次范围之外。受控测试资格不签发生产资格，也没有调用模型或真实外部网络。

### R4：监管、停止与核查证据生产

依赖 R3；依据 Spec §3.4、§4.1、§4.4–4.5，验证 EX-09–EX-13。

- [x] 升级 Job Host 私有 IPC，分别产出真实启动/退出、输出、监管和清理事实；使用已验证 boot/进程启动标记与监督窗口，不把 PID/心跳单独作为全树保证。
- [x] 保留一环境一 manager、干净环境、固定 initialize、代理 ready、显式 start、有界 stdin/输出；超时、取消、超限与观察失效均进入停止。
- [x] 增加 profile 对前台/后台/服务的监管证据校验；无法证明时按真实情况保持不可用或 lost，不能硬编码 controlled/confirmed。保留 Mac setsid 负向事实。
- [x] 实现核查的只读/限定停止端口及追加证据；隔离解除必须证明相交风险消除，没有 relaunch 分支，不复用旧 Worker 凭证。
- [x] 实际运行测试子进程并注入 Worker/Job Host 崩溃、ack 丢失、持有管道、setsid、进程身份替换、初始化失败与停止失败；每个测试有独立目录、总超时、清理与残留证据。
- [x] 验证已有结果后监管丢失会阻止后续模型续接和相交新任务，其他无关目录不被误解锁或无故占用。

完成条件：真实后端能生成符合目标 profile 的观察；未达到保证的 mode 明确不可用。固定探针通过仍不签发生产资格；后端能力不足属于具体 blocker，不靠改状态让测试通过。

#### R4 阶段记录：后端负向证据（2026-09-09）

实际运行 `node packages/runtime-sandbox/scripts/qualify-job-host.mjs --installed`，使用脚本拥有的专用假数据目录。normal、output-limit、cpu-limit、memory-limit、cancel、deadline 探针返回主进程退出、stdio 关闭及 SRT reset；整体仍为 `productionSuitable:false`。脚本中的 Perl `fork`/`setsid` 后代在主进程退出后继续写入 `detached-finished`，任务树清理仍为 `unknown`。因此退出、管道关闭和 reset 不能作为整个任务树的释放证据；这次运行不签发主机资格，也不能替代 R4 要求的崩溃、身份替换与限定核查测试。

新增 `probe-supervision.mjs` 实际运行八种有限寿命子进程场景：normal、identity、ack-loss、pipes、init-failure、host-crash、stop-failure、worker-crash。2026-09-09 的编译源码探针通过，`productionSuitable:false`；故障结果保持 `lost` / `unknown`。identity 只验证当前私有 IPC 会话拒绝错误 boot，不是操作系统 PID 复用证明；ack-loss 验证同一 session 不接受第二次 start，不代替 Worker/数据库跨重启测试。长临时路径曾在 SRT 初始化阶段出现 `EADDRINUSE`，测试改用拥有的短路径后通过；生产私有路径的长度仍须纳入安装资格。该探针不覆盖完整生产授权链或任务树释放证明。

以下为后续接入之前的阶段记录，并非最新完成状态。R3/R4 当时验证与未完成边界：两组定向回归共 248 项通过，覆盖合同、SQLite/UDS、迁移、同机备份恢复、权威迁移、Worker 拒绝降级及 Job Host 私有 IPC；类型检查、改动文件 Biome 检查、依赖边界和文档严格检查通过。项目整体 `npm run check` 在 lint 阶段失败：当前 182 errors / 985 warnings；对原 HEAD 的隔离源码副本复核为 182 errors / 988 warnings，不能将整体检查写为通过。

尚需完成完整 v2 Worker 准备/启动与资源控制、生产范围/输出证据的端到端验证，以及跨进程重启、真实 PID 复用和风险消除核查。当前产品适配器尚未接入任务树完整监管/释放证据；这不能推导为 SRT 在所有平台上均无法满足要求。Mac 已接受 best-effort 限制，Linux 固定版本 SRT 已使用 PID namespace，两者必须分别验证；已有局部实现和 `lost` 观察不能代替上述工作。R3/R4 保持未完成，工作区草稿不作为已交付提交。

#### R4 双向失联与 v2 启动恢复进展（2026-09-09）

Worker→Job Host 增加带 session、单调序号和时间戳的心跳；两端均拒绝过期消息刷新监督窗口。Job Host 在 Worker 卡住但 IPC 未断开时，也按单调时钟的监督窗口停止任务。两个新增单元用例先复现失败，修复后通过。`probe-supervision.mjs` 增加 worker-stall：暂停真实 Worker，独立观察任务的假数据计数文件停止更新，恢复 Worker 后仍为 lost/unknown；九种有限进程场景全部通过。这不将心跳升级为任务树完整证明。

`recoverSandboxExecutionsAtStartup` 已在 Agent 开放准入前处理 v2 未释放记录，使用当前权威追加 lost/unknown；保留原结果、效果、运行绑定与目录占用，没有启动或按旧 PID 接管分支。SQLite 重开测试验证更换 Agent/Worker boot 后旧监督失效、已知结果不变、旧续接意图被拒绝、相交任务仍被拒绝、独立目录可以准入，以及重复恢复不重复追加既有 lost 观察。预留记录仍由原占用保护，恢复不为其补造运行绑定；已 released 但效果未决的记录不反转清理事实。

本轮专项回归 112 项通过；随后增加新 boot 恢复断言的 28 项定向回归通过。类型检查通过。另在 Hermes 使用现有 Python/unshare 运行 PID namespace/setsid 实验：namespace init 退出后，后代未存活到原定 4 秒，命令约 0.32 秒结束。该实验未使用 bubblewrap/SRT，不签发 Linux 资格；实际完整 SRT 验收仍待准备缺失依赖后运行。不得把这份内核机制证据转写为产品 released 证据。

本阶段结束时 R4 仍未完成：尚需 profile 对应的真实监督/清理证据生产和校验、重启后限定停止的完整通道，以及证明相交风险消除后解除隔离的正向验收。双向停止与启动恢复修复不替代这些完成条件。

#### R4 完成证据（2026-09-09）

R4 所需的 R3 前台基础已接通：显式 v2 foreground 固定读取/命令经既有 scope、回执与认证 Payload UDS 完成准备，原 Job Host 登记后由唯一 `bindAndStart` CAS 固定真实运行绑定。后台/服务仍明确拒绝，完整 Pi 工具、通用网络派发和 UI 消费不因此勾选 R3/R5/R6/R9。

- Job Host 私有 IPC 绑定真实会话、boot、进程启动标记、单调序号和监督窗口；双向失联请求停止。控制目录与任务私有目录隔离，控制 secret 不进入 task argv/env/stdin；Agent 仅导入无 SRT/启动能力的 `runtime-sandbox/control` 客户端。
- 原环境控制引用与签名观察存入既有受保护 Run trace。核查先 CAS 追加状态，再进行有界 inspect/stop；复用请求不重复停止，迟到结果不改写账本。当前 Agent 权威可以核查旧 Worker 原环境，不能复用旧 Worker 凭证启动；引用、目录 inode、boot 或策略不符均保持隔离。正向清理与不可信/超时/并发/重启保留结果及占用由真实 SQLite 测试覆盖。
- Linux 用户代码启动前，通过私有握手核实固定 SRT PID namespace init 的身份和祖先关系；二进制 stdin 原样交给任务。只有原 namespace init 消失、任务退出、stdio 关闭、SRT reset 和原 Job Host 退出的证据完整时允许清理 confirmed。此时仍须经过产品投影和派发/效果检查才能释放占用。Mac 已启动任务继续 unknown，不把 setsid 负向事实改成成功。
- Mac `probe-supervision.mjs` 的九项真实有限进程场景通过，覆盖 Worker/Host 崩溃、Worker 卡住、ack 丢失、持有管道、错误 boot、初始化与停止失败。身份测试不宣称强制制造了操作系统 PID 复用。
- Mac 与 Hermes 均运行 `probe-job-host-control.mjs` 五项：限定停止、Worker 崩溃、未启动停止、setsid、包含 NUL/换行的 stdin；同时验证错误凭证拒绝、任务无法读取控制目录、终态签名篡改拒绝。Linux 五项清理 confirmed；Mac 仅未启动项 confirmed，其余 unknown。Hermes 另运行固定 SRT 的普通/setsid 两项 namespace 探针通过。
- Hermes 依赖仅下载并校验后解包到 Owner 批准的 `/data/himawari-r4-uxRKWbwG`，使用 SRT 0.0.75、bubblewrap 0.6.1 与 socat 1.7.4.1；未安装系统软件或修改服务/安全设置。专用 PATH 仅用于探针，不是生产配置或资格。
- `HIMAWARI_LIVE_SANDBOX_PROBE=1 node packages/runtime-sandbox/scripts/qualify-production.mjs --v2` 通过真实 Mac SQLite、回执、scope、UDS、生产 v2 Worker、Job Host 和受保护输出路径；未知清理仍隔离，新 Worker 重投递没有再启动。验收发现并修复了 Worker 传入过多资源字段、初始效果提前断言与数据库合同不符的问题。固定假数据/测试资格不代表真实模型、HITL、安装或生产资格完成。

最终检查：367 项合同/迁移/集成/Worker 路由与边界测试、40 项 runtime-sandbox 单元测试通过；`npm run build:node`、`npm run check` 和改动文件 Biome 检查通过。早先整体 lint 失败的记录保留为历史；当前源码基线已包含独立的 `f37fa06` lint 修复提交，不再把旧失败当作现状。

上述证据完成 R4 的监管、限定停止和风险核查要求。完整 Spec/Plan 保持进行中，此处 R4 完成时尚未勾选 R3；R3 的后续验收见上节，其他阶段仍未完成。

### R5：完整前台 Pi 工具 runner

依赖 R4；依据 Spec §2、§5、§8，验证 EX-01、EX-04–EX-06。

- [ ] 复用已安装 runner 入口体系，执行真实 Pi read/write/edit/bash/find/grep/ls；Agent 只取定义，产品其他包不得直接导入 Pi。
- [ ] 文件 inspect/read 保留元数据与正文双阶段、HostFileReadService 身份/大小/类型检查和模型披露；验证真实空文件与失败差异。
- [ ] 覆盖 Pi Operations 外 I/O：read 路径探测、rg/fd、图片处理、长输出日志；全部在私有受限环境，必要二进制预装且摘要固定，不能自动联网下载。
- [ ] 在受保护输出中保存结果及截断/来源，导出检查所有权和实际文件类型；不向 Agent 回传可被任意解释为宿主路径的 fullOutputPath。
- [ ] 写入使用现有冲突检查/安全替换，原目录保留用户修改，删除/重要覆盖沿 HITL；一次复合工具不按每次 I/O 重复消费授权。
- [ ] 盘点 program、Git/archive/tar、候选导入导出、扩展加载的实际调用方，按受限执行/狭窄可信动作/禁用登记；移除已无调用方旧执行路径，不扩大为无关重构。

完成条件：真实 Pi 兼容及受限 runner 测试证明七工具功能和无旁路；测试既验证正常结果，也验证恶意路径、输出产物替换、秘密/控制目录及缺失搜索器失败拒绝。

### R6：受管理后台任务

依赖 R5；依据 Spec §4.2，验证 EX-07、EX-09–EX-11。

- [ ] 通过 Pi 扩展注册任务 start/status/output/cancel 薄适配，保留原前台 Bash 合同；共用既有命令授权、后端和保护输出，不造新 shell 协议。
- [ ] start 前持久句柄关联并获取资源占用；调用返回 started 与真正运行/结束结果分开，重投递只查询原关联。
- [ ] 有界输出 cursor、重复查询和进程退出后读回不触发新执行；伪造/跨 Run 句柄、过期授权和 PID 复用均拒绝控制。
- [ ] 资源寿命不得超过原 Run/Grant/执行期限；Run 结束停止资源，后台不自动转成长期 Task。写任务在整个存活期占用目录，冲突操作等待/拒绝。
- [ ] 验证启动成功但返回丢失、取消与完成竞态、查询期间崩溃、输出洪泛、写占用、撤权、Run 结束与重启只核查。

完成条件：至少一个有界长命令和一个声明 readiness 的测试服务可被可靠管理；返回句柄不声称工作完成，所有测试资源结束或留下明确的隔离证据。

### R7：MCP 接入（移出本次范围）

本地 stdio MCP 与受治理远程 MCP 的接入及真实多请求验收不属于本次实施任务，EX-08 同步移出。不标记完成，不阻塞 R8/R9/R11/R12；需求保留，后续另行安排。

### R8：授权联网与后端资格矩阵

依赖 R3–R5；依据 Spec §4.5、§7，验证 EX-03、EX-13、EX-14。

- [ ] 将原域名 Grant 到网络策略映射扩展到实际安装/下载/工具链请求；冻结实际 domain:port 与披露，不因重定向或镜像自动扩权。
- [ ] 验证 HTTP/裸 TCP/SOCKS、删除代理变量、DNS、localhost/socket、SSRF/元数据、重定向和代理初始化失败；网络拒绝以实际拒绝证据判断，不能只看 curl 非零退出。
- [ ] 资源 CPU/RSS 观测与阈值停止、授权撤销停止分别记录覆盖和局限，不宣称硬配额或即时撤回残留进程文件权。
- [ ] 按 host/backend/profile/mode/schema/runtime/runner/保证绑定资格；Mac 与实际需启用的 Linux 分开取证，Hermes 先核实数据盘及测试目录。
- [ ] 强隔离后端只列能力缺口及候选验证条件；不在本任务隐式安装 Gondolin/容器或恢复旧 fallback。

完成条件：拟启用组合有真实目标主机证据；失败或未测的 mode 不注册。首批必要联网能力未通过仍报告整批未完成。

### R9：真实 Web Search 与页面核实

依赖 R5/R8；依据 Spec §7 的 Web Search，验证 EX-15。

- [ ] 复用 WebCapabilityService/searchPublic/openPublic/buildResearchCitations 与现有 provider/HTTP 端口，确定实际 provider、秘密来源与预算。
- [ ] Pi 薄适配经过通用准入和披露；保存查询时间、来源 URL、页面可获得的发布时间及实际片段，不把搜索摘要伪装成已读全文。
- [ ] 覆盖失败/无结果/限额/撤权/重定向，真实 provider 验收按具体账号和费用授权执行；结果可回读不重复请求。

完成条件：正式链路返回可核实引用，失败不编造；测试 provider 只能作回归，不作为真实搜索交付。

### R10：GitHub 已有 commit 推送（移出本次范围）

专用推送动作、凭据委托、传输及真实 GitHub 仓库验收不属于本次实施任务，EX-16 同步移出。不标记完成，不阻塞 R11/R12；需求保留，后续另行安排。

### R11：正式模型、HITL、UI 与故障旅程

依赖 R5、R6、R8、R9；依据 Spec §3.4、§6 与验收标准，验证 EX-04、EX-09、EX-10、EX-17。

- [ ] 控制中心复用现有 Run/Trace/工具结果展示：操作结果、后台 started/ready、监管失联和清理未知分开；不是简单绿色 success。
- [ ] 正式 Agent/Worker、身份/CSRF、实际模型配置和预算就绪后，ego Lite 发起文件总结，由模型调用工具、真实读取、同 Pi loop 续接并落库。
- [ ] 从 UI 执行受控写入、后台 start/query/stop 和非 MCP 测试服务 readiness，覆盖审批批准/拒绝、并发批准、过期、取消和结果后清理失败。
- [ ] 刷新和服务重启回读既有模型/工具结果；不新增模型调用，未完成资源进入核查，不复活取消 Run。
- [ ] 独立确认真实搜索、联网和后台任务整批证据，按主机/模式显示能力不可用及具体原因。

完成条件：从用户入口验证文件读取/写入、后台任务、Web Search 及实际故障；没有未核实资源时才正常完成 Run，不能用预准备调用或合成 session 代替。

### R12：安装、文档与最终切换

依赖本次有效任务（R1–R6、R8、R9、R11）；依据 Spec §10，验证 EX-12、EX-18。

- [ ] 打包固定依赖与 runner，校验安装产物摘要/权限、schema/mode 协商、主机资格；真实安装后执行对应探针，不复制签名或静态模板当资格。
- [ ] 完成全部模型可达调用方归属检查，移除已经迁移且无调用方的旧后端执行入口；保留旧数据只读，不维护隐含运行 fallback。
- [ ] 执行停准入、在途核查、资源释放/隔离、版本切换和拒绝不兼容回退的安装测试；不逆写 migration、不 reset 用户变更。
- [ ] 实现改变操作合同时，语义复核安装/备份/权威迁移 Runbook，运行相应静态检查和实际授权 preflight 后再封存；本设计阶段不预封存。
- [ ] 更新架构当前事实、覆盖清单及必要运行文档；验证通过后分目的本地提交，远端 push/发布按具体指令执行。

完成条件：本次有效的 16 项 EX 验收全部映射到可信证据（不含 EX-08、EX-16），必须能力无遗漏，历史/合成/真实主机证据明确区分。

## 验收映射

本表仅包含本次有效的 16 项验收；EX-08、EX-16 保留编号但不在表内。

| Spec 编号 | 主任务 | 最小验证层 |
|---|---|---|
| EX-01 | R1、R5 | 固定 Pi 兼容 + 实际受限 runner 的隐含 I/O |
| EX-02 | R2、R3 | SQLite 事务、并发/父调用、同 Grant 单次消费 |
| EX-03 | R3、R8 | 实际 UDS/权威来源 + 启动竞态/联网拒绝 |
| EX-04 | R5、R11 | 两阶段文件 + 正式模型/Pi/UI |
| EX-05 | R5 | 原目录文件冲突/安全替换/搜索 |
| EX-06 | R1、R5 | 前台真实退出/输出 + 效果合同 |
| EX-07 | R2、R6 | 持久句柄 + 实际后台任务/ack 丢失 |
| EX-09 | R1、R4、R11 | 投影判断 + lost 后停止续接/相交准入 |
| EX-10 | R4、R6、R11 | 取消/超时/迟到结果与停止竞态 |
| EX-11 | R2、R4、R6 | 真正崩溃、PID 身份、重启核查及隔离解除证据 |
| EX-12 | R1–R3、R12 | v1 历史读回、追加迁移、版本不匹配/回退拒绝 |
| EX-13 | R4、R8 | 分主机和 mode 的实际资格 |
| EX-14 | R8 | 联网/SSRF/秘密/资源阈值 |
| EX-15 | R9 | 真实 Web provider 与页面引用 |
| EX-17 | R11 | ego Lite 正式模型与刷新/重启回读 |
| EX-18 | R12 | 安装产物与完整调用方归属/停止迁移 |

## 原待办与新任务的对应

| 原任务/待办 | 新归属及保留事实 |
|---|---|
| 原 Task 1–2 / P0-06 | 历史 v1 设计与按次 Pi 绑定已实现；R1/R5 验证新合同，不能重标历史测试为 v2 |
| 原 Task 3–4 / P0-10–P0-11 / P1-01–P1-02 | R2–R4、R8，复用已接通的 scope/主机/账本，补真实监管核查及新版本 |
| 原 Task 5 / P0-07–P0-09、P0-12–P0-14 | R5，保留文件身份、双授权、保护结果和 Pi 续接；后台能力另由 R6 验证 |
| 原 Task 6 | MCP 接入移出本次 R7；授权联网仍由 R8 交付 |
| 原 Task 7–8 | R9 交付真实 Web；GitHub 已有 commit 推送移出本次 R10 |
| 原 Task 9 / P0-01–P0-05、P1-03–P1-05 | R11，原模型/身份与入口证据保留，完整新路径重新验收 |
| 原 Task 10 / P2-01–P2-02 | R12，最终资格、运行文档及交付 |

## 验证命令与证据规则

每个任务先运行行为相关的最小检查，具体新增测试路径在实现时登记到现有 CI 项目；拟新增文件不是已存在可执行命令。已有入口如下：

```sh
npm run typecheck
npm run check:boundaries
npm run check:pi-compat
node_modules/.bin/vitest run --config vitest.workspace.ts --project integration test/integration/sandbox-execution-contract.test.ts
npm run check:v0.2-coverage
npm run check:v0.2-invariants
npm run check:secrets
npm run check:ci-policy
python3 /Users/triggerjames/.codex/skills/document-governance/scripts/validate_docs.py . --strict
```

R2–R4 追加真实 SQLite/UDS 与进程故障测试；R5、R6、R8 在源码和可安装产物各运行对应后端用例。现有 `qualify-policy.mjs`、`qualify-job-host.mjs`、`qualify-production.mjs` 在适配 v2 后继续作为有限探针，不更改 productionSuitable 以代替正式资格。每份实际主机证据记录安装/runtime/runner/profile/mode/schema 摘要、OS、场景、退出状态、效果/监管/清理事实及残留处置；合成 session、临时资格、真实安装明确分开。

真实模型、收费 provider、安装变更在具体目标和影响明确后按现有授权执行；此 Plan 不授予所有未来外部操作权限。测试只用任务专用假数据，有界进程不能留下无主常驻资源；涉及 Hermes 大量数据先验证机械盘挂载。

文档设计本身运行 strict 治理、SOURCE/ADR 链、覆盖/不变量及 diff 检查。它不要求重跑全部产品测试，也不得引用历史测试作为本次已运行结果。历史全仓 lint 问题仍在 [SOURCE: docs/backlog/BL-20260907-001-修-复-全-仓-既-有-lint-问.md]，不在本任务批量修复。

## 历史 v1 验证记录（保留证据，不是当前待办）

以下按当时记录保留。段落中的“尚未接入/仍待实现”描述各次验证时点；当前基线以上文为准，当前执行次序仅 R1–R12。旧 completed/failed 和 cleanup unknown 断言属于 v1，不可作为 v2 的验收条件。历史 274 项/62 项等数字不表示本次重新运行。

当前证据（2026-09-08）：`packages/runtime-sandbox/test/policy.unit.test.ts` 覆盖策略非法字段、目录相交、权限例外、符号链接与异步输入改变。`npm run build:node` 后运行 `node packages/runtime-sandbox/scripts/qualify-policy.mjs`，在 Mac 自动创建的专用假数据目录验证读取、写入、假秘密拒绝、目录越界拒绝、符号链接越界拒绝与代理联网拒绝。该版本探针对网络的断言仅检查 curl 失败，不能单独证明代理拒绝；2026-09-09 已纠正，见下方正式接入核对。探针退出码 0、stderr 为空；依赖探针 errors/warnings 均为空。

此探针仅验证固定脚本下的策略，输出明确保持 `productionSuitable: false`；不是正式 Worker 接线、授权 scope 存储或平台资格签发。资源观测与超限停止、未知清理的持久隔离与 Worker 崩溃核查、正式启动接纳仍缺完整实现与证据；新增账本仅提供持久化基础。2026-09-08 Owner 已取消 CPU/内存硬上限作为硬性验收要求，改用资源观测和超限停止；不得声称原生 SRT 提供硬配额。SRT 0.0.75 的配置没有硬 CPU/内存限制；`cleanupAfterCommand()` 与 `reset()` 不负责证明任务后代全部退出。因此不能只用启动参数适配或 `kill(-pid)` 启用生产 profile。权限 scope 的原始授权、host/runtime/runner 摘要及 TOCTOU 复核仍必须在正式接纳与启动点完成，策略编译不能替代这些检查。

Job Host 组件证据（2026-09-08）：新增 `runtime-sandbox/src/job-host-main.ts` 与父进程控制器，准备完成不自动启动，父进程必须显式提交 start；子进程不继承宿主秘密环境和 Worker IPC。策略编译将 SDK 的 HOME 默认路径绑定到作业私有 HOME，避免父子摘要不同。取消在 SDK 初始化或启动描述生成期间发生时，清理等待该阶段结束，并保留强制退出期限。收到启动意图后失联而没有启动观察，返回启动未知，不能标成未执行。

`packages/runtime-sandbox/scripts/qualify-job-host.mjs` 使用固定假数据，在真实 Mac SRT 验证显式启动、参数原样传递、假秘密拒绝、输出洪泛、取消、超时及策略摘要变化拒绝；`--installed` 验证打包入口。新增单元测试与已有策略测试共 18 项通过。实际 `setsid()` 负向用例已证明：主命令退出、stdio 关闭、SRT reset 成功后，脱离原进程组的子进程仍能写入专用测试文件。该测试子进程有界自退出，不留下常驻任务。因此当前控制器对已启动任务始终报告 `taskTreeCleanup: unknown`；源码探针和安装产物均不签发生产资格。2026-09-08 Owner 已接受首批原生 Mac 不以任意后代必定回收为硬性条件；上述负向证据保留为已知限制。正式启用仍须完成尽力停止、清理未知持久化、禁止自动重放及重启核查，不把组件探针计为这些接线的验收。

Task 4 的前置账本部分已提前实施：追加迁移 `0027_sandbox_job_observations.sql`，通过 `SqliteProductStateRepository.sandboxJobJournal()` 提供原子准入、追加、读回与待核查分页。在同一个 `BEGIN IMMEDIATE` 事务内检查现有部署权威、Handle/Grant、Run 和执行租约，再保存启动序号；回放返回 `applied: false`，不能据此再次启动。过期后仍可在当前部署权威下追加停止/核查观察；完成必须引用本次调用已持久化的受保护输出。`admit()` 已将现有凭证消费与首条作业观察放入同一事务，直接的独立 `sandboxPrepare` 写入口已禁止。摘要由实际消费结果生成；重放凭证没有账本时直接拒绝，不能补建后自动启动。首次观察写入失败时凭证和 Handle 消费一起回滚。`WorkerDelegationAdmissionService` 已支持由可信组合显式选择的 SRT 模式，使用事务返回的冻结凭证构造既有 Worker 消息，避免二次消费或额外读回。真实 SQLite 测试验证首次单次派发、重放不派发、未知旧请求、scope 准备失败及准备期间权限过期拒绝执行。准入时间在异步准备完成后重新获取。生产 `service-main` 尚未配置此模式；作业身份已通过 `work.execute.payload.sandboxJob` 和现有认证 UDS 传递；调用方不能指定该身份。Worker 未配置 SRT 监督器时返回 `SANDBOX_SUPERVISOR_UNAVAILABLE`；配置后走独立生命周期分支，不会丢弃身份后使用旧后端执行。`SandboxScopeService` 已从现有 Payload 存储读取有界 JSON 正文，使用现有加密端口验证 Owner/Agent 与内容完整性，再验证 scope 摘要及计划绑定；错误仅返回 `SANDBOX_SCOPE_UNAVAILABLE`，不泄露正文。准入服务必须先通过此检查才能消费凭证。真实加密 Payload 与 SQLite 测试覆盖身份替换、过期、密文篡改和摘要替换。目录授权校验已通过既有状态端口接入，拒绝缺失、撤销、过期、版本/根/主机/授权变化及操作范围不足；scope 中的 `parentRequestId` 必须匹配准入请求的 causationId。测试使用真实加密 Payload/SQLite 与注入的目录状态端口，并非正式主机授权来源验收。正式目录状态来源、网络授权、父工具调用关系、主机资格解析与 Job Host 监督仍待接入。

生命周期协调器证据（2026-09-08）：`SandboxJobLifecycleService` 复用既有 `SandboxExecutionPort` 和 SQLite 账本，`prepareHost` 只准备基础设施，只有首次成功追加 `starting` 的协调器才能启动任务。两个协调器竞争时，未获得启动权的一方取消自己的 Job Host，但不得追加观察覆盖获胜作业。准备期间取消不启动；失联核查将已有启动意图转为 `reconciling/quarantined`，保留已存输出引用，不调用启动器。准备和启动前各复核一次当前 scope/资格；凭证、Run、租约的最终检查仍由同一 SQLite 启动事务执行。真实 SQLite 回归包含多协调器竞争、重复请求、准备期间取消、复核失败、清理未知与恢复不重放；注入的主机 session 不是正式主机资格。

`apps/execution-worker/src/product-job-host.ts` 将既有 Job Host 接到产品 session 端口，固定采用原请求时间加墙钟额度与原截止时间两者中较早者，不因重新准备而延长执行时间。正文交给受保护输出存储回调；存储失败返回未知。适配位于 Worker 组合层，`runtime-sandbox` 继续只依赖 SRT，不反向依赖应用层。正式 Worker 的执行分支和 broker 生命周期装配已经实现；主机 scope/资格解析及启动组合仍未启用这些组件，不能将组件交付等同正式 Worker 验收。

跨进程账本组件（2026-09-08）：既有认证 Payload UDS 增加 `payload.sandbox.job` 读取/追加操作，继续校验 Worker 启动身份、Agent Service 启动身份、epoch/fence、消息上限和时限。Agent Service 从冻结调用凭证和当前部署权威校验作业/主机绑定，Worker 不能传入数据库 authority。该通道不开放准入或任意账本查询；没有可信主机配置时拒绝服务。真实 Unix socket 与 SQLite 回归覆盖未握手、主机/作业/Owner/Worker 身份替换、权威变化、重复追加、旧观察重放返回最新状态，以及隔离状态重连回读。跨进程端口组件已完成，正式服务组合仍未启用；Worker 重启后的旧启动身份恢复须走 Agent Service 核查，不能降低冻结凭证的身份校验。

正式入口接线证据（2026-09-08）：`ProductionSandboxExecution` 验证 broker 返回的冻结计划与执行消息一致，再调用既有生命周期；取消可以早于异步绑定或发生在准备期间，停止服务也先请求停止作业。已记录启动意图的请求走核查，不能重新启动。`createBrokerSandboxExecution()` 将生命周期的读回/追加映射到已认证 Payload UDS，不向 Worker 开放 `admit/listPending`。启动 RPC 失联无法确认是否已提交时返回 `result_unknown`；清理未知不能映射成成功。`recoverSandboxJobsAtStartup()` 已由正式 Agent Service 调用，在准入入口创建前把旧 prepared/starting 作业转入隔离；核查没有启动能力，重复启动核查不追加伪造完成记录。真实 UDS/SQLite 测试覆盖执行后隔离、准备期间取消、已有启动记录恢复、重复请求及不同启动身份下的恢复；这些测试仍使用受控主机 session，不能计作实际 SRT 主机资格。

主机部署格式证据（2026-09-08）：新增 `sandbox-host-binding.v1` 与 `sandbox-runtime-qualification.v1`，将主机、profile、运行产物、runner 和证据摘要绑定到同一部署项。Mac 记录资源观测模式、尽力停止及脱离后代可能存活的限制；Linux 仍要求任务树终止和崩溃清理证据。部署加载器拒绝摘要或主机不匹配，也禁止用 SRT 资格放宽旧 process 后端的检查。主机清单只描述可用目录、工具链及网络上界，不提供目录或联网授权。合同与加载器测试使用合成记录，不能作为真实资格签发；正式启动组合、主机复核和安装验收仍未完成。

主机产物复核组件（2026-09-08）：新增 `platform-node/src/capabilities/sandbox-host-verifier.ts`，复用既有安全文件摘要读取，按安装工具的路径、内容摘要、大小与权限格式复核整个运行产物目录；检查实际 OS/架构、主机/profile、runner、目录设备与 inode，以及计划所需保证和资源上界。每次调用重新读盘，拒绝符号链接、可被其他用户写入的文件、目录身份替换、辅助文件变更和额外注入文件。新增 14 项测试通过；现有产物验证 3 项、部署加载器 13 项回归通过。该组件尚未接到正式启动组合，不签发主机资格，也不能证明检查后到启动之间文件绝对不会变化；目录/网络授权、受保护调用上下文及启动点复核仍须由正式接线完成。

真实 SQLite 回执暴露并修复了原合同的摘要格式不匹配：`semanticFingerprint` 保留持久凭证的 `sha256:` 前缀，不改写旧凭证。execution-contracts 的内部相对导入改为项目既有的 `.ts` 源码写法，使 SQLite 源码 Worker 可以加载校验器；Node 构建仍将路径改写为 `.js`。相关回归覆盖旧 schema 26 升级、数据库重开、重复启动、租约改变、Handle 撤销、Run 取消、过期清理、事务回滚、输出持久化与终态禁止重启。正式 Worker/Job Host 仍未切换到这套账本，不能将这些测试计为主机执行资格。

### 正式接入核对（2026-09-09）

已有调用回执、受保护工具结果、文件读取 `context` 与阶段记录，以及 `sandbox_jobs.plan_json` 继续作为数据来源。文件读取的完整 `call/binding` 已持久化，不能因单条 `runtime-tool-intent` 没有这些字段，就判断整个系统缺少调用身份存储。模型请求也仍由 `WorkerDelegationService` 派发给 Worker。

| 接入点 | 当前实现与验证边界 |
|---|---|
| 候选计划 | `createSandboxExecutionPlanCandidate` 已连接现有 `WorkerDelegationService`；投影原有调用上下文与 Handle，不生成假指纹或提前消费授权 |
| 目录与父调用 | `createProductionSandboxServices` 读取现有目录授权状态，从文件读取 context、阶段 ID 与输入记录产生受保护 scope；Worker 子调用查同一作业账本并收紧父范围 |
| 网络授权 | Owner 已批准复用同一 Grant 和现有通道；解析器核对同一操作的审批快照 `targets` 中 `network-domain` 确切域名、Grant 状态、审批指纹和主机上界，不再次消费 Grant。缺少明确域名授权则拒绝联网 |
| 启动复核 | 既有认证 `payload.sandbox.job` 增加 `resolveScope`/`resolvedScope`；Agent 在 scope 读取前后核对当前凭证，在新增启动观察前重新验证目录、网络、父调用与真实主机。旧观察重放、清理与读回不恢复执行权限 |
| Worker 组合 | `createProductionSandboxWorker` 通过认证通道取得 scope 和原输入，在 Worker 编译策略并启动固定 runner；Agent 不依赖 SRT。`prepared.policyDigest` 可为空，第一笔原子 `starting` 写入 Worker 策略摘要，此后不能替换 |
| runner 输入与结果 | 至多 48 KiB 输入经私有 IPC 后仅进入 stdin；stdout 原样保存为受保护 Payload，资源观察写入现有作业观察 JSON，保持原 runner 输出合同 |

实际 root scope 产生器目前连接文件读取的 inspect/read 工作流；其他工具的授权范围产生器、通用 runner 合同仍属于后续工具迁移，不能因共享组件已接入而声称全部工具可用。未配置可信部署、scope 或主机资格时拒绝 SRT 执行。正式部署资格仍由主机安装来源负责，本次不签发资格。

资源观测组件使用固定 `/bin/ps` 的有界查询，只读取 PID、父 PID、进程组、CPU、RSS 与启动时间；每次查询完成后间隔 100 ms 采样，不并发堆积查询。跟踪已观察的后代及同组进程，已退出进程的观察 CPU 保留，PID 复用按启动标记区分。超过计划 CPU/内存额度或观测失败时请求停止。采样可能漏掉短命或未观察到的后代，不证明硬配额或完整任务树回收；原生 Mac 清理仍可为 `unknown`，对应作业持久隔离并禁止重放。

验证（2026-09-09）：相关 unit/contracts/integration/node-services 26 个文件、274 项回归通过，包含候选投影、网络授权拒绝、目录撤权、首笔启动摘要固定、资源观察持久化和既有文件审批恢复。类型、依赖边界、产品不变量、覆盖登记、秘密扫描和 CI 测试登记检查通过。全仓库 `npm run check` 在 lint 阶段失败，涉及大量既有文件；不能把这些分项通过称为整套检查通过。

真实 Mac 受控组合验收通过：`HIMAWARI_LIVE_SANDBOX_PROBE=1 node packages/runtime-sandbox/scripts/qualify-production.mjs` 使用临时假数据、实际文件摘要和受控测试资格，经过实际 Agent scope 解析器、认证 Payload UDS、SQLite 账本与 Worker/Job Host 组合，验证允许读取、秘密与越界拒绝、只读目录写入拒绝、代理网络拒绝、受保护结果和资源观察保存，以及清理未知作业在重复投递和重新创建 Worker 后不重跑。输出 `productionSandboxProbePassed: true`，同时保持 `productionSuitable: false`。该脚本从已准备的测试调用开始，不能证明真实模型/HITL 准入端到端完成，也未模拟实际 Worker 进程崩溃或安装恢复。

当前 Node 产物的 `qualify-policy.mjs` 与 `qualify-job-host.mjs` 均退出 0，验证二进制 stdin、固定参数、输出上限、取消、超时与 CPU/内存阈值停止；CPU 用例观察到 110 ms，内存用例使用 1 字节阈值避免内存压力。任务主进程退出、管道关闭和 SRT reset 可观察，任务树清理仍记录 `unknown`。两项脚本继续输出 `productionSuitable: false`。本次修改的 47 个 TypeScript/脚本文件 lint error 检查通过；全仓库 lint 失败仍单独保留。

网络探针已纠正：此前固定脚本只把 curl 失败当作拒绝，重新运行发现 curl 可在读取系统 OpenSSL 配置时先失败，旧说法“已证明代理拒绝”证据不足。现在固定 CONNECT 探针使用 SRT 为任务生成的本地代理认证，要求实际 `X-Proxy-Error: blocked-by-allowlist` 响应，不放宽正式文件策略。

Task 3 保持未完成：仍缺正式安装主机资格、完整模型/文件审批链路以及真实失联/重启恢复验收。SQLite 继续在同一事务中消费凭证、生成 `semanticFingerprint`、保存作业，并在启动事务复核 Handle/Grant/Run/租约；未增加权限库或 Run 状态机。


## Task 1–2 验证记录

2026-09-07 至 2026-09-08 本地验证：Pi compatibility 6 个文件、62 项测试通过；统一作业合同 10 项、现有工具工厂 2 项、Capability 回执与 runtime continuation 集成回归 30 项，以及备份/迁移 CLI 2 项均通过。类型检查和 Node runtime 构建通过；依赖边界、v0.2 覆盖、产品不变量、秘密扫描与 CI 测试注册检查通过。

文档 strict 校验为 0 错误、0 警告；3 个受 S1 Spec 变更影响的 Runbook 已核对语义、重新封存并通过静态合同检查。没有执行真实安装、备份、迁移或 SRT 作业。原始指南补充 frontmatter 后，正文 SHA-256 与修改前一致。

全仓 `npm run check` 仍在既有 lint 上失败：182 个错误、977 个警告；本次改动代码的定向 Biome 检查无错误或警告。后续处理记录在 [SOURCE: docs/backlog/BL-20260907-001-修-复-全-仓-既-有-lint-问.md]。这些结果是本地源码和测试证据，不是主机资格或上线验收。


## 本次设计交付记录（2026-09-09）

Owner 已批准 ADR 0025 的方案和文档重设计范围。此次交付更新 ADR 替代关系、架构当前/目标边界、Spec 的事实与资源合同、R1–R12 及 EX-01–EX-18 映射；产品代码、依赖、数据库和主机资格均未因设计修改。本次文档 strict 校验为 0 错误、0 警告；需求覆盖、产品不变量、依赖边界、秘密扫描和 CI 政策检查通过。另核对三份历史 ADR 正文逐字不变、18 项验收在 Spec/Plan 一一对应、12 个实施任务均未勾选完成。本次未运行产品功能测试、真实沙箱/模型或外部服务验收；新合同和验收任务保持未完成。

## 本次范围调整（2026-09-09）

Owner 明确将 MCP 接入和 GitHub 已有 commit 推送移出本次 Spec/Plan，保留产品需求。已调整目标、依赖、任务、验收映射与关闭条件；R1 的既有实现及历史证据不撤销。前文历史记录中的“18 项验收/12 个任务”描述当时范围，不能作为当前完成条件。

## 关闭检查

- [ ] 本次有效任务 R1–R6、R8、R9、R11、R12 及对应 16 项 EX 有可信证据；R7/R10 与 EX-08/EX-16 不计入完成条件，未被标记为完成。
- [ ] 资源监管与清理义务有明确结论，未知未被默认成功或自动重放。
- [ ] 安装行为、架构当前事实、UI 和 Runbook 与实际一致。
- [ ] 未完成必要能力不以归档/Backlog 隐藏；其他后续事项按治理记录。
- [ ] 整批实际交付完成后才归档本 Plan；本次设计完成不关闭实施计划。
