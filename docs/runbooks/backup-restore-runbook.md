---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:70cf363101149da107b8cabb819069b922956f4e1f212d3e9108b050e75bb4c0"
supersedes: ""
superseded_by: ""
date: "2026-08-27"
---

# 同机备份与恢复 Runbook

<!-- runbook-contract:
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
- apps/agent-service/src/service-main.ts
- packages/application/src/services/thread-execution-projection.ts
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
- packages/runtime-sandbox/src/linux-namespace.ts
- packages/application/src/ports/sandbox-execution-journal.ts
- packages/application/src/services/sandbox-execution-projection.ts
- packages/persistence-sqlite/src/sqlite-sandbox-execution-operations.ts
- packages/persistence-sqlite/src/sqlite-capability-invocation-operations.ts
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
- packages/persistence-sqlite/src/sqlite-recovery-point.ts
- packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts
- packages/persistence-sqlite/src/sqlite-run-lifecycle-operations.ts
- packages/persistence-sqlite/src/sqlite-run-checkpoint-operations.ts
- packages/persistence-sqlite/src/migration-engine.ts
- packages/persistence-sqlite/src/migrations
- packages/persistence-sqlite/src/state-root-lock.ts
- packages/platform-node/src/host-secret-source.ts
- packages/platform-node/src/payload-protector.ts
- packages/platform-node/src/strict-configuration.ts
- packages/platform-node/src/state-root-layout.ts
- docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md
- docs/adr/0018-sqlite-product-state-authority.md
-->

## Scope

2026-09-11 聊天运行体验更新：可撤销的联网搜索设置保存在既有 Product State，关联审批记录通过 `policyAuthorization` 标明真实授权来源，不新增迁移文件。备份/迁移须共同保留设置 revision、派生 Grant 与审计；关闭设置后，旧 Grant 的消费和 Sandbox 准入被拒绝。恢复后核对设置与当前固定 Exa 路径、主机/目录路由和模型披露身份一致，配置绑定不同不能沿用开启状态。它不授予其他文件、命令或网络权限。Pi 更新合并仅影响尚未持久化的连续累计片段，不能删除已持久化记录或工具边界。`runPolicy.timeZone` 是显式 IANA 时区，只用于新 Run 的时间上下文；历史已冻结内容保持原值。

未配置受保护安装时，完整 runtime 字节校验仍在每次调用的独立工作线程运行；安装必须包含编译后的 `sandbox-runtime-digest-worker.js`。ADR 0028 允许已经独立验证权限的 Linux 安装，在相同进程、相同 root 保护版本身份下复用首次完整审计；每次仍验证当前进程和保护记录，失效立即拒绝，不接受普通时间缓存。保护记录不属于备份或迁移数据，目标主机必须重新建立身份、权限与安装资格，不能复制源主机记录作为证据。此变化不改变数据格式、迁移权威或停止条件。参见 [SOURCE: docs/adr/0028-protected-runtime-installation.md] 和 [SOURCE: docs/runbooks/hermes-control-center-upgrade-runbook.md]；本 Runbook 原有操作范围保持不变。

2026-09-11 合同核查：新增离线初始化、目录 Grant 与能力登记仍属于当前身份的停机管理操作，不修改本 Runbook 的备份/迁移数据格式。恢复必须保留其审计、目录身份与授权；不能在已恢复 state root 再运行首次初始化，不能将原主机安装资格当作目标主机资格。启动后快照按原字节复查，工具每次仍检查当前主机与授权；模型失败展示改进不改变原始记录和费用核算。

本次 Web 重构追加 schema 30：`runs.model_selection_json` 保存用户提交时选择的模型引用和思考深度。备份、恢复和迁移必须保留此列及原 Trace/Payload；恢复不能用当前输入框的选择改写旧 Run，也不能给旧记录补造选择。目标配置仍须支持原模型、深度、预算与披露，缺失时报告失败而不是静默替换。浏览器的主题、主题色和未发送草稿属于客户端偏好，不随服务数据库恢复。

