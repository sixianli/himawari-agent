---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:5732277813c2e440efdc2d9b566aebd23982965c0ecd18e302c9a9f21f96d5f8"
supersedes: ""
superseded_by: ""
date: "2026-08-27"
---

# 本地 Node runtime 安装、启停与诊断 Runbook

<!-- runbook-contract:
- apps/agent-service/src/service-main.ts
- packages/persistence-sqlite/src/migrations/0043_sandbox_recovery_scheduling.sql
- packages/persistence-sqlite/src/sqlite-sandbox-recovery-scheduling.ts
- packages/application/src/services/sandbox-resource-recovery.ts
- apps/agent-service/src/production-run-dispatch-loop.ts
- packages/persistence-sqlite/src/migrations/0042_sandbox_resource_incidents.sql
- packages/runtime-pi/src/pi-tool-progress-guard.ts
- apps/agent-service/src/production-coding-workflow.ts
- apps/agent-service/src/production-file-preparation.ts
- packages/runtime-pi/src/prepare-file-mutation.ts
- packages/runtime-pi/src/prepare-file-mutation-worker.ts
- packages/persistence-sqlite/src/migrations/0037_fixed_file_recovery_artifacts.sql
- packages/platform-node/src/files/pi-file-publication.ts
- apps/agent-service/src/production-sandbox-file-recovery.ts
- apps/agent-service/src/production-sandbox-tool-result.ts
- apps/agent-service/src/production-runtime-tools.ts
- packages/persistence-sqlite/src/migrations/0036_fixed_file_scope_contract.sql
- packages/execution-contracts/src/sandbox-scope-v1.ts
- packages/execution-contracts/src/pi-runner-v1.ts
- packages/platform-node/src/capabilities/sandbox-host-verifier.ts
- packages/platform-node/src/files/sandboxed-coding-operations.ts
- packages/persistence-sqlite/src/migrations/0035_workspace_admission_queue.sql
- packages/persistence-sqlite/src/sqlite-workspace-admission-queue.ts
- packages/application/src/services/file-operation-service.ts
- packages/platform-node/src/files/constrained-file-system.ts
- packages/persistence-sqlite/src/migrations/0034_authorization_reservations.sql
- packages/persistence-sqlite/src/sqlite-authorization-reservations.ts
- packages/application/src/services/action-intent-snapshot.ts
- packages/persistence-sqlite/src/sqlite-sandbox-release-operations.ts
- packages/persistence-sqlite/src/sqlite-sandbox-recovery-operations.ts
- apps/agent-service/src/production-thread-titles.ts
- apps/agent-service/src/production-model-composition.ts
- apps/agent-service/src/production-run-composition.ts
- packages/application/src/services/thread-execution-projection.ts
- packages/persistence-sqlite/src/migrations/0032_runtime_history.sql
- packages/application/src/services/runtime-history-service.ts
- packages/runtime-pi/src/pi-native-history.ts
- apps/agent-service/src/public-search-authorization.ts
- packages/application/src/services/sandbox-action-grant.ts
- packages/persistence-sqlite/src/sqlite-durable-operations.ts
- packages/platform-node/src/capabilities/sandbox-runtime-digest-worker.ts
- packages/platform-node/src/capabilities/protected-runtime.ts
- packages/platform-node/src/built-in-identity.ts
- packages/platform-node/src/built-in-identity-routes.ts
- packages/persistence-sqlite/src/sqlite-built-in-identity.ts
- packages/persistence-sqlite/src/built-in-identity-recovery.ts
- packages/persistence-sqlite/src/migrations/0031_built_in_identity.sql
- packages/application/src/ports/built-in-identity.ts
- apps/agent-service/src/production-managed-tasks.ts
- apps/agent-service/src/production-sandbox-stream.ts
- apps/agent-service/src/production-sandbox-services.ts
- apps/execution-worker/src/production-sandbox-execution-v2.ts
- packages/execution-contracts/src/sandbox-readiness.ts
- apps/agent-service/src/capability-programs/pi-coding-main.ts
- packages/runtime-pi/src/sandboxed-coding-executor.ts
- packages/platform-node/src/files/pi-output-export.ts
- apps/agent-service/src/production-sandbox-output.ts
- apps/agent-service/src/production-sandbox-control.ts
- packages/application/src/services/sandbox-execution-reconciliation.ts
- packages/runtime-sandbox/src/job-host-control-client.ts
- packages/runtime-sandbox/src/linux-namespace.ts
- packages/execution-contracts/src/sandbox-preparation-v2.ts
- packages/persistence-sqlite/src/migrations/0029_sandbox_execution_preparation.sql
- packages/execution-contracts/src/sandbox-execution-support.ts
- packages/execution-contracts/src/sandbox-host-binding-v1.ts
- packages/execution-contracts/src/sandbox-qualification-v1.ts
- packages/execution-contracts/src/sandbox-execution-v2.ts
- packages/application/src/ports/sandbox-execution-journal.ts
- packages/application/src/services/sandbox-execution-projection.ts
- packages/persistence-sqlite/src/sqlite-sandbox-execution-operations.ts
- packages/persistence-sqlite/src/sqlite-capability-invocation-operations.ts
- apps/execution-worker/src/production-worker-composition.ts
- apps/execution-worker/src/production-sandbox-worker.ts
- packages/application/src/services/sandbox-scope-service.ts
- packages/application/src/services/sandbox-network-authorization.ts
- packages/application/src/services/sandbox-startup-recovery.ts
- apps/execution-worker/src/production-execution-worker.ts
- apps/execution-worker/src/production-sandbox-execution.ts
- apps/execution-worker/src/broker-sandbox-execution.ts
- packages/execution-contracts/src/payload-broker-v1.ts
- packages/platform-node/src/payload-uds-transport.ts
- apps/execution-worker/src/production-payload-broker-client.ts
- packages/runtime-sandbox/src
- packages/application/src/services/sandbox-job-lifecycle-service.ts
- packages/application/src/ports/sandbox-execution.ts
- apps/execution-worker/src/product-job-host.ts
- packages/application/src/services/runtime-continuation-service.ts
- packages/application/src/ports/run-checkpoints.ts
- packages/runtime-pi/src/pi-tool-batch-continuation.ts
- docs/adr/0023-durable-hitl-execution.md
- packages/runtime-pi/src/pi-runtime-adapter.ts
- apps/agent-service/src/capability-programs
- apps/agent-service/src/production-file-read-workflow.ts
- apps/agent-service/src/production-file-read-services.ts
- packages/runtime-pi/src/governed-read-executor.ts
- packages/application/src/services/run-execution-input-service.ts
- packages/application/src/services/run-coordinator.ts
- packages/application/src/ports/run-dispatch.ts
- packages/domain/src/run-state.ts
- apps/agent-service/src/production-run-reconciler.ts
- scripts/ci/build.mjs
- scripts/package-node-runtime.mjs
- scripts/install-node-runtime.mjs
- scripts/generate-artifact-manifest.mjs
- scripts/ci/install-tools.mjs
- scripts/ci/install-dependencies.mjs
- scripts/ci/resources.mjs
- scripts/ci/redact-text.mjs
- scripts/ci/artifact-files.mjs
- scripts/ci/artifact-archive.py
- scripts/ci/contracts.mjs
- scripts/ci/context.mjs
- scripts/ci/check-policy.mjs
- scripts/ci/quality-policy.mjs
- scripts/ci/source-inputs.mjs
- scripts/ci/verify-artifact.mjs
- ci/toolchain-lock.json
- ci/policy.schema.json
- ci/quality-policy.json
- ci/result.schema.json
- ci/coverage.schema.json
- package.json
- package-lock.json
- apps/admin-cli/src
- apps/agent-service/src
- apps/execution-worker/src/service-main.ts
- packages/application/src/ports/configuration.ts
- packages/platform-node/src/authenticated-uds-transport.ts
- packages/platform-node/src/execution-uds-transport.ts
- packages/platform-node/src/ephemeral-secret-port.ts
- packages/platform-node/src/strict-configuration.ts
- packages/platform-node/src/state-root-layout.ts
- packages/memory-mem0/src/index.ts
- packages/persistence-sqlite/src/product-state-repository.ts
- packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts
- packages/persistence-sqlite/src/sqlite-run-lifecycle-operations.ts
- packages/persistence-sqlite/src/sqlite-run-checkpoint-operations.ts
- packages/persistence-sqlite/src/migration-engine.ts
- packages/persistence-sqlite/src/migrations
- docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md
-->

## Scope

2026-09-11 聊天运行体验更新：可撤销的联网搜索设置保存在既有 Product State，关联审批记录通过 `policyAuthorization` 标明真实授权来源，不新增迁移文件。备份/迁移须共同保留设置 revision、派生 Grant 与审计；关闭设置后，旧 Grant 的消费和 Sandbox 准入被拒绝。恢复后核对设置与当前固定 Exa 路径、主机/目录路由和模型披露身份一致，配置绑定不同不能沿用开启状态。它不授予其他文件、命令或网络权限。Pi 更新合并仅影响尚未持久化的连续累计片段，不能删除已持久化记录或工具边界。`runPolicy.timeZone` 是显式 IANA 时区，只用于新 Run 的时间上下文；历史已冻结内容保持原值。

