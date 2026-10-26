import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, writeSync } from "node:fs";
import path from "node:path";

export const recoveryMethod = "stopped-raw-copy-v1";
process.env.SQLITE_USE_URI = "1";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identityKeys = ["ownerId", "agentId", "deploymentId"];
const metadataKeys = ["dev", "ino", "uid", "gid", "mode", "nlink", "size", "mtimeNs", "ctimeNs"];
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);

function present(filename) {
  try { lstatSync(filename); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

function metadata(info) {
  return Object.fromEntries(metadataKeys.map((key) => [key, String(info[key])]));
}

function safeNode(filename, ownerUid, kind, exactMode) {
  const info = lstatSync(filename, { bigint: true });
  assert(!info.isSymbolicLink() && realpathSync(filename) === filename && Number(info.uid) === ownerUid && !(Number(info.mode) & 0o022), "ELEVENTH_RAW_COPY_PATH_UNSAFE");
  assert(kind === "directory" ? info.isDirectory() : info.isFile() && info.nlink === 1n, "ELEVENTH_RAW_COPY_NODE_UNSAFE");
  if (exactMode !== undefined) assert.equal(Number(info.mode) & 0o777, exactMode, "ELEVENTH_RAW_COPY_MODE_INVALID");
  return info;
}

export function requireNoDatabaseSidecars(filename) {
  for (const suffix of ["-wal", "-shm"]) assert(!present(filename + suffix), "ELEVENTH_RAW_COPY_DATABASE_SIDECAR_PRESENT");
}

function validateOptions(options) {
  assert(options && Number.isSafeInteger(options.ownerUid ?? process.getuid()) && [50, 51, 55, 56].includes(options.schema), "ELEVENTH_RAW_COPY_OPTIONS_INVALID");
  options = { ...options, ownerUid: options.ownerUid ?? process.getuid() };
  for (const key of ["stateRoot", "evidenceRoot"]) assert(typeof options[key] === "string" && path.isAbsolute(options[key]) && path.resolve(options[key]) === options[key], "ELEVENTH_RAW_COPY_ROOT_INVALID");
  assert(!inside(options.stateRoot, options.evidenceRoot) && !inside(options.evidenceRoot, options.stateRoot), "ELEVENTH_RAW_COPY_ROOTS_OVERLAP");
  assert(typeof options.recoveryId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.recoveryId), "ELEVENTH_RAW_COPY_ID_INVALID");
  for (const key of identityKeys) assert(typeof options.identity?.[key] === "string" && options.identity[key].length > 0, "ELEVENTH_RAW_COPY_IDENTITY_REQUIRED");
  assert(Array.isArray(options.expectedLedger) && options.expectedLedger.length === options.schema && typeof options.openReadonly === "function", "ELEVENTH_RAW_COPY_LEDGER_REQUIRED");
  safeNode(options.stateRoot, options.ownerUid, "directory");
  safeNode(options.evidenceRoot, options.ownerUid, "directory", 0o700);
  return options;
}

function syncDirectory(directory) {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function hashFile(filename, ownerUid, exactMode) {
  const before = safeNode(filename, ownerUid, "file", exactMode);
  const descriptor = openSync(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    assert.deepEqual(metadata(fstatSync(descriptor, { bigint: true })), metadata(before), "ELEVENTH_RAW_COPY_FILE_CHANGED");
    const buffer = Buffer.allocUnsafe(65536);
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    assert.deepEqual(metadata(fstatSync(descriptor, { bigint: true })), metadata(before), "ELEVENTH_RAW_COPY_FILE_CHANGED");
  } finally { closeSync(descriptor); }
  assert.deepEqual(metadata(safeNode(filename, ownerUid, "file", exactMode)), metadata(before), "ELEVENTH_RAW_COPY_FILE_CHANGED");
  assert.equal(BigInt(bytes), before.size, "ELEVENTH_RAW_COPY_FILE_SIZE_CHANGED");
  return { bytes, sha256: hash.digest("hex"), metadata: metadata(before) };
}

function readDataTree(directory, ownerUid, copied = false) {
  const nodes = [];
  const rootBefore = safeNode(directory, ownerUid, "directory", copied ? 0o700 : undefined);
  requireNoDatabaseSidecars(path.join(directory, "product.sqlite"));
  function visit(relative, kind) {
    const filename = path.join(directory, relative);
    if (kind === "file") {
      const value = hashFile(filename, ownerUid, copied ? 0o600 : undefined);
      assert.equal(value.metadata.dev, String(rootBefore.dev), "ELEVENTH_RAW_COPY_FILESYSTEM_ESCAPE");
      nodes.push({ path: relative, kind, ...value });
      return;
    }
    const before = safeNode(filename, ownerUid, "directory", copied ? 0o700 : undefined);
    assert.equal(before.dev, rootBefore.dev, "ELEVENTH_RAW_COPY_FILESYSTEM_ESCAPE");
    const names = readdirSync(filename).sort();
    nodes.push({ path: relative, kind, metadata: metadata(before) });
    for (const name of names) {
      assert(name !== "." && name !== ".." && !name.includes(path.sep), "ELEVENTH_RAW_COPY_MEMBER_NAME_INVALID");
      const child = path.join(relative, name);
      const info = lstatSync(path.join(directory, child));
      visit(child, info.isDirectory() ? "directory" : "file");
    }
    assert.deepEqual(readdirSync(filename).sort(), names, "ELEVENTH_RAW_COPY_DIRECTORY_CHANGED");
    assert.deepEqual(metadata(safeNode(filename, ownerUid, "directory", copied ? 0o700 : undefined)), metadata(before), "ELEVENTH_RAW_COPY_DIRECTORY_CHANGED");
  }
  visit("product.sqlite", "file");
  visit("payload-ciphertext", "directory");
  assert.deepEqual(metadata(safeNode(directory, ownerUid, "directory", copied ? 0o700 : undefined)), metadata(rootBefore), "ELEVENTH_RAW_COPY_DATA_ROOT_CHANGED");
  return nodes.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function members(nodes) {
  return nodes.map(({ metadata: ignored, ...entry }) => entry);
}

function copyFileExact(source, target, expected, ownerUid) {
  const before = safeNode(source, ownerUid, "file");
  assert.deepEqual(metadata(before), expected.metadata, "ELEVENTH_RAW_COPY_SOURCE_CHANGED");
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output;
  try {
    assert.deepEqual(metadata(fstatSync(input, { bigint: true })), expected.metadata, "ELEVENTH_RAW_COPY_SOURCE_CHANGED");
    output = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const buffer = Buffer.allocUnsafe(65536);
    for (;;) {
      const count = readSync(input, buffer, 0, buffer.length, null);
      if (count === 0) break;
      let written = 0;
      while (written < count) written += writeSync(output, buffer, written, count - written);
    }
    fsyncSync(output);
    assert.deepEqual(metadata(fstatSync(input, { bigint: true })), expected.metadata, "ELEVENTH_RAW_COPY_SOURCE_CHANGED");
  } finally {
    if (output !== undefined) closeSync(output);
    closeSync(input);
  }
  const result = hashFile(target, ownerUid, 0o600);
  assert.equal(result.bytes, expected.bytes, "ELEVENTH_RAW_COPY_BYTES_CHANGED");
  assert.equal(result.sha256, expected.sha256, "ELEVENTH_RAW_COPY_DIGEST_CHANGED");
}

function copyDataTree(source, target, nodes, ownerUid) {
  mkdirSync(target, { mode: 0o700 });
  for (const entry of nodes) {
    const destination = path.join(target, entry.path);
    if (entry.kind === "directory") mkdirSync(destination, { mode: 0o700 });
    else copyFileExact(path.join(source, entry.path), destination, entry, ownerUid);
  }
  for (const entry of nodes.filter((value) => value.kind === "directory").reverse()) syncDirectory(path.join(target, entry.path));
  syncDirectory(target);
  assert.deepEqual(members(readDataTree(target, ownerUid, true)), members(nodes), "ELEVENTH_RAW_COPY_TREE_CHANGED");
}

function verifyDatabase(filename, options) {
  requireNoDatabaseSidecars(filename);
  const database = options.openReadonly(filename);
  try {
    assert.equal(database.pragma("query_only", { simple: true }), 1, "ELEVENTH_RAW_COPY_QUERY_ONLY_REQUIRED");
    database.exec("BEGIN");
    const schema = Number(database.prepare("SELECT value FROM schema_metadata WHERE key='current_sequence'").get()?.value);
    const minimum = Number(database.prepare("SELECT value FROM schema_metadata WHERE key='minimum_writer_sequence'").get()?.value);
    assert(schema === options.schema && minimum === schema, "ELEVENTH_RAW_COPY_SCHEMA_CHANGED");
    const ledger = database.prepare("SELECT sequence,name,phase,digest,applied_at FROM schema_migration_ledger ORDER BY sequence").all();
    assert(ledger.length === schema && ledger.every((row, index) => row.sequence === index + 1), "ELEVENTH_RAW_COPY_LEDGER_SEQUENCE_INVALID");
    assert.deepEqual(ledger, options.expectedLedger, "ELEVENTH_RAW_COPY_LEDGER_CHANGED");
    const rows = database.prepare("SELECT id,owner_id,agent_id FROM deployments WHERE id=?").all(options.identity.deploymentId);
    assert.equal(rows.length, 1, "ELEVENTH_RAW_COPY_IDENTITY_AMBIGUOUS");
    assert.deepEqual(rows[0], { id: options.identity.deploymentId, owner_id: options.identity.ownerId, agent_id: options.identity.agentId }, "ELEVENTH_RAW_COPY_IDENTITY_CHANGED");
    assert.deepEqual(database.prepare("PRAGMA integrity_check").all(), [{ integrity_check: "ok" }], "ELEVENTH_RAW_COPY_INTEGRITY_FAILED");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), [], "ELEVENTH_RAW_COPY_FOREIGN_KEYS_FAILED");
    database.exec("COMMIT");
    return ledger;
  } finally {
    database.close();
    requireNoDatabaseSidecars(filename);
  }
}

function retainJson(filename, value, ownerUid) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + "\n");
  const descriptor = openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  syncDirectory(path.dirname(filename));
  safeNode(filename, ownerUid, "file", 0o600);
  assert.deepEqual(readFileSync(filename), bytes, "ELEVENTH_RAW_COPY_RETAINED_BYTES_CHANGED");
  return { path: filename, sha256: sha(bytes), bytes: bytes.length };
}

