---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:3c1fd240e0a6867c86e7314b01d01da400fda85a864f50fc77918d9cc0770257"
supersedes: ""
superseded_by: ""
date: "2026-09-11"
---

# Hermes 控制中心升级与真实验收

阅读导航：[适用范围](#scope) · [现场前置核对](#live-state-preflight) · [升级步骤](#procedure) · [验收](#verification) · [并发刷新与回答显示](#concurrent-refresh) · [证据](#evidence) · [回退](#rollback) · [停止条件](#stop-conditions)。

本文绑定 Hermes 的固定日期部署脚本与目录仅保留为历史参照，不适用于云端部署。当前开发测试在 Hermes 的任务自有目录运行，云服务器只用于生产；遵循 [ADR 0047](../adr/0047-test-checkout-on-hermes-nvme.md#storage)，每次生产部署仍须单独授权。[SOURCE: docs/adr/0047-test-checkout-on-hermes-nvme.md]

<!-- runbook-contract:
- docs/execution/specs/2026-09-24-isolated-tool-execution-design.md
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
- packages/execution-contracts/src/sandbox-execution-v2.ts
- apps/agent-service/src/production-copy-save.ts
- packages/platform-node/src/files/workspace-copy-publication.ts
- packages/platform-node/src/files/pi-file-publication.ts
- apps/agent-service/src/production-workspace-copies.ts
- packages/platform-node/src/candidate-workspace/qualified-candidate-workspace.ts
- packages/persistence-sqlite/src/migrations/0046_directory_move_contract.sql
- packages/persistence-sqlite/src/migrations/0047_workspace_copy_contract.sql
- packages/persistence-sqlite/src/migrations/0049_thread_title_budget.sql
- packages/application/src/services/workspace-copy-service.ts
- packages/application/src/services/workspace-claims.ts
- packages/application/src/services/sandbox-execution-reconciliation.ts
- packages/platform-node/src/capabilities/directory-move-scope.ts
- packages/platform-node/src/files/directory-move.ts
- packages/platform-node/src/files/rename-native.c
- packages/runtime-pi/src/pi-runtime-adapter.ts
- packages/application/src/ports/intelligence.ts
- packages/persistence-sqlite/src/sqlite-run-resource-guard.ts
- packages/application/src/services/run-coordinator.ts
- packages/application/src/services/run-execution-input-service.ts
- packages/application/src/ports/run-dispatch.ts
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
- packages/persistence-sqlite/src/migrations/0032_runtime_history.sql
- packages/application/src/services/runtime-history-service.ts
- packages/runtime-pi/src/pi-native-history.ts
- apps/admin-cli/src
- apps/agent-service/src
- apps/control-center/src
- scripts/qualify-control-center-browser.mjs
- scripts/test-thread-loading-browser.mjs
- scripts/test-mobile-composer-browser.mjs
- apps/execution-worker/src
- packages/platform-node/src
- packages/application/src/ports/configuration.ts
- packages/gateway-contracts/src/contracts-v2.ts
- packages/gateway-contracts/src/thread-contracts-v3.ts
- packages/application/src/services/thread-execution-projection.ts
- packages/application/src/services/thread-execution-state.ts
- packages/application/src/services/thread-execution-resources.ts
- packages/application/src/services/sandbox-scope-service.ts
- packages/persistence-sqlite/src
- packages/runtime-pi/src
- packages/runtime-pi/test/fixtures/rejected-current-task-context.ts
- packages/runtime-sandbox/src
- packages/runtime-sandbox/scripts
- scripts/package-node-runtime.mjs
- scripts/install-node-runtime.mjs
- scripts/probe-protected-runtime.mjs
- scripts/operations
- scripts/ci/artifact-files.mjs
- scripts/ci/artifact-archive.py
- docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md
- package-lock.json
- packages/application/src/ports/capabilities.ts
- packages/application/src/services/execution-worker-service.ts
- packages/execution-contracts/src/payload-broker-v1.ts
- packages/platform-node/src/payload-uds-transport.ts
- packages/platform-node/src/capabilities/node-capability-runtime.ts
- apps/agent-service/src/production-payload-broker-handler.ts
- apps/execution-worker/src/production-payload-broker-client.ts
- apps/execution-worker/src/production-worker-composition.ts
- packages/persistence-sqlite/src/sqlite-sandbox-authority-withdrawal.ts
- packages/application/src/ports/sandbox-execution-journal.ts
- apps/agent-service/src/production-run-dispatcher.ts
- packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts
- packages/persistence-sqlite/src/sqlite-sandbox-execution-operations.ts
-->

## Scope

升级用户已明确授权的 Hermes Linux 上 Himawari 安装。目标限定 `/data/hermes/himawari`，以及经用户单独同意后用于程序和运行依赖的 `/opt/himawari/releases`，不操作父目录中的其他 Hermes Agent 服务或其他应用。既有网络资格探针另外使用 `/data/himawari-r8-web-2026-09-11` 中新建的唯一临时子目录；执行前须验证此专用验收根为当前服务账号所有、0700、普通规范目录且位于 `/data` 机械盘，不访问其他同级目录。Mac 仅用于源码开发、浏览器和交付查看，不作为运行主机。此流程不执行跨主机 Authority Transfer，不创建 PR 或推送。

Schema 40 为尚未绑定的预约增加不可撤销的停止标记，并保留独立的有限恢复记录。停止或启动恢复遇到这类预约时禁止后续绑定；已注册环境只通过原认证 Job Host 控制通道请求停止。标记不证明私有环境已清理或共享占用可释放，缺少证据时仍保留 claim；不补造运行时身份或永久释放回执。升级必须先备份并迁移唯一 writer，Schema 39 及以前的 writer 不得接管。Worker 线上消息合同没有新增字段，旧 Worker 也不能绕过数据库绑定检查。

Schema 41 新增独立的 `sandbox_reservation_release_receipts`。只有原认证宿主证明任务从未启动、原进程已退出且清理完成，当前 writer 才能同事务保存永久回执并释放该预约的占用。原停止标记保持不可撤销，不伪造运行时绑定、业务结果或退款；重复停止和恢复读回原事实，不因核验凭据过期重新占用。缺少宿主证明、仍有保护或已启动任务的后代状态未知时继续保留未确认状态。备份与权威迁移须同时保留回执、停止标记及受保护宿主证据；Schema 40 及以前的 writer 不得写入新库，回退仍需停机并恢复匹配旧版本的完整恢复点。

轮次已取消、失败或完成后，如果某个工具只有准备事件而没有结束结果，页面显示“结果未确认”，不持续显示准备中；明确未派发的原证据仍显示“尚未派发”。缺少真实起止边界时不生成时长，刷新后沿用相同规则。

新增的 `thread.execution_state` 状态查询只有服务配置声明 `executionStateAvailable` 时才由新页面使用；原事件查询保持严格兼容。安装验收须核对新页面与服务能力声明一致，整体与工具行共同保留未知结果，断线不会覆盖已完成事实；Stop/清理仍使用原 revision、权限和幂等入口。新查询仅从持久 Run/Trace 汇总已有事实，操作结果列表不是文件已回滚、资源已释放或所有后代已停止的证明。资源 journal、队列及全部阶段仍未完整接入，不能据此跳过本 Runbook 的平台与现场资格。本展示升级无新 migration，也不授权本机任务自动切换 Hermes。实现与本地证据见[统一状态接入记录](../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p6-unified-state)。

执行状态旁的下一步提示必须从持久 `ThreadExecutionState` 和当前 `availableActions` 得出；不得展示后端没有提供的 Stop/清理动作，不自动重发工具，也不推断失败已回滚或资源已释放。命令以非零码退出且效果未断言时，页面应保留“已失败”事实，同时说明工作区可能已有改动、具体效果尚未核验，并要求先检查工作区。安装复核须覆盖至少一个明确未派发、一个效果未知和一个非零命令退出场景，并核对刷新后的持久状态。当前本地通过了页面/状态单测，以及在模拟浏览器环境中渲染会话页面的组件测试（2026-09-25 复验）；完整安装资格与真实 Gateway→Worker→页面联合路径尚未通过，不能将这段提示视为已完成现场验收。实现证据见[P1 页面下一步记录](../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p1-next-action)。


Job Host 还在 DNS 解析前、拨号前通过原认证 Worker IPC 逐次核对 Agent 当前 scope，已有连接按 250 ms 周期重查；每次回复只供原检查使用，1500 ms 未答、撤销、断开或身份变化均拒绝并关闭出口。Worker 与 Job Host 必须来自匹配安装产物，不能用旧组件缺少核验回调作为继续联网的理由；TLS 内部请求不可见，周期核验不构成每个加密请求的原子授权。

只读网络重试只在原调用仍运行时发生：声明零费用的 GET 与固定公开 `web_search_exa` 查询，对明确暂时错误最多重试一次；默认退避 250 ms，有有效 Retry-After 时至少等待该值，原期限不足则停止。GET 决定重试时用单调时钟记下最早发送时刻；等待提前返回时补等剩余时间，每次补等仍受原中止信号和原总期限约束，不为重试增加时间预算。GET 每次重查当前授权和秘密句柄，搜索在重试前建立新代理连接以重新触发出口检查，并沿用原 MCP 请求期限；任意写入、未知非幂等结果和有费用的 endpoint 不自动重发。重启、备份恢复或权威迁移不会恢复重试计数或重新执行历史工具；此策略没有新增恢复表、迁移或部署开关。

内部资源快照 `readRunInventory` 只读取已有同主体 Run 的预约、绑定、队列历史及旧格式未释放标记，不变更数据库版本、额度或执行权。生产 `thread.execution_state` 已将该快照与 Run/Trace 聚合，读取期间资源或 Run 改变时拒绝混合结论。历史 Scope 仅用于验证原工具归属，不读取或续发当前 Grant；停止、核验和资源状态未确认通过既有 `reasonCode` 表达，保持 v3 阶段枚举兼容。工具效果与资源清理分别保留；当前准备或受控执行尚无最终结果不等于结果未知，显式未知、观察失效或停止后无结果仍显示未确认。已释放但未交接的内部结果仍显示结果未确认。当前可见会话每两秒重新只读核验，隐藏或断线时停止该轮询，不把连接心跳或本地计时当作执行事实；空快照与旧权限都不能代替当前宿主停止证明或本 Runbook 的现场核验。读取超过任一 10,000 条上限时必须报告失败，不接受截断后继续操作。

新增的 `thread.execution_environment` 查询（读取当前执行模式、仍在运行的后台或服务类程序、严格模式下不可用的工具）只有服务配置声明 `executionEnvironmentAvailable` 时才由新页面使用；未声明时页面不显示输入框上方的状态条和侧栏转圈标记。这个查询只读已有执行记录和安装声明，不含命令内容和内部编号，不新增 migration，也不能停止程序或切换模式。安装验收须核对状态条显示的模式与本机配置一致（写了 `taskEnvironments` 时为“严格模式”，否则为“默认模式”）；列表为空不证明宿主上没有残留进程，不能代替本 Runbook 的现场核验。实现与本地证据见[执行环境显示的记录](../../test/qualification/evidence/isolated-tool-execution/p3-ui-environment-01/README.md)。

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

## Authoritative Sources

- [SOURCE: docs/execution/specs/2026-09-10-control-center-local-acceptance-design.md]
- [SOURCE: docs/execution/plans/2026-09-10-control-center-local-acceptance-plan.md]
- [SOURCE: docs/execution/plans/2026-09-07-srt-unified-execution-plan.md]
- [SOURCE: docs/adr/0027-built-in-owner-authentication.md]
- [SOURCE: docs/adr/0028-protected-runtime-installation.md]

原生历史修复的切换前资格入口为 `scripts/operations/hermes-native-history-qualify.py --qualify`。该入口只适用于 schema 32 原生历史候选及 v3 数据库副本演练通过的现场；在独立证据目录创建受保护候选，通过 systemd 私有目录视图把候选映射到最终安装路径，当前线上服务仍使用原安装。先核对真实签署者可读取工作区 device/inode 且目录身份不变，再由实际运行账号验证写入拒绝、完整核验复用与六组资格探针，成功后签署新安装事实。此步骤只新增候选安装、独立保护记录与资格证据，不改线上配置、数据库、服务单元或当前保护记录。通过不代表正式切换完成；后续仍须执行已核验停机备份、schema 迁移、旧历史导入、启动和真实模型验收。

若首轮停在 `composition-installed`，且独立诊断和同账号对照确认临时测试运行目录误用了正式安装保护记录，可使用 `scripts/operations/hermes-native-history-resume-qualification.py --resume`。此入口核对冻结脚本和既有诊断，只在该合成目录用例中不设置安装保护记录，继续使用完整文件摘要验证；正式安装权限与缓存探针保持启用。新结果写入 `attempt-v2`，保留首轮失败证据，六组通过后才发布签署结果。

正式原生历史切换入口为 `scripts/operations/hermes-native-history-cutover.py --apply`，只适用于其绑定的 Hermes 安装、签署摘要和十轮旧历史候选。停服前通过私有候选视图检查历史水位及真实启动配置和已注册能力语义；确认无活动 Run、无未释放沙箱后，停服创建并核验 schema 31 备份。新版 CLI 正常迁移到 schema 32，导入器通过普通仓库锁和 Authority 保存历史，随后切换安装、保护记录和启动入口。首次启动前失败时，先保存失败数据，再用同一已核验恢复点恢复旧 schema、配置、文件所有权和安装；这个恢复目标与范围须包含在本次具体执行授权中。首次启动已尝试后不自动回退数据库，防止丢失新接纳的工作；停止失败服务并保留现场。启动 ready 仍不能代替真实模型验收。

在 schema 32 已切换的安装上，后续 E2E 修复使用独立的安装候选与资格目录，不再次迁移数据库或导入旧历史。`hermes-ui-session-qualify.py --qualify` 绑定本次界面语言与令牌刷新候选的源码摘要，并复用已验证的签署顺序、权限保护和六组安装探针；在正式切换前保留当前运行安装及其保护记录。验收通过后，`hermes-ui-session-cutover.py --apply` 必须绑定本次签署摘要及当前安装摘要，核对无活动 Run 与未清理作业，停服创建并验证 schema 32 备份后只切换安装、启动配置与保护记录，不重做迁移或历史导入；首次启动前失败恢复旧安装，首次启动尝试后保留数据现场。语言选择仅控制 UI，不注入模型回答语言。页面只有收到服务器明确的 `HTTP_GATEWAY_CSRF_REJECTED` 时才在身份和 authority 均未变化的前提下更新令牌，使用原请求和原幂等键重试一次；网络失败或其他拒绝不自动重试。

通用 Harness 生命周期候选使用 `hermes-harness-qualify.py --qualify`，构建目录为 `/data/hermes/himawari/builds/2026-09-12-harness-lifecycle`，独立资格目录为 `2026-09-12-harness-lifecycle-installation`。该候选从 Cindy 借鉴工具结果指纹和有限窗口循环检测，并在 Pi 审批续跑快照中保留检测状态、排除已完成结果的本地重放；取消事件在 SessionManager 中保留原生类型，交由 Pi 在发往模型时转换。入口绑定当前 `a83239f9…` 运行时、候选源码归档、完整安装树和各辅助脚本摘要；先以真实运行账号检查六个页面资源及入口引用，再执行既有六组受保护安装探针并签署新证据。资格阶段不停止线上服务、不写产品数据库、不改变模型路由。循环中止与取消事件保真已有确定性测试；旧对话正确回答和多工具正常汇总仍需通过实际服务验收，不能把本候选签署结果当成这两项通过。后续切换使用 `hermes-harness-cutover.py --apply --receipt <本次签署摘要>`，绑定本候选资格目录及当前 `a83239f9…` 安装。入口先以实际运行账号再次核对候选页面，再确认无活动 Run、无未清理作业，停服创建并验证 schema 32 备份，核对候选启动配置和已注册能力后切换安装。当前启动器绑定 `2026-09-12-three-fixes-installation`；新启动器绑定本次 `harness-lifecycle-installation`。首次启动前失败恢复旧安装与配置；首次启动尝试后失败则停止服务并保留数据现场，不自动回退数据库。

`hermes-harness-finalization-comparison.mjs --compare` 用于已切换 `0d269e65…` 候选后的完成阶段诊断。只读取两条明确授权的四工具失败 Run：旧分支的 `run:cb547c58-80ea-42e6-8b90-4cfac81dcdf2` 和本次复测的 `run:d1872f77-4434-405f-af8c-ecb3cfbb485c`；先核对各四个作业均已清理、结果按原调用 ID 成对且全部成功。每条原始输入对照两种后续响应，各重复两次：原始工具选项，以及 Pi 在存在工具历史但当前工具列表为空时的 `tools: []` 序列化。所有消息、工具结果、推理和模型路由保持原值，不附加新请求，不执行返回工具。最多八次模型请求，本组预估上限 0.50 美元；费用合并所有前组实际费用、未知费用完整预留、新鲜产品费用及搜索预留，累计不得超过已授权 2 美元。结果仅导出结构、摘要、费用、工具状态标记及经既有产品脱敏器处理且不超过 2400 字符的合成验收回答。此步骤不写产品数据库、不更改服务或生产配置；通过只说明本次对照支持进一步设计完成阶段，不能据此关闭全部工具或宣称正式任务验收已通过。

Worker 阶段编号修正候选使用 `hermes-loop-identity-qualify.py --qualify` 与 `hermes-loop-identity-cutover.py --apply --receipt <本次签署摘要>`，绑定 `2026-09-13-loop-identity` 构建和当前 `7b05555b…` 安装。其前一版真实验收在第四次相同目录结果后仍请求第五次审批，已取消且没有执行第五次；原因是内置文件工具的 Worker 阶段编号与模型调用编号不同。此修正只在产品内置工具的受保护 `pi-result.v1` 结果中排除瞬时来源调用编号，保留其他来源与内容变化，自定义工具输出仍作为不透明内容比较。使用原有六组隔离安装探针、schema 32 备份核验和安装切换，不修改模型路由或导入历史。安装后须重新完成逐项审批循环中止及单次说明验收；四工具正常汇总和旧对话当前来源仍分别验证，不能相互替代。历史固定日期脚本的摘要属于原冻结入口，格式整理后的源码不能冒充原字节重新执行；本候选每个辅助入口重新绑定实际使用的脚本摘要。


P3 文件协议使用 Schema 46 的 writer 边界。升级和恢复必须保留原文件候选、逐文件发布记录、目录移动意图/收据、队列与占用；不得整批回滚已成功文件或覆盖后续人工修改。合同 3 的确定未发布冲突是失败结果，不是成功写入。目录工具合同 4 的 `rename-native` 随目标平台构建并受 runtime 摘要核验，Mac 包不能移作 Linux 包。新增固定文件完成资格仅适用于已验证的固定程序正常结束，旧资格与普通命令的未知清理仍保留保护；实际安装资格和启用不能由测试结果自动生成。详见 [SOURCE: docs/execution/specs/2026-09-16-workspace-authorization-lifecycle-design.md]。

P4 工作副本保存合同将当前 writer 边界推进至 Schema 47，保留已有行和历史迁移。副本的待保存操作包含目录授权版本、根身份、输入内容/身份基线及先前逐文件保存结果；Schema 46 或更旧的程序必须拒绝写入，不能忽略这些条件继续执行。恢复点须同时保留对应受保护内容和文件操作记录；若单独配置候选目录，须核对其备份范围，不能仅凭数据库备份宣称唯一候选已受保护。过期不自动应用或删除候选；回退须停止新 writer 并恢复匹配旧程序的完整恢复点。本批没有执行实际实例迁移，也没有为缺少资格的候选命令后端生成启用资格。

任务级执行环境记录将当前 writer 边界推进至 Schema 48，保留已有行和历史迁移。新表保存每轮对话一个的执行作业、按“第几个环境”编号的环境记录、环境级占用（`lease`，整个环境持有的工作目录占用登记，释放前会冲突的其他任务不能动这些目录）、每次调用与环境的关联、停止记录和不可修改的释放回执；原来单次调用的执行记录含义不变。Schema 47 或更旧的程序必须拒绝写入新库，否则它看不到环境级占用，可能让冲突的任务提前运行。Run 结束前现在还要求本轮没有未释放的环境。现有执行路线不会创建这类记录，所以升级后这些表为空；本迁移也不启用新的执行后端。备份和恢复点须随数据库一起保留这些表；回退须停止新 writer 并恢复匹配旧程序的完整恢复点，不能删除新表或修改迁移账本来降级。只读核查使用[工作区历史占用只读核查](workspace-lifecycle-audit-runbook.md#procedure)的 `environments` 分区。本批没有执行实际实例迁移。

对话标题预算账户将当前 writer 边界推进至 Schema 49，保留已有行和历史迁移。本迁移重建模型预算账户表 `model_budget_accounts`（记录每个花费主体已预留和已花费的模型费用），新增一类账户：自动生成对话标题的那次模型调用改记在本轮对话专属的标题账户（账户号 `thread-title:<Run ID>`），不再记在本轮对话（Run）自己的账户里。这样标题调用结果不明时，只有标题账户进入待核对状态，不会挡住本轮对话的派发、恢复或结束。依赖该表的预算分配表 `model_budget_allocations` 和模型调用身份表 `model_invocation_identities` 随之重建，原有行逐行保留；旧行都属于原有几类账户，所以升级后不会凭空出现标题账户。全局费用上限和按数据级别的费用上限仍计入标题账户，单轮费用上限对标题账户单独计算。Schema 48 或更旧的程序必须拒绝写入新库，否则它读不懂标题账户。备份和恢复点须随数据库一起保留这三张表；回退须停止新 writer 并恢复匹配旧程序的完整恢复点，不能修改迁移账本来降级。本批没有执行实际实例迁移。

SRT 可选工作副本使用 `privateRoot/workspace-copies` 保存当前文件基线和候选内容，生产 Owner 入口按既有 Bash 配置装配创建、选择和准备操作。`prepare` 不表示已保存回原目录；保存须配置 `save_copy` 工具和 `pi-coding-tool@5` 前台 `verified_effect` 描述，经原 Run/Worker 准入队列逐文件执行，不能启用绕过该队列的旧 `host.file.execute`。描述的 `directoryOperations` 是上限，实际 scope 仅含 read 与当前操作；移入回收区仍须 trash 授权。 备份须同时保留任务私有目录中的 `copy-save-state-*.json`、原目录 `.himawari-recovery` 中的已暂存内容/快照以及 SQLite 操作记录；最终结果写回中断后，只能在原资源已确认释放后核验并导入历史效果，不能重新派发保存。旧严格 Scope 读者会拒绝合同 5，禁止混用不支持该合同的 Agent/Worker 或复用旧安装摘要。备份或权威迁移必须保留唯一副本和受保护的选择/操作记录；换主机或路径后重新验证目录身份、来源授权与执行资格，不能沿用旧 inode 或进程证明。具体已验证范围见[P4 完成验收](../archive/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#p4-completed)。


## Safety and Preconditions

升级前复核能力安装声明中的 `privateRoot`：Linux 最紧的是 SOCKS 网络桥，最多 27 个 UTF-8 字节；Mac 不创建该桥，最紧的是本地 mux，按 5 位 PID 与固定序号 `0` 预算，最多 37 个字节；当前每个 Job Host 是新进程，只接受一次 prepare、初始化一次 SRT。上游 `parentProxy` 不会关闭 mux，产品未启用 TLS 终止与 SRT 日志监视套接字；控制接口预算仍为 100 字节。加载器取实际启用路径的最紧预算，以 `CAPABILITY_DEPLOYMENT_INVALID_VALUE` 拒绝超长声明，消息包含实际字节数、上限及决定预算的套接字。路径调整须重新计算声明摘要并保留原安装/恢复依据，具体操作边界见[安装 Runbook](install-start-stop-runbook.md#safety-and-preconditions)，组成部分见[按平台核算套接字预算](../backlog/BL-20261002-002-生-产-privateroot-超-过-27-字-节.md#socket-budget)；Mac 依据来自 SRT 0.0.75 源码，未在 Mac 上验证。

Pi 默认工具提示修复候选使用 `scripts/operations/hermes-three-fixes-qualify.py --qualify`，仅适用于其绑定的 UI-session 版本已经上线的现场。先验证本次源码归档、准备清单和全部安装文件摘要，再复制到独立候选目录；同样使用真实运行账号、最终路径的私有视图和六组安装探针。复制后的 workspace 链接必须指向隔离源码中的同名包，不能沿用构建目录的绝对链接。首次尝试若在链接保护阶段失败、且尚无探针输出或运行授权文件，可使用 `--resume-links`：核验安装文件与源码摘要、保留首次失败记录后，仅重定位身份匹配的 workspace 链接；任意其他外部链接仍然拒绝。此入口不切换线上版本。

签署者读取资格目录中的受保护源码清单副本，避免把旧候选的源码信息写入新签名。正式切换使用 `hermes-three-fixes-cutover.py --apply --receipt <本次 installation-receipt.json 的 SHA-256>`，须核对资格结果与签名摘要、旧安装摘要和服务入口；在没有活动 Run 时停止服务、创建并验证备份，再切换候选。保留既有 schema 32 和历史，不重复导入。新服务启动前的失败恢复原安装；尝试启动新服务后的失败保留现场数据供诊断，不盲目恢复旧数据库。

若新服务未就绪，使用 `hermes-three-fixes-startup-diagnostic.py --read-startup-errors` 导出限定长度、脱敏后的启动日志。检查最近日志时须包含 `service.failed` 等结构化事件，不能只筛选 `Error` 字样。`hermes-three-fixes-recover-service.py --restore-installation-only` 仅适用于本次绑定的启动失败：确认 schema 32、无活动任务、切换后没有新 Run，保存失败安装与当前配置后恢复旧安装及原配置，并重新等待 Agent、Worker 就绪。该恢复入口不恢复或覆盖数据库；出现新任务时拒绝继续，需要根据现场判断兼容性。

本次因缺失 `share/control-center` 触发的 `PRODUCTION_HTTP_STATIC_ROOT_INVALID` 使用 `hermes-three-fixes-cutover-v2.py --apply --receipt <本次签名摘要>` 重试。它只补入摘要已绑定、且与现用页面一致的六个浏览器构建文件；停机前在候选私有视图中，以真实运行账号检查静态根目录、全部文件和 HTML 引用，并重新计算运行时摘要，确认六组安装探针所签署的运行时代码未变。静态检查不通过时保持原服务运行。切换结果与备份使用独立的第二次尝试名称，保留首次失败与恢复记录。

本次三项修复回归另获最多 2 美元的模型与搜索调用授权，仅使用已有合成验收对话和验收文件。`hermes-three-fixes-observer.py` 以本次开始时间及三个固定验收 Thread 限定费用、任务和清理摘要，已结算调用计实际费用，未知调用保留预计费用。每次发起真实回归前核对新鲜摘要和配置中的每 Run 上限，为未决调用与搜索成本保留额度；没有可验证的剩余额度时不发起新调用。该观察器最多运行一小时，不执行模型或工具，也不导出对话正文、配置全文或凭据。

若真实模型在取得正确工具结果后仍串入旧任务或重复调用，先用 `hermes-three-fixes-model-diagnostic.mjs` 检查固定合成 Run 的消息结构、调用编号和结果摘要。`hermes-three-fixes-input-comparison.mjs --compare` 仅用于两个固定失败输入的离线对照：原输入、临时移除旧的明文推理、仅保留当前轮，各重复两次，最多十二次模型请求。后两种都是实验副本，不改写持久历史，也不是已采纳的产品方案；当前轮推理和工具结果保持不变，遇到旧签名推理则拒绝实验。它使用既有 OpenRouter 模型及凭据，在本次 2 美元授权内另设最多 0.50 美元的保守预估上限，运行前核对最新公开价格，并通过 OpenRouter `provider.max_price` 限定单价、拒绝额外按次收费，每次记录实际费用；费用缺失或超出预估立即停止，不重试。返回的工具调用只做摘要，绝不执行。证据目录排他创建，阻止重复启动；读取生产数据库时启用只读模式，输出限定结构和已知标记，不导出消息原文或凭据。该模型对照费用单独记账，必须与产品观察器费用合并核对，不能只看产品预算表。

在上述对照仍复现故障时，`hermes-three-fixes-provider-comparison.mjs --compare` 保留两个输入的完整历史及本轮推理，以 OpenInference、DeepInfra 两个公开可用上游为对照；四工具输入另比较仅提取本轮 `pi-result.v1.content` 的原生文本。每个条件重复两次，合计最多十二次非流式请求，输出上限 4096 token；天气输入不做无意义的工具包装变体。两种输入差异和上游差异分别记录，不能用单个成功样本推断根因。路由保留原有数据收集和 ZDR 约束，原路由若排除任一目标则拒绝运行；每个请求固定一个上游且不回退，并根据最新端点价格设置上限。开始前只读核对本次产品已结算费用、上一组对照实际费用，另保留 0.25 美元搜索额度；本组预估最多 0.50 美元且三者合计不得超过本次 2 美元授权。未决产品费用、价格异常、响应上游不符或费用缺失即停止。脚本不修改正式路由、历史或工具结果，不执行模型返回的调用，使用独立排他证据目录，仅输出摘要。

若 provider-comparison 在第二个 DeepInfra 请求超时停止，`hermes-three-fixes-tool-content-comparison.mjs --compare` 只补做尚未执行的四工具结果格式对照：固定原失败 Run 及四个工具调用编号，保留全部历史与本轮推理，在 OpenInference 分别发送原包装和仅提取本轮原生文本的实验副本，各两次，合计四次。它校验前一脚本的冻结摘要、前一结果确为第二次调用超时，并将该组全部预估费用继续预留；不重试超时请求。继续使用只读数据库、当前结算费用核对、每组最多 0.50 美元和累计 2 美元约束，以及原有数据收集和 ZDR 约束。输出仅供判断输入格式的影响，单独成功样本不能代替真实产品回归。

当历史删减和本轮工具文本提取都不能消除重复调用时，`hermes-three-fixes-provider-matrix.mjs --compare` 用两个原始失败输入对照 OpenInference、BaseTen、DeepInfra，分别固定 `open-inference/fp8`、`baseten/fp8`、`deepinfra/fp8` 端点，按对应端点定价；保留所有消息、工具定义及推理，各条件计划两次，最多十二次请求。输出上限统一 4096 token，单次等待上限提高到 240 秒；某上游第一次请求失败后，跳过该上游剩余样本，继续其他上游。失败或费用未知的请求按全部预估费用占用预算，不算免费，也不自动重发。响应上游不符、认证拒绝或总费用超界则停止整组。运行前合并本次产品新鲜已结算费用、首组输入对照费用、超时组全部预留和四次格式对照费用，继续保留搜索额度；本组预估上限 0.50 美元、总授权上限 2 美元。每个请求按公开最新端点最高价格设置 `provider.max_price`，保留原数据策略，禁止回退和执行返回工具。该入口只产生独立实验摘要，不修改生产模型路由；有完整对照结果后才决定是否存在可采用的上游路由修复。

`hermes-three-fixes-task-context.mjs --compare` 验证通用上下文扩展的效果：固定当前生产配置指定的单一端点，使用同样两个受保护的原始失败输入，各对照原始输入和本轮状态提醒两次，最多八次请求。不切换模型或提供商、不改写历史、不执行返回工具。提醒文本来自已编译并绑定摘要的候选模块。2026-09-12 对照中该候选四个样本仅一次天气通过、两次多工具均失败，已从运行时撤回；源码保存在 `packages/runtime-pi/test/fixtures/rejected-current-task-context.ts`，仅用于核对既有实验，不能作为当前产品能力或上线方案。费用合并所有前组实际费用及未知费用预留，保留搜索额度；本组上限 0.50 美元、累计授权上限 2 美元。原始消息、调用 ID、工具结果和推理逐字保留，仅在完整结果批次之后附加当前请求和返回状态。该组非流式对照通过后仍须真实服务流式验收；循环中止不能算正常任务完成。

用户已授权在 Hermes 安装、使用机械盘、复用现有 OpenRouter 凭据进行累计不超过 1 美元的验收，并批准内置账号登录。2026-09-12 全功能 E2E 另获最多 2 美元模型与搜索预算，优先使用 DeepSeek V4 Flash 0731；两笔预算分别记录，不能把额外上限当作剩余额度。模型调用只使用验收文本，文件操作只针对明确授权工作目录的验收文件。预算包含已发生费用及不能确定实际费用的预留，不将失败调用算作免费。

当前目标是 `hermes-home`，SSH 为 `hermes`，Cloudflare 认证无法及时完成时使用已授权的 `hermes-tailscale-breakglass`。公开入口是 `https://himawari.siyi.win`，保留现有 Cloudflare Access 和 tunnel，只更新本机 127.0.0.1:18082 的产品服务。不得改变其他账号、网络规则或共享磁盘挂载。

## Live-State Preflight

核对候选完整安装包含[预热准备线程](#pi-preparation-prewarm)的 pool 模块、准备入口、线程入口及 runtime-pi 导出。本次运行时变更须走完整安装资格流程；切换前的正常停止须等待该池拥有的全部线程退出，再按下述步骤检查旧服务进程、socket 和锁。

只读核对主机名、Linux/架构、`findmnt /data` 与磁盘可用空间；核对 `systemctl cat/status himawari.service`（受保护迁移后的系统级服务，运行账号必须为 `himawari`） 的真实单元、PID、安装前缀和工作目录。检查生产配置的 Owner/Agent/deployment 与现有 authority、数据库记录一致，记录活动 Run 和已发生/预留费用，禁止输出配置全文或密钥。确认配置、state、qualifications 均是规范路径且权限安全，旧发布目录保留且可回读。

安装候选归档之前，按[归档解包与临时磁盘](install-start-stop-runbook.md#artifact-extraction-contract)核对匿名 tar 与解压 payload 所在盘的可用空间。r62 完整产物会临时多占 `328202240` 字节，约 `330 MB`，解包结束后自动释放；写出 payload 时两份数据同时存在，不能只按压缩归档大小估算。直接父目录缺失时，匿名暂存使用父链中最近的已有目录，必须核对该目录实际所在盘。[SOURCE: docs/runbooks/install-start-stop-runbook.md#artifact-extraction-contract]

新建证据运行 ID 后，将白名单源码清单、SHA-256、秘密扫描结果和真实命令结果写入本次证据目录。工具链使用固定 Node 22.22.3/npm 11.8.0，依赖闭包来自精确 lockfile。构建、开发依赖、临时探针和数据库放在 `/data`。用户授权 NVMe 迁移时，仅完整安装前缀中的程序、运行依赖和静态页面复制到 `/opt/himawari/releases/<版本>`；先核对根盘确为 NVMe、剩余空间至少 10 GiB 且复制后仍保留该余量。数据库、附件、日志、备份与构建缓存继续位于 `/data`。

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

安装目录权限遵循[安装前提](install-start-stop-runbook.md#safety-and-preconditions)：本次新建的解压目的目录及其父目录、安装前缀目录链和新运行时目录固定为 `0755`，安装器内部暂存根仍为 `0700`；已有 prefix、lib、bin 只清除同组及其他用户写权限，保留原私有访问限制；文件字节和包内模式不变。[SOURCE: docs/runbooks/install-start-stop-runbook.md#safety-and-preconditions] 受保护迁移入口仍设置 umask `077` 并显式规范目录及文件模式，不能用修改产品检查器或放宽写权限替代安装修复。R2-D15 只核对该升级入口源码，不执行受保护升级；Hermes 回归结果不证明 Ubuntu 24.04 生产机的 AppArmor 前提成立。

归档分支在一次完整 gzip 解压、tar 完整预检及全部 payload 内容检查后移动运行时，复用解包器已经设置的 `0755` 目录模式，省去重复目录规范步骤。源码复制分支继续规范新运行时目录。两个大小上限、混合错误顺序与测试侧独立回读覆盖见[归档解包与临时磁盘](install-start-stop-runbook.md#artifact-extraction-contract)及[安装权限验收证据](install-start-stop-runbook.md#installation-permission-evidence)。本轮 D15 没有执行受保护升级、生产状态迁移或部署；Hermes 结果不能代替 Mac、Ubuntu 24.04 生产机或其 AppArmor 前提的实际检查。[SOURCE: docs/runbooks/install-start-stop-runbook.md#artifact-extraction-contract] [SOURCE: docs/runbooks/install-start-stop-runbook.md#installation-permission-evidence]

TE-11 的执行事件传输使用固定分页版本：请求和响应均为 `x-himawari-events-pagination: 1`，响应另带 `x-himawari-events-page`（more/complete）及非空页的 `x-himawari-events-next-cursor`。升级时 Agent 与 Worker 必须取自同一安装产物并成对切换；旧新混用会拒绝事件读取，不能保留旧 Worker 单独更新 Agent。详情见[执行事件有界分页设计](../execution/specs/2026-09-29-execution-event-pagination-design.md#协议) [SOURCE: docs/execution/specs/2026-09-29-execution-event-pagination-design.md#协议]。本变更无数据库迁移；单次正文上限、认证和期限保持原值。缺少分页标记或单事件超限时停止并保留诊断，先核对两端产物身份，不能调高上限或重放工具。

2026-09-16 的 v4 发布绑定源码提交 `0600b2958432a4592a52e5c01cf92794a7af7121`，构建与资格目录使用 `2026-09-16-v4-0600b29`。本次用户已经批准部署，并完成两小时临时 sudo 认证，实际到期时间为 `2026-09-16T01:22:45Z`；此授权只适用于本次执行，不得延长或作为后续部署的凭据。候选采用固定 Node/npm 工具链重新安装依赖、构建完整运行时，六组安装资格采用正式 `himawari` 账号和最终私有挂载路径。冻结辅助入口位于 `/etc/himawari/deploy-v4-0600b29/`，分别绑定源码、准备清单、运行时和辅助程序摘要；切换必须传入本次签署回执摘要。Pi 能力入口字节与现用版本相同，因此只核对注册能力声明不变，不运行历史 Registry 摘要迁移。沿用 schema 32 完整备份验证、仅替换 NVMe 只读绑定与签署启动配置；保留原 `2026-09-15-main-4f1e86f` 安装。不重新导入历史，也不更换模型或身份设置。此次没有新的付费模型预算，安装验证与生产页面验收不得冒充真实付费模型对话验收。脱敏证据及冻结脚本副本保存于 `test/qualification/evidence/control-center-v4/deployment-hermes/`。

2026-09-27 将隔离执行分支提交 `c71adbd5f23a88834512ad26112f587d6fa993b9` 部署到 Hermes，数据库从 schema 32 迁移到 48，安装根为 `/opt/himawari/releases/2026-09-27-c71adbd`。所有者说明当时没有用户，因此不在数据库副本上预演，直接执行第 4、5 步；资格验证和签署仍照常进行，因为启动脚本要核对签署回执。跨多个 schema 升级时，停服后按顺序执行：完整备份并验证、`db migrate`、所有者批准的删除（`delete purge`、`sandbox purge-unconfirmed`），再切换。断网构建需要把以往构建的 npm 缓存合并到本次缓存，并在构建源码目录的 `.npmrc` 写 `prefer-offline=true`，否则 npm 会因缓存过期尝试联网而失败。

Pi 编码工具程序 `pi-coding-main.js` 的字节改变而版本号不变时，第 6 步的 `capabilities register` 会以 `ADMIN_CAPABILITY_REVIEW_REQUIRED` 拒绝，切换脚本中的“已注册能力不变”检查也会失败；目前没有更新“同版本、只换程序”登记的正式命令，也不得手工改表。本次所有者选择先启动、以后补登记：续做脚本只接受 `himawari.pi-coding` 的 `integrity` 与 `artifact.digest` 两个字段的差异，没有写登记表。服务运行时只检查登记的状态、版本和允许的操作，实际程序由签署的部署快照核对。另外，Worker 等待 Agent 发布启动绑定的期限固定为 30 秒，以往启动约需 20–25 秒；本次迁移后首次启动超时，由 systemd 重启后就绪，切换脚本应以两个进程的 `service.ready` 为准并检查重启次数。升级前除核对执行记录的清理标记外，还必须查出 `sandbox_workspace_occupancy` 中 `released_at` 为空的占用，以及 `sandbox_workspace_barriers` 中未解决的保护，并逐条对照所属执行和 Run；本次漏查了占用表，v4 缺陷留下的两条旧占用在上线后挡住了所有写文件请求，处理见证据中的[旧占用修正](../../test/qualification/evidence/isolated-tool-execution/p3-hermes-deployment-01/README.md#occupancy-fix)。执行记录、差异明细与冻结脚本见[本次部署证据](../../test/qualification/evidence/isolated-tool-execution/p3-hermes-deployment-01/README.md)。

发布文档与源码应在同一份干净的候选源码中核对和生成 `contract_sha256`，并用同一候选执行严格文档检查。主工作区存在未提交修改时，先导出已提交源码，再只叠加本次明确纳入的修改；不能用主工作区的摘要给另一份 Git 归档作保证。提交后重新导出该提交复验，防止未提交的前端或脚本内容影响摘要。

执行过程与自动标题版本（源码提交 `3b21555`）沿用 schema 32 的安装切换流程。发布输入必须来自该提交的独立源码归档，不能混入主工作区未提交的品牌、语言或文档修改。候选目录为 `/opt/himawari/releases/2026-09-14-web-3b21555`，独立构建和资格目录分别为 `builds/2026-09-14-web-3b21555`、`qualifications/2026-09-14-web-3b21555-installation`。六组资格探针重新执行并签署本次实际运行时；资格入口和切换入口分别绑定源码、辅助脚本、产物与回执摘要。当前服务已经通过 `BindReadOnlyPaths` 绑定 NVMe 安装，切换时只替换这一条已核实的绑定及对应启动器，保留旧 NVMe 安装用于恢复，不使用最初迁盘时要求“没有旧绑定”的脚本条件。无 schema 迁移与历史重导，模型路由、记忆检索和身份设置保持原配置；新无标题对话的标题请求使用当前模型与原费用账本。发布后检验生产 HTTP 就绪和静态资源，使用明确标记的合成验收对话验证回答、自动标题和刷新持久化；历史对话批量补名不包含在本次发布中。

NVMe 迁移保持已签名能力的规范运行路径不变：在服务私有挂载视图中，用 `BindReadOnlyPaths=/opt/himawari/releases/<版本>:/data/hermes/himawari/releases/2026-09-11-control-center` 将固态盘的受保护安装挂到原路径。宿主上的旧机械盘安装保留，作为切换前回退源；服务实际读取的设备必须通过其挂载命名空间内的 `findmnt`、`stat` 和 `/proc/<PID>/exe` 独立核对，不能只看路径名。新版本的资格探针必须采用完全相同的只读绑定视图，并重新签署实际运行时摘要。切换脚本只替换保护记录、启动入口和绑定配置，不重命名或覆盖旧机械盘安装；后续升级必须检查现有 `BindReadOnlyPaths`，不能继续套用只替换宿主旧目录的脚本。

Agent 在创建沙箱服务时完成本进程的首次安装校验，校验失败不得进入 ready。Worker 的独立校验不能代替 Agent 的校验。受保护安装仅复用安装身份及文件身份、权限、大小和修改时间均一致的程序摘要；每次仍检查保护记录、进程权限、父目录、工作区和执行授权。外置或未受保护程序保留逐次字节校验。首次校验、不同 runner 之间的复用、权限变化和失败重试均须通过自动化回归；记忆检索及其参与问答的流程保持完整，不添加空记忆跳过路径。

迁移前先保持旧服务运行，在独立资格目录验收写入拒绝、六组现有 Linux 探针和实际 host verification 的首次及重复耗时。全部通过后确认无活动 Run 和未清理沙箱，停服创建并独立核验 schema 32 备份，再切换绑定、保护记录和启动配置。首次启动前失败恢复旧 unit、保护记录、配置及 attestation；首次启动已尝试后保留数据库和失败现场。Agent 与 Worker ready 后，再通过真实请求测量记忆检索、搜索启动和完整回答耗时；安装探针通过不代表问答已通过。

仅修改控制中心资源的修订可以采用静态资源切换：先核对候选提交相对当前生产提交只改变浏览器实现、对应测试及运行手册，依赖锁、Gateway、Agent、Worker、数据库和受保护运行时字节均不变。在 `/data` 的独立目录构建浏览器资源，执行移动端与完整浏览器验收；随后将新资源以 root 持有、服务账号只读的权限复制到静态目录，保留旧的带内容摘要的资源文件，最后原子替换 `index.html`。切换前保存旧入口及每个文件的摘要；切换后回读 HTTP 返回的入口和资源，复查原服务 PID、运行时摘要与核心健康状态。失败只恢复旧入口，不回滚数据库。此流程不重启服务、不更换运行时资格、不重签工具；只要运行时或依赖发生变化，就必须执行下面的完整安装资格与切换流程。

循环退出候选使用 `scripts/operations/hermes-loop-finalization-qualify.py --qualify` 和 `hermes-loop-finalization-cutover.py --apply --receipt <已核对的摘要>`。入口绑定 `2026-09-13-loop-finalization` 构建、源码清单、完整安装文件集、启动与签署脚本，以及当前运行时摘要；沿用六组受保护安装探针。安装验证期间保留线上服务，切换前核对没有活动任务、沙箱资源已释放、schema 32 和备份可恢复，切换只替换安装与已签署配置。此候选修复循环结果指纹中的调用编号干扰，并允许循环中止后最多一次受费用准入约束的说明；正常多步任务保留活动工具。检查源码回归和直接导入打包模块的回归结果，随后仍须真实浏览器验收，不能把循环中止后给出说明算作四工具正常完成。新启动前失败沿用安装恢复；新启动后失败保留现场并诊断，不覆盖对话数据库。

1. 检查本 Runbook 静态合同。只传输已审阅且通过秘密扫描的源码白名单；不打包配置、凭据、真实数据或历史浏览器证据。构建安装到本次独立发布目录，保留旧版本。
2. 打包统一文件和目录权限，禁止 group/other write。安装固定 Pi 工具普通文件后，针对实际安装树执行 Pi、组合、网络允许/拒绝、Worker 崩溃清理及公开搜索探针。固定探针使用合成数据；必须验证真实 namespace 释放、安装字节摘要、实际工具和 provider 返回，不能复用旧资格或伪造结果。任何产物变更后重新执行受影响资格。
3. 实测通过后，使用该主机既有受保护签名源签署本次安装事实，保存证据摘要、runtime/runner/system tool 字节摘要及精确能力上界。Pi 探针使用与正式 Worker 相同的 5 秒清理期限。Pi write/edit 使用 verified_effect，并要求安装的 Pi 程序在实际回读成功后生成内容摘要、字节数和路径；Worker 将原受保护输出绑定到持久证据，Agent 再核对原调用、Grant 和输入。不能以 exit 0 代替效果校验。bash 本轮只读，退出事实为 not_asserted。搜索为独立 fixed_read 程序，出口仅 `mcp.exa.ai:443`。两者都要求既有目录 Grant 和动作/披露授权。用户明确开启“允许联网搜索”后，固定 Exa 搜索可从服务端设置派生精确的一次性 Grant，记录真实的 policyAuthorization 来源；关闭设置后，旧派生 Grant 在消费和 Sandbox 准入时失效。该设置不授权其他工具、附件或任意网络出口。配置中的搜索路径或模型披露身份改变时，设置失效，须重新确认。
4. 在切换前复查旧服务无活动 Run。停止已核验的 `himawari.service`，检查旧 Agent/Worker 完全退出与锁释放；再次执行[尚未启动的 SRT 预约统计](#live-state-preflight)，保存停服后的查询结果，非零时停止升级并报告用户，不启动新版；使用正式 backup create/verify 命令保存并核验恢复点：优先旧安装；若已复现旧备份缺陷，可使用经回归与安装资格验证、schema 相同的候选 CLI 完成备份，不改写旧数据或放宽验证，同时私密保留配置、单元和旧签名启动器。不能删除活动锁或清理未知子进程。
5. 用新安装的 `db migrate --confirm APPLY_MIGRATIONS` 升级同一数据库。该命令在停机独占锁内用 SQLite backup 创建并校验同主机迁移前快照，存于 state/data 下新建的 0700 目录，文件 0600；输出 snapshotPath，重复执行且无待迁移时不再创建快照。此快照不替代步骤 4 的完整恢复点。保留原 Owner、Agent、部署、对话、授权和受保护 Payload。只有没有外部 Owner 绑定时才通过 `account create` 建立内置账号；已有绑定不得自动覆盖。Hermes 当前保留 Cloudflare 产品登录，内置账号迁移须明确确认具体 Owner 与会话撤销影响后另行执行。密码输入和验证器设置只放在 0700 目录中的 0600 文件。
6. 通过 `workspace grant` 授权已核验的工作目录，并明确确认其规范绝对路径；默认仅 read/create/update，不代替动作审批。通过 `capabilities register` 显式确认合格部署快照摘要并写入现有 Registry；不得手工插入批准或资格记录。
7. 更新已核验的同一 systemd 用户服务启动路径。启动器每次核对主机、签名、证据和实际 runtime 字节，再生成本次启动快照；随后启动独立 Worker 与 Agent。初次握手使用配置的 Worker 请求期限，须等待实际 service.ready，不能以 systemd active 代替就绪证据。运行中复查快照原字节，不能因启动超过五分钟失去能力，也不能接受被修改的快照。
8. 使用真实浏览器登录原 HTTPS 入口，完成聊天、多轮上下文、工具审批与文件、公开搜索、停止、刷新和服务恢复。实际调用沿用预算与披露校验；不把通过 HTTP 或受控测试写成真实模型验收。

仅浏览器静态资源变化时，服务端安装字节与资格保持不变；先验证可移植 Web 构建、体积和安全检查，按显式清单校验上传的静态文件。先安装带内容哈希的新资源，对同名文件要求字节完全一致，再保存原 index.html 并原子替换入口。保留旧资源以支持正在打开的页面，不为网页更新重启 Agent/Worker。最终在正式 URL 刷新验证，分别记录服务端资格版本与 Web 资源摘要。

`hermes-harness-continuation-gate.mjs --compare` 是未接入生产的继续工作对照。它保留上述两个四工具失败输入的全部历史、路由、推理与结果，将后续工具列表替换为仅含 `continue_work` 的实验选项：资料足够时直接回答，仍需工具时返回所需工具名及原因。另从较短验收线程的真实 `ls` 结果构造“先列目录，再读取 script.py 解释其行为”的未完成任务，移除其余三个调用及结果并明确记录为合成样本；此样本用于验证不会把多步任务提前结束，不能冒充真实已执行的读取。每个样本分别保留原始工具和实验选项，各重复两次，最多十二次请求。本组上限 0.50 美元，累计仍为已授权的 2 美元，额外纳入前组八次汇总对照费用；不执行任何返回的工具、不修改数据库、服务或模型配置。脚本绑定当前 `0d269e65…` 安装和两个固定诊断辅助模块。输出仅保留有长度限制的脱敏回答、继续原因、工具名和费用。空工具对照四次成功汇总仅证明在固定输入下可生成答案，不证明已找到正常任务的结束条件；本组仍需人工核对正确汇总与必要续跑，且通过后仍须真实 Pi 与服务流式验收。

用户于 2026-09-13 另行明确选择“允许 8 小时完整 sudo，接受整台主机的 root 权限范围”。仅此临时授权允许执行 `hermes-temporary-sudo.py --grant-eight-hours`：在 Hermes 的 `/etc/sudoers.d/99-himawari-codex-20260913` 创建 `andy` 可作为 root 执行任意命令的免密码规则，使用 sudo 的 `NOTAFTER` 限定从安装起八小时，并由固定 systemd 定时器调用 root 持有的 `/etc/himawari/codex-sudo-expiry-20260913.py`，核对规则摘要后删除该条规则。此权限在系统层面覆盖整台主机；本任务仍只执行已授权的 Himawari 工作，不自动延长授权。它是对本 Runbook 项目路径范围的显式账户权限例外，不能泛化为后续任务的默认权限。安装前验证主机、账号、父目录所有权、目标与定时单元不存在及整个 sudoers 配置；先准备规则并通过 `visudo`，启动清理定时器后原子安装，再从 `andy` 身份忽略缓存执行 `sudo -n -k id -u` 验证。失败时撤销本次创建的规则与清理入口。用户在自己的终端输入密码，脚本不接收或保存密码。安装回执写入 `/data/hermes/himawari/qualifications/2026-09-13-temporary-sudo/receipt.json`，代理须读取实际到期时间。到期阻止新 sudo 命令，不能撤销已完成的修改或自动停止已启动的服务；重启后即使临时清理定时器丢失，规则自身的到期限制仍保留。若规则被修改，自动清理拒绝删除并保留诊断。需要提前撤销时，仅删除该临时规则并重新检查 sudoers，不覆盖系统已有规则。

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

本次同时改变 Agent、Worker 与 Pi 适配器的事件记录，**不适用仅静态资源切换**。未来实际部署必须重新构建、核验完整安装及目标平台资格；本次本地验收不授权执行本 Runbook 的部署步骤。


完整浏览器验收使用 `scripts/qualify-control-center-browser.mjs` 的隔离 HTTP 服务。断网与恢复均先调用浏览器的网络模拟接口，再用不读取缓存的 HTTP 请求确认传输确实被阻断或恢复。Linux WebKit 在传输恢复后可能仍保留离线的系统提示；仅在实际请求成功且该提示仍为离线时，测试脚本补发联网事件，并在 `networkEmulation` 中记录补发情况。草稿保留、离线操作禁用和重连后的恢复断言继续执行；这种事件补发仅验证应用响应，不代表真实操作系统断网切换已验收。

语言控件只切换本浏览器的界面语言；Thread 详情不提供独立回答语言选择器，新 Fork 不附加历史回答语言策略。验收须检查中英日界面切换没有发送服务端变更命令。

Logo 以正式静态资源参与构建及摘要校验，发布前须确认页面资源完整，不能用源码存在替代构建产物中的图片检查。

CSRF 恢复场景在隔离浏览器中模拟过期令牌被网关拒绝，确认只刷新一次、重试保持原请求正文和幂等键，并在后续请求中复用新令牌；此模拟不替代生产登录与会话到期验收。

v4 手机输入区遵循已确认原型的单行附件、模型与强度入口、发送按钮顺序；搜索授权放在统一设置和当前轮确认卡片中，支持调节的模型使用离散档位滑块，运行时停止按钮占用发送位置。`scripts/test-mobile-composer-browser.mjs` 使用现有 HTTP fixture，通过 Gateway 边界提供生产同类的模型及搜索控件，检查三语、320/393/430 像素宽度、长模型名、菜单位置、较矮视口和运行状态。几何断言检查同一行、无重叠、触摸区域和视口内可见性，失败截图保留在报告目录；同时运行完整浏览器验收。模拟 WebKit 不等于真实 iPhone 软键盘或第三方浏览器已验证。

连接与侧栏修订的候选须同时包含 HTTP Gateway 和控制中心资源。空闲 SSE 在 HTTP 身份校验后立即发送不含业务数据的注释帧；订阅授权仍由 Gateway 执行。浏览器切换标签页时保留健康连接，握手超过 10 秒会关闭并按既有退避重试。验收需覆盖无新事件时建立连接、标签页恢复、断网重连及会话撤销，不能以单次健康响应代替。v4 侧栏验收从新建、搜索、置顶和最近分组进入；设置由右上角齿轮打开，归档位于“会话与数据”。首页不提供“管理”、独立审批、通用详情或未启用页面入口。核对桌面收起恢复、手机抽屉、三语和键盘焦点。 对话首页不再展示全局加载提示，首次列表使用占位条，正常后台刷新保持现有消息和草稿。以 `scripts/test-thread-loading-browser.mjs` 实测 3 秒慢请求、失败重试、空列表刷新、手机直达链接失败及快速切换；重试应替换旧读取而非等待其结束。完整浏览器验收还须证明聊天和管理页面断网时立即禁止联网操作，联网后恢复。隔离浏览器报告不能替代 Hermes 上对应版本的实际验收。

此次后端修改会改变运行时摘要。历史固定日期的资格与切换脚本只用于各自绑定的冻结候选，不能直接复用于本修订。部署前必须从明确的提交及获准附带的工作区改动准备独立候选，重新绑定源码、安装、脚本与当前安装摘要，完成既有安装资格探针和停机备份前置检查。未完成该准备或未获本次切换授权时，不执行线上变更。

Schema 32 增加受保护原生历史快照、Run 内顺序和 Fork 固定引用。迁移须先取得既有机制核验通过的停机备份；升级后回读 `run_payload_artifacts`、对应 Payload 密文和 `thread_fork_lineage.runtime_history_json`，核对旧 artifact 内容未变、外键完整。恢复与迁移须保留清单引用的所有消息 Payload，不能只搬运聊天正文。重启后以新 Run 验证旧工具调用/结果可见且不重新执行；取消后核对实际结果及新请求，不能仅看服务 ready。旧 Trace 没有自动导入为完整历史，不能由 schema 升级推断旧会话已修复。回退需要匹配旧版本的整套已核验数据库备份，禁止旧二进制直接打开 schema 32，也不手工删除 migration ledger。

必须回读正式服务 PID、安装路径、握手和真实 Run 状态。SQLite quick check 通过且旧记录保留；模型与工具记录按轮持久化；文件内容须从主机独立回读确认。批准前不能产生文件或出口；拒绝后不能执行。搜索显示实际来源及查询时间，过期资料必须明确说明。重启后身份、聊天、草稿边界及旧结果符合合同，不能重新执行原工具。

v5 已完成后的服务恢复验收可使用 `scripts/operations/hermes-protected-acceptance.py --restart-and-observe`。管理员通过限时独立 systemd 单元启动；入口核对受保护版本、账号和无活动 Run，再重启同一系统服务一次，并读取新 Agent/Worker 就绪事件。随后最多观察十五分钟，只导出两个固定合成对话的 Run 状态、工具清理事实及总费用和未结算预留；不导出正文、Payload、凭据或原始日志。输出位于本次独立 `attempt-v5/live-acceptance/`，该目录存在时拒绝重复运行。观察本身不调用模型；真实浏览器测试须依据导出的剩余预算再准入。新取消和完成 Run 均终结后提前结束观察；窗口结束不等于验收成功。

搜索时间标注候选使用 `hermes-search-time-qualify.py --qualify` 和 `hermes-search-time-cutover.py --apply --receipt <本次签署摘要>`，构建及资格目录分别为 `2026-09-13-search-time`、`2026-09-13-search-time-installation`。入口绑定当前 `4c2ffd5d…` 安装、完整源码归档和候选文件摘要。此候选只为检索源中带 `Z` 的发布时间明确标注 UTC，不改模型连接、路由、日期值或引用正文；日期缺少时区时不推断。先以锁定的 npm 11.8.0 和原锁文件执行完整 `npm ci`，保留工作区自己的依赖，核对 `packages/platform-node/node_modules/zod` 为 4.4.3，不能只复制根目录依赖而遗漏 MCP SDK 使用的版本。候选 SQLite 预编译模块与原本本地编译模块字节不同，须通过数据库测试及六组实际安装验证后再签署。复制资格源码时仅忽略根依赖目录并单独复制，保留工作区内依赖；全部符号链接继续接受既有内部路径验证。切换前确认无活动 Run、无未清理作业，创建并验证 schema 32 备份，只切换安装和启动配置；原安装保留在 `2026-09-13-before-search-time`。不重导历史、不覆盖数据库，首次启动前沿用安装恢复，首次启动尝试后保留现场。切换后在已授权合成旧对话中核对本轮搜索、源日期及回答，不能以静态时区标注测试代替实际回答验证。

2026-09-13 的历史完整测试使用 `/data/himawari-tests-20260913` 中的独立临时目录和 `umask 077`。当前开发验证按 [ADR 0047 的存放规则](../adr/0047-test-checkout-on-hermes-nvme.md#storage)：在 Hermes 上运行，源码检出、它的 npm 依赖以及写进检出 `.ci-output/` 的构建和测试输出放在固态根盘上登录账号家目录里的任务目录，工具链和保留的报告、证据放在机械盘 `/data` 上的任务目录；运行时临时数据在固态根盘上每次运行用 `mktemp -d /tmp/hXXXX` 新建的 10 字节独占 0700 目录（路径必须短，否则产品的 Unix 套接字路径会超出上限），通过 `HIMAWARI_TEST_TEMP_ROOT` 和同根的 `TMPDIR` 指定，运行前和运行中保留至少 10 GiB 根盘余量，记录采样峰值，转存现场后清理。使用正式 `vitest.workspace.ts` 和项目原有时限，不设置 `HIMAWARI_TEST_TIMEOUT_MS`（该变量的撤销见 [BL-20261001-002](../backlog/BL-20261001-002-回-到-同-步-写-入-快-的.md)）。测试不读写 Hermes 上原有 Himawari 服务的目录和数据，不停止或重启它。不改变 SQLite 同步设置，不用 `/dev/shm` 替代磁盘。测试不读写 `/opt/himawari`、`/etc/himawari`、`/var/lib/himawari`，不启动系统服务。此规则不移动历史部署数据库或改变冻结探针的安装身份；实际部署资格仍按本次具体授权及最终安装路径核对。

中文正文中的自动来源链接修复使用 `hermes-source-links-qualify.py --qualify` 与 `hermes-source-links-cutover.py --apply --receipt <本次签署摘要>`，构建目录为 `2026-09-13-source-links`。候选只更换 `share/control-center` 的 HTML 和主 JavaScript 资源；运行时目录每个文件与已安装搜索时间候选相同，资格入口强制摘要仍为 `a9b48f67…`。自动识别的网址在中文标点前结束，剩余正文继续由 Marked 解析；显式 Markdown 地址和原生 Unicode 路径不截断。停服前沿用页面检查、真实账号保护和六组资格探针，切换入口绑定当前搜索时间安装和本次签署，创建并验证 `before-source-links-2026-09-13` 备份后更换安装与启动入口。旧安装保留在 `2026-09-13-before-source-links`，schema 32 与历史保持不变。浏览器复测直接打开已保存的合成天气回答，核对两个实际链接的 href 不含中文句尾，不增加模型请求。现有恢复与首次启动后保留现场规则继续适用。

<a id="concurrent-refresh"></a>

### 并发刷新与回答显示

U1 修订 `51fe7f6` 处理会话详情与执行状态读取之间发生的并发更新：状态版本比本轮详情新时，页面重新读取详情，不接纳版本不匹配的状态；状态版本更旧或归属不匹配时仍报错。已知消息的正文读取独立进行，执行状态刷新失败不会阻止它；正式回答的正文尚未读回时，页面保留已显示的执行文本，正文到达后显示正式回答。

安装验收须覆盖状态先于详情更新、正文延迟返回、状态读取失败和刷新后的回答保留，并继续核对旧版本与错误归属被拒绝。该修订没有改变服务协议、数据库或部署步骤；组件回归不能替代实际安装后的页面验收。原始失败和修正后的回归证据见[U1 停止记录](../../.ci-output/handoff/2026-09-28-codex-round2-stop-27.md#verification)。

## Evidence

主机原始证据限定 `/data/hermes/himawari/qualifications/<本次运行 ID>/`，私有输出目录 0700、文件 0600。独立运行账号方案下，外层目录可由 root 持有并设为 0711，以便部署账号和运行账号分别访问各自私有子目录；仅经过字段筛选、不含凭据或用户正文的资格签名、权限验证摘要和错误码由 root 以 0644 发布。配置全文、私钥和原始错误日志仍保持私有；公开可提交副本限定 `test/qualification/evidence/hermes-web-2026-09-11/` 与 `test/qualification/evidence/runtime-history/`，仅保留脱敏摘要、公开合成验收、截图与运行结果。密码、TOTP、恢复码、私钥、配置全文及真实用户 Payload 不进入仓库、日志、模型或聊天。

## Rollback

切换前失败保持旧服务。切换后失败先停止本次服务，保留新状态与失败证据。仅代码兼容且 schema 一致时可恢复旧前缀；schema 已升级时不得直接让旧二进制打开新数据库。数据库恢复必须使用已核验恢复点的独立目标并再次核验身份，不能覆盖当前数据；未获该具体恢复授权时保留停机现场，报告所需决策。不得自动撤回已执行外部动作或清除未知结果。

## Stop Conditions

主机、路径、身份、预算不明确；静态合同或实际安装验证失败；签名/摘要/权限/namespace 证据不匹配；活跃 Run 无法正常停机；恢复点不通过；迁移、身份、握手失败；需要放宽授权、访问其他用户数据或修改 Cloudflare 策略。停止依赖步骤，继续不依赖它的源码修复和验证。

## Troubleshooting

后台核查与操作结果并发写入时的版本处理，见[安装与诊断手册的核查说明](install-start-stop-runbook.md#troubleshooting)。该处理保留原资源事实、恢复所有权和期限检查，不新增数据格式，不改变本手册的备份、权威迁移或部署操作步骤；它不授权重放原工具。

资源核查失败时先看持久恢复终点与安全原因：`SANDBOX_RECONCILIATION_PERMISSION_DENIED` 表示宿主检查被拒绝，不代表原执行 Grant 应重新授予；`SANDBOX_CONTROL_TIMED_OUT` 是控制连接请求超时，`SANDBOX_RECONCILIATION_TIMED_OUT` 是整个核查任务到期；身份、目录或证据变化必须核对原绑定，不能直接采用当前 PID。`unresolved` 表示本次核查已经结束，不表示后台正在重试。失败细节经原 Job 的受保护 `restricted` Trace 保存，保留备份但不得直接输出到页面或普通日志。没有充分新释放证明时仍保留相交资源保护；不得用删除 claim 或重跑原工具来清除错误。

`SANDBOX_HOST_PATH_UNSAFE` 先核对精确路径及 mode，以及 SRT Unix socket 路径长度；生产 jobId 使用完整 SHA-256 的 base64url 编码缩短目录名，外部恢复 ID 合同不变；重新正确打包和验证，不放宽检查。Provider 429 显示限流/过载，保留未知费用与失败记录，不伪造完成。`result_unknown` 检查原环境终态及 namespace，不能通过清空占用重跑。SSH 未认证先使用已授权替代链路；不得打印 Cloudflare 一次性认证链接中的令牌。

未配置受保护安装时，每个进程首次使用某个期望摘要会在独立工作线程逐字节读取全部文件，保留路径、权限、文件身份和前后变化检查，并记录元数据指纹；此后每次调用只复核元数据，任何差异都丢弃指纹并重新完整审计，见 [SOURCE: docs/adr/0034-runtime-verification-by-inode-metadata.md]。验证 Node 源码入口与安装后的 JavaScript Worker 均能加载，校验摘要必须与原算法一致。

ADR 0034 沿用 ADR 0028 的受保护 Linux 安装，作为上述逐次复核的显式替代路径。迁移前准备独立系统运行账号、由 root 保护的安装/启动入口和 `/etc/himawari` 中的版本记录，保留部署账号管理权限。账号不得加入 sudo、Docker 或其他特权组；systemd 使用 `User=himawari`、`NoNewPrivileges=yes`，子进程明确继承 `HIMAWARI_RUNTIME_PROTECTION_FILE`。运行数据和私有秘密仍由运行账号持有；签名私钥不能交给它。Himawari 自有父目录只给予必要穿越权限，不公开同级服务。共享的 `/data/hermes` 属于另一套 Hermes Agent，其权限会被该服务重设为 0700，不能依赖一次 chmod，也不得停用它的安全加固。系统单元以 `TemporaryFileSystem=/data/hermes:ro,mode=0755` 和 `BindPaths=/data/hermes/himawari` 提供私有目录视图，宿主父目录保留原所有者和 0700。root 持有安装及保护记录的要求保持不变。启动时可写的能力快照和 attestation 放在私有运行数据目录，不能要求服务修改受保护资格目录。

停服前先以新账号在同样的 systemd 私有目录视图中验证：父目录由 root 持有且为 0755，仅能看到 himawari 子目录，映射目录的 device/inode 与原目录一致，Node 确实可执行。此检查失败时保留原服务，不能先停服再验证账号能否启动解释器。正式单元和六组验收均使用相同视图、NoNewPrivileges 和 capability 限制；限定临时单元设置运行期限，并在异常后停止、释放。

切换前以新账号实际执行 `scripts/probe-protected-runtime.mjs`，仅使用本次安装中的 `protection-probe/sentinel.txt` 和 `/data/himawari-r8-protected` 独立验收 scratch；首次新建前确认路径不存在，创建后验证规范路径、运行账号所有及 0700。若继续已确认回退的失败尝试，仅复用已核实归属的该验收目录，旧证据保留并为新尝试另建输出目录。必须证明覆盖、chmod、删除、父目录替换、版本记录写入及 Docker 控制访问被拒绝，同时临时工作区读写成功；记录首次完整审计及后续十次核验耗时和完整摘要调用次数。该探针不代表完整工具或模型响应时间。继续以相同非特权账号、NoNewPrivs 和最终安装路径执行六组现有 SRT/Pi 探针，重新签署实际资格后才替换原用户单元为系统单元。候选失败时不启动新服务；权限迁移后的回退须同时恢复原运行身份和私有数据权限，不能只改 ExecStart。管理员必须停机升级，不得原地热改活动安装。无管理员认证时只准备脚本和候选，保留旧服务。

账号迁移须按步骤核对每个进程实际读取路径时的身份。部署签署者仍为部署账号时，必须在私有工作区交接给运行账号之前读取并签署其 device/inode；签署完成后交接所有权，再由迁移程序及新服务核对路径和 device/inode 未变。不得让部署签署者依赖已经归运行账号所有的 0700 工作区，也不得通过放宽私有目录权限解决顺序错误。仅在迁移前旧账号下运行检查不能证明迁移中各阶段的可访问性。

本次 v4 失败后的修复入口为 `scripts/operations/hermes-protected-migration.py`，与同目录三个 `.mjs` 程序一起部署，辅助程序必须符合入口内绑定的 SHA-256。此入口仅适用于已核实的 v4 回退状态，不是通用升级器。`--check` 只读核对现场；`--apply` 仅能由管理员通过独立 systemd 单元执行，并再次核对现场。新证据限定 `qualifications/2026-09-11-protected/attempt-v5/`，该目录已存在时拒绝重跑，保留现场供检查。

停服前，先在新证据目录的合成工作区执行同一所有权交接函数，用真实 `andy` 和 `himawari` 身份验证：签署读取在交接前成功，交接后新账号可读取且旧账号被拒绝，原 device/inode、0700 权限和文件内容不变。随后以正式签署者核对实际工作区和签名源的可读取性，不输出私钥。正式六组探针使用独立 scratch 作为 HOME；签署成功之前，所有生产运行数据仍由旧账号持有。签署后才统一交接运行数据，并在交接前后比较目录身份。签署失败时不交接数据；部分交接失败时进入已停服状态下的原有权限恢复流程。macOS 上的受控回归测试不替代这次真实 Linux 账号演练、最终保护验证和服务验收。

资格探针的 stdout 必须是一个可直接解析的 JSON 值；Vite 依赖预处理、警告和其他诊断均写到 stderr。验证冷缓存时也必须满足该合同，不能依赖缓存恰好已热身；签署端保持严格解析，不通过截取 JSON 或忽略任意前缀把污染输出当成合格证据。

长时间的特权迁移必须由 systemd 后台单元接管，使用固定单元名和 root 所有的独占锁防止重复运行；不得把 SSH 终端、前台 `sudo` 或调用方输出管道的存活作为迁移成功的前提。启动命令返回后，通过单元状态及原子写入的阶段记录观察进度。记录应先持久化，再输出日志；关闭输出管道不得导致迁移退出。捕获可处理的终止信号并走已有回退，强制终止或主机断电后不能仅凭旧阶段记录自动重跑。

若在“安装目录已切换、正式服务尚未启动”阶段中断，先核对两个服务均停止、无遗留资格验证进程、原安装和备份完整、配置未变、数据库无活动 Run、安装归 root 所有且运行数据归专用账号所有。只针对核实后的阶段恢复，保留旧验证输出，在新输出目录重新执行资格检查；不得重复交换目录或把不完整输出签署为通过。后台恢复依然需要管理员认证，该认证由用户在 Hermes 终端完成，不通过聊天传递密码。

模型配置中的 `reasoningRequired: true` 用于 Provider 明确要求思考的端点，需同时 `reasoning: true`。确认菜单不再提供 off，当前轮记录保留实际选择。审批详情必须能显示含斜线和中文的目录目标；不得将加载失败当成批准或跳过审批。

恢复审批须读取已有冻结请求，不能用新时间重写同一持久化 key。验收核对 Pi 工具真实失败标记、审批等待扣除和文件回读；是否要求近期认证以实际审批合同为准，不以“工具”一概判断。

若计划在 Worker 准入前拒绝，比较实际请求与签名能力的每个资源额度；正式组合必须逐项取较小值，不能直接扩大签名上限。Trace 的 Runtime 和授权审计并发时使用数据库原子序号分配；不得删除审计记录、重置序号或重发工具来消除冲突。

前台任务也必须核对清理。已取消/失败的 Run 可以通过原停止命令再次核对，禁止重新运行其模型或工具。协调器完整性核验使用现有 30 秒上限；不要把 Job Host 的 5 秒进程退出期限与包括安装文件核验的协调期限混为一谈。机械盘主机可配置 Worker 等待 300 秒、Run 900 秒、Provider 120 秒，仍逐项受已签名能力上限约束。升级旧安装前先使用相同安装和原受保护证据释放遗留环境；只有规范协调器核验并持久化 released 才能报告清理完成。

若旧 fixed_read 已有真实结果及清理证据，却仍保留 SANDBOX_NOT_STARTED 效果，先核对其固定只读合同、结果绑定与原安装字节，再通过现有 Journal CAS 补充 not_applicable；不能把写操作、未知退出或未经验证的副作用套用此修复。维护进程在服务停止后正常取得独占 Authority，保留旧安装做核验，结束后释放 Authority；不继承旧 Worker 的执行权，不直接更新数据库列。候选版本的同一受测验证/持久化组件可用于这次受限修复，随后才替换安装树。

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

Linux 安装必须包含同一候选包编译出的 `linux-host-guardian-main.js`、`linux-host-guardian.js` 和 `linux-host-group.js`，由既有 runtime digest 核验。Host 在创建 SRT 代理前确认同组清理进程就绪；正常退出继续使用 SRT `cleanupAfterCommand()/reset()`。Host 被杀后，清理进程核对原 Host 身份已消失，或准确匹配的原 Host 已为 `Z`（已退出、父进程尚未收尸），以及各成员 PGID/SID 与原 Host PID 相同、自身仍占据原组；发信号前再次核对身份，再在原清理期限内结束当前自身组。Agent 随后独立确认零成员；不能把发信号成功写成 `srtReset=true` 或已释放。

清理进程回收代理时不等待原 Host 收尸，但原 Host 处于僵尸状态，或原 Host 已消失而自身组仍在可信回收期间时，沿用 `cleanup_pending` 在原恢复期限内观察。僵尸、权限错误、身份变化和无法读取的组不能算空；到期仍未清空时保留占用，不增加宽限。真实恢复验收必须覆盖六处 finish 崩溃，并读回 Host 组为空、原结果恰好一次交付且未重新执行。规则见[Linux Host 组清理](../execution/specs/2026-09-24-isolated-tool-execution-design.md#linux-host-group)。[SOURCE: docs/execution/specs/2026-09-24-isolated-tool-execution-design.md]

清理进程属于当前安装和运行中的进程，不属于备份或迁移数据。不能按备份的 PID 重建它的活动身份；目标主机不能替源主机按旧数字杀组，目标启动成功也不证明源主机组已清空。新候选改变运行时字节，原冻结候选的资格不能复用。离组后代限制和 Mac 规则保留；本轮 Mac 行为未验证。

升级后核查原作业时，已完成清理但终态中的 `taskProcessGroupGone` 为 false，不再阻止按原签名开始记录和当前进程身份补做核验；没有原身份依据、原任务进程组仍存活或 Linux 的 Host 自身组非空时继续保留占用。证明仍仅为 `process_group_gone`，不能推断离组后代已停止；数据格式及本手册的部署授权要求不变。详细边界见[原环境核查约束](install-start-stop-runbook.md#v2-原环境核查约束2026-09-09)。[SOURCE: docs/runbooks/install-start-stop-runbook.md]

历史占用可先按[只读核查流程](workspace-lifecycle-audit-runbook.md)从对应源码 checkout 读取已验证的数据库副本。该入口不随安装产物自动变成管理命令，也不执行迁移、解锁或重放；现场宿主停止证明与具体修复仍需单独核对。

JobHost 控制探针现含脱离原进程组的持续写入子进程，在 Stop 和 Worker 崩溃后独立读取文件。2026-09-20 的隔离实测中，Linux namespace 释放后无新增写入；Mac 后代仍继续写入。按 ADR 0033，Mac 上任务进程组全部消失后照样释放占用，cleanup 记为 `process_group_gone`（停止未经严格确认），离开进程组的后代继续写入是所有者已接受的风险；探针只在 cleanup 为 `confirmed` 时要求观察之后没有新增写入。构建产品探针还检查执行前拒绝竞争预约、永久释放后才允许预约及独立数据库读回。这些探针的安装资格为合成夹具，不能替代本 Runbook 要求的最终安装路径、运行账号和权限资格；两个探针也不构成第二个并发 writer 的完整联合验收。见[本次证据边界](../../test/qualification/evidence/workspace-authorization-lifecycle/p1-platform-01/README.md)。 升级后如需删除旧的未确认 SRT 执行记录，按[删除旧的未确认 SRT 执行记录](install-start-stop-runbook.md#purge-unconfirmed-srt-records)在停机状态下执行；所有者已在 2026-09-26 授权在所有机器上执行这项删除。

Schema 37 为原调用的恢复结果建立 writer 屏障。恢复结果保存在受保护的 `pi-file-recovery:<invocationId>` Trace artifact 中，与原 Worker 输出分开；不覆盖原输出，也不创建第二个调用回执。旧 writer 不理解该来源，不得直接写入新库。

固定文件合同 2 的受信 runner 在保存前将 Scope、输入摘要、候选 inode、完整父目录身份和内容摘要写入本次私有 Job 目录；保存后等待核验记录落盘，再返回结果。记录失败阻止发布，发布后的记录失败则保留候选身份用于核实。私有记录不含候选正文。它们与授权目录内 `.himawari-recovery/` 的候选一起属于现场恢复证据，单独的产品数据库备份不包含这些文件；恢复数据库不能被报告成同时恢复了工作区与私有 Job 目录。

Agent 只有在原 journal 已接纳永久释放记录且没有新保护时才核实文件。已保存的核验记录作为历史事实保留；缺少最终核验记录时，必须匹配原候选 inode、内容及发布时父目录。核实可清除该次发布留下的私有硬链接别名，不能重新发布候选、修改用户后续编辑或启动旧工具。仅内容相同或目标名称相同不足以证明本次保存成功。

结果交接还须核对原请求的分类、当前披露权限、恢复 artifact 与受保护交接回执。该实现当前处理固定 write/edit 的缺失或 unknown 结果；已保存的错误结果保持不变。真实 Job Host 释放、跨 Worker 与 Linux 平台资格须单独验证；本地受控进程证据的集成测试不能代替这些资格。回退仍须停止新 writer 并使用匹配版本的完整恢复点，不删除恢复事实来允许旧程序接管。

### 工具执行前检查点与恢复引用

生产装配在进入产品工具前，复用现有 Pi 批次格式和加密 Payload 保存检查点。执行 intent 中的 `tool-batch-recovery.v1` 引用绑定原模型工具调用，内部文件阶段共同指向该父调用；备份、恢复及迁移须一同保留这些关联。保存失败的工具没有进入执行，旧记录缺少检查点时不能补造。引用本身不授权跨 boot/fence 重放。对原 Run 未取消、未过期，已有确定结果与永久释放回执且原批次凭据完整的调用，调度器可领取原 Run 的新租约，仅交付旧结果并继续 Pi；原工具不会再次启动。缺失快照、权限变化、未确认控制或模型费用仍未知时保留待核对状态，不能通过重发清除未知。恢复沿用原模型 stream ordinal，保留原调用回执、交付 intent 与受保护 Payload；没有新增表或迁移。详见[已核验工具结果恢复合同](../execution/specs/2026-09-28-sandbox-tool-result-resumption-design.md#恢复条件与用户行为)。

创建本机 Job Host 前还需保存 `sandbox-preparation-control.v1` 受保护记录，其中的控制密钥只用于核验原宿主，不授予启动权限。备份与迁移须保留该记录；旧数据不回填。已认证的 `host_never_started` 预留释放可交付确定未启动的失败，不能伪造 bound 记录；已取得启动权或使用旧协议且缺少最终证明时仍待核对；登记前封锁仅适用于带新协议字段的计划。首次准备、登记或 bind 失败通过 `sandbox-control:*:diagnostic:preparation-failure` 尝试保留有界阶段及机器码，使用 `himawari diagnose run` 查询，不在普通日志中记录。Payload 或 Admission 通道在成功握手后发生传输失败，失败操作按原结果结束；后续操作使用原 peer/boot、凭据与现有校验重新握手，并发调用共享一次握手，不重发失败的执行请求。准备诊断也使用同一机制。Worker 就绪状态反映两个通道当前状态；后续就绪探测可触发共享恢复，成功后才恢复 ready。握手失败仍未就绪，关闭期间迟到的回复不能恢复 Worker。 正在停止任务时，保留 broker 到清理观察保存结束，再由 close 统一断开。握手或当前权威校验失败时仍可能没有持久诊断，不能据此声称错误已完整留存。详见[准备控制恢复合同](../execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md#权限与失败边界)。本批没有新 migration，不改变本 Runbook 的现场操作授权要求。

Job Host 启动先建立原私有 IPC 监督，再动态加载 SRT 与策略编译模块；新鲜准备消息不会因后续加载慢而过期。安装验收应覆盖慢加载后完成准备、到达即过期的消息被拒绝、加载失败无用户任务启动，以及超过原 30 秒准备上限仍失败。1.5 秒消息年龄、任务总期限、认证及签名终态格式不变；不能把加载期间的心跳当作 ready 或清理证明。准备期间，任务期限早于或等于 30 秒准备上限时，受保护诊断必须为 `JOB_HOST_EXECUTION_DEADLINE`，结束原因为 `deadline`；只有准备上限更早时才是 `JOB_HOST_PREPARATION_TIMEOUT`。安装验收须检查两个先后边界及相等边界，取消或结束后不再追加超时分类，不能把两种诊断码都接受为正确结果。`dependencies` 阶段失败且 `srtReset=false` 时仍须保留未确认状态，不能凭“任务未启动”直接释放。详细合同见[依赖加载期间的启动监督](../execution/specs/2026-09-28-sandbox-preparation-control-recovery-design.md#startup-supervision)。本修订没有部署动作；云端定向测试不能替代最终产品资格；用户已无限期推迟 Mac 验证，Mac 行为未验证。


### Schema 38 纯联网范围

Schema 38 为 `sandbox-scope.v2` 和 `network_only` 合同建立 writer 屏障；这类前台 Job 使用自己的私有临时目录，不保存目录 Grant，也没有共享文件 claim。备份和恢复仍须保留原网络授权、Handle、调用回执、Scope Payload、私有环境和资源释放证据。空 claim 只说明没有用户文件占用，不能据此认定进程已结束或重发原操作；网络外部效果仍按命令退出事实记录，不宣称无副作用。

公开搜索新增显式 `runPolicy.publicSearch.scopeSource: private_temp` 路由，不能同时配置 `grantId`；安装清单须使用相匹配的 `private_temp` / `network_only` 操作合同，纯联网清单可不含用户目录根。旧目录型路由和合同保持原权限语义，升级不会自动切换部署配置。配置或模型绑定变化会使原搜索委托失效，需按现有入口重新授权；保存搜索结果是另一次获准文件操作。

验证分别检查无目录 Grant 的搜索准入、零共享文件占用、原网络授权撤销、私有工作目录及真实沙箱越界拒绝。Schema 37 或更旧 writer/Worker 不得处理新合同；回退须停机并恢复与旧版本匹配的完整恢复点，不能删 migration ledger 降级。本批源码和受控测试不构成部署授权，也不替代目标平台与实际安装资格。

### Schema 39 自动审查记录

Schema 39 新增 `automatic_action_reviews`，在模型调用前保留唯一请求身份，完成时与原审批及一次性 Grant 同事务写入。备份和恢复须保留审查记录、Owner 委托版本、原请求摘要、受保护输入/输出 Payload、审批来源和原模型费用记录。`pending` 只表示没有已提交决定，不能推断模型未调用，更不能删除该记录后重试付费调用。已完成记录读回历史决定，不重新派发工具。

自动审查默认未装配。当前委托只接受精确请求摘要，批准不能扩成其他文件、命令或长期授权；写入时使用 writer 当前时间，重新核验请求期限、委托版本和 Run 执行租约。已有人工请求或决定优先，撤销、取消、过期及执行权变化阻止迟到批准。审查等待不创建共享文件占用；自动批准保存 `automaticReview` 来源，不能解释为用户对本次操作点击了确认。

升级前后核对独立 `specialist` JEV 描述符、披露范围与单价，以及审查决定的置信度和预算账户的 `unknown` 状态。新 Agent Service 只能凭自己的启动实例和当前 Run 租约准入审查；旧实例的未知调用不能重放，也不能把本地受控测试解释为真实服务结算。

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
