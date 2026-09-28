import type {
  ThreadExecutionRecord,
  ThreadExecutionState,
} from "@himawari-agent/gateway-contracts";
import { describe, expect, it } from "vitest";
import {
  authorizationReviewSteps,
  executionActivity,
  executionFailureMessage,
  executionItems,
  executionItemWorkTime,
  executionNextAction,
  executionStateLabel,
  executionTime,
  executionToolPhase,
  type RunSummary,
  recordedInterval,
  thinkingSteps,
} from "../src/execution-view.js";

const record = (
  sequence: number,
  seconds: number,
  overrides: Partial<ThreadExecutionRecord> = {},
): ThreadExecutionRecord => ({
  id: `event:${sequence}`,
  itemId: "call:one",
  sequence,
  kind: "status",
  phase: "started",
  name: "runtime.model_started",
  text: "",
  input: "",
  output: "",
  occurredAt: new Date(seconds * 1000).toISOString(),
  ...overrides,
});
const run: RunSummary = {
  runId: "run:one",
  revision: 1,
  status: "running",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(100000).toISOString(),
};
describe("durable execution presentation", () => {
  it.each([
    ["runtime.tool_outcome.failed", "chat.reason.toolDeadlineExceeded"],
    ["runtime.tool_reason.SANDBOX_TOOL_DEADLINE_EXCEEDED", "chat.reason.toolDeadlineExceeded"],
    ["runtime.tool_outcome.unresolved", "chat.phase.unresolved"],
    ["runtime.tool_outcome.not_dispatched", "chat.phase.notDispatched"],
  ] as const)("retains deadline reasons without overriding %s", (outcome, expected) => {
    const failed = record(2, 2, { kind: "tool", name: "bash", phase: "failed" });
    expect(
      executionToolPhase(
        failed,
        [
          failed,
          record(3, 2, { name: "runtime.tool_reason.SANDBOX_TOOL_DEADLINE_EXCEEDED" }),
          record(4, 2, { name: outcome }),
        ],
        { ...run, status: "completed" },
      ),
    ).toBe(expected);
  });

  it.each([
    {
      displayPhase: "unresolved",
      availableActions: [],
      effectSummary: [{ itemId: "call", outcome: "unknown" }],
      expected: "chat.nextAction.unresolved",
    },
    {
      displayPhase: "unresolved",
      availableActions: ["stop"],
      effectSummary: [{ itemId: "call", outcome: "unknown" }],
      expected: "chat.nextAction.stop",
    },
    {
      displayPhase: "unresolved",
      availableActions: ["retry_cleanup"],
      effectSummary: [{ itemId: "call", outcome: "unknown" }],
      expected: "chat.nextAction.retryCleanup",
    },
    {
      displayPhase: "not_dispatched",
      availableActions: [],
      effectSummary: [{ itemId: "call", outcome: "not_dispatched" }],
      expected: "chat.nextAction.notDispatched",
    },
    {
      displayPhase: "stopped",
      availableActions: [],
      effectSummary: [{ itemId: "call", outcome: "succeeded" }],
      expected: "chat.nextAction.stoppedWithResults",
    },
    {
      displayPhase: "failed",
      availableActions: [],
      effectSummary: [
        { itemId: "call:one", outcome: "succeeded" },
        { itemId: "call:two", outcome: "failed" },
      ],
      expected: "chat.nextAction.partial",
    },
    {
      displayPhase: "failed",
      availableActions: [],
      effectSummary: [{ itemId: "call", outcome: "failed" }],
      expected: "chat.nextAction.failed",
    },
    {
      displayPhase: "failed",
      availableActions: [],
      effectSummary: [],
      expected: "chat.nextAction.failedBeforeAnyOperation",
    },
    {
      displayPhase: "completed",
      availableActions: [],
      effectSummary: [{ itemId: "call", outcome: "succeeded" }],
      expected: undefined,
    },
  ] as const)("shows a safe next action for $displayPhase execution", (scenario) => {
    const state: ThreadExecutionState = {
      runRevision: 1,
      revision: "state-1",
      lastObservedAt: new Date(1000).toISOString(),
      displayPhase: scenario.displayPhase,
      reasonCode: "EXECUTION_STATE",
      availableActions: scenario.availableActions,
      needsAttention: false,
      timing: { reviewMilliseconds: null, executionMilliseconds: null },
      effectSummary: scenario.effectSummary,
      operations: [],
    };
    expect(executionNextAction(state)).toBe(scenario.expected);
  });

  it("localizes resource facts without requiring a new wire phase or inferring release", () => {
    expect(executionStateLabel("unresolved", "RESOURCE_STOP_IN_PROGRESS")).toBe(
      "chat.resource.stopping",
    );
    expect(executionStateLabel("unresolved", "RESOURCE_CHECK_IN_PROGRESS")).toBe(
      "chat.resource.verifying",
    );
    expect(executionStateLabel("preparing", "RUN_BUILDING_CONTEXT")).toBe(
      "chat.activity.buildingContext",
    );
    expect(executionStateLabel("preparing", "RESOURCE_QUEUE_WAITING")).toBe("chat.resource.queued");
    expect(executionStateLabel("preparing", "RESOURCE_EXECUTION_OBSERVED")).toBe(
      "chat.resource.executing",
    );
    expect(executionStateLabel("failed", "WORKER_DEADLINE_EXCEEDED")).toBe(
      "chat.reason.deadlineExceeded",
    );
    expect(executionStateLabel("failed", "WORKER_RESOURCE_CEILING_CHANGED")).toBe(
      "chat.reason.resourceCeilingChanged",
    );
    expect(executionStateLabel("failed", "WORKER_AUTHORIZATION_DENIED")).toBe(
      "chat.reason.authorizationDenied",
    );
    expect(executionStateLabel("failed", "SANDBOX_COMMAND_EFFECT_UNVERIFIED")).toBe(
      "chat.reason.commandEffectUnverified",
    );
    expect(executionStateLabel("not_dispatched", "SANDBOX_STRICT_MODE_UNAVAILABLE")).toBe(
      "chat.reason.strictModeUnavailable",
    );
    expect(executionStateLabel("unresolved", "RESOURCE_STATE_UNCONFIRMED")).toBe(
      "chat.phase.unresolved",
    );
    expect(executionStateLabel("unresolved", "FUTURE_REASON")).toBe("chat.phase.unresolved");
    expect(executionStateLabel("completed", "RESOURCE_STOP_NOT_STRICTLY_CONFIRMED")).toBe(
      "chat.resource.stopNotStrictlyConfirmed",
    );
    expect(executionStateLabel("stopped", "RUN_STOPPED_NOT_STRICTLY_CONFIRMED")).toBe(
      "chat.resource.stopNotStrictlyConfirmed",
    );
    expect(executionStateLabel("completed", "EXECUTION_RECORD_DELETED")).toBe(
      "chat.resource.recordDeleted",
    );
    expect(executionStateLabel("completed", "RESOURCE_RELEASE_CONFIRMED")).toBe(
      "chat.phase.completed",
    );
  });

  it("explains what a stop without strict confirmation leaves running", () => {
    const state: ThreadExecutionState = {
      runRevision: 1,
      revision: "state-1",
      lastObservedAt: new Date(1000).toISOString(),
      displayPhase: "stopped",
      reasonCode: "RUN_STOPPED_NOT_STRICTLY_CONFIRMED",
      availableActions: [],
      needsAttention: false,
      timing: { reviewMilliseconds: null, executionMilliseconds: null },
      effectSummary: [{ itemId: "call", outcome: "succeeded" }],
      operations: [],
    };
    expect(executionNextAction(state)).toBe("chat.nextAction.stopNotStrictlyConfirmed");
    expect(executionNextAction({ ...state, reasonCode: "RUN_CANCELLED_RESOURCES_RELEASED" })).toBe(
      "chat.nextAction.stoppedWithResults",
    );
  });
  it("merges replayed out-of-order observations without erasing tool input", () => {
    const started = record(1, 10, { kind: "tool", name: "read", input: '{"path":"README.md"}' });
    const ended = record(3, 13, {
      kind: "tool",
      name: "read",
      phase: "completed",
      output: "contents",
    });
    expect(executionItems([ended, started, ended])).toEqual([
      {
        ...ended,
        firstSequence: 1,
        requestedAt: null,
        input: started.input,
        startedAt: started.occurredAt,
        endedAt: ended.occurredAt,
      },
    ]);
  });
  it("keeps independent tool calls and message snapshots", () => {
    expect(
      executionItems([
        record(1, 1, { kind: "tool" }),
        record(2, 2, { kind: "tool", itemId: "call:two" }),
        record(3, 3, { kind: "message", itemId: "message:one", text: "a" }),
        record(4, 4, { kind: "message", itemId: "message:one", text: "answer" }),
      ]).map((item) => item.text),
    ).toEqual(["", "", "answer"]);
  });
  it("restores elapsed work and approval wait from historical boundaries", () => {
    const history = [
      record(1, 10),
      record(2, 20, { phase: "waiting" }),
      record(3, 50),
      record(4, 60, { phase: "completed" }),
    ];
    expect(executionTime(history, { ...run, status: "completed" }, 999999)).toEqual({
      work: 20000,
      wait: 30000,
      known: true,
    });
    expect(
      executionTime(history.slice(0, 2), { ...run, status: "awaiting_approval" }, 35000),
    ).toEqual({ work: 10000, wait: 15000, known: true });
  });
  it("stops clocks at the persisted terminal update and marks missing clocks unknown", () => {
    expect(executionTime([record(1, 10)], { ...run, status: "cancelled" }, 999999).work).toBe(
      90000,
    );
    expect(executionTime([], run, 999999)).toEqual({ work: 0, wait: 0, known: false });
  });
});

