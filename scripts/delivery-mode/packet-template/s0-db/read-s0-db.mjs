import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";

export const fixed = Object.freeze({
  runtimeRoot: "__PKT_OLD_PREFIX__/lib/himawari-agent",
  configuration: "/etc/himawari/config.json",
  stateRoot: "/var/lib/himawari/state",
  database: "/var/lib/himawari/state/data/product.sqlite",
  uid: __PKT_SERVICE_UID__,
  gid: __PKT_SERVICE_GID__,
  ownerId: "owner:first-production",
  agentId: "agent:first-production",
  deploymentId: "himawari-prod-deployment",
  hostId: "himawari-prod-host",
});

export const catalogRegistrationPrefix = "__PKT_OLD_PREFIX__";

export const historyTables = Object.freeze([
  "runs",
  "threads",
  "thread_gateway_events",
  "run_coordination_checkpoints",
  "model_budget_accounts",
  "model_budget_allocations",
  "model_invocation_identities",
  "run_payload_artifacts",
  "capability_invocation_receipts",
  "sandbox_execution_records",
  "sandbox_release_receipts",
  "sandbox_reservation_release_receipts",
]);

export const unresolvedQuery = `SELECT count(*) AS count
FROM sandbox_execution_records reservation
WHERE json_extract(reservation.plan_json,'$.backendRef')='srt'
  AND reservation.preparation_state='reserved' AND reservation.started_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM sandbox_reservation_release_receipts released
    WHERE released.job_id=reservation.job_id
      AND json_extract(released.verification_json,'$.identity.jobId')=reservation.job_id
      AND json_extract(released.verification_json,'$.stopRequestedAt')=reservation.reservation_stopped_at
  )
  AND NOT EXISTS (
    SELECT 1 FROM sandbox_release_receipts released
    WHERE released.job_id=reservation.job_id
      AND json_extract(released.verification_json,'$.identity.jobId')=reservation.job_id
  )`;

export function one(database, sql, values = []) {
  const rows = database.prepare(sql).all(...values);
  assert.equal(rows.length, 1, "__PKT_LABEL_UPPER___DB_EXPECTED_ONE_ROW");
  return rows[0];
}

export function historyRow(table, row, ignoredColumns = {}) {
  const ignored = ignoredColumns[table];
  if (!ignored) return row;
  return Object.fromEntries(Object.entries(row).filter(([key]) => !ignored.includes(key)));
}

export function historyDigests(database, ignoredColumns = {}) {
  const tables = new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map((row) => row.name));
  return Object.fromEntries(historyTables.map((table) => {
    assert(tables.has(table), "__PKT_LABEL_UPPER___DB_HISTORY_TABLE_MISSING");
    const hash = createHash("sha256");
    let rows = 0;
    for (const row of database.prepare(`SELECT rowid AS "__rowid", * FROM "${table}" ORDER BY rowid`).iterate()) {
      hash.update(`${canonicalJson(historyRow(table, row, ignoredColumns))}\n`);
      rows += 1;
    }
    return [table, { rows, sha256: hash.digest("hex") }];
  }));
}

export const ledgerMigrationId = (row) => row.id ?? String(row.sequence).padStart(4, "0");