未配置受保护安装时，完整 runtime 字节校验仍在每次调用的独立工作线程运行；安装必须包含编译后的 `sandbox-runtime-digest-worker.js`。ADR 0028 允许已经独立验证权限的 Linux 安装，在相同进程、相同 root 保护版本身份下复用首次完整审计；每次仍验证当前进程和保护记录，失效立即拒绝，不接受普通时间缓存。保护记录不属于备份或迁移数据，目标主机必须重新建立身份、权限与安装资格，不能复制源主机记录作为证据。此变化不改变数据格式、迁移权威或停止条件。参见 [SOURCE: docs/adr/0028-protected-runtime-installation.md] 和 [SOURCE: docs/runbooks/hermes-control-center-upgrade-runbook.md]；本 Runbook 原有操作范围保持不变。

本次 Web 重构追加 schema 30：`runs.model_selection_json` 保存用户提交时选择的模型引用和思考深度。备份、恢复和迁移必须保留此列及原 Trace/Payload；恢复不能用当前输入框的选择改写旧 Run，也不能给旧记录补造选择。目标配置仍须支持原模型、深度、预算与披露，缺失时报告失败而不是静默替换。浏览器的主题、主题色和未发送草稿属于客户端偏好，不随服务数据库恢复。

控制中心查询执行过程时仅返回经过归属校验和字段筛选的展示投影；恢复检查应核对多轮历史、模型选择与审批等待，不直接开放原始 Trace JSON。取消仍经过 RunCoordinator。上述展示投影已由受控 SQLite/Pi 适配与浏览器测试验证。2026-09-11 Hermes 同机升级、迁移前快照与真实服务重启由专用 Hermes Runbook 和验收记录约束；未执行跨主机权威迁移或从备份完整恢复服务。

schema 28 在原数据库追加 v2 资源关联、独立操作/资源观察、目录占用和派发回执。升级既有库仍须先取得已验证快照；0020/0027 不改写。恢复/迁移时必须保留占用和未确认派发；旧未结束作业缺少可信目录链时按主机保守阻止新准入，缺少主机身份时阻止所有主机的新准入。禁止通过删除 Run、清空占用或把旧记录改成 v2 来恢复执行。已确认清理的旧历史结果保持原解释，不由迁移补写新资格。

这些 SQLite 机制已有独立测试数据库的升级、重开和事务验证；本次未升级运行中的 state root，也未执行真实安装、恢复或跨主机迁移。正式组合已具备显式 v2 foreground 固定读取/命令路径、目录身份和证据读取，Pi 七工具前台 runner 已有假数据验收，目标安装资格仍须独立验证。恢复后继续适用当前主机/目录/权威检查，不能自动重放旧任务或未确认派发。

SRT 的 Agent Service 和 Worker 启动组合已连接现有准入、目录授权状态、受保护 scope、认证 Payload 通道与作业监督器；scope 来源已支持文件 inspect/read 工作流及已批准 Grant targets 的通用工具范围；七工具前台 runner 及后台执行已有专用假数据验收，目标安装资格仍须独立完成。网络范围须来自本次操作同一 Grant 的审批快照确切小写 hostname:port 目标，并与主机能力上界核对；不新增授权或再次消费 Grant。准入及启动前验证授权、父调用和真实 host/runtime/runner/qualification。缺少可信来源时拒绝。策略只由 Worker 编译，初始观察可无摘要，首次原子启动固定摘要后不可替换。

R8 增加 Job Host 私有认证上游，初始化时强制 SRT 两种代理协议通过上游并禁用 bypass；解析后的非公网地址被拒绝。旧裸域名绑定与审批快照不可自动补端口，须由现有授权流程取得有效的明确端口目标。Worker 对所有 mode 每轮监督都重查原授权，失败后请求 Job Host 关闭；关闭出口会终止连接，不等于撤回已经外发的数据或未知后代的文件权限。监督间隔为 250 ms，但 RPC 和调度会增加实际停止延迟。Node 客户端使用 SRT 生成并规范为数字回环地址的代理 URL，不需要为解析 localhost 开放额外 DNS 服务。联网工具仍须在主机 inventory 中声明其必要的只读系统工具链/证书文件，并验证下载、安装和重定向。出口测试计数不是生产签名资格；不得手工把测试证据复制到部署 qualification。

安装产物源码新增了 R1 的 v2 合同、类型端口和纯判断函数，以及 R2 的 SQLite 账本，正式组合按安装声明分别使用 v1 与 v2 foreground；声明不能代替目标平台资格。新增 `SandboxExecutionPortV2` 导出不代表 Job Host 取得新监督资格，也不会把旧 unknown 回执转换为已清理。后续接入 v2 正式适配器时，须重新核对本 Runbook 的迁移、恢复和安装验证。

v2 broker 与 Worker foreground 已接入准备、登记、唯一绑定、观察和限定核查，并有真实 Mac UDS/SQLite/Worker 假数据验收；R6 已增加显式 background/service 路径，只有 Worker、安装声明与资格共同支持时才可准入。安装清单/资格中的 `supportedExecutions` 仅表示显式兼容声明，不提供授权、监管证明或 v2 启用开关；缺少声明不能推断支持 v2，显式排除 v1 的声明也不能通过旧路径运行。追加 migration 0029 已修正准备顺序：先保存不含运行摘要的执行预留及目录占用，Worker 准备后首次 CAS 固定真实绑定；旧记录保持 `legacy_bound`。迁移仍须通过现有同机备份和停机入口，不能直接对正在运行的产品库执行 SQL。R3 范围/控制接口验收已完成，Pi 工具 runner 已完成专用假数据验收，安装资格仍待完成，不得用占位摘要或把 v2 数据标为 v1 进行安装验收。Job Host 私有 IPC 增加会话/boot/序号/监督窗口，但 PID、心跳、主进程退出及 reset 仍不构成任务树释放证明；真实长临时路径探针在 SRT 初始化出现过 `EADDRINUSE`，安装资格还须验证所选 privateRoot 的实际可用性。

schema 27 的作业账本继续作为持久依据；不能给无账本的旧凭证补建可启动作业，不能自动重放清理未知作业。旧作业读回、清理和重复观察不恢复执行权限。Job Host 接收至多 48 KiB 的私有 IPC 输入，仅送入任务 stdin；正文不进入 argv 或环境变量。stdout 保留原 runner 合同并保存为受保护 Payload；CPU/RSS 观察随作业观察持久保存。固定有界进程采样超限或失败时请求停止，采样不能证明硬配额、所有短命后代都被计入或整个进程树已退出。

Agent 启动在开放准入前还会使用当前权威失效 v2 旧监督观察，保留已知结果、效果和目录占用；此恢复没有启动能力，不按旧 PID 接管进程。Job Host 双向心跳超时会请求停止，过期 IPC 消息不能续期。Worker 卡住、重启记录转为 lost/unknown 的测试通过不表示残留风险已消除；解除占用仍需独立可信清理证据。

真实 Mac 假数据组合探针已验证实际 scope/UDS/SQLite/Worker/Job Host、保护规则、资源记录及隔离后不重放，但使用的是受控测试资格和已准备的测试调用；它不是正式主机资格签发，也没有验证真实模型/HITL 或实际进程崩溃后的安装恢复。正式安装与恢复验收仍待完成。启动时的旧作业核查、清理未知隔离，以及关闭时先保存观察再断开通道的顺序继续适用。安装、备份和权威迁移流程不因组件接入而改变，恢复的旧 Capability 记录不能充当新 SRT profile 的资格。

本 Runbook 只覆盖当前仓库已经验证的本地 Node runtime：从锁定依赖构建可重定位 artifact，安装到明确的绝对前缀，使用受保护的 Execution Worker UDS 启动 Agent Service，执行只读 doctor/db status，并以有界信号完成正常停止或故障重启。它不负责安装 systemd/launchd unit、不修改公网入口、不切换 authority、不配置真实 provider、不部署到 Hermes，也不替代 authority transfer Runbook。

公开服务主入口已连接 HTTP、持久 Run、Pi、已授权 Worker 工具和 Mem0。缺少 `runPolicy`、HTTP、身份配置或实际模型配置时，仍以 `SERVICE_PUBLIC_MODE_INCOMPLETE` 拒绝启动。启用前必须验证同一安装候选的完整请求、持久结果和重启回读；库导入成功或 `service.ready` 不能替代这些证据，也不能替代实际目标环境资格。

文件读取工具已复用 Pi `read` 定义，无 Handle 调用表示读取意图。正式组合已提供 inspect/read 两阶段工作流，持久保存调用 context、阶段输入和 Handle，并通过 Worker 派发；读取与模型披露分别检查授权。缺少有效路由或目录授权时拒绝执行，需要审批时保存等待状态。安装及服务启动成功仍不能证明实际 Mac 文件读取可用，须完成目标 Worker 隔离资格及全流程验收。Agent Service 不执行 Pi 默认本机文件 I/O，既有可执行工具仍通过受限 `inputRef` 使用 Worker。

