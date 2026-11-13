<a id="database-migrations"></a>
# 数据库迁移怎么写

改产品库的表结构之前先读这份。决定和理由见 [ADR 0265](../../docs/adr/0265-migrations-get-unique-ids-and-merge-in-any-order.md)。

<a id="rules"></a>
## 规则

- 新迁移一律用 `npm run migration:new -- <蛇形名字>` 生成，文件在 `packages/persistence-sqlite/src/migrations/`，名字是 14 位 UTC 时间戳加名字。不要手写编号，不要向 `bundledMigrationFiles` 加条目，也不要改 `SUPPORTED_SCHEMA_MAX` 或写死迁移数量的测试；0001 到 0095 已冻结。
- 新迁移只加不改：建新表、新索引、新触发器、往参照表插行。要改已有的表，在同名的 `<时间戳>_<名字>.meta.json` 里写 `{"alters":["表名"]}` 声明，同时进行的两个 PR 不能声明同一张表。
- 不要用 `CHECK (列 IN (...))` 枚举会增长的取值。用参照表加触发器，加一个取值就是往参照表插一行，不用重建表。
- 迁移里不得出现 `ATTACH`、`VACUUM`、`load_extension`、`writable_schema`（字符串里的字不算）。
- 已有的迁移文件不许改内容、改名或删除；要改就写一个新迁移。
- 提交前运行 `npm run check:migration-conflicts`；它也是 `npm run check` 的一步。
