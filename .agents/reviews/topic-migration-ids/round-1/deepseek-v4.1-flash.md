# 方案：用“内容身份 + 集合账本 + 合并前可交换性回放”取代全局迁移编号

> 本文基于已检出的 `61984fb18be8a3499b345f21e0d811c0ba045c0f` 阅读代码和一手资料写成。没有修改文件，没有运行测试；排队分支的实际内容没有逐个 `git show`，相关处标「未核实」。

---

## 一、方案依赖的前提

### 1. 本改动不触碰模型请求

`.claude/rules/prompt-prefix.md:4`：

> “发给模型的内容”包括系统提示、工具定义、历史、资料块、遮盖和压缩。

同文件 `:35`：

> 已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。

同文件 `:28`：

> 每轮都会变的内容只放在最后一条用户消息里。

本方案只改 SQLite 迁移引擎、ledger、打包和备份脚本，不参与请求组装。因此“请求开头不变、只在末尾追加、每轮变化值在最后一条消息”这条约束**不会因本改动改变**；但仍需在实施后用 `npm run check:prompt-prefix` 证明这一点。

### 2. 业界不是只有“全局递增编号”这一种做法

**Rails**：迁移文件名用 UTC 时间戳，按时间决定顺序。
https://guides.rubyonrails.org/active_record_migrations.html

> “Rails uses this timestamp to determine which migration should be run and in what order”

**Django**：编号只是开发者参考，真正身份是迁移名和依赖关系；两个并行迁移没有排序时会被检测出来。
https://docs.djangoproject.com/en/5.2/topics/migrations/

> “Don’t worry - the numbers are just there for developers’ reference, Django just cares that each migration has a different name. Migrations specify which other migrations they depend on … so it’s possible to detect when there’s two new migrations for the same app that aren’t ordered.”

> “Django will refuse to run migrations or make new migrations until it’s fixed.”

**GitLab**：时间戳版本必须全仓库唯一；每个已执行迁移有 SHA-256 checksum 文件，防止重复执行。
https://docs.gitlab.com/development/migration_style_guide/

> “The version must be unique across the repository, and hand-typed versions often collide with existing migrations.”

> “When a migration is first executed, a new migration checksum file is created in db/schema_migrations containing a SHA256 generated from the migration’s timestamp.”

> “The timestamp portion of a migration filename determines the order in which migrations are run.”

**Atlas**：目录完整性文件能发现“两个分支同时新增迁移”，但它自己也说逻辑冲突仍靠 lint。
https://atlasgo.io/concepts/migration-directory-integrity

> “Because of the merge conflict on the atlas.sum file, in order to land their changes, Team B would need to …”

> “migrate/lint remains the gate for logical conflicts such as the two inventory tables described above.”

**Atlas 执行顺序**：默认线性，乱序执行不保证确定性。
https://atlasgo.io/versioned/apply

> “linear (default) - Atlas expects a linear history and fails if it encounters files that were added out of order.”

> “Executing files out of order cannot guarantee deterministic behavior and may lead to failures (e.g., conflicted migrations).”

**Flyway**：支持 outOfOrder，但默认关闭，且它只是“补跑缺号”，并没有解决并行生成唯一版本号的问题。
https://documentation.red-gate.com/flyway/reference/configuration/flyway-namespace/flyway-out-of-order-setting

> “Allows migrations to be run ‘out of order’. If you already have versions 1.0 and 3.0 applied, and now a version 2.0 is found, it will be applied too instead of being ignored.”

> “Default: false”

**SQLite**：改 CHECK 属于“其他 schema 变更”，官方要求按 12 步重建表，不能直接 ALTER。
https://www.sqlite.org/lang_altertable.html

> “The 12-step generalized ALTER TABLE procedure above will work even if the schema change causes the information stored in the table to change.”

> “So the full 12-step procedure above is appropriate for … adding CHECK or FOREIGN KEY or NOT NULL constraints …”

### 3. 当前实现把“编号”同时当成六种东西

已读代码证实：

- `packages/persistence-sqlite/src/migration-engine.ts:764-776`：`validateDefinitions` 要求 `migration.sequence === index + 1`。
- 同文件 `:852-888`：`validateLedger` 要求 ledger 第 i 行 `sequence === i + 1`，并与 `migrations[index]` 逐条比对 name/phase/digest。
- 同文件 `:984-985`：`const currentSequence = ledger.at(-1)?.sequence ?? 0; const pending = migrations.slice(currentSequence);`，也就是“只跑最大号之后的”。
- 同文件 `:79-745`：`bundledMigrationFiles` 是手写数组，每个新迁移必须在末尾追加一条。
- 同文件 `:747-748`：`LATEST_MIGRATION_SEQUENCE` 取数组最后一项。
- 同文件 `:898-906`：`current_sequence` 和 `minimum_writer_sequence` 都写成同一个整数。
- 同文件 `:1013-1034`：`assertWritableSchema` 用整数比较阻止旧 writer 写新库。

外部消费者也把它当版本号：

- `scripts/delivery-mode/make-packet.py:119-124`：文件号必须 `1..N` 连续，`target_schema` 取最大号。
- 同文件 `:155-171`：用正则解析 `migration-engine.ts` 的数组，并从 `current+1..target` 逐号生成 ledger。
- `scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs:75-79`：要求 `ledger.length === current` 且 `row.sequence === index + 1`。
- `scripts/delivery-mode/packet-template/maintenance/S9-control-files.py:232-236`：要求 ledger 正好 `1..schema`。
- `scripts/operations/workspace-lifecycle-audit.mjs:5,28-38`：`SUPPORTED_SCHEMA_MAX = 95`，并要求 `ledger.count === version`。
- `scripts/check-audit-schema-range.mjs:10-20`：要求这个硬编码上限等于最新迁移号。
- `packages/persistence-sqlite/src/sqlite-recovery-point.ts:363-368,959-961,1035`、`sqlite-authority-transfer.ts:395-401,781-794,1278`：备份清单里的 `schemaSequence` 用 `MAX(sequence)`，并必须等于当前程序期望值。
- `packages/persistence-sqlite/src/sqlite-worker.ts:141-164`：worker 用 `writerSequence` 和 `current_sequence`/`minimum_writer_sequence` 比较。
- `packages/persistence-sqlite/src/sqlite-sandbox-reservation-administration.ts:293-313`：要求 ledger 连续且 `minimum === current`。
- `packages/persistence-sqlite/test/migration-engine.contract.test.ts:21` 等多处测试写死 95。

