## 结论摘要

这次改动本身没有触及模型请求的组装路径。迁移集合、指纹、`migration_id`、S0 的 `migrationIds` 都只在持久化、审计、打包和交付脚本里流转，我没有发现它们进入系统提示、工具定义或历史消息的代码路径；增量的 `describeMigrationSet` 排序修复也让指纹更确定。主要问题集中在**合并/打包安全门槛的失败路径与文档承诺不一致**，以及**快照仍按旧的数量语义校验**。

## 读代码证实的问题（按严重度）

### 1. 中：`check:migration-conflicts` 在 `git fetch` 失败时静默使用陈旧的 `origin/main`，与 ADR 的“拿不到就失败”相反

- 文件:行：`scripts/check-migration-conflicts.mjs:26-40`
- 问题：ADR 明确说“检查开头自动 `git fetch origin main`，拿不到就失败，不默默放行”（`docs/adr/0265-migrations-get-unique-ids-and-merge-in-any-order.md:231`），但代码把 fetch 异常吞掉了，随后退回本地 `origin/main`/`main`。如果本地 `origin/main` 落后于真实 main，`merge-base` 会偏旧，分支点之后 main 新增的迁移不会被纳入“本分支新增”分析，真冲突会被延后到打包阶段才可能发现。
- 证据：

```js
// scripts/check-migration-conflicts.mjs:26-40
function baseRef() {
  ...
  try {
    git(["fetch", "--quiet", "origin", "main"]);
  } catch {}
  for (const candidate of ["origin/main", "main"]) {
    try {
      return git(["merge-base", "HEAD", candidate]);
    } catch {}
  }
  ...
}
```

```md
<!-- docs/adr/0265-...md:231 -->
- 合并前本地检查依赖 `origin/main` 是最新的；检查开头自动 `git fetch origin main`，拿不到就失败，不默默放行。
```

- 建议：fetch 失败时以非零码退出，除非显式传了 `--base`（离线/特殊场景）。增加反向用例：fetch 失败且本地 `origin/main` 存在时，检查必须失败。注意：打包时的 `--commit --applied` 还会再分析一次 pending 集合，所以这不是“必然上线坏库”，但确实削弱了 ADR 承诺的合并前硬门槛。

### 2. 中：打包硬门槛只核对已应用迁移的摘要，不核对迁移名/文件身份；`--commit` 路径也不检查现有文件是否被改名

- 文件:行：`scripts/migration-conflicts/analyze.mjs:361-375`、`scripts/check-migration-conflicts.mjs:160-186`
- 问题：`checkAgainstApplied` 按 `id` 找条目后只比较 SQL 的 SHA-256；迁移名不参与比较。`--commit` 分支也没有调用 `changedExistingFiles`。因此，“把一个已应用的 timestamped 迁移改名为同 id、同内容的另一个名字”可以同时通过：
  - 打包前的 `check-migration-replay --commit ... --applied ...`（id 和摘要都没变）；
  - `replayAll`（只关心能否执行）；
  - 传入的 `migrationIds/migrationDigests` 检查。

  但运行时的 `validateLedger` 会比较 ledger 里的 `name` 和按新文件名解析出的 `definition.name`（`packages/persistence-sqlite/src/migration-engine.ts:988-1002`），于是部署启动时才会报 `DIGEST_MISMATCH` 并拒绝。ADR 说“打包前核对已应用的迁移文件没被改过”（`docs/adr/0265-...md:140`），这里只核对了内容，没有核对文件身份/名字。
- 证据：

```js
// scripts/migration-conflicts/analyze.mjs:364-374
for (const { id, digest } of applied) {
  const entry = byId.get(id);
  if (!entry) { ... }
  if (digest && createHash("sha256").update(entry.sql).digest("hex") !== digest) {
    problems.push(`APPLIED_MIGRATION_CHANGED ...`);
  }
}
```

```js
// scripts/check-migration-conflicts.mjs:162-169
if (commitFlag !== -1) {
  const { legacy, stamped, unknown } = loadEntriesFromCommit(...);
  ...
  problems.push(...replayAll([...legacy, ...stamped]));
  // 没有调用 changedExistingFiles
```

- 建议：让 S0 同时带上 `migrationNames`（或让 `--applied` 接受 `id:name:digest`），在 `checkAgainstApplied` 中比较名字；或者在 `--commit` 路径对目标提交的迁移目录做一次“相对 main 历史未改名/未删除”的检查。增加“改名但内容不变”的反向用例。

