import {
  MEM0_OPENROUTER_BASE_URL,
  QWEN3_EMBEDDING_8B_COST,
  QWEN3_EMBEDDING_8B_DIMENSIONS,
  QWEN3_EMBEDDING_8B_MODEL,
  QWEN3_EMBEDDING_8B_VERSION,
} from "@himawari-agent/memory-mem0";
import { parseProductConfiguration } from "@himawari-agent/platform-node";

export const OPENROUTER_LIVE_BUDGET_USD = 1;
export const OPENROUTER_LIVE_BUDGET_MICROS = OPENROUTER_LIVE_BUDGET_USD * 1_000_000;
export const OPENROUTER_PRIMARY_MODEL = "deepseek/deepseek-v4-flash-0731";
export const OPENROUTER_FALLBACK_MODEL = "z-ai/glm-5.3-flash";
export const OPENROUTER_GENERATION_SNAPSHOT = "catalog-2026-08-28";
export const OPENROUTER_PROVIDER_SECRET_REF = "openrouter-api-key";
export const OPENROUTER_PROVIDER_SECRET_VERSION = "v1";

export const OPENROUTER_FALLBACK_ROUTING = Object.freeze({
  order: Object.freeze(["z-ai"]),
  allow_fallbacks: false,
  require_parameters: true,
  data_collection: "deny" as const,
});

export function createOpenRouterLiveConfiguration(stateRoot: string) {
  return parseProductConfiguration(
    {
      schemaVersion: "himawari.configuration.v1",
      deploymentId: "deployment-openrouter-live-qualification",
      ownerId: "owner-openrouter-live-qualification",
      agentId: "agent-openrouter-live-qualification",
      stateRoot,
      runtimeDirectory: `${stateRoot}/runtime`,
      cacheDirectory: `${stateRoot}/cache`,
      publicOrigin: "http://127.0.0.1",
      publicMode: false,
      modelDescriptors: [
        {
          ref: "model-primary",
          role: "primary",
          provider: "openrouter",
          model: OPENROUTER_PRIMARY_MODEL,
          version: OPENROUTER_GENERATION_SNAPSHOT,
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
          secretRef: OPENROUTER_PROVIDER_SECRET_REF,
        },
        {
          ref: "model-fallback",
          role: "fallback",
          provider: "openrouter",
          model: OPENROUTER_FALLBACK_MODEL,
          version: OPENROUTER_GENERATION_SNAPSHOT,
          priority: 2,
          name: "GLM 5.3 Flash",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          capabilities: ["text", "tool_calling", "structured_outputs"],
          cost: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 },
          contextWindow: 1_310_720,
          maxTokens: 131_072,
          allowedDataClassifications: ["private"],
          disclosure: "external_remote",
          secretRef: OPENROUTER_PROVIDER_SECRET_REF,
          providerRouting: OPENROUTER_FALLBACK_ROUTING,
        },
        {
          ref: "model-embedding",
          role: "embedding",
          provider: "openrouter",
          model: QWEN3_EMBEDDING_8B_MODEL,
          version: QWEN3_EMBEDDING_8B_VERSION,
          capabilities: ["embedding"],
          cost: QWEN3_EMBEDDING_8B_COST,
          dimensions: QWEN3_EMBEDDING_8B_DIMENSIONS,
          allowedDataClassifications: ["public", "private"],
          disclosure: "external_remote",
          secretRef: OPENROUTER_PROVIDER_SECRET_REF,
        },
      ],
      memory: {
        adapter: "mem0-oss",
        version: "3.1.7",
        storagePath: `${stateRoot}/data/memory`,
        dimensions: QWEN3_EMBEDDING_8B_DIMENSIONS,
      },
      repositoryAllowlistRefs: [],
      secretReferences: [
        {
          ref: OPENROUTER_PROVIDER_SECRET_REF,
          version: OPENROUTER_PROVIDER_SECRET_VERSION,
          purpose: "model-provider-auth",
          scope: "model",
        },
      ],
      budgets: {
        globalCostMicros: OPENROUTER_LIVE_BUDGET_MICROS,
        perRunCostMicros: OPENROUTER_LIVE_BUDGET_MICROS,
        perClassificationCostMicros: {
          public: OPENROUTER_LIVE_BUDGET_MICROS,
          private: OPENROUTER_LIVE_BUDGET_MICROS,
          sensitive: 0,
          restricted: 0,
        },
      },
      concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
      deadlines: { runMs: 300_000, workerRequestMs: 30_000, providerRequestMs: 120_000 },
    },
    "2026-08-28T00:00:00.000Z",
  );
}

export { MEM0_OPENROUTER_BASE_URL };
