## 结论摘要

方案的根因判断（编号写死、只认前缀、共用行、CHECK 枚举逼出整表重建）基本成立；但“合并前自动拦下真冲突”这个核心卖点在**把 main 并进分支之后就不成立**，而且打包、审计、维护脚本中大量按“四位编号/连续下标/单一整数”写死的消费者没有覆盖。下面按严重度列出。

> 说明：方案提到的 `.agents/reviews/topic-migration-ids/plan-brief.md` 在本环境读不到（提交里实际是 `plan-review-brief.md`，git 以 records-path 拒绝），所以只按 ADR 正文和代码核对；读不到的地方标“未核实”。

---

## 证实的

### 高

**1. 冲突检查的核心例子可以被“先把 main 并进来”绕过，空库也暴露不了数据依赖的失败**

- 问题：方案把“同时进行的迁移”定义为“origin/main 有、merge-base 没有”（ADR:158）。PR 一旦执行 `git merge main`，merge-base 就包含 main 上的 `0095_correction_propagation`，它不再算“同时进行”；第 3 步又在**空库**上按两种顺序跑（ADR:163-167），空库里没有 `memory_review` 行，`perception_records` 那张重建表不会违反新 CHECK，两种顺序的最终结构也可能相同，于是检查通过。生产库有 `memory_review` 行时才会失败。第 4 步“合并后的兜底”同样在空库上跑，也拦不住。
- 证据：
  - `docs/adr/0265-...md:158` 的“同时进行”定义、`:163-167` 的“在空库里按两种顺序各跑一遍”。
  - `packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:23-28`：`kind IN (... 'memory_review')`；同文件 `:1-17` 先 `CREATE TABLE ..._keep AS SELECT` 再 `DROP`/重建。
  - ADR:65 自己举的 `perception_records` 例子就是“重建的表里没有 `memory_review`，生产库里已有行会违反约束”。
- 建议：不要把“并进 main”当成冲突消失。至少改成“本 PR 的迁移 vs main 上所有碰同一张表的迁移”（或按迁移文件首次进入 git 的作者时间取 main 上更晚的迁移），并在**带代表性数据的 fixture** 上跑两种顺序：至少为每个现有 CHECK 的 `IN` 值、每个参照表主键插一行，再跑 `integrity_check`、`foreign_key_check` 和数据摘要。更好的做法见“如果由我来定”：新迁移只允许增量，禁止重建。

**2. 所有按四位编号扫描的脚本会静默忽略时间戳文件，出包/审计门槛假通过**

- 问题：`target_schema()` 只匹配 `^([0-9]{4})_...`，时间戳文件被过滤掉后 `numbers` 仍是 1..95，返回 95；`check-audit-schema-range.mjs` 同样只扫四位文件，最新号永远停在 95；`run-packet-checks.py` 和 S7 又都拿整数比较。结果可能是：代码里有新迁移，出包却认为 `target=95`、不跑迁移，生产启动时再因 `SCHEMA_NOT_CURRENT`/`WRITER_TOO_OLD` 失败；审计检查则永远通过。这正是 I-46 那类“写死迁移号”的翻版。
- 证据：
  - `scripts/delivery-mode/make-packet.py:119-124`（`re.fullmatch(r'([0-9]{4})_...')` + 返回 `numbers[-1]`）。
  - `scripts/check-audit-schema-range.mjs:11-20`（只匹配 `^(\d{4})_.+\.sql$`）。
  - `scripts/delivery-mode/run-packet-checks.py:53-58`（解析整数 `currentSchema`/`targetSchema`）。
  - `scripts/delivery-mode/packet-template/systemd/S7-switch-start-readback.py:239`（`schemaSequence`/`migrationCount` 与整数 `__PKT_TARGET_SCHEMA__` 比较）。
- 建议：所有扫描器必须**对未知文件名 fail closed**（既不是合法旧四位、也不是合法新时间戳就报错），target 从与运行时相同的合并清单计算；加一条测试：仓库里存在时间戳迁移时，出包 target 和审计门槛必须跟着变。

