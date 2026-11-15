# PR 560 复核材料

问题：第二十九次上线在 S3_COPY51 以 MAINTENANCE_LEDGER_DIGEST_MISMATCH 停下并回滚。scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs 的 readMaintenanceState 用旧版本（oldPrefix）自带的 loadBundledMigrations 读迁移定义，按 migration.id 建 Map；旧版本的定义没有 id 字段（在生产上实测：字段只有 sequence,name,changeSet,phase,file,sql,digest），按 "0001" 之类的编号一条都取不到。生产账本 78 条与新版本迁移逐条一致。

做法：新增导出 bundledMigrationId(migration) = migration.id ?? 序号补零四位，readMaintenanceState 建表时用它；口径与同一函数里 ledgerIds 的回退（ledgerIds[index].id ?? 序号补零）以及 s0-db/read-s0-db.mjs:79 一致。verify-fixtures.mjs 加三条断言。事故清单 docs/incidents-and-gates.md 加 I-105。

约束：只改这个取号；不放宽 name/phase/digest 的逐条比对；不改 deploy.sh。请特别查：maintenance 目录、s0-db、install、systemd 等模板里还有没有其他地方在 oldPrefix 或 newPrefix 下读 migration.id 会取不到；timestamp 迁移（14 位编号）在新版本下的 id 与账本 migration_id 是否一致；补零后可能与 14 位编号冲突吗。
