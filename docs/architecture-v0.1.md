---
status: active
document_type: architecture
version: "0.1"
supersedes: ""
superseded_by: ""
date: "2026-08-25"
---
# Himawari Agent Architecture v0.1

## Current System

仓库当前实现是一个私有 npm workspace monorepo 基础。根工具链要求 Node.js `>=22.19.0`，以 npm `11.8.0` 管理锁文件，以 TypeScript `5.9.3` 做 strict、`erasableSyntaxOnly` 类型检查，以 Biome `2.3.5` 做格式和 lint，并以 Vitest `4.1.9` 提供 unit、contracts、integration、e2e、Pi compatibility、browser、admin CLI、Node services 和 workspace scaffold 九个可独立选择的测试项目。

当前代码包含十四个 workspace。`packages/domain` 实现不可变身份、所有权规则、Run 状态机、Agent 权威租约，以及 deployment/fence、Thread 生命周期、消息/检查点、产品 session/device、后台 job/occurrence、Memory generation/lifecycle、GitHub receipt/coverage gap、恢复点/transfer 和 health 状态；两类基础 contracts 保留 `gateway.v1`/`gateway.v2` 与 `execution.v1`/`execution.v2`，Thread 扩展使用独立 `gateway.thread.v3`；`packages/application` 实现产品端口、v1/v2 Gateway、认证 Thread Gateway、Thread command/query/Fork/deletion 组合、最小 Context Formation、Run/Worker 编排、可靠事件、Trace、授权、产品 Memory/projection、增量自动 Memory、Thread 稳定检查点与候选提炼、模型、调度、Attention 和外部结果对账；`packages/platform-node` 已实现可信模型 Provider 边界、Payload envelope encryption、host secret source、严格配置、state-root layout、health/lifecycle coordinator、无私人标签的运行指标、`execution.v2` HTTP/JSON over UDS、同源 v1/v2/Thread v3 HTTP/SSE Gateway、浏览器正文读取/opaque search admission 与身份入口，`packages/runtime-pi` 实现 Pi Agent Runtime 适配器及闭合的产品模型绑定；`packages/testing` 提供 conformance suites、内存参考适配器、牛肉餐厅夹具、故障注入器，以及 v0.2 canonical scope 与 evidence harness。`packages/persistence-sqlite` 已实现规范 schema、十六项不可变 migration、专用 SQLite execution context、state-root lock、持久 deployment/lease、原子 Product State transaction、主要产品 repository、可恢复 Outbox、持久 Gateway Read Model、身份 binding/session/device、产品 Memory/projection job、敏感 Memory 审批元数据、Thread 生命周期/消息/lineage/opaque search projection/durable Gateway event、Thread 摘要/派生候选/provenance、受保护 Payload envelope metadata、受治理删除、GitHub monitor history retain/delete 状态机、加密同机恢复点 create/verify/restore，以及停机 authority transfer；`packages/memory-mem0` 已实现显式配置、单记录投影、检索、清理与产品 ID round-trip 的 Mem0 adapter，并提供把 strict OpenRouter embedding descriptor 映射到 Mem0 既有 OpenAI-compatible embedder 的生产组合；`packages/integration-github` 已实现只读 permission boundary、host-secret/短期 installation token 边界、raw-byte HMAC webhook admission、SQLite receipt/occurrence 去重、bounded mirror、relevance/Attention/coverage-gap、`gateway.v2` monitor enable/pause/revoke handler 和 capability deny 断言。该 handler 已校验 Owner/Agent scope、安装状态、CAS revision、模型/仓库/分类披露，并按撤销顺序同步 scheduler、删除 mirror 后调用 history policy port；SQLite durable adapter 已提供 retry/readback 组合点，最终 Agent Service/Gateway 总组合仍由对应后续 Tasks 验收。

`apps/agent-service` 现有可编程的本地前台组合根、严格 `gateway.v1` in-process transport、production `execution.v2` UDS client、可安装 `main`，以及从严格配置创建并在启动/关闭生命周期中管理的 production Model/Pi 与 Mem0 composition；支持的 OpenRouter 配置会把独立 embedding descriptor 交给 Mem0，deterministic fixture 只报告显式 descriptor，不创建任何 Pi、Mem0 或隐式模型路径。`apps/execution-worker` 同时保留确定性的 `execution.v1` in-process test profile，并实现验证 authority fence、adapter registry、resource ceiling、去重、cursor、取消与对账的 production Worker runtime。两项服务均有可重定位 Node runtime、稳定诊断/退出码和信号 drain，但 public HTTP、身份与真实业务 adapters 尚未在最终 `main` 中组合。`apps/control-center` 已实现 browser-only React/Vite 控制中心基础、typed Gateway client、v2/Thread v3 SSE 恢复、native History typed routes、11 入口响应式三栏/单栏 Shell、`react-intl` 三语 runtime 和 native-first 语义组件；Thread surface 已接通严格 list/detail/search/message/Fork/lifecycle/answer-locale/checkpoint/deletion contract，七个 legacy surface 保持 `baseline_only`，Capabilities/Adapters、Authorizations/Grants 与 Settings 保持 `blocked`，因此全入口仍不等于全业务操作面已接通。`apps/admin-cli` 已实现可执行 doctor、只读 db status 和受 offline lock/confirm 保护的 migration 入口。

已关闭 Foundation Spec 的 Task 1 至 Task 20 已按确定性参考配置实现并验证：[SOURCE: docs/archive/specs/2026-08-25-agent-foundation-design.md] [SOURCE: docs/archive/plans/2026-08-25-agent-foundation-plan.md] 当前 portable durable web-agent Plan 的 Task 20–27 已有代码与确定性资格证据，其中真实 GitHub/Cloudflare、跨主机 transfer、完整浏览器矩阵和最终 Agent Service 生产组合仍按各自证据保持未验证。Task 20 的 OpenRouter 模型路径已完成受保护 transport、strict provider routing、闭合 Pi 运行时绑定、独立 4096 维 Qwen embedding descriptor、严格配置映射、Mem0 OpenAI-compatible projection 以及 Agent Service 启动生命周期接入；embedding 与 primary/fixed fallback generation 的有界 live provider/model/token/cost readback 均已通过。上游仍未公开不可变模型版本，所以本地日期化 catalog snapshot 不是官方 immutable version。

## Boundaries

允许的 workspace 依赖方向是：

```text
agent-service → application + contracts + selected adapters + runtime-pi
execution-worker → application + execution-contracts + selected adapters
control-center → gateway-contracts + browser-only UI dependencies
admin-cli → application + approved offline/admin adapters
persistence-sqlite → application + domain + product contracts
memory-mem0 → application + domain
integration-github → application + domain + product contracts
platform-node → application + domain + contracts
runtime-pi → application/runtime-port + @earendil-works/pi-coding-agent + @earendil-works/pi-ai
application → domain + product contracts
contracts → no internal dependency
domain → no internal dependency
testing → application + domain + product contracts
```

`scripts/check-boundaries.mjs` 从根和各 workspace 的 `package.json` 及 TypeScript import 构建依赖图，检查非精确直接外部依赖、非法方向、循环、未声明依赖和逃出 workspace 根的相对 import。任何 `@earendil-works/pi-*` 依赖或 import 只能位于 `packages/runtime-pi`；domain、contracts、application 和 browser-only workspace 不能直接 import `node:` 模块，browser-only workspace 也只能声明或导入明确允许的浏览器依赖。控制中心当前逐项允许 React、React DOM、`react-intl`、Vite/Vitest 与类型/构建配套，不把 browser-only 放宽为任意 npm 包；`test/integration/workspace/workspace-boundaries.test.ts` 会为依赖图的每个非法 workspace 方向以及 Node、browser、Pi 和本地路径规则运行 negative probe。

根构建可以分别验证 Node 图、两类 contracts、两个服务、browser bundle 和 admin CLI。`build:browser` 在 Vite production build 后执行 `scripts/check-control-center-build.mjs`，机械验证外部 CSS/JS、en/ja locale code splitting、无 source map、无 inline script/style、无动态代码求值，以及 entry/总 gzip 预算；Fastify `GET /*` 只对非 `/api`、非 `/assets` 且 `Accept` 包含 `text/html` 的路径返回同源 SPA shell，未知 API 与非 HTML 请求仍为 404。`scripts/generate-artifact-manifest.mjs` 会在构建后生成 machine-readable manifest，固定根 manifest/lock SHA-256、每个 workspace 的内容 checksum，以及当次 browser artifacts 的路径、大小和 SHA-256；生成物位于忽略提交的 `dist/`，脚本和 checksum contract 才是当前受版本控制的稳定入口。

`packages/runtime-pi` 直接固定 `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-ai` `0.84.2`；提交的 manifest 和 lockfile 不引用相邻的 `../pi-mono`。它只能从 `@himawari-agent/application/runtime-port` 导入 Agent Runtime request/event 类型，不能通过 application 根入口获得 Memory、Permission、Capability Registry 或持久化写端口。Pi `0.84.2` 的发布声明图在 TypeScript `NodeNext` 下包含上游 JSON import-attribute 与 optional provider 声明问题，因此本仓库启用 `skipLibCheck` 仅跳过第三方声明文件检查；Himawari 自有源码仍由 strict TypeScript 完整检查，并以 published package compatibility test 补足运行时证据。该隔离边界落实了产品自有 Pi 适配层决策：[SOURCE: docs/adr/0001-pi-runtime-adapter.md]