export function readS0State(database, expected, ignoredColumns = {}) {
  assert.equal(database.pragma("query_only", { simple: true }), 1, "__PKT_LABEL_UPPER___DB_QUERY_ONLY_REQUIRED");
  const current = Number(one(database, "SELECT value FROM schema_metadata WHERE key='current_sequence'").value);
  const minimumWriter = Number(one(database, "SELECT value FROM schema_metadata WHERE key='minimum_writer_sequence'").value);
  const ledger = database.prepare("SELECT sequence,name,phase,digest,applied_at FROM schema_migration_ledger ORDER BY sequence").all();
  const hasIdColumn = database.prepare("SELECT 1 FROM pragma_table_info('schema_migration_ledger') WHERE name='migration_id'").get() !== undefined;
  const migrationIds = (hasIdColumn ? database.prepare("SELECT sequence,migration_id AS id FROM schema_migration_ledger ORDER BY sequence").all() : ledger).map(ledgerMigrationId);
  const migrationDigests = ledger.map((row) => row.digest);
  const migrationNames = ledger.map((row) => row.name);
  assert(Number.isSafeInteger(current) && current > 0 && minimumWriter === current, "__PKT_LABEL_UPPER___DB_SCHEMA_UNSUPPORTED");
  assert(ledger.length === current && ledger.every((row, index) => row.sequence === index + 1), "__PKT_LABEL_UPPER___DB_LEDGER_INVALID");
  const deployment = one(database, "SELECT id,status,authority_epoch,fencing_token FROM deployments WHERE id=? AND owner_id=? AND agent_id=?", [expected.deploymentId, expected.ownerId, expected.agentId]);
  assert.equal(deployment.status, "active", "__PKT_LABEL_UPPER___DB_DEPLOYMENT_NOT_ACTIVE");
  for (const number of [deployment.authority_epoch, deployment.fencing_token]) assert(Number.isSafeInteger(number) && number > 0, "__PKT_LABEL_UPPER___DB_AUTHORITY_INVALID");
  return {
    schemaVersion: "himawari.__PKT_LABEL__-change-s0-db.v1",
    checkedAt: new Date().toISOString(),
    schema: { current, minimumWriter, ledgerCount: ledger.length, ledgerMax: ledger.at(-1).sequence },
    migrationIds,
    migrationDigests,
    migrationNames,
    identity: { deploymentId: deployment.id, ownerId: expected.ownerId, agentId: expected.agentId, hostId: expected.hostId },
    authority: { deploymentId: deployment.id, ownerId: expected.ownerId, agentId: expected.agentId, status: deployment.status, authorityEpoch: deployment.authority_epoch, fencingToken: deployment.fencing_token },
    gate: {
      oldReservedCount: one(database, "SELECT count(*) AS count FROM sandbox_execution_records WHERE json_extract(plan_json,'$.backendRef')='srt' AND preparation_state='reserved' AND started_at IS NULL").count,
      unresolvedReservedCount: one(database, unresolvedQuery).count,
      nonTerminalRunCount: one(database, "SELECT count(*) AS count FROM runs WHERE status NOT IN ('completed','failed','cancelled')").count,
    },
    history: historyDigests(database, ignoredColumns),
  };
}

export function openReadonly(runtimeRoot, filename) {
  const require = createRequire(`${runtimeRoot}/package.json`);
  const BetterSqlite3 = require(`${runtimeRoot}/node_modules/better-sqlite3`);
  const database = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
  database.pragma("query_only = ON");
  assert.equal(database.pragma("query_only", { simple: true }), 1, "__PKT_LABEL_UPPER___DB_QUERY_ONLY_REQUIRED");
  return database;
}

