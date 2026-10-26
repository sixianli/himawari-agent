import assert from "node:assert/strict";
import { createHash, createPublicKey, verify } from "node:crypto";
import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { hostname, release } from "node:os";
import { pathToFileURL } from "node:url";
import { validateR2l6Installed } from "./validate-r2l6-installed.mjs";
import { validateSystemToolBindings } from "./cloud-system-tool-bindings.mjs";
import { assertCapabilityCompatibility, assertPrepareConfigurationIdentity, createCapabilityManifest } from "./cloud-capability-manifest.mjs";

const root = "/var/lib/himawari",
  prefix = "/opt/himawari/releases/2026-10-26-twelfth",
  runtime = prefix + "/lib/himawari-agent",
  q = root + "/qualification/twelfth-20261026";
const protectionPath = "/opt/himawari/operations/twelfth-20261026/runtime-protection.json",
  mutable = root + "/state/deployment";
assert.equal(process.env.HIMAWARI_RUNTIME_PROTECTION_FILE, protectionPath);
process.umask(0o077);
const hash = (b) => createHash("sha256").update(b).digest("hex");
async function safeRead(p) {
  const s = await lstat(p);
  assert(s.isFile() && !s.isSymbolicLink() && !(s.mode & 0o077) && s.uid === process.getuid());
  return readFile(p);
}
async function trustedRead(p) {
  assert(p.startsWith(q + "/"));
  assert.equal(await realpath(p), p);
  const st = await lstat(p);
  assert(st.isFile() && st.uid === 0 && !(st.mode & 0o022));
  return readFile(p);
}
const bytes = await trustedRead(q + "/installation-receipt.json"),
  receipt = JSON.parse(bytes),
  publicKey = createPublicKey(await trustedRead(q + "/host-qualification-public-key.pem"));
assert(
  verify(null, bytes, publicKey, await trustedRead(q + "/installation-receipt.sig")),
  "RECEIPT_SIGNATURE_INVALID",
);
assert.equal(hostname(), receipt.host);
assert.equal(process.platform, receipt.platform);
assert.equal(process.arch, receipt.architecture);
assert.equal(release(), receipt.osRelease);
assert.equal(receipt.runtime, runtime);
assert.equal(receipt.bwrapBindings.srt.requestedPath, "/usr/bin/bwrap");
assert.equal(receipt.bwrapBindings.program.requestedPath, "/usr/local/libexec/bubblewrap-0.11.2/bwrap");
assert.equal(receipt.bwrapBindings.program.minimumSatisfied, true);
for (const binding of Object.values(receipt.bwrapBindings)) {
  assert.equal(await realpath(binding.requestedPath), binding.realpath);
  assert.equal(hash(await readFile(binding.realpath)), binding.sha256, "BWRAP_EXECUTABLE_CHANGED");
  assert.equal(hash(await readFile(binding.apparmorProfile.path)), binding.apparmorProfile.sha256, "BWRAP_APPARMOR_PROFILE_CHANGED");
}
for (const [name, digest] of Object.entries(receipt.artifacts))
  assert.equal(hash(await trustedRead(q + "/" + name + ".json")), digest, "EVIDENCE_CHANGED");
for (const [name, digest] of Object.entries(receipt.acceptanceEvidence))
  assert.equal(hash(await trustedRead(q + "/acceptance-evidence/" + name)), digest, "ACCEPTANCE_EVIDENCE_CHANGED");
await validateSystemToolBindings(receipt.bindingInputs.systemToolPaths, receipt.systemToolBindings);
for (const [p, digest] of Object.entries(receipt.systemTools))
  assert.equal(hash(await readFile(p)), digest, "SYSTEM_TOOL_CHANGED");
const platform = await import(
  pathToFileURL(runtime + "/node_modules/@himawari-agent/platform-node/dist/index.js").href
);
const sandboxRuntime = await import(
  pathToFileURL(runtime + "/node_modules/@himawari-agent/runtime-sandbox/dist/index.js").href
);
const dependencies = await sandboxRuntime.inspectSrtDependencies();
assert.equal(dependencies.errors.length, 0, "SRT_DEPENDENCIES_UNAVAILABLE");
const preparing = process.argv[2] === "--prepare";
assert(preparing && process.argv.length === 4, "PREPARE_ONLY_REQUIRED");
const configPath = process.argv[3];
assert.equal(configPath, "/etc/himawari/config.json");
assert(process.getuid() > 0, "RUNTIME_ACCOUNT_REQUIRED");
assert.equal(receipt.schema, "himawari-installed-foreground-receipt.v2");
assert.deepEqual(Object.keys(receipt.artifacts).sort(), [
  "pi-installed", "composition-installed", "network-installed", "boundary-installed",
  "worker-loss-installed", "web-search-installed", "r2l6-installed",
].sort());
const r2l6 = await validateR2l6Installed({ runtime, reportPath: q + "/r2l6-installed.json" });
assert.equal(r2l6.reportSha256, receipt.artifacts["r2l6-installed"]);
assert.equal(r2l6.runtimeDigest, receipt.runtimeDigest);
assert.equal(receipt.bindingInputs.acceptanceUid, process.getuid());
const originalConfigBytes = await safeRead(configPath);
let config = JSON.parse(originalConfigBytes),
  now = new Date().toISOString(),
  signerRef = "host-signer:" + hash(publicKey.export({ type: "spki", format: "der" }));