### 4. 更深一层：`decision_ledger` 的开放枚举被写进 CHECK

`packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:23-28`：

> `kind TEXT NOT NULL CHECK ( kind IN ( 'proactive', 'memory_candidate', … 'memory_review' ) )`

SQLite 不能改 CHECK，只能按官方 12 步重建整表，并连带重建引用它的子表。已核对事实里 `decision_ledger` 已被重建 9 次，排队迁移中还有 4 个在重建它。这个问题**不是编号问题**；即使编号完全自由，4 个 PR 仍会在 600 行重建 SQL 上冲突。

### 5. 已证实与推测的边界

**读代码或来源证实：** 上述 file:line、SQLite 12 步、Rails/Django/GitLab/Atlas/Flyway 的公开说法。

**推测或未核实：**
- 排队分支的具体 SQL 内容没有逐个读，只依据题目给出的分支名和文件 `0095_correction_propagation.sql`。
- 没有运行任何测试，没有在生产库或测试服务器上验证。
- ULID 在实际多代理并发下的碰撞概率、回放式冲突检查的耗时，属于工程判断。
- 旧二进制读到新增 `id` 列后的精确行为，是从当前 SQL（显式列名 SELECT/INSERT）推断的，未在真实旧包上验证。

---

## 二、根因

1. **序号既是迁移身份，又是执行位置，又是连续性约束。**
   `validateDefinitions`、`validateLedger`、`applyMigrations` 三处共同要求“1..N 连续、按下标一一对应”。因此任何 PR 只要在 main 之后加迁移，就必须等前一个合入后重新编号。

2. **编号被当成 schema 版本、回滚兼容线、打包目标、审计上限。**
   `current_sequence`、`minimum_writer_sequence`、`target_schema`、`schemaSequence`、`SUPPORTED_SCHEMA_MAX`、`LATEST_MIGRATION_SEQUENCE` 全部来自同一个整数。要并行，必须先把这些语义拆开。

3. **开放枚举用了 SQLite 最难改的约束形式。**
   `CHECK (kind IN (...))` 每加一个种类就触发整表重建。这是 4 个排队 PR 冲突的直接原因，也是“编号排完队仍然会撞”的原因。

4. **没有“迁移改了什么”的机器可读事实。**
   两个分支各加一个文件，Git 不会冲突；引擎只按文件顺序执行，没有任何地方检查“这两个迁移是否改同一张表/同一批行”。协调者分配编号实际上承担了冲突检测。

5. **回滚保护只有一个全局整数。**
   老程序靠 `writerSequence` 和 `minimum_writer_sequence` 拒绝写新库。这个整数每加一个迁移就变，天然要求线性顺序；要允许乱序，必须把“旧 writer 是否安全”从“迁移排第几”中解耦。

6. **同一个值有多个产生处、多个使用处，且两端校验不一致。**
   I-46、I-61、I-73 都是这一类：清单里的值只在一端被接受。本方案的每个新值都必须有唯一的产生函数和统一解析入口。

---

## 三、完整方案

### 3.1 编号方式：新迁移不再有全局序号

- **0001–0095 永久冻结**：保留原文件名和原 ledger 行，不重命名、不重排、不重写 digest。
- **新迁移使用内容无关、全局唯一、可排序的 ULID 作为身份**，文件名形如：

  ```text
  m_01J9Z6Q8K3W7T2N5R8V0X4B6C1_add_web_push_gate.sql
  m_01J9Z7A1D5M8P3S6V9Y2B4E7F0_add_perception_records.sql
  ```

  `m_` 前缀与旧的四位数字文件名区分；ULID 由 `npm run db:migration:new -- <slug>` 生成，生成一次后不随改名、改说明、重排而变。ULID 的时间前缀只用于稳定排序，随机后缀保证几十个代理并行生成也不会撞号。不要用“当前秒级时间戳” alone：GitLab 明确说版本必须全仓库唯一，手写/并发时间戳会碰撞。
- **不再有 `bundledMigrationFiles` 手写数组**。运行时扫描目录：
  - `^[0-9]{4}_.+\.sql$` → 旧迁移，必须与一次生成后冻结的 `legacy-migrations.json` 完全一致（sequence、name、changeSet、phase、file、digest）。
  - `^m_[0-9A-HJKMNP-TV-Z]{26}_.+\.sql$` → 新迁移。
  - 不接受其他文件名。
- `legacy-migrations.json` 只从当前数组生成一次，此后不改。这样“每个新迁移在数组末尾加一条”的步骤消失。

**为什么不用纯时间戳**：Rails/GitLab 都依赖时间戳唯一，但几十个代理并行时同秒碰撞是现实风险。ULID 保留可排序性，同时用随机位消除碰撞。

### 3.2 迁移文件内容

- 每个文件只含 SQL，不加解释性注释；身份来自文件名，依赖关系由回放验证而不是手写清单。
- digest 是文件 UTF-8 字节的 SHA-256。用 `.gitattributes` 固定 `*.sql text eol=lf`；读取时拒绝 BOM 和 CRLF，避免不同机器 checkout 后 digest 变化。
- 禁止迁移里出现非确定值：`CURRENT_TIMESTAMP`、`datetime('now')`、`random()`、`randomblob()`、`abs(random())` 等。新增检查 `MIGRATION_NONDETERMINISTIC_SQL`。这保证同一迁移集合在任何机器、任何应用顺序下产生相同的表结构和数据。
- 单个迁移内部仍按现有规则一个事务执行；失败回滚该迁移，不自动降级。