export function readRouteAuthorization(database, configuration, snapshot, runnerDigest, catalogRuntimeRoot) {
  assert.equal(snapshot.schemaVersion, "capability-deployment.v1", "__PKT_LABEL_UPPER___DB_CAPABILITY_SNAPSHOT_INVALID");
  assert(Array.isArray(snapshot.capabilities), "__PKT_LABEL_UPPER___DB_CAPABILITY_SNAPSHOT_INVALID");
  const routes = Object.entries(configuration.runPolicy).filter(([, value]) => value && typeof value === "object" && typeof value.capabilityRef === "string");
  const directoryGrants = [];
  for (const [routeKey, route] of routes) {
    if (typeof route.grantId !== "string") continue;
    assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(route.grantId), "__PKT_LABEL_UPPER___DB_GRANT_ID_INVALID");
    const stored = one(database, "SELECT revision,value_json FROM product_state_records WHERE key=? AND owner_id=? AND agent_id=?", [`host-workspace:directory-grant:${route.grantId}`, configuration.ownerId, configuration.agentId]);
    const grant = JSON.parse(stored.value_json);
    assert.equal(grant.id, route.grantId, "__PKT_LABEL_UPPER___DB_GRANT_ID_MISMATCH");
    const matches = snapshot.capabilities.filter((entry) => entry.manifest?.ref === route.capabilityRef && entry.manifest?.version === route.capabilityVersion);
    assert.equal(matches.length, 1, "__PKT_LABEL_UPPER___DB_ROUTE_CAPABILITY_AMBIGUOUS");
    const roots = matches[0].binding?.value?.roots;
    assert(Array.isArray(roots), "__PKT_LABEL_UPPER___DB_ROUTE_ROOTS_INVALID");
    const matchingRoots = roots.filter((root) => root.canonicalRootId === grant.canonicalRootId);
    assert.equal(matchingRoots.length, 1, "__PKT_LABEL_UPPER___DB_GRANT_ROOT_NOT_BOUND");
    const root = matchingRoots[0];
    directoryGrants.push({ routeKey, grantId: grant.id, capabilityRef: route.capabilityRef, capabilityVersion: route.capabilityVersion, revision: grant.revision, stateRevision: stored.revision, hostId: grant.hostId, canonicalRootId: grant.canonicalRootId, displayPath: grant.displayPath, device: root.device, inode: root.inode, pathPolicy: grant.pathPolicy, mountPolicy: grant.mountPolicy, expiresAt: grant.expiresAt, revokedAt: grant.revokedAt, readAllowed: Array.isArray(grant.operations) && grant.operations.includes("read"), hostMatchesRoute: grant.hostId === route.hostId, rootMatchesSnapshot: root.canonicalPath === grant.displayPath, currentlyUsable: grant.revokedAt === null && Date.parse(grant.expiresAt) > Date.now(), metadataSha256: createHash("sha256").update(stored.value_json).digest("hex") });
  }
  const capabilities = snapshot.capabilities.map((entry) => {
    const manifest = entry.manifest;
    assert(typeof manifest?.ref === "string" && typeof manifest.version === "string", "__PKT_LABEL_UPPER___DB_CAPABILITY_MANIFEST_INVALID");
    const stored = one(database, "SELECT id,version,status,revision,integrity,record_json FROM capability_declarations WHERE id=? AND owner_id=? AND agent_id=?", [manifest.ref, configuration.ownerId, configuration.agentId]);
    const registry = JSON.parse(stored.record_json);
    const declaration = registry.declaration;
    const equal = isDeepStrictEqual;
    const runner = entry.binding?.value?.runner;
    assert(typeof runner?.path === "string" && /^[a-f0-9]{64}$/.test(runner.sha256), "__PKT_LABEL_UPPER___DB_RUNNER_BINDING_INVALID");
    assert(typeof entry.binding.value.hostId === "string" && Array.isArray(manifest.runtime?.argv) && manifest.runtime.argv.length === 4 && manifest.runtime.argv.every((value) => typeof value === "string"), "__PKT_LABEL_UPPER___DB_MANIFEST_RUNTIME_IDENTITY_INVALID");
    const actualRunnerSha256 = runnerDigest(runner.path);
    const invariant = capabilityManifestInvariant(manifest, entry.binding.value.runtimeRoot);
    return { capabilityRef: stored.id, version: stored.version, status: stored.status, revision: stored.revision, hostId: entry.binding.value.hostId, workerInstanceId: manifest.runtime.argv[3], runtimeRoot: entry.binding.value.runtimeRoot, activeHealthy: stored.status === "active" && registry.lifecycle === "active" && declaration?.health?.status === "healthy", versionMatchesSnapshot: stored.version === manifest.version, operationsMatchSnapshot: equal(declaration?.operations, manifest.operations), scopesMatchSnapshot: equal(declaration?.scopes, manifest.scopes), costMatchesSnapshot: equal(declaration?.cost, manifest.cost), secretRefsMatchSnapshot: equal(declaration?.scopes?.secrets, manifest.scopes?.secrets), permissionRefsMatchSnapshot: equal(declaration?.permissionRefs, manifest.permissionRefs), integrityMatchesSnapshot: stored.integrity === manifest.integrity && declaration?.integrity === manifest.integrity, declarationInvariantMatchesSnapshot: canonicalJson(capabilityManifestInvariant(declaration, catalogRuntimeRoot ?? entry.binding.value.runtimeRoot)) === canonicalJson(invariant), runnerSha256: runner.sha256, actualRunnerSha256, runnerMatchesRecorded: actualRunnerSha256 === runner.sha256, declarationMatchesSnapshotExceptArtifact: canonicalJson(withoutArtifactDigest(capabilityManifestInvariant(declaration, catalogRuntimeRoot ?? entry.binding.value.runtimeRoot))) === canonicalJson(withoutArtifactDigest(invariant)), snapshotIntegrityMatchesRunner: manifest.integrity === "sha256:" + runner.sha256 && manifest.artifact?.digest === manifest.integrity, storedIntegrity: stored.integrity, storedIntegrityMatchesDeclaration: stored.integrity === declaration?.integrity,manifestInvariantDigest: createHash("sha256").update(canonicalJson(invariant)).digest("hex"), registryRecordSha256: createHash("sha256").update(stored.record_json).digest("hex") };
  });
  return { directoryGrants, capabilities };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function withoutArtifactDigest(invariant) {
  const copy = structuredClone(invariant);
  delete copy.integrity;
  if (copy.artifact) delete copy.artifact.digest;
  return copy;
}