安装产物包含 Agent Service、Execution Worker、admin CLI 及产品运行时包；它不包含 `packages/testing` 的生产 adapter。打包器从列入 runtime 的生产 workspace manifests 自动推导全部直接外部依赖根，再递归复制其依赖闭包；因此 `platform-node` 声明的官方 MCP client 也必须出现在安装产物，新增生产依赖不能依赖手工清单。Agent Service 启动时只从 strict configuration 读取一个 primary、一个 private-only fallback 和一个独立 embedding descriptor；支持的 OpenRouter 配置创建 production Model/Pi 与 Mem0 composition，Mem0 使用配置声明的 embedding provider/model/version 和 dimensions，deterministic 配置只报告 descriptor，不创建隐藏模型或调用 provider。每个构建记录提交身份、实际源码与 package-lock 摘要、workspace checksum、Node 平台/架构和外部依赖闭包；已审阅的未提交改动不能被省略为只有提交身份。由于 `better-sqlite3` 等 native 依赖，Mac 与 Linux 必须分别构建和验收，不能把一个平台的二进制包当作另一个平台的 immutable artifact。

Schema 40 为尚未绑定的预约增加不可撤销的停止标记，并保留独立的有限恢复记录。停止或启动恢复遇到这类预约时禁止后续绑定；已注册环境只通过原认证 Job Host 控制通道请求停止。标记不证明私有环境已清理或共享占用可释放，缺少证据时仍保留 claim；不补造运行时身份或永久释放回执。升级必须先备份并迁移唯一 writer，Schema 39 及以前的 writer 不得接管。Worker 线上消息合同没有新增字段，旧 Worker 也不能绕过数据库绑定检查。

Schema 41 新增独立的 `sandbox_reservation_release_receipts`。只有原认证宿主证明任务从未启动、原进程已退出且清理完成，当前 writer 才能同事务保存永久回执并释放该预约的占用。原停止标记保持不可撤销，不伪造运行时绑定、业务结果或退款；重复停止和恢复读回原事实，不因核验凭据过期重新占用。缺少宿主证明、仍有保护或已启动任务的后代状态未知时继续保留未确认状态。备份与权威迁移须同时保留回执、停止标记及受保护宿主证据；Schema 40 及以前的 writer 不得写入新库，回退仍需停机并恢复匹配旧版本的完整恢复点。

轮次已取消、失败或完成后，如果某个工具只有准备事件而没有结束结果，页面显示“结果未确认”，不持续显示准备中；明确未派发的原证据仍显示“尚未派发”。缺少真实起止边界时不生成时长，刷新后沿用相同规则。

## Authoritative Sources

- 服务启动、authority/SQLite 检查、UDS client/server、信号 drain 和稳定错误码：`apps/agent-service/src/service-main.ts`、`apps/execution-worker/src/service-main.ts`、`packages/platform-node/src/execution-uds-transport.ts`；共享认证、socket 权限和绝对截止时限由 `packages/platform-node/src/authenticated-uds-transport.ts` 管理。
- 可重定位 artifact、内部 workspace 包和外部依赖闭包：`scripts/package-node-runtime.mjs`。
- 绝对前缀安装和三个入口：`scripts/install-node-runtime.mjs`。
- 固定工具、禁用未知安装脚本和 SQLite 原生构建探针：`ci/toolchain-lock.json`、`scripts/ci/install-tools.mjs`、`scripts/ci/install-dependencies.mjs`。
- CI 恢复下载缓存时，工具安装前缀只允许已有普通 `downloads`、`wheels` 目录；已有解压程序、安装记录或目录符号链接仍拒绝。每次重新核对归档摘要、解压安装并验证工具身份，不复用上次安装的 executable。仅 CI 汇总器使用主锁文件投影出的最小依赖，产品构建与本 Runbook 安装仍使用完整依赖及 SQLite 探针；该优化不改变运行时产物或服务启停约定。
- 安装期间的磁盘采样与错误脱敏：`scripts/ci/resources.mjs`、`scripts/ci/redact-text.mjs`；采样只提供观测峰值下界，出现采样错误时须保留不完整状态和有界诊断，不能从安装成功推导采样完整。协调暂停单独记录原因、耗时和操作结果，不抹去暂停前的失败。
- 文件模式、内容摘要和归档校验：`scripts/ci/artifact-files.mjs`、`scripts/ci/verify-artifact.mjs`。CI 归档安装还绑定同一次运行的 context；它与下述本机目录安装入口有不同的输入参数。 Context 的来源由 `scripts/ci/context.mjs` 核验；周期质量归档还核对已提交的启用状态、默认分支、cron 与同次 SHA，不能通过临时修改工作树取得周期身份。共享 Context 支持周期事件不启用任何安装或周期操作。
- CI 源码摘要记录实际工作树中的构建输入，包含普通源码的新增、修改、删除和文件模式，不能只记录 Git HEAD。构建器仍引用的模块或显式必需文件缺失时必须失败；构建期间及安装前再次核对摘要，不能用忽略所有缺失文件的方式通过校验。
- state root、SQLite migration、Worker recovery 与身份边界：`packages/platform-node/src/state-root-layout.ts`、`packages/persistence-sqlite/src/product-state-repository.ts`。
- 本 Runbook contract selector 中列出的源文件和 portable durable web-agent Spec。

本地安装合同补充：Worker 以 deployment binding.kind 区分 sandbox 与旧 process 后端；SRT 不需要伪造旧 process isolation 配置，仍须通过真实 host 资格复核。权限续租只改变到期信息时，不使并发读取失去原权威；停止或身份变化仍必须拒绝。公开网页客户端先创建产品 session，再从认证配置读取 sessionId，不能拼造 ID。重复 Payload 上传须比较带 `sha256:` 前缀的同一正文摘要；并发活跃时间更新冲突时重新检查会话及设备撤销状态。这些规则已通过实际 HTTP／SQLite 和并发回归验证。

审批页空闲时，`/api/gateway/v2/events` 应保持连接并发送心跳；HTTP 200 后立即结束不是正常空闲状态。正式审批组合通过受控订阅通知快照变化，浏览器重新读取审批列表／详情；该提示没有 durable cursor。验收须覆盖空列表下的连接稳定、持久数据变化后的刷新和客户端断开后的订阅取消，不能只检查状态码或用测试服务器的常驻空连接替代正式组合。

控制中心验收还须检查已认证 `/api/control-center/v1/config` 的安装操作清单：当前正式部署只开放对话、审批和依赖健康检查，其他 13 个页面应显示“未启用”且不发送缺失操作的查询。健康页必须读取 `/api/health/v1/dependencies` 的实际依赖状态；连接指示灯不能证明业务功能已安装。已认证但未安装的操作应返回 HTTP 501 / `PORT_OPERATION_NOT_INSTALLED`，不能报成身份权限错误；无效身份和错误 authority 仍应拒绝。不能为了消除报错而移除授权检查，或把缺失后端替换为空数组。


Hermes 的 systemd、Cloudflare 入口、Host 签名与付费模型验收是 Owner 另行明确授权的部署操作，证据记录在 [SOURCE: docs/execution/plans/2026-09-07-srt-unified-execution-plan.md] 的 R8；不扩张本 Runbook 的本地安装操作范围。

### 2026-09-11 安装合同补充

打包会规范普通文件与目录权限，去掉 group/other write 并保留可执行位，避免构建主机 umask 让运行时拒绝实际安装。增加 Pi 工具与公开搜索的请求路由并不创建权限：`runPolicy.coding`/`publicSearch` 必须引用真实目录 Grant 和合格 Capability；搜索使用固定 Exa MCP 出口及受保护结果，不能把查询摘录当作完整网页。工作目录和 Capability 登记使用离线 CLI，要求独占锁、活动身份及明确目标确认。

每次启动检查新鲜资格；同一次启动内复查不可变快照原字节与实时安装摘要，不以五分钟经过自动撤销正常工具，也不接受修改后的配置。快照不能迁移成另一主机的资格。当前 Hermes 操作由 [SOURCE: docs/runbooks/hermes-control-center-upgrade-runbook.md] 单独约束。

## Safety and Preconditions

- 目标必须是本机明确的临时或已批准 state root、runtime 前缀和配置路径；不得使用工作目录推断生产路径，不得把 `/data/hermes` 或其他共享 Hermes Agent state root 当作 Himawari 目标。
- 安装前记录 Git HEAD/worktree、package-lock digest、Node/npm、目标前缀和 state root、磁盘可用空间及现有进程。目标前缀必须由本次运行创建，或已取得清理其 `lib/himawari-agent` 的明确授权。
- 配置必须是 strict production profile，authority.json 的 deployment/Owner/Agent/status/epoch/fence 必须与 SQLite 一致；Worker token 只能从 `0600` 文件读取，secret source 不得进入 argv、日志或证据。
- 启用真实 Worker 能力时，配置必须引用 Owner 独占、非符号链接、大小有界且 SHA-256 匹配的不可变能力部署快照。快照中的 Manifest、平台资格和 runtime binding 必须与当前 build、平台及 Agent Service 的 active Capability Registry 一致；空、缺失、被改写或不合格的快照必须使 Worker 保持 not ready。
- Agent Service 必须先有同一 deployment 的 Worker；Agent Service 不会在 Worker 不可用时降级到进程内执行。两个服务必须使用同一 state root 的 runtime 目录和 boot-scoped token。
- 启停与诊断证据只写入 `test/integration/qualification/evidence/operations/install-start-stop/<unique-run-id>/`，目录 `0700`、文件 `0600`；不记录配置全文、token、secret value 或私人 Payload。

