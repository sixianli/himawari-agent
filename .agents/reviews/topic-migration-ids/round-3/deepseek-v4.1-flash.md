CLAIM|1|一致|docs/adr/0018-sqlite-product-state-authority.md:21|Himawari 的产品库是一个 SQLite 文件（单机文件数据库）|Himawari Agent v0.2 使用 SQLite 作为产品业务状态的唯一权威数据库。
CLAIM|2|一致|packages/persistence-sqlite/src/migration-engine.ts:743|每个迁移是 `packages/persistence-sqlite/src/migrations/` 下的一个文件，文件名开头是四位连续编号，例如 `0095_correction_propagation.sql`|    file: "0095_correction_propagation.sql",
CLAIM|3|找不到|-|2026-11-14 排队的有 PR 414、404、436、444、443、449、479、451、455、454、486 等十几个|-
CLAIM|4|一致|.claude/rules/owner-standing-rules.md:21|属于“数据存储结构”这一类大改动（[Andy 定的长期规则](../../.claude/rules/owner-standing-rules.md#fixing-bugs-and-new-features)）|<a id="fixing-bugs-and-new-features"></a>
CLAIM|5|一致|docs/adr/0265-migrations-get-unique-ids-and-merge-in-any-order.md:4|所以本 ADR 只是方案，Andy 同意后才动代码。|decision_status: proposed
CLAIM|6|一致|packages/persistence-sqlite/src/migration-engine.ts:79|新迁移要在手写数组末尾加一条：`packages/persistence-sqlite/src/migration-engine.ts:79` 原文 `const bundledMigrationFiles = [`|const bundledMigrationFiles = [
CLAIM|7|一致|packages/persistence-sqlite/src/migration-engine.ts:81|每条写 `sequence`、`name`、`changeSet`、`phase`、`file`|    sequence: 1,
CLAIM|8|一致|packages/persistence-sqlite/src/migration-engine.ts:769|定义必须从 1 连续：同文件第 769 行 `const expectedSequence = index + 1;`|    const expectedSequence = index + 1;
CLAIM|9|一致|packages/persistence-sqlite/src/migration-engine.ts:772|不等就报 `DEFINITION_GAP`|        SQLITE_MIGRATION_ERROR_CODES.DEFINITION_GAP,
CLAIM|10|一致|packages/persistence-sqlite/src/migration-engine.ts:857|库里的记录也必须从 1 连续，并按下标和定义逐条对上：同文件第 857 行 `const expectedSequence = index + 1;`|    const expectedSequence = index + 1;
CLAIM|11|一致|packages/persistence-sqlite/src/migration-engine.ts:865|之后 `const definition = migrations[index];`|    const definition = migrations[index];
CLAIM|12|一致|packages/persistence-sqlite/src/migration-engine.ts:985|只跑“库里最大号之后”的迁移：同文件第 985 行 `const pending = migrations.slice(currentSequence);`|  const pending = migrations.slice(currentSequence);
CLAIM|13|一致|packages/persistence-sqlite/src/migration-engine.ts:991|已有库迁移前必须有同机快照：同文件第 991 行 `if (currentSequence > 0) verifySnapshot(database, options.snapshot, currentSequence);`|  if (currentSequence > 0) verifySnapshot(database, options.snapshot, currentSequence);
CLAIM|14|一致|packages/persistence-sqlite/src/migration-engine.ts:828|记录表的主键是整数编号：同文件第 828 行 `sequence INTEGER PRIMARY KEY CHECK (sequence >= 1),`|      sequence INTEGER PRIMARY KEY CHECK (sequence >= 1),
CLAIM|15|一致|packages/persistence-sqlite/src/migration-engine.ts:906|每跑一个迁移还写 `schema_metadata` 的 `current_sequence` 和 `minimum_writer_sequence`（第 906 行 `statement.run("minimum_writer_sequence", String(sequence), updatedAt);`）|  statement.run("minimum_writer_sequence", String(sequence), updatedAt);
CLAIM|16|一致|packages/persistence-sqlite/src/migration-engine.ts:1019|`assertWritableSchema`（第 1013 行）用它们挡住“比库旧的程序”写库，这是回滚保护|        SQLITE_MIGRATION_ERROR_CODES.WRITER_TOO_OLD,
CLAIM|17|一致|scripts/delivery-mode/make-packet.py:122|上线打包脚本按整数取目标版本并要求连续：`scripts/delivery-mode/make-packet.py:122` 原文 `if not numbers or numbers != list(range(1, len(numbers) + 1)):`|    if not numbers or numbers != list(range(1, len(numbers) + 1)):
CLAIM|18|一致|scripts/delivery-mode/make-packet.py:159|第 159 行用正则解析 `migration-engine.ts` 的数组|    entries = {int(sequence): {'sequence': int(sequence), 'name': name, 'phase': phase, 'file': filename} for sequence, name, phase, filename in re.findall(
CLAIM|19|一致|scripts/delivery-mode/make-packet.py:169|第 167 行检查每个待跑迁移有没有碰“受保护的表”|            refuse('PACKET_MIGRATION_TOUCHES_PRESERVED_TABLES', entry['file'] + ' ' + ','.join(touched))
CLAIM|20|一致|scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs:79|生产机上的读库脚本要求记录是 1..N：`scripts/delivery-mode/packet-template/s0-db/read-s0-db.mjs:79` 原文 `assert(ledger.length === current && ledger.every((row, index) => row.sequence === index + 1), "__PKT_LABEL_UPPER___DB_LEDGER_INVALID");`|  assert(ledger.length === current && ledger.every((row, index) => row.sequence === index + 1), "__PKT_LABEL_UPPER___DB_LEDGER_INVALID");
CLAIM|21|一致|packages/persistence-sqlite/src/sqlite-recovery-point.ts:961|备份恢复按整数比版本：`packages/persistence-sqlite/src/sqlite-recovery-point.ts:961` 原文 `if (manifest.schemaSequence !== expectedSchemaSequence) {`|    if (manifest.schemaSequence !== expectedSchemaSequence) {
CLAIM|22|一致|scripts/operations/workspace-lifecycle-audit.mjs:5|审计脚本写死支持的最高版本：`scripts/operations/workspace-lifecycle-audit.mjs:5` 原文 `export const SUPPORTED_SCHEMA_MAX = 95;`|export const SUPPORTED_SCHEMA_MAX = 95;
CLAIM|23|一致|scripts/check-audit-schema-range.mjs:27|`scripts/check-audit-schema-range.mjs` 不等就报 `AUDIT_SCHEMA_RANGE_STALE`|AUDIT_SCHEMA_RANGE_STALE 数据库迁移已到 ${result.latest}，但 ${AUDIT_SCRIPT} 的 SUPPORTED_SCHEMA_MAX 是 ${result.supported}。
CLAIM|24|一致|docs/incidents-and-gates.md:84|（事故 I-46，`docs/incidents-and-gates.md:84`）|把能读的数据库版本写死在 67 以内
CLAIM|25|一致|docs/incidents-and-gates.md:98|写死迁移号已经出过两次事故：I-46 和 I-61（`docs/incidents-and-gates.md:98`，“和 I-46 是同一类错误（写死迁移号范围）的另一处”）|和 I-46 是同一类错误（写死迁移号范围）的另一处
CLAIM|26|一致|docs/lessons.md:667|`docs/lessons.md:667` 记了写死迁移编号的测试漏跑、main 上 16 个用例一直失败。|main 上 16 个用例一直失败
CLAIM|27|一致|.agents/instructions/delivery-mode.md:27|合并前本地基本检查必过：`.agents/instructions/delivery-mode.md:27` 原文“合并进 `main` 之前，PR 最新提交上的 `ci/required` 必须是成功……上面的本地基本检查照样必过”。|上面的本地基本检查照样必过
CLAIM|28|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:23|`decision_ledger` 的 `kind` 列是写在 CHECK 里的枚举：`packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:23` 原文 `kind TEXT NOT NULL CHECK (`，下一行 `kind IN (`|  kind TEXT NOT NULL CHECK (
CLAIM|29|一致|packages/persistence-sqlite/src/migration-engine.ts:739|已合并的 95 个迁移|    sequence: 95,
CLAIM|30|不一致|packages/persistence-sqlite/src/migrations/0087_rule_book_memory_link.sql:15|decision_ledger 被整表重建过 9 次|DROP TABLE decision_ledger;
CLAIM|31|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:6|连同引用它的子表 `decision_signals`、`decision_ledger_payloads`、`source_insights` 等一起重建|CREATE TABLE decision_signals_keep AS SELECT * FROM decision_signals;
CLAIM|32|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:19|单个迁移 600 多行|CREATE TABLE decision_ledger (
CLAIM|33|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:26|`memory_review` 种类合进 main（`0095_correction_propagation.sql`）|      'retrieval_degrade', 'external_read', 'rule_review', 'memory_review'
CLAIM|34|找不到|-|远程分支上排队的 10 个迁移里，有 4 个又在重建 `decision_ledger`（`0096_web_push_gate`、`0095_perception_records`、`0097_proactive_source_registry`、`0097_device_actions`）|-
CLAIM|35|找不到|-|其中 `0095_perception_records` 是在 `memory_review` 种类合进 main（`0095_correction_propagation.sql`）之前写的，它重建的表里没有 `memory_review`|-
CLAIM|36|找不到|-|照现在的样子合进去，生产库里已有的 `memory_review` 行在搬数据时会违反新约束，上线时迁移失败|-
CLAIM|37|一致|packages/persistence-sqlite/src/migration-engine.ts:441|默认 `phase` 是 `expand`、`changeSet` 是名字换连字符（0052 以后的 44 个迁移全是这样）|    phase: "expand" as const,
CLAIM|38|一致|packages/persistence-sqlite/src/migration-engine.ts:748|`LATEST_MIGRATION_SEQUENCE` 改成这份合成清单的个数（现在取数组最后一项，`migration-engine.ts:747`，冻结后就不会再变，必须改）|  bundledMigrationFiles[bundledMigrationFiles.length - 1]?.sequence ?? 0;
CLAIM|39|一致|scripts/delivery-mode/make-packet.py:121|现在它们只认四位号，新文件会被悄悄忽略，打包会以为没有新迁移。|    numbers = sorted(int(match.group(1)) for match in (re.fullmatch(r'([0-9]{4})_[a-z0-9_]+\.sql', name) for name in names) if match)
CLAIM|40|一致|scripts/operations/workspace-lifecycle-audit.mjs:45|删掉 `SUPPORTED_SCHEMA_MAX` 和 `version >= 33` 这类按号开关|          ${version >= 33 ? "json_extract(r.recovery_json,'$.status')" : "NULL"} AS recoveryStatus,
CLAIM|41|一致|docs/lessons.md:667|写死版本号的测试改成从清单推算（`docs/lessons.md:667` 已建议的方向）|改成从迁移清单推算期望值
CLAIM|42|一致|packages/persistence-sqlite/src/migration-engine.ts:1013|引擎的 `assertWritableSchema`（现在只收一个整数，改成收期望的身份）|export function assertWritableSchema(database: SqliteDatabase, writerSequence: number): void {
CLAIM|43|一致|packages/persistence-sqlite/src/sqlite-recovery-point.ts:365|恢复点|    (database.prepare("SELECT MAX(sequence) FROM schema_migration_ledger").pluck().get() as
CLAIM|44|一致|packages/persistence-sqlite/src/sqlite-authority-transfer.ts:397|权限转移|    (database.prepare("SELECT MAX(sequence) FROM schema_migration_ledger").pluck().get() as
CLAIM|45|一致|apps/agent-service/src/production-data-export.ts:321|数据导出和聊天导出的清单（`production-data-export.ts:321`、`production-chat-export.ts:53`）|        migrationSequence: LATEST_MIGRATION_SEQUENCE,
CLAIM|46|一致|apps/agent-service/src/production-chat-export.ts:53|数据导出和聊天导出的清单（`production-data-export.ts:321`、`production-chat-export.ts:53`）|          migrationSequence: LATEST_MIGRATION_SEQUENCE,
CLAIM|47|一致|packages/persistence-sqlite/src/migration-engine.ts:906|`schema_metadata` 的 `current_sequence`、`minimum_writer_sequence` 继续写|  statement.run("minimum_writer_sequence", String(sequence), updatedAt);
CLAIM|48|一致|packages/persistence-sqlite/src/product-state-repository.ts:278|服务启动时会先跑 `applyMigrations`（`product-state-repository.ts:278`）|        applyMigrations(database, migrations, {
CLAIM|49|一致|packages/persistence-sqlite/src/migration-engine.ts:868|老程序遇到库里有它不认识的迁移，在 `validateLedger` 报 `UNKNOWN_APPLIED_MIGRATION`、拒绝启动|        SQLITE_MIGRATION_ERROR_CODES.UNKNOWN_APPLIED_MIGRATION,
CLAIM|50|一致|packages/persistence-sqlite/src/migration-engine.ts:876|每个跑过的迁移照旧核对名字、阶段和摘要（SHA-256，内容指纹）|      definition.digest !== record.digest
CLAIM|51|一致|packages/persistence-sqlite/src/migration-engine.ts:981|现在的 `applyMigrations` 先 `ensureInternalSchema` 后核快照（`migration-engine.ts:980-991`）|  ensureInternalSchema(database);
CLAIM|52|一致|packages/persistence-sqlite/src/migration-engine.ts:827|那时它只是 `CREATE TABLE IF NOT EXISTS`，没有写|    CREATE TABLE IF NOT EXISTS schema_migration_ledger (
CLAIM|53|一致|scripts/delivery-mode/run-packet-checks.py:58|`TARGET_SCHEMA` 继续是整数（目标个数），因为它贯穿 `S7-switch-start-readback.py:239`、`run-packet-checks.py:53-58`、`raw-copy-recovery.mjs`、`bindings.draft.json` 和测试|    return int(found['currentSchema'][0]), int(found['targetSchema'][0])
CLAIM|54|一致|scripts/delivery-mode/make-packet.py:170|`MIGRATION_LEDGER` 里每项带编号|        ledger.append({key: entry[key] for key in ('sequence', 'name', 'phase')})
CLAIM|55|一致|scripts/delivery-mode/make-packet.py:162|受保护表检查照旧逐个迁移做|    for sequence in range(current + 1, target + 1):
CLAIM|56|一致|scripts/delivery-mode/packet-template/maintenance/verify-fixtures.mjs:142|生产机脚本和它们的测试数据（`verify-fixtures.mjs`、`verify-raw-copy-fixtures.mjs`、`verify-migrate-fixtures.mjs`、`verify-sidecar-tidy-fixtures.mjs` 里手建的 5 列记录表）一起改|CREATE TABLE schema_migration_ledger(sequence INTEGER,name TEXT,phase TEXT,digest TEXT,applied_at TEXT);
CLAIM|57|一致|packages/persistence-sqlite/src/migrations/0095_correction_propagation.sql:67|同一文件第 67 行起还有一条“哪种决定允许哪些结果”的大 CHECK|    kind = 'proactive' OR
CLAIM|58|一致|packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:4|种子数据取程序里已有的 `DECISION_KINDS`、`DECISION_OUTCOMES`（`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts`）|  DECISION_KINDS,
CLAIM|59|一致|scripts/run-all-checks.mjs:32|`npm run check` 只跑这里列出的步骤，`scripts/run-all-checks.mjs:31`|  const names = stepNames(manifest.scripts["check:steps"]);
CLAIM|60|一致|.claude/rules/incident-gates.md:1|按[每个事故都要有自动门槛](../../.claude/rules/incident-gates.md#incidents-get-automatic-gates)记一行|<a id="incidents-get-automatic-gates"></a>
CLAIM|61|找不到|-|迁移编号、指纹都不进模型请求，不影响 KV 缓存（DeepSeek 审核已核对 `packages/prompt-catalog` 和 Pi 适配器不读这些值）|-
CLAIM|62|找不到|-|叠在别的 PR 上的分支（例如 `paired_devices` 出现在 6 个分支里）不受影响|-

远程分支、排队 PR、`paired_devices` 分布和 `0095_perception_records` 等不在当前检出中，无法核对；`prompt-catalog`/Pi 适配器完全不读迁移编号与指纹属于否定性说法，未读到可逐字引用的代码；管理命令和沙箱预留管理的读版本方式也未逐一展开。