**3. `LATEST_MIGRATION_SEQUENCE` 仍从冻结数组取最后一项，新时间戳迁移不会更新它**

- 问题：方案一边说旧数组冻结在 0095，一边让新迁移只加文件；但 `LATEST_MIGRATION_SEQUENCE` 当前就是 `bundledMigrationFiles` 的最后一项（`migration-engine.ts:747-748`）。如果数组冻结而不改这个常量，第一笔时间戳迁移合并后它仍是 95，`assertWritableSchema(database, 95)`、数据导出、admin schema range 都会把已到 96 的库判成“程序太旧”或导出错误版本。
- 证据：`packages/persistence-sqlite/src/migration-engine.ts:747-748`；使用方 `apps/admin-cli/src/memory-command.ts:54`、`thread-command.ts:75`、`data-command.ts:228`、`apps/agent-service/src/production-data-export.ts:321`、`production-chat-export.ts:53`、`apps/admin-cli/src/index.ts:401`。
- 建议：把“旧数组 + 目录扫描”的合并结果作为唯一清单，`LATEST_MIGRATION_SEQUENCE` 从合并清单的**个数**计算；类型保持 `number`（见第 11 条），不要改成时间戳字符串。

**4. `sequence` 改成“第几个被跑”后，多处按 index 对齐的消费者会误拒合法库**

- 问题：晚合的小号迁移会以 `sequence = 当前个数+1` 落账，但它在定义数组里的下标可能不同。凡是拿 `ledger[index]` 对 `migrations[index]` 的代码都会错位。方案只笼统说“维护脚本按 migration_id”，没有列出这些具体点。
- 证据：
  - `packages/persistence-sqlite/src/migration-engine.ts:856-888`：`definition = migrations[index]`。
  - `scripts/delivery-mode/packet-template/maintenance/maintenance-common.mjs:927-931`：`ledger[index]` 逐列对 `migrations[index]`。
  - `scripts/delivery-mode/packet-template/maintenance/S9-control-files.py:232-236`：要求 `[row[0] for row in ledger] == list(range(1, schema + 1))`。
  - `scripts/delivery-mode/make-packet.py:155-171` 生成 `MIGRATION_LEDGER`；`maintenance-common.mjs:825-837` 用 `appliedSequences` 对 `migrationExpectedLedger.map(row => row.sequence)`。
- 建议：定义一个 `SchemaIdentity`（个数、按迁移 ID 排序的集合、指纹），所有读写方都用它；ledger 核对按 `migration_id`，packet 的期望 ledger 里 `sequence` 用“应用顺序”而不是定义下标。新增测试：先应用时间戳大的迁移，再补跑时间戳小的小号迁移，S7/S9/raw-copy 必须通过。

**5. 回滚说明与代码不符：旧程序不会以 `WRITER_TOO_OLD` 拒绝，服务本身也没有写入门**

- 问题：ADR 过渡第 3 条说“跑过新编号迁移后，老程序以 `WRITER_TOO_OLD` 拒绝写入”。但 `applyMigrations` 先 `validateLedger`，遇到程序不认识的已应用迁移会抛 `UNKNOWN_APPLIED_MIGRATION`（`:866-871`），到不了 `assertWritableSchema`。而 `assertWritableSchema` 只在 admin-cli 和迁移引擎内部被调用，服务启动路径没有调用它。回滚后如果跑 `db migrate`，看到的是 `UNKNOWN_APPLIED_MIGRATION`；如果不跑迁移，根本没有写入门。
- 证据：`packages/persistence-sqlite/src/migration-engine.ts:852-889`、`:1013-1035`；调用方只有 `apps/admin-cli/src/memory-command.ts:54`、`thread-command.ts:75`、`data-command.ts:228` 和引擎内部的 `:988`、`:1009`；`apps/admin-cli/src/index.ts:335-352` 的 `db.migrate`。
- 建议：改正 runbook/ADR，明确回滚时 `db migrate` 的预期错误码；如果要求“拒绝写入”而不是“拒绝启动”，给服务启动加一个只读的身份检查（按 `minimum_writer_sequence`/指纹），并用旧二进制测试覆盖。

