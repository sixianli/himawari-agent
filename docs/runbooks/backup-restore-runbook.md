---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:750099fe217460ac72bdbfcd99d647488b00d6868c9e30c838382e64e36583be"
supersedes: ""
superseded_by: ""
date: "2026-08-27"
---

# 同机备份与恢复 Runbook

<!-- runbook-contract:
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

本次 Web 重构追加 schema 30：`runs.model_selection_json` 保存用户提交时选择的模型引用和思考深度。备份、恢复和迁移必须保留此列及原 Trace/Payload；恢复不能用当前输入框的选择改写旧 Run，也不能给旧记录补造选择。目标配置仍须支持原模型、深度、预算与披露，缺失时报告失败而不是静默替换。浏览器的主题、主题色和未发送草稿属于客户端偏好，不随服务数据库恢复。

控制中心查询执行过程时仅返回经过归属校验和字段筛选的展示投影；恢复检查应核对多轮历史、模型选择与审批等待，不直接开放原始 Trace JSON。取消仍经过 RunCoordinator。上述改动由受控 SQLite/Pi 适配与浏览器测试验证，本轮不执行实际运行目录升级、恢复或权威迁移。

R8 的网络出口和活动连接属于原 Job Host，不随备份或权威迁移恢复。Worker 对 foreground、background、service 均在监督循环重查当前授权，失败后请求停止并关闭出口；恢复的旧 Grant 或连接计数不能恢复网络权限。目标需要自己的明确 hostname:port 授权和平台资格，不能沿用源主机上游端口或认证。此变化不修改数据迁移格式或本 Runbook 的停机/恢复步骤。

schema 28 在原数据库追加 v2 资源关联、独立操作/资源观察、目录占用和派发回执。升级既有库仍须先取得已验证快照；0020/0027 不改写。恢复/迁移时必须保留占用和未确认派发；旧未结束作业缺少可信目录链时按主机保守阻止新准入，缺少主机身份时阻止所有主机的新准入。禁止通过删除 Run、清空占用或把旧记录改成 v2 来恢复执行。已确认清理的旧历史结果保持原解释，不由迁移补写新资格。

schema 29 追加执行准备阶段，保持 schema 28 的历史记录为 `legacy_bound`。新 `reserved` 记录没有实际运行摘要，`bound` 记录保存首次启动固定的摘要和监督身份；两者均须与原调用回执、目录占用及观察历史一同保留。恢复或迁移不能为未绑定记录补造启动资格，也不能把已绑定作业重新派发；源主机上的 PID、IPC session 和 boot 仅供核查，不成为目标的停止或执行句柄。

这些 SQLite 机制已有独立测试数据库的升级、重开和事务验证；本次未升级运行中的 state root，也未执行真实安装、恢复或跨主机迁移。正式组合已具备显式 v2 foreground 路径、真实目录身份解析和限定风险核查；Pi 七工具前台 runner 已有假数据验收，目标安装资格仍须独立验证。恢复或迁移后的 Pi 工具链须与原 runtimeDigest 匹配，不能以同名系统工具替代缺失的 bash/rg/fd，也不能下载补齐后沿用旧资格。恢复后继续适用当前主机/目录/权威检查，不能自动重放旧任务或未确认派发。

SRT 变更已包含产品作业合同、计划投影、Pi 调用绑定、固定版本运行依赖及候选策略编译。Node 打包包含 `runtime-sandbox` 和 SRT 0.0.75，正式 Worker 已分别组合 v1 与显式 v2 foreground，未取得 SRT 主机安装资格。schema 27 已追加作业观察账本；升级必须遵循下述快照与迁移检查，不能在恢复后将无账本的旧凭证补建为可启动作业，也不能自动重放待核查作业。固定假数据策略探针通过不代表正式 Job Host、资源硬上限或崩溃恢复可用。本文的实际安装、备份与权威迁移流程不因目标架构获采纳而改变；不能把恢复的旧 Capability 记录当成新 SRT profile 的主机资格。

本 Runbook 只管理当前活动部署在同一主机、同一存储边界内的加密恢复点：创建、独立验证，以及把一个已验证恢复点恢复到它原属的明确 state root。恢复点不改变 authority epoch，不创建第二个可启动权威，也不是异地主机损毁后的灾难恢复介质。

恢复包只包含 SQLite backup API 产生的 `data/product.sqlite` 一致性副本，以及该副本实际引用的 `data/payload-ciphertext/` 文件。Agent/Worker 启动身份文件位于 `runtime/`，不属于恢复数据；恢复后的服务必须重新建立当前 boot、authority lease 和握手，不能把旧启动文件当作恢复后的执行权限。`runtime/`、`cache/`、lock、socket、日志、secret、能力部署快照及其 runtime root 明确排除；恢复后仍须由安装流程独立提供并验证与 active Capability Registry 一致的不可变快照，不能从数据库记录重新生成可执行绑定。当前 CLI 通过权限受限的 secret 目录解析 `backup-encryption` 与 `payload-encryption` 引用；不得把密钥值写入参数、日志或证据。

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

3. 创建命令只有在自动临时解密验证全部通过后才返回成功。随后从独立命令再次验证：

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

## Verification

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
