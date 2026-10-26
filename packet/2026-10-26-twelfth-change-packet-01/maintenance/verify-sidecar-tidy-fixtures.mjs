import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(path.join(process.cwd(), "package.json"));
const Database = require("better-sqlite3");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert(process.env.HIMAWARI_TEST_TEMP_ROOT, "SIDECAR_TIDY_FIXTURE_OWNED_TEMP_ROOT_REQUIRED");
const root = mkdtempSync(path.join(process.env.HIMAWARI_TEST_TEMP_ROOT, "sidecar-tidy-fixture-"));

const common = await import("./maintenance-common.mjs");
const { historyTables } = await import("../s0-db/read-s0-db.mjs");
const { requireNoDatabaseSidecars } = await import("./raw-copy-recovery.mjs");

const databaseSha = (filename) => sha(readFileSync(filename));
const sidecarList = (databasePath) => ["-wal", "-shm"].filter((suffix) => existsSync(databasePath + suffix));
const sidecarSizes = (databasePath) => Object.fromEntries(["-wal", "-shm"].map((suffix) => [suffix, existsSync(databasePath + suffix) ? lstatSync(databasePath + suffix).size : null]));
const openLenient = (filename) => {
  const database = new Database(filename, { readonly: true, fileMustExist: true });
  database.pragma("query_only=ON");
  return database;
};
const openImmutable = (filename) => {
  const database = new Database(pathToFileURL(filename).href + "?mode=ro&immutable=1", { readonly: true, fileMustExist: true });
  database.pragma("query_only=ON");
  return database;
};
const openStrict = (filename) => {
  requireNoDatabaseSidecars(filename);
  return openImmutable(filename);
};
const openReadWrite = (filename) => new Database(filename, { fileMustExist: true });
const mainFileRows = (databasePath) => {
  const database = openImmutable(databasePath);
  try { return { total: database.prepare("SELECT count(*) AS c FROM runs").get().c, child: database.prepare("SELECT count(*) AS c FROM runs WHERE id=?").get("run:fixture-child").c }; } finally { database.close(); }
};

function writeApproval(filename, action, stateRoot, preservedCurrentRecoveryId = "fixture-preserved-current51") {
  const approval = {
    schemaVersion: "himawari.twelfth-change-rollback-approval.v1",
    action,
    recoveryId: "fixture-raw51",
    targetStateRoot: stateRoot,
    targetPrefix: common.oldPrefix,
    discardsPostRecoveryPointHistory: true,
    discardsCapabilityUpgrade: true,
    requiresIndependentAccountRecovery: true,
    controlFilesApproved: true,
    approvalRef: "fixture:packet-b:rollback",
    preservedCurrentRecoveryId,
  };
  writeFileSync(filename, `${JSON.stringify(approval, null, 2)}\n`, { mode: 0o600 });
}

