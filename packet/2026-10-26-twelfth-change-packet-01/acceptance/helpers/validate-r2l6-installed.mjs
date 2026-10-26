import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const r2l6AssertionIds = Object.freeze([
  "original_started",
  "old_pair_exited",
  "new_pair_same_state",
  "cleanup_unknown_occupied",
  "conflict_queued_not_admitted",
  "conflict_cancelled",
  "original_not_replayed",
  "trusted_release",
  "new_admission",
  "owned_cleanup",
]);

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function validateR2l6Installed({ runtime, reportPath }) {
  assert.equal(process.platform, "linux", "R2L6_VALIDATOR_LINUX_REQUIRED");
  assert(path.isAbsolute(runtime), "R2L6_RUNTIME_ABSOLUTE_REQUIRED");
  assert(path.isAbsolute(reportPath), "R2L6_REPORT_ABSOLUTE_REQUIRED");
  assert.equal(await realpath(runtime), runtime, "R2L6_RUNTIME_CANONICAL_REQUIRED");
  assert((await lstat(runtime)).isDirectory(), "R2L6_RUNTIME_DIRECTORY_REQUIRED");
  const reportBytes = await readFile(reportPath);
  const report = JSON.parse(reportBytes);
  assert.equal(report.schemaVersion, "r2-l6-installed-recovery.v1");
  assert.equal(report.passed, true);
  assert.equal(report.nonProduction, true);
  assert.equal(report.productionQualificationIssued, false);
  assert.equal(report.installedRuntime, runtime);
  assert.equal(report.input.runtimeRoot, runtime);
  assert(Array.isArray(report.assertions));
  assert.deepEqual(
    report.assertions.map(({ id }) => id).sort(),
    [...r2l6AssertionIds].sort(),
    "R2L6_ASSERTION_SET_CHANGED",
  );
  assert(report.assertions.every(({ passed }) => passed === true));
  assert.equal(report.cleanup.completed, true);
  assert.equal(report.cleanup.taskTreesReleased, true);
  assert.deepEqual(report.cleanup.ownedProcessesRemaining, []);
  assert.equal(report.failure, undefined);
  assert.equal(report.runtimeIntegrityFailure, undefined);
  assert(Number.isFinite(report.fault.freezeDurationMs) && report.fault.freezeDurationMs <= 250);
  assert(Number.isFinite(report.fault.remainingDeadlineMs) && report.fault.remainingDeadlineMs >= 1500);
  assert.equal(report.fault.remainingDeadlineMeasurementPoint, "both-processes-state-T");
  assert.equal(report.fault.preflight.directMarker.passed, true);
  assert.equal(report.fault.preflight.directProcesses.passed, true);
  assert.equal(report.fault.preflight.frozenProduct.passed, true);
  assert.equal(report.qualification.nonProduction, true);
  assert.equal(report.qualification.runtimeDigest, report.runtimeDigestBefore);
  assert.equal(report.controller.executable, "/usr/bin/python3");
  assert.equal(report.controller.isolated, 1);
  assert.equal(report.controller.pidfdOpen, true);
  assert.equal(report.controller.pidfdSendSignal, true);
  const platform = await import(
    pathToFileURL(path.join(runtime, "node_modules/@himawari-agent/platform-node/dist/index.js")).href
  );
  const runtimeDigest = await platform.digestSandboxRuntime(runtime);
  assert.match(runtimeDigest, /^[a-f0-9]{64}$/);
  assert.equal(report.runtimeDigestBefore, report.runtimeDigestAfter);
  assert.equal(report.runtimeDigestBefore, runtimeDigest);
  const files = {
    jobHostDigest: "node_modules/@himawari-agent/runtime-sandbox/dist/job-host-main.js",
    agentServiceMainDigest: "node_modules/@himawari-agent/agent-service/dist/main.js",
    bashDigest: "pi-tools/bin/bash",
  };
  const fileDigests = {};
  for (const [field, relative] of Object.entries(files)) {
    const file = path.join(runtime, relative);
    const info = await lstat(file);
    assert(info.isFile() && !info.isSymbolicLink(), "R2L6_RUNTIME_FILE_UNSAFE");
    assert.equal(await realpath(file), file);
    if (field === "bashDigest") assert((info.mode & 0o111) !== 0);
    fileDigests[field] = hash(await readFile(file));
    assert.equal(report[field], fileDigests[field], `R2L6_${field}_MISMATCH`);
  }
  return {
    schema: "r2-l6-installed-readonly-validation.v1",
    passed: true,
    nonProduction: true,
    productionQualificationIssued: false,
    checkedAt: new Date().toISOString(),
    installedRuntime: runtime,
    runtimeDigest,
    reportSha256: hash(reportBytes),
    ...fileDigests,
    assertions: [...r2l6AssertionIds],
    freezeDurationMs: report.fault.freezeDurationMs,
    remainingDeadlineMs: report.fault.remainingDeadlineMs,
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const options = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    assert(["--runtime", "--report"].includes(key) && value && !options[key]);
    options[key] = value;
  }
  assert.deepEqual(Object.keys(options).sort(), ["--report", "--runtime"]);
  try {
    const result = await validateR2l6Installed({
      runtime: options["--runtime"],
      reportPath: options["--report"],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ passed: false, error: String(error) })}\n`);
    process.exitCode = 1;
  }
}
