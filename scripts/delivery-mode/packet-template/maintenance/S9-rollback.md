# S9：明确批准后恢复原样数据与旧版本控制文件

第十二次变更由 `scripts/delivery-mode/deploy.sh` 运行。从 `S2_STOP` 起任何一步失败，`deploy.sh` 会自动运行 `scripts/delivery-mode/rollback.sh`，按下面的步骤恢复；其他时候只有 Andy（执行生产命令的用户）决定回退时才手动运行。第十二次的数据库结构版本（Schema，数据库表结构的编号）从头到尾都是 56，没有迁移，所以恢复只有一条路线：把 S3（停服后原样复制数据库的步骤）保存的 Schema 56 数据库（恢复点编号 `__PKT_LABEL__-__PKT_DATE_COMPACT__-raw-schema56`）放回原位，再让服务的配置、systemd unit（系统服务定义文件）、能力快照和启动证明回到旧版本 `/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__` 的原件。放回之前，程序会先把当时的 Schema 56 数据原样另存一份（不做反向迁移）。

恢复会丢掉恢复点之后写入的全部历史，包括 `S7_CATALOG_UPGRADE` 用 `himawari capabilities upgrade --reviewed` 写入的变更：`himawari.pi-coding`、`himawari.public-search`、`himawari.public-fetch` 三条登记的升级（能力登记：数据库里记录每个能力版本和声明摘要的行）。恢复后三条登记回到 S0（上线前在生产机上做的只读读取）读回时第十一次的样子，与恢复后的旧配置、旧快照一致。工作目录 `/var/lib/himawari/workspace` 和它的授权 `directory:himawari-prod-workspace-20261015` 在第十二次没有改动，恢复后授权仍是 S0 读回的版本和内容，目录和里面的文件不动。恢复不会自动撤销账号、会话或设备。恢复成功后服务仍保持停止，重新启动需要另行批准。新旧正式安装、恢复前的当前数据副本、原 control 目录、秘密（包括已在生产机上的 `deepseek-web` 密钥文件）和全部报告都保留。

