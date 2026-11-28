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
  approvedModelRef, approvedModelLimits, approvedPublicFetchBytes, approvedEmbeddingDescriptor, approvedSpeech, currentSchema, targetSchema,
  migrateDatabase, readMigrationContent, describeMigrationSnapshot,
} from "./maintenance-common.mjs";
import { fixed } from "../s0-db/read-s0-db.mjs";
import { createRawRecoveryPoint, verifyRawRecoveryPoint, restoreRawRecoveryPoint, recoveryMethod } from "./raw-copy-recovery.mjs";

const actions = new Set(["S3_COPY51", "S7_DB_STATUS", "S7_CONFIG_APPLY", "S7_CATALOG_UPGRADE", "S8_READBACK", "S9_SIDECAR_TIDY", "S9_RAW_RESTORE51"]);
const afterStop = new Set(["S7_DB_STATUS", "S7_CONFIG_APPLY", "S7_CATALOG_UPGRADE", "S8_READBACK"]);

function requireSchemaGate(state, schema) {
  assert.equal(state.schema.current, schema, "__PKT_LABEL_UPPER___MAINTENANCE_EXPECTED" + schema);
  assert.equal(state.gate.unresolvedReservedCount, 0, "__PKT_LABEL_UPPER___MAINTENANCE_GATE_UNRESOLVED");
  assert.equal(state.gate.nonTerminalRunCount, 0, "__PKT_LABEL_UPPER___MAINTENANCE_NON_TERMINAL_RUNS");
}

function requireStepBinding(report, action, code) {
  assert(typeof report.bindingSha256 === "string" && /^[0-9a-f]{64}$/.test(report.bindingSha256), code + ":" + action);
  assert.equal(report.bindingSha256, sha(readFileSync(`${operations}/inputs/bindings.json`)), code + ":" + action);
}

function requirePassedStep(action) {
  const report = jsonFile(`${evidenceRoot}/${action.toLowerCase()}-result.json`);
  assert(report.passed === true && report.action === action, "__PKT_LABEL_UPPER___MAINTENANCE_PREVIOUS_STEP_NOT_VERIFIED:" + action);
  requireStepBinding(report, action, "__PKT_LABEL_UPPER___MAINTENANCE_PREVIOUS_STEP_BINDING_CHANGED");
  return report;
}

async function recoveryOptions(binding, prefix, schema, recoveryId, ledger) {
  assert.equal(binding.maintenance.recoveryMethod, recoveryMethod, "__PKT_LABEL_UPPER___MAINTENANCE_RECOVERY_METHOD_CHANGED");
  const { acquireStateRootLock } = await persistence(prefix);
  return { stateRoot: binding.paths.stateRoot, evidenceRoot, recoveryId, schema, identity: binding.identity, expectedLedger: ledger, openReadonly: (filename) => openRecoveryReadonly(prefix, filename), acquireStateRootLock, requireStopped };
}

async function copyRecovery(binding, prefix, schema, id, state) {
  const beforeSpace = diskSpace();
  const result = await createRawRecoveryPoint(await recoveryOptions(binding, prefix, schema, id, state.ledger));
  return { ...result, spaceBefore: beforeSpace, spaceAfter: diskSpace() };
}

async function verifyRetainedRecovery(binding, expectedDigest) {
  const id = recoveryIdForSchema(binding, currentSchema);
  const report = jsonFile(`${evidenceRoot}/s3_copy51-result.json`);
  assert(report.passed === true && report.action === "S3_COPY51", "__PKT_LABEL_UPPER___MAINTENANCE_RECOVERY_POINT_NOT_VERIFIED");
  requireStepBinding(report, "S3_COPY51", "__PKT_LABEL_UPPER___MAINTENANCE_RECOVERY_BINDING_CHANGED");
  assert(report.recovery?.method === recoveryMethod && report.recovery.recoveryId === id, "__PKT_LABEL_UPPER___MAINTENANCE_RECOVERY_POINT_CHANGED");
  const reference = jsonFile(`${evidenceRoot}/s3-copy-after__PKT_CURRENT_SCHEMA__.json`);
  const proof = await verifyRawRecoveryPoint({ ...await recoveryOptions(binding, oldPrefix, currentSchema, id, reference.ledger), expectedDigest: expectedDigest ?? report.recovery.digest });
  assert.equal(proof.digest, report.recovery.digest, "__PKT_LABEL_UPPER___MAINTENANCE_RECOVERY_DIGEST_CHANGED");
  return { proof, reference };
}