## Data Model

领域层以不同的 branded string 类型表示 Owner、Agent、Thread、Session、Run、Turn、Trigger、幂等键、权威 holder 和权威 lease。工厂只接受 1–128 个字符的机器标识，不生成标识，也不依赖数据库、传输或 Node.js API。

实体的所有权链如下：

```text
Owner
  └── Agent
        ├── Thread
        ├── Session ── optional Thread
        └── Trigger ── optional Thread + IdempotencyKey
              Session + Trigger ── ownership check → Run
                                                    └── Turn
```

所有实体是冻结的只读值。Session 和 Trigger 只能关联同一 Owner/Agent 的 Thread；Run 要求 Session 与 Trigger 的 Owner/Agent 相同，且 Trigger 显式指定 Thread 时必须与 Session Thread 相同。没有 Thread 的 Trigger 可以在接纳过程中关联到新建 Session 的 Thread。

Run 从 `accepted` 开始，当前合法转换为：

```text
accepted → building_context | failed | cancelled
building_context → running | failed | cancelled
running → awaiting_approval | reconciling_external_result | completed | failed | cancelled
awaiting_approval → running | failed | cancelled
reconciling_external_result → completed | failed | cancelled
completed | failed | cancelled → no next state
```

因此 `running → awaiting_approval → running` 可以重复，而 `completed`、`failed` 和 `cancelled` 是不可再转换的终态。

Agent 权威租约的领域模型是纯单槽位规则。同一 Agent 的同一 lease/holder 重申是幂等的；不同 lease 或 holder 同时声明会返回冲突；释放必须匹配当前 lease ID。时间、到期、续租和 fencing token 不进入纯领域实体，由 Authority Lease 端口及参考适配器处理；Task 5 的产品状态提交要求每个新写命令携带并匹配当前 lease ID 与 fencing token。

持久 Web 基础新增的产品状态使用独立 branded IDs，供应商 identity 只作为 metadata：Mem0 provider record、外部身份 subject 和 GitHub delivery ID 都不能替代产品 Memory、Session 或 receipt ID。Deployment 只允许 `inactive_ready → active → retired_pending_transfer → retired`，激活必须提高 authority epoch 并使用正 fencing token；任何非 active、deployment 不匹配、epoch 不匹配或 token 不匹配都会返回 `DOMAIN_STALE_AUTHORITY_FENCE`。Thread checkpoint 重试保留同一 job/generation identity；job、occurrence、Memory generation/lifecycle、GitHub receipt/gap、recovery point 和 transfer 均有显式终态，不允许从完成、删除或 retired 状态复活。

## Wire Contracts

`packages/gateway-contracts` 发布 `gateway.v1` 产品协议。它包含统一 Trigger admission，Thread 创建和关闭、Run 取消、语义审批响应，Thread/Run 快照查询、Trace 分页查询、可恢复事件订阅，Thread/Run 快照和有序流事件。Run 只能由统一 Trigger admission 启动；Gateway 不提供绕过触发接纳的新建 Run 命令。

Owner Thread 产品聚合在 `packages/domain/src/thread.ts` 中持有 active/archived/trashed/deletion 状态、title revision/source、pin order、answer locale、message watermark 与不可变 Fork lineage；正文、标题、summary 和命令结果只通过受保护 Payload reference 关联。`ThreadCommandService` 以稳定幂等语义驱动 SQLite fenced transaction：Owner message admission 在一次事务中创建 Message、Trigger、Run、Turn、Thread revision、receipt 与 Outbox，最终 assistant commit 只把 committed message 加入历史。SQLite 的正文与标题搜索只保存授权方生成的 opaque token，查询固定 projection version、Owner/Agent、生命周期、时间和关联任务状态；投影可重建且不成为权威。Fork 只接受已提交 Turn/watermark，不复制 Task、Approval、Grant 或长期 Memory；来源永久删除后只保留不可解析 lineage marker。

Gateway 信封携带消息标识、schema 版本、相关关系、可空因果关系、数据等级、Owner/Agent scope 和 actor。所有改变状态的命令另带幂等键。流事件以 `messageId` 作为事件标识，并携带 cursor、Session、可选 Thread/Turn、Run、父事件、严格正数 Run 内序号、事件时间、写入时间、事件类型和可空 Payload 引用。

`packages/execution-contracts` 发布 `execution.v1` Worker 协议。请求覆盖工作执行、取消和外部结果对账；事件覆盖进度、结果、取消确认和对账结果。所有请求包含幂等键，所有消息包含相关和因果标识、Owner/Agent/Run/Worker Run scope 及数据等级。工作执行只携带输入、委派上下文、短期能力句柄和秘密引用；结果和错误正文也通过引用或稳定机器码表达。

由于 v1 parser 会拒绝未知字段和消息类型，持久 Web 扩展没有暗改 v1，而是分别发布 `gateway.v2` 与 `execution.v2` 和独立 JSON fixtures。`gateway.v2` 覆盖 Thread message/checkpoint、approval、task、inbox、Memory、Trace、product sessions/devices、health、collection snapshot 和 durable stream event；`execution.v2` 覆盖 Worker handshake/readiness、cursor replay、deadline、cancellation、resource ceiling、result 和 reconciliation。两个 v2 信封都携带 deployment/authority epoch/fence、数据等级、风险和授权引用；高风险或关键 mutation 缺授权、零 epoch/fence、不支持版本、未知字段或不匹配 outcome 一律 fail closed。正文、Worker 输入输出和秘密仍只通过 Payload/secret reference 传递。

两类协议使用零外部依赖的运行时 schema，同时导出从 schema 推导的 TypeScript 类型。解析器要求精确字段、规范 UTC 毫秒时间戳、受限枚举和有界整数；未知字段、未知消息类型及不受支持的版本会返回带固定 `CONTRACT_VALIDATION_ERROR` code 和字段路径的错误。`public`、`private`、`sensitive`、`restricted` 是当前四个数据等级。v1 JSON 兼容性夹具固定首版 wire shape；在 v1 中添加未知字段不会被静默接受。

## Application Ports and Reference Adapters

`packages/application` 当前公开以下产品端口，不包含任何具体供应商、数据库、传输或 Pi 类型：

```text
StateStore          ReliableEvent      ProductStateRepository
ReliableEventSink   TraceStore         PayloadStore       AuditLedger
PayloadProtector    SessionDeletionState/Target
AuthorizationStore
CapabilityRegistry/ExecutionHandle
Memory              Model              AgentRuntime       RuntimeTool
Capability          WorkerRun          Secret              Scheduler
Attention           AttentionState     Delivery            AuthorityLease
GatewayAccess       GatewayControlPlane                     GatewayReadModel
ExternalActionReconciliation
Clock               IdGenerator
Configuration       PersistenceLifecycle     DeploymentAuthorityState
ThreadMessage       ThreadCheckpoint         ProductMemoryState/Projection
IdentityAssertion   SessionDeviceState       BackgroundWorkState
GitHubIntegration/Read                      RecoveryPoint/AuthorityTransfer
HealthState         GatewayV2ControlPlane/ReadModel          ExecutionTransport
```

端口值使用领域 branded identity、产品数据等级、稳定引用、JSON 值、`Uint8Array` Payload 和产品事件。`ApplicationPortError` 提供固定 `PORT_*` 错误码，使冲突、缺失、重复、非法操作、非权威写入、已撤销句柄和测试注入故障可以由应用层稳定分类。Secret Port 只签发与 Owner、Agent、Run、用途、scope 和期限绑定的 opaque handle；Agent Runtime、Model 和 Capability 事件只传 Payload 引用与机器错误码。

`packages/testing` 的 `./conformance` 子路径导出可复用 Vitest suite。每个 suite 接收 adapter harness，所以未来数据库、供应商或远程适配器可以用自己的 setup/teardown 重跑同一行为契约。当前内存参考实现覆盖全部端口，并在读写边界做防御性复制；它们是确定性测试替身，不是生产持久化或安全边界。

测试控制包括 `ManualClock`、按 namespace 递增的 `DeterministicIdGenerator` 和按命名 checkpoint/调用次数触发的 `DeterministicFailureScheduler`。Authority Lease 参考适配器使用注入时钟处理到期、续租和单一 live lease，并在每次新 claim 时递增 fencing token。故障调度在 mutation 之前触发，使失败后的状态保持未写入并可确定性重试。

### Product state commit and reliable publication

`RunStateCommitCoordinator` 是窄状态提交服务；`RunCoordinator` 组合它和其他产品端口，但不取代原有提交边界。状态提交服务读取产品 Run 状态、调用领域 `transitionRun()`，并把下一版状态、幂等命令结果和对应业务事件提交给 `ProductStateRepositoryPort`。Run 采用 `run:<RunId>` 状态键；业务事件采用由命令 idempotency key 派生的稳定事件 ID。

参考 Product State Repository 在一个无 `await` 的 mutation 边界内同时写入 State revision、命令结果和 pending Reliable Event，提供内存 transaction/outbox 等价语义。提交前会完成以下检查：

1. Owner、Agent 和 idempotency key 作用域内是否已有相同 command type/fingerprint；相同命令返回原提交结果，不同命令返回冲突。
2. 当前 Authority Lease 是否与命令携带的 lease ID 和 fencing token 完全一致；仅回放已经提交且不再写状态的命令可以在租约变化后返回原结果。
3. State expected revision、事件 ID 唯一性及事件 idempotency key 是否与命令一致。

