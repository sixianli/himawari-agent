# 复核材料：迁移编号改用时间戳，按集合判断哪些要跑

## 这个 PR 做了什么

产品库（SQLite）的迁移以前是 0001–0095 的连续整数，引擎只跑“库里最大号之后”的迁移。现在：0001–0095 冻结在 `bundledMigrationFiles`；新迁移是 `packages/persistence-sqlite/src/migrations/<14位UTC时间戳>_<名字>.sql`，引擎扫描目录；账本 `schema_migration_ledger` 加 `migration_id` 列（老记录为 NULL，编号按 4 位补零推出）；`sequence` 变成“第几个被应用”；待跑迁移 = 已知编号集合 − 库里已应用编号集合（晚合并的较小编号也会被跑）；集合指纹（编号加摘要）每次从账本现算，不另存；写库前除了数量，还核对指纹。

另外：`scripts/check-migration-conflicts.mjs`（合并前冲突检查，影子库里逐个应用新迁移）、`scripts/new-migration.mjs`（生成器）、打包脚本 `scripts/delivery-mode/make-packet.py` 按集合差规划迁移并在目标提交上完整重放、S0 读库脚本输出 `migrationIds`、审计脚本 `scripts/operations/workspace-lifecycle-audit.mjs` 和 `scripts/check-audit-schema-range.mjs` 不再写死最大迁移号、管理命令用 `bundledSchemaFingerprint()`。决定和理由见 `docs/adr/0265-migrations-get-unique-ids-and-merge-in-any-order.md`。

## 约束

- 生产库只有一个，不能丢数据；上线前必须有同机快照；老程序遇到更新的库必须拒绝写入（回滚保护）；不能削弱这些检查。
- 已有的 0001–0095 和生产库要平滑过渡：库里没有 `migration_id` 列时先加列，老记录不改。
- 不写代码注释；不为假想需求加兼容层。

## 已核对的事实

- 引擎入口：`applyMigrations`、`validateDefinitions`、`validateLedger`、`assertWritableSchema`、`readSchemaIdentity`、`loadBundledMigrations` 都在 `packages/persistence-sqlite/src/migration-engine.ts`。
- 测试：`packages/persistence-sqlite/test/migration-ids.contract.test.ts`、`test/tooling/migration-conflicts.test.mjs`、`test/tooling/audit-schema-range.test.mjs`、`scripts/delivery-mode/test_make_packet.py` 已通过。
