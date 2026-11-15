import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, linkSync, readFileSync, lstatSync, readdirSync, readlinkSync, realpathSync, unlinkSync, writeFileSync, statfsSync } from "node:fs";
import path from "node:path";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { fixed, openReadonly, readS0State, readRouteAuthorization, readExistingWorkspace, one, catalogRegistrationPrefix, canonicalJson, historyDigests, historyTables, historyRow, ledgerMigrationId } from "../s0-db/read-s0-db.mjs";
import { validateWorkspacePlan, verifyExistingGrant, verifyWorkspaceIdentity } from "./workspace-grant.mjs";
import { requireNoDatabaseSidecars } from "./raw-copy-recovery.mjs";
import { newCapabilityRefs, webNetwork, webProviderSecretRef } from "../signing/cloud-capability-manifest.mjs";

export const operations = "/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__";
export const evidenceRoot = "/var/lib/himawari/__PKT_LABEL__-__PKT_DATE_COMPACT__-evidence";
export const oldPrefix = "__PKT_OLD_PREFIX__";
export const newPrefix = "/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__";
export const oldStaticRoot = `${oldPrefix}/share/control-center`;
export const newStaticRoot = `${newPrefix}/share/control-center`;
export const sqliteDriverRoot = `${newPrefix}/lib/himawari-agent`;
export const node = "/opt/himawari/node/bin/node";
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function definitionsForLedger(migrations, ledgerIds) {
  const definitions = new Map(migrations.map((migration) => [ledgerMigrationId(migration), migration]));
  return ledgerIds.map((row) => definitions.get(ledgerMigrationId(row)));
}

