import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalJson as s0CanonicalJson, capabilityManifestInvariant as s0Invariant } from "../s0-db/read-s0-db.mjs";
import * as capabilityApi from "./cloud-capability-manifest.mjs";
import { assertCapabilityCompatibility, assertPrepareConfigurationIdentity, createCapabilityManifest, manifestInvariantDigest } from "./cloud-capability-manifest.mjs";

const oldRoot = "/fixture/releases/first/lib/himawari-agent";
const newRoot = "/fixture/releases/third/lib/himawari-agent";
const binding = (runtimeRoot) => ({
  capabilityRef: "himawari.pi-coding",
  capabilityVersion: "1.0.0",
  hostId: "himawari-prod-host",
  runtimeRoot,
  artifactDigest: `sha256:${"a".repeat(64)}`,
  executable: { path: runtimeRoot + "/pi-tools/bin/node" },
  runner: { path: runtimeRoot + "/node_modules/@himawari-agent/agent-service/dist/capability-programs/pi-coding-main.js", sha256: "a".repeat(64) },
  operationBindings: ["read", "write", "edit", "find", "grep", "ls", "bash"].map((operation) => ({ operation })),
  allowedDomains: [],
});
const options = {
  key: "pi",
  ownerId: "owner:first-production",
  deploymentId: "himawari-prod-deployment",
  workerInstanceId: "execution-worker:himawari-prod-deployment",
  signerRef: "host-signer:" + "b".repeat(64),
  issuedAt: "2026-10-09T00:00:00.000Z",
  observedAt: "2026-10-09T00:00:01.000Z",
};
const current = createCapabilityManifest({ ...options, binding: binding(newRoot) });
const previous = structuredClone(current);
previous.source.locator = "artifact:first-cloud-installed-pi";
previous.health.checkedAt = "2026-10-07T00:00:00.000Z";
previous.reviewedAt = "2026-10-07T00:00:00.000Z";
previous.runtime.argv[0] = oldRoot + "/pi-tools/bin/node";
previous.runtime.argv[1] = oldRoot + "/node_modules/@himawari-agent/agent-service/dist/capability-programs/pi-coding-main.js";
const previousDigest = manifestInvariantDigest(previous, oldRoot);
const results = [];
const test = (name, verify) => {
  try {
    verify();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
  }
};
const registeredTest = (ref, name, verify) => {
  if (!capabilityApi.newCapabilityRefs.includes(ref)) test(name, verify);
};
test("allows only exact runtime-prefix replacement and three observed fields", () => {
  assert.equal(manifestInvariantDigest(current, newRoot), previousDigest);
});
test("matches the independently used S0 invariant algorithm", () => {
  const expected = createHash("sha256").update(s0CanonicalJson(s0Invariant(current, newRoot))).digest("hex");
  assert.equal(manifestInvariantDigest(current, newRoot), expected);
});
test("preserves approved operations, version, artifact and policy fixture", () => {
  assert.deepEqual(current.operations, ["read", "write", "edit", "find", "grep", "ls", "bash"]);
  assert.equal(current.version, "1.0.0");
  assert.equal(current.integrity, `sha256:${"a".repeat(64)}`);
  assert.deepEqual(current.scopes, { dataClassifications: ["public", "private"], network: [], filesystem: ["workspace:himawari-prod-qualification"], secrets: [] });
  assert.deepEqual(current.cost, { currency: "USD", maxMicrosPerInvocation: 0 });
});
for (const [name, change] of [
  ["rejects operation expansion", (value) => value.operations.push("unknown")],
  ["rejects filesystem scope changes", (value) => value.scopes.filesystem.push("workspace:other")],
  ["rejects cost changes", (value) => value.cost.maxMicrosPerInvocation++],
  ["rejects capability version changes", (value) => value.version = "2.0.0"],
  ["rejects integrity changes", (value) => value.integrity = `sha256:${"c".repeat(64)}`],
  ["rejects runner path suffix changes", (value) => value.runtime.argv[1] += ".changed"],
  ["rejects Node path suffix changes", (value) => value.runtime.argv[0] += ".changed"],
  ["rejects host argument changes", (value) => value.runtime.argv[2] = "other-host"],
  ["rejects extra runner arguments", (value) => value.runtime.argv.push("--extra")],
  ["rejects runtime prefix lookalikes", (value) => value.runtime.argv[0] = newRoot + "-other/pi-tools/bin/node"],
  ["rejects secret scope changes", (value) => value.scopes.secrets.push("secret:other")],
  ["rejects permission changes", (value) => value.permissionRefs.push("permission:other")],
  ["rejects signer changes", (value) => value.artifact.signerRef = "host-signer:other"],
  ["rejects unknown declaration changes", (value) => value.unapproved = true],
]) {
  test(name, () => {
    const changed = structuredClone(current);
    change(changed);
    assert.notEqual(manifestInvariantDigest(changed, newRoot), previousDigest);
  });
}
const observation = {
  capabilityRef: current.ref,
  version: current.version,
  status: "active",
  activeHealthy: true,
  versionMatchesSnapshot: true,
  operationsMatchSnapshot: true,
  scopesMatchSnapshot: true,
  costMatchesSnapshot: true,
  secretRefsMatchSnapshot: true,
  permissionRefsMatchSnapshot: true,
  declarationMatchesSnapshotExceptArtifact: true,
  snapshotIntegrityMatchesRunner: true,
  storedIntegrityMatchesDeclaration: true,
  integrityMatchesSnapshot: true,
  declarationInvariantMatchesSnapshot: true,
  runnerMatchesRecorded: true,
  runnerSha256: "a".repeat(64),
  actualRunnerSha256: "a".repeat(64),
  manifestInvariantDigest: createHash("sha256").update(s0CanonicalJson(s0Invariant(previous, oldRoot))).digest("hex"),
  registryRecordSha256: "d".repeat(64),
};
registeredTest(current.ref, "accepts independently frozen old runner and unchanged catalog policy", () => {
  assertCapabilityCompatibility({ manifest: current, binding: binding(newRoot), observation });
});
for (const field of ["activeHealthy", "versionMatchesSnapshot", "operationsMatchSnapshot", "scopesMatchSnapshot", "costMatchesSnapshot", "secretRefsMatchSnapshot", "permissionRefsMatchSnapshot", "declarationMatchesSnapshotExceptArtifact", "snapshotIntegrityMatchesRunner", "storedIntegrityMatchesDeclaration", "runnerMatchesRecorded"]) {
  registeredTest(current.ref, "rejects unsuccessful S0 check " + field, () => {
    assert.throws(() => assertCapabilityCompatibility({ manifest: current, binding: binding(newRoot), observation: { ...observation, [field]: false } }), new RegExp("OLD_CAPABILITY_CHECK_FAILED:" + field));
  });
  registeredTest(current.ref, "rejects missing S0 check " + field, () => {
    const missing = { ...observation };
    delete missing[field];
    assert.throws(() => assertCapabilityCompatibility({ manifest: current, binding: binding(newRoot), observation: missing }), new RegExp("OLD_CAPABILITY_CHECK_FAILED:" + field));
  });
}
for (const field of ["integrityMatchesSnapshot", "declarationInvariantMatchesSnapshot"]) {
  registeredTest(current.ref, "rejects an S0 registry that no longer matches the previous snapshot " + field, () => {
    assert.throws(() => assertCapabilityCompatibility({ manifest: current, binding: binding(newRoot), observation: { ...observation, [field]: false } }), new RegExp("OLD_CAPABILITY_PREVIOUS_SHAPE_CHANGED:" + field));
  });
  registeredTest(current.ref, "rejects a missing previous-shape field " + field, () => {
    const missing = { ...observation };
    delete missing[field];
    assert.throws(() => assertCapabilityCompatibility({ manifest: current, binding: binding(newRoot), observation: missing }), new RegExp("OLD_CAPABILITY_PREVIOUS_SHAPE_CHANGED:" + field));
  });
}
for (const [field, value] of [["actualRunnerSha256", "e".repeat(64)], ["runnerSha256", "e".repeat(64)], ["manifestInvariantDigest", "e".repeat(64)], ["capabilityRef", "other-capability"], ["version", "2.0.0"], ["status", "disabled"]]) {
  registeredTest(current.ref, "rejects changed S0 binding " + field, () => {
    assert.throws(() => assertCapabilityCompatibility({ manifest: current, binding: binding(newRoot), observation: { ...observation, [field]: value } }));
  });
}
const registeredRunner = "e".repeat(64);
const registered = structuredClone(previous);
registered.integrity = `sha256:${registeredRunner}`;
registered.artifact.digest = registered.integrity;
const registeredObservation = { ...observation, runnerSha256: registeredRunner, actualRunnerSha256: registeredRunner, manifestInvariantDigest: createHash("sha256").update(s0CanonicalJson(s0Invariant(registered, oldRoot))).digest("hex") };
registeredTest(current.ref, "accepts a new runner when every other declaration field matches the registered capability", () => {
  const result = assertCapabilityCompatibility({ manifest: current, binding: binding(newRoot), observation: registeredObservation });
  assert.equal(result.runnerSha256, "a".repeat(64));
  assert.equal(result.registeredRunnerSha256, registeredRunner);
});
registeredTest(current.ref, "rejects a new runner whose manifest integrity names another artifact", () => {
  const changed = { ...binding(newRoot), runner: { ...binding(newRoot).runner, sha256: "f".repeat(64) } };
  assert.throws(() => assertCapabilityCompatibility({ manifest: current, binding: changed, observation: registeredObservation }), /NEW_MANIFEST_ARTIFACT_CHANGED/);
});
registeredTest(current.ref, "rejects an artifact digest that differs from the manifest integrity", () => {
  const changed = structuredClone(current);
  changed.artifact.digest = `sha256:${"f".repeat(64)}`;
  assert.throws(() => assertCapabilityCompatibility({ manifest: changed, binding: binding(newRoot), observation: registeredObservation }), /NEW_MANIFEST_ARTIFACT_CHANGED/);
});
for (const [name, change] of [
  ["operation expansion", (value) => value.operations.push("unknown")],
  ["network scope expansion", (value) => value.scopes.network.push("example.com")],
  ["runner argument changes", (value) => value.runtime.argv.push("--extra")],
  ["signer changes", (value) => value.artifact.signerRef = "host-signer:other"],
]) {
  registeredTest(current.ref, "rejects a new runner combined with " + name, () => {
    const changed = structuredClone(current);
    change(changed);
    assert.throws(() => assertCapabilityCompatibility({ manifest: changed, binding: binding(newRoot), observation: registeredObservation }), /NEW_CAPABILITY_POLICY_INCOMPATIBLE/);
  });
}
const webBinding = (capabilityRef, runnerName, operation, runtimeRoot, digest) => ({
  capabilityRef,
  capabilityVersion: "1.0.0",
  hostId: "himawari-prod-host",
  runtimeRoot,
  artifactDigest: `sha256:${digest}`,
  executable: { path: runtimeRoot + "/pi-tools/bin/node" },
  runner: { path: runtimeRoot + "/node_modules/@himawari-agent/agent-service/dist/capability-programs/" + runnerName, sha256: digest },
  operationBindings: [{ operation }],
  allowedDomains: [...capabilityApi.webNetwork],
});
const registeredWeb = (manifest, key, runnerName) => {
  const value = structuredClone(manifest);
  value.integrity = `sha256:${registeredRunner}`;
  value.artifact.digest = value.integrity;
  value.source.locator = "artifact:eleventh-cloud-installed-" + key;
  value.reviewedAt = "2026-10-25T00:00:00.000Z";
  value.runtime.argv[0] = oldRoot + "/pi-tools/bin/node";
  value.runtime.argv[1] = oldRoot + "/node_modules/@himawari-agent/agent-service/dist/capability-programs/" + runnerName;
  return { ...observation, capabilityRef: manifest.ref, runnerSha256: registeredRunner, actualRunnerSha256: registeredRunner, manifestInvariantDigest: createHash("sha256").update(s0CanonicalJson(s0Invariant(value, oldRoot))).digest("hex") };
};
test("__PKT_LABEL__ registers no new capability", () => {
  assert.deepEqual([...capabilityApi.newCapabilityRefs], __PKT_NEW_CAPABILITY_REFS_JSON__);
});
for (const [key, ref, runnerName, operation, digest] of [
  ["search", "himawari.public-search", "web-search-main.js", "web_search", "a".repeat(64)],
  ["fetch", "himawari.public-fetch", "web-fetch-main.js", "web_fetch", "9".repeat(64)],
]) {
  const webCurrent = createCapabilityManifest({ ...options, key, binding: webBinding(ref, runnerName, operation, newRoot, digest) });
  const webObservation = registeredWeb(webCurrent, key, runnerName);
  const bound = () => webBinding(ref, runnerName, operation, newRoot, digest);
  test(key + " manifest keeps both web domains and the DeepSeek secret", () => {
    assert.deepEqual(webCurrent.operations, [operation]);
    assert.deepEqual(webCurrent.scopes.network, ["mcp.exa.ai:443", "api.deepseek.com:443"]);
    assert.deepEqual(webCurrent.runtime.network, ["mcp.exa.ai:443", "api.deepseek.com:443"]);
    assert.deepEqual(webCurrent.scopes.secrets, ["deepseek-web"]);
  });
  registeredTest(ref, "accepts a plain " + key + " runner upgrade against the registered eleventh declaration", () => {
    const result = assertCapabilityCompatibility({ manifest: webCurrent, binding: bound(), observation: webObservation });
    assert.equal(result.runnerSha256, digest);
    assert.equal(result.registeredRunnerSha256, registeredRunner);
  });
  registeredTest(ref, "rejects " + key + " without an S0 registry observation", () => {
    assert.throws(() => assertCapabilityCompatibility({ manifest: webCurrent, binding: bound(), observation: undefined }), /FROZEN_CAPABILITY_OBSERVATION_REQUIRED/);
  });
  for (const [name, change] of [
    ["an extra network domain", (value) => { value.scopes.network.push("example.com:443"); value.runtime.network.push("example.com:443"); }],
    ["a dropped DeepSeek domain", (value) => { value.scopes.network = ["mcp.exa.ai:443"]; value.runtime.network = ["mcp.exa.ai:443"]; }],
    ["runtime network differing from scope network", (value) => { value.runtime.network = ["mcp.exa.ai:443"]; }],
    ["an extra secret", (value) => value.scopes.secrets.push("other-secret")],
    ["a dropped secret", (value) => { value.scopes.secrets = []; }],
    ["an extra operation", (value) => value.operations.push("unknown")],
    ["a cost change", (value) => value.cost.maxMicrosPerInvocation++],
    ["a filesystem scope change", (value) => value.scopes.filesystem.push("workspace:other")],
    ["a permission change", (value) => value.permissionRefs.push("permission:other")],
  ]) {
    registeredTest(ref, "rejects " + key + " upgrade with " + name, () => {
      const changed = structuredClone(webCurrent);
      change(changed);
      assert.throws(() => assertCapabilityCompatibility({ manifest: changed, binding: bound(), observation: webObservation }), /NEW_CAPABILITY_POLICY_INCOMPATIBLE/);
    });
  }
}
const firstShapes = [
  ["himawari.pi-coding", () => current, () => binding(newRoot)],
  ...[
    ["search", "himawari.public-search", "web-search-main.js", "web_search", "a".repeat(64)],
    ["fetch", "himawari.public-fetch", "web-fetch-main.js", "web_fetch", "9".repeat(64)],
  ].map(([key, ref, runnerName, operation, digest]) => [ref, () => createCapabilityManifest({ ...options, key, binding: webBinding(ref, runnerName, operation, newRoot, digest) }), () => webBinding(ref, runnerName, operation, newRoot, digest)]),
];
for (const [ref, makeManifest, makeBinding] of firstShapes) {
  if (!capabilityApi.newCapabilityRefs.includes(ref)) continue;
  test("first registration of " + ref + " accepts the approved shape without an S0 observation", () => {
    const result = assertCapabilityCompatibility({ manifest: makeManifest(), binding: makeBinding(), observation: undefined });
    assert.equal(result.registered, false);
    assert.equal(result.capabilityRef, ref);
  });
  test("first registration of " + ref + " rejects an existing S0 observation", () => {
    assert.throws(() => assertCapabilityCompatibility({ manifest: makeManifest(), binding: makeBinding(), observation }), /NEW_CAPABILITY_ALREADY_REGISTERED/);
  });
  for (const [name, change, code] of [
    ["an extra operation", (value) => value.operations.push("unknown"), /NEW_CAPABILITY_OPERATIONS_CHANGED/],
    ["a network change", (value) => { value.scopes.network.push("example.com:443"); }, /NEW_CAPABILITY_NETWORK_CHANGED/],
    ["a secret change", (value) => value.scopes.secrets.push("other-secret"), /NEW_CAPABILITY_SECRETS_CHANGED/],
    ["an integrity change", (value) => { value.integrity = `sha256:${"e".repeat(64)}`; }, /NEW_MANIFEST_ARTIFACT_CHANGED/],
  ]) {
    test("first registration of " + ref + " rejects " + name, () => {
      const changed = structuredClone(makeManifest());
      change(changed);
      assert.throws(() => assertCapabilityCompatibility({ manifest: changed, binding: makeBinding(), observation: undefined }), code);
    });
  }
}
registeredTest(current.ref, "rejects pi gaining a network scope", () => {
  const changed = structuredClone(current);
  changed.scopes.network.push("api.deepseek.com:443");
  assert.throws(() => assertCapabilityCompatibility({ manifest: changed, binding: binding(newRoot), observation: registeredObservation }), /NEW_CAPABILITY_POLICY_INCOMPATIBLE/);
});
const configuration = {
  ownerId: "owner:first-production",
  agentId: "agent:first-production",
  deploymentId: "himawari-prod-deployment",
  runPolicy: { read: { hostId: "himawari-prod-host", capabilityRef: current.ref, capabilityVersion: current.version, grantId: "grant:first" } },
};
const frozenIdentity = {
  ownerId: configuration.ownerId,
  agentId: configuration.agentId,
  deploymentId: configuration.deploymentId,
  authorizedRoots: [{ canonicalRootId: "1:2", canonicalPath: "/fixture/old-authorized-root", device: "1", inode: "2" }],
  authorizedDirectoryGrants: [{ routeKey: "read", ...configuration.runPolicy.read, expiresAt: "9999-01-01T00:00:00.000Z", revokedAt: null }],
};
for (const field of ["ownerId", "agentId", "deploymentId"]) {
  test("rejects changed permanent config identity " + field, () => {
    assert.throws(() => assertPrepareConfigurationIdentity({ ...configuration, [field]: "other" }, frozenIdentity));
  });
}
test("permits boot after a frozen directory grant naturally expires", () => {
  const expired = structuredClone(frozenIdentity);
  expired.authorizedDirectoryGrants[0].expiresAt = "2000-01-01T00:00:00.000Z";
  assertPrepareConfigurationIdentity(configuration, expired);
});
test("permits boot after a product-approved grant ID update", () => {
  const updated = structuredClone(configuration);
  updated.runPolicy.read.grantId = "grant:product-approved-renewal";
  assertPrepareConfigurationIdentity(updated, frozenIdentity);
});
test("does not widen or mutate signed roots while validating boot identity", () => {
  const before = JSON.stringify(frozenIdentity);
  assertPrepareConfigurationIdentity(configuration, frozenIdentity);
  assert.equal(JSON.stringify(frozenIdentity), before);
});
const prepareSource = await readFile(new URL("./cloud-protected-prepare.mjs", import.meta.url), "utf8");
test("formal prepare uses the identity guard and has no permanent frozen grant gate", () => {
  assert(prepareSource.includes("assertPrepareConfigurationIdentity(config, receipt.bindingInputs)"));
  assert(!prepareSource.includes("Date.parse(grant.expiresAt)"));
  assert(!prepareSource.includes("OLD_CONFIG_GRANT_ID_CHANGED"));
});
test("formal prepare keeps the existing route configuration and only replaces the capability snapshot", () => {
  assert.equal(capabilityApi.applyFirstSwitchConfiguration, undefined);
  assert.equal(capabilityApi.assertConfigurationChange, undefined);
  assert(!prepareSource.includes("applyFirstSwitchConfiguration"));
  assert(!prepareSource.includes("runPolicy"));
  assert.equal((prepareSource.match(/config\.capabilityDeployment = /g) ?? []).length, 1);
  assert.equal((prepareSource.match(/await rename\(configPath \+ "\.next", configPath\)/g) ?? []).length, 1);
});
test("formal prepare switches the configuration last and clears temporary files from an interrupted run", () => {
  const snapshotRename = prepareSource.indexOf('await rename(snapshotPath + ".next", snapshotPath);');
  const attestation = prepareSource.indexOf('mutable + "/startup-attestation.json"');
  const configRename = prepareSource.indexOf('await rename(configPath + ".next", configPath);');
  assert(snapshotRename > 0 && attestation > snapshotRename && configRename > attestation);
  assert(!/await (?:writeFile|rename|rm)\(/.test(prepareSource.slice(configRename + 1)));
  for (const target of ["snapshotPath", "configPath"]) {
    const clear = `await rm(${target} + ".next", { force: true });\nawait writeFile(${target} + ".next", `;
    assert.equal(prepareSource.split(clear).length, 2);
    assert.equal((prepareSource.match(new RegExp(`writeFile\\(${target} \\+ "\\.next"`, "g")) ?? []).length, 1);
  }
});
const report = { schema: "himawari-__PKT_LABEL__-capability-manifest-fixture.v1", productionQualificationIssued: false, passed: results.every((result) => result.passed), total: results.length, failed: results.filter((result) => !result.passed).length, results };
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
process.exitCode = report.passed ? 0 : 1;
