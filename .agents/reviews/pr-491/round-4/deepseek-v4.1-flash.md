我先看两段 diff 的范围和关键文件。
## 结论概览

核心引擎的“按集合判断、按编号对齐、快照后才加列、指纹集合化”实现与 ADR 基本一致；我没有发现会直接丢数据或破坏回滚保护的高危缺陷。发现的问题集中在**打包链路的 fail-open、旧库升级被误拒、文档/作者说法与代码不一致，以及若干测试与 fixture 缺口**。

以下按严重度排列；标「已证实」的是我亲自读代码看到的，标「推测/未核实」的是我无法仅凭现有文件确认运行时行为的。

---

## 中

### 1. `migrationDigests` 缺失或长度不符时，打包静默跳过“已应用迁移是否被改过”的核对
- 文件: `scripts/delivery-mode/make-packet.py:404-408`
- 已证实
- 问题：S0 的 `migrationIds` 存在、但 `migrationDigests` 缺失或长度不一致时，`pairs` 会退化成纯 id 列表；`check-migration-conflicts.mjs` 解析到 `digest` 为 `undefined` 后，`checkAgainstApplied` 的 `if (digest && ...)` 直接跳过摘要比较。也就是说，一个被截断、过期或被手工改过的 S0 输入会让本应拦截“已上线的迁移文件被改过”的硬门槛静默失效。作者说法“打包前核对已应用的迁移文件没被改过”并非在所有输入形状下成立。
- 证据：
  ```python
  digests = s0.get('migrationDigests')
  pairs = [identifier + ':' + digest for identifier, digest in zip(applied_ids, digests)] if isinstance(digests, list) and len(digests) == len(applied_ids) else applied_ids
  check_migration_replay(parameters['COMMIT'], pairs)
  ```
  ```js
  if (digest && createHash("sha256").update(entry.sql).digest("hex") !== digest) {
  ```
- 建议：当 `migrationIds` 非空而 `migrationDigests` 缺失/长度不等时直接 `refuse`（例如 `PACKET_S0_MIGRATION_DIGESTS_INVALID`），不要降级。

### 2. 待跑的旧迁移（0001–0095）也会被套用“只增不减、必须写 .meta.json”的规则，旧库升级会被误拒
- 文件: `scripts/migration-conflicts/analyze.mjs:211, 361-385`；`packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql`
- 已证实（代码路径与 0095 内容已读；是否实际触发取决于生产库当前版本）
- 问题：`checkAgainstApplied` 把“目标提交里有、S0 显示未应用”的所有迁移都交给 `analyzeMigrations`。该函数对每一项都要求 `meta[entry.id]?.alters` 声明，否则 `UNDECLARED_ALTERATION`。因此当生产/恢复库低于 95 时，待跑的 0095 这类旧迁移（无 `.meta.json`，且大量 `DROP TABLE` / 重建）必然被判为未声明改动，打包被拒。这与打包脚本本身“按集合差规划旧迁移”的逻辑矛盾。
- 证据：
  ```js
  const base = appliedIds.map((id) => byId.get(id));
  const added = entries.filter((entry) => !appliedSet.has(entry.id)).sort(...);
  problems.push(...analyzeMigrations({ base, added, meta }));
  ```
  ```js
  const declared = new Set(meta[entry.id]?.alters ?? []);
  const changedExisting = new Set([...diff.altered, ...diff.dropped].map(tableOf));
  ...
  if (!declared.has(name)) problems.push(`UNDECLARED_ALTERATION ...`);
  ```
  0095 内容包含：
  ```sql
  DROP TABLE decision_ledger;
  DROP TABLE decision_prereviews;
  ...
  ```
- 建议：`checkAgainstApplied` 只把 `id.length === 14` 的迁移纳入“新增迁移”规则；旧四位迁移视为已批准的基线（或为冻结清单建一份等价声明），只做重放与完整性检查。并补一个“生产库 94 → 目标 96”的真实 `--applied` 用例。

