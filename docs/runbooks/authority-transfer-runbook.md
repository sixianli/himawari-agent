---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:387d8994b7abef1d5002a985e9c574d9a085ebc989fcc6c23b2b4c3170f94506"
supersedes: ""
superseded_by: ""
date: "2026-08-27"
---

# 停机加密 Authority Transfer Runbook

<!-- runbook-contract:
- packages/platform-node/src/capabilities/isolation.ts
- packages/platform-node/src/process-output.ts
- packages/persistence-sqlite/src/sqlite-sandbox-reservation-release.ts
- packages/persistence-sqlite/src/sqlite-sandbox-reservation-never-started.ts
- docs/execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md
- docs/execution/specs/2026-09-29-sandbox-deadline-settlement-design.md
- apps/agent-service/src/production-run-expiry.ts
- scripts/operations/hermes-ui-session-start.mjs
- apps/agent-service/src/production-sandbox-lost-result-recovery.ts
- apps/agent-service/src/production-sandbox-stream-result-recovery.ts
- apps/agent-service/src/production-tool-result-recovery.ts
- packages/persistence-sqlite/src/sqlite-sandbox-tool-result-recovery.ts
- packages/execution-contracts/src/sandbox-execution-v2.ts
- apps/agent-service/src/production-copy-save.ts
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
- packages/runtime-pi/src/pi-runtime-adapter.ts
- packages/application/src/ports/intelligence.ts
- packages/persistence-sqlite/src/sqlite-run-resource-guard.ts
- packages/application/src/ports/run-lifecycle.ts
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
- packages/persistence-sqlite/src/built-in-identity-recovery.ts
- packages/persistence-sqlite/src/migrations/0031_built_in_identity.sql
- packages/application/src/ports/built-in-identity.ts
- apps/agent-service/src/production-managed-tasks.ts
- apps/agent-service/src/production-sandbox-stream.ts
- apps/agent-service/src/production-sandbox-services.ts
- apps/execution-worker/src/production-sandbox-execution-v2.ts
- packages/execution-contracts/src/sandbox-readiness.ts
- apps/agent-service/src/production-sandbox-output.ts
- apps/agent-service/src/production-sandbox-control.ts
- packages/application/src/services/sandbox-execution-reconciliation.ts
- packages/runtime-sandbox/src/job-host-control-client.ts
- packages/runtime-sandbox/src/machine-boot.ts
- packages/runtime-sandbox/src/linux-namespace.ts
- packages/application/src/ports/sandbox-execution-journal.ts
- packages/application/src/services/sandbox-execution-projection.ts
- packages/persistence-sqlite/src/sqlite-sandbox-execution-operations.ts
- packages/persistence-sqlite/src/sqlite-capability-invocation-operations.ts
- packages/application/src/services/sandbox-startup-recovery.ts
- packages/application/src/services/sandbox-job-lifecycle-service.ts
- packages/application/src/services/runtime-continuation-service.ts
- packages/application/src/ports/run-checkpoints.ts
- packages/runtime-pi/src/pi-tool-batch-continuation.ts
- docs/adr/0023-durable-hitl-execution.md
- packages/application/src/services/run-execution-input-service.ts
- packages/application/src/services/run-coordinator.ts
- packages/application/src/ports/run-dispatch.ts
- packages/domain/src/run-state.ts
- apps/agent-service/src/production-run-reconciler.ts
- apps/admin-cli/src
- apps/agent-service/src/service-main.ts
- apps/agent-service/src/production-service-lifecycle.ts
- apps/agent-service/src/production-memory-worker.ts
- apps/agent-service/src/production-authority-lifecycle.ts
- apps/agent-service/src/production-execution-client.ts
- apps/execution-worker/src/service-main.ts
- packages/domain/src/durable-state.ts
- packages/persistence-sqlite/src/sqlite-authority-transfer.ts
- packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts
- packages/persistence-sqlite/src/sqlite-run-lifecycle-operations.ts
- packages/persistence-sqlite/src/sqlite-run-checkpoint-operations.ts
- packages/persistence-sqlite/src/migration-engine.ts
- packages/persistence-sqlite/src/migrations
- packages/persistence-sqlite/src/state-root-lock.ts
- packages/platform-node/src/host-secret-source.ts
- packages/platform-node/src/payload-protector.ts
- packages/platform-node/src/state-root-layout.ts
- packages/platform-node/src/strict-configuration.ts
- docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md
- docs/adr/0003-single-logical-agent-authority.md
- docs/adr/0019-offline-authority-transfer.md
- packages/application/src/ports/capabilities.ts
- packages/application/src/services/execution-worker-service.ts
- packages/execution-contracts/src/payload-broker-v1.ts
- packages/platform-node/src/payload-uds-transport.ts
- packages/platform-node/src/capabilities/node-capability-runtime.ts
- apps/agent-service/src/production-payload-broker-handler.ts
- apps/execution-worker/src/production-payload-broker-client.ts
- apps/execution-worker/src/production-worker-composition.ts
- packages/persistence-sqlite/src/sqlite-sandbox-authority-withdrawal.ts
-->

## Scope

2026-09-11 聊天运行体验更新：可撤销的联网搜索设置保存在既有 Product State，关联审批记录通过 `policyAuthorization` 标明真实授权来源，不新增迁移文件。备份/迁移须共同保留设置 revision、派生 Grant 与审计；关闭设置后，旧 Grant 的消费和 Sandbox 准入被拒绝。恢复后核对设置与当前固定 Exa 路径、主机/目录路由和模型披露身份一致，配置绑定不同不能沿用开启状态。它不授予其他文件、命令或网络权限。Pi 更新合并仅影响尚未持久化的连续累计片段，不能删除已持久化记录或工具边界。`runPolicy.timeZone` 是显式 IANA 时区，只用于新 Run 的时间上下文；历史已冻结内容保持原值。

未配置受保护安装时，每个进程首次使用某个期望摘要会在独立工作线程完整读取 runtime 字节，同时记录全部目录与文件的元数据指纹；此后每次调用在同一工作线程只复核元数据（设备号、inode、权限、所有者、大小、修改时间和纳秒级 `ctime`），任何差异都丢弃指纹并重新完整审计，见 [SOURCE: docs/adr/0034-runtime-verification-by-inode-metadata.md]。安装必须包含编译后的 `sandbox-runtime-digest-worker.js`。ADR 0034 沿用 ADR 0028 的受保护 Linux 路径：已经独立验证权限的安装，在相同进程、相同 root 保护版本身份下复用首次完整审计；每次仍验证当前进程和保护记录，失效立即拒绝，不接受普通时间缓存。保护记录不属于备份或迁移数据，目标主机必须重新建立身份、权限与安装资格，不能复制源主机记录作为证据。此变化不改变数据格式、迁移权威或停止条件。参见 [SOURCE: docs/adr/0028-protected-runtime-installation.md] 和 [SOURCE: docs/runbooks/hermes-control-center-upgrade-runbook.md]；本 Runbook 原有操作范围保持不变。

2026-09-11 合同核查：新增离线初始化、目录 Grant 与能力登记仍属于当前身份的停机管理操作，不修改本 Runbook 的备份/迁移数据格式。恢复必须保留其审计、目录身份与授权；不能在已恢复 state root 再运行首次初始化，不能将原主机安装资格当作目标主机资格。启动后快照按原字节复查，工具每次仍检查当前主机与授权；模型失败展示改进不改变原始记录和费用核算。

本次 Web 重构追加 schema 30：`runs.model_selection_json` 保存用户提交时选择的模型引用和思考深度。备份、恢复和迁移必须保留此列及原 Trace/Payload；恢复不能用当前输入框的选择改写旧 Run，也不能给旧记录补造选择。目标配置仍须支持原模型、深度、预算与披露，缺失时报告失败而不是静默替换。浏览器的主题、主题色和未发送草稿属于客户端偏好，不随服务数据库恢复。