通过检查后，预提交故障不会留下 State、命令结果或 Event 的任一部分。并发相同命令会在 authority 查询后的第二次幂等检查处收敛为一次提交。

`ReliableEventPublisher` 分批读取 pending 事件，交给 `ReliableEventSinkPort` 后再标记 published。发布前失败保留 pending 事件；Sink 已接收但 published 标记失败时会按同一 event ID 重投，Sink 返回 `duplicate` 而不产生第二次可见交付。新建协调器和发布器只需复用同一 Product State Repository 即可恢复 Run 和 outbox，不读取 Pi Session 文件。

内存参考适配器继续为所有端口提供可复用 conformance，但只代表确定性产品语义，不代表跨进程耐久性。Product State、Reliable Event、deployment authority、lease、Trace、Payload metadata、Audit、Authorization、Capability Registry/Handle、Scheduler、Attention/Delivery state 和删除状态的相同 conformance 已直接在真实 SQLite harness 上通过。Gateway Read Model 的 scope、cursor、retention 与 restart 行为另有真实文件集成测试；生产 Memory、模型、Secret、Capability 隔离和正式服务组合仍属于后续 Plan 任务。

### SQLite schema and immutable migrations

`packages/persistence-sqlite` 现在以十六个连续 SQL migration 建立 58 个产品表及 2 个内部治理表。产品表规范化保存 Owner/Agent、deployment/authority、Thread/Run、session/device/外部 subject binding、approval/Grant、capability、Product State、command result/outbox、Trace/audit、Task/Attention、Gateway Read Model、Memory、GitHub、删除、恢复点与存储健康状态；foreign key、唯一键、revision、authority epoch/fencing token 和稳定幂等键在 schema 层形成第一道约束。第九个 migration 扩展后台 occurrence 与 Run checkpoint 恢复字段，第十个 migration 增加唯一 Owner 外部身份 binding 和产品 session authentication reference，第十一至十三个 migration 增加 Memory projection reliability、敏感候选审批和 Thread distillation；第十四个 migration 增加 GitHub history policy 的 durable retry/readback 状态，第十五个 migration 增加 Thread lifecycle、opaque Message/title search projection 与删除 task binding，第十六个 migration 增加 cursor-ordered committed Thread Gateway event。`schemaCatalog` 为每个表固定产品端口、生命周期、加密或 Payload 引用分类、删除关系和 migration owner，不能用供应商表替代产品权威状态。

迁移 ledger 持久化连续 `sequence`、`name`、`phase`、SQL SHA-256 与应用时间。loader 验证定义连续性和 digest；启动会拒绝历史内容不匹配、ledger 空洞、未知已应用 migration、未来 schema 及过旧 writer。`expand → backfill → verify → contract` 是受检查的单向 change-set 阶段，系统不提供自动数据库 downgrade。

真实文件连接固定 `foreign_keys=ON`、本地 WAL、`synchronous=FULL`、5000 ms busy timeout 和 1000 页自动 checkpoint，并要求 SQLite 至少为 `3.51.3` 且 `quick_check` 成功。已有 schema 执行下一 migration 前必须提供由 SQLite backup API 创建、完整性检查通过、绑定当前主机、源路径、schema sequence 和文件 digest 的同机 snapshot；fresh create、连续升级、重复运行、并发 contention、损坏 ledger、未来 schema 与旧 writer 已由真实 SQLite 文件契约测试覆盖。`SqliteProductStateRepository.open()` 在取得 state-root lock 后调用该引擎，再把 current schema 交给专用 execution context。[SOURCE: docs/adr/0018-sqlite-product-state-authority.md]

### Encrypted same-host recovery points

`SqliteRecoveryPointAdapter` 实现 `RecoveryPointPort`，把 SQLite online backup 和数据库实际引用的 content-addressed Payload ciphertext 作为唯一 allowlist；`runtime/`、`cache/`、lock、socket、日志、secret 与 orphan ciphertext 不进入恢复点。每个文件用随机 DEK 和独立 nonce 执行 AES-256-GCM，DEK 由配置声明的 host `backup-encryption` KEK 包装，canonical manifest 另以 HMAC-SHA256 认证；产品状态只保存 manifest reference、digest、状态与时间，不保存 key material。

create 在最终 rename 前自动解密到权限受限 staging，并核对 manifest authentication、ciphertext/plaintext digest、schema sequence、SQLite quick/full integrity、foreign key、全表 row counts、Payload envelope authentication 和可靠事件 Outbox continuity。restore 只接受配置中的同一 state root、精确确认词和可独占 state-root 管理锁；验证完成后先把当前 `data/` 移到唯一 previous 路径，再原子放入新 data，任一切换阶段失败都恢复 previous。manifest 固定 30 天 `retainUntil`，`purgeExpired()` 删除到期加密副本与恢复点记录；这只是同机逻辑恢复，不改变 authority，也不是 off-host disaster recovery。[SOURCE: docs/runbooks/backup-restore-runbook.md]

### SQLite execution, authority and atomic product commits

`SqliteProductStateRepository` 在取得显式 state root 的进程独占锁后启动专用 Worker 线程；只有 Worker 持有 `better-sqlite3` connection。主 Agent Service event loop 通过结构化消息异步等待，所有读写按同一消息队列排序。锁以原子目录和主机/PID/token owner record 表达；只有同机 PID 已确认死亡时才原子回收专用 stale lock，正常关闭会核对 token 后释放。

每个 Product State mutation 在一个 `BEGIN IMMEDIATE` transaction 内依次验证幂等 command、当前 active deployment、未释放且未过期 lease、authority epoch/fencing token、expected revision、command fingerprint 和 Event identity，然后共同写入 `product_state_records`、`command_results` 与 pending `reliable_events`。相同 command 并发收敛为一次 commit 和一次 replay；相同 idempotency key 的不同 fingerprint、inactive/retired deployment、stale epoch/token/lease 和旧进程消息均 fail closed。`AuthorityLeasePort` 与 `DeploymentAuthorityStatePort` 共享同一 execution context，持久化单 live lease、续期/过期、单调 fencing token 和不可复活的 retired lifecycle。

运行状态报告 writer queue 深度、最后 transaction duration、busy timeout、WAL bytes 与文件系统 free bytes；低于配置水位时进入 write restriction。checkpoint 只允许受控 `PASSIVE` 或 `TRUNCATE`。真实文件测试覆盖主线程 timer 在同步 driver stall 期间继续运行、并发重复命令、live state-root lock、20 ms `SQLITE_BUSY`、长 reader 下 bounded checkpoint、配置磁盘水位、由 `max_page_count` 触发的真实 `SQLITE_FULL`，以及子进程在 state/result/event 写入后被杀死的逐点 rollback。COMMIT 后回包前被杀死会在重启后返回原提交，不重复副作用；每次重启都通过 WAL、`quick_check` 与 foreign-key recovery。[SOURCE: docs/adr/0018-sqlite-product-state-authority.md]

### SQLite durable repositories, Outbox and Read Model

Trace、Payload metadata、Audit、Authorization/Grant、Capability Registry/Handle、Scheduler、Attention/Delivery、Identity 与 Session 删除适配器复用同一 `SqliteExecutionContext`，只有专用 Worker 持有连接。完整产品记录使用 JSON 列保存精确端口值，owner、agent、run、status、revision、时间和 Payload reference 同时进入规范化列与索引；作用域敏感而原端口未携带 scope 的读取，由构造适配器时固定的 Owner/Agent 约束。Payload adapter 只持久化调用方已经提供的 ciphertext、算法、key reference、digest、content type 和分类；正式写前加密、外部 ciphertext store 与 host secret source 已由 platform-node 适配器提供，全部正文路径的最终组合仍未完成。

Reliable Event 有 `pending → claimed → published` 生命周期。Publisher 在一个即时事务中回收已到期 claim、按稳定顺序认领有界批次，并只接受匹配 `claim_id` 的 acknowledgment。若 sink 已接收而进程在 acknowledgment commit 前退出，下一实例会回收 claim、重放同一 event ID；consumer receipt 以 `(consumer_id, event_id)` 唯一键把重复交付收敛为一次处理。传统 `ReliableEventPort` 仍保留同内容 append 幂等语义。

Gateway Read Model 分开保存单调 revision 的 Thread/Run snapshot、全局持久 cursor sequence、scope 列和 retained stream event。查询必须同时匹配 Owner/Agent 及 Session/Thread/Run filter；subscription cursor 也必须属于相同 scope。进入 Trash 的 Thread 即使投影行尚在，也会由与权威 `threads.status` 的联表条件从 Thread/Run snapshot、Trace query 和 subscription 中隐藏。Thread snapshot 最多保存 1000 个 Session 和 1000 个 Run 引用，同 revision 不允许改写不同内容。Retention watermark 只能单调前移且不能越过最新 cursor，水位以下事件被删除，旧 cursor 返回明确错误而不是静默跳过。