async function applyStaticRootConfiguration(binding) {
  requireStopped();
  const configPath = binding.paths.config;
  const nextPath = `${configPath}.next`;
  assert.equal(sha(readFileSync(configPath)), binding.service.oldConfigSha256, "__PKT_LABEL_UPPER___MAINTENANCE_ORIGINAL_CONFIG_REQUIRED");
  assert.throws(() => lstatSync(nextPath), { code: "ENOENT" }, "__PKT_LABEL_UPPER___MAINTENANCE_CONFIG_NEXT_PRESENT");
  const index = lstatSync(`${newStaticRoot}/index.html`);
  assert(index.isFile() && !index.isSymbolicLink(), "__PKT_LABEL_UPPER___MAINTENANCE_NEW_STATIC_ROOT_INDEX_MISSING");
  const bytes = staticRootConfigurationBytes(readOriginalConfiguration(binding));
  assert.equal(sha(bytes), staticRootConfigurationSha256(binding), "__PKT_LABEL_UPPER___MAINTENANCE_STATIC_ROOT_CONFIG_BYTES_CHANGED");
  writeFileSync(nextPath, bytes, { flag: "wx", mode: 0o600 });
  try {
    const nextInfo = lstatSync(nextPath);
    assert(nextInfo.isFile() && nextInfo.uid === process.getuid() && (nextInfo.mode & 0o777) === 0o600 && sha(readFileSync(nextPath)) === sha(bytes), "__PKT_LABEL_UPPER___MAINTENANCE_CONFIG_NEXT_READBACK_FAILED");
    const platform = await import(pathToFileURL(`${newPrefix}/lib/himawari-agent/node_modules/@himawari-agent/platform-node/dist/index.js`).href);
    const loaded = await new platform.JsonFileConfigurationPort(nextPath).load();
    assert.equal(loaded.http?.staticRoot, newStaticRoot, "__PKT_LABEL_UPPER___MAINTENANCE_NEW_RUNTIME_REJECTED_STATIC_ROOT");
    const model = loaded.modelDescriptors?.find((entry) => entry.ref === approvedModelRef);
    assert(model && model.contextWindow === approvedModelLimits.contextWindow && model.maxTokens === approvedModelLimits.maxTokens, "__PKT_LABEL_UPPER___MAINTENANCE_NEW_RUNTIME_REJECTED_MODEL_LIMITS");
    assert(!Object.hasOwn(loaded, "budgets") && loaded.runPolicy?.publicFetch?.maximumBytes === approvedPublicFetchBytes, "__PKT_LABEL_UPPER___MAINTENANCE_NEW_RUNTIME_REJECTED_PUBLIC_FETCH");
    if (approvedEmbeddingDescriptor !== null) {
      const embedding = loaded.modelDescriptors?.find((entry) => entry.role === "embedding");
      assert(embedding && embedding.provider === approvedEmbeddingDescriptor.provider && embedding.model === approvedEmbeddingDescriptor.model && embedding.dimensions === approvedEmbeddingDescriptor.dimensions && loaded.memory?.dimensions === approvedEmbeddingDescriptor.dimensions, "__PKT_LABEL_UPPER___MAINTENANCE_NEW_RUNTIME_REJECTED_EMBEDDING");
    }
    if (approvedSpeech !== null) assert.deepEqual({ ...loaded.speech }, { ...approvedSpeech }, "__PKT_LABEL_UPPER___MAINTENANCE_NEW_RUNTIME_REJECTED_SPEECH");
  } catch (error) {
    rmSync(nextPath, { force: true });
    throw error;
  }
  requireStopped();
  renameSync(nextPath, configPath);
  const info = lstatSync(configPath);
  assert(info.isFile() && info.uid === process.getuid() && (info.mode & 0o777) === 0o600 && sha(readFileSync(configPath)) === sha(bytes), "__PKT_LABEL_UPPER___MAINTENANCE_CONFIG_READBACK_FAILED");
  assert.equal(currentConfigurationStage(binding), "static-root", "__PKT_LABEL_UPPER___MAINTENANCE_CONFIG_STAGE_CHANGED");
  return { path: configPath, beforeSha256: binding.service.oldConfigSha256, afterSha256: sha(bytes), bytes: bytes.length };
}

