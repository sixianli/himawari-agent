import type { RuntimeEvent, RuntimeRequest } from "@himawari-agent/application";
import { expect, it, vi } from "vitest";
import { createProductionTitledRuntime } from "../src/production-titled-runtime.js";

const runId = "run:titled-runtime" as RuntimeRequest["runId"];
const request = { runId, threadId: "thread:titled-runtime" } as unknown as RuntimeRequest;
const at = "2026-10-26T12:40:09.911Z";
const events: RuntimeEvent[] = [
  {
    type: "runtime.message",
    runId,
    phase: "started",
    role: "assistant",
    sequence: 1,
    payloadRef: "payload:answer" as never,
    occurredAt: at,
  },
  {
    type: "runtime.completed",
    runId,
    occurredAt: at,
    output: { kind: "answer", contentRef: "payload:answer" } as never,
  },
];

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function runtimeOf(list: readonly RuntimeEvent[]) {
  return {
    cancel: vi.fn(async () => undefined),
    async *run() {
      yield* list;
    },
  };
}

async function collect(iterable: AsyncIterable<RuntimeEvent>, settle: Promise<unknown>) {
  const seen: string[] = [];
  const reading = (async () => {
    for await (const event of iterable) seen.push(event.type);
  })();
  await Promise.race([reading, settle]);
  return seen;
}

it("completes the Run once memory capture is admitted, without waiting for the thread title to finish", async () => {
  const memoryStart = vi.fn(async () => undefined);
  const runtime = createProductionTitledRuntime({
    runtime: runtimeOf(events),
    titles: { start: vi.fn(async () => undefined) },
    memoryCapture: { start: memoryStart },
    memoryPaused: async () => false,
  });

  const seen = await collect(runtime.run(request), new Promise((done) => setTimeout(done, 200)));

  expect(memoryStart).toHaveBeenCalledWith(request);
  expect(seen).toEqual(["runtime.message", "runtime.completed"]);
});

it("still holds the Run until every background model call is admitted under its lease", async () => {
  const titleAdmitted = deferred();
  const memoryAdmitted = deferred();
  const consolidationAdmitted = deferred();
  const order: string[] = [];
  const runtime = createProductionTitledRuntime({
    runtime: runtimeOf(events),
    titles: { start: () => titleAdmitted.promise.then(() => void order.push("title")) },
    memoryCapture: { start: () => memoryAdmitted.promise.then(() => void order.push("memory")) },
    memoryEpisodes: {
      start: async () => void order.push("episodes"),
      recordCompaction: async () => undefined,
    },
    memoryConsolidation: {
      start: () => consolidationAdmitted.promise.then(() => void order.push("consolidation")),
    },
    memoryPaused: async () => false,
  });
  const seen: string[] = [];
  const reading = (async () => {
    for await (const event of runtime.run(request)) seen.push(event.type);
  })();

  await new Promise((done) => setTimeout(done, 20));
  expect(seen).toEqual(["runtime.message"]);
  memoryAdmitted.resolve();
  await new Promise((done) => setTimeout(done, 20));
  expect(seen).toEqual(["runtime.message"]);
  consolidationAdmitted.resolve();
  await new Promise((done) => setTimeout(done, 20));
  expect(seen).toEqual(["runtime.message"]);
  titleAdmitted.resolve();
  await reading;

  expect(seen).toEqual(["runtime.message", "runtime.completed"]);
  expect(order).toEqual(["memory", "episodes", "consolidation", "title"]);
});