S2 Thread repository 的列表路径把 lifecycle 与 pin 过滤下推到 SQLite，并按“已置顶组、`pin_order`、`updated_at DESC`、`ThreadId`”做 keyset 分页；cursor 引用的 Thread 不存在时 fail closed，要求客户端重新取得 snapshot。opaque Message/title search projection 同样在 SQL 内完成 Owner/Agent、projection version、lifecycle、时间与 task status 过滤，再按 `ThreadId` 分页；查询端口不接收明文正文。Thread 专项资格在 10,000 个同时间戳 Thread、200,000 条初始 Message、8,000 active/1,000 archived/1,000 trashed 上完整枚举列表与搜索，无重复或遗漏；active list/search/pin/Fork/projection rebuild 的 p95 为 2.811/8.835/3.215/1.262/0.646 ms，repository 正常关闭重开为 357.85 ms。100 个 rebuild 目标删除旧 projection version 后保留 10,000 条 current 行且 stale 行为 0。数据只存在临时本地 SQLite，并不构成生产容量、跨主机或 soak 证明。

Worker 在 `ready` 前执行冷启动恢复：过期 Outbox claim 回到 `pending`，中断的 `delivering` 以新 revision 回到 `pending` 并记录 `PROCESS_RESTARTED`；恢复报告枚举 pending event、未终结 Run/checkpoint、pending approval/delivery/deletion、到期 work lease、可安全重试 occurrence、可见 blocker、`MODEL_BLOCKED` 和未知外部结果。正式 Agent Service 已在 Worker handshake 前打开专用 SQLite execution context，并把这些脱敏计数写入启动诊断。恢复只重新暴露或 claim 可恢复工作，不回答 Owner 审批、不重放未知外部副作用，也不把旧 authority fence 变成当前权威。

### Session Trace, protected Payload and deletion propagation

`SessionTraceRecorder` 生成 `trace.v1` 信封并由 Trace Store 强制校验 Run 内严格连续序号、稳定 Run scope、父事件归属及已有因果事件的相关关系。事件正文不内嵌模型输入、工具结果或审批快照，而是在写入前转换为产品 JSON、脱敏、交给 `PayloadProtectorPort`，最后只保存 Payload 引用。无法确认安全转换的负载不会写入 Payload；Trace 改写为不含原文的 `trace.redaction_failed`，并留下最小失败审计记录。

Payload 端口的持久化输入是 ciphertext、算法标识、key reference、内容 digest 和分类元数据，不接收明文语义字段。`packages/testing` 的 `test-xor-v1` 只用于证明“写前脱敏、保护后存储、引用组装”的接口顺序和防御性复制，不是生产密码学实现，也不能成为部署配置。

`SessionDeletionCoordinator` 继续为 Session 删除提供四目标 conformance。`ThreadDeletionCoordinationService` 与 SQLite Thread repository 先在同一权威 writer 中查询稳定 task binding，并以独立、带 revision/fence/idempotency 的 pause、cancel 或 rebind 命令收敛 active task；归档和恢复不修改 Task、Approval 或 Grant。active task 未解决时 Trash 与永久删除原子拒绝，永久删除还要求逐次 authorization reference 与 recent-auth。真实离线物理管理路径由 `SqliteGovernedDeletionAdapter` 承担：Thread、task 与 Memory 进入 7 天 Trash 时立即退出普通读取、调度或检索，但适配器不替 Owner 自动选择 task 动作；`himawari delete trash|restore|inspect|purge|purge-expired` 要求 stopped service、state-root 独占锁和精确确认词，Thread mutation plan 同时显示受影响 task IDs。

永久删除在一个 SQLite 即时事务中级联 Thread/message、Run/checkpoint、Approval、Trace、inbox 和投影行；已经独立暂停、取消或重新绑定的 Task 保留自身定义与历史，来源 Thread binding 失效时变为 `null`，不会随 Thread 被静默删除。保留的长期 Memory 只把 provenance 标为 `source_deleted` 并清空 `source_thread_id`。未被其他行引用的 Payload metadata 与受管 ciphertext file 随后删除；search/cache/archive 使用 state root 内的确定性受管 artifact 路径并逐项回读。每个目标的 attempts、稳定失败码和验证时间保存在 `deletion_tombstones.record_json`，物理目标失败时保持 `deletion_pending`，重试只处理尚未验证的目标。已发布或待发布的外部副作用内容被移除后，只增加 SHA-256 引用的最小 Audit 墓碑，不保存原正文。带 provider projection 的 Memory 先持久进入 `deletion_pending`，必须由既有 durable Memory projection cleanup 到 `deleted_verified` 后才允许产品行与 Payload 最终清除。

SQLite 运行状态公开 `normal`、`warning`、`write_restricted` 三档，并记录 database/WAL/free bytes、writer queue、Outbox、background job、Memory projection、deletion 与 retained SSE 计数。严重 headroom 不足会让普通 repository write fail closed，但认证只读、离线删除、恢复点/transfer 管理路径不依赖该 admission gate；系统没有自动删除 Owner 内容的代码路径。`RuntimeMetricsRegistry` 只接受固定低基数指标名，不接受 Owner、repository 或正文标签；详细 dependency health 与 metrics 仅在认证 API 下返回，公共 `/health/live` 和 `/health/ready` 只返回最小状态。结构化诊断在序列化后再次执行机器秘密脱敏。

### Permission, approval and Grants

`PermissionService` 接受模型或其他调用方提出的产品 `ActionIntent`，但只由版本化确定性策略和持久 Grant 产生 `ALLOW`。显式 `DENY` 规则优先；未命中规则或 Grant 的行动形成 `ASK`。Authorization Store 不可读、Grant 消耗冲突或其他组件故障一律 fail closed，不能由模型输出修正。

Foundation `ActionIntent`、`PermissionService` 与 `CapabilityRegistryService` 保留为 `execution.v1` 兼容层。v0.2 的 `authorization.v2` 意图固定 11 类 ActionKind 和四级风险，完整保存 target/resource、capability version、classification/disclosure、side effect、recipients、cost/frequency、credential/access、reversibility、idempotency、模型建议、确定性 fact 与最终风险；未知字段、缺失语义和模型降低风险均不可执行。Approval Request 保存该不可变语义快照及稳定 hash；响应 hash 不同则拒绝。无 UI 时只把请求标记为 `queued_no_ui`，进程重建后从 Store 恢复。过期只会进入 `expired`，相同 Intent 的超时或重试不能变成允许；之后的尝试必须形成具有新稳定 identity 的 `ActionIntent` 与 Approval Request。CRITICAL 批准还必须保存 recent-auth reference。

Grant 与 Capability 声明分离。一次性 Grant 精确绑定原 Intent 并只有一次使用预算；长期 Grant 只允许范围有界、无披露、无副作用、非敏感的 READ，并约束 capability/version、operations、resource identities/prefixes、最大数据等级、副作用、收件人、每次/累计费用、频率、次数、期限和撤销状态。SQLite 以稳定 usage identity 和 revision CAS 在一个 transaction 内写入 Grant 次数/费用、`authorization_usage`、Trace、Audit 和待发布 Outbox；相同重试只消费一次。该边界落实确定性授权决策：[SOURCE: docs/adr/0004-deterministic-authorization.md]

### Capability Registry and execution boundary

Capability Registry 分开保存不可变版本声明、安装生命周期和短期执行 Handle。声明固定来源 locator、exact version、SHA-256 integrity、operations、permission refs 与 isolation；记录在 `discovered → installation_proposed → installation_approved → active` 之后才能签发 Handle。更新固定新的 version/integrity，标记 operation 或 permission expansion，并再次经过 proposal/approval 才能激活；停用后的版本先 `disabled` 再 `uninstalled`。

`capability.v2` Manifest 保存 source identity、artifact digest/signature、精确版本、operations、permission/data/network/file/secret scope、isolation、费用、health、review 和 runtime contract。只有 `discovered → review_required → installation_proposed → installation_approved → active` 的已审查健康能力可投影；disabled/revoked/uninstalled 在 SQLite 同一 transaction 内撤销活动 Handle 与依赖任务。更新提议与等待批准只改变 candidate 状态，当前已资格版本在原子切换前继续有权执行；同可信来源、完整性有效、兼容且无扩张的非执行代码变化才可按 Owner policy 自动批准，新执行代码、source/major/runtime/executable/signer/compatibility 变化或 scope 扩张必须显式批准。切换前重新验证 rollback 与 candidate artifact/runtime，切换 transaction 同时撤销旧版本 Handle；回退只切换版本，结构化记录明确不声称撤销外部副作用或产品数据库状态。Foundation `CapabilityRegistryService` 不接受 v2 Manifest。

一个 `capability-handle.v2` 只携带 Permission 已允许的 authorization reference、Owner/Agent/Run、authority fence、固定 capability/version/operation、input/context/secret refs、maximum classification、deadline、次数/费用和幂等 usage，不携带秘密原值。Worker 每次执行都重新验证当前有权版本、Grant、scope、budget、expiry 和 fence；超期、撤销、停用、版本切换或 authority transfer 会使旧 Handle 失效。

`ExecutionWorkerService` 以现有 `execution.v1` 请求为边界，向能力适配器只转交 Handle 允许的上下文与短期 Secret Handle。取消、调用期限、progress、result、unknown external result 和 failure 映射回版本化 Worker 事件。`work.reconcile` 另经 `ExternalActionReconciliationPort` 查询外部动作，只接受 outcome 与引用一致的 `confirmed_succeeded`、`confirmed_failed` 或 `still_unknown`，并返回 `work.reconciled`；未知结果不能被执行请求自动重试。

