import { createRunId } from "@himawari-agent/domain";
import { describe, expect, it, vi } from "vitest";
import type { SandboxExecutionRunInventory } from "../src/ports/sandbox-execution-journal.js";
import type { TraceEvent } from "../src/ports/observability.js";
import { ExecutionLiveFeed } from "../src/services/execution-live-feed.js";
import { ProductThreadGatewayAdapter } from "../src/services/product-thread-gateway-adapter.js";
import type { ThreadExecutionObservation } from "../src/services/thread-execution-projection.js";
import { ThreadExecutionProjection } from "../src/services/thread-execution-projection.js";
import { nextThreadExecutionResourceChangeAt } from "../src/services/thread-execution-resources.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 9, 25, 0, 0, seconds)).toISOString();
const emptyInventory: SandboxExecutionRunInventory = {
  admissions: [],
  queue: [],
  legacyResourcesPending: false,
  deletedPlans: [],
  taskEnvironmentCalls: [],
  executionLease: null,
};
const scope = { ownerId: "owner-watch", agentId: "agent-watch" };

describe("thread execution resource change instants", () => {
  it("returns the earliest recorded instant after now, at any depth", () => {
    const inventory = {
      ...emptyInventory,
      executionLease: { expiresAt: at(40), releasedAt: null },
      admissions: [
        {
          plan: { effectiveDeadlineAt: at(30), nested: [{ validUntil: at(20) }] },
          releaseReceipt: { acceptedAt: at(5) },
        },
      ],
    } as unknown as SandboxExecutionRunInventory;
    expect(nextThreadExecutionResourceChangeAt(inventory, at(10))).toBe(at(20));
    expect(nextThreadExecutionResourceChangeAt(inventory, at(20))).toBe(at(30));
    expect(nextThreadExecutionResourceChangeAt(inventory, at(40))).toBeNull();
  });

  it("ignores identifiers and text that are not instants", () => {
    const inventory = {
      ...emptyInventory,
      deletedPlans: [{ identity: { jobId: "2026-10-25" }, note: `before ${at(50)}` }],
    } as unknown as SandboxExecutionRunInventory;
    expect(nextThreadExecutionResourceChangeAt(inventory, at(0))).toBeNull();
    expect(() => nextThreadExecutionResourceChangeAt(inventory, "not a time")).toThrow(
      "THREAD_EXECUTION_RESOURCE_CLOCK_INVALID",
    );
  });
});

describe("thread execution observation", () => {
  const runId = createRunId("run-watch");
  const event = (sequence: number, overrides: Partial<TraceEvent> = {}) =>
    ({
      ...scope,
      threadId: "thread-watch",
      runId,
      sequence,
      ...overrides,
    }) as unknown as TraceEvent;
  function projection(input: {
    readonly events: TraceEvent[];
    readonly inventory?: SandboxExecutionRunInventory;
    readonly checkpoint?: unknown;
  }) {
    const readRun = vi.fn(async (_runId: string, after: number, limit: number) =>
      input.events.filter((item) => item.sequence > after).slice(0, limit),
    );
    const readInventory = vi.fn(async () => input.inventory ?? emptyInventory);
    const value = new ThreadExecutionProjection({
      threads: {},
      trace: { readRun },
      payloads: () => ({ get: async () => undefined }),
      protector: {},
      checkpoints: { read: async () => input.checkpoint },
      ...(input.inventory
        ? { resources: { readInventory, now: () => at(10), digest: () => "a".repeat(64) } }
        : {}),
    } as unknown as ConstructorParameters<typeof ThreadExecutionProjection>[0]);
    return { value, readRun, readInventory };
  }
  const observe = (
    target: ThreadExecutionProjection,
    afterSequence = 0,
    known: { resourceRevision: string | null; resourcesPending: boolean } | null = null,
  ) =>
    target.observeRun({
      ...scope,
      threadId: "thread-watch",
      runId,
      afterSequence,
      known,
    });

  it("reports the last Trace sequence from the given point without reading payloads", async () => {
    const { value, readRun } = projection({ events: [event(1), event(2), event(3)] });
    await expect(observe(value)).resolves.toEqual({
      traceSequence: 3,
      checkpointRevision: null,
      resourceRevision: null,
      resourcesPending: false,
      nextChangeAt: null,
    });
    await expect(observe(value, 3)).resolves.toMatchObject({ traceSequence: 3 });
    expect(readRun).toHaveBeenLastCalledWith(runId, 3, 1000);
  });

  it("refuses Trace rows outside the Run scope", async () => {
    const { value } = projection({ events: [event(1, { ownerId: "owner-other" } as never)] });
    await expect(observe(value)).rejects.toThrow("THREAD_EXECUTION_SCOPE_MISMATCH");
  });

  it("changes the checkpoint and resource markers when their records change", async () => {
    const first = await observe(projection({ events: [], inventory: emptyInventory }).value);
    const second = await observe(
      projection({
        events: [],
        inventory: { ...emptyInventory, legacyResourcesPending: true },
        checkpoint: { checkpoint: { phase: "terminal" } },
      }).value,
    );
    expect(first.resourceRevision).not.toBeNull();
    expect(second.resourceRevision).not.toBe(first.resourceRevision);
    expect(first.resourcesPending).toBe(false);
    expect(second.resourcesPending).toBe(true);
    expect(second.checkpointRevision).not.toBeNull();
  });

  it("reuses the known release conclusion while the inventory is unchanged", async () => {
    const inventory = {
      ...emptyInventory,
      executionLease: { expiresAt: at(30), releasedAt: null },
    };
    const { value } = projection({ events: [], inventory });
    const first = await observe(value);
    expect(first.nextChangeAt).toBe(at(30));
    await expect(
      observe(value, 0, { resourceRevision: first.resourceRevision, resourcesPending: true }),
    ).resolves.toMatchObject({ resourcesPending: true });
    await expect(
      observe(value, 0, { resourceRevision: "thread-command:v1:other", resourcesPending: true }),
    ).resolves.toMatchObject({ resourcesPending: false });
  });
});

