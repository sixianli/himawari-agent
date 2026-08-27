import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentId,
  createMemoryId,
  createOwnerId,
  createThreadId,
} from "@himawari-agent/domain";
import {
  QWEN3_EMBEDDING_8B_COST,
  QWEN3_EMBEDDING_8B_DIMENSIONS,
  QWEN3_EMBEDDING_8B_MODEL,
} from "@himawari-agent/memory-mem0";
import { MacOsKeychainProviderSecretSource } from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionMemoryCompositionFromConfiguration } from "../../apps/agent-service/src/production-memory-composition.js";
import {
  createOpenRouterLiveConfiguration,
  MEM0_OPENROUTER_BASE_URL,
  OPENROUTER_LIVE_BUDGET_USD,
} from "./fixtures/openrouter-live-configuration.js";

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
        configuration: createOpenRouterLiveConfiguration(stateRoot),
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
    expect(estimatedCostUsd).toBeLessThanOrEqual(OPENROUTER_LIVE_BUDGET_USD);
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