let inspectionCounter = 0;
function writeInspection(directory, finishedAt, overrides = {}) {
  inspectionCounter += 1;
  const report = {
    schemaVersion: "himawari.twelfth-change-stop.v1",
    mode: "inspect-only",
    passed: true,
    processesAbsent: { confirmed: true },
    serviceAfter: { ActiveState: "inactive", MainPID: "0" },
    finishedAt: new Date(finishedAt).toISOString(),
    ...overrides,
  };
  const filename = path.join(directory, `s2-inspection-${Date.now()}${inspectionCounter}.json`);
  writeFileSync(filename, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return filename;
}

function clearInspections(value) {
  for (const name of readdirSync(value.evidence)) rmSync(path.join(value.evidence, name));
}

function createDatabase(filename) {
  const database = new Database(filename);
  database.pragma("journal_mode=WAL");
  database.exec("CREATE TABLE schema_metadata(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE schema_migration_ledger(sequence INTEGER PRIMARY KEY,name TEXT,phase TEXT,digest TEXT,applied_at TEXT); CREATE TABLE capability_declarations(id TEXT PRIMARY KEY,version TEXT,status TEXT,revision INTEGER,integrity TEXT,record_json TEXT); CREATE TABLE product_state_records(key TEXT PRIMARY KEY,revision INTEGER,value_json TEXT);");
  for (const table of historyTables) database.exec(`CREATE TABLE "${table}"(id TEXT PRIMARY KEY,status TEXT);`);
  database.prepare("INSERT INTO schema_metadata VALUES(?,?)").run("current_sequence", "50");
  database.prepare("INSERT INTO schema_metadata VALUES(?,?)").run("minimum_writer_sequence", "50");
  for (let index = 0; index < 50; index += 1) database.prepare("INSERT INTO schema_migration_ledger VALUES(?,?,?,?,?)").run(index + 1, `migration-${index + 1}`, "expand", `sha256:${sha(String(index + 1))}`, "2026-10-13T00:00:00.000Z");
  database.prepare("INSERT INTO runs VALUES(?,?)").run("run:fixture-seed", "completed");
  database.prepare("INSERT INTO capability_declarations VALUES(?,?,?,?,?,?)").run("himawari.pi-coding", "1.0.0", "active", 1, "sha256:fixture", JSON.stringify({ ref: "himawari.pi-coding" }));
  database.prepare("INSERT INTO product_state_records VALUES(?,?,?)").run("host-workspace:directory-grant:fixture", 1, JSON.stringify({ grantId: "fixture" }));
  database.pragma("wal_checkpoint(TRUNCATE)");
  database.close();
  chmodSync(filename, 0o600);
}

function leaveSidecars(databasePath) {
  const database = openLenient(databasePath);
  try { database.prepare("SELECT count(*) AS count FROM sqlite_master").get(); } finally { database.close(); }
}

let caseIndex = 0;
function build(name) {
  caseIndex += 1;
  const directory = path.join(root, `${caseIndex}-${name}`);
  mkdirSync(directory, { mode: 0o700 });
  const stateRoot = path.join(directory, "state");
  const evidence = path.join(directory, "evidence");
  mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(evidence, { mode: 0o700 });
  const databasePath = path.join(stateRoot, "product.sqlite");
  createDatabase(databasePath);
  const approvalPath = path.join(directory, "rollback-approval.json");
  writeApproval(approvalPath, "S9_RAW_RESTORE51", stateRoot);
  const inspectionPath = writeInspection(evidence, Date.now());
  const binding = { maintenance: { recovery56Id: "fixture-raw51" }, paths: { stateRoot }, identity: { deploymentId: "deployment:fixture", ownerId: "owner:fixture", agentId: "agent:fixture" } };
  const expected = common.rollbackApprovalExpectation(binding, "S9_RAW_RESTORE51");
  const options = {
    database: databasePath,
    owner: process.getuid(),
    procRoot: "/proc",
    requireStopped: () => undefined,
    requireRollbackApproval: () => {
      const approval = common.verifyRollbackApproval(common.loadRollbackApproval(approvalPath, (filename) => JSON.parse(readFileSync(filename, "utf8"))), expected);
      return { filename: approvalPath, approval, sha256: sha(readFileSync(approvalPath)) };
    },
    requireFreshInspection: () => common.requireFreshInspection({ directory: evidence, owners: [process.getuid()] }),
    openLenient,
    openImmutable,
    openStrict,
    openReadWrite,
    collectState: common.collectTidyState,
  };
  return { directory, stateRoot, evidence, databasePath, approvalPath, inspectionPath, binding, expected, options };
}

function codeOf(error) {
  return error instanceof Error ? error.message.split("\n")[0] : String(error);
}

function expectCode(code, operation) {
  let caught = null;
  try { operation(); } catch (error) { caught = error; }
  assert(caught, `SIDECAR_TIDY_FIXTURE_ERROR_NOT_RAISED:${code}`);
  assert.equal(codeOf(caught), code, `SIDECAR_TIDY_FIXTURE_ERROR_MISMATCH:${code}:${codeOf(caught)}`);
  return caught;
}

const children = new Set();
const childScript = path.join(root, "child.mjs");
writeFileSync(childScript, `import { createRequire } from "node:module";
import path from "node:path";
const Database = createRequire(path.join(process.cwd(), "package.json"))("better-sqlite3");
const [action, database, value] = process.argv.slice(2);
const handle = new Database(database, action === "read" ? { readonly: true, fileMustExist: true } : { fileMustExist: true });
if (action === "write") {
  handle.pragma("journal_mode=WAL");
  handle.exec("BEGIN");
  handle.prepare("INSERT INTO runs VALUES(?,?)").run(value, "completed");
  handle.exec("COMMIT");
}
process.stdout.write("CHILD_READY\\n");
globalThis.sidecarTidyChildHandle = handle;
setInterval(() => undefined, 1000);
`, { mode: 0o600 });

async function startChild(action, databasePath, value) {
  const child = spawn(process.execPath, ["--no-global-search-paths", childScript, action, databasePath, value ?? ""], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  let stdout = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SIDECAR_TIDY_CHILD_READY_TIMEOUT")), 30000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); if (stdout.includes("CHILD_READY")) { clearTimeout(timer); resolve(); } });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`SIDECAR_TIDY_CHILD_EXITED_EARLY:${code}`)); });
  });
  return child;
}

