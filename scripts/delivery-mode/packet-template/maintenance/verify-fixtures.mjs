import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { readGrantsWithoutSnapshot, historyDigests, historyRow, readS0State, unresolvedQuery, readRouteAuthorization, readExistingWorkspace, historyTables, catalogRegistrationPrefix } from "../s0-db/read-s0-db.mjs";
import { oldPrefix, newPrefix, spaceSamplingWarnings, cli as maintenanceCli, strictCapabilityKeys, verifyHistoryUnchanged, configurationStage, staticRootConfiguration, staticRootConfigurationBytes, approvedEmbeddingDescriptor, approvedSpeech, approvedRunPolicyAdditions, approvedSecretReferences, oldStaticRoot, newStaticRoot, verifyStartupAuthority, verifyAuthorizationUsable, readCatalogRecords, verifyCatalogRecordsAtS0, catalogStrictView, verifyUpgradedCatalog as verifyUpgradedCatalogWith, verifyUpgradePlan, verifyPreparedCapabilities, verifyPendingCapabilities as verifyPendingCapabilitiesWith, upgradeResultExpectation as upgradeResultExpectationWith, isFirstTools, routeIdentity, definitionsForLedger, historyIgnoredColumns, historyIgnoredColumnsFor, migrationExpectedLedger } from "./maintenance-common.mjs";
import { validateWorkspacePlan, verifyExistingGrant, verifyWorkspaceIdentity } from "./workspace-grant.mjs";

const verifyUpgradedCatalog = (current, previousAudit, newRefs = []) => verifyUpgradedCatalogWith(current, previousAudit, newRefs);
const verifyPendingCapabilities = (pending, frozen, refs = []) => verifyPendingCapabilitiesWith(pending, frozen, refs);
const upgradeResultExpectation = (value, refs = []) => upgradeResultExpectationWith(value, refs);

const require = createRequire(path.join(process.cwd(), "package.json"));
const BetterSqlite3 = require("better-sqlite3");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const preUpgradeKeys = strictCapabilityKeys.filter((key) => !["integrityMatchesSnapshot", "declarationInvariantMatchesSnapshot"].includes(key));
const throwsCode = (operation, code, name) => assert.throws(operation, (error) => error instanceof Error && error.message.split("\n")[0] === code, name);
const counts = {};
const count = (group) => { counts[group] = (counts[group] ?? 0) + 1; };
const rejectAll = (group, base, cases, check) => {
  for (const [name, code, mutate] of cases) {
    const value = structuredClone(base);
    mutate(value);
    throwsCode(() => check(value), code, name);
    count(group);
  }
};
assert(typeof process.env.HIMAWARI_TEST_TEMP_ROOT === "string", "FIXTURE_OWNED_TEMP_ROOT_REQUIRED");
const originRelease = historyIgnoredColumnsFor([{ sequence: 97, name: "other" }, { sequence: 98, name: "thread_origin", phase: "expand" }]);
assert.deepEqual(originRelease, { threads: ["origin"] }, "HISTORY_ORIGIN_IGNORED_WHEN_THE_PACKET_LEDGER_HAS_THREAD_ORIGIN");
assert.deepEqual(historyIgnoredColumnsFor([{ sequence: 97, name: "other" }]), {}, "HISTORY_ORIGIN_COMPARED_WHEN_THE_PACKET_LEDGER_LACKS_THREAD_ORIGIN");
const packetAppliesThreadOrigin = migrationExpectedLedger.some((row) => row.name === "thread_origin");
assert.deepEqual(historyIgnoredColumns, packetAppliesThreadOrigin ? { threads: ["origin"] } : {}, "HISTORY_IGNORED_COLUMNS_FOLLOW_THE_PACKET_LEDGER");
assert.deepEqual(historyIgnoredColumnsFor([{ sequence: 97, name: "thread_origin" }, { sequence: 98, name: "thread_origin" }]), { threads: ["origin"] }, "HISTORY_IGNORED_COLUMNS_MERGED_WITHOUT_DUPLICATES");
assert.deepEqual(historyRow("threads", { __rowid: 1, id: "thread:1", origin: "think" }, originRelease), { __rowid: 1, id: "thread:1" }, "HISTORY_ROW_THREAD_ORIGIN_IGNORED");
assert.deepEqual(historyRow("threads", { __rowid: 1, id: "thread:1", origin: "think" }), { __rowid: 1, id: "thread:1", origin: "think" }, "HISTORY_ROW_KEEPS_ORIGIN_BY_DEFAULT");
assert.deepEqual(historyRow("messages", { __rowid: 1, origin: "x" }, originRelease), { __rowid: 1, origin: "x" }, "HISTORY_ROW_OTHER_TABLES_KEEP_EVERY_COLUMN");

const releaseWithoutMigrationIds = [{ sequence: 1, name: "a" }, { sequence: 78, name: "b" }];
const releaseWithMigrationIds = [{ sequence: 1, id: "0001", name: "a" }, { sequence: 78, id: "0078", name: "b" }, { sequence: 96, id: "20261114120000", name: "c" }];
assert.deepEqual(definitionsForLedger(releaseWithoutMigrationIds, [{ sequence: 1 }, { sequence: 78 }]).map((definition) => definition?.name), ["a", "b"], "MIGRATION_DEFINITIONS_OLD_RELEASE_NO_ID_COLUMN");
assert.deepEqual(definitionsForLedger(releaseWithMigrationIds, [{ sequence: 1 }, { sequence: 78 }]).map((definition) => definition?.name), ["a", "b"], "MIGRATION_DEFINITIONS_NEW_RELEASE_NO_ID_COLUMN");
assert.deepEqual(definitionsForLedger(releaseWithMigrationIds, [{ sequence: 1, id: "0001" }, { sequence: 96, id: "20261114120000" }]).map((definition) => definition?.name), ["a", "c"], "MIGRATION_DEFINITIONS_ID_COLUMN");
assert.equal(definitionsForLedger(releaseWithoutMigrationIds, [{ sequence: 2 }])[0], undefined, "MIGRATION_DEFINITIONS_UNKNOWN_SEQUENCE");

const plan = { decisionRef: "G90", routeKey: "coding", grantId: "directory:himawari-prod-workspace-20261015", canonicalPath: "/var/lib/himawari/workspace", subdirectories: ["files", "repos"] };
const fourthPlan = { decisionRef: "G90", routeKey: "coding", oldGrantId: "directory:himawari-prod-workspace-20261012", oldCanonicalPath: "/var/lib/himawari/qualification-workspace", newGrantId: plan.grantId, canonicalPath: plan.canonicalPath, subdirectories: ["files", "repos"], durationDays: 90 };
const expectedWebRoute = (capabilityRef, maximumBytes) => ({ scopeSource: "private_temp", hostId: "host:one", workerInstanceId: "worker:one", capabilityRef, capabilityVersion: "1.0.0", maximumBytes, providers: ["exa-public", "deepseek"], providerSecrets: { deepseek: "deepseek-web" } });
const original = { ownerId: "owner:one", agentId: "agent:one", deploymentId: "deployment:one", stateRoot: "/fixture/state", http: { host: "127.0.0.1", port: 8787, staticRoot: oldStaticRoot }, runPolicy: { maxWallTimeMs: 1500, systemInstruction: "只在授权目录内工作。", coding: { hostId: "host:one", workerInstanceId: "worker:one", grantId: plan.grantId, capabilityRef: "himawari.pi-coding", capabilityVersion: "1.0.0", maximumBytes: 49152, enabledTools: ["read", "write", "edit", "bash", "find", "grep", "ls"], approval: "workspace_auto" }, publicSearch: expectedWebRoute("himawari.public-search", 4096), publicFetch: expectedWebRoute("himawari.public-fetch", __PKT_ORIGINAL_PUBLIC_FETCH_BYTES__) }, secretReferences: [{ ref: "vercel-gateway", version: "v1", purpose: "model-gateway", scope: "deployment:one" }, { ref: "deepseek-web", version: "v1", purpose: "web-provider", scope: "himawari-prod-deployment" }], modelDescriptors: [{ ref: "__PKT_MODEL_REF__", role: "primary", contextWindow: __PKT_ORIGINAL_CONTEXT_WINDOW__, maxTokens: __PKT_ORIGINAL_MAX_TOKENS__, cost: { input: 0.45, output: 1.8 } }, { ref: "qwen-embedding", role: "embedding", dimensions: 4096 }], memory: { dimensions: 4096 }, capabilityDeployment: { snapshotPath: "/fixture/snapshot", sha256: `sha256:${"1".repeat(64)}` } };
const originalBefore = JSON.stringify(original);
const staticConfiguration = staticRootConfiguration(original);
const expectedStaticConfiguration = { ...structuredClone(original), http: { ...structuredClone(original.http), staticRoot: newStaticRoot } };
Object.assign(expectedStaticConfiguration.modelDescriptors[0], { contextWindow: __PKT_TARGET_CONTEXT_WINDOW__, maxTokens: __PKT_TARGET_MAX_TOKENS__ });
expectedStaticConfiguration.runPolicy.publicFetch.maximumBytes = __PKT_TARGET_PUBLIC_FETCH_BYTES__;
if (approvedEmbeddingDescriptor !== null) {
  expectedStaticConfiguration.modelDescriptors[1] = structuredClone(approvedEmbeddingDescriptor);
  expectedStaticConfiguration.memory.dimensions = approvedEmbeddingDescriptor.dimensions;
}
if (approvedSpeech !== null) expectedStaticConfiguration.speech = structuredClone(approvedSpeech);
for (const [key, value] of Object.entries(approvedRunPolicyAdditions)) expectedStaticConfiguration.runPolicy[key] = structuredClone(value);
for (const secret of approvedSecretReferences) expectedStaticConfiguration.secretReferences = [...expectedStaticConfiguration.secretReferences.filter((entry) => entry.ref !== secret.ref), structuredClone(secret)];
assert.deepEqual(staticConfiguration, expectedStaticConfiguration, "STATIC_ROOT_CONFIGURATION_SHAPE_CHANGED");
assert.deepEqual(Object.keys(staticConfiguration), Object.keys(expectedStaticConfiguration), "STATIC_ROOT_CONFIGURATION_KEY_ORDER_CHANGED");
assert.deepEqual(Object.keys(staticConfiguration.modelDescriptors[0]), Object.keys(original.modelDescriptors[0]), "STATIC_ROOT_CONFIGURATION_MODEL_KEY_ORDER_CHANGED");
assert.equal(staticRootConfigurationBytes(original).toString("utf8"), JSON.stringify(staticConfiguration, null, 2) + "\n", "STATIC_ROOT_CONFIGURATION_BYTES_CHANGED");
const preparedConfiguration = { ...structuredClone(staticConfiguration), capabilityDeployment: { snapshotPath: "/fixture/snapshot", sha256: `sha256:${"2".repeat(64)}` } };
assert.equal(configurationStage(original, structuredClone(original)), "original");
assert.equal(configurationStage(original, structuredClone(staticConfiguration)), "static-root");
assert.equal(configurationStage(original, preparedConfiguration), "prepared");
assert.equal(JSON.stringify(original), originalBefore, "CONFIGURATION_CHECK_MUTATED_ORIGINAL");
count("configurationAccepted");
rejectAll("configurationRejections", preparedConfiguration, [
  ["grant switched", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.runPolicy.coding.grantId = "directory:other"; }],
  ["tool added", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.runPolicy.coding.enabledTools.push("delete"); }],
  ["approval loosened", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.runPolicy.coding.approval = "never_ask"; }],
  ["maximum bytes raised", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.runPolicy.coding.maximumBytes = 49153; }],
  ["instruction changed", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.runPolicy.systemInstruction = "其他指令"; }],
  ["wall time changed", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.runPolicy.maxWallTimeMs = 1600; }],
  ["state root changed", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.stateRoot = "/other"; }],
  ["owner changed", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.ownerId = "owner:other"; }],
  ["additional field", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.additionalSetting = true; }],
  ["additional route", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.runPolicy.other = structuredClone(value.runPolicy.coding); }],
  ["configuration change carried", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.configurationChange = { coding: {} }; }],
  ["coding route removed", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { delete value.runPolicy.coding; }],
  ["fetch maximum bytes raised", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.runPolicy.publicFetch.maximumBytes = __PKT_TARGET_PUBLIC_FETCH_BYTES__ + 1; }],
  ["search provider dropped", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.runPolicy.publicSearch.providers = ["exa-public"]; }],
  ["fetch secret renamed", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.runPolicy.publicFetch.providerSecrets.deepseek = "other-secret"; }],
  ["fetch route removed", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { delete value.runPolicy.publicFetch; }],
  ["extra secret reference", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.secretReferences.push({ ref: "other", version: "v1", purpose: "web-provider", scope: "himawari-prod-deployment" }); }],
  ["DeepSeek secret reference missing", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.secretReferences.pop(); }],
  ["static root on other release", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.http.staticRoot = "/opt/himawari/releases/other/share/control-center"; }],
  ["static root kept old with new snapshot", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.http.staticRoot = oldStaticRoot; }],
  ["http port changed", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.http.port = 8788; }],
  ["http field added", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.http.cors = "*"; }],
  ["context window kept old", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.modelDescriptors[0].contextWindow = __PKT_TARGET_CONTEXT_WINDOW__ + 1; }],
  ["output limit other value", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.modelDescriptors[0].maxTokens = __PKT_TARGET_MAX_TOKENS__ + 1; }],
  ["embedding model changed", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.modelDescriptors[1].dimensions = 777; }],
  ["embedding model renamed", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.modelDescriptors[1].model = "other-embedding"; }],
  ["memory dimensions changed", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.memory.dimensions = 777; }],
  ["model cost changed", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.modelDescriptors[0].cost.output = 0; }],
  ["fetch limit kept old", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.runPolicy.publicFetch.maximumBytes = __PKT_TARGET_PUBLIC_FETCH_BYTES__ - 1; }],
  ["budgets added", "__PKT_LABEL_UPPER___MAINTENANCE_UNAPPROVED_CONFIG_FIELD_CHANGED", (value) => { value.budgets = {}; }],
], (value) => configurationStage(original, value));
rejectAll("configurationOriginalRejections", original, [
  ["original static root already new", "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_STATIC_ROOT_CHANGED", (value) => { value.http.staticRoot = newStaticRoot; }],
  ["original static root elsewhere", "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_STATIC_ROOT_CHANGED", (value) => { value.http.staticRoot = "/opt/himawari/releases/2026-10-18-sixth/share/control-center"; }],
  ["original without http", "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_STATIC_ROOT_CHANGED", (value) => { delete value.http; }],
  ["original without primary model", "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_MODEL_DESCRIPTOR_CHANGED", (value) => { value.modelDescriptors[0].ref = "other-primary"; }],
  ["original primary model twice", "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_MODEL_DESCRIPTOR_CHANGED", (value) => { value.modelDescriptors.push(structuredClone(value.modelDescriptors[0])); }],
  ["original window not a number", "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_MODEL_DESCRIPTOR_CHANGED", (value) => { delete value.modelDescriptors[0].contextWindow; }],
  ["original with budgets", "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_BUDGETS_PRESENT", (value) => { value.budgets = {}; }],
  ["original context window old", "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_MODEL_DESCRIPTOR_CHANGED", (value) => { value.modelDescriptors[0].contextWindow = __PKT_ORIGINAL_CONTEXT_WINDOW__ - 1; }],
  ["original output limit old", "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_MODEL_DESCRIPTOR_CHANGED", (value) => { value.modelDescriptors[0].maxTokens = __PKT_ORIGINAL_MAX_TOKENS__ - 1; }],
  ["original fetch limit old", "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_PUBLIC_FETCH_CHANGED", (value) => { value.runPolicy.publicFetch.maximumBytes = __PKT_ORIGINAL_PUBLIC_FETCH_BYTES__ - 1; }],
  ["original without fetch route", "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_PUBLIC_FETCH_CHANGED", (value) => { delete value.runPolicy.publicFetch; }],
], (value) => configurationStage(value, preparedConfiguration));
if (approvedEmbeddingDescriptor !== null) rejectAll("configurationEmbeddingOriginalRejections", original, [
  ["original embedding missing", "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_EMBEDDING_DESCRIPTOR_CHANGED", (value) => { value.modelDescriptors.pop(); }],
  ["original memory missing", "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_EMBEDDING_DESCRIPTOR_CHANGED", (value) => { delete value.memory; }],
], (value) => configurationStage(value, preparedConfiguration));