### 3. 作者说法“`schema_metadata` 加 `schema_fingerprint`”与代码、ADR 都不一致
- 文件: `packages/persistence-sqlite/src/migration-engine.ts:896-919, 1014-1022`；`docs/adr/0265-...md:128,133`
- 已证实（文档与实现均读）
- 问题：代码没有给 `schema_metadata` 加任何 `schema_fingerprint` 列，也没有写入指纹；`ensureInternalSchema` 只建 `key/value/updated_at`，`writeSchemaMetadata` 只写 `current_sequence` 和 `minimum_writer_sequence`。指纹是每次由 `readSchemaIdentity` 从账表现算。ADR 133 行明确说“不另存一份”，但 128 行仍残留“加列、加索引、写指纹”，本次复核材料也照抄了“加 `schema_fingerprint`”。
- 证据：
  ```ts
  CREATE TABLE IF NOT EXISTS schema_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  ```
  ```ts
  statement.run("current_sequence", String(sequence), updatedAt);
  statement.run("minimum_writer_sequence", String(sequence), updatedAt);
  ```
  ADR 133：“指纹不另存一份：每次都从记录表里的编号和摘要现算”。
- 建议：修正复核材料和 ADR 128 行；若产品确实需要持久化指纹用于取证，再单独设计，不能只写在说明里。

---

## 低

### 4. 生产机 fixture 未按 ADR 声称一起改，时间戳迁移已应用后的 6 列账本路径缺少 fixture 覆盖
- 文件: `docs/adr/0265-...md:143`；`scripts/delivery-mode/packet-template/maintenance/verify-fixtures.mjs:142,155`；`verify-raw-copy-fixtures.mjs:37-40`；`verify-migrate-fixtures.mjs:49-53`；`verify-sidecar-tidy-fixtures.mjs:83-87`
- 已证实
- 问题：ADR 第 143 行说这些“手建的 5 列记录表”会一起改，但本次提交没有改它们；它们仍然只建 5 列、只插 5 列。结果是：`migration_id` 有值（即新式时间戳迁移已在生产库应用）的 6 列账本，只在仓库集成测试里出现，S0 / maintenance / S9 的 packet fixture 没有覆盖。`readS0State` 新增的 `migrationIds` / `migrationDigests` 也没有被这些 fixture 直接断言。
- 证据：
  ```js
  CREATE TABLE schema_migration_ledger(sequence INTEGER,name TEXT,phase TEXT,digest TEXT,applied_at TEXT);
  ...
  full.prepare("INSERT INTO schema_migration_ledger VALUES(?,?,?,?,?)")...
  ```
- 建议：增加一个 6 列、含 14 位 `migration_id` 的 fixture，覆盖 `readS0State` 输出、`readMaintenanceState` 按 id 对齐、`verifyMigrationTransition` 的晚合序列；并同步修正 ADR 143。

### 5. `run-packet-checks.py` 对“新式审计脚本”只查标记存在，实际不再验证目标版本覆盖
- 文件: `scripts/delivery-mode/run-packet-checks.py:68-72`；`scripts/delivery-mode/test_make_packet.py:763-766`
- 已证实
- 问题：只要看到 `LEGACY_MIGRATION_COUNT` 和 `AUDIT_READ_TABLES` 就 `return None`，不再检查审计脚本能否覆盖包的目标版本。测试甚至明确断言 `AUDIT_READ_TABLES = Object.freeze([])` 时 `target=500` 也通过。出包阶段的第二道防线被削弱，只剩仓库里的 `check-audit-schema-range`。
- 证据：
  ```python
  if len(re.findall(r'^export const LEGACY_MIGRATION_COUNT = [0-9]+;$', text, re.M)) == 1 and 'export const AUDIT_READ_TABLES' in text:
      return None
  ```
  ```python
  self.write_audit_copy('export const LEGACY_MIGRATION_COUNT = 95;\nexport const AUDIT_READ_TABLES = Object.freeze([]);\n')
  self.assertIsNone(checks_runner.audit_script_problem(self.packet, 500))
  ```
