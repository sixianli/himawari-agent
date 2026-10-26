# S9：异常时保留现场、批准后恢复、临时材料清理

`scripts/delivery-mode/deploy.sh` 在 `S2_STOP` 之前失败时，服务没有被动过，只停止后续动作。从 `S2_STOP` 起失败时，它自动运行 `scripts/delivery-mode/rollback.sh` 恢复旧版本；其他时候只在 Andy 决定回退时手动运行。

恢复只有一条路线：把 S3（停服后原样复制数据库的步骤）保存的 Schema 56 数据库（Schema 是数据库表结构的编号；恢复点编号 `__PKT_LABEL__-__PKT_DATE_COMPACT__-raw-schema56`）放回，再把配置、unit（systemd 系统服务定义文件）、能力快照和启动证明换回第十一次部署的原件，旧版本安装目录是 `__PKT_OLD_PREFIX__`。第十二次的数据库从头到尾都是 Schema 56，没有迁移，所以也没有“退回 Schema 50”这一说。

恢复需要用户对这一次恢复的具体批准，写进受保护的 `rollback-approval.json`（动作 `S9_RAW_RESTORE51`）：恢复点编号和摘要、旧版本路径、承认恢复点之后的历史会丢失、承认 `S7_CATALOG_UPGRADE` 做的能力登记变更会丢失（三个能力的升级）、承认账号凭据是否轮换要另行决定，以及具体的批准引用。恢复会先把当时的 Schema 56 数据原样另存一份，再放回 S3 的 Schema 56 数据。同时，`S7_CONFIG_APPLY` 对 `http.staticRoot` 的改动随原配置一起被换回。

如果数据库旁边仍留着 `-wal`/`-shm` 附属文件（SQLite 的预写日志和共享内存文件），先用生产账号运行 `S9_SIDECAR_TIDY` 整理（[附属文件整理](../maintenance/S9-rollback.md#附属文件整理)），不手动删除。准确步骤和后果见 [S9 恢复说明](../maintenance/S9-rollback.md)、[数据库维护程序](../maintenance/run-maintenance.mjs)和[控制文件恢复脚本](../maintenance/S9-control-files.py)。数据库恢复用动作 `S9_RAW_RESTORE51`，控制文件恢复用步骤 `S9_RAW_CONTROL51`。恢复后服务仍保持停止，再次启动另行批准。

恢复失败时保留暂存目录、原数据和日志。不得手工复制数据库或 WAL 文件、删除迁移记录或直接用 SQL 降级。原 control 文件、恢复点、新旧正式安装、操作目录、验收目录、证据根（`/var/lib/himawari/__PKT_LABEL__-__PKT_DATE_COMPACT__-evidence`）和授权目录都不属于临时清理目标。

`scripts/delivery-mode/deploy.sh` 的各步（其中 `S6_ACCEPTANCE`、`S6_READ`、`S7_SWITCH_START`、`S8_READBACK` 的报告是清理脚本要核对的）全部通过后，root 才可按 [S9-clean-transport.py](S9-clean-transport.py) 和[清理说明](S9-clean-transport.md)的固定目标清理本次运输目录里的输入和验证副本。脚本先检查所有报告和归档已留存、目录身份与 S1 创建时相同、没有进程在使用、没有文档把这些路径当作永久证据引用；有未知或未通过就保留现场。正式启动和维护恢复只用永久的操作目录、验收目录和证据根，不需要运输目录；Mac 上的冻结包和用户备用包装保留。