**6. 快照验证在 ledger 升级/回填之后；失败或崩溃会留下已修改的库**

- 问题：`applyMigrations` 当前先 `ensureInternalSchema` 再 `verifySnapshot`（`:980-991`）。现在 `ensureInternalSchema` 只是 `CREATE TABLE IF NOT EXISTS`，基本是空操作；方案要在这里 `ALTER TABLE` 加列并回填旧行，这就变成了“先写库、后验证快照”。快照验证失败时，生产库已经不是原样；回填中途崩溃也可能留下半升级状态。
- 证据：`packages/persistence-sqlite/src/migration-engine.ts:980-991`；`apps/admin-cli/src/index.ts:340-352` 只在 `current < migrations.length` 时建快照（按个数，不按集合差）。
- 建议：先验证同机快照，再在一个 `IMMEDIATE` 事务里完成 `ALTER`/回填/写指纹；快照条件改用同一个“已知集合 − 已应用集合”的判断；加测试：快照不匹配时源库文件字节不变。

### 中

**7. `assertWritableSchema(database, writerSequence: number)` 无法识别“个数相同、集合不同”**

- 问题：方案说“工作进程、备份恢复、权限转移同时比指纹”，但这个 API 只收一个数字；调用方传的是 `LATEST_MIGRATION_SEQUENCE`。测试服务器跑分支版本时，个数相同、集合不同仍会被放行（或按 `SCHEMA_NOT_CURRENT` 误判）。
- 证据：`packages/persistence-sqlite/src/migration-engine.ts:1013-1035`；`apps/admin-cli/src/{memory,thread,data}-command.ts` 的调用。
- 建议：改成接收期望的 `SchemaIdentity`（或至少 `{ count, fingerprint, ids }`），由引擎导出的合并清单提供；所有调用方和测试一起改。

**8. 审计脚本内部仍写死 `version >= N`，而“应用顺序 count”在晚合补跑时不能当特性版本用**

- 问题：方案只改 `SUPPORTED_SCHEMA_MAX`（上限），但 `workspace-lifecycle-audit.mjs` 里大量 `version >= 33/40/41/43...` 用来决定列是否存在。晚合的小号迁移在**新库**上可能排在第 96 个应用，在**生产库**上排在第 97 个应用；同一个列对应的 count 不同，一个阈值无法同时正确。开发者写这个阈值时也无法预知最终 count。结果还是 I-46 那类“读到不存在的列”。
- 证据：`scripts/operations/workspace-lifecycle-audit.mjs:29-38`、`:44-59` 等。
- 建议：审计脚本改为**直接内省 schema**（`pragma_table_info`/`sqlite_schema`）判断列、索引、触发器是否存在，不再用版本号做特性开关；“登记已看过”只用于审计读的表/列清单。

**9. `decision_ledger.kind` 改成参照表 + 外键，会降低默认连接下的约束强度**

- 问题：方案说“数据库照样拒绝不认识的种类和结果，可靠性不降”。但 SQLite 外键默认关闭，必须每个连接手动 `PRAGMA foreign_keys=ON`。应用主路径开了（`migration-engine.ts:1063`），但 Python 维护脚本、离线修复、第三方工具不一定会开；原来的 CHECK 是无条件生效的。
- 证据：SQLite 官方原文：“Foreign key constraints are disabled by default (for backwards compatibility), so must be enabled separately for each database connection.” https://www.sqlite.org/foreignkeys.html §2；`packages/persistence-sqlite/src/migration-engine.ts:1063`。
- 建议：参照表之外再加 `BEFORE INSERT/UPDATE` 触发器，找不到 kind/outcome 就 `RAISE(ABORT)`（触发器不依赖 `foreign_keys` 开关）；或者保留一个稳定超集的 CHECK。加测试：`PRAGMA foreign_keys=OFF` 时写入未知 kind 仍必须失败。另加一条测试比较迁移种子与代码里的 `DECISION_KINDS`/`DECISION_OUTCOMES`，避免两处漂移。