导航：[批准文件](#批准文件) · [数据库恢复](#数据库恢复) · [附属文件整理](#附属文件整理) · [控制文件恢复](#控制文件恢复) · [恢复后停服](#恢复后停服)

## 批准文件

Claude 根据用户的具体批准，在证据根 `/var/lib/himawari/__PKT_LABEL__-__PKT_DATE_COMPACT__-evidence` 内建立 `rollback-approval.json`。文件必须由 root 所有、属组 GID __PKT_SERVICE_GID__、权限 0640：生产账号能读，不能改。恢复点摘要来自 S3 成功报告；`approvalRef` 必须写这次批准的具体引用，不能用下面的占位文本。

```json
{
  "schemaVersion": "himawari.__PKT_LABEL__-change-rollback-approval.v1",
  "action": "S9_RAW_RESTORE51",
  "recoveryId": "__PKT_LABEL__-__PKT_DATE_COMPACT__-raw-schema56",
  "recoveryDigest": "EXECUTION_OUTPUT:/s3_copy51-result.json/recovery/verifiedResult/digest",
  "targetStateRoot": "/var/lib/himawari/state",
  "targetPrefix": "/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__",
  "discardsPostRecoveryPointHistory": true,
  "discardsCapabilityUpgrade": true,
  "requiresIndependentAccountRecovery": true,
  "controlFilesApproved": true,
  "preservedCurrentRecoveryId": "__PKT_LABEL__-__PKT_DATE_COMPACT__-raw-before-rollback51",
  "approvalRef": "PENDING:CONCRETE_ROLLBACK_ROUTE_APPROVAL"
}
```

模板本身不是批准。各字段的作用：

| 字段 | 检查方 | 含义 |
| --- | --- | --- |
| `recoveryId`、`recoveryDigest` | 数据库动作和控制文件脚本 | 只能恢复 S3 建的那个恢复点，摘要必须与 S3 报告一致。 |
| `targetStateRoot` | 两者 | 只能是原 stateRoot `/var/lib/himawari/state`。 |
| `targetPrefix` | 两者 | 必须是旧版本路径，其他路径都会被拒绝。 |
| `discardsPostRecoveryPointHistory` | 两者 | 承认恢复点之后的历史会丢失。 |
| `discardsCapabilityUpgrade` | 两者 | 承认 `S7_CATALOG_UPGRADE` 写入的能力登记变更会随之消失：三个能力回到 S0 读回的登记。 |
| `requiresIndependentAccountRecovery` | 两者 | 承认账号凭据是否轮换要另行决定。 |
| `controlFilesApproved` | 两者 | 同时批准恢复控制文件。 |
| `preservedCurrentRecoveryId` | 数据库动作 | 恢复前先把当时的数据再存一份，编号不能与 S3 恢复点相同。 |
| `approvalRef` | 两者 | 不能为空，也不能以 `PENDING:`、`S0_DB:`、`EXECUTION_OUTPUT:` 开头。 |

缺任何一项或值不对，数据库动作以 `__PKT_LABEL_UPPER___MAINTENANCE_ROLLBACK_*`（或 `__PKT_LABEL_UPPER___MAINTENANCE_CURRENT_STATE_RECOVERY_REQUIRED`）拒绝，控制文件脚本以 `__PKT_LABEL_UPPER___S9_*` 拒绝，都不改任何数据。

[返回导航](#s9明确批准后恢复原样数据与旧版本控制文件)

## 数据库恢复

1. 服务保持 inactive、MainPID 为 0。Claude 用统一包装运行 `S2_INSPECT`（以 root 运行 `/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__/systemd/S2-stop-and-inspect.py --inspect-only`）。它只生成新的现场报告，不删锁也不启动服务。三项操作系统结论必须都是 confirmed；有 unknown 或进程看不全就不能恢复。
2. 可选：如果数据库旁边仍留着 `-wal` 或 `-shm`（见[附属文件整理](#附属文件整理)），Claude 先运行 `S9_SIDECAR_TIDY` 整理它们，再执行下一步恢复。它以生产账号、原 HOME/PATH、umask 0022 运行 `/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__/maintenance/run-maintenance.mjs S9_SIDECAR_TIDY`；被自动权限检查拦下时，用户运行 [数据库备用包装](run-user-maintenance.sh)，参数相同。整理失败时服务保持停止，残留保留，按失败报告另行处理，不手动删除文件。
3. Claude 用统一包装运行 `S9_RAW_RESTORE51`。它以生产账号、原 HOME/PATH、umask 0022 运行 `/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__/maintenance/run-maintenance.mjs S9_RAW_RESTORE51`。被自动权限检查拦下时，用户运行 [数据库备用包装](run-user-maintenance.sh)，参数相同。
4. 维护程序先核对批准文件，再取得正式状态锁，保存当前只读读回（当前 Schema 必须是 56，否则以 `__PKT_LABEL_UPPER___MAINTENANCE_ROLLBACK_CURRENT_SCHEMA_REQUIRED` 停止），并新建一份当前数据的原样恢复点（编号取批准文件里的 `preservedCurrentRecoveryId`，模板写的是 `__PKT_LABEL__-__PKT_DATE_COMPACT__-raw-before-rollback51`，这份恢复点记录的是恢复前那一刻的数据，Schema 是 56 或 55），这样恢复之后仍能取回现在的数据。随后它重新核对 S3 恢复点的完整文件树和摘要，建立独占的已核验暂存目录，把原数据库和加密 Payload 目录分别改名到原 state 下的 `.raw-restore-<preservedCurrentRecoveryId>-original`，再放入已核验副本，每一步都留记录。任何中断都保留原数据和暂存目录，不自动撤销。目标只能是原 stateRoot，不使用 backup CLI，也不读备份密钥。
5. 维护程序独立检查恢复后的 Schema、完整迁移记录、integrity 和外键检查、全部加密 Payload 的路径、字节和 SHA，历史表和升级门是否与 S3 建恢复点时的读回一致，以及 S0 读回的三个能力的登记是否都等于 S0 读回的样子（报告的 `catalog` 字段）。`s9_raw_restore51-result.json` 必须 passed；报告记录批准文件 SHA、恢复结果、恢复前当前数据恢复点和恢复后读回的 SHA。失败时服务保持停止，日志和残留都保留。

原样复制不包含 `authority.json` 镜像（部署身份文件的副本）。恢复数据库后，程序以只读方式核对镜像里的部署身份、revision、status、epoch、fence 和 transferId 是否与恢复后的数据库一致。S7 的启动会推进 fence（防止旧进程继续写的递增编号），所以恢复点里的值可能比镜像旧；不兼容时报告 `__PKT_LABEL_UPPER___MAINTENANCE_RESTORED_AUTHORITY_MIRROR_INCOMPATIBLE`，服务继续停止。这时数据可能已经恢复，但不能继续恢复控制文件或启动；要根据失败报告另行批准处理办法，不能手改镜像绕过。Hermes 上的生产形状演练专门造了这种不一致，确认它以这个错误码停止。

当前状态读回和原样复制都要求数据库旁边没有 `-wal` 和 `-shm`（SQLite 的预写日志和共享内存附属文件）。如果在 `S7_DB_STATUS` 之后、服务真正启动之前就需要恢复，这一步打开过数据库，可能留下这两个文件。`S7_CATALOG_UPGRADE` 本身不运行末尾的 `db status`，正常不会留下附属文件。历史上（第五次）的 `S7_CATALOG_UPGRADE` 结尾运行过 `db status`，留下了 `-wal` 0 字节、`-shm` 32768 字节，登记为 [BL-20261017-007](../../../../docs/backlog/BL-20261017-007-s9-回-滚-前-处-理-数-据.md)，后来已删除该步，见 [S7 说明](../systemd/P9-switch-start-readback.md#能力升级与配置切换)。这时 `S9_RAW_RESTORE51` 会在动任何数据之前以 `__PKT_LABEL_UPPER___RAW_COPY_DATABASE_SIDECAR_PRESENT` 停止。这是预期的安全停止：不要手动删除这两个文件；先按[附属文件整理](#附属文件整理)运行 `S9_SIDECAR_TIDY` 整理，再重试恢复，或根据失败报告另行批准处理办法。服务正常启动过再正常停止之后，最后关闭数据库的服务进程会自行清掉这两个文件。同样的原因，`S9_RAW_RESTORE51` 结束时不运行 `db status`，否则下一步 `S9_RAW_CONTROL51` 会以 `__PKT_LABEL_UPPER___S9_DATABASE_SIDECAR_PRESENT` 拒绝。

[返回导航](#s9明确批准后恢复原样数据与旧版本控制文件)

## 附属文件整理

`S9_SIDECAR_TIDY` 只处理 SQLite 数据库旁边的预写日志 `-wal` 和共享内存 `-shm` 附属文件，不改数据库内容，也不删除任何文件；它用 SQLite 自带的 checkpoint 让服务进程正常收尾。它先只读地读回当前状态，再以读写方式打开数据库并执行一次 `PRAGMA wal_checkpoint(TRUNCATE)`，随后关闭。这个动作不需要状态锁。第十二次的当前数据库是 Schema 56，读回和比较用的 Schema 值、迁移记录和张数都取自数据库本身，不写死版本号。

前置条件（缺一即停，不改任何数据）：

1. 服务处于停止状态（unit inactive、MainPID 为 0）。
2. 批准文件 `rollback-approval.json` 存在，并与 `S9_RAW_RESTORE51` 用完全相同的核对（路线、动作、恢复点摘要、批准引用等）。
3. 证据根内有一份 300 秒内、`mode` 为 `inspect-only`、`passed` 为真、`processesAbsent.confirmed` 为真的 `S2_INSPECT` 报告，路径在证据根下，摘要核对方式与 `S9-control-files.py` 的 `stopped_proof` 一致。

动作在预读回前和读写打开前各扫描一次 `/proc/<pid>/fd`，把每个进程打开的文件与数据库、`-wal`、`-shm` 的真实路径逐字比较；只要数据库被任何进程打开，就以 `__PKT_LABEL_UPPER___MAINTENANCE_DATABASE_OPEN_BY_PROCESS` 停止并报出 pid 和匹配路径（root 进程由 `S2_INSPECT` 负责，这里跳过读不到的进程）。预读回按附属文件状态选读取方式：`-wal` 和 `-shm` 都在时用宽松只读打开；只有 `-shm` 时用 `immutable=1` 只读主库；只有 `-wal`（缺 `-shm`）无法安全读，立即以 `__PKT_LABEL_UPPER___MAINTENANCE_SIDECAR_READ_REQUIRES_SHM` 停止；两者都没有时只记录 `noSidecars`，不做读写打开。读取前后都记录附属文件状态（`-wal` 的存在、大小和 SHA-256，`-shm` 的存在），读回期间有变化就以 `__PKT_LABEL_UPPER___MAINTENANCE_READBACK_CHANGED_SIDECARS` 停止。读回之后、读写打开之前再记录一次同样的状态，写进报告的 `sidecarsBeforeWrite`；其中的 `-wal` 大小和 SHA-256 是读写连接打开前一刻的实测值，用来证明那一刻日志里是否仍有未合并的帧。

整理阶段以 `fileMustExist: true`、不带 `immutable` 的读写方式打开数据库：`PRAGMA journal_mode` 不是 `wal` 时以 `__PKT_LABEL_UPPER___MAINTENANCE_NOT_WAL` 停止；`pragma("wal_checkpoint(TRUNCATE)")` 返回的 `busy` 不为 0 时以 `__PKT_LABEL_UPPER___MAINTENANCE_SIDECAR_BUSY` 停止；关闭后仍存在 `-wal`/`-shm` 时以 `__PKT_LABEL_UPPER___MAINTENANCE_SIDECAR_REMAINS` 停止（报告路径、大小、所有者和权限）；存在 `-journal` 时以 `__PKT_LABEL_UPPER___MAINTENANCE_JOURNAL_SIDECAR_PRESENT` 停止；附属文件为符号链接、目录、FIFO、链接数不为 1、所有者不等于数据库所有者、或权限含组/其他可写位时以 `__PKT_LABEL_UPPER___MAINTENANCE_SIDECAR_UNSAFE` 停止。所有者与数据库所有者比较，不用写死的 uid:gid。返回值里只有 `busy` 用来判断：按 SQLite 的说明，`TRUNCATE` 成功收尾后日志被截断为零字节，返回的 `log` 和 `checkpointed` 因此按定义都是 0，整理前日志里有没有帧都一样；日志里的帧是否真的并回主库，靠整理后只读主库的内容与整理前读回逐项比较来证明（见下），不能看这两个数。

整理后严格读回当前状态（`rollback-current`），把 Schema 两个值、账本全部行、12 张历史表的行与摘要、能力声明、授权记录、`integrity_check` 和 `foreign_key_check` 与整理前逐项比较，任何差异都以 `__PKT_LABEL_UPPER___MAINTENANCE_TIDY_CONTENT_CHANGED` 停止；整理前的读回经过日志，整理后的严格读回只读主库（`immutable=1`），所以这一比较同时证明日志里的帧确实并回了主库。成功时在证据根写 `s9_sidecar_tidy-result.json`，记录整理前读回、整理记录（`PRAGMA journal_mode`、checkpoint 返回值，以及读写打开前一刻的 `sidecarsBeforeWrite`）、整理后严格读回和结果；失败时服务保持停止，残留保留，按失败报告另行处理，不手动删除文件。

[返回导航](#s9明确批准后恢复原样数据与旧版本控制文件)

## 控制文件恢复

只有上一步数据库恢复报告 passed 后，Claude 才用统一包装运行 `S9_RAW_CONTROL51`，它以 root 运行：

```sh
/usr/bin/python3 -I /opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__/maintenance/S9-control-files.py S9_RAW_RESTORE51
```

被自动权限检查拦下时，用户运行 [控制文件备用包装](run-user-control-rollback.sh) `S9_RAW_RESTORE51`。脚本先核对 Node 和本目录 `OWNED-SHA256SUMS` 列出的辅助文件未变、绑定已冻结，再核对批准文件的路线、动作、恢复点摘要和批准引用与数据库恢复报告完全一致；然后以只读 SQLite 重新核对 Schema、迁移记录、integrity、外键、没有未处理的沙箱预留、授权 `directory:himawari-prod-workspace-20261015` 的版本和内容等于 S0 读回、Pi 和搜索（`himawari.pi-coding`、`himawari.public-search`）的能力登记等于 S0 读回，并运行一次 S2 `--inspect-only`，得到控制文件恢复前的新现场报告。报告缺失、操作系统结论 unknown、unit 不是 inactive/MainPID 0、unit SHA 既不等于 S0 读到的原 unit 也不等于 S7 发布的新 unit，或任何不一致，都会阻止写入。

脚本先用独占新文件完整保存当前 config、unit、快照和启动证明的字节和 SHA。原配置及其敏感字节只写进生产账号 0600 文件，unit 和 root 报告只写进 root 保护文件；终端只输出证据位置、SHA 和状态。然后它从 S2 保存的原件恢复旧版本的能力快照、启动证明、config 和 unit：config、快照和启动证明恢复为生产账号 0600，unit 恢复为 root 0644。恢复前还核对 S2 保存的原配置 SHA 等于 S0 读到的旧配置摘要、原配置的编码路由仍指向授权 `directory:himawari-prod-workspace-20261015`、原配置里的 `capabilityDeployment` 指向 S2 保存的原快照。S2 保存的原配置里 `http.staticRoot` 还是第十一次的目录，所以 `S7_CONFIG_APPLY` 的改动也随原配置一起被换回。旧版本（第十一次）的 prepare helper（启动前准备脚本）和 root 保护文件在 `/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__`（`cloud-protected-prepare.mjs`、`pair-supervisor.mjs`、`runtime-protection.json`），第十二次变更没有改过它们，脚本只核对它们与 S2 保存时相同，不会以恢复名义覆盖。

恢复 unit 之后、`daemon-reload` 之前，脚本清理 `S7_CONFIG_APPLY` 或准备脚本中断时可能留下的两个临时文件 `/etc/himawari/config.json.next` 和 `/var/lib/himawari/state/deployment/capability-deployment.json.next`：每个存在的文件必须是生产账号所有、0600、普通文件，否则以 `__PKT_LABEL_UPPER___S9_FILE_UNSAFE` 或 `__PKT_LABEL_UPPER___S9_FILE_MODE_CHANGED` 停止且不删除；符合时先把字节保存进证据根，再删除并同步目录，报告的 `clearedPrepareLeftovers` 列出删除了哪些文件和保存位置。准备正常结束时这两个文件不存在，这一步什么也不删。

脚本随后执行 `systemctl daemon-reload`，读回 inactive/MainPID 0、相同的 User/Group/UMask/NoNewPrivileges/空 capabilities，以及指向旧版本路径的 ExecStart、旧 prepare helper 和保护文件。控制文件修改前后各用 readonly/query_only 事务读回数据库。成功报告是 root:GID988 0640 的 `s9-control-result-<时间>.json`，记录 `capabilityUpgradeDiscarded=true`、`grantRecordUnchanged=true`、`accountRecoveryRequired=true`、`serviceStartAuthorized=false`。失败时保存 `s9-control-failure-<时间>.json`，不自动撤销已做的部分，也不启动服务。

[返回导航](#s9明确批准后恢复原样数据与旧版本控制文件)

## 恢复后停服

数据库和控制文件恢复成功后，服务仍然停止。重新启动旧版本前，需要用户另行批准，并重新做现场检查。报告里的 `accountRecoveryRequired=true` 表示：恢复带回的是恢复点当时的认证行，是否需要轮换账号凭据由用户决定；如需轮换，使用[安装 Runbook 的账号恢复步骤](../../../../docs/runbooks/install-start-stop-runbook.md)，并要有单独批准和用户提供的受保护输入文件。S9 不生成、读取或打印密码和第二因素输入，也不补建授权或能力登记。

临时材料清理按包内准确清单另行执行。本目录不会删除正式安装、恢复点、原 control、秘密、授权目录或报告。

[返回导航](#s9明确批准后恢复原样数据与旧版本控制文件)
