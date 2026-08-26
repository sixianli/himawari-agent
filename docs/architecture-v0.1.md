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

仓库当前实现是一个私有 npm workspace monorepo 基础。根工具链要求 Node.js `>=22.19.0`，以 npm `11.8.0` 管理锁文件，以 TypeScript `5.9.3` 做 strict、`erasableSyntaxOnly` 类型检查，以 Biome `2.3.5` 做格式和 lint，并以 Vitest `4.1.9` 提供 unit、contracts、integration、e2e 和 Pi compatibility 五个测试项目。

当前代码包含九个 workspace。`packages/domain` 实现不可变身份、所有权规则、Run 状态机与 Agent 权威租约；两类 contracts 固定 `gateway.v1` 与 `execution.v1`；`packages/application` 实现产品端口、Gateway、Run/Worker 编排、可靠事件、Trace、授权、记忆、模型、调度、Attention 和外部结果对账；`packages/platform-node` 与 `packages/runtime-pi` 分别实现可信模型 Provider 边界和 Pi Agent Runtime 适配器；`packages/testing` 提供 conformance suites、内存参考适配器、牛肉餐厅夹具和故障注入器。

`apps/agent-service` 现有可编程的本地前台组合根和严格 `gateway.v1` in-process transport；`apps/execution-worker` 现有独立启动、独立关闭的 `execution.v1` Worker 进程边界。组合根可替换 Gateway Control Plane/Read Model、Worker client 和 Secret Port，并把产品服务组合到同一可信前台进程。它们是本地架构验证入口，不是网络监听器或已打包 CLI。

已关闭 Foundation Spec 的 Task 1 至 Task 20 已按确定性参考配置实现并验证：[SOURCE: docs/archive/specs/2026-08-25-agent-foundation-design.md] [SOURCE: docs/archive/plans/2026-08-25-agent-foundation-plan.md]

## Boundaries

允许的 workspace 依赖方向是：

```text
apps/* → application + contracts + selected adapters
platform-node → application + domain + contracts
runtime-pi → application + @earendil-works/pi-coding-agent
application → domain + product contracts
contracts → no internal dependency
domain → no internal dependency
testing → application + domain + product contracts
```

`scripts/check-boundaries.mjs` 从根和各 workspace 的 `package.json` 及 TypeScript import 构建依赖图，检查非精确直接外部依赖、非法方向、循环、未声明依赖和逃出 workspace 根的相对 import。任何 `@earendil-works/pi-*` 依赖或 import 只能位于 `packages/runtime-pi`；domain、contracts 和 application 不能直接 import `node:` 模块。

`packages/runtime-pi` 直接固定 `@earendil-works/pi-coding-agent` `0.84.2`；提交的 manifest 和 lockfile 不引用相邻的 `../pi-mono`。它只能从 `@himawari-agent/application/runtime-port` 导入 Agent Runtime request/event 类型，不能通过 application 根入口获得 Memory、Permission、Capability Registry 或持久化写端口。该隔离边界落实了产品自有 Pi 适配层决策：[SOURCE: docs/adr/0001-pi-runtime-adapter.md]

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

## Wire Contracts

`packages/gateway-contracts` 发布 `gateway.v1` 产品协议。它包含统一 Trigger admission，Thread 创建和关闭、Run 取消、语义审批响应，Thread/Run 快照查询、Trace 分页查询、可恢复事件订阅，Thread/Run 快照和有序流事件。Run 只能由统一 Trigger admission 启动；Gateway 不提供绕过触发接纳的新建 Run 命令。

Gateway 信封携带消息标识、schema 版本、相关关系、可空因果关系、数据等级、Owner/Agent scope 和 actor。所有改变状态的命令另带幂等键。流事件以 `messageId` 作为事件标识，并携带 cursor、Session、可选 Thread/Turn、Run、父事件、严格正数 Run 内序号、事件时间、写入时间、事件类型和可空 Payload 引用。