function verifyPoint(options) {
  const pointPath = path.join(options.evidenceRoot, options.recoveryId);
  safeNode(pointPath, options.ownerUid, "directory", 0o700);
  assert.deepEqual(readdirSync(pointPath).sort(), ["data", "manifest.json"], "ELEVENTH_RAW_COPY_POINT_MEMBERS_CHANGED");
  const manifestPath = path.join(pointPath, "manifest.json");
  const manifestInfo = hashFile(manifestPath, options.ownerUid, 0o600);
  const bytes = readFileSync(manifestPath);
  assert.equal(sha(bytes), manifestInfo.sha256, "ELEVENTH_RAW_COPY_MANIFEST_CHANGED");
  const digest = `sha256:${manifestInfo.sha256}`;
  if (options.expectedDigest !== undefined) assert.equal(digest, options.expectedDigest, "ELEVENTH_RAW_COPY_APPROVED_DIGEST_CHANGED");
  const manifest = JSON.parse(bytes);
  assert(manifest.schemaVersion === "himawari.stopped-raw-copy.v1" && manifest.method === recoveryMethod && manifest.recoveryId === options.recoveryId && manifest.schema === options.schema, "ELEVENTH_RAW_COPY_MANIFEST_BINDING_CHANGED");
  assert.deepEqual(manifest.identity, Object.fromEntries(identityKeys.map((key) => [key, options.identity[key]])), "ELEVENTH_RAW_COPY_MANIFEST_IDENTITY_CHANGED");
  const before = readDataTree(path.join(pointPath, "data"), options.ownerUid, true);
  assert.deepEqual(members(before), manifest.members, "ELEVENTH_RAW_COPY_MANIFEST_TREE_CHANGED");
  assert.deepEqual(manifest.ledger, options.expectedLedger, "ELEVENTH_RAW_COPY_MANIFEST_LEDGER_CHANGED");
  const ledger = verifyDatabase(path.join(pointPath, "data/product.sqlite"), options);
  const after = readDataTree(path.join(pointPath, "data"), options.ownerUid, true);
  assert.deepEqual(after, before, "ELEVENTH_RAW_COPY_VERIFICATION_CHANGED_COPY");
  assert.equal(sha(readFileSync(manifestPath)), manifestInfo.sha256, "ELEVENTH_RAW_COPY_MANIFEST_CHANGED");
  return { method: recoveryMethod, recoveryId: options.recoveryId, digest, schemaVersion: String(options.schema), schema: options.schema, ...manifest.identity, fullIntegrityCheck: "ok", foreignKeys: "ok", ledger, fileCount: before.filter((entry) => entry.kind === "file").length, payloadCount: before.filter((entry) => entry.kind === "file" && entry.path.startsWith("payload-ciphertext/")).length, pointPath, manifest: { path: manifestPath, sha256: manifestInfo.sha256, bytes: manifestInfo.bytes }, members: manifest.members, sourceDatabaseBeforeSha256: manifest.sourceDatabaseBeforeSha256, sourceDatabaseAfterSha256: manifest.sourceDatabaseAfterSha256 };
}