const startupBinding = { identity: { deploymentId: "deployment:one", ownerId: "owner:one", agentId: "agent:one" }, authority: { authorityEpoch: 3, fencingToken: 7 } };
const liveAuthority = { deploymentId: "deployment:one", ownerId: "owner:one", agentId: "agent:one", authorityEpoch: 3, fencingToken: 8, status: "active" };
const bootBinding = { ...liveAuthority, workerInstanceId: "worker:one", workerBootId: "boot:one" };
const startupReport = { schemaVersion: "himawari.__PKT_LABEL__-change-startup-verification.v1", passed: true, authority: liveAuthority, currentEpoch: 3, currentFencingToken: 8, agentBinding: { ...bootBinding }, workerBinding: { ...bootBinding } };
verifyStartupAuthority(liveAuthority, startupBinding, startupReport);
for (const [name, code, mutate] of [
  ["fence not advanced", "__PKT_LABEL_UPPER___MAINTENANCE_LIVE_FENCING_NOT_ADVANCED", (value) => { value.authority.fencingToken = 7; value.currentFencingToken = 7; value.agentBinding.fencingToken = 7; value.workerBinding.fencingToken = 7; value.live.fencingToken = 7; }],
  ["epoch changed", "__PKT_LABEL_UPPER___MAINTENANCE_LIVE_EPOCH_CHANGED", (value) => { value.authority.authorityEpoch = 4; }],
  ["deployment changed", "__PKT_LABEL_UPPER___MAINTENANCE_LIVE_AUTHORITY_CHANGED", (value) => { value.authority.deploymentId = "deployment:other"; }],
  ["report current fence differs", "__PKT_LABEL_UPPER___MAINTENANCE_STARTUP_CURRENT_FENCING_CHANGED", (value) => { value.currentFencingToken = 9; }],
  ["agent boot fence differs", "__PKT_LABEL_UPPER___MAINTENANCE_STARTUP_BOOT_AUTHORITY_CHANGED", (value) => { value.agentBinding.fencingToken = 9; }],
  ["worker boot ID differs", "__PKT_LABEL_UPPER___MAINTENANCE_STARTUP_BOOT_ID_CHANGED", (value) => { value.workerBinding.workerBootId = "boot:other"; }],
  ["report not passed", "__PKT_LABEL_UPPER___MAINTENANCE_STARTUP_NOT_VERIFIED", (value) => { value.passed = false; }],
  ["live fence moved after report", "__PKT_LABEL_UPPER___MAINTENANCE_LIVE_FENCING_CHANGED", (value) => { value.live.fencingToken = 9; }],
]) {
  const value = { ...structuredClone(startupReport), live: structuredClone(liveAuthority) };
  mutate(value);
  const { live, ...report } = value;
  throwsCode(() => verifyStartupAuthority(live, startupBinding, report), code, name);
  count("startupRejections");
}

const db = new BetterSqlite3(":memory:");
db.exec(`CREATE TABLE sandbox_execution_records(job_id TEXT,plan_json TEXT,preparation_state TEXT,started_at TEXT,reservation_stopped_at TEXT);
CREATE TABLE sandbox_reservation_release_receipts(job_id TEXT,verification_json TEXT);
CREATE TABLE sandbox_release_receipts(job_id TEXT,verification_json TEXT);`);
const add = db.prepare("INSERT INTO sandbox_execution_records VALUES(?,?, 'reserved', NULL,?)");
for (const id of ["unresolved", "admin", "automatic", "ordinary", "bad-stop"]) add.run(id, '{"backendRef":"srt"}', "2026-10-08T00:00:00.000Z");
for (const id of ["admin", "automatic"]) db.prepare("INSERT INTO sandbox_reservation_release_receipts VALUES(?,?)").run(id, JSON.stringify({ identity: { jobId: id }, stopRequestedAt: "2026-10-08T00:00:00.000Z", validUntil: "2026-10-08T00:00:01.000Z" }));
db.prepare("INSERT INTO sandbox_reservation_release_receipts VALUES(?,?)").run("bad-stop", JSON.stringify({ identity: { jobId: "bad-stop" }, stopRequestedAt: "2026-10-09T00:00:00.000Z" }));
db.prepare("INSERT INTO sandbox_release_receipts VALUES(?,?)").run("ordinary", '{"identity":{"jobId":"ordinary"}}');
assert.equal(db.prepare(unresolvedQuery).get().count, 2);
db.exec("DROP TABLE sandbox_reservation_release_receipts");
assert.throws(() => db.prepare(unresolvedQuery).get());
db.close();