公开模式的 `runPolicy` 必须显式配置，例如：

~~~json
{
  "version": "owner-policy-v1",
  "systemInstruction": "按用户请求执行已授权任务。",
  "memoryLimit": 20,
  "maxSelectedMemories": 5,
  "maxMemoryClassification": "private"
}
~~~

系统指令不得包含凭据。Memory 选取数不得超过检索数，实际注入分类同时受当前 Run 分类约束。模型描述符和费用上限仍由原配置字段提供。修改配置只影响尚未冻结输入的 Run；运行中的已冻结请求不会改用新指令。已有数据库需按同机 snapshot 和迁移合同升级到当前 schema，不能跳过备份直接启动旧库。

启用文件读取时，`runPolicy.fileRead` 必须引用当前 Worker instance、目标 hostId、既有目录 Grant 和匹配的 Capability 版本。能力 program 的固定 argv 应指向安装树中 agent-service 包的 `dist/capability-programs/host-file-read-main.js` 并携带 hostId/workerInstanceId；该入口由 Worker 隔离后端启动，不能在 Agent Service 内执行。Manifest 声明 inspect/read/disclose，后者仅用于授权。配置、程序存在或打包成功均不创建动作授权，也不替代本机能力隔离资格。

项目七工具使用独立的 `dist/capability-programs/pi-coding-main.js`，固定 argv 仍是 hostId/workerInstanceId；安装 operationBindings 显式声明 `pi-coding-tool` 版本 `1`，只读工具采用 fixed_read，bash 采用 command，write/edit 采用带 verifier 的 verified_effect。scope 必须是 authorized-project.v1，仍复用 Grant targets 和原准入通道。该入口不能替代 host-readonly.v1 的 inspect/read 审批。工具目录不会因为文件存在而自动向模型开放能力。

在计算 runtimeDigest 和主机资格之前准备 `runtimeRoot/pi-tools/bin/bash`、`rg`、`fd`：必须为适合目标 OS、可实际执行的普通文件，不接受符号链接。运行环境仅使用该目录作为 PATH，PI_OFFLINE=1；缺依赖明确失败。不要直接复制 macOS 平台签名的系统 Bash 并假定副本能运行；须验证实际安装文件及其签名/加载依赖。其他命令依赖同样须先安装在允许且固定的工具链内，不能以工具运行触发隐式下载。新增二进制会改变 runtimeDigest，须重新取得当前主机资格。

通用 HITL 需要 migration 0026、受保护恢复 Payload、审批存储和执行租约一同可用。公开入口使用已有身份与 CSRF 校验提供 `approval.list/detail/respond`，Thread 的等待、恢复和取消状态通过持久事件通知页面。等待审批不占用执行槽位；批准、拒绝、审批过期或原 Run 总期限到达后才重新领取。恢复仍使用原始截止时间，不能重新分配时长。其他治理操作未因审批入口接入而自动启用。

## Live-State Preflight

在安装或启动前执行以下只读检查，并保存脱敏结果：

~~~text
git rev-parse HEAD
git status --short --branch
node --version
npm --version
df -h <target-filesystem>
ps -axo pid,command
~~~

确认构建输入来自当前 checkout 和 committed `package-lock.json`，目标 prefix/state root 是绝对规范路径，目录 owner/mode 安全，旧的 `execution.sock` 不存在或由同一受控进程持有，目标 deployment 没有其他 active service。启动前再运行：

~~~text
<absolute-prefix>/bin/himawari db status --config <absolute-config-path>
<absolute-prefix>/bin/himawari doctor --config <absolute-config-path>
~~~

若目标已有活动服务、state-root lock、socket、authority 不匹配、schema 不完整或可用空间不足，停止；不得删除活锁、覆盖 state root 或猜测服务管理器命令。

## Procedure

1. 对本 Runbook 执行静态 contract check，建立新的受限 evidence 目录，冻结本次构建 commit、prefix、state root、deployment、Owner/Agent 和运行 ID。
2. 在干净或已审阅的工作树上按 README 安装固定工具链，再执行 `npm run ci:install`；该入口先运行 `npm ci --ignore-scripts`，只构建清单中已审阅的 SQLite 原生依赖并实际验证内存读写。将本次工具目录的 `bin` 放到 PATH 后执行 `npm run build`。工具目录和安装证据目录必须是本次新目录，已有目录使用显式参数另选路径，不覆盖旧证据。不能把未校验的旧 node_modules 或单独 `npm ci --ignore-scripts` 当作完成原生依赖安装。
3. 核对两个 artifact manifest 的提交输入、package-lock SHA、workspace checksum、Node 平台/架构、schema/migration sequence 和依赖版本。构建输入摘要包含仓库 `assets/` 下的品牌资源；Logo 缺失必须导致浏览器构建失败，不能接受资源被改动后仍沿用旧摘要的归档。确认 runtime 外部依赖根与列入打包的生产 workspace manifests 完全对应，`@modelcontextprotocol/client` 等新生产依赖和传递闭包存在，`@himawari-agent/testing` 不存在；若核对失败，删除本次临时产物并停止。
4. 创建本次明确的绝对安装前缀并安装：

~~~text
mkdir -p <absolute-prefix>
npm run install:node-runtime -- --prefix <absolute-prefix>
~~~

5. 在启动前运行 `himawari db status` 与 `himawari doctor`，确认 SQLite quick check、schema、authority、Payload、Worker 和 identity 的脱敏状态；若配置声明能力部署快照，还要回读其规范路径、owner/mode、字节数、SHA-256、Manifest/运行绑定数量和本平台资格结论。只读命令失败时不启动普通服务。
6. 以独立子进程先启动 Worker，再启动 Agent Service。Worker 先公布本次 `workerInstanceId/workerBootId`；Agent 取得当前 authority lease 后启动反向权限与 Payload 服务，再发布同时绑定双方实例、boot 和当前 authority 的启动文件，最后完成 Worker handshake。记录双方 `service.ready` 的 component、schema、identity 和 recovery counters；只存在 socket 或旧启动文件不算完成握手。
7. 运行只读 doctor、db status 和适用业务查询；确认 Agent Service 通过 UDS handshake、`service.ready` 记录 model path、memory path 与 embedding descriptor identity、没有 testing adapter、没有 repository checkout 路径，也没有秘密或私人正文输出。deterministic profile 必须显示 descriptor-only；支持的 Pi/Mem0 profile 只能显示配置中的 primary/fallback/embedding reference、version 和 dimensions，不能显示 secret value。
8. 正常停止时先向 Agent Service 发送 `SIGTERM`。Agent 按已登记资源先停止接纳、等待在途工作，再逆序关闭依赖；Memory 消费者停止领取新任务并等待当前批次完成后，才关闭 Memory、模型、authority 和 SQLite。等待 `service.draining` 与 `service.stopped`，再向 Worker 发送 `SIGTERM`，等待其停止并确认 socket 已删除。超出有界等待后才记录 forced stop，并把后续启动视为 recovery drill。
9. 重启或 forced stop 后重新取得 state-root lock，确认同一 deployment/Owner/Agent/Run identity、SQLite schema/quick check、pending recovery counters 和 UDS handshake；不得将普通一次重启写成完整 crash matrix。
10. 完成验证后保存脱敏命令输出、artifact identity、进程退出码、socket/lock 回读和 rollback 状态；临时 prefix、临时 state root 与证据目录按本次授权的保留策略清理。

### Schema 43 资源恢复调度

升级和恢复须保留原 `recovery_json` 的 owner、revision、次数、动作及时间。`scheduled` 表示已排定原资源核查，`nextAttemptAt` 是最早可检查时间；此时开始和结束时间为空。真正开始后才增加次数，终态 `unresolved` 没有下次自动重试。迁移只为旧记录补空的下次时间，不制造释放证明或恢复工具权限。Schema 42 或更旧 writer 不得写入新库；回退须停止新 writer 并恢复匹配旧版本的完整恢复点，禁止删除 migration ledger 或新字段来降级。

已配置沙箱子系统时，后台独立检查终态 Run 遗留资源、过期执行和已有未知资源，按原资源身份执行有限 inspect/stop。Web 模式复用生产 Run 循环；无 Web 模式在启动登记和 Worker 就绪后启动仅处理资源的循环，每次扫描先复核权威，不创建模型或 Run 执行服务。原授权撤销不阻止核验清理，也不恢复执行、模型或披露权限。未绑定预约须先保存禁止启动标记，核查失败继续保护；只有原宿主从未启动且已退出的证明才允许释放。关闭服务或失去权威时立即取消核查，然后有限等待；close 复用同一次等待，不重新计算期限。明确 stop 可接替尚未结束的 inspect，旧检查的迟到写入被恢复 revision 拒绝；已经进行中的 stop 不重复派发。未配置后端、缺少可信宿主身份或只有启动日志均不能证明清理成功；Mac 任意后代停止资格仍须现场证明。

