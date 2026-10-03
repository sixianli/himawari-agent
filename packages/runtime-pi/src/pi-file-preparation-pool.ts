import type { Worker } from "node:worker_threads";
import {
  createPiPreparationWorker,
  handoffPiPreparationWorker,
  type PiFilePreparationRequest,
  piPreparationMilliseconds,
  piPreparationResourceLimits,
  stopPiPreparationWorker,
} from "./prepare-file-mutation.ts";

const warmupMilliseconds = 8000;
const maximumWarmupAttempts = 3;

type WarmSlot = {
  readonly worker: Worker;
  phase: "warming" | "ready" | "consumed" | "stopping";
  timer: ReturnType<typeof setTimeout> | undefined;
};

export function createPiFilePreparationPool(options: {
  readonly maxMemoryBytes: number;
  readonly onWarmupFailure?: (error: Error) => void;
  readonly onWarmupReady?: () => void;
}) {
  const limits = piPreparationResourceLimits(options.maxMemoryBytes);
  const owned = new Set<Worker>();
  const requests = new Set<Promise<unknown>>();
  const shutdown = new AbortController();
  let slot: WarmSlot | undefined;
  let failures = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  const reportFailure = (error: Error) => {
    failures += 1;
    options.onWarmupFailure?.(error);
    if (!closed && failures < maximumWarmupAttempts)
      retry = setTimeout(startWarmup, 1000 * failures);
  };

  const failWarmup = (entry: WarmSlot, error: Error) => {
    if (entry.phase === "consumed" || entry.phase === "stopping") return;
    entry.phase = "stopping";
    clearTimeout(entry.timer);
    entry.timer = undefined;
    void stopPiPreparationWorker(entry.worker).then(
      () => {
        owned.delete(entry.worker);
        if (slot === entry) slot = undefined;
        if (!closed) reportFailure(error);
      },
      (terminationError: unknown) => {
        if (!closed)
          options.onWarmupFailure?.(terminationError instanceof Error ? terminationError : error);
      },
    );
  };

  function startWarmup() {
    retry = undefined;
    if (closed || slot) return;
    const deadline = performance.now() + warmupMilliseconds;
    let worker: Worker;
    try {
      worker = createPiPreparationWorker(options.maxMemoryBytes, true);
    } catch (error) {
      reportFailure(error instanceof Error ? error : new Error("PI_PREPARATION_WARMUP_FAILED"));
      return;
    }
    const entry: WarmSlot = { worker, phase: "warming", timer: undefined };
    slot = entry;
    owned.add(worker);
    entry.timer = setTimeout(
      () => {
        failWarmup(entry, new Error("PI_PREPARATION_WARMUP_TIME_LIMIT"));
      },
      Math.max(0, deadline - performance.now()),
    );
    worker.on("message", (message: unknown) => {
      if (entry.phase !== "warming") return;
      if (message && typeof message === "object" && "kind" in message && message.kind === "ready") {
        if (performance.now() >= deadline) {
          failWarmup(entry, new Error("PI_PREPARATION_WARMUP_TIME_LIMIT"));
          return;
        }
        clearTimeout(entry.timer);
        entry.timer = undefined;
        entry.phase = "ready";
        options.onWarmupReady?.();
      } else {
        failWarmup(entry, new Error("PI_PREPARATION_WARMUP_PROTOCOL_INVALID"));
      }
    });
    worker.once("error", (error) => failWarmup(entry, error));
    worker.once("exit", () => failWarmup(entry, new Error("PI_PREPARATION_WORKER_EXITED")));
  }

  startWarmup();

  return {
    async prepare(input: PiFilePreparationRequest) {
      if (closed) throw new Error("PI_PREPARATION_POOL_CLOSED");
      const milliseconds = piPreparationMilliseconds(input);
      const requestedLimits = piPreparationResourceLimits(input.limits.maxMemoryBytes);
      const matches = Object.entries(limits).every(
        ([key, value]) => requestedLimits[key as keyof typeof requestedLimits] === value,
      );
      const entry = slot?.phase === "ready" && matches ? slot : undefined;
      if (entry) entry.phase = "consumed";
      const worker = entry?.worker ?? createPiPreparationWorker(input.limits.maxMemoryBytes);
      owned.add(worker);
      const signal = input.signal
        ? AbortSignal.any([input.signal, shutdown.signal])
        : shutdown.signal;
      const request = handoffPiPreparationWorker(worker, { ...input, signal }, milliseconds);
      requests.add(request);
      try {
        const result = await request;
        if (signal.aborted) throw new Error("PI_PREPARATION_CANCELLED");
        return result;
      } finally {
        requests.delete(request);
        owned.delete(worker);
        if (entry && slot === entry) {
          slot = undefined;
          failures = 0;
          if (!closed) startWarmup();
        }
      }
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      clearTimeout(retry);
      retry = undefined;
      if (slot) {
        clearTimeout(slot.timer);
        slot.timer = undefined;
        slot.phase = "stopping";
      }
      shutdown.abort();
      closing = (async () => {
        await Promise.all([...owned].map(stopPiPreparationWorker));
        await Promise.allSettled([...requests]);
        owned.clear();
        slot = undefined;
      })();
      return closing;
    },
  };
}
