import {
  MEM0_AI_GATEWAY_BASE_URL,
  QWEN3_EMBEDDING_8B_COST,
  QWEN3_EMBEDDING_8B_DIMENSIONS,
  QWEN3_EMBEDDING_8B_MODEL,
  QWEN3_EMBEDDING_8B_VERSION,
} from "@himawari-agent/memory-mem0";
import { parseProductConfiguration } from "@himawari-agent/platform-node";

export const AI_GATEWAY_LIVE_BUDGET_USD = 1;
export const AI_GATEWAY_LIVE_BUDGET_MICROS = AI_GATEWAY_LIVE_BUDGET_USD * 1_000_000;
export const AI_GATEWAY_PRIMARY_MODEL = "deepseek/deepseek-v4.1-flash";
export const AI_GATEWAY_GENERATION_SNAPSHOT = "catalog-2026-10-06";
export const AI_GATEWAY_PROVIDER_SECRET_REF = "vercel-ai-gateway-api-key";
export const AI_GATEWAY_PROVIDER_SECRET_VERSION = "v1";
export const AI_GATEWAY_PRIMARY_ROUTING = Object.freeze({
  order: Object.freeze(["runware", "deepinfra", "morph"]),
  sort: "cost" as const,
});

export function createAiGatewayLiveConfiguration(stateRoot: string) {
  return parseProductConfiguration(
    {
      schemaVersion: "himawari.configuration.v1",
      deploymentId: "deployment-ai-gateway-live-qualification",
      ownerId: "owner-ai-gateway-live-qualification",
      agentId: "agent-ai-gateway-live-qualification",
      stateRoot,
      runtimeDirectory: `${stateRoot}/runtime`,
      cacheDirectory: `${stateRoot}/cache`,
      publicOrigin: "http://127.0.0.1",
      publicMode: false,
      modelDescriptors: [
        {
          ref: "model-primary",
          role: "primary",
          provider: "vercel-ai-gateway",
          model: AI_GATEWAY_PRIMARY_MODEL,
          version: AI_GATEWAY_GENERATION_SNAPSHOT,
          priority: 1,
          name: "DeepSeek V4.1 Flash",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          capabilities: ["text", "tool_calling", "structured_outputs"],
          cost: { input: 0.3, output: 2.4, cacheRead: 0.3, cacheWrite: 0.3 },
          contextWindow: 1_048_576,
          maxTokens: 32768,
          allowedDataClassifications: ["public", "private"],
          disclosure: "external_remote",
          secretRef: AI_GATEWAY_PROVIDER_SECRET_REF,
          providerRouting: AI_GATEWAY_PRIMARY_ROUTING,
        },
        {
          ref: "model-embedding",
          role: "embedding",
          provider: "vercel-ai-gateway",
          model: QWEN3_EMBEDDING_8B_MODEL,
          version: QWEN3_EMBEDDING_8B_VERSION,
          capabilities: ["embedding"],
          cost: QWEN3_EMBEDDING_8B_COST,
          dimensions: QWEN3_EMBEDDING_8B_DIMENSIONS,
          allowedDataClassifications: ["public", "private"],
          disclosure: "external_remote",
          secretRef: AI_GATEWAY_PROVIDER_SECRET_REF,
        },
      ],
      memory: {
        adapter: "mem0-oss",
        version: "3.3.1",
        storagePath: `${stateRoot}/data/memory`,
        dimensions: QWEN3_EMBEDDING_8B_DIMENSIONS,
      },
      repositoryAllowlistRefs: [],
      secretReferences: [
        {
          ref: AI_GATEWAY_PROVIDER_SECRET_REF,
          version: AI_GATEWAY_PROVIDER_SECRET_VERSION,
          purpose: "model-provider-auth",
          scope: "model",
        },
      ],
      budgets: {
        globalCostMicros: AI_GATEWAY_LIVE_BUDGET_MICROS,
        perRunCostMicros: AI_GATEWAY_LIVE_BUDGET_MICROS,
        perClassificationCostMicros: {
          public: AI_GATEWAY_LIVE_BUDGET_MICROS,
          private: AI_GATEWAY_LIVE_BUDGET_MICROS,
          sensitive: 0,
          restricted: 0,
        },
      },
      concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
      deadlines: { runMs: 300_000, workerRequestMs: 30_000, providerRequestMs: 120_000 },
    },
    "2026-10-06T00:00:00.000Z",
  );
}

export { MEM0_AI_GATEWAY_BASE_URL };