const expectedIdentity = { deploymentId: "deployment:one", ownerId: "owner:one", agentId: "agent:one", hostId: "host:one" };
const binding = { identity: expectedIdentity };
const full = new BetterSqlite3(":memory:");
full.exec(`CREATE TABLE schema_metadata(key TEXT,value TEXT);
CREATE TABLE schema_migration_ledger(sequence INTEGER,name TEXT,phase TEXT,digest TEXT,applied_at TEXT);
CREATE TABLE deployments(id TEXT,owner_id TEXT,agent_id TEXT,status TEXT,authority_epoch INTEGER,fencing_token INTEGER);
CREATE TABLE sandbox_reservation_release_receipts(job_id TEXT,verification_json TEXT);
CREATE TABLE fixture_user_messages(body TEXT);
INSERT INTO fixture_user_messages VALUES('SECRET_MESSAGE_CANARY_NOT_ALLOWED_IN_OUTPUT');
INSERT INTO schema_metadata VALUES('current_sequence','__PKT_CURRENT_SCHEMA__'),('minimum_writer_sequence','__PKT_CURRENT_SCHEMA__');
INSERT INTO deployments VALUES('deployment:one','owner:one','agent:one','active',3,7);`);
for (const table of historyTables) {
  if (table === "sandbox_execution_records") full.exec("CREATE TABLE sandbox_execution_records(job_id TEXT,plan_json TEXT,preparation_state TEXT,started_at TEXT,reservation_stopped_at TEXT)");
  else if (table === "sandbox_release_receipts") full.exec("CREATE TABLE sandbox_release_receipts(job_id TEXT,verification_json TEXT)");
  else if (table === "runs") full.exec("CREATE TABLE runs(id TEXT,status TEXT,body TEXT)");
  else if (table !== "sandbox_reservation_release_receipts") full.exec(`CREATE TABLE "${table}"(id TEXT,body TEXT)`);
}
for (let index = 1; index <= __PKT_CURRENT_SCHEMA__; index += 1) full.prepare("INSERT INTO schema_migration_ledger VALUES(?,?,?,?,?)").run(index, `migration-${index}`, "expand", "sha256:fixture", "2026-10-08T00:00:00.000Z");
full.prepare("INSERT INTO runs(id,status,body) VALUES(?,?,?)").run("run:one", "completed", "SECRET_RUN_CANARY_NOT_ALLOWED_IN_OUTPUT");
const withWrites = (operation) => { full.pragma("query_only=OFF"); try { operation(); } finally { full.pragma("query_only=ON"); } };
full.pragma("query_only=ON");
const clear = readS0State(full, expectedIdentity);
assert.deepEqual(clear.identity, expectedIdentity);
assert.deepEqual(clear.authority, { deploymentId: "deployment:one", ownerId: "owner:one", agentId: "agent:one", status: "active", authorityEpoch: 3, fencingToken: 7 });
assert.deepEqual(clear.schema, { current: __PKT_CURRENT_SCHEMA__, minimumWriter: __PKT_CURRENT_SCHEMA__, ledgerCount: __PKT_CURRENT_SCHEMA__, ledgerMax: __PKT_CURRENT_SCHEMA__ });
assert.deepEqual(clear.gate, { oldReservedCount: 0, unresolvedReservedCount: 0, nonTerminalRunCount: 0 });
assert.deepEqual(Object.keys(clear.history), [...historyTables]);
assert.equal(clear.history.runs.rows, 1);
assert(!JSON.stringify(clear).includes("CANARY"), "S0_READ_LEAKED_ROW_CONTENT");
count("s0Accepted");
withWrites(() => full.prepare("INSERT INTO sandbox_execution_records VALUES(?,?, 'reserved', NULL,?)").run("job:stopped", '{"backendRef":"srt"}', "2026-10-08T00:00:00.000Z"));
const reserved = readS0State(full, expectedIdentity);
assert.deepEqual(reserved.gate, { oldReservedCount: 1, unresolvedReservedCount: 1, nonTerminalRunCount: 0 });
assert.throws(() => verifyHistoryUnchanged(clear, reserved), /__PKT_LABEL_UPPER___MAINTENANCE_HISTORY_CHANGED/);
withWrites(() => full.exec("DELETE FROM sandbox_execution_records"));
verifyHistoryUnchanged(clear, readS0State(full, expectedIdentity));
withWrites(() => full.exec("UPDATE runs SET body='changed'"));
const changedRun = readS0State(full, expectedIdentity);
assert.equal(changedRun.history.runs.rows, 1);
assert.notEqual(changedRun.history.runs.sha256, clear.history.runs.sha256);
assert.throws(() => verifyHistoryUnchanged(clear, changedRun), /__PKT_LABEL_UPPER___MAINTENANCE_HISTORY_CHANGED/);
withWrites(() => full.exec("UPDATE runs SET body='SECRET_RUN_CANARY_NOT_ALLOWED_IN_OUTPUT'"));
verifyHistoryUnchanged(clear, readS0State(full, expectedIdentity));
for (const status of ["accepted", "building_context", "running", "awaiting_approval", "reconciling_external_result"]) {
  withWrites(() => full.prepare("UPDATE runs SET status=?").run(status));
  assert.equal(readS0State(full, expectedIdentity).gate.nonTerminalRunCount, 1, status);
}
for (const status of ["failed", "cancelled", "completed"]) {
  withWrites(() => full.prepare("UPDATE runs SET status=?").run(status));
  assert.equal(readS0State(full, expectedIdentity).gate.nonTerminalRunCount, 0, status);
}
count("nonTerminalRunsCounted");
throwsCode(() => readS0State(full, { ...expectedIdentity, deploymentId: "deployment:other" }), "__PKT_LABEL_UPPER___DB_EXPECTED_ONE_ROW", "unknown deployment");
for (const [name, code, statement, undo] of [
  ["schema __PKT_PREVIOUS_SCHEMA__", "__PKT_LABEL_UPPER___DB_SCHEMA_UNSUPPORTED", "UPDATE schema_metadata SET value='__PKT_PREVIOUS_SCHEMA__' WHERE key='current_sequence'", "UPDATE schema_metadata SET value='__PKT_CURRENT_SCHEMA__' WHERE key='current_sequence'"],
  ["writer floor __PKT_PREVIOUS_SCHEMA__", "__PKT_LABEL_UPPER___DB_SCHEMA_UNSUPPORTED", "UPDATE schema_metadata SET value='__PKT_PREVIOUS_SCHEMA__' WHERE key='minimum_writer_sequence'", "UPDATE schema_metadata SET value='__PKT_CURRENT_SCHEMA__' WHERE key='minimum_writer_sequence'"],
  ["ledger gap", "__PKT_LABEL_UPPER___DB_LEDGER_INVALID", "UPDATE schema_migration_ledger SET sequence=1000000 WHERE sequence=10", "UPDATE schema_migration_ledger SET sequence=10 WHERE sequence=1000000"],
  ["deployment retired", "__PKT_LABEL_UPPER___DB_DEPLOYMENT_NOT_ACTIVE", "UPDATE deployments SET status='retired'", "UPDATE deployments SET status='active'"],
  ["fencing token zero", "__PKT_LABEL_UPPER___DB_AUTHORITY_INVALID", "UPDATE deployments SET fencing_token=0", "UPDATE deployments SET fencing_token=7"],
  ["history table missing", "__PKT_LABEL_UPPER___DB_HISTORY_TABLE_MISSING", "ALTER TABLE threads RENAME TO threads_hidden", "ALTER TABLE threads_hidden RENAME TO threads"],
]) {
  withWrites(() => full.exec(statement));
  throwsCode(() => readS0State(full, expectedIdentity), code, name);
  withWrites(() => full.exec(undo));
  count("s0Rejections");
}
verifyHistoryUnchanged(clear, readS0State(full, expectedIdentity));

withWrites(() => {
  full.exec("ALTER TABLE sandbox_execution_records ADD COLUMN recovery_json TEXT");
  full.prepare("INSERT INTO sandbox_execution_records VALUES(?,?,?,?,?,?)").run("job:recovered", '{"backendRef":"srt"}', "terminal", "2026-10-08T00:00:00.000Z", null, '{"status":"resolved","revision":2}');
  full.prepare("INSERT INTO threads(id,body) VALUES(?,?)").run("thread:one", "SECRET_THREAD_CANARY_NOT_ALLOWED_IN_OUTPUT");
});
const historyReference = new BetterSqlite3(full.serialize());
withWrites(() => {
  full.prepare("INSERT INTO runs(id,status,body) VALUES(?,?,?)").run("run:two", "completed", "new");
  full.prepare("INSERT INTO threads(id,body) VALUES(?,?)").run("thread:two", "new");
});
withWrites(() => full.exec("ALTER TABLE threads ADD COLUMN origin TEXT NOT NULL DEFAULT 'owner'; UPDATE threads SET origin='think' WHERE id='thread:two'"));
const referenceHistory = historyDigests(historyReference, originRelease).threads;
const originHistory = historyDigests(full, originRelease).threads;
assert.equal(originHistory.rows, referenceHistory.rows + 1);
assert.notDeepEqual(historyDigests(full).threads, originHistory, "HISTORY_ORIGIN_DIGEST_COUNTS_ORIGIN_BY_DEFAULT");
count("historyDigestsAccepted");
withWrites(() => full.exec("UPDATE threads SET body='changed' WHERE id='thread:one'"));
assert.notDeepEqual(historyDigests(full, originRelease).threads.sha256, referenceHistory.sha256, "HISTORY_DIGEST_SEES_AN_OLD_THREAD_CHANGE_BESIDE_ORIGIN");
count("historyDigestsRejections");
withWrites(() => full.exec("UPDATE threads SET body='SECRET_THREAD_CANARY_NOT_ALLOWED_IN_OUTPUT' WHERE id='thread:one'; ALTER TABLE threads DROP COLUMN origin"));
historyReference.close();

const registeredRuntime = `${catalogRegistrationPrefix}/lib/himawari-agent`;
const previousRuntime = `${oldPrefix}/lib/himawari-agent`;
const newRuntime = `${newPrefix}/lib/himawari-agent`;
assert.equal(registeredRuntime, previousRuntime, "FIXTURE_REGISTRATION_NOT_PREVIOUS");
const issuedAt = { [previousRuntime]: "2026-10-17T00:00:00.000Z", [newRuntime]: "2026-10-18T00:00:00.000Z" };
const keys = ["pi", "search", "fetch"];
const registeredKeys = ["pi", "search", "fetch"];
const refOf = { pi: "himawari.pi-coding", search: "himawari.public-search", fetch: "himawari.public-fetch" };
const keyOf = (capabilityRef) => Object.keys(refOf).find((key) => refOf[key] === capabilityRef);
const webNetwork = ["mcp.exa.ai:443", "api.deepseek.com:443"];
const networkOf = (key) => key === "pi" ? [] : [...webNetwork];
const secretsOf = (key) => key === "pi" ? [] : ["deepseek-web"];
const operationsOf = { pi: ["read", "write", "edit"], search: ["web_search"], fetch: ["web_fetch"] };
const runnerPath = (runtime, key) => `${runtime}/capability-runners/${key}.mjs`;
const runnerSources = new Map(keys.flatMap((key) => [previousRuntime, newRuntime].map((runtime) => [runnerPath(runtime, key), `export const runner = ${JSON.stringify(`${runtime}:${key}`)};\n`])));
const runnerDigest = (filename) => {
  assert(runnerSources.has(filename), "FIXTURE_RUNNER_UNKNOWN");
  return sha(runnerSources.get(filename));
};
const artifactOf = (runtime, key) => `sha256:${runnerDigest(runnerPath(runtime, key))}`;
const manifestFor = (key, runtime, checkedAt) => ({ manifestVersion: "capability.v2", ref: refOf[key], displayName: key, version: "1.0.0", source: { type: "program", locator: `artifact:${runtime}:${key}` }, sourceIdentity: "host:host:one", integrity: artifactOf(runtime, key), artifact: { digest: artifactOf(runtime, key), signatureStatus: "verified", signerRef: "host-signer:fixture", rollbackArtifactRef: null }, operations: [...operationsOf[key]], permissionRefs: [], isolation: "sandbox", scopes: { dataClassifications: ["public", "private"], network: networkOf(key), filesystem: ["workspace:fixture"], secrets: secretsOf(key) }, cost: { currency: "USD", maxMicrosPerInvocation: 0 }, health: { status: "healthy", checkedAt }, reviewedBy: "owner:one", reviewedAt: issuedAt[runtime], contractCompatibility: ["capability-conformance.v1"], runtime: { kind: "program", argv: ["/opt/himawari/node/bin/node", runnerPath(runtime, key), "host:one", "worker:one"], environmentKeys: [], workdirRef: "workspace:fixture", stdin: "protected_payload", stdout: "protected_payload", subprocesses: [], network: networkOf(key), filesystem: ["workspace:fixture"] } });
const qualificationFor = (key, runtime, checkedAt) => ({ qualificationVersion: "capability-runtime-qualification.v1", runtimeIdentity: "srt:0.0.81", productionSuitable: true, artifactDigest: artifactOf(runtime, key), reasonCodes: [], checkedAt, sandbox: { osRelease: "6.8.0-fixture", runnerDigest: runnerDigest(runnerPath(runtime, key)) } });
const snapshotFor = (runtime, order, checkedAt = "2026-10-18T01:00:00.000Z") => ({ schemaVersion: "capability-deployment.v1", capabilities: order.map((key) => ({ manifest: manifestFor(key, runtime, checkedAt), binding: { kind: "sandbox", value: { hostId: "host:one", runtimeRoot: runtime, roots: [{ canonicalRootId: "1:9", canonicalPath: plan.canonicalPath, device: "1", inode: "9" }], runner: { path: runnerPath(runtime, key), sha256: runnerDigest(runnerPath(runtime, key)) } } }, qualification: qualificationFor(key, runtime, checkedAt) })) });
const registered = Object.fromEntries(registeredKeys.map((key) => [key, { ref: refOf[key], revision: { pi: 3, search: 2, fetch: 1 }[key], lifecycle: "active", declaration: manifestFor(key, registeredRuntime, issuedAt[registeredRuntime]), pendingDeclaration: null, permissionExpansion: false, runtimeQualification: qualificationFor(key, registeredRuntime, issuedAt[registeredRuntime]), pendingUpdateAssessment: null, rollbackDeclaration: null, rollbackQualification: null, lastVersionTransition: null, updatedAt: issuedAt[registeredRuntime] }]));
const grantKey = `host-workspace:directory-grant:${plan.grantId}`;
const grantValue = { id: plan.grantId, revision: 1, hostId: "host:one", canonicalRootId: "1:9", displayPath: plan.canonicalPath, operations: ["read", "create", "update"], dataClassification: "private", disclosure: "model", pathPolicy: "same_filesystem_no_links", mountPolicy: "fixed_device", authorizationRef: `owner-cli:${plan.grantId}`, expiresAt: "2099-01-01T00:00:00.000Z", revokedAt: null };
const writeDeclaration = (record) => full.prepare("UPDATE capability_declarations SET revision=?,integrity=?,record_json=? WHERE id=?").run(record.revision, record.declaration.integrity, JSON.stringify(record), record.ref);
const insertDeclaration = (record) => full.prepare("INSERT INTO capability_declarations VALUES(?,?,?,?,?,?,?,?)").run(record.ref, "owner:one", "agent:one", "1.0.0", "active", record.revision, record.declaration.integrity, JSON.stringify(record));
const writeGrant = (revision, value) => full.prepare("UPDATE product_state_records SET revision=?,value_json=? WHERE key=?").run(revision, JSON.stringify(value), grantKey);
const audit = (ownerId, action, targetRef, outcome) => full.prepare("INSERT INTO audit_records VALUES(?,?,?,?,?)").run(ownerId, "agent:one", action, targetRef, outcome);
withWrites(() => {
  full.exec(`CREATE TABLE product_state_records(key TEXT,owner_id TEXT,agent_id TEXT,revision INTEGER,value_json TEXT);
CREATE TABLE capability_declarations(id TEXT,owner_id TEXT,agent_id TEXT,version TEXT,status TEXT,revision INTEGER,integrity TEXT,record_json TEXT);
CREATE TABLE capability_handles(capability_id TEXT,status TEXT,revoked_at TEXT);
CREATE TABLE audit_records(owner_id TEXT,agent_id TEXT,action TEXT,target_ref TEXT,outcome TEXT);`);
  full.prepare("INSERT INTO product_state_records VALUES(?,?,?,?,?)").run(grantKey, "owner:one", "agent:one", 2, JSON.stringify(grantValue));
  for (const record of Object.values(registered)) insertDeclaration(record);
  for (const [status, revokedAt] of [["revoked", "2026-10-15T00:00:00.000Z"], ["revoked", null], ["consumed", null]]) full.prepare("INSERT INTO capability_handles VALUES(?,?,?)").run(refOf.pi, status, revokedAt);
  audit("owner:one", "owner.capability.register", refOf.pi, "completed");
  audit("owner:one", "owner.capability.upgrade", "capability:retired", "completed");
  audit("owner:one", "owner.capability.scope_upgrade", refOf.search, "completed");
  audit("owner:one", "owner.capability.register", refOf.fetch, "completed");
  audit("owner:one", "owner.capability.revoke", refOf.search, "completed");
  audit("owner:other", "owner.capability.upgrade", refOf.pi, "completed");
});
const byRef = (capabilities, capabilityRef) => capabilities.find((capability) => capability.capabilityRef === capabilityRef);

