import assert from "node:assert/strict";
import { verifyDoctor } from "../verify-doctor.mjs";

const deploymentId = "himawari-prod-deployment";
const valid = {
  schemaVersion: 1,
  command: "doctor",
  deploymentId,
  configurationSchema: "himawari.configuration.v1",
  ready: false,
  dependencies: {
    authority: "available",
    schema: "available",
    sqlite: "available",
    payload: "available",
    worker: "available",
    memory: "available",
    identity: "unavailable",
  },
};
const rejected = [];
function reject(name, change) {
  const value = structuredClone(valid);
  change(value);
  rejected.push({ name, value });
}
for (const key of Object.keys(valid.dependencies)) {
  reject("missing dependency " + key, (value) => { delete value.dependencies[key]; });
  reject("wrong dependency " + key, (value) => { value.dependencies[key] = "unsafe"; });
}
for (const key of ["authority", "schema", "sqlite", "payload", "worker", "memory"]) {
  reject("extra unavailable " + key, (value) => { value.dependencies[key] = "unavailable"; });
  reject("unexpected optional " + key, (value) => { value.dependencies[key] = "not-required"; });
}
reject("extra dependency", (value) => { value.dependencies.extra = "available"; });
reject("extra top field", (value) => { value.extra = true; });
reject("ready true", (value) => { value.ready = true; });
reject("identity available", (value) => { value.dependencies.identity = "available"; });
reject("identity optional", (value) => { value.dependencies.identity = "not-required"; });
reject("different deployment", (value) => { value.deploymentId = "other"; });
reject("different schema", (value) => { value.configurationSchema = "unknown"; });
reject("different command", (value) => { value.command = "db.status"; });
reject("different version", (value) => { value.schemaVersion = 2; });
reject("dependency array", (value) => { value.dependencies = []; });
rejected.push({ name: "null", value: null }, { name: "array", value: [] });
const accepted = verifyDoctor(valid, deploymentId);
assert.deepEqual(accepted, { passed: true, knownDefect: "BL-20261008-007", ready: false, dependencies: valid.dependencies });
for (const item of rejected) assert.throws(() => verifyDoctor(item.value, deploymentId), undefined, item.name);
process.stdout.write(JSON.stringify({ passed: true, accepted: 1, rejected: rejected.length, scope: "doctor-output-contract-fixture-only" }) + "\n");
