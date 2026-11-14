## 侧重检查（先查这类路径）

我按“错误路径、不可信输入、安全、资源耗尽、不可撤销操作、规则/文档与代码一致性”核对了以下路径，未运行任何测试（工具限制），结论均来自读代码：

- **不可信文件名/目录项**：`loadBundledMigrations` 对旧清单之外、非 14 位时间戳、非 `.meta.json` 的文件直接报 `DEFINITION_INVALID`；`make-packet.migration_files` 也拒绝未识别文件；生成器校验蛇形名。这部分是收紧的。
- **影子库执行与逃逸**：`scripts/migration-conflicts/analyze.mjs:3-12` 用正则拒绝 `ATTACH`、`VACUUM`、`load_extension`、`writable_schema`，但先做朴素的注释剥离；字符串字面量里的 `/*`、`*/` 可以干扰剥离，存在绕过空间（低，见问题 7）。
- **资源耗尽**：ADR 0265:159 说检查“有超时”，但 `make-packet.py:149` 的 `subprocess.run` 和 `check-migration-conflicts.mjs` 的 `git`/`execFileSync` 都没有超时；迁移 SQL 在进程内同步执行，病态 SQL 可以拖住 CI/打包（低，见问题 7）。
- **不可撤销操作**：迁移仍逐条 `IMMEDIATE` 事务提交（`migration-engine.ts:1112-1135`），整批迁移前的快照在循环前核对（`:1105`）。若一批多条中后面的失败，前面的已提交、`minimum_writer_sequence` 已抬高，老程序会被拒绝写入；这是既有设计，本次没有加重，但“上线前快照”仍是唯一恢复路径。
- **规则/文档一致性**：`.agents/instructions/migrations.md` 只写禁止 `ATTACH DATABASE`、`VACUUM INTO`、`load_extension`，没有写代码实际也禁止的 `writable_schema`；ADR 0265 声称导出/备份清单加 `schemaFingerprint`、main 合并后 CI 再查、检查有超时，这些与实现不一致（见问题 1、4、7）。

---

## 结论（按严重度）

### 1. 高：合并后 main CI 与打包“兜底”没有执行顺序等价检查

**文件**: `scripts/check-migration-conflicts.mjs:116-144`、`scripts/migration-conflicts/analyze.mjs:186-226`、`scripts/delivery-mode/make-packet.py:148-156`

**问题**：ADR 0265:170、215 承诺“main 上每次合并后 CI 再跑一次第 3 条（顺序甲=按进入 main 的先后）”“打包时在目标提交上再跑一遍迁移冲突检查，不过就拒绝打包”。实现里：
- `--commit` 模式只做 `legacy` 数量检查和 `replayAll`（`check-migration-conflicts.mjs:118-124`），`replayAll` 只验证“按编号顺序能不能跑”。
- 默认模式用 `added = stamped.filter(!known)`（`:140-144`）；在 main 上 `added` 为空，`analyzeMigrations` 的顺序比较（`analyze.mjs:186-226`）不会对任何已合入的迁移运行。
- 打包的 `check_migration_replay` 调用的正是 `--commit`（`make-packet.py:148-151`）。

**证据（已读）**：
```js
// check-migration-conflicts.mjs:118-124
const { legacy, stamped, unknown } = loadEntriesFromCommit(...);
...
problems.push(...replayAll([...legacy, ...stamped]));
```
```js
// check-migration-conflicts.mjs:142-144
const base = [...legacy, ...stamped.filter((entry) => known.has(entry.file))];
const added = stamped.filter((entry) => !known.has(entry.file));
problems.push(...analyzeMigrations({ base, added, meta: loadMeta(added) }));
```
```python
# make-packet.py:148-149
def check_migration_replay(commit):
    child = subprocess.run(['node', ... '--commit', commit], ...)
```
`replayAll` 只 `cloneFrom(entries)`，不比较两种顺序（`analyze.mjs:235-253`）。

**推测影响**：第二个 PR 在“检查跑过之后、合并之前”main 又变了（ADR:215 明确不要求分支是最新），且两条迁移顺序不同会得到不同结构时，PR 检查看不到对方、main 检查 `added` 为空、打包只按编号跑一遍——这条真正的顺序冲突可以一路通过，生产库按“已有 + 待跑”的顺序升级后与全新库结构不同。测试里 `rejects a late small id whose result differs from a fresh database` 只直接调 `analyzeMigrations`，没有覆盖 main/打包路径。

