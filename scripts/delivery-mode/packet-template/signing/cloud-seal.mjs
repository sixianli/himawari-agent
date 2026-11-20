import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { hostname, release } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateR2l6Installed } from "./validate-r2l6-installed.mjs";
import { validateSystemToolBindings } from "./cloud-system-tool-bindings.mjs";
import { assertCapabilityCompatibility, createCapabilityManifest, newCapabilityRefs, webNetwork, webProviderSecretRef } from "./cloud-capability-manifest.mjs";

const root = "/var/lib/himawari",
  prefix = "/opt/himawari/releases/__PKT_DATE__-__PKT_LABEL__",
  runtime = prefix + "/lib/himawari-agent",
  q = root + "/qualification/__PKT_LABEL__-__PKT_DATE_COMPACT__";
const inputPath = q + "/binding-inputs.json";
const inputInfo = await lstat(inputPath);
assert(inputInfo.isFile() && !inputInfo.isSymbolicLink() && inputInfo.uid === 0 && !(inputInfo.mode & 0o022));
assert.equal(await realpath(inputPath), inputPath);
const input = JSON.parse(await readFile(inputPath, "utf8"));
assert.equal(input.schema, "himawari-__PKT_LABEL__-cloud-binding-inputs.v1");
assert(input.expectedHostname && !input.expectedHostname.startsWith("REPLACE_"));
assert(Number.isSafeInteger(input.acceptanceUid) && input.acceptanceUid > 0);
for (const field of ["hostId", "deploymentId", "workerInstanceId", "ownerId", "agentId"])
  assert(typeof input[field] === "string" && input[field].length > 0 && !input[field].startsWith("REPLACE_"), "FROZEN_ORIGINAL_RUNTIME_IDENTITY_REQUIRED");
assert.equal(input.workspace, root + "/qualification-workspace-__PKT_LABEL__-__PKT_DATE_COMPACT__");
assert.equal(input.qualificationWorkspaceRef, "workspace:himawari-prod-__PKT_LABEL__-qualification");
assert.equal(input.runtime, runtime);
assert.equal(input.privateRoot, root + "/jobs");
process.umask(0o077);
const hash = (b) => createHash("sha256").update(b).digest("hex"),
  fileHash = async (p) => hash(await readFile(p));
