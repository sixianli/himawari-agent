import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductionRunDispatchLoop,
  type ProductionRunDispatchLoopFailure,
  type ProductionRunDispatchLoopOptions,
} from "../src/production-run-dispatch-loop.js";
import type {
  ProductionRunDispatchDrainResult,
  ProductionRunDispatchPumpResult,
} from "../src/production-run-dispatcher.js";

const PUMP_RESULT: ProductionRunDispatchPumpResult = Object.freeze({
  checkedAt: "2026-09-05T00:00:00.000Z",
  reconciled: 0,
  claimed: 0,
  settled: 0,
  unknown: 0,
  conflicts: 0,
});

const DRAINED_RESULT: ProductionRunDispatchDrainResult = Object.freeze({
  drained: true,
  inFlight: 0,
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (resolvePromise === undefined) throw new Error("DEFERRED_NOT_INITIALIZED");
      resolvePromise(value);
    },
  };
}

type PumpAction = () => Promise<ProductionRunDispatchPumpResult>;
type Dispatcher = ProductionRunDispatchLoopOptions["dispatcher"];

class DispatcherStub implements Dispatcher {
  readonly pumpActions: PumpAction[] = [];
  readonly drainCalls: number[] = [];
  pumpCalls = 0;
  drainAction: (timeoutMs: number) => Promise<ProductionRunDispatchDrainResult> = async () =>
    DRAINED_RESULT;

  pump(): Promise<ProductionRunDispatchPumpResult> {
    this.pumpCalls += 1;
    return this.pumpActions.shift()?.() ?? Promise.resolve(PUMP_RESULT);
  }

  drain(timeoutMs: number): Promise<ProductionRunDispatchDrainResult> {
    this.drainCalls.push(timeoutMs);
    return this.drainAction(timeoutMs);
  }
}

