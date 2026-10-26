import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync, realpathSync, readdirSync, readlinkSync } from "node:fs";
import { hostname, release } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateSystemToolBindings } from "./cloud-system-tool-bindings.mjs";
import { validateR2l6Installed } from "./validate-r2l6-installed.mjs";

const operations = "/opt/himawari/operations/twelfth-20261026";
const runtime = "/opt/himawari/releases/2026-10-26-twelfth/lib/himawari-agent";
const qualification = "/var/lib/himawari/qualification/twelfth-20261026";
const stateRoot = "/var/lib/himawari/state";
const evidenceRoot = "/var/lib/himawari/twelfth-20261026-evidence";
const configurationPath = "/etc/himawari/config.json";
const protectionPath = operations + "/runtime-protection.json";
const node = "/opt/himawari/node/bin/node";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const artifactNames = ["pi-installed", "composition-installed", "network-installed", "boundary-installed", "worker-loss-installed", "web-search-installed", "r2l6-installed"];

function file(filename, uid, mode) {
  const info = lstatSync(filename);
  assert(info.isFile() && !info.isSymbolicLink() && info.uid === uid && info.nlink === 1 && !(info.mode & 0o022), "TWELFTH_STARTUP_FILE_UNSAFE");
  assert.equal(realpathSync(filename), filename, "TWELFTH_STARTUP_FILE_NOT_CANONICAL");
  if (mode !== undefined) assert.equal(info.mode & 0o7777, mode, "TWELFTH_STARTUP_FILE_MODE_CHANGED");
  return readFileSync(filename);
}

function qualifiedFile(relative) {
  assert(!path.isAbsolute(relative) && !relative.split("/").includes(".."), "TWELFTH_STARTUP_QUALIFICATION_PATH_UNSAFE");
  return file(qualification + "/" + relative, 0);
}

