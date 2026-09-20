import { describe, expect, it, vi } from "vitest";
import { createRunId } from "@himawari-agent/domain";
import {
  threadExecutionStateSchema,
  type ThreadExecutionRecord,
} from "@himawari-agent/gateway-contracts";
import { projectThreadExecutionState } from "../src/services/thread-execution-state.js";
import { ThreadExecutionProjection } from "../src/services/thread-execution-projection.js";
import type { ThreadRunSummaryRecord } from "../src/ports/threads.js";

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