验收应独立读回释放凭据、claim/barrier 和恢复终点。已确认释放但业务结果未知时分别保留，不重发工具，也不以结果交接未完成恢复旧占用。原始预约核查异常沿用受保护 Trace，仅安全原因进入恢复状态。本地 SQLite、认证 socket 和受控宿主退出回归见[调度证据](../../test/qualification/evidence/workspace-authorization-lifecycle/p1-recovery-scheduling-01/README.md)，不替代部署实例的证明或操作授权。无 Web 启动、权威丢失、有限关闭和 stop 优先级的回归见[生命周期证据](../../test/qualification/evidence/workspace-authorization-lifecycle/p1-recovery-startup-01/README.md)。

### Schema 42 资源矛盾事件

释放后收到同一资源的新鲜宿主运行证据时，原 journal 会建立独立 `resource_contradiction` 保护并记录 `SANDBOX_RELEASE_CONTRADICTED`，不篡改原释放凭据或物理 claim。保护范围仍为原精确资源；原有限恢复任务保存 owner、revision、次数和 unresolved 终点。旧停止证明重验不能解除新保护，必须核验晚于事件且身份匹配的新停止证据。备份、恢复和权威迁移须保留保护表中的接纳权威、验证正文及解除证明，不能只恢复原释放凭据。Schema 41 或更旧 writer 必须拒绝新库；回退只能在停止新 writer 后恢复匹配旧版的完整恢复点，不删除事件或降低版本号。此变更没有执行生产迁移，也不使 Mac 获得完整后代停止资格。

## Verification

### Schema 33 释放事实与有界恢复

Schema 33 保存 `sandbox_release_receipts`、独立控制保护及 `recovery_json`。升级、备份与迁移必须一同保留这些记录、原执行观察与占用；已经提交的 `released_at` 不得清空，结果 ACK 迟到不改变释放事实。旧记录没有新的可信释放回执时不自动回填或解锁，须通过当前安装的受限 inspect/stop 核验；过期凭证不能当作新观察使用。

启动恢复不重发原工具；核验超过期限且原任务仍持有处理权时记录 unresolved。恢复观察带原任务 revision，SQLite 在写入事务内比较 owner、revision、运行状态及释放期限；任务被接管或结束后，旧回调不能写入释放证明，也不能替新任务结束恢复。超时后的后端返回不再触发新校验或写入；登记阶段耗尽期限时不再调用宿主。结束前重新读取并保留同期工具结果和永久释放事实。此修复沿用 Schema 41，不新增迁移或 Worker 工具字段；升级时仍须按原停机流程替换唯一 writer，不能仅凭 schema 相同忽略旧程序缺少恢复写入隔离的行为差异。验收独立读回原释放时间、恢复 owner/次数/终点和未完成交接，不能仅凭页面状态判定清理完成。恢复回执只证明资源义务已结束，不恢复执行或模型披露权限。Schema 33 不允许旧 writer 直接写入；回退须停止服务并使用匹配旧版本的完整、已核验恢复点，不能删除新表或修改 migration ledger 降级。本次源码与隔离数据库测试不代表已对部署实例执行迁移或解锁。

### Schema 34 审批与额度预约

Schema 34 新增 `authorization_reservations` 并为使用记录增加请求身份。备份与恢复须保留预约、Handle、调用回执和已消费计数的一致快照；历史消费不自动退回，迁移不会使旧请求重新可执行。新 v2 摘要使用 SHA-256，旧摘要只按原快照验证，不覆盖已有审批内容。

验收分别读回 reserved、committed、released：排队预约不增加消费，调用准入与额度承诺同事务完成；未派发释放必须同时撤销未使用 Handle。缺少 ACK 不能作为退费或重发依据。回滚只能在服务停止后恢复匹配旧版本的完整恢复点，禁止让 Schema 33 或更旧 writer 写入 Schema 34，因为它们不理解预约额度。此处仅定义升级合同，未授权或执行部署实例的迁移。


### v4 控制中心与持久事件核对

本次调整增加 Worker 工具实际起止事件和 Pi 可观测思考边界的展示投影，沿用原有 Trace/Payload 存储，不增加数据库迁移。备份、恢复及权威迁移仍须完整保留这些记录；缺少旧时长边界的历史显示“暂无时长”，不得在恢复时补造计时或重放工具。原有停止、安装资格、加密与权威检查程序继续适用。

聊天页的新建先进入本地草稿，首次发送才创建持久会话。审批在所属轮次处理，侧栏红点提醒；归档管理位于齿轮设置的“会话与数据”。联网搜索开关与会话内“记住我的选择”复用原来的受限搜索授权合同。设置不展示内部 checkpoint、修订和连接绿点。安装后须验证草稿恢复、幂等重试、当前轮审批以及真实模型支持的强度档位，不能以原型演示数据作为运行证据。语言切换应保持设置弹窗及当前页面状态。


自动标题由正式模型组合注入 Run 组合：首次 Assistant 消息触发对活跃且无标题对话的检查，使用该 Run 的模型引用和首条用户消息的分类，沿用 Pi transport、披露检查与费用准入。正文可先显示，Run 结束前等待本地标题调用准入；标题响应异步完成，成功后写入受保护 Payload 并发布 Thread 改名事件。已有标题、手动改名和归档状态优先，失败只记录 `thread-title.failed`，不把标题失败改记为正文失败。停机时先停止 Run 循环，再等待标题请求结束；单次标题模型请求最多 20 秒或配置的更短期限，不能仅以正文完成判断所有模型请求已结算。

安装验收使用合成对话检查自动标题、刷新持久化和费用记录，再核对执行过程的模型请求、工具参数、执行与结果关联。记忆与上下文阶段仅展示发生记录，不公开原始正文；沿用 Thread 游标，不另设重连位置。以上变化不新增数据库 schema、配置字段或历史批量补名步骤，记忆检索不因生成标题而跳过。真实模型验收须使用本次获准的原模型和费用范围；隔离测试通过不等同于真实模型或迁移验收通过。

启用沙箱能力的 Agent 必须在本进程完成首次安装校验后才进入 ready，不能以 Worker 已就绪代替。受保护程序摘要可在安装及文件身份未变化时复用，安装外的程序仍逐次校验；这不改变本手册的数据格式、权威转移或停机步骤。恢复到另一安装或主机时，原进程缓存不适用，必须重新验证实际安装。Hermes 的 NVMe 私有只读挂载及设备回读另见 [SOURCE: docs/runbooks/hermes-control-center-upgrade-runbook.md]。

工具审批续跑快照同时保存本轮进展指纹和已完成工具结果，备份、恢复及迁移须连同其受保护 Payload 一起保留。恢复审批时只重放同一暂停点已有的结果，不再次执行对应工具；因循环保护中止的 Run 保持失败，即使随后生成了结果说明，也不能改记为任务成功。这些运行层行为不依赖具体模型提供商。

Schema 32 增加受保护原生历史快照、Run 内顺序和 Fork 固定引用。迁移须先取得既有机制核验通过的停机备份；升级后回读 `run_payload_artifacts`、对应 Payload 密文和 `thread_fork_lineage.runtime_history_json`，核对旧 artifact 内容未变、外键完整。恢复与迁移须保留清单引用的所有消息 Payload，不能只搬运聊天正文。重启后以新 Run 验证旧工具调用/结果可见且不重新执行；取消后核对实际结果及新请求，不能仅看服务 ready。旧 Trace 没有自动导入为完整历史，不能由 schema 升级推断旧会话已修复。回退需要匹配旧版本的整套已核验数据库备份，禁止旧二进制直接打开 schema 32，也不手工删除 migration ledger。

- 未保存完整审批暂停点的中断执行交给生产恢复组件后，Run 与 checkpoint 必须同时显示 `reconciling_external_result`，旧执行租约失效，已有结果引用保留；恢复不能重新调用模型或工具。此检查当前有本地 SQLite 证据，完整安装入口验证仍待完成。已经待核实的记录不重复占用初始扫描批次，不代表外部结果已经确认。

- `runtime-manifest.json`、build artifact manifest、package-lock 和 `git rev-parse HEAD` 能互相对应；内部 package 版本和外部依赖版本均为精确值，生产 workspace manifest 的每个直接外部依赖根及其闭包都存在，且安装树不包含 `@himawari-agent/testing`。
- `himawari doctor` 返回 ready，`himawari db status` 显示 managed schema、预期 migration sequence 和 `quickCheck: ok`。
- Worker 与 Agent Service 均从安装 prefix 运行，不依赖 repository cwd、TypeScript source、未声明 `../pi-mono` 或 testing adapter；Worker 先于 Agent Service ready。
- Worker ready 必须来自非空且完整验证的能力部署快照；`capabilityRef + version + artifact digest + platform qualification + runtime binding` 任一不一致时，真实能力 adapter 不得注册或执行。
- `service.ready` 的 model path、memory path 与 embedding descriptor 来自 strict configuration；deterministic profile 不初始化 Pi 或 Mem0，production Pi profile 只绑定显式 primary/fallback，embedding 不进入 Pi generation registry，而由 Mem0 projection 使用显式 dimensions（本次配置为 4096）。
- 正常停止后无遗留 UDS socket、活跃 state-root lock 或未记录 child process；forced stop 后下次启动仍通过正式 recovery。
- Worker 重启产生新 boot identity 后，旧 Agent 启动绑定必须失效；只重启 Worker 不得沿用旧 Agent/Worker 配对。当前 authority 或任一 peer identity 不匹配时，权限与 Payload 请求不得通过。
- 配置了生产 Memory 时，ready 前已执行消费者启动与当前 authority 检查；每次新任务领取前再次检查权威。只构造 Mem0 对象不算消费者就绪。该消费者证据不代表其他尚未接入的后台任务已经运行。
- 当安装产物启用持久执行领取时，验证领取使用当前实际权威和新进程身份，旧执行不能续租或写 Run/检查点；恢复必须区分安全续跑与未知结果待核对。停止服务不得伪造 Owner 取消，也不能仅凭启动日志或表中存在租约就认定领取循环已接入。
- 启用持久 Run 组合时，核对 `deadlines.runMs` 已冻结为受保护输入中的绝对截止时间；恢复不得超过首次冻结的截止时间。缺少截止时间的旧执行快照不能自动重建或继续执行，应保留现场并核实旧执行状态。超时必须请求停止当前执行并拒绝迟到成功，Worker 请求的截止不能超过父 Run。
- 目标前缀、state root、authority file、SQLite、Payload、runtime/cache 和证据权限符合当前配置；诊断输出不含 token、配置全文或私人正文。
- 该 Runbook 的成功只证明本机安装/启停边界，不证明 Mac/Hermes 双向迁移、真实 provider/GitHub/Cloudflare、systemd/launchd 或 production readiness。

