# 问题：数据库迁移编号排队，成了全项目的开发瓶颈

请从问题本身出发，自己读代码、上网查业界做法，提出你认为最好的完整方案。不要局限于任何现成思路；下面只讲问题、目标、约束和已核对的事实，不含任何倾向。

## 问题

Himawari 用 SQLite（单机文件数据库），产品库的结构变化靠按序号排列的迁移文件。几十个线程（并行的开发代理）同时开发，凡是改表的 PR 都要由协调者分配“正式迁移号”；前一个合进 main 之后，下一个才能改号、重跑 CI、再合并。现在排队的有 10 个以上 PR。所有者要求根治，不要表面修补。

## 目标

1. 各 PR 不再需要别人分配编号，可以并行合并（任意先后）。
2. 两个迁移真正冲突时（例如都改同一张表），能在合并前自动发现，而不是靠人排队。
3. 已有的 0001–0095 和唯一一台生产库能平滑过渡，不丢数据，上线和回滚的安全检查不削弱。

## 约束

- 只有一个生产库（一台机器），上线一律从 main 打包；另有一台测试服务器可能跑分支版本。
- 原则优先级：用户主权 > 边界与可逆性 > 记忆（数据）可靠性 > 效率。不能为了快牺牲数据安全。
- 不写死能动态得到的值；不加代码注释；方案要写清业界怎么做、我们为什么这样做、放弃了什么。
- 不花钱买服务（例如不能依赖 GitHub 付费功能）。

## 已核对的事实（文件:行）

- `packages/persistence-sqlite/src/migration-engine.ts:79` 起是手写数组 `bundledMigrationFiles`，每条有 sequence、name、changeSet、phase、file；每个新迁移都要在数组末尾加一条。
- 同文件 `validateDefinitions`（约 764 行）要求 sequence 从 1 连续；`validateLedger`（约 852 行）要求库里的记录也从 1 连续且与定义按下标逐条对上（名字、阶段、摘要）。
- `applyMigrations`（约 1000 行）：只跑 `migrations.slice(currentSequence)`，即“库里最大号之后”的；已有库迁移前必须有同机快照。
- 记录表 `schema_migration_ledger(sequence INTEGER PRIMARY KEY, name, phase, digest, applied_at)`，另有 `schema_metadata` 的 `current_sequence`、`minimum_writer_sequence`；`assertWritableSchema` 用整数比较，老程序遇到新库拒绝写入（回滚保护）。
- 整数版本号还被这些地方使用：`scripts/delivery-mode/make-packet.py:119`（`target_schema` 要求文件号连续）、`:155`（`migration_ledger` 用正则解析 migration-engine.ts 的数组，并检查迁移有没有碰“受保护的表”）；`scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs:79`、`maintenance/S9-control-files.py:236`（要求 ledger 是 1..N）；`packages/persistence-sqlite/src/sqlite-recovery-point.ts:961`、`sqlite-authority-transfer.ts`（备份清单里的 schemaSequence 必须等于当前程序的）；`packages/persistence-sqlite/src/sqlite-worker.ts:144`；`scripts/operations/workspace-lifecycle-audit.mjs:5` 的 `SUPPORTED_SCHEMA_MAX = 95`，由 `scripts/check-audit-schema-range.mjs` 要求等于最新迁移号（事故 I-46）；若干测试写死 95。
- 正在排队的分支里，迁移文件互相碰撞：例如 0094_paired_devices、0095_perception_records、0096_web_push_gate、0096_mcp_connections、0097_device_actions、0095_owner_proposals、0095_apple_push 等（分支名 origin/claude/project-thread-*）。
- 实测哪些表被重建：`decision_ledger` 的 `kind` 列用 `CHECK (kind IN (...))` 枚举（见 `migrations/0095_correction_propagation.sql:23`）。SQLite 不能修改 CHECK，加一个新种类就要按 SQLite 官方“12 步”重建整张表，连带重建引用它的子表（一个迁移 600 多行）。已合并的迁移里 decision_ledger 被重建过 9 次；排队的 10 个迁移里有 4 个又在重建它（web_push_gate、perception_records、proactive_source_registry、device_actions）。

## 一手资料（可自己再查）

- Rails 迁移指南 https://guides.rubyonrails.org/active_record_migrations.html
- Django 迁移 https://docs.djangoproject.com/en/5.2/topics/migrations/
- GitLab 迁移规范 https://docs.gitlab.com/development/migration_style_guide/
- Flyway outOfOrder https://documentation.red-gate.com/fd/out-of-order-224919730.html
- Atlas 执行顺序 https://atlasgo.io/versioned/apply ，目录完整性 https://atlasgo.io/concepts/migration-directory-integrity
- goose 乱序迁移 https://pressly.github.io/goose/blog/2021/out-of-order-migrations
- SQLite ALTER TABLE https://www.sqlite.org/lang_altertable.html

## 要你给出

根因（不止一个的话都列）、完整方案（编号方式、库里怎么记录、怎么判断哪些要跑、回滚保护怎么保持、冲突怎么在合并前自动发现、上线打包脚本和备份怎么改、0001–0095 和生产库怎么过渡、排队中的 PR 怎么迁过来）、放弃了哪些做法和原因、风险。
