// biome-ignore-all lint/complexity/useLiteralKeys: fake Pi SDK records are intentionally untrusted
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ConfiguredPiModelDescriptor,
  ConfiguredPiModelBindingPort,
  type PiModelRuntime,
  type PiModelRuntimeFactory,
} from "../src/index.js";

const PRIMARY_REF = "model-openrouter-primary";
const FALLBACK_REF = "model-openrouter-fallback";
const SECRET = "fixture-provider-value";
const FALLBACK_ROUTING = {
  order: ["z-ai"],
  allow_fallbacks: false,
  require_parameters: true,
  data_collection: "deny",
} as const;

function modelDescriptor(
  role: "primary" | "fallback",
  overrides: Partial<ConfiguredPiModelDescriptor> = {},
): ConfiguredPiModelDescriptor {
  const fallback = role === "fallback";
  return {
    ref: fallback ? FALLBACK_REF : PRIMARY_REF,
    routingClass: role,
    priority: fallback ? 2 : 1,
    provider: "openrouter",
    model: fallback ? "z-ai/glm-5.3-flash" : "deepseek/deepseek-v4-flash-0731",
    version: fallback ? "catalog-2026-08-27" : "catalog-2026-08-27",
    name: fallback ? "GLM 5.3 Flash" : "DeepSeek V4 Flash 0731",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: fallback
      ? { input: 0.075, output: 0.25, cacheRead: 0.015, cacheWrite: 0 }
      : { input: 0.03, output: 0.1, cacheRead: 0.007, cacheWrite: 0 },
    contextWindow: 1_310_720,
    maxTokens: fallback ? 48_000 : 131_072,
    capabilities: ["text", "tool_calling", "structured_outputs"],
    disclosure: "external_remote",
    allowedDataClassifications: fallback ? ["private"] : ["public", "private"],
    secretRequirement: {
      secretRef: "openrouter-api-key",
      secretVersion: "v1",
      purpose: "model-provider-auth",
    },
    ...(fallback ? { providerRouting: FALLBACK_ROUTING } : {}),
    ...overrides,
  };
}

function descriptors(): readonly ConfiguredPiModelDescriptor[] {
  return [modelDescriptor("primary"), modelDescriptor("fallback")];
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

  it("lazily resolves the shared secret and registers exactly the closed model set", async () => {
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
    expect(primary.model).toBe(runtime.models.get("openrouter:deepseek/deepseek-v4-flash-0731"));
    expect(await binding.resolve(FALLBACK_REF)).toMatchObject({ modelRuntime: runtime });
    expect(create).toHaveBeenCalledTimes(1);
    expect(resolveSecret).toHaveBeenCalledTimes(1);
    expect(resolveSecret).toHaveBeenCalledWith("openrouter-api-key", "v1");
    expect(runtimeOptions[0]).toMatchObject({
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    expect(runtimeOptions[0]).toHaveProperty("credentials");
    expect(JSON.stringify(runtimeOptions[0])).not.toContain(SECRET);
    expect(runtime.registered).toHaveLength(1);
    expect(runtime.registered[0]?.providerId).toBe("openrouter");
    expect(runtime.registered[0]?.config["models"]).toEqual([
      expect.objectContaining({ id: "deepseek/deepseek-v4-flash-0731" }),
      expect.objectContaining({ id: "z-ai/glm-5.3-flash" }),
    ]);
    expect(runtime.registered[0]?.config["models"]).toHaveLength(2);
    expect(
      (runtime.registered[0]?.config["models"] as Record<string, unknown>[])[1]?.["compat"],
    ).toMatchObject({ openRouterRouting: FALLBACK_ROUTING });
    expect(JSON.stringify(binding.configuredDescriptors())).not.toContain(SECRET);
    expect(JSON.stringify(runtime.registered)).not.toContain(SECRET);
    expect(runtime.apiKeys).toEqual([{ providerId: "openrouter", value: SECRET }]);

    await binding.close();
    expect(runtime.removedProviders).toEqual(["openrouter"]);
  });

  it("rejects development secret sources and fallback disclosure expansion", () => {
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
          descriptors: [
            modelDescriptor("primary"),
            modelDescriptor("fallback", { allowedDataClassifications: ["public", "private"] }),
          ],
          secretSource: { productionSuitable: true, resolve: async () => SECRET },
        }),
    ).toThrow("allowedDataClassifications must be exactly private");
  });

  it("works with the pinned Pi runtime without disk model discovery", async () => {
    const binding = new ConfiguredPiModelBindingPort({
      descriptors: descriptors(),
      secretSource: { productionSuitable: true, resolve: async () => SECRET },
    });

    const primary = await binding.resolve(PRIMARY_REF);
    const fallback = await binding.resolve(FALLBACK_REF);

    expect(primary.model).toBeDefined();
    expect(fallback.model).toBeDefined();
    expect(primary.modelRuntime).toBe(fallback.modelRuntime);
    await binding.close();
  });
});
