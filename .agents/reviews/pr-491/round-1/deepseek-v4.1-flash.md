## 读代码证实的发现

### 高

**1. 高 — 冲突检查只看 schema 结构，检测不到数据改动和 CHECK 取值被删；ADR 里点名的 `perception_records` 场景实际会通过**
`scripts/migration-conflicts/analyze.mjs:13-16,95-126`

证据：
```js
const rows = database
  .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
  .all();
...
const diff = diffSnapshots(baseSnapshot, snapshot(database));
...
const declared = new Set(meta[entry.id]?.alters ?? []);
const changedExisting = [...diff.altered, ...diff.dropped].map(tableOf);
```
`snapshot` 只取 `sqlite_master` 的 DDL，`diffSnapshots` 只比较建表/索引语句；没有记录行数据、没有比较 CHECK 里的取值、也没有 `meta` 里的“去掉什么”字段。因此：
- 对已有表做 `DELETE`/`UPDATE`/`INSERT`（不改 schema）不会被发现；
- 单个迁移重建 `decision_ledger` 并删掉 `memory_review` 这个 CHECK 取值时，只会被归为 `altered table:decision_ledger`，只要 `.meta.json` 写了 `{"alters":["decision_ledger"]}` 就通过；
- 影子库没有生产数据，`INSERT INTO new SELECT ...` 不会因旧数据违反新 CHECK 而失败。

这和 ADR 0265「冲突怎样自动发现」第 1、2 条（临时触发器记录数据写入、逐项比较被去掉的列/索引/约束/CHECK 取值）以及 I-102 中“真冲突在合并前自动拦下”的说法不一致。建议：对每张已存在的表做规范化内容快照（按主键排序/摘要），比较 `sqlite_master` 中 CHECK 表达式与列/索引集合；为 `.meta.json` 增加明确的“remove”清单并逐项核对；补 `perception_records` 单迁移重建、`UPDATE`/`DELETE` 已有数据两类反向用例。

**2. 高 — 冲突检查只对“本分支新增”的迁移两两比顺序，不检查新增迁移与 main 已有迁移的顺序；打包重放也只跑一个顺序**
`scripts/check-migration-conflicts.mjs:124-129`、`scripts/migration-conflicts/analyze.mjs:128-157`

证据：
```js
const ref = baseRef();
const known = baseFileNames(ref);
const base = [...legacy, ...(known ? stamped.filter((entry) => known.has(entry.file)) : [])];
const added = known ? stamped.filter((entry) => !known.has(entry.file)) : stamped;
problems.push(...analyzeMigrations({ base, added, meta: loadMeta(added) }));
```
```js
const sorted = [...added].sort(...);
for (...) for (...) {
  ...
  const forward = cloneFrom([...base, left, right]);
  ...
  const reverse = cloneFrom([...base, right, left]);
```
`analyzeMigrations` 的顺序比较只覆盖 `added` 内部；`base`（main 已有迁移）从不参与两两比较。PR 一旦把 main 合进分支，`merge-base` 变成 main 尖端，main 迁移全部进入 `base`，于是“晚合入的小号迁移”和 main 迁移之间的顺序差异被漏掉。`check-migration-replay --commit` 的 `replayAll([...legacy, ...stamped])` 也只按编号顺序跑一次，不是生产顺序。这正是 ADR 说已经从 `merge-base` 方案改掉、但代码仍保留的行为。建议：把 `base` 和 `added` 合并成完整集合，同时比较“生产顺序（base+added）”和“编号顺序（全排序）”的结构/数据结果；并在 main 合并后、打包时对完整集合跑两种顺序。

**3. 高 — 禁止语句正则漏掉合法写法 `ATTACH 'file' AS x`，影子库可逃逸访问宿主机文件**
`scripts/migration-conflicts/analyze.mjs:3-7`

证据：
```js
const FORBIDDEN = [
  { pattern: /\battach\s+database\b/i, label: "ATTACH DATABASE" },
  { pattern: /\bvacuum\s+into\b/i, label: "VACUUM INTO" },
  { pattern: /\bload_extension\b/i, label: "load_extension" },
];
```
SQLite 的语法是 `ATTACH [DATABASE] expr AS schema-name`，`ATTACH '/tmp/x.db' AS other;` 不写 `DATABASE` 也合法，当前正则不匹配；测试里的反向用例只覆盖了 `ATTACH DATABASE`。迁移会在内存影子库中执行，`ATTACH` 可读写宿主机文件。建议改成 `/\battach\b/i` 或按 SQL 语句解析（并处理注释；`VACUUM/**/INTO` 同理），加 `ATTACH '/tmp/x' AS x` 的反向用例；同时考虑拦 `PRAGMA writable_schema` 等可破坏 schema 的语句。