const previousSnapshot = snapshotFor(previousRuntime, ["pi", "search", "fetch"], "2026-10-18T01:00:00.000Z");
const previousStrict = readRouteAuthorization(full, original, previousSnapshot, runnerDigest, registeredRuntime);
assert.deepEqual(previousStrict.capabilities.map((capability) => capability.capabilityRef), [refOf.pi, refOf.search, refOf.fetch]);
for (const capability of previousStrict.capabilities) {
  for (const key of strictCapabilityKeys) assert.equal(capability[key], true, "PREVIOUS_STRICT_KEY_FALSE:" + key);
  assert.equal(capability.storedIntegrity, artifactOf(previousRuntime, keyOf(capability.capabilityRef)));
  assert.equal(capability.runtimeRoot, previousRuntime);
}
verifyAuthorizationUsable(previousStrict);
assert.deepEqual(readRouteAuthorization(full, structuredClone(staticConfiguration), previousSnapshot, runnerDigest, registeredRuntime), previousStrict, "STATIC_ROOT_CHANGED_PREVIOUS_AUTHORIZATION");
count("previousStrictShape");
count("staticRootIgnoredByGrantReadback");
assert.equal(previousStrict.directoryGrants.length, 1);
const grant = previousStrict.directoryGrants[0];
assert.deepEqual([grant.routeKey, grant.grantId, grant.displayPath, grant.stateRevision, grant.readAllowed, grant.hostMatchesRoute, grant.rootMatchesSnapshot, grant.currentlyUsable], ["coding", plan.grantId, plan.canonicalPath, 2, true, true, true, true]);

const frozenWorkspace = { path: plan.canonicalPath, device: "1", inode: "9", uid: __PKT_SERVICE_UID__, gid: __PKT_SERVICE_GID__, mode: "0700", subdirectories: [{ name: "files", device: "1", inode: "10", uid: __PKT_SERVICE_UID__, gid: __PKT_SERVICE_GID__, mode: "0700" }, { name: "repos", device: "1", inode: "11", uid: __PKT_SERVICE_UID__, gid: __PKT_SERVICE_GID__, mode: "0700" }] };
const frozen = { authorization: previousStrict, workspace: frozenWorkspace };