async function main(action) {
  const frozen = loadBinding(!action.startsWith("S9_") && action !== "S7_CATALOG_UPGRADE");
  const binding = afterStop.has(action) ? withAuthorityAtStop(frozen) : frozen;
  const report = { schemaVersion: "himawari.__PKT_LABEL__-change-maintenance.v1", action, startedAt: new Date().toISOString(), actor: { uid: process.getuid(), account: "himawari-prod", hostname: hostname() }, bindingSha256: sha(readFileSync("/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__/inputs/bindings.json")), passed: false };
  const retain = (name, value) => retainedJson(name, value, { supersede: action.startsWith("S9_") });
  retain(`${action.toLowerCase()}-started.json`, report);
  try {
    if (!["S8_READBACK", "S9_SIDECAR_TIDY"].includes(action)) await requireStateUnlocked(["S3_COPY51", "S9_RAW_RESTORE51"].includes(action) ? oldPrefix : newPrefix);
    if (action === "S3_COPY51") {
      const before = await readMaintenanceState(binding, oldPrefix, "since-freeze");
      requireSchemaGate(before, currentSchema);
      report.before = retain("s3-copy-before__PKT_CURRENT_SCHEMA__.json", before);
      report.recovery = await copyRecovery(binding, oldPrefix, currentSchema, recoveryIdForSchema(binding, currentSchema), before);
      const after = await readMaintenanceState(binding, oldPrefix, false, before.authority);
      verifyHistoryUnchanged(before, after);
      report.after = retain("s3-copy-after__PKT_CURRENT_SCHEMA__.json", after);
    } else if (action === "S7_DB_STATUS") {
      requirePassedStep("S3_COPY51");
      const state = await readMaintenanceState(binding, newPrefix);
      requireSchemaGate(state, currentSchema);
      verifyHistoryUnchanged(jsonFile(`${evidenceRoot}/s3-copy-after__PKT_CURRENT_SCHEMA__.json`), state);
      const authorization = readPreUpgradeAuthorization(binding);
      report.authorization = retain("s7-preupgrade-authorization.json", authorization);
      report.authorizationVerification = { passed: true, configurationSha256: authorization.configurationSha256, authorizationSha256: report.authorization.sha256, checkedAt: authorization.checkedAt };
      report.state = retain("s7-preswitch-state.json", state);
    } else if (action === "S7_CONFIG_APPLY") {
      requirePassedStep("S7_DB_STATUS");
      const state = await readMaintenanceState(binding, newPrefix);
      requireSchemaGate(state, currentSchema);
      const preswitch = jsonFile(`${evidenceRoot}/s7-preswitch-state.json`);
      verifyHistoryUnchanged(preswitch, state);
      report.configuration = retain("s7-config-apply.json", await applyStaticRootConfiguration(binding));
      const authorization = readPreUpgradeAuthorization(binding);
      assert.equal(authorization.configurationSha256, staticRootConfigurationSha256(binding), "__PKT_LABEL_UPPER___MAINTENANCE_STATIC_ROOT_CONFIG_BYTES_CHANGED");
      report.authorization = retain("s7-static-root-authorization.json", authorization);
      if (targetSchema !== currentSchema) {
        const migration = await migrateDatabase({
          requireStopped,
          collectContent: () => readMigrationContent(newPrefix),
          runMigrate: () => cli(newPrefix, ["db", "migrate", "--config", binding.paths.config, "--confirm", "APPLY_MIGRATIONS"], "s7-migrate" + targetSchema),
          describeSnapshot: describeMigrationSnapshot,
        });
        verifyHistoryUnchanged(preswitch, migration.after);
        report.migrationBefore = retain("s7-migrate-before" + currentSchema + ".json", migration.before);
        report.migrate = migration.migrate.retained;
        report.migrationSnapshot = migration.snapshot;
        report.migrationTransition = migration.transition;
        report.migrationAfter = retain("s7-migrate-after" + targetSchema + ".json", migration.after);
      }
      const applied = await readMaintenanceState(binding, newPrefix);
      requireSchemaGate(applied, targetSchema);
      verifyHistoryUnchanged(preswitch, applied);
      report.after = retain("s7-config-apply-after__PKT_TARGET_SCHEMA__.json", applied);
    } else if (action === "S7_CATALOG_UPGRADE" && currentConfigurationStage(binding) === "prepared") {
      requirePassedStep("S7_CONFIG_APPLY");
      report.recoveryReadback = (await verifyRetainedRecovery(binding)).proof;
      const resumed = readCatalogResume(binding);
      report.resume = resumed.approval;
      Object.assign(report, resumed.retained);
      const after = await readMaintenanceState(binding, newPrefix);
      requireSchemaGate(after, targetSchema);
      verifyHistoryUnchanged(jsonFile(`${evidenceRoot}/s7-preswitch-state.json`), after);
      const upgradedState = readCatalogState(binding, { prepared: true, upgraded: true });
      assert.equal(upgradedState.snapshotSha256, resumed.snapshotSha256, "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_SNAPSHOT_CHANGED");
      const planDigest = verifyUpgradePlan(resumed.plan, { frozen: upgradedState.frozen, snapshotSha256: resumed.snapshotSha256, authorization: upgradedState.authorization });
      assert.deepEqual(upgradeResultExpectation(resumed.upgrade), upgradeResultExpectation({ snapshotDigest: resumed.plan.snapshotDigest, planDigest, frozen: upgradedState.frozen }), "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_RESULT_CHANGED");
      const upgraded = verifyUpgradedCatalog(upgradedState, resumed.original.records.upgradeAudit);
      report.catalogAfter = retain("s7-catalog-after.json", { authorization: upgradedState.authorization, records: upgradedState.records, strict: upgradedState.strict, workspace: upgradedState.workspace });
      report.catalog = { preparedConfigurationSha256: upgradedState.configurationSha256, snapshotSha256: resumed.snapshotSha256, planDigest, upgraded, upgradeAuditBefore: resumed.original.records.upgradeAudit, upgradeAudit: upgradedState.records.upgradeAudit };
      report.after = retain("s7-catalog-after__PKT_TARGET_SCHEMA__.json", after);
      report.postUpgradeState = retain("s7-post-upgrade-state.json", postUpgradeState(binding, after));
    } else if (action === "S7_CATALOG_UPGRADE") {
      requirePassedStep("S7_CONFIG_APPLY");
      report.recoveryReadback = (await verifyRetainedRecovery(binding)).proof;
      const before = await readMaintenanceState(binding, newPrefix);
      requireSchemaGate(before, targetSchema);
      verifyHistoryUnchanged(jsonFile(`${evidenceRoot}/s7-preswitch-state.json`), before);
      const original = readPreUpgradeAuthorization(binding);
      report.catalogBefore = retain("s7-catalog-before.json", original);
      const prepared = runPrepare(binding);
      report.prepare = prepared.retained;
      loadBinding(false);
      const afterPrepare = readCatalogState(binding, { prepared: true });
      assert.equal(afterPrepare.configurationSha256, prepared.configurationSha256, "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_CONFIG_CHANGED");
      assert.equal(afterPrepare.snapshotSha256, prepared.snapshotSha256, "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_SNAPSHOT_CHANGED");
      verifyCatalogRecordsAtS0(afterPrepare.records, afterPrepare.frozen);
      assert.deepEqual(afterPrepare.records.upgradeAudit, original.records.upgradeAudit, "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_AUDIT_CHANGED");
      verifyPreparedCapabilities(afterPrepare);
      verifyPendingCapabilities(afterPrepare.pending, afterPrepare.frozen);
      const planned = await cli(newPrefix, ["capabilities", "upgrade-plan", "--config", binding.paths.config, "--reviewed"], "s7-catalog-plan");
      report.plan = planned.retained;
      const planDigest = verifyUpgradePlan(planned.result, afterPrepare);
      const applied = await cli(newPrefix, ["capabilities", "upgrade", "--config", binding.paths.config, "--confirm", planDigest, "--reviewed"], "s7-catalog-upgrade");
      report.upgrade = applied.retained;
      assert.deepEqual(upgradeResultExpectation(applied.result), upgradeResultExpectation({ snapshotDigest: planned.result.snapshotDigest, planDigest, frozen: afterPrepare.frozen }), "__PKT_LABEL_UPPER___MAINTENANCE_UPGRADE_RESULT_CHANGED");
      const after = await readMaintenanceState(binding, newPrefix);
      verifyHistoryUnchanged(before, after);
      const upgradedState = readCatalogState(binding, { prepared: true, upgraded: true });
      assert.equal(upgradedState.configurationSha256, prepared.configurationSha256, "__PKT_LABEL_UPPER___MAINTENANCE_PREPARED_CONFIG_CHANGED");
      const upgraded = verifyUpgradedCatalog(upgradedState, original.records.upgradeAudit);
      report.catalogAfter = retain("s7-catalog-after.json", { authorization: upgradedState.authorization, records: upgradedState.records, strict: upgradedState.strict, workspace: upgradedState.workspace });
      report.catalog = { preparedConfigurationSha256: prepared.configurationSha256, snapshotSha256: prepared.snapshotSha256, planDigest, upgraded, upgradeAuditBefore: original.records.upgradeAudit, upgradeAudit: upgradedState.records.upgradeAudit };
      report.after = retain("s7-catalog-after__PKT_TARGET_SCHEMA__.json", after);
      report.postUpgradeState = retain("s7-post-upgrade-state.json", postUpgradeState(binding, after));
    } else if (action === "S8_READBACK") {
      requirePassedStep("S7_CATALOG_UPGRADE");
      verifyHistoryUnchanged(jsonFile(`${evidenceRoot}/s3-copy-after__PKT_CURRENT_SCHEMA__.json`), jsonFile(`${evidenceRoot}/s7-catalog-after__PKT_TARGET_SCHEMA__.json`));
      const after = await readMaintenanceState(binding, newPrefix, true);
      requireSchemaGate(after, targetSchema);
      report.state = retain("s8-database-readback.json", after);
      report.authorization = retain("s8-current-authorization.json", readPostSwitchAuthorization(binding));
      report.recoveryPoints = { ["schema" + currentSchema]: (await verifyRetainedRecovery(binding)).proof };
      report.scope = "upgraded-capability-catalog-existing-workspace-grant-and-raw-recovery-point-not-paid-chat-acceptance";
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
      report.before = retain("s9_sidecar_tidy-before.json", tidy.before);
      report.tidy = retain("s9_sidecar_tidy-tidy.json", { readVia: tidy.readVia, noSidecars: tidy.noSidecars, journalMode: tidy.journalMode, checkpoint: tidy.checkpoint, checkpointBusy: tidy.checkpointBusy, sidecarsBefore: tidy.sidecarsBefore, sidecarsBeforeWrite: tidy.sidecarsBeforeWrite, sidecarsAfter: tidy.sidecarsAfter, comparedSections: tidy.comparedSections });
      report.after = retain("s9_sidecar_tidy-after.json", tidy.after);
      report.state = retain("s9_sidecar_tidy-state.json", await readMaintenanceState(binding, newPrefix, "rollback-current"));
      report.scope = "rollback-approval-and-fresh-s2-inspection-required-no-state-lock-no-manual-deletion-wal-checkpoint-truncate-then-content-readback";
    } else {
      const id = recoveryIdForSchema(binding, currentSchema);
      const approvalRecord = readRollbackApproval(binding);
      const approval = approvalRecord.approval;
      report.approvalSha256 = approvalRecord.sha256;
      report.approvalRef = approval.approvalRef;
      const current = await readMaintenanceState(binding, newPrefix, "rollback-current");
      assert([currentSchema, targetSchema].includes(current.schema.current), "__PKT_LABEL_UPPER___MAINTENANCE_ROLLBACK_CURRENT_SCHEMA_REQUIRED");
      report.before = retain(`${action.toLowerCase()}-before.json`, current);
      const retained = await verifyRetainedRecovery(binding, approval.recoveryDigest);
      report.verify = retained.proof;
      const options = await recoveryOptions(binding, oldPrefix, currentSchema, id, retained.reference.ledger);
      const restored = await restoreRawRecoveryPoint({ ...options, expectedDigest: approval.recoveryDigest, preservedRecoveryId: approval.preservedCurrentRecoveryId, currentLedger: current.ledger, currentSchema: current.schema.current, currentOpenReadonly: (filename) => openRecoveryReadonly(newPrefix, filename) });
      Object.assign(report, restored);
      const state = await readMaintenanceState(binding, oldPrefix);
      assert.equal(state.schema.current, currentSchema, "__PKT_LABEL_UPPER___MAINTENANCE_RESTORED_SCHEMA_MISMATCH");
      const reference = retained.reference;
      verifyHistoryUnchanged(reference, state);
      assert.deepEqual(state.gate, reference.gate, "__PKT_LABEL_UPPER___MAINTENANCE_RESTORED_GATE_CHANGED");
      report.after = retain(`${action.toLowerCase()}-after.json`, state);
      report.catalog = readRestoredCatalog(binding);
      report.accountRecoveryRequired = true;
      report.serviceStartAuthorized = false;
      const authorityPath = `${binding.paths.stateRoot}/authority.json`;
      const authorityMirror = jsonFile(authorityPath);
      const authorityDatabase = openRecoveryReadonly(oldPrefix);
      try {
        const deployment = authorityDatabase.prepare("SELECT id,owner_id AS ownerId,agent_id AS agentId,revision,status,authority_epoch AS authorityEpoch,fencing_token AS fencingToken,transfer_id AS transferId FROM deployments WHERE id=?").get(binding.identity.deploymentId);
        report.authorityMirrorCompatibility = { path: authorityPath, sha256: sha(readFileSync(authorityPath)), compatible: Boolean(deployment && ["id", "ownerId", "agentId", "revision", "status", "authorityEpoch", "fencingToken", "transferId"].every((key) => authorityMirror[key] === deployment[key])), modified: false };
        assert.equal(report.authorityMirrorCompatibility.compatible, true, "__PKT_LABEL_UPPER___MAINTENANCE_RESTORED_AUTHORITY_MIRROR_INCOMPATIBLE");
      } finally { authorityDatabase.close(); }
    }
    if (action !== "S8_READBACK") requireStopped();
    report.passed = true;
    report.finishedAt = new Date().toISOString();
    const retained = retain(`${action.toLowerCase()}-result.json`, report);
    process.stdout.write(JSON.stringify({ passed: true, action, evidence: retained, productionPaidChatVerified: false }) + "\n");
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    if (error?.rawRecovery) report.partialRecovery = error.rawRecovery;
    if (error?.maintenanceDetail) report.maintenanceDetail = error.maintenanceDetail;
    report.accountRecoveryRequired = action.startsWith("S9_") ? true : report.accountRecoveryRequired;
    report.serviceStartAuthorized = false;
    report.failureCode = "__PKT_LABEL_UPPER___DEPLOY_MAINTENANCE_STOPPED";
    const firstLine = error instanceof Error ? error.message.split("\n")[0] : "";
    report.failedCondition = /^[A-Z0-9_]+(:[A-Za-z0-9._-]+)?$/.test(firstLine) ? firstLine : "__PKT_LABEL_UPPER___DEPLOY_MAINTENANCE_UNEXPECTED_FAILURE";
    const retained = retain(`${action.toLowerCase()}-failure.json`, report);
    process.stdout.write(JSON.stringify({ passed: false, action, failureCode: report.failureCode, evidence: retained }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv.length !== 3 || !actions.has(process.argv[2])) {
    process.stderr.write("__PKT_LABEL_UPPER___MAINTENANCE_ARGUMENT_INVALID\n");
    process.exitCode = 1;
  } else {
    try {
      await main(process.argv[2]);
    } catch {
      process.stderr.write("__PKT_LABEL_UPPER___MAINTENANCE_PRECHECK_FAILED\n");
      process.exitCode = 1;
    }
  }
}