**建议**：在默认模式对“base 中已有的时间戳迁移”也按 git 历史顺序重放并与编号顺序比较；打包时用 S0 读到的 `migrationIds`（已有集合）拼出真实生产顺序，重放后与“全部按编号”比较结构和参照表数据，不一致就拒绝打包。补一条会失败的 main/打包反向用例。

---

### 2. 中高：顺序比较只比 `sqlite_master`，没有比行数据，ADR 要求的参照表数据检查未实现

**文件**: `scripts/migration-conflicts/analyze.mjs:73-75、182、208-224`

**问题**：ADR 0265:165 要求两种顺序“比较规范化后的结构，以及参照表这类迁移自己写进去的数据（按主键排序后算摘要），各跑 integrity_check、foreign_key_check”。但 `schemaDump` 只返回 `sqlite_master` 的 `type:name` 和 `sql`（`analyze.mjs:40-50、73-75`）；两种顺序比较和整批比较都只比较 `schemaDump`：
```js
// analyze.mjs:208-209
if (JSON.stringify(schemaDump(forward)) !== JSON.stringify(schemaDump(reverse))) ...
// analyze.mjs:222-224
if (JSON.stringify(schemaDump(production)) !== JSON.stringify(schemaDump(fresh))) ...
```
`tableRows` 只用于“每个迁移单独跑时有没有删改 base 里的行”（`:18-37、123-137`），没有参与顺序比较；纯 `INSERT` 的 `touched` 为空（`:182`），所以两个新迁移即使对同一参照表写入互相覆盖的值，也不会被标记为碰同一张表。也没有 `PRAGMA integrity_check` / `foreign_key_check`（ADR 说的）。

**证据（已读）**：`tableRows` 与 `schemaDump` 的定义见上；`analyzeMigrations` 结果只在 `schema` 不同时报 `ORDER_DEPENDENT`。

**推测影响**：例如迁移 A `INSERT OR REPLACE INTO kinds(kind,label) VALUES('x','a')`，迁移 B 写 `('x','b')`；两者都能在任一顺序跑通、结构相同，检查通过，生产与全新库的参照数据不同。迁移 B `DELETE` 掉 A 新插入的行也不会被 `UNDECLARED_ALTERATION` 捕获，因为 B 单独在 base 上跑时没有可删的行。

**建议**：顺序比较和整批比较都加上按表的主键排序行摘要（排除随机值/时间列，或在 `.meta.json` 声明不稳定列），并执行 `integrity_check`、`foreign_key_check`；补“同键不同值/删除其他新迁移插入行”的反向用例。

---

### 3. 中高：已有迁移文件被改写/改名没有任何自动检查，能通过冲突检查和打包，却会让新二进制启动失败

**文件**: `packages/persistence-sqlite/src/migration-engine.ts:1320-1344、979-993`；`scripts/check-migration-conflicts.mjs:120-123、136-139`；`scripts/delivery-mode/make-packet.py:136-139`；`scripts/check-audit-schema-range.mjs`（`numberedBeyondLegacy` 只取 `number > legacy`）

**问题**：引擎按 `bundledMigrationFiles[].file` 读旧文件，并对账本逐行核对 `name/phase/digest`；但各检查只核对“四位编号文件数量是否仍是 95”和“编号连续”，没有把工作区/目标提交的迁移文件与 base 提交或 `bundledMigrationFiles` 的**文件名和内容**比较。
```js
// check-migration-conflicts.mjs:120-123
if (legacy.length !== LEGACY_MIGRATION_COUNT)
  problems.push(`LEGACY_SET_CHANGED expected ... found ${legacy.length}`);
```
```python
# make-packet.py:136-139
if not legacy or legacy != list(range(1, len(legacy) + 1)): refuse(...)
if len({entry[0] for entry in timestamped}) != len(timestamped): refuse(...)
```
`loadBundledMigrations` 读的是 `metadata.file`（`migration-engine.ts:1321-1329`），目录里多出的旧四位文件会被判 `DEFINITION_INVALID`（`:1333-1343`）。

**证据（已读）**：`grep bundledMigrationFiles` 只命中引擎、ADR、说明文档，没有任何检查把实际文件与数组或 base 提交对比；`test/tooling/migration-conflicts.test.mjs` 也没有“修改/改名已有迁移”的用例。

**推测影响**：
- 原地修改 `0095_*.sql`：所有冲突检查通过；生产库已有账本摘要与文件新摘要不符，`validateLedger` 报 `DIGEST_MISMATCH`，部署/启动失败（失败关闭，但会直接卡住上线）；全新库则会应用被改过的 SQL。
- 改名（0095_a.sql → 0095_b.sql）：数量仍是 95，检查通过；引擎读不到 `bundledMigrationFiles` 里的旧文件或把新名字当未识别文件，启动失败。

