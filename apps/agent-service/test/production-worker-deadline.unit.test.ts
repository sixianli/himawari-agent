import { setImmediate as afterIo } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { beforeDeadline } from "../src/production-worker-deadline.js";

describe("beforeDeadline", () => {
  let unhandled: unknown[];
  const record = (reason: unknown) => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", record);
  });

  afterEach(() => {
    process.off("unhandledRejection", record);
  });

  const settle = async () => {
    await afterIo();
    await afterIo();
  };

  it("[R2-S3] observes work that is aborted after its deadline has already passed", async () => {
    const run = new AbortController();
    const work = (async () => {
      await afterIo();
      run.signal.throwIfAborted();
    })();
    const waited = beforeDeadline(work, performance.now() - 1);
    run.abort();
    await expect(waited).rejects.toThrow("WORKER_DEADLINE_EXCEEDED");
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("[R2-S3] observes work that was already aborted when the deadline had passed", async () => {
    const run = new AbortController();
    run.abort();
    const work = (async () => {
      run.signal.throwIfAborted();
    })();
    await expect(beforeDeadline(work, performance.now() - 1)).rejects.toThrow(
      "WORKER_DEADLINE_EXCEEDED",
    );
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("[R2-S3] observes work that fails after the deadline expired while waiting", async () => {
    let fail: (error: Error) => void = () => undefined;
    const work = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    await expect(beforeDeadline(work, performance.now() + 5)).rejects.toThrow(
      "WORKER_DEADLINE_EXCEEDED",
    );
    fail(new Error("late"));
    await settle();
    expect(unhandled).toEqual([]);
  });

  it("returns work that finishes before the deadline", async () => {
    await expect(beforeDeadline(Promise.resolve("done"), performance.now() + 1_000)).resolves.toBe(
      "done",
    );
  });

  it("does not accept a result once the deadline has passed", async () => {
    await expect(beforeDeadline(Promise.resolve("late"), performance.now() - 1)).rejects.toThrow(
      "WORKER_DEADLINE_EXCEEDED",
    );
  });
});