控制中心查询执行过程时仅返回经过归属校验和字段筛选的展示投影；恢复检查应核对多轮历史、模型选择与审批等待，不直接开放原始 Trace JSON。取消仍经过 RunCoordinator。上述展示投影已由受控 SQLite/Pi 适配与浏览器测试验证。2026-09-11 Hermes 同机升级、迁移前快照与真实服务重启由专用 Hermes Runbook 和验收记录约束；未执行跨主机权威迁移或从备份完整恢复服务。

R8 的网络出口和活动连接属于原 Job Host，不随备份或权威迁移恢复。Worker 对 foreground、background、service 均在监督循环重查当前授权，失败后请求停止并关闭出口；恢复的旧 Grant 或连接计数不能恢复网络权限。目标需要自己的明确 hostname:port 授权和平台资格，不能沿用源主机上游端口或认证。此变化不修改数据迁移格式或本 Runbook 的停机/恢复步骤。

schema 28 在原数据库追加 v2 资源关联、独立操作/资源观察、目录占用和派发回执。升级既有库仍须先取得已验证快照；0020/0027 不改写。恢复/迁移时必须保留占用和未确认派发；旧未结束作业缺少可信目录链时按主机保守阻止新准入，缺少主机身份时阻止所有主机的新准入。禁止通过删除 Run、清空占用或把旧记录改成 v2 来恢复执行。已确认清理的旧历史结果保持原解释，不由迁移补写新资格。

schema 29 追加执行准备阶段，保持 schema 28 的历史记录为 `legacy_bound`。新 `reserved` 记录没有实际运行摘要，`bound` 记录保存首次启动固定的摘要和监督身份；两者均须与原调用回执、目录占用及观察历史一同保留。恢复或迁移不能为未绑定记录补造启动资格，也不能把已绑定作业重新派发；源主机上的 PID、IPC session 和 boot 仅供核查，不成为目标的停止或执行句柄。

这些 SQLite 机制已有独立测试数据库的升级、重开和事务验证；本次未升级运行中的 state root，也未执行真实安装、恢复或跨主机迁移。正式组合已具备显式 v2 foreground 路径、真实目录身份解析和限定风险核查；Pi 七工具前台 runner 已有假数据验收，目标安装资格仍须独立验证。恢复或迁移后的 Pi 工具链须与原 runtimeDigest 匹配，不能以同名系统工具替代缺失的 bash/rg/fd，也不能下载补齐后沿用旧资格。恢复后继续适用当前主机/目录/权威检查，不能自动重放旧任务或未确认派发。

SRT 变更已包含产品作业合同、计划投影、Pi 调用绑定、固定版本运行依赖及候选策略编译。Node 打包包含 `runtime-sandbox` 和 SRT 0.0.75，正式 Worker 已分别组合 v1 与显式 v2 foreground，未取得 SRT 主机安装资格。schema 27 已追加作业观察账本；升级必须遵循下述快照与迁移检查，不能在恢复后将无账本的旧凭证补建为可启动作业，也不能自动重放待核查作业。固定假数据策略探针通过不代表正式 Job Host、资源硬上限或崩溃恢复可用。本文的实际安装、备份与权威迁移流程不因目标架构获采纳而改变；不能把恢复的旧 Capability 记录当成新 SRT profile 的主机资格。

本 Runbook 只管理当前活动部署在同一主机、同一存储边界内的加密恢复点：创建、独立验证，以及把一个已验证恢复点恢复到它原属的明确 state root。恢复点不改变 authority epoch，不创建第二个可启动权威，也不是异地主机损毁后的灾难恢复介质。

