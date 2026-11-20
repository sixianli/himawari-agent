import { describe, expect, it } from "vitest";
import {
  type McpUsageCountRow,
  mcpUsageWindow,
  summarizeMcpUsage,
} from "../src/mcp-connections.js";

const kinds = {
  reads: ["start_here", "find_memories"],
  memoryPushes: ["propose_memory", "propose_memories"],
  ruleProposals: ["propose_rule"],
};
const window = mcpUsageWindow("2026-11-13");

function row(
  tool: string,
  counter: string,
  value: number,
  overrides: Partial<McpUsageCountRow> = {},
): McpUsageCountRow {
  return {
    connectionId: "conn-a",
    day: "2026-11-13",
    tool,
    auto: false,
    counter,
    value,
    ...overrides,
  };
}

describe("[P5-B] connection usage numbers", () => {
  it("covers the seven days ending today", () => {
    expect(window).toEqual({ fromDay: "2026-11-07", toDay: "2026-11-13", days: 7 });
    expect(() => mcpUsageWindow("2026-11-13", 0)).toThrow("MCP_USAGE_WINDOW_INVALID");
  });

  it("gives every connection all zeros, in the order asked, when nothing was counted", () => {
    const [a, b] = summarizeMcpUsage(["conn-b", "conn-a"], [], kinds, window);
    expect(a).toMatchObject({ connectionId: "conn-b", reads: 0, failed: 0, ruleProposals: 0 });
    expect(b?.readsByTool).toEqual([
      { tool: "start_here", calls: 0 },
      { tool: "find_memories", calls: 0 },
    ]);
  });

  it("splits reads by tool, automatic and model calls, and what came back", () => {
    const [usage] = summarizeMcpUsage(
      ["conn-a"],
      [
        row("find_memories", "calls", 5, { auto: true }),
        row("find_memories", "empty", 3, { auto: true }),
        row("find_memories", "delivered", 2, { auto: true }),
        row("find_memories", "calls", 1),
        row("find_memories", "delivered", 1),
        row("start_here", "calls", 2),
        row("start_here", "failed", 1),
        row("start_here", "delivered", 1),
      ],
      kinds,
      window,
    );
    expect(usage).toEqual({
      connectionId: "conn-a",
      reads: 8,
      readsByTool: [
        { tool: "start_here", calls: 2 },
        { tool: "find_memories", calls: 6 },
      ],
      delivered: 4,
      empty: 3,
      autoReads: 5,
      autoDelivered: 2,
      modelReads: 3,
      memoryPushes: 0,
      ruleProposals: 0,
      ruleProposalsRateLimited: 0,
      failed: 1,
      rateLimited: 0,
    });
  });

  it("keeps rule proposals and their refusals apart from other refusals and failures", () => {
    const [usage] = summarizeMcpUsage(
      ["conn-a"],
      [
        row("propose_rule", "calls", 4),
        row("propose_rule", "rate_limited", 2),
        row("propose_rule", "failed", 1),
        row("find_memories", "rate_limited", 3, { auto: true }),
        row("propose_memory", "calls", 2),
        row("propose_memories", "calls", 1),
      ],
      kinds,
      window,
    );
    expect(usage).toMatchObject({
      ruleProposals: 4,
      ruleProposalsRateLimited: 2,
      rateLimited: 3,
      failed: 1,
      memoryPushes: 3,
      reads: 0,
    });
  });

  it("REVERSE: leaves out other connections, days outside the window and unknown tools", () => {
    const [usage] = summarizeMcpUsage(
      ["conn-a"],
      [
        row("find_memories", "calls", 9, { connectionId: "conn-b" }),
        row("find_memories", "calls", 9, { day: "2026-11-06" }),
        row("find_memories", "calls", 9, { day: "2026-11-14" }),
        row("some_tool", "calls", 9),
      ],
      kinds,
      window,
    );
    expect(usage).toMatchObject({ reads: 0, memoryPushes: 0, ruleProposals: 0, failed: 0 });
  });
});