it("shows only known failure messages from replayed execution records", () => {
  const failed = record(3, 3, {
    phase: "failed",
    name: "runtime.failed",
    text: "PI_MODEL_RATE_LIMITED",
  });
  expect(executionFailureMessage([failed, record(1, 1), failed])).toBe("chat.error.rateLimited");
  expect(executionFailureMessage([{ ...failed, text: "PRIVATE_PROVIDER_ERROR" }])).toBe(
    "chat.error.failed",
  );
  expect(executionFailureMessage([])).toBe("chat.error.failed");
  expect(executionFailureMessage([{ ...failed, text: "CONTEXT_MEMORY_UNAVAILABLE" }])).toBe(
    "chat.error.contextMemoryUnavailable",
  );
});

it("excludes approval wait from tool time and keeps the first completed message boundary", () => {
  const start = record(1, 10, { kind: "tool" });
  const wait = record(2, 12, { phase: "waiting" });
  const resume = record(3, 42);
  const end = record(4, 45, { kind: "tool", phase: "completed" });
  const history = [end, wait, start, resume, wait];
  const item = executionItems(history)[0];
  if (!item) throw new Error("Missing tool fixture");
  expect(executionItemWorkTime(item, history)).toBe(5000);
  const replayed = executionItems([
    start,
    end,
    record(5, 90, { kind: "tool", phase: "completed" }),
  ])[0];
  expect(replayed?.endedAt).toBe(end.occurredAt);
});