### 3. 中：迁移前快照只按“数量”校验，未校验集合/指纹；在新的集合语义下，同数量不同集合的快照也会被接受

- 文件:行：`packages/persistence-sqlite/src/migration-engine.ts:1046-1061`、`1074-1084`、`1099-1108`、`1311-1315`
- 问题：`currentSequence` 现在只是“已应用迁移的数量”（`ledger.length`），`verifySnapshot` 仍只比较 `snapshot.schemaSequence === currentSequence`，并检查快照文件摘要和账本最大 `sequence`。快照里到底是哪些迁移、摘要是什么，没有和当前库或程序清单比较。生产调用方（admin CLI `db.migrate`、权限转移导入）通常是从同一个 `database` 现场创建快照，所以现实风险有限；但 `applyMigrations` 是公开 API，传入一个同数量、不同集合的合格快照仍然会通过“上线前必须有同机快照”的门槛。这正是本次改动引入“数量不再能识别集合”的后果。
- 证据：

```ts
// migration-engine.ts:1046-1061
if (
  snapshot.host !== hostname() ||
  snapshot.sourceDatabasePath !== database.name ||
  snapshot.schemaSequence !== currentSequence ||
  snapshotDigest !== snapshot.digest
) { ... }
```

```ts
// migration-engine.ts:1074-1084
const snapshotSequence = readMigrationLedger(snapshotDatabase).at(-1)?.sequence ?? 0;
if (snapshotSequence !== snapshot.schemaSequence) { ... }
```

```ts
// migration-engine.ts:1311-1315
return Object.freeze({
  ...
  schemaSequence: sourceSequence,
  digest: sha256(readFileSync(absoluteSnapshotPath)),
```

- 建议：给 `VerifiedMigrationSnapshot` 增加集合指纹（例如 `schemaFingerprint`），在 `createVerifiedMigrationSnapshot` 中从快照账本计算，在 `verifySnapshot` 中与当前库 `readSchemaIdentity(database).fingerprint` 比较；增加“同数量不同集合的快照必须拒绝”的反向用例。

### 4. 低：`checkAgainstApplied` 在缺少摘要时直接跳过“已应用迁移被改过”的检查

- 文件:行：`scripts/migration-conflicts/analyze.mjs:364-375`；CLI 解析在 `scripts/check-migration-conflicts.mjs:170-178`
- 问题：`if (digest && ...)` 意味着 `--applied 0001`（没有 `:摘要`）会被当成合法的已应用记录，且不做任何内容核对。`make-packet.schema_parameters` 现在会拒绝缺失/空摘要（`scripts/delivery-mode/make-packet.py:404-410`），但函数本身和 CLI 仍允许这种输入；如果以后有别的调用方直接调 `checkAgainstApplied` 或 CLI，就会静默绕过检查。
- 证据：

```js
// analyze.mjs:370
if (digest && createHash("sha256").update(entry.sql).digest("hex") !== digest) {
```

```js
// check-migration-conflicts.mjs:172-178
const applied = process.argv[appliedFlag + 1]
  .split(",")
  .filter(Boolean)
  .map((item) => {
    const [id, digest] = item.split(":");
    return { id, digest };
  });
```

- 建议：对已应用条目强制要求非空摘要；在 `checkAgainstApplied` 里对空/缺摘要报 `APPLIED_MIGRATION_DIGEST_MISSING`，并补反向用例。现有 `test_make_packet.py` 只覆盖了打包侧。

### 5. 低：ADR 说“晚合的小号照跑，写日志”，代码没有写日志

- 文件:行：`packages/persistence-sqlite/src/migration-engine.ts:1099-1141`；文档：`docs/adr/0265-...md:127`
- 问题：`pending` 的筛选和 `sequence = applied.length + 1` 都按预期执行，但没有任何“该迁移的 id 小于库中已应用最大 id / 晚合补跑”的日志输出。ADR 承诺“写日志”，代码里找不到对应输出。
- 证据：

```ts
// migration-engine.ts:1100-1101
const appliedIds = new Set(ledger.map((record) => record.id));
const pending = migrations.filter((migration) => !appliedIds.has(migration.id));
```

```md
<!-- ADR:127 -->
- 一个迁移的编号比库里已跑的最大编号还小时（“晚合的小号”），照跑，写日志。
```

