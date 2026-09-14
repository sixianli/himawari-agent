import { describe, expect, it } from "vitest";
import type { LegacyPiRunHistory } from "../src/legacy-pi-history.js";
import { qualifyLegacyPiHistory } from "../src/legacy-pi-history.js";

const user = { role: "user", content: "写入验收文件", timestamp: 1 };
const assistant = {
  role: "assistant",
  provider: "openrouter",
  api: "openai-completions",
  model: "original-model",
  timestamp: 2,
  stopReason: "toolUse",
  usage: {
    input: 10,
    output: 3,
    cacheRead: 2,
    cacheWrite: 0,
    totalTokens: "[REDACTED]",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  content: [{ type: "toolCall", id: "call", name: "write", arguments: { path: "test.txt" } }],
};
const result = {
  role: "toolResult",
  toolCallId: "call",
  toolName: "write",
  isError: true,
  content: [{ type: "text", text: "approval_denied" }],
  timestamp: 3,
};
function run(
  messages: readonly unknown[],
  status: LegacyPiRunHistory["status"] = "completed",
): LegacyPiRunHistory {
  return {
    runId: "legacy-run" as LegacyPiRunHistory["runId"],
    status,
    finalizedMessages: messages,
  };
}
describe("qualified legacy Pi history", () => {
  it("deduplicates identical finalized observations and repairs only the known redacted token total", () => {
    const candidate = qualifyLegacyPiHistory([run([user, assistant, assistant, result])]);
    expect(candidate.duplicateMessages).toBe(1);
    expect(candidate.repairedUsageTotals).toBe(1);
    expect(candidate.messages).toHaveLength(3);
    expect(candidate.messages[1]).toMatchObject({
      usage: { totalTokens: 15 },
      model: "original-model",
    });
    expect(assistant.usage.totalTokens).toBe("[REDACTED]");
  });
  it("records missing cancelled output without inventing an assistant reply or tool result", () => {
    const candidate = qualifyLegacyPiHistory([run([user], "cancelled")]);
    expect(candidate.incompleteCancelledRuns).toEqual(["legacy-run"]);
    expect(candidate.messages).toHaveLength(2);
    expect(candidate.messages[1]).toMatchObject({
      role: "custom",
      customType: "himawari.turn_aborted",
    });
  });
  it.each(
    [
      [user, assistant],
      [user, result],
      [user, { ...assistant, content: [{ type: "text", text: "[REDACTED]" }] }],
      [user, { ...assistant, usage: { ...assistant.usage, input: "[REDACTED]" } }],
      [user, { ...assistant, content: [{ type: "text", text: "RUNTIME_TOOL_SUSPENDED" }] }],
      [user, assistant, result, { ...assistant, timestamp: 4 }],
    ].map((messages) => ({ messages })),
  )("rejects incomplete, repeated, or redacted tool history", ({ messages }) => {
    expect(() => qualifyLegacyPiHistory([run(messages)])).toThrow();
  });
});