- 对保存了完整 `awaiting_approval` checkpoint 的 Run，核对对应审批、恢复正文、原工具调用和模型调用序号均可回读；待决时无新执行租约，作出决定后使用新租约。重启后的已确认工具阶段不得重复执行，未知阶段继续核查。原 Run 已取消或超过总期限时不得继续读取或调用模型。

## Evidence

每次执行使用新的 `test/integration/qualification/evidence/operations/install-start-stop/<unique-run-id>/`，记录静态 contract digest、Git HEAD/worktree、Node/npm、平台/架构、artifact/package-lock/workspace checksum、prefix/state-root/authority identity、目录和 socket/lock 权限、磁盘空间、精确命令与 exit status、service ready/draining/stopped 日志摘要、doctor/db status、重启 recovery counters 和清理结论。

只记录稳定错误码、计数、版本和引用；不得记录 secret value、Worker token、环境转储、Cookie、private key、配置全文、Payload plaintext、数据库行或共享 Hermes Agent 数据。

## Rollback

- 构建或安装在服务启动前失败时，只移除本次新建 prefix 和 `dist` 产物；不得触碰既有 state root、其他 prefix 或共享主机服务。
- 服务启动失败时保留脱敏 stderr、authority/lock/socket 现场和 evidence；先停止同一运行创建的 child process，再按正式 doctor/db status 诊断，不能用 `kill -9` 后直接删除活锁。
- 正常停止后若重启验证失败，保持服务停止，回退到本次安装前已验证的 prefix/state root 或走独立 backup/restore；不得把应用回退与数据库恢复、authority transfer 或公网入口切换混为一个动作。
- prefix 清理不删除 Owner 数据；state root、Payload、recovery point、迁移包、secret source 和外部副作用各有独立授权与 rollback 边界。

## Stop Conditions

- Runbook static check、Git/build/artifact contract 或 target-read-only preflight 失败。
- prefix、state root、deployment、Owner/Agent、authority epoch/fence、配置或 Worker token 路径不明确、不匹配或权限不安全。
- 发现活跃 Agent/Worker、UDS socket、state-root lock、未知 child process、testing adapter、repository cwd 依赖或旧 authority 未对齐。
- SQLite 版本、schema/migration digest、quick/full integrity、Payload authentication、Worker handshake、doctor/db status 或 recovery identity 任一失败。
- 能力部署快照缺失、可被其他账号写入、为符号链接、超出上限、SHA-256 不符、含未知或重复项，或 Manifest、资格、runtime binding 与当前平台/注册表不一致。
- 需要把 secret 放进 argv/env/log/Trace，扩大安装目录、覆盖既有数据、猜测 systemd/launchd 命令，或对 `/data/hermes` 共享 Hermes Agent state root 做写入。
- 磁盘不足、安装脚本跨出绝对 prefix、服务未在有界时间内 drain/stop，或 forced stop 后现场无法安全回读。
- 要求把本地安装通过等同 Mac/Hermes transfer、真实外部账户、public URL、paid model 或 v0.2 production-ready。

## Troubleshooting

资源核查失败时先看持久恢复终点与安全原因：`SANDBOX_RECONCILIATION_PERMISSION_DENIED` 表示宿主检查被拒绝，不代表原执行 Grant 应重新授予；`SANDBOX_CONTROL_TIMED_OUT` 是控制连接请求超时，`SANDBOX_RECONCILIATION_TIMED_OUT` 是整个核查任务到期；身份、目录或证据变化必须核对原绑定，不能直接采用当前 PID。`unresolved` 表示本次核查已经结束，不表示后台正在重试。失败细节经原 Job 的受保护 `restricted` Trace 保存，保留备份但不得直接输出到页面或普通日志。没有充分新释放证明时仍保留相交资源保护；不得用删除 claim 或重跑原工具来清除错误。

Unix socket 路径以 UTF-8 字节计数，macOS 最多 103 字节、Linux 最多 107 字节（不含终止 NUL）。启动在绑定前拒绝超长路径；应选择更短的独立 state root，不能依靠系统截断后的文件名或手工改 socket 名称继续运行。

| 症状 | 安全诊断 | 停止或有界修复 |
| --- | --- | --- |
| `ADMIN_ARGUMENT_INVALID` | 只读核对入口参数、绝对 config 路径和命令版本 | 停止并修正参数；不把错误输出当作服务 ready |
| `STATE_ROOT_PATH_UNSAFE` 或权限错误 | 回读规范绝对路径、owner/mode、authority file 和 runtime 目录 | 停止；人工修复已授权目录权限后重新 preflight，不递归清理未知目录 |
| `SQLITE_STATE_ROOT_LOCKED` | 只读检查 lock owner、PID、token、socket 和进程存活 | 保留活锁；确认 owner 已死亡且符合回收规则后再从完整 preflight 重试 |
| Worker UDS handshake/authentication failure | 核对 Worker/Agent 配置、boot token reference、deployment epoch/fence 和 socket owner | 停止 Agent；先修复同一运行 Worker，再重新启动，不降级为进程内执行 |
| `SERVICE_AUTHORITY_MISMATCH` 或 schema error | 对比 authority.json、SQLite deployment、config 和 bundled migration ledger | 停止；选择匹配的 prefix/state root 或走独立迁移/恢复决策，不手工改 authority |
| forced stop 后无法恢复 | 保留 lock/socket/SQLite 现场，运行只读 doctor、db status 和进程检查 | 若正式 recovery 未证明安全则停止，转入 backup/restore 或 incident diagnosis 的独立 Runbook |
| 需要 systemd/launchd 或 Hermes 操作 | 仅确认当前 Runbook scope 不包含服务管理器和远端部署 | 停止；选择经过验证且已授权的对应 Runbook，不猜测命令 |

### v2 原环境核查约束（2026-09-09）

恢复必须保留既有受保护 Run trace 中的控制引用、终态证据及其 Payload；不得仅备份 SQLite 中的 PID。当前 Agent 权威通过原环境认证控制端口 inspect/stop，或读取原 Job Host 的签名终态；身份、目录 inode、策略或宿主变化时继续隔离，不能在目标主机按旧 PID 停止或重启。Agent 仅加载不含 SRT 启动能力的控制客户端。

Linux 前台清理证据要求原 PID namespace init 已消失及完整终态；Mac 已启动任务没有全树保证时继续 unknown。端口失联、证据不完整和超时均不能解除相交占用。真实假数据探针不签发安装资格；不得把测试临时 bubblewrap/socat 的 PATH 配置用于生产，生产依赖位置须单独验证。实际安装、备份恢复和跨主机迁移的既有步骤及审批边界保持适用。

### 资源输出分页保留

v2 已保存输出的分页引用和 cursor 归原 Run 的受保护 artifact；同机恢复须一同保留对应加密 Payload、artifact 关联及原作业账本。游标只定位原调用/资源的固定输出快照，不能改写为宿主路径，也不能用来重新执行任务。原输出缺失或摘要不符时拒绝，不能以空文件代替；权威迁移仍按原回执和当前身份拒绝旧 Worker 输出权限。R6 追加了后台运行输出片段、结束标记和命令退出事实，均归原 Run；恢复时须同时保留这些 artifact，不补造丢失片段、不重启原命令。后台/服务的目标安装资格仍须独立验证。

### 受管理后台资源的安装与恢复

后台 Bash 继续使用安装的 Pi runner 和固定工具链；其运行模式由 Worker 从匹配的操作声明传入，不能从模型参数选择。前台 Bash 保留原结果格式；后台输出只在完整行检查后追加，末尾无换行内容在退出时检查，机器秘密命中即停止并拒绝输出。start 回执只表示资源已启动，命令退出码另存入连续输出的结束事实。资源句柄与管理调用不能重复消费 Grant。