async function withStateLock(options, operation) {
  assert(typeof options.acquireStateRootLock === "function" && typeof options.requireStopped === "function", "ELEVENTH_RAW_COPY_STOPPED_LOCK_REQUIRED");
  options.requireStopped();
  const lock = await options.acquireStateRootLock(options.stateRoot);
  try {
    options.requireStopped();
    const result = await operation();
    options.requireStopped();
    return result;
  } finally { await lock.release(); }
}

function createPointLocked(options) {
  const source = path.join(options.stateRoot, "data");
  assert.equal(safeNode(source, options.ownerUid, "directory").dev, safeNode(options.stateRoot, options.ownerUid, "directory").dev, "ELEVENTH_RAW_COPY_FILESYSTEM_ESCAPE");
  const before = readDataTree(source, options.ownerUid);
  verifyDatabase(path.join(source, "product.sqlite"), options);
  assert.deepEqual(readDataTree(source, options.ownerUid), before, "ELEVENTH_RAW_COPY_SOURCE_CHANGED");
  const pointPath = path.join(options.evidenceRoot, options.recoveryId);
  mkdirSync(pointPath, { mode: 0o700 });
  syncDirectory(options.evidenceRoot);
  copyDataTree(source, path.join(pointPath, "data"), before, options.ownerUid);
  verifyDatabase(path.join(pointPath, "data/product.sqlite"), options);
  const after = readDataTree(source, options.ownerUid);
  assert.deepEqual(after, before, "ELEVENTH_RAW_COPY_SOURCE_CHANGED");
  const sourceHash = before.find((entry) => entry.path === "product.sqlite").sha256;
  retainJson(path.join(pointPath, "manifest.json"), { schemaVersion: "himawari.stopped-raw-copy.v1", method: recoveryMethod, recoveryId: options.recoveryId, schema: options.schema, identity: Object.fromEntries(identityKeys.map((key) => [key, options.identity[key]])), checkedAt: new Date().toISOString(), sourceDatabaseBeforeSha256: sourceHash, sourceDatabaseAfterSha256: after.find((entry) => entry.path === "product.sqlite").sha256, ledger: options.expectedLedger, members: members(before) }, options.ownerUid);
  const verifiedResult = verifyPoint(options);
  assert.deepEqual(readDataTree(source, options.ownerUid), before, "ELEVENTH_RAW_COPY_SOURCE_CHANGED");
  return { ...verifiedResult, verifiedResult };
}