恢复包只包含 SQLite backup API 产生的 `data/product.sqlite` 一致性副本，以及该副本实际引用的 `data/payload-ciphertext/` 文件。Agent/Worker 启动身份文件位于 `runtime/`，不属于恢复数据；恢复后的服务必须重新建立当前 boot、authority lease 和握手，不能把旧启动文件当作恢复后的执行权限。`runtime/`、`cache/`、lock、socket、日志、secret、能力部署快照及其 runtime root 明确排除；恢复后仍须由安装流程独立提供并验证与 active Capability Registry 一致的不可变快照，不能从数据库记录重新生成可执行绑定。当前 CLI 通过权限受限的 secret 目录解析 `backup-encryption` 与 `payload-encryption` 引用；不得把密钥值写入参数、日志或证据。

Schema 40 为尚未绑定的预约增加不可撤销的停止标记，并保留独立的有限恢复记录。停止或启动恢复遇到这类预约时禁止后续绑定；已注册环境只通过原认证 Job Host 控制通道请求停止。标记不证明私有环境已清理或共享占用可释放，缺少证据时仍保留 claim；不补造运行时身份或永久释放回执。升级必须先备份并迁移唯一 writer，Schema 39 及以前的 writer 不得接管。Worker 线上消息合同没有新增字段，旧 Worker 也不能绕过数据库绑定检查。

Schema 41 新增独立的 `sandbox_reservation_release_receipts`。只有原认证宿主证明任务从未启动、原进程已退出且清理完成，当前 writer 才能同事务保存永久回执并释放该预约的占用。原停止标记保持不可撤销，不伪造运行时绑定、业务结果或退款；重复停止和恢复读回原事实，不因核验凭据过期重新占用。缺少宿主证明、仍有保护或已启动任务的后代状态未知时继续保留未确认状态。备份与权威迁移须同时保留回执、停止标记及受保护宿主证据；Schema 40 及以前的 writer 不得写入新库，回退仍需停机并恢复匹配旧版本的完整恢复点。

轮次已取消、失败或完成后，如果某个工具只有准备事件而没有结束结果，页面显示“结果未确认”，不持续显示准备中；明确未派发的原证据仍显示“尚未派发”。缺少真实起止边界时不生成时长，刷新后沿用相同规则。

## Authoritative Sources