`packages/platform-node` 的能力运行时使用 Node `crypto` 验证普通文件 SHA-256、受信 Ed25519 signer 与不可变 metadata；本地 program/stdio MCP 只接受精确 process binding。Linux 后端生成非 setuid `bubblewrap >=0.11.2` 与 `prlimit >=2.38` launch，固定无网络 namespace、只读 runtime root、显式 filesystem bind、清空环境和 CPU/地址空间/进程/输出上限，并由 Worker 监督 wall time 与进程组终止。官方 MCP TypeScript client/server `2.0.0` fixture 验证现代 `2026-07-28` stdio 握手、精确 server identity、批准 tool mapping、输出字节上限和关闭。远程 API/adapter 只可访问绑定的 HTTPS/明确 loopback 同源 endpoint，禁止 redirect，secret material 只由 invocation-bound 短期 Handle 注入声明 header，输出先保护再存储；有副作用请求在断连、非成功响应、响应超限或结果持久化失败后只返回 unknown，不能被当作确定失败自动重试。

平台资格与实现能力分开：Mac 的 `/usr/bin/sandbox-exec` 非生产 spike 虽通过文件 allow/deny、网络 deny 与终止测试，但没有签名 App Sandbox/XPC helper，不能标记为 production suitable；Hermes 缺少 `bwrap`，且 `prlimit 2.37.2` 低于门禁，也不能激活本地 program/stdio MCP。当前没有安装或启用真实 capability，也没有把测试 direct-process fixture 当作生产隔离。`DeterministicRestaurantCapabilityPort` 与 `ScriptedExternalActionReconciliationPort` 仍只验证搜索、预订和对账产品语义；production Worker 以 `execution.v2` 严格消息在权限受限 UDS 上接收请求，并只执行配置中精确注册的 adapter/version/operation。该边界落实受治理能力决策：[SOURCE: docs/adr/0008-governed-capability-registry.md] [SOURCE: docs/adr/0021-platform-capability-runtime-isolation.md]

### Memory and context formation

Memory 端口使用产品自己的 proposal、record、candidate 和 correction 值；正文仍是 Payload 引用，provenance 是 source Trace reference。`packages/testing` 的内存适配器只按标准化 search terms 做可重复 overlap score 和稳定 ID tie-break，不读取正文，也不代表最终召回算法或供应商选择。

`ContextFormationService` 对 Memory 只持有 `search` 子集，并可读取当前 Thread 最新的已完成摘要。每次调用先按数据等级、相关性、数量上限选择必要历史，再按时间顺序组装 Thread summary ref、选定 Thread message refs、trigger Payload、policy refs、显式 answer-locale policy ref、通过数据等级与数量限制的 memory content refs 和 Capability summary refs，并把最终清单写成 protected Payload。检索 query、全部 candidates、选择/排除理由、history source refs 和 final context 分成四个父子/因果相连的 Trace 事件；高敏候选会在 candidates 中可见，但不能进入较低等级上下文。摘要只作为附加上下文，原始 transcript 继续保留并可按相关性回取。

`ThreadCheckpointService` 以 `ThreadId + source watermark + distillation policy version` 派生稳定 checkpoint job 与 generation identity。Owner 明确请求、所有 admitted Runs 已稳定的受控 idle、compaction 前和达到 source-size threshold 都进入同一持久队列；触发本身不关闭、归档或替换 Thread。SQLite claim lease 维护 `pending → running → completed` 或有界 `retry_wait → failed_terminal`，进程中断后只恢复原 identity。`pre_compaction` 必须携带 Pi 已生成并已保护的 summary Payload；该引用直接占用既有 `summary_ref`，派生模型只提取 Memory/experience/commitment candidates 并必须返回空 summary，产品提交原样发布同一摘要，不再执行第二次摘要生成。其他三类产品触发仍由显式 distillation model 生成摘要。

模型只接收已扫描过机器秘密的受保护来源正文。一次 generation 先准备受保护 Payload，再在单个 SQLite transaction 中共同提交 summary、零条或多条 Memory/experience/commitment candidate 及其 provenance，最后才把 job/generation 标记 completed；事务中断不会暴露 partial generation，COMMIT 后回包丢失则按 generation identity 回读原输出。summary 固定来源起止序号、水位线、policy/model identity。敏感候选正文在批准前不持久化，未解决 commitment 只保持候选状态；该服务不依赖 Scheduler、Capability 或外部动作端口。

确定性资格矩阵覆盖四类 trigger、重复请求、模型响应前失败、protected content 写入失败、产品事务前中断、产品事务后回包丢失、claim lease 过期、进程重启和 pre-compaction 恢复。固定夹具得到 summary faithfulness `1.0`、source coverage `1.0`、跨 Thread retrieval relevance `1.0` 和 generation duplication `0`；这些指标证明持久语义与测量 harness，不代表真实模型质量。

user message、schedule 和 external event 没有各自的上下文实现，三者只改变统一请求中的 `sourceType`。Pi 的公开产品依赖面只包含 Agent Runtime Port，因此不能直接调用 Memory 的 proposal、commit、correct 或 delete；长期记忆写入仍必须由后续 Run Coordinator 的产品策略触发。该边界落实可替换 Memory 决策：[SOURCE: docs/adr/0005-replaceable-memory-boundary.md]

### Model routing and trusted Provider boundary

Model descriptor 以产品值固定 provider、model、version、routing class、deterministic priority、capabilities、允许的数据等级、披露边界和可空 Secret requirement。`ModelRouterService` 的策略阶段先对候选生成明确 allow/deny reason，并把任务 profile、数据等级、请求披露上限、政策引用、全部候选和最终模型身份写入 protected Trace；只有 `model.route_decided` 成功写入后才进入执行阶段并产生 Provider request。

primary、specialist、local 只选择对应 approved routing class；retryable failure 只能进入单独声明的 fallback class。fallback 除重新检查 capability、classification 和请求披露上限外，还与失败路由的实际披露等级比较。启用不可降级规则时，备用模型不能从 local 扩大到 remote，也不能从 trusted remote 扩大到 external remote；被阻断的候选和原因进入 `model.fallback_blocked`，不会触发第二次调用。

每次模型调用都把 request、started、output reference、completed 或 failed 转成父子/因果相连的产品 Trace；重试另有 `model.retry` 和新的 route decision。terminal Payload 记录 token usage、cost micros 和 latency milliseconds，错误只记录稳定机器码。输入和流式输出正文仍只通过 Payload reference 传递。Pi 返回 `length` 终态时映射为 `OPENROUTER_OUTPUT_TRUNCATED`；成功响应没有任何可持久正文时映射为可重试的 `OPENROUTER_EMPTY_RESPONSE`，两者都不能形成 completed 业务结果。

需要供应商凭证时，Router 根据 descriptor 的 reference/version/purpose 签发仅绑定当前 Owner、Agent、Run、invocation 和 deadline 的 opaque Secret Handle。`packages/platform-node` 的 `TrustedModelProviderAdapter` 在进入受信任 transport 前重新验证 Handle，并只在该适配器的局部内存解析原值；应用请求、产品事件、Trace 和 reference-only resolution log 都不包含原值。调用结束后 Router 撤销 Handle。模型请求、provider API 选择、HTTP 调用、SSE 解析、usage 与标准重试语义全部交给 Pi `ModelRuntime.stream()`；Himawari 的 `PiModelTransport` 只负责产品 Payload 读写、跨 chunk machine-secret redaction、产品终态映射，以及 Pi `0.84.2` 尚未公开的 OpenRouter generation/provider/实际 cost 元数据旁路观察。观察器只读取克隆 Response，不能替代或影响 Pi 的响应解析。`RestrictedProviderSecretSource`、systemd credential 和 macOS Keychain provider-secret 边界也已与固定大小的 Payload 加密密钥 source 分离。独立 embedding descriptor 保留在产品配置与 Memory 边界，不进入 Pi generation binding；`resolveConfiguredModelDescriptorSet()` 只把获准的 OpenRouter primary/fallback 转成 canonical Pi descriptor，`createOpenRouterMem0ProjectionAdapter()` 则把该 descriptor 映射到 Mem0 已有的 OpenAI-compatible provider，并强制 embedding/vector 均为配置的 `4096` dimensions（本次 Qwen 配置）。`apps/agent-service` 的 production `main` 在支持的 provider 配置下创建并关闭 Model/Pi 与 Mem0 composition，deterministic 配置只保留 descriptor-only 启动路径。Task 20 的确定性验证已覆盖 strict provider routing、Keychain provider-secret readback、闭合 Pi 两模型注册、配置映射、Mem0 projection、入口生命周期、cancellation、tool-call 拒绝、disclosure、fallback、secret redaction、空响应和截断终态。Qwen embedding 与 generation primary/fixed fallback 的有界 paid call 已完成 provider/model/token/cost 回读；最终 Gateway/Memory/Worker 组合仍由后续任务验收。该边界落实受策略控制的模型路由：[SOURCE: docs/adr/0007-policy-controlled-model-routing.md]

### Pi Agent Runtime projection

`packages/runtime-pi` 是唯一可以加载 `@earendil-works/pi-*` 包的 workspace。适配器内部直接使用固定版本的 `AgentSessionEvent`、`CreateAgentSessionOptions`、`ModelRuntime`、`Model`、`ToolDefinition` 和 `SessionManager` 类型；产品端口不暴露这些类型。published package compatibility test 验证 `0.84.2` 的导出和运行行为。每个 Run 都显式传入 product-selected model binding、结构化产品上下文和授权能力 Handle，并创建 `SessionManager.inMemory()`；Pi Session 只在该次执行中存在。

