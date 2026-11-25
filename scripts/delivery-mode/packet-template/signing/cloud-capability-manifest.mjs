import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export const webProviderSecretRef = "deepseek-web";
export const webNetwork = Object.freeze(["mcp.exa.ai:443", "api.deepseek.com:443"]);
export const newCapabilityRefs = Object.freeze(__PKT_NEW_CAPABILITY_REFS_JSON__);
const displayNames = Object.freeze({ pi: "已授权目录 Pi 工具", search: "公开网页搜索（Exa）", fetch: "公开网页读取" });

export function createCapabilityManifest({ key, binding, ownerId, workerInstanceId, signerRef, issuedAt, observedAt }) {
  return {
    manifestVersion: "capability.v2",
    ref: binding.capabilityRef,
    displayName: displayNames[key],
    version: binding.capabilityVersion,
    source: { type: "program", locator: "artifact:__PKT_LABEL__-cloud-installed-" + key },
    sourceIdentity: "host:" + binding.hostId,
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
      filesystem: ["workspace:himawari-prod-qualification"],
      secrets: key === "pi" ? [] : [webProviderSecretRef],
    },
    cost: { currency: "USD", maxMicrosPerInvocation: 0 },
    health: { status: "healthy", checkedAt: observedAt },
    reviewedBy: ownerId,
    reviewedAt: issuedAt,
    contractCompatibility: ["capability-conformance.v1"],
    runtime: {
      kind: "program",
      argv: [
        binding.executable.path,
        binding.runner.path,
        binding.hostId,
        workerInstanceId,
      ],
      environmentKeys: [],
      workdirRef: "workspace:himawari-prod-qualification",
      stdin: "protected_payload",
      stdout: "protected_payload",
      subprocesses: [],
      network: binding.allowedDomains,
      filesystem: ["workspace:himawari-prod-qualification"],
    },
  };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function manifestInvariantDigest(manifest, runtimeRoot) {
  assert(typeof runtimeRoot === "string" && runtimeRoot.startsWith("/"), "__PKT_LABEL_UPPER___MANIFEST_RUNTIME_ROOT_INVALID");
  const invariant = structuredClone(manifest);
  if (invariant.source) delete invariant.source.locator;
  if (invariant.health) delete invariant.health.checkedAt;
  delete invariant.reviewedAt;
  if (Array.isArray(invariant.runtime?.argv)) invariant.runtime.argv = invariant.runtime.argv.map((value, index) => index < 2 && typeof value === "string" && (value === runtimeRoot || value.startsWith(`${runtimeRoot}/`)) ? `<runtime>${value.slice(runtimeRoot.length)}` : value);
  return createHash("sha256").update(canonicalJson(invariant)).digest("hex");
}

const newCapabilityShapes = Object.freeze({
  "himawari.pi-coding": Object.freeze({ operations: Object.freeze(["read", "write", "edit", "find", "grep", "ls", "bash"]), network: Object.freeze([]), secrets: Object.freeze([]) }),
  "himawari.public-search": Object.freeze({ operations: Object.freeze(["web_search"]), network: webNetwork, secrets: Object.freeze([webProviderSecretRef]) }),
  "himawari.public-fetch": Object.freeze({ operations: Object.freeze(["web_fetch"]), network: webNetwork, secrets: Object.freeze([webProviderSecretRef]) }),
});

function assertNewCapability({ manifest, binding, observation }) {
  assert.equal(observation, undefined, "NEW_CAPABILITY_ALREADY_REGISTERED");
  const shape = newCapabilityShapes[manifest.ref];
  assert(shape, "NEW_CAPABILITY_UNKNOWN");
  assert.deepEqual(manifest.operations, [...shape.operations], "NEW_CAPABILITY_OPERATIONS_CHANGED");
  assert.match(binding.runner.sha256, /^[a-f0-9]{64}$/, "NEW_RUNNER_DIGEST_INVALID");
  assert.equal(manifest.integrity, "sha256:" + binding.runner.sha256, "NEW_MANIFEST_ARTIFACT_CHANGED");
  assert.equal(manifest.artifact?.digest, manifest.integrity, "NEW_MANIFEST_ARTIFACT_CHANGED");
  assert.deepEqual(manifest.scopes.network, [...shape.network], "NEW_CAPABILITY_NETWORK_CHANGED");
  assert.deepEqual(manifest.runtime.network, [...shape.network], "NEW_CAPABILITY_NETWORK_CHANGED");
  assert.deepEqual(manifest.scopes.secrets, [...shape.secrets], "NEW_CAPABILITY_SECRETS_CHANGED");
  return { capabilityRef: manifest.ref, version: manifest.version, runnerSha256: binding.runner.sha256, registered: false };
}