**建议**：检查脚本对 base 中已存在的每个迁移文件做 blob 对比，禁止修改、删除、改名；旧清单文件的 name 必须与 `bundledMigrationFiles` 一致（可加一个 manifest 摘要）。补“改一个字节/改名”的反向用例。

---

### 4. 中：数据导出/导入仍只比整数 `migrationSequence`，ADR 承诺的 `schemaFingerprint` 没有加进清单

**文件**: `apps/agent-service/src/production-data-export.ts:321`、`apps/agent-service/src/production-chat-export.ts:53`、`packages/persistence-sqlite/src/data-export/verify.ts:302-306`、`packages/persistence-sqlite/src/data-export/chats-verify.ts:36-37`、`apps/admin-cli/src/data-command.ts:180、192-193、229`

**问题**：改成时间戳编号后，“个数相同”不再等于“迁移集合相同”（测试服务器/分支版本可以出现）。ADR 0265:132 明确要求数据导出/聊天导出清单用 `readSchemaIdentity`，:135 要求导出清单加可选 `schemaFingerprint`。实现只改了恢复点和权限转移的运行时校验，导出仍是：
```ts
// production-data-export.ts:321
migrationSequence: LATEST_MIGRATION_SEQUENCE,
```
```ts
// verify.ts:302
if (manifest.migrationSequence !== expectedMigrationSequence) throw ...
```
```ts
// chats-verify.ts:36
if (manifest.migrationSequence > migrationSequence) throw ...
```
`buildPortableExport` 的 manifest 直接使用调用方传入的整数（`export.ts:731-733`），不读数据库账本。

**证据（已读）**：`grep migrationSequence|schemaFingerprint` 显示导出/导入类型、schema、verify 都只有整数；`buildPortableExport` 没有调用 `readSchemaIdentity`。`production-data-export` 还使用 `LATEST_MIGRATION_SEQUENCE` 而不是实际库身份。

**推测影响**：测试服务器或分支库与当前二进制同数不同集合时，导出的数据可能来自不同 schema，`data inspect`/`data import` 仅凭整数接受；导入到当前库可能出现列缺失/语义不符的数据。生产主路径通常服务启动时已把集合对齐，风险主要在测试/分支/回滚场景。

**建议**：按 ADR 给导出/聊天清单增加可选 `schemaFingerprint`（新导出必写，旧导出缺省只比个数），由源库 `readSchemaIdentity` 计算；导入/检查时校验。`production-data-export.ts`、`production-chat-export.ts` 应读取实际库身份，不要只传 `LATEST_MIGRATION_SEQUENCE`。

---

### 5. 中：新增的权限转移、沙箱预留管理指纹校验没有失败反向用例

**文件**: `packages/persistence-sqlite/src/sqlite-authority-transfer.ts:790-798`、`packages/persistence-sqlite/src/sqlite-sandbox-reservation-administration.ts:315-316`；测试：`test/integration/sqlite-recovery-point.test.ts:886-891`（恢复点有反向用例），但 `test/integration/sqlite-authority-transfer.test.ts` 本次未改，`test/integration/sandbox-reservation-administration.test.ts:739-775` 只是把 `schema_fingerprint` 从断言里过滤掉。

**问题**：恢复点新增了 `expectedSchemaFingerprint: "0".repeat(64)` 必须失败的用例；权限转移的同数不同集合检查、沙箱预留写命令的指纹检查没有对应的“同一个数、不同集合必须被拒”用例。删掉这两处 `fingerprint !==` 判断，现有测试仍然通过。

**证据（已读）**：`git diff --name-only` 中没有权限转移测试文件；沙箱管理测试的改法只是 `WHERE key <> 'schema_fingerprint'`，没有构造同数不同集合的数据库。

**推测影响**：这些检查是本次“同数不同集合也要拒绝”的关键防线；缺少反向用例时未来重构容易把检查删掉而不被发现。

**建议**：分别构造 95 旧迁移 + 一个时间戳迁移 A 的库，断言另一个同数不同集合 B 在权限转移导入、沙箱预留写命令下以 `SCHEMA_INCOMPATIBLE`/`SCHEMA_UNSUPPORTED` 失败；再加一条删除指纹判断会失败的测试。

---

### 6. 低：审计脚本不再对“未来的时间戳迁移”失败关闭，唯一防线变成 CI 的复核清单