### 中

**4. 中 — 没有待跑迁移时提前返回，永远不会补 `migration_id` 列/索引，也不写 `schema_fingerprint`**
`packages/persistence-sqlite/src/migration-engine.ts:1099-1117`

证据：
```ts
const expectedFingerprint = migrationSetFingerprint(migrations);
if (pending.length === 0) {
  assertWritableSchema(database, migrations.length, expectedFingerprint);
  return { appliedSequences: [], currentSequence };
}
...
for (const migration of pending) {
  const applyOne = database.transaction(() => {
    ensureLedgerIdColumn(database);
```
`ensureLedgerIdColumn` 只在有待跑迁移的事务里调用；`writeSchemaMetadata` 也只在迁移事务里调用。生产库已经在 95、且本版本没有新迁移时，第一次上线不会执行 ADR 过渡步骤 2 说的“加 `migration_id` 列和部分唯一索引、写指纹”。作者“库里没有 `migration_id` 列时先加列”的说法在这个常见路径上不成立。现在功能上还能靠 `sequence` 推出旧编号，但文档承诺的过渡动作被推迟到下一个迁移。建议在 `pending.length === 0` 分支（无快照需求时）单独开事务做 `ensureLedgerIdColumn` 并写指纹，或至少补这个行为；加“95 号库、无待跑迁移”的测试。

**5. 中 — 沙箱预留管理命令的写路径仍只比数量，没有用指纹；与“管理命令用 `bundledSchemaFingerprint()`”的说法不符**
`packages/persistence-sqlite/src/sqlite-sandbox-reservation-administration.ts:21,293-310`

证据：
```ts
import { LATEST_MIGRATION_SEQUENCE, readMigrationLedger } from "./migration-engine.ts";
...
if (
  current < SANDBOX_RESERVATION_ADMIN_FIRST_SCHEMA ||
  current > LATEST_MIGRATION_SEQUENCE ||
  ...
  (writing && current !== LATEST_MIGRATION_SEQUENCE)
)
```
`confirm` 会写 `audit_records`、`sandbox_reservation_release_receipts`、`runs` 等；但判断只用 `current`（数量）。数量相同、集合不同的库在这里会通过。ADR 第 4 节明确把“沙箱预留管理”列进应改用 `readSchemaIdentity` 的地方。建议让它接收/构造 `bundledSchemaFingerprint()` 并像三个 admin-cli 命令一样传给统一的 `assertWritableSchema`，补同数量不同集合的反向用例。

**6. 中 — 恢复点、权限转移、导出清单仍只比整数版本，`schema_fingerprint` 只写不读；同数量不同集合的备份仍可能被恢复/转移**
`packages/persistence-sqlite/src/migration-engine.ts:1018`、`sqlite-recovery-point.ts:363-367`、`sqlite-authority-transfer.ts:395-399`、`apps/agent-service/src/production-data-export.ts:321`、`production-chat-export.ts:53`

证据：
```ts
statement.run("schema_fingerprint", fingerprint, updatedAt);
```
```ts
function schemaSequence(database) {
  return (database.prepare("SELECT MAX(sequence) FROM schema_migration_ledger")... ) ?? 0;
}
```
```ts
migrationSequence: LATEST_MIGRATION_SEQUENCE,
```
全仓没有读取 `schema_fingerprint` 的地方。恢复/转移清单只保存/比较 `schemaSequence`（数量），导出清单用的是二进制知道的 `LATEST_MIGRATION_SEQUENCE` 而不是数据库实际身份。ADR 第 4 节要求“所有读版本的地方只用 `readSchemaIdentity`”、给恢复点/权限转移/导出清单加可选 `schemaFingerprint`，这里没有实现。恢复是破坏性操作：同数量不同集合的备份会先被接受并替换当前数据，等下次服务启动才被 `applyMigrations` 拒绝。建议至少在这三类清单里写入并在读取时校验指纹（旧清单无字段时回退到数量比较）。

### 低

**7. 低/中 — 冲突检查不 fetch `origin/main`，找不到基准时静默用 `null`；与 ADR 要求不符**
`scripts/check-migration-conflicts.mjs:24-32,124-129`

