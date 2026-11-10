import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  capturePiToolBatch,
  inspectPiToolBatch,
  type PiToolBatchContinuation,
  piToolBatchSessionManager,
  restorePiToolBatch,
} from "../src/pi-tool-batch-continuation.ts";

const PROMPT = "Keep authorization";

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
    get sessionManager() {
      const manager = SessionManager.inMemory("/workspace");
      for (const message of messages)
        if (message.role !== "custom") manager.appendMessage(message as never);
      return manager;
    },
    messages,
    getActiveToolNames: () => ["read"],
    getToolDefinition: (name: string) =>
      name === "read" ? { name: "read", executionMode: "sequential" } : undefined,
  } as unknown as AgentSession;
  return { session, messages, assistant };
}
describe("tool-batch persisted-state integrity", () => {
  it("captures a batch after a message steered in during the run, which Pi stores with its own timestamp", () => {
    const f = state();
    const steered = {
      role: "custom",
      customType: "himawari.background.command",
      content: "The background command finished.",
      display: false,
      details: { taskRef: "task" },
      timestamp: -5,
    } as unknown as (typeof f.messages)[number];
    f.messages.splice(1, 0, steered);
    const sessionManager = SessionManager.inMemory("/workspace");
    sessionManager.appendMessage(f.messages[0] as never);
    sessionManager.appendCustomMessageEntry(
      "himawari.background.command",
      "The background command finished.",
      false,
      { taskRef: "task" },
    );
    for (const message of f.messages.slice(2)) sessionManager.appendMessage(message as never);
    const session = {
      sessionManager,
      messages: f.session.messages,
      getActiveToolNames: f.session.getActiveToolNames,
      getToolDefinition: f.session.getToolDefinition,
    } as unknown as AgentSession;
    const saved = capturePiToolBatch(session, "waiting", 3, PROMPT);
    expect(
      piToolBatchSessionManager(saved, PROMPT, "/workspace").buildSessionContext().messages,
    ).toMatchObject([
      { role: "user" },
      { role: "custom", content: "The background command finished." },
    ]);
    const unstored = SessionManager.inMemory("/workspace");
    for (const message of [f.messages[0], ...f.messages.slice(2)])
      unstored.appendMessage(message as never);
    expect(() =>
      capturePiToolBatch(
        {
          sessionManager: unstored,
          messages: f.session.messages,
          getActiveToolNames: f.session.getActiveToolNames,
          getToolDefinition: f.session.getToolDefinition,
        } as unknown as AgentSession,
        "waiting",
        3,
        PROMPT,
      ),
    ).toThrow("PI_CONTINUATION_PREFIX_INVALID");
  });

  it("treats a registered but inactive parallel tool as sequential, like the active tool list does", () => {
    const f = state();
    const parallelRead = (name: string) =>
      name === "read" ? { name: "read", executionMode: "parallel" } : undefined;
    const inactive = {
      sessionManager: f.session.sessionManager,
      messages: f.session.messages,
      getActiveToolNames: () => [],
      getToolDefinition: parallelRead,
    } as unknown as AgentSession;
    expect(capturePiToolBatch(inactive, "waiting", 3, PROMPT).parallel).toBeUndefined();
    const active = {
      sessionManager: f.session.sessionManager,
      messages: f.session.messages,
      getActiveToolNames: () => ["read"],
      getToolDefinition: parallelRead,
    } as unknown as AgentSession;
    expect(() => capturePiToolBatch(active, "waiting", 3, PROMPT)).toThrow(
      "PI_CONTINUATION_RESULTS_INVALID",
    );
  });

  it("refuses to capture when the Pi session entries do not rebuild the messages before the batch", () => {
    const f = state();
    const sessionManager = f.session.sessionManager;
    f.messages.unshift({ role: "user", content: "Only in session messages", timestamp: -1 });
    const session = {
      sessionManager,
      messages: f.session.messages,
      getActiveToolNames: f.session.getActiveToolNames,
      getToolDefinition: f.session.getToolDefinition,
    } as unknown as AgentSession;
    expect(() => capturePiToolBatch(session, "waiting", 3, PROMPT)).toThrow(
      "PI_CONTINUATION_PREFIX_INVALID",
    );
  });

  it("freezes an independent transcript and restores it through a Pi session manager", async () => {
    const f = state();
    const saved = capturePiToolBatch(f.session, "waiting", 3, PROMPT);
    f.assistant.content.splice(0);
    expect(saved.assistant.content).toHaveLength(3);
    expect(() => piToolBatchSessionManager(saved, "changed", "/workspace")).toThrow(
      "PI_CONTINUATION_SYSTEM_PROMPT_CHANGED",
    );
    const manager = piToolBatchSessionManager(saved, PROMPT, "/workspace", { id: "restored" });
    expect(manager.getSessionId()).toBe("restored");
    expect(manager.buildSessionContext().messages).toEqual([
      { role: "user", content: "Read both", timestamp: 0 },
    ]);
    const restored = restorePiToolBatch(f.session, saved);
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
      expect(() => capturePiToolBatch(session, "waiting", ordinal, PROMPT)).toThrow(
        "PI_CONTINUATION_BATCH_INVALID",
      );
    },
  );
  it.each(["stop", "error", "aborted", "length"] as const)(
    "refuses a %s message as a resumable batch",
    (reason) => {
      const f = state();
      f.assistant.stopReason = reason;
      expect(() => capturePiToolBatch(f.session, "waiting", 1, PROMPT)).toThrow(
        "PI_CONTINUATION_BATCH_INVALID",
      );
    },
  );
  it("rejects an absent assistant or a waiting call from another batch", () => {
    const f = state();
    expect(() => capturePiToolBatch(f.session, "foreign", 1, PROMPT)).toThrow(
      "PI_CONTINUATION_BATCH_INVALID",
    );
    f.messages.splice(1);
    expect(() => capturePiToolBatch(f.session, "waiting", 1, PROMPT)).toThrow(
      "PI_CONTINUATION_BATCH_INVALID",
    );
  });
  it.each(["empty", "assistant"])("rejects an invalid %s prefix", (kind) => {
    const f = state();
    if (kind === "empty") f.messages.shift();
    else f.messages[0] = structuredClone(f.assistant);
    expect(() => capturePiToolBatch(f.session, "waiting", 1, PROMPT)).toThrow(
      "PI_CONTINUATION_PREFIX_INVALID",
    );
  });
  it("rejects duplicate call identities even when result counts match", () => {
    const f = state();
    f.assistant.content.push({ type: "toolCall", id: "first", name: "read", arguments: {} });
    expect(() => capturePiToolBatch(f.session, "waiting", 1, PROMPT)).toThrow(
      "PI_CONTINUATION_RESULTS_INVALID",
    );
  });
  it("requires every preceding result to belong to the matching completed tool", () => {
    const f = state();
    f.messages[2] = { role: "user", content: "unrelated", timestamp: 2 };
    expect(() => capturePiToolBatch(f.session, "waiting", 1, PROMPT)).toThrow(
      "PI_CONTINUATION_RESULTS_INVALID",
    );
  });
  it.each(["pi-tool-batch.v1", "pi-tool-batch.v2"])(
    "refuses the obsolete %s snapshot on restore and skips it on inspection",
    (version) => {
      const f = state();
      const saved = capturePiToolBatch(f.session, "waiting", 1, PROMPT);
      const obsolete = { ...saved, version } as unknown as PiToolBatchContinuation;
      expect(() => restorePiToolBatch(f.session, obsolete)).toThrow(
        "PI_CONTINUATION_VERSION_INVALID",
      );
      expect(() => piToolBatchSessionManager(obsolete, PROMPT, "/workspace")).toThrow(
        "PI_CONTINUATION_VERSION_INVALID",
      );
      expect(inspectPiToolBatch(obsolete)).toBeUndefined();
      expect(inspectPiToolBatch(saved)?.waitingToolCallId).toBe("waiting");
    },
  );
  it("does not consume a result when a caller supplies a mismatched tool name", () => {
    const f = state();
    const restored = restorePiToolBatch(
      f.session,
      capturePiToolBatch(f.session, "waiting", 1, PROMPT),
    );
    expect(() => restored.completedResult("first", "write")).toThrow(
      "PI_CONTINUATION_RESULT_TOOL_MISMATCH",
    );
    expect(restored.completedResult("first", "read")?.toolName).toBe("read");
  });
});
