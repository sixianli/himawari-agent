# PR 546 第 1 轮作者说明

问题：上线包出包被拒（`MIGRATION_FAILS 20261114151105_web_push_gate.sql: no such table: decision_ledger_kinds`）。`scripts/migration-conflicts/analyze.mjs` 的 `checkAgainstApplied`（只在 `make-packet.py` 出包时带 `--applied` 调用）把所有待上线的时间戳迁移当成互相独立的新迁移，每个只在生产已应用迁移（0001–0078）上单独测；但这 31 个迁移已经按 id 顺序合进 main，后面的依赖前面建的表，单独测必然失败。

目标：出包检查对已经按顺序合进 main 的待上线迁移，按 id 顺序累积测（每个在“已有迁移 + 它前面的待上线迁移”上测），同时保留原有的检查强度：坏迁移仍被拒，未声明的改动和未声明的删除仍被拒，“生产顺序等于全新库”和完整性、外键检查仍在。

改动：`analyzeMigrations` 新增 `sequential` 选项（默认 false，PR 上不带 `--applied` 的检查不变，仍要求每个新迁移独立）：sequential 时每步基线是 `base + 前面的 added`，差异用该步前的快照算，跳过成对的“互相独立/顺序无关”检查（顺序已固定）。`checkAgainstApplied` 调用时打开它。测试 `test/tooling/migration-conflicts.test.mjs` 新增两条用例。

约束：只改出包检查脚本和它的测试，不碰 `deploy.sh`、迁移文件、产品代码、发给模型的任何内容（不会改变模型已经见过的请求开头）。

已核对的事实：用 0001–0078 的文件算出 78 条已应用记录，`node scripts/check-migration-conflicts.mjs --commit HEAD --applied …`：改前 `MIGRATION_FAILS …device_actions.sql: no such table: decision_ledger_kinds`，改后通过（migrations=109）；新用例撤掉修复后失败。

请特别看：sequential 下 `touched`/`written` 两个表是否还被用到且语义正确；跳过成对检查后有没有放过本来该拦的问题（这些迁移已按 id 顺序合进 main，生产顺序和全新库的对比由 `compareOrders` 和函数末尾的 production 对 fresh 检查保留）。