- 建议：至少要求 `AUDIT_READ_TABLES` 非空、`LEGACY_MIGRATION_COUNT` 与包内冻结清单一致，并对目标提交里碰审计表的时间戳迁移检查是否在 `AUDIT_REVIEWED_MIGRATIONS` 中。

### 6. ADR 承诺的“快照不匹配时库文件一个字节都不变”没有自动用例
- 文件: `docs/adr/0265-...md:183`；`packages/persistence-sqlite/test/migration-ids.contract.test.ts`（全文件）
- 已证实（通读测试文件未找到按字节比较的用例）
- 问题：现有测试只断言 `SNAPSHOT_REQUIRED` / `SNAPSHOT_INVALID` 错误码，没有在错误前后比较数据库文件字节；也没有覆盖“旧 5 列库没有待跑迁移时，不加列、不写库”。虽然从代码看 `verifySnapshot` 位于 `ensureLedgerIdColumn` 之前，写操作确实在快照核对之后，但缺少反向验证。
- 证据：`migration-engine.contract.test.ts:98-101` 只断言错误码；`migration-ids.contract.test.ts` 没有 `readFileSync(databasePath)` 前后比较。
- 建议：补两条用例：坏快照前后数据库字节完全一致；旧 5 列库无待跑迁移时列数/字节不变。

### 7. packet 模板中审计脚本的硬编码摘要仍是旧值，刷新逻辑不更新它们
- 文件: `scripts/delivery-mode/packet-template/acceptance/cloud/question-12-inputs.json:43`、`r2l6-source-manifest.json:39-43`、`carry-forward-audit.json:317-323`、`adaptation-manifest.json:107-112`；`scripts/delivery-mode/make-packet.py:557-577,580-594`
- 推测/未核实
- 问题：`scripts/operations/workspace-lifecycle-audit.mjs` 已改，但上述清单里的摘要仍指向旧内容（例如 `question-12-inputs.json` 写 `1a4a06...`，`adaptation-manifest.json` 写 `933cc99e...`）。`refresh_carried_copies` 只刷新 `adaptation-manifest.json` 和实际副本，`regenerate_hashes` 只刷新 `cloud-inputs.draft.json` 与 OWNED-SUMS，不更新 `question-12-inputs.json`、`r2l6-source-manifest.json`、`carry-forward-audit.json`。我没有找到在父级验收链路里会校验这些文件的读取方，因此标未核实；若存在，验收会失败。
- 建议：确认 `question-12-inputs.json` / `r2l6-source-manifest.json` 的实际校验方；若参与验收，纳入 `refresh_carried_copies` 或 `regenerate_hashes`，否则明确它们是历史记录。

### 8. 两个“集合身份”函数的契约略有不一致
- 文件: `packages/persistence-sqlite/src/migration-engine.ts:779-813, 957-964`
- 已证实
- 问题：`readSchemaIdentity` 的 `ids` 明确 `sort()`，而 `describeMigrationSet` 直接按 `migrations.map` 顺序返回，未排序；ADR 对 `SchemaIdentity` 的描述是“排好序的编号”。另外 `bundledSchemaFingerprint` 不对时间戳 id 做 `validateDefinitions` 那套重复/递增校验，和 `loadBundledMigrations` 的合法性判断不完全一致。目前调用方都传入已排序/已加载的集合，未造成实际故障，但属于后续容易踩的契约裂缝。
- 证据：
  ```ts
  ids: Object.freeze(migrations.map((migration) => migration.id)),
  ```
  ```ts
  ids: Object.freeze(ledger.map((record) => record.id).sort()),
  ```
- 建议：让 `describeMigrationSet` 也排序，或在接口注释里明确“ids 顺序不保证”；`bundledSchemaFingerprint` 可复用与 `loadBundledMigrations` 相同的文件分类校验。

---

## 侧重检查

我按“错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档一致性”逐项核对：

