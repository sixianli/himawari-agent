import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, linkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(path.join(process.cwd(), "package.json"));
const Database = require("better-sqlite3");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert(process.env.HIMAWARI_TEST_TEMP_ROOT, "RAW_FIXTURE_OWNED_TEMP_ROOT_REQUIRED");
const root = mkdtempSync(path.join(process.env.HIMAWARI_TEST_TEMP_ROOT, "raw-fixture-"));
const cases = [];
let api;
try {
  api = await import("./raw-copy-recovery.mjs");
} catch (error) {
  cases.push({ name: "G69 stopped raw copy entrypoint exists", passed: false, error: error.message });
}
const identity = { ownerId: "owner:fixture", agentId: "agent:fixture", deploymentId: "deployment:fixture" };
const ledgers = Object.fromEntries([49, 50, 51].map((schema) => [schema, Array.from({ length: schema }, (_, index) => ({ sequence: index + 1, name: `migration-${index + 1}`, phase: "expand", digest: `sha256:${sha(String(index + 1))}`, applied_at: "2026-10-09T00:00:00.000Z" }))]));
const openReadonly = (filename) => {
  const database = new Database(pathToFileURL(filename).href + "?mode=ro&immutable=1", { readonly: true, fileMustExist: true });
  database.pragma("query_only=ON");
  return database;
};

function fixture(name, schema = 50) {
  const directory = path.join(root, name);
  mkdirSync(directory, { mode: 0o700 });
  const stateRoot = path.join(directory, "state");
  const evidenceRoot = path.join(directory, "evidence");
  for (const value of [stateRoot, evidenceRoot, path.join(stateRoot, "data"), path.join(stateRoot, "data/payload-ciphertext"), path.join(stateRoot, "data/payload-ciphertext/nested"), path.join(stateRoot, "secrets"), path.join(stateRoot, "deployment")]) mkdirSync(value, { mode: 0o700 });
  const databasePath = path.join(stateRoot, "data/product.sqlite");
  const database = new Database(databasePath);
  database.exec("CREATE TABLE schema_metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE schema_migration_ledger(sequence INTEGER PRIMARY KEY,name TEXT,phase TEXT,digest TEXT,applied_at TEXT); CREATE TABLE deployments(id TEXT,owner_id TEXT,agent_id TEXT); CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE child(parent_id INTEGER REFERENCES parent(id)); CREATE TABLE authentication_tokens(token TEXT);");
  database.prepare("INSERT INTO schema_metadata VALUES(?,?)").run("current_sequence", String(schema));
  database.prepare("INSERT INTO schema_metadata VALUES(?,?)").run("minimum_writer_sequence", String(schema));
  for (const row of ledgers[schema]) database.prepare("INSERT INTO schema_migration_ledger VALUES(?,?,?,?,?)").run(...Object.values(row));
  database.prepare("INSERT INTO deployments VALUES(?,?,?)").run(identity.deploymentId, identity.ownerId, identity.agentId);
  database.prepare("INSERT INTO authentication_tokens VALUES(?)").run("FICTITIOUS_ORIGINAL_TOKEN");
  database.close();
  chmodSync(databasePath, 0o600);
  for (const [relative, value] of [["data/payload-ciphertext/a.bin", Buffer.from([0, 1, 255, 34])], ["data/payload-ciphertext/nested/b.bin", Buffer.from("ciphertext-two")], ["secrets/secret", Buffer.from("SECRET_CANARY_UNTOUCHED")], ["deployment/authority", Buffer.from("AUTHORITY_CANARY_UNTOUCHED")]]) writeFileSync(path.join(stateRoot, relative), value, { mode: 0o600 });
  let held = false;
  let acquisitions = 0;
  const options = { stateRoot, evidenceRoot, recoveryId: "raw50", schema, identity, expectedLedger: ledgers[schema], openReadonly, ownerUid: process.getuid(), requireStopped: () => undefined, acquireStateRootLock: async () => { assert.equal(held, false); held = true; acquisitions += 1; return { release: async () => { held = false; } }; } };
  return { ...options, options, databasePath, directory, held: () => held, acquisitions: () => acquisitions };
}

async function check(name, operation) {
  try {
    await operation();
    cases.push({ name, passed: true });
  } catch (error) {
    cases.push({ name, passed: false, error: error.message });
  }
}

function editDatabase(value, sql) {
  const database = new Database(value.databasePath);
  try { database.exec(sql); } finally { database.close(); }
}

function bytesTree(directory) {
  const result = [];
  for (const name of readdirSync(directory).sort()) {
    const filename = path.join(directory, name);
    const info = lstatSync(filename);
    if (info.isDirectory()) for (const entry of bytesTree(filename)) result.push({ ...entry, path: `${name}/${entry.path}` });
    else result.push({ path: name, bytes: info.size, sha256: sha(readFileSync(filename)) });
  }
  return result;
}

