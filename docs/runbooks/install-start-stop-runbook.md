---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:53809fcae50b95b3ae424a07d7b78548c035dbea21f23ea9a176ed0ea693db0a"
supersedes: ""
superseded_by: ""
date: "2026-08-27"
---

# 本地 Node runtime 安装、启停与诊断 Runbook

当前开发测试遵循 [ADR 0049](../adr/0049-first-production-host-acceptance-exception.md#storage)：在 Hermes 上的任务自有目录运行，临时安装和状态放在每次运行用 `mktemp -d /tmp/hXXXX` 新建的 10 字节独占 0700 目录（路径必须短，否则产品的 Unix 套接字路径会超出上限）；不在云服务器 `84.247.157.41` 和 Mac 上测试，不操作生产目录或系统服务。[SOURCE: docs/adr/0049-first-production-host-acceptance-exception.md]

G51只允许本次首次生产安装必要的[限定主机能力验收](../adr/0049-first-production-host-acceptance-exception.md#first-install-acceptance)。具体流程先在Hermes验证，再以固定版本、摘要、普通账号、虚构工作区、自有进程、资源上限、证据和失败处理清单取得云执行授权。本文不提供云端资格签发命令；静态检查或规则例外不能代替具体安装、签署、验收和服务启动授权。普通测试和构建仍只在Hermes。

## 阅读导航

- [安装和启动前提](#safety-and-preconditions)
- [Ubuntu 24.04 的 bwrap 前提](#ubuntu-2404-bwrap)
- [归档解包与临时磁盘](#artifact-extraction-contract)
- [目标现场只读检查](#live-state-preflight)
- [安装与启停步骤](#procedure)
- [结果验证](#verification)
- [证据保存](#evidence)
- [安装权限验收证据](#installation-permission-evidence)
- [回退](#rollback)
- [停止条件](#stop-conditions)

<!-- runbook-contract:
- docs/execution/specs/2026-09-24-isolated-tool-execution-design.md
- packages/platform-node/src/capabilities/capability-deployment.ts
- packages/platform-node/src/capabilities/isolation.ts
- packages/platform-node/src/process-output.ts
- packages/persistence-sqlite/src/sqlite-sandbox-reservation-release.ts
- packages/persistence-sqlite/src/sqlite-sandbox-reservation-never-started.ts
- docs/execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md
- docs/execution/specs/2026-10-04-sandbox-preparation-launch-arbitration-design.md
- packages/runtime-sandbox/src/job-host-launch-decision.ts
- docs/execution/specs/2026-09-29-sandbox-deadline-settlement-design.md
- scripts/operations/hermes-ui-session-start.mjs
- apps/agent-service/src/production-sandbox-lost-result-recovery.ts
- apps/agent-service/src/production-sandbox-stream-result-recovery.ts
- apps/agent-service/src/production-tool-result-recovery.ts
- packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts
- apps/agent-service/src/production-copy-save.ts
- apps/execution-worker/src/production-task-environment-backend.ts
- packages/platform-node/src/files/workspace-copy-publication.ts
- packages/platform-node/src/files/pi-file-publication.ts
- apps/agent-service/src/production-workspace-copies.ts
- packages/platform-node/src/candidate-workspace/qualified-candidate-workspace.ts
- packages/persistence-sqlite/src/migrations/0046_directory_move_contract.sql
- packages/persistence-sqlite/src/migrations/0047_workspace_copy_contract.sql
- packages/persistence-sqlite/src/migrations/0049_thread_title_budget.sql
- packages/persistence-sqlite/src/sqlite-execution-environment-operations.ts
- packages/application/src/services/workspace-copy-service.ts
- packages/application/src/services/workspace-claims.ts
- packages/platform-node/src/capabilities/directory-move-scope.ts
- packages/platform-node/src/files/directory-move.ts
- packages/platform-node/src/files/rename-native.c
- packages/application/src/ports/intelligence.ts
- packages/persistence-sqlite/src/sqlite-run-resource-guard.ts
- packages/application/src/ports/run-lifecycle.ts
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
- packages/runtime-pi/src/pi-file-preparation-pool.ts
- packages/runtime-pi/src/index.ts
- packages/persistence-sqlite/src/migrations/0037_fixed_file_recovery_artifacts.sql
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
- packages/application/src/services/thread-execution-state.ts
- packages/application/src/services/thread-execution-resources.ts
- packages/application/src/services/sandbox-scope-service.ts
- packages/gateway-contracts/src/thread-contracts-v3.ts
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
- packages/runtime-sandbox/src/machine-boot.ts
- packages/persistence-sqlite/src/sqlite-sandbox-unconfirmed-purge.ts
- packages/persistence-sqlite/src/sqlite-run-diagnostics.ts
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
- docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md
- scripts/ci/contracts.mjs
- scripts/ci/context.mjs
- scripts/ci/check-policy.mjs
- scripts/ci/test-concurrency.mjs
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
- packages/application/src/ports/capabilities.ts
- packages/application/src/services/execution-worker-service.ts
- packages/platform-node/src/capabilities/node-capability-runtime.ts
- apps/agent-service/src/production-payload-broker-handler.ts
- packages/persistence-sqlite/src/sqlite-sandbox-authority-withdrawal.ts
- apps/agent-service/src/production-run-dispatcher.ts
-->

## Scope

2026-09-11 聊天运行体验更新：可撤销的联网搜索设置保存在既有 Product State，关联审批记录通过 `policyAuthorization` 标明真实授权来源，不新增迁移文件。备份/迁移须共同保留设置 revision、派生 Grant 与审计；关闭设置后，旧 Grant 的消费和 Sandbox 准入被拒绝。恢复后核对设置与当前固定 Exa 路径、主机/目录路由和模型披露身份一致，配置绑定不同不能沿用开启状态。它不授予其他文件、命令或网络权限。Pi 更新合并仅影响尚未持久化的连续累计片段，不能删除已持久化记录或工具边界。`runPolicy.timeZone` 是显式 IANA 时区，只用于新 Run 的时间上下文；历史已冻结内容保持原值。

未配置受保护安装时，每个进程首次使用某个期望摘要会在独立工作线程完整读取 runtime 字节，同时记录全部目录与文件的元数据指纹；此后每次调用在同一工作线程只复核元数据（设备号、inode、权限、所有者、大小、修改时间和纳秒级 `ctime`），任何差异都丢弃指纹并重新完整审计，见 [SOURCE: docs/adr/0034-runtime-verification-by-inode-metadata.md]。安装必须包含编译后的 `sandbox-runtime-digest-worker.js`。ADR 0034 沿用 ADR 0028 的受保护 Linux 路径：已经独立验证权限的安装，在相同进程、相同 root 保护版本身份下复用首次完整审计；每次仍验证当前进程和保护记录，失效立即拒绝，不接受普通时间缓存。保护记录不属于备份或迁移数据，目标主机必须重新建立身份、权限与安装资格，不能复制源主机记录作为证据。此变化不改变数据格式、迁移权威或停止条件。参见 [SOURCE: docs/adr/0028-protected-runtime-installation.md] 和 [SOURCE: docs/runbooks/hermes-control-center-upgrade-runbook.md]；本 Runbook 原有操作范围保持不变。

本次 Web 重构追加 schema 30：`runs.model_selection_json` 保存用户提交时选择的模型引用和思考深度。备份、恢复和迁移必须保留此列及原 Trace/Payload；恢复不能用当前输入框的选择改写旧 Run，也不能给旧记录补造选择。目标配置仍须支持原模型、深度、预算与披露，缺失时报告失败而不是静默替换。浏览器的主题、主题色和未发送草稿属于客户端偏好，不随服务数据库恢复。

控制中心查询执行过程时仅返回经过归属校验和字段筛选的展示投影；恢复检查应核对多轮历史、模型选择与审批等待，不直接开放原始 Trace JSON。取消仍经过 RunCoordinator。上述展示投影已由受控 SQLite/Pi 适配与浏览器测试验证。2026-09-11 Hermes 同机升级、迁移前快照与真实服务重启由专用 Hermes Runbook 和验收记录约束；未执行跨主机权威迁移或从备份完整恢复服务。

schema 28 在原数据库追加 v2 资源关联、独立操作/资源观察、目录占用和派发回执。升级既有库仍须先取得已验证快照；0020/0027 不改写。恢复/迁移时必须保留占用和未确认派发；旧未结束作业缺少可信目录链时按主机保守阻止新准入，缺少主机身份时阻止所有主机的新准入。禁止通过删除 Run、清空占用或把旧记录改成 v2 来恢复执行。已确认清理的旧历史结果保持原解释，不由迁移补写新资格。

这些 SQLite 机制已有独立测试数据库的升级、重开和事务验证；本次未升级运行中的 state root，也未执行真实安装、恢复或跨主机迁移。正式组合已具备显式 v2 foreground 固定读取/命令路径、目录身份和证据读取，Pi 七工具前台 runner 已有假数据验收，目标安装资格仍须独立验证。恢复后继续适用当前主机/目录/权威检查，不能自动重放旧任务或未确认派发。

SRT 的 Agent Service 和 Worker 启动组合已连接现有准入、目录授权状态、受保护 scope、认证 Payload 通道与作业监督器；scope 来源已支持文件 inspect/read 工作流及已批准 Grant targets 的通用工具范围；七工具前台 runner 及后台执行已有专用假数据验收，目标安装资格仍须独立完成。网络范围须来自本次操作同一 Grant 的审批快照确切小写 hostname:port 目标，并与主机能力上界核对；不新增授权或再次消费 Grant。准入及启动前验证授权、父调用和真实 host/runtime/runner/qualification。缺少可信来源时拒绝。策略只由 Worker 编译，初始观察可无摘要，首次原子启动固定摘要后不可替换。

R8 增加 Job Host 私有认证上游，初始化时强制 SRT 两种代理协议通过上游并禁用 bypass；解析后的非公网地址被拒绝。旧裸域名绑定与审批快照不可自动补端口，须由现有授权流程取得有效的明确端口目标。Worker 对所有 mode 每轮监督都重查原授权，失败后请求 Job Host 关闭；关闭出口会终止连接，不等于撤回已经外发的数据或未知后代的文件权限。监督间隔为 250 ms，但 RPC 和调度会增加实际停止延迟。Job Host 还在 DNS 解析前、拨号前通过原认证 Worker IPC 逐次核对 Agent 当前 scope，已有连接按 250 ms 周期重查；每次回复只供原检查使用，1500 ms 未答、撤销、断开或身份变化均拒绝并关闭出口。Worker 与 Job Host 必须来自匹配安装产物，不能用旧组件缺少核验回调作为继续联网的理由；TLS 内部请求不可见，周期核验不构成每个加密请求的原子授权。Node 客户端使用 SRT 生成并规范为数字回环地址的代理 URL，不需要为解析 localhost 开放额外 DNS 服务。联网工具仍须在主机 inventory 中声明其必要的只读系统工具链/证书文件，并验证下载、安装和重定向。出口测试计数不是生产签名资格；不得手工把测试证据复制到部署 qualification。

只读网络重试只在原调用仍运行时发生：声明零费用的 GET 与固定公开 `web_search_exa` 查询，对明确暂时错误最多重试一次；默认退避 250 ms，有有效 Retry-After 时至少等待该值，原期限不足则停止。GET 决定重试时用单调时钟记下最早发送时刻；等待提前返回时补等剩余时间，每次补等仍受原中止信号和原总期限约束，不为重试增加时间预算。GET 每次重查当前授权和秘密句柄，搜索在重试前建立新代理连接以重新触发出口检查，并沿用原 MCP 请求期限；任意写入、未知非幂等结果和有费用的 endpoint 不自动重发。重启、备份恢复或权威迁移不会恢复重试计数或重新执行历史工具；此策略没有新增恢复表、迁移或部署开关。

安装产物源码新增了 R1 的 v2 合同、类型端口和纯判断函数，以及 R2 的 SQLite 账本，正式组合按安装声明分别使用 v1 与 v2 foreground；声明不能代替目标平台资格。新增 `SandboxExecutionPortV2` 导出不代表 Job Host 取得新监督资格，也不会把旧 unknown 回执转换为已清理。后续接入 v2 正式适配器时，须重新核对本 Runbook 的迁移、恢复和安装验证。

v2 broker 与 Worker foreground 已接入准备、登记、唯一绑定、观察和限定核查，并有真实 Mac UDS/SQLite/Worker 假数据验收；R6 已增加显式 background/service 路径，只有 Worker、安装声明与资格共同支持时才可准入。安装清单/资格中的 `supportedExecutions` 仅表示显式兼容声明，不提供授权、监管证明或 v2 启用开关；缺少声明不能推断支持 v2，显式排除 v1 的声明也不能通过旧路径运行。追加 migration 0029 已修正准备顺序：先保存不含运行摘要的执行预留及目录占用，Worker 准备后首次 CAS 固定真实绑定；旧记录保持 `legacy_bound`。迁移仍须通过现有同机备份和停机入口，不能直接对正在运行的产品库执行 SQL。R3 范围/控制接口验收已完成，Pi 工具 runner 已完成专用假数据验收，安装资格仍待完成，不得用占位摘要或把 v2 数据标为 v1 进行安装验收。Job Host 私有 IPC 增加会话/boot/序号/监督窗口，但 PID、心跳、主进程退出及 reset 仍不构成任务树释放证明；真实长临时路径探针在 SRT 初始化出现过 `EADDRINUSE`，安装资格还须验证所选 privateRoot 的实际可用性。能力安装声明加载时按平台检查实际启用的 SRT 和 Job Host 套接字预算：Linux 的 SOCKS 桥最紧，根目录最多 27 个 UTF-8 字节；Mac 不创建该桥，按 mux 套接字、5 位 PID 和固定序号 `0` 核算，最多 37 个字节；当前每个 Job Host 都是新进程，第二次 prepare 被拒绝，SRT 只初始化一次。产品的上游 `parentProxy` 不会关闭本地 mux，TLS 终止与 SRT 日志监视未启用；控制套接字的 100 字节预算更宽。如 `/var/lib/himawari/jobs` 为 22 字节，符合 Linux 预算。超长声明以 `CAPABILITY_DEPLOYMENT_INVALID_VALUE` 拒绝，报告实际字节数、上限及决定预算的套接字。选择短路径后须重新计算声明摘要，不能仅改摘要或略过资格。各组成部分见[按平台核算套接字预算](../backlog/BL-20261002-002-生-产-privateroot-超-过-27-字-节.md#socket-budget)；Mac 依据来自 SRT 0.0.75 源码，未在 Mac 上验证。

schema 27 的作业账本继续作为持久依据；不能给无账本的旧凭证补建可启动作业，不能自动重放清理未知作业。旧作业读回、清理和重复观察不恢复执行权限。Job Host 接收至多 48 KiB 的私有 IPC 输入，仅送入任务 stdin；正文不进入 argv 或环境变量。stdout 保留原 runner 合同并保存为受保护 Payload；CPU/RSS 观察随作业观察持久保存。固定有界进程采样超限或失败时请求停止，采样不能证明硬配额、所有短命后代都被计入或整个进程树已退出。

Agent 启动在开放准入前还会使用当前权威失效 v2 旧监督观察，保留已知结果、效果和目录占用；此恢复没有启动能力，不按旧 PID 接管进程。Job Host 双向心跳超时会请求停止，过期 IPC 消息不能续期。任务退出后的异步 SRT reset 和控制终态写入期间，宿主继续发送真实心跳，直到清理结束；正常清理耗时不再因提前停发心跳被误判失联。心跳仅证明连接仍在工作，不证明资源已释放；原清理强制退出期限不变。Worker 卡住、重启记录转为 lost/unknown 的测试通过不表示残留风险已消除；解除占用仍需独立可信清理证据。

真实 Mac 假数据组合探针已验证实际 scope/UDS/SQLite/Worker/Job Host、保护规则、资源记录及隔离后不重放，但使用的是受控测试资格和已准备的测试调用；它不是正式主机资格签发，也没有验证真实模型/HITL 或实际进程崩溃后的安装恢复。正式安装与恢复验收仍待完成。启动时的旧作业核查、清理未知隔离，以及关闭时先保存观察再断开通道的顺序继续适用。安装、备份和权威迁移流程不因组件接入而改变，恢复的旧 Capability 记录不能充当新 SRT profile 的资格。

本 Runbook 只覆盖当前仓库已经验证的本地 Node runtime：从锁定依赖构建可重定位 artifact，安装到明确的绝对前缀，使用受保护的 Execution Worker UDS 启动 Agent Service，执行只读 doctor/db status，并以有界信号完成正常停止或故障重启。它不负责安装 systemd/launchd unit、不修改公网入口、不切换 authority、不配置真实 provider、不部署到 Hermes，也不替代 authority transfer Runbook。

公开服务主入口已连接 HTTP、持久 Run、Pi、已授权 Worker 工具和 Mem0。缺少 `runPolicy`、HTTP、身份配置或实际模型配置时，仍以 `SERVICE_PUBLIC_MODE_INCOMPLETE` 拒绝启动。启用前必须验证同一安装候选的完整请求、持久结果和重启回读；库导入成功或 `service.ready` 不能替代这些证据，也不能替代实际目标环境资格。

文件读取工具已复用 Pi `read` 定义，无 Handle 调用表示读取意图。正式组合已提供 inspect/read 两阶段工作流，持久保存调用 context、阶段输入和 Handle，并通过 Worker 派发；读取与模型披露分别检查授权。缺少有效路由或目录授权时拒绝执行，需要审批时保存等待状态。安装及服务启动成功仍不能证明实际 Mac 文件读取可用，须完成目标 Worker 隔离资格及全流程验收。Agent Service 不执行 Pi 默认本机文件 I/O，既有可执行工具仍通过受限 `inputRef` 使用 Worker。

安装产物包含 Agent Service、Execution Worker、admin CLI 及产品运行时包；它不包含 `packages/testing` 的生产 adapter。打包器从列入 runtime 的生产 workspace manifests 自动推导全部直接外部依赖根，再递归复制其依赖闭包；因此 `platform-node` 声明的官方 MCP client 也必须出现在安装产物，新增生产依赖不能依赖手工清单。Agent Service 启动时只从 strict configuration 读取一个 primary、可选独立 specialist 和一个独立 embedding descriptor；支持的 Vercel AI Gateway 配置创建 production Model/Pi 与 Mem0 composition，Mem0 使用配置声明的 embedding provider/model/version 和 dimensions，deterministic 配置只报告 descriptor，不创建隐藏模型或调用 provider。每个构建记录提交身份、实际源码与 package-lock 摘要、workspace checksum、Node 平台/架构和外部依赖闭包；已审阅的未提交改动不能被省略为只有提交身份。由于 `better-sqlite3` 等 native 依赖，Mac 与 Linux 必须分别构建和验收，不能把一个平台的二进制包当作另一个平台的 immutable artifact。

Schema 40 为尚未绑定的预约增加不可撤销的停止标记，并保留独立的有限恢复记录。停止或启动恢复遇到这类预约时禁止后续绑定；已注册环境只通过原认证 Job Host 控制通道请求停止。标记不证明私有环境已清理或共享占用可释放，缺少证据时仍保留 claim；不补造运行时身份或永久释放回执。升级必须先备份并迁移唯一 writer，Schema 39 及以前的 writer 不得接管。Worker 线上消息合同没有新增字段，旧 Worker 也不能绕过数据库绑定检查。

Schema 41 新增独立的 `sandbox_reservation_release_receipts`。只有原认证宿主证明任务从未启动、原进程已退出且清理完成，当前 writer 才能同事务保存永久回执并释放该预约的占用。原停止标记保持不可撤销，不伪造运行时绑定、业务结果或退款；重复停止和恢复读回原事实，不因核验凭据过期重新占用。缺少宿主证明、仍有保护或已启动任务的后代状态未知时继续保留未确认状态。备份与权威迁移须同时保留回执、停止标记及受保护宿主证据；Schema 40 及以前的 writer 不得写入新库，回退仍需停机并恢复匹配旧版本的完整恢复点。

轮次已取消、失败或完成后，如果某个工具只有准备事件而没有结束结果，页面显示“结果未确认”，不持续显示准备中；明确未派发的原证据仍显示“尚未派发”。缺少真实起止边界时不生成时长，刷新后沿用相同规则。

历史工具结果以已持久保存的产品 outcome 为依据：`failed` 或 `result_unknown` 不因旧 Pi 记录的 `isError=false` 或缺少错误码变为完成。确定未派发的 `FILE_VERSION_CONFLICT` 显示“尚未派发”；若同时存在结果未知证据，或产品成功与未派发标记相互矛盾，优先保留“结果未确认”，不能据此推断没有写入。原输出内容与事件序号保持不变，不补造执行时长，也不重放工具。

新控制中心在服务声明 `executionStateAvailable` 后另查 `thread.execution_state`，旧事件接口不增加字段，旧服务缺少该声明时仍走原兼容路径。恢复后应同时检查每个操作和整体结论，不能只看最后成功工具或 Run 终态；分页或版本变化造成的读取失败必须保留原结论并重新查询，不能重新执行工具。页面状态的内容 revision 不是执行权凭据；实际 Stop/清理仍经原 revision、权限和幂等控制。当前效果列表仅表示操作 outcome，不能代替原 journal 的资源释放证明。此展示升级无 migration，不修改已有恢复点，也不授权生产切换。


内部资源快照 `readRunInventory` 只读取已有同主体 Run 的预约、绑定、队列历史及旧格式未释放标记，不变更数据库版本、额度或执行权。生产 `thread.execution_state` 已将该快照与 Run/Trace 聚合，读取期间资源或 Run 改变时拒绝混合结论。历史 Scope 仅用于验证原工具归属，不读取或续发当前 Grant；停止、核验和资源状态未确认通过既有 `reasonCode` 表达，保持 v3 阶段枚举兼容。工具效果与资源清理分别保留；当前准备或受控执行尚无最终结果不等于结果未知，显式未知、观察失效或停止后无结果仍显示未确认。已释放但未交接的内部结果仍显示结果未确认。当前可见会话每两秒重新只读核验，隐藏或断线时停止该轮询，不把连接心跳或本地计时当作执行事实；空快照与旧权限都不能代替当前宿主停止证明或本 Runbook 的现场核验。读取超过任一 10,000 条上限时必须报告失败，不接受截断后继续操作。

原运行调度现在可补交已经保存的完成输出：仅接受原 `runtime_settled/completed`，或清理未确认而保存输出的记录。恢复仍要求原冻结输入、当前权威和执行租约，并在写入回答的同一事务核对 checkpoint revision、原结果、全部前台/后台资源的永久释放、队列及未解除保护；不延长业务执行期限、不调用模型/工具、不发起第二轮清理。原输出保存后或 Run 状态变更前中断均保留可恢复身份；未知输出不能走该路径。取消先提交时不写回答。原输入不能读取或校验失败时保存 `RUN_COMPLETION_DELIVERY_REJECTED` 并保留原输出，停止自动补交；不得通过改诊断码或续发旧授权强行恢复。备份/迁移须共同保留冻结输入、checkpoint、回答 Payload、完成命令与消息身份；本变更沿用 Schema 43，升级仍须替换唯一 writer，不能因 schema 相同认定旧程序具有这些行为检查。该能力由现有 Run 调度触发；仅运行资源核查的无 Web 模式不因此创建模型/Run 执行服务。

工具结果现在保留产品派发证据 `dispatchState`（明确未派发、可能派发、已接收），旧记录缺少该字段时仍使用已知旧错误码。编码工具的准入前拒绝和 Pi 前置检查失败显示为未派发；未知、矛盾或无法识别的证据不能显示成功。Worker 取消通知须经过原沙箱结果核验；没有可信结果时保留结果未知并禁止重复派发，之后只按原结果或下述确定结果丢失的边界交付。只读工具（fixed_read，例如 read/ls/find/grep）报告确定的 Pi 工具错误时，模型拿到的是 Worker 已保存的 Pi 自身错误输出（例如“文件不存在”），它经过与成功结果相同的披露检查，并作为该调用的结果引用保存；bash 失败仍只给出错误码说明。取消原因保存在受保护诊断中，通知时间不能当作真实执行结束时间；升级、恢复或迁移不得据此删除占用、回滚已发生修改或续发权限。此变更沿用原 SQLite schema、Worker 协议和页面阶段，不构成完整错误分类、有限网络重试或平台停止资格。

当提前完成 IPC 与最终 result IPC 的退出事实矛盾时，保存确定错误 `SANDBOX_HOST_COMPLETION_CONTRADICTED`；向模型交付明确失败说明，不携带可能自称成功的原 stdout。原输出和分块仍保留作诊断，成对重启不得将该错误覆盖成成功或重新执行。该错误不证明工具没有产生效果；原披露与效果核验继续适用。

工具原期限到达后，等待结果及认证清理汇报的截止点取原工具期限加既有 35000 毫秒与原 Run 期限的较早者；工具和Run的实际执行期限不延长。这段回复余量不延长披露授权：SQLite 从持久原回执自行计算上界，调用方只能缩短；每次交付检查及输出解密后重新核验 Grant/Handle、Run 与当前执行权，撤销或自身到期时连固定错误说明也不再交付。期限恢复由 Agent 核验解密结束语义及原宿主签名；SQLite 在原 Run 期限内核对持久来源、释放、权限和版本，仅允许内部期限用途形成失败，不扩大普通恢复窗口。

完整期限结束块、原宿主签名退出事实和认证释放齐全时，正常 Worker 及重启恢复均交付确定错误 `SANDBOX_TOOL_DEADLINE_EXCEEDED`，不把部分 stdout 作为成功结果交付，未知工作区效果仍保留。

若直到原 Run 期限仍待核查，现有 Run 调度读取受保护冻结输入，仅在当前权限、版本、原期限及全部资源释放检查通过后，以单个事务将 Run 和 checkpoint 写为 failed并结束临时收尾租约，原因 `RUN_EXECUTION_DEADLINE_EXCEEDED`。同一事务还写标准回执、待发布的 run.failed 事件、线程版本和网关通知；重复到期检查不重复通知，任一写入失败整体回滚。页面分别显示工具超时已清理和本轮到期已结束；不能把页面终点当成工作区未修改的证明。备份继续共同保留冻结输入、checkpoint、执行记录、结束块和原认证证据；无新表或迁移，同 schema 的旧程序不具备此收尾行为。见[到期收尾设计](../execution/specs/2026-09-29-sandbox-deadline-settlement-design.md)。[SOURCE: docs/execution/specs/2026-09-29-sandbox-deadline-settlement-design.md]

纯非沙箱工具结果 UNKNOWN 也使用原冻结期限：Run 与 checkpoint 必须同时核对、无输出和终态且原因为 `RUNTIME_TOOL_RESULT_UNKNOWN`。现有到期事务与页面投影共用规范 SQLite 缺席核查，必须没有执行记录、任何状态的 admission/deleted plan 和 legacy pending 资源；显示清单为空不能替代。已结束的 Run 显示期限失败，工具仍显示“结果未确认”，不能据此重跑、撤销或断言操作没发生。恢复扫描的固定上界和游标仅在内存中，重启从头核查，不增加备份字段、迁移或外部接口。升级及恢复继续保留受保护原输入、checkpoint、Run 回执和通知，不能以新配置重新开始期限。见[非沙箱 UNKNOWN 到期](../execution/specs/2026-09-29-sandbox-deadline-settlement-design.md#非沙箱-unknown-到期)。[SOURCE: docs/execution/specs/2026-09-29-sandbox-deadline-settlement-design.md#非沙箱-unknown-到期]

前台 SRT 现沿用受保护 Payload 通道额外保存 stdout 分块，任务正常退出且 stdout/stderr 管道已关闭时先保存带 termination 的结束块，再等待宿主清理。最终报告仍未确认管道关闭时，只保存输出前缀，不能生成结束块或完整成功结果；原未知结果、有限恢复和停止规则继续适用。正常 Worker 的原始 stdout Payload 和结果消费者不变；恢复只在接纳释放后核验完整分块、原身份和当前权限，重组成普通 Payload，并将输出归属和 operation CAS 同事务保存。已有等价原 Payload 时复用，已确定 operation 优先，不能用当前文件内容代替旧 read 输出。备份和迁移须同时保留原 Run 的 `sandbox-stream-chunk:*`、`sandbox-stream-end:*`、对应加密 Payload、原调用回执和输出归属；分块 JSON 不是完整输出引用。每次调用增加分块副本与本机 RPC，结束 artifact 还会保存末块 JSON，容量评估不能只按原 stdout 长度计算。合法的取消、输出或资源超限、宿主失败结束块在完整校验后保留原 UNKNOWN 或已有确定错误，不因不能恢复输出而关闭 Agent；未知原因、矛盾字段和损坏分块仍拒绝。后台游标合同不变；完整性、取消、期限、披露和效果验证不放宽。见[前台结果恢复设计](../execution/specs/2026-09-29-sandbox-foreground-result-durability-design.md#恢复裁决与事务)。[SOURCE: docs/execution/specs/2026-09-29-sandbox-foreground-result-durability-design.md]

Worker 单独退出而 Agent 继续运行时，服务整体不可用，页面也不能停止本轮；需要成对重启服务。生产启动器在任一进程退出时会自动成对重启。将来的 Mac 常驻启动器必须保持同样的合同。现有 `hermes-ui-session-start.mjs` 先停止 Agent，再停止尚存活的 Worker，交由服务管理器重启整对；不能用只恢复 Worker 或修改业务 HTTP 就绪条件替代此步骤。这里说明所需进程合同，不授权生产重启；执行仍遵守本 Runbook 的现场检查与授权要求。

前台没有完整结束块且没有确定 operation 时，不保证恢复原输出。只有已接受释放、原签名结束记录证明任务启动并退出、操作没有确定结果、且同一部署当前 epoch/fence 已严格超过原尝试时，恢复才以原 operation revision 比较写入 `SANDBOX_TOOL_RESULT_LOST`。该确定错误表示原输出和退出结果丢失，不表示工具没有产生效果；效果未知事实保留，原工具不得重放，已接受释放不得撤销。原确定结果先写入时优先，丢失错误先写入后迟到写者不能覆盖。

此错误沿原 Pi 批次交付一次，模型得到“工具已运行并结束，但输出和退出结果在服务重启时丢失；没有重新执行。它可能已经产生了效果，是否重做请先确认。”当前 Run、租约、取消、期限、披露与预算仍须核验；取消或过期不能复活或补交，旧 Handle 不因恢复而取得新 fence 权限。没有签名退出证明或原尝试仍可提交时不能声称丢失。页面仅将这一已释放的确定错误显示为失败，不推断工作区效果已核验。

按 [ADR 0033 决定第 2、5 条](../adr/0033-process-sandbox-default-and-optional-containers.md#decision)，SRT 资源观察器不因后代脱离进程组而停止任务。CPU/内存超限、样本不可用或非法时仍停止；PID 身份核验、原期限和进程组消失证明不变。`process_group_gone` 不证明脱离后代已停止。

升级、备份和恢复应共同保留原控制关联、签名控制证据、释放回执、operation journal、原 Pi 批次及交付记录，还有既有受保护 trace 中的 `sandbox-tool-result-lost:<invocationId>` 固定错误 Payload。本修改不扩展恢复包或迁移包范围；数据库恢复点不等于保存了宿主原控制目录，缺少匹配的原签名证据时不得新认定结果丢失。这里不新增原工具输出的宿主明文文件，不新增表、迁移、状态或队列；同 schema 不证明旧 writer 理解本错误的恢复和交付语义。仍须替换唯一 writer，回退前核对匹配程序和完整恢复点。参见[工具执行排查记录](../execution/plans/2026-09-28-tool-execution-audit-plan.md#缺陷和待验证项)；Linux 现场资格不能由 Mac 证据替代。

生产通用 Worker 现在通过既有 Payload UDS 的 `payload.invocation.validate` 校验 Agent 当前持久调用权限；不支持此操作的旧 Agent 会拒绝继续执行，升级须使用匹配服务产物，不能降级成仅凭内存委派放行。该查询不读取正文、不缓存批准、不再消费额度；外发前与输入解密返回前均重新检查。事件流挂起期间仍检查撤销并向原 Worker 请求停止，受保护诊断区分“已请求”与“发送未确认”，两者均不是效果终结或资源释放证明。资源扫描在 Run 仍运行时也识别 Grant/Handle 撤销、期限失效和能力禁用，排定原资源有限 stop；未绑定预约先禁止启动，未知停止仍保留占用。现有 Schema 43、历史结果保留和恢复点规则不变；实际目录授权与平台停止能力仍须按目标现场检查，不能以这些本地测试替代资格或生产操作授权。

可选配置 `taskEnvironments`（任务环境，即一轮对话专用的 Docker 容器）默认不写，不写时产品行为不变：安装声明里后端不是 `srt`（本机沙箱）的工具调用一律以 `SANDBOX_TASK_ENVIRONMENT_UNAVAILABLE` 拒绝。写入后即进入严格模式：安装声明里后端是 `srt` 的工具调用，包括旧版文件读取和 Worker 发起的子任务，在准入前一律以 `SANDBOX_STRICT_MODE_UNAVAILABLE` 拒绝，不写入任何执行记录，也不改用 SRT 执行，会话里对应的工具步骤显示“严格模式下不可用”；Agent Service 通过 Worker 取得和停止容器，Worker 用配置里的 Docker 程序绝对路径、可选 `dockerHost`（Docker 服务的连接地址，不写时用 Docker 自己的默认连接）、固定摘要的执行镜像与出网代理镜像创建容器；runner 摘要（容器里启动程序和挂载运行时的固定布局算出的 SHA-256 值）不再写在配置里，Agent Service 和 Worker 都从签名安装声明里的运行时摘要自动计算，旧配置里如果还有 `runnerDigest`，启动时以 `CONFIGURATION_UNKNOWN_FIELD` 拒绝，删掉这一项即可。严格模式下，安装声明可以把三类文件发布指向容器后端：先在准入前准备好候选内容的写入和编辑（`pi-coding-tool` 版本 `3`）、移动目录（版本 `4`）、另存副本（版本 `5`）。这三类不在容器里运行，由 Worker 在宿主一侧直接发布候选，但登记在本轮任务环境名下：环境已发出停止、已过期限、容器已被替换或未在运行时一律拒绝，不写文件；发布进行中时不发出停止证明；同一调用只能发布一次。没有准备好候选的写入（版本 `2`）在容器后端仍然拒绝。容器状态记录保存在 `<stateRoot>/runtime/task-environments`，属于本机运行状态：备份恢复包不包含它，恢复也不会覆盖它。把数据库恢复到较早的时间点后，数据库里登记的任务环境可能与这些记录和实际容器不一致，这种情况的处理尚未验证。Worker 启动时如果没有任何沙箱主机绑定把操作指向该 `backendRef`，或这些绑定的运行时目录、摘要不一致，就以 `TASK_ENVIRONMENT_BINDING_UNAVAILABLE`、`TASK_ENVIRONMENT_RUNTIME_AMBIGUOUS` 拒绝启动。本段只记录配置和组装；经产品路径的真实 Docker 安装资格尚未完成，不能据此在生产配置中启用。

## Authoritative Sources

- 服务启动、authority/SQLite 检查、UDS client/server、信号 drain 和稳定错误码：`apps/agent-service/src/service-main.ts`、`apps/execution-worker/src/service-main.ts`、`packages/platform-node/src/execution-uds-transport.ts`；共享认证、socket 权限和绝对截止时限由 `packages/platform-node/src/authenticated-uds-transport.ts` 管理。
- 可重定位 artifact、内部 workspace 包和外部依赖闭包：`scripts/package-node-runtime.mjs`。
- 绝对前缀安装和三个入口：`scripts/install-node-runtime.mjs`。
- 固定工具、禁用未知安装脚本和 SQLite 原生构建探针：`ci/toolchain-lock.json`、`scripts/ci/install-tools.mjs`、`scripts/ci/install-dependencies.mjs`。
- CI 恢复下载缓存时，工具安装前缀只允许已有普通 `downloads`、`wheels` 目录；已有解压程序、安装记录或目录符号链接仍拒绝。每次重新核对归档摘要、解压安装并验证工具身份，不复用上次安装的 executable。仅 CI 汇总器使用主锁文件投影出的最小依赖，产品构建与本 Runbook 安装仍使用完整依赖及 SQLite 探针；该优化不改变运行时产物或服务启停约定。
- 安装期间的磁盘采样与错误脱敏：`scripts/ci/resources.mjs`、`scripts/ci/redact-text.mjs`；采样只提供观测峰值下界，出现采样错误时须保留不完整状态和有界诊断，不能从安装成功推导采样完整。协调暂停单独记录原因、耗时和操作结果，不抹去暂停前的失败。
- 文件模式、内容摘要和归档校验：`scripts/ci/artifact-files.mjs`、`scripts/ci/verify-artifact.mjs`。CI 归档安装还绑定同一次运行的 context；它与下述本机目录安装入口有不同的输入参数。 Context 的来源由 `scripts/ci/context.mjs` 核验；周期质量归档还核对已提交的启用状态、默认分支、cron 与同次 SHA，不能通过临时修改工作树取得周期身份。共享 Context 支持周期事件不启用任何安装或周期操作。
- CI 源码摘要记录实际工作树中的构建输入，包含普通源码的新增、修改、删除和文件模式，不能只记录 Git HEAD。构建器仍引用的模块或显式必需文件缺失时必须失败；构建期间及安装前再次核对摘要，不能用忽略所有缺失文件的方式通过校验。
- integration 的并发数由[CI 测试资源规则](../execution/specs/2026-09-03-github-ci-quality-gates-design.md#3-测试集合完整且不重复)按 CPU、内存和最多 4 个 worker 计算。该测试调度变更不改变安装、归档身份或服务启停合同；旧政策迁移保留原始来源摘要及其他门禁。正式入口同时传入归档和上下文，需要运行时的测试安装校验过的产物；直接开发运行两个变量均缺省时仍可读取 `dist/node-runtime`。测试与构建同时运行时使用 CI 的独立构建输出，避免覆盖开发模式的输入。
- state root、SQLite migration、Worker recovery 与身份边界：`packages/platform-node/src/state-root-layout.ts`、`packages/persistence-sqlite/src/product-state-repository.ts`。
- 本 Runbook contract selector 中列出的源文件和 portable durable web-agent Spec。

本地安装合同补充：Worker 以 deployment binding.kind 区分 sandbox 与旧 process 后端；SRT 不需要伪造旧 process isolation 配置，仍须通过真实 host 资格复核。权限续租只改变到期信息时，不使并发读取失去原权威；停止或身份变化仍必须拒绝。公开网页客户端先创建产品 session，再从认证配置读取 sessionId，不能拼造 ID。重复 Payload 上传须比较带 `sha256:` 前缀的同一正文摘要；并发活跃时间更新冲突时重新检查会话及设备撤销状态。这些规则已通过实际 HTTP／SQLite 和并发回归验证。

审批页空闲时，`/api/gateway/v2/events` 应保持连接并发送心跳；HTTP 200 后立即结束不是正常空闲状态。正式审批组合通过受控订阅通知快照变化，浏览器重新读取审批列表／详情；该提示没有 durable cursor。验收须覆盖空列表下的连接稳定、持久数据变化后的刷新和客户端断开后的订阅取消，不能只检查状态码或用测试服务器的常驻空连接替代正式组合。

控制中心验收还须检查已认证 `/api/control-center/v1/config` 的安装操作清单：当前正式部署只开放对话、审批和依赖健康检查，其他 13 个页面应显示“未启用”且不发送缺失操作的查询。健康页必须读取 `/api/health/v1/dependencies` 的实际依赖状态；连接指示灯不能证明业务功能已安装。已认证但未安装的操作应返回 HTTP 501 / `PORT_OPERATION_NOT_INSTALLED`，不能报成身份权限错误；无效身份和错误 authority 仍应拒绝。不能为了消除报错而移除授权检查，或把缺失后端替换为空数组。


Hermes 的 systemd、Cloudflare 入口、Host 签名与付费模型验收是 Owner 另行明确授权的部署操作，证据记录在 [SOURCE: docs/execution/plans/2026-09-07-srt-unified-execution-plan.md] 的 R8；不扩张本 Runbook 的本地安装操作范围。

### 2026-09-11 安装合同补充

打包会规范普通文件与目录权限，去掉 group/other write 并保留可执行位，避免构建主机 umask 让运行时拒绝实际安装。增加 Pi 工具与公开搜索的请求路由并不创建权限：`runPolicy.coding`/`publicSearch` 必须引用真实目录 Grant 和合格 Capability；搜索使用固定 Exa MCP 出口及受保护结果，不能把查询摘录当作完整网页。工作目录和 Capability 登记使用离线 CLI，要求独占锁、活动身份及明确目标确认。

每次启动检查新鲜资格；同一次启动内复查不可变快照原字节与实时安装摘要，不以五分钟经过自动撤销正常工具，也不接受修改后的配置。快照不能迁移成另一主机的资格。当前 Hermes 操作由 [SOURCE: docs/runbooks/hermes-control-center-upgrade-runbook.md] 单独约束。


P3 文件协议使用 Schema 46 的 writer 边界。升级和恢复必须保留原文件候选、逐文件发布记录、目录移动意图/收据、队列与占用；不得整批回滚已成功文件或覆盖后续人工修改。合同 3 的确定未发布冲突是失败结果，不是成功写入。目录工具合同 4 的 `rename-native` 随目标平台构建并受 runtime 摘要核验，Mac 包不能移作 Linux 包。新增固定文件完成资格仅适用于已验证的固定程序正常结束，旧资格与普通命令的未知清理仍保留保护；实际安装资格和启用不能由测试结果自动生成。详见 [SOURCE: docs/execution/specs/2026-09-16-workspace-authorization-lifecycle-design.md]。

P4 工作副本保存合同将当前 writer 边界推进至 Schema 47，保留已有行和历史迁移。副本的待保存操作包含目录授权版本、根身份、输入内容/身份基线及先前逐文件保存结果；Schema 46 或更旧的程序必须拒绝写入，不能忽略这些条件继续执行。恢复点须同时保留对应受保护内容和文件操作记录；若单独配置候选目录，须核对其备份范围，不能仅凭数据库备份宣称唯一候选已受保护。过期不自动应用或删除候选；回退须停止新 writer 并恢复匹配旧程序的完整恢复点。本批没有执行实际实例迁移，也没有为缺少资格的候选命令后端生成启用资格。

任务级执行环境记录将当前 writer 边界推进至 Schema 48，保留已有行和历史迁移。新表保存每轮对话一个的执行作业、按“第几个环境”编号的环境记录、环境级占用（`lease`，整个环境持有的工作目录占用登记，释放前会冲突的其他任务不能动这些目录）、每次调用与环境的关联、停止记录和不可修改的释放回执；原来单次调用的执行记录含义不变。Schema 47 或更旧的程序必须拒绝写入新库，否则它看不到环境级占用，可能让冲突的任务提前运行。Run 结束前现在还要求本轮没有未释放的环境。现有执行路线不会创建这类记录，所以升级后这些表为空；本迁移也不启用新的执行后端。备份和恢复点须随数据库一起保留这些表；回退须停止新 writer 并恢复匹配旧程序的完整恢复点，不能删除新表或修改迁移账本来降级。只读核查使用[工作区历史占用只读核查](workspace-lifecycle-audit-runbook.md#procedure)的 `environments` 分区。本批没有执行实际实例迁移。

对话标题预算账户将当前 writer 边界推进至 Schema 49，保留已有行和历史迁移。本迁移重建模型预算账户表 `model_budget_accounts`（记录每个花费主体已预留和已花费的模型费用），新增一类账户：自动生成对话标题的那次模型调用改记在本轮对话专属的标题账户（账户号 `thread-title:<Run ID>`），不再记在本轮对话（Run）自己的账户里。这样标题调用结果不明时，只有标题账户进入待核对状态，不会挡住本轮对话的派发、恢复或结束。依赖该表的预算分配表 `model_budget_allocations` 和模型调用身份表 `model_invocation_identities` 随之重建，原有行逐行保留；旧行都属于原有几类账户，所以升级后不会凭空出现标题账户。全局费用上限和按数据级别的费用上限仍计入标题账户，单轮费用上限对标题账户单独计算。Schema 48 或更旧的程序必须拒绝写入新库，否则它读不懂标题账户。备份和恢复点须随数据库一起保留这三张表；回退须停止新 writer 并恢复匹配旧程序的完整恢复点，不能修改迁移账本来降级。本批没有执行实际实例迁移。

SRT 可选工作副本使用 `privateRoot/workspace-copies` 保存当前文件基线和候选内容，生产 Owner 入口按既有 Bash 配置装配创建、选择和准备操作。`prepare` 不表示已保存回原目录；保存须配置 `save_copy` 工具和 `pi-coding-tool@5` 前台 `verified_effect` 描述，经原 Run/Worker 准入队列逐文件执行，不能启用绕过该队列的旧 `host.file.execute`。描述的 `directoryOperations` 是上限，实际 scope 仅含 read 与当前操作；移入回收区仍须 trash 授权。 备份须同时保留任务私有目录中的 `copy-save-state-*.json`、原目录 `.himawari-recovery` 中的已暂存内容/快照以及 SQLite 操作记录；最终结果写回中断后，只能在原资源已确认释放后核验并导入历史效果，不能重新派发保存。旧严格 Scope 读者会拒绝合同 5，禁止混用不支持该合同的 Agent/Worker 或复用旧安装摘要。备份或权威迁移必须保留唯一副本和受保护的选择/操作记录；换主机或路径后重新验证目录身份、来源授权与执行资格，不能沿用旧 inode 或进程证明。具体已验证范围见[P4 完成验收](../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p4-completed)。


## Safety and Preconditions

模型配置遵循[网关迁移设计](../execution/specs/2026-10-06-vercel-gateway-migration-design.md)：文本仅`deepseek/deepseek-v4.1-flash`，嵌入仅`alibaba/qwen3-embedding-8b`、4096维，不保留GLM备用。`providerRouting`保存`order: ["runware", "deepinfra", "morph"]`与`sort: "cost"`；文本输出上限不得超过32768，单次请求还取配置与调用选项的较小值。准入使用冻结的保守估价，结算使用网关返回实际费用；缺失或矛盾费用保持待核对，不把失败当免费，也不自动重发。历史调用身份和账单不改写。

Mem0运行时精确锁定`3.3.1`，保留既有`vectors.sqlite`及`history.sqlite`路径，实体派生索引单独使用同目录的`entities.sqlite`。实体索引由SDK工厂创建，不混入产品记忆主库；产品记忆仍由产品数据库与受保护Payload负责。备份恢复点只包含产品SQLite与受保护Payload文件，不包含Mem0索引；停机权威迁移会打包配置的整个Memory目录，因此也携带entities.sqlite，并检查Memory版本。实体索引本身不能替代产品状态和受保护Payload的验证。Mac对该新版本及网关行为尚未检查；Hermes结果不能证明生产服务器资格。

- 目标必须是本机明确的临时或已批准 state root、runtime 前缀和配置路径；不得使用工作目录推断生产路径，不得把 `/data/hermes` 或其他共享 Hermes Agent state root 当作 Himawari 目标。
- 安装前记录 Git HEAD/worktree、package-lock digest、Node/npm、目标前缀和 state root、磁盘可用空间及现有进程。目标前缀必须由本次运行创建，或已取得清理其 `lib/himawari-agent` 的明确授权。
- 归档解压与安装显式将本次新建的解压目的目录及其父目录、安装前缀目录链和新运行时目录设为 `0755`，不依赖安装者的 umask；安装器内部暂存根仍为 `0700`。普通文件保持原始字节和包内模式。已有 prefix、lib、bin 只去掉同组和其他用户的写权限：`0700` 保持不变，`0770` 变成 `0750`；其他已有外层目录不变。归档安装 CLI 对全部 payload 文件读取全部字节，核对原始清单的路径、字节数、模式和 SHA-256。安装后另用产品 checker 和独立权限回读核对结果；三条归档测试的独立内容回读范围见[安装权限验收证据](#installation-permission-evidence)。R2-D15 的小型源码样本只证明 `--source` 复制入口的权限规则，不证明约 33,000 个文件的完整源码安装能在默认 30 秒内完成。
- 安装器先规范化安装路径，再逐级创建目录，避免含 `..` 的前缀放宽已有私有父目录。源码复制入口只接受普通目录作为源根；符号链接源根在替换已有运行时之前以 `ARTIFACT_LINK_FORBIDDEN` 拒绝，不修改原始源码目录。
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

Linux候选包的安装命令不自动准备这些宿主二进制。安装成功后仍须核对`pi-tools/bin`中的实际文件、版本、可执行性和摘要，再计算runtimeDigest；不能把安装器成功当作工具已经可用。工具缺失时先取得相应下载授权，不以外部PATH替代安装目录中的固定文件。

自动审查默认关闭：只有同时提供 `runPolicy.automaticReview`（`delegationKey`/`configurationVersion`/`modelRef`/`maximumWaitMs`/`maxOutputBytes`）和匹配的 Owner 委托记录才会外发。缺少该配置段时人工确认路径完全不变；配置存在但模型边界或受保护 Payload 不可用时启动以 `AUTOMATIC_REVIEW_RUNTIME_UNAVAILABLE` 失败，不会静默忽略。`modelRef` 必须指向已配置的生成模型；委托只覆盖逐条列出的确切请求摘要，审查输入只含冻结的操作摘要与版本身份，不含文件正文、路径或凭据。启用前须按 [P5 启用建议](../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#automatic-review-enablement) 确认模型身份、接收方与费用额度。

通用 HITL 需要 migration 0026、受保护恢复 Payload、审批存储和执行租约一同可用。公开入口使用已有身份与 CSRF 校验提供 `approval.list/detail/respond`，Thread 的等待、恢复和取消状态通过持久事件通知页面。等待审批不占用执行槽位；批准、拒绝、审批过期或原 Run 总期限到达后才重新领取。恢复仍使用原始截止时间，不能重新分配时长。其他治理操作未因审批入口接入而自动启用。

<a id="ubuntu-2404-bwrap"></a>

## Ubuntu 24.04 的 bwrap 前提

Ubuntu 23.10 及以后版本引入了对普通用户程序使用用户命名空间的限制；Ubuntu 24.04 默认启用。用户命名空间是 Linux 让普通用户建立隔离运行环境的机制。安装 Linux 沙箱前，管理员必须读取 `kernel.apparmor_restrict_unprivileged_userns` 的实际值，不能只按系统版本判断。[Ubuntu 23.10 发布说明](https://discourse.ubuntu.com/t/mantic-minotaur-release-notes/35534)记录该版本发布时尚未默认启用；[Ubuntu 24.04 发布说明](https://documentation.ubuntu.com/release-notes/24.04/)说明默认限制及按程序配置的办法。

AppArmor 是 Ubuntu 按程序限制权限的安全模块。该开关为 `1` 时，没有取得匹配 AppArmor 权限的普通用户程序使用用户命名空间会受到限制。bubblewrap（命令名 `bwrap`，产品在 Linux 上使用的沙箱程序）需要其中的权限，否则建立用户或网络隔离时会失败。[固定版本 SRT README](https://github.com/anthropics/sandbox-runtime/blob/v0.0.75/README.md#platform-specific-dependencies)说明了这项前提。

本节记录两个已经批准的程序路径。管理员只检查、配置本次部署实际采用的路径；本节不要求为了安装产品同时安装两份 bwrap。若实际部署同时使用两处路径，则分别检查两处。Linux 的 `program/stdio MCP` 隔离后端（启动独立程序，或通过标准输入和输出与外部工具通信的后端）仍要求 bubblewrap `>=0.11.2`，并拒绝 setuid 程序（执行时借用文件所有者权限的程序）。系统 `/usr/bin/bwrap` 的版本不足时，不能把它代替该后端需要的 0.11.2 程序；给程序增加 AppArmor 规则不会升级版本或取消原有资格检查。

| 实际采用的程序路径 | 对应规则文件 | 核对依据 |
| --- | --- | --- |
| `/usr/bin/bwrap` | `/etc/apparmor.d/bwrap` | ADR 0045 记录的系统 bwrap 路径；版本和是否被部署采用须在目标机核对 |
| `/usr/local/libexec/bubblewrap-0.11.2/bwrap` | `/etc/apparmor.d/bwrap-0.11.2` | BL-20261001-001 记录的 0.11.2 安装路径；供 `program/stdio MCP` 后端使用 |

以下命令由管理员（用户）自己执行。创建、加载或撤销 AppArmor 规则需要 root 权限，并改变系统安全设置；编程代理不执行这些改动。bwrap 的启动检查由管理员切换到产品最终使用的普通用户执行，产品不能以 root 运行。执行前仍须满足本 Runbook 的[目标现场检查](#live-state-preflight)、证据保存和针对实际目标的授权要求。

管理员先以 root 执行只读检查，保存输出：

~~~sh
test "$(id -u)" -eq 0
cat /etc/os-release
sysctl kernel.apparmor_restrict_unprivileged_userns
aa-status
~~~

然后只运行实际采用路径的版本与权限检查。

若采用 `/usr/bin/bwrap`：

~~~sh
/usr/bin/bwrap --version
stat -c '%U %G %a %n' /usr/bin/bwrap
~~~

若采用 0.11.2 安装路径：

~~~sh
/usr/local/libexec/bubblewrap-0.11.2/bwrap --version
stat -c '%U %G %a %n' /usr/local/libexec/bubblewrap-0.11.2/bwrap
sha256sum /usr/local/libexec/bubblewrap-0.11.2/bwrap
~~~

2026-10-01 的历史记录中，0.11.2 程序由 root 所有，权限为 `0755`，SHA-256 为 `20a3bdb6c1147f62a043a9d4d9c7873db233df40f11a0cc48731a16b97e008f3`。该记录不证明生产机当前仍有相同文件。管理员须核对本次采用的实际程序和已经批准的安装身份。实际采用的程序缺失、版本不足、身份不符，或读取系统前提失败时停止，不自动下载、重装程序或修改系统开关。

开关为 `1` 时，检查实际采用路径是否已有有效规则。已有规则先核对内容和来源，不覆盖其他管理员维护的规则。需要修改已有规则时，先把原文件保存到本次受保护证据目录，记录原规则是否已加载，再由管理员确认具体改动。需要新建规则时，仅新建实际采用路径对应的文件。下面两个规则保持已经批准的原文，不把程序路径改成通配符。

`/etc/apparmor.d/bwrap` 的内容：

~~~text
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
~~~

`/etc/apparmor.d/bwrap-0.11.2` 的内容：

~~~text
abi <abi/4.0>,
include <tunables/global>

profile bwrap-0.11.2 /usr/local/libexec/bubblewrap-0.11.2/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap-0.11.2>
}
~~~

`profile` 名称和 `local` 引用分别为 `bwrap`、`bwrap-0.11.2`，防止加载第二条时替换第一条。`userns,` 只在对应程序的规则中授予用户命名空间权限；`flags=(unconfined)` 沿用原批准内容。该规则不代替产品自身的隔离策略。

管理员只加载实际采用路径对应的规则。若采用系统 bwrap：

~~~sh
apparmor_parser -r /etc/apparmor.d/bwrap
~~~

若采用 0.11.2 安装路径：

~~~sh
apparmor_parser -r /etc/apparmor.d/bwrap-0.11.2
~~~

加载后检查规则状态和全局开关。原值为 `1` 时必须仍为 `1`；加载失败或实际状态不符时停止。[Ubuntu AppArmor 操作说明](https://ubuntu.com/server/docs/how-to/security/apparmor/)解释了 `-r` 加载或替换、`-R` 卸载规则的命令。

~~~sh
sysctl kernel.apparmor_restrict_unprivileged_userns
aa-status
~~~

管理员把下面的 `<实际产品普通用户>` 替换为本次已确认的产品运行账号。先检查该账号的 UID（用户编号）不为 `0`，再执行实际采用路径的 bwrap 启动检查。不要用旧测试环境的账号代替产品最终运行账号。

~~~sh
D10_PRODUCT_USER='<实际产品普通用户>'
test "$(id -u "$D10_PRODUCT_USER")" -ne 0
~~~

若采用系统 bwrap：

~~~sh
sudo -u "$D10_PRODUCT_USER" -- /usr/bin/bwrap --unshare-all --unshare-net --ro-bind / / --dev /dev --proc /proc /usr/bin/true
~~~

若采用 0.11.2 安装路径：

~~~sh
sudo -u "$D10_PRODUCT_USER" -- /usr/local/libexec/bubblewrap-0.11.2/bwrap --unshare-all --unshare-net --ro-bind / / --dev /dev --proc /proc /usr/bin/true
~~~

实际采用路径的命令必须退出为 `0`。失败时保存标准错误和退出码，停止后续安装或启动。`--unshare-all --unshare-net` 要求建立包含网络隔离的命名空间；`--ro-bind / /` 为这次启动检查提供只读系统文件。该检查只证明所选普通用户能启动 bwrap，不能证明完整产品沙箱、SRT 网络代理或 `program/stdio MCP` 后端已经通过验收。[bubblewrap 0.11.2 命令说明](https://github.com/containers/bubblewrap/blob/v0.11.2/bwrap.xml)给出了这些参数的含义。

按项目的 SRT 集成指南，**不得关闭全局 `kernel.apparmor_restrict_unprivileged_userns` 开关，不得使用 `--privileged`，也不得以 root 运行产品来绕过失败**。系统前提不足时由管理员处理，不自动降低隔离要求。

撤销前确认没有仍依赖对应规则的产品进程。管理员只撤销本次新增的规则，先卸载成功，再删除对应文件；卸载失败时停止，不继续删除。若原来已有规则且本次修改了它，应恢复已保存的原规则并按原加载状态恢复，不能把删除文件当作恢复原状。

撤销本次新增的系统 bwrap 规则：

~~~sh
apparmor_parser -R /etc/apparmor.d/bwrap && rm -- /etc/apparmor.d/bwrap
~~~

撤销本次新增的 0.11.2 路径规则：

~~~sh
apparmor_parser -R /etc/apparmor.d/bwrap-0.11.2 && rm -- /etc/apparmor.d/bwrap-0.11.2
~~~

撤销后保存 `aa-status` 和全局开关的只读检查结果。全局开关保持原值；原值为 `1` 时，对应普通用户程序会再次受到限制。撤销规则不删除 0.11.2 程序，也不清理云服务器的旧测试环境。ADR 0049 要求生产需要的 0.11.2 程序及规则继续保留；本节中的撤销命令不授予撤销生产机已有规则的权限。

Hermes 使用 Ubuntu 22.04，其测试结果不能证明 Ubuntu 24.04 的 AppArmor 行为。部署前须在实际生产机上，以最终运行账号检查实际程序版本、摘要、权限、匹配规则、全局开关和上述启动结果，并继续完成实际产品路径检查。这属于 R2-L2 的生产前提核对。云服务器不用于开发测试；生产部署或服务变更仍须逐次取得用户明确授权。2026-10-01 的旧结果只作历史记录，不能代替此次检查。本次 D10 只补文档，没有登录生产机或修改系统设置，产品启动时的自动检测仍留待第二轮以后。

[SOURCE: docs/adr/0045-short-test-temp-root.md#apparmor]
[SOURCE: docs/backlog/BL-20261001-001-ubuntu-24-04-默-认-禁-止-bwrap.md]
[SOURCE: docs/adr/0021-platform-capability-runtime-isolation.md]
[SOURCE: docs/adr/0049-first-production-host-acceptance-exception.md]
[SOURCE: docs/assets/others/Anthropic_SRT_AI_Agent_Integration_Guide_2026-09-07.md]

[↑ 返回阅读导航](#阅读导航)

<a id="artifact-extraction-contract"></a>

## 归档解包与临时磁盘

安装前分别检查压缩归档、解压目的目录和匿名暂存文件所在文件系统的可用空间。解包器在目的目录的父链中只读查找最近的已有目录，再在该目录创建权限为 `0600` 的匿名临时文件。直接父目录缺失时不会为暂存提前创建目录，须按最近已有祖先当前所在盘核对暂存与目标写出的空间，不能只检查压缩归档所在盘。

匿名文件临时保存一份完整的未压缩 tar。r62 完整产品归档实测为 `328202240` 字节，约 `330 MB`；这份空间是安装 payload 之外的额外占用，安装目录的上级目录所在盘必须有相应余量。写出 payload 时匿名 tar 仍存在，容量规划必须同时计入未压缩 tar、解压后的 payload、已有压缩归档和其他安装数据。匿名文件在解包上下文正常返回或异常退出时自动关闭并释放。该样本大小不是所有未来归档的上限。

原始解压 tar 的正式上限为 `2 GiB + 256 MiB`，即 `2415919104` 字节，包括 tar 头、PAX 扩展及填充；普通文件逻辑内容总量仍受原有 `2 GiB` 上限约束。两者不是同一限制，也不是整个安装的磁盘占用上限。Hermes 测试的根盘 `10 GiB` 守卫仍须执行，不能代替真实部署目标的容量检查。

解包器先完整读取 gzip，再对 tar 做完整预检，最后才创建解压目的目录及其缺失父目录。gzip 损坏、截断或原始大小超限先于目标创建失败；输入同时有 gzip 或大小错误与 tar 结构错误时，先报告前者。原有 tar 安全检查不放宽。独立 `extract` 的创建边界不表示安装 CLI 从未创建 prefix 或内部暂存根，CLI 会先准备安装目录。机制与错误选择见[归档解包与文件清单](../execution/specs/2026-09-03-github-ci-quality-gates-design.md#artifact-extraction-and-inventory)。[SOURCE: docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md#artifact-extraction-and-inventory]

[↑ 返回阅读导航](#阅读导航)

## Live-State Preflight

核对本次安装包含[预热准备线程](#pi-preparation-prewarm)的 pool 模块、准备入口、线程入口及 runtime-pi 导出。正常停止必须等待该池拥有的线程退出；不能仅以准备调用已返回或 state-root lock 已释放代替服务进程停止检查。

在安装或启动前执行以下只读检查，并保存脱敏结果：

~~~text
git rev-parse HEAD
git status --short --branch
node --version
npm --version
df -h <target-filesystem>
ps -axo pid,command
~~~

归档安装还须按[归档解包与临时磁盘](#artifact-extraction-contract)确定匿名 tar 实际暂存的最近已有祖先目录。分别记录该目录、解压目标和压缩归档所在盘的可用空间，计入暂存 tar 与 payload 同时存在的峰值。

确认构建输入来自当前 checkout 和 committed `package-lock.json`，目标 prefix/state root 是绝对规范路径，目录 owner/mode 安全，旧的 `execution.sock` 不存在或由同一受控进程持有，目标 deployment 没有其他 active service。启动前再运行：

~~~text
<absolute-prefix>/bin/himawari db status --config <absolute-config-path>
<absolute-prefix>/bin/himawari doctor --config <absolute-config-path>
~~~

若目标已有活动服务、state-root lock、socket、authority 不匹配、schema 不完整或可用空间不足，停止；不得删除活锁、覆盖 state root 或猜测服务管理器命令。

升级前，先从已核实的配置和 `db status` 确定实际产品数据库路径。停旧服务之前可以执行下面的只读统计作为参考；旧 Agent 和 Worker 完全停止之后、启动新版之前必须再次执行，并以停服后的结果作为升级判断依据。停服过程可能留下新的预约，不能用停服前的零值代替复查。将下面的绝对路径替换为该数据库路径，分别保存查询时机和输出；停服后数量不为 0 时停止升级并报告用户，不自动释放或删除记录。

~~~sh
python3 - /absolute/path/product.sqlite <<'PYTHON'
import pathlib, sqlite3, sys
uri = pathlib.Path(sys.argv[1]).resolve(strict=True).as_uri() + "?mode=ro"
with sqlite3.connect(uri, uri=True) as database:
    count = database.execute("""
        SELECT count(*) FROM sandbox_execution_records
        WHERE json_extract(plan_json, '$.backendRef') = 'srt'
          AND preparation_state = 'reserved' AND started_at IS NULL
    """).fetchone()[0]
print("尚未启动的 SRT 预约数：", count)
if count:
    raise SystemExit("停止升级：旧预约不能凭新版准备封锁自动恢复，须报告用户。")
PYTHON
~~~

这是升级操作提示，不是资源释放证明。新建 SRT v2 计划使用 `preparationProtocol=launch-or-block.v2`；已有 `register-before-host.v1` 或无字段计划保持原值。旧 Worker 严格解析会拒绝不认识的协议，发生在创建 Host 前；Agent 与 Worker 必须同包升级，不能删字段降级。登记前不可变封锁仍使用 `preparation_not_authorized`；登记已接受后，新协议的禁止启动决定及保护 Artifact 经 Agent 与 SQLite 核对，才允许使用 `preparation_launch_blocked`。启动先赢或旧协议确认丢失而无 Host 证明时仍保留占用。已有 Host 和容器的认证释放条件不变。Hermes 上的安装路径检查不能替代生产升级后的现场验收。详见[准备启动与停止仲裁](../execution/specs/2026-10-04-sandbox-preparation-launch-arbitration-design.md) [SOURCE: docs/execution/specs/2026-10-04-sandbox-preparation-launch-arbitration-design.md]。

严格模式下，Agent 重启后会为 completed/failed/cancelled Run 的未绑定容器预约补调原同 Run 环境停止，再核对环境释放回执和原预约事务。活动及结果待核实 Run 不因进入恢复清单就停止环境。停止接受但证明缺失、身份不符或后端不可用时继续保留占用；原失败的停止请求不会被同义人工请求重发，不可通过删除严格模式记录、重建 locator 或更换停止 intent 来伪造释放。恢复点须保留 SQLite 中原 execution job、环境、停止 intent、lease 和释放回执；迁移后仍须核验配置的后端与原环境身份，不能从历史回执推断当前运行时已停止。该恢复不重放模型或工具，不增加系统设置、停机、迁移或生产操作授权。详见[未绑定容器的终态恢复](../execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md#container-unbound-recovery) [SOURCE: docs/execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md]。

## Procedure

TE-11 的执行事件传输使用固定分页版本：请求和响应均为 `x-himawari-events-pagination: 1`，响应另带 `x-himawari-events-page`（more/complete）及非空页的 `x-himawari-events-next-cursor`。升级时 Agent 与 Worker 必须取自同一安装产物并成对切换；旧新混用会拒绝事件读取，不能保留旧 Worker 单独更新 Agent。详情见[执行事件有界分页设计](../execution/specs/2026-09-29-execution-event-pagination-design.md#协议) [SOURCE: docs/execution/specs/2026-09-29-execution-event-pagination-design.md#协议]。本变更无数据库迁移；单次正文上限、认证和期限保持原值。缺少分页标记或单事件超限时停止并保留诊断，先核对两端产物身份，不能调高上限或重放工具。

1. 对本 Runbook 执行静态 contract check，建立新的受限 evidence 目录，冻结本次构建 commit、prefix、state root、deployment、Owner/Agent 和运行 ID。
2. 在干净或已审阅的工作树上按 README 安装固定工具链，再执行 `npm run ci:install`；该入口先运行 `npm ci --ignore-scripts`，只构建清单中已审阅的 SQLite 原生依赖并实际验证内存读写。将本次工具目录的 `bin` 放到 PATH 后执行 `npm run build`。工具目录和安装证据目录必须是本次新目录，已有目录使用显式参数另选路径，不覆盖旧证据。不能把未校验的旧 node_modules 或单独 `npm ci --ignore-scripts` 当作完成原生依赖安装。
3. 核对两个 artifact manifest 的提交输入、package-lock SHA、workspace checksum、Node 平台/架构、schema/migration sequence 和依赖版本。构建输入摘要包含仓库 `assets/` 下的品牌资源；Logo 缺失必须导致浏览器构建失败，不能接受资源被改动后仍沿用旧摘要的归档。确认 runtime 外部依赖根与列入打包的生产 workspace manifests 完全对应，`@modelcontextprotocol/client` 等新生产依赖和传递闭包存在，`@himawari-agent/testing` 不存在；若核对失败，删除本次临时产物并停止。
4. 创建本次明确的绝对安装前缀并安装：

~~~text
mkdir -p <absolute-prefix>
npm run install:node-runtime -- --prefix <absolute-prefix>
~~~

5. 若本次是升级，先按[正常停止流程](#procedure)确认旧 Agent 和 Worker 完全退出、锁已释放，再执行[尚未启动的 SRT 预约统计](#live-state-preflight)，保存停服后的查询结果，非零时停止升级并报告用户，不启动新版。随后在启动前运行 `himawari db status` 与 `himawari doctor`，确认 SQLite quick check、schema、authority、Payload、Worker 和 identity 的脱敏状态；若配置声明能力部署快照，还要回读其规范路径、owner/mode、字节数、SHA-256、Manifest/运行绑定数量和本平台资格结论。只读命令失败时不启动普通服务。
6. 以独立子进程先启动 Worker，再启动 Agent Service。Worker 先公布本次 `workerInstanceId/workerBootId`；Agent 取得当前 authority lease 后启动反向权限与 Payload 服务，再发布同时绑定双方实例、boot 和当前 authority 的启动文件，最后完成 Worker handshake。记录双方 `service.ready` 的 component、schema、identity 和 recovery counters；只存在 socket 或旧启动文件不算完成握手。
7. 运行只读 doctor、db status 和适用业务查询；确认 Agent Service 通过 UDS handshake、`service.ready` 记录 model path、memory path 与 embedding descriptor identity、没有 testing adapter、没有 repository checkout 路径，也没有秘密或私人正文输出。deterministic profile 必须显示 descriptor-only；支持的 Pi/Mem0 profile 只能显示配置中的 primary/specialist/embedding reference、version 和 dimensions，不能显示 secret value。
8. 正常停止时先向 Agent Service 发送 `SIGTERM`。Agent 按已登记资源先停止接纳、等待在途工作，再逆序关闭依赖；Memory 消费者停止领取新任务并等待当前批次完成后，才关闭 Memory、模型、authority 和 SQLite。等待 `service.draining` 与 `service.stopped`，再向 Worker 发送 `SIGTERM`，等待其停止并确认 socket 已删除。超出有界等待后才记录 forced stop，并把后续启动视为 recovery drill。
9. 重启或 forced stop 后重新取得 state-root lock，确认同一 deployment/Owner/Agent/Run identity、SQLite schema/quick check、pending recovery counters 和 UDS handshake；不得将普通一次重启写成完整 crash matrix。
10. 完成验证后保存脱敏命令输出、artifact identity、进程退出码、socket/lock 回读和 rollback 状态；临时 prefix、临时 state root 与证据目录按本次授权的保留策略清理。

### Schema 43 资源恢复调度

升级和恢复须保留原 `recovery_json` 的 owner、revision、次数、动作及时间。`scheduled` 表示已排定原资源核查，`nextAttemptAt` 是最早可检查时间；此时开始和结束时间为空。真正开始后才增加次数，终态 `unresolved` 没有下次自动重试。迁移只为旧记录补空的下次时间，不制造释放证明或恢复工具权限。Schema 42 或更旧 writer 不得写入新库；回退须停止新 writer 并恢复匹配旧版本的完整恢复点，禁止删除 migration ledger 或新字段来降级。

已配置沙箱子系统时，后台独立检查终态 Run 遗留资源、过期执行和已有未知资源，按原资源身份执行有限 inspect/stop。Web 模式复用生产 Run 循环；无 Web 模式在启动登记和 Worker 就绪后启动仅处理资源的循环，每次扫描先复核权威，不创建模型或 Run 执行服务。原授权撤销不阻止核验清理，也不恢复执行、模型或披露权限。未绑定预约须先保存禁止启动标记，核查失败继续保护；本机 SRT 只有原宿主从未启动且已退出的证明，或新协议计划已完成准备登记封锁的证明，才允许释放；容器仍须自身的环境释放回执。自动预约恢复同样按后端分流：只对 SRT 调用本机准备控制，container 核对自身已持久的 `task_environment_released` 证明；环境尚未释放时继续保留预约占用，不伪造本机准备记录，也不替代环境自身的停止流程。 对未绑定 container 预约，重启后终态 Run 没有自动补调环境停止的保证，可能一直保留占用并需要人工处理；详情及后续工作见 [BL-20260929-004](../backlog/BL-20260929-004-agent-重-启-后-停-止-终-态.md)。关闭服务或失去权威时立即取消核查，然后有限等待；close 复用同一次等待，不重新计算期限。明确 stop 可接替尚未结束的 inspect，旧检查的迟到写入被恢复 revision 拒绝；已经进行中的 stop 不重复派发。未配置后端、缺少可信宿主身份或只有启动日志均不能证明清理成功；Mac 任意后代停止资格仍须现场证明。

验收应独立读回释放凭据、claim/barrier 和恢复终点。已确认释放但业务结果未知时分别保留，不重发工具，也不以结果交接未完成恢复旧占用。原始预约核查异常沿用受保护 Trace，仅安全原因进入恢复状态。本地 SQLite、认证 socket 和受控宿主退出回归见[调度证据](../../test/qualification/evidence/workspace-authorization-lifecycle/p1-recovery-scheduling-01/README.md)，不替代部署实例的证明或操作授权。无 Web 启动、权威丢失、有限关闭和 stop 优先级的回归见[生命周期证据](../../test/qualification/evidence/workspace-authorization-lifecycle/p1-recovery-startup-01/README.md)。

### Schema 42 资源矛盾事件

释放后收到同一资源的新鲜宿主运行证据时，原 journal 会建立独立 `resource_contradiction` 保护并记录 `SANDBOX_RELEASE_CONTRADICTED`，不篡改原释放凭据或物理 claim。保护范围仍为原精确资源；原有限恢复任务保存 owner、revision、次数和 unresolved 终点。旧停止证明重验不能解除新保护，必须核验晚于事件且身份匹配的新停止证据。备份、恢复和权威迁移须保留保护表中的接纳权威、验证正文及解除证明，不能只恢复原释放凭据。Schema 41 或更旧 writer 必须拒绝新库；回退只能在停止新 writer 后恢复匹配旧版的完整恢复点，不删除事件或降低版本号。此变更没有执行生产迁移，也不使 Mac 获得完整后代停止资格。

### Schema 44/45：未准入队列与原工具批次恢复

当前数据库新增不可修改的队列 authority 绑定历史，原请求、顺序、期限和 claims 保持不变；备份与恢复必须一起保留原队列、绑定历史、Handle、授权预约和 Run 租约。只允许无回执、无准入且仍有效的队列绑定当前执行权，不消费次数或占用工作区。Schema 45 为原队列的工具批次关联增加写入校验；schema 44 及更早 writer 不能接管这一恢复语义，迁移后被最低 writer 版本拒绝；不得删除绑定、回改 Handle fence 或降低元数据版本来绕过，回退遵守原迁移前恢复点流程。

生产调度只恢复具有原受保护 Pi 批次、单个未准入队列且无消费回执的中断 Run。取得当前 Run 租约后，在读取工具列表前重新验证原 Scope、目标与权限，再加载原批次；原批准、输入、期限及已完成工具结果保持不变。已准入、有回执、已取消、恢复内容缺失或状态不明确的操作仍进入核对，不能重放；工具列表或请求内容改变也不能续接。历史队列若没有批次关联，不会因升级而获得自动恢复资格。实现、替身边界与本地验证见[Plan 的整轮续接记录](../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p2-queued-run-restart)。

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

安装后，执行过程的下一步提示必须来自已持久化 `ThreadExecutionState` 和当前有效 `availableActions`；不能仅凭旧页面状态显示停止、恢复或重试操作，也不能自动重发执行结果不确定的请求。命令非零退出且效果未断言时，Run 保持失败并提示先检查工作区。定向状态与页面单测不能代替安装产物的 DOM 路径及完整用户流程验收。


自动标题由正式模型组合注入 Run 组合：首次 Assistant 消息触发对活跃且无标题对话的检查，使用该 Run 的模型引用和首条用户消息的分类，沿用 Pi transport、披露检查与费用准入；Schema 49 起标题费用记在该 Run 专属的标题预算账户，标题结果不明只让该账户待核对，不挡住 Run 本身。正文可先显示，Run 结束前等待本地标题调用准入；标题响应异步完成，成功后写入受保护 Payload 并发布 Thread 改名事件。已有标题、手动改名和归档状态优先，失败只记录 `thread-title.failed`，不把标题失败改记为正文失败。停机时先停止 Run 循环，再等待标题请求结束；单次标题模型请求最多 20 秒或配置的更短期限，不能仅以正文完成判断所有模型请求已结算。

安装验收使用合成对话检查自动标题、刷新持久化和费用记录，再核对执行过程的模型请求、工具参数、执行与结果关联。记忆与上下文阶段仅展示发生记录，不公开原始正文；沿用 Thread 游标，不另设重连位置。以上变化不新增数据库 schema、配置字段或历史批量补名步骤，记忆检索不因生成标题而跳过。真实模型验收须使用本次获准的原模型和费用范围；隔离测试通过不等同于真实模型或迁移验收通过。

启用沙箱能力的 Agent 必须在本进程完成首次安装校验后才进入 ready，不能以 Worker 已就绪代替。受保护程序摘要可在安装及文件身份未变化时复用，安装外的程序仍逐次校验；这不改变本手册的数据格式、权威转移或停机步骤。恢复到另一安装或主机时，原进程缓存不适用，必须重新验证实际安装。Hermes 的 NVMe 私有只读挂载及设备回读另见 [SOURCE: docs/runbooks/hermes-control-center-upgrade-runbook.md]。

工具审批续跑快照同时保存本轮进展指纹和已完成工具结果，备份、恢复及迁移须连同其受保护 Payload 一起保留。恢复审批时只重放同一暂停点已有的结果，不再次执行对应工具；因循环保护中止的 Run 保持失败，即使随后生成了结果说明，也不能改记为任务成功。这些运行层行为不依赖具体模型提供商。

Schema 32 增加受保护原生历史快照、Run 内顺序和 Fork 固定引用。迁移须先取得既有机制核验通过的停机备份；升级后回读 `run_payload_artifacts`、对应 Payload 密文和 `thread_fork_lineage.runtime_history_json`，核对旧 artifact 内容未变、外键完整。恢复与迁移须保留清单引用的所有消息 Payload，不能只搬运聊天正文。重启后以新 Run 验证旧工具调用/结果可见且不重新执行；取消后核对实际结果及新请求，不能仅看服务 ready。旧 Trace 没有自动导入为完整历史，不能由 schema 升级推断旧会话已修复。回退需要匹配旧版本的整套已核验数据库备份，禁止旧二进制直接打开 schema 32，也不手工删除 migration ledger。

- 未保存完整审批暂停点的中断执行交给生产恢复组件后，Run 与 checkpoint 必须同时显示 `reconciling_external_result`，旧执行租约失效，已有结果引用保留；恢复不能重新调用模型或工具。此检查当前有本地 SQLite 证据，完整安装入口验证仍待完成。已经待核实的记录不重复占用初始扫描批次，不代表外部结果已经确认。

- `runtime-manifest.json`、build artifact manifest、package-lock 和 `git rev-parse HEAD` 能互相对应；内部 package 版本和外部依赖版本均为精确值，生产 workspace manifest 的每个直接外部依赖根及其闭包都存在，且安装树不包含 `@himawari-agent/testing`。
- `himawari doctor` 返回 ready，`himawari db status` 显示 managed schema、预期 migration sequence 和 `quickCheck: ok`。
- Worker 与 Agent Service 均从安装 prefix 运行，不依赖 repository cwd、TypeScript source、未声明 `../pi-mono` 或 testing adapter；Worker 先于 Agent Service ready。
- Worker ready 必须来自非空且完整验证的能力部署快照；`capabilityRef + version + artifact digest + platform qualification + runtime binding` 任一不一致时，真实能力 adapter 不得注册或执行。
- `service.ready` 的 model path、memory path 与 embedding descriptor 来自 strict configuration；deterministic profile 不初始化 Pi 或 Mem0，production Pi profile 只绑定显式 primary，embedding 不进入 Pi generation registry，而由 Mem0 projection 使用显式 dimensions（本次配置为 4096）。
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

<a id="installation-permission-evidence"></a>

### 安装权限验收证据

D15 的三条完整归档用例使用同一正式构建产物和匹配 Context。每条都真实运行 `--artifact` 安装 CLI；CLI 继续检查全部 payload 文件的全部字节。每条用例独立回读安装后全部目录及文件的路径和模式。`0002/new` 另调用已安装产品的 checker，重算安装后全部文件的内容摘要。`0077/new` 与 `0002/0700` 调用已安装产品的 `fingerprint` 模式，检查类型、权限、属主和文件身份，并按目录深度、顶层分组与文件模式选取代表文件，回读字节数、SHA-256 和模式。

`fingerprint` 是文件元数据身份摘要，不读取每个文件的全部内容。完整 `digest` 模式还逐文件使用 `O_NOFOLLOW` 打开，读取全部内容，并在读完后重新核对文件身份；`O_NOFOLLOW` 用来拒绝打开时已变成符号链接的文件。两条抽样用例只按上述范围陈述独立内容回读覆盖。真实安装 CLI 的全部内容检查不能写成每条用例又独立完成了一次全部内容回读。

原始归档清单读取、期望排序和抽样选择在文件级准备，发生在用例执行之前；记录收集与准备成本，不能把它当作消失的成本。默认关闭的 `HIMAWARI_TEST_INSTALLATION_REPORT` 记录真实 `spawnSync` 前后的 CLI 时间及退出元数据。日志追加发生在 CLI 计时区间之外，仍计入整个用例。CLI 时间只报告，退出码 `0` 不能代替完整用例断言通过。

本轮性能与验收规则见[D15 的前后耗时与后续验收](../backlog/BL-20261001-004-安-装-结-果-继-承-安-装.md#d15-timing-evidence)。正式第 3 层的并发运行结果单独记录；局部文件三次通过不证明完整批次、Mac 或生产主机已经通过。[SOURCE: docs/backlog/BL-20261001-004-安-装-结-果-继-承-安-装.md#d15-timing-evidence]

[↑ 返回阅读导航](#阅读导航)

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

后台核查已取得资源观察、但操作结果在核验证据或写入期间更新时，只要原资源事实和环境身份完全未变、恢复所有权仍有效，就在同一次恢复期限内读取最新操作结果并重新核验证据，再尝试保存释放事实。操作版本竞争本身不再作为失控原因。资源序号或身份改变、恢复被接管、证据失效和恢复超时仍按原规则拒绝；这项处理不会重新执行工具，也不解除缺少释放证明的占用。

资源核查失败时先看持久恢复终点与安全原因：`SANDBOX_RECONCILIATION_PERMISSION_DENIED` 表示宿主检查被拒绝，不代表原执行 Grant 应重新授予；`SANDBOX_CONTROL_TIMED_OUT` 是控制连接请求超时，`SANDBOX_RECONCILIATION_TIMED_OUT` 是整个核查任务到期；身份、目录或证据变化必须核对原绑定，不能直接采用当前 PID。`unresolved` 表示本次核查已经结束，不表示后台正在重试。失败细节经原 Job 的受保护 `restricted` Trace 保存，保留备份但不得直接输出到页面或普通日志。没有充分新释放证明时仍保留相交资源保护；不得用删除 claim 或重跑原工具来清除错误。

工具的前台结果交给模型之前，如果这次沙箱执行记录处于 `lost`（失去控制）或 `reconciling`（后台正在核查）——任务结束后记录都会先经过这两个状态，再由后台核查确认释放——交付会先等后台核查结束，最多 35 秒：核查确认 `released`（已释放）后照常交付；核查以 `unresolved` 结束时不交付，保留“结果未确认”，页面提示先停止本轮；35 秒后仍未结束时以 `SANDBOX_RECOVERY_UNSETTLED` 失败，不绕过核查直接交付。任务已退出且原 Job Host（负责启动和清理任务的宿主进程）仍在正常收尾，或原宿主已经确认进入停止阶段时，通过身份和签名检查的新鲜观察返回 `cleanup_pending`。它不是释放证明，不占用终态证据序号，也不据此让 Worker 取消正常收尾。后台核查在同一个 owner、revision 和原期限内继续观察：stop 只发送一次，之后每隔 250 毫秒 inspect，最长仍为 30 秒。执行期限到达不禁止清理；观察超过 1.5 秒、身份不符或控制失联不能当作正常 pending。已认证 `finished` 终态的签名时间固定，不作为活动心跳使用；宿主仍存活且任务退出、stdio 已关闭、SRT 已复位时，pending 观察时间取本次身份与终态核验时间，签名文件不改写。运行中观察仍核对原心跳时间，释放仍须证明原宿主和进程组已消失。核查期限届满仍保留占用并记录 unresolved。前台交付在核验证据期间若被后台核查更新记录，会在原 35 秒窗口内重读最新记录、重新检查披露权限和释放事实；仅重试版本确有变化的派发前准备，不重放已经派发的结果。要查看某一轮的这些状态变化和受保护诊断，用[查看某一轮执行的诊断记录](#diagnose-run)。

Unix socket 路径以 UTF-8 字节计数，macOS 最多 103 字节、Linux 最多 107 字节（不含终止 NUL）。启动在绑定前拒绝超长路径；应选择更短的独立 state root，不能依靠系统截断后的文件名或手工改 socket 名称继续运行。

| 症状 | 安全诊断 | 停止或有界修复 |
| --- | --- | --- |
| 解包报告 `ARTIFACT_SIZE_LIMIT`、gzip 损坏/截断或暂存写入失败 | 核对原始解压 tar 上限、普通文件逻辑内容上限、归档身份与匿名暂存所在盘余量；保留真实 stderr | 停止并保留证据，不提高上限、不跳过完整预检、不改用外部 tar 继续安装 |
| `ADMIN_ARGUMENT_INVALID` | 只读核对入口参数、绝对 config 路径和命令版本 | 停止并修正参数；不把错误输出当作服务 ready |
| `STATE_ROOT_PATH_UNSAFE` 或权限错误 | 回读规范绝对路径、owner/mode、authority file 和 runtime 目录 | 停止；人工修复已授权目录权限后重新 preflight，不递归清理未知目录 |
| `SQLITE_STATE_ROOT_LOCKED` | 只读检查 lock owner、PID、token、socket 和进程存活 | 保留活锁；确认 owner 已死亡且符合回收规则后再从完整 preflight 重试 |
| Worker UDS handshake/authentication failure | 核对 Worker/Agent 配置、boot token reference、deployment epoch/fence 和 socket owner | 停止 Agent；先修复同一运行 Worker，再重新启动，不降级为进程内执行 |
| `SERVICE_AUTHORITY_MISMATCH` 或 schema error | 对比 authority.json、SQLite deployment、config 和 bundled migration ledger | 停止；选择匹配的 prefix/state root 或走独立迁移/恢复决策，不手工改 authority |
| forced stop 后无法恢复 | 保留 lock/socket/SQLite 现场，运行只读 doctor、db status 和进程检查 | 若正式 recovery 未证明安全则停止，转入 backup/restore 或 incident diagnosis 的独立 Runbook |
| 需要 systemd/launchd 或 Hermes 操作 | 仅确认当前 Runbook scope 不包含服务管理器和远端部署 | 停止；选择经过验证且已授权的对应 Runbook，不猜测命令 |

### v2 原环境核查约束（2026-09-09）

Linux 安装必须包含同一候选包编译出的 `linux-host-guardian-main.js`、`linux-host-guardian.js` 和 `linux-host-group.js`，由既有 runtime digest 核验。Host 在创建 SRT 代理前确认同组清理进程就绪；正常退出继续使用 SRT `cleanupAfterCommand()/reset()`。Host 被杀后，清理进程核对原 Host 身份已消失，或准确匹配的原 Host 已为 `Z`（已退出、父进程尚未收尸），以及各成员 PGID/SID 与原 Host PID 相同、自身仍占据原组；发信号前再次核对身份，再在原清理期限内结束当前自身组。Agent 随后独立确认零成员；不能把发信号成功写成 `srtReset=true` 或已释放。

清理进程回收代理时不等待原 Host 收尸，但原 Host 处于僵尸状态，或原 Host 已消失而自身组仍在可信回收期间时，沿用 `cleanup_pending` 在原恢复期限内观察。僵尸、权限错误、身份变化和无法读取的组不能算空；到期仍未清空时保留占用，不增加宽限。真实恢复验收必须覆盖六处 finish 崩溃，并读回 Host 组为空、原结果恰好一次交付且未重新执行。规则见[Linux Host 组清理](../execution/specs/2026-09-24-isolated-tool-execution-design.md#linux-host-group)。[SOURCE: docs/execution/specs/2026-09-24-isolated-tool-execution-design.md]

清理进程属于当前安装和运行中的进程，不属于备份或迁移数据。不能按备份的 PID 重建它的活动身份；目标主机不能替源主机按旧数字杀组，目标启动成功也不证明源主机组已清空。新候选改变运行时字节，原冻结候选的资格不能复用。离组后代限制和 Mac 规则保留；本轮 Mac 行为未验证。

恢复必须保留既有受保护 Run trace 中的控制引用、终态证据及其 Payload；不得仅备份 SQLite 中的 PID。当前 Agent 权威通过原环境认证控制端口 inspect/stop，或读取原 Job Host 的签名终态；身份、目录 inode、策略或宿主变化时继续隔离，不能在目标主机按旧 PID 停止或重启。Agent 仅加载不含 SRT 启动能力的控制客户端。

Linux 前台清理证据要求原 PID namespace init 已消失、Host 自身进程组为空及完整终态，释放记录的 cleanup 为 `confirmed`。按 ADR 0033，已启动的 SRT 任务在原 Job Host 已退出、SRT 已复位、任务进程组（主进程及仍留在同一组的子进程）经 Job Host 终态证据确认全部消失，且 Linux 的 Host 自身组为空时，也释放占用，cleanup 记为 `process_group_gone`，含义是“停止未经严格确认”：用 `setsid` 等方式离开进程组的后代不被跟踪，可能仍在运行。Agent 登记 Job Host 时同时保存本机开机标识（macOS 的 `kern.bootsessionuuid`、Linux 的 `/proc/sys/kernel/random/boot_id`）；之后核查时开机标识已变，说明机器重启过、原进程组必然已不存在，不再联系原 Job Host，直接按 `process_group_gone` 释放。会话页面把这种释放显示为“停止未经严格确认”：工具步骤显示“已完成 · 停止未经严格确认”，被停止的一轮对话还会说明离开进程组的程序可能仍在运行、修改文件或联网。Job Host 在同一次开机里崩溃时，Agent 读取 Job Host 在任务启动后写入控制目录的签名开始记录（`started.json`），用操作系统保存的进程启动时刻（macOS 的 `ps -o lstart`、Linux 的 `/proc/<pid>/stat` 第 22 项）核对 Job Host 和任务进程组组长是不是原来的进程：Job Host 已退出，且原任务进程组已没有进程或组长编号已被新进程占用，并且 Linux 的 Host 自身组为空时，按 `process_group_gone` 释放；不属于上述可信清理等待的 Job Host 仍在、任务组长仍是原进程、任务组长已退出但组员还在、没有开始记录或记录核对不通过时继续 unknown。若宿主已写入 `finished` 终态，任务已退出且 SRT 已复位，但当时的 `taskProcessGroupGone` 为 false，Agent 仍使用同一份签名开始记录和当前进程身份核验原进程组；后来确认原宿主及原任务进程组消失，且 Linux 的 Host 自身组为空时，沿用已有 `process_group_gone` 证明解除占用，不修改旧终态文件，不把它当作严格进程树清理。终态证据没有进程组字段、进程组仍在或无法核验身份时继续 unknown；没有保存开机标识的旧登记在重启后也继续 unknown。端口失联、证据不完整和超时均不能解除相交占用。真实假数据探针不签发安装资格；不得把测试临时 bubblewrap/socat 的 PATH 配置用于生产，生产依赖位置须单独验证。实际安装、备份恢复和跨主机迁移的既有步骤及审批边界保持适用。

<a id="purge-unconfirmed-srt-records"></a>

### 删除旧的未确认 SRT 执行记录

新释放规则上线前，SRT 模式留下的一批执行记录清理结果为 `unknown`（未确认），至今仍挡住目录，也可能让所属 Run（一轮对话的执行）无法结束。按 ADR 0033，这些记录经所有者授权后整批删除，不逐条核查，也不做备份；所有者已在 2026-09-26 授权在所有机器上执行，这项授权只覆盖本节的删除。规则见 [SOURCE: docs/execution/specs/2026-09-24-isolated-tool-execution-design.md]。

1. 停止 Agent 与 Worker，确认数据库已按正常迁移流程升级到当前 schema。删除命令要取得 state root（产品状态目录）的独占锁，服务仍在运行时以 `ADMIN_TARGET_NOT_STOPPED` 拒绝，不删除任何数据。
2. 列出：`himawari sandbox list-unconfirmed --config <绝对配置路径>`。这一步只读，输出每条将被删除的记录：调用编号 `jobId`、所属 Run、所属对话 `threadId`、开始时间、占用的目录（主机编号和根目录编号，不含路径），以及每类关联数据的条数和整份清单的摘要 `digest`。把输出保存到本机受保护的证据目录。
3. 删除：`himawari sandbox purge-unconfirmed --config <绝对配置路径> --digest <上一步的摘要>`。命令先输出一行 `mutation.plan` 说明，再在一个事务里重新计算清单；摘要不同就以 `SANDBOX_PURGE_DIGEST_MISMATCH` 退出，不删除任何数据，这时回到第 2 步重新列出。成功时输出被删的调用编号和各类数据条数。
4. 再次列出，结果应为空清单。然后按正常流程启动服务。

删除范围：只包括本 Agent 名下、工具程序走 SRT（执行计划的 `backendRef` 为 `srt`）、不是未启动的预约、清理结果为 `unknown`、没有释放回执的执行记录，以及只属于这些记录的目录占用、冲突保护、观察记录、操作观察和执行 intent（执行动作前写下的“准备做这件事”的记录）。不删除：已释放的记录、未启动的预约、严格模式（任务环境）的记录、其他 Owner 或 Agent 的记录，以及排队记录和它不可删除的授权绑定、调用回执、Run、对话、消息、Payload（加密保存的正文）和审计日志。

留痕：`deletion_tombstones` 为每条被删记录写一条 `sandbox_execution` 删除标记，保存原执行计划（只有编号、引用和摘要，不含工具输入输出），供界面找回对应的工具步骤；另写一条 `sandbox_unconfirmed_purge` 汇总，保存摘要、被删编号和各类条数。`audit_records` 写一条 `sandbox.unconfirmed_records_deleted` 审计事件，目标是清单摘要。

删除后的效果：这些记录不再挡住目录；某个 Run 如果只因这些记录没能结束，Run 结束检查不再把它们算作未释放的资源，已准入但执行记录已删除的排队记录也不再阻止 Run 结束。删除不会停止任何进程：原工具程序或离开进程组的后代如果仍在运行，可能继续写入目录，这是 ADR 0033 中所有者已接受的风险。删除不可撤销，没有回退步骤；数据库恢复到删除前的恢复点会让这些记录重新出现。删除后，历史对话里对应的工具步骤显示“执行记录已删除”，不显示为已完成。验证来源：[真实命令行与 SQLite 回归](../../test/integration/sandbox-unconfirmed-purge.test.ts)。

<a id="diagnose-run"></a>

### 查看某一轮执行的诊断记录

工具执行出错或一轮对话卡住时，失败细节保存在受保护诊断里（加密保存的 Trace 记录，页面和普通日志都不显示）。管理员可以在服务所在的机器上，用管理命令行读取某一个 Run（一轮对话的执行）的诊断：

`himawari diagnose run --config <绝对配置路径> --secret-dir <密钥目录的绝对路径> --run <Run 编号>`

- 只读：以只读方式打开数据库，不取 state root（产品状态目录）的独占锁，服务运行时也能用，不修改任何数据。
- 输出一行 JSON，包含三部分：
  - `run`：这个 Run 的编号、所属对话 `threadId`、状态和创建、更新时间。
  - `sandboxJobs`：这个 Run 的每一条沙箱执行记录（沙箱是隔离运行工具程序的环境）：调用编号 `jobId`、工具调用编号 `toolCallId`、当前序号、资源状态 `supervision`（例如 `controlled` 受控、`lost` 失去控制、`reconciling` 正在核查、`released` 已释放）、清理结果 `cleanup`、原因码、后台核查记录 `recovery`、每一步观察记录 `observations`，以及结果投递记录 `intents`（把结果交给模型或继续执行的记录）。
  - `diagnostics`：解密后的诊断正文，只包括工具诊断（`runtime-tool-diagnostic:*`）、沙箱控制诊断（`sandbox-control:*:diagnostic:*`）和每次控制检查的原始观察（`sandbox-control:*:observation:*`）。不输出模型输入、工具输出，也不输出沙箱控制连接的登记记录（其中含控制凭据）。某一条解不开时，这一条只给出错误码（例如密钥不可用时为 `PAYLOAD_KEY_UNAVAILABLE`），其余照常输出。
- 输出可能含文件路径和错误原文，属于私人数据：只保存到本机受保护的证据目录（目录 `0700`、文件 `0600`），不贴到页面、普通日志或公开位置。在真实数据上运行前须得到所有者同意，并以能读取密钥目录和数据库的账号执行。
- 错误码：Run 不存在或不属于本配置的 Owner、Agent 时为 `ADMIN_RUN_NOT_FOUND`；参数缺失、重复或配置里负责 Payload 加密的密钥引用不是恰好一个时为 `ADMIN_ARGUMENT_INVALID`。两种情况都不输出任何记录。

验证来源：[真实命令行与 SQLite 回归](../../test/integration/admin-diagnose-run.test.ts)。

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

Schema 35 新增 `sandbox_admission_queue`。备份应同时保留队列次序、冻结请求、调用回执、Handle 和额度预约；恢复不能把已准入请求重新派发。等待中的请求没有文件占用，也没有消费回执；取消、期限届满或授权失效后不能取得资源。当前版本允许工具对象重建后在完整执行身份不变时继续原队列：保留原目标、回执编号、期限与次序，准入事务再次核对冻结请求并只承诺一个回执。跨 boot/fence 续接仅适用于具有原工具批次关联且未准入、无回执的原队列；其他情况仍按中断核对处理。恢复时不能通过删除队列或更换调用身份绕过原次序。

发送 `work.execute` 前，在 Worker 接收 Handle 的异步等待结束后，再读取原冻结 Scope、当前 Grant/来源策略、Run、Handle 和最新资源上限；期限届满、撤销、目标换位、策略停用、能力停用或资源预算收紧时禁止发送执行消息。已批准记录仍保留；此前准入事务已经承诺的调用回执与额度不退回，也不据零执行消息伪造宿主释放证明。Worker 启动及 Payload 披露仍保留各自的现时核验。回归包含真实 SQLite、原目录身份和额度记录，Worker 传输及策略编辑边界为受控测试；不代表已部署或经过真实外部服务验收。

受控文件发布先完成并同步暂存内容，再发布最终路径。已保存的文件操作记录可包含暂存 inode 证据；恢复只核查最终文件身份与内容，并清除属于该操作的暂存硬链接，不重复写入。仅内容相同不足以证明是本操作产生的效果。文件候选位于原授权目录的 `.himawari-recovery/`；它不属于产品数据库备份包，不能据数据库恢复宣称候选内容或目标文件已恢复。

Schema 35 也是旧 writer 的版本屏障：Schema 34 或更旧代码不理解持久公平队列及文件发布归属，禁止并行写入新库。回退须停止服务并恢复匹配旧版本的完整恢复点，不能只删除新表或降版本号。当前文件原语已有本地 macOS 回归证据；跨 Worker 的细粒度文件占用、Linux 文件系统资格和部署升级仍须独立验证。

### Schema 36 固定文件目标合同

Schema 36 不重写旧记录；它为新增 JSON 字段建立 writer 版本屏障。`pi-coding-tool` 合同 2 在受保护 Scope 中保存 `sandbox-file-target.v1`：相对路径、授权根以下的已存在父目录身份，以及原文件 inode 和内容摘要。目标不存在与父目录尚未创建分别记录；父目录缺失时继续协调整个授权目录，不伪称已有精确父目录身份。备份必须保留原 Scope Payload、其摘要和对应 claim，不能恢复时按最新文件内容重建原基线。

合同 1 继续使用目录级协调。合同 2 仅用于固定目标 read/write/edit；新 Worker 在启动 Job Host 前拒绝缺少文件快照的新合同，旧 Worker 会拒绝未知合同版本。它仍复用原 Job Host、SRT 与 Pi Operations；不能仅在登记数据里把版本改成 2 就视为安装资格通过。新安装的实际字节、冻结快照和目标主机资格必须匹配后才可采用新合同。

恢复不能把目标版本冲突改写为允许覆盖。文件型 claim 同时保留父目录名称槽位和当前文件身份，原子替换后名称槽位仍冲突；硬链接、符号链接和跨设备目标被拒绝。名称保守归一化可能在区分大小写的文件系统上多排队，不能据此宣称所有别名场景的并行资格已通过。默认核验读取仍要求当前路径不变；固定文件读取可读完已经打开的完整旧版本，不能推广成任意原地写入都可并行。回退仍要求停止服务并恢复匹配旧版本的完整恢复点。

### 固定文件合同 3：先准备候选，再取得提交占用

`pi-coding-tool@3` 仅用于固定 `write/edit`；该合同沿用 Schema 41 的保存结构，当前整体数据库已由对话标题预算账户的迁移推进至 Schema 49。准入前以 Pi Operations 的不可变快照准备完整候选，受控暂存区保存候选内容及工具结果；其 inode、摘要与原文件版本绑定到已有受保护 Scope artifact。此阶段没有调用消费回执或工作区占用，正式目标及缺失父目录保持不变。提交仍复用原持久队列、Worker、发布记录和原宿主释放证明；不能因候选已准备就提前派发或宣布保存成功。细节见[本批实施与验证范围](../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#implementation-record)。

备份、迁移与恢复须一起保留 Scope Payload、排队身份及工作区 `.himawari-recovery/` 中的候选与结果；数据库备份不包含这些暂存文件。候选本身可能是唯一结果，不自动清理、不按当前文件重建旧基线、不覆盖后续编辑。准备后取消或版本冲突不授权重放；跨 boot/fence 重新绑定只允许原批次关联完整、未准入且当前权限有效的队列，固定文件候选的真实 Worker 恢复联合验收仍待完成。旧程序不理解合同 3 或新增 Scope 字段时必须停止对应执行，不删字段降级，也不能仅凭 Schema 相同认定回退兼容。

<a id="pi-preparation-prewarm"></a>

**预热准备线程**

准备入口、线程入口和 [Pi 准备线程池](../../packages/runtime-pi/src/pi-file-preparation-pool.ts)必须随同一安装包交付。Agent Service 在安装声明包含 `pi-coding-tool@3` 时最多保留一个未消费的预热线程，预热只加载 Pi 模块，不接收请求输入。该线程采用 256 MiB 额度，对应 V8 old generation 192 MiB、young generation 32 MiB、code range 16 MiB 和 stack 16 MiB，`execArgv` 为 `[]`。只有已 `ready` 且四项上限与请求完全相同的线程才能接收该请求；其余请求立即冷启动，不排队等待预热。每个线程只接收一次实际输入，消费后的补充发生在该请求与线程停止完成之后。

预热上限为 60 秒（60000ms），从创建线程前开始计时，接收 `ready` 时再次检查期限。失败后不限重试总次数，退避依次为 1000ms、2000ms、4000ms，之后逐次翻倍，上限为 300000ms。失败线程确认实际退出后才安排下一次重试；同一时间最多一个未消费的预热线程。恢复到 `ready` 时重置退避为 1000ms。首次进入失败状态写一次 `pi.preparation.warmup_failed` 及稳定错误代码，恢复到 `ready` 时写一次 `pi.preparation.warmup_recovered`；连续重试不重复写失败日志。这些日志只说明预热状态，请求仍可立即冷启动，不排队等待恢复。

实际准备预算保持 `min(maxWallTimeMs, maxCpuTimeMs)`，常规 10000ms 预算不变：冷启动计入模块加载，预热请求从实际输入交接开始计时，结果与线程终止均须在预算内完成。验收须覆盖无输入预热、上限不匹配时冷启动、拒绝第二份输入、取消和超时，以及超过三次预热失败后的恢复、退避递增与上限、失败期间请求冷启动成功。服务关闭取消待定重试，不再创建新线程，并等待池拥有的全部线程退出。即使某个线程停止操作失败，关闭也先等待全部线程停止操作和尚未结束的准备请求结束，释放池的线程所有权，再返回停止错误。准备调用返回、空闲槽消失或进程锁释放不能分别代替这一检查。

Hermes r54 五次独立测量的额外进程 RSS 中位数为 110.910 MiB、最大 114.355 MiB，容量安排须计入这一个空闲预热线程；测量条件与边界见[架构文档的实测内存段](../architecture-v0.1.md#pi-file-preparation-memory)。验收分别记录空闲时进程 RSS（实际驻留内存）增量和线程 ready 时的堆读回；V8 上限不是 RSS 硬上限。备份、恢复或权威迁移不搬运进程内预热线程，也不因预热重新授予调用权限。

确定尚未派发的固定写入版本冲突返回 `FILE_VERSION_CONFLICT`，原调用重放只返回已知未执行事实。Pi 现有循环中的新调用携带受保护历史关联，宿主必须用原请求、未派发诊断及结果记录复核；关联不授予权限，新内容仍经原 ActionPolicy，确切单次批准不能扩大。备份需保留 `runtime-file-read:*:conflict-lineage` 与原工具诊断/结果 Payload。循环的受保护进度状态新增冲突计数；同一 Run 连续工作中累计四次版本冲突后停止继续调用工具并进入原有结果说明路径，读取或更换内容不清零。不能用忽略该计数或关联的旧运行时恢复此类 continuation。Worker 已派发后失败、结果未知和跨 boot 自动重绑定仍不得冒充可自动重试。

新合同尚无生产切换或 Linux 资格。采用前须对实际安装字节、最终运行身份和目标文件系统完成资格并明确选择合同 3；旧合同 1/2 的行为保留，普通源码升级不自动改部署绑定。本节不授权启用模型、付费调用、生产迁移或部署。

### Schema 37 固定文件发布恢复

Schema 37 为原调用的恢复结果建立 writer 屏障。恢复结果保存在受保护的 `pi-file-recovery:<invocationId>` Trace artifact 中，与原 Worker 输出分开；不覆盖原输出，也不创建第二个调用回执。旧 writer 不理解该来源，不得直接写入新库。

固定文件合同 2 的受信 runner 在保存前将 Scope、输入摘要、候选 inode、完整父目录身份和内容摘要写入本次私有 Job 目录；保存后等待核验记录落盘，再返回结果。记录失败阻止发布，发布后的记录失败则保留候选身份用于核实。私有记录不含候选正文。它们与授权目录内 `.himawari-recovery/` 的候选一起属于现场恢复证据，单独的产品数据库备份不包含这些文件；恢复数据库不能被报告成同时恢复了工作区与私有 Job 目录。

Agent 只有在原 journal 已接纳永久释放记录且没有新保护时才核实文件。已保存的核验记录作为历史事实保留；缺少最终核验记录时，必须匹配原候选 inode、内容及发布时父目录。核实可清除该次发布留下的私有硬链接别名，不能重新发布候选、修改用户后续编辑或启动旧工具。仅内容相同或目标名称相同不足以证明本次保存成功。

结果交接还须核对原请求的分类、当前披露权限、恢复 artifact 与受保护交接回执。该实现当前处理固定 write/edit 的缺失或 unknown 结果；已保存的错误结果保持不变。真实 Job Host 释放、跨 Worker 与 Linux 平台资格须单独验证；本地受控进程证据的集成测试不能代替这些资格。回退仍须停止新 writer 并使用匹配版本的完整恢复点，不删除恢复事实来允许旧程序接管。

### 工具执行前检查点与恢复引用

生产装配在进入产品工具前，复用现有 Pi 批次格式和加密 Payload 保存检查点。执行 intent 中的 `tool-batch-recovery.v1` 引用绑定原模型工具调用，内部文件阶段共同指向该父调用；备份、恢复及迁移须一同保留这些关联。保存失败的工具没有进入执行，页面归为“尚未派发”；旧记录缺少检查点时不能补造。引用本身不授权跨 boot/fence 重放。对原 Run 未取消、未过期，已有确定结果与永久释放回执且原批次凭据完整的调用，调度器可领取原 Run 的新租约，仅交付旧结果并继续 Pi；原工具不会再次启动。缺失快照、权限变化、未确认控制或模型费用仍未知时保留待核对状态，不能通过重发清除未知。恢复沿用原模型 stream ordinal，保留原调用回执、交付 intent 与受保护 Payload；没有新增表或迁移。详见[已核验工具结果恢复合同](../execution/specs/2026-09-28-sandbox-tool-result-resumption-design.md#恢复条件与用户行为)。

创建本机 Job Host 前还需保存 `sandbox-preparation-control.v1` 受保护记录，其中的控制密钥只用于核验原宿主，不授予启动权限。备份与迁移须保留该记录；旧数据不回填。已认证的 `host_never_started` 预留释放可交付确定未启动的失败，不能伪造 bound 记录；已取得启动权或使用旧协议且缺少最终证明时仍待核对；登记前封锁仅适用于带新协议字段的计划。首次准备、登记或 bind 失败通过 `sandbox-control:*:diagnostic:preparation-failure` 尝试保留有界阶段及机器码，使用 `himawari diagnose run` 查询，不在普通日志中记录。Payload 或 Admission 通道在成功握手后发生传输失败，失败操作按原结果结束；后续操作使用原 peer/boot、凭据与现有校验重新握手，并发调用共享一次握手，不重发失败的执行请求。准备诊断也使用同一机制。Worker 就绪状态反映两个通道当前状态；后续就绪探测可触发共享恢复，成功后才恢复 ready。握手失败仍未就绪，关闭期间迟到的回复不能恢复 Worker。 正在停止任务时，保留 broker 到清理观察保存结束，再由 close 统一断开。握手或当前权威校验失败时仍可能没有持久诊断，不能据此声称错误已完整留存。详见[准备控制恢复合同](../execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md#权限与失败边界)。本批没有新 migration，不改变本 Runbook 的现场操作授权要求。

Job Host 启动先建立原私有 IPC 监督，再动态加载 SRT 与策略编译模块；新鲜准备消息不会因后续加载慢而过期。安装验收应覆盖慢加载后完成准备、到达即过期的消息被拒绝、加载失败无用户任务启动，以及超过原 30 秒准备上限仍失败。1.5 秒消息年龄、任务总期限、认证及签名终态格式不变；不能把加载期间的心跳当作 ready 或清理证明。准备期间，任务期限早于或等于 30 秒准备上限时，受保护诊断必须为 `JOB_HOST_EXECUTION_DEADLINE`，结束原因为 `deadline`；只有准备上限更早时才是 `JOB_HOST_PREPARATION_TIMEOUT`。安装验收须检查两个先后边界及相等边界，取消或结束后不再追加超时分类，不能把两种诊断码都接受为正确结果。`dependencies` 阶段失败且 `srtReset=false` 时仍须保留未确认状态，不能凭“任务未启动”直接释放。详细合同见[依赖加载期间的启动监督](../execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md#startup-supervision)。本修订没有部署动作；云端定向测试不能替代最终产品资格；用户已无限期推迟 Mac 验证，Mac 行为未验证。


### Schema 38 纯联网范围

Schema 38 为 `sandbox-scope.v2` 和 `network_only` 合同建立 writer 屏障；这类前台 Job 使用自己的私有临时目录，不保存目录 Grant，也没有共享文件 claim。备份和恢复仍须保留原网络授权、Handle、调用回执、Scope Payload、私有环境和资源释放证据。空 claim 只说明没有用户文件占用，不能据此认定进程已结束或重发原操作；网络外部效果仍按命令退出事实记录，不宣称无副作用。

公开搜索新增显式 `runPolicy.publicSearch.scopeSource: private_temp` 路由，不能同时配置 `grantId`；安装清单须使用相匹配的 `private_temp` / `network_only` 操作合同，纯联网清单可不含用户目录根。旧目录型路由和合同保持原权限语义，升级不会自动切换部署配置。配置或模型绑定变化会使原搜索委托失效，需按现有入口重新授权；保存搜索结果是另一次获准文件操作。

验证分别检查无目录 Grant 的搜索准入、零共享文件占用、原网络授权撤销、私有工作目录及真实沙箱越界拒绝。Schema 37 或更旧 writer/Worker 不得处理新合同；回退须停机并恢复与旧版本匹配的完整恢复点，不能删 migration ledger 降级。本批源码和受控测试不构成部署授权，也不替代目标平台与实际安装资格。

### Schema 39 自动审查记录

Schema 39 新增 `automatic_action_reviews`，在模型调用前保留唯一请求身份，完成时与原审批及一次性 Grant 同事务写入。备份和恢复须保留审查记录、Owner 委托版本、原请求摘要、受保护输入/输出 Payload、审批来源和原模型费用记录。`pending` 只表示没有已提交决定，不能推断模型未调用，更不能删除该记录后重试付费调用。已完成记录读回历史决定，不重新派发工具。

自动审查默认未装配。当前委托只接受精确请求摘要，批准不能扩成其他文件、命令或长期授权；写入时使用 writer 当前时间，重新核验请求期限、委托版本和 Run 执行租约。已有人工请求或决定优先，撤销、取消、过期及执行权变化阻止迟到批准。审查等待不创建共享文件占用；自动批准保存 `automaticReview` 来源，不能解释为用户对本次操作点击了确认。

若明确配置 TypeSafe JEV 审查，`modelDescriptors` 必须保留独立的 `specialist` 身份与单价，primary 只供 Pi 对话模型使用。审查调用必须取得当前 Run 启动实例持有的执行租约并通过模型预算准入；缺少租约、额度、有效模型身份、置信度或实际用量时不得自动批准。仅 429/529 明确拒绝可在期限内重试，模糊网络失败和未知用量不得按估算结算或重放。受控本地测试不代表真实 TypeSafe 调用或生产启用。

恢复不会自动续跑未完成审查，也不会启用模型。当前真实模型接入、披露和费用配置仍须按实施 Plan 单独完成；受控模型替身与 SQLite 回归不代表真实服务验收。Schema 38 或更旧 writer 不得写入新库，回退不得删表或修改账本以绕过版本屏障，也不得覆盖升级后新增的决定和消息。

模型审查适配器复用现有受信模型入口和预算账本，生产配置仍未装配。取消信号在调用开始前释放预约；开始后缺少完整用量时保存 `cancel_unresolved`，不能按零费用处理；完整用量已经到达则仍按原价格快照结算。恢复时须保留这些费用事实，不能把没有批准等同于没有模型费用。Pi 的 Stop 信号已传入生产文件/编码授权入口；取消审查等待不新建人工确认，超时则保留人工路径。当前验证使用受控模型流、真实 Pi 会话与 SQLite；真实模型启用和页面联合验收尚未完成。信号已取消不能替代 Worker 进程及后代已停止的现场证据。

自动审查开始和决定现在与审查记录同事务写入现有 Run 执行事件，并通过既有 Thread 通知提供页面读回。备份须保留两者；事件缺失不能从模型正文补造用户确认或执行效果。请求 Thread 必须与 Run 归属一致；重复决定不重复产生步骤。页面的审查耗时只取已保存的开始与决定时间，缺少任一边界时不推算；自动允许不代表用户点击确认。此路径已有真实 SQLite 与隔离 HTTP 夹具下的 Chrome 回归，真实模型和 Worker 联合验收仍未完成。

取消 Run 先保存取消决定，再独立请求运行时、原 Worker 和资源管理器停止；一处报错或等待不阻止其他停止请求发出。清理错误汇总返回，不能将 Run 的 `cancelled` 状态当作进程已结束。对已取消或失败的 Run 再次停止时，只重试仍活跃的运行时/Worker 并重新核对资源，不重启模型或工具。执行权中断也保留资源停止端口的同步异常，不能漏掉清理失败。当前回归采用受控运行时/Worker 与真实协调器，平台进程树清理仍须独立核验。

清理端口的调用方等待现在有独立的 30 秒上限，取消、执行权中断及运行时完成均适用；这不是资源释放证明，也不替代平台停止宽限和按错误类别的恢复政策。运行时已生成输出但清理拒绝或超时，保留输出与受保护原因，Run 进入 `reconciling_external_result`；恢复不得重新执行模型或工具。取消、失败状态与仍需清理的资源分别核对，迟到成功不能直接覆盖原未知状态。备份和权威迁移须一并保留该检查点、清理事件及原资源证据。

同一 Run 有多个资源时，停止入口会继续枚举后续页并独立请求各资源停止，最后汇总清理结论。一条资源等待或报错不阻止其他资源收到停止；只有每条资源均有永久释放回执且无残留保护时，整体才报告已释放。

长期 Grant 的现时覆盖检查与创建条件一致：仅允许低风险 READ；新请求风险提高或动作类别变化时重新询问，不能因资源相同就复用。恢复、转移和升级时保留原 intent、审批及额度记录，不把过去拒绝改成批准。具体写入内容仍使用精确单次批准；记住搜索选择会为新请求派生独立单次 Grant，不是长期写权限。参见[单次批准与范围授权实施记录](../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p2-scope-continuity)。

## 旧程序执行器的尾部输出（2026-09-29）

程序主进程退出后，执行器继续读取 stdout/stderr，直到流结束，或输出连续安静 100ms；每段新输出重新计时。原期限、取消和输出上限在等待期间继续生效，返回的结构化字节不追加说明。该修复不改变能力准入、Mac 原生程序的资格要求、安装/迁移/恢复步骤或操作授权；退出码 0 仍不能代替文件效果校验或证明所有后代已停止。回归及批次范围见[工具执行排查计划](../execution/plans/2026-09-28-tool-execution-audit-plan.md)。

[SOURCE: docs/execution/plans/2026-09-28-tool-execution-audit-plan.md]

## Bash 主进程退出后的输出等待（2026-09-29）

依据 [ADR 0040](../adr/0040-background-output-closed-after-bash-returns.md#decision)，Bash 主进程退出、后台程序仍占用输出时，连续安静 100ms 后正常返回原退出码和已读输出；新输出重新计时，自然关闭不加说明。调用结束时关闭读端，不主动结束后台程序；未重定向的后台程序之后继续向原通道写输出，可能按已接受的行为退出。需要长期运行的程序应把 stdout/stderr 重定向到文件；已重定向或不再输出的后台程序可以继续运行。

模型结果使用以下说明原文：

> 仍有后台程序占用这次命令的输出，它之后的输出不会显示在这次结果里；如果它继续往这里写输出，会被系统结束。需要长期运行的程序，请把输出重定向到文件，例如 `npm run dev > dev.log 2>&1 &`。

说明不计入命令自身的输出上限，但计入整份工具结果 JSON 的上限；超过时沿用 `PI_RESULT_OUTPUT_LIMIT`。不另设额度或放宽任何上限，原期限、取消、资源与输出检查保持。目录释放仍按平台清理证明核验；Linux 同次开机还须 [Host 自身组为空](../execution/specs/2026-09-24-isolated-tool-execution-design.md#linux-host-group)。`process_group_gone` 不证明主动离组的后代全部停止。现有页面后台列表不能列出前台 Bash 自行脱离进程组的后代，这是已知限制，不能用列表为空证明没有后台进程。此改动不增加安装、迁移或恢复步骤，不改变本手册的操作授权要求。

[SOURCE: docs/adr/0040-background-output-closed-after-bash-returns.md]
