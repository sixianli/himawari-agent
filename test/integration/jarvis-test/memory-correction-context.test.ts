import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunExecutionSource } from "@himawari-agent/application";
import { createRunId, createSessionId } from "@himawari-agent/domain";
import { createReferenceAdapterSet, ManualClock } from "@himawari-agent/testing";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createProductionRunPolicy } from "../../../apps/agent-service/src/production-run-policy.js";
import { createAiGatewayLiveConfiguration } from "../fixtures/openrouter-live-configuration.ts";
import { useSqliteContractExecution } from "../sqlite-contract-execution.fixture.ts";
import { loadDataset } from "./cases.ts";
import { assembleContext, MAX_SELECTED_MEMORIES, MEMORY_LIMIT } from "./context.ts";

const dataset = loadDataset();
const memoryCases = dataset.cases.filter(({ scenario }) => scenario === "memory_correction");

describe("Jarvis Test #1 memory correction: the material given to the model", () => {
  useSqliteContractExecution("worker");
  const roots: string[] = [];
  afterAll(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it.each(memoryCases.map((item) => [item.id, item.title, item] as const))(
    "%s %s: carries the correction and leaves out what it replaced",
    async (_id, _title, item) => {
      const root = await mkdtemp(path.join(tmpdir(), `himawari-jarvis-${item.id}-`));
      roots.push(root);
      const { formed, material, profileNow, providerNow } = await assembleContext(
        dataset,
        item,
        root,
      );
      const memories = item.memories ?? [];
      const text = (id: string) => memories.find((memory) => memory.id === id)?.text ?? id;
      for (const id of item.context?.present ?? []) expect(material, id).toContain(text(id));
      for (const id of item.context?.absent ?? []) expect(material, id).not.toContain(text(id));
      const selected = formed.selected.map(({ id }) => id);
      for (const id of item.context?.absent ?? []) expect(selected).not.toContain(id);
      expect(profileNow).toEqual([dataset.today]);
      for (const call of providerNow.mock.results) expect(call.value).toBe(dataset.today);
    },
  );
});

describe("Jarvis Test fixed today", () => {
  it("writes the case date, and no other date, into the production system instruction", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-jarvis-date-"));
    try {
      const adapters = createReferenceAdapterSet({ clock: new ManualClock(dataset.today) });
      const configuration = {
        ...createAiGatewayLiveConfiguration(root),
        runPolicy: {
          version: "jarvis-test-policy-v1",
          timeZone: dataset.timeZone,
          systemInstruction: "可信系统指令",
          memoryLimit: MEMORY_LIMIT,
          maxSelectedMemories: MAX_SELECTED_MEMORIES,
          maxMemoryClassification: "private" as const,
        },
      };
      const protect = vi.spyOn(adapters.payloadProtector, "protect");
      const source: RunExecutionSource = {
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        runId: createRunId("run-jarvis-date"),
        sessionId: createSessionId("session-jarvis-date"),
        threadId: null,
        triggerId: "trigger-jarvis-date" as RunExecutionSource["triggerId"],
        sourceType: "user_message",
        sourceId: "owner-message",
        payloadRef: "owner-content",
        dataClassification: "private",
        occurredAt: dataset.today,
      };
      await createProductionRunPolicy({
        configuration,
        artifacts: adapters.runPayloadArtifacts,
        protector: adapters.payloadProtector,
        handles: { listRunExecutionHandles: async () => [] },
        clock: adapters.clock,
        ids: adapters.ids,
      })(source);
      const instruction = new TextDecoder().decode(protect.mock.calls[0]?.[0].plaintext);
      expect(instruction).toContain(`本轮请求时间（UTC）：${dataset.today}`);
      expect(instruction).toContain("2026-11-02 09:30:00 GMT+09:00");
      const dates = new Set(instruction.match(/\d{4}-\d{2}-\d{2}/gu) ?? []);
      expect([...dates]).toEqual(["2026-11-02"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