**文件**: `scripts/operations/workspace-lifecycle-audit.mjs:57-77`；测试 `test/integration/workspace-lifecycle-audit.test.ts:506-513`

**问题**：旧实现用 `SUPPORTED_SCHEMA_MAX` 拒绝任何高于脚本认识的版本。新实现删掉上界，只拒绝：
- `sequence > 95` 且 `migration_id IS NULL` 的行（`unknownLegacyLike`）；
- 版本 ≥95 时 `AUDIT_READ_TABLES` 里缺表。

一个真实的新时间戳迁移（`migration_id` 非空）即使改了审计读取的列/语义，审计脚本仍会运行。测试插入的未来行故意不带 `migration_id`，只覆盖了“旧式未来行”这一种情况。

**证据（已读）**：
```js
const unknownLegacyLike = hasIdColumn
  ? db.prepare("SELECT count(*) ... WHERE sequence > ? AND migration_id IS NULL")...
  : Math.max(0, ledger.count - LEGACY_MIGRATION_COUNT);
...
(version >= LEGACY_MIGRATION_COUNT && missingTables.length > 0)
```
测试：`INSERT INTO schema_migration_ledger (sequence,...,applied_at) SELECT MAX(sequence)+1,'future',...`（无 `migration_id`）。

**推测影响**：生产机上直接跑审计脚本时，遇到未复核的新迁移不会拒绝，可能按旧列读新语义；`check-audit-schema-range` 的 `AUDIT_REVIEWED_MIGRATIONS` 只在仓库/CI 上生效，不在生产脚本运行时生效。

**建议**：若不希望重新写死上界，可让审计脚本接受“已复核指纹/清单文件”或要求 `schema_fingerprint` 与 CI 生成的清单匹配；至少补一条“非空 `migration_id` 的未来迁移必须被拒/被明确允许”的用例，明确这是有意的 fail-open。

---

### 7. 低：`schema_metadata.schema_fingerprint` 只写不读；禁止语句扫描可被注释字符绕过且无超时

**文件**: `packages/persistence-sqlite/src/migration-engine.ts:1018`、`scripts/migration-conflicts/analyze.mjs:10-12`、`scripts/delivery-mode/make-packet.py:149`

**问题 A（Q4 的生产者/消费者）**：`schema_fingerprint` 只在 `writeSchemaMetadata` 里写；全仓搜索没有读取者（只有 ADR 和两个测试把它排除在断言外）。`assertWritableSchema` 每次都从账本重算指纹（`migration-engine.ts:1160-1169`），不读这个字段。它是新增的持久值却没有消费者；无待跑迁移的旧库也不会写它，所以随时可能缺失/过期。

**问题 B（安全/资源）**：`withoutComments` 用正则剥离 `/*...*/` 和 `--...`，但不识别字符串字面量；`INSERT ... VALUES ('/*')` 之类可以干扰，随后真正的 `ATTACH` 可能被藏进被误删的区段（我未构造执行，属推测）。此外 `check-migration-conflicts` 和 `make-packet.check_migration_replay` 都没有超时，ADR 0265:159 声称有超时。

**建议**：要么在读路径消费 `schema_fingerprint`（并规定缺省回退），要么删掉并同步 ADR；禁止语句检查改成基于 SQL tokenizer 或只在字面量外剥注释；给检查进程加超时。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？发给模型的内容是否仍只在末尾追加，每轮会变的值是否都在最后一条消息里？

**不会（就本次改动触及的代码而言）。** 改动文件全部在持久化引擎、管理命令、交付/审计脚本和测试；没有修改任何系统提示、工具定义、历史消息或出口遮盖的组装代码。`LATEST_MIGRATION_SEQUENCE`、`migration_id`、`schema_fingerprint` 的引用只出现在持久化包、管理命令、导出清单和测试里（grep 未命中 `packages/prompt-catalog` 或 `packages/runtime-pi` 的请求组装）。因此请求仍然只在末尾追加，本次没有新增每轮变化的值，也没有新增进入系统提示/工具定义的值。`applied_at` 是唯一的时间值，但只写数据库账本，不进入模型请求或迁移指纹。

