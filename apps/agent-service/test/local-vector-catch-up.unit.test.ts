import { describe, expect, it } from "vitest";
import { createLocalVectorCatchUp } from "../src/local-vector-catch-up.ts";

describe("[P3-1] local vector catch-up", () => {
  it("retries a failed catch-up with growing delays while the model stays ready, and stops once it succeeds", async () => {
    const outcomes = [new Error("STORE_BUSY"), new Error("STORE_BUSY"), undefined];
    let runs = 0;
    const retries: number[] = [];
    const pending: (() => void)[] = [];
    const catchUp = createLocalVectorCatchUp({
      run: async () => {
        const outcome = outcomes[runs];
        runs += 1;
        if (outcome) throw outcome;
      },
      failed: (_error, retryInMs) => {
        retries.push(retryInMs);
        throw new Error("LOG_SINK_DOWN");
      },
      schedule: (callback) => pending.push(callback),
    });
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    catchUp.observe(false);
    await settle();
    expect(runs).toBe(0);
    catchUp.observe(true);
    catchUp.observe(true);
    await settle();
    expect(runs).toBe(1);
    expect(retries).toEqual([60_000]);
    pending.shift()?.();
    await settle();
    expect(runs).toBe(2);
    expect(retries).toEqual([60_000, 120_000]);
    catchUp.observe(false);
    pending.shift()?.();
    await settle();
    expect(runs).toBe(2);
    catchUp.observe(true);
    await settle();
    expect(runs).toBe(3);
    catchUp.observe(true);
    await settle();
    expect(runs).toBe(3);
    expect(pending).toEqual([]);
  });
});
