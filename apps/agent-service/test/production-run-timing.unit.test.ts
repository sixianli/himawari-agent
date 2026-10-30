import type { RuntimeEvent, RuntimeRequest } from "@himawari-agent/application";
import { expect, it } from "vitest";
import {
  currentRunId,
  ProductionRunTimings,
  recordInCurrentRun,
} from "../src/production-run-timing.js";

const runId = "run:timing" as RuntimeRequest["runId"];

function clock() {
  let now = 0;
  return {
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

it("reports one flat diagnostic per attempt with every measured step of that Run", async () => {
  const time = clock();
  const timings = new ProductionRunTimings(time.now);
  const checkpoints = timings.methods(
    {
      writes: 0,
      async compareAndSet(input: { readonly runId: string }) {
        time.advance(15);
        this.writes += 1;
        return input.runId;
      },
      async read() {
        time.advance(100);
      },
    },
    { compareAndSet: "checkpoint.write" },
  );
  const stops = timings.methods(
    {
      async stopRun(_runId: string) {
        time.advance(1600);
        return { released: true };
      },
    },
    { stopRun: "resources.stop" },
  );
  const reports: Record<string, string | number>[] = [];

  await timings.attempt(
    runId,
    "execute",
    async () => {
      time.advance(5);
      await checkpoints.compareAndSet({ runId });
      await checkpoints.compareAndSet({ runId });
      await checkpoints.read();
      await checkpoints.compareAndSet({ runId: "run:other" });
      await stops.stopRun(runId);
    },
    (diagnostic) => reports.push({ ...diagnostic }),
  );

  expect(checkpoints.writes).toBe(3);
  expect(reports).toEqual([
    {
      runId,
      attempt: "execute",
      outcome: "returned",
      totalMs: 1750,
      "checkpoint.write.n": 2,
      "checkpoint.write.ms": 30,
      "checkpoint.write.max": 15,
      "checkpoint.write.at": 5,
      "checkpoint.write.end": 35,
      "resources.stop.n": 1,
      "resources.stop.ms": 1600,
      "resources.stop.max": 1600,
      "resources.stop.at": 150,
      "resources.stop.end": 1750,
    },
  ]);
});

it("separates waiting for the runtime from the time the coordinator spends on each event", async () => {
  const time = clock();
  const timings = new ProductionRunTimings(time.now);
  const event = (type: "runtime.model_started") =>
    ({ type, runId, modelRef: "model", occurredAt: "2026-10-26T00:00:00.000Z" }) as RuntimeEvent;
  const runtime = timings.runtime(
    {
      cancel: async () => undefined,
      async *run() {
        time.advance(2700);
        yield event("runtime.model_started");
        time.advance(3900);
        yield event("runtime.model_started");
      },
    },
    "runtime",
  );
  const reports: Record<string, string | number>[] = [];

  await timings.attempt(
    runId,
    "execute",
    async () => {
      for await (const _ of runtime.run({ runId } as RuntimeRequest)) time.advance(60);
    },
    (diagnostic) => reports.push({ ...diagnostic }),
  );

  expect(reports[0]).toMatchObject({
    totalMs: 6720,
    "runtime.first_event.ms": 2700,
    "runtime.next_event.n": 2,
    "runtime.next_event.ms": 3900,
    "runtime.consumer.n": 2,
    "runtime.consumer.ms": 120,
  });
});

it("still reports a failed attempt and stops tracking it afterwards", async () => {
  const time = clock();
  const timings = new ProductionRunTimings(time.now);
  const reports: Record<string, string | number>[] = [];

  await expect(
    timings.attempt(
      runId,
      "execute",
      async () => {
        time.advance(10);
        throw new Error("RUN_FAILED");
      },
      (diagnostic) => reports.push({ ...diagnostic }),
    ),
  ).rejects.toThrow("RUN_FAILED");
  await timings.measure(runId, "late.step", async () => time.advance(5));

  expect(reports).toEqual([{ runId, attempt: "execute", outcome: "failed", totalMs: 10 }]);
});

it("measures frozen ports and class instances with private state without changing their answers", async () => {
  const time = clock();
  const timings = new ProductionRunTimings(time.now);
  class Store {
    readonly #rows = ["row"];
    async read(_runId: string) {
      time.advance(7);
      return this.#rows;
    }
    count() {
      return this.#rows.length;
    }
  }
  const store = timings.methods(new Store(), { read: "store.read" });
  const port = timings.methods(
    Object.freeze({
      lookup: async (input: { readonly runId: string }) => {
        time.advance(3);
        return input.runId;
      },
    }),
    { lookup: "port.lookup" },
  );
  const reports: Record<string, string | number>[] = [];

  await timings.attempt(
    runId,
    "execute",
    async () => {
      expect(await store.read(runId)).toEqual(["row"]);
      expect(store.count()).toBe(1);
      expect(await port.lookup({ runId })).toBe(runId);
      expect(store instanceof Store).toBe(true);
      expect("lookup" in port).toBe(true);
    },
    (diagnostic) => reports.push({ ...diagnostic }),
  );

  expect(reports[0]).toMatchObject({ "store.read.ms": 7, "port.lookup.ms": 3 });
});

it("credits a step to the Run whose attempt is running even when the caller cannot name the Run", async () => {
  const time = clock();
  const timings = new ProductionRunTimings(time.now);
  const reports: Record<string, string | number>[] = [];
  recordInCurrentRun("db.run", 40);

  await timings.attempt(
    runId,
    "execute",
    async () => {
      time.advance(100);
      expect(currentRunId()).toBe(runId);
      await new Promise((resolve) => setImmediate(resolve));
      recordInCurrentRun("db.run", 30);
      recordInCurrentRun("db.queue", 5);
      recordInCurrentRun("db.run", 20);
    },
    (diagnostic) => reports.push({ ...diagnostic }),
  );

  expect(currentRunId()).toBeUndefined();
  expect(reports[0]).toMatchObject({
    "db.run.n": 2,
    "db.run.ms": 50,
    "db.run.max": 30,
    "db.queue.n": 1,
    "db.queue.ms": 5,
  });
});
