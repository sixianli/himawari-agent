# PR 563 复核材料

问题：PR 558 的迁移 packages/persistence-sqlite/src/migrations/20261115045512_thread_origin.sql 给 threads 加 origin 列（默认 owner）并回填想一想线程为 think。出包脚本 make-packet.py 的 migration_ledger 对改“历史保留表”的迁移报 PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES；部署时 maintenance-common.mjs 的 verifyHistoryUnchanged（比 historyDigests）和 compareHistoryRows（逐行比，要求列名相同）也会因为多出 origin 列判历史被改。Andy 要求这次一起上线，并说过线上数据不重要，保护历史数据的闸门可以放行。

做法：一次性放行。make-packet.py 新增 ADDED_COLUMN_BACKFILLS（按 sql.strip() 的 sha256 绑定这一个文件，只放 threads，且要求 read-s0-db.mjs 的 historyIgnoredColumns 登记了 origin）；read-s0-db.mjs 新增 historyIgnoredColumns = { threads: ["origin"] } 和 historyRow，historyDigests 与 compareHistoryRows 比对前去掉这一列。

约束：其余表、threads 的其余列照旧逐行比；不改 deploy.sh。请特别查：历史比对在部署的每个阶段（S0 冻结、S3 复制前后、S7 迁移前后、S8 对照恢复点）前后两边是否都经过 historyRow；compareHistoryRows 里把 iterate 包进生成器后提前退出时底层迭代器是否会被关掉；回填 UPDATE 会不会被其他检查（例如 migrationComparedSections 的其他部分、行数）拦下；还有没有别的地方逐行读 threads 做比较。
