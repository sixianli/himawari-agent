// biome-ignore-all lint/complexity/useLiteralKeys: fake Pi SDK records are intentionally untrusted
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfiguredPiModelBindingPort,
  getPiModelPresentation,
  type ConfiguredPiModelDescriptor,
  type PiModelRuntime,
  type PiModelRuntimeFactory,
} from "../src/index.js";

const PRIMARY_REF = "model-gateway-primary";
const SECRET = "fixture-provider-value";
const ROUTING = { order: ["runware", "deepinfra", "morph"], sort: "cost" } as const;

function modelDescriptor(
  role: "primary",
  overrides: Partial<ConfiguredPiModelDescriptor> = {},
): ConfiguredPiModelDescriptor {
  return {
    ref: PRIMARY_REF,
    routingClass: role,
    priority: 1,
    provider: "vercel-ai-gateway",
    model: "deepseek/deepseek-v4.1-flash",
    version: "catalog-2026-10-06",
    name: "DeepSeek V4.1 Flash",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.3, output: 2.4, cacheRead: 0.3, cacheWrite: 0.3 },
    contextWindow: 1_000_000,
    maxTokens: 32768,
    capabilities: ["text", "tool_calling", "structured_outputs"],
    disclosure: "external_remote",
    allowedDataClassifications: ["public", "private"],
    secretRequirement: {
      secretRef: "ai-gateway-api-key",
      secretVersion: "v1",
      purpose: "model-provider-auth",
    },
    providerRouting: ROUTING,
    ...overrides,
  };
}

function descriptors(): readonly ConfiguredPiModelDescriptor[] {
  return [modelDescriptor("primary")];
}

class RecordingRuntime {
  readonly registered: {
    readonly providerId: string;
    readonly config: Readonly<Record<string, unknown>>;
  }[] = [];
  readonly apiKeys: { readonly providerId: string; readonly value: string }[] = [];
  readonly removedProviders: string[] = [];
  readonly models = new Map<string, unknown>();

  getModel(providerId: string, modelId: string): unknown | undefined {
    return this.models.get(`${providerId}:${modelId}`);
  }

  registerProvider(providerId: string, config: Readonly<Record<string, unknown>>): void {
    this.registered.push({ providerId, config });
    const models = config["models"];
    if (!Array.isArray(models)) throw new Error("missing models");
    for (const model of models) {
      if (model === null || typeof model !== "object" || Array.isArray(model)) {
        throw new Error("invalid model");
      }
      const id = (model as Record<string, unknown>)["id"];
      if (typeof id !== "string") throw new Error("invalid model id");
      this.models.set(`${providerId}:${id}`, model);
    }
  }

  async setRuntimeApiKey(providerId: string, apiKey: string): Promise<void> {
    this.apiKeys.push({ providerId, value: apiKey });
  }

  async removeRuntimeApiKey(providerId: string): Promise<void> {
    this.removedProviders.push(providerId);
  }
}

