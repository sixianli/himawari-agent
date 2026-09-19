---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:6ae09a90483b30bd52b1e956fb94a310531ddfcfe61d3abe0ecb787d868b4135"
supersedes: ""
superseded_by: ""
date: "2026-08-27"
---

# 停机加密 Authority Transfer Runbook

<!-- runbook-contract:
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

SRT 的 Agent Service/Worker 组合已接上现有授权来源、受保护 scope、认证 Payload 通道与作业监督器；Node 打包包含 SRT 0.0.75。当前文件 inspect/read scope 来源与受控 Mac 组合探针已经实现，但未签发正式安装主机资格，也未完成真实跨主机崩溃恢复验收。schema 27 继续保存计划和作业观察；初始观察允许无策略摘要，由首次原子启动固定 Worker 编译的摘要，此后不得更换。资源观察随作业记录迁移，仅为历史证据，不能成为目标主机资格。恢复后不能给无账本的旧凭证补建可启动作业，不能重放清理未知作业。本文的停机、备份与权威迁移流程保持不变；目标仍须独立验证主机资格、目录授权和本次操作的网络 Grant，不得沿用源主机路径或网络上界推断授权。

本 Runbook 只用于把同一个 Owner/Agent 的单一逻辑权威在两个已准备好的 deployment 之间停机迁移。它覆盖源部署导出、迁移包认证检查、空目标导入、inactive-ready 验证、显式激活、未激活导入的放弃，以及加密迁移包的 7 天保留边界。

目标服务必须建立自己的 Agent/Worker boot identity、authority lease 和反向权限/Payload 通道；源 `runtime/` 中的启动绑定不随迁移包转移，也不能在目标重用。

目标 Agent Service 现在会在创建准入入口前核查已有 SRT 作业：prepared/starting 等未结束作业保存为清理未知并隔离，已有隔离状态保持不变。核查使用当前目标权威，仅追加观察；不把源 Worker 凭据变成目标执行权限，不自动重放，也不证明源机器的任务后代已经退出。此启动行为已有同机 SQLite 回归，不能代替实际双向迁移和两台主机的进程核查。

迁移不是在线复制、自动故障切换、普通备份、主机损毁恢复或 active-active。导出一旦进入 `retired_pending_transfer`，源部署不能自动恢复为 active；回切必须由当时的 active target 发起新的 reverse transfer。当前实现把激活后的 source `retired` 状态写入目标侧的权威产品数据库；物理源 state root 保持 `retired_pending_transfer`，两种状态都拒绝普通启动。

## Authoritative Sources