### 3.3 库内记录：单表扩展，不重建旧 ledger

保留 `schema_migration_ledger(sequence INTEGER PRIMARY KEY, name, phase, digest, applied_at)`，只做向后兼容的扩展：

```text
schema_migration_ledger
  sequence      INTEGER PRIMARY KEY   -- 旧行 1..95；新行 = 当前最大 + 1，仅作追加计数
  id            TEXT                  -- 新增，可空；旧行留 NULL，读取时派生 legacy:<4位>
  name          TEXT NOT NULL
  phase         TEXT NOT NULL
  digest        TEXT NOT NULL
  applied_at    TEXT NOT NULL
```

- 新增部分唯一索引：`CREATE UNIQUE INDEX ... ON schema_migration_ledger(id) WHERE id IS NOT NULL`。
- **不改写旧行**。旧行的身份在读取时由 `sequence` 派生为 `legacy:0001`…`legacy:0095`，与冻结的 `legacy-migrations.json` 对齐。这样旧历史仍是原字节。
- 新行写入时带 `id`，`sequence` 取 `MAX(sequence)+1`。因此：
  - `MAX(sequence)` 永远等于 `ledger.length`（95 + 新迁移数）。
  - 这个数定义为 **`generation`（schema 代数）**，不再叫“最新迁移号”。
  - 同一迁移集合无论按什么顺序应用，`generation` 都相同，因为每个新迁移只追加一行。

`schema_metadata` 保留并新增：

```text
current_sequence          = generation
minimum_writer_sequence   = generation
migration_set_digest      = sha256("himawari.migration-set.v1\n" + 按 id 排序的每行 "<id> <digest>" 用 "\n" 连接 + "\n")
```

`migration_set_digest` 不包含 `applied_at`、`sequence`、ledger 行顺序；它只取决于“已应用迁移 id 和内容 digest 的集合”。这是新 schema 身份。`current_sequence`/`minimum_writer_sequence` 继续保留，是为了让旧二进制和旧工具仍能拒绝新库。

新增唯一解析入口 `readSchemaIdentity(database)`，返回：

```text
{
  legacyCount,        // 旧 ledger 行数，必须为 95
  generation,         // ledger.length / MAX(sequence)
  migrationIds,       // 排序后的 id 列表
  migrationSetDigest  // 按集合计算
}
```

所有消费者只允许调用它，禁止再各自 `MAX(sequence)` 或解析 TS 数组。

### 3.4 执行算法

`applyMigrations` 改成集合驱动：

1. 加载定义：冻结的旧迁移 + 目录中的新迁移。
2. `validateDefinitions`：
   - 旧迁移仍要求 1..95 连续、name/phase/changeSet/digest 与冻结清单一致；
   - 新迁移要求 id 格式合法、id 唯一、digest 与文件一致；
   - 不再要求新旧合并后 `sequence === index+1`。
3. `ensureInternalSchema`：
   - 如果库已有产品表但没有 ledger，仍拒绝；
   - 如果 ledger 缺 `id` 列，在**已校验 pre-migration snapshot 之后**用 `ALTER TABLE ... ADD COLUMN id TEXT` 添加，并建部分唯一索引；不 UPDATE 旧行。
4. `validateLedger`：
   - 旧行必须正好是 1..95，名称/阶段/digest 与冻结清单一致；
   - 新行 id 必须非空、唯一、能在当前二进制定义中找到，name/phase/digest 必须一致；
   - 已应用集合必须是当前已知集合的子集；数据库里有当前二进制不认识的 id → `UNKNOWN_APPLIED_MIGRATION`，拒绝写入；
   - 缺当前二进制已知但未应用的 → 视为 pending，写完前禁止写。
5. pending = 定义集合 − 已应用集合，**按 id 字典序排序**执行。
6. 已有库且 pending 非空时，必须先有同机、已验证的 pre-migration snapshot；snapshot 校验同时比较 `generation` 和 `migrationSetDigest`。
7. 每个迁移一个 `BEGIN IMMEDIATE` 事务：执行 SQL → 插入 ledger 行（`sequence = max+1`、`id`、name/phase/digest）→ 重新计算集合 digest → 更新 `current_sequence`/`minimum_writer_sequence`/`migration_set_digest`。
8. 返回值改为 `{ appliedIds, generation, migrationSetDigest }`；过渡期保留 `currentSequence` 作为 `generation` 的别名，避免一次性改爆所有调用方。

**乱序如何安全**：pending 按 id 排序，而不是按“已应用最大号之后”。一个 id 更小的迁移晚到，只要它与已应用的同表迁移可交换（见 3.5），就能补跑。Flyway 的 `outOfOrder` 证明这种模式可行，但 Atlas 也警告乱序执行不保证确定性；所以我们不直接打开 `outOfOrder`，而是用合并前回放证明“这个乱序集合的最终状态和顺序应用一致”。

### 3.5 合并前自动发现真正冲突：可交换性回放

新增 `scripts/check-migration-parallel.mjs`，作为 `npm run check` 的一部分，并在所有改迁移目录的 PR 上作为必需 CI 检查。它不依赖 GitHub 付费功能，只用 Node + better-sqlite3 + git。

**输入：**
- main 的迁移定义（旧迁移 + 新迁移）和实际已应用顺序；
- 当前 PR 的迁移定义；
- 候选集合 = PR 有、main 没有的新迁移。

**算法：**

1. 在临时 SQLite 库上按 main 的实际 ledger 顺序重放 main 的迁移，得到每张表的指纹。
2. 对每张表定义指纹：
   - 该表及其索引/触发器/视图在 `sqlite_schema` 中的 `sql`，排序后拼接；
   - 表内容按主键（无主键按 rowid）排序后的 canonical JSON 或内容 digest；
   - 两者一起哈希。
3. 计算两个顺序，分别重放到两个临时库：
   - **生产顺序**：main 已应用顺序 + 候选迁移按 id 排序；
   - **全新安装顺序**：main ∪ 候选 全部按 id 排序（旧迁移固定在前）。
