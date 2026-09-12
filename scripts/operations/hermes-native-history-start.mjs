import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { lstat, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname, release } from "node:os";

const root = "/data/hermes/himawari",
  prefix = root + "/releases/2026-09-11-control-center",
  runtime = prefix + "/lib/himawari-agent",
  q = root + "/qualifications/2026-09-11-native-history-installation";
const protectionPath = "/etc/himawari/runtime.json",
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
for (const [name, digest] of Object.entries(receipt.artifacts))
  assert.equal(hash(await trustedRead(q + "/" + name + ".json")), digest, "EVIDENCE_CHANGED");
for (const [p, digest] of Object.entries(receipt.systemTools))
  assert.equal(hash(await readFile(p)), digest, "SYSTEM_TOOL_CHANGED");
const require = createRequire(runtime + "/package.json"),
  platform = require("@himawari-agent/platform-node"),
  sandboxRuntime = require("@himawari-agent/runtime-sandbox");
const dependencies = await sandboxRuntime.inspectSrtDependencies();
assert.equal(dependencies.errors.length, 0, "SRT_DEPENDENCIES_UNAVAILABLE");
const preparing = process.argv[2] === "--prepare";
assert(process.argv.length === (preparing ? 4 : 2));
const configPath = preparing ? process.argv[3] : root + "/config/production.json";
assert(
  configPath === root + "/config/production.json" ||
    configPath === mutable + "/production-prepared.json",
);
const config = JSON.parse(await safeRead(configPath)),
  now = new Date().toISOString(),
  signerRef = "host-signer:" + hash(publicKey.export({ type: "spki", format: "der" }));
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
    qualificationRef: "hermes-foreground:" + key + ":" + hash(bytes),
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
  const manifest = {
    manifestVersion: "capability.v2",
    ref: binding.capabilityRef,
    displayName: key === "pi" ? "Hermes 已授权目录 Pi 工具" : "公开网页搜索（Exa）",
    version: binding.capabilityVersion,
    source: { type: "program", locator: "artifact:hermes-installed-" + key },
    sourceIdentity: "host:hermes-home",
    integrity: binding.artifactDigest,
    artifact: {
      digest: binding.artifactDigest,
      signatureStatus: "verified",
      signerRef,
      rollbackArtifactRef: null,
    },
    operations: binding.operationBindings.map((x) => x.operation),
    permissionRefs: [],
    isolation: "sandbox",
    scopes: {
      dataClassifications: ["public", "private"],
      network: binding.allowedDomains,
      filesystem: ["workspace:hermes-default"],
      secrets: [],
    },
    cost: { currency: "USD", maxMicrosPerInvocation: 0 },
    health: { status: "healthy", checkedAt: now },
    reviewedBy: config.ownerId,
    reviewedAt: receipt.issuedAt,
    contractCompatibility: ["capability-conformance.v1"],
    runtime: {
      kind: "program",
      argv: [
        binding.executable.path,
        binding.runner.path,
        binding.hostId,
        "execution-worker:" + config.deploymentId,
      ],
      environmentKeys: [],
      workdirRef: "workspace:hermes-default",
      stdin: "protected_payload",
      stdout: "protected_payload",
      subprocesses: [],
      network: binding.allowedDomains,
      filesystem: ["workspace:hermes-default"],
    },
  };
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
  snapshotPath = mutable + "/deployment-" + randomUUID() + ".json";
await writeFile(snapshotPath, snapshotBytes, { mode: 0o600, flag: "wx" });
config.capabilityDeployment = { snapshotPath, sha256: "sha256:" + hash(snapshotBytes) };
await new platform.CapabilityDeploymentSnapshotLoader(config.capabilityDeployment).load();
await writeFile(configPath + ".next", JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
await rename(configPath + ".next", configPath);
await new platform.JsonFileConfigurationPort(configPath).load();
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
console.log(
  JSON.stringify({
    event: "installation-verified",
    at: now,
    runtimeDigest: receipt.runtimeDigest,
    snapshotDigest: hash(snapshotBytes),
    preparing,
  }),
);
if (preparing) process.exit(0);
const args = [
  "--config",
  configPath,
  "--worker-token-file",
  root + "/config/worker-token.json",
  "--profile",
  "production",
];
const children = [];
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  const agent = children.find((x) => x.name === "agent"),
    worker = children.find((x) => x.name === "worker");
  const exited = (child) =>
    !child || child.process.exitCode !== null || child.process.signalCode !== null;
  const wait = (child) =>
    exited(child)
      ? Promise.resolve()
      : new Promise((resolve) => child.process.once("exit", resolve));
  if (!exited(agent)) agent.process.kill("SIGTERM");
  setTimeout(() => {
    for (const x of children) if (!exited(x)) x.process.kill("SIGKILL");
    process.exit(code || 1);
  }, 30000).unref();
  wait(agent)
    .then(() => {
      if (!exited(worker)) worker.process.kill("SIGTERM");
      return wait(worker);
    })
    .then(() => process.exit(code));
}
for (const [name, entry] of [
  ["worker", "himawari-execution-worker"],
  ["agent", "himawari-agent-service"],
]) {
  const log = await open(root + "/logs/" + name + ".log", "a", 0o600),
    child = spawn(prefix + "/bin/" + entry, args, {
      env: {
        PATH: runtime + "/pi-tools/bin:/usr/bin:/bin",
        HOME: root + "/state",
        LANG: "C.UTF-8",
        HIMAWARI_RUNTIME_PROTECTION_FILE: protectionPath,
      },
      stdio: ["ignore", log.fd, log.fd],
    });
  children.push({ name, process: child });
  child.once("error", (e) => {
    console.error(name, e.code);
    stop(1);
  });
  child.once("exit", (code, signal) => {
    console.log(JSON.stringify({ event: "service-exit", name, code, signal }));
    if (!stopping) stop(code || 1);
  });
  await log.close();
}
process.once("SIGTERM", () => stop(0));
process.once("SIGINT", () => stop(0));
