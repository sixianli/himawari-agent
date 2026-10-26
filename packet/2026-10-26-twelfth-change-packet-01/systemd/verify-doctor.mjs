import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const dependencyKeys = ["authority", "schema", "sqlite", "payload", "worker", "memory", "identity"];
const resultKeys = ["schemaVersion", "command", "deploymentId", "configurationSchema", "ready", "dependencies"];

export function verifyDoctor(result, deploymentId) {
  assert(result !== null && typeof result === "object" && !Array.isArray(result), "TWELFTH_DOCTOR_OBJECT_REQUIRED");
  assert.deepEqual(Object.keys(result).sort(), [...resultKeys].sort(), "TWELFTH_DOCTOR_FIELDS_CHANGED");
  assert.equal(result.schemaVersion, 1, "TWELFTH_DOCTOR_SCHEMA_CHANGED");
  assert.equal(result.command, "doctor", "TWELFTH_DOCTOR_COMMAND_CHANGED");
  assert.equal(result.deploymentId, deploymentId, "TWELFTH_DOCTOR_DEPLOYMENT_CHANGED");
  assert.equal(result.configurationSchema, "himawari.configuration.v1", "TWELFTH_DOCTOR_CONFIG_SCHEMA_CHANGED");
  assert(result.dependencies !== null && typeof result.dependencies === "object" && !Array.isArray(result.dependencies), "TWELFTH_DOCTOR_DEPENDENCIES_REQUIRED");
  assert.deepEqual(Object.keys(result.dependencies).sort(), [...dependencyKeys].sort(), "TWELFTH_DOCTOR_DEPENDENCY_SET_CHANGED");
  for (const key of dependencyKeys.filter((key) => key !== "identity"))
    assert.equal(result.dependencies[key], "available", "TWELFTH_DOCTOR_DEPENDENCY_UNAVAILABLE:" + key);
  assert.equal(result.dependencies.identity, "unavailable", "TWELFTH_DOCTOR_KNOWN_IDENTITY_RESULT_CHANGED");
  assert.equal(result.ready, false, "TWELFTH_DOCTOR_KNOWN_READY_RESULT_CHANGED");
  return { passed: true, knownDefect: "BL-20261008-007", ready: false, dependencies: result.dependencies };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 4, "TWELFTH_DOCTOR_INPUT_AND_DEPLOYMENT_REQUIRED");
  const result = JSON.parse(readFileSync(process.argv[2] === "-" ? 0 : process.argv[2], "utf8"));
  process.stdout.write(JSON.stringify(verifyDoctor(result, process.argv[3])) + "\n");
}