4. 对每张表比较两个最终指纹：
   - 相同 → 可交换，允许并行合并；
   - 不同 → 失败，输出 `MIGRATION_ORDER_DEPENDENT table=<t> ids=<...> productionOrder=<...> idOrder=<...>`。
5. 额外检查：
   - 每个候选迁移单独叠在 main 上必须能执行；
   - 完整集合必须能执行；
   - 执行后 `PRAGMA integrity_check`、`PRAGMA foreign_key_check` 通过；
   - 两个分支都创建同名表/索引时，完整集合回放会失败或指纹不同，直接报冲突。
6. 对无法可靠判定 touched 的 SQL（`PRAGMA writable_schema`、`ATTACH`、动态 SQL、没有 fixture 的 DML）直接失败 `MIGRATION_TOUCH_UNKNOWN`，要求人工确认，绝不静默放行。

**这解决了什么：**

- 两个迁移改不同表：两个顺序指纹相同，任意先后合并都可以。
- 两个迁移都 `ALTER TABLE t ADD COLUMN`：列顺序不同，指纹不同，阻止；这正是“真正冲突”。
- 两个迁移都向同一张 lookup 表 `INSERT` 不同主键：两个顺序最终行集合相同，允许；不会因为“同表”一刀切。
- 两个迁移都重建 `decision_ledger`：顺序不同会丢列/丢行或直接 SQL 失败，阻止。
- 两个分支都 `CREATE TABLE inventory`：完整集合回放失败，阻止。

**为什么不是 Atlas sum**：Atlas 的 `atlas.sum` 会让**任何**并行新增迁移都产生 merge 冲突，即使两张表完全无关；这会把“并行开发”重新变成串行解决文本冲突。我们只拦真正顺序相关的迁移。

**为什么不是 Django 多 leaf**：Django 的多 leaf 会要求所有并行迁移都线性化；我们只在最终表指纹不同的时候要求人工介入。

**合并顺序保证**：PR 必须与 main 保持最新（branch protection 的 “Require branches to be up to date” 是免费功能），这样 CI 检查的是实际会合入的组合。若平台允许直接合并两个都通过旧 base CI 的 PR，第二次合并会改变生产顺序；因此要求“合并前至少一次以最新 main 为 base 的检查通过”，或由现有合并流程在更新 base 后重跑该检查。

### 3.6 修复 `decision_ledger` 的结构性根因

在基础引擎落地后，先合一个一次性过渡迁移 `m_<ULID>_decision_kind_lookup.sql`：

1. 新建：

   ```text
   decision_kinds(kind TEXT PRIMARY KEY)
   decision_kind_outcomes(kind TEXT NOT NULL REFERENCES decision_kinds(kind),
                          outcome TEXT NOT NULL,
                          PRIMARY KEY (kind, outcome))
   ```

   从现有 `DECISION_KINDS` / `DECISION_OUTCOMES`（`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:54-61` 已在使用）种入现有 8 个 kind 和各自允许的 outcome。
2. 按 SQLite 官方 12 步重建一次 `decision_ledger`：把 `CHECK (kind IN (...))` 改为 `REFERENCES decision_kinds(kind)`；把 kind→outcome 的巨型 CHECK 改为复合外键或保留应用层校验。保留 `(kind='proactive') = (outcome IS NULL)` 这类封闭、不会随功能增长的约束。
3. 之后新增 kind 只需要：

   ```sql
   INSERT OR IGNORE INTO decision_kinds(kind) VALUES ('new_kind');
   INSERT OR IGNORE INTO decision_kind_outcomes(kind, outcome) VALUES ('new_kind', '...');
   ```

   不再重建 `decision_ledger`，也不再连带重建子表。

**这是唯一一次大重建**。排队的 4 个 decision_ledger 迁移在 rebase 后删除各自的重建块，改成插入 kind/outcome；它们之间只会改同一张 lookup 表的不同行，按 3.5 的回放会判为可交换。

### 3.7 0001–0095 和生产库的过渡

**旧库不动历史：**
- 生产库当前 95 行 ledger 原样保留，旧迁移文件原样保留。
- 第一次运行新二进制时：
  1. 先创建并验证同机 pre-migration snapshot；
  2. 给 ledger 加可空 `id` 列和部分唯一索引；
  3. 旧行不 UPDATE，读取时派生 `legacy:0001`…`legacy:0095`；
  4. 按 id 顺序执行所有新迁移；
  5. 写入新的 `generation` 和 `migration_set_digest`。
- 生产库从 95 过渡到“95 + 若干新迁移”时，`generation` 从 96 开始；旧二进制看到 ledger 第 96 行或 `current_sequence >= 96`，会以 `UNKNOWN_APPLIED_MIGRATION` 或 `WRITER_TOO_OLD` 拒绝写入。这保持了现有回滚保护，而且比整数更精确：新二进制只要发现一个自己不认识的已应用 id，也会拒绝。

**旧备份和旧清单：**
- 旧 recovery point / authority transfer 的 manifest 只有 `schemaSequence <= 95`，新代码把它当 legacy 清单接受，按 legacy 集合校验。
- 新清单使用 v2：保留 `schemaSequence = generation`，并增加 `migrationSetDigest`。旧代码看到 `schemaSequence >= 96` 会拒绝；旧代码若因为新增字段而无法解析，也会拒绝，这是安全方向。
- 新代码校验清单时同时比较 `generation` 和 `migrationSetDigest`；只比整数不够。

**测试服务器跑分支版本：**
- 分支库的迁移集合与 main 不同，`migrationSetDigest` 不同。
- main 二进制遇到分支库中不认识的已应用 id，按 `UNKNOWN_APPLIED_MIGRATION` 拒绝写入；分支二进制反之亦然。
- authority transfer 同时比较集合 digest，不再只比较 `MAX(sequence)`，避免“同代数不同集合”被误接收。

