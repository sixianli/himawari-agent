// biome-ignore-all lint/complexity/useLiteralKeys: fake Pi SDK records are intentionally untrusted

import { parseProductConfiguration } from "@himawari-agent/platform-node";
import type {
  ConfiguredPiModelDescriptor,
  PiModelRuntime,
  PiModelRuntimeFactory,
} from "@himawari-agent/runtime-pi";
import { createReferenceAdapterSet, type ReferenceAdapterSet } from "@himawari-agent/testing";
import { describe, expect, it, vi } from "vitest";
import {
  createProductionMemoryCompositionFromConfiguration,
  createProductionModelComposition,
  resolveConfiguredModelDescriptorSet,
} from "../src/index.js";

const primaryModel: ConfiguredPiModelDescriptor = {
  ref: "model-openrouter-primary",
  provider: "openrouter",
  model: "deepseek/deepseek-v4-flash-0731",
  version: "catalog-2026-08-28",
  routingClass: "primary",
  priority: 1,
  disclosure: "external_remote",
  capabilities: ["text", "tool_calling", "structured_outputs"],
  allowedDataClassifications: ["public", "private"],
  secretRequirement: {
    secretRef: "openrouter-api-key",
    secretVersion: "v1",
    purpose: "model-provider-auth",
  },
  name: "DeepSeek V4 Flash 0731",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.03, output: 0.1, cacheRead: 0.007, cacheWrite: 0 },
  contextWindow: 1_310_720,
  maxTokens: 131_072,
};

const fallbackRouting = {
  order: ["z-ai"],
  allow_fallbacks: false,
  require_parameters: true,
  data_collection: "deny" as const,
};

const fallbackModel: ConfiguredPiModelDescriptor = {
  ref: "model-openrouter-fallback",
  provider: "openrouter",
  model: "z-ai/glm-5.3-flash",
  version: "catalog-2026-08-28",
  routingClass: "fallback",
  priority: 2,
  disclosure: "external_remote",
  capabilities: ["text", "tool_calling", "structured_outputs"],
  allowedDataClassifications: ["private"],
  secretRequirement: {
    secretRef: "openrouter-api-key",
    secretVersion: "v1",
    purpose: "model-provider-auth",
  },
  providerRouting: fallbackRouting,
  name: "GLM 5.3 Flash",
  api: "openai-completions",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 },
  contextWindow: 1_310_720,
  maxTokens: 131_072,
};

const descriptors = [primaryModel, fallbackModel] as const;

class RecordingRuntime {
  readonly models = new Map<string, unknown>();
  readonly removedProviders: string[] = [];

  getModel(providerId: string, modelId: string): unknown | undefined {
    return this.models.get(`${providerId}:${modelId}`);
  }

  registerProvider(providerId: string, config: Readonly<Record<string, unknown>>): void {
    const models = config["models"];
    if (!Array.isArray(models)) throw new Error("models missing");
    for (const model of models) {
      if (model === null || typeof model !== "object" || Array.isArray(model)) {
        throw new Error("model invalid");
      }
      const id = (model as Record<string, unknown>)["id"];
      if (typeof id !== "string") throw new Error("model id missing");
      this.models.set(`${providerId}:${id}`, model);
    }
  }

  async setRuntimeApiKey(): Promise<void> {}

  async removeRuntimeApiKey(providerId: string): Promise<void> {
    this.removedProviders.push(providerId);
  }
}

function compositionOptions(
  adapters: ReferenceAdapterSet,
  overrides: Partial<Parameters<typeof createProductionModelComposition>[0]> = {},
) {
  const resolve = vi.fn(async () => "fixture-provider-value");
  const options = {
    ownerId: "owner-production-model" as never,
    agentId: "agent-production-model" as never,
    descriptors,
    handles: adapters.secret,
    secretSource: {
      kind: "macos-keychain" as const,
      productionSuitable: true,
      resolve,
    },
    payloads: adapters.payload,
    protector: adapters.payloadProtector,
    ids: adapters.ids,
    clock: adapters.clock,
    ...overrides,
  };
  return { options, resolve };
}