async function stopChild(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => { child.once("exit", resolve); child.kill(signal); });
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

const sectionsEqual = (result) => {
  for (const section of common.tidyContentSections) assert.deepEqual(result.after[section], result.before[section], `SIDECAR_TIDY_FIXTURE_SECTION_CHANGED:${section}`);
};

let fatal = null;
try {
await check("F1 both sidecars from a read-only open are removed and the strict readback equals the lenient readback", "plan 乙-7 F1; fifth rehearsal production-shape-chain-report.json lines 308-311 {\"-wal\":0,\"-shm\":32768}; brief 批复 6/7", async () => {
  const value = build("F1");
  leaveSidecars(value.databasePath);
  assert.deepEqual(sidecarSizes(value.databasePath), { "-wal": 0, "-shm": 32768 }, "SIDECAR_TIDY_FIXTURE_HANDOFF_SCENE_CHANGED");
  const shaBefore = databaseSha(value.databasePath);
  const sidecarsBefore = sidecarList(value.databasePath);
  const result = common.tidyDatabaseSidecars(value.options);
  assert.deepEqual([result.noSidecars, result.readVia, result.journalMode, result.checkpointBusy], [false, "lenient-readonly", "wal", 0], "SIDECAR_TIDY_FIXTURE_F1_RESULT_CHANGED");
  assert.deepEqual(result.sidecarsAfter, { wal: { exists: false }, shm: { exists: false } }, "SIDECAR_TIDY_FIXTURE_F1_LEDGER_CHANGED");
  assert.deepEqual(sidecarList(value.databasePath), [], "SIDECAR_TIDY_FIXTURE_F1_SIDECARS_REMAIN");
  sectionsEqual(result);
  assert.equal(databaseSha(value.databasePath), shaBefore, "SIDECAR_TIDY_FIXTURE_F1_DATABASE_CHANGED");
  return { shaBefore, shaAfter: databaseSha(value.databasePath), sidecarsBefore, sidecarsAfter: sidecarList(value.databasePath), journalMode: result.journalMode, checkpoint: result.checkpoint };
});

await check("F2 committed frames still in the WAL after a killed writer are merged, kept and visible before and after", "plan 乙-7 F2; BL-20261017-007 committed-but-unmerged WAL frames; Claude reply 2026-10-18 item 2: the merge is proven by reading the main file with immutable=1 before and after, and SQLITE_CHECKPOINT_TRUNCATE reports log 0 and checkpointed 0 by definition after truncation (SQLite documentation on SQLITE_CHECKPOINT_TRUNCATE)", async () => {
  const value = build("F2");
  const child = await startChild("write", value.databasePath, "run:fixture-child");
  await stopChild(child, "SIGKILL");
  const walBeforeWrite = { exists: true, bytes: lstatSync(value.databasePath + "-wal").size, sha256: sha(readFileSync(value.databasePath + "-wal")) };
  assert(walBeforeWrite.bytes > 0, "SIDECAR_TIDY_FIXTURE_F2_WAL_EMPTY");
  const mainFileRunsBefore = mainFileRows(value.databasePath);
  assert.deepEqual(mainFileRunsBefore, { total: 1, child: 0 }, "SIDECAR_TIDY_FIXTURE_F2_MAIN_FILE_ALREADY_MERGED");
  const sidecarsBefore = sidecarList(value.databasePath);
  const result = common.tidyDatabaseSidecars(value.options);
  assert.equal(result.readVia, "lenient-readonly", "SIDECAR_TIDY_FIXTURE_F2_READ_VIA_CHANGED");
  assert.equal(result.checkpointBusy, 0, "SIDECAR_TIDY_FIXTURE_F2_BUSY");
  assert.deepEqual(result.checkpoint, [{ busy: 0, log: 0, checkpointed: 0 }], "SIDECAR_TIDY_FIXTURE_F2_CHECKPOINT_CHANGED");
  assert.deepEqual(result.sidecarsBeforeWrite, { wal: walBeforeWrite, shm: { exists: true } }, "SIDECAR_TIDY_FIXTURE_F2_WRITE_LEDGER_CHANGED");
  const mainFileRunsAfter = mainFileRows(value.databasePath);
  assert.deepEqual(mainFileRunsAfter, { total: 2, child: 1 }, "SIDECAR_TIDY_FIXTURE_F2_MAIN_FILE_NOT_MERGED");
  assert.equal(result.before.history.runs.rows, 2, "SIDECAR_TIDY_FIXTURE_F2_LENIENT_READ_MISSED_COMMITTED_FRAME");
  assert.equal(result.after.history.runs.rows, 2, "SIDECAR_TIDY_FIXTURE_F2_STRICT_READ_MISSED_MERGED_FRAME");
  sectionsEqual(result);
  assert.deepEqual(sidecarList(value.databasePath), [], "SIDECAR_TIDY_FIXTURE_F2_SIDECARS_REMAIN");
  return { sidecarsBefore, sidecarsBeforeWrite: result.sidecarsBeforeWrite, walBeforeWrite, mainFileRunsBefore, mainFileRunsAfter, runsRowsBefore: result.before.history.runs.rows, runsRowsAfter: result.after.history.runs.rows, checkpoint: result.checkpoint };
});

await check("F3 a process holding the database is refused before any content is read or written", "brief 步骤 2 F3 correction; plan 乙-2 item 2 /proc scan; BL open-by-other-process refusal", async () => {
  const value = build("F3");
  leaveSidecars(value.databasePath);
  const child = await startChild("read", value.databasePath);
  const shaBefore = databaseSha(value.databasePath);
  const sidecarsBefore = sidecarList(value.databasePath);
  const caught = expectCode("TWELFTH_MAINTENANCE_DATABASE_OPEN_BY_PROCESS", () => common.tidyDatabaseSidecars(value.options));
  assert.equal(caught.maintenanceDetail.processes[0].pid, child.pid, "SIDECAR_TIDY_FIXTURE_F3_REPORTED_PID_CHANGED");
  assert.equal(databaseSha(value.databasePath), shaBefore, "SIDECAR_TIDY_FIXTURE_F3_DATABASE_CHANGED");
  assert.deepEqual(sidecarList(value.databasePath), sidecarsBefore, "SIDECAR_TIDY_FIXTURE_F3_SIDECARS_CHANGED");
  await stopChild(child, "SIGTERM");
  return { reportedPid: caught.maintenanceDetail.processes[0].pid, sidecarsBefore, sidecarsAfter: sidecarList(value.databasePath) };
});

await check("F4 a service that is not stopped is refused before the approval or inspection is read", "plan 乙-2 item 1; maintenance-common requireStopped definition", async () => {
  const value = build("F4");
  leaveSidecars(value.databasePath);
  const shaBefore = databaseSha(value.databasePath);
  const sidecarsBefore = sidecarList(value.databasePath);
  value.options.requireStopped = () => { throw new Error("TWELFTH_MAINTENANCE_SERVICE_NOT_STOPPED"); };
  expectCode("TWELFTH_MAINTENANCE_SERVICE_NOT_STOPPED", () => common.tidyDatabaseSidecars(value.options));
  assert.equal(databaseSha(value.databasePath), shaBefore, "SIDECAR_TIDY_FIXTURE_F4_DATABASE_CHANGED");
  assert.deepEqual(sidecarList(value.databasePath), sidecarsBefore, "SIDECAR_TIDY_FIXTURE_F4_SIDECARS_CHANGED");
  return { shaBefore, shaAfter: databaseSha(value.databasePath), sidecarsBefore, sidecarsAfter: sidecarList(value.databasePath) };
});

await check("F6 a rollback journal beside a WAL database is refused and left in place", "plan 乙-3 item 1; existing S9 checks cover only -wal/-shm", async () => {
  const value = build("F6");
  const journalPath = `${value.databasePath}-journal`;
  writeFileSync(journalPath, "rollback-journal-evidence", { mode: 0o600 });
  const shaBefore = databaseSha(value.databasePath);
  const journalSha = sha(readFileSync(journalPath));
  expectCode("TWELFTH_MAINTENANCE_JOURNAL_SIDECAR_PRESENT", () => common.tidyDatabaseSidecars(value.options));
  assert.equal(databaseSha(value.databasePath), shaBefore, "SIDECAR_TIDY_FIXTURE_F6_DATABASE_CHANGED");
  assert.equal(existsSync(journalPath), true, "SIDECAR_TIDY_FIXTURE_F6_JOURNAL_DELETED");
  assert.equal(sha(readFileSync(journalPath)), journalSha, "SIDECAR_TIDY_FIXTURE_F6_JOURNAL_CHANGED");
  return { shaBefore, shaAfter: databaseSha(value.databasePath), journalPresent: existsSync(journalPath) };
});

await check("F7a a group-writable shm sidecar is refused and left in place", "plan 乙-3 item 1 file-safety style", async () => {
  const value = build("F7a");
  leaveSidecars(value.databasePath);
  chmodSync(value.databasePath + "-shm", 0o664);
  const shaBefore = databaseSha(value.databasePath);
  const sidecarsBefore = sidecarList(value.databasePath);
  expectCode("TWELFTH_MAINTENANCE_SIDECAR_UNSAFE", () => common.tidyDatabaseSidecars(value.options));
  assert.equal(databaseSha(value.databasePath), shaBefore, "SIDECAR_TIDY_FIXTURE_F7A_DATABASE_CHANGED");
  assert.deepEqual(sidecarList(value.databasePath), sidecarsBefore, "SIDECAR_TIDY_FIXTURE_F7A_SIDECARS_CHANGED");
  assert.equal(lstatSync(value.databasePath + "-shm").mode & 0o777, 0o664, "SIDECAR_TIDY_FIXTURE_F7A_MODE_CHANGED");
  return { shaBefore, shaAfter: databaseSha(value.databasePath), sidecarsBefore, sidecarsAfter: sidecarList(value.databasePath) };
});

await check("F7b a symlinked shm sidecar is refused and left in place", "plan 乙-3 item 1 file-safety style", async () => {
  const value = build("F7b");
  leaveSidecars(value.databasePath);
  const target = path.join(value.directory, "shm-target");
  rmSync(value.databasePath + "-shm");
  writeFileSync(target, "shm-symlink-target", { mode: 0o600 });
  symlinkSync(target, value.databasePath + "-shm");
  const shaBefore = databaseSha(value.databasePath);
  const sidecarsBefore = sidecarList(value.databasePath);
  expectCode("TWELFTH_MAINTENANCE_SIDECAR_UNSAFE", () => common.tidyDatabaseSidecars(value.options));
  assert.equal(databaseSha(value.databasePath), shaBefore, "SIDECAR_TIDY_FIXTURE_F7B_DATABASE_CHANGED");
  assert.deepEqual(sidecarList(value.databasePath), sidecarsBefore, "SIDECAR_TIDY_FIXTURE_F7B_SIDECARS_CHANGED");
  assert.equal(lstatSync(value.databasePath + "-shm").isSymbolicLink(), true, "SIDECAR_TIDY_FIXTURE_F7B_SYMLINK_CHANGED");
  return { shaBefore, shaAfter: databaseSha(value.databasePath), sidecarsBefore, sidecarsAfter: sidecarList(value.databasePath) };
});

await check("F8 a lone shm sidecar is read from the main file and both sidecars are gone afterwards", "plan 乙-7 F8; brief 批复 3 lone-shm branch", async () => {
  const value = build("F8");
  leaveSidecars(value.databasePath);
  rmSync(value.databasePath + "-wal");
  assert.deepEqual(sidecarList(value.databasePath), ["-shm"], "SIDECAR_TIDY_FIXTURE_F8_SCENE_CHANGED");
  const shaBefore = databaseSha(value.databasePath);
  const result = common.tidyDatabaseSidecars(value.options);
  assert.deepEqual([result.noSidecars, result.readVia, result.journalMode, result.checkpointBusy], [false, "immutable-readonly", "wal", 0], "SIDECAR_TIDY_FIXTURE_F8_RESULT_CHANGED");
  sectionsEqual(result);
  assert.deepEqual(sidecarList(value.databasePath), [], "SIDECAR_TIDY_FIXTURE_F8_SIDECARS_REMAIN");
  return { shaBefore, shaAfter: databaseSha(value.databasePath), readVia: result.readVia, checkpoint: result.checkpoint };
});

await check("F9 a lone wal sidecar without shm is refused before opening the database", "brief 步骤 2 F9 correction of plan 乙-7 F9 (refuse, not success); brief 批复 3", async () => {
  const value = build("F9");
  const child = await startChild("write", value.databasePath, "run:fixture-child");
  await stopChild(child, "SIGKILL");
  rmSync(value.databasePath + "-shm");
  assert.deepEqual(sidecarList(value.databasePath), ["-wal"], "SIDECAR_TIDY_FIXTURE_F9_SCENE_CHANGED");
  const shaBefore = databaseSha(value.databasePath);
  const sidecarsBefore = sidecarList(value.databasePath);
  expectCode("TWELFTH_MAINTENANCE_SIDECAR_READ_REQUIRES_SHM", () => common.tidyDatabaseSidecars(value.options));
  assert.equal(databaseSha(value.databasePath), shaBefore, "SIDECAR_TIDY_FIXTURE_F9_DATABASE_CHANGED");
  assert.deepEqual(sidecarList(value.databasePath), sidecarsBefore, "SIDECAR_TIDY_FIXTURE_F9_SIDECARS_CHANGED");
  return { shaBefore, shaAfter: databaseSha(value.databasePath), sidecarsBefore, sidecarsAfter: sidecarList(value.databasePath) };
});

await check("F10 a database without sidecars succeeds, records noSidecars and still proves the content", "brief 步骤 2 new F10; brief 批复 3 no-sidecars branch", async () => {
  const value = build("F10");
  const shaBefore = databaseSha(value.databasePath);
  const result = common.tidyDatabaseSidecars(value.options);
  assert.deepEqual([result.noSidecars, result.readVia, result.journalMode, result.checkpointBusy], [true, "immutable-readonly", null, null], "SIDECAR_TIDY_FIXTURE_F10_RESULT_CHANGED");
  assert.deepEqual(result.sidecarsBefore, { wal: { exists: false }, shm: { exists: false } }, "SIDECAR_TIDY_FIXTURE_F10_LEDGER_CHANGED");
  sectionsEqual(result);
  assert.equal(databaseSha(value.databasePath), shaBefore, "SIDECAR_TIDY_FIXTURE_F10_DATABASE_CHANGED");
  assert.deepEqual(sidecarList(value.databasePath), [], "SIDECAR_TIDY_FIXTURE_F10_SIDECARS_APPEARED");
  return { shaBefore, shaAfter: databaseSha(value.databasePath), noSidecars: result.noSidecars, readVia: result.readVia };
});

await check("F11a a missing rollback approval is refused with the S9 approval code", "brief 步骤 2 new F11; brief 批复 1 same approval checks as S9_RAW_RESTORE51", async () => {
  const value = build("F11a");
  leaveSidecars(value.databasePath);
  rmSync(value.approvalPath);
  const shaBefore = databaseSha(value.databasePath);
  const sidecarsBefore = sidecarList(value.databasePath);
  expectCode("TWELFTH_MAINTENANCE_ROLLBACK_APPROVAL_REQUIRED", () => common.tidyDatabaseSidecars(value.options));
  assert.equal(databaseSha(value.databasePath), shaBefore, "SIDECAR_TIDY_FIXTURE_F11A_DATABASE_CHANGED");
  assert.deepEqual(sidecarList(value.databasePath), sidecarsBefore, "SIDECAR_TIDY_FIXTURE_F11A_SIDECARS_CHANGED");
  return { shaBefore, shaAfter: databaseSha(value.databasePath), sidecarsBefore, sidecarsAfter: sidecarList(value.databasePath) };
});

await check("F11b an approval for another route is refused with the S9 route code", "brief 步骤 2 new F11; brief 批复 1 same approval checks as S9_RAW_RESTORE51", async () => {
  const value = build("F11b");
  leaveSidecars(value.databasePath);
  writeApproval(value.approvalPath, "S9_OTHER_ROUTE", value.stateRoot);
  const shaBefore = databaseSha(value.databasePath);
  const sidecarsBefore = sidecarList(value.databasePath);
  expectCode("TWELFTH_MAINTENANCE_ROLLBACK_ROUTE_CHANGED", () => common.tidyDatabaseSidecars(value.options));
  assert.equal(databaseSha(value.databasePath), shaBefore, "SIDECAR_TIDY_FIXTURE_F11B_DATABASE_CHANGED");
  assert.deepEqual(sidecarList(value.databasePath), sidecarsBefore, "SIDECAR_TIDY_FIXTURE_F11B_SIDECARS_CHANGED");
  return { shaBefore, shaAfter: databaseSha(value.databasePath), sidecarsBefore, sidecarsAfter: sidecarList(value.databasePath) };
});

await check("F11c an approval whose preserved current recovery point is the restore point is refused", "review reply 2026-10-18 item 2; the preserved current recovery point must not collide with the restore point", async () => {
  const value = build("F11c");
  leaveSidecars(value.databasePath);
  writeApproval(value.approvalPath, "S9_RAW_RESTORE51", value.stateRoot, "fixture-raw51");
  const shaBefore = databaseSha(value.databasePath);
  const sidecarsBefore = sidecarList(value.databasePath);
  expectCode("TWELFTH_MAINTENANCE_CURRENT_STATE_RECOVERY_REQUIRED", () => common.tidyDatabaseSidecars(value.options));
  assert.equal(databaseSha(value.databasePath), shaBefore, "SIDECAR_TIDY_FIXTURE_F11C_DATABASE_CHANGED");
  assert.deepEqual(sidecarList(value.databasePath), sidecarsBefore, "SIDECAR_TIDY_FIXTURE_F11C_SIDECARS_CHANGED");
  return { shaBefore, shaAfter: databaseSha(value.databasePath), sidecarsBefore, sidecarsAfter: sidecarList(value.databasePath) };
});

await check("F12a a stale S2 inspection is refused with the freshness code", "brief 步骤 2 new F12; brief 批复 1 fresh S2 inspection within 300 seconds", async () => {
  const value = build("F12a");
  leaveSidecars(value.databasePath);
  clearInspections(value);
  writeInspection(value.evidence, Date.now() - 400000);
  const shaBefore = databaseSha(value.databasePath);
  const sidecarsBefore = sidecarList(value.databasePath);
  expectCode("TWELFTH_MAINTENANCE_S2_INSPECTION_STALE", () => common.tidyDatabaseSidecars(value.options));
  assert.equal(databaseSha(value.databasePath), shaBefore, "SIDECAR_TIDY_FIXTURE_F12A_DATABASE_CHANGED");
  assert.deepEqual(sidecarList(value.databasePath), sidecarsBefore, "SIDECAR_TIDY_FIXTURE_F12A_SIDECARS_CHANGED");
  return { shaBefore, shaAfter: databaseSha(value.databasePath), sidecarsBefore, sidecarsAfter: sidecarList(value.databasePath) };
});

await check("F12b an S2 inspection without confirmed process absence is refused with the freshness code", "brief 步骤 2 new F12; brief 批复 1 processesAbsent.confirmed required", async () => {
  const value = build("F12b");
  leaveSidecars(value.databasePath);
  clearInspections(value);
  writeInspection(value.evidence, Date.now(), { processesAbsent: { confirmed: false } });
  const shaBefore = databaseSha(value.databasePath);
  const sidecarsBefore = sidecarList(value.databasePath);
  expectCode("TWELFTH_MAINTENANCE_S2_INSPECTION_NOT_FRESH", () => common.tidyDatabaseSidecars(value.options));
  assert.equal(databaseSha(value.databasePath), shaBefore, "SIDECAR_TIDY_FIXTURE_F12B_DATABASE_CHANGED");
  assert.deepEqual(sidecarList(value.databasePath), sidecarsBefore, "SIDECAR_TIDY_FIXTURE_F12B_SIDECARS_CHANGED");
  return { shaBefore, shaAfter: databaseSha(value.databasePath), sidecarsBefore, sidecarsAfter: sidecarList(value.databasePath) };
});

await check("F12c a missing S2 inspection is refused with the inspection-required code", "brief 步骤 2 new F12; brief 批复 1 an S2_INSPECT report is required", async () => {
  const value = build("F12c");
  leaveSidecars(value.databasePath);
  clearInspections(value);
  const shaBefore = databaseSha(value.databasePath);
  const sidecarsBefore = sidecarList(value.databasePath);
  expectCode("TWELFTH_MAINTENANCE_S2_INSPECTION_REQUIRED", () => common.tidyDatabaseSidecars(value.options));
  assert.equal(databaseSha(value.databasePath), shaBefore, "SIDECAR_TIDY_FIXTURE_F12C_DATABASE_CHANGED");
  assert.deepEqual(sidecarList(value.databasePath), sidecarsBefore, "SIDECAR_TIDY_FIXTURE_F12C_SIDECARS_CHANGED");
  return { shaBefore, shaAfter: databaseSha(value.databasePath), sidecarsBefore, sidecarsAfter: sidecarList(value.databasePath) };
});

await check("F13 a post-tidy readback that differs from the pre-tidy readback stops with the content-changed code", "brief 批复 5 post-tidy readback compare; plan 乙-4 list", async () => {
  const value = build("F13");
  leaveSidecars(value.databasePath);
  let calls = 0;
  value.options.collectState = (handle) => {
    calls += 1;
    const state = common.collectTidyState(handle);
    return calls === 1 ? state : { ...state, integrity: `${state.integrity}!` };
  };
  const caught = expectCode("TWELFTH_MAINTENANCE_TIDY_CONTENT_CHANGED", () => common.tidyDatabaseSidecars(value.options));
  assert.equal(caught.maintenanceDetail.section, "integrity", "SIDECAR_TIDY_FIXTURE_F13_SECTION_CHANGED");
  return { section: caught.maintenanceDetail.section, collectCalls: calls };
});

await check("F14 a missing collaborator is refused with the options code", "plan 乙-3; brief 批复 1 action receives its collaborators explicitly", async () => {
  expectCode("TWELFTH_MAINTENANCE_SIDECAR_TIDY_OPTIONS_INVALID", () => common.tidyDatabaseSidecars({}));
  return { collaborators: ["requireStopped", "requireRollbackApproval", "requireFreshInspection", "openLenient", "openImmutable", "openStrict", "openReadWrite", "collectState"] };
});
} catch (error) { fatal = String(error?.stack ?? error); }