**10. 冲突分类漏掉 upsert、触发器副作用、`CREATE TABLE AS SELECT`、`ALTER TABLE RENAME` 等**

- 问题：方案把“只追加行”定义成 `INSERT … VALUES`，但 `INSERT ... ON CONFLICT DO UPDATE`、`INSERT OR REPLACE`、`REPLACE INTO` 都会改数据；触发器可以写别的表；`CREATE TABLE ... AS SELECT` 会复制数据；`ALTER TABLE ... RENAME` 是结构变更。现有迁移里这些写法大量存在，正则/关键字分类很容易漏报。
- 证据：`packages/persistence-sqlite/src/migrations/0089_consolidation_hold.sql:1-7`、`0095_correction_propagation.sql:1-17`、`0042_sandbox_resource_incidents.sql:3`、`0051_srt_task_environment_release.sql:17`、`0087_rule_book_memory_link.sql:301-399`、`0080_decision_signals.sql:33`、`0095:595`。
- 建议：不要靠 SQL 文本正则做语义判断。可以在 shadow DB 上动态检测：对比 `sqlite_schema` 前后差异得到结构变更；给每张表临时挂 `AFTER INSERT/UPDATE/DELETE` 触发器记录被写的表；或者干脆规定“新迁移只允许白名单语句（CREATE TABLE/ADD COLUMN/CREATE INDEX/INSERT 静态参照行）”，禁止重建、upsert、触发器写其他表。

**11. 打包/维护链的改动面被低估；`TARGET_SCHEMA` 变成集合会直接打穿一串脚本**

- 问题：方案第 5 条把 target 改成“编号集合”，但 `TARGET_SCHEMA` 现在是整数，贯穿 JSON 绑定、S7、run-packet-checks、raw-copy、fixtures、测试。`substitute()` 用 `str(parameters[key])`，Python 的 set/list 字符串不是合法 JSON；`int < str` 还会在 Python 3 里直接 `TypeError`。
- 证据：`scripts/delivery-mode/packet-template/inputs/bindings.draft.json:105`、`scripts/delivery-mode/packet-template/systemd/S7-switch-start-readback.py:239`、`scripts/delivery-mode/run-packet-checks.py:53-58`、`scripts/delivery-mode/packet-template/maintenance/raw-copy-recovery.mjs:34,253`、`scripts/delivery-mode/generated-packet-gate.py:29`、`scripts/delivery-mode/test_make_packet.py:490-524`。
- 建议：**保持 `TARGET_SCHEMA` 为整数个数**（待跑个数 = target 集合大小 − 生产集合大小，前提是生产集合 ⊆ target 集合），另外单独传 `TARGET_MIGRATION_IDS`/指纹。这样 S7、raw-copy、fixtures、run-packet-checks 基本不用改语义，只加集合校验。若坚持改成集合，必须逐项改完并加测试。

**12. `ALTER TABLE ADD COLUMN` 不能直接加 UNIQUE；必须用部分唯一索引**

- 问题：方案说加 `migration_id`（只对非空值唯一）。SQLite 的 `ALTER TABLE ADD COLUMN` 不允许带 PRIMARY KEY/UNIQUE 约束；直接写 `ADD COLUMN migration_id TEXT UNIQUE` 会失败。
- 证据：SQLite ALTER TABLE 限制 https://www.sqlite.org/lang_altertable.html （“The column may not have a PRIMARY KEY or UNIQUE constraint”）。
- 建议：`ALTER TABLE ... ADD COLUMN migration_id TEXT`，再 `CREATE UNIQUE INDEX ... ON schema_migration_ledger(migration_id) WHERE migration_id IS NOT NULL`；`out_of_order` 用 `INTEGER NOT NULL DEFAULT 0`。加一个从 95 行旧库升级的测试。

**13. 迁移生成器/`.meta.json` 的输入校验和安全没有写**