**回滚：**
- 仍然只支持“恢复到升级前 snapshot”，不做自动 down migration，和现状一致。
- 上线前 snapshot 是旧集合（legacy 95），旧二进制可以打开；升级后新库的新 snapshot 由新二进制校验。回滚到旧版本时使用旧 snapshot，而不是让旧二进制直接打开新库。
- 上线/回滚检查不削弱：snapshot 仍要求同机、integrity_check 通过、source path 一致，并额外比较集合 digest。

### 3.8 打包、备份、审计脚本的具体改法

| 文件 | 现状 | 改法 |
|---|---|---|
| `migration-engine.ts:79-748` | 手写数组、`LATEST_MIGRATION_SEQUENCE` | 删除数组；目录扫描 + `legacy-migrations.json`；导出 `LEGACY_MIGRATION_MAX`、`loadMigrationSet()`、`readSchemaIdentity()` |
| `migration-engine.ts:764-807` | 旧+新混在一起要求 1..N | 旧迁移单独校验 1..95；新迁移只校验 id/digest 唯一 |
| `migration-engine.ts:852-889` | 按下标逐条比对 | 按 id 集合比对；旧行派生 id；新增行按 id 查找 |
| `migration-engine.ts:984-985` | `slice(currentSequence)` | 集合差集，按 id 排序 |
| `migration-engine.ts:1013-1035` | 整数 writerSequence | 接收 writer 的已知集合/digest；未知已应用 id 或 digest 不符即拒绝 |
| `make-packet.py:119-124` | 要求文件号 `1..N`，取最大号 | 校验旧迁移 1..95 + 新 id 唯一；`target_generation = 95 + 新迁移数`，并计算 `targetMigrationSetDigest` |
| `make-packet.py:155-171` | 正则解析 TS 数组，按 `current+1..target` | 从目录/`git show` 读文件；pending = target 集合 − current 集合；保护表检查用回放得到的 `touches` |
| `make-packet.py:341-350` | `target < current` 就拒绝 | 要求 current 集合 ⊆ target 集合，且 generation 不回退；否则拒绝 |
| `read-s0-db.mjs:75-79` | ledger 必须 1..current | 读 `readSchemaIdentity`：旧行 1..95、新 id 唯一、generation=ledger.length=MAX(sequence)、集合 digest 一致 |
| `S9-control-files.py:232-236` | ledger 必须 `1..schema` | 按 id 集合和 digest 比较；允许新行 sequence 顺序与 id 顺序不同；校验 generation |
| `raw-copy-recovery.mjs:252-256` | `currentLedger.length === currentSchema` | generation 仍等于 length，但恢复 ID 和期望 ledger 改用集合 digest + id |
| `workspace-lifecycle-audit.mjs:5,28-38` | `SUPPORTED_SCHEMA_MAX = 95`、count=version | 删除硬编码上限；用 `readSchemaIdentity` + 所需列探测；新增 `check:audit-schema-impact` |
| `check-audit-schema-range.mjs` | 比较最新号与硬编码上限 | 替换为 `check:migration-set` / `check:audit-schema-impact`：回放迁移，任何改审计表的迁移都要更新审计契约指纹 |
| `sqlite-recovery-point.ts:363-368,959-961,1035` | `MAX(sequence)` + manifest | 读 `generation` + `migrationSetDigest`；v1 旧清单按 legacy 接受；v2 新清单两项都比 |
| `sqlite-authority-transfer.ts:395-401,781-794,1278` | `MAX(sequence)`，`migrations.at(-1).sequence` | 同上；import 时期望集合 digest，不期望最后一项 sequence |
| `sqlite-worker.ts:141-164` | 整数 writerSequence | 配置传 `writerMigrationSetDigest` + generation；运行前比较集合 digest |
| `sqlite-sandbox-reservation-administration.ts:293-313` | 连续 ledger + `minimum === current` | 改用 identity helper；读取接受 49..当前 generation，写入要求集合 digest 正好等于当前 |
| `product-state-repository.ts:287,302` | `writerSequence: migrations.length` | 传完整集合 digest / generation |
| `apps/admin-cli/src/index.ts:340-359,401` | `current = ledger.at(-1).sequence`；`expectedSchemaSequence = at(-1).sequence` | 用 `readSchemaIdentity`；snapshot 比较 generation + set digest |
| `apps/admin-cli/src/{data,memory,thread}-command.ts` | `LATEST_MIGRATION_SEQUENCE` | 改为 `LEGACY_MIGRATION_MAX` + `describeMigrationSet()`；导出/导入清单同时带 generation 和 set digest |
| `apps/agent-service/src/production-{data,chat}-export.ts:321/53` | `migrationSequence: LATEST_MIGRATION_SEQUENCE` | 改为导出 `{generation, migrationSetDigest}`；verify 端同时校验 |
| 测试中的 95 | `CURRENT_SCHEMA_SEQUENCE = 95` 等多处 | 改成从 `legacy-migrations.json` / `LEGACY_MIGRATION_MAX` 派生；新增乱序、可交换、未知 id 用例 |

**关键原则**：新值只允许有一个产生函数和一个解析函数。`readSchemaIdentity()` 是唯一入口；`make-packet.py` 和 S9 用同一套规则实现，并用跨语言 fixture 校验两端一致。

### 3.9 排队中的 PR 怎么迁

1. 先合“引擎 v2 + 冻结旧迁移清单”基础 PR；此 PR 不新增产品表，只改引擎、ledger 扩展和所有消费者。生产仍停在 95，旧二进制仍可运行。
2. 合一次性 `decision_kind_lookup` 过渡迁移。
3. 每个排队 PR：
   - `git rebase` 到含前两步的 main；
   - 用 `npm run db:migration:rename -- <old-file>` 把 `0096_*`/`0095_*` 改名为 `m_<ULID>_<slug>.sql`；不改 SQL 内容，不再往数组加条目；
   - 涉及 `decision_ledger` 重建的 4 个 PR：删掉重建块，改成插入 `decision_kinds` / `decision_kind_outcomes`；
   - 新增/调整对应的 migration contract test；
   - 运行 `npm run check:migrations`、`npm run check`、该迁移的 contract test。
