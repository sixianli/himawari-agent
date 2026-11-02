import { ConfiguredPiModelBindingPort } from "@himawari-agent/runtime-pi";
import { getPiModelPresentation } from "@himawari-agent/runtime-pi";
import { describe, expect, it } from "vitest";
import { resolveConfiguredModelDescriptorSet } from "../src/production-model-composition.js";
import {
  expandConfigurationWithMagpieModels,
  parseMagpieModelList,
  priceTiers,
} from "../src/production-magpie-models.js";

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  context_length: 1_000_000,
  context_window: 1_000_000,
  display_name: id,
  id,
  magpie_label: `${id} · OpenCode Go`,
  max_input_tokens: 1_000_000,
  max_output_tokens: 384_000,
  modalities: { input: ["text"], output: ["text"] },
  object: "model",
  reasoning: true,
  reasoning_levels: ["high", "max"],
  tool_call: true,
  type: "model",
  ...extra,
});

const LIST = {
  object: "list",
  data: [
    entry("group/himawari-main", {
      context_window: 200_000,
      max_output_tokens: 200_000,
      reasoning_levels: ["low", "medium", "high", "xhigh", "max"],
    }),
    entry("auto/grok-4.7", {
      reasoning_levels: ["low", "medium", "high", "xhigh"],
      pricing: { completion: "0.000006", prompt: "0.000002" },
    }),
    entry("opencode-go/deepseek-v4-pro", {
      pricing: { completion: "0.00000198", input_cache_read: "0.000000022", prompt: "0.00000066" },
    }),
    entry("opencode-go/glm-5.3-flash", {
      max_output_tokens: 131_072,
      modalities: { input: ["text", "image"] },
      reasoning_levels: ["low", "medium", "high"],
      pricing: { completion: "0.0000005", prompt: "0.00000015" },
    }),
    entry("opencode-go/kimi-k3", {
      pricing: { completion: "0.000015", prompt: "0.000003" },
    }),
    entry("opencode-go/plain", { reasoning: false, reasoning_levels: [] }),
    entry("opencode-go/no-tools", { tool_call: false }),
    entry("opencode-go/image-only", { modalities: { input: ["image"] } }),
  ],
};

const configuration = () =>
  ({
    modelDescriptors: [
      {
        ref: "model-primary",
        role: "primary",
        provider: "magpie",
        model: "group/himawari-main",
        version: "v1",
        priority: 1,
        disclosure: "trusted_remote",
        capabilities: ["text", "tool_calling"],
        allowedDataClassifications: ["public", "private"],
        secretRef: "magpie-gateway",
        name: "DeepSeek V4.1 Flash",
        api: "openai-completions",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.3, output: 2.4, cacheRead: 0.3, cacheWrite: 0.3 },
        contextWindow: 1_000_000,
        maxTokens: 32768,
        baseUrl: "http://127.0.0.1:3425/v1",
      },
      {
        ref: "model-embedding",
        role: "embedding",
        provider: "deterministic",
        model: "embedding-fixture",
        version: "fixture-1",
        dimensions: 8,
        capabilities: ["embedding"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        allowedDataClassifications: ["public", "private"],
        disclosure: "local_only",
        secretRef: null,
      },
    ],
    memory: { dimensions: 8 },
    secretReferences: [
      { ref: "magpie-gateway", version: "v1", purpose: "model-auth", scope: "model-primary" },
    ],
  }) as never;

const jsonFetch = (body: unknown, status = 200) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
const calls: { url: string; authorization: string | null }[] = [];

