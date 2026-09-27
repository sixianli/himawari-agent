import { createRunId } from "@himawari-agent/domain";
import {
  type ThreadExecutionRecord,
  threadExecutionStateSchema,
} from "@himawari-agent/gateway-contracts";
import { describe, expect, it, vi } from "vitest";
import type { ThreadRunSummaryRecord } from "../src/ports/threads.js";
import { ThreadExecutionProjection } from "../src/services/thread-execution-projection.js";
import { projectThreadExecutionState } from "../src/services/thread-execution-state.js";

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 20, 0, 0, seconds)).toISOString();
const run: ThreadRunSummaryRecord = {
  runId: createRunId("state-run"),
  revision: 3,
  status: "running",
  createdAt: at(0),
  updatedAt: at(1),
};
const record = (
  sequence: number,
  itemId: string,
  phase: ThreadExecutionRecord["phase"],
  name = "write",
  seconds = sequence,
): ThreadExecutionRecord => ({
  id: `${itemId}:${sequence}:${name}`,
  sequence,
  itemId,
  phase,
  name,
  kind: name.startsWith("runtime.") ? "status" : "tool",
  input: "",
  output: "",
  text: "",
  occurredAt: at(seconds),
});

describe("backend execution state", () => {
  it.each([
    ["WORKER_DEADLINE_EXCEEDED", "WORKER_DEADLINE_EXCEEDED"],
    ["SANDBOX_COMMAND_EFFECT_UNVERIFIED", "SANDBOX_COMMAND_EFFECT_UNVERIFIED"],
    ["SANDBOX_STRICT_MODE_UNAVAILABLE", "SANDBOX_STRICT_MODE_UNAVAILABLE"],
    ["/private/host/token", "TOOL_FAILED"],
  ] as const)("projects only allowlisted tool failure reasons (%s)", (reason, expected) => {
    const state = projectThreadExecutionState(
      { ...run, status: "failed" },
      [
        record(1, "failed-call", "failed"),
        record(2, "failed-call", "updated", `runtime.tool_reason.${reason}`),
      ],
      true,
    );
    expect(state.operations).toEqual([
      expect.objectContaining({
        itemId: "failed-call",
        displayPhase: "failed",
        reasonCode: expected,
      }),
    ]);
    expect(threadExecutionStateSchema.parse(state)).toEqual(state);
  });

  it("says the Run is looking up memory while it builds context, and only then", () => {
    const building = projectThreadExecutionState({ ...run, status: "building_context" }, [], true);
    expect(building).toMatchObject({
      displayPhase: "preparing",
      reasonCode: "RUN_BUILDING_CONTEXT",
    });
    expect(threadExecutionStateSchema.parse(building)).toEqual(building);
    expect(projectThreadExecutionState({ ...run, status: "accepted" }, [], true)).toMatchObject({
      displayPhase: "preparing",
      reasonCode: "EXECUTION_PREPARING",
    });
    expect(projectThreadExecutionState(run, [], true)).toMatchObject({
      displayPhase: "model_waiting",
      reasonCode: "EXECUTION_MODEL_WAITING",
    });
  });

  it("shows resource recovery while preserving the successful tool effect", () => {
    const state = projectThreadExecutionState(
      { ...run, status: "cancelled" },
      [record(1, "saved", "completed")],
      true,
      {
        revision: "resource-1",
        allReleased: false,
        pendingResources: true,
        unresolvedResultItemIds: [],
        phase: "stopping",
        reasonCode: "RESOURCE_STOP_IN_PROGRESS",
        lastObservedAt: at(5),
        operations: [
          {
            itemId: "saved",
            phase: "stopping",
            reasonCode: "RESOURCE_STOP_IN_PROGRESS",
            lastObservedAt: at(5),
          },
        ],
      },
    );
    expect(state).toMatchObject({
      displayPhase: "unresolved",
      reasonCode: "RESOURCE_STOP_IN_PROGRESS",
      lastObservedAt: at(5),
      effectSummary: [{ itemId: "saved", outcome: "succeeded" }],
      operations: [
        { itemId: "saved", displayPhase: "unresolved", reasonCode: "RESOURCE_STOP_IN_PROGRESS" },
      ],
      availableActions: [],
    });
    expect(threadExecutionStateSchema.parse(state)).toEqual(state);
  });
  it("ends cancelled cleanup only with complete release evidence, never an empty inventory", () => {
    const resources = {
      revision: "resource-1",
      allReleased: true,
      pendingResources: false,
      unresolvedResultItemIds: [],
      phase: null,
      reasonCode: "RESOURCE_RELEASE_CONFIRMED",
      lastObservedAt: at(5),
      operations: [
        {
          itemId: "saved",
          phase: "released" as const,
          reasonCode: "RESOURCE_RELEASE_CONFIRMED",
          lastObservedAt: at(5),
        },
      ],
    };
    const state = projectThreadExecutionState(
      { ...run, status: "cancelled" },
      [record(1, "saved", "completed")],
      true,
      resources,
    );
    expect(state).toMatchObject({
      displayPhase: "stopped",
      availableActions: [],
      effectSummary: [{ itemId: "saved", outcome: "succeeded" }],
    });
    expect(
      projectThreadExecutionState({ ...run, status: "cancelled" }, [], true, {
        ...resources,
        allReleased: false,
        operations: [],
      }).displayPhase,
    ).toBe("unresolved");
  });
  it("says a stop was not strictly confirmed when a process-group release ended the Run", () => {
    const released = (reasonCode: string) => ({
      itemId: "saved",
      phase: "released" as const,
      reasonCode,
      lastObservedAt: at(5),
    });
    const resources = {
      revision: "resource-1",
      allReleased: true,
      pendingResources: false,
      unresolvedResultItemIds: [],
      phase: null,
      reasonCode: "RESOURCE_STOP_NOT_STRICTLY_CONFIRMED",
      lastObservedAt: at(5),
      operations: [released("RESOURCE_STOP_NOT_STRICTLY_CONFIRMED")],
    };
    const cancelled = projectThreadExecutionState(
      { ...run, status: "cancelled" },
      [record(1, "saved", "completed")],
      true,
      resources,
    );
    expect(cancelled).toMatchObject({
      displayPhase: "stopped",
      reasonCode: "RUN_STOPPED_NOT_STRICTLY_CONFIRMED",
      availableActions: [],
      effectSummary: [{ itemId: "saved", outcome: "succeeded" }],
      operations: [
        {
          itemId: "saved",
          displayPhase: "completed",
          reasonCode: "RESOURCE_STOP_NOT_STRICTLY_CONFIRMED",
        },
      ],
    });
    expect(threadExecutionStateSchema.parse(cancelled)).toEqual(cancelled);
    const strict = projectThreadExecutionState(
      { ...run, status: "cancelled" },
      [record(1, "saved", "completed")],
      true,
      { ...resources, operations: [released("RESOURCE_RELEASE_CONFIRMED")] },
    );
    expect(strict).toMatchObject({
      displayPhase: "stopped",
      reasonCode: "RUN_CANCELLED_RESOURCES_RELEASED",
      operations: [{ itemId: "saved", displayPhase: "completed", reasonCode: "TOOL_SUCCEEDED" }],
    });
  });

  it("shows a deleted execution record without calling the step successful or blocking the Run", () => {
    const state = projectThreadExecutionState(
      { ...run, status: "completed" },
      [record(1, "old-call", "completed"), record(2, "new-call", "completed")],
      true,
      {
        revision: "resource-1",
        allReleased: true,
        pendingResources: false,
        unresolvedResultItemIds: [],
        phase: null,
        reasonCode: "RESOURCE_RELEASE_CONFIRMED",
        lastObservedAt: at(5),
        operations: [
          {
            itemId: "old-call",
            phase: "record_deleted",
            reasonCode: "EXECUTION_RECORD_DELETED",
            lastObservedAt: null,
          },
          {
            itemId: "new-call",
            phase: "released",
            reasonCode: "RESOURCE_RELEASE_CONFIRMED",
            lastObservedAt: at(5),
          },
        ],
      },
    );
    expect(state).toMatchObject({
      displayPhase: "completed",
      availableActions: [],
      operations: [
        { itemId: "old-call", displayPhase: "completed", reasonCode: "EXECUTION_RECORD_DELETED" },
        { itemId: "new-call", displayPhase: "completed", reasonCode: "TOOL_SUCCEEDED" },
      ],
    });
    expect(threadExecutionStateSchema.parse(state)).toEqual(state);
  });

  it("does not hide an unrendered resource behind a completed Run or a last successful tool", () => {
    const state = projectThreadExecutionState(
      { ...run, status: "completed" },
      [record(1, "saved", "completed")],
      true,
      {
        revision: "resource-1",
        allReleased: false,
        pendingResources: true,
        unresolvedResultItemIds: [],
        phase: "unresolved",
        reasonCode: "RESOURCE_STATE_UNCONFIRMED",
        lastObservedAt: at(5),
        operations: [
          {
            itemId: "other",
            phase: "unresolved",
            reasonCode: "RESOURCE_STATE_UNCONFIRMED",
            lastObservedAt: at(5),
          },
        ],
      },
    );
    expect(state.displayPhase).toBe("unresolved");
    expect(state.effectSummary).toEqual([{ itemId: "saved", outcome: "succeeded" }]);
  });

  it("does not advertise execution when resource observation contradicts a terminal Run", () => {
    const state = projectThreadExecutionState(
      { ...run, status: "completed" },
      [record(1, "saved", "completed")],
      true,
      {
        revision: "resource-1",
        allReleased: false,
        pendingResources: true,
        unresolvedResultItemIds: [],
        phase: "executing",
        reasonCode: "RESOURCE_EXECUTION_OBSERVED",
        lastObservedAt: at(5),
        operations: [],
      },
    );
    expect(state).toMatchObject({
      displayPhase: "unresolved",
      reasonCode: "RESOURCE_STATE_UNCONFIRMED",
    });
  });

  it("keeps an unrendered internal result unknown after every resource has released", () => {
    const state = projectThreadExecutionState({ ...run, status: "cancelled" }, [], true, {
      revision: "released-unknown",
      allReleased: true,
      pendingResources: false,
      phase: null,
      reasonCode: "RESOURCE_RELEASE_CONFIRMED",
      lastObservedAt: at(5),
      operations: [],
      unresolvedResultItemIds: ["missing-parent"],
    });
    expect(state).toMatchObject({
      displayPhase: "unresolved",
      reasonCode: "EXECUTION_RESULT_UNCONFIRMED",
      availableActions: [],
    });
  });

  it("shows a cancelled queue as not dispatched only with positive queue and tool evidence", () => {
    const resources = {
      revision: "queue-cancelled",
      allReleased: false,
      pendingResources: false,
      unresolvedResultItemIds: [],
      phase: null,
      reasonCode: "RESOURCE_QUEUE_CANCELLED",
      lastObservedAt: null,
      operations: [
        {
          itemId: "queued",
          phase: "not_dispatched" as const,
          reasonCode: "RESOURCE_QUEUE_CANCELLED",
          lastObservedAt: null,
        },
      ],
    };
    const records = [
      record(1, "queued", "failed"),
      record(2, "queued", "updated", "runtime.tool_outcome.not_dispatched"),
    ];
    expect(
      projectThreadExecutionState({ ...run, status: "cancelled" }, records, true, resources),
    ).toMatchObject({
      displayPhase: "not_dispatched",
      reasonCode: "RUN_CANCELLED_BEFORE_DISPATCH",
      availableActions: [],
    });
    expect(
      projectThreadExecutionState({ ...run, status: "cancelled" }, [], true, resources)
        .displayPhase,
    ).toBe("unresolved");
  });

  it("does not claim resource shutdown from a cancelled Run even when every tool returned", () => {
    expect(
      projectThreadExecutionState(
        { ...run, status: "cancelled" },
        [record(1, "saved", "completed")],
        true,
      ),
    ).toMatchObject({
      displayPhase: "unresolved",
      reasonCode: "RUN_CANCELLED_RESOURCE_STATE_UNCONFIRMED",
      effectSummary: [{ itemId: "saved", outcome: "succeeded" }],
      availableActions: ["retry_cleanup"],
    });
  });

  it("keeps concurrent unresolved operations when the last tool succeeds and the Run completes", () => {
    const state = projectThreadExecutionState(
      { ...run, status: "completed" },
      [record(1, "first", "started"), record(2, "second", "completed")],
      true,
    );
    expect(state).toMatchObject({
      displayPhase: "unresolved",
      availableActions: [],
      needsAttention: false,
      effectSummary: [
        { itemId: "first", outcome: "unknown" },
        { itemId: "second", outcome: "succeeded" },
      ],
      timing: { executionMilliseconds: null, reviewMilliseconds: null },
    });
    expect(threadExecutionStateSchema.parse(state)).toEqual(state);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "retains successful side effects after Run %s",
    (status) => {
      const state = projectThreadExecutionState(
        { ...run, status },
        [record(1, "saved", "completed")],
        true,
      );
      expect(state.operations[0]?.displayPhase).toBe("completed");
      expect(state.effectSummary[0]?.outcome).toBe("succeeded");
      expect(state.availableActions).toEqual(status === "completed" ? [] : ["retry_cleanup"]);
    },
  );

  it("never treats intent or model tool call as proof that the Worker started", () => {
    for (const phase of ["updated", "started"] as const) {
      const state = projectThreadExecutionState(run, [record(1, "intent", phase)], true);
      expect(state.operations[0]).toMatchObject({
        displayPhase: "preparing",
        reasonCode: "TOOL_START_UNCONFIRMED",
        executionMilliseconds: null,
      });
      expect(state.availableActions).toEqual(["stop"]);
    }
  });

  it("preserves authoritative non-dispatch and unknown markers", () => {
    const state = projectThreadExecutionState(
      run,
      [
        record(1, "conflict", "updated", "runtime.tool_outcome.not_dispatched"),
        record(1, "conflict", "failed"),
        record(2, "lost", "updated", "runtime.tool_outcome.unresolved"),
        record(2, "lost", "failed"),
        record(3, "ok", "completed"),
      ],
      false,
    );
    expect(state.displayPhase).toBe("unresolved");
    expect(state.operations.map((operation) => operation.displayPhase)).toEqual([
      "not_dispatched",
      "unresolved",
      "completed",
    ]);
    expect(state.availableActions).toEqual([]);
  });

  it("uses actual parallel interval union and no missing or backwards interval", () => {
    const records = [
      record(1, "a", "updated", "runtime.tool_execution.started", 1),
      record(2, "a", "updated", "runtime.tool_execution.ended", 5),
      record(3, "b", "updated", "runtime.tool_execution.started", 3),
      record(4, "b", "updated", "runtime.tool_execution.ended", 8),
      record(5, "missing", "updated", "runtime.tool_execution.started", 4),
      record(6, "skew", "updated", "runtime.tool_execution.started", 9),
      record(7, "skew", "updated", "runtime.tool_execution.ended", 7),
      record(8, "review", "updated", "runtime.authorization_review.started", 2),
      record(9, "review", "updated", "runtime.authorization_review.approved", 4),
    ];
    const state = projectThreadExecutionState(run, records, true);
    expect(state.timing).toEqual({ executionMilliseconds: 7000, reviewMilliseconds: 2000 });
    expect(projectThreadExecutionState(run, [...records, ...records].reverse(), true)).toEqual(
      state,
    );
  });

  it("changes revision for Run and evidence changes but not rereads or unrelated clock time", () => {
    const records = [record(1, "a", "started")];
    const state = projectThreadExecutionState(run, records, true);
    expect(projectThreadExecutionState(run, records, true)).toEqual(state);
    expect(projectThreadExecutionState({ ...run, revision: 4 }, records, true).revision).not.toBe(
      state.revision,
    );
    expect(
      projectThreadExecutionState(run, [...records, record(2, "a", "completed")], true).revision,
    ).not.toBe(state.revision);
  });

  it("only requests human attention for an available human action", () => {
    const state = projectThreadExecutionState({ ...run, status: "awaiting_approval" }, [], false);
    expect(state).toMatchObject({
      displayPhase: "awaiting_approval",
      needsAttention: true,
      availableActions: ["review_approval"],
    });
    expect(projectThreadExecutionState(run, [], true).needsAttention).toBe(false);
    expect(
      projectThreadExecutionState({ ...run, status: "reconciling_external_result" }, [], false),
    ).toMatchObject({ displayPhase: "unresolved", needsAttention: false });
  });
});

describe("execution state history read boundary", () => {
  const input = {
    ownerId: "owner-state",
    agentId: "agent-state",
    threadId: "thread-state",
    runId: run.runId,
    canCancelRun: true,
  };
  function fixture() {
    const listRuns = vi.fn().mockResolvedValue([run]);
    const projection = new ThreadExecutionProjection({
      threads: { listRuns },
    } as unknown as ConstructorParameters<typeof ThreadExecutionProjection>[0]);
    const read = vi.spyOn(projection, "read");
    return { projection, read, listRuns };
  }
  it("rejects resource changes across the Trace read even when the Run revision is unchanged", async () => {
    const inventory = {
      admissions: [],
      queue: [],
      legacyResourcesPending: false,
      deletedPlans: [],
    };
    const readInventory = vi
      .fn()
      .mockResolvedValueOnce(inventory)
      .mockResolvedValueOnce({ ...inventory, legacyResourcesPending: true });
    const projection = new ThreadExecutionProjection({
      threads: { listRuns: async () => [run] },
      payloads: () => ({ get: async () => undefined }),
      protector: {},
      resources: { readInventory, now: () => at(10), digest: () => "a".repeat(64) },
    } as unknown as ConstructorParameters<typeof ThreadExecutionProjection>[0]);
    vi.spyOn(projection, "read").mockResolvedValue({ records: [], nextSequence: null });
    await expect(projection.readState(input)).rejects.toThrow(
      "THREAD_EXECUTION_RESOURCES_CHANGED_DURING_READ",
    );
  });
  it("reads all pages so an earlier unresolved tool cannot be hidden by a later success", async () => {
    const { projection, read } = fixture();
    read.mockResolvedValueOnce({
      records: [
        record(1, "first", "updated", "runtime.tool_outcome.unresolved"),
        record(1, "first", "failed"),
      ],
      nextSequence: 1000,
    });
    read.mockResolvedValueOnce({
      records: [record(1001, "last", "completed")],
      nextSequence: null,
    });
    expect(await projection.readState(input)).toMatchObject({
      displayPhase: "unresolved",
      operations: [{ itemId: "first" }, { itemId: "last" }],
    });
    expect(read.mock.calls.map(([query]) => query.afterSequence)).toEqual([0, 1000]);
  });
  it("projects a safe product failure reason to the tool row without exposing raw diagnostics", async () => {
    const payloadValues = new Map([
      ["outer", { payloadRef: "tool-result" }],
      [
        "tool-result",
        {
          toolCallId: "deadline-call",
          toolName: "write",
          arguments: {},
          isError: true,
          result: {
            details: {
              dispatchState: "not_sent",
              productOutcome: "failed",
              errorCode: "WORKER_DEADLINE_EXCEEDED",
              protectedDiagnostic: "/private/host/token",
            },
            content: [],
          },
        },
      ],
    ]);
    const traceEvent = {
      id: "tool-event",
      schemaVersion: "trace.v1",
      ownerId: input.ownerId,
      agentId: input.agentId,
      sessionId: "session-state",
      threadId: input.threadId,
      runId: input.runId,
      turnId: null,
      parentEventId: null,
      causationId: null,
      correlationId: "run-state",
      sequence: 1,
      occurredAt: at(2),
      recordedAt: at(2),
      actorId: "runtime",
      dataClassification: "private",
      eventType: "runtime.tool_result",
      payloadRef: "outer",
    };
    const projection = new ThreadExecutionProjection({
      threads: {
        read: async () => ({ status: "active" }),
        listRuns: async () => [run],
      },
      trace: { readRun: async () => [traceEvent] },
      payloads: () => ({
        get: async (ref: string) => ({
          ref,
          dataClassification: "private",
          contentType: "application/json",
          ciphertext: new TextEncoder().encode(JSON.stringify(payloadValues.get(ref))),
        }),
      }),
      protector: {
        unprotect: async ({ payload }: { payload: { ciphertext: Uint8Array } }) =>
          payload.ciphertext,
      },
    } as unknown as ConstructorParameters<typeof ThreadExecutionProjection>[0]);
    const state = await projection.readState(input);
    expect(state.operations).toEqual([
      expect.objectContaining({
        itemId: expect.stringMatching(/^tool:/),
        displayPhase: "not_dispatched",
        reasonCode: "WORKER_DEADLINE_EXCEEDED",
      }),
    ]);
    expect(JSON.stringify(state)).not.toContain("/private/host/token");
  });
  it("rejects a Run revision change instead of mixing old observations with new controls", async () => {
    const { projection, read, listRuns } = fixture();
    listRuns
      .mockResolvedValueOnce([run])
      .mockResolvedValueOnce([{ ...run, revision: 4, status: "completed" }]);
    read.mockResolvedValue({ records: [], nextSequence: null });
    await expect(projection.readState(input)).rejects.toThrow(
      "THREAD_EXECUTION_CHANGED_DURING_READ",
    );
  });
  it("rejects a stalled cursor and a history beyond the finite read budget", async () => {
    const { projection, read } = fixture();
    read.mockResolvedValue({ records: [], nextSequence: 0 });
    await expect(projection.readState(input)).rejects.toThrow(
      "THREAD_EXECUTION_PAGE_NOT_ADVANCING",
    );
    read.mockImplementation(async (query) => ({
      records: [],
      nextSequence: query.afterSequence + 1000,
    }));
    await expect(projection.readState(input)).rejects.toThrow("THREAD_EXECUTION_HISTORY_LIMIT");
  });
  it("does not report an unreadable tool result as an empty successful Run", () => {
    expect(
      projectThreadExecutionState(
        { ...run, status: "completed" },
        [record(1, "unreadable", "unavailable", "runtime.tool_result")],
        true,
      ),
    ).toMatchObject({
      displayPhase: "unresolved",
      effectSummary: [{ itemId: "unreadable", outcome: "unknown" }],
    });
  });
});
