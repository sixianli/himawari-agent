import { createServer, type Server } from "node:http";
import { ConfiguredPiModelBindingPort } from "@himawari-agent/runtime-pi";
import { afterEach, describe, expect, it } from "vitest";
import { expandConfigurationWithMagpieModels } from "../../apps/agent-service/src/production-magpie-models.js";
import { resolveConfiguredModelDescriptorSet } from "../../apps/agent-service/src/production-model-composition.js";
import { ACCEPTANCE_SELECTABLE_MODELS } from "../../apps/control-center/test/release-walkthrough-models.js";

const listed = (id: string, label: string) => ({
  id,
  object: "model",
  type: "model",
  display_name: label,
  magpie_label: label,
  context_window: 32768,
  max_output_tokens: 2048,
  modalities: { input: ["text"], output: ["text"] },
  reasoning: false,
  tool_call: true,
});

function descriptor(ref: string, model: string, priority: number) {
  return {
    ref,
    role: "primary",
    provider: "magpie",
    model,
    version: "v1",
    disclosure: "trusted_remote",
    secretRef: "vercel-ai-gateway-api-key",
    capabilities: ["text", "tools"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    priority,
    name: "Product path primary",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 2048,
    baseUrl: "http://127.0.0.1:3425/v1",
  };
}

const embedding = {
  ref: "model-embedding",
  role: "embedding",
  provider: "deterministic",
  model: "embedding-fixture",
  version: "fixture-1",
  dimensions: 8,
  capabilities: ["embedding"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  disclosure: "local_only",
  secretRef: null,
};

async function listenCatalog(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.url !== "/v1/models") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        object: "list",
        data: [
          listed("deepseek/deepseek-v4.1-flash", "Product path primary"),
          ...ACCEPTANCE_SELECTABLE_MODELS.map((entry) => listed(entry.model, entry.name)),
        ],
      }),
    );
  });
  const port = await new Promise<number>((resolve) =>
    server.listen({ host: "127.0.0.1", port: 0 }, () =>
      resolve((server.address() as { port: number }).port),
    ),
  );
  return { server, port };
}

const secretReferences = [
  {
    ref: "vercel-ai-gateway-api-key",
    version: "v1",
    purpose: "model-provider-auth",
    scope: "agent",
  },
];

describe("release walkthrough selectable models reach the product the way production gets them", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it("adds each acceptance model, with its slash reference, from the model list service", async () => {
    server = createServer((request, response) => {
      if (request.url !== "/v1/models") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: [
            listed("deepseek/deepseek-v4.1-flash", "Product path primary"),
            ...ACCEPTANCE_SELECTABLE_MODELS.map((entry) => listed(entry.model, entry.name)),
          ],
        }),
      );
    });
    const port = await new Promise<number>((resolve) =>
      (server as Server).listen({ host: "127.0.0.1", port: 0 }, () =>
        resolve(((server as Server).address() as { port: number }).port),
      ),
    );
    const primary = {
      ...descriptor("model-primary", "deepseek/deepseek-v4.1-flash", 1),
      baseUrl: `http://127.0.0.1:${port}/v1`,
    };
    const expansion = await expandConfigurationWithMagpieModels(
      {
        modelDescriptors: [primary, embedding],
        secretReferences: [
          {
            ref: "vercel-ai-gateway-api-key",
            version: "v1",
            purpose: "model-provider-auth",
            scope: "agent",
          },
        ],
      } as never,
      { resolveSecret: async () => "local-provider-fixture" },
    );
    const refs = expansion.configuration.modelDescriptors
      .filter(({ role }) => role === "primary")
      .map(({ ref }) => ref);
    expect(refs).toEqual(["model-primary", ...ACCEPTANCE_SELECTABLE_MODELS.map(({ ref }) => ref)]);
    const names = expansion.configuration.modelDescriptors.flatMap((entry) =>
      "name" in entry ? [entry.name] : [],
    );
    for (const entry of ACCEPTANCE_SELECTABLE_MODELS) expect(names).toContain(entry.name);
  });

  it("[I-75] binds every expanded model the way the walkthrough service does, and refuses an https address", async () => {
    const started = await listenCatalog();
    server = started.server;
    const catalogUrl = `http://127.0.0.1:${started.port}/v1`;
    const expansion = await expandConfigurationWithMagpieModels(
      {
        modelDescriptors: [
          {
            ...descriptor("model-primary", "deepseek/deepseek-v4.1-flash", 1),
            baseUrl: catalogUrl,
          },
          embedding,
        ],
        memory: { dimensions: 8 },
        secretReferences,
      } as never,
      { resolveSecret: async () => "local-provider-fixture" },
    );
    const generation = resolveConfiguredModelDescriptorSet(
      expansion.configuration as never,
    ).generation;
    expect(generation).toHaveLength(1 + ACCEPTANCE_SELECTABLE_MODELS.length);
    const secretSource = {
      productionSuitable: true,
      resolve: async () => "local-provider-fixture",
    };
    const bind = (baseUrl: string) =>
      new ConfiguredPiModelBindingPort({
        descriptors: generation.map((model) => ({ ...model, baseUrl })) as never,
        secretSource,
      });
    expect(() => bind(catalogUrl)).not.toThrow();
    expect(() => bind("https://127.0.0.1:9443/v1")).toThrow("loopback HTTP URL");
  });
});
