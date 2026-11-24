import { describe, expect, it } from "vitest";
import {
  clearedToolResultIds,
  clearToolResults,
  recallToolResult,
  type ToolResultClearingSettings,
} from "../src/tool-result-clearing.js";

const settings: ToolResultClearingSettings = {
  triggerTokens: 100_000,
  keepToolUses: 3,
  clearAtLeastTokens: 5_000,
  keepToolNames: new Set(["plan_update"]),
};

const page = (tokens: number) => "a".repeat(tokens * 3);

let clock = 0;
const user = (text: string) => ({ role: "user", content: text, timestamp: ++clock });
const assistant = (input: number) => ({
  role: "assistant",
  content: [],
  usage: { input, output: 10, cacheRead: 0, cacheWrite: 0 },
  timestamp: ++clock,
});
const result = (id: string, tokens: number, toolName = "web_fetch") => ({
  role: "toolResult",
  toolCallId: id,
  toolName,
  content: [{ type: "text" as const, text: page(tokens) }],
  isError: false,
  timestamp: ++clock,
});

function reading(lastUsage: number, sizes: readonly number[], names: readonly string[] = []) {
  return [
    user("读这些网页"),
    ...sizes.flatMap((size, index) => [
      assistant(index === sizes.length - 1 ? lastUsage : 1_000),
      result(`call-${index}`, size, names[index]),
    ]),
  ];
}

describe("clearing old tool results", () => {
  it("clears every older result in one batch once the measured context passes the trigger", () => {
    const cleared = clearedToolResultIds(
      reading(120_000, [4_000, 4_000, 4_000, 4_000, 4_000]),
      settings,
    );
    expect([...cleared]).toEqual(["call-0", "call-1"]);
  });

  it("stays put below the trigger", () => {
    expect(
      clearedToolResultIds(reading(90_000, [4_000, 4_000, 4_000, 4_000, 4_000]), settings).size,
    ).toBe(0);
  });

  it("REVERSE: does not clear when the older results add up to less than the minimum", () => {
    expect(
      clearedToolResultIds(reading(120_000, [2_000, 2_000, 4_000, 4_000, 4_000]), settings).size,
    ).toBe(0);
  });

  it("REVERSE: never clears a tool that asks to keep its results", () => {
    const messages = reading(120_000, [4_000, 4_000, 4_000, 4_000, 4_000], ["plan_update"]);
    expect(clearedToolResultIds(messages, settings).size).toBe(0);
  });

  it("REVERSE: never clears a result that names a password, since later copies of the value are masked only because of it", () => {
    const messages = reading(120_000, [4_000, 6_000, 4_000, 4_000, 4_000]);
    const first = messages[2] as ReturnType<typeof result>;
    messages[2] = {
      ...first,
      content: [{ type: "text", text: `${page(4_000)}\n密码：Qz7mWx42Lp` }],
    };
    expect([...clearedToolResultIds(messages, settings)]).toEqual(["call-1"]);
  });

  it("gives the same answer for an earlier request after more messages are appended", () => {
    const first = reading(120_000, [4_000, 4_000, 4_000, 4_000, 4_000]);
    const cleared = clearToolResults(first, settings);
    const later = [
      ...first,
      assistant(60_000),
      result("call-5", 4_000),
      assistant(61_000),
      user("再看看"),
    ];
    const again = clearToolResults(later, settings);
    expect(again?.slice(0, first.length)).toEqual(cleared);
  });

  it("does not trust token counts measured before a compaction", () => {
    const kept = reading(120_000, [4_000, 4_000, 4_000, 4_000, 4_000]);
    const summary = {
      role: "compactionSummary",
      summary: "s",
      tokensBefore: 1,
      timestamp: ++clock,
    };
    expect(
      clearedToolResultIds([summary, ...kept.map((m) => ({ ...m, timestamp: 0 }))], settings).size,
    ).toBe(0);
  });

  it("REVERSE: does not throw on a tool result whose content is not well formed", () => {
    const broken = [
      {
        role: "toolResult",
        toolCallId: "odd-0",
        toolName: "web_fetch",
        content: [null, { type: "text" }],
        isError: false,
        timestamp: ++clock,
      },
      {
        role: "toolResult",
        toolCallId: "odd-1",
        content: [{ type: "text", text: "x" }],
        isError: false,
        timestamp: ++clock,
      },
    ];
    const messages = [...broken, ...reading(120_000, [4_000, 4_000, 4_000, 4_000, 4_000])];
    expect(() => clearToolResults(messages, settings)).not.toThrow();
    expect([...clearedToolResultIds(messages, settings)]).toEqual(["odd-0", "call-0", "call-1"]);
  });

  it("returns nothing to change when nothing is cleared", () => {
    expect(clearToolResults(reading(10, [4_000]), settings)).toBeUndefined();
  });
});

describe("recalling a cleared result", () => {
  it("returns the original content by id", () => {
    const messages = reading(120_000, [4_000, 4_000]);
    const recalled = recallToolResult(messages, "call-0");
    expect(recalled.found).toBe(true);
    expect(recalled.content).toEqual([{ type: "text", text: page(4_000) }]);
  });

  it("returns what an earlier recall returned when that recall's own result was cleared", () => {
    const messages = [
      ...reading(120_000, [4_000, 4_000, 4_000, 4_000, 4_000]),
      assistant(1_000),
      result("recall-1", 4_000, "tool_result_recall"),
    ];
    const recalled = recallToolResult(messages, "recall-1");
    expect(recalled.found).toBe(true);
    expect(recalled.content).toEqual([{ type: "text", text: page(4_000) }]);
  });

  it("REVERSE: an earlier recall that found nothing still counts as not found", () => {
    const messages = [
      ...reading(120_000, [4_000]),
      assistant(1_000),
      { ...result("recall-1", 10, "tool_result_recall"), isError: true },
    ];
    expect(recallToolResult(messages, "recall-1").found).toBe(false);
  });

  it("REVERSE: says so when the id is unknown or empty", () => {
    const messages = reading(120_000, [4_000]);
    for (const id of ["call-9", "", 42]) {
      const recalled = recallToolResult(messages, id);
      expect(recalled.found).toBe(false);
      expect(JSON.stringify(recalled.content)).toContain("没有编号为");
    }
  });

  it("REVERSE: a missing id does not tell the model to redo an operation that has consequences", () => {
    const text = JSON.stringify(recallToolResult(reading(120_000, [4_000]), "call-9").content);
    expect(text).not.toContain("重新执行那次工具");
    expect(text).toContain("有后果的操作不要为了看结果重做");
  });
});