- 建议：在发现待跑 timestamped id 小于已应用 timestamped 最大 id 时输出一条结构化日志（含旧最大 id、本次 id、应用后的 sequence），或者把 ADR 改成“目前不写日志”。

### 6. 低：规则文件仍提到已被删除的 `SUPPORTED_SCHEMA_MAX`

- 文件:行：`.agents/instructions/migrations.md:9`
- 问题：规则文件仍写“不要改 `SUPPORTED_SCHEMA_MAX`”，但本 PR 已把仓库审计脚本改成 `LEGACY_MIGRATION_COUNT` + `AUDIT_READ_TABLES`/`AUDIT_REVIEWED_MIGRATIONS`，`SUPPORTED_SCHEMA_MAX` 只在 `run-packet-checks.py` 对旧包副本的兼容分支里出现。新线程按规则文件会去找一个不存在的常量。
- 证据：

```md
<!-- .agents/instructions/migrations.md:9 -->
- 新迁移一律用 ... 不要手写编号，不要向 `bundledMigrationFiles` 加条目，也不要改 `SUPPORTED_SCHEMA_MAX` 或写死迁移数量的测试；0001 到 0095 已冻结。
```

- 建议：改成“不要改冻结清单 / 审计脚本里的 `LEGACY_MIGRATION_COUNT`、`AUDIT_READ_TABLES`、`AUDIT_REVIEWED_MIGRATIONS` 这些共用行”，或直接说明由 `check:migration-conflicts` / `check:audit-schema-range` 处理。

## 推测 / 未核实

- **打包硬门槛对“已合并但尚未部署”的迁移改名/改内容**：仓库 PR 检查通过 `changedExistingFiles` 能覆盖大多数情况；但 `--commit` 路径没有这项检查。若存在直接推 main 或绕过 PR 检查的路径，打包阶段不会发现，部署启动时才会因 `name`/`digest` 不匹配拒绝。影响是“部署失败但可回滚”，不是静默坏库。未核实是否存在直接推 main 的路径。
- **对旧提交生成交付包**：`make_packet.target_schema()` 现在会调用 `check_migration_replay(commit)`，而 `check-migration-conflicts --commit` 要求 legacy 文件数恰好等于 `LEGACY_MIGRATION_COUNT`（当前 95）。`test_make_packet.py` 的 `DerivedExpectationsTest.setUp` 直接 patch 掉了这个调用，说明对冻结前的旧提交（例如测试用的 56）无法再直接跑这条检查。若交付流程确实需要为远早于冻结点的提交出包，这是行为变化；若只回滚到紧邻的 95/96 版本，则不受影响。未核实交付流程是否支持更老的目标。
- **审计运行时不再拒绝“更高的未知时间戳迁移”**：新测试明确让它通过（`test/integration/workspace-lifecycle-audit.test.ts:506-514`），且 ADR 说这是有意的取舍。代价是打包检查 `run-packet-checks.py:68-70` 对带新常量的审计脚本直接放行，不再验证新迁移是否碰过 `AUDIT_READ_TABLES`；这项复核只剩仓库检查。若绕过仓库检查直接出包，审计表被改的风险不会被包检查拦住。属于已声明的设计取舍，不是代码 bug。

## 侧重检查

我按额外侧重查看了这些路径，结论如下：

- **错误路径**
  - 老库无 `migration_id` 列：`readMigrationLedger` 用 `sequence` 补 `0001`…`0095`，S0、audit、maintenance、fingerprint 都能接受（`migration-engine.ts:922-935`、`read-s0-db.mjs:78-80`、`maintenance-common.mjs:931-938`）。未发现崩溃。
  - 缺快照：`applyMigrations` 在 `ensureLedgerIdColumn` 之前调用 `verifySnapshot`，测试证明不写文件（`migration-ids.contract.test.ts:272-298`）。符合约束。
  - 同数量不同集合：`assertWritableSchema`、权限转移、恢复点、沙箱预留管理都有指纹反向用例；但快照校验仍只按数量（见问题 3）。
  - 未知已应用迁移：`validateLedger` 按 id 查定义，未知 id 抛 `UNKNOWN_APPLIED_MIGRATION`（`migration-engine.ts:980-987`），回滚保护保留。