describe("ConfiguredPiModelBindingPort", () => {
  afterEach(() => vi.restoreAllMocks());

  function gatewayDescriptor(): ConfiguredPiModelDescriptor {
    return {
      ...modelDescriptor("primary"),
      provider: "vercel-ai-gateway",
      model: "deepseek/deepseek-v4.1-flash",
      name: "DeepSeek V4.1 Flash",
      maxTokens: 32768,
      providerRouting: { order: ["runware", "deepinfra", "morph"], sort: "cost" },
    };
  }

  it("[R2-L5] binds one primary DeepSeek model without a fallback or ambient key", async () => {
    const runtime = new RecordingRuntime();
    const binding = new ConfiguredPiModelBindingPort({
      descriptors: [gatewayDescriptor()],
      secretSource: { productionSuitable: true, resolve: async () => SECRET },
      runtimeFactory: { create: async () => runtime as unknown as PiModelRuntime },
    });
    const primary = await binding.resolve(PRIMARY_REF);

    expect(primary.model).toBe(
      runtime.models.get("vercel-ai-gateway:deepseek/deepseek-v4.1-flash"),
    );
    expect(runtime.registered[0]?.config["baseUrl"]).toBe("https://ai-gateway.vercel.sh/v1");
    expect(runtime.registered[0]?.config["models"]).toHaveLength(1);
    expect(primary.descriptor?.providerRouting).toEqual({
      order: ["runware", "deepinfra", "morph"],
      sort: "cost",
    });
    expect(runtime.apiKeys).toHaveLength(0);
    expect(JSON.stringify(runtime.registered)).not.toContain(SECRET);
    await binding.close();
  });

  it("[R2-L5] rejects a second text descriptor before Pi initialization", () => {
    expect(
      () =>
        new ConfiguredPiModelBindingPort({
          descriptors: [gatewayDescriptor(), { ...gatewayDescriptor(), ref: "retired-fallback" }],
          secretSource: { productionSuitable: true, resolve: async () => SECRET },
        }),
    ).toThrow("PI_MODEL_BINDING_REQUIRES_ONE_PRIMARY");
  });

  it("[R2-L5] rejects output above the gateway model limit", () => {
    expect(
      () =>
        new ConfiguredPiModelBindingPort({
          descriptors: [{ ...gatewayDescriptor(), maxTokens: 32769 }],
          secretSource: { productionSuitable: true, resolve: async () => SECRET },
        }),
    ).toThrow("maxTokens must not exceed 32768");
  });

  it("omits off for endpoints that require reasoning, using Pi capability mapping", async () => {
    const runtime = new RecordingRuntime();
    const binding = new ConfiguredPiModelBindingPort({
      descriptors: [modelDescriptor("primary", { reasoning: true, reasoningRequired: true })],
      secretSource: { productionSuitable: true, resolve: async () => SECRET },
      runtimeFactory: { create: async () => runtime as unknown as PiModelRuntime },
    });
    const primary = await binding.resolve(PRIMARY_REF);
    expect(getPiModelPresentation(primary).thinkingLevels).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    await binding.close();
    const plain = new ConfiguredPiModelBindingPort({
      descriptors: descriptors(),
      secretSource: { productionSuitable: true, resolve: async () => SECRET },
      runtimeFactory: { create: async () => new RecordingRuntime() as unknown as PiModelRuntime },
    });
    expect(getPiModelPresentation(await plain.resolve(PRIMARY_REF)).thinkingLevels).toEqual([
      "off",
    ]);
    await plain.close();
  });

  it("registers exactly the closed model set and defers the shared secret", async () => {
    const runtime = new RecordingRuntime();
    const runtimeOptions: Parameters<PiModelRuntimeFactory["create"]>[0][] = [];
    const create: PiModelRuntimeFactory["create"] = vi.fn(async (options) => {
      runtimeOptions.push(options);
      return runtime as unknown as PiModelRuntime;
    });
    const resolveSecret = vi.fn(async () => SECRET);
    const binding = new ConfiguredPiModelBindingPort({
      descriptors: descriptors(),
      secretSource: { productionSuitable: true, resolve: resolveSecret },
      runtimeFactory: { create },
    });

    expect(create).not.toHaveBeenCalled();
    expect(resolveSecret).not.toHaveBeenCalled();
    await expect(binding.resolve("model-not-configured")).rejects.toThrow(
      "PI_MODEL_REF_NOT_CONFIGURED",
    );
    expect(create).not.toHaveBeenCalled();
    expect(resolveSecret).not.toHaveBeenCalled();

    const primary = await binding.resolve(PRIMARY_REF);
    expect(primary.model).toBe(
      runtime.models.get("vercel-ai-gateway:deepseek/deepseek-v4.1-flash"),
    );
    expect(await binding.resolve(PRIMARY_REF)).toMatchObject({ modelRuntime: runtime });
    expect(create).toHaveBeenCalledTimes(1);
    expect(resolveSecret).not.toHaveBeenCalled();
    if (!primary.resolveSecret) throw new Error("Expected deferred secret resolver");
    await expect(primary.resolveSecret()).resolves.toBe(SECRET);
    expect(resolveSecret).toHaveBeenCalledTimes(1);
    expect(resolveSecret).toHaveBeenCalledWith("ai-gateway-api-key", "v1");
    expect(runtimeOptions[0]).toMatchObject({
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    expect(runtimeOptions[0]).toHaveProperty("credentials");
    expect(JSON.stringify(runtimeOptions[0])).not.toContain(SECRET);
    expect(runtime.registered).toHaveLength(1);
    expect(runtime.registered[0]?.providerId).toBe("vercel-ai-gateway");
    expect(runtime.registered[0]?.config["models"]).toEqual([
      expect.objectContaining({ id: "deepseek/deepseek-v4.1-flash" }),
    ]);
    expect(runtime.registered[0]?.config["models"]).toHaveLength(1);
    expect(binding.configuredDescriptors()[0]?.providerRouting).toEqual(ROUTING);
    expect(
      Reflect.set(binding.configuredDescriptors()[0]?.providerRouting?.order ?? [], "0", "other"),
    ).toBe(false);
    expect(JSON.stringify(binding.configuredDescriptors())).not.toContain(SECRET);
    expect(JSON.stringify(runtime.registered)).not.toContain(SECRET);
    expect(runtime.apiKeys).toEqual([]);

    await binding.close();
    expect(runtime.removedProviders).toEqual([]);
  });

  it("[R2-L5] rejects development secret sources and unsupported text models", () => {
    expect(
      () =>
        new ConfiguredPiModelBindingPort({
          descriptors: descriptors(),
          secretSource: { productionSuitable: false, resolve: async () => SECRET },
        }),
    ).toThrow("PI_UNSAFE_PROVIDER_SECRET_SOURCE");

    expect(
      () =>
        new ConfiguredPiModelBindingPort({
          descriptors: [modelDescriptor("primary", { model: "unsupported-text-model" })],
          secretSource: { productionSuitable: true, resolve: async () => SECRET },
        }),
    ).toThrow("model is unsupported");
  });

  it("works with the pinned Pi runtime without disk model discovery", async () => {
    const binding = new ConfiguredPiModelBindingPort({
      descriptors: descriptors(),
      secretSource: { productionSuitable: true, resolve: async () => SECRET },
    });

    const primary = await binding.resolve(PRIMARY_REF);
    const same = await binding.resolve(PRIMARY_REF);

    expect(primary.model).toBeDefined();
    expect(same.model.id).toBe("deepseek/deepseek-v4.1-flash");
    expect(primary.modelRuntime).toBe(same.modelRuntime);
    await binding.close();
  });
});