控制中心查询执行过程时仅返回经过归属校验和字段筛选的展示投影；恢复检查应核对多轮历史、模型选择与审批等待，不直接开放原始 Trace JSON。取消仍经过 RunCoordinator。上述展示投影已由受控 SQLite/Pi 适配与浏览器测试验证。2026-09-11 Hermes 同机升级、迁移前快照与真实服务重启由专用 Hermes Runbook 和验收记录约束；未执行跨主机权威迁移或从备份完整恢复服务。

R8 的网络出口和活动连接属于原 Job Host，不随备份或权威迁移恢复。Worker 对 foreground、background、service 均在监督循环重查当前授权，失败后请求停止并关闭出口；Job Host 还在 DNS 解析前、拨号前通过原认证 Worker IPC 逐次核对 Agent 当前 scope，已有连接按 250 ms 周期重查；每次回复只供原检查使用，1500 ms 未答、撤销、断开或身份变化均拒绝并关闭出口。Worker 与 Job Host 必须来自匹配安装产物，不能用旧组件缺少核验回调作为继续联网的理由；TLS 内部请求不可见，周期核验不构成每个加密请求的原子授权。恢复的旧 Grant 或连接计数不能恢复网络权限。目标需要自己的明确 hostname:port 授权和平台资格，不能沿用源主机上游端口或认证。此变化不修改数据迁移格式或本 Runbook 的停机/恢复步骤。

只读网络重试只在原调用仍运行时发生：声明零费用的 GET 与固定公开 `web_search_exa` 查询，对明确暂时错误最多重试一次；默认退避 250 ms，有有效 Retry-After 时至少等待该值，原期限不足则停止。GET 决定重试时用单调时钟记下最早发送时刻；等待提前返回时补等剩余时间，每次补等仍受原中止信号和原总期限约束，不为重试增加时间预算。GET 每次重查当前授权和秘密句柄，搜索在重试前建立新代理连接以重新触发出口检查，并沿用原 MCP 请求期限；任意写入、未知非幂等结果和有费用的 endpoint 不自动重发。重启、备份恢复或权威迁移不会恢复重试计数或重新执行历史工具；此策略没有新增恢复表、迁移或部署开关。

