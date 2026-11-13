---
status: active
document_type: adr
decision_status: proposed
supersedes: ""
superseded_by: ""
amends: "docs/adr/0018-sqlite-product-state-authority.md"
date: "2026-11-14"
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

几十个线程并行开发，凡是改表的 PR 都会在自己的分支上取“下一个号”。两个 PR 同时取到 0096，必然撞号；所以现在由协调者给每个 PR 分配“正式号”，前一个合进 main 之后，下一个才能改号、重跑 CI（持续集成，每次推送后自动跑的检查）、再合并。2026-11-14 排队的有 PR 414、404、436、444、443、449、479、451、455、454、486 等十几个，每个都要等前一个合完，成了全项目的开发瓶颈。Andy 要求根治。

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

- 已合并的 95 个迁移里，`decision_ledger` 被整表重建过 9 次（连同引用它的子表 `decision_signals`、`decision_ledger_payloads`、`source_insights` 等一起重建，单个迁移 600 多行）。
- 远程分支上排队的 10 个迁移里，有 4 个又在重建 `decision_ledger`（`0096_web_push_gate`、`0095_perception_records`、`0097_proactive_source_registry`、`0097_device_actions`），都只是为了在 `kind` 里加一个值。
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
| GitLab | 同 Rails，14 位时间戳，“hand-typed versions often collide”所以用生成器 | 同 Rails；另外每个迁移在 `db/schema_migrations/` 下有一个单独文件，避免大家改同一个文件 | 能 | `structure.sql` 冲突 + CI 检查 | [GitLab 迁移规范](https://docs.gitlab.com/development/migration_style_guide/) |
| Django | 名字唯一即可，“the numbers are just there for developers' reference” | 按名字 | 每个迁移写明依赖谁，形成依赖图 | 同一个应用出现两个末端就要求人线性化或生成合并迁移 | [Django 迁移](https://docs.djangoproject.com/en/5.2/topics/migrations/) |
| Flyway | 版本号 | 历史表 | 默认不能；`outOfOrder=true` 时能 | 无自动语义检查 | [Flyway outOfOrder](https://documentation.red-gate.com/fd/out-of-order-224919730.html) |
| goose | 时间戳或序号 | 版本表 | 默认不能；`-allow-missing` 能。维护者原先推荐“开发用时间戳、合并后由 CI 改成序号”，后来因为社区反馈放宽 | 无 | [goose 博客](https://pressly.github.io/goose/blog/2021/out-of-order-migrations) |
| Atlas | 时间戳 | 版本表 | 默认 `linear` 不能；`non-linear` 能，但文档不建议用于生产 | 故意用 `atlas.sum` 制造 git 冲突，强迫线性；用 `atlas migrate rebase` 解决 | [Atlas apply](https://atlasgo.io/versioned/apply)、[目录完整性](https://atlasgo.io/concepts/migration-directory-integrity) |

共同点：**编号只负责“唯一”，不负责“排队”**；库里按“跑过哪些”记，而不是按“跑到第几号”记。分歧在于“晚合的小号”怎么办：Rails、GitLab 直接补跑；Atlas、Flyway 默认拒绝，是因为它们不知道两个迁移是否互不影响。我们的做法是：允许补跑，但由合并前的自动检查保证补跑的迁移和已上线的迁移互不影响，这样既不排队，也不靠运气。

**两个对标问题的回答：**

1. 大公司遇到同样问题怎么做、用户看到什么：GitLab 上千人同时提交迁移，用时间戳 + 每迁移一个文件 + CI 检查，开发者从不需要别人分号；最终用户什么都看不到，上线照常。
2. 这是根因还是表面修补：根因。四个原因各有对应的改法（见下文），改完后只有真正改同一张表的两个 PR 需要先后处理，而且由检查自动指出，不再靠人排队。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

### 一、编号：UTC 时间戳加名字，由脚本生成

- 新迁移的文件名是 `<14 位 UTC 时间戳>_<名字>.sql`，例如 `20261114013000_device_actions.sql`。时间戳只保证唯一和大致的先后，不代表“排第几”。
- 用 `npm run migration:new -- <名字>` 生成文件（取当前 UTC 时间），不手打，避免 GitLab 说的手打撞号。
- 默认 `phase` 是 `expand`、`changeSet` 是名字换连字符（0052 以后的 44 个迁移全是这样）。少数需要别的阶段时，在同名 `.meta.json` 里写，例如 `20261114013000_x.meta.json`。

### 二、每加一个迁移只新增文件，不改任何共用的行（对应根因 3）

- 引擎启动时扫描迁移目录得到清单，不再手写数组。0001–0095 的数组原样冻结成“旧清单”，以后不再往里加；检查拒绝新增四位编号文件。
- `SUPPORTED_SCHEMA_MAX` 改成按内容判断：审计脚本声明它读哪些表；只有碰到这些表的迁移才需要在审计脚本里登记“已看过”（I-46 的本意是“新迁移改了审计读的表时要有人看过”，这样只在真改到时才要动）。审计脚本运行时遇到“碰了它读的表但没登记”的迁移就拒绝，和现在遇到更高版本就拒绝的效果相同。
- 写死版本号的测试改成从清单推算（`docs/lessons.md:667` 已建议的方向）；`check:migration-conflicts`（见下文）同时检查测试和脚本里不再出现写死的最新号。

### 三、库里按“跑过哪些”记，晚合的也能补跑（对应根因 1、2）

- 记录表 `schema_migration_ledger` 加一列 `migration_id`（只对非空值唯一）。旧的 95 行不改写，读的时候按 `sequence` 推出 `0001`…`0095`，已有历史保持原样。`sequence` 列保留，含义变成“第几个被跑的”（仍是 1..N 连续），所以生产机上只认 `sequence` 的老脚本（前提 8）不用跟着改语义。
- 要跑的迁移 = 程序知道的 − 库里跑过的，按编号顺序跑；旧清单永远排在前面。库里有程序不认识的编号，照旧拒绝（`UNKNOWN_APPLIED_MIGRATION`）；每个跑过的迁移照旧核对名字、阶段和摘要（SHA-256，内容指纹）。
- 一个迁移的编号比库里已跑的最大编号还小时（“晚合的小号”），照跑，但在记录里标 `out_of_order = 1`、写日志，方便事后查。它能安全补跑，靠的是下一节的合并前检查。
- 迁移前同机快照、一次一个迁移一个事务，这些都不变（前提 5）。

### 四、回滚保护改成按集合比（对应根因 2 带来的连锁）

- 程序能写库的条件从“库的最大号 = 我的最大号”改成“库跑过的集合 = 我知道的集合”。老程序（回滚后）遇到库里有它不认识的迁移，照旧以 `WRITER_TOO_OLD` 拒绝写入，效果和现在一样。
- `schema_metadata` 新增 `schema_fingerprint`：对“跑过的编号排序后”算 SHA-256。`current_sequence`、`minimum_writer_sequence` 继续写，值是“跑过的个数”，供 `sqlite-worker.ts`、生产机脚本这类只比整数的地方用；需要判断“是不是同一套结构”的地方（工作进程、备份恢复、权限转移）同时比指纹，这样测试服务器跑分支版本时个数相同、集合不同也能被认出来。
- 备份清单（恢复点、权限转移）加 `schemaFingerprint`。改动前做的备份没有这个字段，按个数比（那时只有旧清单，个数相同就是同一套）。
- 其他读整数版本的地方一并改成同一个读取函数（`readSchemaIdentity`，返回个数、编号集合和指纹），不许各自 `MAX(sequence)`：数据导出和聊天导出的清单（`apps/agent-service/src/production-data-export.ts:321`、`production-chat-export.ts:53` 现在写 `migrationSequence: LATEST_MIGRATION_SEQUENCE`）、管理命令（`apps/admin-cli/src/` 的 data、memory、thread 命令和 `index.ts`）、沙箱预留管理（`sqlite-sandbox-reservation-administration.ts`）、生产机上的恢复脚本（`raw-copy-recovery.mjs`）。导出清单加指纹，导入时两项都比；旧导出没有指纹，按个数比。

### 五、上线打包脚本改成按集合算（前提 7、8）

- `make-packet.py` 的目标版本改成“这个提交里的迁移编号集合”（旧清单解析 + 目录扫描），待跑清单 = 目标集合 − 生产库跑过的集合（S0 阶段读库时一并读出 `migration_id`）。生产库有、提交里没有的，拒绝打包（等同现在的 `PACKET_COMMIT_OLDER_THAN_PRODUCTION_SCHEMA`）。
- 受保护表检查照旧逐个迁移做。
- 生产机上的维护脚本（`maintenance-common.mjs`、`S9-control-files.py`）按 `migration_id` 而不是下标核对记录。

### 六、`decision_ledger.kind` 改成参照表（对应根因 4，单独 PR，要 Andy 同意改表）

- 新建 `decision_ledger_kinds(kind TEXT PRIMARY KEY)` 和 `decision_ledger_outcomes(kind, outcome)`（同一文件第 67 行起还有一条“哪种决定允许哪些结果”的大 CHECK，也随种类增长）。`decision_ledger.kind` 引用前者，`(kind, outcome)` 引用后者（`proactive` 的 outcome 是空值，SQLite 不检查含空值的外键，原有的 `(kind = 'proactive') = (outcome IS NULL)` 这类不会增长的约束保留）。这需要最后一次整表重建（和现在的做法相同，只做这一次），种子数据取程序里已有的 `DECISION_KINDS`、`DECISION_OUTCOMES`（`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts`）。
- 以后加一种决定只要两三行 `INSERT`，两个 PR 各加各的不冲突。数据库照样拒绝不认识的种类和结果，可靠性不降。
- 写进开发规则：会不断增加取值的字段不用 CHECK 枚举，用参照表；取值固定的小枚举（例如 `('useful', 'unneeded', 'missed')`）可以继续用 CHECK。

[返回阅读导航](#contents)

<a id="conflicts"></a>

## 冲突怎样自动发现

新增检查 `npm run check:migration-conflicts`，放进 `npm run check`（合并前必过，前提 12）和 CI。它只读 SQL、在内存里建空库，几秒钟跑完，不用重跑整套 CI。

1. **格式和唯一性**：文件名格式、编号不重复、没有新增四位编号、`.meta.json` 合法。
2. **按表比对“同时进行”的迁移**：
   - “同时进行的迁移” = 现在 `origin/main` 上有、但本 PR 的分叉点（`git merge-base`）上没有的迁移，也就是本 PR 写代码时看不到的那些。
   - 从 SQL 里认出每个迁移碰了哪些表，并分三种：改结构（建表、改表、删表、重建、建索引和触发器）、改数据（`UPDATE`、`DELETE`、`INSERT … SELECT`）、只追加行（`INSERT … VALUES`）。外键 `REFERENCES` 指向的表算“读结构”。
   - 本 PR 的迁移和任何一个“同时进行的迁移”在同一张表上，一方改结构、或双方都改数据，就失败，并打印两边的文件和表名：先把 main 并进来，再按最新的表定义重写自己的迁移。双方都只追加行（例如各自往 `decision_ledger_kinds` 加一种）不算冲突。
   - 并进 main 以后，那个迁移就不再是“同时进行的”，检查自然通过；不需要人登记“已解决”。
   - 这一步能拦下上面 `perception_records` 的例子：它和 `0095_correction_propagation` 都重建 `decision_ledger`。
3. **两种顺序跑出的结构必须相同**：在空库里按两种顺序各跑一遍，比较规范化后的表结构（`sqlite_schema` 和每张表的列、索引、外键）：
   - 顺序甲：先跑 main 上的全部，再跑本 PR 的（模拟生产库的实际顺序）；
   - 顺序乙：全部按编号排序跑（模拟新装的库）。
   - 两种顺序还要比较参照表这类迁移自己写进去的数据（按主键排序后算摘要），并各跑一遍 `PRAGMA integrity_check`、`PRAGMA foreign_key_check`。
   - 不同就失败。这保证“晚合的小号”在生产库和新库上得到同一套结构。例如两个迁移都给同一张表 `ADD COLUMN`，两种顺序列的先后不同，会被拦下。
4. **合并后的兜底**：main 上每次合并后 CI 再跑一次第 3 步，顺序甲改为“按迁移文件进入 main 的先后”（从 git 历史取）。正常情况下前三步已经挡住；这一步只防“PR 的 CI 跑完以后 main 又变了，合并前又没跑本地检查”这种漏网。

这一检查本身就是给根因 4 上的自动门槛，按[每个事故都要有自动门槛](../../.claude/rules/incident-gates.md#incidents-get-automatic-gates)记一行（写死迁移号这一类已经出现 I-46、I-61 和 lessons 第 667 行三次）。

[返回阅读导航](#contents)

<a id="transition"></a>

## 过渡：0001–0095 和生产库

1. **引擎 PR（不改业务表）**：做[决定](#decision)的一到五节和冲突检查。旧清单冻结在这个 PR 合并时 main 上的最后一个四位号（如果 PR 414 先合，就到 0096）。
2. **第一次上线**：启动时引擎给记录表加 `migration_id`、`out_of_order` 两列并补齐旧行（补的值由旧清单按 `sequence` 对上名字和摘要，对不上就拒绝启动），算出指纹写进 `schema_metadata`。这一步只动迁移自己的记录表，不跑任何业务 SQL；仍在迁移前做同机快照。
3. **回滚**：回到引擎 PR 之前的版本时，老程序只按列名读 `sequence, name, phase, digest, applied_at`，多出的两列不影响它；只要还没有跑过新编号的迁移，老程序照常工作；跑过以后，老程序以 `WRITER_TOO_OLD` 拒绝写入，和今天回滚跨过一个迁移时一样。
4. **第二个 PR**：`decision_ledger_kinds` 参照表，用新编号，是第一个新式迁移。
5. **验收**：在 Hermes 测试服务器上用一份生产库副本走一遍：旧库升级、两个“晚合小号”迁移补跑、回滚到老程序被拒绝写入、备份恢复的指纹核对。

[返回阅读导航](#contents)

<a id="queued-prs"></a>

## 排队中的 PR 怎么迁过来

引擎 PR 合并后，每个排队的 PR 做一次（各自线程做，互不等待）：

1. 把自己的 `00NN_x.sql` 用 `npm run migration:new` 换成新编号文件，内容不变；删掉自己在 `bundledMigrationFiles`、`SUPPORTED_SCHEMA_MAX`、测试里加的那几行。
2. 重建 `decision_ledger` 只为加种类的（web_push_gate、perception_records、proactive_source_registry、device_actions），等参照表 PR 合并后，把 600 多行的重建换成一行 `INSERT`。
3. 跑 `npm run check:migration-conflicts`。通过就按平常流程合并，不用再找协调者要号；失败就按提示和对方协调，这时只有这两个 PR 需要先后处理。

叠在别的 PR 上的分支（例如 `paired_devices` 出现在 6 个分支里）不受影响：编号在写的时候就定下，叠多少层都不会变。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **只把编号换成时间戳**：不改“只认前缀”和共用行，仍要按号的顺序合并（根因 2、3 还在）。
- **合并时由机器人统一改号（goose 原先推荐的混合做法）**：要有程序在合并后往 main 推提交，或改写合并提交；改号后迁移文件的内容摘要和测试服务器上已跑的记录对不上。goose 的维护者自己后来也放宽了这个要求。
- **GitHub 合并队列**：个人账号的私有仓库用不了（前提 15），而且它只是把排队自动化，不消除排队。
- **Atlas 式校验和文件**：它的设计目的就是让两个加迁移的分支在 git 上冲突、强迫线性，正好和目标相反。
- **Django 式依赖图**：每两个并行的迁移都要人线性化或生成合并迁移，仪式比现在少不了多少；我们用“碰了哪些表”自动判断，只有真冲突才要人处理。
- **用 `PRAGMA writable_schema` 直接改 CHECK 定义**：SQLite 官方只把它用于“删掉”约束，而且警告语法错误会让库损坏、无法读取；加新种类不适用。
- **要求 PR 合并前必须先并入最新 main（GitHub 分支保护的“分支必须是最新的”）**：DeepSeek 独立方案提出过。它等于每合一个 PR，其他所有 PR 都要并入 main、重跑整套 CI，又回到排队。我们改为合并前在本地跑几秒钟的冲突检查（前提 12），加上合并后的兜底。
- **用 ULID（时间加随机数的编号）代替时间戳**：DeepSeek 独立方案提出，理由是同一秒生成会撞号。撞号的后果只是第二个 PR 的冲突检查报“编号重复”、换一个号，不会进 main；时间戳更好读，和 Rails、GitLab 一致，所以不换。
- **种类只在程序里校验、库里不设约束**：省掉参照表，但库里能写进任意种类，违反数据可靠性优先于效率的顺序。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果和风险

- 好处：改表的 PR 不再要号、不再排队；只有真冲突的两个 PR 需要先后处理，并由检查指出是哪张表。迁移文件和 `decision_ledger` 的重建大幅减少。
- 生产库的跑法和新库可能不同顺序（晚合的小号）。靠冲突检查第 2、3 步保证结构相同；结构相同但数据结果依赖顺序的情况（例如两个迁移都 `UPDATE` 同一张表）由“双方都改数据就算冲突”挡住。检查认表靠解析 SQL，遇到它认不出的写法（例如动态拼的表名）时按“碰了所有表”处理，宁可多报。
- 记录表多两列；生产机上的脚本要跟着改（打包、S0、S9、维护脚本），这些都在引擎 PR 里，并由现有的打包检查（`run-packet-checks.py`、`make-packet.py` 的拒绝）覆盖。
- 合并前本地检查依赖 `origin/main` 是最新的；检查开头自动 `git fetch origin main`，拿不到就失败，不默默放行。
- 工作量：引擎 PR 是一个中等改动（引擎、打包脚本、维护脚本、审计脚本、检查脚本、测试），参照表 PR 是一次常规重建。

[返回阅读导航](#contents)

<a id="owner-decisions"></a>

## 要 Andy 拍板的

1. 同不同意整套换法（时间戳编号、按集合记录、允许晚合补跑、合并前自动查冲突）。推荐同意：这是 Rails、GitLab 的主流做法，加上我们自己的冲突检查补上它们靠人的那一块。
2. 同不同意 `decision_ledger.kind` 改成参照表（改表，单独 PR）。推荐同意：排队的 4 个重建因此各缩成一行，以后加种类不再互相冲突。
3. 引擎 PR 开工期间，排队中的 PR 是继续按旧办法一个个合（协调者照旧分号），还是先停下等引擎 PR。推荐继续按旧办法合：引擎 PR 合并时把当时 main 上的号全部冻结进旧清单，已合的不用返工。

[返回阅读导航](#contents)
