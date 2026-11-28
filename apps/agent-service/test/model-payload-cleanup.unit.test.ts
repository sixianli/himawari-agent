// biome-ignore-all lint/complexity/useLiteralKeys: fake Pi SDK records are intentionally untrusted

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelInvocationPermit, PayloadStorePort } from "@himawari-agent/application";
import type { ConfiguredPiModelDescriptor, PiModelRuntime } from "@himawari-agent/runtime-pi";
import { createReferenceAdapterSet, testModelEgress } from "@himawari-agent/testing";
import { describe, expect, it, vi } from "vitest";
import { createProductionModelComposition } from "../src/production-model-composition.js";

const MODEL: ConfiguredPiModelDescriptor = {
  ref: "model-cleanup",
  provider: "vercel-ai-gateway",
  model: "deepseek/deepseek-v4.1-flash",
  version: "catalog-2026-10-06",
  routingClass: "primary",
  priority: 1,
  disclosure: "external_remote",
  capabilities: ["text"],
  secretRequirement: {
    secretRef: "vercel-ai-gateway-api-key",
    secretVersion: "v1",
    purpose: "model-provider-auth",
  },
  providerRouting: { order: ["runware", "deepinfra", "morph"], sort: "cost" },
  name: "DeepSeek V4.1 Flash",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.3, output: 2.4, cacheRead: 0.3, cacheWrite: 0.3 },
  contextWindow: 1_048_576,
  maxTokens: 32768,
};

class CleanupRuntime {
  readonly models = new Map<string, unknown>();
  failing = false;
  getModel(providerId: string, modelId: string): unknown {
    const value = this.models.get(`${providerId}:${modelId}`);
    return value ? { ...(value as Record<string, unknown>), provider: providerId } : undefined;
  }
  registerNativeProvider(provider: { readonly id: string; getModels(): readonly unknown[] }): void {
    for (const model of provider.getModels() as { id: string }[])
      this.models.set(`${provider.id}:${model.id}`, model);
  }
  async refresh(): Promise<void> {}
  stream(_model: unknown, _context: unknown, options: Record<string, unknown>) {
    const failing = this.failing;
    return (async function* () {
      if (failing) throw new Error("PROVIDER_DOWN");
      await (options["fetch"] as typeof fetch)("https://ai-gateway.vercel.sh/v1/chat/completions");
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "答案" }],
          api: "openai-completions",
          provider: "vercel-ai-gateway",
          model: MODEL.model,
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 30,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 40,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.000001 },
          },
        },
      };
    })();
  }
}

function countingStore(inner: PayloadStorePort) {
  const live = new Set<string>();
  const store: PayloadStorePort = {
    put: async (payload) => {
      await inner.put(payload);
      live.add(payload.ref);
    },
    get: (ref) => inner.get(ref),
    delete: async (ref) => {
      live.delete(ref);
      return inner.delete(ref);
    },
  };
  return { store, live };
}

