import type {
  ThreadExecutionRecord,
  ThreadExecutionState,
  ThreadGatewaySnapshot,
} from "@himawari-agent/gateway-contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ChatHistory } from "../src/components/chat-history.js";

type Detail = Extract<ThreadGatewaySnapshot, { type: "thread.detail_snapshot" }>;
function render(
  status: Detail["payload"]["runs"][number]["status"],
  kind: "message" | "tool",
  phase: ThreadExecutionRecord["phase"],
) {
  return renderRun(status, [
    {
      id: "event:partial",
      itemId: "output:one",
      sequence: 1,
      kind,
      phase,
      name: kind === "tool" ? "write" : "",
      text: "保留的部分回答",
      input: "",
      output: "",
      occurredAt: "2026-09-11T00:00:02Z",
    },
  ]);
}
function renderRun(
  status: Detail["payload"]["runs"][number]["status"],
  records: ThreadExecutionRecord[],
  state?: ThreadExecutionState,
  extra: Record<string, unknown> = {},
) {
  const detail: Detail = {
    schemaVersion: "gateway.thread.v3",
    kind: "snapshot",
    type: "thread.detail_snapshot",
    messageId: "snapshot:one",
    correlationId: "query:one",
    causationId: null,
    scope: { ownerId: "owner:test", agentId: "agent:test" },
    authority: { deploymentId: "deployment:test", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "system", actorId: "system:test" },
    payload: {
      thread: {
        threadId: "thread:test",
        revision: 1,
        status: "active",
        titleRef: null,
        titleSource: null,
        titleRevision: 0,
        pinOrder: null,
        answerLocale: "zh-CN",
        messageWatermark: 0,
        sourceThreadId: null,
        sourceWatermark: null,
        createdAt: "2026-09-11T00:00:00Z",
        updatedAt: "2026-09-11T00:00:12Z",
      },
      snapshotRef: "snapshot:one",
      generatedAt: "2026-09-11T00:00:12Z",
      nextSequence: null,
      messages: [],
      runs: [
        {
          runId: "run:cancel",
          revision: 1,
          status,
          createdAt: "2026-09-11T00:00:00Z",
          updatedAt: "2026-09-11T00:00:12Z",
          background: null,
          backgroundCommands: [],
        },
      ],
    },
  };
  return renderToStaticMarkup(
    createElement(ChatHistory, {
      detail,
      contentByRef: {},
      execution: { "run:cancel": records },
      ...(state ? { executionStates: { "run:cancel": state }, executionStateAvailable: true } : {}),
      connection: "connected",
      message: (id) => id,
      renderApproval: () => null,
      ...extra,
    }),
  );
}
it("stops the partial output label when a Run is cancelled, while preserving its text", () => {
  const html = render("cancelled", "message", "updated");
  expect(html).toContain("保留的部分回答");
  expect(html).toContain("chat.phase.stopped");
  expect(html).not.toContain("chat.phase.updated");
});
it("does not infer a tool result or completed output from a terminal Run", () => {
  expect(render("cancelled", "tool", "started")).toContain("chat.recordUnavailable");
  expect(render("failed", "message", "updated")).toContain("chat.recordUnavailable");
  expect(render("completed", "message", "updated")).toContain("chat.recordUnavailable");
  expect(render("cancelled", "message", "completed")).toContain("chat.phase.completed");
});
it("keeps active partial outputs marked as streaming", () => {
  expect(render("running", "message", "updated")).toContain("chat.phase.updated");
});

