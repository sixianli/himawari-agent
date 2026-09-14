import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

process.env.MEM0_TELEMETRY = "false";
process.env.MEM0_TELEMETRY_SAMPLE_RATE = "0";
const root = process.env.HIMAWARI_TEST_RUNTIME_ROOT;
if (!root) throw new Error("INSTALLED_RUNTIME_REQUIRED");
const loadPackage = (name) =>
  import(pathToFileURL(path.join(root, "node_modules", name, "dist/index.js")).href);
const [agent, platform] = await Promise.all([
  loadPackage("@himawari-agent/agent-service"),
  loadPackage("@himawari-agent/platform-node"),
]);
const sources = {
  provider: new platform.RestrictedProviderSecretSource(process.env.HIMAWARI_TEST_SECRET_DIRECTORY),
  keys: new platform.RestrictedSecretFileSource(process.env.HIMAWARI_TEST_SECRET_DIRECTORY),
};
const providerUrl = process.env.HIMAWARI_TEST_MODEL_URL;
if (!providerUrl?.startsWith("https://127.0.0.1:")) throw new Error("LOCAL_PROVIDER_REQUIRED");
const raw = JSON.parse(await readFile(process.env.HIMAWARI_TEST_CONFIGURATION, "utf8"));
const output = {
  write: (data) => {
    process.stdout.write(data);
    if (String(data).includes('"event":"service.ready"'))
      process.stdout.write(
        `HIMAWARI_PRODUCTION_HTTP_READY ${JSON.stringify({ address: `http://127.0.0.1:${raw.http.listenPort}` })}\n`,
      );
    return true;
  },
};
process.exitCode = await agent.runAgentService(process.argv.slice(2), output, process.stderr, {
  secretSources: sources,
  modelCompositionFactory: async ({ configuration, repository }) => {
    const clock = { now: () => new Date().toISOString() };
    const ids = { next: (scope) => `${scope}:${randomUUID()}` };
    const handles = new platform.EphemeralSecretPort({ clock, ids });
    const descriptors = agent.resolveConfiguredModelDescriptorSet(configuration);
    const composition = agent.createProductionModelComposition({
      ownerId: configuration.ownerId,
      agentId: configuration.agentId,
      descriptors: descriptors.generation.map((model) => ({ ...model, baseUrl: providerUrl })),
      handles,
      secretSource: sources.provider,
      payloads: repository.payloadStore(configuration.ownerId, configuration.agentId),
      protector: new platform.EnvelopePayloadProtector({
        keys: sources.keys,
        activeKey: { keyRef: "payload-kek", kekVersion: "v1", dekVersion: "dek-v1" },
      }),
      ids,
      clock,
      requestTimeoutMs: configuration.deadlines.providerRequestMs,
    });
    return {
      descriptors,
      composition: {
        ...composition,
        close: async () => {
          try {
            await composition.close();
          } finally {
            handles.clear();
          }
        },
      },
    };
  },
  memoryCompositionFactory: async ({ configuration }) => {
    const { Memory } = await import(
      pathToFileURL(path.join(root, "node_modules/mem0ai/dist/oss/index.mjs")).href
    ).catch((error) => {
      if (error.code === "ERR_MODULE_NOT_FOUND") process.stderr.write(`${error.message}\n`);
      throw error;
    });
    return agent.createProductionMemoryCompositionFromConfiguration({
      configuration,
      secretSource: sources.provider,
      load: async () => ({
        Memory: class extends Memory {
          constructor(config) {
            super({
              ...config,
              embedder: {
                ...config.embedder,
                config: { ...config.embedder.config, baseURL: providerUrl },
              },
              llm: { ...config.llm, config: { ...config.llm.config, baseURL: providerUrl } },
            });
          }
        },
      }),
    });
  },
});
