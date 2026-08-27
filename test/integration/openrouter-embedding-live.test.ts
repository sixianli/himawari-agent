import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentId,
  createMemoryId,
  createOwnerId,
  createThreadId,
} from "@himawari-agent/domain";
import { createProductionMemoryCompositionFromConfiguration } from "../../apps/agent-service/src/production-memory-composition.js";
import {
  MEM0_OPENROUTER_BASE_URL,
  QWEN3_EMBEDDING_8B_COST,
  QWEN3_EMBEDDING_8B_DIMENSIONS,
  QWEN3_EMBEDDING_8B_MODEL,
  QWEN3_EMBEDDING_8B_VERSION,
} from "@himawari-agent/memory-mem0";
import {
  parseProductConfiguration,
  MacOsKeychainProviderSecretSource,
} from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";

interface LiveEnvironment {
  readonly HIMAWARI_LIVE_EMBEDDING_PRINT_EVIDENCE?: string;
  readonly HIMAWARI_LIVE_EMBEDDING_SMOKE?: string;
}

interface EmbeddingRequestBody {
  readonly model?: unknown;
  readonly dimensions?: unknown;
}

interface EmbeddingResponseBody {
  readonly data?: unknown;
  readonly model?: unknown;
  readonly usage?: unknown;
}

interface EmbeddingItem {
  readonly embedding?: unknown;
}

interface EmbeddingUsage {
  readonly prompt_tokens?: unknown;
  readonly total_tokens?: unknown;
}

const environment = process.env as unknown as LiveEnvironment;
const LIVE_ENABLED = environment.HIMAWARI_LIVE_EMBEDDING_SMOKE === "1";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function configuration(stateRoot: string) {
  return parseProductConfiguration(
    {
      schemaVersion: "himawari.configuration.v1",
      deploymentId: "deployment-live-embedding",
      ownerId: "owner-live-embedding",
      agentId: "agent-live-embedding",
      stateRoot,
      runtimeDirectory: path.join(stateRoot, "runtime"),
      cacheDirectory: path.join(stateRoot, "cache"),
      publicOrigin: "http://127.0.0.1",
      publicMode: false,
      modelDescriptors: [
        {
          ref: "model-primary",
          role: "primary",
          provider: "openrouter",
          model: "deepseek/deepseek-v4-flash-0731",
          version: "catalog-2026-08-28",
          priority: 1,
          name: "DeepSeek V4 Flash 0731",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          capabilities: ["text", "tool_calling", "structured_outputs"],
          cost: { input: 0.03, output: 0.1, cacheRead: 0.007, cacheWrite: 0 },
          contextWindow: 1_310_720,
          maxTokens: 131_072,
          allowedDataClassifications: ["public", "private"],
          disclosure: "external_remote",
          secretRef: "openrouter-api-key",
        },
        {
          ref: "model-fallback",
          role: "fallback",
          provider: "openrouter",
          model: "z-ai/glm-5.3-flash",
          version: "catalog-2026-08-28",
          priority: 2,
          name: "GLM 5.3 Flash",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          capabilities: ["text", "tool_calling", "structured_outputs"],
          cost: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 },
          contextWindow: 1_310_720,
          maxTokens: 48_000,
          allowedDataClassifications: ["private"],
          disclosure: "external_remote",
          secretRef: "openrouter-api-key",
          providerRouting: {
            order: ["z-ai"],
            allow_fallbacks: false,
            require_parameters: true,
            data_collection: "deny",
          },
        },
        {
          ref: "model-embedding",
          role: "embedding",
          provider: "openrouter",
          model: QWEN3_EMBEDDING_8B_MODEL,
          version: QWEN3_EMBEDDING_8B_VERSION,
          capabilities: ["embedding"],
          cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 },
          dimensions: QWEN3_EMBEDDING_8B_DIMENSIONS,
          allowedDataClassifications: ["public", "private"],
          disclosure: "external_remote",
          secretRef: "openrouter-api-key",
        },
      ],
      memory: {
        adapter: "mem0-oss",
        version: "3.1.7",
        storagePath: path.join(stateRoot, "data", "memory"),
        dimensions: QWEN3_EMBEDDING_8B_DIMENSIONS,
      },
      repositoryAllowlistRefs: [],
      secretReferences: [
        {
          ref: "openrouter-api-key",
          version: "v1",
          purpose: "model-provider-auth",
          scope: "model",
        },
      ],
      budgets: {
        globalCostMicros: 1_000_000,
        perRunCostMicros: 1_000_000,
        perClassificationCostMicros: {
          public: 1_000_000,
          private: 1_000_000,
          sensitive: 0,
          restricted: 0,
        },
      },
      concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
      deadlines: { runMs: 300_000, workerRequestMs: 30_000, providerRequestMs: 60_000 },
    },
    "2026-08-28T00:00:00.000Z",
  );
}