服务仅在安装声明含匹配的 `readinessProbes` 且具备该模式资格时启用。本批探针使用私有目录内唯一 Unix socket 的 HTTP GET、预期 2xx 状态和最多 30 秒期限；不开放通用本地 TCP 或其他 Unix socket，不以日志判断就绪。恢复后的声明、运行文件与资格必须重新匹配；不得凭旧 ready 回执连接新服务。

Run 正常完成前停止其后台资源；SQLite 完成事务拒绝仍有未释放资源的 Run。未知清理进入原核查流程并保留写目录占用。Mac 测试主进程退出仍不证明任意后代已全部退出，不能清除隔离以获得正常完成。这里没有新增迁移文件、安装资格签发或运行中数据库修改步骤。


## 内置账号初始化与恢复

此流程属于已配置活动主机上的停机管理操作，不建立新的 deployment authority，不自动启用公网入口，不向模型发送数据。账号与配置合同见 [SOURCE: docs/archive/specs/2026-09-10-built-in-account-authentication-design.md]、[SOURCE: docs/adr/0027-built-in-owner-authentication.md]。

1. 使用已安装构建并完成本 Runbook 的 Live-State Preflight。核对 `identity.kind` 为 `built-in`、配置中的唯一 Owner/Agent/deployment 与 `authority.json` 及数据库活动权威一致，服务已停止，数据库已按正常迁移流程升级到当前 schema。确认保存密码输入与验证器设置资料的目录归当前用户所有、权限为 0700；所有操作只针对选定 state root。
2. 在该受保护目录准备 `account-input.json`（0600），只包含 `username` 与 `password`。用户名为 3–64 位字母、数字、点、下划线或连字符，首位为字母或数字；会统一为小写。密码为 12–128 个字符，不作为命令行参数、环境变量或诊断输出。目标设置文件必须尚不存在。
3. 首次创建命令为 `himawari account create --config <绝对配置路径> --input <绝对输入文件路径> --output <新的绝对设置文件路径>`。macOS 默认从与服务相同的钥匙串 Payload source 解析配置的加密密钥；其他平台或文件 source 使用 `--secret-dir <受保护密钥目录>`。命令使用 state-root 独占锁并验证活动权威，不通过公网提供初始化入口。
4. 输出的设置文件为 0600，包含用户名、验证器 `otpUri` 与 10 条一次性恢复码。验证器按 `otpUri` 中的 secret 设置 TOTP（SHA1、6 位、30 秒）；妥善保存恢复码。终端结果只报告设置文件路径和是否撤销旧会话。输入/设置资料按 Owner 的秘密保存策略保管，不进入 Git、普通备份日志、浏览器 localStorage 或模型上下文。
5. 启动 Worker 与 Agent 后，从配置的同源地址打开控制中心。输入用户名/密码，再输入验证码或恢复码；只有第二步成功才建立产品会话。HTTPS Cookie 使用 Secure；明确配置的 loopback HTTP 仍执行同样的认证。跨设备通过 HTTPS 反向代理访问，listener 仍绑定 loopback，不用放宽 Host/Origin 来解决代理配置错误。

   同一个验证器时间步只能成功认证一次；连续在多台设备登录或再次验证时，须等待下一组验证码，或使用尚未消费的恢复码。登录和第二因素共用每 5 分钟 20 次的账号尝试预算；触发限流时按页面提示等待。

6. 从“会话与设备”验证设备列表、再次验证、撤销与退出登录。需要近期验证的敏感操作应在完成验证后由用户重新提交；不得自动重放审批。会话失效后，普通请求和流式继续披露都被拒绝，前端清除已认证视图。
7. 丢失验证器时可在密码步骤后使用未使用过的恢复码。丢失密码或所有第二因素时，停止服务并准备新的受保护输入/设置文件，执行 `himawari account recover ... --confirm RECOVER_ACCOUNT_<配置中的 Owner ID>`。恢复要求原账号已存在，重置密码和第二因素，撤销全部旧会话、设备与未完成验证请求并写入审计。外部 Owner 绑定不能通过这个命令被静默替换。

失败处理：配置、目录权限、活动权威、独占锁、加密 Payload 或第二因素失败时停止本操作。已有账号不会被 create 覆盖，设置文件不会被覆盖；创建失败留下的私密设置文件不能作为账号成功证据，应以账号记录、命令结果与后续真实登录核对。数据库升级失败按前述迁移/恢复点流程处理，不直接回写旧 schema。账号恢复属于不可撤销的凭据轮换；回退代码前保留当前 state root 和已验证恢复点，旧版本不能使用更新后的凭据或忽略较新的 schema。

验证来源：账号命令使用真实 SQLite 与受保护文件源的自动化检查、真实密码/TOTP/恢复码/会话事务集成检查，以及浏览器认证流程。受控服务不执行模型或 Worker，不能代替实际平台资格或原控制中心端到端验收。

生成模型可选 `reasoningRequired` 能力需与 `reasoning` 一致；原配置省略时保持原语义。真实审批目标展示允许有界路径文本，不改变身份、Grant 或审批决定合同。

恢复审批须读取已有冻结请求，不能用新时间重写同一持久化 key。验收核对 Pi 工具真实失败标记、审批等待扣除和文件回读；是否要求近期认证以实际审批合同为准，不以“工具”一概判断。


同次进程观察现在携带 Agent 在该次核验中产生的证据，保存时不重复扫描安装字节；外部 Worker 事实仍独立核验，序号、身份、有效期及事务检查保留。注册控制入口统一核对当前 Scope、Grant 和安装；终态工具仍保存结果并完成原清理核验。此调整不改变停机、恢复、迁移或重新授权步骤，不使旧进程证据恢复执行权限。

### Schema 35 持久排队与文件发布证据

Schema 35 新增 `sandbox_admission_queue`。备份应同时保留队列次序、冻结请求、调用回执、Handle 和额度预约；恢复不能把已准入请求重新派发。等待中的请求没有文件占用，也没有消费回执；取消、期限届满或授权失效后不能取得资源。当前版本允许工具对象重建后在完整执行身份不变时继续原队列：保留原目标、回执编号、期限与次序，准入事务再次核对冻结请求并只承诺一个回执。跨 Agent/Worker boot 或产品 authority fence 变化后的执行权重新绑定及后台自动续接仍未实现；恢复时不能通过删除队列或更换调用身份绕过原次序。

受控文件发布先完成并同步暂存内容，再发布最终路径。已保存的文件操作记录可包含暂存 inode 证据；恢复只核查最终文件身份与内容，并清除属于该操作的暂存硬链接，不重复写入。仅内容相同不足以证明是本操作产生的效果。文件候选位于原授权目录的 `.himawari-recovery/`；它不属于产品数据库备份包，不能据数据库恢复宣称候选内容或目标文件已恢复。

Schema 35 也是旧 writer 的版本屏障：Schema 34 或更旧代码不理解持久公平队列及文件发布归属，禁止并行写入新库。回退须停止服务并恢复匹配旧版本的完整恢复点，不能只删除新表或降版本号。当前文件原语已有本地 macOS 回归证据；跨 Worker 的细粒度文件占用、Linux 文件系统资格和部署升级仍须独立验证。

### Schema 36 固定文件目标合同

Schema 36 不重写旧记录；它为新增 JSON 字段建立 writer 版本屏障。`pi-coding-tool` 合同 2 在受保护 Scope 中保存 `sandbox-file-target.v1`：相对路径、授权根以下的已存在父目录身份，以及原文件 inode 和内容摘要。目标不存在与父目录尚未创建分别记录；父目录缺失时继续协调整个授权目录，不伪称已有精确父目录身份。备份必须保留原 Scope Payload、其摘要和对应 claim，不能恢复时按最新文件内容重建原基线。

合同 1 继续使用目录级协调。合同 2 仅用于固定目标 read/write/edit；新 Worker 在启动 Job Host 前拒绝缺少文件快照的新合同，旧 Worker 会拒绝未知合同版本。它仍复用原 Job Host、SRT 与 Pi Operations；不能仅在登记数据里把版本改成 2 就视为安装资格通过。新安装的实际字节、冻结快照和目标主机资格必须匹配后才可采用新合同。

恢复不能把目标版本冲突改写为允许覆盖。文件型 claim 同时保留父目录名称槽位和当前文件身份，原子替换后名称槽位仍冲突；硬链接、符号链接和跨设备目标被拒绝。名称保守归一化可能在区分大小写的文件系统上多排队，不能据此宣称所有别名场景的并行资格已通过。默认核验读取仍要求当前路径不变；固定文件读取可读完已经打开的完整旧版本，不能推广成任意原地写入都可并行。回退仍要求停止服务并恢复匹配旧版本的完整恢复点。

### 固定文件合同 3：先准备候选，再取得提交占用

