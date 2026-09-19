import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { awaitPiPreparationWorker } from "../src/prepare-file-mutation.ts";

it.each(["timeout", "cancel"] as const)(
  "stops running synchronous computation on %s before settling",
  async (reason) => {
    const progress = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(
      `
    const { parentPort, workerData } = require("node:worker_threads");
    const progress = new Int32Array(workerData);
    Atomics.add(progress, 0, 1);
    parentPort.postMessage({kind: "started"});
    while (true) Atomics.add(progress, 0, 1);
  `,
      { eval: true, workerData: progress.buffer },
    );
    const started = once(worker, "message");
    const controller = new AbortController();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const result = awaitPiPreparationWorker(worker, 1000, controller.signal);
      const rejected = expect(result).rejects.toThrow(
        reason === "timeout" ? "PI_PREPARATION_TIME_LIMIT" : "PI_PREPARATION_CANCELLED",
      );
      await started;
      expect(Atomics.load(progress, 0)).toBeGreaterThan(0);
      expect(worker.threadId).toBeGreaterThan(0);
      if (reason === "timeout") vi.advanceTimersByTime(1000);
      else controller.abort();
      await rejected;
      // Node sets -1 only when the worker is no longer running. A rejected promise
      // alone is insufficient evidence that synchronous computation stopped.
      expect(worker.threadId).toBe(-1);
    } finally {
      vi.useRealTimers();
      await worker.terminate();
    }
  },
);