**未核实**：是否存在仓库外或未检出的代码把 schema/迁移号嵌入提示；本次只核对了当前检出的引用。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会（本次改动不进入请求字节）。** 迁移指纹 `migrationSetFingerprint` 先按 id 显式排序再算 SHA-256（`migration-engine.ts:768-777`），不依赖数据库返回顺序；文件摘要来自固定文件内容；`readSchemaIdentity` 的 `ids` 也做了 `sort()`（`:948-954`）。`applied_at` 虽然是时间字段，但它不参与指纹，也不进入请求。唯一潜在的小不一致是 `describeMigrationSet` 返回的 `ids` 没有排序（`:799-806`），但它的 `fingerprint` 内部排序，目前没有把 `ids` 序列化到请求或清单；若将来越来越多地方直接比较 `ids`，应先排序。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**有，但不完整。**
- 会真正失败的反向用例：同数不同集合被 `assertWritableSchema` 拒绝（`migration-ids.contract.test.ts`）；晚合小号补跑；未知已应用迁移；重复/乱序定义；指纹顺序无关；冲突检查的未声明改表、未声明删值、两种顺序结构不同、注释拆开的 `ATTACH`/`VACUUM`、`writable_schema`；打包按集合差规划；审计脚本的旧计数/新表检查。这些测试直接调用对应函数，去掉修复会失败。
- 缺失的反向用例：已有迁移文件被改写/改名（问题 3）；顺序依赖的**行数据**差异（问题 2）；main/打包路径的顺序兜底（问题 1）；权限转移和沙箱预留管理的“同数不同集合”（问题 5）；审计脚本“非空 `migration_id` 的未来迁移”（问题 6）。
- 声明中的“测试已通过”我**未运行核实**（工具限制），只核对了测试代码存在及其断言内容。

### 4. 改动产生/修改的每个值，每个使用它的地方都能接受吗？

逐个核对结果：

- **`migration_id`**：产生于 `applyMigrations`（旧迁移写 NULL，时间戳迁移写 14 位 id，`migration-engine.ts:1118-1129`）；读取处 `readMigrationLedger` 对 NULL 按 `sequence` 推 `0001`…（`:913-926`）。S0 读库、`maintenance-common`、审计脚本都做了同样的 NULL 回退；部分唯一索引只约束非 NULL。两端一致。注意 `readSchemaIdentity` 的 id 来自账本，若有人直接篡改账本/绕过唯一索引，重复 id 不会被 `validateLedger` 显式检查（低风险）。
- **`sequence`（应用次序）**：引擎写入 `applied.length + 1`；所有消费者（S0、审计、maintenance、恢复点、权限转移、沙箱管理）使用的都是“记录条数/上一条 sequence”，在新语义下等于应用个数，检查一致；老的 `minimum_writer_sequence` 只与整数比较，回滚保护仍成立（新库计数 >95 时老程序拒绝）。
- **`schema_fingerprint`**：产生于 `writeSchemaMetadata`（`:1018`），但**没有消费者**（问题 7）。这不是两端校验，而是只有生产端。
- **`LATEST_MIGRATION_SEQUENCE`**：引擎按“旧清单数 + 目录里时间戳文件数”算；管理命令、打包 `TARGET_SCHEMA`、S0/维护比较都按个数，一致。但数据导出/聊天导出用它作为清单里的 `migrationSequence`，而不是数据库实际身份，属于问题 4 的不一致。
- **`migrationIds`（S0 新字段）**：S0 读出后只被 `make-packet` 的集合差使用；`make-packet` 会检查长度、子集、待跑数，并区分同数不同集合，消费端能接受。旧 S0 无此字段时退化为按个数取前缀，但新打包模板自己上传新 S0，实际不会走旧格式；这条属于**推测**的兼容路径，未实际演练。
- **`MIGRATION_LEDGER` 每项 `{sequence,name,phase}`**：maintenance 的 `verifyMigrationTransition` 只按这些字段比较，引擎实际还写 `migration_id`，但引擎自身会用 id/name/digest 校验，包计划不比较 id 不会放宽安全性。`TARGET_SCHEMA` 仍被 S7/maintenance/raw-copy 作为个数使用，语义一致。
- **`AUDIT_READ_TABLES`/`AUDIT_REVIEWED_MIGRATIONS`**：`check-audit-schema-range` 消费；`run-packet-checks` 只识别脚本形态；运行时审计脚本不读复核清单（问题 6）。
- **`bundledSchemaFingerprint` vs `readSchemaIdentity`**：测试断言两者相等；但 `bundledSchemaFingerprint` 会静默忽略目录里不认识的额外文件，而 `loadBundledMigrations` 会报错，可能导致管理命令先通过、服务启动才失败（失败关闭，低风险）。

**结论**：`migration_id`、`sequence`、`minimum_writer_sequence`、S0 `migrationIds`、打包 `TARGET_SCHEMA` 两端基本一致；`schema_fingerprint`、导出清单、审计运行时复核存在上述缺口。