- **不合规范/不可信输入**
  - 迁移文件名：引擎和打包脚本都拒绝既非旧四位、也非 14 位时间戳、也非对应 meta 的文件（`migration-engine.ts:1336-1345`、`make-packet.py:123-141`）。未发现静默忽略。
  - ledger/S0 的 id/摘要：S0 从账本现算，打包侧校验长度和空值（问题 4 的 CLI 缺口除外）。
  - `.meta.json`：解析失败会抛异常，不会静默放过。
- **安全**
  - 冲突检查在内存影子库执行迁移，并拒绝 `ATTACH`、`VACUUM`、`load_extension`、`writable_schema`（`analyze.mjs:4-8`、`withoutComments`/`forbiddenOutsideLiterals`）。我没有发现可静态绕过的写法；`ATTACH`/`VACUUM INTO`/注释拆词都有测试。
  - `new-migration.mjs` 使用固定 git 参数和 `wx` 写入，名字有正则校验，未发现路径注入。
- **资源耗尽**
  - 打包调用冲突检查有 5 分钟超时（`make-packet.py:148-157`）；仓库 `npm run check:migration-conflicts` 本身没有总超时，`analyzeMigrations` 对新增迁移做 O(n²) 的两两比较和多次影子库重放。ADR 已接受这个风险，靠 CI 作业超时兜底。未发现新的无界循环。
- **不可撤销操作**
  - `migration_id` 加列和唯一索引、迁移 SQL、账本写入都在同一个 `IMMEDIATE` 事务里（`migration-engine.ts:1116-1137`），失败会整体回滚。
  - 没有待跑迁移时不加列、不写文件，有测试覆盖（问题 3 的快照集合校验除外）。
- **规则/文档与代码一致性**
  - 发现：ADR 的 fetch 失败承诺（问题 1）、ADR 的“写日志”（问题 5）、规则文件的 `SUPPORTED_SCHEMA_MAX`（问题 6）。
  - `docs/incidents-and-gates.md` 的 I-46 仍描述旧的 `SUPPORTED_SCHEMA_MAX` 门槛，但它是历史事故记录；新的 I-102 已指向新检查。未把它列为问题，只提示以后改门槛时注意别把历史记录当成现行规则。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**没有发现改变。** 本次 diff 的文件集中在 `packages/persistence-sqlite`、`apps/admin-cli`、`scripts/delivery-mode`、`scripts/operations`、`scripts/migration-conflicts`、测试和文档；没有改 `packages/prompt-catalog`、`packages/runtime-pi` 的请求组装。我在这两个目录搜索 `migration`、`schemaSequence`、`migrationSequence` 等，没有命中会把这些值写进提示词/历史的路径。

因此发给模型的内容仍然只在末尾追加；“每轮会变的值放在最后一条消息”这条约束没有因本次改动而改变。迁移编号/指纹不在模型请求里，**未发现**会影响 KV 缓存前缀的新字段。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 关键实现是确定性的：

- `migrationSetFingerprint` 先按 `id` 排序再拼接 `id + digest`，不包含 `applied_at`、时间戳或数据库返回顺序（`migration-engine.ts:770-777`）。
- `readSchemaIdentity` 从账本读取后也把 `ids` 排序（`migration-engine.ts:957-964`）。
- `describeMigrationSet` 在增量提交里把 `ids` 改成 `.sort()`（`migration-engine.ts:807-812`），与指纹的排序一致。
- `bundledSchemaFingerprint` 也最终走同一个排序函数（`migration-engine.ts:779-805`）。

唯一理论上的例外是“账本里出现重复 id 且摘要不同”的非法库：`sort` 对同 id 元素是稳定的，结果会依赖读入顺序；但 `ensureLedgerIdColumn` 建了非空唯一索引，`validateDefinitions` 也拒绝重复 id，正常路径不会出现。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

**有自动检查，覆盖面总体不错：**

