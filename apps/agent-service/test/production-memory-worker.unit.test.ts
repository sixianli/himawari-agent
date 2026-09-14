import { describe, expect, it, vi } from "vitest";
import { ProductionMemoryWorker } from "../src/production-memory-worker.js";

describe("production Memory consumer", () => {
  it("does not claim a job when shutdown begins during the authority check", async () => {
    let release = () => {};
    const batch = vi.fn(async () => []);
    const worker = new ProductionMemoryWorker({
      service: { runProjectionBatch: batch },
      assertActive: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      onFailure() {},
    });
    const starting = worker.start();
    worker.stopAccepting();
    release();
    await starting;
    await worker.drain();
    expect(batch).not.toHaveBeenCalled();
  });

  it("checks authority before each claim and stops after authority loss", async () => {
    vi.useFakeTimers();
    try {
      const batch = vi.fn(async () => []);
      let active = true;
      const failure = vi.fn();
      const worker = new ProductionMemoryWorker({
        service: { runProjectionBatch: batch },
        assertActive: () => {
          if (!active) throw new Error("authority lost");
        },
        onFailure: failure,
      });
      await worker.start();
      expect(batch).toHaveBeenCalledWith(1);
      active = false;
      await vi.advanceTimersByTimeAsync(1000);
      expect(batch).toHaveBeenCalledTimes(1);
      expect(failure).toHaveBeenCalledTimes(1);
      await expect(worker.drain()).rejects.toThrow("authority lost");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the accepted job before allowing provider closure", async () => {
    let finish = () => {};
    const worker = new ProductionMemoryWorker({
      service: {
        runProjectionBatch: () =>
          new Promise((resolve) => {
            finish = () => resolve([]);
          }),
      },
      assertActive() {},
      onFailure() {},
    });
    const starting = worker.start();
    let drained = false;
    const draining = worker.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    finish();
    await Promise.all([starting, draining]);
    expect(drained).toBe(true);
  });
});