- **错误路径**
  - 快照缺失/不匹配：`applyMigrations` 在 `verifySnapshot` 前只做 `ensureInternalSchema`（`CREATE TABLE IF NOT EXISTS`）和读账本；加列/加索引/first migration 在 `verifySnapshot` 之后、同一 `IMMEDIATE` 事务内（`migration-engine.ts:1096-1138`）。结论：代码结构正确；缺按字节验证用例（见问题 6）。
  - 未知已应用迁移：`validateLedger` 按 id 查定义，找不到即 `UNKNOWN_APPLIED_MIGRATION`（966-1004）。正确。
  - 编号重复/乱序：`validateDefinitions` 对 4 位基线要求补零编号，对 14 位要求严格递增并查重（841-857）。正确。
  - 同数不同集合：`assertWritableSchema` 在 `currentSequence === writerSequence` 时比较指纹（1163-1173）；`applyMigrations` 和 admin 命令均传入期望指纹。正确。
  - 无法识别的迁移文件：`loadBundledMigrations` 与 `bundledSchemaFingerprint` 都抛 `DEFINITION_INVALID`。正确。
  - 畸形 S0 / 缺失摘要：发现 fail-open（问题 1）。
  - 旧库待跑迁移：发现误拒（问题 2）。

- **不可信输入**
  - `migration_id`：引擎按 id 查定义、核对 name/phase/digest；S0 / maintenance / audit 都把 NULL 按 `sequence` 补零；非 14 位的非空 id 会在引擎侧变成未知迁移。逐处核对通过。
  - `migrationIds` / `migrationDigests`：S0 产生，make-packet 按位置 zip；两边顺序都来自 `ORDER BY sequence`。映射本身正确，问题是缺失时降级。
  - `.meta.json`：只认 `alters` / `removes`；非法 JSON 会直接抛错，不会静默通过。可接受。
  - 迁移文件名：生成器用 `^[a-z][a-z0-9_]*$` 和 `wx` 创建，无路径穿越；打包/引擎都用固定正则，未识别文件直接拒绝。

- **安全**
  - 影子库执行不可信 SQL：`foreign_keys = ON`；`ATTACH`、`VACUUM`、`load_extension`、`writable_schema` 被拒绝（`analyze.mjs:4-9,48-51,140-143`）。未发现可逃出影子库的 SQL 写法（`better-sqlite3` 不提供 SQLite CLI 的 `readfile()` 等）。
  - `migration_id` 部分唯一索引防止新式 id 重复；旧行保持 NULL。
  - 迁移应用/打包生成属于不可逆写操作，依赖同机快照；本次改动没有削弱快照检查。

- **资源耗尽**
  - `analyzeMigrations` 对每个新增迁移和每一对迁移都克隆内存库，最坏 O(n²)；ADR 已把这一风险列为接受，`make-packet` 调检查时有 300 秒超时；CI 侧无总超时，属于已知取舍。
  - `LATEST_MIGRATION_SEQUENCE` 在模块加载时同步 `readdirSync`；异常会直接抛，不会静默少算（但错误类型不是 `SqliteMigrationError`）。

- **规则/文档一致性**
  - `.agents/instructions/migrations.md`、`AGENTS.md` 与生成器/检查脚本一致。
  - ADR 128 与 133 自相矛盾；ADR 143、183 的承诺未完全落地；复核材料关于 `schema_fingerprint` 的说法错误（问题 3、4、6）。
  - `docs/incidents-and-gates.md` I-102 引用的反向用例确实存在（`migration-conflicts.test.mjs` 中的 CONFLICT/ORDER_DEPENDENT/MIGRATION_FAILS 用例）。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
**不会。** 本次改动只涉及 SQLite 迁移引擎、管理命令、打包/运维脚本、审计脚本和文档。我在 `packages/prompt-catalog` 和 `packages/runtime-pi/src` 中搜索 `migration`、`schemaSequence`、`fingerprint`，没有任何命中；迁移编号、账本和指纹都没有进入系统提示、工具定义、历史或遮盖结果。发给模型的内容仍然只在末尾追加，本次也没有新增任何“每轮会变的值”。依据 `prompt-prefix.md#rules`。