export function capabilityManifestInvariant(manifest, runtimeRoot) {
  assert(typeof runtimeRoot === "string" && runtimeRoot.startsWith("/"), "__PKT_LABEL_UPPER___DB_MANIFEST_RUNTIME_ROOT_INVALID");
  const invariant = structuredClone(manifest);
  if (invariant.source) delete invariant.source.locator;
  if (invariant.health) delete invariant.health.checkedAt;
  delete invariant.reviewedAt;
  if (Array.isArray(invariant.runtime?.argv)) invariant.runtime.argv = invariant.runtime.argv.map((value, index) => index < 2 && typeof value === "string" && (value === runtimeRoot || value.startsWith(`${runtimeRoot}/`)) ? `<runtime>${value.slice(runtimeRoot.length)}` : value);
  return invariant;
}

export function readGrantsWithoutSnapshot(database, configuration, workspace) {
  const directoryGrants = [];
  for (const [routeKey, route] of Object.entries(configuration.runPolicy ?? {})) {
    if (!route || typeof route !== "object" || typeof route.capabilityRef !== "string" || typeof route.grantId !== "string") continue;
    assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(route.grantId), "__PKT_LABEL_UPPER___DB_GRANT_ID_INVALID");
    const stored = one(database, "SELECT revision,value_json FROM product_state_records WHERE key=? AND owner_id=? AND agent_id=?", [`host-workspace:directory-grant:${route.grantId}`, configuration.ownerId, configuration.agentId]);
    const grant = JSON.parse(stored.value_json);
    assert.equal(grant.id, route.grantId, "__PKT_LABEL_UPPER___DB_GRANT_ID_MISMATCH");
    assert(typeof workspace?.device === "string" && typeof workspace.inode === "string" && grant.canonicalRootId === `${workspace.device}:${workspace.inode}`, "__PKT_LABEL_UPPER___DB_GRANT_ROOT_NOT_BOUND");
    directoryGrants.push({ routeKey, grantId: grant.id, capabilityRef: route.capabilityRef, capabilityVersion: route.capabilityVersion, revision: grant.revision, stateRevision: stored.revision, hostId: grant.hostId, canonicalRootId: grant.canonicalRootId, displayPath: grant.displayPath, device: workspace.device, inode: workspace.inode, pathPolicy: grant.pathPolicy, mountPolicy: grant.mountPolicy, expiresAt: grant.expiresAt, revokedAt: grant.revokedAt, readAllowed: Array.isArray(grant.operations) && grant.operations.includes("read"), hostMatchesRoute: grant.hostId === route.hostId, rootMatchesSnapshot: workspace.path === grant.displayPath, currentlyUsable: grant.revokedAt === null && Date.parse(grant.expiresAt) > Date.now(), metadataSha256: createHash("sha256").update(stored.value_json).digest("hex") });
  }
  assert.equal(directoryGrants.length, 1, "__PKT_LABEL_UPPER___DB_GRANT_ROUTE_SET_CHANGED");
  return directoryGrants;
}