function selectedEmbeddingConfiguration(stateRoot: string) {
  return parseProductConfiguration(
    {
      schemaVersion: "himawari.configuration.v1",
      deploymentId: "deployment-production-memory",
      ownerId: "owner-production-memory",
      agentId: "agent-production-memory",
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
          model: primaryModel.model,
          version: primaryModel.version,
          priority: primaryModel.priority,
          name: primaryModel.name,
          api: "openai-completions",
          reasoning: primaryModel.reasoning,
          input: [...primaryModel.input],
          capabilities: [...primaryModel.capabilities],
          cost: { ...primaryModel.cost },
          contextWindow: primaryModel.contextWindow,
          maxTokens: primaryModel.maxTokens,
          allowedDataClassifications: ["public", "private"],
          disclosure: "external_remote",
          secretRef: "openrouter-api-key",
        },
        {
          ref: "model-fallback",
          role: "fallback",
          provider: "openrouter",
          model: fallbackModel.model,
          version: fallbackModel.version,
          priority: fallbackModel.priority,
          name: fallbackModel.name,
          api: "openai-completions",
          reasoning: fallbackModel.reasoning,
          input: [...fallbackModel.input],
          capabilities: [...fallbackModel.capabilities],
          cost: { ...fallbackModel.cost },
          contextWindow: fallbackModel.contextWindow,
          maxTokens: fallbackModel.maxTokens,
          allowedDataClassifications: ["private"],
          disclosure: "external_remote",
          secretRef: "openrouter-api-key",
          providerRouting: fallbackRouting,
        },
        {
          ref: "model-embedding",
          role: "embedding",
          provider: "openrouter",
          model: "qwen/qwen3-embedding-8b",
          version: "catalog-2026-08-28",
          capabilities: ["embedding"],
          cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 },
          dimensions: 4096,
          allowedDataClassifications: ["public", "private"],
          disclosure: "external_remote",
          secretRef: "openrouter-api-key",
        },
      ],
      memory: {
        adapter: "mem0-oss",
        version: "3.1.7",
        storagePath: `${stateRoot}/data/memory`,
        dimensions: 4096,
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
      deadlines: { runMs: 1000, workerRequestMs: 1000, providerRequestMs: 1000 },
    },
    "2026-08-28T00:00:00.000Z",
  );
}