### 2. 会不会让同一段文字在不同请求里变成不同字节？
**不会（模型侧无改动）。** 迁移指纹本身也是确定的：`migrationSetFingerprint` 先按 id 排序，只包含 `id + digest`，不含 `applied_at`、时间或目录遍历顺序；`readSchemaIdentity` 的 `ids` 也排序。唯一的非确定性来源是账本里的 `applied_at` 和 S0 的 `checkedAt`，但它们不参与指纹，也不会进入模型请求。另有一个潜在契约问题：`describeMigrationSet().ids` 未排序（问题 8），但指纹仍排序，目前不影响字节一致性。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？
- 有的：`migration-ids.contract.test.ts` 覆盖按集合判断、晚合较小 id、重复/乱序、同数不同集合、指纹顺序无关、打包指纹与加载集合一致、未识别文件；`migration-conflicts.test.mjs` 覆盖晚合删除、重复行、外键、已应用摘要被改、未知 applied id、旧迁移文件被改/删/改名；`audit-schema-range.test.mjs` 覆盖旧计数不一致、新增四位文件、审计表未复核；`test_make_packet.py` 覆盖时间戳文件计数、晚合规划、S0 集合不一致、摘要传递。
- 反向用例质量总体可以：我核对了 `counts duplicate rows`、`late small migration that only deletes rows` 两个用例，按旧代码的 `Set` 实现确实会漏报，因此能起到反向门槛作用。
- 缺口：没有“快照失败库文件字节不变”的用例（问题 6）；没有 packet fixture 覆盖 6 列账本（问题 4）；`--applied id:digest` 的 CLI 解析只有字符串层面的构造测试，没有直接跑 CLI 的 parser；`checkAgainstApplied` 的旧库待跑迁移路径没有被任何真实用例覆盖（问题 2）。
- 作者说“测试已通过”，我只被允许读文件、不能执行测试，因此**未核实**。

### 4. 改动产生/修改的每个值，使用它的地方都能接受吗？
逐项核对（产生 → 使用）：
- `migration_id`：`ensureLedgerIdColumn` / `INSERT` 产生 → `readMigrationLedger`、`read-s0-db.mjs`、`maintenance-common.mjs`、`workspace-lifecycle-audit.mjs`、测试消费。NULL、缺列、14 位 id 都能处理；非空但非法的值会在引擎侧变成未知迁移。通过。
- `migrationIds` / `migrationDigests`：`read-s0-db.mjs` 产生 → `make-packet.py` 消费；其它 S0 消费方忽略新增键。格式（4 位补零旧 id、14 位新 id、64 位 hex 摘要）与 `checkAgainstApplied` / `loadEntriesFromCommit` 的 id 规则一致。**但 digest 缺失时消费方降级而非拒绝（问题 1）。**
- `MIGRATION_LEDGER` 的 `sequence/name/phase`：`make-packet.migration_ledger` 产生 → `maintenance-common.verifyMigrationTransition` 消费；引擎按应用顺序写 sequence，两边都按 `current + offset + 1` 规划，晚合场景一致。通过。
- `sequence` 语义（应用顺序）：S9、raw-copy、hermes 脚本只检查 1..N 连续或取 `max(sequence)`；连续时 count == max。通过。
- `bundledSchemaFingerprint` / `describeMigrationSet` / `readSchemaIdentity`：格式一致（同一条 `migrationSetFingerprint`），消费方是 `assertWritableSchema`、admin data/memory/thread、recovery point、authority transfer、sandbox reservation admin。四处都传入同一算法产生的期望值。通过。
- `LEGACY_MIGRATION_COUNT` / `AUDIT_READ_TABLES` / `AUDIT_REVIEWED_MIGRATIONS`：审计脚本产生 → `check-audit-schema-range.mjs`、`check-migration-conflicts.mjs`、`run-packet-checks.py` 消费；前两者校验一致，`run-packet-checks.py` 只查标记存在（问题 5）。
- `schema_fingerprint`：**声称存在，实际不存在于 `schema_metadata`**（问题 3）。

总体：跨边界映射大多能对齐，但存在两个“应拒绝却降级/误拒”的路径（问题 1、2），以及出包阶段审计覆盖检查的弱化（问题 5）。