export async function createRawRecoveryPoint(input) {
  const options = validateOptions(input);
  return withStateLock(options, () => createPointLocked(options));
}

export async function verifyRawRecoveryPoint(input) {
  return verifyPoint(validateOptions(input));
}

export async function restoreRawRecoveryPoint(input) {
  const options = validateOptions(input);
  assert(/^sha256:[a-f0-9]{64}$/.test(options.expectedDigest ?? ""), "ELEVENTH_RAW_COPY_APPROVED_DIGEST_REQUIRED");
  assert(typeof options.preservedRecoveryId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options.preservedRecoveryId) && options.preservedRecoveryId !== options.recoveryId, "ELEVENTH_RAW_COPY_PRESERVATION_ID_INVALID");
  const currentSchema = options.currentSchema ?? options.schema;
  assert([50, 51, 55].includes(currentSchema) && options.currentLedger.length === currentSchema, "ELEVENTH_RAW_COPY_OPTIONS_INVALID");
  return withStateLock(options, () => {
    const target = verifyPoint(options);
    const preservedCurrent = createPointLocked({ ...options, recoveryId: options.preservedRecoveryId, schema: currentSchema, expectedLedger: options.currentLedger, openReadonly: options.currentOpenReadonly, expectedDigest: undefined });
    const retainedOriginalDirectory = path.join(options.stateRoot, `.raw-restore-${options.preservedRecoveryId}-original`);
    const stagingDirectory = path.join(options.stateRoot, `.raw-restore-${options.preservedRecoveryId}-stage`);
    const journal = [];
    let phase = "current50-preserved";
    function record(next) {
      phase = next;
      journal.push(retainJson(path.join(options.evidenceRoot, `${options.preservedRecoveryId}-${next}.json`), { method: recoveryMethod, phase, targetRecoveryId: options.recoveryId, targetDigest: options.expectedDigest, preservedRecoveryId: options.preservedRecoveryId, preservedDigest: preservedCurrent.digest, retainedOriginalDirectory, stagingDirectory, serviceStartAuthorized: false, automaticRollback: false }, options.ownerUid));
    }
    try {
      assert(!present(retainedOriginalDirectory) && !present(stagingDirectory), "ELEVENTH_RAW_COPY_RESTORE_PATH_EXISTS");
      mkdirSync(retainedOriginalDirectory, { mode: 0o700 });
      mkdirSync(stagingDirectory, { mode: 0o700 });
      syncDirectory(options.stateRoot);
      const targetSource = path.join(target.pointPath, "data");
      const targetBefore = readDataTree(targetSource, options.ownerUid, true);
      copyDataTree(targetSource, path.join(stagingDirectory, "data"), targetBefore, options.ownerUid);
      verifyDatabase(path.join(stagingDirectory, "data/product.sqlite"), options);
      assert.deepEqual(readDataTree(targetSource, options.ownerUid, true), targetBefore, "ELEVENTH_RAW_COPY_RECOVERY_POINT_CHANGED");
      assert.equal(verifyPoint(options).digest, target.digest, "ELEVENTH_RAW_COPY_RECOVERY_POINT_CHANGED");
      const currentSource = readDataTree(path.join(options.stateRoot, "data"), options.ownerUid);
      assert.deepEqual(members(currentSource), preservedCurrent.members, "ELEVENTH_RAW_COPY_CURRENT_STATE_CHANGED");
      record("staging-verified");
      options.requireStopped();
      renameSync(path.join(options.stateRoot, "data/product.sqlite"), path.join(retainedOriginalDirectory, "product.sqlite"));
      syncDirectory(path.join(options.stateRoot, "data"));
      syncDirectory(retainedOriginalDirectory);
      record("original-database-retained");
      options.requireStopped();
      renameSync(path.join(options.stateRoot, "data/payload-ciphertext"), path.join(retainedOriginalDirectory, "payload-ciphertext"));
      syncDirectory(path.join(options.stateRoot, "data"));
      syncDirectory(retainedOriginalDirectory);
      assert.deepEqual(members(readDataTree(retainedOriginalDirectory, options.ownerUid)), preservedCurrent.members, "ELEVENTH_RAW_COPY_RETAINED_ORIGINAL_CHANGED");
      record("original-payload-retained");
      options.requireStopped();
      renameSync(path.join(stagingDirectory, "data/product.sqlite"), path.join(options.stateRoot, "data/product.sqlite"));
      syncDirectory(path.join(options.stateRoot, "data"));
      syncDirectory(path.join(stagingDirectory, "data"));
      record("database-published");
      options.requireStopped();
      renameSync(path.join(stagingDirectory, "data/payload-ciphertext"), path.join(options.stateRoot, "data/payload-ciphertext"));
      syncDirectory(path.join(options.stateRoot, "data"));
      syncDirectory(path.join(stagingDirectory, "data"));
      record("payload-published");
      const restoredBefore = readDataTree(path.join(options.stateRoot, "data"), options.ownerUid, true);
      assert.deepEqual(members(restoredBefore), target.members, "ELEVENTH_RAW_COPY_PUBLISHED_TREE_CHANGED");
      verifyDatabase(path.join(options.stateRoot, "data/product.sqlite"), options);
      assert.deepEqual(readDataTree(path.join(options.stateRoot, "data"), options.ownerUid, true), restoredBefore, "ELEVENTH_RAW_COPY_PUBLISHED_STATE_CHANGED");
      record("independent-readback-passed");
      return { preservedCurrent, restoredResult: target, retainedOriginalDirectory, stagingDirectory, publicationJournal: journal, restoredDataReadback: { members: members(restoredBefore), databaseSha256: restoredBefore.find((entry) => entry.path === "product.sqlite").sha256, fullIntegrityCheck: "ok", foreignKeys: "ok" }, serviceStartAuthorized: false, accountRecoveryRequired: true };
    } catch (error) {
      error.rawRecovery = { phase, preservedCurrent, retainedOriginalDirectory, stagingDirectory, publicationJournal: journal, automaticRollback: false, serviceStartAuthorized: false, accountRecoveryRequired: true };
      throw error;
    }
  });
}