export function productionS0() {
  assert.equal(process.argv.length, 2, "__PKT_LABEL_UPPER___DB_ARGUMENT_INVALID");
  assert.equal(process.getuid(), fixed.uid, "__PKT_LABEL_UPPER___DB_ACTOR_INVALID");
  assert.equal(process.getgid(), fixed.gid, "__PKT_LABEL_UPPER___DB_ACTOR_INVALID");
  const bytes = readFileSync(fixed.configuration);
  const configuration = JSON.parse(bytes);
  for (const key of ["ownerId", "agentId", "stateRoot", "deploymentId"]) assert.equal(configuration[key], fixed[key], "__PKT_LABEL_UPPER___DB_CONFIG_CHANGED");
  assert.equal(configuration.runPolicy?.coding?.hostId, fixed.hostId, "__PKT_LABEL_UPPER___DB_CONFIG_CHANGED");
  assert.equal(configuration.runPolicy?.coding?.grantId, existingWorkspace.grantId, "__PKT_LABEL_UPPER___DB_CONFIG_CHANGED");
  const info = lstatSync(fixed.database);
  assert(info.isFile() && info.uid === fixed.uid && info.gid === fixed.gid && (info.mode & 0o777) === 0o600 && realpathSync(fixed.database) === fixed.database, "__PKT_LABEL_UPPER___DB_PATH_UNSAFE");
  const database = openReadonly(fixed.runtimeRoot, fixed.database);
  try {
    database.exec("BEGIN");
    const result = readS0State(database, fixed);
    assert.equal(result.authority.deploymentId, configuration.deploymentId, "__PKT_LABEL_UPPER___DB_CONFIG_DEPLOYMENT_MISMATCH");
    const firstTools = configuration.capabilityDeployment === undefined;
    if (firstTools) {
      assert.equal(one(database, "SELECT count(*) AS count FROM capability_declarations WHERE owner_id=? AND agent_id=?", [configuration.ownerId, configuration.agentId]).count, 0, "__PKT_LABEL_UPPER___DB_CAPABILITIES_REGISTERED_WITHOUT_SNAPSHOT");
      result.authorization = { directoryGrants: readGrantsWithoutSnapshot(database, configuration, readExistingWorkspace()), capabilities: [] };
    } else {
      const snapshotPath = configuration.capabilityDeployment?.snapshotPath;
      assert.equal(snapshotPath, `${fixed.stateRoot}/deployment/capability-deployment.json`, "__PKT_LABEL_UPPER___DB_SNAPSHOT_PATH_CHANGED");
      const snapshotBytes = readFileSync(snapshotPath);
      assert.equal(configuration.capabilityDeployment.sha256, `sha256:${createHash("sha256").update(snapshotBytes).digest("hex")}`, "__PKT_LABEL_UPPER___DB_SNAPSHOT_DIGEST_CHANGED");
      result.authorization = readRouteAuthorization(database, configuration, JSON.parse(snapshotBytes), (filename) => {
        assert(filename.startsWith(`${fixed.runtimeRoot}/`), "__PKT_LABEL_UPPER___DB_RUNNER_PATH_UNAPPROVED");
        assert.equal(realpathSync(filename), filename, "__PKT_LABEL_UPPER___DB_RUNNER_PATH_UNSAFE");
        const info = lstatSync(filename);
        assert(info.isFile() && info.uid === 0 && !(info.mode & 0o022), "__PKT_LABEL_UPPER___DB_RUNNER_PATH_UNSAFE");
        return createHash("sha256").update(readFileSync(filename)).digest("hex");
      }, `${catalogRegistrationPrefix}/lib/himawari-agent`);
    }
    database.exec("COMMIT");
    result.service = readServiceFiles(bytes);
    result.workspace = readExistingWorkspace();
    return result;
  } finally {
    database.close();
  }
}

function rootOwnedFile(filename) {
  const info = lstatSync(filename);
  assert(info.isFile() && info.uid === 0 && !(info.mode & 0o022) && realpathSync(filename) === filename, "__PKT_LABEL_UPPER___DB_SERVICE_FILE_UNSAFE");
  return readFileSync(filename);
}

function readServiceFiles(configurationBytes) {
  const unitFragmentPath = "/etc/systemd/system/himawari-prod.service";
  const pairSupervisor = "__PKT_OLD_OPERATIONS__/pair-supervisor.mjs";
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  return { unitFragmentPath, unitFragmentSha256: digest(rootOwnedFile(unitFragmentPath)), configurationSha256: digest(configurationBytes), pairSupervisor, pairSupervisorSha256: digest(rootOwnedFile(pairSupervisor)) };
}

export const existingWorkspace = Object.freeze({ grantId: "directory:himawari-prod-workspace-20261015", path: "/var/lib/himawari/workspace", subdirectories: Object.freeze(["files", "repos"]) });

function directoryIdentity(filename) {
  const info = lstatSync(filename);
  assert(info.isDirectory() && realpathSync(filename) === filename, "__PKT_LABEL_UPPER___DB_WORKSPACE_UNSAFE");
  return { device: String(info.dev), inode: String(info.ino), uid: info.uid, gid: info.gid, mode: (info.mode & 0o7777).toString(8).padStart(4, "0") };
}

export function readExistingWorkspace(root = existingWorkspace.path) {
  const identity = directoryIdentity(root);
  return { path: root, ...identity, subdirectories: existingWorkspace.subdirectories.map((name) => ({ name, ...directoryIdentity(`${root}/${name}`) })) };
}

if (process.argv[1] === "-") {
  try {
    process.stdout.write(`${JSON.stringify(productionS0())}\n`);
  } catch (error) {
    process.stdout.write('{"errorCode":"__PKT_LABEL_UPPER___DEPLOY_S0_DB_READ_FAILED"}\n');
    const message = typeof error?.message === "string" && error.message.length > 0 ? error.message : String(error);
    process.stderr.write(`${message.replaceAll("\n", " ").replaceAll("\r", " ")}\n`);
    process.exitCode = 1;
  }
}