assert.equal(hostname(), input.expectedHostname);
assert.equal(process.getuid(), 0, "ROOT_SIGNING_STEP_REQUIRED");
assert.equal(process.platform, "linux");
async function readStableInput(filename, uid) {
  const before = await lstat(filename, { bigint: true });
  assert(before.isFile() && !before.isSymbolicLink() && before.uid === BigInt(uid) && before.nlink === 1n && !(before.mode & 0o022n), "GRANT_SIGNING_INPUT_UNSAFE");
  assert.equal(await realpath(filename), filename, "GRANT_SIGNING_INPUT_NONCANONICAL");
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    const opened = await handle.stat({ bigint: true }), current = await lstat(filename, { bigint: true });
    const identity = (info) => [info.dev, info.ino, info.uid, info.gid, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs].map(String);
    assert.deepEqual(identity(opened), identity(before), "GRANT_SIGNING_INPUT_CHANGED");
    assert.deepEqual(identity(current), identity(before), "GRANT_SIGNING_INPUT_CHANGED");
    return bytes;
  } finally {
    await handle.close();
  }
}
const packetRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const frozenPath = path.join(packetRoot, "inputs/bindings.json"), s0Path = path.join(packetRoot, "inputs/s0-db-readback.json");
const frozenBytes = await readStableInput(frozenPath, 0), s0Bytes = await readStableInput(s0Path, 0);
const frozen = JSON.parse(frozenBytes);
assert.equal(frozen.schemaVersion, "himawari.__PKT_LABEL__-change-bindings.v1");
assert.equal(frozen.status, "frozen-approved");
assert.equal(hash(frozenBytes), input.frozenBindingsSha256, "GRANT_FROZEN_BINDINGS_CHANGED");
assert.equal(hash(s0Bytes), input.authorizationObservationSha256, "GRANT_ORIGINAL_S0_CHANGED");
assert.equal(input.originalConfigurationSha256, frozen.service.oldConfigSha256, "GRANT_ORIGINAL_CONFIGURATION_CHANGED");
assert.match(input.originalConfigurationSha256, /^[a-f0-9]{64}$/);
const validatorPath = path.join(packetRoot, "signing/workspace-grant-binding.py");
const validatorEntry = input.acceptanceFiles["signing/workspace-grant-binding.py"];
assert.equal(validatorEntry.path, validatorPath, "GRANT_VALIDATOR_PATH_CHANGED");
assert.equal(hash(await readStableInput(validatorPath, 0)), validatorEntry.sha256, "GRANT_VALIDATOR_BYTES_CHANGED");
const grantVerification = JSON.parse(execFileSync("/usr/bin/python3", ["-I", validatorPath, "--verify-binding", inputPath, frozenPath, s0Path], { encoding: "utf8", timeout: 15000, maxBuffer: 1048576, env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" } }));
assert.equal(grantVerification.passed, true, "GRANT_SIGNING_VERIFICATION_FAILED");
assert.equal(grantVerification.originalConfigurationSha256, input.originalConfigurationSha256);
assert.equal(grantVerification.grantId, input.workspaceGrant.grantId, "GRANT_SIGNING_GRANT_CHANGED");
if (process.argv[2] === "--preflight") {
  assert.equal(process.argv.length, 3);
  const workspace = input.workspace,
    metadata = await stat(workspace);
  assert(metadata.isDirectory());
  assert.equal(await realpath(workspace), workspace);
  const keyPath = root + "/qualification/signing/host-qualification-signing-key.pem";
  const info = await lstat(keyPath);
  assert(info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o077) && info.uid === 0);
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
const { digestSandboxRuntime } = await import(
  pathToFileURL(runtime + "/node_modules/@himawari-agent/platform-node/dist/index.js").href
);
const observations = {},
  artifacts = {};
for (const name of [
  "pi-installed",
  "composition-installed",
  "network-installed",
  "boundary-installed",
  "worker-loss-installed",
  "web-search-installed",
  "r2l6-installed",
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
const r2l6 = await validateR2l6Installed({ runtime, reportPath: q + "/r2l6-installed.json" });
assert.equal(r2l6.reportSha256, artifacts["r2l6-installed"]);
assert.equal(observations["r2l6-installed"].input.artifactSha256, input.candidate.artifactSha256);
assert.equal(observations["r2l6-installed"].input.contextSha256, input.candidate.contextSha256);
const acceptanceEvidence = {};
async function readAcceptanceEvidence(directory) {
  for (const name of await readdir(directory)) {
    const entry = path.join(directory, name);
    const info = await lstat(entry);
    assert(!info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022));
    assert.equal(await realpath(entry), entry);
    if (info.isDirectory()) await readAcceptanceEvidence(entry);
    else {
      assert(info.isFile());
      acceptanceEvidence[path.relative(q + "/acceptance-evidence", entry)] = await fileHash(entry);
    }
  }
}
await readAcceptanceEvidence(q + "/acceptance-evidence");
for (const filename of ["run-report.json", "acceptance-report.json", "resources.jsonl", "proc.jsonl", "r2l6/controller.json", "r2l6/commands.json", "r2l6/audits.json", "r2l6/original-marker.bin", "owned-processes.json", "scratch-cleanup-decision.json", "bwrap-identities.json", "composition-source-preparation.json", "composition-source-after.json", "composition-source-copy.json", "transport-node-modules-proof.json"])
  assert(Object.hasOwn(acceptanceEvidence, filename), "ACCEPTANCE_EVIDENCE_MISSING:" + filename);
const run = JSON.parse(await readFile(q + "/acceptance-evidence/run-report.json", "utf8"));
assert.equal(run.passed, true);
assert.equal(run.profile, "cloud-__PKT_LABEL__-change");
assert.equal(run.hostname, input.expectedHostname);
assert.equal(run.acceptanceUid, input.acceptanceUid);
assert.equal(run.productionQualificationIssued, false);
assert.equal(run.scratchDeleted, true);
assert.equal(run.scratchCleanupPending, false);
assert.deepEqual(run.runnerErrors, []);
assert.deepEqual(run.scratchCleanupProcessReadback.liveDescendants, []);
assert.equal(run.scratchCleanupReferenceReadback.deleteAllowed, true);
assert.equal(run.scratchCleanupReferenceReadback.exitCode, 0);
const acceptance = JSON.parse(await readFile(q + "/acceptance-evidence/acceptance-report.json", "utf8"));
assert.equal(acceptance.passed, true);
assert.equal(acceptance.profile, "cloud-__PKT_LABEL__-change");
assert.equal(acceptance.hostname, input.expectedHostname);
assert.equal(acceptance.acceptanceUid, input.acceptanceUid);
assert.equal(acceptance.runtime, runtime);
assert.equal(acceptance.sourceRoot, input.compositionSourceRoot);
assert.equal(acceptance.productionQualificationIssued, false);
assert.equal(acceptance.runtimeDigestBefore, r2l6.runtimeDigest);
assert.equal(acceptance.runtimeDigestAfter, r2l6.runtimeDigest);
assert.equal(acceptance.inputManifestSha256, input.acceptanceInputsSha256);
assert.equal(input.acceptanceFiles["cloud-inputs.json"].sha256, input.acceptanceInputsSha256);
for (const name of Object.keys(artifacts))
  assert.equal(acceptanceEvidence[name + ".json"], artifacts[name], "ACCEPTANCE_REPORT_COPY_CHANGED");
const runtimeDigest = await digestSandboxRuntime(runtime),
  executable = runtime + "/pi-tools/bin/node";
assert.equal(runtimeDigest, r2l6.runtimeDigest);
const jobHost = runtime + "/node_modules/@himawari-agent/runtime-sandbox/dist/job-host-main.js";
assert.equal(await fileHash(jobHost), observations["network-installed"].runnerDigest);
assert.equal(await fileHash(jobHost), observations["boundary-installed"].jobHostDigest);
for (const [name, digest] of Object.entries(observations["pi-installed"].toolDigests))
  assert.equal(await fileHash(runtime + "/pi-tools/bin/" + name), digest);
assert.deepEqual(input.systemToolPaths, {
  bwrap: "/usr/bin/bwrap", socat: "/usr/bin/socat", bash: "/usr/bin/bash", rg: "/usr/bin/rg",
});
for (const observed of Object.values(input.systemToolIdentities)) {
  assert.equal(observed.identity.uid, 0, "ROOT_SYSTEM_TOOL_REQUIRED");
  for (const link of observed.links) assert.equal(link.identity.uid, 0, "ROOT_SYSTEM_TOOL_LINK_REQUIRED");
}
const { systemTools, systemToolBindings } = await validateSystemToolBindings(input.systemToolPaths, input.systemToolIdentities);
assert.equal(input.systemToolPaths.bwrap, "/usr/bin/bwrap");
assert.equal(input.bwrapPaths.srt, "/usr/bin/bwrap");
assert.equal(input.bwrapPaths.program, "/usr/local/libexec/bubblewrap-0.11.2/bwrap");
const bwrapBindings = {};
for (const [backend, executablePath, profilePath] of [
  ["srt", input.bwrapPaths.srt, "/etc/apparmor.d/bwrap"],
  ["program", input.bwrapPaths.program, "/etc/apparmor.d/bwrap-0.11.2"],
]) {
  const executableRealpath = await realpath(executablePath);
  const executableInfo = await lstat(executableRealpath);
  assert(executableInfo.isFile() && !executableInfo.isSymbolicLink() && executableInfo.uid === 0 && !(executableInfo.mode & 0o022) && executableInfo.mode & 0o111);
  const versionOutput = execFileSync(executableRealpath, ["--version"], { encoding: "utf8", timeout: 15000 }).trim();
  const version = /^bubblewrap (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(versionOutput);
  assert(version, "BWRAP_VERSION_UNRECOGNIZED");
  if (backend === "program") {
    const [major, minor, patch] = version.slice(1).map(Number);
    assert(major > 0 || minor > 11 || minor === 11 && patch >= 2, "PROGRAM_STDIO_BWRAP_MINIMUM_VERSION_REQUIRED");
  }
  const profileInfo = await lstat(profilePath);
  assert(profileInfo.isFile() && !profileInfo.isSymbolicLink() && profileInfo.uid === 0 && !(profileInfo.mode & 0o022));
  const observed = acceptance.bwrapIdentities[backend];
  assert.equal(observed.requestedPath, executablePath);
  assert.equal(observed.realpath, executableRealpath);
  assert.equal(observed.versionOutput, versionOutput);
  if (backend === "program") assert.equal(observed.minimumSatisfied, true);
  assert.equal(observed.sha256, await fileHash(executableRealpath));
  assert.equal(observed.apparmorProfile.path, profilePath);
  assert.equal(observed.apparmorProfile.present, true);
  assert.equal(observed.apparmorProfile.sha256, await fileHash(profilePath));
  systemTools[executableRealpath] = observed.sha256;
  systemTools[profilePath] = observed.apparmorProfile.sha256;
  bwrapBindings[backend] = observed;
}
const compositionContractPath = input.acceptanceFiles["composition-source-contract.json"].path;
const compositionContract = JSON.parse(await readFile(compositionContractPath, "utf8"));
const compositionAfter = JSON.parse(await readFile(q + "/acceptance-evidence/composition-source-after.json", "utf8"));
const compositionPrepared = JSON.parse(await readFile(q + "/acceptance-evidence/composition-source-preparation.json", "utf8"));
const compositionCopy = JSON.parse(await readFile(q + "/acceptance-evidence/composition-source-copy.json", "utf8"));
assert.match(run.scratch, /^\/tmp\/h[A-Za-z0-9]{4}$/);
assert.equal(acceptance.compositionExecutionSourceRoot, run.scratch + "/source");
assert.equal(input.compositionExecutionSourceRoot, acceptance.compositionExecutionSourceRoot);
assert.equal(acceptanceEvidence["composition-source-copy.json"], input.compositionSourceCopySha256);
assert.deepEqual(compositionCopy, acceptance.compositionSourceCopy);
assert.equal(compositionCopy.schemaVersion, "himawari.__PKT_LABEL__-change-composition-source-copy.v1");
assert.equal(compositionCopy.inputSourceRoot, input.compositionSourceRoot);
assert.equal(compositionCopy.workingSourceRoot, input.compositionExecutionSourceRoot);
assert.equal(compositionCopy.sourceHead, input.candidate.revision);
assert.equal(compositionCopy.nodeModulesProofSha256, input.nodeModulesProofSha256);
assert.equal(compositionCopy.ownerUid, input.acceptanceUid);
for (const field of ["passed", "allTrackedBytesAndModesMatchedInput", "allDependencyEntriesMatchedProof"])
  assert.equal(compositionCopy[field], true);
const transportProof = JSON.parse(await readFile(q + "/acceptance-evidence/transport-node-modules-proof.json", "utf8"));
assert.equal(transportProof.sourceHead, input.candidate.revision);
assert.deepEqual(compositionCopy.dependencyRoots, transportProof.dependencyRoots);
assert.equal(compositionCopy.dependencyEntryCount, transportProof.entries.length);
assert(Number.isSafeInteger(compositionCopy.sourceFileCount) && compositionCopy.sourceFileCount > 0);
assert.match(compositionCopy.trackedSourceSha256, /^[a-f0-9]{64}$/);
for (const observed of [acceptance.compositionSource, compositionPrepared, compositionAfter]) {
  assert.equal(observed.passed, true);
  assert.equal(observed.revision, input.candidate.revision);
  assert.equal(observed.sourceRoot, input.compositionExecutionSourceRoot);
  assert.deepEqual(observed.changedFiles, [compositionContract.fixture]);
  for (const field of ["originalFixtureSha256", "adaptedFixtureSha256", "patchSha256", "entrySha256"])
    assert.equal(observed[field], compositionContract[field]);
  assert.equal(observed.packageLockSha256, transportProof.packageLockSha256, "COMPOSITION_WORKING_LOCK_CHANGED");
  assert.equal(observed.unchangedAssertionsDeadlinesAndProductImports, true);
}
assert.equal(acceptance.compositionSource.checkedOnly, false);
assert.equal(acceptance.compositionSource.cleanBeforePreparation, true);
assert.equal(compositionAfter.checkedOnly, true);
assert.equal(acceptance.compositionSource.passed, true);
assert.equal(acceptance.compositionSource.revision, input.candidate.revision);
assert.equal(acceptance.compositionSource.sourceRoot, input.compositionExecutionSourceRoot);
assert.equal(acceptance.compositionSource.unchangedAssertionsDeadlinesAndProductImports, true);
assert.equal(acceptance.transportNodeModulesProofSha256, input.nodeModulesProofSha256);
assert.equal(acceptanceEvidence["transport-node-modules-proof.json"], input.nodeModulesProofSha256);
const workspace = input.workspace,
  metadata = await lstat(workspace);
assert(metadata.isDirectory() && !metadata.isSymbolicLink());
assert.equal(await realpath(workspace), workspace);
assert.equal(metadata.uid, input.acceptanceUid);
assert.equal(metadata.mode & 0o7777, 0o700);
assert.deepEqual(input.workspaceIdentity, {
  path: workspace,
  device: String(metadata.dev),
  inode: String(metadata.ino),
  uid: metadata.uid,
  gid: metadata.gid,
  mode: "0700",
});
assert(Array.isArray(input.authorizedDirectoryGrants) && input.authorizedDirectoryGrants.length === 1, "NEW_DIRECTORY_GRANT_REQUIRED");
assert(Array.isArray(input.authorizedRoots) && input.authorizedRoots.length === 1, "NEW_AUTHORIZED_ROOT_REQUIRED");
assert.equal(new Set(input.authorizedRoots.map((entry) => entry.canonicalRootId)).size, input.authorizedRoots.length);
assert(!input.authorizedRoots.some((entry) => entry.canonicalPath === workspace || entry.canonicalRootId === String(metadata.dev) + ":" + String(metadata.ino)), "PRODUCTION_AND_QUALIFICATION_ROOTS_MUST_DIFFER");
for (const grant of input.authorizedDirectoryGrants) {
  assert.equal(grant.hostId, input.hostId);
  assert.equal(grant.revokedAt, null, "NEW_DIRECTORY_GRANT_REVOKED");
  assert(Date.parse(grant.expiresAt) > Date.now(), "NEW_DIRECTORY_GRANT_EXPIRED");
  for (const field of ["readAllowed", "hostMatchesRoute", "currentlyUsable"])
    assert.equal(grant[field], true, "NEW_DIRECTORY_GRANT_CHECK_FAILED:" + field);
  assert.equal(grant.grantId, input.workspaceGrant.grantId, "EXISTING_DIRECTORY_GRANT_ID_CHANGED");
  assert(input.authorizedRoots.some((entry) => entry.canonicalRootId === grant.canonicalRootId && entry.canonicalPath === grant.displayPath && entry.device === grant.device && entry.inode === grant.inode), "NEW_DIRECTORY_GRANT_ROOT_CHANGED");
}
for (const authorizedRoot of input.authorizedRoots) {
  const info = await lstat(authorizedRoot.canonicalPath);
  assert(info.isDirectory() && !info.isSymbolicLink());
  assert.equal(await realpath(authorizedRoot.canonicalPath), authorizedRoot.canonicalPath);
  assert.equal(info.uid, input.acceptanceUid);
  assert.equal(info.gid, metadata.gid);
  assert.equal(info.mode & 0o7777, 0o700);
  assert.equal(String(info.dev), authorizedRoot.device, "NEW_AUTHORIZED_ROOT_DEVICE_CHANGED");
  assert.equal(String(info.ino), authorizedRoot.inode, "NEW_AUTHORIZED_ROOT_INODE_CHANGED");
}
const base = {
  schemaVersion: "sandbox-host-binding.v1",
  capabilityVersion: "1.0.0",
  hostId: input.hostId,
  profileRef: "authorized-project.v1",
  runtimeRoot: runtime,
  runtimeDigest,
  executable: { path: executable, sha256: await fileHash(executable) },
  privateRoot: input.privateRoot,
  roots: [
    ...input.authorizedRoots,
    {
      canonicalRootId: String(metadata.dev) + ":" + String(metadata.ino),
      canonicalPath: workspace,
      device: String(metadata.dev),
      inode: String(metadata.ino),
    },
  ],
  readOnlyToolchainPaths: [
    ...new Set([
      ...(await Promise.all(
        [
          runtime,
          "/usr/bin",
          "/usr/lib",
          "/usr/share",
          "/lib",
          __PKT_LIB64_ITEM__
          "/dev",
          "/proc",
          "/etc/ssl",
          "/etc/hosts",
          "/etc/fonts",
          "/var/cache/fontconfig",
          "/etc/alternatives",
          "/usr/sbin",
        ].map((p) => realpath(p)),
      )),
      ...(
        await Promise.all(
          ["/etc/mime.types", "/etc/magic", "/etc/locale.alias", "/etc/ld.so.cache"].map((p) =>
            realpath(p).catch((error) => {
              if (error?.code === "ENOENT") return null;
              throw error;
            }),
          ),
        )
      ).filter(Boolean),
    ]),
  ],
  protectedPaths: [
    root + "/state",
    "/etc/himawari",
    root + "/qualification",
    "/var/tmp/himawari-__PKT_LABEL__-__PKT_DATE_COMPACT__/input",
    root + "/logs",
    "/opt/himawari/operations/__PKT_LABEL__-__PKT_DATE_COMPACT__",
    workspace + "/.env",
    workspace + "/.git",
    ...input.authorizedRoots.flatMap((entry) => [entry.canonicalPath + "/.env", entry.canonicalPath + "/.git"]),
  ],
  maximumResourceCeiling: {
    maxWallTimeMs: 1800000,
    maxCpuTimeMs: 1800000,
    maxMemoryBytes: 1073741824,
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
  ["search", "himawari.public-search", "web-search-main.js", ["web_search"], [...webNetwork]],
  ["fetch", "himawari.public-fetch", "web-fetch-main.js", ["web_fetch"], [...webNetwork]],
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
        contract: key === "pi"
          ? {
              ref: "pi-coding-tool",
              version: "1",
              kind: operation === "bash" ? "command" : ["write", "edit"].includes(operation) ? "verified_effect" : "fixed_read",
              ...(["write", "edit"].includes(operation) ? { verifierRef: "pi-atomic-write", verifierVersion: "1", targetRef: "pi-input:path" } : {}),
            }
          : { ref: key === "search" ? "public-web-search" : "public-web-fetch", version: "1", kind: "network_only" },
        backendRef: "srt",
        scopeSource: key === "pi" ? "grant_targets" : "private_temp",
        directoryOperations:
          key !== "pi"
            ? []
            : operation === "write" || operation === "bash"
              ? ["read", "create", "update"]
              : operation === "edit"
                ? ["read", "update"]
                : ["read"],
        network: key === "pi" ? "disabled" : "grant_targets",
      })),
    },
  });
}
const keyPath = root + "/qualification/signing/host-qualification-signing-key.pem";
const keyStat = await lstat(keyPath);
assert(keyStat.isFile() && !keyStat.isSymbolicLink() && !(keyStat.mode & 0o077) && keyStat.uid === 0);
const privateKey = createPrivateKey(await readFile(keyPath));
const publicKey = createPublicKey(privateKey);
const firstPublicKeyPath = root + "/qualification/first-20261007/host-qualification-public-key.pem";
const firstPublicKeyInfo = await lstat(firstPublicKeyPath);
assert(firstPublicKeyInfo.isFile() && !firstPublicKeyInfo.isSymbolicLink() && firstPublicKeyInfo.uid === 0 && !(firstPublicKeyInfo.mode & 0o022));
assert.equal(await realpath(firstPublicKeyPath), firstPublicKeyPath);
const firstPublicKey = createPublicKey(await readFile(firstPublicKeyPath));
assert.equal(hash(publicKey.export({ type: "spki", format: "der" })), hash(firstPublicKey.export({ type: "spki", format: "der" })), "FIRST_SIGNING_KEY_REQUIRED");
const signerRef = "host-signer:" + hash(publicKey.export({ type: "spki", format: "der" }));
const existingRefs = bindings.map(({ binding }) => binding.capabilityRef).filter((ref) => !newCapabilityRefs.includes(ref)).sort();
assert(Array.isArray(input.persistentCapabilityObservations) && input.persistentCapabilityObservations.length === existingRefs.length, "FROZEN_CAPABILITY_OBSERVATIONS_REQUIRED");
assert.deepEqual(input.persistentCapabilityObservations.map((entry) => entry.capabilityRef).sort(), existingRefs, "FROZEN_CAPABILITY_OBSERVATIONS_REQUIRED");
const capabilityCompatibility = [];
for (const { key, binding } of bindings) {
  const manifest = createCapabilityManifest({ key, binding, ownerId: input.ownerId, workerInstanceId: input.workerInstanceId, signerRef, issuedAt: new Date().toISOString(), observedAt: new Date().toISOString() });
  capabilityCompatibility.push(assertCapabilityCompatibility({ manifest, binding, observation: input.persistentCapabilityObservations.find((entry) => entry.capabilityRef === manifest.ref) }));
}
const qualificationSources = {};
const requiredSources = [
  "packages/runtime-pi/scripts/probe-foreground.mjs",
  "packages/runtime-sandbox/scripts/qualify-production.mjs",
  "packages/runtime-sandbox/scripts/probe-authorized-network.mjs",
  "packages/runtime-sandbox/scripts/probe-network-boundary.mjs",
  "packages/runtime-sandbox/scripts/probe-linux-worker-loss.mjs",
  "packages/runtime-sandbox/scripts/probe-public-search.mjs",
  "test/qualification/sandbox-install-restart-probe.mjs",
  "test/qualification/sandbox-install-restart-controller.py",
  "test/qualification/sandbox-install-restart-model.mjs",
  "test/qualification/sandbox-install-restart-http.mjs",
  "scripts/operations/workspace-lifecycle-audit.mjs",
];
for (const source of requiredSources) {
  const entry = input.qualificationSources[source];
  assert(entry && path.isAbsolute(entry.path));
  assert.match(entry.sha256, /^[a-f0-9]{64}$/);
  assert.equal(await realpath(entry.path), entry.path);
  const sourceInfo = await lstat(entry.path);
  assert(sourceInfo.isFile() && !sourceInfo.isSymbolicLink() && sourceInfo.uid === 0 && !(sourceInfo.mode & 0o022));
  qualificationSources[source] = await fileHash(entry.path);
  assert.equal(qualificationSources[source], entry.sha256, "QUALIFICATION_SOURCE_CHANGED");
}
assert.equal(observations["r2l6-installed"].auditScriptSha256, qualificationSources["scripts/operations/workspace-lifecycle-audit.mjs"]);
const acceptanceSources = {};
for (const [name, entry] of Object.entries(input.acceptanceFiles)) {
  assert(path.isAbsolute(entry.path));
  assert.equal(await realpath(entry.path), entry.path);
  const info = await lstat(entry.path);
  assert(info.isFile() && !info.isSymbolicLink() && info.uid === 0 && !(info.mode & 0o022));
  acceptanceSources[name] = await fileHash(entry.path);
  assert.equal(acceptanceSources[name], entry.sha256, "ACCEPTANCE_SOURCE_CHANGED");
}
assert.equal(acceptanceSources["inputs/s0-db-readback.json"], input.authorizationObservationSha256, "FROZEN_AUTHORIZATION_OBSERVATION_CHANGED");
assert.equal(acceptanceSources["inputs/bindings.json"], input.frozenBindingsSha256, "FROZEN_DEPLOYMENT_BINDINGS_CHANGED");
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
  systemToolBindings,
  bwrapBindings,
  artifacts,
  bindings,
  capabilityCompatibility,
  r2l6Installed: r2l6,
  acceptanceSources,
  acceptanceEvidence,
  bindingInputs: input,
  scope: {
    mode: "foreground",
    codingNetwork: "disabled",
    searchNetwork: [...webNetwork],
    fetchNetwork: [...webNetwork],
    webProviderSecrets: [webProviderSecretRef],
    bashDirectoryOperations: ["read", "create", "update"],
    macAgentInstalled: false,
  },
  limitations: ["资源限制为观测后停止，不是硬配额", "搜索返回摘录，不代表打开网页全文", "读网页只返回长度受限的正文"],
  source: input.candidate,
};
await validateSystemToolBindings(input.systemToolPaths, input.systemToolIdentities);
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