describe("product thread execution watch", () => {
  const subscription = {
    schemaVersion: "gateway.thread.v3",
    kind: "subscription",
    type: "thread.execution_events",
    messageId: "subscription-watch",
    correlationId: "correlation-watch",
    causationId: null,
    scope,
    authority: { deploymentId: "deployment-watch", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "owner", actorId: "subject-watch" },
    payload: { threadId: "thread-watch" },
  } as const;
  const authentication = {
    ownerId: "owner-watch",
    subjectId: "subject-watch",
  } as never;
  const observation = (
    overrides: Partial<ThreadExecutionObservation> = {},
  ): ThreadExecutionObservation => ({
    traceSequence: 1,
    checkpointRevision: null,
    resourceRevision: "thread-command:v1:resource",
    resourcesPending: false,
    nextChangeAt: null,
    ...overrides,
  });
  function watcher(input: {
    readonly runs: () => Array<{ runId: string; revision: number; status: string }>;
    readonly observe: (runId: string, call: number) => ThreadExecutionObservation;
    readonly clock: () => string;
    readonly ticks: number;
    readonly threadStatus?: string;
  }) {
    const controller = new AbortController();
    let ticks = 0;
    let calls = 0;
    const observeRun = vi.fn(async ({ runId }: { runId: string }) => input.observe(runId, calls++));
    const adapter = new ProductThreadGatewayAdapter({
      repository: {
        read: async () => ({ id: "thread-watch", status: input.threadStatus ?? "active" }),
        listRuns: async () =>
          input.runs().map((run) => ({
            ...run,
            runId: createRunId(run.runId),
            createdAt: at(0),
            updatedAt: at(0),
          })),
      },
      execution: { read: vi.fn(), observeRun },
      clock: { now: input.clock },
      waitForEvents: async () => {
        if (++ticks >= input.ticks) controller.abort();
      },
    } as unknown as ConstructorParameters<typeof ProductThreadGatewayAdapter>[0]);
    return { adapter, controller, observeRun };
  }
  async function collect(target: ReturnType<typeof watcher>) {
    const events = [];
    for await (const event of target.adapter.watchExecution({
      authentication,
      subscription: subscription as never,
      signal: target.controller.signal,
    }))
      if (event.type === "thread.execution_changed") events.push(event.payload);
    return events;
  }

  it("announces unsettled Runs once, then only when their markers change", async () => {
    let now = 0;
    const target = watcher({
      runs: () => [
        { runId: "run-active", revision: 2, status: "running" },
        { runId: "run-settled", revision: 4, status: "completed" },
      ],
      observe: (runId, call) =>
        runId === "run-active"
          ? observation({ traceSequence: call < 4 ? 1 : 2 })
          : observation({ traceSequence: 9 }),
      clock: () => at(now++),
      ticks: 4,
    });
    const events = await collect(target);
    expect(events.map(({ runId, traceSequence }) => [runId, traceSequence])).toEqual([
      ["run-active", 1],
      ["run-active", 2],
    ]);
    expect(events[0]).toMatchObject({
      threadId: "thread-watch",
      runRevision: 2,
      resourceRevision: "thread-command:v1:resource",
    });
    expect(
      target.observeRun.mock.calls.filter(([input]) => input.runId === "run-settled"),
    ).toHaveLength(1);
  });

  it("announces a settled-looking Run again when its recorded change instant passes", async () => {
    let now = 0;
    const target = watcher({
      runs: () => [{ runId: "run-window", revision: 3, status: "completed" }],
      observe: (_runId, call) =>
        observation({
          resourcesPending: call === 0,
          nextChangeAt: call === 0 ? at(2) : null,
        }),
      clock: () => at(now++),
      ticks: 4,
    });
    const events = await collect(target);
    expect(events).toHaveLength(2);
    expect(target.observeRun.mock.calls[1]?.[0]).toMatchObject({ known: null });
  });

  it("checks a finished Run with unconfirmed resources at most every five seconds", async () => {
    const seconds = [0, 1, 2, 3, 4, 6];
    let tick = 0;
    const target = watcher({
      runs: () => [{ runId: "run-unresolved", revision: 3, status: "failed" }],
      observe: () => observation({ resourcesPending: true }),
      clock: () => at(seconds[Math.min(tick++, seconds.length - 1)] ?? 0),
      ticks: 6,
    });
    await collect(target);
    expect(target.observeRun).toHaveBeenCalledTimes(2);
  });

  it("observes again when the Run revision changes and ends for an unreadable Thread", async () => {
    let listed = 0;
    const target = watcher({
      runs: () => [{ runId: "run-revised", revision: ++listed > 1 ? 2 : 1, status: "completed" }],
      observe: () => observation(),
      clock: () => at(0),
      ticks: 3,
    });
    expect((await collect(target)).map((item) => item.runRevision)).toEqual([2]);
    expect(target.observeRun).toHaveBeenCalledTimes(2);
    const trashed = watcher({
      runs: () => [],
      observe: () => observation(),
      clock: () => at(0),
      ticks: 2,
      threadStatus: "trashed",
    });
    await expect(collect(trashed)).rejects.toThrow("THREAD_EXECUTION_NOT_FOUND");
  });

  it("pushes answer text and wakes on new records without waiting for the poll", async () => {
    const live = new ExecutionLiveFeed();
    const controller = new AbortController();
    let traceSequence = 1;
    const observeRun = vi.fn(async () => observation({ traceSequence }));
    const adapter = new ProductThreadGatewayAdapter({
      repository: {
        read: async () => ({ id: "thread-watch", status: "active" }),
        listRuns: async () => [
          {
            runId: createRunId("run-live"),
            revision: 1,
            status: "running",
            createdAt: at(0),
            updatedAt: at(0),
          },
        ],
      },
      execution: { read: vi.fn(), observeRun },
      clock: { now: () => at(0) },
      executionPollMilliseconds: 60_000,
      live,
    } as unknown as ConstructorParameters<typeof ProductThreadGatewayAdapter>[0]);
    live.assistantText({ threadId: "thread-watch", runId: "run-live", timestamp: 1, text: "向日" });
    live.assistantText({ threadId: "thread-other", runId: "run-x", timestamp: 1, text: "别处" });
    const started = Date.now();
    const seen: unknown[] = [];
    for await (const event of adapter.watchExecution({
      authentication,
      subscription: subscription as never,
      signal: controller.signal,
    })) {
      seen.push(
        event.type === "thread.execution_text"
          ? ["text", event.payload.offset, event.payload.text]
          : ["changed", event.payload.traceSequence],
      );
      if (seen.length === 2) {
        live.assistantText({
          threadId: "thread-watch",
          runId: "run-live",
          timestamp: 1,
          text: "向日葵的",
        });
        live.assistantText({
          threadId: "thread-watch",
          runId: "run-live",
          timestamp: 1,
          text: "向日葵的一生",
        });
      }
      if (seen.length === 3) {
        traceSequence = 2;
        live.changed("run-live");
      }
      if (seen.length === 4) controller.abort();
    }
    expect(seen).toEqual([
      ["text", 0, "向日"],
      ["changed", 1],
      ["text", 2, "葵的一生"],
      ["changed", 2],
    ]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("tells the watcher when her first characters were written, not when they were sent", async () => {
    const times = ["2026-11-26T03:00:01.000Z", "2026-11-26T03:00:02.000Z"];
    const live = new ExecutionLiveFeed(() => times.shift() ?? "unused");
    const controller = new AbortController();
    const adapter = new ProductThreadGatewayAdapter({
      repository: {
        read: async () => ({ id: "thread-watch", status: "active" }),
        listRuns: async () => [],
      },
      execution: { read: vi.fn(), observeRun: vi.fn(async () => observation()) },
      clock: { now: () => at(30) },
      executionPollMilliseconds: 60_000,
      live,
    } as unknown as ConstructorParameters<typeof ProductThreadGatewayAdapter>[0]);
    const stamps: unknown[] = [];
    const watching = (async () => {
      for await (const event of adapter.watchExecution({
        authentication,
        subscription: subscription as never,
        signal: controller.signal,
      })) {
        if (event.type !== "thread.execution_text") continue;
        stamps.push([event.payload.text, event.payload.emittedAt, event.payload.observedAt]);
        if (stamps.length === 2) controller.abort();
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 20));
    live.assistantText({ threadId: "thread-watch", runId: "run-live", timestamp: 1, text: "好的" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    live.assistantText({
      threadId: "thread-watch",
      runId: "run-live",
      timestamp: 1,
      text: "好的，查到了",
    });
    await watching;
    expect(stamps).toEqual([
      ["好的", "2026-11-26T03:00:01.000Z", at(30)],
      ["，查到了", "2026-11-26T03:00:02.000Z", at(30)],
    ]);
  });
});