- 问题：`npm run migration:new -- <名字>` 直接拿命令行参数拼文件名；方案没写名字校验、拒绝路径分隔符/符号链接、`wx` 创建、`.meta.json` 的 `phase` 校验。冲突检查会在 CI/本机执行 PR 里的 SQL，也没写超时和禁止 `ATTACH`/`VACUUM INTO`/扩展加载。
- 证据：方案第 113 行只说“取当前 UTC 时间，不手打”；引擎只在加载时校验 `name`/`changeSet`/`phase`（`migration-engine.ts:777-787`），生成器本身没有。
- 建议：名字限制 `^[a-z][a-z0-9_]*$`；用 `wx` 创建；拒绝 `/`、`\`、`..`、绝对路径和已存在文件；`.meta.json` 只允许已知字段且 `phase ∈ MIGRATION_PHASES`；冲突检查加超时，迁移里出现 `ATTACH`/`VACUUM INTO`/`load_extension` 直接拒绝。

**14. 14 位秒级时间戳不保证唯一，“由脚本生成避免撞号”说法过强**

- 问题：两个分支在同一秒生成不同名字的迁移，编号相同、文件名不同；第一条合并后，第二条的 CI 才会报重复，需要换号。Rails/GitLab 也接受这种风险，但不应写成“只保证唯一”。
- 证据：方案第 112、211 行；Rails/GitLab 的做法见 ADR 的业界表（https://guides.rubyonrails.org/active_record_migrations.html 、https://docs.gitlab.com/development/migration_style_guide/）。
- 建议：用毫秒级时间戳或时间戳加短随机后缀/ULID；至少让 `migration:new` 同时检查 `origin/main` 和本地目录，并在文档里写明“撞号后换号”的操作步骤。

**15. 测试服务器跑分支版本的切换流程没有覆盖**

- 问题：Hermes 上跑过分支 A 的迁移后，切到 main 且 main 有另一笔迁移，DB 里有 A 的未知 migration_id，`validateLedger` 会抛 `UNKNOWN_APPLIED_MIGRATION`，服务起不来。这是安全失败，但方案只写了“用生产库副本验收一次”，没写日常分支切换怎么处理。
- 证据：`migration-engine.ts:866-871`；ADR 过渡第 5 条只写验收。
- 建议：明确“测试服务器的库是一次性的，切换分支前从生产副本重置”；提供只允许非生产环境使用的 reset/restore 命令，并加环境校验。

**16. 旧导出/备份没有指纹的兼容性、以及 fixtures 仍建 5 列 ledger**

- 问题：方案说旧备份/旧导出没有 `schemaFingerprint` 就按个数比，但需要确认 manifest 的 schema/认证允许可选新增字段，旧 manifest 仍能通过认证；另外 packet 里的 fixtures 仍用 5 列 ledger（没有 `migration_id`），维护脚本一旦 SELECT 新列就会失败。
- 证据：`packages/persistence-sqlite/src/sqlite-recovery-point.ts:125,662,961`、`sqlite-authority-transfer.ts:180,1146`；fixtures：`scripts/delivery-mode/packet-template/maintenance/verify-fixtures.mjs:142`、`verify-raw-copy-fixtures.mjs:37`、`verify-migrate-fixtures.mjs:49`、`verify-sidecar-tidy-fixtures.mjs:83`。
- 建议：manifest 新字段做成可选并参与认证；旧 manifest 读取路径照常；所有 fixtures 补列或改成迁移引擎建表；加旧备份恢复、旧导出导入的自动化测试。

**17. “合并前检查”有 TOCTOU，合并后的兜底是事后**

- 问题：本地/CI 检查基于当时的 `origin/main`，main 在检查后、合并前又前进时仍能合入；第 4 步是合并后 CI，main 可能先坏，部署若不等这项检查就会带病上线。方案也承认没有 merge queue（ADR:59）。
- 证据：ADR:168、:223；GitHub merge queue 文档 https://docs.github.com/en/enterprise-cloud@latest/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue。
- 建议：把这项检查作为**部署前置**（打包/上线前在目标 commit 上再跑一次），或在 main 上设必需检查并在检查通过前阻止部署；接受“main 短暂红”，但不要接受“坏版本上线”。

**18. 新检查没有自动化反向用例，现有契约测试写死 95**

- 问题：方案只描述了检查逻辑，没有像 I-46/I-61 的修复那样给出“去掉检查就失败”的测试；`migration-engine.contract.test.ts` 直接写死 `CURRENT_SCHEMA_SEQUENCE = 95`，大量 `migrations.slice(0, N)` 也依赖连续编号，改造后需要重写。I-73 的教训正是“只看改动本身，没核对两端”。
- 证据：`packages/persistence-sqlite/test/migration-engine.contract.test.ts:21`、`:55-58`、`:112-121` 等；ADR 过渡第 5 条仍是手工验收。
- 建议：至少加这些反向用例，并确认在未修复代码上失败：
  - 已知冲突（`perception_records` 场景）必须失败；
  - 把 main 并进分支后同一场景仍必须失败；
  - 合法的晚合小号迁移必须通过；
  - 同一时间戳/重复编号必须失败；
  - 旧二进制 + 新 ledger 的预期错误码；
  - 个数相同、集合不同的写入必须被拒；
  - 旧备份/旧导出、packet、S0/S7/S9、raw-copy 的兼容性。

**19. `check:migration-conflicts` 要加进 `check:steps`，不是只写进 `npm run check`**

- 问题：`npm run check` 实际由 `scripts/run-all-checks.mjs` 读取 `package.json` 的 `check:steps` 逐条执行；只加 `check` 别名不会被执行。
- 证据：`scripts/run-all-checks.mjs:29-37`。
- 建议：在 `package.json` 的 `check:steps` 里加 `npm run check:migration-conflicts`，并更新 `test/tooling/run-all-checks.test.mjs`/`check:check-runner` 的期望。

---

## 推测（未完全核实）

- **“几秒钟”可能不成立**：95 个迁移在空库跑两遍、加 `integrity_check`/`foreign_key_check`、加 `git fetch origin main`，在 CI 里可能远不止几秒；建议实测并加超时。未核实。
- **如果第 3 步改成带数据 fixture，`randomblob`/`strftime('now')` 会让两次运行的摘要不同**：现有 `0080_decision_signals.sql:33` 用 `randomblob`，`0087_rule_book_memory_link.sql:380`、`0095_correction_propagation.sql:595` 用 `strftime(...,'now')`。空库现在可能碰不到，但一旦 seed 数据就会误报；需要规范化或排除易变列。未核实实际 seed 方案。
- **`schema_fingerprint` 的编码没有定义**：按 ID 排序后用什么分隔符、是否带 `sha256:` 前缀、是否包含 name/digest，必须在所有读写方统一。建议包含 name+digest，这样同一时间戳不同内容也能被发现；不要包含 `applied_at`/`out_of_order`。
- **manifest 新增字段是否破坏旧 manifest 认证**：`sqlite-recovery-point.ts`/`sqlite-authority-transfer.ts` 的 manifest schema 和认证逻辑我未逐行读完；实现时要确认旧 manifest 仍能通过。未核实。
- **`sqlite_schema` 原文比较会有假阳性**：`ALTER TABLE ... RENAME` 会改写 `sqlite_master.sql` 文本，两种顺序可能产生不同空白/引号；如果“规范化”不够彻底，会误报。未核实检查脚本实现。

---

## 侧重检查

- **错误路径/不可信输入**：查了迁移生成器的输入（方案未写校验）、引擎加载时的 `name`/`changeSet`/`phase` 校验（`migration-engine.ts:777-787`）、`.meta.json`（方案未写）、冲突检查执行 PR SQL 的边界（未写超时/禁止 `ATTACH`）。结论：需要补输入校验和超时，见第 13 条。
- **安全**：查了 SQLite 外键默认关闭（官方文档已核实，见第 9 条）、参照表替代 CHECK 的影响、`ALTER TABLE ADD COLUMN UNIQUE` 限制（见第 12 条）、迁移 SQL 在 CI/本机执行的风险。结论：参照表要配触发器；生成器要防路径穿越；检查要限制危险语句。
- **资源耗尽**：查了 `npm run check` 的执行方式（`run-all-checks.mjs`）和 95 个迁移双跑的成本。结论：“几秒”未证实，建议超时和实测。
- **不可撤销操作/数据丢失**：查了 `DROP TABLE`/整表重建（`0095`、`0089` 等）、快照顺序（`migration-engine.ts:980-991`）、回滚（`UNKNOWN_APPLIED_MIGRATION` vs `WRITER_TOO_OLD`）、备份/导出导入兼容性。结论：快照必须先于 ledger 写入；新迁移最好禁止重建；回滚文档要改。
- **规则/文档/代码一致**：查了 ADR 与代码的四处不一致：回滚错误码（第 5 条）、时间戳“唯一”（第 14 条）、“空库双序保证”（第 1 条）、`assertWritableSchema` 只收数字（第 7 条）；以及 `make-packet`/`check-audit-schema-range`/`run-packet-checks`/S7 的整数假设（第 2、11 条）。结论：方案低估了打包/维护链的改动面。

---

## 如果由我来定

我会保留方案的根因分析，但把实现收敛成更小、更可证明的一套：

1. **编号**：仍用时间戳文件，但生成器用毫秒或随机后缀，避免同秒撞号；文件名/`.meta.json` 严格校验。
2. **身份**：`sequence` 继续表示“第几个被跑”（1..N 连续），不改成迁移号；新增 `migration_id`（或直接用完整文件名）和 `schema_fingerprint`。所有读写方共用一个 `SchemaIdentity`：`{ count, sortedIds, fingerprint }`。
3. **写入/回滚**：`assertWritableSchema(database, expectedIdentity)` 比较集合+指纹，不只是个数；服务启动也加只读身份检查，回滚时明确错误码并测试。
4. **新迁移只允许增量**：对时间戳迁移做白名单 lint，禁止 `DROP TABLE`、`ALTER TABLE ... RENAME`、`CREATE TABLE ... AS SELECT`、`INSERT ... SELECT`、`INSERT ... ON CONFLICT DO UPDATE`、写其他表的触发器。旧 1..95 冻结、豁免。这样根本不需要证明任意迁移可交换；真正需要重建时走一次 Andy 批准的特殊流程。
5. **`decision_ledger.kind`**：参照表 + `BEFORE INSERT/UPDATE` 触发器（不只外键），种子用静态 SQL，加“种子 = `DECISION_KINDS`/`DECISION_OUTCOMES`”测试。
6. **冲突检查**：
   - 静态：只做文件名/编号/重复/白名单 lint；
   - 动态：在 shadow DB 上用 `sqlite_schema` 差异 + 每表 DML 触发器收集“碰了哪些表”，不靠 SQL 正则；
   - 数据：在**带代表性数据**的 fixture 上跑两种顺序，比较结构、`integrity_check`、`foreign_key_check` 和按主键排序的数据摘要；
   - 比较对象：本 PR 迁移 vs main 上所有碰同一张表的迁移（不再用 merge-base 排除，避免“并进 main 就通过”）。
7. **打包/审计**：`TARGET_SCHEMA` 保持整数 count，另传 ID 集合/指纹；所有扫描器对未知文件名 fail closed；审计脚本改用 schema 内省，不用版本号阈值；`check:migration-conflicts` 加进 `check:steps`。
8. **测试**：把第 18 条列的反向用例全部落成自动化测试，并确认去掉修复会失败。

---

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

不会。这个改动只涉及 SQLite migration engine、打包/维护脚本和数据库元数据，不参与 prompt 组装；`LATEST_MIGRATION_SEQUENCE`/`migrationSequence`/`schemaSequence` 的使用方是导出、admin-cli、打包和维护脚本，`packages/prompt-catalog` 和 Pi 运行时适配器没有读这些值（全仓搜索未发现）。所以系统提示、工具定义、历史消息、遮盖结果都不变，发给模型的内容仍然只在末尾追加；每轮会变的值也没有被塞进请求开头。依据：`.claude/rules/prompt-prefix.md:35`（已发内容只能追加）、`:41`（系统提示和工具按对话冻结）。要注意的是：**以后不要把 `schema_fingerprint`、`migration_id`、`out_of_order` 这类值写进系统提示或工具定义**；如果确实要告诉模型，只能放在最后一条用户消息里。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**

对模型请求不会：迁移编号/指纹不进请求。对迁移系统本身，要保证**确定性**：`schema_fingerprint` 必须按排序后的 ID、固定编码、固定分隔符计算，不能包含 `applied_at`/`out_of_order`/目录遍历顺序；冲突检查比较 `sqlite_schema` 和数据时要规范化，且不要把 `randomblob`/`strftime('now')` 产生的值算进摘要。方案说“按编号排序后算 SHA-256”方向对，但编码细节没写，见“推测”第 3 条。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

目前不够。方案新增了 `check:migration-conflicts`，但没有给出“已知冲突必须失败”的反向用例，也没有覆盖 `applyMigrations` 的晚合补跑、旧二进制回滚、同个数不同集合、指纹/备份/导出、packet/S0/S7/S9、raw-copy 的测试；现有 `migration-engine.contract.test.ts:21` 还写死 95。按 I-46/I-61 的做法，必须至少有一条“在未修复代码上失败、修复后通过”的测试，并把检查加进 `check:steps`（`scripts/run-all-checks.mjs:32`）。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

不能，至少这些地方不能直接接受或需要改：

- `migration_id` 新列：`readMigrationLedger` 目前不 SELECT 它（`migration-engine.ts:842-850`）；packet 的 `MIGRATION_LEDGER`（`make-packet.py:155-171`）、S9（`S9-control-files.py:232-236`）、maintenance-common（`maintenance-common.mjs:927-931`）、raw-copy（`raw-copy-recovery.mjs:151-156`）、fixtures（`verify-fixtures.mjs:142` 等）都要改。
- `sequence` 语义：`maintenance-common.mjs:927-931` 和 `S9-control-files.py:236` 按 index 对定义，晚合补跑后会错；`maintenance-common.mjs:825-837` 的 `appliedSequences` 对期望 sequence 也会错。
- `schema_fingerprint`：`sqlite-recovery-point.ts:363-368,961` 和 `sqlite-authority-transfer.ts:395` 现在只比 `MAX(sequence)`；manifest schema/认证要允许可选字段，旧 manifest 要能读。
- `LATEST_MIGRATION_SEQUENCE`：仍从冻结数组取最后一项（`migration-engine.ts:747-748`），新迁移不会更新它；所有 `assertWritableSchema`/导出/admin 调用方都会停在 95。
- `TARGET_SCHEMA`：`S7-switch-start-readback.py:239`、`run-packet-checks.py:53-58`、`bindings.draft.json:105`、`raw-copy-recovery.mjs:34,253`、`generated-packet-gate.py:29`、`test_make_packet.py` 都按整数；改成集合会破，建议保持整数 count。
- `SUPPORTED_SCHEMA_MAX`：`workspace-lifecycle-audit.mjs:5` 和 `check-audit-schema-range.mjs:11-20`、`run-packet-checks.py:64-73` 三处互相依赖；时间戳文件会被后两者静默忽略。
- `out_of_order`/`migration_id` 的唯一索引：`ALTER TABLE ADD COLUMN` 不能直接加 UNIQUE，需部分唯一索引（第 12 条）。
- `assertWritableSchema`：只收数字，不能比集合/指纹（第 7 条）。

因此，方案第 4 条列出的“其他读整数版本的地方”还远远不够；打包、维护、审计、fixtures 和 `LATEST_MIGRATION_SEQUENCE` 必须一起纳入同一份变更和同一组测试。