function present(filename) {
  try {
    lstatSync(filename);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function safeFile(filename, owners = [0, fixed.uid]) {
  const info = lstatSync(filename);
  assert(info.isFile() && !info.isSymbolicLink() && owners.includes(info.uid) && !(info.mode & 0o022) && realpathSync(filename) === filename, "__PKT_LABEL_UPPER___MAINTENANCE_FILE_UNSAFE");
  return info;
}

export function jsonFile(filename) {
  safeFile(filename);
  return JSON.parse(readFileSync(filename, "utf8"));
}

export function rootJsonFile(filename) {
  const info = safeFile(filename, [0]);
  assert(info.gid === fixed.gid && (info.mode & 0o777) === 0o640, "__PKT_LABEL_UPPER___MAINTENANCE_ROOT_REPORT_MODE_INVALID");
  return JSON.parse(readFileSync(filename, "utf8"));
}

export function sqliteDriver() {
  const require = createRequire(`${sqliteDriverRoot}/package.json`);
  return require(`${sqliteDriverRoot}/node_modules/better-sqlite3`);
}

export function openImmutableReadonly(filename = fixed.database, owner = fixed.uid) {
  safeFile(filename, [owner]);
  assert.equal(process.env.SQLITE_USE_URI, "1", "__PKT_LABEL_UPPER___SQLITE_URI_REQUIRED");
  const Database = sqliteDriver();
  const database = new Database(pathToFileURL(filename).href + "?mode=ro&immutable=1", { readonly: true, fileMustExist: true });
  database.pragma("query_only=ON");
  assert.equal(database.pragma("query_only", { simple: true }), 1, "__PKT_LABEL_UPPER___RAW_COPY_QUERY_ONLY_REQUIRED");
  return database;
}

export function openReadWriteDatabase(filename = fixed.database, owner = fixed.uid) {
  safeFile(filename, [owner]);
  const Database = sqliteDriver();
  return new Database(filename, { fileMustExist: true });
}

export function openLenientReadonly(filename = fixed.database, owner = fixed.uid) {
  safeFile(filename, [owner]);
  return openReadonly(sqliteDriverRoot, filename);
}

export function openRecoveryReadonly(prefix, filename = fixed.database, owner = fixed.uid) {
  safeFile(filename, [owner]);
  requireNoDatabaseSidecars(filename);
  return openImmutableReadonly(filename, owner);
}

export function verifyStartupAuthority(current, binding, startup) {
  assert.equal(startup.schemaVersion, "himawari.__PKT_LABEL__-change-startup-verification.v1", "__PKT_LABEL_UPPER___MAINTENANCE_STARTUP_REPORT_INVALID");
  assert.equal(startup.passed, true, "__PKT_LABEL_UPPER___MAINTENANCE_STARTUP_NOT_VERIFIED");
  const authority = startup.authority;
  for (const key of ["deploymentId", "ownerId", "agentId"]) {
    assert.equal(current[key], binding.identity[key], "__PKT_LABEL_UPPER___MAINTENANCE_LIVE_AUTHORITY_CHANGED");
    assert.equal(authority[key], binding.identity[key], "__PKT_LABEL_UPPER___MAINTENANCE_LIVE_AUTHORITY_CHANGED");
  }
  assert.equal(current.status, "active", "__PKT_LABEL_UPPER___MAINTENANCE_LIVE_AUTHORITY_NOT_ACTIVE");
  assert.equal(authority.status, "active", "__PKT_LABEL_UPPER___MAINTENANCE_LIVE_AUTHORITY_NOT_ACTIVE");
  assert.equal(authority.authorityEpoch, binding.authority.authorityEpoch, "__PKT_LABEL_UPPER___MAINTENANCE_LIVE_EPOCH_CHANGED");
  assert.equal(current.authorityEpoch, authority.authorityEpoch, "__PKT_LABEL_UPPER___MAINTENANCE_LIVE_EPOCH_CHANGED");
  assert.equal(current.fencingToken, authority.fencingToken, "__PKT_LABEL_UPPER___MAINTENANCE_LIVE_FENCING_CHANGED");
  assert(Number.isSafeInteger(authority.fencingToken) && authority.fencingToken > binding.authority.fencingToken, "__PKT_LABEL_UPPER___MAINTENANCE_LIVE_FENCING_NOT_ADVANCED");
  assert.equal(startup.currentEpoch, authority.authorityEpoch, "__PKT_LABEL_UPPER___MAINTENANCE_STARTUP_CURRENT_EPOCH_CHANGED");
  assert.equal(startup.currentFencingToken, authority.fencingToken, "__PKT_LABEL_UPPER___MAINTENANCE_STARTUP_CURRENT_FENCING_CHANGED");
  for (const boot of [startup.agentBinding, startup.workerBinding]) {
    for (const key of ["deploymentId", "ownerId", "agentId", "authorityEpoch", "fencingToken"]) assert.equal(boot[key], authority[key], "__PKT_LABEL_UPPER___MAINTENANCE_STARTUP_BOOT_AUTHORITY_CHANGED");
    for (const key of ["workerInstanceId", "workerBootId"]) assert(typeof boot[key] === "string" && boot[key].length > 0, "__PKT_LABEL_UPPER___MAINTENANCE_STARTUP_BOOT_ID_MISSING");
  }
  for (const key of ["workerInstanceId", "workerBootId"]) assert.equal(startup.agentBinding[key], startup.workerBinding[key], "__PKT_LABEL_UPPER___MAINTENANCE_STARTUP_BOOT_ID_CHANGED");
}

const usableGrantKeys = ["readAllowed", "hostMatchesRoute", "rootMatchesSnapshot", "currentlyUsable"];
export const strictCapabilityKeys = Object.freeze(["activeHealthy", "versionMatchesSnapshot", "operationsMatchSnapshot", "scopesMatchSnapshot", "costMatchesSnapshot", "secretRefsMatchSnapshot", "permissionRefsMatchSnapshot", "declarationMatchesSnapshotExceptArtifact", "snapshotIntegrityMatchesRunner", "storedIntegrityMatchesDeclaration", "runnerMatchesRecorded", "integrityMatchesSnapshot", "declarationInvariantMatchesSnapshot"]);
const catalogRegistrationRuntimeRoot = `${catalogRegistrationPrefix}/lib/himawari-agent`;
const grantKey = (id) => `host-workspace:directory-grant:${id}`;
const catalogAuditActions = Object.freeze(["owner.capability.upgrade", "owner.capability.scope_upgrade", "owner.capability.register"]);
export const expectedCatalogAudit = Object.freeze({ "himawari.pi-coding": "owner.capability.upgrade", "himawari.public-search": "owner.capability.upgrade", "himawari.public-fetch": "owner.capability.upgrade" });

export function verifyAuthorizationUsable(authorization) {
  assert(Array.isArray(authorization?.directoryGrants) && authorization.directoryGrants.length > 0 && Array.isArray(authorization.capabilities) && authorization.capabilities.length > 0, "__PKT_LABEL_UPPER___MAINTENANCE_AUTHORIZATION_MISSING");
  for (const grant of authorization.directoryGrants) {
    assert.equal(grant.revokedAt, null, "__PKT_LABEL_UPPER___MAINTENANCE_GRANT_REVOKED");
    assert(Date.parse(grant.expiresAt) > Date.now(), "__PKT_LABEL_UPPER___MAINTENANCE_GRANT_EXPIRED");
    for (const key of usableGrantKeys) assert.equal(grant[key], true, "__PKT_LABEL_UPPER___MAINTENANCE_GRANT_UNUSABLE");
  }
  for (const capability of authorization.capabilities) {
    for (const key of strictCapabilityKeys) assert.equal(capability[key], true, "__PKT_LABEL_UPPER___MAINTENANCE_CAPABILITY_NOT_STRICT:" + key);
    assert.equal(capability.actualRunnerSha256, capability.runnerSha256, "__PKT_LABEL_UPPER___MAINTENANCE_RUNNER_CHANGED");
  }
}

function byRef(capabilities, capabilityRef) {
  const matches = capabilities.filter((capability) => capability.capabilityRef === capabilityRef);
  assert.equal(matches.length, 1, "__PKT_LABEL_UPPER___MAINTENANCE_CAPABILITY_REF_AMBIGUOUS");
  return matches[0];
}

function withoutTime(value, field) {
  const copy = structuredClone(value);
  if (field === "health" && copy?.health) delete copy.health.checkedAt;
  if (field === "qualification" && copy) delete copy.checkedAt;
  return canonicalJson(copy);
}

export function readFrozenS0() {
  const filename = `${operations}/inputs/s0-db-readback.json`;
  const bytes = readFileSync(filename);
  safeFile(filename);
  return { s0: JSON.parse(bytes), sha256: sha(bytes) };
}

function readPendingCapabilities(database, binding, snapshot, runnerDigest) {
  return snapshot.capabilities.filter((entry) => newCapabilityRefs.includes(entry.manifest?.ref)).map((entry) => {
    const manifest = entry.manifest;
    const runner = entry.binding?.value?.runner;
    assert(typeof runner?.path === "string" && /^[a-f0-9]{64}$/.test(runner.sha256), "__PKT_LABEL_UPPER___MAINTENANCE_PENDING_RUNNER_INVALID");
    const registered = rows(database, "SELECT count(*) AS count FROM capability_declarations WHERE id=? AND owner_id=? AND agent_id=?", [manifest.ref, binding.identity.ownerId, binding.identity.agentId])[0].count;
    const actualRunnerSha256 = runnerDigest(runner.path);
    return { capabilityRef: manifest.ref, version: manifest.version, registered: registered !== 0, hostId: entry.binding.value.hostId, workerInstanceId: manifest.runtime?.argv?.[3], runtimeRoot: entry.binding.value.runtimeRoot, runnerSha256: runner.sha256, actualRunnerSha256, runnerMatchesRecorded: actualRunnerSha256 === runner.sha256, snapshotIntegrityMatchesRunner: manifest.integrity === "sha256:" + runner.sha256 && manifest.artifact?.digest === manifest.integrity, operations: manifest.operations.map((operation) => operation.name ?? operation), network: manifest.scopes.network, runtimeNetwork: manifest.runtime.network, secrets: manifest.scopes.secrets };
  });
}

export function readCatalogRecords(database, binding, frozen, extraRefs = []) {
  const expectedRefs = [...frozen.authorization.capabilities.map((expected) => expected.capabilityRef), ...extraRefs];
  const capabilities = expectedRefs.map((capabilityRef) => {
    const row = one(database, "SELECT id,version,status,revision,integrity,record_json FROM capability_declarations WHERE id=? AND owner_id=? AND agent_id=?", [capabilityRef, binding.identity.ownerId, binding.identity.agentId]);
    const record = JSON.parse(row.record_json);
    const unrevokedHandles = one(database, "SELECT count(*) AS count FROM capability_handles WHERE capability_id=? AND status='active'", [row.id]).count;
    return { capabilityRef: row.id, version: row.version, status: row.status, revision: row.revision, integrity: row.integrity, record, registryRecordSha256: sha(row.record_json), unrevokedHandles };
  });
  const grants = frozen.authorization.directoryGrants.map((expected) => {
    const row = one(database, "SELECT revision,value_json FROM product_state_records WHERE key=? AND owner_id=? AND agent_id=?", [grantKey(expected.grantId), binding.identity.ownerId, binding.identity.agentId]);
    return { grantId: expected.grantId, stateRevision: row.revision, metadataSha256: sha(row.value_json) };
  });
  const upgradeAudit = rows(database, `SELECT action,target_ref AS targetRef,outcome FROM audit_records WHERE owner_id=? AND agent_id=? AND action IN (${catalogAuditActions.map(() => "?").join(",")}) ORDER BY rowid`, [binding.identity.ownerId, binding.identity.agentId, ...catalogAuditActions]);
  return { capabilities, grants, upgradeAudit };
}

export function verifyCatalogRecordsAtS0(records, frozen) {
  assert.equal(records.capabilities.length, frozen.authorization.capabilities.length, "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_SET_CHANGED");
  for (const [index, expected] of frozen.authorization.capabilities.entries()) {
    const actual = records.capabilities[index];
    for (const [key, value] of Object.entries({ capabilityRef: expected.capabilityRef, version: expected.version, status: expected.status, revision: expected.revision, integrity: expected.storedIntegrity, registryRecordSha256: expected.registryRecordSha256 })) assert.equal(actual[key], value, "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_NOT_AT_S0:" + key);
  }
  for (const [index, expected] of frozen.authorization.directoryGrants.entries()) {
    const actual = records.grants[index];
    assert(actual.grantId === expected.grantId && actual.stateRevision === expected.stateRevision && actual.metadataSha256 === expected.metadataSha256, "__PKT_LABEL_UPPER___MAINTENANCE_GRANT_NOT_AT_S0");
  }
}

export function catalogStrictView(capabilities, snapshot) {
  return capabilities.map((record) => {
    const entries = snapshot.capabilities.filter((entry) => entry.manifest?.ref === record.capabilityRef);
    assert.equal(entries.length, 1, "__PKT_LABEL_UPPER___MAINTENANCE_SNAPSHOT_CAPABILITY_AMBIGUOUS");
    return { capabilityRef: record.capabilityRef, lifecycle: record.record.lifecycle, pendingDeclaration: record.record.pendingDeclaration ?? null, declarationEqualsSnapshot: withoutTime(record.record.declaration, "health") === withoutTime(entries[0].manifest, "health"), qualificationEqualsSnapshot: withoutTime(record.record.runtimeQualification, "qualification") === withoutTime(entries[0].qualification, "qualification"), rollbackIntegrity: record.record.rollbackDeclaration?.integrity ?? null, transitionOutcome: record.record.lastVersionTransition?.outcome ?? null, unrevokedHandles: record.unrevokedHandles };
  });
}

export function readCatalogState(binding, { prepared = false, upgraded = false, allowLiveWal = false } = {}) {
  const plan = validateWorkspacePlan(binding.workspace);
  assert(prepared || !upgraded, "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_STATE_ARGUMENT_INVALID");
  const { s0: frozen, sha256: s0Sha256 } = readFrozenS0();
  assert.equal(safeFile(fixed.configuration, [fixed.uid]).mode & 0o777, 0o600, "__PKT_LABEL_UPPER___MAINTENANCE_CONFIG_MODE_INVALID");
  const configurationBytes = readFileSync(fixed.configuration);
  const configuration = JSON.parse(configurationBytes);
  const stage = configurationStage(readOriginalConfiguration(binding), configuration);
  if (!prepared) assert(stage === "original" ? sha(configurationBytes) === binding.service.oldConfigSha256 : stage === "static-root" && sha(configurationBytes) === staticRootConfigurationSha256(binding), "__PKT_LABEL_UPPER___MAINTENANCE_UNPREPARED_CONFIG_REQUIRED");
  else assert.equal(stage, "prepared", "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_CONFIG_REQUIRED");
  assert.equal(configuration.runPolicy?.coding?.grantId, plan.grantId, "__PKT_LABEL_UPPER___MAINTENANCE_CONFIG_GRANT_CHANGED");
  const snapshotPath = `${fixed.stateRoot}/deployment/capability-deployment.json`;
  assert.equal(configuration.capabilityDeployment.snapshotPath, snapshotPath, "__PKT_LABEL_UPPER___MAINTENANCE_SNAPSHOT_PATH_CHANGED");
  assert.equal(safeFile(snapshotPath, [fixed.uid]).mode & 0o777, 0o600, "__PKT_LABEL_UPPER___MAINTENANCE_SNAPSHOT_MODE_INVALID");
  const snapshotBytes = readFileSync(snapshotPath);
  assert.equal(configuration.capabilityDeployment.sha256, `sha256:${sha(snapshotBytes)}`, "__PKT_LABEL_UPPER___MAINTENANCE_SNAPSHOT_CHANGED");
  const snapshot = JSON.parse(snapshotBytes);
  const runtimeRoot = `${prepared ? newPrefix : oldPrefix}/lib/himawari-agent`;
  const database = allowLiveWal ? openReadonly(sqliteDriverRoot, fixed.database) : openRecoveryReadonly(newPrefix, fixed.database, fixed.uid);
  try {
    database.exec("BEGIN");
    const runnerDigest = (filename) => {
      assert(filename.startsWith(`${runtimeRoot}/`), "__PKT_LABEL_UPPER___MAINTENANCE_RUNNER_PATH_CHANGED");
      safeFile(filename, [0]);
      return sha(readFileSync(filename));
    };
    const registeredSnapshot = upgraded ? snapshot : { ...snapshot, capabilities: snapshot.capabilities.filter((entry) => !newCapabilityRefs.includes(entry.manifest?.ref)) };
    const authorization = readRouteAuthorization(database, configuration, registeredSnapshot, runnerDigest, upgraded ? undefined : catalogRegistrationRuntimeRoot);
    verifyExistingGrant(authorization.directoryGrants, frozen.authorization.directoryGrants, plan);
    const pending = upgraded ? [] : readPendingCapabilities(database, binding, snapshot, runnerDigest);
    assert.deepEqual(pending.map((entry) => entry.capabilityRef), prepared && !upgraded ? [...newCapabilityRefs] : [], "__PKT_LABEL_UPPER___MAINTENANCE_PENDING_CAPABILITY_SET_CHANGED");
    const records = readCatalogRecords(database, binding, frozen, upgraded ? newCapabilityRefs : []);
    const authorityRow = one(database, "SELECT id,status,authority_epoch,fencing_token FROM deployments WHERE id=? AND owner_id=? AND agent_id=?", [binding.identity.deploymentId, binding.identity.ownerId, binding.identity.agentId]);
    const authority = { deploymentId: authorityRow.id, ownerId: binding.identity.ownerId, agentId: binding.identity.agentId, status: authorityRow.status, authorityEpoch: authorityRow.authority_epoch, fencingToken: authorityRow.fencing_token };
    assert.deepEqual({ ...authority, fencingToken: binding.authority.fencingToken }, binding.authority, "__PKT_LABEL_UPPER___MAINTENANCE_AUTHORITY_CHANGED");
    assert(Number.isSafeInteger(authority.fencingToken) && authority.fencingToken >= binding.authority.fencingToken, "__PKT_LABEL_UPPER___MAINTENANCE_AUTHORITY_CHANGED");
    database.exec("COMMIT");
    const strict = catalogStrictView(records.capabilities, snapshot);
    const workspace = verifyWorkspaceIdentity(readExistingWorkspace(plan.canonicalPath), frozen.workspace, plan);
    return { frozen, s0Sha256, authority, authorization, pending, records: { ...records, capabilities: records.capabilities.map(({ record, ...rest }) => rest) }, strict, workspace, configurationSha256: sha(configurationBytes), snapshotSha256: sha(snapshotBytes) };
  } finally {
    database.close();
  }
}

export function readPreUpgradeAuthorization(binding) {
  requireStopped();
  const current = readCatalogState(binding);
  assert.deepEqual(current.authorization, current.frozen.authorization, "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_AUTHORIZATION_CHANGED");
  assert.deepEqual(current.authority, binding.authority, "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_AUTHORITY_CHANGED");
  for (const capability of current.authorization.capabilities) {
    for (const key of strictCapabilityKeys) assert.equal(capability[key], true, "__PKT_LABEL_UPPER___MAINTENANCE_PREVIOUS_SHAPE_CHANGED:" + key);
  }
  verifyCatalogRecordsAtS0(current.records, current.frozen);
  requireStopped();
  return { schemaVersion: "himawari.__PKT_LABEL__-change-preupgrade-authorization.v1", passed: true, checkedAt: new Date().toISOString(), configurationSha256: current.configurationSha256, snapshotSha256: current.snapshotSha256, s0ReadbackSha256: current.s0Sha256, authorization: current.authorization, records: current.records, workspace: current.workspace };
}

export function verifyPreparedCapabilities(prepared) {
  for (const capability of prepared.authorization.capabilities) {
    const frozenCapability = prepared.frozen.authorization.capabilities.find((entry) => entry.capabilityRef === capability.capabilityRef);
    assert(frozenCapability, "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_CAPABILITY_SET_CHANGED");
    assert.equal(capability.runtimeRoot, `${newPrefix}/lib/himawari-agent`, "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_RUNTIME_CHANGED");
    for (const key of ["operationsMatchSnapshot", "costMatchesSnapshot", "permissionRefsMatchSnapshot", "versionMatchesSnapshot", "scopesMatchSnapshot", "secretRefsMatchSnapshot", "declarationMatchesSnapshotExceptArtifact"]) assert.equal(capability[key], true, "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_POLICY_CHANGED:" + key);
    assert.equal(capability.integrityMatchesSnapshot, frozenCapability.storedIntegrity === "sha256:" + capability.runnerSha256, "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_RUNNER_INTEGRITY_INCONSISTENT");
  }
}

export function verifyPendingCapabilities(pending, frozen) {
  assert.deepEqual(pending.map((entry) => entry.capabilityRef), [...newCapabilityRefs], "__PKT_LABEL_UPPER___MAINTENANCE_PENDING_CAPABILITY_SET_CHANGED");
  const identity = frozen.authorization.capabilities[0];
  for (const entry of pending) {
    assert.equal(entry.registered, false, "__PKT_LABEL_UPPER___MAINTENANCE_NEW_CAPABILITY_ALREADY_REGISTERED");
    assert.equal(entry.version, "1.0.0", "__PKT_LABEL_UPPER___MAINTENANCE_NEW_CAPABILITY_VERSION_CHANGED");
    assert(entry.hostId === identity.hostId && entry.workerInstanceId === identity.workerInstanceId && entry.runtimeRoot === `${newPrefix}/lib/himawari-agent`, "__PKT_LABEL_UPPER___MAINTENANCE_NEW_CAPABILITY_IDENTITY_CHANGED");
    assert(entry.runnerMatchesRecorded === true && entry.snapshotIntegrityMatchesRunner === true, "__PKT_LABEL_UPPER___MAINTENANCE_NEW_RUNNER_CHANGED");
    assert.deepEqual({ network: entry.network, runtimeNetwork: entry.runtimeNetwork, secrets: entry.secrets }, { network: [...webNetwork], runtimeNetwork: [...webNetwork], secrets: [webProviderSecretRef] }, "__PKT_LABEL_UPPER___MAINTENANCE_NEW_CAPABILITY_SCOPE_CHANGED");
  }
}

export function upgradeResultExpectation(value) {
  assert(value.frozen || (Array.isArray(value.upgraded) && Array.isArray(value.current) && Array.isArray(value.registered)), "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_RESULT_SHAPE_CHANGED");
  const refs = value.frozen ? value.frozen.authorization.capabilities.map((capability) => capability.capabilityRef) : value.upgraded;
  return { snapshotDigest: value.snapshotDigest, planDigest: value.planDigest, upgraded: [...refs].sort(), current: value.frozen ? [] : value.current, registered: value.frozen ? [...newCapabilityRefs] : value.registered, keys: value.frozen ? ["current", "planDigest", "registered", "snapshotDigest", "upgraded"] : Object.keys(value).sort() };
}

export function verifyUpgradedCatalog(current, previousAudit) {
  const frozen = current.frozen;
  verifyAuthorizationUsable(current.authorization);
  const refs = frozen.authorization.capabilities.map((capability) => capability.capabilityRef);
  assert.deepEqual(current.authorization.capabilities.map((capability) => capability.capabilityRef).sort(), [...refs, ...newCapabilityRefs].sort(), "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_CAPABILITY_SET_CHANGED");
  const upgraded = [];
  for (const [index, original] of frozen.authorization.capabilities.entries()) {
    const capability = byRef(current.authorization.capabilities, original.capabilityRef);
    const record = current.records.capabilities[index];
    const strict = current.strict[index];
    assert.equal(capability.runtimeRoot, `${newPrefix}/lib/himawari-agent`, "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_RUNTIME_CHANGED");
    for (const key of ["version", "status", "hostId", "workerInstanceId"]) assert.equal(capability[key], original[key], "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_IDENTITY_CHANGED:" + key);
    assert.equal(capability.revision, original.revision + 1, "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_REVISION_CHANGED");
    assert.equal(capability.storedIntegrity, "sha256:" + capability.runnerSha256, "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_INTEGRITY_CHANGED");
    assert.notEqual(capability.registryRecordSha256, original.registryRecordSha256, "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_RECORD_UNCHANGED");
    assert(record.capabilityRef === capability.capabilityRef && record.registryRecordSha256 === capability.registryRecordSha256 && record.integrity === capability.storedIntegrity && record.revision === capability.revision, "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_RECORD_CHANGED");
    assert(strict.capabilityRef === capability.capabilityRef && strict.lifecycle === "active" && strict.pendingDeclaration === null && strict.declarationEqualsSnapshot === true && strict.qualificationEqualsSnapshot === true && strict.transitionOutcome === "activated" && strict.rollbackIntegrity === original.storedIntegrity && strict.unrevokedHandles === 0, "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT");
    upgraded.push({ capabilityRef: capability.capabilityRef, revision: capability.revision, storedIntegrity: capability.storedIntegrity, registryRecordSha256: capability.registryRecordSha256 });
  }
  for (const [offset, ref] of newCapabilityRefs.entries()) {
    const index = refs.length + offset;
    const capability = byRef(current.authorization.capabilities, ref);
    const record = current.records.capabilities[index];
    const strict = current.strict[index];
    assert(capability.runtimeRoot === `${newPrefix}/lib/himawari-agent` && capability.version === "1.0.0" && capability.status === "active" && capability.hostId === frozen.authorization.capabilities[0].hostId && capability.workerInstanceId === frozen.authorization.capabilities[0].workerInstanceId, "__PKT_LABEL_UPPER___MAINTENANCE_REGISTERED_IDENTITY_CHANGED");
    assert.equal(capability.storedIntegrity, "sha256:" + capability.runnerSha256, "__PKT_LABEL_UPPER___MAINTENANCE_REGISTERED_INTEGRITY_CHANGED");
    assert(record.capabilityRef === ref && record.registryRecordSha256 === capability.registryRecordSha256 && record.integrity === capability.storedIntegrity && record.revision === capability.revision, "__PKT_LABEL_UPPER___MAINTENANCE_REGISTERED_RECORD_CHANGED");
    assert(strict.capabilityRef === ref && strict.lifecycle === "active" && strict.pendingDeclaration === null && strict.declarationEqualsSnapshot === true && strict.qualificationEqualsSnapshot === true && strict.rollbackIntegrity === null && strict.transitionOutcome === null && capability.revision === 1 && strict.unrevokedHandles === 0, "__PKT_LABEL_UPPER___MAINTENANCE_REGISTERED_DECLARATION_NOT_STRICT");
    upgraded.push({ capabilityRef: ref, revision: capability.revision, storedIntegrity: capability.storedIntegrity, registryRecordSha256: capability.registryRecordSha256 });
  }
  const audit = current.records.upgradeAudit;
  assert.deepEqual(audit.slice(0, previousAudit.length), previousAudit, "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_AUDIT_CHANGED");
  assert.deepEqual(audit.slice(previousAudit.length).map((entry) => `${entry.action}:${entry.targetRef}:${entry.outcome}`).sort(), [...refs, ...newCapabilityRefs].map((ref) => `${expectedCatalogAudit[ref]}:${ref}:completed`).sort(), "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_AUDIT_MISSING");
  return upgraded;
}

export function readCatalogUpgradeResult(binding) {
  const filename = `${evidenceRoot}/s7_catalog_upgrade-result.json`;
  assert.equal(safeFile(filename, [fixed.uid]).mode & 0o777, 0o600, "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_RESULT_MODE_INVALID");
  const bytes = readFileSync(filename);
  const report = JSON.parse(bytes);
  assert(report.schemaVersion === "himawari.__PKT_LABEL__-change-maintenance.v1" && report.action === "S7_CATALOG_UPGRADE" && report.passed === true, "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_UPGRADE_NOT_VERIFIED");
  assert.equal(report.bindingSha256, sha(readFileSync(`${operations}/inputs/bindings.json`)), "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_UPGRADE_BINDING_CHANGED");
  assert(Array.isArray(report.catalog?.upgraded) && report.catalog.upgraded.length > 0 && Array.isArray(report.catalog.upgradeAudit), "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_UPGRADE_RESULT_INVALID");
  return { report, sha256: sha(bytes) };
}

export function readPostSwitchAuthorization(binding) {
  const upgradeResult = readCatalogUpgradeResult(binding);
  const current = readCatalogState(binding, { prepared: true, upgraded: true, allowLiveWal: true });
  const before = upgradeResult.report.catalog;
  const upgraded = verifyUpgradedCatalog(current, before.upgradeAuditBefore);
  assert.deepEqual(upgraded, before.upgraded, "__PKT_LABEL_UPPER___MAINTENANCE_POST_SWITCH_CATALOG_CHANGED");
  assert.deepEqual(current.records.upgradeAudit, before.upgradeAudit, "__PKT_LABEL_UPPER___MAINTENANCE_POST_SWITCH_AUDIT_CHANGED");
  return { schemaVersion: "himawari.__PKT_LABEL__-change-post-switch-authorization.v1", passed: true, checkedAt: new Date().toISOString(), configurationSha256: current.configurationSha256, snapshotSha256: current.snapshotSha256, s0ReadbackSha256: current.s0Sha256, authority: current.authority, authorization: current.authorization, upgraded, catalogUpgradeSha256: upgradeResult.sha256, workspace: current.workspace };
}

export const approvedModelRef = "__PKT_MODEL_REF__";
export const originalModelLimits = Object.freeze({ contextWindow: __PKT_ORIGINAL_CONTEXT_WINDOW__, maxTokens: __PKT_ORIGINAL_MAX_TOKENS__ });
export const approvedModelLimits = Object.freeze({ contextWindow: __PKT_TARGET_CONTEXT_WINDOW__, maxTokens: __PKT_TARGET_MAX_TOKENS__ });
export const originalPublicFetchBytes = __PKT_ORIGINAL_PUBLIC_FETCH_BYTES__;
export const approvedPublicFetchBytes = __PKT_TARGET_PUBLIC_FETCH_BYTES__;
export const approvedEmbeddingDescriptor = Object.freeze(__PKT_TARGET_EMBEDDING_JSON__);

function applyApprovedEmbedding(configuration) {
  if (approvedEmbeddingDescriptor === null) return;
  const positions = Array.isArray(configuration.modelDescriptors) ? configuration.modelDescriptors.flatMap((entry, index) => (entry?.role === "embedding" ? [index] : [])) : [];
  assert(positions.length === 1 && configuration.memory && typeof configuration.memory === "object", "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_EMBEDDING_DESCRIPTOR_CHANGED");
  configuration.modelDescriptors[positions[0]] = structuredClone(approvedEmbeddingDescriptor);
  configuration.memory.dimensions = approvedEmbeddingDescriptor.dimensions;
  delete configuration.memory.minimumSimilarity;
  if (configuration.runPolicy?.proactive && typeof configuration.runPolicy.proactive === "object") delete configuration.runPolicy.proactive.memoryMinimumSimilarity;
}

export function staticRootConfiguration(original) {
  assert(original.http && typeof original.http === "object" && original.http.staticRoot === oldStaticRoot, "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_STATIC_ROOT_CHANGED");
  const models = Array.isArray(original.modelDescriptors) ? original.modelDescriptors.filter((entry) => entry?.ref === approvedModelRef) : [];
  assert(models.length === 1 && Object.entries(originalModelLimits).every(([key, value]) => models[0][key] === value), "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_MODEL_DESCRIPTOR_CHANGED");
  assert(!Object.hasOwn(original, "budgets"), "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_BUDGETS_PRESENT");
  assert.equal(original.runPolicy?.publicFetch?.maximumBytes, originalPublicFetchBytes, "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_PUBLIC_FETCH_CHANGED");
  const configuration = structuredClone(original);
  configuration.http.staticRoot = newStaticRoot;
  Object.assign(configuration.modelDescriptors.find((entry) => entry?.ref === approvedModelRef), approvedModelLimits);
  configuration.runPolicy.publicFetch.maximumBytes = approvedPublicFetchBytes;
  applyApprovedEmbedding(configuration);
  return configuration;
}

export function staticRootConfigurationBytes(original) {
  return Buffer.from(JSON.stringify(staticRootConfiguration(original), null, 2) + "\n");
}

export function configurationStage(original, current) {
  if (canonicalJson(current) === canonicalJson(original)) return "original";
  const { capabilityDeployment: expectedCapabilityDeployment, ...expectedFields } = staticRootConfiguration(original);
  const { capabilityDeployment: currentCapabilityDeployment, ...currentFields } = current;
  assert.deepEqual(currentFields, expectedFields, "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED");
  return JSON.stringify(currentCapabilityDeployment) === JSON.stringify(expectedCapabilityDeployment) ? "static-root" : "prepared";
}

export function readOriginalConfiguration(binding) {
  const originalPath = `${evidenceRoot}/original-config.json`;
  safeFile(originalPath, [fixed.uid]);
  const bytes = readFileSync(originalPath);
  assert.equal(sha(bytes), binding.service.oldConfigSha256, "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_CONFIG_CHANGED");
  return JSON.parse(bytes);
}

export function currentConfigurationStage(binding) {
  assert.equal(safeFile(fixed.configuration, [fixed.uid]).mode & 0o777, 0o600, "__PKT_LABEL_UPPER___MAINTENANCE_CONFIG_MODE_INVALID");
  return configurationStage(readOriginalConfiguration(binding), JSON.parse(readFileSync(fixed.configuration)));
}

export function staticRootConfigurationSha256(binding) {
  return sha(staticRootConfigurationBytes(readOriginalConfiguration(binding)));
}

function verifyPreparedConfiguration(configuration, configurationBytes, binding, requireStartupReport) {
  const snapshotPath = `${fixed.stateRoot}/deployment/capability-deployment.json`;
  assert.equal(configuration.capabilityDeployment.snapshotPath, snapshotPath, "__PKT_LABEL_UPPER___MAINTENANCE_SNAPSHOT_PATH_CHANGED");
  const snapshotBytes = readFileSync(snapshotPath);
  assert.equal(safeFile(snapshotPath, [fixed.uid]).mode & 0o777, 0o600, "__PKT_LABEL_UPPER___MAINTENANCE_SNAPSHOT_MODE_INVALID");
  assert.equal(configuration.capabilityDeployment.sha256, `sha256:${sha(snapshotBytes)}`, "__PKT_LABEL_UPPER___MAINTENANCE_SNAPSHOT_DIGEST_CHANGED");
  const qualification = binding.service.newQualificationEvidenceRoot;
  assert.equal(qualification, "/var/lib/himawari/qualification/__PKT_LABEL__-__PKT_DATE_COMPACT__", "__PKT_LABEL_UPPER___MAINTENANCE_QUALIFICATION_PATH_CHANGED");
  const receiptPath = `${qualification}/installation-receipt.json`;
  const keyPath = `${qualification}/host-qualification-public-key.pem`;
  const signaturePath = `${qualification}/installation-receipt.sig`;
  for (const filename of [receiptPath, keyPath, signaturePath]) safeFile(filename, [0]);
  const receiptBytes = readFileSync(receiptPath);
  const receipt = JSON.parse(receiptBytes);
  assert(verify(null, receiptBytes, createPublicKey(readFileSync(keyPath)), readFileSync(signaturePath)), "__PKT_LABEL_UPPER___MAINTENANCE_RECEIPT_SIGNATURE_INVALID");
  const { s0: frozen, sha256: s0Sha256 } = readFrozenS0();
  assert.deepEqual(receipt.bindingInputs.workspaceGrant, validateWorkspacePlan(binding.workspace), "__PKT_LABEL_UPPER___MAINTENANCE_SIGNED_WORKSPACE_GRANT_CHANGED");
  assert.deepEqual(receipt.bindingInputs.authorizedDirectoryGrants, frozen.authorization.directoryGrants, "__PKT_LABEL_UPPER___MAINTENANCE_SIGNED_GRANT_CHANGED");
  assert.deepEqual(receipt.bindingInputs.persistentCapabilityObservations, frozen.authorization.capabilities, "__PKT_LABEL_UPPER___MAINTENANCE_SIGNED_CAPABILITIES_CHANGED");
  assert.equal(receipt.bindingInputs.authorizationObservationSha256, s0Sha256, "__PKT_LABEL_UPPER___MAINTENANCE_SIGNED_S0_CHANGED");
  assert.equal(receipt.bindingInputs.originalConfigurationSha256, binding.service.oldConfigSha256, "__PKT_LABEL_UPPER___MAINTENANCE_SIGNED_ORIGINAL_CONFIG_CHANGED");
  assert.equal(receipt.runtime, `${newPrefix}/lib/himawari-agent`, "__PKT_LABEL_UPPER___MAINTENANCE_RECEIPT_RUNTIME_CHANGED");
  assert.equal(receipt.host, hostname(), "__PKT_LABEL_UPPER___MAINTENANCE_RECEIPT_HOST_CHANGED");
  const attestationPath = `${fixed.stateRoot}/deployment/startup-attestation.json`;
  assert.equal(safeFile(attestationPath, [fixed.uid]).mode & 0o777, 0o600, "__PKT_LABEL_UPPER___MAINTENANCE_ATTESTATION_MODE_INVALID");
  const attestation = jsonFile(attestationPath);
  assert.equal(attestation.receiptDigest, sha(receiptBytes), "__PKT_LABEL_UPPER___MAINTENANCE_ATTESTATION_RECEIPT_CHANGED");
  assert.equal(attestation.runtimeDigest, receipt.runtimeDigest, "__PKT_LABEL_UPPER___MAINTENANCE_ATTESTATION_RUNTIME_CHANGED");
  assert.equal(attestation.snapshotDigest, sha(snapshotBytes), "__PKT_LABEL_UPPER___MAINTENANCE_ATTESTATION_SNAPSHOT_CHANGED");
  assert.equal(attestation.signatureVerified, true, "__PKT_LABEL_UPPER___MAINTENANCE_ATTESTATION_SIGNATURE_UNVERIFIED");
  assert.equal(attestation.liveHostVerified, true, "__PKT_LABEL_UPPER___MAINTENANCE_ATTESTATION_HOST_UNVERIFIED");
  if (!requireStartupReport) return;
  const reportPath = `${evidenceRoot}/s7-startup-verification.json`;
  safeFile(reportPath, [0]);
  const rootReport = JSON.parse(readFileSync(reportPath));
  assert.equal(rootReport.schemaVersion, "himawari.__PKT_LABEL__-change-startup-verification.v1", "__PKT_LABEL_UPPER___MAINTENANCE_STARTUP_REPORT_INVALID");
  assert.equal(rootReport.passed, true, "__PKT_LABEL_UPPER___MAINTENANCE_STARTUP_NOT_VERIFIED");
  for (const [key, value] of Object.entries({ configurationSha256: sha(configurationBytes), snapshotSha256: sha(snapshotBytes), receiptSha256: sha(receiptBytes), runtimeDigest: receipt.runtimeDigest, signatureVerified: true, liveHostVerified: true })) assert.equal(rootReport[key], value, "__PKT_LABEL_UPPER___MAINTENANCE_STARTUP_REPORT_CHANGED");
}

export function loadBinding(requireStartupReport = true) {
  assert.equal(process.getuid(), fixed.uid, "__PKT_LABEL_UPPER___MAINTENANCE_ACTOR_INVALID");
  assert.equal(process.getgid(), fixed.gid, "__PKT_LABEL_UPPER___MAINTENANCE_ACTOR_INVALID");
  assert.equal(hostname(), "__PKT_HOSTNAME__", "__PKT_LABEL_UPPER___MAINTENANCE_HOST_INVALID");
  assert.equal(realpathSync(process.execPath), node, "__PKT_LABEL_UPPER___MAINTENANCE_NODE_INVALID");
  assert.equal(sha(readFileSync(node)), "e6ec2c188d83d813f81f2de8aea084d74dce603ac1abedd0a30ad941b10087b2", "__PKT_LABEL_UPPER___MAINTENANCE_NODE_CHANGED");
  assert.equal(process.env.HOME, fixed.stateRoot, "__PKT_LABEL_UPPER___MAINTENANCE_HOME_INVALID");
  assert.equal(process.env.PATH, "/opt/himawari/node/bin:/usr/bin:/bin", "__PKT_LABEL_UPPER___MAINTENANCE_PATH_INVALID");
  assert.equal(process.umask(), 0o022, "__PKT_LABEL_UPPER___MAINTENANCE_UMASK_INVALID");
  assert(!Object.hasOwn(process.env, "TMPDIR"), "__PKT_LABEL_UPPER___MAINTENANCE_TMPDIR_UNEXPECTED");
  const binding = jsonFile(`${operations}/inputs/bindings.json`);
  assert.equal(binding.status, "frozen-approved", "__PKT_LABEL_UPPER___MAINTENANCE_PACKAGE_NOT_FROZEN");
  assert(typeof binding.approvals.packageRef === "string" && binding.approvals.packageRef.length > 0 && !binding.approvals.packageRef.startsWith("S0_DB:"), "__PKT_LABEL_UPPER___MAINTENANCE_APPROVAL_REQUIRED");
  assert(!Object.hasOwn(binding, "configurationChange"), "__PKT_LABEL_UPPER___MAINTENANCE_CONFIG_CHANGE_NOT_ALLOWED");
  assert(!/"(PENDING:|S0_DB:|EXECUTION_OUTPUT:)/.test(JSON.stringify({ identity: binding.identity, workspace: binding.workspace, authority: binding.authority, service: binding.service })), "__PKT_LABEL_UPPER___MAINTENANCE_S0_BINDING_REQUIRED");
  assert.deepEqual(binding.identity, { deploymentId: fixed.deploymentId, ownerId: fixed.ownerId, agentId: fixed.agentId, hostId: fixed.hostId }, "__PKT_LABEL_UPPER___MAINTENANCE_IDENTITY_CHANGED");
  for (const key of ["authorityEpoch", "fencingToken"]) assert(Number.isSafeInteger(binding.authority[key]) && binding.authority[key] > 0, "__PKT_LABEL_UPPER___MAINTENANCE_S0_AUTHORITY_REQUIRED");
  validateWorkspacePlan(binding.workspace);
  assert.match(binding.service.oldConfigSha256, /^[a-f0-9]{64}$/, "__PKT_LABEL_UPPER___MAINTENANCE_S0_CONFIG_REQUIRED");
  for (const [key, value] of Object.entries({ oldPrefix, newPrefix, stateRoot: fixed.stateRoot, database: fixed.database, config: fixed.configuration, evidenceRoot, secretDirectory: "/var/lib/himawari/state/secrets" })) assert.equal(binding.paths[key], value, "__PKT_LABEL_UPPER___MAINTENANCE_PATH_BINDING_CHANGED");
  for (const [key, value] of Object.entries({ newPrepareHelper: `${operations}/cloud-protected-prepare.mjs`, newRuntimeProtectionFile: `${operations}/runtime-protection.json` })) assert.equal(binding.service[key], value, "__PKT_LABEL_UPPER___MAINTENANCE_SERVICE_BINDING_CHANGED");
  const rootInfo = lstatSync(evidenceRoot);
  assert(rootInfo.isDirectory() && rootInfo.uid === fixed.uid && rootInfo.gid === fixed.gid && (rootInfo.mode & 0o777) === 0o700 && realpathSync(evidenceRoot) === evidenceRoot, "__PKT_LABEL_UPPER___MAINTENANCE_EVIDENCE_UNSAFE");
  assert.equal(safeFile(fixed.configuration, [fixed.uid]).mode & 0o777, 0o600, "__PKT_LABEL_UPPER___MAINTENANCE_CONFIG_MODE_INVALID");
  const configurationBytes = readFileSync(fixed.configuration);
  const configuration = JSON.parse(configurationBytes);
  const stage = configurationStage(readOriginalConfiguration(binding), configuration);
  if (stage === "original") assert.equal(sha(configurationBytes), binding.service.oldConfigSha256, "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_CONFIG_CHANGED");
  if (stage === "static-root") assert.equal(sha(configurationBytes), staticRootConfigurationSha256(binding), "__PKT_LABEL_UPPER___MAINTENANCE_STATIC_ROOT_CONFIG_BYTES_CHANGED");
  if (stage === "prepared") verifyPreparedConfiguration(configuration, configurationBytes, binding, requireStartupReport);
  for (const key of ["ownerId", "agentId", "deploymentId"]) assert.equal(configuration[key], binding.identity[key], "__PKT_LABEL_UPPER___MAINTENANCE_CONFIG_IDENTITY_CHANGED");
  assert.equal(configuration.stateRoot, fixed.stateRoot, "__PKT_LABEL_UPPER___MAINTENANCE_CONFIG_STATE_CHANGED");
  return binding;
}

function prepareCommand(binding) {
  return ["/usr/bin/setpriv", "--no-new-privs", node, "--no-global-search-paths", binding.service.newPrepareHelper, "--prepare", fixed.configuration];
}

export function runPrepare(binding) {
  requireStopped();
  for (const filename of [`${fixed.configuration}.next`, `${fixed.stateRoot}/deployment/capability-deployment.json.next`]) assert(!present(filename), "__PKT_LABEL_UPPER___MAINTENANCE_PREPARE_LEFTOVER_PRESENT");
  safeFile(binding.service.newPrepareHelper, [0]);
  safeFile(binding.service.newRuntimeProtectionFile, [0]);
  const command = prepareCommand(binding);
  const output = spawnSync(command[0], command.slice(1), { cwd: fixed.stateRoot, encoding: "utf8", timeout: 240000, maxBuffer: 16777216, env: { HOME: fixed.stateRoot, PATH: "/opt/himawari/node/bin:/usr/bin:/bin", LANG: "C.UTF-8", HIMAWARI_RUNTIME_PROTECTION_FILE: binding.service.newRuntimeProtectionFile }, stdio: ["ignore", "pipe", "pipe"] });
  const record = { checkedAt: new Date().toISOString(), actor: { uid: process.getuid(), account: "himawari-prod", hostname: hostname() }, command, status: output.status, signal: output.signal, stdout: output.stdout ?? "", stderr: output.stderr ?? "", errorCode: output.error?.code ?? null };
  const retained = retainedJson("s7-catalog-prepare-command.json", record);
  assert(output.status === 0 && output.signal === null && !output.error, "__PKT_LABEL_UPPER___MAINTENANCE_PREPARE_FAILED");
  requireStopped();
  for (const filename of [`${fixed.configuration}.next`, `${fixed.stateRoot}/deployment/capability-deployment.json.next`]) assert(!present(filename), "__PKT_LABEL_UPPER___MAINTENANCE_PREPARE_LEFTOVER_PRESENT");
  const event = JSON.parse(output.stdout.trim().split("\n").at(-1));
  const snapshotPath = `${fixed.stateRoot}/deployment/capability-deployment.json`;
  for (const filename of [fixed.configuration, snapshotPath, `${fixed.stateRoot}/deployment/startup-attestation.json`]) {
    const info = safeFile(filename, [fixed.uid]);
    assert(info.gid === fixed.gid && (info.mode & 0o777) === 0o600, "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_FILE_MODE_INVALID");
  }
  assert(event.event === "installation-verified" && event.preparing === true && event.snapshotDigest === sha(readFileSync(snapshotPath)), "__PKT_LABEL_UPPER___MAINTENANCE_PREPARE_OUTPUT_INVALID");
  return { retained, snapshotSha256: event.snapshotDigest, configurationSha256: sha(readFileSync(fixed.configuration)) };
}

export function verifyUpgradePlan(plan, prepared) {
  const frozen = prepared.frozen;
  assert.deepEqual(Object.keys(plan).sort(), ["current", "planDigest", "registrations", "snapshotDigest", "upgrades"], "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_SHAPE_CHANGED");
  assert.equal(plan.snapshotDigest, `sha256:${prepared.snapshotSha256}`, "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_SNAPSHOT_CHANGED");
  assert.match(plan.planDigest, /^sha256:[a-f0-9]{64}$/, "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_DIGEST_INVALID");
  assert.deepEqual(plan.current, [], "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_CURRENT_UNEXPECTED");
  assert.deepEqual(plan.upgrades.map((entry) => entry.ref).sort(), frozen.authorization.capabilities.map((capability) => capability.capabilityRef).sort(), "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_SET_CHANGED");
  for (const original of frozen.authorization.capabilities) {
    const entries = plan.upgrades.filter((candidate) => candidate.ref === original.capabilityRef);
    assert.equal(entries.length, 1, "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_SET_CHANGED");
    const entry = entries[0];
    const snapshotCapability = byRef(prepared.authorization.capabilities, original.capabilityRef);
    const scopeChanges = { expansions: [], contractions: [] };
    assert.deepEqual({ ...entry, scopeChanges: { expansions: [...(entry.scopeChanges?.expansions ?? [])].sort(), contractions: [...(entry.scopeChanges?.contractions ?? [])].sort() } }, { ref: original.capabilityRef, version: original.version, fromIntegrity: original.storedIntegrity, toIntegrity: "sha256:" + snapshotCapability.runnerSha256, fromRuntimeRoot: `${oldPrefix}/lib/himawari-agent`, toRuntimeRoot: `${newPrefix}/lib/himawari-agent`, scopeChanges }, "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_ENTRY_CHANGED");
  }
  const pending = prepared.pending;
  assert.deepEqual(plan.registrations, pending.map((entry) => ({ ref: entry.capabilityRef, version: entry.version, integrity: "sha256:" + entry.runnerSha256, operations: entry.operations, network: [...webNetwork], secrets: [webProviderSecretRef] })), "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_REGISTRATIONS_CHANGED");
  return plan.planDigest;
}

const catalogResumeRecords = Object.freeze({ catalogBefore: "s7-catalog-before.json", prepare: "s7-catalog-prepare-command.json", plan: "s7-catalog-plan-command.json", upgrade: "s7-catalog-upgrade-command.json" });

function lastJsonLine(text) {
  const result = JSON.parse(String(text).trim().split("\n").at(-1));
  assert(result && typeof result === "object", "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_RESUME_OUTPUT_INVALID");
  return result;
}

function requireRetainedCommand(record, command) {
  assert.deepEqual(record.command, command, "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_RESUME_COMMAND_CHANGED");
  assert(record.status === 0 && record.signal === null && record.errorCode === null, "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_RESUME_COMMAND_FAILED");
  return lastJsonLine(record.stdout);
}

export function readCatalogResume(binding) {
  const approvalPath = `${evidenceRoot}/s7-catalog-resume-approval.json`;
  const approval = rootJsonFile(approvalPath);
  assert(approval.schemaVersion === "himawari.__PKT_LABEL__-change-catalog-resume-approval.v1" && approval.action === "S7_CATALOG_UPGRADE" && approval.failedCondition === "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT" && typeof approval.approvalRef === "string" && approval.approvalRef.length > 0 && approval.bindingSha256 === sha(readFileSync(`${operations}/inputs/bindings.json`)), "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_RESUME_APPROVAL_INVALID");
  assert.deepEqual(Object.keys(approval.retained ?? {}).sort(), Object.keys(catalogResumeRecords).sort(), "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_RESUME_APPROVAL_INVALID");
  const retained = {};
  const records = {};
  for (const [key, name] of Object.entries(catalogResumeRecords)) {
    const filename = `${evidenceRoot}/${name}`;
    assert.equal(safeFile(filename, [fixed.uid]).mode & 0o777, 0o600, "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_RESUME_RECORD_UNSAFE");
    const bytes = readFileSync(filename);
    retained[key] = { path: filename, sha256: sha(bytes), bytes: bytes.length };
    assert.deepEqual(retained[key], approval.retained[key], "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_RESUME_RECORD_CHANGED:" + key);
    records[key] = JSON.parse(bytes);
  }
  const { s0: frozen, sha256: s0Sha256 } = readFrozenS0();
  const original = records.catalogBefore;
  assert(original.schemaVersion === "himawari.__PKT_LABEL__-change-preupgrade-authorization.v1" && original.passed === true && original.configurationSha256 === staticRootConfigurationSha256(binding) && original.s0ReadbackSha256 === s0Sha256, "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_RESUME_ORIGINAL_INVALID");
  assert.deepEqual(original.authorization, frozen.authorization, "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_AUTHORIZATION_CHANGED");
  verifyCatalogRecordsAtS0(original.records, frozen);
  const event = requireRetainedCommand(records.prepare, prepareCommand(binding));
  assert(event.event === "installation-verified" && event.preparing === true && /^[a-f0-9]{64}$/.test(event.snapshotDigest), "__PKT_LABEL_UPPER___MAINTENANCE_PREPARE_OUTPUT_INVALID");
  assert(approval.preparedConfigurationSha256 === sha(readFileSync(fixed.configuration)) && approval.snapshotSha256 === event.snapshotDigest && event.snapshotDigest === sha(readFileSync(`${fixed.stateRoot}/deployment/capability-deployment.json`)), "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_RESUME_SCENE_CHANGED");
  const himawari = `${newPrefix}/bin/himawari`;
  const plan = requireRetainedCommand(records.plan, [himawari, "capabilities", "upgrade-plan", "--config", binding.paths.config, "--reviewed"]);
  const upgrade = requireRetainedCommand(records.upgrade, [himawari, "capabilities", "upgrade", "--config", binding.paths.config, "--confirm", plan.planDigest, "--reviewed"]);
  return { approval: { path: approvalPath, sha256: sha(readFileSync(approvalPath)), approvalRef: approval.approvalRef }, retained, original, snapshotSha256: event.snapshotDigest, plan, upgrade };
}

export function readRestoredCatalog(binding, prefix = oldPrefix) {
  const { s0: frozen } = readFrozenS0();
  const database = openRecoveryReadonly(prefix, fixed.database, fixed.uid);
  try {
    database.exec("BEGIN");
    const records = readCatalogRecords(database, binding, frozen);
    database.exec("COMMIT");
    verifyCatalogRecordsAtS0(records, frozen);
    return { ...records, capabilities: records.capabilities.map(({ record, ...rest }) => rest) };
  } finally {
    database.close();
  }
}

export function retainedJson(name, value, { supersede = false } = {}) {
  assert(/^[a-z0-9][a-z0-9._-]*\.json$/.test(name), "__PKT_LABEL_UPPER___MAINTENANCE_REPORT_NAME_INVALID");
  const filename = path.join(evidenceRoot, name);
  if (supersede && existsSync(filename)) {
    safeFile(filename, [fixed.uid]);
    for (let sequence = 1; ; sequence += 1) {
      try {
        linkSync(filename, `${filename}.superseded-${sequence}`);
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    }
    unlinkSync(filename);
  }
  writeFileSync(filename, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  safeFile(filename, [fixed.uid]);
  return { path: filename, sha256: sha(readFileSync(filename)), bytes: lstatSync(filename).size };
}

export function requireStopped() {
  const output = execFileSync("/usr/bin/systemctl", ["show", "himawari-prod.service", "--property=ActiveState,SubState,MainPID", "--no-pager"], { encoding: "utf8", timeout: 10000, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", SYSTEMD_PAGER: "cat" } });
  const values = Object.fromEntries(output.trim().split("\n").map((line) => line.split("=")));
  assert.equal(values.ActiveState, "inactive", "__PKT_LABEL_UPPER___MAINTENANCE_SERVICE_NOT_STOPPED");
  assert.equal(values.MainPID, "0", "__PKT_LABEL_UPPER___MAINTENANCE_MAIN_PROCESS_REMAINED");
  return values;
}

export async function persistence(prefix = newPrefix) {
  return import(pathToFileURL(`${prefix}/lib/himawari-agent/node_modules/@himawari-agent/persistence-sqlite/dist/index.js`));
}

export async function requireStateUnlocked(prefix = newPrefix) {
  requireStopped();
  const { acquireStateRootLock } = await persistence(prefix);
  const lock = await acquireStateRootLock(fixed.stateRoot);
  await lock.release();
  requireStopped();
}

export function rollbackApprovalExpectation(binding, action) {
  return { schemaVersion: "himawari.__PKT_LABEL__-change-rollback-approval.v1", action, recoveryId: recoveryIdForSchema(binding, currentSchema), targetStateRoot: binding.paths.stateRoot, targetPrefix: oldPrefix };
}

export function verifyRollbackApproval(approval, expected) {
  assert.equal(approval.schemaVersion, expected.schemaVersion, "__PKT_LABEL_UPPER___MAINTENANCE_ROLLBACK_APPROVAL_INVALID");
  assert.equal(approval.action, expected.action, "__PKT_LABEL_UPPER___MAINTENANCE_ROLLBACK_ROUTE_CHANGED");
  assert.equal(approval.recoveryId, expected.recoveryId, "__PKT_LABEL_UPPER___MAINTENANCE_ROLLBACK_BACKUP_CHANGED");
  assert.equal(approval.targetStateRoot, expected.targetStateRoot, "__PKT_LABEL_UPPER___MAINTENANCE_ROLLBACK_TARGET_CHANGED");
  assert.equal(approval.discardsPostRecoveryPointHistory, true, "__PKT_LABEL_UPPER___MAINTENANCE_ROLLBACK_LOSS_NOT_APPROVED");
  assert.equal(approval.discardsCapabilityUpgrade, true, "__PKT_LABEL_UPPER___MAINTENANCE_ROLLBACK_UPGRADE_LOSS_NOT_ACKNOWLEDGED");
  assert.equal(approval.requiresIndependentAccountRecovery, true, "__PKT_LABEL_UPPER___MAINTENANCE_ROLLBACK_ACCOUNT_RECOVERY_NOT_ACKNOWLEDGED");
  assert.equal(approval.controlFilesApproved, true, "__PKT_LABEL_UPPER___MAINTENANCE_ROLLBACK_CONTROL_FILES_NOT_APPROVED");
  assert.equal(approval.targetPrefix, expected.targetPrefix, "__PKT_LABEL_UPPER___MAINTENANCE_ROLLBACK_PREFIX_CHANGED");
  assert(typeof approval.approvalRef === "string" && approval.approvalRef.length > 0 && !/^(PENDING:|S0_DB:|EXECUTION_OUTPUT:)/.test(approval.approvalRef), "__PKT_LABEL_UPPER___MAINTENANCE_ROLLBACK_APPROVAL_REQUIRED");
  assert(typeof approval.preservedCurrentRecoveryId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(approval.preservedCurrentRecoveryId) && approval.preservedCurrentRecoveryId !== expected.recoveryId, "__PKT_LABEL_UPPER___MAINTENANCE_CURRENT_STATE_RECOVERY_REQUIRED");
  return approval;
}

export function loadRollbackApproval(filename, parse = rootJsonFile) {
  assert(present(filename), "__PKT_LABEL_UPPER___MAINTENANCE_ROLLBACK_APPROVAL_REQUIRED");
  return parse(filename);
}

export function readRollbackApproval(binding, action = "S9_RAW_RESTORE51") {
  const filename = `${evidenceRoot}/rollback-approval.json`;
  const approval = verifyRollbackApproval(loadRollbackApproval(filename), rollbackApprovalExpectation(binding, action));
  return { filename, approval, sha256: sha(readFileSync(filename)) };
}

export function requireFreshInspection({ directory = evidenceRoot, owners = [0, fixed.uid], maxAgeMs = 300000, now = Date.now() } = {}) {
  const names = readdirSync(directory).filter((name) => /^s2-inspection-[A-Za-z0-9]+\.json$/.test(name));
  assert(names.length > 0, "__PKT_LABEL_UPPER___MAINTENANCE_S2_INSPECTION_REQUIRED");
  const candidate = names.map((name) => ({ name, info: safeFile(path.join(directory, name), owners) })).sort((left, right) => right.info.mtimeMs - left.info.mtimeMs)[0];
  const filename = path.join(directory, candidate.name);
  const bytes = readFileSync(filename);
  const report = JSON.parse(bytes);
  assert.equal(report.mode, "inspect-only", "__PKT_LABEL_UPPER___MAINTENANCE_S2_INSPECTION_NOT_FRESH");
  assert.equal(report.passed, true, "__PKT_LABEL_UPPER___MAINTENANCE_S2_INSPECTION_NOT_FRESH");
  assert.equal(report.processesAbsent?.confirmed, true, "__PKT_LABEL_UPPER___MAINTENANCE_S2_INSPECTION_NOT_FRESH");
  assert(report.serviceAfter?.ActiveState === "inactive" && report.serviceAfter?.MainPID === "0", "__PKT_LABEL_UPPER___MAINTENANCE_S2_INSPECTION_NOT_FRESH");
  const finishedAt = Date.parse(report.finishedAt);
  assert(Number.isFinite(finishedAt), "__PKT_LABEL_UPPER___MAINTENANCE_S2_INSPECTION_NOT_FRESH");
  const ageMs = now - finishedAt;
  assert(ageMs >= 0 && ageMs <= maxAgeMs, "__PKT_LABEL_UPPER___MAINTENANCE_S2_INSPECTION_STALE");
  const after = lstatSync(filename);
  assert(after.mtimeMs === candidate.info.mtimeMs && after.size === candidate.info.size, "__PKT_LABEL_UPPER___MAINTENANCE_S2_INSPECTION_CHANGED");
  return { path: filename, sha256: sha(bytes), bytes: bytes.length, finishedAt: report.finishedAt, ageMs };
}

function failTidy(code, maintenanceDetail) {
  const error = new Error(code);
  error.maintenanceDetail = maintenanceDetail;
  throw error;
}

function sidecarLedger(database) {
  const entry = (filename, digest) => {
    if (!present(filename)) return { exists: false };
    const info = lstatSync(filename);
    return digest ? { exists: true, bytes: info.size, sha256: sha(readFileSync(filename)) } : { exists: true };
  };
  return { wal: entry(`${database}-wal`, true), shm: entry(`${database}-shm`, false) };
}

function safeSidecar(filename, databaseInfo) {
  const info = lstatSync(filename);
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && realpathSync(filename) === filename, "__PKT_LABEL_UPPER___MAINTENANCE_SIDECAR_UNSAFE");
  assert.equal(info.uid, databaseInfo.uid, "__PKT_LABEL_UPPER___MAINTENANCE_SIDECAR_UNSAFE");
  assert(!(info.mode & 0o022), "__PKT_LABEL_UPPER___MAINTENANCE_SIDECAR_UNSAFE");
  return info;
}

export function openDatabaseProcesses(database, procRoot = "/proc") {
  const targets = new Set();
  for (const filename of [database, `${database}-wal`, `${database}-shm`]) if (present(filename)) targets.add(realpathSync(filename));
  const matches = [];
  for (const entry of readdirSync(procRoot)) {
    if (!/^\d+$/.test(entry)) continue;
    let descriptors;
    try { descriptors = readdirSync(`${procRoot}/${entry}/fd`); } catch { continue; }
    for (const descriptor of descriptors) {
      let link;
      try { link = readlinkSync(`${procRoot}/${entry}/fd/${descriptor}`); } catch { continue; }
      if (link.endsWith(" (deleted)")) link = link.slice(0, -" (deleted)".length);
      if (targets.has(link)) matches.push({ pid: Number(entry), fd: Number(descriptor), path: link });
    }
  }
  return matches;
}

function readTidyState(database, { openLenient, openImmutable, collectState }) {
  const sidecars = sidecarLedger(database);
  const noSidecars = !sidecars.wal.exists && !sidecars.shm.exists;
  if (sidecars.wal.exists && !sidecars.shm.exists) failTidy("__PKT_LABEL_UPPER___MAINTENANCE_SIDECAR_READ_REQUIRES_SHM", { sidecars });
  const via = noSidecars || !sidecars.wal.exists ? "immutable-readonly" : "lenient-readonly";
  const handle = via === "lenient-readonly" ? openLenient(database) : openImmutable(database);
  let state;
  try { state = collectState(handle); } finally { handle.close(); }
  const after = sidecarLedger(database);
  if (canonicalJson(after) !== canonicalJson(sidecars)) failTidy("__PKT_LABEL_UPPER___MAINTENANCE_READBACK_CHANGED_SIDECARS", { before: sidecars, after });
  return { state, via, sidecars, noSidecars };
}

function strictTidyState(database, { openStrict, collectState }) {
  const handle = openStrict(database);
  try { return collectState(handle); } finally { handle.close(); }
}

function checkpointBusyValue(checkpoint) {
  const row = Array.isArray(checkpoint) ? checkpoint.at(0) : checkpoint;
  return row && typeof row === "object" ? Number(row.busy) : Number.NaN;
}

export const tidyContentSections = Object.freeze(["schema", "ledger", "history", "capabilities", "authorization", "integrity", "foreignKeys"]);

export function collectTidyState(database) {
  return {
    schema: { current: Number(one(database, "SELECT value FROM schema_metadata WHERE key='current_sequence'").value), minimumWriter: Number(one(database, "SELECT value FROM schema_metadata WHERE key='minimum_writer_sequence'").value) },
    ledger: rows(database, "SELECT sequence,name,phase,digest,applied_at FROM schema_migration_ledger ORDER BY sequence", []),
    history: historyDigests(database, historyIgnoredColumns),
    capabilities: rows(database, "SELECT id,version,status,revision,integrity,record_json FROM capability_declarations ORDER BY id", []).map(({ record_json: recordJson, ...row }) => ({ ...row, recordSha256: sha(recordJson) })),
    authorization: rows(database, "SELECT key,revision,value_json FROM product_state_records WHERE key LIKE 'host-workspace:directory-grant:%' ORDER BY key", []).map(({ value_json: valueJson, ...row }) => ({ ...row, valueSha256: sha(valueJson) })),
    integrity: rows(database, "PRAGMA integrity_check", []).map((row) => row.integrity_check).join(","),
    foreignKeys: rows(database, "PRAGMA foreign_key_check", []).length,
  };
}

export function tidyDatabaseSidecars(options) {
  for (const key of ["requireStopped", "requireRollbackApproval", "requireFreshInspection", "openLenient", "openImmutable", "openStrict", "openReadWrite", "collectState"]) assert(typeof options?.[key] === "function", "__PKT_LABEL_UPPER___MAINTENANCE_SIDECAR_TIDY_OPTIONS_INVALID");
  const database = options.database, owner = options.owner ?? fixed.uid, procRoot = options.procRoot ?? "/proc";
  options.requireStopped();
  const approval = options.requireRollbackApproval();
  const inspection = options.requireFreshInspection();
  const databaseInfo = safeFile(database, [owner]);
  const beforeOpen = openDatabaseProcesses(database, procRoot);
  if (beforeOpen.length > 0) failTidy("__PKT_LABEL_UPPER___MAINTENANCE_DATABASE_OPEN_BY_PROCESS", { processes: beforeOpen });
  if (present(`${database}-journal`)) failTidy("__PKT_LABEL_UPPER___MAINTENANCE_JOURNAL_SIDECAR_PRESENT", { path: `${database}-journal` });
  for (const suffix of ["-wal", "-shm"]) if (present(`${database}${suffix}`)) safeSidecar(`${database}${suffix}`, databaseInfo);
  const sidecarsBefore = sidecarLedger(database);
  const before = readTidyState(database, options);
  const beforeWrite = openDatabaseProcesses(database, procRoot);
  if (beforeWrite.length > 0) failTidy("__PKT_LABEL_UPPER___MAINTENANCE_DATABASE_OPEN_BY_PROCESS", { processes: beforeWrite });
  const sidecarsBeforeWrite = sidecarLedger(database);
  let journalMode = null, checkpoint = null, checkpointBusy = null;
  if (!before.noSidecars) {
    const handle = options.openReadWrite(database);
    try {
      journalMode = handle.pragma("journal_mode", { simple: true });
      assert.equal(journalMode, "wal", "__PKT_LABEL_UPPER___MAINTENANCE_NOT_WAL");
      checkpoint = handle.pragma("wal_checkpoint(TRUNCATE)");
    } finally { handle.close(); }
    checkpointBusy = checkpointBusyValue(checkpoint);
    if (checkpointBusy !== 0) failTidy("__PKT_LABEL_UPPER___MAINTENANCE_SIDECAR_BUSY", { checkpoint, busy: checkpointBusy });
    const remaining = ["-wal", "-shm"].filter((suffix) => present(`${database}${suffix}`));
    if (remaining.length > 0) failTidy("__PKT_LABEL_UPPER___MAINTENANCE_SIDECAR_REMAINS", { remaining: remaining.map((suffix) => { const info = lstatSync(`${database}${suffix}`); return { path: `${database}${suffix}`, bytes: info.size, uid: info.uid, gid: info.gid, mode: (info.mode & 0o777).toString(8) }; }) });
  }
  const sidecarsAfter = sidecarLedger(database);
  const after = strictTidyState(database, options);
  for (const section of tidyContentSections) if (canonicalJson(before.state[section]) !== canonicalJson(after[section])) failTidy("__PKT_LABEL_UPPER___MAINTENANCE_TIDY_CONTENT_CHANGED", { section, before: before.state[section], after: after[section] });
  options.requireStopped();
  return { noSidecars: before.noSidecars, readVia: before.via, approval: { filename: approval.filename, sha256: approval.sha256, approvalRef: approval.approval.approvalRef }, inspection, journalMode, checkpoint, checkpointBusy, sidecarsBefore, sidecarsBeforeWrite, sidecarsAfter, before: before.state, after, comparedSections: [...tidyContentSections] };
}

export const currentSchema = __PKT_CURRENT_SCHEMA__;
export const targetSchema = __PKT_TARGET_SCHEMA__;
export const migrationExpectedLedger = Object.freeze(__PKT_MIGRATION_LEDGER__.map((row) => Object.freeze(row)));
export const addedColumnBackfills = Object.freeze({ thread_origin: Object.freeze({ threads: Object.freeze(["origin"]) }) });
export function historyIgnoredColumnsFor(ledger) {
  const merged = {};
  for (const row of ledger) for (const [table, columns] of Object.entries(addedColumnBackfills[row.name] ?? {})) merged[table] = [...new Set([...(merged[table] ?? []), ...columns])];
  return Object.freeze(Object.fromEntries(Object.entries(merged).map(([table, columns]) => [table, Object.freeze(columns)])));
}
export const historyIgnoredColumns = historyIgnoredColumnsFor(migrationExpectedLedger);
export const migrationComparedSections = Object.freeze(["history", "capabilities", "authorization", "releaseReceipts", "integrity", "foreignKeys"]);

export function migrationContentState(database) {
  return { ...collectTidyState(database), releaseReceipts: rows(database, "SELECT environment_id AS environmentId,basis,stop_fence AS stopFence,accepted_at AS acceptedAt,proof_json AS proofJson,authority_json AS authorityJson FROM execution_environment_release_receipts ORDER BY environment_id", []) };
}

export function readMigrationContent(prefix = newPrefix, database = fixed.database) {
  const opened = openRecoveryReadonly(prefix, database, fixed.uid);
  try {
    opened.exec("BEGIN");
    const state = migrationContentState(opened);
    opened.exec("COMMIT");
    return state;
  } finally {
    opened.close();
  }
}

export function verifyMigrationTransition(before, after) {
  const changed = (detail) => failTidy("__PKT_LABEL_UPPER___MAINTENANCE_MIGRATION_CONTENT_CHANGED", detail);
  if (after.schema.current !== targetSchema || after.schema.minimumWriter !== targetSchema) changed({ section: "schema", before: before.schema, after: after.schema });
  if (after.ledger.length !== before.ledger.length + migrationExpectedLedger.length) changed({ section: "ledgerLength", beforeLength: before.ledger.length, afterLength: after.ledger.length });
  for (let index = 0; index < before.ledger.length; index += 1) if (canonicalJson(after.ledger[index]) !== canonicalJson(before.ledger[index])) changed({ section: "ledgerRow", sequence: index + 1, before: before.ledger[index], after: after.ledger[index] });
  const applied = after.ledger.slice(before.ledger.length);
  applied.forEach((row, index) => {
    const expected = migrationExpectedLedger[index];
    if (!expected || row.sequence !== expected.sequence || row.name !== expected.name || row.phase !== expected.phase) changed({ section: "ledgerApplied", applied: row, expected });
  });
  for (const section of migrationComparedSections) if (canonicalJson(after[section]) !== canonicalJson(before[section])) changed({ section, before: before[section], after: after[section] });
  return { schema: after.schema, ledgerApplied: applied, comparedSections: [...migrationComparedSections] };
}

export function describeMigrationSnapshot(source, stateRoot = fixed.stateRoot, owner = fixed.uid) {
  assert(typeof source === "string" && path.isAbsolute(source), "__PKT_LABEL_UPPER___MAINTENANCE_SNAPSHOT_PATH_INVALID");
  assert.equal(path.dirname(path.dirname(source)), path.join(stateRoot, "data"), "__PKT_LABEL_UPPER___MAINTENANCE_SNAPSHOT_PATH_INVALID");
  assert(/^pre-migration-[A-Za-z0-9]+$/.test(path.basename(path.dirname(source))), "__PKT_LABEL_UPPER___MAINTENANCE_SNAPSHOT_PATH_INVALID");
  assert.equal(path.basename(source), "product.sqlite", "__PKT_LABEL_UPPER___MAINTENANCE_SNAPSHOT_PATH_INVALID");
  const info = safeFile(source, [owner]);
  assert.equal(info.mode & 0o777, 0o600, "__PKT_LABEL_UPPER___MAINTENANCE_SNAPSHOT_MODE_INVALID");
  return { path: source, bytes: info.size, sha256: sha(readFileSync(source)), mode: "0600" };
}

export async function migrateDatabase(options) {
  for (const key of ["requireStopped", "collectContent", "runMigrate", "describeSnapshot"]) assert(typeof options?.[key] === "function", "__PKT_LABEL_UPPER___MAINTENANCE_MIGRATION_OPTIONS_INVALID");
  assert(targetSchema > currentSchema && migrationExpectedLedger.length === targetSchema - currentSchema, "__PKT_LABEL_UPPER___MAINTENANCE_MIGRATION_NOT_PLANNED");
  const database = options.database ?? fixed.database;
  options.requireStopped();
  for (const suffix of ["-wal", "-shm", "-journal"]) if (present(`${database}${suffix}`)) failTidy("__PKT_LABEL_UPPER___MAINTENANCE_MIGRATE_SIDECAR_PRESENT", { path: `${database}${suffix}` });
  const before = options.collectContent();
  if (before.schema.current !== currentSchema || before.schema.minimumWriter !== currentSchema || before.ledger.length !== currentSchema) failTidy("__PKT_LABEL_UPPER___MAINTENANCE_MIGRATION_SCHEMA_INVALID", { schema: before.schema, ledgerLength: before.ledger.length });
  const migrate = await options.runMigrate();
  const result = migrate?.result;
  if (result?.currentSequence !== targetSchema) failTidy("__PKT_LABEL_UPPER___MAINTENANCE_MIGRATION_SCHEMA_INVALID", { result });
  if (canonicalJson(result?.appliedSequences) !== canonicalJson(migrationExpectedLedger.map((row) => row.sequence))) failTidy("__PKT_LABEL_UPPER___MAINTENANCE_MIGRATION_SEQUENCE_INVALID", { result });
  const snapshot = options.describeSnapshot(result.snapshotPath);
  const after = options.collectContent();
  const transition = verifyMigrationTransition(before, after);
  options.requireStopped();
  return { before, after, transition, migrate, snapshot };
}

export function postUpgradeState(binding, state) {
  return { schemaVersion: "himawari.__PKT_LABEL__-change-post-upgrade-state.v1", action: "S7_CATALOG_UPGRADE", checkedAt: new Date().toISOString(), deploymentId: binding.identity.deploymentId, schemaSequence: state.schema.current, schemaMinimumWriter: state.schema.minimumWriter, migrationCount: state.ledger.length, integrityCheck: "ok", foreignKeys: "ok" };
}

export function recoveryIdForSchema(binding, schema) {
  assert.equal(schema, currentSchema, "__PKT_LABEL_UPPER___MAINTENANCE_RECOVERY_SCHEMA_INVALID");
  const id = binding.maintenance.recovery__PKT_CURRENT_SCHEMA__Id;
  assert(typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id), "__PKT_LABEL_UPPER___MAINTENANCE_RECOVERY_ID_INVALID");
  return id;
}

export function spaceSamplingWarnings(samplerFailure, sampled) {
  return [...(samplerFailure ? [{ code: "SAMPLER_EXIT_FAILED", stage: "worker" }] : []), ...(sampled ? sampled.errors : [{ code: "SAMPLER_RESULT_MISSING", stage: "worker" }])];
}

export async function cli(prefix, args, name) {
  requireStopped();
  safeFile(`${prefix}/bin/himawari`);
  const command = [`${prefix}/bin/himawari`, ...args];
  const backupArgument = args.includes("--backup-id") ? args.indexOf("--backup-id") : args.indexOf("--backup");
  const sampler = new Worker(new URL("./maintenance-space-sampler.mjs", import.meta.url), { workerData: { stateRoot: fixed.stateRoot, backupId: backupArgument >= 0 ? args[backupArgument + 1] : null }, execArgv: [] });
  let sampled;
  const ready = new Promise((resolve, reject) => {
    sampler.once("error", reject);
    sampler.on("message", (message) => {
      if (message.kind === "ready") resolve(message);
      if (message.kind === "result") sampled = message.result;
    });
  });
  const exited = new Promise((resolve, reject) => {
    sampler.once("error", reject);
    sampler.once("exit", (code) => code === 0 ? resolve() : reject(new Error("__PKT_LABEL_UPPER___MAINTENANCE_SAMPLER_FAILED")));
  });
  exited.catch(() => undefined);
  let samplerFailure = false;
  try {
    await ready;
  } catch {
    samplerFailure = true;
  }
  let output;
  try {
    output = spawnSync(command[0], command.slice(1), { encoding: "utf8", timeout: 1200000, maxBuffer: 16777216, env: { HOME: fixed.stateRoot, PATH: "/opt/himawari/node/bin:/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
  } finally {
    sampler.postMessage({ kind: "stop" });
    try {
      await exited;
    } catch {
      samplerFailure = true;
    }
  }
  const record = { checkedAt: new Date().toISOString(), actor: { uid: process.getuid(), account: "himawari-prod", hostname: hostname() }, command, status: output.status, signal: output.signal, stdout: output.stdout ?? "", stderr: output.stderr ?? "", errorCode: output.error?.code ?? null, spaceSample: sampled ?? null, samplerFailure, spaceSamplingWarnings: spaceSamplingWarnings(samplerFailure, sampled) };
  const retained = retainedJson(`${name}-command.json`, record);
  assert(output.status === 0 && output.signal === null && !output.error, "__PKT_LABEL_UPPER___MAINTENANCE_CLI_FAILED");
  requireStopped();
  const records = output.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const result = records.at(-1);
  assert(result && typeof result === "object", "__PKT_LABEL_UPPER___MAINTENANCE_CLI_OUTPUT_INVALID");
  return { result, retained };
}

function rows(database, sql, values) {
  return database.prepare(sql).all(...values);
}

function hashedBytes(value) {
  const bytes = Buffer.from(value, "utf8");
  return { bytes: bytes.length, sha256: sha(bytes) };
}

export async function readMaintenanceState(binding, prefix = newPrefix, allowStartupAuthority = false, expectedAuthority = binding.authority) {
  const database = allowStartupAuthority === true ? openReadonly(sqliteDriverRoot, fixed.database) : openRecoveryReadonly(prefix, fixed.database, fixed.uid);
  try {
    database.exec("BEGIN");
    const state = readS0State(database, binding.identity, historyIgnoredColumns);
    assert.deepEqual(state.identity, binding.identity, "__PKT_LABEL_UPPER___MAINTENANCE_DB_BINDING_CHANGED");
    if (allowStartupAuthority === "rollback-current") {
      assert.equal(state.authority.authorityEpoch, binding.authority.authorityEpoch, "__PKT_LABEL_UPPER___MAINTENANCE_ROLLBACK_CURRENT_EPOCH_CHANGED");
      assert(state.authority.fencingToken >= binding.authority.fencingToken, "__PKT_LABEL_UPPER___MAINTENANCE_ROLLBACK_CURRENT_FENCING_INVALID");
    } else if (allowStartupAuthority === true) {
      verifyStartupAuthority(state.authority, { ...binding, authority: expectedAuthority }, rootJsonFile(`${evidenceRoot}/s7-startup-verification.json`));
    } else {
      assert.deepEqual(state.authority, expectedAuthority, "__PKT_LABEL_UPPER___MAINTENANCE_DB_AUTHORITY_CHANGED");
    }
    const ledger = rows(database, "SELECT sequence,name,phase,digest,applied_at FROM schema_migration_ledger ORDER BY sequence", []);
    const { loadBundledMigrations } = await persistence(prefix);
    const migrations = await loadBundledMigrations();
    assert(migrations.length >= ledger.length, "__PKT_LABEL_UPPER___MAINTENANCE_MIGRATIONS_TOO_OLD");
    const idColumn = rows(database, "SELECT 1 AS present FROM pragma_table_info('schema_migration_ledger') WHERE name='migration_id'", []).length === 1;
    const ledgerIds = idColumn ? rows(database, "SELECT sequence, migration_id AS id FROM schema_migration_ledger ORDER BY sequence", []) : ledger;
    const definitions = definitionsForLedger(migrations, ledgerIds);
    for (let index = 0; index < ledger.length; index += 1) {
      assert.equal(ledger[index].sequence, index + 1, "__PKT_LABEL_UPPER___MAINTENANCE_LEDGER_DIGEST_MISMATCH");
      const definition = definitions[index];
      assert(definition, "__PKT_LABEL_UPPER___MAINTENANCE_LEDGER_DIGEST_MISMATCH");
      for (const key of ["name", "phase", "digest"]) assert.equal(ledger[index][key], definition[key], "__PKT_LABEL_UPPER___MAINTENANCE_LEDGER_DIGEST_MISMATCH");
    }
    assert.deepEqual(rows(database, "PRAGMA integrity_check", []), [{ integrity_check: "ok" }], "__PKT_LABEL_UPPER___MAINTENANCE_INTEGRITY_FAILED");
    assert.deepEqual(rows(database, "PRAGMA foreign_key_check", []), [], "__PKT_LABEL_UPPER___MAINTENANCE_FOREIGN_KEYS_FAILED");
    database.exec("COMMIT");
    return { ...state, ledger };
  } finally {
    database.close();
  }
}

export function verifyHistoryUnchanged(before, after) {
  assert(before.history && typeof before.history === "object" && Object.keys(before.history).length > 0, "__PKT_LABEL_UPPER___MAINTENANCE_HISTORY_MISSING");
  assert.deepEqual(after.history, before.history, "__PKT_LABEL_UPPER___MAINTENANCE_HISTORY_CHANGED");
}

export function diskSpace() {
  const root = statfsSync("/");
  return { checkedAt: new Date().toISOString(), rootAvailableBytes: root.bavail * root.bsize, rootAvailableInodes: root.ffree };
}