4. 合并顺序不再由协调者分配；`check-migration-parallel` 只拦真正顺序相关的组合。两个改不同表的 PR 可以任意先后合并；改同一张表的 PR 只有两种合法情况：
   - id 顺序与生产应用顺序一致（先合入的 id 更小），或者
   - 回放证明两个顺序最终指纹相同（例如各自 `INSERT` 不同 lookup 行）。
5. 长期不合并的旧分支如果 id 较小又改了 main 已改的表，会被回放拦下；解决办法是 rebase 后重新生成一个更晚的 ULID（只对未合入迁移允许），而不是人工排队。

---

## 四、自动检查与反向用例

新增或修改的检查：

1. **`migration-engine.contract.test.ts`**
   - 旧 ledger 1..95 原样接受；
   - 新迁移按 id 集合执行，乱序不同表成功；
   - 已应用 id 不在当前二进制 → 拒绝；
   - 同一 id 重复 → 拒绝；
   - 历史 SQL 改动 → digest mismatch；
   - 同一迁移集合不同应用顺序 → `migrationSetDigest` 相同、每表 schema 指纹相同；
   - 旧 writer（95）遇到新库 → 拒绝。
   - **反向用例**：去掉“未知已应用 id”检查后，该用例必须失败；去掉集合 digest 校验后，篡改 digest 的用例必须失败。

2. **`test/tooling/migration-parallel.test.mjs`（新）**
   - 两个改不同表的迁移，两种顺序都通过；
   - 两个都 `ALTER TABLE t ADD COLUMN` 且 id 顺序与合并顺序相反 → 必须报 `MIGRATION_ORDER_DEPENDENT`；
   - 两个向同一 lookup 表插入不同主键 → 必须通过；
   - 两个都重建同一张表 → 必须失败；
   - 两个都 `CREATE TABLE same_name` → 必须失败；
   - 含 `PRAGMA writable_schema` 或 `random()` → 必须报 `MIGRATION_TOUCH_UNKNOWN` / `MIGRATION_NONDETERMINISTIC_SQL`。
   - **反向用例/变异测试**：删掉“两个顺序指纹比较”这一行，第二个用例会错误通过，测试必须因此失败；删掉 `MIGRATION_TOUCH_UNKNOWN`，未知 SQL 用例必须失败。

3. **`test_make_packet.py`**
   - target 由集合计算，不再要求文件号连续；
   - main 有 A、分支有 B，target 包含 A+B；合并后 target 仍正确；
   - 分支缺 main 的迁移 → 拒绝；
   - 分支有 main 不认识的 id → 拒绝；
   - 保护表检查使用 `touches`，删掉该检查后对应测试失败。

4. **`read-s0-db` / `S9-control-files` / `workspace-lifecycle-audit` 测试**
   - ledger 行乱序但 id 集合正确 → 通过；
   - 缺一行、重复 id、digest 不符 → 失败；
   - 审计脚本在新增一个改审计表的迁移但未更新契约时 → `check:audit-schema-impact` 失败；删掉该检查后反向测试失败。

5. **`sqlite-recovery-point` / `sqlite-authority-transfer` 测试**
   - v1 legacy 清单可读；
   - v2 清单 generation 对但 set digest 不对 → 拒绝；
   - 新库清单被旧 expected（95）读取 → 拒绝；
   - 删除 set digest 比较后，篡改用例必须失败。

6. **worker/admin schema 检查**
   - 未知已应用 id、集合 digest 不符 → 拒绝写；
   - 读取端接受 49..当前 generation，写入端只接受当前集合；
   - 保留 I-61 的反向用例：未来版本被拒、旧版本读取可用。

所有反向用例都必须实际执行并断言“检查会失败”，不能只断言正常路径。**未核实**：以上用例尚未实现和运行。

---

## 五、放弃的做法及原因

| 做法 | 放弃原因 |
|---|---|
| 保留整数，只打开 Flyway 式 `outOfOrder` | 仍然要求版本号唯一；几十个代理仍会撞号。Atlas 明确说乱序执行不保证确定性。 |
| 由协调者/脚本自动分配编号 | 仍然串行；自动分配只是把人工排队变成服务排队。 |
| GitHub merge queue / 付费合并功能 | 约束明确不能依赖付费服务；而且它只能串行合并，不能解决同表语义冲突。 |
| 只用 Atlas `atlas.sum` | 任何两个并行新增迁移都会制造文本冲突，即使改不同表；且需要外部工具/注册中心。可借鉴 checksum，不照搬。 |
| 只用 Django 多 leaf 检测 | 会把所有并行迁移都判为需要线性化，过于保守；我们希望只拦真正顺序相关的迁移。 |
| 把所有迁移压成一个 | 丢失历史、无法平滑过渡生产 ledger，风险远大于收益。 |
| 直接重建/清空数据库或只用 schema dump | 违反“记忆（数据）可靠性”，不可接受。 |
| 去掉所有 CHECK 约束 | 削弱数据库边界；开放枚举应改用 lookup 表，而不是放弃约束。 |
| 另建一张“新迁移表”，旧 ledger 完全不动 | 会让 generation/ledger.length、S9、审计、打包全部出现两套账本，消费者更多、I-73 风险更大。单表加可空 `id` 更小。 |
| 手写每个迁移的 `touches` 清单 | 会漂移，最终又变成人工维护；用真实回放 + 保守 SQL 扫描。 |
| 用纯时间戳做 id | GitLab 明确要求版本全仓库唯一；并行代理同秒碰撞风险高。ULID 更稳。 |

---

## 六、风险、反例与未核实

1. **回放指纹可能漏掉语义**：如果迁移只改数据、不改 schema，而临时库没有代表性数据，两个迁移可能看起来可交换，实际在真实数据上不交换。
   缓解：对没有 fixture 的 DML 直接报 `MIGRATION_TOUCH_UNKNOWN`；为关键表准备最小 fixture；最终仍以人工复核为最后一道。**未核实**：指纹对全部现有迁移的覆盖度。

