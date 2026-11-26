import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert(process.env.HIMAWARI_TEST_TEMP_ROOT, "MIGRATE_FIXTURE_OWNED_TEMP_ROOT_REQUIRED");
assert(process.env.HIMAWARI_MIGRATE_PREFIX, "MIGRATE_FIXTURE_CANDIDATE_RUNTIME_REQUIRED");
const prefix = process.env.HIMAWARI_MIGRATE_PREFIX;
const require = createRequire(path.join(prefix, "lib/himawari-agent/package.json"));
const Database = require("better-sqlite3");
const root = mkdtempSync(path.join(process.env.HIMAWARI_TEST_TEMP_ROOT, "migrate-fixture-"));

const common = await import("./maintenance-common.mjs");
const { historyTables } = await import("../s0-db/read-s0-db.mjs");
const raw = await import("./raw-copy-recovery.mjs");
const persistence = await common.persistence(prefix);
const migrations = await persistence.loadBundledMigrations();
const from = common.currentSchema;
const to = common.targetSchema;

const identity = { ownerId: "owner:fixture", agentId: "agent:fixture", deploymentId: "deployment:fixture" };
const databaseSha = (filename) => sha(readFileSync(filename));
const ledgerFor = (schema) => Array.from({ length: schema }, (_, index) => ({ sequence: index + 1, name: `migration-${index + 1}`, phase: "expand", digest: `sha256:${sha(String(index + 1))}`, applied_at: "2026-10-26T00:00:00.000Z" }));
const immutable = (filename) => {
  const database = new Database(pathToFileURL(filename).href + "?mode=ro&immutable=1", { readonly: true, fileMustExist: true });
  database.pragma("query_only=ON");
  return database;
};
const content = (databasePath) => {
  const database = immutable(databasePath);
  try { return common.migrationContentState(database); } finally { database.close(); }
};

let caseIndex = 0;
function build(name, schema, createDatabase = true) {
  caseIndex += 1;
  const directory = path.join(root, `${caseIndex}-${name}`);
  const stateRoot = path.join(directory, "state");
  const evidence = path.join(directory, "evidence");
  for (const value of [directory, stateRoot, evidence, path.join(stateRoot, "data"), path.join(stateRoot, "data/payload-ciphertext"), path.join(stateRoot, "secrets"), path.join(stateRoot, "deployment")]) mkdirSync(value, { mode: 0o700 });
  const databasePath = path.join(stateRoot, "data/product.sqlite");
  if (createDatabase) {
    const database = new Database(databasePath);
    database.pragma("journal_mode=WAL");
    database.exec("CREATE TABLE schema_metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE schema_migration_ledger(sequence INTEGER PRIMARY KEY,name TEXT,phase TEXT,digest TEXT,applied_at TEXT); CREATE TABLE capability_declarations(id TEXT PRIMARY KEY,version TEXT,status TEXT,revision INTEGER,integrity TEXT,record_json TEXT); CREATE TABLE product_state_records(key TEXT PRIMARY KEY,revision INTEGER,value_json TEXT); CREATE TABLE execution_environment_release_receipts(environment_id TEXT PRIMARY KEY,basis TEXT,stop_fence INTEGER,accepted_at TEXT,proof_json TEXT,authority_json TEXT);");
    for (const table of historyTables) database.exec(`CREATE TABLE "${table}"(id TEXT PRIMARY KEY,status TEXT);`);
    database.prepare("INSERT INTO schema_metadata VALUES(?,?)").run("current_sequence", String(schema));
    database.prepare("INSERT INTO schema_metadata VALUES(?,?)").run("minimum_writer_sequence", String(schema));
    for (const row of ledgerFor(schema)) database.prepare("INSERT INTO schema_migration_ledger VALUES(?,?,?,?,?)").run(row.sequence, row.name, row.phase, row.digest, row.applied_at);
    database.prepare("INSERT INTO capability_declarations VALUES(?,?,?,?,?,?)").run("himawari.pi-coding", "1.0.0", "active", 1, "sha256:fixture", JSON.stringify({ ref: "himawari.pi-coding" }));
    database.prepare("INSERT INTO product_state_records VALUES(?,?,?)").run("host-workspace:directory-grant:fixture", 1, JSON.stringify({ grantId: "fixture" }));
    database.pragma("wal_checkpoint(TRUNCATE)");
    database.close();
    chmodSync(databasePath, 0o600);
  }
  writeFileSync(path.join(stateRoot, "data/payload-ciphertext/payload.bin"), Buffer.from([0, 1, 2, 255]), { mode: 0o600 });
  return { directory, stateRoot, evidence, databasePath };
}

