---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0018-sqlite-product-state-authority.md"
date: "2026-11-14"
covers: ".claude/rules/incident-gates.md, .claude/rules/owner-standing-rules.md, packages/persistence-sqlite/src/migration-engine.ts, packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql, packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts, packages/persistence-sqlite/src/sqlite-recovery-point.ts, scripts/check-audit-schema-range.mjs, scripts/delivery-mode/make-packet.py, scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs, scripts/operations/workspace-lifecycle-audit.mjs, scripts/run-all-checks.mjs"
verified_at: "7c8521fe5f55e7dd57c5bd52badd16eef647502e"
---

# ADR 0265：数据库迁移改用不撞号的编号，任意先后合并，真冲突在合并前自动拦下

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [根因](#root-causes)
- [业界怎么做](#industry)
- [决定](#decision)
- [冲突怎样自动发现](#conflicts)
- [过渡：0001–0095 和生产库](#transition)
- [排队中的 PR 怎么迁过来](#queued-prs)
- [放弃的做法](#options)
- [后果和风险](#consequences)
- [要 Andy 拍板的](#owner-decisions)

<a id="context"></a>

## 背景

迁移（migration）是一段改数据库结构的 SQL，例如建一张新表、给表加一列。Himawari 的产品库是一个 SQLite 文件（单机文件数据库），每个迁移是 `packages/persistence-sqlite/src/migrations/` 下的一个文件，文件名开头是四位连续编号，例如 `0095_correction_propagation.sql`。

几十个线程并行开发，凡是改表的 PR 都会在自己的分支上取“下一个号”。两个 PR 同时取到 0096，必然撞号；所以现在由协调者给每个 PR 分配“正式号”，前一个合进 main 之后，下一个才能改号、重跑 CI（持续集成，每次推送后自动跑的检查）、再合并。协调者 2026-11-14 报的排队名单有 PR 414、404、436、444、443、449、479、451、455、454、486 等十几个（来自协调者的转述，不是仓库里的文件），每个都要等前一个合完，成了全项目的开发瓶颈。Andy 要求根治。

改迁移机制本身不改任何业务表，但它决定生产库每次上线跑哪些 SQL，属于“数据存储结构”这一类大改动（[Andy 定的长期规则](../../.claude/rules/owner-standing-rules.md#fixing-bugs-and-new-features)），所以本 ADR 只是方案，Andy 同意后才动代码。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 新迁移要在手写数组末尾加一条：`packages/persistence-sqlite/src/migration-engine.ts:79` 原文 `const bundledMigrationFiles = [`，每条写 `sequence`、`name`、`changeSet`、`phase`、`file`。
2. 定义必须从 1 连续：同文件第 769 行 `const expectedSequence = index + 1;`，不等就报 `DEFINITION_GAP`。
3. 库里的记录也必须从 1 连续，并按下标和定义逐条对上：同文件第 857 行 `const expectedSequence = index + 1;`，之后 `const definition = migrations[index];`。
4. 只跑“库里最大号之后”的迁移：同文件第 985 行 `const pending = migrations.slice(currentSequence);`。
5. 已有库迁移前必须有同机快照：同文件第 991 行 `if (currentSequence > 0) verifySnapshot(database, options.snapshot, currentSequence);`。
6. 记录表的主键是整数编号：同文件第 828 行 `sequence INTEGER PRIMARY KEY CHECK (sequence >= 1),`；每跑一个迁移还写 `schema_metadata` 的 `current_sequence` 和 `minimum_writer_sequence`（第 906 行 `statement.run("minimum_writer_sequence", String(sequence), updatedAt);`），`assertWritableSchema`（第 1013 行）用它们挡住“比库旧的程序”写库，这是回滚保护。
7. 上线打包脚本按整数取目标版本并要求连续：`scripts/delivery-mode/make-packet.py:122` 原文 `if not numbers or numbers != list(range(1, len(numbers) + 1)):`；第 159 行用正则解析 `migration-engine.ts` 的数组；第 167 行检查每个待跑迁移有没有碰“受保护的表”。
8. 生产机上的读库脚本要求记录是 1..N：`scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs:79` 原文 `assert(ledger.length === current && ledger.every((row, index) => row.sequence === index + 1), "__PKT_LABEL_UPPER___DB_LEDGER_INVALID");`。
9. 备份恢复按整数比版本：`packages/persistence-sqlite/src/sqlite-recovery-point.ts:961` 原文 `if (manifest.schemaSequence !== expectedSchemaSequence) {`。
10. 审计脚本写死支持的最高版本，并有检查要求它等于最新迁移号：`scripts/operations/workspace-lifecycle-audit.mjs:5` 原文 `export const SUPPORTED_SCHEMA_MAX = 95;`；`scripts/check-audit-schema-range.mjs` 不等就报 `AUDIT_SCHEMA_RANGE_STALE`（事故 I-46，`docs/incidents-and-gates.md:84`）。
11. 写死迁移号已经出过两次事故：I-46 和 I-61（`docs/incidents-and-gates.md:98`，“和 I-46 是同一类错误（写死迁移号范围）的另一处”）；`docs/lessons.md:667` 记了写死迁移编号的测试漏跑、main 上 16 个用例一直失败。
12. 合并前本地基本检查必过：`.agents/instructions/delivery-mode.md:27` 原文“合并进 `main` 之前，PR 最新提交上的 `ci/required` 必须是成功……上面的本地基本检查照样必过”。
13. `decision_ledger` 的 `kind` 列是写在 CHECK 里的枚举：`packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:23` 原文 `kind TEXT NOT NULL CHECK (`，下一行 `kind IN (`。
14. SQLite 不能直接改 CHECK，加约束要按官方的 12 步重建整张表：[SQLite ALTER TABLE](https://www.sqlite.org/lang_altertable.html) 原文 “The only schema altering commands directly supported by SQLite are the "rename table", "rename column", "add column", "drop column" commands”，以及 “the full 12-step procedure above is appropriate for … adding CHECK or FOREIGN KEY or NOT NULL constraints”。
15. 本仓库是个人账号下的私有仓库，用不了 GitHub 的合并队列（merge queue，GitHub 替你排队、逐个验证后再合并的功能）：[GitHub 文档](https://docs.github.com/en/enterprise-cloud@latest/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request-with-a-merge-queue) 写的是只在组织的公开仓库或 Enterprise Cloud 组织的私有仓库可用。

以下是本线程 2026-11-14 在仓库里实测的数（命令和输出见 PR 描述）：

- 已合并的 95 个迁移里，`decision_ledger` 被整表重建过 4 次（`0087_rule_book_memory_link.sql`、`0088_memory_capture_backlog.sql`、`0089_consolidation_hold.sql`、`0095_correction_propagation.sql` 各有一句 `DROP TABLE decision_ledger;`，用 `grep -c` 数出；连同引用它的子表 `decision_signals`、`decision_ledger_payloads`、`source_insights` 等一起重建，单个迁移 600 多行）。
- 以下三条是本线程用 `git show origin/claude/project-thread-*:<迁移文件>` 在远程分支上读到的，不在 main 的文件里，所以代码说法核对读不到，命令和输出见 PR 描述。排队分支里的迁移有 4 个又在重建 `decision_ledger`（`0096_web_push_gate`、`0095_perception_records`、`0097_proactive_source_registry`、`0097_device_actions`），都只是为了在 `kind` 里加一个值。
- 其中 `0095_perception_records` 是在 `memory_review` 种类合进 main（`0095_correction_propagation.sql`）之前写的，它重建的表里没有 `memory_review`。照现在的样子合进去，生产库里已有的 `memory_review` 行在搬数据时会违反新约束，上线时迁移失败。这就是下文说的“真冲突”，目前完全靠人发现。

[返回阅读导航](#contents)

<a id="root-causes"></a>

## 根因

不是“协调者分号慢”，而是机制本身逼着所有改表的 PR 排成一列。有四个原因，缺一个都根治不了：

1. **编号在写代码时就定死，而且必须全局连续**（前提 1、2）。并行开发的两个 PR 不知道对方存在，只能取同一个“下一个号”。
2. **引擎只认“前缀”**（前提 3、4）：库里的记录必须正好是定义的前 N 条，只跑第 N 条之后的。即使两个 PR 号不撞，晚合进来的小号也永远跑不了。所以连“先占号、后合并”都不行，必须按号的顺序合并。
3. **每加一个迁移都要改几处所有人共用的行**：数组末尾（前提 1）、`SUPPORTED_SCHEMA_MAX`（前提 10）、写死版本号的测试（前提 11）。两个 PR 改同一行，git 就报冲突，后合的必须变基、推送、再等一轮 CI。
4. **真冲突没有自动检查，而且数据设计制造了大量“假的真冲突”**：`decision_ledger.kind` 写成 CHECK 枚举（前提 13、14），每加一种决定就要整表重建，把本来无关的功能（网页推送、感知、设备动作）都变成“改同一张表”；两个重建同时写，后跑的会把先跑的改动整个盖掉（上面 `perception_records` 的例子）。现在唯一的防线是协调者排队。

只解决 1（例如换成时间戳编号）而不解决 2、3，仍要排队；只解决 1–3 而不解决 4，会把“排队”换成“偶尔上线失败或静默丢约束”，违反[记忆可靠性优先于效率](../product-vision.md)。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

| 做法 | 编号 | 记录哪些跑过 | 晚合的小号能不能跑 | 冲突怎么发现 | 来源 |
|---|---|---|---|---|---|
| Rails | 文件名前缀是 UTC 时间戳 `YYYYMMDDHHMMSS` | `schema_migrations` 表存跑过的版本集合 | 能：`db:migrate` “runs … all the migrations that have not yet been run” | `schema.rb` 合并冲突，“run bin/rails db:migrate to regenerate the schema file” | [Rails 指南](https://guides.rubyonrails.org/active_record_migrations.html) |
| GitLab | 同 Rails，14 位时间戳，“hand-typed versions often collide”所以用生成器 | 同 Rails；另外每个迁移在 `db/schema_migrations/` 下有一个单独文件，避免大家改同一个文件 | 能 | structure.sql 冲突 + CI 检查 | [GitLab 迁移规范](https://docs.gitlab.com/development/migration_style_guide/) |
| Django | 名字唯一即可，“the numbers are just there for developers' reference” | 按名字 | 每个迁移写明依赖谁，形成依赖图 | 同一个应用出现两个末端就要求人线性化或生成合并迁移 | [Django 迁移](https://docs.djangoproject.com/en/5.2/topics/migrations/) |
| Flyway | 版本号 | 历史表 | 默认不能；`outOfOrder=true` 时能 | 无自动语义检查 | [Flyway outOfOrder](https://documentation.red-gate.com/fd/out-of-order-224919730.html) |
| goose | 时间戳或序号 | 版本表 | 默认不能；`-allow-missing` 能。维护者原先推荐“开发用时间戳、合并后由 CI 改成序号”，后来因为社区反馈放宽 | 无 | [goose 博客](https://pressly.github.io/goose/blog/2021/out-of-order-migrations) |
| Atlas | 时间戳 | 版本表 | 默认 `linear` 不能；`non-linear` 能，但文档不建议用于生产 | 故意用 `atlas.sum` 制造 git 冲突，强迫线性；用 `atlas migrate rebase` 解决 | [Atlas apply](https://atlasgo.io/versioned/apply)、[目录完整性](https://atlasgo.io/concepts/migration-directory-integrity) |

共同点：**编号只负责“彼此不同”，不负责“排队”**；库里按“跑过哪些”记，而不是按“跑到第几号”记。分歧在于“晚合的小号”怎么办：Rails、GitLab 直接补跑；Atlas、Flyway 默认拒绝，是因为它们不知道两个迁移是否互不影响。我们的做法是：允许补跑，但由合并前的自动检查保证补跑的迁移和已上线的迁移互不影响、新迁移不悄悄去掉已有结构，这样既不排队，也不靠运气。

**两个对标问题的回答：**

1. 大公司遇到同样问题怎么做、用户看到什么：GitLab 上千人同时提交迁移，用时间戳 + 每迁移一个文件 + CI 检查，开发者从不需要别人分号；最终用户什么都看不到，上线照常。
2. 这是根因还是表面修补：根因。四个原因各有对应的改法（见下文），改完后只有真正改动同一处已有结构的 PR 需要先后处理，而且由检查自动指出，不再靠人排队。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

### 一、编号：UTC 时间戳加名字，由脚本生成

- 新迁移的文件名是 `<14 位 UTC 时间戳>_<名字>.sql`，例如 20261114013000_device_actions.sql。时间戳只负责“彼此不同”和大致先后，不代表“排第几”。
- 用 `npm run migration:new -- <名字>` 生成：取当前 UTC 时间；名字只许 `^[a-z][a-z0-9_]*$`；生成前对照本地目录和 `origin/main` 的迁移目录，同一秒已有就顺延一秒；以“文件不存在才创建”的方式写入。时间戳不能百分之百保证唯一（两个分支同一秒生成仍会相同），撞了的后果是后合的那个 PR 的检查报“编号重复”，换个号即可，不会进 main。
- 默认 `phase` 是 `expand`、`changeSet` 是名字换连字符（0052 以后的 44 个迁移全是这样）。现在没有需要别的阶段的迁移，所以 `.meta.json` 只认 `alters`（改了已有结构的表）和 `removes`（去掉的取值）两个字段；真需要别的阶段时再加。

### 二、每加一个迁移只新增文件，不改任何共用的行（对应根因 3）

- 引擎启动时扫描迁移目录，和冻结的旧清单合成一份清单，这是唯一的来源。0001 到冻结时 main 上最后一个四位号的数组原样冻结成“旧清单”，以后不再往里加；`LATEST_MIGRATION_SEQUENCE` 改成这份合成清单的个数（现在取数组最后一项，`migration-engine.ts:747`，冻结后就不会再变，必须改）。
- 所有扫描迁移目录的脚本（`make-packet.py`、`check-audit-schema-range.mjs` 等）遇到既不是旧四位格式、也不是新时间戳格式的文件一律报错，不许静默跳过。现在它们只认四位号，新文件会被悄悄忽略，打包会以为没有新迁移。
- 审计脚本 `workspace-lifecycle-audit.mjs` 不再按版本号判断：删掉 `SUPPORTED_SCHEMA_MAX` 和 `version >= 33` 这类按号开关，改成数老清单（`LEGACY_MIGRATION_COUNT`，现在是 95）和检查它读的 16 张表（`AUDIT_READ_TABLES`）都在；版本不低于 95 时表缺了就拒绝，低于 95 的老库保留原来的按版本号读法，因为它们读的表本来就可能还没建。新迁移碰了这些表，`check-audit-schema-range.mjs` 要求在 `AUDIT_REVIEWED_MIGRATIONS` 里登记审计脚本已复核（I-46 要防的就是“新迁移改了审计读的表”）。代价：这道复核只在仓库检查里，生产机上直接跑审计脚本时，遇到带编号的新迁移不再像以前那样因“版本太高”而拒绝；这是有意的取舍，因为再写死一个上界就要每个迁移改一次共用的行，那正是要去掉的。
- 写死版本号的测试改成从清单推算（`docs/lessons.md:667` 已建议的方向）。

### 三、库里按“跑过哪些”记，晚合的也能补跑（对应根因 1、2）

- 记录表 `schema_migration_ledger` 加 `migration_id TEXT` 列，另建 `migration_id IS NOT NULL` 的部分唯一索引（SQLite 的 `ADD COLUMN` 不能直接带 UNIQUE）。旧的行不改写，读的时候按 `sequence` 推出 `0001`…`0095`，已有历史保持原样。`sequence` 列保留，含义变成“第几个被跑的”（仍是 1..N 连续），所以只认 `sequence` 连续的生产机脚本（前提 8）不用改语义。
- 要跑的迁移 = 程序知道的 − 库里跑过的，按编号顺序跑；旧清单永远排在前面。库里有程序不认识的编号，照旧拒绝（`UNKNOWN_APPLIED_MIGRATION`）；每个跑过的迁移照旧核对名字、阶段和摘要（SHA-256，内容指纹）。“按下标对齐记录和定义”的地方改成按编号对齐：引擎的 `validateLedger` 和 `maintenance-common.mjs`。`S9-control-files.py` 和 `raw-copy-recovery.mjs` 只检查账本是 1 到 N 连续、前后一致，`sequence` 现在是应用顺序，晚合的小号也满足，所以不改。
- 一个迁移的编号比库里已跑的最大编号还小时（“晚合的小号”），照跑；账本的 `sequence` 记下它实际的应用顺序，目前不另写日志。它能安全补跑，靠的是下一节的合并前检查。
- 同机快照除了个数，也要带集合指纹（`schemaFingerprint`），和当前库的指纹对不上就按 `SNAPSHOT_INVALID` 拒绝。
- 记录表的升级（加列、加索引）放在同机快照核对**之后**，和第一个待跑迁移放在同一个 `IMMEDIATE` 事务里；没有待跑迁移时什么都不写。现在的 `applyMigrations` 先 `ensureInternalSchema` 后核快照（`migration-engine.ts:980-991`），那时它只是 `CREATE TABLE IF NOT EXISTS`，没有写；加了列以后必须先核快照。

### 四、版本身份改成“个数 + 集合 + 指纹”，回滚保护不变（对应根因 2 带来的连锁）

- 新增一个读取函数 `readSchemaIdentity`，返回 `{ 个数, 排好序的编号, 指纹 }`。指纹 = 对“每行 `<编号> <摘要>`，按编号排序、换行连接”算 SHA-256，不含跑的时间和先后。写库或接收外来库之前要核对集合的地方用它：引擎的 `assertWritableSchema`（多收一个期望指纹）、管理命令（`apps/admin-cli/src/` 的 data、memory、thread 命令）、恢复点（`expectedSchemaFingerprint`）、权限转移导入、沙箱预留管理的写命令。`sqlite-worker.ts` 仍只比整数，因为服务启动时 `applyMigrations` 已经核对过集合；数据导出和聊天导出清单只记整数，原因见“后果和风险”。
- `schema_metadata` 的 `current_sequence`、`minimum_writer_sequence` 继续写，值是个数，供只比整数的老代码用。指纹不另存一份：每次都从记录表里的编号和摘要现算（`readSchemaIdentity`），存下来的副本没人读，只会过期。
- 回滚保护：服务启动时会先跑 `applyMigrations`（`product-state-repository.ts:278`），老程序遇到库里有它不认识的迁移，在 `validateLedger` 报 `UNKNOWN_APPLIED_MIGRATION`、拒绝启动；这和今天回滚跨过一个迁移时完全一样，回滚靠的是上线前的快照。新程序在“个数相同、集合不同”（测试服务器跑过分支版本）时同样拒绝。
- 恢复点和权限转移的清单不加字段：恢复或导入时，把解出来的库里的指纹和当前程序的指纹比较，不一致就拒绝。清单里仍只有个数，旧清单照常能用。

### 五、上线打包脚本：整数照旧，另传集合（前提 7、8）

- `TARGET_SCHEMA` 继续是整数（目标个数），因为它贯穿 `S7-switch-start-readback.py:239`、`run-packet-checks.py:53-58`、`raw-copy-recovery.mjs`、`bindings.draft.json` 和测试，改成集合会把这一串全打穿。目标集合不另存一份：打包时直接读目标提交的迁移目录。
- 待跑清单 = 目标集合 − 生产库集合（S0 阶段读库时一并读出 `migration_id`），按编号排序；生产库有、提交里没有的，拒绝打包。`MIGRATION_LEDGER` 里每项仍是 `sequence`、`name`、`phase`，期望的 `sequence` 按“应用顺序”填；编号和摘要只用于打包时的规划和核对：S0 带上 `migrationIds` 和 `migrationDigests`，打包前核对已应用的迁移文件没被改过，并对待跑的迁移做完整的冲突分析。
- 受保护表检查照旧逐个迁移做。
- 打包时在目标提交上再跑一遍迁移冲突检查（下一节），不过就拒绝打包。这是“合并后、上线前”的硬门槛，弥补合并前检查和合并之间 main 又变了的空档。
- 生产机脚本的测试数据（`verify-fixtures.mjs`、`verify-raw-copy-fixtures.mjs`、`verify-migrate-fixtures.mjs`、`verify-sidecar-tidy-fixtures.mjs` 里手建的 5 列记录表）不改：它们代表还没有时间戳迁移的老库；6 列的新库由引擎的集成测试和打包的 Python 测试覆盖。

### 六、`decision_ledger.kind` 改成参照表（对应根因 4，单独 PR，要 Andy 同意改表）

- 新建 `decision_ledger_kinds(kind TEXT PRIMARY KEY)` 和 `decision_ledger_outcomes(kind, outcome)`（同一文件第 67 行起还有一条“哪种决定允许哪些结果”的大 CHECK，也随种类增长）。`decision_ledger.kind`、`(kind, outcome)` 分别引用它们；`(kind = 'proactive') = (outcome IS NULL)` 这类不会增长的约束保留。
- SQLite 的外键默认关闭、要每个连接自己打开（[SQLite 外键](https://www.sqlite.org/foreignkeys.html)：“Foreign key constraints are disabled by default … must be enabled separately for each database connection”）。为了在维护脚本这类不开外键的连接里也照样拦住，再加 `BEFORE INSERT`、`BEFORE UPDATE` 触发器：种类或结果不在参照表里就 `RAISE(ABORT)`。
- 这需要最后一次整表重建（和现在的做法相同，只做这一次）。种子数据取程序里已有的 `DECISION_KINDS`、`DECISION_OUTCOMES`（`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts`），并加测试核对参照表和这两个常量一致，防止两边漂移。
- 以后加一种决定只要两三行 `INSERT`，两个 PR 各加各的不冲突。
- 写进开发规则：会不断增加取值的字段不用 CHECK 枚举，用参照表；取值固定的小枚举（例如 `('useful', 'unneeded', 'missed')`）可以继续用 CHECK。

[返回阅读导航](#contents)

<a id="conflicts"></a>

## 冲突怎样自动发现

新增检查 `npm run check:migration-conflicts`，加进 `package.json` 的 `check:steps`（`npm run check` 只跑这里列出的步骤，`scripts/run-all-checks.mjs` 的 `stepNames`）、CI 和打包（见上一节）。它在内存里建库跑迁移；打包脚本调它时有 5 分钟上限，其余靠 CI 作业自己的超时（见“后果和风险”）。

起初的设计是“只和本 PR 写代码时看不到的迁移比”（按 `git merge-base` 划分）。DeepSeek 审核指出：PR 只要把 main 并进来，旧的迁移就不再算“看不到的”，过时的重建照样能过；空库里又没有数据，暴露不了“搬旧数据时违反新约束”。所以改成下面三条，都不依赖 PR 什么时候并过 main：

1. **新迁移默认只许“只增不减”**：在影子库（只用于检查的临时库）里跑每个新迁移，比较它前后的 `sqlite_schema` 和每张表的列、索引、外键、CHECK，并逐表比较它前后的行：已有的行被删或被改就算改了那张表。允许的只有：建新表、建索引、往表里插入新行。删表、删列、改名、重建、改或删已有数据、改约束，都算“改动已有结构”，必须在 `.meta.json` 的 `alters` 里写明要改哪些表，否则失败；影子库里没有生产数据，所以只能核对迁移自己带的数据。判断靠 SQLite 自己跑出来的结果，不靠正则读 SQL；唯一例外是拒绝清单：去掉注释后迁移里出现 `ATTACH`、`VACUUM`、`load_extension`、`writable_schema` 就直接拒绝，宁可误拒也不放过能逃出影子库的写法。
2. **不许悄悄去掉东西**：对声明了“改动已有结构”的迁移，在 main 当前的结构上跑它，凡是从某个对象的建表语句里消失的带引号的取值（CHECK 里的种类就是这样），必须在 `.meta.json` 的 `removes` 里逐项列出，否则失败；被去掉的列和索引已经算在“改动已有结构”里，必须声明那张表。上面 `perception_records` 的例子：它在今天的 main 上会去掉 `memory_review`，而它没有声明，所以失败；把 main 并进来也照样失败。
3. **两种顺序跑出的结果必须相同**：在空库里按两种顺序各跑一遍，比较规范化后的结构（`sqlite_schema` 和每张表的列、索引、外键）、参照表这类迁移自己写进去的数据（按主键排序后算摘要，跑出随机值和当前时间的列不比），各跑 `PRAGMA integrity_check`、`PRAGMA foreign_key_check`：
   - 顺序甲：先跑 main 上的全部，再跑本 PR 的（模拟生产库的实际顺序）；
   - 顺序乙：全部按编号排序跑（模拟新装的库）。
   - 不同就失败。例如两个迁移都给同一张表 `ADD COLUMN`、而本 PR 的编号更小，两种顺序列的先后不同，会被拦下。

另外，main 上的常规检查对全部迁移按编号完整重放一次；打包时在目标提交上再跑一次完整重放，并用生产库已应用的编号做“生产顺序对新库”的结构和数据比较（硬门槛，不过不打包）。“按迁移文件进入 main 的先后”这种从 git 历史取顺序的做法没有做：生产库实际应用的顺序已经由 S0 读出的编号给出，更准。

反向用例（实施时先在未修复的代码上证明会失败）：`perception_records` 场景必须失败，并进 main 后仍必须失败；合法的晚合小号必须通过；编号重复必须失败；两个迁移给同一参照表插不同行必须通过；老程序遇到新记录表的错误码；个数相同、集合不同必须被拒；旧备份、旧导出、打包、S0、S7、S9、raw-copy 的兼容。

这一检查本身就是给根因 4 上的自动门槛，按[每个事故都要有自动门槛](../../.claude/rules/incident-gates.md#incidents-get-automatic-gates)记一行（写死迁移号这一类已经出现 I-46、I-61 和 lessons 第 667 行三次）。

[返回阅读导航](#contents)

<a id="transition"></a>

## 过渡：0001–0095 和生产库

1. **引擎 PR（不改业务表）**：做[决定](#decision)的一到五节和冲突检查。旧清单冻结在这个 PR 合并时 main 上的最后一个四位号（如果 PR 414 先合，就到 0096）。
2. **第一次上线**：引擎在第一个新迁移的事务里（已核对同机快照）给记录表加 `migration_id` 列和部分唯一索引。库里还没有新迁移时不写任何东西：缺列时按 `sequence` 推出 `0001`…`0095`，缺指纹时由 `readSchemaIdentity` 从账本里的摘要现算。旧行不改写，不跑任何业务 SQL。加测试：快照不匹配时，库文件一个字节都不变。
3. **回滚**：回到引擎 PR 之前的版本时，老程序只按列名读 `sequence, name, phase, digest, applied_at`，多出的列不影响它；只要还没有跑过新编号的迁移，老程序照常工作；跑过以后，老程序启动时报 `UNKNOWN_APPLIED_MIGRATION` 拒绝启动，要用上线前的快照回滚，和今天回滚跨过一个迁移时一样。
4. **第二个 PR**：`decision_ledger` 参照表，用新编号，是第一个新式迁移。
5. **测试服务器**：它的库是一次性的。跑过分支版本后再切别的版本，会因为库里有不认识的迁移而拒绝启动（安全的失败）；切换前从生产副本重置，重置命令只许在非生产环境运行。
6. **验收**：在 Hermes 测试服务器上用一份生产库副本走一遍：旧库升级、两个“晚合小号”迁移补跑、回滚到老程序被拒绝启动、备份恢复和导出导入的指纹核对。

[返回阅读导航](#contents)

<a id="queued-prs"></a>

## 排队中的 PR 怎么迁过来

引擎 PR 合并后，每个排队的 PR 做一次（各自线程做，互不等待）：

1. 把自己的 00NN_x.sql 用 `npm run migration:new` 换成新编号文件，内容不变；删掉自己在 `bundledMigrationFiles`、`SUPPORTED_SCHEMA_MAX`、测试里加的那几行。
2. 重建 `decision_ledger` 只为加种类的（web_push_gate、perception_records、proactive_source_registry、device_actions），等参照表 PR 合并后，把 600 多行的重建换成几行 `INSERT`。
3. 跑 `npm run check:migration-conflicts`。通过就按平常流程合并，不用再找协调者要号；失败就按提示处理，这时只有真正碰同一处的 PR 需要先后处理。

叠在别的 PR 上的分支不受影响：编号在写的时候就定下，叠多少层都不会变（例如本线程在远程分支上看到 `paired_devices` 迁移同时出现在多个分支里，同样是远程分支读到的，不在 main）。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **只把编号换成时间戳**：不改“只认前缀”和共用行，仍要按号的顺序合并（根因 2、3 还在）。
- **合并时由机器人统一改号（goose 原先推荐的混合做法）**：要有程序在合并后往 main 推提交，或改写合并提交；改号后迁移文件的内容摘要和测试服务器上已跑的记录对不上。goose 的维护者自己后来也放宽了这个要求。
- **GitHub 合并队列**：个人账号的私有仓库用不了（前提 15），而且它只是把排队自动化，不消除排队。
- **Atlas 式校验和文件**：它的设计目的就是让两个加迁移的分支在 git 上冲突、强迫线性，正好和目标相反。
- **Django 式依赖图**：每两个并行的迁移都要人线性化或生成合并迁移，仪式比现在少不了多少；我们用“只增不减 + 两种顺序结果相同”自动判断，只有真冲突才要人处理。
- **按 `git merge-base` 划分“同时进行的迁移”、按表名比对**：线程自己的第一版。DeepSeek 审核指出并进 main 就能绕过，换成了上面不依赖合并时机的三条。
- **要求 PR 合并前必须先并入最新 main（GitHub 分支保护的“分支必须是最新的”）**：DeepSeek 独立方案提出过。它等于每合一个 PR，其他所有 PR 都要并入 main、重跑整套 CI，又回到排队。我们改为合并前本地检查、合并后 CI 兜底、打包前硬门槛。
- **用 ULID（时间加随机数的编号）代替时间戳**：DeepSeek 两次提出，理由是同一秒生成会撞号。撞号的后果只是后合的 PR 的检查报“编号重复”、换一个号，不会进 main；生成器已对照 `origin/main` 顺延；时间戳更好读，和 Rails、GitLab 一致，所以不换。
- **`TARGET_SCHEMA` 改成编号集合**：会打穿 S7、run-packet-checks、raw-copy 等一串只认整数的脚本；保留整数个数、另传集合，改动面小得多。
- **用 `PRAGMA writable_schema` 直接改 CHECK 定义**：SQLite 官方只把它用于“删掉”约束，而且警告语法错误会让库损坏、无法读取；加新种类不适用。
- **种类只在程序里校验、库里不设约束**：省掉参照表，但库里能写进任意种类，违反数据可靠性优先于效率的顺序。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果和风险

- 好处：改表的 PR 不再要号、不再排队；只有真正改动同一处已有结构的 PR 需要先后处理，并由检查指出是哪张表、去掉了什么。`decision_ledger` 的 600 行重建不再出现。
- 生产库和新库可能按不同顺序跑（晚合的小号）。靠冲突检查第 3 条保证两种顺序结构和参照数据相同；“改动已有结构”必须声明，且不许悄悄去掉东西（第 1、2 条）。
- 新迁移多了一道约束：改动已有结构要写 `.meta.json`。这是有意的：这类迁移正是会出事的那类，值得多写两行。
- 改动面不小：引擎、`readSchemaIdentity` 的十几个使用方、打包和生产机脚本及其测试数据、审计脚本、管理命令、导出导入、冲突检查和反向用例，都在引擎 PR 里一次改完，由现有的打包检查（`run-packet-checks.py`、`make-packet.py` 的拒绝）和新加的测试覆盖。
- 合并前本地检查依赖 `origin/main` 是最新的；检查开头自动 `git fetch origin main`，拿不到就失败，不默默放行。
- 检查本身没有总超时，只有打包脚本调它时给了 5 分钟的上限；影子库在内存里同步执行迁移，病态的 SQL 能拖住 CI，这个风险接受，靠 CI 自己的作业超时兜底。
- 数据导出和聊天导出清单仍只记整数 `migrationSequence`，不加指纹：它描述的是写出它的程序，不是库；导出的来源库在管理命令里已按指纹核对，在服务里已通过启动时的迁移核对。
- main 合并后的 CI 和打包前的检查，顺序等价只在打包时用 S0 读到的生产库已应用编号做“生产顺序对新库”的比较（`--applied`）；main 上的常规检查只做按编号的完整重放，因为 main 上没有“本次新增”的迁移可以比。
- 与发给模型的内容无关：迁移编号、指纹都不进模型请求，不影响 KV 缓存（DeepSeek 审核在全仓搜索后说没有发现 `packages/prompt-catalog` 和 Pi 适配器读这些值；这是模型的搜索结论，不是本线程亲自核对的）。

[返回阅读导航](#contents)

<a id="owner-decisions"></a>

## 要 Andy 拍板的

1. 同不同意整套换法（时间戳编号、按集合记录、允许晚合补跑、合并前自动查冲突）。推荐同意：这是 Rails、GitLab 的主流做法，加上我们自己的冲突检查补上它们靠人的那一块。
2. 同不同意 `decision_ledger.kind` 改成参照表（改表，单独 PR）。推荐同意：排队的 4 个重建因此各缩成一行，以后加种类不再互相冲突。
3. 引擎 PR 开工期间，排队中的 PR 是继续按旧办法一个个合（协调者照旧分号），还是先停下等引擎 PR。推荐继续按旧办法合：引擎 PR 合并时把当时 main 上的号全部冻结进旧清单，已合的不用返工。

[返回阅读导航](#contents)