function createLoop(
  dispatcher: DispatcherStub,
  onFailure?: (failure: ProductionRunDispatchLoopFailure) => void,
  fallbackScanIntervalMs = 1_000,
): ProductionRunDispatchLoop {
  return new ProductionRunDispatchLoop({
    dispatcher,
    fallbackScanIntervalMs,
    ...(onFailure === undefined ? {} : { onFailure }),
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ProductionRunDispatchLoop", () => {
  it("runs the recovery pump immediately before enabling the fallback timer", async () => {
    const dispatcher = new DispatcherStub();
    const loop = createLoop(dispatcher);

    const startup = loop.start();
    expect(dispatcher.pumpCalls).toBe(1);
    await expect(startup).resolves.toBeUndefined();
    expect(loop.state).toBe("running");

    await expect(loop.stop(100)).resolves.toEqual(DRAINED_RESULT);
    expect(dispatcher.drainCalls).toEqual([100]);
    expect(loop.state).toBe("stopped");
  });

  it("coalesces repeated wakeups while one pump is running and keeps the follow-up", async () => {
    const dispatcher = new DispatcherStub();
    const entered = deferred<void>();
    const release = deferred<void>();
    dispatcher.pumpActions.push(async () => {
      entered.resolve(undefined);
      await release.promise;
      return PUMP_RESULT;
    });

    const loop = createLoop(dispatcher);
    const startup = loop.start();
    await entered.promise;
    expect(loop.wakeup()).toBe(true);
    expect(loop.wakeup()).toBe(true);
    expect(dispatcher.pumpCalls).toBe(1);

    release.resolve(undefined);
    await expect(startup).resolves.toBeUndefined();
    await flushMicrotasks();
    expect(dispatcher.pumpCalls).toBe(2);
    expect(loop.state).toBe("running");

    await loop.stop(100);
  });

  it("starts a pump for a wakeup received after the initial pump is idle", async () => {
    const dispatcher = new DispatcherStub();
    const loop = createLoop(dispatcher);

    await loop.start();
    expect(dispatcher.pumpCalls).toBe(1);
    expect(loop.wakeup()).toBe(true);
    await flushMicrotasks();
    expect(dispatcher.pumpCalls).toBe(2);

    await loop.stop(100);
  });

  it("runs bounded fallback scans and unrefs the timer lifecycle", async () => {
    vi.useFakeTimers();
    const dispatcher = new DispatcherStub();
    const loop = createLoop(dispatcher, undefined, 25);

    await loop.start();
    expect(dispatcher.pumpCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(24);
    expect(dispatcher.pumpCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatcher.pumpCalls).toBe(2);
    expect(loop.wakeup()).toBe(true);
    await flushMicrotasks();
    expect(dispatcher.pumpCalls).toBe(3);

    await loop.stop(100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed once on a pump error and does not retry from wakeups or the timer", async () => {
    vi.useFakeTimers();
    const dispatcher = new DispatcherStub();
    const failure = new Error("PUMP_FAILED");
    dispatcher.pumpActions.push(async () => {
      throw failure;
    });
    const failures: ProductionRunDispatchLoopFailure[] = [];
    const loop = createLoop(dispatcher, (value) => failures.push(value), 25);

    await expect(loop.start()).rejects.toBe(failure);
    expect(loop.state).toBe("failed");
    expect(loop.failure).toEqual({ phase: "startup", error: failure });
    expect(failures).toEqual([{ phase: "startup", error: failure }]);
    expect(loop.wakeup()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(dispatcher.pumpCalls).toBe(1);
    expect(failures).toHaveLength(1);
  });

  it("fails closed on a later wakeup error and does not schedule another pump", async () => {
    const dispatcher = new DispatcherStub();
    const failure = new Error("WAKEUP_PUMP_FAILED");
    dispatcher.pumpActions.push(async () => PUMP_RESULT);
    dispatcher.pumpActions.push(async () => {
      throw failure;
    });
    const failures: ProductionRunDispatchLoopFailure[] = [];
    const loop = createLoop(dispatcher, (value) => failures.push(value));

    await loop.start();
    expect(loop.wakeup()).toBe(true);
    await flushMicrotasks();
    expect(loop.state).toBe("failed");
    expect(loop.failure).toEqual({ phase: "wakeup", error: failure });
    expect(failures).toEqual([{ phase: "wakeup", error: failure }]);
    expect(loop.wakeup()).toBe(false);
    expect(dispatcher.pumpCalls).toBe(2);

    await loop.stop(100);
  });

  it("rejects new wakeups before stop and waits for the active and accepted follow-up pump", async () => {
    const dispatcher = new DispatcherStub();
    const entered = deferred<void>();
    const release = deferred<void>();
    dispatcher.pumpActions.push(async () => {
      entered.resolve(undefined);
      await release.promise;
      return PUMP_RESULT;
    });

    const loop = createLoop(dispatcher);
    const startup = loop.start();
    await entered.promise;
    expect(loop.wakeup()).toBe(true);
    const stopping = loop.stop(100);
    expect(loop.wakeup()).toBe(false);
    expect(dispatcher.drainCalls).toEqual([100]);

    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);

    release.resolve(undefined);
    await expect(startup).resolves.toBeUndefined();
    await expect(stopping).resolves.toEqual(DRAINED_RESULT);
    expect(dispatcher.pumpCalls).toBe(2);
    expect(loop.state).toBe("stopped");
  });

  it("returns dispatcher timeout semantics and permits a later bounded drain retry", async () => {
    const dispatcher = new DispatcherStub();
    dispatcher.drainAction = async () => ({ drained: false, inFlight: 1 });
    const loop = createLoop(dispatcher);

    await loop.start();
    await expect(loop.stop(7)).resolves.toEqual({ drained: false, inFlight: 1 });
    expect(loop.state).toBe("stopping");
    expect(loop.wakeup()).toBe(false);

    dispatcher.drainAction = async () => DRAINED_RESULT;
    await expect(loop.drain(11)).resolves.toEqual(DRAINED_RESULT);
    expect(dispatcher.drainCalls).toEqual([7, 11]);
    expect(loop.state).toBe("stopped");
  });
});