for (const child of children) await stopChild(child, "SIGKILL");

const report = {
  schemaVersion: "himawari.twelfth-sidecar-tidy-fixtures.v1",
  passed: fatal === null && cases.length > 0 && cases.every((item) => item.passed),
  fatal,
  scope: "S9_SIDECAR_TIDY boundaries with a real WAL database, real /proc process scan and real better-sqlite3 pragma returns; the root-side S2_INSPECT survey, the production service unit and root file ownership are not executed here",
  total: cases.length,
  failed: cases.filter((item) => !item.passed).length,
  cases,
  expectedValueSources: {
    sidecarShape: "fifth rehearsal .ci-output/handoff/prod-fifth-evidence-c53bca70/rehearsal/shape-01/production-shape-chain-report.json lines 308-311 {-wal:0,-shm:32768}",
    comparisonList: "plan 乙-4 items 1-4; read-s0-db.mjs historyDigests; maintenance-common.mjs tidyContentSections",
    errorCodes: "brief 批复 1-5 and plan 乙-2/乙-3; not taken from this change's code",
  },
  fixtureSha256: sha(readFileSync(new URL(import.meta.url))),
  implementationSha256: sha(readFileSync(new URL("./maintenance-common.mjs", import.meta.url))),
  productionExecutionProved: false,
  manualDeletionByActionProved: false,
  rootProcessSurveyIncluded: false,
};
rmSync(root, { recursive: true });
process.stdout.write(JSON.stringify(report) + "\n");
process.exitCode = report.passed ? 0 : 1;
