---
status: active
document_type: runbook
execution_risk: critical
contract_sha256: "sha256:ed1abaa5b446b80f792aaf407cb79ecafbfbd3451fa037acbe9e6c49b7d5ae08"
supersedes: ""
superseded_by: ""
date: "2026-08-27"
---

# 同机备份与恢复 Runbook

<!-- runbook-contract:
- apps/admin-cli/src
- packages/persistence-sqlite/src/sqlite-recovery-point.ts
- packages/persistence-sqlite/src/state-root-lock.ts
- packages/platform-node/src/host-secret-source.ts
- packages/platform-node/src/payload-protector.ts
- packages/platform-node/src/strict-configuration.ts
- docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md
- docs/adr/0018-sqlite-product-state-authority.md
-->

## Scope

本 Runbook 只管理当前活动部署在同一主机、同一存储边界内的加密恢复点：创建、独立验证，以及把一个已验证恢复点恢复到它原属的明确 state root。恢复点不改变 authority epoch，不创建第二个可启动权威，也不是异地主机损毁后的灾难恢复介质。

恢复包只包含 SQLite backup API 产生的 `data/product.sqlite` 一致性副本，以及该副本实际引用的 `data/payload-ciphertext/` 文件。`runtime/`、`cache/`、lock、socket、日志和 secret 明确排除。当前 CLI 通过权限受限的 secret 目录解析 `backup-encryption` 与 `payload-encryption` 引用；不得把密钥值写入参数、日志或证据。

## Authoritative Sources

- 产品恢复、排除清单、停止服务、原子切换和保留边界：[SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md#同机恢复点导出与导入]
- SQLite 单一产品状态权威：[SOURCE: docs/adr/0018-sqlite-product-state-authority.md]
- 本 Runbook contract selector 中列出的 CLI、恢复点 adapter、管理锁、配置、host secret source 和 Payload 认证实现。
- 受保护配置只提供 state root、deployment/Owner/Agent identity、authority 和 secret reference；运行时回读只显示引用，不显示 secret material。

## Safety and Preconditions

- 有效恢复点必须通过 manifest HMAC、每文件 AES-256-GCM authentication、ciphertext/plaintext digest、schema sequence、SQLite quick/full integrity、foreign key、全表行数、Payload authentication 和 Outbox continuity 检查。
- `backup create` 会向活动 SQLite 写入恢复点与操作 marker，并在 state root 的 `recovery-points/` 下新增加密文件；这是第一次目标 mutation。执行前必须报告主机、deployment、state root、backup ID、预计磁盘增量和 30 天保留上限，并取得覆盖该目标与动作的明确授权。
- `backup restore` 是 critical 恢复 mutation。服务必须已经停止，state-root 管理锁必须可独占取得，目标必须与配置中的 state root 完全相同，且确认词必须精确为 `RESTORE_<backup-id>`。运行前必须再次报告将替换的 `data/`、恢复点 identity、数据回退范围和外部副作用不回滚边界，并取得逐次授权。
- secret 目录及文件必须由当前服务账号拥有，目录权限为 `0700`、文件权限为 `0600`，且配置中各恰好有一个 `backup-encryption` 和 `payload-encryption` secret reference。
- 恢复只回退产品 data partition；不回退 public ingress、外部账户、已完成的外部副作用、host secret、authority 或应用版本。
- 证据只能写入下述项目批准的隔离目录，且不得包含配置全文、密钥、token、Cookie、私钥、Payload plaintext 或未脱敏环境输出。

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

- create/verify/restore 输出的 backup ID、Owner/Agent/deployment、authority epoch、schema sequence 与目标完全一致。
- `quickIntegrityCheck` 与 `fullIntegrityCheck` 均为 `ok`，Payload 数量、Outbox 数量、文件数量和 manifest digest 在独立 verify 中不变。
- 恢复后的 `himawari db status` 显示 managed schema、预期 sequence 与 `quickCheck: ok`；`doctor` 的 authority、schema、SQLite、Payload 与适用依赖符合目标 profile。
- 用恢复点创建前已记录的只读业务引用验证数据水位线已回到预期；不要只依据 exit code 或文件存在判断成功。
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