证据：
```js
function baseRef() {
  const flag = process.argv.indexOf("--base");
  if (flag !== -1) return process.argv[flag + 1];
  for (const candidate of ["origin/main", "main"]) {
    try { return git(["merge-base", "HEAD", candidate]); } catch {}
  }
  return null;
}
```
ADR 写的是“检查开头自动 `git fetch origin main`，拿不到就失败，不默默放行”，并且已放弃用 `merge-base` 划分。现在是本地 `origin/main` 旧了也继续跑，且 `ref === null` 时把所有 timestamp 文件都当成本分支新增，结果不可靠。建议：显式 fetch（或要求 `--base`），拿不到就拒绝；基准用 main 当前的完整迁移集合。

**8. 低 — 顺序比较的 forward 重放不在 `try` 里；大量新迁移时是 O(n²) 全量重放且没有超时**
`scripts/migration-conflicts/analyze.mjs:138-157`

证据：
```js
const forward = cloneFrom([...base, left, right]);
let reverse;
try {
  reverse = cloneFrom([...base, right, left]);
} catch (error) {
  problems.push(`ORDER_DEPENDENT ...`);
```
如果两种顺序都失败（例如两个迁移插入相同主键），`forward` 会直接抛异常，脚本以堆栈退出而不是给出 `ORDER_DEPENDENT`/`FULL_REPLAY_FAILS` 问题项。每个 `added` 都要重建一次 base，再和所有其他 added 组合重建，迁移多时开销增长很快；ADR 说“有超时”，但 `check-migration-replay` 和脚本本身都没有超时。建议把 forward 也放进 `try/catch`，并在脚本或 `subprocess.run` 上加超时/规模上限。

**9. 低 — 文档与代码不一致：meta 的 phase/changeSet、生成器对 `origin/main` 的检查、审计脚本按版本号开关**
- `docs/adr/0265...` 说少数迁移可在 `.meta.json` 写 `phase`/`changeSet`；但 `migration-engine.ts:1355-1365` 的 `loadBundledMigrations` 固定 `phase: "expand"`、`changeSet: entry.name.replace(/_/g, "-")`，`make-packet.py:211-215` 也把时间戳迁移固定成 `expand`，`.meta.json` 只被冲突检查读取 `alters`。
- `scripts/new-migration.mjs:10-19,34` 只读本地目录（`nextMigrationId(readdirSync(directory))`），没有像 ADR 说的对照 `origin/main`。
- `scripts/operations/workspace-lifecycle-audit.mjs:60,96-...` 仍保留 `version >= 33/40/41/...` 这类按版本号开关，ADR 决定是改成查 `pragma_table_info`。
这些不是当前功能的直接故障，但会让后续迁移和审计脚本的行为与决策文档不一致。

**10. 低 — 打包脚本接受新的四位号迁移，而运行时冻结清单会拒绝它**
`scripts/delivery-mode/make-packet.py:123-143`、`packages/persistence-sqlite/src/migration-engine.ts:1320-1340` 附近

证据：
```py
legacy_match = re.fullmatch(r'([0-9]{4})_[a-z0-9_]+\.sql', name)
...
if not legacy or legacy != list(range(1, len(legacy) + 1)):
    refuse('PACKET_MIGRATIONS_NOT_CONTIGUOUS', legacy[-3:])
```
`make-packet` 只要求四位号连续，因此 target 提交里若出现 `0096_x.sql`，会把它计入 `TARGET_SCHEMA`；但引擎的 `bundledMigrationFiles` 冻结在 95，`loadBundledMigrations` 会把 0096 当“无法识别的文件”抛 `DEFINITION_INVALID`。CI 的 `check-audit-schema-range` 能拦住（该检查会报 `MIGRATION_NUMBERED_FILE_ADDED`），但打包脚本本身不拒绝。建议打包时同时对照引擎的 `bundledMigrationFiles`，或直接拒绝 legacy 数量之后的任何四位号文件。

---

## 推测 / 未核实

- **测试是否真的全部通过未核实**：环境只允许读文件和 git 命令，不能运行 `vitest`/`python`。下面的“测试缺口”来自读测试代码，不是运行结果。
- **构建产物是否包含新增的 `migrations/*.sql` 和 `.meta.json` 未核实**：`loadBundledMigrations` 依赖 `import.meta.url` 下的 `./migrations/`，但打包/构建配置不在本次 diff 中；如果构建只拷贝旧的 95 个文件，新迁移在产物里会消失。需要看构建配置确认。
- **`probe-source` 里的旧审计副本**：`scripts/delivery-mode/packet-template/acceptance/cloud/probe-source/scripts/operations/workspace-lifecycle-audit.mjs` 仍是 `version > 56` 的旧实现；`make-packet.refresh_carried_copies` 会根据 `r2l6-source-manifest.json` 的 `byteIdentical: true` 在打包时刷新它，所以当前不应直接算失败，但这条自动刷新链未实际运行验证。