2. **列顺序严格性**：两个都 `ALTER TABLE t ADD COLUMN` 的迁移即使业务上不冲突，也会因 SQLite 列追加顺序不同而被拦。
   这是有意的确定性取舍；如果 owner 接受“列顺序不同但语义相同”，可放宽，但会增加 `SELECT *`/`INSERT INTO t VALUES` 的隐性风险。

3. **一次性的 `decision_ledger` 重建仍有风险**：600 行级重建、子表引用、外键检查都可能出错。
   缓解：严格按 SQLite 12 步、同机 snapshot、`integrity_check` + `foreign_key_check`、在测试服务器上先跑分支；**不要在生产库上直接试验**。

4. **旧二进制安全性依赖“新行会进入旧 ledger”**：如果某个新迁移没有写 ledger 行，旧二进制可能误以为还是 95。
   缓解：新引擎把“迁移 SQL 成功但 ledger 行未写”视为事务失败整体回滚；增加测试。

5. **消费者遗漏**：本方案改动的值很多（id、digest、generation、set digest、touches、target/current），最容易犯 I-73。
   缓解：所有值经 `readSchemaIdentity()`；加 `check:schema-identity-consumers`：grep 禁止再出现 `migrations.slice(currentSequence)`、`MAX(sequence)` 当身份、`SUPPORTED_SCHEMA_MAX`、`LATEST_MIGRATION_SEQUENCE` 等旧模式；跨语言 fixture 验证 TS/Python/Node 三端对同一 ledger 算出同一结果。

6. **CI 回放成本**：每次 PR 重放全部 95+ 迁移，可能变慢。
   缓解：只在迁移目录变化时跑；用内存/临时 SQLite；缓存 main 基础指纹；**未核实**实际耗时。

7. **ULID 时钟偏移**：时间前缀不保证与创建顺序完全一致。
   但 id 只用于稳定排序，不用于语义依赖；真正依赖关系由回放和“必须能执行”保证。若两个迁移有依赖，必须在同一 PR 或后一个基于前一个；CI 会失败。

8. **未核实**：排队分支 `origin/claude/project-thread-*` 的实际差异；生产机当前 ledger 行内容和磁盘状态；所有测试文件是否还有写死 95 的遗漏。

---

## 七、需要人拍板的取舍

1. **是否现在做 `decision_ledger` 的 lookup 表一次性重建？**
   推荐做。否则 4 个排队 PR 会继续重建同一张表，编号方案再好也无法消除冲突。

2. **确定性要多严格？**
   推荐“同一迁移集合必须产生同一每表 schema 指纹”，因此列追加顺序不同也算冲突。若接受列顺序差异，可放宽，但会牺牲可预测性。

3. **新迁移 id 用 ULID 还是时间戳？**
   推荐 ULID：可排序、无需协调、碰撞概率低。时间戳更符合 Rails/GitLab 习惯，但并行代理碰撞风险高。

4. **旧 ledger 是“加可空 id 列、读取时派生 legacy id”，还是“另建新表”？**
   推荐加可空列。它保持旧行字节不变，generation/ledger.length 语义连续，旧二进制仍能识别并拒绝新库。

5. **新二进制遇到“自己不认识但已应用”的迁移，是否允许声明式 backward-compatible 放行？**
   推荐默认拒绝，保留现有“旧 writer 不能写新库”的安全级别。若将来确实需要灰度混跑，再为单个迁移增加显式兼容标记。

6. **审计脚本如何防止 I-46 重演？**
   推荐“审计表指纹契约 + `check:audit-schema-impact`”，不再维护 `SUPPORTED_SCHEMA_MAX`。需要接受：新增迁移若改审计表，必须更新契约文件，否则 CI 失败。

7. **上线顺序**：推荐先合引擎 v2（不新增产品表），再合 decision lookup，最后让排队 PR rebase。是否接受这个短期的“两次部署”节奏，需要 owner 决定。

---

## 八、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 改动只涉及 SQLite 迁移引擎、ledger、打包/备份/审计脚本，不修改系统提示、工具定义、历史消息、资料块或遮盖逻辑。发给模型的内容仍然“只在末尾追加”，每轮变化的值仍然只在最后一条用户消息里。依据是 `.claude/rules/prompt-prefix.md:4,28,35`。实施后用 `npm run check:prompt-prefix` 验证；本次未运行。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**对模型请求：不会，因为完全不碰请求组装。**

**对迁移身份：不会，而且专门消除了这种不确定性。**
- `digest` 只取决于迁移文件 UTF-8 字节；固定 LF、拒绝 BOM/CRLF。
- `migration_set_digest` 只取决于“按 id 排序的 id+digest 集合”，不包含 `applied_at`、`sequence`、ledger 行顺序。
- 迁移 SQL 禁止 `CURRENT_TIMESTAMP`、`random()` 等非确定函数。
- 冲突检查的每表指纹按排序后的 schema 和行内容计算，不依赖数据库返回顺序。

有一个例外要说明：ledger 的 `applied_at` 仍是每条记录的实际时间，因此同一迁移集合在不同机器上的 ledger 行时间不同；但它**不参与** schema 身份、备份兼容判断或冲突判断。备份是数据库快照，本来不要求跨机器逐字节相同。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，见第四节。核心是：
- `migration-engine.contract.test.ts`：集合执行、乱序、未知 id、digest 篡改、旧 writer 拒绝；
- `migration-parallel.test.mjs`：同表列顺序冲突、整表重建冲突、同表 lookup 插入可交换、未知 SQL；
- `test_make_packet.py`：target 由集合计算、缺迁移/多迁移拒绝；
- S9/read-s0/audit：id 集合、generation、digest、审计表影响；
- recovery/transfer：v1 legacy 清单、v2 集合 mismatch；
- worker/admin：旧 writer/未知集合拒绝。

**反向用例会真的失败**：每个检查都设计“删掉检测逻辑后，对应用例从失败变通过”的变异测试，并在测试里断言错误码/非零退出。**未核实**：这些测试尚未实现和运行，不能声称已经通过。