it("distinguishes actual thinking, tools, waiting and a stale connection", () => {
  const thinking = record(1, 10, { phase: "updated", name: "runtime.activity.thinking" });
  expect(executionActivity([thinking], run, "connected", 12000)).toMatchObject({
    label: "chat.activity.thinking",
    stale: false,
  });
  const tool = record(2, 12, { kind: "tool", name: "web_search" });
  expect(executionActivity([thinking, tool], run, "connected", 30000)).toMatchObject({
    label: "chat.activity.tool",
    tool: "web_search",
    stale: true,
    age: 18000,
  });
  expect(executionActivity([tool], run, "offline", 30000).label).toBe("chat.disconnected");
  expect(
    executionActivity([tool], { ...run, status: "awaiting_approval" }, "connected", 30000),
  ).toMatchObject({ label: "runs.status.awaitingApproval", stale: false });
});

it("omits successful textless messages but preserves failures and actual text", () => {
  const items = executionItems([
    record(1, 1, { kind: "message", itemId: "empty", phase: "completed" }),
    record(2, 2, { kind: "message", itemId: "space", text: "  \n", phase: "updated" }),
    record(3, 3, { kind: "message", itemId: "error", phase: "failed" }),
    record(4, 4, { kind: "message", itemId: "answer", text: "Answer", phase: "completed" }),
  ]);
  expect(items.map((item) => item.itemId)).toEqual(["error", "answer"]);
});