if (api) {
  await check("G69 copies complete ciphertext tree and unchanged SQLite under lock with readonly integrity and ledger", async () => {
    const value = fixture("copy-complete");
    const before = bytesTree(path.join(value.stateRoot, "data"));
    const result = await api.createRawRecoveryPoint(value.options);
    assert.equal(value.acquisitions(), 1);
    assert.equal(value.held(), false);
    assert.equal(result.method, "stopped-raw-copy-v1");
    assert.equal(result.recoveryId, "raw50");
    assert.equal(result.schemaVersion, "50");
    assert.equal(result.fullIntegrityCheck, "ok");
    assert.equal(result.foreignKeys, "ok");
    assert.equal(result.sourceDatabaseBeforeSha256, result.sourceDatabaseAfterSha256);
    assert.deepEqual(bytesTree(path.join(value.stateRoot, "data")), before);
    assert.deepEqual(bytesTree(path.join(result.pointPath, "data")), before);
    assert.equal(lstatSync(result.pointPath).mode & 0o777, 0o700);
    for (const entry of bytesTree(result.pointPath)) assert.equal(lstatSync(path.join(result.pointPath, entry.path)).mode & 0o777, 0o600);
    assert(!existsSync(path.join(result.pointPath, "secrets")));
    assert(!existsSync(path.join(result.pointPath, "deployment")));
    const independent = await api.verifyRawRecoveryPoint({ ...value.options, expectedDigest: result.digest });
    assert.equal(independent.digest, result.digest);
  });
  for (const [name, mutate] of [
    ["empty WAL exists", (value) => writeFileSync(value.databasePath + "-wal", "", { mode: 0o600 })],
    ["nonempty WAL exists", (value) => writeFileSync(value.databasePath + "-wal", "wal", { mode: 0o600 })],
    ["empty SHM exists", (value) => writeFileSync(value.databasePath + "-shm", "", { mode: 0o600 })],
    ["database symlink", (value) => { renameSync(value.databasePath, value.databasePath + ".outside"); symlinkSync(value.databasePath + ".outside", value.databasePath); }],
    ["payload symlink escape", (value) => symlinkSync(path.join(value.stateRoot, "secrets/secret"), path.join(value.stateRoot, "data/payload-ciphertext/link"))],
    ["payload hardlink", (value) => linkSync(path.join(value.stateRoot, "data/payload-ciphertext/a.bin"), path.join(value.stateRoot, "data/payload-ciphertext/hard"))],
    ["payload FIFO", (value) => execFileSync("/usr/bin/mkfifo", [path.join(value.stateRoot, "data/payload-ciphertext/fifo")])],
    ["group writable file", (value) => chmodSync(path.join(value.stateRoot, "data/payload-ciphertext/a.bin"), 0o620)],
    ["world writable directory", (value) => chmodSync(path.join(value.stateRoot, "data/payload-ciphertext/nested"), 0o702)],
    ["wrong owner policy", (value) => { value.options.ownerUid = process.getuid() + 1; }],
    ["ledger gap", (value) => editDatabase(value, "DELETE FROM schema_migration_ledger WHERE sequence=8")],
    ["ledger digest changed", (value) => editDatabase(value, "UPDATE schema_migration_ledger SET digest='sha256:changed' WHERE sequence=8")],
    ["deployment identity changed", (value) => editDatabase(value, "UPDATE deployments SET owner_id='owner:other'")],
    ["foreign key violation", (value) => { editDatabase(value, "PRAGMA foreign_keys=OFF; INSERT INTO child VALUES(777)"); const database = openReadonly(value.databasePath); try { assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 1); } finally { database.close(); } }],
    ["service active", (value) => { value.options.requireStopped = () => { throw new Error("TWELFTH_MAINTENANCE_SERVICE_NOT_STOPPED"); }; }],
    ["state lock conflict", (value) => { value.options.acquireStateRootLock = async () => { throw new Error("SQLITE_STATE_ROOT_LOCKED"); }; }],
    ["evidence tree inside source", (value) => { value.options.evidenceRoot = path.join(value.stateRoot, "data/payload-ciphertext"); }],
    ["path traversal recovery ID", (value) => { value.options.recoveryId = "../escape"; }],
    ["third deployment schema 49 route", (value) => { value.options.schema = 49; value.options.expectedLedger = ledgers[49]; }],
  ]) await check(`G69 refuses ${name} without changing source`, async () => {
    const value = fixture(`reject-${cases.length}`);
    mutate(value);
    const before = readFileSync(value.databasePath);
    await assert.rejects(() => api.createRawRecoveryPoint(value.options));
    assert.deepEqual(readFileSync(value.databasePath), before);
    assert.equal(value.held(), false);
  });
  await check("G69 recovery ID is exclusive and existing manifest remains unchanged", async () => {
    const value = fixture("exclusive");
    const point = await api.createRawRecoveryPoint(value.options);
    const before = readFileSync(path.join(point.pointPath, "manifest.json"));
    await assert.rejects(() => api.createRawRecoveryPoint(value.options));
    assert.deepEqual(readFileSync(path.join(point.pointPath, "manifest.json")), before);
  });
  await check("G69 checkpointed WAL-mode database copies without creating sidecars", async () => {
    const value = fixture("closed-wal-mode");
    const database = new Database(value.databasePath);
    database.pragma("journal_mode=WAL");
    database.close();
    assert(!existsSync(value.databasePath + "-wal") && !existsSync(value.databasePath + "-shm"));
    const point = await api.createRawRecoveryPoint(value.options);
    assert(!existsSync(value.databasePath + "-wal") && !existsSync(value.databasePath + "-shm"));
    assert(!existsSync(path.join(point.pointPath, "data/product.sqlite-wal")) && !existsSync(path.join(point.pointPath, "data/product.sqlite-shm")));
  });
  for (const [name, mutate] of [
    ["member bytes changed", (directory) => writeFileSync(path.join(directory, "data/payload-ciphertext/a.bin"), "changed", { mode: 0o600 })],
    ["member missing", (directory) => rmSync(path.join(directory, "data/payload-ciphertext/a.bin"))],
    ["extra member", (directory) => writeFileSync(path.join(directory, "data/payload-ciphertext/extra.bin"), "extra", { mode: 0o600 })],
    ["sidecar added", (directory) => writeFileSync(path.join(directory, "data/product.sqlite-shm"), "", { mode: 0o600 })],
  ]) await check(`G69 independent readback refuses ${name}`, async () => {
    const value = fixture(`tamper-${cases.length}`);
    const point = await api.createRawRecoveryPoint(value.options);
    mutate(point.pointPath);
    await assert.rejects(() => api.verifyRawRecoveryPoint({ ...value.options, expectedDigest: point.digest }));
  });
  await check("G69 refuses source mutation during copy and retains failed evidence", async () => {
    const value = fixture("mutated-source");
    value.options.openReadonly = (filename) => {
      if (filename.startsWith(value.evidenceRoot + "/")) writeFileSync(path.join(value.stateRoot, "data/payload-ciphertext/a.bin"), "mutation", { mode: 0o600 });
      return openReadonly(filename);
    };
    await assert.rejects(() => api.createRawRecoveryPoint(value.options));
    assert(existsSync(path.join(value.evidenceRoot, "raw50")));
  });
  await check("third restore of the only schema-50 point preserves current50 and publishes both paths without touching controls or authentication rows", async () => {
    const value = fixture("restore-50");
    const target = await api.createRawRecoveryPoint(value.options);
    const targetData = bytesTree(path.join(target.pointPath, "data"));
    writeFileSync(path.join(value.stateRoot, "data/payload-ciphertext/a.bin"), "current50-ciphertext", { mode: 0o600 });
    const current = bytesTree(path.join(value.stateRoot, "data"));
    const controls = ["secrets/secret", "deployment/authority"].map((relative) => sha(readFileSync(path.join(value.stateRoot, relative))));
    const restored = await api.restoreRawRecoveryPoint({ ...value.options, expectedDigest: target.digest, preservedRecoveryId: "preserved-current50", currentLedger: ledgers[50], currentOpenReadonly: openReadonly });
    assert.equal(restored.restoredResult.digest, target.digest);
    assert.deepEqual(bytesTree(path.join(value.stateRoot, "data")), targetData);
    assert.deepEqual(bytesTree(path.join(restored.preservedCurrent.pointPath, "data")), current);
    assert.deepEqual(["secrets/secret", "deployment/authority"].map((relative) => sha(readFileSync(path.join(value.stateRoot, relative)))), controls);
    const readback = openReadonly(value.databasePath);
    try { assert.deepEqual(readback.prepare("SELECT token FROM authentication_tokens").all(), [{ token: "FICTITIOUS_ORIGINAL_TOKEN" }]); } finally { readback.close(); }
    assert.equal(restored.serviceStartAuthorized, false);
    assert.equal(restored.accountRecoveryRequired, true);
    assert(existsSync(restored.retainedOriginalDirectory));
    assert.equal(value.held(), false);
  });
  await check("restores the S3 schema50 raw point from a current schema51 database and preserves the current schema51 state", async () => {
    assert.notEqual(process.getuid(), 0, "RAW_FIXTURE_UNPRIVILEGED_ACTOR_REQUIRED");
    const value = fixture("restore-50-from-51");
    const target = await api.createRawRecoveryPoint(value.options);
    const targetData = bytesTree(path.join(target.pointPath, "data"));
    const next = ledgers[51][50];
    editDatabase(value, `INSERT INTO schema_migration_ledger (sequence,name,phase,digest,applied_at) VALUES(${next.sequence},'${next.name}','${next.phase}','${next.digest}','${next.applied_at}')`);
    editDatabase(value, "UPDATE schema_metadata SET value='51' WHERE key IN ('current_sequence','minimum_writer_sequence')");
    const current = bytesTree(path.join(value.stateRoot, "data"));
    const restored = await api.restoreRawRecoveryPoint({ ...value.options, expectedDigest: target.digest, preservedRecoveryId: "preserved-current51", currentLedger: ledgers[51], currentSchema: 51, currentOpenReadonly: openReadonly });
    assert.equal(restored.restoredResult.digest, target.digest);
    assert.equal(restored.restoredResult.schema, 50);
    assert.equal(restored.preservedCurrent.schema, 51);
    assert.equal(restored.preservedCurrent.verifiedResult.schemaVersion, "51");
    assert.deepEqual(bytesTree(path.join(value.stateRoot, "data")), targetData);
    assert.deepEqual(bytesTree(path.join(restored.preservedCurrent.pointPath, "data")), current);
    const readback = openReadonly(value.databasePath);
    try { assert.equal(Number(readback.prepare("SELECT value FROM schema_metadata WHERE key='current_sequence'").get().value), 50); } finally { readback.close(); }
    assert.equal(restored.serviceStartAuthorized, false);
    assert.equal(restored.accountRecoveryRequired, true);
    assert.equal(value.held(), false);
  });
  await check("G69 restore rejects wrong target digest before preserving or replacing current state", async () => {
    const value = fixture("restore-wrong-digest", 50);
    await api.createRawRecoveryPoint(value.options);
    const before = bytesTree(path.join(value.stateRoot, "data"));
    await assert.rejects(() => api.restoreRawRecoveryPoint({ ...value.options, expectedDigest: `sha256:${"0".repeat(64)}`, preservedRecoveryId: "preserved-current50", currentLedger: ledgers[50], currentOpenReadonly: openReadonly }));
    assert.deepEqual(bytesTree(path.join(value.stateRoot, "data")), before);
    assert(!existsSync(path.join(value.evidenceRoot, "preserved-current50")));
  });
  await check("G69 partial publication preserves original database and staging and never automatically rolls back", async () => {
    assert.notEqual(process.getuid(), 0, "RAW_FIXTURE_UNPRIVILEGED_ACTOR_REQUIRED");
    const value = fixture("restore-partial", 50);
    const point = await api.createRawRecoveryPoint(value.options);
    const originalDirectory = path.join(value.stateRoot, ".raw-restore-preserved-partial-original");
    value.options.requireStopped = () => {
      if (existsSync(path.join(originalDirectory, "product.sqlite"))) chmodSync(path.join(value.stateRoot, "data"), 0o500);
    };
    let failure;
    try { await api.restoreRawRecoveryPoint({ ...value.options, expectedDigest: point.digest, preservedRecoveryId: "preserved-partial", currentLedger: ledgers[50], currentOpenReadonly: openReadonly }); } catch (error) { failure = error; }
    chmodSync(path.join(value.stateRoot, "data"), 0o700);
    assert(failure && failure.code === "EACCES");
    assert.equal(failure.rawRecovery.phase, "original-database-retained");
    assert.equal(failure.rawRecovery.automaticRollback, false);
    assert.equal(failure.rawRecovery.serviceStartAuthorized, false);
    assert(existsSync(path.join(originalDirectory, "product.sqlite")));
    assert(!existsSync(value.databasePath));
    assert(existsSync(path.join(value.stateRoot, "data/payload-ciphertext")));
    assert(existsSync(path.join(failure.rawRecovery.stagingDirectory, "data/product.sqlite")));
    assert(existsSync(path.join(value.evidenceRoot, "preserved-partial/manifest.json")));
    assert.equal(value.held(), false);
  });
}
const report = { passed: cases.length > 1 && cases.every((item) => item.passed), scope: "G69-real-sqlite-and-whole-ciphertext-tree-copy-restore-boundaries", total: cases.length, failed: cases.filter((item) => !item.passed).length, cases, fixtureSha256: sha(readFileSync(new URL(import.meta.url))), implementationSha256: existsSync(new URL("./raw-copy-recovery.mjs", import.meta.url)) ? sha(readFileSync(new URL("./raw-copy-recovery.mjs", import.meta.url))) : null, productionExecutionProved: false, stateRootLockBoundary: "fixture-exclusive-lock-adapter; production-maintenance-chain-must-exercise-installed-lock" };
rmSync(root, { recursive: true });
process.stdout.write(JSON.stringify(report) + "\n");
process.exitCode = report.passed ? 0 : 1;