function writeConfiguration(value) {
  const configurationPath = path.join(value.stateRoot, "config.json");
  const template = JSON.parse(readFileSync(new URL("./production-shape-config-template.json", import.meta.url), "utf8"));
  const deployment = path.join(value.stateRoot, "deployment");
  template.stateRoot = value.stateRoot;
  template.runtimeDirectory = path.join(value.stateRoot, "runtime");
  template.cacheDirectory = path.join(value.stateRoot, "cache");
  template.memory.storagePath = path.join(value.stateRoot, "data/memory");
  template.http.staticRoot = path.join(prefix, "share/control-center");
  template.runPolicy.coding.grantId = "directory:fixture-migrate";
  template.capabilityDeployment = { snapshotPath: path.join(deployment, "capability-deployment.json"), sha256: "sha256:" + "a".repeat(64) };
  writeFileSync(configurationPath, JSON.stringify(template, null, 2) + "\n", { mode: 0o600 });
  chmodSync(configurationPath, 0o600);
  return configurationPath;
}

const pendingNames = new Set(common.migrationExpectedLedger.map((row) => row.name));
const productionApplied = migrations.filter((migration) => !pendingNames.has(migration.name));

function seedCurrent(value) {
  assert.equal(productionApplied.length, from, `MIGRATE_FIXTURE_PRODUCTION_APPLIED_COUNT:${productionApplied.length}:${from}`);
  const seeded = persistence.openQualifiedDatabase(value.databasePath);
  persistence.applyMigrations(seeded, productionApplied);
  seeded.close();
  chmodSync(value.databasePath, 0o600);
}