it("keeps the model request time and arguments separate from tool execution", () => {
  const request = record(1, 1, {
    kind: "tool",
    phase: "updated",
    name: "web_search",
    input: '{"query":"Tokyo"}',
  });
  const start = record(2, 3, { kind: "tool", name: "web_search" });
  const end = record(3, 8, {
    kind: "tool",
    name: "web_search",
    phase: "completed",
    output: "News",
  });
  expect(executionItems([end, request, start, end])[0]).toMatchObject({
    requestedAt: request.occurredAt,
    startedAt: start.occurredAt,
    endedAt: end.occurredAt,
    input: request.input,
    output: "News",
  });
});

it("uses only execution-host timing, never time spent requesting or awaiting approval", () => {
  const records = [
    record(1, 1, { kind: "tool", phase: "started" }),
    record(2, 2, { phase: "waiting" }),
    record(3, 62),
    record(4, 70, { phase: "updated", name: "runtime.tool_execution.started" }),
    record(5, 72, { phase: "updated", name: "runtime.tool_execution.ended" }),
    record(6, 80, { kind: "tool", phase: "completed" }),
  ];
  expect(recordedInterval(records, "call:one", "runtime.tool_execution")).toBe(2000);
  expect(
    recordedInterval(
      records.filter((_, i) => i === 0 || i === 5),
      "call:one",
      "runtime.tool_execution",
    ),
  ).toBeNull();
  expect(recordedInterval(records, "other", "runtime.tool_execution")).toBeNull();
  expect(
    recordedInterval([...records, ...records.slice(4, 5)], "call:one", "runtime.tool_execution"),
  ).toBe(2000);
});
it("pairs observed thinking boundaries and keeps legacy observations untimed", () => {
  const records = [
    record(1, 10, { phase: "updated", name: "runtime.thinking.started" }),
    record(2, 12, { phase: "updated", name: "runtime.thinking.ended" }),
  ];
  expect(thinkingSteps(records)).toMatchObject([{ elapsed: 2000 }]);
  expect(thinkingSteps(records.slice(0, 1))).toMatchObject([{ elapsed: null }]);
  expect(thinkingSteps([record(1, 1, { name: "runtime.activity.thinking" })])).toMatchObject([
    { elapsed: null },
  ]);
});

it("uses durable admission and unresolved markers independently from Pi tool starts", () => {
  const tool = record(2, 1, { kind: "tool", name: "write", phase: "failed" });
  const outcome = record(2, 1, {
    id: "outcome",
    phase: "updated",
    name: "runtime.tool_outcome.not_dispatched",
  });
  expect(executionToolPhase(tool, [outcome, tool], run)).toBe("chat.phase.notDispatched");
  expect(
    executionToolPhase(tool, [{ ...outcome, name: "runtime.tool_outcome.unresolved" }], run),
  ).toBe("chat.phase.unresolved");
  expect(
    executionToolPhase(
      tool,
      [{ ...outcome, sequence: 1, name: "runtime.tool_outcome.preparing" }],
      run,
    ),
  ).toBeUndefined();
  expect(
    executionActivity(
      [outcome],
      { ...run, status: "reconciling_external_result" },
      "connected",
      1000,
    ).label,
  ).toBe("chat.phase.unresolved");
});