---

## 侧重检查

查过的路径和结论：

- **错误路径**
  - `applyMigrations` 的“无待跑迁移”提前返回：确认会跳过列升级和指纹写入（发现 4）。
  - `analyzeMigrations` 的 forward 重放异常未捕获：一个会让“两个迁移都失败”的情况以堆栈退出（发现 8）。
  - `baseRef` 拿不到 `origin/main` 时返回 `null` 并继续：确认是静默降级（发现 7）。
  - `make-packet` 的 `check_migration_replay` 无超时；`subprocess.run` 调用链未设置 timeout（发现 8）。
- **不合规范或不可信的输入**
  - 新迁移文件名：engine、`make-packet`、`new-migration` 三处的 14 位/蛇形正则基本一致；`new-migration` 的 `validName` 能挡住路径穿越，`writeFileSync` 用 `wx` 防覆盖。
  - SQL 内容：禁区只拦三种写法，`ATTACH` 可省略 `DATABASE`，还可通过注释变形绕过（发现 3）；`PRAGMA writable_schema`、普通 DML 未拦（发现 1）。
  - `.meta.json`：冲突检查直接 `JSON.parse`，运行时完全不读；格式错误会以异常形式让检查失败，未做结构化校验。
- **安全**
  - 影子库是 `:memory:`，但 `ATTACH` 逃逸可达宿主机文件；这是本次最直接的安全缺口（发现 3）。
  - `check-migration-conflicts --commit`/`make-packet` 用 `execFileSync("git", args)` 传参，未发现 shell 注入；`new-migration` 路径校验也够。
- **资源耗尽**
  - `analyzeMigrations` 对所有 added 各克隆一次 base，再对 added 两两组合克隆正反顺序；迁移多时是 O(n²) 次完整重放，且无超时（发现 8）。
  - `git show` 的 `maxBuffer` 设了 256MB，未见无界读取。
- **不可撤销的操作**
  - 迁移本身有同机快照要求，`applyMigrations` 在事务内写 DDL/账本，失败会回滚；这部分比旧实现没有削弱。
  - 恢复点/权限转移的“同数量不同集合”不被指纹保护，恢复会先替换数据目录再等下次启动失败（发现 6）。
  - 沙箱预留管理的 `confirm` 是写操作，但只比数量（发现 5）。
- **规则/文档与代码一致性**
  - `prompt-prefix` 相关：未发现迁移值进入 prompt catalog/runtime-pi/application，见必答问题 1。
  - ADR 0265 的“数据写入比较”“CHECK 取值比较”“base+added 两种顺序”“所有读版本处用 `readSchemaIdentity`”“fetch origin/main”“meta 的 phase/changeSet”均与当前代码有偏差（发现 1、2、6、7、9）。

---

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？**

不会。改动集中在 `packages/persistence-sqlite` 的迁移引擎、审计脚本、打包脚本和 admin CLI；我在 `packages/prompt-catalog`、`packages/runtime-pi`、`packages/application/src` 中搜索 `migration`、`schema_migration`、`LATEST_MIGRATION`、`schema_fingerprint`，没有命中。请求组装顺序没有被改，没有新增系统提示/工具定义/历史内容；新增的迁移编号、指纹、`migrationIds` 都只存在于数据库、S0/打包产物和运维日志中，不在模型请求里。按 `prompt-prefix` 规则，这属于“不改变已发内容、不引入每轮变化值”，仍然只在末尾追加，未发现把时间/路径/哈希写进请求头的改动。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**

对模型请求不会。新指纹是确定性的：`migrationSetFingerprint` 先按 id 排序再拼 `<id> <digest>\n`（`migration-engine.ts:770-779`），`readSchemaIdentity.ids` 也排序；`bundledSchemaFingerprint` 虽然用 `readdirSync` 取文件，但最终经同一个排序函数。没有把时间、随机数或数据库返回顺序带进指纹。`new-migration.mjs` 用的时间只进文件名；S0 的 `checkedAt`、`writeSchemaMetadata` 的 `appliedAt` 等是数据库/运维 JSON 的时间字段，不是模型请求文本。没有发现“同一段提示词文字因前后文或遮盖变成不同字节”的机制。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