function runCli(value, configurationPath) {
  const environment = { HOME: value.stateRoot, PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", NODE_OPTIONS: "", NODE_PATH: "" };
  const stdout = execFileSync(path.join(prefix, "bin/himawari"), ["db", "migrate", "--config", configurationPath, "--confirm", "APPLY_MIGRATIONS"], { encoding: "utf8", env: environment, cwd: value.stateRoot, timeout: 600000, maxBuffer: 16777216, stdio: ["ignore", "pipe", "pipe"] });
  const records = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { result: records.at(-1), retained: null };
}

function requireStoppedStandIn() { return { ActiveState: "inactive", MainPID: "0" }; }

function migrateOptions(value, overrides = {}) {
  return {
    database: value.databasePath,
    requireStopped: requireStoppedStandIn,
    collectContent: () => content(value.databasePath),
    runMigrate: async () => { throw new Error("MIGRATE_FIXTURE_UNEXPECTED_MIGRATION"); },
    describeSnapshot: (source) => common.describeMigrationSnapshot(source, value.stateRoot, process.getuid()),
    ...overrides,
  };
}

function codeOf(error) {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

function expectCode(code, operation) {
  return Promise.resolve().then(operation).then(
    () => { throw new Error(`MIGRATE_FIXTURE_ERROR_NOT_RAISED:${code}`); },
    (error) => { assert.equal(codeOf(error), code, `MIGRATE_FIXTURE_ERROR_MISMATCH:${code}:${codeOf(error)}`); return error; },
  );
}

const cases = [];
async function check(name, source, operation) {
  try {
    const detail = await operation();
    cases.push({ name, source, passed: true, detail: detail ?? null });
  } catch (error) {
    cases.push({ name, source, passed: false, error: String(error?.message ?? error), stack: String(error?.stack ?? "") });
  }
}

let fatal = null;
try {
  assert(to > from && common.migrationExpectedLedger.length === to - from, `MIGRATE_FIXTURE_NO_MIGRATION_PLANNED:${from}:${to}`);
  await check(`M1 a schema${from} database migrates to schema${to} with the candidate CLI, keeps the compared content, leaves a 0600 pre-migration snapshot and yields a verifiable schema${to} raw copy`, "admin-cli db.migrate snapshot under data/pre-migration-*; packet migration ledger derived from migration-engine.ts", async () => {
    assert(migrations.length === to, `MIGRATE_FIXTURE_CANDIDATE_RUNTIME_MIGRATIONS:${migrations.length}`);
    const value = build("M1", from, false);
    seedCurrent(value);
    const configurationPath = writeConfiguration(value);
    const before = content(value.databasePath);
    const migrated = await common.migrateDatabase(migrateOptions(value, { runMigrate: async () => runCli(value, configurationPath) }));
    const after = migrated.after;
    assert.deepEqual([after.schema.current, after.schema.minimumWriter, after.ledger.length], [to, to, to], "MIGRATE_FIXTURE_M1_STATE_CHANGED");
    assert.deepEqual(after.ledger.slice(0, from), before.ledger, "MIGRATE_FIXTURE_M1_LEDGER_PREFIX_CHANGED");
    assert.deepEqual(after.ledger.slice(from).map(({ sequence, name, phase }) => ({ sequence, name, phase })), common.migrationExpectedLedger.map((row) => ({ ...row })), "MIGRATE_FIXTURE_M1_LEDGER_CHANGED");
    for (const section of common.migrationComparedSections) assert.deepEqual(after[section], before[section], `MIGRATE_FIXTURE_M1_SECTION_CHANGED:${section}`);
    assert.equal(migrated.snapshot.mode, "0600");
    assert.equal(migrated.snapshot.sha256, databaseSha(migrated.snapshot.path));
    const snapshotState = content(migrated.snapshot.path);
    assert.deepEqual([snapshotState.schema.current, snapshotState.ledger.length], [from, from], "MIGRATE_FIXTURE_M1_SNAPSHOT_NOT_CURRENT");
    const database = new Database(value.databasePath);
    database.prepare("INSERT INTO owners (id,revision) VALUES (?,?)").run(identity.ownerId, 0);
    database.prepare("INSERT INTO agents (id,owner_id,revision) VALUES (?,?,?)").run(identity.agentId, identity.ownerId, 0);
    database.prepare("INSERT INTO deployments (id,owner_id,agent_id,revision,status,authority_epoch,fencing_token) VALUES (?,?,?,?,?,?,?)").run(identity.deploymentId, identity.ownerId, identity.agentId, 0, "active", 1, 1);
    database.close();
    chmodSync(value.databasePath, 0o600);
    let held = false;
    const lock = async () => { assert.equal(held, false); held = true; return { release: async () => { held = false; } }; };
    const point = await raw.createRawRecoveryPoint({ stateRoot: value.stateRoot, evidenceRoot: value.evidence, recoveryId: `raw${to}`, schema: to, identity, expectedLedger: after.ledger, openReadonly: immutable, ownerUid: process.getuid(), requireStopped: requireStoppedStandIn, acquireStateRootLock: lock });
    assert.equal(point.schemaVersion, String(to));
    const verified = await raw.verifyRawRecoveryPoint({ stateRoot: value.stateRoot, evidenceRoot: value.evidence, recoveryId: `raw${to}`, schema: to, identity, expectedLedger: after.ledger, openReadonly: immutable, ownerUid: process.getuid(), expectedDigest: point.digest });
    assert.equal(verified.digest, point.digest);
    assert.equal(held, false);
    return { schema: after.schema, ledgerApplied: migrated.transition.ledgerApplied, snapshot: { bytes: migrated.snapshot.bytes, mode: migrated.snapshot.mode, directory: path.basename(path.dirname(migrated.snapshot.path)) }, dataEntries: readdirSync(path.join(value.stateRoot, "data")).sort(), recoveryDigest: point.digest };
  });

  await check(`M2 a database already at schema${to} is refused before any migration and keeps its bytes`, "migrateDatabase reads the schema first and only migrates from the production schema", async () => {
    const value = build("M2", to);
    const shaBefore = databaseSha(value.databasePath);
    const caught = await expectCode("__PKT_LABEL_UPPER___MAINTENANCE_MIGRATION_SCHEMA_INVALID", () => common.migrateDatabase(migrateOptions(value)));
    assert.equal(databaseSha(value.databasePath), shaBefore, "MIGRATE_FIXTURE_M2_DATABASE_CHANGED");
    return { schemaBefore: to, detail: caught.maintenanceDetail ?? null };
  });

  await check("M3 a service that is not stopped is refused before any read", "maintenance-common requireStopped", async () => {
    const value = build("M3", from);
    const shaBefore = databaseSha(value.databasePath);
    await expectCode("MIGRATE_FIXTURE_SERVICE_NOT_STOPPED", () => common.migrateDatabase(migrateOptions(value, { requireStopped: () => { throw new Error("MIGRATE_FIXTURE_SERVICE_NOT_STOPPED"); }, collectContent: () => { throw new Error("MIGRATE_FIXTURE_M3_READ_BEFORE_STOP_CHECK"); } })));
    assert.equal(databaseSha(value.databasePath), shaBefore, "MIGRATE_FIXTURE_M3_DATABASE_CHANGED");
    return { sha: shaBefore };
  });

  await check("M4 a database with a write-ahead log beside it is refused with the migrate sidecar code and left unchanged", "migrateDatabase sidecar refusal; tidy belongs to S9 only", async () => {
    const value = build("M4", from);
    writeFileSync(value.databasePath + "-wal", "", { mode: 0o600 });
    const shaBefore = databaseSha(value.databasePath);
    const caught = await expectCode("__PKT_LABEL_UPPER___MAINTENANCE_MIGRATE_SIDECAR_PRESENT", () => common.migrateDatabase(migrateOptions(value)));
    assert.equal(databaseSha(value.databasePath), shaBefore, "MIGRATE_FIXTURE_M4_DATABASE_CHANGED");
    assert.equal(existsSync(value.databasePath + "-wal"), true, "MIGRATE_FIXTURE_M4_SIDECAR_DELETED");
    return { sha: shaBefore, detail: caught.maintenanceDetail ?? null };
  });

  await check("M5 a CLI result that applied other sequences is refused before the snapshot and the after read", "migrateDatabase appliedSequences must equal the packet migration ledger", async () => {
    const value = build("M5", from);
    let afterRead = false;
    let reads = 0;
    await expectCode("__PKT_LABEL_UPPER___MAINTENANCE_MIGRATION_SEQUENCE_INVALID", () => common.migrateDatabase(migrateOptions(value, {
      collectContent: () => { reads += 1; if (reads > 1) afterRead = true; return content(value.databasePath); },
      runMigrate: async () => ({ result: { currentSequence: to, appliedSequences: [from], snapshotPath: null }, retained: null }),
      describeSnapshot: () => { throw new Error("MIGRATE_FIXTURE_M5_SNAPSHOT_DESCRIBED"); },
    })));
    assert.equal(afterRead, false, "MIGRATE_FIXTURE_M5_AFTER_READ");
    return { reads };
  });

  await check("M6 describeMigrationSnapshot refuses the live database path and a snapshot that is not 0600", "describeMigrationSnapshot path and mode checks", async () => {
    const value = build("M6", from);
    await expectCode("__PKT_LABEL_UPPER___MAINTENANCE_SNAPSHOT_PATH_INVALID", () => common.describeMigrationSnapshot(value.databasePath, value.stateRoot, process.getuid()));
    const directory = path.join(value.stateRoot, "data/pre-migration-AbC123");
    mkdirSync(directory, { mode: 0o700 });
    const loose = path.join(directory, "product.sqlite");
    writeFileSync(loose, readFileSync(value.databasePath), { mode: 0o640 });
    chmodSync(loose, 0o640);
    await expectCode("__PKT_LABEL_UPPER___MAINTENANCE_SNAPSHOT_MODE_INVALID", () => common.describeMigrationSnapshot(loose, value.stateRoot, process.getuid()));
    chmodSync(loose, 0o600);
    assert.equal(common.describeMigrationSnapshot(loose, value.stateRoot, process.getuid()).mode, "0600");
    return { accepted: path.basename(directory) };
  });
} catch (error) { fatal = String(error?.stack ?? error); }

const report = {
  schemaVersion: "himawari.__PKT_LABEL__-migrate-fixtures.v1",
  passed: fatal === null && cases.length > 0 && cases.every((item) => item.passed),
  fatal,
  scope: `S7_CONFIG_APPLY migration ${from} to ${to}: a real candidate CLI migration of a real schema${from} database (M1) and the refusal boundaries M2-M6. The SQLite driver, persistence module and CLI all come from HIMAWARI_MIGRATE_PREFIX. Production paths are not executed here.`,
  prefix,
  bundledMigrations: migrations.length,
  total: cases.length,
  failed: cases.filter((item) => !item.passed).length,
  cases,
  fixtureSha256: sha(readFileSync(new URL(import.meta.url))),
  implementationSha256: sha(readFileSync(new URL("./maintenance-common.mjs", import.meta.url))),
  productionExecutionProved: false,
};
rmSync(root, { recursive: true });
process.stdout.write(JSON.stringify(report) + "\n");
process.exitCode = report.passed ? 0 : 1;
