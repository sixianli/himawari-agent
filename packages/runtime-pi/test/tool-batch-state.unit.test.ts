import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  capturePiToolBatch,
  type PiToolBatchContinuation,
  restorePiToolBatch,
} from "../src/pi-tool-batch-continuation.ts";

// Pure persisted-state contracts. The separate compatibility suite exercises
// these states through the pinned Pi agent loop and its real tool executor.
function state() {
  const assistant: AssistantMessage = {
    role: "assistant",
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    content: [
      { type: "text", text: "Run two reads" },
      { type: "toolCall", id: "first", name: "read", arguments: { path: "one" } },
      { type: "toolCall", id: "waiting", name: "read", arguments: { path: "two" } },
    ],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
  const messages: AgentSession["agent"]["state"]["messages"] = [
    { role: "user", content: "Read both", timestamp: 0 },
    assistant,
    {
      role: "toolResult",
      toolCallId: "first",
      toolName: "read",
      content: [{ type: "text", text: "first result" }],
      isError: false,
      timestamp: 2,
    },
  ];
  const session = {
    agent: { state: { messages, systemPrompt: "Keep authorization" } },
  } as AgentSession;
  return { session, messages, assistant };
}
describe("tool-batch persisted-state integrity", () => {
  it("freezes an independent transcript and restores the original system instruction", async () => {
    const f = state();
    const saved = capturePiToolBatch(f.session, "waiting", 3);
    f.assistant.content.splice(0);
    f.session.agent.state.systemPrompt = "changed";
    expect(saved.assistant.content).toHaveLength(3);
    const restored = restorePiToolBatch(f.session, saved);
    expect(f.session.agent.state.messages).toEqual(saved.prefix);
    expect(f.session.agent.state.systemPrompt).toBe("Keep authorization");
    expect(restored.completedStreamOrdinal).toBe(3);
    const stream = restored.takeReplay();
    if (!stream) throw new Error("Missing one-shot replay");
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["start", "done"]);
    expect(await stream.result()).toEqual(saved.assistant);
    expect(restored.takeReplay()).toBeUndefined();
    const first = restored.completedResult("first", "read");
    if (!first) throw new Error("Missing completed result");
    first.content.splice(0);
    expect(saved.completedResults[0]?.content).toHaveLength(1);
    expect(restored.completedResult("first", "read")).toBeUndefined();
    expect(restored.completedResult("waiting", "read")).toBeUndefined();
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid stream ordinal %s",
    (ordinal) => {
      const { session } = state();
      expect(() => capturePiToolBatch(session, "waiting", ordinal)).toThrow(
        "PI_CONTINUATION_BATCH_INVALID",
      );
    },
  );
  it.each(["stop", "error", "aborted", "length"] as const)(
    "refuses a %s message as a resumable batch",
    (reason) => {
      const f = state();
      f.assistant.stopReason = reason;
      expect(() => capturePiToolBatch(f.session, "waiting", 1)).toThrow(
        "PI_CONTINUATION_BATCH_INVALID",
      );
    },
  );
  it("rejects an absent assistant or a waiting call from another batch", () => {
    const f = state();
    expect(() => capturePiToolBatch(f.session, "foreign", 1)).toThrow(
      "PI_CONTINUATION_BATCH_INVALID",
    );
    f.messages.splice(1);
    expect(() => capturePiToolBatch(f.session, "waiting", 1)).toThrow(
      "PI_CONTINUATION_BATCH_INVALID",
    );
  });
  it.each(["empty", "assistant"])("rejects an invalid %s prefix", (kind) => {
    const f = state();
    if (kind === "empty") f.messages.shift();
    else f.messages[0] = structuredClone(f.assistant);
    expect(() => capturePiToolBatch(f.session, "waiting", 1)).toThrow(
      "PI_CONTINUATION_PREFIX_INVALID",
    );
  });
  it("rejects duplicate call identities even when result counts match", () => {
    const f = state();
    f.assistant.content.push({ type: "toolCall", id: "first", name: "read", arguments: {} });
    expect(() => capturePiToolBatch(f.session, "waiting", 1)).toThrow(
      "PI_CONTINUATION_RESULTS_INVALID",
    );
  });
  it("requires every preceding result to belong to the matching completed tool", () => {
    const f = state();
    f.messages[2] = { role: "user", content: "unrelated", timestamp: 2 };
    expect(() => capturePiToolBatch(f.session, "waiting", 1)).toThrow(
      "PI_CONTINUATION_RESULTS_INVALID",
    );
  });
  it("refuses obsolete persisted versions without changing the target session", () => {
    const f = state();
    const saved = capturePiToolBatch(f.session, "waiting", 1);
    const messages = structuredClone(f.messages);
    expect(() =>
      restorePiToolBatch(f.session, {
        ...saved,
        version: "pi-tool-batch.v1",
      } as unknown as PiToolBatchContinuation),
    ).toThrow("PI_CONTINUATION_VERSION_INVALID");
    expect(f.messages).toEqual(messages);
  });
  it("does not consume a result when a caller supplies a mismatched tool name", () => {
    const f = state();
    const restored = restorePiToolBatch(f.session, capturePiToolBatch(f.session, "waiting", 1));
    expect(() => restored.completedResult("first", "write")).toThrow(
      "PI_CONTINUATION_RESULT_TOOL_MISMATCH",
    );
    expect(restored.completedResult("first", "read")?.toolName).toBe("read");
  });
});