assertPrepareConfigurationIdentity(config, receipt.bindingInputs);
const capabilities = [];
for (const { key, binding } of receipt.bindings) {
  assert(
    verify(
      null,
      await readFile(binding.runner.path),
      publicKey,
      await trustedRead(q + "/" + key + "-runner.sig"),
    ),
    "RUNNER_SIGNATURE_INVALID",
  );
  const sandbox = {
    schemaVersion: "sandbox-runtime-qualification.v1",
    qualificationRef: "twelfth-cloud-foreground:" + key + ":" + hash(bytes),
    hostId: binding.hostId,
    profileRef: binding.profileRef,
    srtVersion: "0.0.75",
    platform: process.platform,
    architecture: process.arch,
    osRelease: release(),
    runtimeDigest: binding.runtimeDigest,
    runnerDigest: binding.runner.sha256,
    evidenceDigest: hash(bytes),
    resourceMode: "observe_and_stop",
    terminationMode: "verified_tree",
    guarantees: [
      "filesystem_default_deny",
      "network_allowlist",
      "clean_environment",
      "bounded_output",
      "wall_clock_stop",
      "resource_observation",
      "durable_start_admission",
      "unknown_quarantine",
      "restart_reconciliation",
      "task_tree_termination",
      "worker_crash_cleanup",
    ],
    limitations: [],
    supportedExecutions: binding.supportedExecutions,
  };
  await platform.verifySandboxHost({ binding, qualification: sandbox, hostId: binding.hostId });
  const manifest = createCapabilityManifest({ key, binding, ownerId: config.ownerId, workerInstanceId: receipt.bindingInputs.workerInstanceId, signerRef, issuedAt: receipt.issuedAt, observedAt: now });
  assert.equal(hash(await readFile(binding.runner.path)), binding.runner.sha256, "NEW_RUNNER_DIGEST_CHANGED");
  assertCapabilityCompatibility({ manifest, binding, observation: receipt.bindingInputs.persistentCapabilityObservations.find((entry) => entry.capabilityRef === manifest.ref) });
  capabilities.push({
    manifest,
    binding: { kind: "sandbox", value: binding },
    qualification: {
      qualificationVersion: "capability-runtime-qualification.v1",
      platform: process.platform,
      runtimeIdentity: "srt:0.0.75",
      productionSuitable: true,
      artifactDigest: binding.artifactDigest,
      enforcement: {
        filesystem: true,
        network: true,
        processes: true,
        secrets: true,
        resourceCeilings: false,
        termination: true,
      },
      reasonCodes: [],
      checkedAt: now,
      sandbox,
    },
  });
}
const snapshot = { schemaVersion: "capability-deployment.v1", capabilities },
  snapshotBytes = Buffer.from(JSON.stringify(snapshot, null, 2) + "\n"),
  snapshotPath = mutable + "/capability-deployment.json";
await rm(snapshotPath + ".next", { force: true });
await writeFile(snapshotPath + ".next", snapshotBytes, { mode: 0o600, flag: "wx" });
await rename(snapshotPath + ".next", snapshotPath);
config.capabilityDeployment = { snapshotPath, sha256: "sha256:" + hash(snapshotBytes) };
await new platform.CapabilityDeploymentSnapshotLoader(config.capabilityDeployment).load();
await writeFile(
  mutable + "/startup-attestation.json",
  JSON.stringify({
    at: now,
    receiptDigest: hash(bytes),
    runtimeDigest: receipt.runtimeDigest,
    liveHostVerified: true,
    signatureVerified: true,
    snapshotDigest: hash(snapshotBytes),
    dependencies,
    scope: receipt.scope,
  }),
  { mode: 0o600 },
);
await rm(configPath + ".next", { force: true });
await writeFile(configPath + ".next", JSON.stringify(config, null, 2) + "\n", { mode: 0o600, flag: "wx" });
await rename(configPath + ".next", configPath);
await new platform.JsonFileConfigurationPort(configPath).load();
console.log(
  JSON.stringify({
    event: "installation-verified",
    at: now,
    runtimeDigest: receipt.runtimeDigest,
    snapshotDigest: hash(snapshotBytes),
    preparing,
  }),
);
process.exitCode = 0;