每次 Pi Session 重建都从 durable product history 与已接受 checkpoint 重新填充 `SessionManager`，而不是持久化或恢复 Pi 自有 Session 文件。compatibility matrix 以相同 Thread/Run/Session request 连续重建两次，验证产品 identity 与投影后的消息/compaction 语义一致；Pi entry identity 仍是适配器内部实现细节，不能替代 ThreadId、MessageId、TurnId 或 RunId。

`ConfiguredPiModelBindingPort` 只接受一组 canonical primary/fallback descriptor；同一个对象同时承载产品策略身份与 Pi provider model config，不再维护可能漂移的 `{ model, pi }` 双描述符。严格配置的生成字段经 `resolveConfiguredModelDescriptorSet()` 映射到该对象，而独立 embedding descriptor 仅交给产品 Memory 组合，永远不会伪装成 Pi generation model。它通过 `modelsPath: null`、Pi `InMemoryCredentialStore`、`allowModelNetwork: false` 和 `refreshOnCreate: false` 关闭磁盘模型发现与网络刷新，只注册闭合的两个 OpenRouter 模型。共享 provider secret 由 production-suitable host source 在首次 binding 时按需解析并只交给 Pi runtime；原值不进入 descriptor、runtime options、Trace 或诊断。fallback 的 `order: ["z-ai"]` 仅作用于 fallback descriptor，不把该上游顺序强加给 primary。

资源加载器关闭项目 context、themes 和所有 ambient Extensions/Skills/prompts discovery；产品授权端口返回的路径只能通过 `additionalExtensionPaths`、`additionalSkillPaths` 与 `additionalPromptTemplatePaths` 显式加载。`noTools: "all"` 默认关闭 Pi 本机 coding tools，适配器只把 `RuntimeToolPort.listAuthorized()` 返回的 custom tools 加入 Session，并在 Pi 参数 schema 验证后调用产品 preflight。对于后续 Host Files/Code Workspace 能力，`createGovernedPiCodingTools()` 直接复用 Pi 的 read/bash/edit/write/grep/find/ls 定义、参数规范化和结果形状，只要求注入产品受治理的 Operations；Operations 缺失时 fail closed，不回退到 Pi 本机文件或 shell。Permission 已撤销、Handle 不匹配或其他 fail-closed 决定不会到达 capability execution。

`RuntimeProjectionPort.resolveContext()` 返回有角色的历史消息、tool call/tool result、独立的新 user prompt 和可选已接受 checkpoint；适配器逐条预填充 Pi `SessionManager`，不再把多个 Payload 文本用空行拼接成一条 user message。Pi 的 message、turn、tool、compaction、abort、error 和 settled lifecycle 被映射为产品 Runtime event。消息、工具参数/结果和 provider observation 在进入产品 Payload capture 前做 adapter-local redaction；Runtime event 只携带 Payload reference 或稳定 error code。内部异步队列在事件映射完成时立即向调用者产出，而不是等整个 Run 结束后回放。`before_provider_request` 与 `after_provider_response` 是当前 request/response 观察点。完成事件只会在 `waitForIdle()`、`agent_settled` 和适配器 listener queue 都完成后产生。

Pi compaction summary 只形成 `RuntimeProjectionPort.proposeCompaction()` 请求；它不能直接写 Thread、Memory 或产品消息。产品接受后把同一受保护 Payload 作为 `pre_compaction` Thread checkpoint 的 prepared summary，派生流程不得再次摘要。Runtime 工具端口以 `RunId + toolCallId` 作为外部动作幂等边界，使 Session 重建不会重新提交已完成动作。该边界落实产品状态高于 Pi 投影的决策：[SOURCE: docs/adr/0001-pi-runtime-adapter.md] [SOURCE: docs/adr/0015-product-state-over-pi-runtime-projection.md]

### Run coordination and scoped worker delegation

`RunCoordinator` 只依赖产品拥有的 `ContextFormationPort`、`WorkerRunPort`、`AgentRuntimePort`、Run 状态提交、State checkpoint 和 Session Trace。它按 `accepted → building_context → running → terminal/reconciliation` 驱动 Run，并把 Owner 取消同时传播给当前 Runtime 与活跃 Worker。Runtime、Worker 和 Pi Session 都不能自行写产品 Run 终态。

每个 Worker request 显式绑定 parent Run、Owner、Agent、task reference、可委派 context references、短期 capability-handle references、数据等级、deadline 和 duration/cost/progress budgets。协调器要求这些引用是父 Run 授权集合的子集，并拒绝任何 secret reference；因此 Worker 不会继承父 Agent 未委派的 Grant 或秘密。Worker result reference 被聚合为 Runtime 输入，unknown external result 则把父 Run 转入 `reconciling_external_result`。

协调检查点使用 `run-checkpoint:<RunId>`，在每个可挂起阶段记录形成的 context reference、已完成 Worker result references、Runtime event count、最新 Trace event 和终态。进程重建后由产品 State 恢复，而不是依赖 Pi Session。`RuntimeToolPort` 的参考实现另以稳定 `RunId + toolCallId` 保存外部动作结果，因此“动作已成功、Runtime 尚未发出结果事件”之间崩溃时，重试返回原结果而不再次执行动作。

### Unified trigger ingestion and scheduling

`UnifiedTriggerIngestionService` 把 user message、schedule 和 external event 都转换成严格的 `gateway.v1 trigger.admit` command。三类来源共享 message/correlation/causation、Owner/Agent、actor、数据等级、idempotency key、Trigger/source、时间、Thread、Payload 和 source proof 字段；应用层只有一个 `TriggerAdmissionPort`，因此 Scheduler 不能直接创建 Run 或绕过后续 Context Formation、Permission 与 Trace 管线。

`ScheduledJob` 是 revision-checked 产品值，持有长期 Grant reference 与冻结的任务语义：capability、operation、resource、side effect、数据等级、单次费用、频率、任务 scope reference、期限和 revocation marker。每次 due dispatch 都先验证当前 Agent Authority Fence，再从 Authorization Store 重读 Grant，校验长期类型、Owner/Agent、有效期、撤销、剩余使用/费用预算及完整语义范围。失败会取消该任务而不产生 Trigger。

每个定时 occurrence 以 `job ID + provider occurrence identity` 派生 stable key，并由 `DurableBackgroundWorkService` 复用唯一 `UnifiedTriggerIngestionService` 生成 Trigger admission idempotency key。SQLite 的 `(job_id, stable_key)` 唯一键把 timer、人工重放和外部投递合并为原 occurrence；同一 job 默认只允许一个 admitted/running Run，只有 occurrence 明确标记 `parallelSafe` 时才允许并行。旧 authority fence 在创建、接纳、claim 和 settle 四个边界都被拒绝。

预算与容量在同一 `BEGIN IMMEDIATE` transaction 内检查并保留：全局、数据分类和单 Run 费用都是硬上限；总并发、category 并发和前台保留槽位共同决定接纳。已在线持久化但资源不足的 occurrence 保持可查询的 `budget_blocked` 或 `capacity_blocked`，不会因浏览器离线丢失。Worker claim 保存 lease ID、holder、取得/到期时间；重启只重新暴露已到期 lease，completed occurrence 不会回退。transport/provider failure 使用 attempt 有界、最大延迟有界且由稳定 seed 决定 jitter 的 exponential backoff；credential、authorization、policy 与 invalid input 没有自动 retry 时间。`MODEL_BLOCKED` 与未知外部结果保留原 occurrence/Run identity，后者必须先走 reconcile。

`evaluateDurableSchedule()` 支持固定 interval、one-shot 和 IANA timezone daily schedule。周期 misfire 直接合并并跳过旧 occurrence，one-shot 超过 grace 后成为 `MISSED`；IANA 日历通过运行时 timezone database 解析，不存在的 DST wall time没有候选，重复 wall time按本地日期只采用第一次。当前生产服务已执行持久恢复并持有这些 adapters；HTTP Trigger Control Plane 边界已经实现，但自动 timer loop 与真实 command handler 要等最终 Agent Service 组合，不能把测试用 admission sink 当作公共 Gateway。

### Central attention and delivery

Run 完成后产生产品 `AttentionCandidate`，其中只包含结果 Payload reference、Owner/Agent/Run/Session/Thread scope、数据等级、紧急度、置信度、duplicate key、设备可用性和可空 interrupt authorization reference。`AttentionPolicyService` 以固定阈值先区分 `SILENT`、`INBOX`、`DIGEST`、`NOTIFY` 和候选 `INTERRUPT`，再结合集中 policy state 的重复窗口、即时交付频率、安静时间与设备状态做降级。`INTERRUPT` 只有在 candidate reference 命中注入的当前显式授权集合时才能成立。

Attention decision 以 candidate semantic fingerprint 和 Owner/Agent policy revision 做 CAS。相同 candidate 重放返回原决定；ID 内容冲突会被拒绝；不同客户端或并发候选不能各自提交冲突优先级。非静默决定与唯一 `DeliveryRequest` 在同一 state commit 创建，静默决定不创建交付。由此客户端只渲染集中决定，不重新判断优先级。

