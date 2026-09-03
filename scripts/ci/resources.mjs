import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function observeResources({
  root,
  toolsDirectory,
  temporaryDirectory,
  intervalMs = 30000,
}) {
  const scopes = [{ label: "workspace", directory: path.resolve(root) }];
  const tools = toolsDirectory && path.resolve(toolsDirectory);
  if (tools && path.relative(scopes[0].directory, tools).startsWith(".."))
    scopes.push({ label: "tools", directory: tools });
  if (temporaryDirectory) scopes.push({ label: "temporary", directory: temporaryDirectory });
  const record = {
    schemaVersion: 1,
    method: "sampled-allocated-disk-du-kib",
    intervalMs,
    peakIsLowerBound: true,
    hardware: {
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? "unavailable",
      memoryBytes: os.totalmem(),
    },
    scopes: scopes.map(({ label }) => ({
      label,
      samples: 0,
      firstBytes: null,
      peakBytes: null,
      lastBytes: null,
    })),
    errors: [],
    startedAt: new Date().toISOString(),
  };
  let pending;
  const sample = () => {
    if (pending) return pending;
    pending = Promise.all(
      scopes.map(async ({ directory, label }, index) => {
        try {
          const { stdout } = await run("du", ["-sk", directory], {
            timeout: 30000,
            maxBuffer: 1024 * 1024,
          });
          const kib = Number(/^\s*(\d+)\s/u.exec(stdout)?.[1]);
          if (!Number.isSafeInteger(kib)) throw new Error("INVALID_DISK_SAMPLE");
          const bytes = kib * 1024;
          const scope = record.scopes[index];
          scope.firstBytes ??= bytes;
          scope.lastBytes = bytes;
          scope.peakBytes = Math.max(scope.peakBytes ?? 0, bytes);
          scope.samples += 1;
        } catch (error) {
          const message = `${label}:${error.code ?? "INVALID_DISK_SAMPLE"}`;
          if (!record.errors.includes(message)) record.errors.push(message);
        }
      }),
    ).finally(() => {
      pending = undefined;
    });
    return pending;
  };
  await sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await pending;
    await sample();
    return {
      ...record,
      completedAt: new Date().toISOString(),
      status: record.errors.length ? "incomplete" : "measured",
    };
  };
}