function setup() {
  const adapters = createReferenceAdapterSet();
  const counting = countingStore(adapters.payload);
  const runtime = new CleanupRuntime();
  const composition = createProductionModelComposition({
    egress: testModelEgress(),
    ownerId: "owner-cleanup" as never,
    agentId: "agent-cleanup" as never,
    descriptors: [MODEL],
    handles: adapters.secret,
    secretSource: {
      kind: "macos-keychain" as const,
      productionSuitable: true,
      resolve: vi.fn(async () => "fixture-provider-value"),
    },
    payloads: counting.store,
    protector: adapters.payloadProtector,
    ids: adapters.ids,
    clock: adapters.clock,
    runtimeFactory: { create: async () => runtime as unknown as PiModelRuntime },
    fetch: vi.fn(
      async () =>
        new Response(
          `data: ${JSON.stringify({ id: "generation:cleanup", model: MODEL.model, usage: { cost: 0.000001 }, choices: [{ index: 0, delta: { provider_metadata: { gateway: { generationId: "generation:cleanup", routing: { finalProvider: "deepinfra" }, cost: 0.000001 } } } }] })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    ),
  });
  const permit: ModelInvocationPermit = {
    assertActive: vi.fn(async () => {}),
    markStarted: vi.fn(async () => {}),
    releaseReserved: vi.fn(async () => {}),
    settle: vi.fn(async () => {}),
    markUnknown: vi.fn(async () => {}),
  };
  const request = {
    ownerId: "owner-cleanup",
    agentId: "agent-cleanup",
    runId: "run:cleanup",
    threadId: "thread:cleanup",
    modelRef: MODEL.ref,
    dataClassification: "private",
    systemInstructionRef: "disclosure:cleanup",
    correlationId: "cleanup:test",
  };
  const gate = {
    context: { ownerId: request.ownerId, agentId: request.agentId, runId: request.runId },
    begin: vi.fn(async () => ({ disposition: "fresh", permit })),
  };
  return { composition, runtime, live: counting.live, request, gate };
}

const PURPOSES = ["thread-title", "memory-capture", "memory-consolidation"] as const;

describe("[P0-5] model prompt and answer payloads left by auxiliary text calls", () => {
  it.each(PURPOSES)("leaves no payload behind after a %s call that succeeds", async (purpose) => {
    const { composition, live, request, gate } = setup();
    try {
      const answer = await composition.generateText?.(
        request as never,
        "private prompt",
        gate as never,
        {
          purpose,
          invocationId: `${purpose}:run:cleanup`,
          maxOutputTokens: 128,
          reasoningOutputTokens: 1024,
          requestTimeoutMs: 20000,
          errorPrefix: "CLEANUP",
        },
      );
      expect(answer).toBe("答案");
      expect([...live]).toEqual([]);
    } finally {
      await composition.close();
    }
  });

  it.each(PURPOSES)("leaves no payload behind after a %s call that fails", async (purpose) => {
    const { composition, runtime, live, request, gate } = setup();
    runtime.failing = true;
    try {
      await expect(
        composition.generateText?.(request as never, "private prompt", gate as never, {
          purpose,
          invocationId: `${purpose}:run:cleanup`,
          maxOutputTokens: 128,
          reasoningOutputTokens: 1024,
          requestTimeoutMs: 20000,
          errorPrefix: "CLEANUP",
        }),
      ).rejects.toThrow();
      expect([...live]).toEqual([]);
    } finally {
      await composition.close();
    }
  });

  it("leaves no payload behind after a thread title", async () => {
    const { composition, live, request, gate } = setup();
    try {
      expect(
        await composition.generateTitle?.(request as never, "title prompt", gate as never),
      ).toBe("答案");
      expect([...live]).toEqual([]);
    } finally {
      await composition.close();
    }
  });

  it("keeps the prompt and answer of a mail judgement until the caller releases them", async () => {
    const { composition, live } = setup();
    try {
      const model = composition.proactiveModel(MODEL.ref, {
        maxOutputTokens: 128,
        requestTimeoutMs: 20000,
      });
      const authority = await model.prepare({
        invocationId: "mail-cleanup",
        prompt: "mail prompt",
        dataClassification: "private",
        deadlineAt: "2099-01-01T00:00:00.000Z",
      });
      await authority.release();
      expect([...live]).toEqual([authority.inputRef]);
      await model.release([authority.inputRef]);
      expect([...live]).toEqual([]);
    } finally {
      await composition.close();
    }
  });

  it("knows every place that calls generateText, so a new call site cannot skip cleanup", () => {
    const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src");
    const callers = readdirSync(directory)
      .filter((file) => file.endsWith(".ts") && file !== "production-model-composition.ts")
      .filter((file) => /\bgenerateText\b/u.test(readFileSync(path.join(directory, file), "utf8")))
      .sort();
    expect(callers).toEqual(["service-main.ts"]);
  });
});
