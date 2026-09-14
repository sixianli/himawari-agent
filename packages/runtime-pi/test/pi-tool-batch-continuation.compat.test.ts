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
  restorePiToolBatch,
  type PiToolBatchContinuation,
} from "../src/pi-tool-batch-continuation.js";
import { createFauxModelFixture } from "./faux-model-fixture.js";

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
    async function freshSession() {
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
            saved = capturePiToolBatch(session, id, 1);
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
        sessionManager: SessionManager.inMemory(process.cwd()),
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
      const second = await freshSession();
      const snapshot = JSON.parse(JSON.stringify(saved)) as PiToolBatchContinuation;
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
      expect(second.agent.state.messages.at(-1)).toMatchObject({
        role: "assistant",
        stopReason: "stop",
      });
    } finally {
      for (const session of sessions) session.dispose();
    }
  });
});