`packages/execution-contracts` 发布 `execution.v1` Worker 协议。请求覆盖工作执行、取消和外部结果对账；事件覆盖进度、结果、取消确认和对账结果。所有请求包含幂等键，所有消息包含相关和因果标识、Owner/Agent/Run/Worker Run scope 及数据等级。工作执行只携带输入、委派上下文、短期能力句柄和秘密引用；结果和错误正文也通过引用或稳定机器码表达。

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
```

端口值使用领域 branded identity、产品数据等级、稳定引用、JSON 值、`Uint8Array` Payload 和产品事件。`ApplicationPortError` 提供固定 `PORT_*` 错误码，使冲突、缺失、重复、非法操作、非权威写入、已撤销句柄和测试注入故障可以由应用层稳定分类。Secret Port 只签发与 Owner、Agent、Run、用途、scope 和期限绑定的 opaque handle；Agent Runtime、Model 和 Capability 事件只传 Payload 引用与机器错误码。

`packages/testing` 的 `./conformance` 子路径导出可复用 Vitest suite。每个 suite 接收 adapter harness，所以未来数据库、供应商或远程适配器可以用自己的 setup/teardown 重跑同一行为契约。当前内存参考实现覆盖全部端口，并在读写边界做防御性复制；它们是确定性测试替身，不是生产持久化或安全边界。

测试控制包括 `ManualClock`、按 namespace 递增的 `DeterministicIdGenerator` 和按命名 checkpoint/调用次数触发的 `DeterministicFailureScheduler`。Authority Lease 参考适配器使用注入时钟处理到期、续租和单一 live lease，并在每次新 claim 时递增 fencing token。故障调度在 mutation 之前触发，使失败后的状态保持未写入并可确定性重试。

### Product state commit and reliable publication

`RunStateCommitCoordinator` 是 Task 5 的窄状态提交服务；Task 13 的 `RunCoordinator` 组合它和其他产品端口，但不取代原有提交边界。状态提交服务读取产品 Run 状态、调用领域 `transitionRun()`，并把下一版状态、幂等命令结果和对应业务事件提交给 `ProductStateRepositoryPort`。Run 采用 `run:<RunId>` 状态键；业务事件采用由命令 idempotency key 派生的稳定事件 ID。

参考 Product State Repository 在一个无 `await` 的 mutation 边界内同时写入 State revision、命令结果和 pending Reliable Event，提供内存 transaction/outbox 等价语义。提交前会完成以下检查：

1. Owner、Agent 和 idempotency key 作用域内是否已有相同 command type/fingerprint；相同命令返回原提交结果，不同命令返回冲突。
2. 当前 Authority Lease 是否与命令携带的 lease ID 和 fencing token 完全一致；仅回放已经提交且不再写状态的命令可以在租约变化后返回原结果。
3. State expected revision、事件 ID 唯一性及事件 idempotency key 是否与命令一致。

通过检查后，预提交故障不会留下 State、命令结果或 Event 的任一部分。并发相同命令会在 authority 查询后的第二次幂等检查处收敛为一次提交。

`ReliableEventPublisher` 分批读取 pending 事件，交给 `ReliableEventSinkPort` 后再标记 published。发布前失败保留 pending 事件；Sink 已接收但 published 标记失败时会按同一 event ID 重投，Sink 返回 `duplicate` 而不产生第二次可见交付。新建协调器和发布器只需复用同一 Product State Repository 即可恢复 Run 和 outbox，不读取 Pi Session 文件。

当前保证只由内存参考适配器和可复用 conformance suite 验证，不代表生产跨进程耐久性、加密强度或隔离已经实现。生产 Memory 检索、真实模型 Provider/传输与 Secret material source、Capability 生产沙箱/传输、生产删除、Scheduler 与 Delivery 适配器和生产持久化仍属于后续 Plan 任务。

### Session Trace, protected Payload and deletion propagation

`SessionTraceRecorder` 生成 `trace.v1` 信封并由 Trace Store 强制校验 Run 内严格连续序号、稳定 Run scope、父事件归属及已有因果事件的相关关系。事件正文不内嵌模型输入、工具结果或审批快照，而是在写入前转换为产品 JSON、脱敏、交给 `PayloadProtectorPort`，最后只保存 Payload 引用。无法确认安全转换的负载不会写入 Payload；Trace 改写为不含原文的 `trace.redaction_failed`，并留下最小失败审计记录。

Payload 端口的持久化输入是 ciphertext、算法标识、key reference、内容 digest 和分类元数据，不接收明文语义字段。`packages/testing` 的 `test-xor-v1` 只用于证明“写前脱敏、保护后存储、引用组装”的接口顺序和防御性复制，不是生产密码学实现，也不能成为部署配置。

`SessionDeletionCoordinator` 为一次 Session 删除保存独立 revision 和四个固定目标：Payload、search、cache、archive。每个目标记录尝试次数、失败码和验证时间；重建协调器后只重试未验证目标。总状态只有在四个适配器都回读确认内容不存在时才是 `verified`，否则保持 `incomplete`，并且断言接口拒绝把部分清理报告为已验证。Audit Ledger 只保留 Session 引用、结果和时间，不复制被删除正文。

### Permission, approval and Grants

`PermissionService` 接受模型或其他调用方提出的产品 `ActionIntent`，但只由版本化确定性策略和持久 Grant 产生 `ALLOW`。显式 `DENY` 规则优先；未命中规则或 Grant 的行动形成 `ASK`。Authorization Store 不可读、Grant 消耗冲突或其他组件故障一律 fail closed，不能由模型输出修正。

Approval Request 保存冻结的语义快照及稳定 hash。快照包含 capability、operation、resource、数据等级、副作用、费用、频率、幂等键和可逆性；响应 hash 不同则拒绝。无 UI 时只把请求标记为 `queued_no_ui`，进程重建后从 Store 恢复。过期只会进入 `expired`，相同 Intent 的超时或重试不能变成允许。

Grant 与 Capability 声明分离。一次性 Grant 精确绑定原 Intent 并只有一次使用预算；长期 Grant 约束 capability、operations、resource prefixes、最大数据等级、副作用、每次/累计费用、频率、次数、期限和撤销状态。每次允许会通过 revision-checked Store mutation 消耗费用和次数，避免并发使用绕过预算。当前参考 Store 是内存语义替身，不代表生产授权持久化已经实现。该边界落实确定性授权决策：[SOURCE: docs/adr/0004-deterministic-authorization.md]

### Capability Registry and execution boundary

Capability Registry 分开保存不可变版本声明、安装生命周期和短期执行 Handle。声明固定来源 locator、exact version、SHA-256 integrity、operations、permission refs 与 isolation；记录在 `discovered → installation_proposed → installation_approved → active` 之后才能签发 Handle。更新固定新的 version/integrity，标记 operation 或 permission expansion，并再次经过 proposal/approval 才能激活；停用后的版本先 `disabled` 再 `uninstalled`。

一个 `CapabilityExecutionHandle` 只携带 Permission 已允许的 authorization reference、Owner/Agent/Run、固定 capability/version、operation、input refs、delegated context refs、declared secret refs、maximum classification 和 expiry，不复制 Grant 预算或秘密原值。Worker 每次执行都重新验证这些字段和 Registry 当前 active version；超期、撤销、停用或升级会使旧 Handle 失效。

`ExecutionWorkerService` 以现有 `execution.v1` 请求为边界，向能力适配器只转交 Handle 允许的上下文与短期 Secret Handle。取消、调用期限、progress、result、unknown external result 和 failure 映射回版本化 Worker 事件。`work.reconcile` 另经 `ExternalActionReconciliationPort` 查询外部动作，只接受 outcome 与引用一致的 `confirmed_succeeded`、`confirmed_failed` 或 `still_unknown`，并返回 `work.reconciled`；未知结果不能被执行请求自动重试。

当前 `DeterministicRestaurantCapabilityPort` 与 `ScriptedExternalActionReconciliationPort` 只验证搜索、预订和对账的产品语义；它们不是网络客户端、隔离进程或真实供应商。生产 Worker 传输与沙箱仍未实现。该边界落实受治理能力决策：[SOURCE: docs/adr/0008-governed-capability-registry.md]

### Memory and context formation

Memory 端口使用产品自己的 proposal、record、candidate 和 correction 值；正文仍是 Payload 引用，provenance 是 source Trace reference。`packages/testing` 的内存适配器只按标准化 search terms 做可重复 overlap score 和稳定 ID tie-break，不读取正文，也不代表最终召回算法或供应商选择。

`ContextFormationService` 对 Memory 只持有 `search` 子集。每次调用按固定顺序组装 Thread message refs、trigger Payload、policy refs、通过数据等级与数量限制的 memory content refs、Capability summary refs，并把最终清单写成 protected Payload。检索 query、全部 candidates、选择/排除理由和 final context 分成四个父子/因果相连的 Trace 事件；高敏候选会在 candidates 中可见，但不能进入较低等级上下文。

user message、schedule 和 external event 没有各自的上下文实现，三者只改变统一请求中的 `sourceType`。Pi 的公开产品依赖面只包含 Agent Runtime Port，因此不能直接调用 Memory 的 proposal、commit、correct 或 delete；长期记忆写入仍必须由后续 Run Coordinator 的产品策略触发。该边界落实可替换 Memory 决策：[SOURCE: docs/adr/0005-replaceable-memory-boundary.md]

### Model routing and trusted Provider boundary

Model descriptor 以产品值固定 provider、model、version、routing class、deterministic priority、capabilities、允许的数据等级、披露边界和可空 Secret requirement。`ModelRouterService` 的策略阶段先对候选生成明确 allow/deny reason，并把任务 profile、数据等级、请求披露上限、政策引用、全部候选和最终模型身份写入 protected Trace；只有 `model.route_decided` 成功写入后才进入执行阶段并产生 Provider request。

primary、specialist、local 只选择对应 approved routing class；retryable failure 只能进入单独声明的 fallback class。fallback 除重新检查 capability、classification 和请求披露上限外，还与失败路由的实际披露等级比较。启用不可降级规则时，备用模型不能从 local 扩大到 remote，也不能从 trusted remote 扩大到 external remote；被阻断的候选和原因进入 `model.fallback_blocked`，不会触发第二次调用。

每次模型调用都把 request、started、output reference、completed 或 failed 转成父子/因果相连的产品 Trace；重试另有 `model.retry` 和新的 route decision。terminal Payload 记录 token usage、cost micros 和 latency milliseconds，错误只记录稳定机器码。输入和流式输出正文仍只通过 Payload reference 传递。

需要供应商凭证时，Router 根据 descriptor 的 reference/version/purpose 签发仅绑定当前 Owner、Agent、Run、invocation 和 deadline 的 opaque Secret Handle。`packages/platform-node` 的 `TrustedModelProviderAdapter` 在进入受信任 transport 前重新验证 Handle，并只在该适配器的局部内存解析原值；应用请求、产品事件、Trace 和 reference-only resolution log 都不包含原值。调用结束后 Router 撤销 Handle。当前 material source 和 transport 只由测试替身验证，尚不是生产 Vault 或 Provider 集成。该边界落实受策略控制的模型路由：[SOURCE: docs/adr/0007-policy-controlled-model-routing.md]

### Pi Agent Runtime projection

`packages/runtime-pi` 是唯一可以加载 `@earendil-works/pi-*` 包的 workspace。它动态加载固定版本的 `pi-coding-agent`，以避免 Pi 的上游声明类型扩散到产品接口，同时由真实 published package compatibility test 验证 `0.84.2` 的导出和运行行为。每个 Run 都显式传入 product-selected model binding、产品 Payload 引用和授权能力 Handle，并创建 `SessionManager.inMemory()`；Pi Session 只在该次执行中存在。

资源加载器关闭项目 context、Skills、prompts、themes 和已发现 Extensions；`noTools: "all"` 同时关闭 Pi 内置 coding tools。适配器只把 `RuntimeToolPort.listAuthorized()` 返回的 custom tools 加入 Session，并在 Pi 参数 schema 验证后调用产品 preflight。Permission 已撤销、Handle 不匹配或其他 fail-closed 决定不会到达 capability execution。

Pi 的 message、turn、tool、compaction、abort、error 和 settled lifecycle 被映射为产品 Runtime event。消息、工具参数/结果和 provider observation 在进入产品 Payload capture 前做 adapter-local redaction；Runtime event 只携带 Payload reference 或稳定 error code。`before_provider_request` 与 `after_provider_response` 是当前 request/response 观察点。完成事件只会在 `waitForIdle()`、`agent_settled` 和适配器 listener queue 都完成后产生。

Pi compaction summary 只形成 `RuntimeProjectionPort.proposeCompaction()` 请求；它不能直接写 Thread、Memory 或产品消息。Runtime 工具端口以 `RunId + toolCallId` 作为外部动作幂等边界，使 Session 重建不会重新提交已完成动作。该边界落实产品状态高于 Pi 投影的决策：[SOURCE: docs/adr/0001-pi-runtime-adapter.md] [SOURCE: docs/adr/0015-product-state-over-pi-runtime-projection.md]

### Run coordination and scoped worker delegation

`RunCoordinator` 只依赖产品拥有的 `ContextFormationPort`、`WorkerRunPort`、`AgentRuntimePort`、Run 状态提交、State checkpoint 和 Session Trace。它按 `accepted → building_context → running → terminal/reconciliation` 驱动 Run，并把 Owner 取消同时传播给当前 Runtime 与活跃 Worker。Runtime、Worker 和 Pi Session 都不能自行写产品 Run 终态。

每个 Worker request 显式绑定 parent Run、Owner、Agent、task reference、可委派 context references、短期 capability-handle references、数据等级、deadline 和 duration/cost/progress budgets。协调器要求这些引用是父 Run 授权集合的子集，并拒绝任何 secret reference；因此 Worker 不会继承父 Agent 未委派的 Grant 或秘密。Worker result reference 被聚合为 Runtime 输入，unknown external result 则把父 Run 转入 `reconciling_external_result`。

协调检查点使用 `run-checkpoint:<RunId>`，在每个可挂起阶段记录形成的 context reference、已完成 Worker result references、Runtime event count、最新 Trace event 和终态。进程重建后由产品 State 恢复，而不是依赖 Pi Session。`RuntimeToolPort` 的参考实现另以稳定 `RunId + toolCallId` 保存外部动作结果，因此“动作已成功、Runtime 尚未发出结果事件”之间崩溃时，重试返回原结果而不再次执行动作。

### Unified trigger ingestion and scheduling

`UnifiedTriggerIngestionService` 把 user message、schedule 和 external event 都转换成严格的 `gateway.v1 trigger.admit` command。三类来源共享 message/correlation/causation、Owner/Agent、actor、数据等级、idempotency key、Trigger/source、时间、Thread、Payload 和 source proof 字段；应用层只有一个 `TriggerAdmissionPort`，因此 Scheduler 不能直接创建 Run 或绕过后续 Context Formation、Permission 与 Trace 管线。

`ScheduledJob` 是 revision-checked 产品值，持有长期 Grant reference 与冻结的任务语义：capability、operation、resource、side effect、数据等级、单次费用、频率、任务 scope reference、期限和 revocation marker。每次 due dispatch 都先验证当前 Agent Authority Fence，再从 Authorization Store 重读 Grant，校验长期类型、Owner/Agent、有效期、撤销、剩余使用/费用预算及完整语义范围。失败会取消该任务而不产生 Trigger。

每个定时 occurrence 以 `job ID + occurrence` 派生稳定 Trigger/admission idempotency references。调度状态在 admission 之后以 CAS 前进；并发节点即使都投递同一 occurrence，下游 admission 仍按相同 key 收敛为一个 Run，只有一个节点能更新 revision。时钟向前跳过多个周期时只投递当前最早 due occurrence，然后把 next time 与 occurrence 直接推进到首个未来槽位，避免恢复后通知风暴。当前 Scheduler 和 admission sink 都是确定性内存测试边界，不是生产 timer 或 Gateway 实现。

### Central attention and delivery

Run 完成后产生产品 `AttentionCandidate`，其中只包含结果 Payload reference、Owner/Agent/Run/Session/Thread scope、数据等级、紧急度、置信度、duplicate key、设备可用性和可空 interrupt authorization reference。`AttentionPolicyService` 以固定阈值先区分 `SILENT`、`INBOX`、`DIGEST`、`NOTIFY` 和候选 `INTERRUPT`，再结合集中 policy state 的重复窗口、即时交付频率、安静时间与设备状态做降级。`INTERRUPT` 只有在 candidate reference 命中注入的当前显式授权集合时才能成立。

Attention decision 以 candidate semantic fingerprint 和 Owner/Agent policy revision 做 CAS。相同 candidate 重放返回原决定；ID 内容冲突会被拒绝；不同客户端或并发候选不能各自提交冲突优先级。非静默决定与唯一 `DeliveryRequest` 在同一 state commit 创建，静默决定不创建交付。由此客户端只渲染集中决定，不重新判断优先级。

Delivery 有独立于 Run 的 revision 和 `pending → delivering → delivered` 状态。客户端必须先原子 claim；同一时刻只有一个 client ID 可以调用 adapter。缺失客户端、适配器失败或暂时不可用会把请求恢复为 `pending`，不改变已完成 Run；成功 acknowledgement 会冻结 terminal delivery，之后其他客户端只看到 existing result。当前 `DeterministicDeliveryPort` 只按 client ID 返回可重复测试结果并记录引用级 attempt，不包含任何固定 UI。

### Agent Gateway and local composition

`AgentGatewayService` 只接收已认证的 `GatewayAuthenticationContext` 和严格解析后的产品消息。in-process transport 负责把 adapter-specific credential 转成 subject、Owner、device 与 authentication reference；应用服务随后核对 Owner/actor scope，并通过 `GatewayAccessPolicyPort` 执行产品 Owner/Device 授权。认证失败或授权失败不会调用 Control Plane。

所有 Gateway command 只通过 `GatewayControlPlanePort.execute()` 改变状态；Gateway 本身没有 State Store 写依赖。Thread/Run snapshot、Trace query 和事件订阅只通过 `GatewayReadModelPort`。订阅保留客户端 `afterCursor`，并拒绝越出 Owner/Agent/Session/Thread/Run scope 的事件、重复 cursor 和同一 Run 内非递增 sequence。当前 `InMemoryGatewayControlPlane` 与 `InMemoryGatewayReadModel` 是本地参考适配器，不是生产 Control Plane 或持久 read model。该边界落实无头 Gateway 决策：[SOURCE: docs/adr/0002-headless-agent-gateway.md]

`createLocalAgentServiceComposition()` 组合 Gateway、Run state/outbox、Trace、Context Formation、Model Router、Permission、Capability Registry、Attention 和 Run Coordinator。`createLocalExecutionWorkerProcess()` 必须单独启动，Agent process 只接受 ready 的 `execution.v1` client；相同结构也可以由远程 client 实现。启动诊断只输出 component、adapter identity、schema version 与 readiness。关闭先进入 draining、拒绝新请求，再等待登记的 Run settlement。Secret Port 是显式注入项，诊断和 Trace 不读取原值。该边界落实可组合服务和本地优先部署决策：[SOURCE: docs/adr/0011-composable-service-boundaries.md] [SOURCE: docs/adr/0012-portable-local-first-deployment.md]

### Reference E2E and recovery evidence

`test/e2e/beef-restaurant.test.ts` 使用确定性模型、Memory、Capability、Scheduler、Attention、Gateway 和 Worker 适配器运行三段参考旅程。它把牛肉偏好及来源写入长期 Memory，在新 Thread 中选择该记忆并生成建议；语义批准一个长期餐厅监控 Grant；由 timer Trigger 委派搜索 Worker 并产生 `INBOX` Delivery；随后对预订请求签发一次性 Grant 和短期 Secret Handle。预订先返回 `result_unknown`，再由独立 reconcile 请求确认成功。第二客户端读取同一 Thread/Session 的 37 个事件，并从 cursor 10 恢复订阅。

`test/integration/failure-recovery-matrix.test.ts` 对八类恢复点做确定性故障注入：Run commit 前、状态 commit 后 event publish 前、等待审批、模型流中断且 fallback 扩大披露、Worker 副作用前后、未知外部结果、运行中 authority loss，以及分阶段 Session 删除。每个场景都以 protected Trace payload 记录 terminal 或明确 pending/reconciling 状态。

本地源码学习模式只改变 `node_modules` 解析状态。只读检查要求 sibling 的 package name、version 和七个 runtime/build entrypoint 与 committed published pin 一致。受管 link 先保留 published package，再创建指向 sibling coding-agent package 的 symlink；恢复时校验 state、link target、manifest/lockfile hash 和 published backup version。它不会写 `file:` 依赖，不会更新 lockfile，也不会让本地路径进入正式安装契约。普通 `npm ci --ignore-scripts` 始终选择 npm 发布物。

## Main Flows

当前可执行入口是程序化本地参考组合与自动化验证，不包含网络监听或生产守护进程：

```text
npm ci --ignore-scripts
  → independently start local execution-worker
  → compose trusted foreground agent-service
  → authenticate Gateway request
  → authorize product Owner/Device scope
  → dispatch command to Control Plane or query Read Model
  → coordinate Context / Model / Worker / Trace / Attention
  → drain new admission and await in-flight Run settlement on shutdown