Delivery 有独立于 Run 的 revision 和 `pending → delivering → delivered` 状态。客户端必须先原子 claim；同一时刻只有一个 client ID 可以调用 adapter。缺失客户端、适配器失败或暂时不可用会把请求恢复为 `pending`，不改变已完成 Run；成功 acknowledgement 会冻结 terminal delivery，之后其他客户端只看到 existing result。当前 `DeterministicDeliveryPort` 只按 client ID 返回可重复测试结果并记录引用级 attempt，不包含任何固定 UI。

### Agent Gateway and local composition

`AgentGatewayService` 只接收已认证的 `GatewayAuthenticationContext` 和严格解析后的产品消息。in-process transport 负责把 adapter-specific credential 转成 subject、Owner、device 与 authentication reference；应用服务随后核对 Owner/actor scope，并通过 `GatewayAccessPolicyPort` 执行产品 Owner/Device 授权。认证失败或授权失败不会调用 Control Plane。

所有 Gateway command 只通过 `GatewayControlPlanePort.execute()` 改变状态；Gateway 本身没有 State Store 写依赖。Thread/Run snapshot、Trace query 和事件订阅只通过 `GatewayReadModelPort`。订阅保留客户端 `afterCursor`，并拒绝越出 Owner/Agent/Session/Thread/Run scope 的事件、重复 cursor 和同一 Run 内非递增 sequence。当前 `InMemoryGatewayControlPlane` 与 `InMemoryGatewayReadModel` 是本地参考适配器，不是生产 Control Plane 或持久 read model。该边界落实无头 Gateway 决策：[SOURCE: docs/adr/0002-headless-agent-gateway.md]

`AgentGatewayV2Service` 对 `gateway.v2` 使用相同的认证、scope 与确定性授权顺序，并校验 deployment、authority epoch 与 fencing token。`AgentThreadGatewayService` 对 `gateway.thread.v3` 再验证认证 Owner/actor、设备授权、event scope、cursor 唯一性和单 Thread revision 不后退；`ProductThreadGatewayAdapter` 把严格消息组合到既有 Thread command/query/Fork/deletion 服务。`createHttpGatewayServer()` 在 Fastify 中提供同源静态资产、v1/v2/Thread v3 command/query 与 durable SSE；请求先经过严格 parser、Host/Origin/Fetch Metadata、session-bound CSRF、精确媒体类型、bounded body 和 header/message 幂等键一致性，再进入应用 Gateway。响应配置 restrictive CSP、frame deny、MIME 与 no-store。SSE 传递持久 cursor/event ID/scope、heartbeat 和 backpressure；重复 cursor、同 Run 非递增 sequence 或跨 scope 事件使 stream fail closed，v1 retention miss 只返回有界 snapshot refresh，Thread cursor 不可用时发出 `thread.snapshot_required`。浏览器正文读取只解析已认证 Owner/Agent scope 的 `text/plain` protected Payload；搜索 query 先作为 private Payload 接纳，再使用共享 tokenizer 生成 Agent/projection-scoped HMAC token refs，浏览器不接触索引明文。

Identity Gateway 把 bootstrap、产品 session 和 break-glass 保持为独立最小 route。bootstrap 默认关闭、仅 loopback、短时有效并通过 SQLite transaction 只创建一次 Owner 外部 subject binding。Cloudflare Access verifier 只接受 RS256 并校验 `kid`/JWKS 有界缓存与轮换、issuer、audience、signature、`exp`、`nbf` 和 clock skew；产品只保存由 issuer/subject 派生的稳定外部引用，不信任 forwarded email/username。产品 session/device 只保存 bearer token digest 与 authentication reference，支持 activity、recent-auth 和级联撤销；CSRF token 绑定产品 session。break-glass 另需 loopback credential 与独占文件锁，只允许修复 Owner mapping、撤销 session/device 或关闭公网入口，并产生受保护审计。

`apps/control-center` 只依赖浏览器 API、Gateway contracts 与 React/Vite。typed client 将私人正文先交给 Payload admission，再只在 command 中传引用；v2 与 Thread v3 SSE synchronizer 分别使用 durable cursor 恢复。`localStorage` 只保存未发送 Thread 草稿、显示偏好、UI locale、v2/Thread last cursor，以及结果未确定期间无正文的 mutation identity；它不能在浏览器本地接纳命令或保存已提交历史、搜索正文、authority state 或长期 Memory 正文。Thread 页面已接通 list/detail/search、committed Message sequence、Run lifecycle、独立 answer locale、create/send/rename/pin/archive/restore/Fork/checkpoint/deletion coordination；revision conflict 显示最新 revision 并要求明确重新应用，不执行 silent last-write-wins。其他七个 legacy surface 仍只显示 `baseline_only` read model，三个缺少领域 contract 的 surface 保持 `blocked`，没有审批、Task、Memory 或 session 的伪 mutation。Chromium 151 与 WebKit 26.5 的受控 fixture 已验证 Thread/search/checkpoint/conflict/archive/delete-impact/Fork、多标签、断网/关闭重开、三语、移动视口、44 px target、320 px reflow 和 axe 基线，但不代表真实公网身份、人工辅助技术或正式六浏览器平台矩阵。

控制中心的信息架构 inventory 现在固定 11 个页面的主责 Spec、稳定对象、Gateway query/mutation、revision、授权/re-auth 以及 empty/loading/error/degraded/offline 状态。`gateway.thread.v3` 标记为 `frozen` 且 Thread 页面集成已完成 S3 Task 6；现有 approval/task/inbox/memory/trace/session/health `gateway.v2` 骨架属于 `baseline_only`，不能作为完整领域页面验收；Capabilities/Adapters、Authorizations/Grants 与 Settings 在领域 Gateway contract 冻结前保持 `blocked`。单元检查会拒绝未知 message type、缺少状态或把未冻结页面标成可接入的变更。

`createLocalAgentServiceComposition()` 组合 Gateway、Run state/outbox、Trace、Context Formation、Model Router、Permission、Capability Registry、Attention 和 Run Coordinator。确定性 test profile 继续由 `createLocalExecutionWorkerProcess()` 单独启动并只接受 ready 的 `execution.v1` client；production profile 使用 `AgentServiceExecutionClient` 完成 instance/boot-token/schema handshake 后，通过 `execution.v2` UDS 请求、结果 cursor 和 readiness 工作，Worker unavailable 时明确失败且不回落到 Agent Service 进程内执行。启动诊断只输出 component、adapter identity、schema version 与 readiness。关闭先进入 draining、拒绝新请求，再等待登记的 Run settlement。Secret Port 是显式注入项，诊断和 Trace 不读取原值。该边界落实可组合服务和本地优先部署决策：[SOURCE: docs/adr/0011-composable-service-boundaries.md] [SOURCE: docs/adr/0012-portable-local-first-deployment.md]

### Reference E2E and recovery evidence

`test/e2e/beef-restaurant.test.ts` 使用确定性模型、Memory、Capability、Scheduler、Attention、Gateway 和 Worker 适配器运行三段参考旅程。它把牛肉偏好及来源写入长期 Memory，在新 Thread 中选择该记忆并生成建议；语义批准一个长期餐厅监控 Grant；由 timer Trigger 委派搜索 Worker 并产生 `INBOX` Delivery；随后对预订请求签发一次性 Grant 和短期 Secret Handle。预订先返回 `result_unknown`，再由独立 reconcile 请求确认成功。第二客户端读取同一 Thread/Session 的 37 个事件，并从 cursor 10 恢复订阅。

`test/integration/failure-recovery-matrix.test.ts` 对八类恢复点做确定性故障注入：Run commit 前、状态 commit 后 event publish 前、等待审批、模型流中断且 fallback 扩大披露、Worker 副作用前后、未知外部结果、运行中 authority loss，以及分阶段 Session 删除。每个场景都以 protected Trace payload 记录 terminal 或明确 pending/reconciling 状态。

本地源码学习模式只改变 `node_modules` 解析状态。只读检查要求 sibling 的 package name、version 和七个 runtime/build entrypoint 与 committed published pin 一致。受管 link 先保留 published package，再创建指向 sibling coding-agent package 的 symlink；恢复时校验 state、link target、manifest/lockfile hash 和 published backup version。它不会写 `file:` 依赖，不会更新 lockfile，也不会让本地路径进入正式安装契约。普通 `npm ci --ignore-scripts` 始终选择 npm 发布物。

## Main Flows

当前可执行入口包括可安装 Agent Service、Execution Worker、管理 CLI、程序化本地参考组合、GitHub/模型确定性边界测试、规模资格测试，以及独立 HTTP/Identity/Control Center 资格测试。最终 public HTTP 组合尚未进入 Agent Service `main`：

```text
npm ci --ignore-scripts
  → build relocatable node-runtime and browser bundle
  → optionally run qualify:scale on a temporary qualified SQLite fixture
  → start production execution-worker over protected UDS
  → start strict production agent-service and recover durable state
  → independently qualify HTTP parser/origin/auth/scope/SSE adapters
  → independently qualify bootstrap/session/break-glass and Control Center
  → later tasks compose those adapters with real Control Plane/Read Model
  → drain new admission and await in-flight Run settlement on shutdown
```

