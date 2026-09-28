import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync } from "node:fs";

const context = new AsyncLocalStorage();
let sequence = 0;
export function record(value) {
  const destination = process.env.HIMAWARI_TEST_TIMING_OUTPUT;
  if (destination)
    appendFileSync(
      destination,
      `${JSON.stringify({ pid: process.pid, at: Date.now(), ...value })}\n`,
      { mode: 0o600 },
    );
}
export function measure(stage, identity, action) {
  const parent = context.getStore();
  const id = `${process.pid}:${++sequence}`;
  const started = performance.now();
  const at = Date.now();
  const cpu = process.cpuUsage();
  const jobId = identity?.jobId ?? parent?.jobId ?? null;
  const runId = identity?.runId ?? parent?.runId ?? null;
  const finish = (outcome) =>
    record({
      kind: "span",
      id,
      parent: parent?.id ?? null,
      stage,
      jobId,
      runId,
      startedAt: at,
      durationMs: performance.now() - started,
      cpu: process.cpuUsage(cpu),
      outcome,
    });
  return context.run({ id, jobId, runId }, () => {
    try {
      const value = action();
      if (value && typeof value.then === "function")
        return value.then(
          (result) => {
            finish("returned");
            return result;
          },
          (error) => {
            finish("threw");
            throw error;
          },
        );
      finish("returned");
      return value;
    } catch (error) {
      finish("threw");
      throw error;
    }
  });
}