describe("Magpie model discovery", () => {
  it("reads the real /v1/models fields: limits, image input, real reasoning levels, per-token prices", () => {
    const parsed = parseMagpieModelList(LIST);
    const pro = parsed.find(({ id }) => id === "opencode-go/deepseek-v4-pro");
    expect(pro).toMatchObject({
      label: "opencode-go/deepseek-v4-pro · OpenCode Go",
      contextWindow: 1_000_000,
      maxOutputTokens: 384_000,
      reasoningLevels: ["high", "max"],
      acceptsImages: false,
    });
    expect(pro?.price?.input).toBeCloseTo(0.66);
    expect(pro?.price?.output).toBeCloseTo(1.98);
    expect(parsed.find(({ id }) => id === "opencode-go/glm-5.3-flash")?.acceptsImages).toBe(true);
    expect(parsed.find(({ id }) => id === "opencode-go/plain")?.reasoningLevels).toEqual([]);
    expect(parseMagpieModelList({ data: [{ id: "x" }, 7, null] })).toEqual([]);
    expect(parseMagpieModelList("nope")).toEqual([]);
  });

  it("adds every listed tool-calling text model as its own descriptor and keeps the configured one first", async () => {
    calls.length = 0;
    const expansion = await expandConfigurationWithMagpieModels(configuration(), {
      resolveSecret: async () => "gateway-key\n",
      fetch: jsonFetch(LIST),
    });
    expect(calls).toEqual([
      { url: "http://127.0.0.1:3425/v1/models", authorization: "Bearer gateway-key" },
    ]);
    const primaries = expansion.configuration.modelDescriptors.filter(
      ({ role }) => role === "primary",
    );
    expect(primaries.map((descriptor) => descriptor.model)).toEqual([
      "group/himawari-main",
      "opencode-go/deepseek-v4-pro",
      "opencode-go/glm-5.3-flash",
      "opencode-go/kimi-k3",
      "opencode-go/plain",
    ]);
    expect(primaries[0]).toMatchObject({
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    });
    const glm = primaries.find((descriptor) => descriptor.model === "opencode-go/glm-5.3-flash");
    expect(glm).toMatchObject({
      ref: "magpie:opencode-go/glm-5.3-flash",
      provider: "magpie",
      baseUrl: "http://127.0.0.1:3425/v1",
      secretRef: "magpie-gateway",
      input: ["text", "image"],
      maxTokens: 32768,
      contextWindow: 1_000_000,
      reasoning: true,
      thinkingLevels: ["low", "medium", "high"],
    });
    expect(glm).toMatchObject({
      cost: { input: expect.closeTo(0.15), output: expect.closeTo(0.5) },
    });
    expect(primaries.find((descriptor) => descriptor.model === "opencode-go/plain")).toMatchObject({
      reasoning: false,
      cost: { input: 0.3, output: 2.4 },
    });
    expect([...expansion.prices.keys()].sort()).toEqual([
      "magpie:opencode-go/deepseek-v4-pro",
      "magpie:opencode-go/glm-5.3-flash",
      "magpie:opencode-go/kimi-k3",
    ]);
    expect([...expansion.automaticRefs]).toEqual(["model-primary"]);
  });

  it("falls back to the configured model when Magpie cannot be read", async () => {
    const events: Record<string, string | number>[] = [];
    const original = configuration();
    for (const fetcher of [
      jsonFetch({}, 500),
      (async () => {
        throw new Error("connect ECONNREFUSED");
      }) as typeof fetch,
    ]) {
      const expansion = await expandConfigurationWithMagpieModels(original, {
        resolveSecret: async () => "k",
        fetch: fetcher,
        onDiagnostic: (event) => events.push(event),
      });
      expect(expansion.configuration).toBe(original);
      expect(expansion.prices.size).toBe(0);
    }
    expect(events.map(({ event }) => event)).toEqual([
      "magpie-models.discovery_failed",
      "magpie-models.discovery_failed",
    ]);
  });

  it("leaves non-Magpie configurations alone without any request", async () => {
    calls.length = 0;
    const gateway = configuration() as { modelDescriptors: { provider: string }[] };
    const original = {
      ...gateway,
      modelDescriptors: gateway.modelDescriptors.map((descriptor, index) =>
        index === 0 ? { ...descriptor, provider: "vercel-ai-gateway" } : descriptor,
      ),
    } as never;
    const expansion = await expandConfigurationWithMagpieModels(original, {
      resolveSecret: async () => "k",
      fetch: jsonFetch(LIST),
    });
    expect(expansion.configuration).toBe(original);
    expect(calls).toEqual([]);
  });

  it("splits tiers by the listed prices themselves, not by fixed thresholds", () => {
    const tiers = priceTiers(
      new Map([
        ["a", { input: 0.1, output: 0.2 }],
        ["b", { input: 0.2, output: 0.2 }],
        ["c", { input: 1, output: 2 }],
        ["d", { input: 1, output: 3 }],
        ["e", { input: 5, output: 20 }],
        ["f", { input: 9, output: 40 }],
      ]),
    );
    expect([...tiers]).toEqual([
      ["a", "low"],
      ["b", "low"],
      ["c", "mid"],
      ["d", "mid"],
      ["e", "high"],
      ["f", "high"],
    ]);
    const scaled = priceTiers(
      new Map([
        ["a", { input: 100, output: 200 }],
        ["b", { input: 200, output: 200 }],
        ["c", { input: 1000, output: 2000 }],
      ]),
    );
    expect([...scaled.values()]).toEqual(["low", "mid", "high"]);
    expect(priceTiers(new Map()).size).toBe(0);
  });

  it("gives every discovered model only the reasoning levels Magpie lists for it", async () => {
    const expansion = await expandConfigurationWithMagpieModels(configuration(), {
      resolveSecret: async () => "k",
      fetch: jsonFetch(LIST),
    });
    const resolved = resolveConfiguredModelDescriptorSet(expansion.configuration);
    const pi = resolved.generation.filter(
      (descriptor) => descriptor.api === "openai-completions",
    ) as never[];
    const port = new ConfiguredPiModelBindingPort({
      descriptors: pi,
      secretSource: { productionSuitable: true, resolve: async () => "secret" },
    });
    const levels = async (ref: string) =>
      getPiModelPresentation(await port.resolve(ref)).thinkingLevels;
    expect(await levels("model-primary")).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    expect(await levels("magpie:opencode-go/deepseek-v4-pro")).toEqual(["off", "high", "max"]);
    expect(await levels("magpie:opencode-go/glm-5.3-flash")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
    expect(await levels("magpie:opencode-go/plain")).toEqual(["off"]);
    await port.close();
  });
});