- 产品恢复、排除清单、停止服务、原子切换和保留边界：[SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md#同机恢复点导出与导入]
- SQLite 单一产品状态权威：[SOURCE: docs/adr/0018-sqlite-product-state-authority.md]
- 本 Runbook contract selector 中列出的 CLI、恢复点 adapter、管理锁、配置、host secret source 和 Payload 认证实现。
- 受保护配置只提供 state root、deployment/Owner/Agent identity、authority 和 secret reference；运行时回读只显示引用，不显示 secret material。

## Safety and Preconditions

- 有效恢复点必须通过 manifest HMAC、每文件 AES-256-GCM authentication、ciphertext/plaintext digest、schema sequence、SQLite quick/full integrity、foreign key、全表行数、Payload authentication 和 Outbox continuity 检查。
- `backup create` 会向活动 SQLite 写入恢复点与操作 marker，并在 state root 的 `recovery-points/` 下新增加密文件；这是第一次目标 mutation。执行前必须报告主机、deployment、state root、backup ID、预计磁盘增量和 30 天保留上限，并取得覆盖该目标与动作的明确授权。
- 配置必须通过当前 strict schema，包含一个显式 primary、private-only fallback 和独立 embedding descriptor；embedding dimensions 必须与 Mem0 vector dimension 相等。恢复点流程不改写这些模型身份，也不推断或下载隐式 embedding。
- 若配置声明能力部署快照，restore 前后只核对其引用、SHA-256 与 active Capability Registry 一致性；恢复包不携带、改写或激活该快照。快照或本平台资格不满足时，数据库恢复可以完成，但普通 Worker 必须保持 not ready。
- `backup restore` 是 critical 恢复 mutation。服务必须已经停止，state-root 管理锁必须可独占取得，目标必须与配置中的 state root 完全相同，且确认词必须精确为 `RESTORE_<backup-id>`。运行前必须再次报告将替换的 `data/`、恢复点 identity、数据回退范围和外部副作用不回滚边界，并取得逐次授权。
- secret 目录及文件必须由当前服务账号拥有，目录权限为 `0700`、文件权限为 `0600`，且配置中各恰好有一个 `backup-encryption` 和 `payload-encryption` secret reference。
- 恢复只回退产品 data partition；不回退 public ingress、外部账户、已完成的外部副作用、host secret、authority 或应用版本。
- 证据只能写入下述项目批准的隔离目录，且不得包含配置全文、密钥、token、Cookie、私钥、Payload plaintext 或未脱敏环境输出。

若备份包含文件读取工作流，其目录 Grant、按阶段的受保护输入、Handle、调用回执及结果随产品 SQLite/Payload 保存。恢复后不重签或重放未知调用，不把恢复出来的目录 Grant 当作新主机访问授权；开始新的读取前必须核实目标主机、Worker instance、目录身份、租约和当前模型披露权限。

## Live-State Preflight

在任何 mutation 前执行以下只读检查；将占位符替换为本次已解析的绝对路径和稳定 ID，不使用 shell glob：

~~~text
git rev-parse HEAD
git status --short --branch
himawari db status --config <absolute-config-path>
himawari doctor --config <absolute-config-path>
~~~

另外只读回读并记录：当前主机、配置文件与 state root 的 owner/mode、deployment/Owner/Agent identity、authority status/epoch/fence、数据库 schema sequence、quick check、`recovery-points/` 所在文件系统的可用字节，以及 secret reference 的名称/版本/用途。不得读取或打印 secret value。

创建前估算 `data/product.sqlite` 与数据库实际引用的 Payload ciphertext 总字节；剩余空间必须同时容纳 plaintext 临时 SQLite snapshot、加密对象和安全余量。恢复前还必须确认 Agent Service 与 Execution Worker 已由适用的已验证服务管理程序停止、`runtime/execution.sock` 不再接受连接、state-root lock 可独占取得，并先执行：

~~~text
himawari backup verify --config <absolute-config-path> --secret-dir <absolute-secret-directory> --backup <backup-id>
~~~

任一 identity、权限、schema、integrity、空间、锁、恢复点或 secret reference 回读不完整或不一致时停止。

## Procedure

1. 对当前 Runbook 执行静态 contract 检查，完成 Git/worktree 与 Live-State Preflight，并创建 `test/integration/qualification/evidence/operations/backup-restore/<unique-run-id>/`，权限限制为当前账号可读写。
2. 创建恢复点时冻结唯一 backup ID，报告 mutation 边界并取得授权，然后执行：

~~~text
himawari backup create --config <absolute-config-path> --secret-dir <absolute-secret-directory> --backup-id <backup-id>
~~~

3. 创建命令只有在自动临时解密验证全部通过后才返回成功。审批、能力声明与授权使用记录的空元数据占位仍随整库加密、认证和恢复；只有既有 metadata 引用、指定媒体类型、private 分类、空内联字节、匹配摘要且无加密字段的严格形状可免于正文解密。包含正文、未知摘要或加密字段的记录继续拒绝。随后从独立命令再次验证：

~~~text
himawari backup verify --config <absolute-config-path> --secret-dir <absolute-secret-directory> --backup <backup-id>
~~~

4. 恢复时先完成创建阶段以外的恢复专用 preflight，并通过适用的已验证服务管理程序停止 Agent Service 与 Execution Worker。停止后重新确认 socket、进程、管理锁和目标 state root；缺少可验证的停止程序时直接停止本 Runbook。
5. 展示精确目标、恢复点、风险、预计停机、data partition 替换范围和非回滚边界，取得本次恢复授权后执行：

~~~text
himawari backup restore --config <absolute-config-path> --secret-dir <absolute-secret-directory> --backup <backup-id> --target <absolute-state-root> --confirm RESTORE_<backup-id>
~~~

6. CLI 先解密到受限新目录并完成全部验证，之后才在独占管理锁下原子替换 `data/`。不得手工复制 SQLite、Payload 文件、WAL 或 recovery-point object 来绕过验证。
7. 按本次已验证的服务启动程序重新启动 Worker 与 Agent Service；重新运行 `db status`、`doctor` 和业务只读查询。未完成对应 install/start/stop Runbook 前，不在此处猜测 launchd/systemd 命令。

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


自动标题沿用既有 Thread 与 Payload 存储，不新增 schema。恢复点须共同保留 `threads.title_ref`、标题来源与 revision、受保护标题 Payload，以及 `thread-title:<runId>` 对应的模型调用身份和费用记录；不能只恢复聊天正文或清除 started/unknown 记录来重新计费。已有自动标题和用户手动标题均保持原值，恢复动作本身不请求模型补名。正常停机先停止 Run 循环，再等待已发起的标题请求结束；强制中断后的记录以数据库实际状态为准，不能把进程内队列视为可恢复任务。标题模型请求最多等待 20 秒，仍受当前配置的更短期限约束；不要因正文已完成就直接杀掉服务。

执行过程使用现有 Thread 事件游标，新增记忆检索、筛选和上下文阶段的发生记录；这些阶段不向页面公开记忆正文或完整模型上下文。工具请求从模型消息中的调用 ID、名称和参数派生，并与同 ID 的执行及结果关联。恢复后核对阶段、工具参数和结果投影仍可读取，不另建第二套历史或重新执行工具以补齐展示。

启用沙箱能力的 Agent 必须在本进程完成首次安装校验后才进入 ready，不能以 Worker 已就绪代替。受保护程序摘要可在安装及文件身份未变化时复用，安装外的程序仍逐次校验；这不改变本手册的数据格式、权威转移或停机步骤。恢复到另一安装或主机时，原进程缓存不适用，必须重新验证实际安装。Hermes 的 NVMe 私有只读挂载及设备回读另见 [SOURCE: docs/runbooks/hermes-control-center-upgrade-runbook.md]。

工具审批续跑快照同时保存本轮进展指纹和已完成工具结果，备份、恢复及迁移须连同其受保护 Payload 一起保留。恢复审批时只重放同一暂停点已有的结果，不再次执行对应工具；因循环保护中止的 Run 保持失败，即使随后生成了结果说明，也不能改记为任务成功。这些运行层行为不依赖具体模型提供商。

Schema 32 增加受保护原生历史快照、Run 内顺序和 Fork 固定引用。迁移须先取得既有机制核验通过的停机备份；升级后回读 `run_payload_artifacts`、对应 Payload 密文和 `thread_fork_lineage.runtime_history_json`，核对旧 artifact 内容未变、外键完整。恢复与迁移须保留清单引用的所有消息 Payload，不能只搬运聊天正文。重启后以新 Run 验证旧工具调用/结果可见且不重新执行；取消后核对实际结果及新请求，不能仅看服务 ready。旧 Trace 没有自动导入为完整历史，不能由 schema 升级推断旧会话已修复。回退需要匹配旧版本的整套已核验数据库备份，禁止旧二进制直接打开 schema 32，也不手工删除 migration ledger。

恢复或迁移后的候选必须支持 migration 0024/0025：embedding 调用身份和 Memory projection 预算账户随产品 SQLite 一起验证，不能丢弃 started/unknown 费用记录来触发重试。公开入口还需要当前主机的 `http`、`identity`、`runPolicy` 与模型配置；被冻结的 Run 输入继续使用原有快照。重新启动后检查 Run dispatch、Memory consumer、Worker 与权威就绪状态，并回读原 Thread/Run 和受保护回答正文。此检查不替代真实公共身份入口或目标平台资格。

- 中断执行交给生产恢复组件后，Run 与 checkpoint 必须同时显示 `reconciling_external_result`，旧执行租约失效，已有结果引用保留；恢复不能重新调用模型或工具。此检查当前有本地 SQLite 证据，完整安装入口验证仍待完成。已经待核实的记录不重复占用初始扫描批次，不代表外部结果已经确认。

- 若数据包含 Run 执行输入快照，保留首次执行开始时间与绝对截止时间；恢复或迁移不重新发放运行时长。缺少截止时间的旧快照须停止并核实历史执行，不能自动删除快照后重建。目标时钟须可信，不能以导入或重启时间替换原截止时间。

- create/verify/restore 输出的 backup ID、Owner/Agent/deployment、authority epoch、schema sequence 与目标完全一致。
- `quickIntegrityCheck` 与 `fullIntegrityCheck` 均为 `ok`，Payload 数量、Outbox 数量、文件数量和 manifest digest 在独立 verify 中不变。
- 恢复后的 `himawari db status` 显示 managed schema、预期 sequence 与 `quickCheck: ok`；`doctor` 的 authority、schema、SQLite、Payload 与适用依赖符合目标 profile。
- 用恢复点创建前已记录的只读业务引用验证数据水位线已回到预期；不要只依据 exit code 或文件存在判断成功。
- 对本次包含运行正文的恢复点，核对正文、所属 Run、用途和操作身份回执一并恢复，正文摘要、分类与媒体类型一致；不能只验证正文可解密。已保存但尚未发布的正文仍保持未发布，恢复操作不能把它补发为 Assistant 消息。
- 若恢复点含 Capability 调用回执，核对原幂等键、冻结任务语义及 Agent/Worker 执行身份一并恢复。旧回执只证明过去已经接纳调用，不能作为重新派发依据；正文访问仍须验证当前权威、租约、Run、能力与 Grant。未知外部结果保持待核对，不因恢复成功自动重试。
- 若包含 Run 执行租约，核对其 Run 归属、唯一执行身份、revision、权威关联和释放状态一起恢复。旧 consumer 或旧权威不能继续写 Run 和检查点；已取消 Run 的检查点、失效租约和命令回执必须一致。恢复后先区分安全提交的结果与待核对的中断执行，不手工重置租约或自动重新执行未知动作。
- 若包含审批暂停点，候选须支持 migration 0026，并共同回读 checkpoint、受保护的 Pi 恢复正文、审批身份与动作摘要、工具执行回执、模型调用序号和原 Run 绝对截止时间。完整等待状态可在当前权限校验后恢复；不完整的运行中状态保持待核查。审批记录不能单独作为重新执行已确认或未知副作用的依据。
- `runtime/`、`cache/`、secret source、authority file 和 public ingress 未被恢复包覆盖；不存在 `.restore-*` 临时目录或 plaintext SQLite 临时文件。
- 对恢复期间已经发生的外部副作用逐项保持原状态或显式进入 reconciliation；不得假定数据库恢复自动撤销外部动作。

## Evidence

每次执行使用新的 `test/integration/qualification/evidence/operations/backup-restore/<unique-run-id>/`。记录脱敏后的 Runbook check、Git HEAD/worktree、目标主机与 identity、路径与权限结论、schema/integrity/空间/锁 preflight、精确命令与 exit status、manifest digest、验证计数、服务停止/启动回读、业务水位线、rollback 状态和最终结论。

不得记录 secret value、配置全文、环境变量转储、Payload plaintext、未脱敏数据库行或恢复包对象正文。若该隔离证据目录不能安全创建，停止操作。

## Rollback

- 在原子切换完成前，任何 authentication、digest、schema、SQLite、Payload、Outbox、空间或注入错误都会删除 staging 并保持当前 `data/` 不变。
- 在切换过程中，CLI 把当前 `data/` 先移动到唯一 previous 目录；后续 rename、fsync、marker 或注入失败会删除新 data 并把 previous 原子移回。验证当前数据仍可读后才能重试。
- 命令成功后 previous 目录会删除。此后若需要回到另一水位线，必须把它作为新的 critical restore，选择另一个已验证恢复点并重新执行全部 preflight 与授权；不能用 runtime/cache、WAL 或未验证目录手工回切。
- 数据库恢复不授权应用版本回退、authority transfer、外部账户回退、secret rotation 或外部副作用补偿，这些边界各自需要独立程序与授权。

## Stop Conditions

- Runbook static check 失败、worktree 或 contract source 在 gate 后变化。
- 主机、deployment、Owner/Agent、authority epoch/fence、state root 或 backup ID 不明确或不匹配。
- 配置/secret 路径权限不安全，secret reference 缺失/重复，或需要显示 secret value 才能继续。
- 可用空间不足以容纳临时 snapshot、加密恢复点和安全余量；不得自动清理 Owner 内容。
- manifest authentication、文件 digest、schema、quick/full integrity、foreign key、行数、Payload authentication 或 Outbox continuity 任一失败。
- 恢复被误认为能够携带、重建或自动激活能力部署快照/runtime root，或快照与恢复后的 active Capability Registry 不一致却要求 Worker ready。
- restore 目标服务未确认停止、state-root lock 不可独占、目标不是配置中的同一 state root，或确认词不精确。
- 要求把同机恢复点当作 off-host disaster recovery、改变 authority、回滚外部副作用、绕过验证、扩大目标或删除其他恢复点。

## Troubleshooting

资源核查失败时先看持久恢复终点与安全原因：`SANDBOX_RECONCILIATION_PERMISSION_DENIED` 表示宿主检查被拒绝，不代表原执行 Grant 应重新授予；`SANDBOX_CONTROL_TIMED_OUT` 是控制连接请求超时，`SANDBOX_RECONCILIATION_TIMED_OUT` 是整个核查任务到期；身份、目录或证据变化必须核对原绑定，不能直接采用当前 PID。`unresolved` 表示本次核查已经结束，不表示后台正在重试。失败细节经原 Job 的受保护 `restricted` Trace 保存，保留备份但不得直接输出到页面或普通日志。没有充分新释放证明时仍保留相交资源保护；不得用删除 claim 或重跑原工具来清除错误。

| 症状 | 安全诊断 | 停止或有界修复 |
| --- | --- | --- |
| `RECOVERY_POINT_TARGET_NOT_STOPPED` | 只读检查服务进程、socket 与 state-root lock owner | 停止；使用已验证的服务停止程序后重新 preflight，不删除活锁 |
| `RECOVERY_POINT_AUTHENTICATION_FAILED` | 核对 manifest 中的 key reference/version 与 host secret reference 可用性，不打印值 | 停止；修复正确 secret source 或选择可认证恢复点，不重写 manifest |
| `RECOVERY_POINT_DIGEST_MISMATCH` 或 `RECOVERY_POINT_PAYLOAD_INVALID` | 保留恢复点只读，记录对象引用和稳定错误码 | 停止；该恢复点不可用，选择另一个已验证恢复点 |
| `RECOVERY_POINT_SCHEMA_MISMATCH` | 对比安装 runtime 的 bundled migration sequence 与 manifest sequence | 停止；先走独立应用兼容/升级决策，不修改加密恢复点 |
| `RECOVERY_POINT_SQLITE_CORRUPT` | 在 staging 验证输出中记录 quick/full integrity 结论 | 停止；不得把损坏 SQLite 切换为当前 data |
| `ENOSPC` 或空间预检不足 | 只读回读同一文件系统可用字节和恢复点大小 | 停止；人工决定安全空间处理，不自动删除 Owner 数据 |
| 恢复中断 | 检查当前 `data/` 可读性、`.restore-*` 与管理锁状态，不手工覆盖 | 若 CLI 已自动回滚且验证通过，可从完整 preflight 重试；否则停止并保留现场 |

### v2 原环境核查约束（2026-09-09）

恢复必须保留既有受保护 Run trace 中的控制引用、终态证据及其 Payload；不得仅备份 SQLite 中的 PID。当前 Agent 权威通过原环境认证控制端口 inspect/stop，或读取原 Job Host 的签名终态；身份、目录 inode、策略或宿主变化时继续隔离，不能在目标主机按旧 PID 停止或重启。Agent 仅加载不含 SRT 启动能力的控制客户端。

Linux 前台清理证据要求原 PID namespace init 已消失及完整终态；Mac 已启动任务没有全树保证时继续 unknown。端口失联、证据不完整和超时均不能解除相交占用。真实假数据探针不签发安装资格；不得把测试临时 bubblewrap/socat 的 PATH 配置用于生产，生产依赖位置须单独验证。实际安装、备份恢复和跨主机迁移的既有步骤及审批边界保持适用。

### 资源输出分页保留

v2 已保存输出的分页引用和 cursor 归原 Run 的受保护 artifact；同机恢复须一同保留对应加密 Payload、artifact 关联及原作业账本。游标只定位原调用/资源的固定输出快照，不能改写为宿主路径，也不能用来重新执行任务。原输出缺失或摘要不符时拒绝，不能以空文件代替；权威迁移仍按原回执和当前身份拒绝旧 Worker 输出权限。R6 追加了后台运行输出片段、结束标记和命令退出事实，均归原 Run；恢复时须同时保留这些 artifact，不补造丢失片段、不重启原命令。后台/服务的目标安装资格仍须独立验证。

### 受管理后台资源的安装与恢复

后台 Bash 继续使用安装的 Pi runner 和固定工具链；其运行模式由 Worker 从匹配的操作声明传入，不能从模型参数选择。前台 Bash 保留原结果格式；后台输出只在完整行检查后追加，末尾无换行内容在退出时检查，机器秘密命中即停止并拒绝输出。start 回执只表示资源已启动，命令退出码另存入连续输出的结束事实。资源句柄与管理调用不能重复消费 Grant。

服务仅在安装声明含匹配的 `readinessProbes` 且具备该模式资格时启用。本批探针使用私有目录内唯一 Unix socket 的 HTTP GET、预期 2xx 状态和最多 30 秒期限；不开放通用本地 TCP 或其他 Unix socket，不以日志判断就绪。恢复后的声明、运行文件与资格必须重新匹配；不得凭旧 ready 回执连接新服务。

Run 正常完成前停止其后台资源；SQLite 完成事务拒绝仍有未释放资源的 Run。未知清理进入原核查流程并保留写目录占用。Mac 测试主进程退出仍不证明任意后代已全部退出，不能清除隔离以获得正常完成。这里没有新增迁移文件、安装资格签发或运行中数据库修改步骤。


## 内置账号的恢复边界

恢复副本在切换为活动 data 目录前会撤销内置账号的旧会话、设备和未完成验证请求，并禁用内置身份绑定。原因是恢复旧数据库可能重新带回旧密码或已消耗恢复码。恢复后必须通过安装运行说明中的停机 `account recover` 管理步骤设置新的凭据，才能重新开放内置账号登录；不能把恢复点中的旧凭据当作当前认证证明。

[SOURCE: docs/adr/0027-built-in-owner-authentication.md] [SOURCE: docs/runbooks/install-start-stop-runbook.md]

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

`pi-coding-tool@3` 仅用于固定 `write/edit`；该合同沿用 Schema 41 的保存结构，当前整体数据库已由资源矛盾事件迁移推进至 Schema 42。准入前以 Pi Operations 的不可变快照准备完整候选，受控暂存区保存候选内容及工具结果；其 inode、摘要与原文件版本绑定到已有受保护 Scope artifact。此阶段没有调用消费回执或工作区占用，正式目标及缺失父目录保持不变。提交仍复用原持久队列、Worker、发布记录和原宿主释放证明；不能因候选已准备就提前派发或宣布保存成功。细节见[本批实施与验证范围](../execution/plans/2026-09-16-workspace-authorization-lifecycle-plan.md#implementation-record)。

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