有检查，但不是所有声称的反向用例都有：
- 已存在：`packages/persistence-sqlite/test/migration-ids.contract.test.ts`（重复/乱序 id、同数量不同集合、晚合小号、按 id 记录）；`test/tooling/migration-conflicts.test.mjs`（重复 id、未声明改表、两个重建同表、依赖另一个新迁移、禁止语句、坏 SQL、生成器）；`test/tooling/audit-schema-range.test.mjs`（新迁移碰审计表、未 review、新增四位号）；`scripts/delivery-mode/test_make_packet.py`（时间戳计数、晚合小号规划、未识别文件、生产库外来 id、同数量不同集合拒绝、目标提交重放失败）。
- 缺失的反向用例：DELETE/UPDATE 已有数据、删掉 CHECK 取值（`perception_records` 场景）、新增迁移与 main 已有迁移的顺序差异、`ATTACH 'file' AS x`（不带 `DATABASE`）、无待跑迁移时补 `migration_id`、沙箱预留管理同数量不同集合、恢复点/权限转移/导出清单的同数量不同集合。
- `test/tooling/migration-conflicts.test.mjs` 直接调用 `analyzeMigrations`，没有覆盖 `check-migration-conflicts.mjs` 的 `git fetch`/merge-base 行为；`DerivedExpectationsTest` 还把 `check_migration_replay` patch 掉了，所以打包脚本的“真重放”路径缺少端到端反向用例。
- “作者说测试已通过”未核实（工具限制，不能运行测试）。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**

逐项核对：
- **`migration_id`**：engine 对 legacy 写 `NULL`、对新迁移写 14 位 id（`migration-engine.ts:1120-1131`）；engine 读取时用 `NULL` 回退到 4 位 `sequence`（`readMigrationLedger`），S0、`maintenance-common.mjs:931-938`、审计脚本都同样回退。两端格式一致，能接受。
- **`sequence`**：新含义是“第几个被应用”，仍保证 1..N 连续；S0 的 `ledger.length === current`、`maintenance-common` 的 `sequence === index+1`、S9、raw-copy、worker 的 `current_sequence` 都按连续计数使用，能接受。注意定义里的 `definition.sequence` 在晚合小号时要和账本 `sequence` 不同，现有代码已按 id 对齐、不再混用这两者。
- **`schema_fingerprint`**：产生于 `writeSchemaMetadata`（`migration-engine.ts:1018`），但全仓没有读取者；`assertWritableSchema` 虽然接受 `expectedFingerprint`，但恢复点、权限转移、导出清单和沙箱预留管理都没有使用它。这个值的“使用方”不完整，属于发现 6。
- **`migrationIds`**：S0 输出（`read-s0-db.mjs:79,89`），`make-packet.py:398` 消费；finalize 不校验 S0 顶层字段集合，额外字段可接受。旧 S0 没有该字段时 `make-packet` 回退为“按前 N 个 id”，如果生产库曾晚合小号，这个回退会规划错；新 S0 总带该字段，风险主要留给旧包。
- **id 格式与后端校验**（I-73 角度）：`new-migration` 生成 `[0-9]{14}` 和 `[a-z][a-z0-9_]*`；engine 的 `^\d{14}$`/`^[a-z][a-z0-9_]*$`、`make-packet` 的 `[0-9]{14}_[a-z][a-z0-9_]*\.sql`、S0 的字符串 id、legacy 的 `%04d` 都能对上。`LEGACY_MIGRATION_COUNT` 在 engine 和审计脚本里都是 95，`check-audit-schema-range` 会核对两边；这部分一致。
- **`TARGET_SCHEMA`/`CURRENT_SCHEMA`**：仍是数量，`make-packet.target_schema()` 返回 `len(target_migration_ids)`，S0 的 `current` 是 `current_sequence`，两边一致。
- **`MIGRATION_LEDGER`/`migrationExpectedLedger`**：`make-packet` 按“应用顺序”填 `sequence`，`maintenance-common.verifyMigrationTransition` 和 `migrateDatabase` 都按应用顺序校验 `appliedSequences`，一致。
- **`AUDIT_READ_TABLES`/`AUDIT_REVIEWED_MIGRATIONS`**：审计脚本声明、`check-audit-schema-range` 消费，当前清单和代码引用表基本对得上；但清单是手工维护的，新增审计读取表不会自动发现（发现 9 的低风险部分）。

总体：编号/数量的两端校验基本闭合；**指纹这一路是“只生产不消费”**，恢复、转移、导出、沙箱预留管理仍停在数量比较，不能算每一个使用方都接受了新语义。