export function assertCapabilityCompatibility({ manifest, binding, observation }) {
  if (newCapabilityRefs.includes(manifest.ref)) return assertNewCapability({ manifest, binding, observation });
  assert(observation && typeof observation === "object", "FROZEN_CAPABILITY_OBSERVATION_REQUIRED");
  assert.equal(observation.capabilityRef, manifest.ref, "OLD_CAPABILITY_REF_CHANGED");
  assert.equal(observation.version, manifest.version, "OLD_CAPABILITY_VERSION_CHANGED");
  assert.equal(observation.status, "active", "OLD_CAPABILITY_NOT_ACTIVE");
  for (const field of ["activeHealthy", "versionMatchesSnapshot", "operationsMatchSnapshot", "scopesMatchSnapshot", "costMatchesSnapshot", "secretRefsMatchSnapshot", "permissionRefsMatchSnapshot", "declarationMatchesSnapshotExceptArtifact", "snapshotIntegrityMatchesRunner", "storedIntegrityMatchesDeclaration", "runnerMatchesRecorded"]) assert.equal(observation[field], true, "OLD_CAPABILITY_CHECK_FAILED:" + field);
  for (const field of ["integrityMatchesSnapshot", "declarationInvariantMatchesSnapshot"]) assert.equal(observation[field], true, "OLD_CAPABILITY_PREVIOUS_SHAPE_CHANGED:" + field);
  assert.match(observation.runnerSha256, /^[a-f0-9]{64}$/);
  assert.match(observation.actualRunnerSha256, /^[a-f0-9]{64}$/);
  assert.match(observation.manifestInvariantDigest, /^[a-f0-9]{64}$/);
  assert.match(observation.registryRecordSha256, /^[a-f0-9]{64}$/);
  assert.equal(observation.actualRunnerSha256, observation.runnerSha256, "OLD_RUNNER_RECORDED_DIGEST_CHANGED");
  assert.match(binding.runner.sha256, /^[a-f0-9]{64}$/, "NEW_RUNNER_DIGEST_INVALID");
  assert.equal(manifest.integrity, "sha256:" + binding.runner.sha256, "NEW_MANIFEST_ARTIFACT_CHANGED");
  assert.equal(manifest.artifact?.digest, manifest.integrity, "NEW_MANIFEST_ARTIFACT_CHANGED");
  const registeredArtifact = "sha256:" + observation.actualRunnerSha256;
  const registeredShape = { ...manifest, integrity: registeredArtifact, artifact: { ...manifest.artifact, digest: registeredArtifact } };
  assert.equal(manifestInvariantDigest(registeredShape, binding.runtimeRoot), observation.manifestInvariantDigest, "NEW_CAPABILITY_POLICY_INCOMPATIBLE");
  return { capabilityRef: manifest.ref, version: manifest.version, runnerSha256: binding.runner.sha256, registeredRunnerSha256: observation.actualRunnerSha256, manifestInvariantDigest: observation.manifestInvariantDigest, registryRecordSha256: observation.registryRecordSha256 };
}

export function assertPrepareConfigurationIdentity(config, bindingInputs) {
  for (const field of ["ownerId", "agentId", "deploymentId"]) {
    assert(typeof bindingInputs[field] === "string" && bindingInputs[field].length > 0, "FROZEN_CONFIG_IDENTITY_REQUIRED:" + field);
    assert.equal(config[field], bindingInputs[field], "SIGNED_CONFIG_IDENTITY_CHANGED:" + field);
  }
}
