import { createRunId } from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import {
  type LegacyPiRunHistory,
  qualifyLegacyPiHistory,
} from "../../packages/runtime-pi/src/legacy-pi-history.ts";

const user = { role: "user", content: "continue", timestamp: 1 };
const assistant = {
  role: "assistant",
  api: "openai-completions",
  provider: "fixture",
  model: "original",
  stopReason: "stop",
  timestamp: 2,
  content: [{ type: "text", text: "completed" }],
  usage: {
    input: 2,
    output: 3,
    cacheRead: 4,
    cacheWrite: 0,
    totalTokens: 9,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};
const call = {
  ...assistant,
  stopReason: "toolUse",
  content: [{ type: "toolCall", id: "call-one", name: "read", arguments: { path: "fixture" } }],
};
const result = {
  role: "toolResult",
  toolCallId: "call-one",
  toolName: "read",
  isError: false,
  timestamp: 3,
  content: [{ type: "text", text: "fixture value" }],
};
const run = (
  finalizedMessages: readonly unknown[],
  status: LegacyPiRunHistory["status"] = "completed",
  id = "legacy-one",
): LegacyPiRunHistory => ({ runId: createRunId(id), status, finalizedMessages });
describe("legacy history causal validation", () => {
  it("preserves source identity and causal order across completed, failed and cancelled runs", () => {
    const runs = [
      run([user, call, result, { ...assistant, timestamp: 4 }]),
      run([user, assistant], "failed", "legacy-two"),
      run([user], "cancelled", "legacy-three"),
    ];
    const before = structuredClone(runs);
    const history = qualifyLegacyPiHistory(runs);
    expect(runs).toEqual(before);
    expect(history.coveredRunIds).toEqual(["legacy-one", "legacy-two", "legacy-three"]);
    expect(history.messages).toHaveLength(8);
    expect(history.incompleteCancelledRuns).toEqual(["legacy-three"]);
    expect(history.messages.at(-1)).toMatchObject({
      role: "custom",
      customType: "himawari.turn_aborted",
      display: false,
      timestamp: 1,
    });
    expect(history.messages[1]).toEqual(call);
    expect(history.messages[2]).toEqual(result);
  });
  it("deduplicates identical observations and repairs only the documented usage total", () => {
    const original = { ...assistant, usage: { ...assistant.usage, totalTokens: "[REDACTED]" } };
    const value = qualifyLegacyPiHistory([run([user, original, original])]);
    expect(value.duplicateMessages).toBe(1);
    expect(value.repairedUsageTotals).toBe(1);
    expect(value.messages[1]).toMatchObject({ usage: { totalTokens: 9 } });
    expect(original.usage.totalTokens).toBe("[REDACTED]");
  });
  it.each([
    ["empty", [], "LEGACY_HISTORY_INCOMPLETE"],
    ["missing answer", [user], "LEGACY_HISTORY_INCOMPLETE"],
    ["missing user", [assistant], "LEGACY_HISTORY_USER_MISSING"],
    ["second user", [user, { ...user, timestamp: 4 }], "LEGACY_HISTORY_USER_BOUNDARY_INVALID"],
    ["missing tool result", [user, call, assistant], "LEGACY_HISTORY_TOOL_RESULT_MISSING"],
    ["dangling call", [user, call], "LEGACY_HISTORY_INCOMPLETE"],
    ["orphan result", [user, result], "LEGACY_HISTORY_ORPHAN_RESULT"],
    ["wrong tool", [user, call, { ...result, toolName: "write" }], "LEGACY_HISTORY_ORPHAN_RESULT"],
    [
      "duplicate call",
      [user, call, result, { ...call, timestamp: 4 }],
      "LEGACY_HISTORY_DUPLICATE_CALL",
    ],
    [
      "custom role",
      [user, { role: "custom", content: "internal", timestamp: 2 }],
      "LEGACY_HISTORY_MESSAGE_INVALID",
    ],
    ["null", [user, null], "LEGACY_HISTORY_MESSAGE_INVALID"],
    ["array", [user, []], "LEGACY_HISTORY_MESSAGE_INVALID"],
    [
      "redacted body",
      [user, { ...assistant, content: [{ type: "text", text: "[REDACTED]" }] }],
      "LEGACY_HISTORY_CONTENT_UNAVAILABLE",
    ],
    [
      "suspended result",
      [user, call, { ...result, content: [{ type: "text", text: "RUNTIME_TOOL_SUSPENDED" }] }],
      "LEGACY_HISTORY_CONTENT_UNAVAILABLE",
    ],
    [
      "invalid native shape",
      [user, { ...assistant, content: [{ type: "image" }] }],
      "PI_HISTORY_MESSAGE_INVALID",
    ],
  ] as const)("rejects %s without returning partial history", (_name, messages, code) => {
    expect(() => qualifyLegacyPiHistory([run(messages)])).toThrow(code);
  });
  it.each(["bad", -1, Infinity, Number.NaN])(
    "does not infer redacted totals from invalid count %s",
    (input) => {
      expect(() =>
        qualifyLegacyPiHistory([
          run([
            user,
            { ...assistant, usage: { ...assistant.usage, input, totalTokens: "[REDACTED]" } },
          ]),
        ]),
      ).toThrow("LEGACY_HISTORY_CONTENT_UNAVAILABLE");
    },
  );
  it("rejects a repeated run even when its messages are identical", () => {
    expect(() => qualifyLegacyPiHistory([run([user, assistant]), run([user, assistant])])).toThrow(
      "LEGACY_HISTORY_DUPLICATE_RUN",
    );
  });
  it("records cancellation after a final answer without marking it missing", () => {
    const value = qualifyLegacyPiHistory([run([user, assistant], "cancelled")]);
    expect(value.incompleteCancelledRuns).toEqual([]);
    expect(value.messages).toHaveLength(3);
  });
});
