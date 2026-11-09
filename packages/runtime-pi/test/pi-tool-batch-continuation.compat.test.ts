import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  capturePiToolBatch,
  type PiToolBatchContinuation,
  piToolBatchSessionManager,
  restorePiToolBatch,
} from "../src/pi-tool-batch-continuation.js";
import { createFauxModelFixture } from "./faux-model-fixture.js";

const FROZEN_PROMPT = "Himawari frozen prompt";

describe("pinned Pi tool-batch continuation", () => {
  it("restores a multi-tool batch in a new session without another first model request", async () => {
    const model = await createFauxModelFixture("完成", [
      { name: "controlled_action", id: "confirmed", arguments: { value: "first" } },
      { name: "controlled_action", id: "waiting", arguments: { value: "second" } },
    ]);
    const binding = await model.models.resolve(model.descriptor.ref);
    const completed = new Map<string, string>();
    const effects: string[] = [];
    let approved = false;
    let saved: PiToolBatchContinuation | undefined;
    const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
    async function freshSession(sessionManager = SessionManager.inMemory(process.cwd())) {
      const settingsManager = SettingsManager.inMemory(
        {
          compaction: { enabled: false },
          retry: { enabled: false },
          defaultTools: [],
        },
        { projectTrusted: false },
      );
      const resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: process.cwd(),
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "Use controlled_action.",
      });
      await resourceLoader.reload();
      const tool: ToolDefinition = {
        name: "controlled_action",
        label: "controlled action",
        description: "Controlled test action",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        } as ToolDefinition["parameters"],
        executionMode: "sequential",
        execute: async (id, parameters) => {
          const session = sessions.at(-1);
          if (!session) throw new Error("Missing test session");
          if (!approved && id === "waiting") {
            saved = capturePiToolBatch(session, id, 1, FROZEN_PROMPT);
            session.agent.abort();
            throw new Error("PRODUCT_SUSPENDED");
          }
          const previous = completed.get(id);
          if (previous) return { content: [{ type: "text", text: previous }], details: {} };
          const value = (parameters as { value: string }).value;
          effects.push(value);
          completed.set(id, value);
          return { content: [{ type: "text", text: value }], details: {} };
        },
      };
      const { session } = await createAgentSession({
        cwd: process.cwd(),
        model: binding.model,
        modelRuntime: binding.modelRuntime,
        noTools: "all",
        tools: [tool.name],
        customTools: [tool],
        settingsManager,
        resourceLoader,
        sessionManager,
      });
      sessions.push(session);
      return session;
    }
    try {
      const first = await freshSession();
      await first.prompt("Execute both controlled actions.");
      expect(saved).toBeDefined();
      expect(effects).toEqual(["first"]);
      expect(model.observed).toHaveLength(1);
      first.dispose();
      approved = true;
      const snapshot = JSON.parse(JSON.stringify(saved)) as PiToolBatchContinuation;
      expect(() =>
        piToolBatchSessionManager(structuredClone(snapshot), "another prompt", process.cwd()),
      ).toThrow("PI_CONTINUATION_SYSTEM_PROMPT_CHANGED");
      const second = await freshSession(
        piToolBatchSessionManager(snapshot, FROZEN_PROMPT, process.cwd()),
      );
      expect(second.agent.state.messages.filter((m) => m.role === "user")).toHaveLength(1);
      const completed = (value: PiToolBatchContinuation) => {
        const result = value.completedResults[0];
        if (!result) throw new Error("TEST_COMPLETED_RESULT_MISSING");
        return result;
      };
      for (const mutate of [
        (value: PiToolBatchContinuation) => {
          value.completedResults.splice(0);
        },
        (value: PiToolBatchContinuation) => {
          value.completedResults.push(structuredClone(completed(value)));
        },
        (value: PiToolBatchContinuation) => {
          completed(value).toolCallId = "another-call";
        },
        (value: PiToolBatchContinuation) => {
          completed(value).toolName = "another-tool";
        },
        (value: PiToolBatchContinuation) => {
          completed(value).details = { productOutcome: "result_unknown" };
        },
      ]) {
        const invalid = structuredClone(snapshot);
        mutate(invalid);
        expect(() => restorePiToolBatch(second, invalid)).toThrow(
          "PI_CONTINUATION_RESULTS_INVALID",
        );
      }
      const probe = restorePiToolBatch(second, snapshot);
      expect(() => probe.completedResult("confirmed", "wrong-name")).toThrow(
        "PI_CONTINUATION_RESULT_TOOL_MISMATCH",
      );
      expect(probe.completedResult("confirmed", "controlled_action")?.content).toEqual([
        { type: "text", text: "first" },
      ]);
      expect(probe.completedResult("confirmed", "controlled_action")).toBeUndefined();
      expect(probe.completedResult("waiting", "controlled_action")).toBeUndefined();
      const restored = restorePiToolBatch(second, snapshot);
      const providerStream = second.agent.streamFunction;
      let ordinal = restored.completedStreamOrdinal;
      const actualOrdinals: number[] = [];
      second.agent.streamFunction = (model, context, options) => {
        const replay = restored.takeReplay();
        if (replay) return replay;
        actualOrdinals.push(++ordinal);
        if (!providerStream) throw new Error("Missing Pi provider");
        return providerStream(model, context, options);
      };
      await second.agent.continue();
      await second.waitForIdle();
      expect(effects).toEqual(["first", "second"]);
      expect(actualOrdinals).toEqual([2]);
      expect(model.observed).toHaveLength(2);
      const followup = model.observed[1] as {
        messages: { role: string; toolCallId?: string; content: unknown }[];
      };
      expect(
        followup.messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId),
      ).toEqual(["confirmed", "waiting"]);
      expect(JSON.stringify(followup)).not.toContain("PRODUCT_SUSPENDED");
      const before = (model.observed[0] as { transcript: unknown[] }).transcript;
      const after = (model.observed[1] as { transcript: unknown[] }).transcript;
      expect(before.length).toBeGreaterThan(1);
      expect(JSON.stringify(after.slice(0, before.length))).toBe(JSON.stringify(before));
      expect(second.agent.state.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
      });
    } finally {
      for (const session of sessions) session.dispose();
    }
  });

  it("[NL-1] runs a read-only batch concurrently and restores it without frozen results", async () => {
    const model = await createFauxModelFixture("完成", [
      { name: "lookup", id: "confirmed", arguments: { value: "first" } },
      { name: "lookup", id: "waiting", arguments: { value: "second" } },
    ]);
    const binding = await model.models.resolve(model.descriptor.ref);
    const completed = new Map<string, string>();
    const effects: string[] = [];
    let approved = false;
    let saved: PiToolBatchContinuation | undefined;
    let releaseFirst: () => void = () => {};
    const waitingStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] = [];
    async function freshSession(
      executionMode: "parallel" | "sequential",
      sessionManager = SessionManager.inMemory(process.cwd()),
    ) {
      const settingsManager = SettingsManager.inMemory(
        { compaction: { enabled: false }, retry: { enabled: false }, defaultTools: [] },
        { projectTrusted: false },
      );
      const resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: process.cwd(),
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "Use lookup.",
      });
      await resourceLoader.reload();
      const tool: ToolDefinition = {
        name: "lookup",
        label: "lookup",
        description: "Read-only test lookup",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        } as ToolDefinition["parameters"],
        executionMode,
        execute: async (id, parameters) => {
          const session = sessions.at(-1);
          if (!session) throw new Error("Missing test session");
          if (!approved && id === "confirmed")
            await Promise.race([
              waitingStarted,
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error("TEST_BATCH_NOT_CONCURRENT")), 2000),
              ),
            ]);
          if (!approved && id === "waiting") {
            releaseFirst();
            saved = capturePiToolBatch(session, id, 1, FROZEN_PROMPT);
            session.agent.abort();
            throw new Error("PRODUCT_SUSPENDED");
          }
          const previous = completed.get(id);
          if (previous) return { content: [{ type: "text", text: previous }], details: {} };
          const value = (parameters as { value: string }).value;
          effects.push(value);
          completed.set(id, value);
          return { content: [{ type: "text", text: value }], details: {} };
        },
      };
      const { session } = await createAgentSession({
        cwd: process.cwd(),
        model: binding.model,
        modelRuntime: binding.modelRuntime,
        noTools: "all",
        tools: [tool.name],
        customTools: [tool],
        settingsManager,
        resourceLoader,
        sessionManager,
      });
      sessions.push(session);
      return session;
    }
    try {
      const first = await freshSession("parallel");
      await first.prompt("Look up both values.");
      expect(effects).toEqual(["first"]);
      expect(saved).toMatchObject({
        waitingToolCallId: "waiting",
        completedResults: [],
        parallel: true,
      });
      first.dispose();
      approved = true;
      const snapshot = JSON.parse(JSON.stringify(saved)) as PiToolBatchContinuation;
      const sequential = await freshSession("sequential");
      expect(() => restorePiToolBatch(sequential, structuredClone(snapshot))).toThrow(
        "PI_CONTINUATION_PARALLEL_BATCH_INVALID",
      );
      const { parallel: _flag, ...unflagged } = structuredClone(snapshot);
      expect(() => restorePiToolBatch(sequential, unflagged)).toThrow(
        "PI_CONTINUATION_RESULTS_INVALID",
      );
      const second = await freshSession(
        "parallel",
        piToolBatchSessionManager(snapshot, FROZEN_PROMPT, process.cwd()),
      );
      const restored = restorePiToolBatch(second, snapshot);
      const providerStream = second.agent.streamFunction;
      second.agent.streamFunction = (model, context, options) => {
        const replay = restored.takeReplay();
        if (replay) return replay;
        if (!providerStream) throw new Error("Missing Pi provider");
        return providerStream(model, context, options);
      };
      await second.agent.continue();
      await second.waitForIdle();
      expect(effects).toEqual(["first", "second"]);
      expect(model.observed).toHaveLength(2);
      const followup = model.observed[1] as {
        messages: { role: string; toolCallId?: string; content: unknown }[];
      };
      expect(
        followup.messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId),
      ).toEqual(["confirmed", "waiting"]);
      expect(JSON.stringify(followup)).not.toContain("PRODUCT_SUSPENDED");
    } finally {
      for (const session of sessions) session.dispose();
    }
  });
});
