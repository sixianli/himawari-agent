import type { ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import { describe, expect, it } from "vitest";
import { executionTimeline, timelineDuration } from "../src/execution-timeline.js";
import type { RunSummary } from "../src/execution-view.js";

const runStart = Date.parse("2026-10-26T12:23:57.695Z");
const at = (milliseconds: number) => new Date(runStart + milliseconds).toISOString();
let sequence = 0;
const record = (
  milliseconds: number,
  overrides: Partial<ThreadExecutionRecord>,
): ThreadExecutionRecord => {
  sequence += 1;
  return {
    id: `event:${sequence}`,
    itemId: `event:${sequence}`,
    sequence,
    kind: "status",
    phase: "updated",
    name: "runtime.turn_started",
    text: "",
    input: "",
    output: "",
    occurredAt: at(milliseconds),
    ...overrides,
  };
};
const status = (milliseconds: number, name: string, phase: ThreadExecutionRecord["phase"]) =>
  record(milliseconds, { name, phase });
const message = (
  milliseconds: number,
  itemId: string,
  phase: ThreadExecutionRecord["phase"],
  text: string,
) => record(milliseconds, { kind: "message", itemId, phase, name: "deepseek-v4-flash", text });
const toolCall = (messageRecord: ThreadExecutionRecord, index: number, itemId: string) => ({
  ...messageRecord,
  id: `${messageRecord.id}:call:${index}`,
  itemId,
  kind: "tool" as const,
  phase: "updated" as const,
  name: "web_search",
  text: "",
  input: '{"query":"US news"}',
});
const tool = (milliseconds: number, itemId: string, phase: ThreadExecutionRecord["phase"]) =>
  record(milliseconds, { kind: "tool", itemId, phase, name: "web_search" });
const toolExecution = (milliseconds: number, itemId: string, edge: "started" | "ended") =>
  record(milliseconds, { itemId, name: `runtime.tool_execution.${edge}` });

function newsRun() {
  sequence = 0;
  const records: ThreadExecutionRecord[] = [
    status(647, "memory.query", "updated"),
    record(2117, { name: "memory.selection", phase: "completed", text: "2" }),
    record(2138, { name: "context.formed", phase: "completed", text: "1" }),
    status(2339, "deepseek-v4-flash", "started"),
    status(2340, "runtime.turn_started", "updated"),
    message(2341, "message:first", "updated", ""),
    message(4193, "message:first", "updated", "我来搜索"),
  ];
  const narration = message(5104, "message:first", "completed", "我来搜索最新的美国新闻。");
  records.push(
    narration,
    toolCall(narration, 0, "tool:zh"),
    toolCall(narration, 1, "tool:en"),
    tool(5108, "tool:zh", "started"),
    tool(5116, "tool:en", "started"),
    status(7529, "runtime.suspended", "waiting"),
    status(15957, "deepseek-v4-flash", "started"),
    status(15958, "runtime.turn_started", "updated"),
  );
  const resumed = message(15960, "message:resumed", "completed", "");
  records.push(
    resumed,
    toolCall(resumed, 0, "tool:zh"),
    toolCall(resumed, 1, "tool:en"),
    tool(15961, "tool:zh", "started"),
    tool(15962, "tool:en", "started"),
    toolExecution(16200, "tool:zh", "started"),
    toolExecution(16300, "tool:en", "started"),
    toolExecution(18700, "tool:zh", "ended"),
    toolExecution(18800, "tool:en", "ended"),
    tool(18813, "tool:zh", "completed"),
    tool(18890, "tool:en", "completed"),
    status(18893, "runtime.turn_started", "updated"),
    record(19600, { itemId: "thinking:last", name: "runtime.thinking.started" }),
    record(21000, { itemId: "thinking:last", name: "runtime.thinking.ended" }),
    record(21800, { itemId: "text:last", name: "runtime.text.started" }),
    message(22400, "message:last", "updated", "以下是今天的美国新闻"),
    message(25473, "message:last", "completed", "以下是今天的美国新闻……".repeat(10)),
    status(25721, "runtime.completed", "completed"),
  );
  return records;
}
const completedRun: RunSummary = {
  runId: "run:news",
  revision: 3,
  status: "completed",
  createdAt: at(0),
  updatedAt: at(27082),
};

describe("execution timeline", () => {
  it("[UI-3] gives every second of a turn to exactly one of model, tool, waiting for you and preparation", () => {
    const timeline = executionTimeline(newsRun(), completedRun, runStart + 99999);
    expect(timeline?.total).toBe(27082);
    expect(timeline?.categories).toEqual({ you: 8428, tool: 2929, model: 9346, prep: 6379 });
    const { you, tool: toolTime, model, prep } = timeline?.categories ?? {};
    expect((you ?? 0) + (toolTime ?? 0) + (model ?? 0) + (prep ?? 0)).toBe(timeline?.total);
  });

  it("[UI-3] lists the steps in order with times taken from the recorded events", () => {
    const timeline = executionTimeline(newsRun(), completedRun, runStart + 99999);
    expect(
      timeline?.steps.map(({ kind, start, end, parallel }) => [kind, start, end, parallel]),
    ).toEqual([
      ["memory", 647, 2117, false],
      ["context", 2117, 2138, false],
      ["think", 2340, 5104, false],
      ["you", 7529, 15957, false],
      ["tool", 15961, 18813, false],
      ["tool", 15962, 18890, true],
      ["think", 18893, 21800, false],
      ["write", 21800, 25473, false],
    ]);
    expect(timeline?.longest).toBe(timeline?.steps[3]?.id);
  });

  it("[UI-3] splits model and tool steps into waiting, reasoning, output, queue and run segments", () => {
    const steps = executionTimeline(newsRun(), completedRun, runStart + 99999)?.steps ?? [];
    expect(steps[2]?.segments).toEqual([
      { kind: "wait", start: 2340, end: 4193 },
      { kind: "output", start: 4193, end: 5104 },
    ]);
    expect(steps[4]?.segments).toEqual([
      { kind: "queue", start: 15961, end: 16200 },
      { kind: "run", start: 16200, end: 18700 },
    ]);
    expect(steps[6]?.segments).toEqual([
      { kind: "wait", start: 18893, end: 19600 },
      { kind: "reason", start: 19600, end: 21000 },
      { kind: "wait", start: 21000, end: 21800 },
    ]);
    expect(steps[7]).toMatchObject({ itemId: "message:last", characters: 120 });
    expect(steps[0]).toMatchObject({ count: 2 });
    expect(steps[1]).toMatchObject({ count: 1 });
    expect(steps[4]).toMatchObject({ itemId: "tool:zh" });
  });

  it("[UI-3] keeps a running step open until now and still adds up to the elapsed time", () => {
    const records = newsRun().filter((item) => item.sequence <= 11);
    const timeline = executionTimeline(
      records,
      { ...completedRun, status: "awaiting_approval", updatedAt: at(7529) },
      runStart + 10000,
    );
    expect(timeline?.total).toBe(10000);
    expect(timeline?.steps.at(-1)).toMatchObject({ kind: "you", end: 10000, running: true });
    expect(timeline?.categories).toEqual({ you: 2471, tool: 0, model: 2764, prep: 4765 });
  });

  it("[UI-3] falls back to the first text update when no output boundary was recorded", () => {
    const records = newsRun().filter((item) => item.name !== "runtime.text.started");
    const steps = executionTimeline(records, completedRun, runStart + 99999)?.steps ?? [];
    expect(steps.slice(-2).map(({ kind, start, end }) => [kind, start, end])).toEqual([
      ["think", 18893, 22400],
      ["write", 22400, 25473],
    ]);
  });

  it("[UI-3] returns nothing for a run without timing events", () => {
    expect(executionTimeline([], completedRun, runStart)).toBeNull();
  });

  it.each([
    [0, "0.0s"],
    [940, "0.9s"],
    [8428, "8.4s"],
    [59960, "1m 00s"],
    [65200, "1m 05s"],
    [3725000, "62m 05s"],
  ])("[UI-3] shows %ims as %s", (milliseconds, text) => {
    expect(timelineDuration(milliseconds)).toBe(text);
  });
});