const record = (
  sequence: number,
  itemId: string,
  kind: "message" | "tool",
  phase: ThreadExecutionRecord["phase"],
  text = "",
): ThreadExecutionRecord => ({
  id: `event:${sequence}:${itemId}`,
  itemId,
  sequence,
  kind,
  phase,
  name: kind === "tool" ? "web_search" : "deepseek",
  text,
  input: kind === "tool" ? `{"query":"${itemId}"}` : "",
  output: "",
  occurredAt: `2026-09-11T00:00:0${sequence}Z`,
});
const narration = "I'll search for the latest US news now.";
const searching = [
  record(1, "message:narration", "message", "updated", narration),
  record(2, "message:narration", "message", "completed", narration),
  record(2, "call:first", "tool", "updated"),
  record(2, "call:second", "tool", "updated"),
  record(3, "call:first", "tool", "started"),
];
const searchingState: ThreadExecutionState = {
  runRevision: 1,
  revision: "state:one",
  lastObservedAt: "2026-09-11T00:00:03Z",
  displayPhase: "preparing",
  reasonCode: "RESOURCE_EXECUTION_OBSERVED",
  availableActions: ["stop"],
  needsAttention: false,
  timing: { reviewMilliseconds: null, executionMilliseconds: null },
  effectSummary: [
    { itemId: "call:first", outcome: "pending" },
    { itemId: "call:second", outcome: "pending" },
  ],
  operations: [
    {
      itemId: "call:first",
      displayPhase: "preparing",
      reasonCode: "RESOURCE_EXECUTION_OBSERVED",
      lastObservedAt: "2026-09-11T00:00:03Z",
      executionMilliseconds: null,
    },
    {
      itemId: "call:second",
      displayPhase: "preparing",
      reasonCode: "TOOL_START_UNCONFIRMED",
      lastObservedAt: "2026-09-11T00:00:02Z",
      executionMilliseconds: null,
    },
  ],
};
it("keeps model narration before tool calls inside the step chain instead of marking it as a completed answer", () => {
  const html = renderRun("running", searching, searchingState);
  expect(html).not.toContain("chat.phase.completed");
  expect(html).not.toContain("partial-status");
  expect(html).toMatch(
    /<li class="execution-stage execution-note">.*I&#x27;ll search for the latest US news now\.<\/span><\/li>/,
  );
  expect(html.indexOf("execution-note")).toBeLessThan(html.indexOf("call:first"));
});
it("shows a requested tool that has not started as queued behind the running one", () => {
  const html = renderRun("running", searching, searchingState);
  expect(html).toContain("chat.resource.executing");
  expect(html).toContain("chat.phase.queued");
  expect(html).not.toContain("chat.phase.preparing");
});
it("shows a tool whose execution environment stopped reporting in plain words", () => {
  const html = renderRun("running", searching, {
    ...searchingState,
    displayPhase: "unresolved",
    reasonCode: "EXECUTION_RESULT_UNCONFIRMED",
    operations: searchingState.operations.map((operation) =>
      operation.itemId === "call:first"
        ? { ...operation, displayPhase: "unresolved", reasonCode: "RESOURCE_OBSERVATION_EXPIRED" }
        : operation,
    ),
  });
  expect(html).toContain("chat.resource.noReport");
  expect(html).toContain("chat.phase.queued");
});
it("labels the final answer as streaming until the Run itself ends", () => {
  const answer = [
    ...searching,
    record(4, "call:first", "tool", "completed"),
    record(5, "call:second", "tool", "started"),
    record(6, "call:second", "tool", "completed"),
    record(7, "message:answer", "message", "updated", "十条新闻"),
    record(8, "message:answer", "message", "completed", "十条新闻"),
  ];
  const running = renderRun("running", answer);
  expect(running).toContain('<p class="partial-status">chat.phase.updated</p>');
  expect(running).toContain("十条新闻");
  expect(renderRun("cancelled", answer)).toContain(
    '<p class="partial-status">chat.phase.completed</p>',
  );
});

it("[UI-47] never shows the memories brought to the model as process steps", () => {
  const memory = (
    sequence: number,
    name: string,
    phase: ThreadExecutionRecord["phase"],
    count: string,
  ): ThreadExecutionRecord => ({
    id: `trace:${sequence}`,
    itemId: `trace:${sequence}`,
    sequence,
    kind: "status",
    phase,
    name,
    text: count,
    input: "",
    output: "",
    occurredAt: `2026-09-11T00:00:0${sequence}Z`,
  });
  const html = renderRun("completed", [
    memory(1, "memory.query", "updated", ""),
    memory(2, "memory.selection", "completed", "2"),
    memory(3, "context.formed", "completed", "9"),
    record(4, "message:answer", "message", "completed", "已写好 PDF。"),
  ]);
  expect(html).not.toContain('data-tool-category="memory"');
  expect(html).not.toContain("memory-record");
});
it("[I-23] shows no memory step when no memory passed the relevance threshold", () => {
  const memory = (
    sequence: number,
    name: string,
    phase: ThreadExecutionRecord["phase"],
    count: string,
  ): ThreadExecutionRecord => ({
    id: `trace:${sequence}`,
    itemId: `trace:${sequence}`,
    sequence,
    kind: "status",
    phase,
    name,
    text: count,
    input: "",
    output: "",
    occurredAt: `2026-09-11T00:00:0${sequence}Z`,
  });
  const html = renderRun("completed", [
    memory(1, "memory.query", "updated", ""),
    memory(2, "memory.selection", "completed", "0"),
    memory(3, "context.formed", "completed", "0"),
    record(4, "message:answer", "message", "completed", "已写好 PDF。"),
  ]);
  expect(html).not.toContain("step.memoryFound");
  expect(html).not.toContain("step.memoryProfile");
  expect(html).not.toContain('data-tool-category="memory"');
});

it("[UI-12] shows an uploaded file once, in the owner's message, and still lists files the agent wrote", () => {
  const delivered = (name: string, source: "upload" | "write") => ({
    key: `run:cancel:${name}`,
    name,
    path: name,
    kind: "data" as const,
    runId: "run:cancel",
    turn: 1,
    source,
    command: undefined,
    versions: 1,
    registered: undefined,
    trace: undefined,
  });
  const html = renderRun("completed", [], undefined, {
    onOpenFile: () => {},
    filesByRun: {
      "run:cancel": [delivered("sales.csv", "upload"), delivered("report.csv", "write")],
    },
  });
  expect(html).toContain("report.csv");
  expect(html).not.toContain("sales.csv");
});
