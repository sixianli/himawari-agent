import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { lstat, open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname, release } from "node:os";

const root = "/data/hermes/himawari",
  prefix = root + "/releases/2026-09-11-control-center",
  runtime = prefix + "/lib/himawari-agent",
  q = root + "/qualifications/2026-09-11-protected/attempt-v5/seal-stage-v5";
process.umask(0o077);
const hash = (b) => createHash("sha256").update(b).digest("hex"),
  fileHash = async (p) => hash(await readFile(p));
assert.equal(hostname(), "hermes-home");
assert.equal(process.platform, "linux");
if (process.argv[2] === "--preflight") {
  assert.equal(process.argv.length, 3);
  const workspace = root + "/workspaces/default",
    metadata = await stat(workspace);
  assert(metadata.isDirectory());
  assert.equal(await realpath(workspace), workspace);
  const keyPath = root + "/qualifications/host-qualification-signing-key.pem";
  const info = await lstat(keyPath);
  assert(info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o077));
  const handle = await open(keyPath, "r");
  await handle.close();
  console.log(
    JSON.stringify({
      passed: true,
      signerUid: process.getuid(),
      workspaceDevice: String(metadata.dev),
      workspaceInode: String(metadata.ino),
    }),
  );
  process.exit(0);
}
assert.equal(process.argv.length, 2);
const require = createRequire(runtime + "/package.json");
const { digestSandboxRuntime } = require("@himawari-agent/platform-node");
const observations = {},
  artifacts = {};
for (const name of [
  "pi-installed",
  "composition-installed",
  "network-installed",
  "boundary-installed",
  "worker-loss-installed",
  "web-search-installed",
]) {
  const bytes = await readFile(q + "/" + name + ".json");
  observations[name] = JSON.parse(bytes);
  artifacts[name] = hash(bytes);
}
assert.equal(observations["pi-installed"].passed, 22);
assert(observations["pi-installed"].reports.every((x) => x.namespaceState === "released"));
assert.equal(observations["composition-installed"].productionSandboxProbePassed, true);
assert.equal(observations["composition-installed"].installedRuntime, runtime);
assert.equal(observations["composition-installed"].cleanup, "confirmed");
assert.equal(observations["composition-installed"].replayExecuted, false);
assert.equal(observations["network-installed"].passed, true);
assert.equal(observations["network-installed"].evidence.length, 10);
assert(
  observations["network-installed"].evidence.every(
    (x) => x.passed && x.namespaceState === "released" && x.network.closed,
  ),
);
assert.equal(observations["boundary-installed"].evidence.length, 7);
assert(
  observations["boundary-installed"].evidence.every(
    (x) => x.denialObserved && x.namespaceState === "released" && x.network.closed,
  ),
);
assert.equal(observations["worker-loss-installed"].passed, true);
assert.equal(observations["web-search-installed"].passed, true);
assert.equal(observations["web-search-installed"].installedRuntime, runtime);
assert.equal(observations["web-search-installed"].evidence.length, 3);
assert(
  observations["web-search-installed"].evidence.every(
    (x) => x.passed && x.namespaceState === "released" && x.network.closed,
  ),
);
const runtimeDigest = await digestSandboxRuntime(runtime),
  executable = runtime + "/pi-tools/bin/node";
const jobHost = runtime + "/node_modules/@himawari-agent/runtime-sandbox/dist/job-host-main.js";
assert.equal(await fileHash(jobHost), observations["network-installed"].runnerDigest);
assert.equal(await fileHash(jobHost), observations["boundary-installed"].jobHostDigest);
for (const [name, digest] of Object.entries(observations["pi-installed"].toolDigests))
  assert.equal(await fileHash(runtime + "/pi-tools/bin/" + name), digest);
const systemTools = {};
for (const name of ["bwrap", "socat", "bash", "rg"]) {
  const p = await realpath("/usr/bin/" + name);
  systemTools[p] = await fileHash(p);
}
const workspace = root + "/workspaces/default",
  metadata = await stat(workspace);