`pi-coding-tool@3` 仅用于固定 `write/edit`；该合同沿用 Schema 41 的保存结构，当前整体数据库已由资源恢复调度迁移推进至 Schema 43。准入前以 Pi Operations 的不可变快照准备完整候选，受控暂存区保存候选内容及工具结果；其 inode、摘要与原文件版本绑定到已有受保护 Scope artifact。此阶段没有调用消费回执或工作区占用，正式目标及缺失父目录保持不变。提交仍复用原持久队列、Worker、发布记录和原宿主释放证明；不能因候选已准备就提前派发或宣布保存成功。细节见[本批实施与验证范围](../execution/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#implementation-record)。

备份、迁移与恢复须一起保留 Scope Payload、排队身份及工作区 `.himawari-recovery/` 中的候选与结果；数据库备份不包含这些暂存文件。候选本身可能是唯一结果，不自动清理、不按当前文件重建旧基线、不覆盖后续编辑。准备后取消或版本冲突不授权重放；跨 boot/fence 的自动重新绑定仍未实现。旧程序不理解合同 3 或新增 Scope 字段时必须停止对应执行，不删字段降级，也不能仅凭 Schema 相同认定回退兼容。

准备计算的线程入口必须随安装包交付；线程采用请求的时间预算、V8 堆上限和 Stop 信号，V8 堆上限不代表 OS 总内存资格。停止只在线程终止后返回，不能把主调用返回当作线程已停止。

确定尚未派发的固定写入版本冲突返回 `FILE_VERSION_CONFLICT`，原调用重放只返回已知未执行事实。Pi 现有循环中的新调用携带受保护历史关联，宿主必须用原请求、未派发诊断及结果记录复核；关联不授予权限，新内容仍经原 ActionPolicy，确切单次批准不能扩大。备份需保留 `runtime-file-read:*:conflict-lineage` 与原工具诊断/结果 Payload。循环的受保护进度状态新增冲突计数；同一 Run 连续工作中累计四次版本冲突后停止继续调用工具并进入原有结果说明路径，读取或更换内容不清零。不能用忽略该计数或关联的旧运行时恢复此类 continuation。Worker 已派发后失败、结果未知和跨 boot 自动重绑定仍不得冒充可自动重试。

新合同尚无生产切换或 Linux 资格。采用前须对实际安装字节、最终运行身份和目标文件系统完成资格并明确选择合同 3；旧合同 1/2 的行为保留，普通源码升级不自动改部署绑定。本节不授权启用模型、付费调用、生产迁移或部署。

### Schema 37 固定文件发布恢复

Schema 37 为原调用的恢复结果建立 writer 屏障。恢复结果保存在受保护的 `pi-file-recovery:<invocationId>` Trace artifact 中，与原 Worker 输出分开；不覆盖原输出，也不创建第二个调用回执。旧 writer 不理解该来源，不得直接写入新库。

固定文件合同 2 的受信 runner 在保存前将 Scope、输入摘要、候选 inode、完整父目录身份和内容摘要写入本次私有 Job 目录；保存后等待核验记录落盘，再返回结果。记录失败阻止发布，发布后的记录失败则保留候选身份用于核实。私有记录不含候选正文。它们与授权目录内 `.himawari-recovery/` 的候选一起属于现场恢复证据，单独的产品数据库备份不包含这些文件；恢复数据库不能被报告成同时恢复了工作区与私有 Job 目录。

Agent 只有在原 journal 已接纳永久释放记录且没有新保护时才核实文件。已保存的核验记录作为历史事实保留；缺少最终核验记录时，必须匹配原候选 inode、内容及发布时父目录。核实可清除该次发布留下的私有硬链接别名，不能重新发布候选、修改用户后续编辑或启动旧工具。仅内容相同或目标名称相同不足以证明本次保存成功。

结果交接还须核对原请求的分类、当前披露权限、恢复 artifact 与受保护交接回执。该实现当前处理固定 write/edit 的缺失或 unknown 结果；已保存的错误结果保持不变。真实 Job Host 释放、跨 Worker 与 Linux 平台资格须单独验证；本地受控进程证据的集成测试不能代替这些资格。回退仍须停止新 writer 并使用匹配版本的完整恢复点，不删除恢复事实来允许旧程序接管。

### 工具执行前检查点与恢复引用

生产装配在进入产品工具前，复用现有 Pi 批次格式和加密 Payload 保存检查点。执行 intent 中的 `tool-batch-recovery.v1` 引用绑定原模型工具调用，内部文件阶段共同指向该父调用；备份、恢复及迁移须一同保留这些关联。保存失败的工具没有进入执行，页面归为“尚未派发”；旧记录缺少检查点时不能补造。引用本身不授权跨 boot/fence 重放，也未启用 Run 自动恢复。本批没有新 migration，不改变本 Runbook 的现场操作授权要求。


### Schema 38 纯联网范围

Schema 38 为 `sandbox-scope.v2` 和 `network_only` 合同建立 writer 屏障；这类前台 Job 使用自己的私有临时目录，不保存目录 Grant，也没有共享文件 claim。备份和恢复仍须保留原网络授权、Handle、调用回执、Scope Payload、私有环境和资源释放证据。空 claim 只说明没有用户文件占用，不能据此认定进程已结束或重发原操作；网络外部效果仍按命令退出事实记录，不宣称无副作用。

公开搜索新增显式 `runPolicy.publicSearch.scopeSource: private_temp` 路由，不能同时配置 `grantId`；安装清单须使用相匹配的 `private_temp` / `network_only` 操作合同，纯联网清单可不含用户目录根。旧目录型路由和合同保持原权限语义，升级不会自动切换部署配置。配置或模型绑定变化会使原搜索委托失效，需按现有入口重新授权；保存搜索结果是另一次获准文件操作。

验证分别检查无目录 Grant 的搜索准入、零共享文件占用、原网络授权撤销、私有工作目录及真实沙箱越界拒绝。Schema 37 或更旧 writer/Worker 不得处理新合同；回退须停机并恢复与旧版本匹配的完整恢复点，不能删 migration ledger 降级。本批源码和受控测试不构成部署授权，也不替代目标平台与实际安装资格。

### Schema 39 自动审查记录

Schema 39 新增 `automatic_action_reviews`，在模型调用前保留唯一请求身份，完成时与原审批及一次性 Grant 同事务写入。备份和恢复须保留审查记录、Owner 委托版本、原请求摘要、受保护输入/输出 Payload、审批来源和原模型费用记录。`pending` 只表示没有已提交决定，不能推断模型未调用，更不能删除该记录后重试付费调用。已完成记录读回历史决定，不重新派发工具。

自动审查默认未装配。当前委托只接受精确请求摘要，批准不能扩成其他文件、命令或长期授权；写入时使用 writer 当前时间，重新核验请求期限、委托版本和 Run 执行租约。已有人工请求或决定优先，撤销、取消、过期及执行权变化阻止迟到批准。审查等待不创建共享文件占用；自动批准保存 `automaticReview` 来源，不能解释为用户对本次操作点击了确认。

恢复不会自动续跑未完成审查，也不会启用模型。当前真实模型接入、披露和费用配置仍须按实施 Plan 单独完成；受控模型替身与 SQLite 回归不代表真实服务验收。Schema 38 或更旧 writer 不得写入新库，回退不得删表或修改账本以绕过版本屏障，也不得覆盖升级后新增的决定和消息。

模型审查适配器复用现有受信模型入口和预算账本，生产配置仍未装配。取消信号在调用开始前释放预约；开始后缺少完整用量时保存 `cancel_unresolved`，不能按零费用处理；完整用量已经到达则仍按原价格快照结算。恢复时须保留这些费用事实，不能把没有批准等同于没有模型费用。Pi 的 Stop 信号已传入生产文件/编码授权入口；取消审查等待不新建人工确认，超时则保留人工路径。当前验证使用受控模型流、真实 Pi 会话与 SQLite；真实模型启用和页面联合验收尚未完成。信号已取消不能替代 Worker 进程及后代已停止的现场证据。

自动审查开始和决定现在与审查记录同事务写入现有 Run 执行事件，并通过既有 Thread 通知提供页面读回。备份须保留两者；事件缺失不能从模型正文补造用户确认或执行效果。请求 Thread 必须与 Run 归属一致；重复决定不重复产生步骤。页面的审查耗时只取已保存的开始与决定时间，缺少任一边界时不推算；自动允许不代表用户点击确认。此路径已有真实 SQLite 与隔离 HTTP 夹具下的 Chrome 回归，真实模型和 Worker 联合验收仍未完成。

取消 Run 先保存取消决定，再独立请求运行时、原 Worker 和资源管理器停止；一处报错或等待不阻止其他停止请求发出。清理错误汇总返回，不能将 Run 的 `cancelled` 状态当作进程已结束。对已取消或失败的 Run 再次停止时，只重试仍活跃的运行时/Worker 并重新核对资源，不重启模型或工具。执行权中断也保留资源停止端口的同步异常，不能漏掉清理失败。当前回归采用受控运行时/Worker 与真实协调器，平台进程树清理仍须独立核验。

清理端口的调用方等待现在有独立的 30 秒上限，取消、执行权中断及运行时完成均适用；这不是资源释放证明，也不替代平台停止宽限和按错误类别的恢复政策。运行时已生成输出但清理拒绝或超时，保留输出与受保护原因，Run 进入 `reconciling_external_result`；恢复不得重新执行模型或工具。取消、失败状态与仍需清理的资源分别核对，迟到成功不能直接覆盖原未知状态。备份和权威迁移须一并保留该检查点、清理事件及原资源证据。

同一 Run 有多个资源时，停止入口会继续枚举后续页并独立请求各资源停止，最后汇总清理结论。一条资源等待或报错不阻止其他资源收到停止；只有每条资源均有永久释放回执且无残留保护时，整体才报告已释放。