准备期间，任务期限早于或等于 30 秒准备上限时，受保护诊断为 `JOB_HOST_EXECUTION_DEADLINE`，结束原因为 `deadline`；准备上限更早时才为 `JOB_HOST_PREPARATION_TIMEOUT`，取消或结束后不再追加超时分类。该分类不改变原期限、签名退出事实、释放核验、持久数据和恢复步骤；备份或权威迁移不会重建定时器或重发原任务。详见[期限诊断合同](../execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md#deadline-classification)。

schema 28 在原数据库追加 v2 资源关联、独立操作/资源观察、目录占用和派发回执。升级既有库仍须先取得已验证快照；0020/0027 不改写。恢复/迁移时必须保留占用和未确认派发；旧未结束作业缺少可信目录链时按主机保守阻止新准入，缺少主机身份时阻止所有主机的新准入。禁止通过删除 Run、清空占用或把旧记录改成 v2 来恢复执行。已确认清理的旧历史结果保持原解释，不由迁移补写新资格。

schema 29 追加执行准备阶段，保持 schema 28 的历史记录为 `legacy_bound`。新 `reserved` 记录没有实际运行摘要，`bound` 记录保存首次启动固定的摘要和监督身份；两者均须与原调用回执、目录占用及观察历史一同保留。恢复或迁移不能为未绑定记录补造启动资格，也不能把已绑定作业重新派发；源主机上的 PID、IPC session 和 boot 仅供核查，不成为目标的停止或执行句柄。

这些 SQLite 机制已有独立测试数据库的升级、重开和事务验证；本次未升级运行中的 state root，也未执行真实安装、恢复或跨主机迁移。正式组合已具备显式 v2 foreground 路径、真实目录身份解析和限定风险核查；Pi 七工具前台 runner 已有假数据验收，目标安装资格仍须独立验证。恢复或迁移后的 Pi 工具链须与原 runtimeDigest 匹配，不能以同名系统工具替代缺失的 bash/rg/fd，也不能下载补齐后沿用旧资格。恢复后继续适用当前主机/目录/权威检查，不能自动重放旧任务或未确认派发。

SRT 的 Agent Service/Worker 组合已接上现有授权来源、受保护 scope、认证 Payload 通道与作业监督器；Node 打包包含 SRT 0.0.75。当前文件 inspect/read scope 来源与受控 Mac 组合探针已经实现，但未签发正式安装主机资格，也未完成真实跨主机崩溃恢复验收。schema 27 继续保存计划和作业观察；初始观察允许无策略摘要，由首次原子启动固定 Worker 编译的摘要，此后不得更换。资源观察随作业记录迁移，仅为历史证据，不能成为目标主机资格。恢复后不能给无账本的旧凭证补建可启动作业，不能重放清理未知作业。本文的停机、备份与权威迁移流程保持不变；目标仍须独立验证主机资格、目录授权和本次操作的网络 Grant，不得沿用源主机路径或网络上界推断授权。

本 Runbook 只用于把同一个 Owner/Agent 的单一逻辑权威在两个已准备好的 deployment 之间停机迁移。它覆盖源部署导出、迁移包认证检查、空目标导入、inactive-ready 验证、显式激活、未激活导入的放弃，以及加密迁移包的 7 天保留边界。

目标服务必须建立自己的 Agent/Worker boot identity、authority lease 和反向权限/Payload 通道；源 `runtime/` 中的启动绑定不随迁移包转移，也不能在目标重用。

目标 Agent Service 现在会在创建准入入口前核查已有 SRT 作业：prepared/starting 等未结束作业保存为清理未知并隔离，已有隔离状态保持不变。核查使用当前目标权威，仅追加观察；不把源 Worker 凭据变成目标执行权限，不自动重放，也不证明源机器的任务后代已经退出。此启动行为已有同机 SQLite 回归，不能代替实际双向迁移和两台主机的进程核查。

迁移不是在线复制、自动故障切换、普通备份、主机损毁恢复或 active-active。导出一旦进入 `retired_pending_transfer`，源部署不能自动恢复为 active；回切必须由当时的 active target 发起新的 reverse transfer。当前实现把激活后的 source `retired` 状态写入目标侧的权威产品数据库；物理源 state root 保持 `retired_pending_transfer`，两种状态都拒绝普通启动。

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

前台 SRT 现沿用受保护 Payload 通道额外保存 stdout 分块，任务正常退出且 stdout/stderr 管道已关闭时先保存带 termination 的结束块，再等待宿主清理。最终报告仍未确认管道关闭时，只保存输出前缀，不能生成结束块或完整成功结果；原未知结果、有限恢复和停止规则继续适用。正常 Worker 的原始 stdout Payload 和结果消费者不变；恢复只在接纳释放后核验完整分块、原身份和当前权限，重组成普通 Payload，并将输出归属和 operation CAS 同事务保存。已有等价原 Payload 时复用，已确定 operation 优先，不能用当前文件内容代替旧 read 输出。备份和迁移须同时保留原 Run 的 `sandbox-stream-chunk:*`、`sandbox-stream-end:*`、对应加密 Payload、原调用回执和输出归属；分块 JSON 不是完整输出引用。每次调用增加分块副本与本机 RPC，结束 artifact 还会保存末块 JSON，容量评估不能只按原 stdout 长度计算。合法的取消、输出或资源超限、宿主失败结束块在完整校验后保留原 UNKNOWN 或已有确定错误，不因不能恢复输出而关闭 Agent；未知原因、矛盾字段和损坏分块仍拒绝。后台游标合同不变；完整性、取消、期限、披露和效果验证不放宽。见[前台结果恢复设计](../execution/specs/2026-09-29-sandbox-foreground-result-durability-design.md#恢复裁决与事务)。[SOURCE: docs/execution/specs/2026-09-29-sandbox-foreground-result-durability-design.md]

Worker 单独退出而 Agent 继续运行时，服务整体不可用，页面也不能停止本轮；需要成对重启服务。生产启动器在任一进程退出时会自动成对重启。将来的 Mac 常驻启动器必须保持同样的合同。现有 `hermes-ui-session-start.mjs` 先停止 Agent，再停止尚存活的 Worker，交由服务管理器重启整对；不能用只恢复 Worker 或修改业务 HTTP 就绪条件替代此步骤。这里说明所需进程合同，不授权生产重启；执行仍遵守本 Runbook 的现场检查与授权要求。

前台没有完整结束块且没有确定 operation 时，不保证恢复原输出。只有已接受释放、原签名结束记录证明任务启动并退出、操作没有确定结果、且同一部署当前 epoch/fence 已严格超过原尝试时，恢复才以原 operation revision 比较写入 `SANDBOX_TOOL_RESULT_LOST`。该确定错误表示原输出和退出结果丢失，不表示工具没有产生效果；效果未知事实保留，原工具不得重放，已接受释放不得撤销。原确定结果先写入时优先，丢失错误先写入后迟到写者不能覆盖。

此错误沿原 Pi 批次交付一次，模型得到“工具已运行并结束，但输出和退出结果在服务重启时丢失；没有重新执行。它可能已经产生了效果，是否重做请先确认。”当前 Run、租约、取消、期限、披露与预算仍须核验；取消或过期不能复活或补交，旧 Handle 不因恢复而取得新 fence 权限。没有签名退出证明或原尝试仍可提交时不能声称丢失。页面仅将这一已释放的确定错误显示为失败，不推断工作区效果已核验。

升级、备份和恢复应共同保留原控制关联、签名控制证据、释放回执、operation journal、原 Pi 批次及交付记录，还有既有受保护 trace 中的 `sandbox-tool-result-lost:<invocationId>` 固定错误 Payload。本修改不扩展恢复包或迁移包范围；数据库恢复点不等于保存了宿主原控制目录，缺少匹配的原签名证据时不得新认定结果丢失。这里不新增原工具输出的宿主明文文件，不新增表、迁移、状态或队列；同 schema 不证明旧 writer 理解本错误的恢复和交付语义。仍须替换唯一 writer，回退前核对匹配程序和完整恢复点。参见[工具执行排查记录](../execution/plans/2026-09-28-tool-execution-audit-plan.md#缺陷和待验证项)；Linux 现场资格不能由 Mac 证据替代。

生产通用 Worker 现在通过既有 Payload UDS 的 `payload.invocation.validate` 校验 Agent 当前持久调用权限；不支持此操作的旧 Agent 会拒绝继续执行，升级须使用匹配服务产物，不能降级成仅凭内存委派放行。该查询不读取正文、不缓存批准、不再消费额度；外发前与输入解密返回前均重新检查。事件流挂起期间仍检查撤销并向原 Worker 请求停止，受保护诊断区分“已请求”与“发送未确认”，两者均不是效果终结或资源释放证明。资源扫描在 Run 仍运行时也识别 Grant/Handle 撤销、期限失效和能力禁用，排定原资源有限 stop；未绑定预约先禁止启动，未知停止仍保留占用。现有 Schema 43、历史结果保留和恢复点规则不变；实际目录授权与平台停止能力仍须按目标现场检查，不能以这些本地测试替代资格或生产操作授权。

## Authoritative Sources

- 迁移顺序、manifest、Payload/Memory、秘密排除、失败行为和验证边界：[SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md#同机恢复点导出与导入]
- 单一逻辑 Agent authority：[SOURCE: docs/adr/0003-single-logical-agent-authority.md]
- 停机加密迁移决策与回切边界：[SOURCE: docs/adr/0019-offline-authority-transfer.md]
- 本 Runbook contract selector 中列出的 CLI、状态机、SQLite adapter、offline lock、authority file、配置、host secret source、Payload envelope 和普通启动 fail-closed 实现。


P3 文件协议使用 Schema 46 的 writer 边界。升级和恢复必须保留原文件候选、逐文件发布记录、目录移动意图/收据、队列与占用；不得整批回滚已成功文件或覆盖后续人工修改。合同 3 的确定未发布冲突是失败结果，不是成功写入。目录工具合同 4 的 `rename-native` 随目标平台构建并受 runtime 摘要核验，Mac 包不能移作 Linux 包。新增固定文件完成资格仅适用于已验证的固定程序正常结束，旧资格与普通命令的未知清理仍保留保护；实际安装资格和启用不能由测试结果自动生成。详见 [SOURCE: docs/execution/specs/2026-09-16-workspace-authorization-lifecycle-design.md]。

P4 工作副本保存合同将当前 writer 边界推进至 Schema 47，保留已有行和历史迁移。副本的待保存操作包含目录授权版本、根身份、输入内容/身份基线及先前逐文件保存结果；Schema 46 或更旧的程序必须拒绝写入，不能忽略这些条件继续执行。恢复点须同时保留对应受保护内容和文件操作记录；若单独配置候选目录，须核对其备份范围，不能仅凭数据库备份宣称唯一候选已受保护。过期不自动应用或删除候选；回退须停止新 writer 并恢复匹配旧程序的完整恢复点。本批没有执行实际实例迁移，也没有为缺少资格的候选命令后端生成启用资格。

任务级执行环境记录将当前 writer 边界推进至 Schema 48，保留已有行和历史迁移。新表保存每轮对话一个的执行作业、按“第几个环境”编号的环境记录、环境级占用（`lease`，整个环境持有的工作目录占用登记，释放前会冲突的其他任务不能动这些目录）、每次调用与环境的关联、停止记录和不可修改的释放回执；原来单次调用的执行记录含义不变。Schema 47 或更旧的程序必须拒绝写入新库，否则它看不到环境级占用，可能让冲突的任务提前运行。Run 结束前现在还要求本轮没有未释放的环境。现有执行路线不会创建这类记录，所以升级后这些表为空；本迁移也不启用新的执行后端。备份和恢复点须随数据库一起保留这些表；回退须停止新 writer 并恢复匹配旧程序的完整恢复点，不能删除新表或修改迁移账本来降级。只读核查使用[工作区历史占用只读核查](workspace-lifecycle-audit-runbook.md#procedure)的 `environments` 分区。本批没有执行实际实例迁移。

对话标题预算账户将当前 writer 边界推进至 Schema 49，保留已有行和历史迁移。本迁移重建模型预算账户表 `model_budget_accounts`（记录每个花费主体已预留和已花费的模型费用），新增一类账户：自动生成对话标题的那次模型调用改记在本轮对话专属的标题账户（账户号 `thread-title:<Run ID>`），不再记在本轮对话（Run）自己的账户里。这样标题调用结果不明时，只有标题账户进入待核对状态，不会挡住本轮对话的派发、恢复或结束。依赖该表的预算分配表 `model_budget_allocations` 和模型调用身份表 `model_invocation_identities` 随之重建，原有行逐行保留；旧行都属于原有几类账户，所以升级后不会凭空出现标题账户。全局费用上限和按数据级别的费用上限仍计入标题账户，单轮费用上限对标题账户单独计算。Schema 48 或更旧的程序必须拒绝写入新库，否则它读不懂标题账户。备份和恢复点须随数据库一起保留这三张表；回退须停止新 writer 并恢复匹配旧程序的完整恢复点，不能修改迁移账本来降级。本批没有执行实际实例迁移。

SRT 可选工作副本使用 `privateRoot/workspace-copies` 保存当前文件基线和候选内容，生产 Owner 入口按既有 Bash 配置装配创建、选择和准备操作。`prepare` 不表示已保存回原目录；保存须配置 `save_copy` 工具和 `pi-coding-tool@5` 前台 `verified_effect` 描述，经原 Run/Worker 准入队列逐文件执行，不能启用绕过该队列的旧 `host.file.execute`。描述的 `directoryOperations` 是上限，实际 scope 仅含 read 与当前操作；移入回收区仍须 trash 授权。 备份须同时保留任务私有目录中的 `copy-save-state-*.json`、原目录 `.himawari-recovery` 中的已暂存内容/快照以及 SQLite 操作记录；最终结果写回中断后，只能在原资源已确认释放后核验并导入历史效果，不能重新派发保存。旧严格 Scope 读者会拒绝合同 5，禁止混用不支持该合同的 Agent/Worker 或复用旧安装摘要。备份或权威迁移必须保留唯一副本和受保护的选择/操作记录；换主机或路径后重新验证目录身份、来源授权与执行资格，不能沿用旧 inode 或进程证明。具体已验证范围见[P4 完成验收](../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p4-completed)。


## Safety and Preconditions

- 这是 critical operation。每次 export、import、activate、abandon 和 reverse transfer 都是独立 mutation；上一动作的授权不会自动授权下一动作。
- 开始前冻结唯一 transfer ID、source deployment、target deployment、Owner/Agent、源 authority epoch/fencing token、源/目标 state root、配置路径、迁移包目录和预计磁盘增量。目标 epoch 与 fencing token 必须各等于源值加一。
- export 前 Agent Service、Execution Worker、新 Trigger admission、scheduler、全部 SQLite/Memory connection 必须停止；在途 Run 必须已完成或形成稳定 checkpoint。CLI 取得 state-root exclusive offline lock 只证明受该锁保护的写者已停止，不能替代服务管理器、进程、socket 和连接回读。
- target state root 必须停止且 product `data/` 为空，不能先复制 SQLite、Payload 或 authority file。目标 host 的配置、秘密、能力部署快照和本平台 runtime root 必须独立准备；迁移包不携带机器秘密、可执行绑定或平台资格。
- 配置中必须恰好存在一个 `payload-encryption` 和一个 `transfer-recipient` secret reference。当前 CLI 从绝对路径的 restricted secret directory 解析 32-byte key material；目录必须为当前账号所有且 `0700`，文件必须为当前账号所有且 `0600`。密钥值不得进入 argv、环境变量、日志、Trace 或证据。
- 配置必须通过当前 strict schema，明确声明 primary、private-only fallback 和独立 embedding descriptor 及其 dimensions；迁移只搬运受保护产品状态，不替换、推断或静默刷新这些模型身份。
- 若目标配置声明能力部署快照，必须在 activation 前验证规范路径、Owner/mode、大小、SHA-256，并逐项对照迁移后的 active Capability Registry 与目标平台资格。源主机快照、runtime root 或资格不能复制后直接视为目标已合格。
- `activate` 只接受权限受限、字段精确的 preflight JSON。CLI 会实际解析目标 Payload 和 recipient key；`doctorReady` 与 `publicIngressReady` 必须来自本次只读检查。文件中的布尔值不是替代证据，缺少原始回读时停止。
- 迁移包 plaintext staging 只能位于 CLI 生成的受限临时目录。copy-on-write 与 SSD 删除不保证可靠擦除；主要保护来自包加密、受限权限、临时文件清理和后续 key disposal。
- 任何公网入口切换、Hermes/Mac 服务操作、外部账户变更和旧包删除都保持各自授权边界。

文件读取的 `runPolicy.fileRead` 属于主机路由选择，不能沿用源主机路径和 Worker instance 推断目标主机授权。迁移的 inspect/read 输入、Handle 和回执仅用于历史回读或核实未知结果；新 authority 下不得自动重签执行，须重新核实本地主机、目录 Grant、文件身份及模型披露权限。

## Live-State Preflight

源端 export 和目标端 import 前，正常停机须等待[预热准备线程池](#pi-preparation-prewarm)拥有的全部线程退出，再检查进程、socket、连接和锁。迁移包不携带预热线程；目标安装须独立包含准备入口、线程入口、pool 模块及 runtime-pi 导出，激活后仍按当前权威交接新请求。

在任何 mutation 前执行并记录以下只读检查：

~~~text
git rev-parse HEAD
git status --short --branch
himawari db status --config <absolute-source-or-target-config-path>
himawari doctor --config <absolute-source-or-target-config-path>
~~~

同时回读并脱敏记录：当前主机、immutable build identity、Node/SQLite/product/schema/adapter/Memory versions、配置与 state root owner/mode、Owner/Agent/deployment、authority status/epoch/fence/transfer ID、数据库 quick/full integrity、WAL checkpoint 条件、Memory storage、实际引用的 Payload ciphertext、源/目标文件系统可用字节，以及 secret reference 名称/版本/用途和可解析结论。

export 前必须从已验证服务管理器、进程表、`runtime/execution.sock` 和 state-root lock 四个角度证明服务与 stores 已停止。target preflight 必须证明 state root 为空且未持有 authority。若尚无该主机的已验证 install/start/stop 程序，不得猜测 launchd/systemd 命令，停止本 Runbook。

## Procedure

1. 对本 Runbook 执行静态 contract check，完成 Git 与 Live-State Preflight，并创建权限受限的新证据目录 `test/integration/qualification/evidence/operations/authority-transfer/<unique-run-id>/`。冻结 transfer ID 和目标 deployment ID。
2. 先停止新 admission/scheduling，等待或 checkpoint 所有在途 Run；通过适用的已验证服务管理器停止 Agent Service 与 Execution Worker，关闭 SQLite/Memory client。重新确认进程、socket、连接与 offline lock 条件。
3. 展示 source、target、epoch/fence 增量、迁移包路径、磁盘增量、停机和失败后 source 保持 pending 的边界，取得 export 授权后执行：

~~~text
himawari transfer export --config <absolute-source-config-path> --secret-dir <absolute-source-secret-directory> --transfer-id <transfer-id> --target-deployment <target-deployment-id> --package-root <absolute-package-root> --confirm EXPORT_<transfer-id>
~~~

4. export 会在 exclusive lock 内先把 source SQLite 与 authority file 置为 `retired_pending_transfer`，再 checkpoint、执行 quick/full/foreign-key integrity、复制 SQLite、为 recipient rewrap Payload DEK、按 allowlist 加入被引用的 Payload ciphertext 和 Memory 文件、流式 AES-256-GCM 加密、HMAC 认证 canonical manifest，并在临时解密目录完成独立验证。任何错误都保持 source stopped/pending。
5. 通过受控离线介质或受保护传输把完整加密包交给目标；不得解密后复制。目标使用自己的 recipient secret source 独立执行：

~~~text
himawari transfer inspect --config <absolute-target-config-path> --secret-dir <absolute-target-secret-directory> --package <absolute-transfer-package>
~~~

6. 对比 authenticated manifest 的 transfer/Owner/Agent/source/target、epoch/fence、product/schema/adapter/Memory versions、文件大小/digest、排除秘密引用和 7 天保留时间。任一不匹配时停止。
7. 确认目标服务停止、state root 为空、offline lock 可独占，展示原子新增的 target `data/` 和 inactive authority 边界，取得 import 授权后执行：

~~~text
himawari transfer import --config <absolute-target-config-path> --secret-dir <absolute-target-secret-directory> --package <absolute-transfer-package> --confirm IMPORT_<transfer-id>
~~~

8. import 只在受限 staging 中解密并验证 authentication、digests、identity、版本、schema、SQLite、Payload 和 Memory；允许的 forward migration 与目标 KEK rewrap 只修改 staging。全部通过后才原子建立 target `data/` 和 `inactive_ready` authority `epoch/fence=0/0`。此时不得启动普通服务或切公网入口。
9. 在 target 对 secret references、离线 product diagnostics、目标服务配置、能力部署快照及目标平台资格、public origin、受控 ingress 和回滚边界执行只读 preflight。创建字段精确、权限 `0600` 的 JSON：

~~~json
{
  "schemaVersion": 1,
  "transferId": "<transfer-id>",
  "deploymentId": "<target-deployment-id>",
  "authorityEpoch": 8,
  "secretReferencesReady": true,
  "doctorReady": true,
  "publicIngressReady": true,
  "evidenceRef": "<non-secret-evidence-reference>"
}
~~~

10. 展示 target activation、source canonical retirement、目标 epoch/fence 和公网切换仍是独立后续动作，取得 activation 授权后执行：

~~~text
himawari transfer activate --config <absolute-target-config-path> --secret-dir <absolute-target-secret-directory> --transfer-id <transfer-id> --preflight <absolute-preflight-json> --confirm ACTIVATE_<transfer-id>
~~~

11. 激活成功后才使用已验证服务程序启动 target Worker 与 Agent Service，并通过独立授权把同一 public ingress 指向 target。重新运行 `db status`、`doctor`、身份、SSE 和只读业务水位线验证。物理 source 继续停止且不可普通启动。
12. 若 target 仍为 inactive-ready 且决定终止本次导入，报告 source 不会自动恢复、包仍按保留策略存在的后果，取得 abandon 授权后执行：

~~~text
himawari transfer abandon --config <absolute-target-config-path> --secret-dir <absolute-target-secret-directory> --transfer-id <transfer-id> --confirm ABANDON_<transfer-id>
~~~

恢复目标 Agent 在开放准入前使用当前权威处理 v2 未释放观察：旧监督标为 lost/unknown，保留原结果、效果和占用，不复用源 Worker 的 boot 凭证或按旧 PID 接管。已确认清理但效果未决的记录保持其原清理事实及未决义务。此逻辑恢复不能作为源主机残留进程已终止的证据，源风险仍按本 Runbook 的停止条件处理。

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

执行状态的下一步提示只读取持久 `ThreadExecutionState` 和当前有效 `availableActions`。迁移后的旧会话不能沿用来源宿主仍有效的 Stop/清理操作、旧 Grant 或旧释放推断；目标应按当前权威重算动作。命令非零退出且效果未断言时保留确定失败，同时提示工作区可能已有改动、效果尚未核验，不自动重发。当前本地只有状态与页面单测，真实跨权威页面验收尚未完成；静态 Runbook 检查也不证明目标服务已具备这些结果。


自动标题沿用既有 Thread、受保护 Payload 和模型费用账本；Schema 49 起标题费用记在该 Run 专属的标题预算账户 `thread-title:<runId>`，迁移时随预算表一起保留。迁移须共同保留 `threads.title_ref`、标题来源与 revision、标题 Payload，以及 `thread-title:<runId>` 对应的调用身份和费用状态；目标不能因标题缺失清除 started/unknown 记录或重放源请求。正常停机先停止 Run 循环，再等待已发起的标题请求结束；标题请求最多等待 20 秒，仍受配置的更短期限约束。强制中断后的进程内标题队列不属于迁移数据，目标以已提交状态为准。已有标题和手动改名优先，不在 import/activate 时批量请求模型。

执行过程继续由原 Trace/Payload 和 Thread 游标投影。记忆检索、筛选及上下文形成只展示阶段发生，不暴露记忆正文和完整模型上下文；模型发出的工具请求与执行、结果按调用 ID 关联。目标回读这些阶段、参数和结果即可验证历史展示，不以重新调用工具作为迁移验收手段。

启用沙箱能力的 Agent 必须在本进程完成首次安装校验后才进入 ready，不能以 Worker 已就绪代替。受保护程序摘要可在安装及文件身份未变化时复用，安装外的程序仍逐次校验；这不改变本手册的数据格式、权威转移或停机步骤。恢复到另一安装或主机时，原进程缓存不适用，必须重新验证实际安装。Hermes 的 NVMe 私有只读挂载及设备回读另见 [SOURCE: docs/runbooks/hermes-control-center-upgrade-runbook.md]。

工具审批续跑快照同时保存本轮进展指纹和已完成工具结果，备份、恢复及迁移须连同其受保护 Payload 一起保留。恢复审批时只重放同一暂停点已有的结果，不再次执行对应工具；因循环保护中止的 Run 保持失败，即使随后生成了结果说明，也不能改记为任务成功。这些运行层行为不依赖具体模型提供商。

Schema 32 增加受保护原生历史快照、Run 内顺序和 Fork 固定引用。迁移须先取得既有机制核验通过的停机备份；升级后回读 `run_payload_artifacts`、对应 Payload 密文和 `thread_fork_lineage.runtime_history_json`，核对旧 artifact 内容未变、外键完整。恢复与迁移须保留清单引用的所有消息 Payload，不能只搬运聊天正文。重启后以新 Run 验证旧工具调用/结果可见且不重新执行；取消后核对实际结果及新请求，不能仅看服务 ready。旧 Trace 没有自动导入为完整历史，不能由 schema 升级推断旧会话已修复。回退需要匹配旧版本的整套已核验数据库备份，禁止旧二进制直接打开 schema 32，也不手工删除 migration ledger。

恢复或迁移后的候选必须支持 migration 0024/0025/0026：embedding 调用身份和 Memory projection 预算账户随产品 SQLite 一起验证，不能丢弃 started/unknown 费用记录来触发重试。公开入口还需要当前主机的 `http`、`identity`、`runPolicy` 与模型配置；被冻结的 Run 输入继续使用原有快照。重新启动后检查 Run dispatch、Memory consumer、Worker 与权威就绪状态，并回读原 Thread/Run 和受保护回答正文。此检查不替代真实公共身份入口或目标平台资格。

- 未保存完整审批暂停点的中断执行交给生产恢复组件后，Run 与 checkpoint 必须同时显示 `reconciling_external_result`，旧执行租约失效，已有结果引用保留；恢复不能重新调用模型或工具。此检查当前有本地 SQLite 证据，完整安装入口验证仍待完成。已经待核实的记录不重复占用初始扫描批次，不代表外部结果已经确认。

- 若迁移包包含通用 HITL 暂停点，保存审批、恢复 Payload 和已确认执行结果供核查。恢复记录绑定原 deployment、epoch 与 fence；权威迁移后不得绕过该绑定自动执行旧工具批次。目标重新授权与跨权威续跑尚未验收，应保留待核查状态，不手改恢复记录或重新发送原请求代替恢复。

- 若数据包含 Run 执行输入快照，保留首次执行开始时间与绝对截止时间；恢复或迁移不重新发放运行时长。缺少截止时间的旧快照须停止并核实历史执行，不能自动删除快照后重建。目标时钟须可信，不能以导入或重启时间替换原截止时间。

- authenticated manifest 与 import/activate 输出中的 transfer、Owner/Agent、source/target deployment、product/schema/adapter/Memory versions 完全一致。
- target activation epoch 与 fencing token 各为源值加一；目标权威 SQLite 与 `authority.json` 状态、epoch、fence 和 transfer ID 一致，且最多一条 deployment 为 `active`。
- import 前不存在 target product state；import 后 activation 前 target 为 `inactive_ready` 且普通 Agent Service 启动失败；activate 后只有 target 可通过普通启动检查。
- source 物理 authority 保持 `retired_pending_transfer` 并拒绝普通启动；target canonical SQLite 中 source deployment 为 `retired`。旧 source 不能靠复制旧 authority、旧 SQLite 或旧包回到 active。
- target Payload 能以目标 KEK 完成 authentication/decryption；Memory projection、Owner/Agent/Thread/Run identity、checkpoint、水位线、jobs 和外部 integration state 以本次范围的只读 fixture 对比一致。
- 对本次包含运行正文的迁移，核对正文与 Run 的归属、用途、操作身份回执、摘要、分类和媒体类型完整迁移；换 KEK 不改变这些语义身份。尚未发布的正文不得因迁移变成已发布消息，旧部署的租约不得用于新增正文。
- 若迁移包含 Capability 调用回执，保留原任务语义、幂等键与首次执行的 deployment/lease/Agent/Worker 身份。目标的新 epoch/fence/lease 不能把源执行回执变成可继续执行或读取正文的权限；重复接纳只回读既有结果，未知外部结果须显式核对，不自动派发新执行。
- 若迁移包含 Run 执行租约，保留来源、执行身份、revision 和释放状态供核对，但目标不能把源 consumer 或源执行租约当作当前执行权限。取消状态、检查点、失效租约和回执须保持一致；新权威只能按当前领取规则处理可恢复任务，未知执行不得因迁移重新派发。
- manifest allowlist 只含 SQLite、数据库引用的 Payload ciphertext 与 Memory 文件；包不含 secret、cache、log、runtime、lock 或 socket，证据不含 plaintext。
- 迁移包不含能力部署快照、runtime root 或平台资格；目标 Worker 只在目标主机独立验证快照 digest、active Capability Registry 和本平台 binding/qualification 后 ready。
- package `retainUntil` 为创建后 7 天；到期清除是独立删除 mutation。未到期不得提前删除唯一加密迁移副本。

## Evidence

每次运行写入新的 `test/integration/qualification/evidence/operations/authority-transfer/<unique-run-id>/`：Runbook check、Git/build identity、主机和 deployment 映射、权限/空间/停止/锁结论、脱敏配置 identity、manifest digest 与计数、版本和 epoch/fence 对比、每条命令/确认/exit status、Payload/Memory/SQLite 验证、preflight evidence reference、public ingress 前后回读、source fail-closed、rollback/abandon 状态和最终结论。

不得记录 secret value、环境转储、配置全文、Payload plaintext、未脱敏数据库行、Cookie/token/private key、迁移包对象内容或临时解密文件。证据目录不能安全建立时停止。

## Rollback

- export 在 source 进入 pending 前失败时没有 authority 变化；进入 pending 后的任何失败都保持 source stopped/pending，删除不完整 staging/package，不自动恢复 active。修复后从完整 preflight 决定重试、保留现场或执行新的恢复决策。
- import 在原子 data commit 前失败只删除 staging；commit 后 authority file 写入失败可能留下不可启动的 inactive SQLite。不得手工启动或改 authority；保留现场并按稳定 transfer ID 执行有界修复或显式 abandon。
- activate 在数据库 commit 后、authority file 前中断时，普通启动会因 SQLite/authority mismatch fail closed；使用同一 transfer、epoch 和 preflight 重试可幂等完成 authority file。authority file 已成功后重复 activation 也返回既有 activated 状态。
- activation 成功后不能直接启动旧 source。回切必须在 target 停止后由当前 active target 创建新 transfer ID、新的更高 epoch/fence 和 reverse package，并重新执行本 Runbook全部授权与验证。
- 应用版本回退、同机数据库恢复、authority transfer、公网入口、外部账户和外部副作用补偿是不同边界；任何一个边界的授权不扩展到另一个。

## Stop Conditions

- Runbook static check、worktree/contract gate、immutable build 或版本对比失败。
- source/target/Owner/Agent/transfer ID、state root、epoch/fence、包路径或公网目标不明确或不匹配。
- 服务/stores 未确认停止、in-flight Run 未 settlement/checkpoint、socket 仍接受连接或 offline lock 不可独占。
- target 非空、已有 authority、已有同 ID transfer 消费记录，或 target epoch/fence 不是单调下一代。
- secret reference 缺失/重复/权限不安全，需要把 secret 放入 argv/env/log/Trace，或机器秘密出现在 manifest/package allowlist。
- manifest authentication、file digest/size、schema/adapter/Memory version、SQLite integrity、Payload authentication、Memory diagnostics 或 forward migration 任一失败。
- 磁盘不足以同时容纳源数据、SQLite snapshot、加密对象和临时解密 staging；不得自动删除 Owner 内容。
- preflight evidence 缺失、目标 secrets/doctor/readiness/public ingress 任一未通过，或 activation 后 source 普通启动未 fail closed。
- 目标能力部署快照缺失、篡改、权限不安全、与迁移后的 active Capability Registry 不一致，或沿用源平台资格冒充目标平台验证。
- 要求自动恢复 source、手工改 authority、直接复制 plaintext state、跳过确认、提前删包、扩大到生产部署或把一次 fixture 成功当作 Mac↔Hermes 完整验收。

## Troubleshooting

后台核查与操作结果并发写入时的版本处理，见[安装与诊断手册的核查说明](install-start-stop-runbook.md#troubleshooting)。该处理保留原资源事实、恢复所有权和期限检查，不新增数据格式，不改变本手册的备份、权威迁移或部署操作步骤；它不授权重放原工具。

资源核查失败时先看持久恢复终点与安全原因：`SANDBOX_RECONCILIATION_PERMISSION_DENIED` 表示宿主检查被拒绝，不代表原执行 Grant 应重新授予；`SANDBOX_CONTROL_TIMED_OUT` 是控制连接请求超时，`SANDBOX_RECONCILIATION_TIMED_OUT` 是整个核查任务到期；身份、目录或证据变化必须核对原绑定，不能直接采用当前 PID。`unresolved` 表示本次核查已经结束，不表示后台正在重试。失败细节经原 Job 的受保护 `restricted` Trace 保存，保留备份但不得直接输出到页面或普通日志。没有充分新释放证明时仍保留相交资源保护；不得用删除 claim 或重跑原工具来清除错误。

| 症状 | 安全诊断 | 停止或有界修复 |
| --- | --- | --- |
| `AUTHORITY_TRANSFER_TARGET_NOT_STOPPED` | 只读检查服务进程、socket、连接和 state-root lock owner | 停止；用已验证服务程序关闭后重新 preflight，不删除活锁 |
| `AUTHORITY_TRANSFER_AUTHORITY_MISMATCH` 或 `EPOCH_STALE` | 对比配置、authority file、SQLite deployment/transfer 与 authenticated manifest | 停止；不要改 epoch/file，选择正确主机、包和配置 |
| `AUTHENTICATION_FAILED` 或 `DIGEST_MISMATCH` | 核对 recipient secret reference/version、manifest mode 与对象 digest，不显示密钥 | 停止；包不可用，修复正确 secret source 或重新从 current source export |
| `SCHEMA_INCOMPATIBLE` 或 `MEMORY_INCOMPATIBLE` | 对比 immutable build、bundled migration、adapter/Memory version | 停止；先完成独立兼容升级，不修改 encrypted package |
| `PAYLOAD_INVALID` | 记录不含正文的 payload ref 与稳定错误码 | 停止；不能跳过 Payload authentication 或改 metadata |
| `TARGET_NOT_EMPTY` | 只读列出 target data/authority 是否存在，不读取正文 | 停止；不得覆盖，使用全新目标或独立清理授权 |
| activation 中断 | 对比 target SQLite 与 authority file 的状态/epoch/fence/transfer ID | 若 DB 已 activated 但 file inactive，以同一 preflight 幂等重试；其他不一致停止并保留现场 |
| source 被尝试启动 | 回读 source authority 与 SQLite transfer 状态 | 保持停止；不得恢复 active，回切只能从 current active target reverse transfer |
| `ENOSPC` | 只读回读同一文件系统可用字节和包/staging 估算 | 停止；人工决定空间处理，不自动删除 Owner 数据 |

### v2 原环境核查约束（2026-09-09）

恢复必须保留既有受保护 Run trace 中的控制引用、终态证据及其 Payload；不得仅备份 SQLite 中的 PID。当前 Agent 权威通过原环境认证控制端口 inspect/stop，或读取原 Job Host 的签名终态；身份、目录 inode、策略或宿主变化时继续隔离，不能在目标主机按旧 PID 停止或重启。Agent 仅加载不含 SRT 启动能力的控制客户端。

Linux 前台清理证据要求原 PID namespace init 已消失及完整终态，释放记录的 cleanup 为 `confirmed`。按 ADR 0033，已启动的 SRT 任务在原 Job Host 已退出、SRT 已复位、任务进程组（主进程及仍留在同一组的子进程）经 Job Host 终态证据确认全部消失时，也释放占用，cleanup 记为 `process_group_gone`，含义是“停止未经严格确认”：用 `setsid` 等方式离开进程组的后代不被跟踪，可能仍在运行。Agent 登记 Job Host 时同时保存本机开机标识（macOS 的 `kern.bootsessionuuid`、Linux 的 `/proc/sys/kernel/random/boot_id`）；之后核查时开机标识已变，说明机器重启过、原进程组必然已不存在，不再联系原 Job Host，直接按 `process_group_gone` 释放。Job Host 在同一次开机里崩溃时，Agent 读取 Job Host 在任务启动后写入控制目录的签名开始记录（`started.json`），用操作系统保存的进程启动时刻（macOS 的 `ps -o lstart`、Linux 的 `/proc/<pid>/stat` 第 22 项）核对 Job Host 和任务进程组组长是不是原来的进程：Job Host 已退出，且原进程组已没有进程或组长编号已被新进程占用时，按 `process_group_gone` 释放；Job Host 仍在、组长仍是原进程、组长已退出但组员还在、没有开始记录或记录核对不通过时继续 unknown。若宿主已写入 `finished` 终态，任务已退出且 SRT 已复位，但当时的 `taskProcessGroupGone` 为 false，Agent 仍使用同一份签名开始记录和当前进程身份核验原进程组；后来确认原宿主及原进程组消失时，沿用已有 `process_group_gone` 证明解除占用，不修改旧终态文件，不把它当作严格进程树清理。终态证据没有进程组字段、进程组仍在或无法核验身份时继续 unknown；没有保存开机标识的旧登记在重启后也继续 unknown。端口失联、证据不完整和超时均不能解除相交占用。真实假数据探针不签发安装资格；不得把测试临时 bubblewrap/socat 的 PATH 配置用于生产，生产依赖位置须单独验证。实际安装、备份恢复和跨主机迁移的既有步骤及审批边界保持适用。 删除旧的未确认 SRT 执行记录留下的删除标记和审计事件保存在现有的 `deletion_tombstones`、`audit_records` 表，随迁移包一起转移，不需要额外步骤；删除步骤见[删除旧的未确认 SRT 执行记录](install-start-stop-runbook.md#purge-unconfirmed-srt-records)。

### 资源输出分页保留

v2 已保存输出的分页引用和 cursor 归原 Run 的受保护 artifact；同机恢复须一同保留对应加密 Payload、artifact 关联及原作业账本。游标只定位原调用/资源的固定输出快照，不能改写为宿主路径，也不能用来重新执行任务。原输出缺失或摘要不符时拒绝，不能以空文件代替；权威迁移仍按原回执和当前身份拒绝旧 Worker 输出权限。R6 追加了后台运行输出片段、结束标记和命令退出事实，均归原 Run；恢复时须同时保留这些 artifact，不补造丢失片段、不重启原命令。后台/服务的目标安装资格仍须独立验证。

### 受管理后台资源的安装与恢复

后台 Bash 继续使用安装的 Pi runner 和固定工具链；其运行模式由 Worker 从匹配的操作声明传入，不能从模型参数选择。前台 Bash 保留原结果格式；后台输出只在完整行检查后追加，末尾无换行内容在退出时检查，机器秘密命中即停止并拒绝输出。start 回执只表示资源已启动，命令退出码另存入连续输出的结束事实。资源句柄与管理调用不能重复消费 Grant。

服务仅在安装声明含匹配的 `readinessProbes` 且具备该模式资格时启用。本批探针使用私有目录内唯一 Unix socket 的 HTTP GET、预期 2xx 状态和最多 30 秒期限；不开放通用本地 TCP 或其他 Unix socket，不以日志判断就绪。恢复后的声明、运行文件与资格必须重新匹配；不得凭旧 ready 回执连接新服务。

Run 正常完成前停止其后台资源；SQLite 完成事务拒绝仍有未释放资源的 Run。未知清理进入原核查流程并保留写目录占用。Mac 测试主进程退出仍不证明任意后代已全部退出，不能清除隔离以获得正常完成。这里没有新增迁移文件、安装资格签发或运行中数据库修改步骤。


## 内置账号的恢复边界

目标主机激活时会撤销内置账号随迁移复制的旧产品会话、设备和未完成验证请求。内置账号本身保留，用户须用密码和第二因素在新主机重新登录；原有 Cookie 不获得新主机访问权。迁移仍须按原有权限重新绑定 Host secret、验证 Payload 和平台资格。

[SOURCE: docs/adr/0027-built-in-owner-authentication.md] [SOURCE: docs/runbooks/install-start-stop-runbook.md]

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

预热上限为 8 秒。同一预热失败序列最多尝试三次，第二、三次分别等待 1 秒、2 秒；失败线程先终止再重试，消费 ready 线程并完成请求停止后才重置失败计数。`pi.preparation.warmup_failed` 只说明预热失败，请求仍走冷启动。实际准备预算保持 `min(maxWallTimeMs, maxCpuTimeMs)`：冷启动计入模块加载，预热请求从实际输入交接开始计时，结果与线程终止均须在预算内完成。验收须覆盖无输入预热、上限不匹配时冷启动、拒绝第二份输入、取消和超时。服务关闭须等待池拥有的全部线程退出；准备调用返回、空闲槽消失或进程锁释放不能分别代替这一检查。

Hermes r54 五次独立测量的额外进程 RSS 中位数为 110.910 MiB、最大 114.355 MiB，容量安排须计入这一个空闲预热线程；测量条件与边界见[架构文档的实测内存段](../architecture-v0.1.md#pi-file-preparation-memory)。验收分别记录空闲时进程 RSS（实际驻留内存）增量和线程 ready 时的堆读回；V8 上限不是 RSS 硬上限。备份、恢复或权威迁移不搬运进程内预热线程，也不因预热重新授予调用权限。

确定尚未派发的固定写入版本冲突返回 `FILE_VERSION_CONFLICT`，原调用重放只返回已知未执行事实。Pi 现有循环中的新调用携带受保护历史关联，宿主必须用原请求、未派发诊断及结果记录复核；关联不授予权限，新内容仍经原 ActionPolicy，确切单次批准不能扩大。备份需保留 `runtime-file-read:*:conflict-lineage` 与原工具诊断/结果 Payload。循环的受保护进度状态新增冲突计数；同一 Run 连续工作中累计四次版本冲突后停止继续调用工具并进入原有结果说明路径，读取或更换内容不清零。不能用忽略该计数或关联的旧运行时恢复此类 continuation。Worker 已派发后失败、结果未知和跨 boot 自动重绑定仍不得冒充可自动重试。

新合同尚无生产切换或 Linux 资格。采用前须对实际安装字节、最终运行身份和目标文件系统完成资格并明确选择合同 3；旧合同 1/2 的行为保留，普通源码升级不自动改部署绑定。本节不授权启用模型、付费调用、生产迁移或部署。

### Schema 37 固定文件发布恢复

Schema 37 为原调用的恢复结果建立 writer 屏障。恢复结果保存在受保护的 `pi-file-recovery:<invocationId>` Trace artifact 中，与原 Worker 输出分开；不覆盖原输出，也不创建第二个调用回执。旧 writer 不理解该来源，不得直接写入新库。

固定文件合同 2 的受信 runner 在保存前将 Scope、输入摘要、候选 inode、完整父目录身份和内容摘要写入本次私有 Job 目录；保存后等待核验记录落盘，再返回结果。记录失败阻止发布，发布后的记录失败则保留候选身份用于核实。私有记录不含候选正文。它们与授权目录内 `.himawari-recovery/` 的候选一起属于现场恢复证据，单独的产品数据库备份不包含这些文件；恢复数据库不能被报告成同时恢复了工作区与私有 Job 目录。

Agent 只有在原 journal 已接纳永久释放记录且没有新保护时才核实文件。已保存的核验记录作为历史事实保留；缺少最终核验记录时，必须匹配原候选 inode、内容及发布时父目录。核实可清除该次发布留下的私有硬链接别名，不能重新发布候选、修改用户后续编辑或启动旧工具。仅内容相同或目标名称相同不足以证明本次保存成功。

结果交接还须核对原请求的分类、当前披露权限、恢复 artifact 与受保护交接回执。该实现当前处理固定 write/edit 的缺失或 unknown 结果；已保存的错误结果保持不变。真实 Job Host 释放、跨 Worker 与 Linux 平台资格须单独验证；本地受控进程证据的集成测试不能代替这些资格。回退仍须停止新 writer 并使用匹配版本的完整恢复点，不删除恢复事实来允许旧程序接管。

### 工具执行前检查点与恢复引用

新 SRT v2 计划的 `preparationProtocol=register-before-host.v1` 与同一准备附件键下的 `sandbox-preparation-sealed.v1` 必须原样保留，连同受保护 Payload、摘要和预约释放回执一并备份与恢复。封锁不是宿主控制凭据；只有原计划、原停止时间和附件对应关系通过核验时，`preparation_not_authorized` 才能表示宿主从未获准创建。旧计划不回填标记、不迁移摘要，永远不能使用新依据；已有登记但 ACK 丢失仍待核对。权威转移或数据库恢复本身不证明目标主机上的资源已释放，也不授权原工具重放。详情见[准备封锁与旧版本排除](../execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md#新计划字段与旧-worker-排除) [SOURCE: docs/execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md#新计划字段与旧-worker-排除]。

生产装配在进入产品工具前，复用现有 Pi 批次格式和加密 Payload 保存检查点。执行 intent 中的 `tool-batch-recovery.v1` 引用绑定原模型工具调用，内部文件阶段共同指向该父调用；备份、恢复及迁移须一同保留这些关联。保存失败的工具没有进入执行，页面归为“尚未派发”；旧记录缺少检查点时不能补造。引用本身不授权跨 boot/fence 重放。对原 Run 未取消、未过期，已有确定结果与永久释放回执且原批次凭据完整的调用，调度器可领取原 Run 的新租约，仅交付旧结果并继续 Pi；原工具不会再次启动。缺失快照、权限变化、未确认控制或模型费用仍未知时保留待核对状态，不能通过重发清除未知。恢复沿用原模型 stream ordinal，保留原调用回执、交付 intent 与受保护 Payload；没有新增表或迁移。详见[已核验工具结果恢复合同](../execution/specs/2026-09-28-sandbox-tool-result-resumption-design.md#恢复条件与用户行为)。

创建本机 Job Host 前还需保存 `sandbox-preparation-control.v1` 受保护记录，其中的控制密钥只用于核验原宿主，不授予启动权限。备份与迁移须保留该记录；旧数据不回填。已认证的 `host_never_started` 预留释放可交付确定未启动的失败，不能伪造 bound 记录；准备登记已被接受后缺少最终证明时仍待核对。首次准备、登记或 bind 失败通过 `sandbox-control:*:diagnostic:preparation-failure` 尝试保留有界阶段及机器码，使用 `himawari diagnose run` 查询，不在普通日志中记录。Payload 或 Admission 通道在成功握手后发生传输失败，失败操作按原结果结束；后续操作使用原 peer/boot、凭据与现有校验重新握手，并发调用共享一次握手，不重发失败的执行请求。准备诊断也使用同一机制。Worker 就绪状态反映两个通道当前状态；后续就绪探测可触发共享恢复，成功后才恢复 ready。握手失败仍未就绪，关闭期间迟到的回复不能恢复 Worker。 正在停止任务时，保留 broker 到清理观察保存结束，再由 close 统一断开。握手或当前权威校验失败时仍可能没有持久诊断，不能据此声称错误已完整留存。详见[准备控制恢复合同](../execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md#权限与失败边界)。本批没有新 migration，不改变本 Runbook 的现场操作授权要求。


### Schema 38 纯联网范围

Schema 38 为 `sandbox-scope.v2` 和 `network_only` 合同建立 writer 屏障；这类前台 Job 使用自己的私有临时目录，不保存目录 Grant，也没有共享文件 claim。备份和恢复仍须保留原网络授权、Handle、调用回执、Scope Payload、私有环境和资源释放证据。空 claim 只说明没有用户文件占用，不能据此认定进程已结束或重发原操作；网络外部效果仍按命令退出事实记录，不宣称无副作用。

公开搜索新增显式 `runPolicy.publicSearch.scopeSource: private_temp` 路由，不能同时配置 `grantId`；安装清单须使用相匹配的 `private_temp` / `network_only` 操作合同，纯联网清单可不含用户目录根。旧目录型路由和合同保持原权限语义，升级不会自动切换部署配置。配置或模型绑定变化会使原搜索委托失效，需按现有入口重新授权；保存搜索结果是另一次获准文件操作。

验证分别检查无目录 Grant 的搜索准入、零共享文件占用、原网络授权撤销、私有工作目录及真实沙箱越界拒绝。Schema 37 或更旧 writer/Worker 不得处理新合同；回退须停机并恢复与旧版本匹配的完整恢复点，不能删 migration ledger 降级。本批源码和受控测试不构成部署授权，也不替代目标平台与实际安装资格。

### Schema 39 自动审查记录

Schema 39 新增 `automatic_action_reviews`，在模型调用前保留唯一请求身份，完成时与原审批及一次性 Grant 同事务写入。备份和恢复须保留审查记录、Owner 委托版本、原请求摘要、受保护输入/输出 Payload、审批来源和原模型费用记录。`pending` 只表示没有已提交决定，不能推断模型未调用，更不能删除该记录后重试付费调用。已完成记录读回历史决定，不重新派发工具。

自动审查默认未装配。当前委托只接受精确请求摘要，批准不能扩成其他文件、命令或长期授权；写入时使用 writer 当前时间，重新核验请求期限、委托版本和 Run 执行租约。已有人工请求或决定优先，撤销、取消、过期及执行权变化阻止迟到批准。审查等待不创建共享文件占用；自动批准保存 `automaticReview` 来源，不能解释为用户对本次操作点击了确认。

迁移时保留审查决定中的已报告置信度、配置的 `specialist` 模型身份和预算账户的 `unknown` 结算状态。目标 Agent Service 必须以自己的启动实例取得新的 Run 执行租约；旧租约和用量不明的审查不能被当作可重放的批准。真实 TypeSafe 调用与费用不由静态迁移检查证明。

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

说明不计入命令自身的输出上限，但计入整份工具结果 JSON 的上限；超过时沿用 `PI_RESULT_OUTPUT_LIMIT`。不另设额度或放宽任何上限，原期限、取消、资源与输出检查保持。目录释放仍按 `process_group_gone` 核验，不证明脱离的后代全部停止。现有页面后台列表不能列出前台 Bash 自行脱离进程组的后代，这是已知限制，不能用列表为空证明没有后台进程。此改动不增加安装、迁移或恢复步骤，不改变本手册的操作授权要求。

[SOURCE: docs/adr/0040-background-output-closed-after-bash-returns.md]