- 迁移顺序、manifest、Payload/Memory、秘密排除、失败行为和验证边界：[SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md#同机恢复点导出与导入]
- 单一逻辑 Agent authority：[SOURCE: docs/adr/0003-single-logical-agent-authority.md]
- 停机加密迁移决策与回切边界：[SOURCE: docs/adr/0019-offline-authority-transfer.md]
- 本 Runbook contract selector 中列出的 CLI、状态机、SQLite adapter、offline lock、authority file、配置、host secret source、Payload envelope 和普通启动 fail-closed 实现。

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

## Verification

### Schema 33 释放事实与有界恢复

Schema 33 保存 `sandbox_release_receipts`、独立控制保护及 `recovery_json`。升级、备份与迁移必须一同保留这些记录、原执行观察与占用；已经提交的 `released_at` 不得清空，结果 ACK 迟到不改变释放事实。旧记录没有新的可信释放回执时不自动回填或解锁，须通过当前安装的受限 inspect/stop 核验；过期凭证不能当作新观察使用。

启动恢复不重发原工具，失去原恢复 owner 或核验超过期限时持久记录 unresolved。验收独立读回原释放时间、恢复 owner/次数/终点和未完成交接，不能仅凭页面状态判定清理完成。恢复回执只证明资源义务已结束，不恢复执行或模型披露权限。Schema 33 不允许旧 writer 直接写入；回退须停止服务并使用匹配旧版本的完整、已核验恢复点，不能删除新表或修改 migration ledger 降级。本次源码与隔离数据库测试不代表已对部署实例执行迁移或解锁。

### Schema 34 审批与额度预约

Schema 34 新增 `authorization_reservations` 并为使用记录增加请求身份。备份与恢复须保留预约、Handle、调用回执和已消费计数的一致快照；历史消费不自动退回，迁移不会使旧请求重新可执行。新 v2 摘要使用 SHA-256，旧摘要只按原快照验证，不覆盖已有审批内容。

验收分别读回 reserved、committed、released：排队预约不增加消费，调用准入与额度承诺同事务完成；未派发释放必须同时撤销未使用 Handle。缺少 ACK 不能作为退费或重发依据。回滚只能在服务停止后恢复匹配旧版本的完整恢复点，禁止让 Schema 33 或更旧 writer 写入 Schema 34，因为它们不理解预约额度。此处仅定义升级合同，未授权或执行部署实例的迁移。


### v4 控制中心与持久事件核对

本次调整增加 Worker 工具实际起止事件和 Pi 可观测思考边界的展示投影，沿用原有 Trace/Payload 存储，不增加数据库迁移。备份、恢复及权威迁移仍须完整保留这些记录；缺少旧时长边界的历史显示“暂无时长”，不得在恢复时补造计时或重放工具。原有停止、安装资格、加密与权威检查程序继续适用。

聊天页的新建先进入本地草稿，首次发送才创建持久会话。审批在所属轮次处理，侧栏红点提醒；归档管理位于齿轮设置的“会话与数据”。联网搜索开关与会话内“记住我的选择”复用原来的受限搜索授权合同。设置不展示内部 checkpoint、修订和连接绿点。安装后须验证草稿恢复、幂等重试、当前轮审批以及真实模型支持的强度档位，不能以原型演示数据作为运行证据。语言切换应保持设置弹窗及当前页面状态。


自动标题沿用既有 Thread、受保护 Payload 和模型费用账本，不新增 schema。迁移须共同保留 `threads.title_ref`、标题来源与 revision、标题 Payload，以及 `thread-title:<runId>` 对应的调用身份和费用状态；目标不能因标题缺失清除 started/unknown 记录或重放源请求。正常停机先停止 Run 循环，再等待已发起的标题请求结束；标题请求最多等待 20 秒，仍受配置的更短期限约束。强制中断后的进程内标题队列不属于迁移数据，目标以已提交状态为准。已有标题和手动改名优先，不在 import/activate 时批量请求模型。

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

Linux 前台清理证据要求原 PID namespace init 已消失及完整终态；Mac 已启动任务没有全树保证时继续 unknown。端口失联、证据不完整和超时均不能解除相交占用。真实假数据探针不签发安装资格；不得把测试临时 bubblewrap/socat 的 PATH 配置用于生产，生产依赖位置须单独验证。实际安装、备份恢复和跨主机迁移的既有步骤及审批边界保持适用。

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

Schema 35 新增 `sandbox_admission_queue`。备份应同时保留队列次序、冻结请求、调用回执、Handle 和额度预约；恢复不能把已准入请求重新派发。等待中的请求没有文件占用，也没有消费回执；取消、期限届满或授权失效后不能取得资源。当前版本允许工具对象重建后在完整执行身份不变时继续原队列：保留原目标、回执编号、期限与次序，准入事务再次核对冻结请求并只承诺一个回执。跨 Agent/Worker boot 或产品 authority fence 变化后的执行权重新绑定及后台自动续接仍未实现；恢复时不能通过删除队列或更换调用身份绕过原次序。

受控文件发布先完成并同步暂存内容，再发布最终路径。已保存的文件操作记录可包含暂存 inode 证据；恢复只核查最终文件身份与内容，并清除属于该操作的暂存硬链接，不重复写入。仅内容相同不足以证明是本操作产生的效果。文件候选位于原授权目录的 `.himawari-recovery/`；它不属于产品数据库备份包，不能据数据库恢复宣称候选内容或目标文件已恢复。

Schema 35 也是旧 writer 的版本屏障：Schema 34 或更旧代码不理解持久公平队列及文件发布归属，禁止并行写入新库。回退须停止服务并恢复匹配旧版本的完整恢复点，不能只删除新表或降版本号。当前文件原语已有本地 macOS 回归证据；跨 Worker 的细粒度文件占用、Linux 文件系统资格和部署升级仍须独立验证。

### Schema 36 固定文件目标合同

Schema 36 不重写旧记录；它为新增 JSON 字段建立 writer 版本屏障。`pi-coding-tool` 合同 2 在受保护 Scope 中保存 `sandbox-file-target.v1`：相对路径、授权根以下的已存在父目录身份，以及原文件 inode 和内容摘要。目标不存在与父目录尚未创建分别记录；父目录缺失时继续协调整个授权目录，不伪称已有精确父目录身份。备份必须保留原 Scope Payload、其摘要和对应 claim，不能恢复时按最新文件内容重建原基线。

合同 1 继续使用目录级协调。合同 2 仅用于固定目标 read/write/edit；新 Worker 在启动 Job Host 前拒绝缺少文件快照的新合同，旧 Worker 会拒绝未知合同版本。它仍复用原 Job Host、SRT 与 Pi Operations；不能仅在登记数据里把版本改成 2 就视为安装资格通过。新安装的实际字节、冻结快照和目标主机资格必须匹配后才可采用新合同。

恢复不能把目标版本冲突改写为允许覆盖。文件型 claim 同时保留父目录名称槽位和当前文件身份，原子替换后名称槽位仍冲突；硬链接、符号链接和跨设备目标被拒绝。名称保守归一化可能在区分大小写的文件系统上多排队，不能据此宣称所有别名场景的并行资格已通过。默认核验读取仍要求当前路径不变；固定文件读取可读完已经打开的完整旧版本，不能推广成任意原地写入都可并行。回退仍要求停止服务并恢复匹配旧版本的完整恢复点。

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