- `packages/persistence-sqlite/test/migration-ids.contract.test.ts`：加载旧清单、按 id 记录新迁移、晚合小号、未知迁移、同数量不同集合、重复/乱序 id、指纹与持久化目 fingerprint 一致、缺快照不写、无待跑不加列。
- `test/tooling/migration-conflicts.test.mjs`：独立新表、参照表插行、同表重建冲突、未声明改动、删除取值、ATTACH/VACUUM/writable_schema、依赖其他新迁移、生产顺序 vs 新库顺序、已应用迁移被改、晚合小号、生成器命名等。
- `test/tooling/audit-schema-range.test.mjs` 和 `scripts/delivery-mode/test_make_packet.py`：审计表触碰审查、legacy 数量、旧四位新文件、打包集合差、缺失摘要拒绝、真实 HEAD 重放。
- 集成测试：`sqlite-authority-transfer.test.ts`、`sqlite-recovery-point.test.ts`、`sandbox-reservation-administration.test.ts`、`workspace-lifecycle-audit.test.ts` 都有同数量不同集合或新迁移的反向用例。

反向用例的逻辑上确实会失败：例如没有指纹检查时，`assertWritableSchema(database, other.length)` 不会抛错，现有 `expect(...).toThrow(/different set/)` 会失败；权限转移、恢复点、沙箱预留管理的同类测试也一样。**我没有实际运行测试**（环境不允许），以上是按测试代码和被测代码的断言关系推断的。

仍缺的反向用例：
- fetch 失败/本地 `origin/main` 陈旧时检查必须失败（问题 1）；
- 同数量不同集合的**快照**必须被 `verifySnapshot` 拒绝（问题 3）；
- 已应用迁移“改名但内容不变”必须被打包检查拒绝（问题 2）；
- CLI 的 `--applied` 缺摘要必须失败（问题 4）。

### 4. 每个新值/改动的每个使用方都能接受吗？

逐项核对结果：

| 值 | 产生处 | 使用处 | 核对结果 |
|---|---|---|---|
| `MigrationDefinition.id` | `loadBundledMigrations`、旧清单补 `0001`…`0095` | `validateDefinitions`、`pending` 集合差、`validateLedger`、`describeMigrationSet` | 通过；旧库无列时按 `sequence` 补 4 位，唯一且稳定 |
| ledger `migration_id` | `applyMigrations`，旧迁移写 `NULL`、时间戳写 id | `readMigrationLedger`、S0、maintenance、audit | 通过；所有读取方都处理列不存在/`NULL` |
| `sequence` 新语义（应用顺序） | `sequence = applied.length + 1` | `readMigrationLedger` 排序、audit 连续性、S9/raw-copy、maintenance 期望 ledger | 通过；这些使用方只要求 1..N 连续，晚合小号仍满足 |
| `migrationIds` / `migrationDigests` | `s0-db/read-s0-db.mjs` | `make-packet.schema_parameters`、`check-migration-conflicts --applied` | 长度和空摘要已校验，id 集合对目标提交校验；**名字没有校验**（问题 2） |
| `LEGACY_MIGRATION_COUNT` | engine/audit 各一份 | `check-audit-schema-range`、`check-migration-conflicts`、audit | 两处 95 一致；新加旧四位文件会被 `numberedBeyondLegacy`/`LEGACY_SET_CHANGED` 拒绝 |
| `AUDIT_READ_TABLES` / `AUDIT_REVIEWED_MIGRATIONS` | 仓库审计脚本 | `check-audit-schema-range`；打包只检查常量格式 | 仓库检查两端匹配；打包检查不验证 reviewed 列表（ADR 已声明的取舍） |
| `SchemaIdentity.fingerprint` | `migrationSetFingerprint` | `assertWritableSchema`、admin data/memory/thread、恢复点、权限转移、沙箱预留管理 | 写库/导入路径都做了同数量比对；**快照路径未用指纹**（问题 3） |
| `LATEST_MIGRATION_SEQUENCE` | 旧清单数 + 时间戳文件数 | 导出/演示包、admin schema 检查、若干测试 | 通过；它现在是迁移总数，等于最大应用序号 |
| 打包 `MIGRATION_LEDGER` 项（`sequence/name/phase`） | `make-packet.migration_ledger` | 生产机 `maintenance-common.mjs` 及引擎 | 通过；sequence 按“应用顺序”生成，晚合小号测试覆盖 |

## 增量（9ba7915f..677a7d33）复核

增量里对 `describeMigrationSet` 的 `.sort()` 修改是正确的，和 `migrationSetFingerprint` 的排序一致；新增的两个测试分别覆盖“缺快照时不加列、不写文件”和“旧库无待跑迁移时不加列”，与 ADR 的过渡要求一致。我没有在这次增量里发现新的阻断性问题；上面列出的问题在 3cab..677a 的整体改动中已经存在。