function processRecord(pid, name) {
  assert(Number.isSafeInteger(pid) && pid > 1, "TWELFTH_STARTUP_PID_INVALID");
  const location = `/proc/${pid}`;
  const info = lstatSync(location);
  assert.equal(info.uid, 999, "TWELFTH_STARTUP_PROCESS_UID_CHANGED");
  const stat = readFileSync(location + "/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
  assert(!["Z", "X"].includes(fields[0]), "TWELFTH_STARTUP_PROCESS_NOT_LIVE");
  const status = Object.fromEntries(readFileSync(location + "/status", "utf8").split("\n").filter((line) => line.includes(":")).map((line) => { const i = line.indexOf(":"); return [line.slice(0, i), line.slice(i + 1).trim()]; }));
  assert(status.Uid.split(/\s+/).every((value) => value === "999"), "TWELFTH_STARTUP_PROCESS_UID_CHANGED");
  assert(status.Gid.split(/\s+/).every((value) => value === "988"), "TWELFTH_STARTUP_PROCESS_GID_CHANGED");
  assert.equal(status.NoNewPrivs, "1", "TWELFTH_STARTUP_NO_NEW_PRIVILEGES_CHANGED");
  assert.equal(status.CapEff, "0000000000000000", "TWELFTH_STARTUP_EFFECTIVE_CAPABILITIES_CHANGED");
  assert.equal(status.CapBnd, "0000000000000000", "TWELFTH_STARTUP_CAPABILITY_BOUND_CHANGED");
  assert.equal(realpathSync(location + "/exe"), realpathSync(node), "TWELFTH_STARTUP_EXECUTABLE_CHANGED");
  const args = readFileSync(location + "/cmdline", "utf8").split("\0").filter(Boolean);
  assert.equal(args[args.indexOf("--profile") + 1], "production", "TWELFTH_STARTUP_PROFILE_CHANGED");
  assert.equal(args[args.indexOf("--config") + 1], configurationPath, "TWELFTH_STARTUP_CONFIG_ARGUMENT_CHANGED");
  assert(args.some((arg) => arg.startsWith(runtime + "/")), "TWELFTH_STARTUP_RUNTIME_ARGUMENT_CHANGED");
  return { name, pid, uid: 999, gid: 988, parentPid: Number(fields[1]), startTime: fields[19], executable: realpathSync(location + "/exe") };
}

async function loadCatalogReader() {
  for (const relative of ["maintenance/maintenance-common.mjs", "maintenance/workspace-grant.mjs", "maintenance/raw-copy-recovery.mjs", "s0-db/read-s0-db.mjs"]) file(operations + "/" + relative, 0);
  return import(pathToFileURL(operations + "/maintenance/maintenance-common.mjs").href);
}

async function inspect(mode, invocationId) {
  assert.equal(process.platform, "linux", "TWELFTH_STARTUP_LINUX_REQUIRED");
  assert.equal(hostname(), "vmi3618928", "TWELFTH_STARTUP_HOST_CHANGED");
  assert.equal(process.getuid(), 999, "TWELFTH_STARTUP_UID_CHANGED");
  assert.equal(process.getgid(), 988, "TWELFTH_STARTUP_GID_CHANGED");
  assert.equal(process.umask(), 0o022, "TWELFTH_STARTUP_UMASK_CHANGED");
  assert.equal(process.env.HOME, stateRoot, "TWELFTH_STARTUP_HOME_CHANGED");
  assert.equal(process.env.PATH, "/opt/himawari/node/bin:/usr/bin:/bin", "TWELFTH_STARTUP_PATH_CHANGED");
  assert.equal(process.env.HIMAWARI_RUNTIME_PROTECTION_FILE, protectionPath, "TWELFTH_STARTUP_PROTECTION_ENV_CHANGED");
  assert(!Object.hasOwn(process.env, "TMPDIR"), "TWELFTH_STARTUP_TMPDIR_PRESENT");
  assert.equal(realpathSync(process.execPath), node, "TWELFTH_STARTUP_NODE_CHANGED");
  assert.equal(hash(file(node, 0)), "e6ec2c188d83d813f81f2de8aea084d74dce603ac1abedd0a30ad941b10087b2", "TWELFTH_STARTUP_NODE_BYTES_CHANGED");
  const bindingBytes = file(operations + "/inputs/bindings.json", 0);
  const binding = JSON.parse(bindingBytes);
  assert.equal(binding.schemaVersion, "himawari.twelfth-change-bindings.v1", "TWELFTH_STARTUP_BINDING_SCHEMA_CHANGED");
  assert.equal(binding.status, "frozen-approved", "TWELFTH_STARTUP_FROZEN_APPROVAL_REQUIRED");
  assert(binding.approvals.packageRef, "TWELFTH_STARTUP_APPROVAL_BINDING_REQUIRED");
  assert.deepEqual(Object.keys(binding.authority).sort(), ["deploymentId", "ownerId", "agentId", "status", "authorityEpoch", "fencingToken"].sort(), "TWELFTH_STARTUP_S0_AUTHORITY_SHAPE_CHANGED");
  for (const key of ["deploymentId", "ownerId", "agentId"]) assert.equal(binding.authority[key], binding.identity[key], "TWELFTH_STARTUP_S0_AUTHORITY_IDENTITY_CHANGED");
  assert.equal(binding.authority.status, "active", "TWELFTH_STARTUP_S0_AUTHORITY_NOT_ACTIVE");
  for (const key of ["authorityEpoch", "fencingToken"]) assert(Number.isSafeInteger(binding.authority[key]) && binding.authority[key] > 0, "TWELFTH_STARTUP_S0_AUTHORITY_NUMBER_INVALID");
  assert.equal(binding.paths.newPrefix, path.dirname(path.dirname(runtime)), "TWELFTH_STARTUP_PREFIX_CHANGED");
  assert.equal(binding.paths.stateRoot, stateRoot, "TWELFTH_STARTUP_STATE_ROOT_CHANGED");
  assert.equal(binding.paths.config, configurationPath, "TWELFTH_STARTUP_CONFIG_PATH_CHANGED");
  assert.equal(binding.service.pairSupervisor, "/opt/himawari/operations/eleventh-20261026/pair-supervisor.mjs", "TWELFTH_STARTUP_PAIR_PATH_CHANGED");
  const originalBytes = file(evidenceRoot + "/original-config.json", 999, 0o600);
  assert.equal(hash(originalBytes), binding.service.oldConfigSha256, "TWELFTH_STARTUP_ORIGINAL_CONFIG_CHANGED");
  const configurationBytes = file(configurationPath, 999, 0o600);
  const original = JSON.parse(originalBytes);
  const current = JSON.parse(configurationBytes);
  const currentDeployment = current.capabilityDeployment;
  const receiptBytes = qualifiedFile("installation-receipt.json");
  const receipt = JSON.parse(receiptBytes);
  const publicKey = createPublicKey(qualifiedFile("host-qualification-public-key.pem"));
  assert(verify(null, receiptBytes, publicKey, qualifiedFile("installation-receipt.sig")), "TWELFTH_STARTUP_RECEIPT_SIGNATURE_INVALID");
  assert.equal(hash(publicKey.export({ type: "spki", format: "der" })), hash(createPublicKey(file("/var/lib/himawari/qualification/first-20261007/host-qualification-public-key.pem", 0)).export({ type: "spki", format: "der" })), "TWELFTH_STARTUP_SIGNER_CHANGED");
  assert.equal(receipt.schema, "himawari-installed-foreground-receipt.v2", "TWELFTH_STARTUP_RECEIPT_SCHEMA_CHANGED");
  assert.equal(receipt.host, hostname(), "TWELFTH_STARTUP_RECEIPT_HOST_CHANGED");
  assert.equal(receipt.platform, process.platform, "TWELFTH_STARTUP_RECEIPT_PLATFORM_CHANGED");
  assert.equal(receipt.architecture, process.arch, "TWELFTH_STARTUP_RECEIPT_ARCH_CHANGED");
  assert.equal(receipt.osRelease, release(), "TWELFTH_STARTUP_RECEIPT_KERNEL_CHANGED");
  assert.equal(receipt.runtime, runtime, "TWELFTH_STARTUP_RECEIPT_RUNTIME_CHANGED");
  assert.equal(receipt.source.revision, "470b6d30a8664d5f85da2a8b261b59a4f5f18704", "TWELFTH_STARTUP_RECEIPT_REVISION_CHANGED");
  assert.equal(receipt.source.artifactSha256, binding.candidate.archiveSha256, "TWELFTH_STARTUP_RECEIPT_ARTIFACT_CHANGED");
  assert.equal(receipt.bindingInputs.acceptanceUid, 999, "TWELFTH_STARTUP_ACCEPTANCE_UID_CHANGED");
  assert.equal(receipt.bindingInputs.deploymentId, binding.identity.deploymentId, "TWELFTH_STARTUP_RECEIPT_DEPLOYMENT_CHANGED");
  assert(!Object.hasOwn(binding, "configurationChange"), "TWELFTH_STARTUP_CONFIGURATION_CHANGE_NOT_ALLOWED");
  for (const key of ["configurationChange", "grantAuthority"]) assert(!Object.hasOwn(receipt.bindingInputs, key), "TWELFTH_STARTUP_FOURTH_ONLY_INPUT_PRESENT:" + key);
  assert.deepEqual(receipt.bindingInputs.workspaceGrant, binding.workspace, "TWELFTH_STARTUP_WORKSPACE_PLAN_CHANGED");
  assert.equal(receipt.bindingInputs.originalConfigurationSha256, binding.service.oldConfigSha256, "TWELFTH_STARTUP_ORIGINAL_CONFIGURATION_BINDING_CHANGED");
  const catalogReader = await loadCatalogReader();
  assert.equal(catalogReader.configurationStage(original, current), "prepared", "TWELFTH_STARTUP_NEW_SNAPSHOT_REQUIRED");
  const staticRootAuthorization = JSON.parse(file(evidenceRoot + "/s7-static-root-authorization.json", 999, 0o600));
  assert(staticRootAuthorization.passed === true && staticRootAuthorization.configurationSha256 === catalogReader.staticRootConfigurationSha256(binding), "TWELFTH_STARTUP_STATIC_ROOT_CONFIGURATION_NOT_VERIFIED");
  assert.equal(original.runPolicy.coding.grantId, binding.workspace.grantId, "TWELFTH_STARTUP_ORIGINAL_GRANT_ID_CHANGED");
  const preupgrade = JSON.parse(file(evidenceRoot + "/s7-preupgrade-authorization.json", 999, 0o600));
  assert.equal(preupgrade.schemaVersion, "himawari.twelfth-change-preupgrade-authorization.v1", "TWELFTH_STARTUP_PREUPGRADE_AUTHORIZATION_SCHEMA_CHANGED");
  assert.equal(preupgrade.passed, true, "TWELFTH_STARTUP_PREUPGRADE_AUTHORIZATION_FAILED");
  assert.equal(preupgrade.configurationSha256, hash(originalBytes), "TWELFTH_STARTUP_PREUPGRADE_CONFIGURATION_CHANGED");
  assert.equal(preupgrade.s0ReadbackSha256, receipt.bindingInputs.authorizationObservationSha256, "TWELFTH_STARTUP_PREUPGRADE_S0_CHANGED");
  assert.deepEqual(preupgrade.authorization, { directoryGrants: receipt.bindingInputs.authorizedDirectoryGrants, capabilities: receipt.bindingInputs.persistentCapabilityObservations }, "TWELFTH_STARTUP_PREUPGRADE_AUTHORIZATION_CHANGED");
  const upgrade = catalogReader.readCatalogUpgradeResult(binding);
  assert.deepEqual(Object.keys(receipt.artifacts).sort(), [...artifactNames].sort(), "TWELFTH_STARTUP_SEVEN_REPORTS_REQUIRED");
  const reports = {};
  for (const [name, digest] of Object.entries(receipt.artifacts)) {
    const bytes = qualifiedFile(name + ".json");
    assert.equal(hash(bytes), digest, "TWELFTH_STARTUP_QUALIFICATION_REPORT_CHANGED");
    reports[name] = JSON.parse(bytes);
  }
  assert.equal(reports["pi-installed"].passed, 22, "TWELFTH_STARTUP_PI_REPORT_FAILED");
  assert.equal(reports["composition-installed"].productionSandboxProbePassed, true, "TWELFTH_STARTUP_COMPOSITION_REPORT_FAILED");
  assert.equal(reports["composition-installed"].cleanup, "confirmed", "TWELFTH_STARTUP_COMPOSITION_CLEANUP_FAILED");
  assert.equal(reports["composition-installed"].replayExecuted, false, "TWELFTH_STARTUP_COMPOSITION_REPLAYED");
  for (const name of ["network-installed", "worker-loss-installed", "web-search-installed"])
    assert.equal(reports[name].passed, true, "TWELFTH_STARTUP_REPORT_FAILED:" + name);
  assert.equal(reports["network-installed"].evidence.length, 10, "TWELFTH_STARTUP_NETWORK_CASES_CHANGED");
  assert(reports["network-installed"].evidence.every((value) => value.passed && value.namespaceState === "released" && value.network.closed), "TWELFTH_STARTUP_NETWORK_RELEASE_FAILED");
  assert.equal(reports["boundary-installed"].evidence.length, 7, "TWELFTH_STARTUP_BOUNDARY_CASES_CHANGED");
  assert(reports["boundary-installed"].evidence.every((value) => value.denialObserved && value.namespaceState === "released" && value.network.closed), "TWELFTH_STARTUP_BOUNDARY_RELEASE_FAILED");
  assert.equal(reports["web-search-installed"].evidence.length, 3, "TWELFTH_STARTUP_SEARCH_CASES_CHANGED");
  assert(reports["web-search-installed"].evidence.every((value) => value.passed && value.namespaceState === "released" && value.network.closed), "TWELFTH_STARTUP_SEARCH_RELEASE_FAILED");
  for (const [name, digest] of Object.entries(receipt.acceptanceEvidence))
    assert.equal(hash(qualifiedFile("acceptance-evidence/" + name)), digest, "TWELFTH_STARTUP_ACCEPTANCE_EVIDENCE_CHANGED");
  for (const { key, binding: value } of receipt.bindings)
    assert(verify(null, file(value.runner.path, 0), publicKey, qualifiedFile(key + "-runner.sig")), "TWELFTH_STARTUP_RUNNER_SIGNATURE_INVALID");
  await validateSystemToolBindings(receipt.bindingInputs.systemToolPaths, receipt.systemToolBindings);
  for (const value of Object.values(receipt.bwrapBindings)) {
    assert.equal(realpathSync(value.requestedPath), value.realpath, "TWELFTH_STARTUP_BWRAP_PATH_CHANGED");
    assert.equal(hash(file(value.realpath, 0)), value.sha256, "TWELFTH_STARTUP_BWRAP_CHANGED");
    assert.equal(hash(file(value.apparmorProfile.path, 0)), value.apparmorProfile.sha256, "TWELFTH_STARTUP_APPARMOR_CHANGED");
  }
  const protection = JSON.parse(file(protectionPath, 0, 0o644));
  assert.deepEqual(protection, { schemaVersion: "protected-runtime.v1", runtimeRoot: runtime, runtimeDigest: receipt.runtimeDigest, runtimeUid: 999, deploymentUid: 0 }, "TWELFTH_STARTUP_RUNTIME_PROTECTION_CHANGED");
  const platform = await import(pathToFileURL(runtime + "/node_modules/@himawari-agent/platform-node/dist/index.js").href);
  assert.equal(await platform.digestSandboxRuntime(runtime), receipt.runtimeDigest, "TWELFTH_STARTUP_LIVE_RUNTIME_DIGEST_CHANGED");
  const r2l6 = await validateR2l6Installed({ runtime, reportPath: qualification + "/r2l6-installed.json" });
  assert.equal(r2l6.reportSha256, receipt.artifacts["r2l6-installed"], "TWELFTH_STARTUP_R2L6_REPORT_CHANGED");
  assert.equal(r2l6.runtimeDigest, receipt.runtimeDigest, "TWELFTH_STARTUP_R2L6_RUNTIME_CHANGED");
  for (const { binding: value } of receipt.bindings) {
    await platform.verifySandboxHost({ binding: value, hostId: value.hostId, qualification: {
      schemaVersion: "sandbox-runtime-qualification.v1", qualificationRef: "twelfth-cloud-foreground:preflight:" + hash(receiptBytes),
      hostId: value.hostId, profileRef: value.profileRef, srtVersion: "0.0.75", platform: process.platform,
      architecture: process.arch, osRelease: release(), runtimeDigest: value.runtimeDigest, runnerDigest: value.runner.sha256,
      evidenceDigest: hash(receiptBytes), resourceMode: "observe_and_stop", terminationMode: "verified_tree",
      guarantees: ["filesystem_default_deny", "network_allowlist", "clean_environment", "bounded_output", "wall_clock_stop", "resource_observation", "durable_start_admission", "unknown_quarantine", "restart_reconciliation", "task_tree_termination", "worker_crash_cleanup"],
      limitations: [], supportedExecutions: value.supportedExecutions,
    } });
  }
  const snapshotPath = stateRoot + "/deployment/capability-deployment.json";
  const snapshotBytes = file(snapshotPath, 999, 0o600);
  assert.deepEqual(currentDeployment, { snapshotPath, sha256: "sha256:" + hash(snapshotBytes) }, "TWELFTH_STARTUP_SNAPSHOT_CONFIG_CHANGED");
  const catalog = catalogReader.readPostSwitchAuthorization(binding);
  assert.equal(catalog.configurationSha256, hash(configurationBytes), "TWELFTH_STARTUP_CATALOG_CONFIG_CHANGED");
  assert.equal(catalog.snapshotSha256, hash(snapshotBytes), "TWELFTH_STARTUP_CATALOG_SNAPSHOT_CHANGED");
  assert.equal(catalog.catalogUpgradeSha256, upgrade.sha256, "TWELFTH_STARTUP_CATALOG_UPGRADE_REPORT_CHANGED");
  assert.equal(catalog.authorization.capabilities.length, receipt.bindings.length, "TWELFTH_STARTUP_CATALOG_SET_CHANGED");
  for (const capability of catalog.authorization.capabilities) {
    const signed = receipt.bindings.filter((value) => value.binding.capabilityRef === capability.capabilityRef);
    assert.equal(signed.length, 1, "TWELFTH_STARTUP_CATALOG_CAPABILITY_UNSIGNED");
    assert.equal(capability.runnerSha256, signed[0].binding.runner.sha256, "TWELFTH_STARTUP_CATALOG_RUNNER_NOT_SIGNED");
    assert.equal(capability.runtimeRoot, runtime, "TWELFTH_STARTUP_CATALOG_RUNTIME_CHANGED");
  }
  assert.deepEqual(catalog.authorization.directoryGrants, receipt.bindingInputs.authorizedDirectoryGrants, "TWELFTH_STARTUP_DIRECTORY_GRANTS_CHANGED");
  const preflight = { schemaVersion: "himawari.twelfth-change-startup-preflight.v1", passed: true, checkedAt: new Date().toISOString(), configurationSha256: hash(configurationBytes), receiptSha256: hash(receiptBytes), runtimeDigest: receipt.runtimeDigest, signatureVerified: true, liveHostVerified: true, runtimeProtectionVerified: true, catalogUpgradeSha256: upgrade.sha256, catalog };
  if (mode === "--preflight") {
    assert.equal(hash(configurationBytes), upgrade.report.catalog.preparedConfigurationSha256, "TWELFTH_STARTUP_PREPARED_CONFIG_CHANGED");
    assert.equal(hash(snapshotBytes), upgrade.report.catalog.snapshotSha256, "TWELFTH_STARTUP_PREPARED_SNAPSHOT_CHANGED");
    assert.deepEqual(catalog.authority, binding.authority, "TWELFTH_STARTUP_PRESWITCH_DB_AUTHORITY_CHANGED");
    return preflight;
  }
  assert(/^[a-f0-9]{32}$/.test(invocationId), "TWELFTH_STARTUP_INVOCATION_INVALID");
  const journal = readFileSync(0, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert(journal.every((item) => item._SYSTEMD_INVOCATION_ID === invocationId), "TWELFTH_STARTUP_JOURNAL_INVOCATION_CHANGED");
  const records = journal.map((item) => { try { return JSON.parse(item.MESSAGE); } catch { return null; } }).filter((item) => item && typeof item === "object");
  assert(!records.some((item) => /(?:failed|failure|error|timeout|lost|quarantined|child_exit|child_error)/i.test(String(item.event))), "TWELFTH_STARTUP_FAILURE_EVENT_OBSERVED");
  const prepared = records.filter((item) => item.event === "installation-verified");
  assert.equal(prepared.length, 1, "TWELFTH_STARTUP_PREPARE_EVENT_MISSING_OR_REPEATED");
  const loaded = await new platform.CapabilityDeploymentSnapshotLoader(currentDeployment).load();
  const snapshot = loaded.snapshot;
  assert.equal(snapshot.capabilities.length, receipt.bindings.length, "TWELFTH_STARTUP_SNAPSHOT_CAPABILITY_SET_CHANGED");
  for (const item of snapshot.capabilities) {
    const signed = receipt.bindings.find((value) => value.binding.capabilityRef === item.manifest.ref);
    assert(signed, "TWELFTH_STARTUP_UNSIGNED_CAPABILITY");
    assert.deepEqual(item.binding, { kind: "sandbox", value: signed.binding }, "TWELFTH_STARTUP_SNAPSHOT_BINDING_CHANGED");
    assert.equal(item.qualification.sandbox.evidenceDigest, hash(receiptBytes), "TWELFTH_STARTUP_SNAPSHOT_RECEIPT_CHANGED");
    await platform.verifySandboxHost({ binding: signed.binding, qualification: item.qualification.sandbox, hostId: signed.binding.hostId });
  }
  const attestation = JSON.parse(file(stateRoot + "/deployment/startup-attestation.json", 999, 0o600));
  for (const [key, expected] of Object.entries({ receiptDigest: hash(receiptBytes), runtimeDigest: receipt.runtimeDigest, snapshotDigest: hash(snapshotBytes), signatureVerified: true, liveHostVerified: true }))
    assert.equal(attestation[key], expected, "TWELFTH_STARTUP_ATTESTATION_CHANGED:" + key);
  assert.deepEqual(attestation.dependencies.errors, [], "TWELFTH_STARTUP_SRT_DEPENDENCIES_FAILED");
  assert.equal(prepared[0].at, attestation.at, "TWELFTH_STARTUP_ATTESTATION_NOT_CURRENT_INVOCATION");
  assert.equal(prepared[0].preparing, true, "TWELFTH_STARTUP_PREPARE_NOT_EXECUTED");
  assert.equal(prepared[0].runtimeDigest, receipt.runtimeDigest, "TWELFTH_STARTUP_PREPARE_RUNTIME_CHANGED");
  assert.equal(prepared[0].snapshotDigest, hash(snapshotBytes), "TWELFTH_STARTUP_PREPARE_SNAPSHOT_CHANGED");
  const configuration = await new platform.JsonFileConfigurationPort(configurationPath).load();
  assert.equal(configuration.stateRoot, stateRoot, "TWELFTH_STARTUP_LOADED_STATE_ROOT_CHANGED");
  const layout = { root: stateRoot, data: stateRoot + "/data", runtime: stateRoot + "/runtime", cache: stateRoot + "/cache", payloadCiphertext: stateRoot + "/data/payload-ciphertext", authorityFile: stateRoot + "/authority.json", agentServiceBootBindingFile: stateRoot + "/runtime/agent-service.boot.json" };
  const [authority, agent, worker] = await Promise.all([platform.readAuthorityFile(layout), platform.readAgentServiceBootBinding(layout), platform.readWorkerServiceBootBinding(layout)]);
  assert.equal(authority.status, "active", "TWELFTH_STARTUP_AUTHORITY_NOT_ACTIVE");
  assert.equal(authority.authorityEpoch, binding.authority.authorityEpoch, "TWELFTH_STARTUP_AUTHORITY_EPOCH_CHANGED");
  assert(Number.isSafeInteger(authority.fencingToken) && authority.fencingToken > binding.authority.fencingToken, "TWELFTH_STARTUP_NEW_LEASE_FENCE_REQUIRED");
  assert.deepEqual(catalog.authority, { deploymentId: authority.id, ownerId: authority.ownerId, agentId: authority.agentId, status: authority.status, authorityEpoch: authority.authorityEpoch, fencingToken: authority.fencingToken }, "TWELFTH_STARTUP_LIVE_DB_AUTHORITY_CHANGED");
  for (const value of [authority, agent, worker]) {
    assert.equal(value.deploymentId ?? value.id, binding.identity.deploymentId, "TWELFTH_STARTUP_DEPLOYMENT_CHANGED");
    assert.equal(value.ownerId, binding.identity.ownerId, "TWELFTH_STARTUP_OWNER_CHANGED");
    assert.equal(value.agentId, binding.identity.agentId, "TWELFTH_STARTUP_AGENT_CHANGED");
    assert.equal(value.authorityEpoch, authority.authorityEpoch, "TWELFTH_STARTUP_BOOT_EPOCH_MISMATCH");
    assert.equal(value.fencingToken, authority.fencingToken, "TWELFTH_STARTUP_BOOT_FENCE_MISMATCH");
  }
  assert.equal(agent.workerInstanceId, worker.workerInstanceId, "TWELFTH_STARTUP_WORKER_INSTANCE_MISMATCH");
  assert.equal(agent.workerBootId, worker.workerBootId, "TWELFTH_STARTUP_WORKER_BOOT_MISMATCH");
  assert.equal(agent.agentServiceInstanceId, "agent-service:" + configuration.deploymentId, "TWELFTH_STARTUP_AGENT_INSTANCE_CHANGED");
  assert.equal(worker.workerInstanceId, "execution-worker:" + configuration.deploymentId, "TWELFTH_STARTUP_WORKER_INSTANCE_CHANGED");
  const agentReady = records.filter((item) => item.component === "agent-service" && item.event === "service.ready");
  const workerReady = records.filter((item) => item.component === "execution-worker" && item.event === "service.ready");
  assert.equal(agentReady.length, 1, "TWELFTH_STARTUP_AGENT_READY_MISSING_OR_REPEATED");
  assert.equal(workerReady.length, 1, "TWELFTH_STARTUP_WORKER_READY_MISSING_OR_REPEATED");
  for (const value of [agentReady[0], workerReady[0]]) {
    assert.equal(value.deploymentId, configuration.deploymentId, "TWELFTH_STARTUP_READY_DEPLOYMENT_CHANGED");
    assert.equal(value.authorityEpoch, authority.authorityEpoch, "TWELFTH_STARTUP_READY_EPOCH_CHANGED");
    assert.equal(value.fencingToken, authority.fencingToken, "TWELFTH_STARTUP_READY_FENCE_CHANGED");
  }
  assert.equal(agentReady[0].workerSchemaVersion, "execution.v2", "TWELFTH_STARTUP_HANDSHAKE_SCHEMA_CHANGED");
  assert.equal(workerReady[0].schemaVersion, "execution.v2", "TWELFTH_STARTUP_WORKER_SCHEMA_CHANGED");
  assert.equal(workerReady[0].adapterRegistry, "snapshot-qualified", "TWELFTH_STARTUP_WORKER_REGISTRY_UNQUALIFIED");
  assert.equal(agentReady[0].publicMode, false, "TWELFTH_STARTUP_PUBLIC_MODE_CHANGED");
  assert.equal(agentReady[0].modelPath, "pi-production", "TWELFTH_STARTUP_MODEL_PATH_CHANGED");
  assert.equal(agentReady[0].memoryPath, "memory-engine-production", "TWELFTH_STARTUP_MEMORY_PATH_CHANGED");
  const spawned = records.filter((item) => item.event === "pair.child_spawned");
  assert.deepEqual(spawned.map((item) => item.name), ["worker", "agent"], "TWELFTH_STARTUP_PAIR_CHILDREN_CHANGED");
  assert.equal(spawned[0].pairRunId, spawned[1].pairRunId, "TWELFTH_STARTUP_PAIR_RUN_MISMATCH");
  const processes = spawned.map((item) => processRecord(item.pid, item.name));
  const mainPid = Number(execFileSync("/usr/bin/systemctl", ["show", "himawari-prod.service", "--property=MainPID", "--value"], { encoding: "utf8", timeout: 5000 }).trim());
  assert(mainPid > 1 && processes.every((item) => item.parentPid === mainPid), "TWELFTH_STARTUP_PAIR_PARENT_MISMATCH");
  const mainArgs = readFileSync(`/proc/${mainPid}/cmdline`, "utf8").split("\0").filter(Boolean);
  assert(mainArgs.includes(operations + "/pair-supervisor.mjs"), "TWELFTH_STARTUP_SUPERVISOR_PATH_CHANGED");
  assert.equal(mainArgs[mainArgs.indexOf("--prefix") + 1], binding.paths.newPrefix, "TWELFTH_STARTUP_SUPERVISOR_PREFIX_CHANGED");
  assert.equal(realpathSync(`/proc/${mainPid}/exe`), realpathSync(node), "TWELFTH_STARTUP_SUPERVISOR_EXECUTABLE_CHANGED");
  const agentPid = processes.find((item) => item.name === "agent").pid;
  const socketInodes = new Set(readdirSync(`/proc/${agentPid}/fd`).map((entry) => { try { return /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${agentPid}/fd/${entry}`))?.[1]; } catch { return undefined; } }).filter(Boolean));
  assert(["127.0.0.1", "::1"].includes(configuration.http.listenHost), "TWELFTH_STARTUP_HTTP_NOT_LOOPBACK");
  const listeners = [];
  for (const source of ["/proc/net/tcp", "/proc/net/tcp6"])
    for (const line of readFileSync(source, "utf8").trim().split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      const [address, port] = fields[1].split(":");
      if (fields[3] === "0A" && parseInt(port, 16) === configuration.http.listenPort)
        listeners.push({ source, address, port: configuration.http.listenPort, uid: Number(fields[7]), inode: fields[9] });
    }
  assert(listeners.length > 0 && listeners.every((item) => ["0100007F", "00000000000000000000000001000000"].includes(item.address) && item.uid === 999 && socketInodes.has(item.inode)), "TWELFTH_STARTUP_LISTENER_NOT_OWNED_LOOPBACK");
  const socket = lstatSync(stateRoot + "/runtime/execution.sock");
  assert(socket.isSocket() && socket.uid === 999 && socket.gid === 988 && (socket.mode & 0o7777) === 0o600, "TWELFTH_STARTUP_EXECUTION_SOCKET_CHANGED");
  return { schemaVersion: "himawari.twelfth-change-startup-verification.v1", passed: true, checkedAt: new Date().toISOString(), scope: "startup-readback-only-no-paid-request", configurationSha256: hash(configurationBytes), snapshotSha256: hash(snapshotBytes), receiptSha256: hash(receiptBytes), runtimeDigest: receipt.runtimeDigest, signatureVerified: true, liveHostVerified: true, runtimeProtectionVerified: true, invocationId, pairRunId: spawned[0].pairRunId, mainPid, processes, authority: { ...authority, deploymentId: authority.id }, currentEpoch: authority.authorityEpoch, currentFencingToken: authority.fencingToken, agentBinding: agent, workerBinding: worker, agentReady: agentReady[0], workerReady: workerReady[0], listeners, catalogUpgradeSha256: upgrade.sha256, catalog, actualSystemdCrashRestartVerified: false };
}

try {
  assert(["--preflight", "--startup"].includes(process.argv[2]), "TWELFTH_STARTUP_MODE_REQUIRED");
  assert.equal(process.argv.length, process.argv[2] === "--preflight" ? 3 : 4, "TWELFTH_STARTUP_ARGUMENTS_CHANGED");
  process.stdout.write(JSON.stringify(await inspect(process.argv[2], process.argv[3])) + "\n");
} catch (error) {
  const first = typeof error?.message === "string" ? error.message.split("\n")[0] : "TWELFTH_STARTUP_INSPECTION_FAILED";
  const code = /^(?:TWELFTH_|RECEIPT_|RUNNER_|SANDBOX_|SRT_)[A-Z0-9_]+(?::[A-Za-z0-9._-]+)?$/.test(first) ? first : "TWELFTH_STARTUP_INSPECTION_FAILED";
  process.stderr.write(JSON.stringify({ passed: false, code }) + "\n");
  process.exitCode = 1;
}