describe.skipIf(!LIVE_ENABLED)("OpenRouter Qwen3 Embedding 8B live smoke", () => {
  it("uses Mem0's OpenAI-compatible embedder with 4096 dimensions", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-live-embedding-"));
    roots.push(stateRoot);
    const calls: Array<{
      readonly requestModel: unknown;
      readonly requestedDimensions: unknown;
      readonly responseModel: unknown;
      readonly returnedDimensions: number | null;
      readonly promptTokens: number | null;
      readonly totalTokens: number | null;
      readonly ok: boolean;
    }> = [];
    const openAiShims = await import("openai/_shims/registry");
    const openAiNodeRuntime = await import("openai/_shims/node-runtime");
    if (openAiShims.kind !== undefined) {
      throw new Error(`OPENAI_SHIMS_ALREADY_INITIALIZED:${openAiShims.kind}`);
    }
    const runtime = openAiNodeRuntime.getRuntime();
    const originalFetch = runtime.fetch as typeof globalThis.fetch;
    let observe = true;
    const observedFetch: typeof globalThis.fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const requestBody =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as EmbeddingRequestBody)
          : undefined;
      const response = await originalFetch(input, init);
      if (observe && url.endsWith("/embeddings")) {
        const body = (await response
          .clone()
          .json()
          .catch(() => undefined)) as EmbeddingResponseBody | undefined;
        const data = Array.isArray(body?.data) ? body.data : [];
        const first = data[0];
        const embedding =
          first && typeof first === "object" && !Array.isArray(first)
            ? (first as EmbeddingItem).embedding
            : undefined;
        const usage =
          body?.usage && typeof body.usage === "object" && !Array.isArray(body.usage)
            ? (body.usage as EmbeddingUsage)
            : undefined;
        calls.push({
          requestModel: requestBody?.model,
          requestedDimensions: requestBody?.dimensions,
          responseModel: body?.model,
          returnedDimensions: Array.isArray(embedding) ? embedding.length : null,
          promptTokens: typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : null,
          totalTokens: typeof usage?.total_tokens === "number" ? usage.total_tokens : null,
          ok: response.ok,
        });
      }
      return response;
    };
    openAiShims.setShims({ ...runtime, fetch: observedFetch }, { auto: false });

    let composition:
      | Awaited<ReturnType<typeof createProductionMemoryCompositionFromConfiguration>>
      | undefined;
    try {
      composition = await createProductionMemoryCompositionFromConfiguration({
        configuration: configuration(stateRoot),
        secretSource: new MacOsKeychainProviderSecretSource({
          servicePrefix: "himawari-provider",
          account: "himawari-agent",
        }),
      });
      const memory = {
        id: createMemoryId("memory-live-embedding"),
        ownerId: createOwnerId("owner-live-embedding"),
        agentId: createAgentId("agent-live-embedding"),
        revision: 1,
        status: "active" as const,
        contentRef: "payload-live-embedding",
        dataClassification: "public" as const,
        sourceThreadId: createThreadId("thread-live-embedding"),
        sourceRefs: ["live-smoke"],
        inference: false,
        confidencePermille: 1000,
        policyVersion: "live-smoke-v1",
        providerRecordId: null,
        lastUsedAt: null,
        updatedAt: "2026-08-28T00:00:00.000Z",
      };
      const providerRecordId = await composition.projection.upsert({
        memory,
        content: "Himawari live embedding smoke — public fixture text.",
      });
      const hits = await composition.projection.search({
        ownerId: memory.ownerId,
        agentId: memory.agentId,
        query: "live embedding smoke",
        limit: 5,
      });
      expect(hits.some((hit) => hit.providerRecordId === providerRecordId)).toBe(true);
      await composition.projection.delete(providerRecordId);
    } finally {
      await composition?.close();
      observe = false;
    }

    // Mem0 OSS 3.1.7 embeds once for the upsert and twice for the search
    // (query plus its entity-boost path).
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.ok)).toBe(true);
    expect(calls.every((call) => call.requestModel === QWEN3_EMBEDDING_8B_MODEL)).toBe(true);
    expect(calls.every((call) => call.requestedDimensions === QWEN3_EMBEDDING_8B_DIMENSIONS)).toBe(
      true,
    );
    expect(calls.every((call) => call.returnedDimensions === QWEN3_EMBEDDING_8B_DIMENSIONS)).toBe(
      true,
    );
    expect(
      calls.every(
        (call) =>
          typeof call.responseModel === "string" &&
          call.responseModel.toLowerCase() === QWEN3_EMBEDDING_8B_MODEL,
      ),
    ).toBe(true);
    expect(calls.every((call) => call.promptTokens !== null)).toBe(true);
    expect(calls.every((call) => call.totalTokens !== null)).toBe(true);
    const totalTokens = calls.reduce((sum, call) => sum + (call.totalTokens ?? 0), 0);
    const estimatedCostUsd = (totalTokens * QWEN3_EMBEDDING_8B_COST.input) / 1_000_000;
    expect(estimatedCostUsd).toBeLessThanOrEqual(1);
    if (environment.HIMAWARI_LIVE_EMBEDDING_PRINT_EVIDENCE === "1") {
      process.stdout.write(
        `${JSON.stringify({
          endpoint: `${MEM0_OPENROUTER_BASE_URL}/embeddings`,
          model: QWEN3_EMBEDDING_8B_MODEL,
          dimensions: QWEN3_EMBEDDING_8B_DIMENSIONS,
          calls,
          totalTokens,
          estimatedCostUsd,
        })}\n`,
      );
    }
  }, 120_000);
});
