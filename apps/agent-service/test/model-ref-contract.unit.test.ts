import { modelRefString as executionModelRef } from "@himawari-agent/execution-contracts";
import { modelRefString as gatewayModelRef } from "@himawari-agent/gateway-contracts";
import { describe, expect, it } from "vitest";
import { expandConfigurationWithMagpieModels } from "../src/production-magpie-models.js";

const entry = (id: string) => ({
  context_window: 200_000,
  display_name: id,
  id,
  max_output_tokens: 32_000,
  modalities: { input: ["text"], output: ["text"] },
  reasoning: true,
  reasoning_levels: ["high"],
  tool_call: true,
});

const configuration = {
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
      secretRef: "magpie-gateway",
      name: "Main",
      api: "openai-completions",
      reasoning: true,
      input: ["text"],
      cost: { input: 0.3, output: 2.4, cacheRead: 0.3, cacheWrite: 0.3 },
      contextWindow: 1_000_000,
      maxTokens: 32768,
      baseUrl: "http://127.0.0.1:3425/v1",
    },
  ],
  memory: { dimensions: 8 },
  secretReferences: [
    { ref: "magpie-gateway", version: "v1", purpose: "model-auth", scope: "model-primary" },
  ],
} as never;

const listed = (ids: readonly string[]) =>
  (async () =>
    new Response(JSON.stringify({ data: ids.map(entry) }), { status: 200 })) as typeof fetch;

describe("[I-73] every model the list offers can be sent", () => {
  const ids = [
    "opencode-go/deepseek-v4.1-flash",
    "opencode-go/glm-5.3-flash",
    "opencode-go/kimi-k3",
    "vendor/model.v2:beta",
    "plain-model",
  ];

  it("accepts the reference of every offered model in both contract packages", async () => {
    const diagnostics: Record<string, string | number>[] = [];
    const expansion = await expandConfigurationWithMagpieModels(configuration, {
      resolveSecret: async () => "key",
      fetch: listed(ids),
      onDiagnostic: (event) => diagnostics.push(event),
    });
    const refs = expansion.configuration.modelDescriptors
      .filter((descriptor) => descriptor.role === "primary")
      .map((descriptor) => descriptor.ref);
    expect(refs.length).toBe(ids.length + 1);
    for (const ref of refs) {
      expect(gatewayModelRef.parse(ref), ref).toBe(ref);
      expect(executionModelRef.parse(ref), ref).toBe(ref);
    }
    expect(
      diagnostics.some(({ event }) => event === "magpie-models.ref_rejected_by_contract"),
    ).toBe(false);
  });

  it("never offers a model whose reference the send check would refuse", async () => {
    const diagnostics: Record<string, string | number>[] = [];
    const expansion = await expandConfigurationWithMagpieModels(configuration, {
      resolveSecret: async () => "key",
      fetch: listed(["opencode-go/ok", "bad id with space", "中文/模型", `x/${"y".repeat(130)}`]),
      onDiagnostic: (event) => diagnostics.push(event),
    });
    const refs = expansion.configuration.modelDescriptors.map((descriptor) => descriptor.ref);
    expect(refs).toEqual(["model-primary", "magpie:opencode-go/ok"]);
    expect(diagnostics).toContainEqual({
      event: "magpie-models.ref_rejected_by_contract",
      count: 3,
      sample: "bad?id?with?space",
    });
  });

  it("refuses references that could rewrite a path or a web address", () => {
    for (const value of ["a//b", "a/", "a/../b", "magpie:../x", "magpie://evil/x", "a/./b"]) {
      expect(() => gatewayModelRef.parse(value), value).toThrow();
      expect(() => executionModelRef.parse(value), value).toThrow();
    }
    for (const value of ["a".repeat(128), `a/${"b".repeat(126)}`, "a..b", "v1.2/model-x"]) {
      expect(gatewayModelRef.parse(value)).toBe(value);
    }
    expect(() => gatewayModelRef.parse("a".repeat(129))).toThrow();
  });

  it("keeps the two contract packages' model-reference rules identical", () => {
    const values = [
      "a/b",
      "a b",
      "/a",
      "a·b",
      "a".repeat(129),
      "a".repeat(127) + "/",
      `a/${"b".repeat(126)}`,
      "",
      "a:b/c-d.e_f",
      "a//b",
      "a/",
      "a/../b",
      "magpie:../x",
      "a/./b",
      "a..b",
      "v1.2/model",
    ];
    for (const value of values) {
      const accepted = (schema: { parse(input: unknown): unknown }) => {
        try {
          schema.parse(value);
          return true;
        } catch {
          return false;
        }
      };
      expect(accepted(gatewayModelRef), value).toBe(accepted(executionModelRef));
    }
  });
});
