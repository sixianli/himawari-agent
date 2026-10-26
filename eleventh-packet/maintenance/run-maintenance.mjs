import assert from "node:assert/strict";
import { readFileSync, writeFileSync, renameSync, lstatSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { pathToFileURL } from "node:url";
import {
  loadBinding, retainedJson, jsonFile, requireStopped, requireStateUnlocked,
  persistence, cli, readMaintenanceState, verifyHistoryUnchanged, diskSpace, openRecoveryReadonly,
  openLenientReadonly, openImmutableReadonly, openReadWriteDatabase, collectTidyState, tidyDatabaseSidecars, postUpgradeState,
  recoveryIdForSchema,
  readRollbackApproval, requireFreshInspection,
  readPreUpgradeAuthorization, readCatalogState, runPrepare, verifyUpgradePlan, verifyUpgradedCatalog, verifyCatalogRecordsAtS0, readCatalogResume,
  readPostSwitchAuthorization, readRestoredCatalog, evidenceRoot, oldPrefix, newPrefix, operations, sha,
  currentConfigurationStage, readOriginalConfiguration, staticRootConfigurationBytes, staticRootConfigurationSha256, newStaticRoot, verifyPendingCapabilities, verifyPreparedCapabilities, upgradeResultExpectation,
  approvedModelRef, approvedModelLimits, approvedPublicFetch, verifyHistoryAgainstRecoveryPoint,
  migrateDatabaseTo56, readMigrationContent, describeMigrationSnapshot, migrationFromSchema, migrationToSchema,
} from "./maintenance-common.mjs";
import { fixed } from "../s0-db/read-s0-db.mjs";
import { createRawRecoveryPoint, verifyRawRecoveryPoint, restoreRawRecoveryPoint, recoveryMethod } from "./raw-copy-recovery.mjs";

const actions = new Set(["S3_COPY51", "S7_DB_STATUS", "S7_CONFIG_APPLY", "S7_CATALOG_UPGRADE", "S8_READBACK", "S9_SIDECAR_TIDY", "S9_RAW_RESTORE51"]);

function requireSchemaGate(state, schema) {
  assert.equal(state.schema.current, schema, "ELEVENTH_MAINTENANCE_EXPECTED" + schema);
  assert.equal(state.gate.unresolvedReservedCount, 0, "ELEVENTH_MAINTENANCE_GATE_UNRESOLVED");
  assert.equal(state.gate.nonTerminalRunCount, 0, "ELEVENTH_MAINTENANCE_NON_TERMINAL_RUNS");
}

function requireStepBinding(report, action, code) {
  assert(typeof report.bindingSha256 === "string" && /^[0-9a-f]{64}$/.test(report.bindingSha256), code + ":" + action);
  assert.equal(report.bindingSha256, sha(readFileSync(`${operations}/inputs/bindings.json`)), code + ":" + action);
}

function requirePassedStep(action) {
  const report = jsonFile(`${evidenceRoot}/${action.toLowerCase()}-result.json`);
  assert(report.passed === true && report.action === action, "ELEVENTH_MAINTENANCE_PREVIOUS_STEP_NOT_VERIFIED:" + action);
  requireStepBinding(report, action, "ELEVENTH_MAINTENANCE_PREVIOUS_STEP_BINDING_CHANGED");
  return report;
}

async function recoveryOptions(binding, prefix, schema, recoveryId, ledger) {
  assert.equal(binding.maintenance.recoveryMethod, recoveryMethod, "ELEVENTH_MAINTENANCE_RECOVERY_METHOD_CHANGED");
  const { acquireStateRootLock } = await persistence(prefix);
  return { stateRoot: binding.paths.stateRoot, evidenceRoot, recoveryId, schema, identity: binding.identity, expectedLedger: ledger, openReadonly: (filename) => openRecoveryReadonly(prefix, filename), acquireStateRootLock, requireStopped };
}

async function copyRecovery(binding, prefix, schema, id, state) {
  const beforeSpace = diskSpace();
  const result = await createRawRecoveryPoint(await recoveryOptions(binding, prefix, schema, id, state.ledger));
  return { ...result, spaceBefore: beforeSpace, spaceAfter: diskSpace() };
}

async function verifyRetainedRecovery(binding, expectedDigest) {
  const id = recoveryIdForSchema(binding, 55);
  const report = jsonFile(`${evidenceRoot}/s3_copy51-result.json`);
  assert(report.passed === true && report.action === "S3_COPY51", "ELEVENTH_MAINTENANCE_RECOVERY_POINT_NOT_VERIFIED");
  requireStepBinding(report, "S3_COPY51", "ELEVENTH_MAINTENANCE_RECOVERY_BINDING_CHANGED");
  assert(report.recovery?.method === recoveryMethod && report.recovery.recoveryId === id, "ELEVENTH_MAINTENANCE_RECOVERY_POINT_CHANGED");
  const reference = jsonFile(`${evidenceRoot}/s3-copy-after55.json`);
  const proof = await verifyRawRecoveryPoint({ ...await recoveryOptions(binding, oldPrefix, 55, id, reference.ledger), expectedDigest: expectedDigest ?? report.recovery.digest });
  assert.equal(proof.digest, report.recovery.digest, "ELEVENTH_MAINTENANCE_RECOVERY_DIGEST_CHANGED");
  return { proof, reference };
}

async function applyStaticRootConfiguration(binding) {
  requireStopped();
  const configPath = binding.paths.config;
  const nextPath = `${configPath}.next`;
  assert.equal(sha(readFileSync(configPath)), binding.service.oldConfigSha256, "ELEVENTH_MAINTENANCE_ORIGINAL_CONFIG_REQUIRED");
  assert.throws(() => lstatSync(nextPath), { code: "ENOENT" }, "ELEVENTH_MAINTENANCE_CONFIG_NEXT_PRESENT");
  const index = lstatSync(`${newStaticRoot}/index.html`);
  assert(index.isFile() && !index.isSymbolicLink(), "ELEVENTH_MAINTENANCE_NEW_STATIC_ROOT_INDEX_MISSING");
  const bytes = staticRootConfigurationBytes(readOriginalConfiguration(binding));
  assert.equal(sha(bytes), staticRootConfigurationSha256(binding), "ELEVENTH_MAINTENANCE_STATIC_ROOT_CONFIG_BYTES_CHANGED");
  writeFileSync(nextPath, bytes, { flag: "wx", mode: 0o600 });
  try {
    const nextInfo = lstatSync(nextPath);
    assert(nextInfo.isFile() && nextInfo.uid === process.getuid() && (nextInfo.mode & 0o777) === 0o600 && sha(readFileSync(nextPath)) === sha(bytes), "ELEVENTH_MAINTENANCE_CONFIG_NEXT_READBACK_FAILED");
    const platform = await import(pathToFileURL(`${newPrefix}/lib/himawari-agent/node_modules/@himawari-agent/platform-node/dist/index.js`).href);
    const loaded = await new platform.JsonFileConfigurationPort(nextPath).load();
    assert.equal(loaded.http?.staticRoot, newStaticRoot, "ELEVENTH_MAINTENANCE_NEW_RUNTIME_REJECTED_STATIC_ROOT");
    const model = loaded.modelDescriptors?.find((entry) => entry.ref === approvedModelRef);
    assert(model && model.contextWindow === approvedModelLimits.contextWindow && model.maxTokens === approvedModelLimits.maxTokens, "ELEVENTH_MAINTENANCE_NEW_RUNTIME_REJECTED_MODEL_LIMITS");
    assert(!Object.hasOwn(loaded, "budgets") && loaded.runPolicy?.publicFetch?.maximumBytes === approvedPublicFetch.to, "ELEVENTH_MAINTENANCE_NEW_RUNTIME_REJECTED_PUBLIC_FETCH");
  } catch (error) {
    rmSync(nextPath, { force: true });
    throw error;
  }
  requireStopped();
  renameSync(nextPath, configPath);
  const info = lstatSync(configPath);
  assert(info.isFile() && info.uid === process.getuid() && (info.mode & 0o777) === 0o600 && sha(readFileSync(configPath)) === sha(bytes), "ELEVENTH_MAINTENANCE_CONFIG_READBACK_FAILED");
  assert.equal(currentConfigurationStage(binding), "static-root", "ELEVENTH_MAINTENANCE_CONFIG_STAGE_CHANGED");
  return { path: configPath, beforeSha256: binding.service.oldConfigSha256, afterSha256: sha(bytes), bytes: bytes.length };
}

async function main(action) {
  const binding = loadBinding(!action.startsWith("S9_") && action !== "S7_CATALOG_UPGRADE");
  const report = { schemaVersion: "himawari.eleventh-change-maintenance.v1", action, startedAt: new Date().toISOString(), actor: { uid: process.getuid(), account: "himawari-prod", hostname: hostname() }, bindingSha256: sha(readFileSync("/opt/himawari/operations/eleventh-20261026/inputs/bindings.json")), passed: false };
  retainedJson(`${action.toLowerCase()}-started.json`, report);
  try {
    if (!["S8_READBACK", "S9_SIDECAR_TIDY"].includes(action)) await requireStateUnlocked(["S3_COPY51", "S9_RAW_RESTORE51"].includes(action) ? oldPrefix : newPrefix);
    if (action === "S3_COPY51") {
      const before = await readMaintenanceState(binding, oldPrefix);
      requireSchemaGate(before, migrationFromSchema);
      report.before = retainedJson("s3-copy-before55.json", before);
      report.recovery = await copyRecovery(binding, oldPrefix, 55, recoveryIdForSchema(binding, 55), before);
      const after = await readMaintenanceState(binding, oldPrefix);
      verifyHistoryUnchanged(before, after);
      report.after = retainedJson("s3-copy-after55.json", after);
    } else if (action === "S7_DB_STATUS") {
      requirePassedStep("S3_COPY51");
      const state = await readMaintenanceState(binding, newPrefix);
      requireSchemaGate(state, migrationFromSchema);
      verifyHistoryUnchanged(jsonFile(`${evidenceRoot}/s3-copy-after55.json`), state);
      const authorization = readPreUpgradeAuthorization(binding);
      report.authorization = retainedJson("s7-preupgrade-authorization.json", authorization);
      report.authorizationVerification = { passed: true, configurationSha256: authorization.configurationSha256, authorizationSha256: report.authorization.sha256, checkedAt: authorization.checkedAt };
      report.state = retainedJson("s7-preswitch-state.json", state);
    } else if (action === "S7_CONFIG_APPLY") {
      requirePassedStep("S7_DB_STATUS");
      const state = await readMaintenanceState(binding, newPrefix);
      requireSchemaGate(state, migrationFromSchema);
      const preswitch = jsonFile(`${evidenceRoot}/s7-preswitch-state.json`);
      verifyHistoryUnchanged(preswitch, state);
      report.configuration = retainedJson("s7-config-apply.json", await applyStaticRootConfiguration(binding));
      const authorization = readPreUpgradeAuthorization(binding);
      assert.equal(authorization.configurationSha256, staticRootConfigurationSha256(binding), "ELEVENTH_MAINTENANCE_STATIC_ROOT_CONFIG_BYTES_CHANGED");
      report.authorization = retainedJson("s7-static-root-authorization.json", authorization);
      const migration = await migrateDatabaseTo56({
        requireStopped,
        collectContent: () => readMigrationContent(newPrefix),
        runMigrate: () => cli(newPrefix, ["db", "migrate", "--config", binding.paths.config, "--confirm", "APPLY_MIGRATIONS"], "s7-migrate56"),
        describeSnapshot: describeMigrationSnapshot,
      });
      verifyHistoryUnchanged(preswitch, migration.after);
      report.migrationBefore = retainedJson("s7-migrate-before55.json", migration.before);
      report.migrate = migration.migrate.retained;
      report.migrationSnapshot = migration.snapshot;
      report.migrationTransition = migration.transition;
      report.migrationAfter = retainedJson("s7-migrate-after56.json", migration.after);
      const migrated = await readMaintenanceState(binding, newPrefix);
      requireSchemaGate(migrated, migrationToSchema);
      verifyHistoryUnchanged(preswitch, migrated);
      report.after = retainedJson("s7-config-apply-after56.json", migrated);
    } else if (action === "S7_CATALOG_UPGRADE" && currentConfigurationStage(binding) === "prepared") {
      requirePassedStep("S7_CONFIG_APPLY");
      report.recovery55Readback = (await verifyRetainedRecovery(binding)).proof;
      const resumed = readCatalogResume(binding);
      report.resume = resumed.approval;
      Object.assign(report, resumed.retained);
      const after = await readMaintenanceState(binding, newPrefix);
      requireSchemaGate(after, migrationToSchema);
      verifyHistoryUnchanged(jsonFile(`${evidenceRoot}/s7-preswitch-state.json`), after);
      const upgradedState = readCatalogState(binding, { prepared: true, upgraded: true });
      assert.equal(upgradedState.snapshotSha256, resumed.snapshotSha256, "ELEVENTH_MAINTENANCE_PREPARED_SNAPSHOT_CHANGED");
      const planDigest = verifyUpgradePlan(resumed.plan, { frozen: upgradedState.frozen, snapshotSha256: resumed.snapshotSha256, authorization: upgradedState.authorization });
      assert.deepEqual(upgradeResultExpectation(resumed.upgrade), upgradeResultExpectation({ snapshotDigest: resumed.plan.snapshotDigest, planDigest, frozen: upgradedState.frozen }), "ELEVENTH_MAINTENANCE_UPGRADE_RESULT_CHANGED");
      const upgraded = verifyUpgradedCatalog(upgradedState, resumed.original.records.upgradeAudit);
      report.catalogAfter = retainedJson("s7-catalog-after.json", { authorization: upgradedState.authorization, records: upgradedState.records, strict: upgradedState.strict, workspace: upgradedState.workspace });
      report.catalog = { preparedConfigurationSha256: upgradedState.configurationSha256, snapshotSha256: resumed.snapshotSha256, planDigest, upgraded, upgradeAuditBefore: resumed.original.records.upgradeAudit, upgradeAudit: upgradedState.records.upgradeAudit };
      report.after = retainedJson("s7-catalog-after56.json", after);
      report.postUpgradeState = retainedJson("s7-post-upgrade-state.json", postUpgradeState(binding, after));
    } else if (action === "S7_CATALOG_UPGRADE") {
      requirePassedStep("S7_CONFIG_APPLY");
      report.recovery55Readback = (await verifyRetainedRecovery(binding)).proof;
      const before = await readMaintenanceState(binding, newPrefix);
      requireSchemaGate(before, migrationToSchema);
      verifyHistoryUnchanged(jsonFile(`${evidenceRoot}/s7-preswitch-state.json`), before);
      const original = readPreUpgradeAuthorization(binding);
      report.catalogBefore = retainedJson("s7-catalog-before.json", original);
      const prepared = runPrepare(binding);
      report.prepare = prepared.retained;
      loadBinding(false);
      const afterPrepare = readCatalogState(binding, { prepared: true });
      assert.equal(afterPrepare.configurationSha256, prepared.configurationSha256, "ELEVENTH_MAINTENANCE_PREPARED_CONFIG_CHANGED");
      assert.equal(afterPrepare.snapshotSha256, prepared.snapshotSha256, "ELEVENTH_MAINTENANCE_PREPARED_SNAPSHOT_CHANGED");
      verifyCatalogRecordsAtS0(afterPrepare.records, afterPrepare.frozen);
      assert.deepEqual(afterPrepare.records.upgradeAudit, original.records.upgradeAudit, "ELEVENTH_MAINTENANCE_UPGRADE_AUDIT_CHANGED");
      verifyPreparedCapabilities(afterPrepare);
      verifyPendingCapabilities(afterPrepare.pending, afterPrepare.frozen);
      const planned = await cli(newPrefix, ["capabilities", "upgrade-plan", "--config", binding.paths.config, "--reviewed"], "s7-catalog-plan");
      report.plan = planned.retained;
      const planDigest = verifyUpgradePlan(planned.result, afterPrepare);
      const applied = await cli(newPrefix, ["capabilities", "upgrade", "--config", binding.paths.config, "--confirm", planDigest, "--reviewed"], "s7-catalog-upgrade");
      report.upgrade = applied.retained;
      assert.deepEqual(upgradeResultExpectation(applied.result), upgradeResultExpectation({ snapshotDigest: planned.result.snapshotDigest, planDigest, frozen: afterPrepare.frozen }), "ELEVENTH_MAINTENANCE_UPGRADE_RESULT_CHANGED");
      const after = await readMaintenanceState(binding, newPrefix);
      verifyHistoryUnchanged(before, after);
      const upgradedState = readCatalogState(binding, { prepared: true, upgraded: true });
      assert.equal(upgradedState.configurationSha256, prepared.configurationSha256, "ELEVENTH_MAINTENANCE_PREPARED_CONFIG_CHANGED");
      const upgraded = verifyUpgradedCatalog(upgradedState, original.records.upgradeAudit);
      report.catalogAfter = retainedJson("s7-catalog-after.json", { authorization: upgradedState.authorization, records: upgradedState.records, strict: upgradedState.strict, workspace: upgradedState.workspace });
      report.catalog = { preparedConfigurationSha256: prepared.configurationSha256, snapshotSha256: prepared.snapshotSha256, planDigest, upgraded, upgradeAuditBefore: original.records.upgradeAudit, upgradeAudit: upgradedState.records.upgradeAudit };
      report.after = retainedJson("s7-catalog-after56.json", after);
      report.postUpgradeState = retainedJson("s7-post-upgrade-state.json", postUpgradeState(binding, after));
    } else if (action === "S8_READBACK") {
      requirePassedStep("S7_CATALOG_UPGRADE");
      verifyHistoryUnchanged(jsonFile(`${evidenceRoot}/s3-copy-after55.json`), jsonFile(`${evidenceRoot}/s7-catalog-after56.json`));
      const after = await readMaintenanceState(binding, newPrefix, true);
      requireSchemaGate(after, migrationToSchema);
      report.state = retainedJson("s8-database-readback.json", after);
      report.authorization = retainedJson("s8-current-authorization.json", readPostSwitchAuthorization(binding));
      report.recoveryPoints = { schema55: (await verifyRetainedRecovery(binding)).proof };
      report.history = retainedJson("s8-history-preserved.json", verifyHistoryAgainstRecoveryPoint(binding));
      report.scope = "rows-present-at-s3-unchanged-new-rows-allowed-startup-recovery-column-allowed-upgraded-capability-catalog-existing-workspace-grant-and-raw-recovery-point-not-paid-chat-acceptance";
    } else if (action === "S9_SIDECAR_TIDY") {
      const approval = readRollbackApproval(binding, "S9_RAW_RESTORE51");
      report.approvalSha256 = approval.sha256;
      report.approvalRef = approval.approval.approvalRef;
      const tidy = tidyDatabaseSidecars({
        database: fixed.database,
        owner: fixed.uid,
        requireStopped,
        requireRollbackApproval: () => approval,
        requireFreshInspection: () => requireFreshInspection(),
        openLenient: (filename) => openLenientReadonly(filename, fixed.uid),
        openImmutable: (filename) => openImmutableReadonly(filename, fixed.uid),
        openStrict: (filename) => openRecoveryReadonly(newPrefix, filename, fixed.uid),
        openReadWrite: (filename) => openReadWriteDatabase(filename, fixed.uid),
        collectState: collectTidyState,
      });
      report.inspection = tidy.inspection;
      report.noSidecars = tidy.noSidecars;
      report.readVia = tidy.readVia;
      report.journalMode = tidy.journalMode;
      report.checkpointBusy = tidy.checkpointBusy;
      report.sidecarsBefore = tidy.sidecarsBefore;
      report.sidecarsBeforeWrite = tidy.sidecarsBeforeWrite;
      report.sidecarsAfter = tidy.sidecarsAfter;
      report.before = retainedJson("s9_sidecar_tidy-before.json", tidy.before);
      report.tidy = retainedJson("s9_sidecar_tidy-tidy.json", { readVia: tidy.readVia, noSidecars: tidy.noSidecars, journalMode: tidy.journalMode, checkpoint: tidy.checkpoint, checkpointBusy: tidy.checkpointBusy, sidecarsBefore: tidy.sidecarsBefore, sidecarsBeforeWrite: tidy.sidecarsBeforeWrite, sidecarsAfter: tidy.sidecarsAfter, comparedSections: tidy.comparedSections });
      report.after = retainedJson("s9_sidecar_tidy-after.json", tidy.after);
      report.state = retainedJson("s9_sidecar_tidy-state.json", await readMaintenanceState(binding, newPrefix, "rollback-current"));
      report.scope = "rollback-approval-and-fresh-s2-inspection-required-no-state-lock-no-manual-deletion-wal-checkpoint-truncate-then-content-readback";
    } else {
      const id = recoveryIdForSchema(binding, 55);
      const approvalRecord = readRollbackApproval(binding);
      const approval = approvalRecord.approval;
      report.approvalSha256 = approvalRecord.sha256;
      report.approvalRef = approval.approvalRef;
      const current = await readMaintenanceState(binding, newPrefix, "rollback-current");
      assert([migrationFromSchema, migrationToSchema].includes(current.schema.current), "ELEVENTH_MAINTENANCE_ROLLBACK_CURRENT_SCHEMA_REQUIRED");
      report.before = retainedJson(`${action.toLowerCase()}-before.json`, current);
      const retained = await verifyRetainedRecovery(binding, approval.recoveryDigest);
      report.verify = retained.proof;
      const options = await recoveryOptions(binding, oldPrefix, 55, id, retained.reference.ledger);
      const restored = await restoreRawRecoveryPoint({ ...options, expectedDigest: approval.recoveryDigest, preservedRecoveryId: approval.preservedCurrentRecoveryId, currentLedger: current.ledger, currentSchema: current.schema.current, currentOpenReadonly: (filename) => openRecoveryReadonly(newPrefix, filename) });
      Object.assign(report, restored);
      const state = await readMaintenanceState(binding, oldPrefix);
      assert.equal(state.schema.current, 55, "ELEVENTH_MAINTENANCE_RESTORED_SCHEMA_MISMATCH");
      const reference = retained.reference;
      verifyHistoryUnchanged(reference, state);
      assert.deepEqual(state.gate, reference.gate, "ELEVENTH_MAINTENANCE_RESTORED_GATE_CHANGED");
      report.after = retainedJson(`${action.toLowerCase()}-after.json`, state);
      report.catalog = readRestoredCatalog(binding);
      report.accountRecoveryRequired = true;
      report.serviceStartAuthorized = false;
      const authorityPath = `${binding.paths.stateRoot}/authority.json`;
      const authorityMirror = jsonFile(authorityPath);
      const authorityDatabase = openRecoveryReadonly(oldPrefix);
      try {
        const deployment = authorityDatabase.prepare("SELECT id,owner_id AS ownerId,agent_id AS agentId,revision,status,authority_epoch AS authorityEpoch,fencing_token AS fencingToken,transfer_id AS transferId FROM deployments WHERE id=?").get(binding.identity.deploymentId);
        report.authorityMirrorCompatibility = { path: authorityPath, sha256: sha(readFileSync(authorityPath)), compatible: Boolean(deployment && ["id", "ownerId", "agentId", "revision", "status", "authorityEpoch", "fencingToken", "transferId"].every((key) => authorityMirror[key] === deployment[key])), modified: false };
        assert.equal(report.authorityMirrorCompatibility.compatible, true, "ELEVENTH_MAINTENANCE_RESTORED_AUTHORITY_MIRROR_INCOMPATIBLE");
      } finally { authorityDatabase.close(); }
    }
    if (action !== "S8_READBACK") requireStopped();
    report.passed = true;
    report.finishedAt = new Date().toISOString();
    const retained = retainedJson(`${action.toLowerCase()}-result.json`, report);
    process.stdout.write(JSON.stringify({ passed: true, action, evidence: retained, productionPaidChatVerified: false }) + "\n");
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    if (error?.rawRecovery) report.partialRecovery = error.rawRecovery;
    if (error?.maintenanceDetail) report.maintenanceDetail = error.maintenanceDetail;
    report.accountRecoveryRequired = action.startsWith("S9_") ? true : report.accountRecoveryRequired;
    report.serviceStartAuthorized = false;
    report.failureCode = "ELEVENTH_DEPLOY_MAINTENANCE_STOPPED";
    const firstLine = error instanceof Error ? error.message.split("\n")[0] : "";
    report.failedCondition = /^[A-Z0-9_]+(:[A-Za-z0-9._-]+)?$/.test(firstLine) ? firstLine : "ELEVENTH_DEPLOY_MAINTENANCE_UNEXPECTED_FAILURE";
    const retained = retainedJson(`${action.toLowerCase()}-failure.json`, report);
    process.stdout.write(JSON.stringify({ passed: false, action, failureCode: report.failureCode, evidence: retained }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.length !== 3 || !actions.has(process.argv[2])) {
    process.stderr.write("ELEVENTH_MAINTENANCE_ARGUMENT_INVALID\n");
    process.exitCode = 1;
  } else {
    try {
      await main(process.argv[2]);
    } catch {
      process.stderr.write("ELEVENTH_MAINTENANCE_PRECHECK_FAILED\n");
      process.exitCode = 1;
    }
  }
}
