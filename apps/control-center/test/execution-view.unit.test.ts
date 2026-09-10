import type { ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import { describe, expect, it } from "vitest";
import { executionItems, executionTime, type RunSummary } from "../src/execution-view.js";

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
  it("merges replayed out-of-order observations without erasing tool input", () => {
    const started = record(1, 10, { kind: "tool", name: "read", input: '{"path":"README.md"}' });
    const ended = record(3, 13, {
      kind: "tool",
      name: "read",
      phase: "completed",
      output: "contents",
    });
    expect(executionItems([ended, started, ended])).toEqual([
      { ...ended, input: started.input, startedAt: started.occurredAt, endedAt: ended.occurredAt },
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
