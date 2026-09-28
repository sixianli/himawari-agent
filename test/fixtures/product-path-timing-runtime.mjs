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
export function failure(error) {
  const codes = new Set([
    "PORT_CONFLICT",
    "PORT_NOT_AUTHORITATIVE",
    "PORT_HANDLE_REVOKED",
    "PORT_INVALID_OPERATION",
    "PORT_NOT_FOUND",
    "EPERM",
    "EACCES",
    "ENOENT",
    "ETIMEDOUT",
  ]);
  const reasons = new Map([
    ["resource sequence changed", "SANDBOX_RESOURCE_SEQUENCE_CHANGED"],
    ["receipt unavailable", "SANDBOX_RECEIPT_UNAVAILABLE"],
    ["authority changed", "SANDBOX_AUTHORITY_CHANGED"],
    ["reconciliation binding mismatch", "SANDBOX_RECONCILIATION_BINDING_MISMATCH"],
    ["Capability invocation receipt has expired", "SANDBOX_RECEIPT_EXPIRED"],
    ["Sandbox job exceeds its consumed invocation", "SANDBOX_INVOCATION_EXPIRED"],
    ["Observation replay changed", "SANDBOX_OBSERVATION_REPLAY_CHANGED"],
    ["SANDBOX_RECONCILIATION_SEQUENCE_CHANGED", "SANDBOX_RECONCILIATION_SEQUENCE_CHANGED"],
    ["SANDBOX_RECONCILIATION_OWNERSHIP_CHANGED", "SANDBOX_RECONCILIATION_OWNERSHIP_CHANGED"],
    ["WORKER_DEADLINE_EXCEEDED", "WORKER_DEADLINE_EXCEEDED"],
    ["SANDBOX_STREAM_SEQUENCE_INVALID", "SANDBOX_STREAM_SEQUENCE_INVALID"],
  ]);
  return {
    systemCode: codes.has(error?.code) ? error.code : "UNKNOWN",
    machineReason: reasons.get(error?.message) ?? "UNKNOWN",
    validationError: error?.name === "ContractValidationError",
  };
}
export function measure(stage, identity, action) {
  const parent = context.getStore();
  const id = `${process.pid}:${++sequence}`;
  const started = performance.now();
  const at = Date.now();
  const cpu = process.cpuUsage();
  const jobId = identity?.jobId ?? parent?.jobId ?? null;
  const runId = identity?.runId ?? parent?.runId ?? null;
  const finish = (outcome, error) =>
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
      ...(outcome === "threw" ? { failure: failure(error) } : {}),
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
            finish("threw", error);
            throw error;
          },
        );
      finish("returned");
      return value;
    } catch (error) {
      finish("threw", error);
      throw error;
    }
  });
}
