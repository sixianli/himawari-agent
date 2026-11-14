CLAIM|1|一致|packages/persistence-sqlite/src/migration-engine.ts:759|每个迁移是 `packages/persistence-sqlite/src/migrations/` 下的一个文件|const MIGRATION_FILE_SYNC_DIRECTORY = new URL("./migrations/", import.meta.url);
CLAIM|2|一致|packages/persistence-sqlite/src/migration-engine.ts:751|文件名开头是四位连续编号，例如 `0095_correction_propagation.sql`|    file: "0095_correction_propagation.sql",
CLAIM|3|不一致|packages/persistence-sqlite/src/migration-engine.ts:1336|新迁移要在手写数组末尾加一条|  for (const file of readdirSync(migrationDirectory)) {
CLAIM|4|不一致|packages/persistence-sqlite/src/migration-engine.ts:87|`packages/persistence-sqlite/src/migration-engine.ts:79` 原文 `const bundledMigrationFiles = [`|const bundledMigrationFiles = [
CLAIM|5|一致|packages/persistence-sqlite/src/migration-engine.ts:89|每条写 `sequence`、`name`、`changeSet`、`phase`、`file`|    sequence: 1,
CLAIM|6|一致|packages/persistence-sqlite/src/migration-engine.ts:836|定义必须从 1 连续|    const expectedSequence = index + 1;
CLAIM|7|不一致|packages/persistence-sqlite/src/migration-engine.ts:836|同文件第 769 行 `const expectedSequence = index + 1;`|    const expectedSequence = index + 1;
CLAIM|8|一致|packages/persistence-sqlite/src/migration-engine.ts:839|不等就报 `DEFINITION_GAP`|        SQLITE_MIGRATION_ERROR_CODES.DEFINITION_GAP,
CLAIM|9|一致|packages/persistence-sqlite/src/migration-engine.ts:972|库里的记录也必须从 1 连续|    const expectedSequence = index + 1;
CLAIM|10|不一致|packages/persistence-sqlite/src/migration-engine.ts:972|同文件第 857 行 `const expectedSequence = index + 1;`|    const expectedSequence = index + 1;
CLAIM|11|不一致|packages/persistence-sqlite/src/migration-engine.ts:980|之后 `const definition = migrations[index];`|    const definition = definitions.get(record.id);
CLAIM|12|不一致|packages/persistence-sqlite/src/migration-engine.ts:1101|只跑“库里最大号之后”的迁移|  const pending = migrations.filter((migration) => !appliedIds.has(migration.id));
CLAIM|13|不一致|packages/persistence-sqlite/src/migration-engine.ts:1101|同文件第 985 行 `const pending = migrations.slice(currentSequence);`|  const pending = migrations.filter((migration) => !appliedIds.has(migration.id));
CLAIM|14|一致|packages/persistence-sqlite/src/migration-engine.ts:1108|已有库迁移前必须有同机快照|  if (currentSequence > 0) verifySnapshot(database, options.snapshot, currentSequence);
CLAIM|15|不一致|packages/persistence-sqlite/src/migration-engine.ts:1108|同文件第 991 行 `if (currentSequence > 0) verifySnapshot(database, options.snapshot, currentSequence);`|  if (currentSequence > 0) verifySnapshot(database, options.snapshot, currentSequence);
CLAIM|16|一致|packages/persistence-sqlite/src/migration-engine.ts:908|记录表的主键是整数编号|      sequence INTEGER PRIMARY KEY CHECK (sequence >= 1),
CLAIM|17|不一致|packages/persistence-sqlite/src/migration-engine.ts:908|同文件第 828 行 `sequence INTEGER PRIMARY KEY CHECK (sequence >= 1),`|      sequence INTEGER PRIMARY KEY CHECK (sequence >= 1),
CLAIM|18|一致|packages/persistence-sqlite/src/migration-engine.ts:1021|每跑一个迁移还写 `schema_metadata` 的 `current_sequence` 和 `minimum_writer_sequence`|  statement.run("minimum_writer_sequence", String(sequence), updatedAt);
CLAIM|19|不一致|packages/persistence-sqlite/src/migration-engine.ts:1021|第 906 行 `statement.run("minimum_writer_sequence", String(sequence), updatedAt);`|  statement.run("minimum_writer_sequence", String(sequence), updatedAt);
CLAIM|20|一致|packages/persistence-sqlite/src/migration-engine.ts:1152|`assertWritableSchema` 用它们挡住“比库旧的程序”写库，这是回滚保护|  if (currentSequence > writerSequence || minimumWriterSequence > writerSequence) {
CLAIM|21|不一致|packages/persistence-sqlite/src/migration-engine.ts:1144|`assertWritableSchema`（第 1013 行）|export function assertWritableSchema(
CLAIM|22|不一致|scripts/delivery-mode/make-packet.py:136|`scripts/delivery-mode/make-packet.py:122` 原文 `if not numbers or numbers != list(range(1, len(numbers) + 1)):`|    if not legacy or legacy != list(range(1, len(legacy) + 1)):
CLAIM|23|不一致|scripts/delivery-mode/make-packet.py:197|第 159 行用正则解析 `migration-engine.ts` 的数组|    entries = {int(sequence): {'sequence': int(sequence), 'name': name, 'phase': phase, 'file': filename} for sequence, name, phase, filename in re.findall(
CLAIM|24|不一致|scripts/delivery-mode/make-packet.py:224|第 167 行检查每个待跑迁移有没有碰“受保护的表”|            refuse('PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES', entry['file'] + ' ' + ','.join(touched))
CLAIM|25|一致|scripts/delivery-mode/make-packet.py:224|上线打包脚本逐个待跑迁移检查有没有碰“受保护的表”|            refuse('PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES', entry['file'] + ' ' + ','.join(touched))
CLAIM|26|一致|scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs:82|生产机上的读库脚本要求记录是 1..N|  assert(ledger.length === current && ledger.every((row, index) => row.sequence === index + 1), "__PKT_LABEL_UPPER___DB_LEDGER_INVALID");
CLAIM|27|不一致|scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs:82|`scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs:79` 原文 `assert(ledger.length === current && ledger.every((row, index) => row.sequence === index + 1), "__PKT_LABEL_UPPER___DB_LEDGER_INVALID");`|  assert(ledger.length === current && ledger.every((row, index) => row.sequence === index + 1), "__PKT_LABEL_UPPER___DB_LEDGER_INVALID");
CLAIM|28|一致|packages/persistence-sqlite/src/sqlite-recovery-point.ts:963|备份恢复按整数比版本|    if (manifest.schemaSequence !== expectedSchemaSequence) {
CLAIM|29|不一致|packages/persistence-sqlite/src/sqlite-recovery-point.ts:963|`packages/persistence-sqlite/src/sqlite-recovery-point.ts:961` 原文 `if (manifest.schemaSequence !== expectedSchemaSequence) {`|    if (manifest.schemaSequence !== expectedSchemaSequence) {
CLAIM|30|不一致|scripts/operations/workspace-lifecycle-audit.mjs:5|审计脚本写死支持的最高版本|export const LEGACY_MIGRATION_COUNT = 95;
CLAIM|31|不一致|scripts/operations/workspace-lifecycle-audit.mjs:5|`scripts/operations/workspace-lifecycle-audit.mjs:5` 原文 `export const SUPPORTED_SCHEMA_MAX = 95;`|export const LEGACY_MIGRATION_COUNT = 95;
CLAIM|32|一致|scripts/check-audit-schema-range.mjs:50|有检查要求它等于最新迁移号|      declared === legacy &&
CLAIM|33|一致|scripts/check-audit-schema-range.mjs:61|`scripts/check-audit-schema-range.mjs` 不等就报 `AUDIT_SCHEMA_RANGE_STALE`|      `AUDIT_SCHEMA_RANGE_STALE 旧清单有 ${result.legacy} 个迁移，但 ${AUDIT_SCRIPT} 的 LEGACY_MIGRATION_COUNT 是 ${result.declared}。\n`,
CLAIM|34|一致|docs/incidents-and-gates.md:84|事故 I-46，`docs/incidents-and-gates.md:84`|`scripts/operations/workspace-lifecycle-audit.mjs` 把能读的数据库版本写死在 67 以内
CLAIM|35|一致|docs/incidents-and-gates.md:98|写死迁移号已经出过两次事故：I-46 和 I-61|和 I-46 是同一类错误（写死迁移号范围）的另一处。
CLAIM|36|一致|docs/lessons.md:667|`docs/lessons.md:667` 记了写死迁移编号的测试漏跑、main 上 16 个用例一直失败|main 上 16 个用例一直失败
CLAIM|37|一致|.agents/instructions/delivery-mode.md:27|`.agents/instructions/delivery-mode.md:27` 原文“合并进 `main` 之前，PR 最新提交上的 `ci/required` 必须是成功……上面的本地基本检查照样必过”|合并进 `main` 之前，PR 最新提交上的 `ci/required` 必须是成功
CLAIM|38|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:23|`decision_ledger` 的 `kind` 列是写在 CHECK 里的枚举|  kind TEXT NOT NULL CHECK (
CLAIM|39|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:23|`packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:23` 原文 `kind TEXT NOT NULL CHECK (`|  kind TEXT NOT NULL CHECK (
CLAIM|40|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:24|下一行 `kind IN (`|    kind IN (
CLAIM|41|一致|packages/persistence-sqlite/src/migration-engine.ts:747|已合并的 95 个迁移|    sequence: 95,
CLAIM|42|一致|packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:15|`decision_ledger` 被整表重建过 4 次（`0087_rule_book_memory_link.sql`、`0088_memory_capture_backlog.sql`、`0089_consolidation_hold.sql`、`0095_correction_propagation.sql` 各有一句 `DROP TABLE decision_ledger;`）|DROP TABLE decision_ledger;
CLAIM|43|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:1|连同引用它的子表 `decision_signals`、`decision_ledger_payloads`、`source_insights` 等一起重建，单个迁移 600 多行|CREATE TABLE decision_ledger_keep AS SELECT * FROM decision_ledger;
CLAIM|44|找不到|-|排队分支里的迁移有 4 个又在重建 `decision_ledger`（`0096_web_push_gate`、`0095_perception_records`、`0097_proactive_source_registry`、`0097_device_actions`），都只是为了在 `kind` 里加一个值|-
CLAIM|45|找不到|-|其中 `0095_perception_records` 是在 `memory_review` 种类合进 main（`0095_correction_propagation.sql`）之前写的，它重建的表里没有 `memory_review`|-
CLAIM|46|不一致|packages/persistence-sqlite/src/migration-engine.ts:847|编号在写代码时就定死，而且必须全局连续|      : /^\d{14}$/.test(migration.id) && migration.id > lastTimestampId;
CLAIM|47|不一致|packages/persistence-sqlite/src/migration-engine.ts:1101|引擎只认“前缀”：库里的记录必须正好是定义的前 N 条，只跑第 N 条之后的|  const pending = migrations.filter((migration) => !appliedIds.has(migration.id));
CLAIM|48|不一致|packages/persistence-sqlite/src/migration-engine.ts:1336|每加一个迁移都要改数组末尾|  for (const file of readdirSync(migrationDirectory)) {
CLAIM|49|不一致|scripts/operations/workspace-lifecycle-audit.mjs:5|每加一个迁移都要改 `SUPPORTED_SCHEMA_MAX`|export const LEGACY_MIGRATION_COUNT = 95;
CLAIM|50|找不到|-|每加一个迁移都要改写死版本号的测试|-
CLAIM|51|不一致|package.json:39|真冲突没有自动检查|    "check:migration-conflicts": "node scripts/check-migration-conflicts.mjs",
CLAIM|52|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:23|`decision_ledger.kind` 写成 CHECK 枚举，每加一种决定就要整表重建|  kind TEXT NOT NULL CHECK (
CLAIM|53|一致|packages/persistence-sqlite/src/migration-engine.ts:449|默认 `phase` 是 `expand`、`changeSet` 是名字换连字符（0052 以后的 44 个迁移全是这样）|    phase: "expand" as const,
CLAIM|54|不一致|packages/persistence-sqlite/src/migration-engine.ts:765|`LATEST_MIGRATION_SEQUENCE` 改成这份合成清单的个数（现在取数组最后一项，`migration-engine.ts:747`）|export const LATEST_MIGRATION_SEQUENCE: number =
CLAIM|55|不一致|scripts/delivery-mode/make-packet.py:130|现在它们只认四位号，新文件会被悄悄忽略，打包会以为没有新迁移|        elif timestamp_match:
CLAIM|56|一致|scripts/operations/workspace-lifecycle-audit.mjs:84|审计脚本有 `version >= 33` 这类按号开关|          ${version >= 33 ? "json_extract(r.recovery_json,'$.status')" : "NULL"} AS recoveryStatus,
CLAIM|57|一致|scripts/operations/workspace-lifecycle-audit.mjs:5|`LEGACY_MIGRATION_COUNT`，现在是 95|export const LEGACY_MIGRATION_COUNT = 95;
CLAIM|58|一致|scripts/operations/workspace-lifecycle-audit.mjs:6|检查它读的 16 张表（`AUDIT_READ_TABLES`）|export const AUDIT_READ_TABLES = Object.freeze([
CLAIM|59|一致|docs/lessons.md:667|`docs/lessons.md:667` 已建议的方向|这两个文件和另外两个写死迁移编号列表的测试改成从迁移清单推算期望值
CLAIM|60|一致|scripts/delivery-mode/packet-template/maintenance/S9-control-files.py:236|`S9-control-files.py` 和 `raw-copy-recovery.mjs` 只检查账本是 1 到 N 连续、前后一致|        require([row[0] for row in ledger] == list(range(1, schema + 1))
CLAIM|61|一致|packages/persistence-sqlite/src/migration-engine.ts:1096|现在的 `applyMigrations` 先 `ensureInternalSchema` 后核快照|  ensureInternalSchema(database);
CLAIM|62|不一致|packages/persistence-sqlite/src/migration-engine.ts:1090|`migration-engine.ts:980-991`|export function applyMigrations(
CLAIM|63|一致|packages/persistence-sqlite/src/migration-engine.ts:908|那时它只是 `CREATE TABLE IF NOT EXISTS`，没有写|      sequence INTEGER PRIMARY KEY CHECK (sequence >= 1),
CLAIM|64|一致|packages/persistence-sqlite/src/product-state-repository.ts:278|服务启动时会先跑 `applyMigrations`（`product-state-repository.ts:278`）|        applyMigrations(database, migrations, {
CLAIM|65|一致|packages/persistence-sqlite/src/migration-engine.ts:983|在 `validateLedger` 报 `UNKNOWN_APPLIED_MIGRATION`、拒绝启动|        SQLITE_MIGRATION_ERROR_CODES.UNKNOWN_APPLIED_MIGRATION,
CLAIM|66|一致|packages/persistence-sqlite/src/sqlite-worker.ts:155|`sqlite-worker.ts` 仍只比整数|    currentSequence !== configuration.writerSequence ||
CLAIM|67|一致|packages/persistence-sqlite/src/data-export/types.ts:36|数据导出和聊天导出清单只记整数|  readonly migrationSequence: number;
CLAIM|68|一致|scripts/delivery-mode/make-packet.py:162|`TARGET_SCHEMA` 继续是整数（目标个数）|    return len(target_migration_ids(commit))
CLAIM|69|一致|scripts/delivery-mode/packet-template/systemd/S7-switch-start-readback.py:239|`TARGET_SCHEMA` 贯穿 `S7-switch-start-readback.py:239`|post_upgrade_state['schemaSequence'] != __PKT_TARGET_SCHEMA__
CLAIM|70|一致|scripts/delivery-mode/make-packet.py:225|`MIGRATION_LEDGER` 里每项仍是 `sequence`、`name`、`phase`|        ledger.append({key: entry[key] for key in ('sequence', 'name', 'phase')})
CLAIM|71|一致|scripts/delivery-mode/packet-template/maintenance/verify-fixtures.mjs:142|`verify-fixtures.mjs`、`verify-raw-copy-fixtures.mjs`、`verify-migrate-fixtures.mjs`、`verify-sidecar-tidy-fixtures.mjs` 里手建的 5 列记录表|CREATE TABLE schema_migration_ledger(sequence INTEGER,name TEXT,phase TEXT,digest TEXT,applied_at TEXT);
CLAIM|72|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:67|同一文件第 67 行起还有一条“哪种决定允许哪些结果”的大 CHECK|    kind = 'proactive' OR
CLAIM|73|不一致|packages/application/src/ports/decision-ledger.ts:32|种子数据取程序里已有的 `DECISION_KINDS`、`DECISION_OUTCOMES`（`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts`）|export const DECISION_KINDS = [
CLAIM|74|一致|scripts/run-all-checks.mjs:32|`npm run check` 只跑这里列出的步骤|  const names = stepNames(manifest.scripts["check:steps"]);
CLAIM|75|不一致|scripts/run-all-checks.mjs:32|`scripts/run-all-checks.mjs:31`|  const names = stepNames(manifest.scripts["check:steps"]);
CLAIM|76|找不到|-|写死迁移号这一类已经出现 I-46、I-61 和 lessons 第 667 行三次|-
CLAIM|77|找不到|-|本线程在远程分支上看到 `paired_devices` 迁移同时出现在多个分支里|-
CLAIM|78|找不到|-|迁移编号、指纹都不进模型请求，不影响 KV 缓存（DeepSeek 审核在全仓搜索后说没有发现 `packages/prompt-catalog` 和 Pi 适配器读这些值）|-

未核实：远程分支上的 4 个排队迁移、`0095_perception_records` 的冲突说法和 `paired_devices` 说法不在当前检出的迁移文件里，无法读到证据。当前检出已包含方案的大部分实现，所以“前提”里的旧机制描述和多处行号与 HEAD 不一致；另外写死版本号的测试和“不影响 KV 缓存”一条我只做了有限搜索，未逐项核实。
