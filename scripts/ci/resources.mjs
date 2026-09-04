import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { redactText } from "./redact-text.mjs";

const run = promisify(execFile);
const failureDetailsLimit = 32;
const outputBytesLimit = 4096;

function diagnosticOutput(value, scopes) {
  const original = String(value ?? "");
  let normalized = original;
  for (const { directory, label } of [...scopes].sort(
    (left, right) => right.directory.length - left.directory.length,
  ))
    normalized = normalized.replaceAll(directory, `<${label}>`);
  const redacted = Buffer.from(redactText(normalized));
  let text = redacted.subarray(0, outputBytesLimit).toString("utf8");
  while (Buffer.byteLength(text) > outputBytesLimit) text = text.slice(0, -1);
  return {
    text,
    originalBytes: Buffer.byteLength(original),
    redactedBytes: redacted.length,
    truncated: redacted.length > outputBytesLimit,
  };
}

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
  if (temporaryDirectory)
    scopes.push({ label: "temporary", directory: path.resolve(temporaryDirectory) });
  const record = {
    schemaVersion: 2,
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
      attempts: 0,
      samples: 0,
      failedSamples: 0,
      firstBytes: null,
      peakBytes: null,
      lastBytes: null,
    })),
    failureCount: 0,
    failureDetailsLimit,
    droppedFailureCount: 0,
    errors: [],
    pauses: { count: 0, totalDurationMs: 0, droppedDetailsCount: 0, entries: [] },
    startedAt: new Date().toISOString(),
  };
  let pending;
  let paused = false;
  let closing = false;
  let activePause;
  let stopPromise;
  let sampleId = 0;
  const sample = (phase) => {
    if (phase !== "final" && (paused || closing)) return Promise.resolve();
    if (pending) return pending;
    const id = ++sampleId;
    pending = Promise.all(
      scopes.map(async ({ directory, label }, index) => {
        const startedAt = new Date().toISOString();
        const started = performance.now();
        const scope = record.scopes[index];
        scope.attempts += 1;
        let stdout = "";
        let stderr = "";
        let exitedSuccessfully = false;
        try {
          ({ stdout, stderr } = await run("du", ["-sk", directory], {
            timeout: 30000,
            maxBuffer: 1024 * 1024,
          }));
          exitedSuccessfully = true;
          const kib = Number(/^\s*(\d+)\s/u.exec(stdout)?.[1]);
          const bytes = kib * 1024;
          if (!Number.isSafeInteger(kib) || !Number.isSafeInteger(bytes))
            throw Object.assign(new Error("INVALID_DISK_SAMPLE"), {
              code: "INVALID_DISK_SAMPLE",
            });
          scope.firstBytes ??= bytes;
          scope.lastBytes = bytes;
          scope.peakBytes = Math.max(scope.peakBytes ?? 0, bytes);
          scope.samples += 1;
        } catch (error) {
          scope.failedSamples += 1;
          record.failureCount += 1;
          if (record.errors.length < failureDetailsLimit) {
            record.errors.push({
              scope: label,
              sampleId: id,
              phase,
              startedAt,
              completedAt: new Date().toISOString(),
              durationMs: Math.round(performance.now() - started),
              exitCode: Number.isInteger(error.code) ? error.code : exitedSuccessfully ? 0 : null,
              errorCode: typeof error.code === "string" ? error.code : null,
              signal: error.signal ?? null,
              killed: error.killed === true,
              stdout: diagnosticOutput(error.stdout ?? stdout, scopes),
              stderr: diagnosticOutput(error.stderr ?? stderr, scopes),
            });
          } else record.droppedFailureCount += 1;
        }
      }),
    ).finally(() => {
      pending = undefined;
    });
    return pending;
  };
  await sample("initial");
  const startTimer = () => {
    const interval = setInterval(() => sample("interval"), intervalMs);
    interval.unref();
    return interval;
  };
  let timer = startTimer();
  const withPausedSampling = (reason, operation) => {
    if (closing) return Promise.reject(new Error("RESOURCE_OBSERVER_STOPPING"));
    if (paused) return Promise.reject(new Error("RESOURCE_PAUSE_ALREADY_ACTIVE"));
    if (
      typeof reason !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(reason) ||
      typeof operation !== "function"
    )
      return Promise.reject(new Error("RESOURCE_PAUSE_ARGUMENT_INVALID"));
    paused = true;
    clearInterval(timer);
    const startedAt = new Date().toISOString();
    const started = performance.now();
    record.pauses.count += 1;
    const action = (async () => {
      let outcome = "passed";
      try {
        await pending;
        return await operation();
      } catch (error) {
        outcome = "failed";
        throw error;
      } finally {
        const durationMs = Math.round(performance.now() - started);
        record.pauses.totalDurationMs += durationMs;
        if (record.pauses.entries.length < failureDetailsLimit)
          record.pauses.entries.push({
            reason,
            startedAt,
            completedAt: new Date().toISOString(),
            durationMs,
            outcome,
          });
        else record.pauses.droppedDetailsCount += 1;
        paused = false;
        activePause = undefined;
        if (!closing) timer = startTimer();
      }
    })();
    // The operation's rejection belongs to its caller. stop still waits for its
    // settlement and produces the final resource report after a cleanup failure.
    activePause = action.then(
      () => undefined,
      () => undefined,
    );
    return action;
  };
  const stop = () => {
    if (stopPromise) return stopPromise;
    closing = true;
    clearInterval(timer);
    stopPromise = (async () => {
      await activePause;
      await pending;
      await sample("final");
      return {
        ...record,
        completedAt: new Date().toISOString(),
        status: record.failureCount ? "incomplete" : "measured",
      };
    })();
    return stopPromise;
  };
  return { stop, withPausedSampling };
}