const base = {
  schemaVersion: "sandbox-host-binding.v1",
  capabilityVersion: "1.0.0",
  hostId: "hermes-home",
  profileRef: "authorized-project.v1",
  runtimeRoot: runtime,
  runtimeDigest,
  executable: { path: executable, sha256: await fileHash(executable) },
  privateRoot: root + "/jobs",
  roots: [
    {
      canonicalRootId: String(metadata.dev) + ":" + String(metadata.ino),
      canonicalPath: workspace,
      device: String(metadata.dev),
      inode: String(metadata.ino),
    },
  ],
  readOnlyToolchainPaths: [
    ...new Set(
      await Promise.all(
        [
          runtime,
          "/usr/bin",
          "/usr/lib",
          "/lib",
          "/lib64",
          "/dev",
          "/proc",
          "/etc/ssl",
          "/etc/hosts",
        ].map((p) => realpath(p)),
      ),
    ),
  ],
  protectedPaths: [
    root + "/state",
    root + "/config",
    root + "/qualifications",
    root + "/builds",
    root + "/logs",
    workspace + "/.env",
    workspace + "/.git",
  ],
  maximumResourceCeiling: {
    maxWallTimeMs: 300000,
    maxCpuTimeMs: 30000,
    maxMemoryBytes: 536870912,
    maxOutputBytes: 524288,
    maxProgressEvents: 256,
  },
  supportedExecutions: [{ schemaVersion: "sandbox-execution.v2", mode: "foreground" }],
};
const bindings = [];
for (const [key, ref, file, operations, domains] of [
  [
    "pi",
    "himawari.pi-coding",
    "pi-coding-main.js",
    ["read", "write", "edit", "find", "grep", "ls", "bash"],
    [],
  ],
  ["search", "himawari.public-search", "web-search-main.js", ["web_search"], ["mcp.exa.ai:443"]],
]) {
  const runner =
      runtime + "/node_modules/@himawari-agent/agent-service/dist/capability-programs/" + file,
    runnerDigest = await fileHash(runner);
  if (key === "search")
    assert.equal(runnerDigest, observations["web-search-installed"].runnerDigest);
  bindings.push({
    key,
    binding: {
      ...base,
      capabilityRef: ref,
      artifactDigest: "sha256:" + runnerDigest,
      runner: { path: runner, sha256: runnerDigest },
      allowedDomains: domains,
      operationBindings: operations.map((operation) => ({
        operation,
        mode: "foreground",
        contract: {
          ref: key === "pi" ? "pi-coding-tool" : "public-web-search",
          version: "1",
          kind:
            operation === "bash"
              ? "command"
              : ["write", "edit"].includes(operation)
                ? "verified_effect"
                : "fixed_read",
          ...(["write", "edit"].includes(operation)
            ? { verifierRef: "pi-atomic-write", verifierVersion: "1", targetRef: "pi-input:path" }
            : {}),
        },
        backendRef: "srt",
        scopeSource: "grant_targets",
        directoryOperations:
          operation === "write"
            ? ["read", "create", "update"]
            : operation === "edit"
              ? ["read", "update"]
              : ["read"],
        network: key === "search" ? "grant_targets" : "disabled",
      })),
    },
  });
}
const keyPath = root + "/qualifications/host-qualification-signing-key.pem";
const keyStat = await lstat(keyPath);
assert(keyStat.isFile() && !keyStat.isSymbolicLink() && !(keyStat.mode & 0o077));
const privateKey = createPrivateKey(await readFile(keyPath));
const publicKey = createPublicKey(privateKey);
const qualificationSources = {};
for (const p of [
  "packages/runtime-pi/scripts/probe-foreground.mjs",
  "packages/runtime-sandbox/scripts/qualify-production.mjs",
  "packages/runtime-sandbox/scripts/probe-authorized-network.mjs",
  "packages/runtime-sandbox/scripts/probe-network-boundary.mjs",
  "packages/runtime-sandbox/scripts/probe-linux-worker-loss.mjs",
  "packages/runtime-sandbox/scripts/probe-public-search.mjs",
])
  qualificationSources[p] = await fileHash(root + "/builds/2026-09-11-experience/source/" + p);
const receipt = {
  qualificationSources,
  schema: "himawari-installed-foreground-receipt.v2",
  issuedAt: new Date().toISOString(),
  host: hostname(),
  platform: process.platform,
  architecture: process.arch,
  osRelease: release(),
  runtime,
  runtimeDigest,
  systemTools,
  artifacts,
  bindings,
  scope: {
    mode: "foreground",
    codingNetwork: "disabled",
    searchNetwork: ["mcp.exa.ai:443"],
    bashDirectoryOperations: ["read"],
    macAgentInstalled: false,
  },
  limitations: ["资源限制为观测后停止，不是硬配额", "搜索返回摘录，不代表打开网页全文"],
  source: JSON.parse(
    await readFile(root + "/builds/2026-09-11-experience/source-identity.json", "utf8"),
  ),
};
const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + "\n"),
  signature = sign(null, bytes, privateKey);
assert(verify(null, bytes, publicKey, signature));
await writeFile(
  q + "/host-qualification-public-key.pem",
  publicKey.export({ type: "spki", format: "pem" }),
  { mode: 0o600, flag: "wx" },
);
await writeFile(q + "/installation-receipt.json", bytes, { mode: 0o600, flag: "wx" });
await writeFile(q + "/installation-receipt.sig", signature, { mode: 0o600, flag: "wx" });
for (const { key, binding } of bindings)
  await writeFile(
    q + "/" + key + "-runner.sig",
    sign(null, await readFile(binding.runner.path), privateKey),
    { mode: 0o600, flag: "wx" },
  );
console.log(
  JSON.stringify({
    runtimeDigest,
    receiptDigest: hash(bytes),
    capabilities: bindings.map((x) => x.binding.capabilityRef),
  }),
);
