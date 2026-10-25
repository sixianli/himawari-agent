import { describe, expect, it } from "vitest";
import { ProductionSandboxExecutionV2 } from "../src/production-sandbox-execution-v2.ts";

type Reply = { record: { phase: string; call: number }; resolvedScope: { call: number } };

function harness(delayMs: number) {
  const started: number[] = [];
  let active = 0;
  let peak = 0;
  const sandboxExecution = async () => {
    const call = started.length + 1;
    started.push(Date.now());
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    active -= 1;
    return { record: { phase: "bound", call }, resolvedScope: { call } } satisfies Reply;
  };
  const instance = new ProductionSandboxExecutionV2({
    configuration: {} as never,
    peer: { workerInstanceId: "worker-1" } as never,
    payloads: { sandboxExecution } as never,
    clock: { now: () => "2026-10-25T00:00:00.000Z" },
  } as never);
  const entry = { invocation: {}, identity: {}, cancelled: false } as never;
  const resolve = () =>
    (instance as unknown as { freshResolve(entry: unknown): Promise<Reply> }).freshResolve(entry);
  return { resolve, started, peak: () => peak };
}

describe("sandbox scope resolve during network authority checks", () => {
  it("runs at most one resolve at a time and answers waiting checks with one newer resolve", async () => {
    const { resolve, started, peak } = harness(300);
    const first = resolve();
    await new Promise((done) => setTimeout(done, 50));
    const checks = await Promise.all([resolve(), resolve(), resolve()]);
    expect((await first).resolvedScope.call).toBe(1);
    expect(checks.map((reply) => reply.resolvedScope.call)).toEqual([2, 2, 2]);
    expect(started).toHaveLength(2);
    expect(peak()).toBe(1);
  });

  it("never answers a check with a resolve that started before the check arrived", async () => {
    const { resolve, started } = harness(200);
    void resolve();
    await new Promise((done) => setTimeout(done, 20));
    const arrived = Date.now();
    const reply = await resolve();
    expect(reply.resolvedScope.call).toBe(2);
    expect(started[1]).toBeGreaterThanOrEqual(arrived);
  });

  it("starts a fresh resolve once the previous one has settled", async () => {
    const { resolve, started } = harness(10);
    await resolve();
    await resolve();
    expect(started).toHaveLength(2);
  });

  it("keeps serving checks after a resolve fails", async () => {
    let calls = 0;
    const instance = new ProductionSandboxExecutionV2({
      configuration: {} as never,
      peer: { workerInstanceId: "worker-1" } as never,
      payloads: {
        sandboxExecution: async () => {
          calls += 1;
          await new Promise((done) => setTimeout(done, 50));
          if (calls === 1) throw new Error("BROKER_UNAVAILABLE");
          return { record: { phase: "bound" }, resolvedScope: { call: calls } };
        },
      } as never,
      clock: { now: () => "2026-10-25T00:00:00.000Z" },
    } as never);
    const entry = { invocation: {}, identity: {}, cancelled: false } as never;
    const resolve = () =>
      (instance as unknown as { freshResolve(entry: unknown): Promise<Reply> }).freshResolve(entry);
    const failing = resolve();
    const waiting = resolve();
    await expect(failing).rejects.toThrow("BROKER_UNAVAILABLE");
    expect((await waiting).resolvedScope.call).toBe(2);
  });
});
