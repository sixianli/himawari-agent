---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:f86b20b4e38f6a3e410f7e3a4991ab024d08ea0fff947d10f212e58199e78830"
supersedes: ""
superseded_by: ""
date: "2026-08-27"
---

# 停机加密 Authority Transfer Runbook

<!-- runbook-contract:
- apps/admin-cli/src
- apps/agent-service/src/service-main.ts
- packages/domain/src/durable-state.ts
- packages/persistence-sqlite/src/sqlite-authority-transfer.ts
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

本 Runbook 只用于把同一个 Owner/Agent 的单一逻辑权威在两个已准备好的 deployment 之间停机迁移。它覆盖源部署导出、迁移包认证检查、空目标导入、inactive-ready 验证、显式激活、未激活导入的放弃，以及加密迁移包的 7 天保留边界。

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
- target state root 必须停止且 product `data/` 为空，不能先复制 SQLite、Payload 或 authority file。目标 host 的配置与秘密必须独立准备；机器秘密不得进入迁移包。
- 配置中必须恰好存在一个 `payload-encryption` 和一个 `transfer-recipient` secret reference。当前 CLI 从绝对路径的 restricted secret directory 解析 32-byte key material；目录必须为当前账号所有且 `0700`，文件必须为当前账号所有且 `0600`。密钥值不得进入 argv、环境变量、日志、Trace 或证据。
- `activate` 只接受权限受限、字段精确的 preflight JSON。CLI 会实际解析目标 Payload 和 recipient key；`doctorReady` 与 `publicIngressReady` 必须来自本次只读检查。文件中的布尔值不是替代证据，缺少原始回读时停止。
- 迁移包 plaintext staging 只能位于 CLI 生成的受限临时目录。copy-on-write 与 SSD 删除不保证可靠擦除；主要保护来自包加密、受限权限、临时文件清理和后续 key disposal。
- 任何公网入口切换、Hermes/Mac 服务操作、外部账户变更和旧包删除都保持各自授权边界。

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
9. 在 target 对 secret references、离线 product diagnostics、目标服务配置、public origin、受控 ingress 和回滚边界执行只读 preflight。创建字段精确、权限 `0600` 的 JSON：

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

## Verification

- authenticated manifest 与 import/activate 输出中的 transfer、Owner/Agent、source/target deployment、product/schema/adapter/Memory versions 完全一致。
- target activation epoch 与 fencing token 各为源值加一；目标权威 SQLite 与 `authority.json` 状态、epoch、fence 和 transfer ID 一致，且最多一条 deployment 为 `active`。
- import 前不存在 target product state；import 后 activation 前 target 为 `inactive_ready` 且普通 Agent Service 启动失败；activate 后只有 target 可通过普通启动检查。
- source 物理 authority 保持 `retired_pending_transfer` 并拒绝普通启动；target canonical SQLite 中 source deployment 为 `retired`。旧 source 不能靠复制旧 authority、旧 SQLite 或旧包回到 active。
- target Payload 能以目标 KEK 完成 authentication/decryption；Memory projection、Owner/Agent/Thread/Run identity、checkpoint、水位线、jobs 和外部 integration state 以本次范围的只读 fixture 对比一致。
- manifest allowlist 只含 SQLite、数据库引用的 Payload ciphertext 与 Memory 文件；包不含 secret、cache、log、runtime、lock 或 socket，证据不含 plaintext。
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