### 4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？

下表逐个列出“产生处、使用处、两端校验”。这是 I-73 的核对清单；任何一行没有做到“两端同一规则”，方案就不算完成。

| 值 | 产生处 | 使用处 | 两端校验 / 本次要求 |
|---|---|---|---|
| 新迁移 `id`（ULID） | `npm run db:migration:new` 生成文件名；引擎目录扫描 | ledger `id` 列；`readSchemaIdentity`；S9/read-s0；packet `migration_ledger`；recovery/transfer 清单；tests | 产生端校验 `^m_[0-9A-HJKMNP-TV-Z]{26}_`；消费端用同一正则；ledger 唯一索引；旧行派生 `legacy:NNNN`。所有消费端必须同时接受 legacy 和 ULID，不能只认数字。 |
| 迁移 `digest` | `migration-engine.ts:798` 对文件字节做 SHA-256 | `validateLedger:873-877`；ledger 行；`migrationSetDigest`；recovery/transfer 文件 digest；packet 保护表检查 | 两端口径必须是“UTF-8 字节、LF、无 BOM”的 SHA-256 hex64；不能一边对文件算、一边对规范化 SQL 算。 |
| `migrationSetDigest` | 新 `readSchemaIdentity()` / `applyMigrations` | `schema_metadata`；recovery/transfer manifest；worker；packet target/current；S9/audit | 产生端按 id 排序、只含 `<id> <digest>`；消费端必须重算并逐字节比较。旧清单没有该字段时按 legacy 处理。 |
| `generation` | `applyMigrations`：`MAX(sequence)+1`，等于 `ledger.length` | `current_sequence`、`minimum_writer_sequence`、`read-s0-db.mjs:75-79`、`S9:232-236`、`workspace-lifecycle-audit:28-38`、`sqlite-sandbox-reservation-administration:293-313`、recovery/transfer `schemaSequence`、packet `target_schema`/`currentSchema`、admin/data export、tests | 产生端保证 `generation === ledger.length === MAX(sequence)` 且单调不减；消费端必须校验这三个等式，不能只信 metadata。旧二进制用它拒绝 >95；新二进制还额外校验集合 digest。 |
| `schemaSequence`（备份/transfer manifest） | `sqlite-recovery-point.ts:641,662`、`sqlite-authority-transfer.ts:1075,1146` | `sqlite-recovery-point.ts:959-969,1035`、`sqlite-authority-transfer.ts:781,1278`、admin `expectedSchemaSequence:401` | 产生端写 `generation`；消费端同时比较 generation 和 `migrationSetDigest`；旧 v1 清单仅当 generation<=95 且集合等于 legacy 时接受。 |
| `target_schema` / `currentSchema`（打包） | `make-packet.py:119-124,330,341-350` | `maintenance-common.mjs:780-849`、`raw-copy-recovery.mjs:252-256`、`run-maintenance.mjs`、`bindings.draft.json:105`、`generated-packet-gate.py:29`、`run-packet-checks.py:53-73` | 产生端不再要求 `1..N` 连续；改为 `generation = 95 + 新迁移数` + `migrationSetDigest`。消费端必须校验 current 集合 ⊆ target 集合、generation 不回退、pending 等于集合差，不能只比较整数。 |
| `SUPPORTED_SCHEMA_MAX` | `workspace-lifecycle-audit.mjs:5` | 同文件 `:28-38`；`check-audit-schema-range.mjs:10-20`；`run-packet-checks.py:64-73`；`test/tooling/audit-schema-range.test.mjs` | 本值应删除。替换为 `readSchemaIdentity()` + 所需列探测 + `check:audit-schema-impact`。所有引用点必须同步删除，不能留一处仍比较 95。 |
| `writerSequence` | `product-state-repository.ts:287,302`、worker 配置、admin CLI | `migration-engine.ts:1013-1034`、`sqlite-worker.ts:141-164`、`sqlite-sandbox-reservation-administration.ts:310`、`memory-command.ts:54`、`thread-command.ts:75`、`data-command.ts:228` | 改为 writer 的已知迁移集合/digest；产生端和消费端都必须校验“未知已应用 id → 拒绝”“缺已知迁移 → 禁止写”“digest 不符 → 拒绝”。不能只把整数换成另一个整数。 |
| `touches`（每迁移改动的表） | 新 `check-migration-parallel.mjs` 回放 + 保守 SQL 扫描 | 合并前冲突检查；packet 保护表检查 `make-packet.py:167`；审计影响检查；S9 迁移内容比较 | 产生端必须对未知 SQL 失败而不是空集；消费端保护表检查用同一套 touches；跨 Python/Node 实现用 fixture 对齐。 |
| `LATEST_MIGRATION_SEQUENCE` | `migration-engine.ts:747-748` | `production-data-export.ts:321`、`production-chat-export.ts:53`、`admin-cli/src/data-command.ts:126,179,191,192,228,235,276,329`、`memory-command.ts:54`、`thread-command.ts:75`、`admin-cli/src/index.ts:401`、多个测试 | 改为 `LEGACY_MIGRATION_MAX` + `describeMigrationSet()`；导出/导入清单带 generation + set digest；消费端校验两项。 |
| `current_sequence` / `minimum_writer_sequence` | `writeSchemaMetadata:898-906` | `read-s0-db.mjs:75-79`、`S9:232-236`、`workspace-lifecycle-audit:28-38`、`sqlite-worker:141-164`、`sqlite-sandbox-reservation-administration:293-313`、`assertWritableSchema:1013-1034` | 保留旧键，但语义改为 generation；新代码不得再把它当迁移身份。旧二进制仍用它拒绝新库；新二进制以集合 digest 为准。 |

**结论**：只要还有任一消费端只比较整数、只解析数字文件名、或只校验一端，这个方案就不完整。实施时应把“用 `readSchemaIdentity()`”做成编译期/检查期约束，而不是靠逐个记得改。
