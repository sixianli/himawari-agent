import assert from "node:assert/strict";
import { lstatSync, readdirSync, statfsSync } from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";

assert(parentPort && typeof workerData.stateRoot === "string");
const stateRoot = workerData.stateRoot;
const backupId = workerData.backupId;
const errors = [];
const migrationBaseline = new Set();
try {
  for (const name of readdirSync(path.join(stateRoot, "data"))) if (name.startsWith("pre-migration-")) migrationBaseline.add(name);
} catch (error) {
  errors.push({ code: error.code ?? "SAMPLER_BASELINE_FAILED", stage: "baseline" });
}
const result = { startedAt: new Date().toISOString(), finishedAt: null, intervalMs: 100, samples: 0, initialRootAvailableBytes: null, minimumRootAvailableBytes: null, finalRootAvailableBytes: null, temporaryPeakBytes: 0, temporaryPeakAllocatedBytes: 0, observedTemporaryPaths: [], newlyCreatedMigrationSnapshotPeakBytes: 0, errors };
const observed = new Set();

function treeSize(filename) {
  try {
    const item = lstatSync(filename);
    assert(!item.isSymbolicLink(), "SAMPLER_SYMLINK_UNEXPECTED");
    if (item.isFile()) return { bytes: item.size, allocated: item.blocks * 512 };
    assert(item.isDirectory(), "SAMPLER_FILE_TYPE_UNEXPECTED");
    return readdirSync(filename).reduce((sum, name) => {
      const child = treeSize(path.join(filename, name));
      return { bytes: sum.bytes + child.bytes, allocated: sum.allocated + child.allocated };
    }, { bytes: 0, allocated: item.blocks * 512 });
  } catch (error) {
    if (error.code !== "ENOENT") errors.push({ code: error.code ?? "SAMPLER_TREE_FAILED", stage: "temporary-tree" });
    return { bytes: 0, allocated: 0 };
  }
}

function names(directory) {
  try {
    return readdirSync(directory);
  } catch (error) {
    if (error.code !== "ENOENT") errors.push({ code: error.code ?? "SAMPLER_DIRECTORY_FAILED", stage: "temporary-directory" });
    return [];
  }
}

function sample() {
  try {
    const disk = statfsSync("/");
    const available = disk.bavail * disk.bsize;
    result.initialRootAvailableBytes ??= available;
    result.minimumRootAvailableBytes = result.minimumRootAvailableBytes === null ? available : Math.min(result.minimumRootAvailableBytes, available);
    result.finalRootAvailableBytes = available;
    result.samples += 1;
    const temporaryPaths = [];
    if (typeof backupId === "string") {
      for (const name of names(path.join(stateRoot, "recovery-points"))) if (name.startsWith(`.${backupId}.create-`) || name.startsWith(`.${backupId}.verify-`)) temporaryPaths.push(path.join(stateRoot, "recovery-points", name));
      for (const name of names(stateRoot)) if (name.startsWith(`.restore-${backupId}-`) || name.startsWith(`.restore-previous-${backupId}-`)) temporaryPaths.push(path.join(stateRoot, name));
    }
    let totalBytes = 0;
    let totalAllocated = 0;
    for (const filename of temporaryPaths) {
      observed.add(filename);
      const size = treeSize(filename);
      totalBytes += size.bytes;
      totalAllocated += size.allocated;
    }
    result.temporaryPeakBytes = Math.max(result.temporaryPeakBytes, totalBytes);
    result.temporaryPeakAllocatedBytes = Math.max(result.temporaryPeakAllocatedBytes, totalAllocated);
    for (const name of names(path.join(stateRoot, "data"))) if (name.startsWith("pre-migration-") && !migrationBaseline.has(name)) result.newlyCreatedMigrationSnapshotPeakBytes = Math.max(result.newlyCreatedMigrationSnapshotPeakBytes, treeSize(path.join(stateRoot, "data", name)).bytes);
  } catch (error) {
    errors.push({ code: error.code ?? "SAMPLER_SPACE_FAILED", stage: "root-space" });
  }
}

sample();
parentPort.postMessage({ kind: "ready", initialErrors: [...errors] });
const interval = setInterval(sample, 100);
parentPort.once("message", (message) => {
  assert.equal(message.kind, "stop");
  clearInterval(interval);
  sample();
  result.finishedAt = new Date().toISOString();
  result.observedTemporaryPaths = [...observed].sort();
  parentPort.postMessage({ kind: "result", result });
  parentPort.close();
});