Fresh completion 验证执行 `npm run check`、四个主 Vitest project、Pi compatibility、独立 workspace 项目、`npm run test:journeys`、`npm run qualify:scale`、`npm run qualify:thread-scale` 和严格文档验证。完整测试数量以最后一次 fresh 命令和对应 evidence 为准；规模资格测试单独记录目标行数、SQLite 版本、资源占用和核心路径 p50/p95/p99。SQLite contract/integration 使用临时真实文件和隔离子进程，安装后的 `himawari` CLI 已在临时 state root 完成损坏前恢复点与原子恢复演练，以及 stopped source 到 inactive/activated target 的 authority-transfer 演练；浏览器资格测试只监听 loopback。这些验证不访问付费模型、外部账户或生产凭据。

Task 20 的真实模型验证由两个显式 opt-in 集成测试组成。`HIMAWARI_LIVE_EMBEDDING_SMOKE=1` 从 macOS Keychain opaque provider-secret source 构造 Mem0 production composition，只发送公开合成文本，并在完成后删除临时状态；它确认 OpenRouter Qwen3 Embedding 8B 请求与返回均为 4096 维并返回 token usage。`HIMAWARI_LIVE_GENERATION_SMOKE=1` 通过同一份 canonical live configuration 先调用 primary，再在本地注入 retryable 503 触发真实 fixed fallback；fresh evidence 确认 `Makora` 执行 DeepSeek primary、`Z.AI` 执行 GLM fallback，两者均返回预期正文，总计 `0.000026 USD`。这两个有界测试不替代最终 Gateway/Memory/Worker 生产组合资格。

## Known Limitations

- `apps/agent-service` 和 `apps/execution-worker` 已有正式 `main`、workspace `build/start`、production UDS client/server、信号 drain、稳定退出码、可重定位 Node runtime 和真实子进程测试；Agent Service 已打开持久 repository、读取后台恢复清单，并在支持的 provider 配置下接入 Model/Pi 与 Mem0 composition 的启动与关闭生命周期，但尚未安装 launchd/systemd unit，也未把已经实现的 HTTP、身份和 Control Center adapters 以及后续 Memory projection worker、模型调用和 GitHub adapters 组合为最终 readiness。
- `persistence-sqlite` 已实现真实 schema/migration、execution context、state-root lock、authority lease/deployment、原子 Product State transaction、claim 型 Outbox、持久 Gateway Read Model、Thread committed Gateway event、Run checkpoint、Thread distillation generation、后台 occurrence/lease/budget/blocker、identity binding/session/device、产品 Memory/projection job、敏感 Memory 审批 metadata、Payload envelope metadata、受治理删除、GitHub history retain/delete 状态机、加密同机 recovery point，以及停机加密 authority transfer。Payload cryptography 与外部 ciphertext file store 已实现，尚未接入全部产品正文路径。authority transfer 使用 authenticated streaming package、recipient/target KEK 两次 DEK rewrap、offline lock、inactive target、单调 epoch/fence 和 SQLite/authority file 双读 fail-closed；当前已有临时 fixture、安装后二进制演练及 Hermes 隔离目录中的 Linux 安装后资格测试，真实 Mac↔Hermes 双向迁移属于 Task 28。`mem0ai@3.1.7` 已通过双平台 compatibility gate；`memory-mem0` 已实现单条产品投影、检索删除与 provider ID round-trip，避免依赖批量 embedding 的全有或全无语义，并已把选定的 4096 维 Qwen embedding 通过 Mem0 的 OpenAI-compatible provider 接入 production memory composition。增量自动 Memory、秘密排除、敏感逐项审批与 Thread 稳定检查点已通过确定性 baseline；generation provider path 已完成有界 primary/fallback 资格，但真实摘要/提取质量和 durable projection worker 仍由最终组合任务验证。`integration-github` 已实现只读 permission、webhook admission、receipt/occurrence 去重、mirror、coverage gap、capability deny 和 `gateway.v2` monitor lifecycle handler 的确定性边界；SQLite 已实现撤销后 retain/delete 的 durable adapter、retry/readback、关联 Task/Run/Trace/Inbox/summary 清理和受限 ciphertext file 删除。最终 Agent Service/Gateway 总组合仍属于 Tasks 27–30；真实 GitHub App 安装、权限 readback、外部 webhook 和线上模型仍未验证。`control-center` 已完成 Thread v3 权威旅程、多标签/离线/重开与浏览器 Payload/search 边界，但审批、能力/Grant、Tasks/Attention、Memory/Trace/settings/device/health 领域页面和最终生产组合仍待后续 Tasks；`admin-cli` 已有 doctor、db status，以及受 offline lock/confirm 保护的 migration、backup、transfer 和 delete 命令。可重定位 Node artifact 包含 GitHub/Mem0/Pi 运行时包与锁定的外部依赖，因 native Node/SQLite 依赖仍须按平台分别构建和验收。
- 默认 local composition 使用 `packages/testing` 的内存 State、Memory、Trace、Authorization、Scheduler、Delivery 和 Gateway read model；进程退出后数据丢失，且不提供跨进程 transaction、加密强度、高可用或灾难恢复。
- Pi adapter 已通过 published `0.84.2` 与 local-source compatibility，但牛肉餐厅 E2E 使用确定性 Model/Capability，不调用真实模型、地图或预订供应商。
- Execution Worker 已具有真实 HTTP/JSON over UDS transport、boot-scoped authentication、严格 resource ceiling validation、deadline/progress limits 和 child-process crash/reconnect 证据。Node 能力运行时、Linux bubblewrap/prlimit launch、artifact verifier、MCP/API/program adapters 与版本切换已实现并通过非生产 fixture，但当前 Mac/Hermes 均未通过本地 program/stdio MCP 生产资格，也尚无 service-manager CPU/内存强制、签名 Mac helper、真实 capability binding/trust root 或最终 Worker 组合。
- Session 删除的抽象 conformance 与 Thread/task/Memory/Payload 的真实 SQLite、ciphertext file 和受管 derived-artifact 删除路径均已验证；最终 Agent Service 组合仍需把所有正文生产者统一登记到这些受管路径，Memory provider cleanup 也仍依赖 durable projection worker 正常运行。
- Thread 已通过 Chromium/WebKit、双确定性设备身份、服务/SQLite 重启、Pi Session 重建、summary/projection rebuild 和 1 万/20 万规模矩阵；这些本地证据未执行物理 macOS 重启、真实外部 IdP MFA 或实体移动设备 readback，不能据此声明正式平台或 production qualification。
- Gateway v1/v2 已保证认证/授权/Control Plane 委派边界，HTTP/SSE 与 Identity adapters 也有 contract/security/browser 证据；默认 `InMemoryGatewayControlPlane` 不实现生产 Thread/Run/Approval command handler，真实 Cloudflare 公网路径和 Agent Service 最终组合仍未验证。
- `gateway.v2`、`execution.v2` 和新增 application ports 是冻结的产品契约；Execution UDS、严格 configuration/state-root、health/metrics model、可安装服务、HTTP/SSE、身份断言、Control Center 基础旅程、产品 Memory/Mem0 projection、受治理删除、同机 recovery point 与停机 authority transfer 已实现，其余 GitHub 与 production adapter 组合尚未实现。
- 生产 Secrets Vault、Provider material source、通知客户端、自动 timer loop 和远程 Worker 均未实现；network Gateway 只作为独立 adapter 验证，尚未在 public production readiness 中启用。本版本不应描述为可生产部署。

## Backlog Links

- Foundation Spec 明确排除生产部署、真实外部供应商和高可用；当前没有已承诺的持久 Backlog item。上述 Known Limitations 是当前事实，不代表已承诺实施日期。[SOURCE: docs/archive/specs/2026-08-25-agent-foundation-design.md#excluded]

## Decision Links

- Pi runtime adapter：[SOURCE: docs/adr/0001-pi-runtime-adapter.md]
- Headless Agent Gateway：[SOURCE: docs/adr/0002-headless-agent-gateway.md]
- Single logical Agent authority：[SOURCE: docs/adr/0003-single-logical-agent-authority.md]
- Deterministic authorization：[SOURCE: docs/adr/0004-deterministic-authorization.md]
- Replaceable Memory boundary：[SOURCE: docs/adr/0005-replaceable-memory-boundary.md]
- Primary Agent and scoped workers：[SOURCE: docs/adr/0006-primary-agent-scoped-workers.md]
- Policy-controlled model routing：[SOURCE: docs/adr/0007-policy-controlled-model-routing.md]
- Governed Capability Registry：[SOURCE: docs/adr/0008-governed-capability-registry.md]
- Protected Agent trust root：[SOURCE: docs/adr/0009-protected-agent-trust-root.md]
- Complete Session Trace：[SOURCE: docs/adr/0010-complete-session-trace.md]
- Composable service boundaries：[SOURCE: docs/adr/0011-composable-service-boundaries.md]
- Portable local-first deployment：[SOURCE: docs/adr/0012-portable-local-first-deployment.md]
- Agent, Thread and Run identity model：[SOURCE: docs/adr/0013-agent-thread-run-memory-model.md]
- Central Attention Policy：[SOURCE: docs/adr/0014-central-attention-policy.md]
- Product state over Pi runtime projection：[SOURCE: docs/adr/0015-product-state-over-pi-runtime-projection.md]
- TypeScript and Node.js runtime：[SOURCE: docs/adr/0016-typescript-node-runtime.md]
- Workspace monorepo：[SOURCE: docs/adr/0017-workspace-monorepo.md]