```

Fresh completion 验证执行 `npm run check`、四个 Vitest project、Pi compatibility 和严格文档验证。当前确定性测试集包含 101 个 unit、69 个 contract、74 个 integration、3 个 E2E 和 6 个 Pi compatibility 测试。E2E 与恢复测试不访问网络、付费模型、外部账户或生产凭据。

## Known Limitations

- `apps/agent-service` 和 `apps/execution-worker` 只公开程序化 process/composition API；没有 `npm start`、socket/HTTP listener、daemon packaging、service manager 或生产 readiness endpoint。
- 默认 local composition 使用 `packages/testing` 的内存 State、Memory、Trace、Authorization、Scheduler、Delivery 和 Gateway read model；进程退出后数据丢失，且不提供跨进程 transaction、加密强度、高可用或灾难恢复。
- Pi adapter 已通过 published `0.84.2` 与 local-source compatibility，但牛肉餐厅 E2E 使用确定性 Model/Capability，不调用真实模型、地图或预订供应商。
- Execution Worker 在本地配置中保持独立 service object 和协议边界，但尚无真实进程间 transport、sandbox、resource limits 或不可信 MCP 隔离。
- Session deletion 已验证四类抽象 target 的 incomplete/resume/verified 语义；尚无把真实生产 Payload、search、cache 和 archive 全部接入同一次删除的实现。
- Gateway command 已保证认证/授权/Control Plane 委派边界；默认 `InMemoryGatewayControlPlane` 不实现生产 Thread/Run/Approval command handler，Read Model 也由测试夹具显式填充。
- 生产 Secrets Vault、Provider material source、通知客户端、远程 Worker、持久 Scheduler 和网络 Gateway 均未实现。本版本不应描述为可生产部署。

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
