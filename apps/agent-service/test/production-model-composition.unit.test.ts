// biome-ignore-all lint/complexity/useLiteralKeys: fake Pi SDK records are intentionally untrusted
import type {
  ConfiguredPiModelDescriptor,
  PiModelRuntime,
  PiModelRuntimeFactory,
} from "@himawari-agent/runtime-pi";
import { createReferenceAdapterSet, type ReferenceAdapterSet } from "@himawari-agent/testing";
import { describe, expect, it, vi } from "vitest";
import { createProductionModelComposition } from "../src/index.js";

const primaryModel: ConfiguredPiModelDescriptor = {
  ref: "model-openrouter-primary",
  provider: "openrouter",
  model: "deepseek/deepseek-v4-flash-0731",
  version: "catalog-2026-08-27",
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
  version: "catalog-2026-08-27",
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
  maxTokens: 48_000,
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
});