describe("production model composition", () => {
  it("wires the trusted transport and closed Pi binding to the same descriptors", async () => {
    const adapters = createReferenceAdapterSet();
    const runtime = new RecordingRuntime();
    const runtimeFactory: PiModelRuntimeFactory = {
      create: async () => runtime as unknown as PiModelRuntime,
    };
    const prepared = compositionOptions(adapters, { runtimeFactory });
    const composition = createProductionModelComposition(prepared.options);

    expect(await composition.model.listAvailable()).toEqual(descriptors);
    expect(prepared.resolve).not.toHaveBeenCalled();
    const binding = await composition.piModels.resolve(primaryModel.ref);
    expect(binding.model).toBe(runtime.models.get("openrouter:deepseek/deepseek-v4-flash-0731"));
    expect(prepared.resolve).toHaveBeenCalledWith("openrouter-api-key", "v1");
    expect(prepared.resolve).toHaveBeenCalledTimes(1);
    expect(composition.transport).toBeDefined();
    expect(composition.payloadBoundary).toBeDefined();

    await composition.close();
    expect(runtime.removedProviders).toEqual(["openrouter"]);
  });

  it("rejects unsafe secret sources and conflicting canonical descriptors", () => {
    const adapters = createReferenceAdapterSet();
    expect(() =>
      createProductionModelComposition(
        compositionOptions(adapters, {
          secretSource: {
            kind: "macos-keychain",
            productionSuitable: false,
            resolve: async () => "fixture-provider-value",
          },
        }).options,
      ),
    ).toThrow("Development secret sources are forbidden in production or public profiles");

    expect(() =>
      createProductionModelComposition(
        compositionOptions(adapters, {
          descriptors: [
            primaryModel,
            {
              ...fallbackModel,
              secretRequirement: { ...fallbackModel.secretRequirement, secretVersion: "v2" },
            },
          ],
        }).options,
      ),
    ).toThrow("PI_MODEL_BINDING_REQUIRES_SHARED_PROVIDER_SECRET");
  });

  it("maps strict configuration into one Pi generation set and an independent embedding descriptor", () => {
    const stateRoot = "/tmp/himawari-model-descriptor-test";
    const configuration = parseProductConfiguration(
      {
        schemaVersion: "himawari.configuration.v1",
        deploymentId: "deployment-model-descriptor-test",
        ownerId: "owner-model-descriptor-test",
        agentId: "agent-model-descriptor-test",
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
            model: primaryModel.model,
            version: primaryModel.version,
            priority: 1,
            name: primaryModel.name,
            api: "openai-completions",
            reasoning: false,
            input: ["text"],
            capabilities: [...primaryModel.capabilities],
            cost: { ...primaryModel.cost },
            contextWindow: primaryModel.contextWindow,
            maxTokens: primaryModel.maxTokens,
            allowedDataClassifications: ["public", "private"],
            disclosure: "external_remote",
            secretRef: "openrouter-api-key",
          },
          {
            ref: "model-fallback",
            role: "fallback",
            provider: "openrouter",
            model: fallbackModel.model,
            version: fallbackModel.version,
            priority: 2,
            name: fallbackModel.name,
            api: "openai-completions",
            reasoning: false,
            input: ["text"],
            capabilities: [...fallbackModel.capabilities],
            cost: { ...fallbackModel.cost },
            contextWindow: fallbackModel.contextWindow,
            maxTokens: fallbackModel.maxTokens,
            allowedDataClassifications: ["private"],
            disclosure: "external_remote",
            secretRef: "openrouter-api-key",
            providerRouting: fallbackRouting,
          },
          {
            ref: "model-embedding",
            role: "embedding",
            provider: "openai-compatible",
            model: "text-embedding-fixture",
            version: "catalog-2026-08-28",
            capabilities: ["embedding"],
            cost: { input: 0.02, output: 0, cacheRead: 0, cacheWrite: 0 },
            dimensions: 1536,
            allowedDataClassifications: ["public", "private"],
            disclosure: "trusted_remote",
            secretRef: "embedding-api-key",
          },
        ],
        memory: {
          adapter: "mem0-oss",
          version: "3.1.7",
          storagePath: `${stateRoot}/data/memory`,
          dimensions: 1536,
        },
        repositoryAllowlistRefs: [],
        secretReferences: [
          {
            ref: "openrouter-api-key",
            version: "v1",
            purpose: "model-provider-auth",
            scope: "model",
          },
          {
            ref: "embedding-api-key",
            version: "v2",
            purpose: "embedding-provider-auth",
            scope: "embedding",
          },
        ],
        budgets: {
          globalCostMicros: 0,
          perRunCostMicros: 0,
          perClassificationCostMicros: { public: 0, private: 0, sensitive: 0, restricted: 0 },
        },
        concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
        deadlines: { runMs: 1000, workerRequestMs: 1000, providerRequestMs: 1000 },
      },
      "2026-08-27T00:00:00.000Z",
    );

    const resolved = resolveConfiguredModelDescriptorSet(configuration);
    expect(resolved.generation).toHaveLength(2);
    expect(resolved.generation[0]).toMatchObject({
      ref: "model-primary",
      provider: "openrouter",
      secretRequirement: {
        secretRef: "openrouter-api-key",
        secretVersion: "v1",
        purpose: "model-provider-auth",
      },
    });
    expect(resolved.generation[1]?.providerRouting).toEqual(fallbackRouting);
    expect(resolved.embedding).toMatchObject({
      ref: "model-embedding",
      provider: "openai-compatible",
      model: "text-embedding-fixture",
      version: "catalog-2026-08-28",
      dimensions: 1536,
      secretRequirement: {
        secretRef: "embedding-api-key",
        secretVersion: "v2",
        purpose: "embedding-provider-auth",
      },
    });
    expect(resolved.embedding).not.toHaveProperty("input");
    expect(resolved.embedding).not.toHaveProperty("api");
  });

  it("fails closed instead of inventing a Pi route for an unregistered generation provider", () => {
    const configuration = {
      modelDescriptors: [
        { ...primaryModel, role: "primary" as const, provider: "unknown-provider" },
        { ...fallbackModel, role: "fallback" as const },
        {
          ref: "model-embedding",
          role: "embedding" as const,
          provider: "deterministic",
          model: "embedding-fixture",
          version: "fixture-1",
          dimensions: 8,
          capabilities: ["embedding"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          allowedDataClassifications: ["public", "private"],
          disclosure: "local_only" as const,
          secretRef: null,
        },
      ],
      memory: { dimensions: 8 },
      secretReferences: primaryModel.secretRequirement
        ? [{ ...primaryModel.secretRequirement, scope: "model" }]
        : [],
    } as never;
    expect(() => resolveConfiguredModelDescriptorSet(configuration)).toThrow(
      "MODEL_PI_PROVIDER_UNSUPPORTED",
    );
  });

  it("composes the selected 4096-dimensional Qwen embedding through Mem0", async () => {
    const configuration = selectedEmbeddingConfiguration(
      "/private/tmp/himawari-production-memory-composition",
    );
    const resolvedSecrets: string[] = [];
    const composition = await createProductionMemoryCompositionFromConfiguration({
      configuration,
      secretSource: {
        kind: "macos-keychain",
        productionSuitable: true,
        resolve: async (secretRef, secretVersion) => {
          resolvedSecrets.push(`${secretRef}@${secretVersion}`);
          return "fixture-provider-value";
        },
      },
      load: async () => ({
        Memory: class {
          readonly configuration: Readonly<Record<string, unknown>>;

          constructor(configuration: Readonly<Record<string, unknown>>) {
            this.configuration = configuration;
          }
        } as never,
      }),
    });

    expect(composition.descriptor).toMatchObject({
      provider: "openrouter",
      model: "qwen/qwen3-embedding-8b",
      version: "catalog-2026-08-28",
      dimensions: 4096,
      cost: { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(resolvedSecrets).toEqual(["openrouter-api-key@v1"]);
    await composition.close();
  });
});