it("shows the recorded automatic-review source and only complete review intervals", () => {
  const start = record(2, 20, {
    phase: "updated",
    itemId: "review:one",
    name: "runtime.authorization_review.started",
  });
  const end = record(3, 23, {
    phase: "updated",
    itemId: "review:one",
    name: "runtime.authorization_review.approved",
  });
  expect(authorizationReviewSteps([end, start, end])).toEqual([
    expect.objectContaining({
      itemId: "review:one",
      sequence: 2,
      outcome: "approved",
      elapsed: 3000,
    }),
  ]);
  expect(authorizationReviewSteps([end])[0]?.elapsed).toBeNull();
  expect(authorizationReviewSteps([start])[0]?.elapsed).toBeNull();
  expect(
    authorizationReviewSteps([start, { ...end, occurredAt: new Date(19000).toISOString() }])[0]
      ?.elapsed,
  ).toBeNull();
  expect(
    executionTime(
      [record(1, 10), start, end, record(4, 30, { phase: "completed" })],
      { ...run, status: "completed" },
      999999,
    ),
  ).toEqual({ work: 20000, wait: 0, known: true });
});

it("prioritizes live review without reviving it after confirmation, cancellation or a later model turn", () => {
  const start = record(3, 20, {
    phase: "updated",
    itemId: "review:one",
    name: "runtime.authorization_review.started",
  });
  const call = record(2, 15, { kind: "tool", name: "write" });
  expect(executionActivity([record(1, 10), call, start], run, "connected", 22000).label).toBe(
    "review.authorizationChecking",
  );
  expect(
    executionActivity([start], { ...run, status: "awaiting_approval" }, "connected", 22000).label,
  ).toBe("runs.status.awaitingApproval");
  expect(executionActivity([start], run, "offline", 22000).label).toBe("chat.disconnected");
  expect(executionActivity([start, record(4, 24)], run, "connected", 25000).label).toBe(
    "chat.activity.waitingModel",
  );
  expect(
    executionActivity([start], { ...run, status: "cancelled" }, "connected", 25000).label,
  ).not.toBe("review.authorizationChecking");
  const approved = {
    ...start,
    id: "approved",
    sequence: 4,
    name: "runtime.authorization_review.approved",
  };
  expect(executionActivity([start, approved], run, "connected", 25000).label).not.toBe(
    "review.authorizationChecking",
  );
});

it("ignores unavailable or malformed review observations", () => {
  expect(
    authorizationReviewSteps([
      record(1, 1, { phase: "unavailable", name: "runtime.authorization_review.approved" }),
      record(2, 2, { phase: "updated", name: "runtime.authorization_review.injected" }),
    ]),
  ).toEqual([]);
});

it.each(["cancelled", "failed", "completed"] as const)(
  "does not keep a terminal %s tool in preparation when its result is missing",
  (status) => {
    const tool = record(2, 1, { kind: "tool", name: "write", phase: "updated" });
    const preparing = record(3, 1, { phase: "updated", name: "runtime.tool_outcome.preparing" });
    expect(executionToolPhase(tool, [tool, preparing], { ...run, status })).toBe(
      "chat.phase.unresolved",
    );
    expect(executionToolPhase(tool, [tool, preparing], run)).toBe("chat.phase.preparing");
    expect(
      executionToolPhase(
        tool,
        [tool, { ...preparing, name: "runtime.tool_outcome.not_dispatched" }],
        { ...run, status },
      ),
    ).toBe("chat.phase.notDispatched");
    expect(
      executionToolPhase({ ...tool, sequence: 4, phase: "completed" }, [preparing], {
        ...run,
        status,
      }),
    ).toBeUndefined();
    expect(recordedInterval([tool, preparing], tool.itemId, "runtime.tool_execution")).toBeNull();
  },
);

it.each(["RUN_EXECUTION_DEADLINE_EXCEEDED", "SANDBOX_TOOL_DEADLINE_EXCEEDED"])(
  "localizes the deadline reason %s",
  (reason) => {
    expect(executionStateLabel("failed", reason)).toBe(
      reason === "RUN_EXECUTION_DEADLINE_EXCEEDED"
        ? "chat.reason.runDeadlineExceeded"
        : "chat.reason.toolDeadlineExceeded",
    );
  },
);