assert.deepEqual(validateWorkspacePlan(structuredClone(plan)), plan);
count("workspacePlanAccepted");
rejectAll("workspacePlanRejections", plan, [
  ["other decision", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_PLAN_CHANGED", (value) => { value.decisionRef = "G76"; }],
  ["other route", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_PLAN_CHANGED", (value) => { value.routeKey = "other"; }],
  ["other grant", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_PLAN_CHANGED", (value) => { value.grantId = "directory:himawari-prod-workspace-20261012"; }],
  ["directory moved", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_PLAN_CHANGED", (value) => { value.canonicalPath = "/var/lib/himawari/qualification-workspace"; }],
  ["subdirectory missing", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_PLAN_CHANGED", (value) => { value.subdirectories = ["files"]; }],
  ["subdirectories reordered", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_PLAN_CHANGED", (value) => { value.subdirectories.reverse(); }],
  ["renewal requested", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_PLAN_CHANGED", (value) => { value.durationDays = 90; }],
  ["grant ID missing", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_PLAN_CHANGED", (value) => { delete value.grantId; }],
], validateWorkspacePlan);
throwsCode(() => validateWorkspacePlan(structuredClone(fourthPlan)), "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_PLAN_CHANGED", "fourth grant-creation plan");
throwsCode(() => validateWorkspacePlan(undefined), "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_PLAN_CHANGED", "plan missing");
count("workspacePlanRejections");
count("workspacePlanRejections");

assert.deepEqual(verifyExistingGrant(structuredClone(previousStrict.directoryGrants), structuredClone(frozen.authorization.directoryGrants), plan), grant);
count("existingGrantAccepted");
const bothGrants = (mutate) => (value) => { mutate(value.live[0]); mutate(value.frozen[0]); };
rejectAll("existingGrantRejections", { live: structuredClone(previousStrict.directoryGrants), frozen: structuredClone(frozen.authorization.directoryGrants) }, [
  ["live grants missing", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_REQUIRED", (value) => { value.live = undefined; }],
  ["second frozen grant", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_SET_CHANGED", (value) => { value.frozen.push({ ...value.frozen[0], grantId: "directory:other" }); value.live = structuredClone(value.frozen); }],
  ["frozen other grant", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_CHANGED", bothGrants((entry) => { entry.grantId = "directory:other"; })],
  ["frozen other route", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_CHANGED", bothGrants((entry) => { entry.routeKey = "other"; })],
  ["frozen other directory", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_CHANGED", bothGrants((entry) => { entry.displayPath = "/var/lib/himawari/qualification-workspace"; })],
  ["live metadata changed", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_CHANGED", (value) => { value.live[0].metadataSha256 = "a".repeat(64); }],
  ["live grant extended", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_CHANGED", (value) => { value.live[0].expiresAt = "2100-01-01T00:00:00.000Z"; }],
  ["live second grant", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_CHANGED", (value) => { value.live.push(structuredClone(value.live[0])); }],
  ["grant revoked", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_UNUSABLE", bothGrants((entry) => { entry.revokedAt = "2026-10-16T00:00:00.000Z"; })],
  ["grant expired", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_UNUSABLE", bothGrants((entry) => { entry.expiresAt = "2026-01-01T00:00:00.000Z"; })],
  ["grant unreadable", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_UNUSABLE", bothGrants((entry) => { entry.readAllowed = false; })],
  ["grant on other host", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_UNUSABLE", bothGrants((entry) => { entry.hostMatchesRoute = false; })],
  ["grant root not in snapshot", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_UNUSABLE", bothGrants((entry) => { entry.rootMatchesSnapshot = false; })],
  ["grant not usable", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_UNUSABLE", bothGrants((entry) => { entry.currentlyUsable = false; })],
], (value) => verifyExistingGrant(value.live, value.frozen, plan));
withWrites(() => writeGrant(3, { ...grantValue, expiresAt: "2100-01-01T00:00:00.000Z" }));
throwsCode(() => verifyExistingGrant(readRouteAuthorization(full, original, previousSnapshot, runnerDigest, registeredRuntime).directoryGrants, frozen.authorization.directoryGrants, plan), "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_GRANT_CHANGED", "grant renewed in database");
withWrites(() => writeGrant(2, grantValue));
assert.deepEqual(readRouteAuthorization(full, original, previousSnapshot, runnerDigest, registeredRuntime), previousStrict, "GRANT_RESTORE_FAILED");
count("existingGrantRejections");

assert.deepEqual(verifyWorkspaceIdentity(structuredClone(frozenWorkspace), structuredClone(frozenWorkspace), plan), frozenWorkspace);
count("workspaceIdentityAccepted");
rejectAll("workspaceIdentityRejections", { live: structuredClone(frozenWorkspace), frozen: structuredClone(frozenWorkspace) }, [
  ["frozen identity missing", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_IDENTITY_REQUIRED", (value) => { value.frozen = null; }],
  ["frozen on other path", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_IDENTITY_REQUIRED", (value) => { value.frozen.path = "/var/lib/himawari/qualification-workspace"; }],
  ["frozen subdirectory missing", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_SUBDIRECTORIES_CHANGED", (value) => { value.frozen.subdirectories.pop(); }],
  ["frozen subdirectories reordered", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_SUBDIRECTORIES_CHANGED", (value) => { value.frozen.subdirectories.reverse(); }],
  ["frozen root owner", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_OWNER_OR_MODE_CHANGED", (value) => { value.frozen.uid = 0; }],
  ["frozen other group", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_OWNER_OR_MODE_CHANGED", (value) => { value.frozen.gid = 0; }],
  ["frozen group-readable", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_OWNER_OR_MODE_CHANGED", (value) => { value.frozen.mode = "0750"; }],
  ["live directory replaced", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_IDENTITY_CHANGED", (value) => { value.live.inode = "12"; }],
  ["live root mode widened", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_IDENTITY_CHANGED", (value) => { value.live.mode = "0750"; }],
  ["live subdirectory replaced", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_IDENTITY_CHANGED", (value) => { value.live.subdirectories[1].inode = "13"; }],
  ["live subdirectory mode widened", "__PKT_LABEL_UPPER___MAINTENANCE_WORKSPACE_IDENTITY_CHANGED", (value) => { value.live.subdirectories[0].mode = "0755"; }],
], (value) => verifyWorkspaceIdentity(value.live, value.frozen, plan));
const workspaceRoot = mkdtempSync(path.join(process.env.HIMAWARI_TEST_TEMP_ROOT, "maintenance-workspace-"));
try {
  for (const name of ["files", "repos"]) mkdirSync(path.join(workspaceRoot, name), { mode: 0o700 });
  const observed = readExistingWorkspace(workspaceRoot);
  assert.deepEqual(Object.keys(observed), ["path", "device", "inode", "uid", "gid", "mode", "subdirectories"]);
  assert.deepEqual(observed.subdirectories.map((child) => child.name), ["files", "repos"]);
  assert(observed.path === workspaceRoot && observed.mode === "0700" && /^\d+$/.test(observed.device) && /^\d+$/.test(observed.inode), "WORKSPACE_IDENTITY_SHAPE_CHANGED");
  assert.deepEqual(readExistingWorkspace(workspaceRoot), observed);
  renameSync(path.join(workspaceRoot, "repos"), path.join(workspaceRoot, "repos-replaced"));
  mkdirSync(path.join(workspaceRoot, "repos"), { mode: 0o700 });
  assert.notEqual(readExistingWorkspace(workspaceRoot).subdirectories[1].inode, observed.subdirectories[1].inode, "REPLACED_DIRECTORY_NOT_DETECTED");
  rmSync(path.join(workspaceRoot, "repos-replaced"), { recursive: true });
  rmSync(path.join(workspaceRoot, "repos"), { recursive: true });
  symlinkSync(path.join(workspaceRoot, "files"), path.join(workspaceRoot, "repos"));
  throwsCode(() => readExistingWorkspace(workspaceRoot), "__PKT_LABEL_UPPER___DB_WORKSPACE_UNSAFE", "symlinked subdirectory");
  count("workspaceDirectoryRead");
} finally {
  rmSync(workspaceRoot, { recursive: true });
}

const atS0 = readCatalogRecords(full, binding, frozen);
verifyCatalogRecordsAtS0(atS0, frozen);
const auditAtS0 = [{ action: "owner.capability.register", targetRef: refOf.pi, outcome: "completed" }, { action: "owner.capability.upgrade", targetRef: "capability:retired", outcome: "completed" }, { action: "owner.capability.scope_upgrade", targetRef: refOf.search, outcome: "completed" }, { action: "owner.capability.register", targetRef: refOf.fetch, outcome: "completed" }];
assert.deepEqual(atS0.upgradeAudit, auditAtS0);
assert.deepEqual(atS0.capabilities.map((capability) => [capability.capabilityRef, capability.revision, capability.unrevokedHandles]), [[refOf.pi, 3, 0], [refOf.search, 2, 0], [refOf.fetch, 1, 0]]);
assert.equal(full.prepare("SELECT count(*) AS count FROM capability_handles WHERE status<>'active' AND revoked_at IS NULL").get().count, 2);
count("catalogAtS0Accepted");
count("endedAndUsedUpHandlesNotUsable");
rejectAll("catalogAtS0Rejections", atS0, [
  ["capability missing", "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_SET_CHANGED", (value) => { value.capabilities.pop(); }],
  ["capabilities swapped", "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_NOT_AT_S0:capabilityRef", (value) => { value.capabilities.reverse(); }],
  ["version changed", "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_NOT_AT_S0:version", (value) => { value.capabilities[0].version = "1.0.1"; }],
  ["status changed", "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_NOT_AT_S0:status", (value) => { value.capabilities[1].status = "suspended"; }],
  ["revision moved", "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_NOT_AT_S0:revision", (value) => { value.capabilities[0].revision += 1; }],
  ["integrity changed", "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_NOT_AT_S0:integrity", (value) => { value.capabilities[1].integrity = artifactOf(newRuntime, "search"); }],
  ["record bytes changed", "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_NOT_AT_S0:registryRecordSha256", (value) => { value.capabilities[0].registryRecordSha256 = "a".repeat(64); }],
  ["grant revision moved", "__PKT_LABEL_UPPER___MAINTENANCE_GRANT_NOT_AT_S0", (value) => { value.grants[0].stateRevision += 1; }],
  ["grant bytes changed", "__PKT_LABEL_UPPER___MAINTENANCE_GRANT_NOT_AT_S0", (value) => { value.grants[0].metadataSha256 = "a".repeat(64); }],
], (value) => verifyCatalogRecordsAtS0(value, frozen));

const preparedSnapshot = snapshotFor(newRuntime, ["search", "pi", "fetch"]);
const preparedAuthorization = readRouteAuthorization(full, preparedConfiguration, preparedSnapshot, runnerDigest, registeredRuntime);
assert.deepEqual(preparedAuthorization.capabilities.map((capability) => capability.capabilityRef), [refOf.search, refOf.pi, refOf.fetch]);
for (const capability of preparedAuthorization.capabilities) {
  for (const key of preUpgradeKeys) assert.equal(capability[key], true, "PREPARED_KEY_UNEXPECTED:" + capability.capabilityRef + ":" + key);
  assert.deepEqual([capability.integrityMatchesSnapshot, capability.declarationInvariantMatchesSnapshot, capability.runtimeRoot], [false, false, newRuntime]);
}
const pending = [];
verifyPreparedCapabilities({ frozen, authorization: structuredClone(preparedAuthorization) });
count("preparedCapabilitiesAccepted");
const preparedIn = (value, ref) => byRef(value.authorization.capabilities, ref);
rejectAll("preparedCapabilitiesRejections", { frozen, authorization: preparedAuthorization }, [
  ["capability not in S0", "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_CAPABILITY_SET_CHANGED", (value) => { preparedIn(value, refOf.pi).capabilityRef = "capability:other"; }],
  ["runtime still previous", "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_RUNTIME_CHANGED", (value) => { preparedIn(value, refOf.pi).runtimeRoot = previousRuntime; }],
  ["fetch runtime still previous", "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_RUNTIME_CHANGED", (value) => { preparedIn(value, refOf.fetch).runtimeRoot = previousRuntime; }],
  ["pi scopes changed", "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_POLICY_CHANGED:scopesMatchSnapshot", (value) => { preparedIn(value, refOf.pi).scopesMatchSnapshot = false; }],
  ["pi secrets changed", "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_POLICY_CHANGED:secretRefsMatchSnapshot", (value) => { preparedIn(value, refOf.pi).secretRefsMatchSnapshot = false; }],
  ["search scopes changed", "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_POLICY_CHANGED:scopesMatchSnapshot", (value) => { preparedIn(value, refOf.search).scopesMatchSnapshot = false; }],
  ["search secrets changed", "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_POLICY_CHANGED:secretRefsMatchSnapshot", (value) => { preparedIn(value, refOf.search).secretRefsMatchSnapshot = false; }],
  ["fetch scopes changed", "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_POLICY_CHANGED:scopesMatchSnapshot", (value) => { preparedIn(value, refOf.fetch).scopesMatchSnapshot = false; }],
  ["fetch declaration changed", "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_POLICY_CHANGED:declarationMatchesSnapshotExceptArtifact", (value) => { preparedIn(value, refOf.fetch).declarationMatchesSnapshotExceptArtifact = false; }],
  ["search operations changed", "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_POLICY_CHANGED:operationsMatchSnapshot", (value) => { preparedIn(value, refOf.search).operationsMatchSnapshot = false; }],
  ["search cost changed", "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_POLICY_CHANGED:costMatchesSnapshot", (value) => { preparedIn(value, refOf.search).costMatchesSnapshot = false; }],
  ["pi permissions changed", "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_POLICY_CHANGED:permissionRefsMatchSnapshot", (value) => { preparedIn(value, refOf.pi).permissionRefsMatchSnapshot = false; }],
  ["pi version changed", "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_POLICY_CHANGED:versionMatchesSnapshot", (value) => { preparedIn(value, refOf.pi).versionMatchesSnapshot = false; }],
  ["runner integrity inconsistent", "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_RUNNER_INTEGRITY_INCONSISTENT", (value) => { preparedIn(value, refOf.pi).integrityMatchesSnapshot = true; }],
], verifyPreparedCapabilities);
verifyPendingCapabilities(structuredClone(pending), frozen);
count("noPendingCapabilitiesAccepted");
rejectAll("pendingCapabilitiesRejections", pending, [
  ["unexpected pending capability", "__PKT_LABEL_UPPER___MAINTENANCE_PENDING_CAPABILITY_SET_CHANGED", (value) => { value.push({ capabilityRef: "capability:other", version: "1.0.0", registered: false }); }],
  ["registered capability reported pending", "__PKT_LABEL_UPPER___MAINTENANCE_PENDING_CAPABILITY_SET_CHANGED", (value) => { value.push({ capabilityRef: refOf.fetch, version: "1.0.0", registered: true }); }],
], (value) => verifyPendingCapabilities(value, frozen));

const unchangedRuntime = `${newPrefix}/lib/himawari-agent-unchanged-runner`;
issuedAt[unchangedRuntime] = issuedAt[newRuntime];
for (const key of keys) runnerSources.set(runnerPath(unchangedRuntime, key), runnerSources.get(runnerPath(previousRuntime, key)));
const unchangedRunnerAuthorization = readRouteAuthorization(full, preparedConfiguration, snapshotFor(unchangedRuntime, ["pi", "search", "fetch"], "2026-10-18T01:00:00.000Z"), runnerDigest, registeredRuntime);
for (const capability of unchangedRunnerAuthorization.capabilities) assert.deepEqual([capability.integrityMatchesSnapshot, capability.declarationInvariantMatchesSnapshot], [true, true], "UNCHANGED_RUNNER_NOT_VISIBLE_BEFORE_UPGRADE");
count("unchangedRunnerVisibleBeforeUpgrade");
const preparedState = { frozen, authorization: preparedAuthorization, pending, snapshotSha256: "3".repeat(64) };
const upgradeOrder = ["search", "pi", "fetch"];
const upgradePlan = { snapshotDigest: `sha256:${"3".repeat(64)}`, planDigest: `sha256:${"4".repeat(64)}`, upgrades: upgradeOrder.map((key) => ({ ref: refOf[key], version: "1.0.0", fromIntegrity: artifactOf(previousRuntime, key), toIntegrity: artifactOf(newRuntime, key), fromRuntimeRoot: previousRuntime, toRuntimeRoot: newRuntime })), registrations: [], current: [] };
assert.equal(verifyUpgradePlan(structuredClone(upgradePlan), preparedState), upgradePlan.planDigest);
const emptyScopeChangesReordered = structuredClone(upgradePlan);
for (const entry of emptyScopeChangesReordered.upgrades) entry.scopeChanges = { expansions: [], contractions: [] };
emptyScopeChangesReordered.upgrades.reverse();
assert.equal(verifyUpgradePlan(emptyScopeChangesReordered, preparedState), upgradePlan.planDigest, "EMPTY_SCOPE_CHANGES_OR_REORDERED_UPGRADES_REJECTED");
count("upgradePlanAccepted");
const upgradeIn = (value, key) => value.upgrades.find((entry) => entry.ref === refOf[key]);
rejectAll("upgradePlanRejections", upgradePlan, [
  ["extra plan field", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_SHAPE_CHANGED", (value) => { value.decisions = []; }],
  ["registrations field missing", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_SHAPE_CHANGED", (value) => { delete value.registrations; }],
  ["snapshot digest without prefix", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_SNAPSHOT_CHANGED", (value) => { value.snapshotDigest = "3".repeat(64); }],
  ["snapshot digest of other snapshot", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_SNAPSHOT_CHANGED", (value) => { value.snapshotDigest = `sha256:${"5".repeat(64)}`; }],
  ["plan digest without prefix", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_DIGEST_INVALID", (value) => { value.planDigest = "4".repeat(64); }],
  ["plan digest upper case", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_DIGEST_INVALID", (value) => { value.planDigest = `sha256:${"A".repeat(64)}`; }],
  ["capability already current", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_CURRENT_UNEXPECTED", (value) => { value.current = [refOf.pi]; }],
  ["upgrade missing", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_SET_CHANGED", (value) => { value.upgrades.pop(); }],
  ["fetch upgrade missing", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_SET_CHANGED", (value) => { value.upgrades = value.upgrades.filter((entry) => entry.ref !== refOf.fetch); }],
  ["extra upgrade", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_SET_CHANGED", (value) => { value.upgrades.push({ ...value.upgrades[0], ref: "capability:other" }); }],
  ["duplicate upgrade", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_SET_CHANGED", (value) => { value.upgrades.push(structuredClone(value.upgrades[1])); }],
  ["from new integrity", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_ENTRY_CHANGED", (value) => { upgradeIn(value, "pi").fromIntegrity = artifactOf(newRuntime, "pi"); }],
  ["to previous integrity", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_ENTRY_CHANGED", (value) => { upgradeIn(value, "pi").toIntegrity = artifactOf(previousRuntime, "pi"); }],
  ["fetch to other runner", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_ENTRY_CHANGED", (value) => { upgradeIn(value, "fetch").toIntegrity = artifactOf(newRuntime, "search"); }],
  ["from new runtime", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_ENTRY_CHANGED", (value) => { upgradeIn(value, "search").fromRuntimeRoot = newRuntime; }],
  ["to previous runtime", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_ENTRY_CHANGED", (value) => { upgradeIn(value, "search").toRuntimeRoot = previousRuntime; }],
  ["from runtime unknown", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_ENTRY_CHANGED", (value) => { upgradeIn(value, "search").fromRuntimeRoot = null; }],
  ["version changed", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_ENTRY_CHANGED", (value) => { upgradeIn(value, "search").version = "1.0.1"; }],
  ["extra entry field", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_ENTRY_CHANGED", (value) => { upgradeIn(value, "search").priorRevision = 1; }],
  ["search scope expansion", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_ENTRY_CHANGED", (value) => { upgradeIn(value, "search").scopeChanges = { expansions: ["network:example.com:443"], contractions: [] }; }],
  ["fetch secret expansion", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_ENTRY_CHANGED", (value) => { upgradeIn(value, "fetch").scopeChanges = { expansions: ["secret:other"], contractions: [] }; }],
  ["fetch contraction", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_ENTRY_CHANGED", (value) => { upgradeIn(value, "fetch").scopeChanges = { expansions: [], contractions: ["network:mcp.exa.ai:443"] }; }],
  ["pi scope expansion", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_ENTRY_CHANGED", (value) => { upgradeIn(value, "pi").scopeChanges = { expansions: ["network:api.deepseek.com:443"], contractions: [] }; }],
  ["unexpected registration", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_REGISTRATIONS_CHANGED", (value) => { value.registrations = [{ ref: "capability:other", version: "1.0.0", integrity: artifactOf(newRuntime, "fetch"), operations: ["web_fetch"], network: [...webNetwork], secrets: ["deepseek-web"] }]; }],
], (value) => verifyUpgradePlan(value, preparedState));
const unchangedRunner = structuredClone(preparedState);
byRef(unchangedRunner.authorization.capabilities, refOf.pi).runnerSha256 = runnerDigest(runnerPath(previousRuntime, "pi"));
const unchangedPlan = structuredClone(upgradePlan);
upgradeIn(unchangedPlan, "pi").toIntegrity = artifactOf(previousRuntime, "pi");
assert.equal(verifyUpgradePlan(unchangedPlan, unchangedRunner), unchangedPlan.planDigest, "UNCHANGED_RUNNER_PLAN_REJECTED");
throwsCode(() => verifyUpgradePlan(structuredClone(unchangedPlan), preparedState), "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_PLAN_ENTRY_CHANGED", "unchanged runner plan against changed snapshot");
count("upgradePlanRejections");

const upgradeResult = { snapshotDigest: upgradePlan.snapshotDigest, planDigest: upgradePlan.planDigest, upgraded: [refOf.search, refOf.pi, refOf.fetch], current: [], registered: [] };
const expectedResult = upgradeResultExpectation({ snapshotDigest: upgradePlan.snapshotDigest, planDigest: upgradePlan.planDigest, frozen });
assert.deepEqual(upgradeResultExpectation(structuredClone(upgradeResult)), expectedResult);
count("upgradeResultAccepted");
rejectAll("upgradeResultRejections", upgradeResult, [
  ["registered field missing", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_RESULT_SHAPE_CHANGED", (value) => { delete value.registered; }],
  ["upgraded field missing", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_RESULT_SHAPE_CHANGED", (value) => { delete value.upgraded; }],
  ["current not a list", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_RESULT_SHAPE_CHANGED", (value) => { value.current = null; }],
  ["registered not a list", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_RESULT_SHAPE_CHANGED", (value) => { value.registered = refOf.fetch; }],
  ["unexpected registration", "UPGRADE_RESULT_CHANGED", (value) => { value.registered.push("capability:other"); }],
  ["upgrade missing", "UPGRADE_RESULT_CHANGED", (value) => { value.upgraded.pop(); }],
  ["fetch registered instead of upgraded", "UPGRADE_RESULT_CHANGED", (value) => { value.upgraded = value.upgraded.filter((ref) => ref !== refOf.fetch); value.registered = [refOf.fetch]; }],
  ["capability left current", "UPGRADE_RESULT_CHANGED", (value) => { value.current = [refOf.pi]; }],
  ["other plan digest", "UPGRADE_RESULT_CHANGED", (value) => { value.planDigest = `sha256:${"6".repeat(64)}`; }],
  ["extra result field", "UPGRADE_RESULT_CHANGED", (value) => { value.decisions = []; }],
], (value) => assert.deepEqual(upgradeResultExpectation(value), expectedResult, "UPGRADE_RESULT_CHANGED"));

const upgradedAt = "2026-10-25T14:00:00.000Z";
const upgradedRecords = Object.fromEntries(registeredKeys.map((key) => {
  const prior = registered[key];
  const manifest = manifestFor(key, newRuntime, "2026-10-18T01:00:00.000Z");
  const qualification = qualificationFor(key, newRuntime, "2026-10-18T01:00:00.000Z");
  return [key, { ...prior, revision: prior.revision + 1, lifecycle: "active", declaration: manifest, pendingDeclaration: null, permissionExpansion: false, runtimeQualification: qualification, pendingUpdateAssessment: null, rollbackDeclaration: prior.declaration, rollbackQualification: prior.runtimeQualification, lastVersionTransition: { fromVersion: prior.declaration.version, toVersion: manifest.version, outcome: "activated", occurredAt: upgradedAt, qualification, externalEffectsRolledBack: false }, updatedAt: upgradedAt }];
}));
withWrites(() => {
  for (const key of upgradeOrder) {
    writeDeclaration(upgradedRecords[key]);
    audit("owner:one", "owner.capability.upgrade", refOf[key], "completed");
  }
});
const currentAfter = (snapshot) => {
  const authorization = readRouteAuthorization(full, preparedConfiguration, snapshot, runnerDigest);
  const records = readCatalogRecords(full, binding, frozen);
  return { frozen, authorization, records: { ...records, capabilities: records.capabilities.map(({ record, ...rest }) => rest) }, strict: catalogStrictView(records.capabilities, snapshot) };
};
const afterUpgrade = currentAfter(preparedSnapshot);
for (const capability of afterUpgrade.authorization.capabilities) for (const key of strictCapabilityKeys) assert.equal(capability[key], true, "UPGRADED_KEY_FALSE:" + capability.capabilityRef + ":" + key);
verifyAuthorizationUsable(afterUpgrade.authorization);
const upgradedSummary = verifyUpgradedCatalog(structuredClone(afterUpgrade), atS0.upgradeAudit);
assert.deepEqual(upgradedSummary.map((entry) => [entry.capabilityRef, entry.revision, entry.storedIntegrity]), [[refOf.pi, 4, artifactOf(newRuntime, "pi")], [refOf.search, 3, artifactOf(newRuntime, "search")], [refOf.fetch, 2, artifactOf(newRuntime, "fetch")]]);
assert.deepEqual(afterUpgrade.records.upgradeAudit, [...auditAtS0, ...upgradeOrder.map((key) => ({ action: "owner.capability.upgrade", targetRef: refOf[key], outcome: "completed" }))]);
count("upgradedAccepted");
const restartedSnapshot = snapshotFor(newRuntime, ["pi", "fetch", "search"], "2026-10-18T03:00:00.000Z");
assert.deepEqual(verifyUpgradedCatalog(currentAfter(restartedSnapshot), atS0.upgradeAudit), upgradedSummary, "RESTART_CHANGED_UPGRADED_CATALOG");
count("restartKeepsStrict");
const reissuedSnapshot = snapshotFor(newRuntime, ["search", "pi", "fetch"], "2026-10-18T03:00:00.000Z");
for (const entry of reissuedSnapshot.capabilities) entry.manifest.reviewedAt = "2026-10-26T00:00:00.000Z";
throwsCode(() => verifyUpgradedCatalog(currentAfter(reissuedSnapshot), atS0.upgradeAudit), "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT", "snapshot reissued after upgrade");
count("upgradedSnapshotRejections");
const requalifiedSnapshot = snapshotFor(newRuntime, ["search", "pi", "fetch"], "2026-10-18T03:00:00.000Z");
for (const entry of requalifiedSnapshot.capabilities) entry.qualification.sandbox.osRelease = "6.8.0-other";
throwsCode(() => verifyUpgradedCatalog(currentAfter(requalifiedSnapshot), atS0.upgradeAudit), "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT", "qualification changed after upgrade");
count("upgradedSnapshotRejections");
const fetchReissuedSnapshot = snapshotFor(newRuntime, ["search", "pi", "fetch"], "2026-10-18T03:00:00.000Z");
fetchReissuedSnapshot.capabilities[2].manifest.reviewedAt = "2026-10-26T00:00:00.000Z";
throwsCode(() => verifyUpgradedCatalog(currentAfter(fetchReissuedSnapshot), atS0.upgradeAudit), "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT", "fetch snapshot reissued after upgrade");
count("upgradedSnapshotRejections");
for (const key of ["search", "fetch"]) {
  withWrites(() => full.prepare("INSERT INTO capability_handles VALUES(?,'active',NULL)").run(refOf[key]));
  throwsCode(() => verifyUpgradedCatalog(currentAfter(preparedSnapshot), atS0.upgradeAudit), "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT", `usable ${key} handle in database`);
  withWrites(() => full.exec("DELETE FROM capability_handles WHERE status='active'"));
  count("upgradedSnapshotRejections");
}
const capabilityIn = (value, ref) => byRef(value.authorization.capabilities, ref);
const lastAuditFor = (value, ref) => value.records.upgradeAudit.findLast((entry) => entry.targetRef === ref);
rejectAll("upgradedRejections", afterUpgrade, [
  ["upgrade not applied", "__PKT_LABEL_UPPER___MAINTENANCE_CAPABILITY_NOT_STRICT:integrityMatchesSnapshot", (value) => { value.authorization = structuredClone(preparedAuthorization); }],
  ["extra capability", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_CAPABILITY_SET_CHANGED", (value) => { value.authorization.capabilities.push({ ...structuredClone(value.authorization.capabilities[0]), capabilityRef: "capability:other" }); }],
  ["fetch missing", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_CAPABILITY_SET_CHANGED", (value) => { value.authorization.capabilities = value.authorization.capabilities.filter((capability) => capability.capabilityRef !== refOf.fetch); }],
  ["runtime still previous", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_RUNTIME_CHANGED", (value) => { capabilityIn(value, refOf.pi).runtimeRoot = previousRuntime; }],
  ["fetch runtime still previous", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_RUNTIME_CHANGED", (value) => { capabilityIn(value, refOf.fetch).runtimeRoot = previousRuntime; }],
  ["version changed", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_IDENTITY_CHANGED:version", (value) => { capabilityIn(value, refOf.search).version = "1.0.1"; }],
  ["host changed", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_IDENTITY_CHANGED:hostId", (value) => { capabilityIn(value, refOf.pi).hostId = "host:other"; }],
  ["worker changed", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_IDENTITY_CHANGED:workerInstanceId", (value) => { capabilityIn(value, refOf.pi).workerInstanceId = "worker:other"; }],
  ["fetch on other worker", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_IDENTITY_CHANGED:workerInstanceId", (value) => { capabilityIn(value, refOf.fetch).workerInstanceId = "worker:other"; }],
  ["fetch not active", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_IDENTITY_CHANGED:status", (value) => { capabilityIn(value, refOf.fetch).status = "suspended"; }],
  ["revision jumped", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_REVISION_CHANGED", (value) => { capabilityIn(value, refOf.search).revision += 1; }],
  ["integrity not the runner", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_INTEGRITY_CHANGED", (value) => { capabilityIn(value, refOf.pi).storedIntegrity = artifactOf(previousRuntime, "pi"); }],
  ["fetch integrity not the runner", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_INTEGRITY_CHANGED", (value) => { capabilityIn(value, refOf.fetch).storedIntegrity = artifactOf(previousRuntime, "fetch"); }],
  ["record unchanged", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_RECORD_UNCHANGED", (value) => { capabilityIn(value, refOf.pi).registryRecordSha256 = frozen.authorization.capabilities[0].registryRecordSha256; }],
  ["record row revision differs", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_RECORD_CHANGED", (value) => { value.records.capabilities[0].revision += 1; }],
  ["record row integrity differs", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_RECORD_CHANGED", (value) => { value.records.capabilities[1].integrity = artifactOf(previousRuntime, "search"); }],
  ["fetch record row differs", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_RECORD_CHANGED", (value) => { value.records.capabilities[2].revision += 1; }],
  ["record row for other capability", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_RECORD_CHANGED", (value) => { value.records.capabilities.reverse(); }],
  ["declaration not active", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT", (value) => { value.strict[0].lifecycle = "pending_review"; }],
  ["pending declaration left", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT", (value) => { value.strict[1].pendingDeclaration = {}; }],
  ["declaration differs from snapshot", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT", (value) => { value.strict[0].declarationEqualsSnapshot = false; }],
  ["qualification differs from snapshot", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT", (value) => { value.strict[1].qualificationEqualsSnapshot = false; }],
  ["transition not activated", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT", (value) => { value.strict[0].transitionOutcome = "rolled_back"; }],
  ["rollback names the new runner", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT", (value) => { value.strict[0].rollbackIntegrity = artifactOf(newRuntime, "pi"); }],
  ["handle left open", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT", (value) => { value.strict[1].unrevokedHandles = 1; }],
  ["strict entry for other capability", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT", (value) => { value.strict.reverse(); }],
  ["fetch declaration pending", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT", (value) => { value.strict[2].pendingDeclaration = {}; }],
  ["fetch without rollback target", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT", (value) => { value.strict[2].rollbackIntegrity = null; }],
  ["fetch transition missing", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT", (value) => { value.strict[2].transitionOutcome = null; }],
  ["fetch handle left open", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_DECLARATION_NOT_STRICT", (value) => { value.strict[2].unrevokedHandles = 1; }],
  ["earlier audit rewritten", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_AUDIT_CHANGED", (value) => { value.records.upgradeAudit[0].outcome = "failed"; }],
  ["upgrade audit missing", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_AUDIT_MISSING", (value) => { value.records.upgradeAudit.pop(); }],
  ["upgrade audit failed", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_AUDIT_MISSING", (value) => { value.records.upgradeAudit.at(-1).outcome = "failed"; }],
  ["upgrade audit repeated", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_AUDIT_MISSING", (value) => { value.records.upgradeAudit.push(structuredClone(value.records.upgradeAudit.at(-1))); }],
  ["search audited as scope upgrade", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_AUDIT_MISSING", (value) => { lastAuditFor(value, refOf.search).action = "owner.capability.scope_upgrade"; }],
  ["pi audited as scope upgrade", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_AUDIT_MISSING", (value) => { lastAuditFor(value, refOf.pi).action = "owner.capability.scope_upgrade"; }],
  ["fetch audited as registration", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_AUDIT_MISSING", (value) => { lastAuditFor(value, refOf.fetch).action = "owner.capability.register"; }],
], (value) => verifyUpgradedCatalog(value, atS0.upgradeAudit));
throwsCode(() => verifyCatalogRecordsAtS0(readCatalogRecords(full, binding, frozen), frozen), "__PKT_LABEL_UPPER___MAINTENANCE_CATALOG_NOT_AT_S0:revision", "upgraded catalog is not the S0 catalog");
withWrites(() => { for (const record of Object.values(registered)) writeDeclaration(record); });
verifyCatalogRecordsAtS0(readCatalogRecords(full, binding, frozen), frozen);
assert.deepEqual(readRouteAuthorization(full, original, previousSnapshot, runnerDigest, registeredRuntime), previousStrict, "RESTORED_CATALOG_NOT_PREVIOUS_STRICT");
count("restoredCatalogAtS0");
full.close();

const firstRefs = [refOf.pi, refOf.search, refOf.fetch];
const firstTime = "2026-10-18T01:00:00.000Z";
const firstDb = new BetterSqlite3(":memory:");
firstDb.exec(`CREATE TABLE product_state_records(key TEXT,owner_id TEXT,agent_id TEXT,revision INTEGER,value_json TEXT);
CREATE TABLE capability_declarations(id TEXT,owner_id TEXT,agent_id TEXT,version TEXT,status TEXT,revision INTEGER,integrity TEXT,record_json TEXT);
CREATE TABLE capability_handles(capability_id TEXT,status TEXT,revoked_at TEXT);
CREATE TABLE audit_records(owner_id TEXT,agent_id TEXT,action TEXT,target_ref TEXT,outcome TEXT);`);
firstDb.prepare("INSERT INTO product_state_records VALUES(?,?,?,?,?)").run(grantKey, "owner:one", "agent:one", 2, JSON.stringify(grantValue));
const firstFrozen = { authorization: { directoryGrants: structuredClone(previousStrict.directoryGrants), capabilities: [] }, workspace: frozenWorkspace };
const firstWorkspace = { path: plan.canonicalPath, device: "1", inode: "9" };
const firstGrants = readGrantsWithoutSnapshot(firstDb, original, firstWorkspace);
assert.deepEqual(firstGrants, previousStrict.directoryGrants, "FIRST_TOOLS_GRANT_READ_DIFFERS_FROM_THE_SNAPSHOT_READ");
assert.deepEqual(verifyExistingGrant(structuredClone(firstGrants), structuredClone(firstFrozen.authorization.directoryGrants), plan), firstGrants[0]);
assert.equal(isFirstTools(firstFrozen, firstRefs), true);
assert.equal(isFirstTools(frozen, firstRefs), false);
assert.equal(isFirstTools(frozen, []), false);
assert.deepEqual(routeIdentity(original, plan), { hostId: "host:one", workerInstanceId: "worker:one" });
count("firstToolsAccepted");
throwsCode(() => isFirstTools(firstFrozen, []), "__PKT_LABEL_UPPER___MAINTENANCE_FIRST_TOOLS_REFS_MISSING", "first tools without new capability references");
throwsCode(() => isFirstTools({ authorization: { directoryGrants: [], capabilities: [] } }, firstRefs), "__PKT_LABEL_UPPER___MAINTENANCE_FIRST_TOOLS_GRANT_MISSING", "first tools without the workspace grant");
count("firstToolsRejections");
for (const [name, code, change] of [
  ["workspace inode changed", "__PKT_LABEL_UPPER___DB_GRANT_ROOT_NOT_BOUND", (value) => { value.workspace.inode = "10"; }],
  ["workspace device changed", "__PKT_LABEL_UPPER___DB_GRANT_ROOT_NOT_BOUND", (value) => { value.workspace.device = "2"; }],
  ["workspace identity missing", "__PKT_LABEL_UPPER___DB_GRANT_ROOT_NOT_BOUND", (value) => { value.workspace = undefined; }],
  ["second grant route", "__PKT_LABEL_UPPER___DB_EXPECTED_ONE_ROW", (value) => { value.configuration.runPolicy.other = { ...structuredClone(value.configuration.runPolicy.coding), grantId: "directory:other" }; }],
  ["grant route removed", "__PKT_LABEL_UPPER___DB_GRANT_ROUTE_SET_CHANGED", (value) => { delete value.configuration.runPolicy.coding; }],
  ["grant row for another owner", "__PKT_LABEL_UPPER___DB_EXPECTED_ONE_ROW", (value) => { value.configuration.ownerId = "owner:other"; }],
]) {
  const value = { configuration: structuredClone(original), workspace: structuredClone(firstWorkspace) };
  change(value);
  throwsCode(() => readGrantsWithoutSnapshot(firstDb, value.configuration, value.workspace), code, "first tools grant: " + name);
  count("firstToolsGrantRejections");
}
firstDb.prepare("UPDATE product_state_records SET value_json=? WHERE key=?").run(JSON.stringify({ ...grantValue, id: "directory:other" }), grantKey);
throwsCode(() => readGrantsWithoutSnapshot(firstDb, original, firstWorkspace), "__PKT_LABEL_UPPER___DB_GRANT_ID_MISMATCH", "first tools grant row of another id");
firstDb.prepare("UPDATE product_state_records SET value_json=? WHERE key=?").run(JSON.stringify(grantValue), grantKey);
for (const [name, change] of [["host", (value) => { value.runPolicy.coding.hostId = undefined; }], ["worker", (value) => { delete value.runPolicy.coding.workerInstanceId; }], ["grant", (value) => { value.runPolicy.coding.grantId = "directory:other"; }], ["route", (value) => { delete value.runPolicy.coding; }]]) {
  const value = structuredClone(original);
  change(value);
  throwsCode(() => routeIdentity(value, plan), "__PKT_LABEL_UPPER___MAINTENANCE_ROUTE_IDENTITY_INVALID", "first tools route identity without " + name);
}
count("firstToolsRejections");

const firstPending = firstRefs.map((ref) => ({ capabilityRef: ref, version: "1.0.0", registered: false, hostId: "host:one", workerInstanceId: "worker:one", runtimeRoot: newRuntime, runnerSha256: "a".repeat(64), actualRunnerSha256: "a".repeat(64), runnerMatchesRecorded: true, snapshotIntegrityMatchesRunner: true, operations: operationsOf[keyOf(ref)], network: networkOf(keyOf(ref)).length ? [...webNetwork] : [...webNetwork], runtimeNetwork: [...webNetwork], secrets: ["deepseek-web"] }));
verifyPendingCapabilities(structuredClone(firstPending), firstFrozen, firstRefs);
count("firstToolsPendingAccepted");
rejectAll("firstToolsPendingRejections", firstPending, [
  ["capability missing", "__PKT_LABEL_UPPER___MAINTENANCE_PENDING_CAPABILITY_SET_CHANGED", (value) => { value.pop(); }],
  ["capability already registered", "__PKT_LABEL_UPPER___MAINTENANCE_NEW_CAPABILITY_ALREADY_REGISTERED", (value) => { value[1].registered = true; }],
  ["version changed", "__PKT_LABEL_UPPER___MAINTENANCE_NEW_CAPABILITY_VERSION_CHANGED", (value) => { value[0].version = "1.0.1"; }],
  ["host differs from the grant", "__PKT_LABEL_UPPER___MAINTENANCE_NEW_CAPABILITY_IDENTITY_CHANGED", (value) => { for (const entry of value) entry.hostId = "host:other"; }],
  ["one capability on another worker", "__PKT_LABEL_UPPER___MAINTENANCE_NEW_CAPABILITY_IDENTITY_CHANGED", (value) => { value[2].workerInstanceId = "worker:other"; }],
  ["runtime still previous", "__PKT_LABEL_UPPER___MAINTENANCE_NEW_CAPABILITY_IDENTITY_CHANGED", (value) => { value[0].runtimeRoot = previousRuntime; }],
  ["runner changed", "__PKT_LABEL_UPPER___MAINTENANCE_NEW_RUNNER_CHANGED", (value) => { value[1].runnerMatchesRecorded = false; }],
  ["scope widened", "__PKT_LABEL_UPPER___MAINTENANCE_NEW_CAPABILITY_SCOPE_CHANGED", (value) => { value[2].network = [...webNetwork, "example.com:443"]; }],
], (value) => verifyPendingCapabilities(value, firstFrozen, firstRefs));
throwsCode(() => verifyPendingCapabilities([], firstFrozen, firstRefs), "__PKT_LABEL_UPPER___MAINTENANCE_PENDING_CAPABILITY_SET_CHANGED", "first tools without pending capabilities");
throwsCode(() => verifyPendingCapabilities(structuredClone(firstPending), { authorization: { directoryGrants: [], capabilities: [] } }, firstRefs), "__PKT_LABEL_UPPER___MAINTENANCE_NEW_CAPABILITY_IDENTITY_CHANGED", "first tools pending without a grant to take the host from");
assert.deepEqual(upgradeResultExpectation({ snapshotDigest: "sha256:" + "1".repeat(64), planDigest: "sha256:" + "2".repeat(64), frozen: firstFrozen }, firstRefs), { snapshotDigest: "sha256:" + "1".repeat(64), planDigest: "sha256:" + "2".repeat(64), upgraded: [], current: [], registered: firstRefs, keys: ["current", "planDigest", "registered", "snapshotDigest", "upgraded"] });
count("firstToolsResultExpectation");

const firstSnapshot = snapshotFor(newRuntime, ["pi", "search", "fetch"], firstTime);
const firstRecord = (key) => ({ ...registered[key], revision: 1, declaration: manifestFor(key, newRuntime, firstTime), runtimeQualification: qualificationFor(key, newRuntime, firstTime), rollbackDeclaration: null, rollbackQualification: null, lastVersionTransition: null, updatedAt: firstTime });
for (const key of keys) {
  const record = firstRecord(key);
  firstDb.prepare("INSERT INTO capability_declarations VALUES(?,?,?,?,?,?,?,?)").run(record.ref, "owner:one", "agent:one", "1.0.0", "active", record.revision, record.declaration.integrity, JSON.stringify(record));
  firstDb.prepare("INSERT INTO audit_records VALUES(?,?,?,?,?)").run("owner:one", "agent:one", "owner.capability.register", record.ref, "completed");
}
const firstCurrent = () => {
  const authorization = readRouteAuthorization(firstDb, preparedConfiguration, firstSnapshot, runnerDigest);
  const records = readCatalogRecords(firstDb, binding, firstFrozen, firstRefs);
  return { frozen: firstFrozen, authorization, records: { ...records, capabilities: records.capabilities.map(({ record, ...rest }) => rest) }, strict: catalogStrictView(records.capabilities, firstSnapshot), routeIdentity: { hostId: "host:one", workerInstanceId: "worker:one" } };
};
const firstAfter = firstCurrent();
assert.deepEqual(firstAfter.authorization.directoryGrants, firstFrozen.authorization.directoryGrants, "FIRST_TOOLS_GRANT_CHANGED_BY_REGISTRATION");
verifyAuthorizationUsable(firstAfter.authorization);
const firstSummary = verifyUpgradedCatalog(structuredClone(firstAfter), [], firstRefs);
assert.deepEqual(firstSummary.map((entry) => [entry.capabilityRef, entry.revision, entry.storedIntegrity]), [[refOf.pi, 1, artifactOf(newRuntime, "pi")], [refOf.search, 1, artifactOf(newRuntime, "search")], [refOf.fetch, 1, artifactOf(newRuntime, "fetch")]]);
assert.deepEqual(firstAfter.records.upgradeAudit.map((entry) => entry.action), ["owner.capability.register", "owner.capability.register", "owner.capability.register"]);
count("firstToolsRegisteredAccepted");
const firstIn = (value, ref) => byRef(value.authorization.capabilities, ref);
rejectAll("firstToolsRegisteredRejections", firstAfter, [
  ["capability missing", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_CAPABILITY_SET_CHANGED", (value) => { value.authorization.capabilities = value.authorization.capabilities.filter((capability) => capability.capabilityRef !== refOf.fetch); }],
  ["extra capability", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADED_CAPABILITY_SET_CHANGED", (value) => { value.authorization.capabilities.push({ ...structuredClone(value.authorization.capabilities[0]), capabilityRef: "capability:other" }); }],
  ["runtime still previous", "__PKT_LABEL_UPPER___MAINTENANCE_REGISTERED_IDENTITY_CHANGED", (value) => { firstIn(value, refOf.pi).runtimeRoot = previousRuntime; }],
  ["host differs from the route", "__PKT_LABEL_UPPER___MAINTENANCE_REGISTERED_IDENTITY_CHANGED", (value) => { firstIn(value, refOf.search).hostId = "host:other"; }],
  ["worker differs from the route", "__PKT_LABEL_UPPER___MAINTENANCE_REGISTERED_IDENTITY_CHANGED", (value) => { firstIn(value, refOf.fetch).workerInstanceId = "worker:other"; }],
  ["no route identity to compare with", "__PKT_LABEL_UPPER___MAINTENANCE_REGISTERED_IDENTITY_CHANGED", (value) => { delete value.routeIdentity; }],
  ["not active", "__PKT_LABEL_UPPER___MAINTENANCE_REGISTERED_IDENTITY_CHANGED", (value) => { firstIn(value, refOf.search).status = "suspended"; }],
  ["version changed", "__PKT_LABEL_UPPER___MAINTENANCE_REGISTERED_IDENTITY_CHANGED", (value) => { firstIn(value, refOf.pi).version = "1.0.1"; }],
  ["integrity not the runner", "__PKT_LABEL_UPPER___MAINTENANCE_REGISTERED_INTEGRITY_CHANGED", (value) => { firstIn(value, refOf.fetch).storedIntegrity = artifactOf(previousRuntime, "fetch"); }],
  ["record row differs", "__PKT_LABEL_UPPER___MAINTENANCE_REGISTERED_RECORD_CHANGED", (value) => { value.records.capabilities[0].revision += 1; }],
  ["registered twice", "__PKT_LABEL_UPPER___MAINTENANCE_REGISTERED_DECLARATION_NOT_STRICT", (value) => { firstIn(value, refOf.pi).revision = 2; value.records.capabilities[0].revision = 2; }],
  ["declaration pending", "__PKT_LABEL_UPPER___MAINTENANCE_REGISTERED_DECLARATION_NOT_STRICT", (value) => { value.strict[1].pendingDeclaration = {}; }],
  ["rollback target present", "__PKT_LABEL_UPPER___MAINTENANCE_REGISTERED_DECLARATION_NOT_STRICT", (value) => { value.strict[2].rollbackIntegrity = artifactOf(previousRuntime, "fetch"); }],
  ["handle left open", "__PKT_LABEL_UPPER___MAINTENANCE_REGISTERED_DECLARATION_NOT_STRICT", (value) => { value.strict[0].unrevokedHandles = 1; }],
  ["registered as upgrade", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_AUDIT_MISSING", (value) => { value.records.upgradeAudit[1].action = "owner.capability.upgrade"; }],
  ["registration audit missing", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_AUDIT_MISSING", (value) => { value.records.upgradeAudit.pop(); }],
  ["registration audit failed", "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_AUDIT_MISSING", (value) => { value.records.upgradeAudit[2].outcome = "failed"; }],
], (value) => verifyUpgradedCatalog(value, [], firstRefs));
firstDb.close();
count("firstToolsRegisteredRejections");

const samplerRoot = mkdtempSync(path.join(process.env.HIMAWARI_TEST_TEMP_ROOT, "maintenance-fixture-"));
let samplerReadback;
try {
  mkdirSync(path.join(samplerRoot, "data"), { mode: 0o700 });
  mkdirSync(path.join(samplerRoot, "recovery-points"), { mode: 0o700 });
  const temporary = path.join(samplerRoot, "recovery-points", ".fixture-backup.verify-owned");
  mkdirSync(temporary, { mode: 0o700 });
  writeFileSync(path.join(temporary, "product.sqlite.plaintext.tmp"), "FICTITIOUS_PLAINTEXT_FIXTURE".repeat(1000), { mode: 0o600 });
  const sampler = new Worker(new URL("./maintenance-space-sampler.mjs", import.meta.url), { workerData: { stateRoot: samplerRoot, backupId: "fixture-backup" }, execArgv: [] });
  await new Promise((resolve, reject) => {
    sampler.on("error", reject);
    sampler.on("message", (message) => {
      if (message.kind === "ready") sampler.postMessage({ kind: "stop" });
      if (message.kind === "result") samplerReadback = message.result;
    });
    sampler.on("exit", (code) => code === 0 ? resolve() : reject(new Error("FIXTURE_SAMPLER_EXIT_FAILED")));
  });
  assert.deepEqual(samplerReadback.errors, []);
  assert(samplerReadback.samples >= 2);
  assert.equal(samplerReadback.temporaryPeakBytes, "FICTITIOUS_PLAINTEXT_FIXTURE".length * 1000);
  assert(samplerReadback.temporaryPeakAllocatedBytes >= samplerReadback.temporaryPeakBytes);
  assert(samplerReadback.minimumRootAvailableBytes > 0);
  assert(samplerReadback.observedTemporaryPaths.includes(temporary));
} finally {
  rmSync(samplerRoot, { recursive: true });
}
assert.deepEqual(spaceSamplingWarnings(false, { errors: [] }), []);
assert.deepEqual(spaceSamplingWarnings(false, { errors: [{ code: "EACCES", stage: "temporary-tree" }] }), [{ code: "EACCES", stage: "temporary-tree" }]);
assert.deepEqual(spaceSamplingWarnings(true, undefined), [{ code: "SAMPLER_EXIT_FAILED", stage: "worker" }, { code: "SAMPLER_RESULT_MISSING", stage: "worker" }]);
assert(!/SPACE_SAMPLING_FAILED|SPACE_SAMPLER_NOT_READY/.test(maintenanceCli.toString()), "SPACE_SAMPLING_MUST_STAY_A_WARNING");
count("spaceSamplingWarningsNotFatal");
process.stdout.write(JSON.stringify({ passed: true, scope: "__PKT_LABEL__ configuration stages (original, static root moved to the __PKT_LABEL__ release, prepared snapshot), handles counted only while usable (status active), startup authority, real-sqlite S0 gate and stopped-service history digests, previous strict catalog shape, existing workspace grant and directory identity, catalog at S0, prepared capabilities with no pending registration, reviewed plain upgrade plan for all three capabilities without scope changes or registration, upgrade result, upgraded catalog before and after a restart snapshot, restored catalog, space sampler", fixtureSource: fileURLToPath(import.meta.url), counts, samplerReadback, doesNotProveProductionState: true }) + "\n");
