import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const startupStage = (stage) =>
  process.stdout.write(`${JSON.stringify({ event: "test.startup", stage })}\n`);
startupStage("imports_started");
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
startupStage("imports_completed");
const payloadHandle = platform.PayloadUdsServer.prototype.handle;
platform.PayloadUdsServer.prototype.handle = async function (request, response, body) {
  const fault = process.env.HIMAWARI_TEST_PREPARATION_TRANSPORT_FAILURE;
  if (fault && request.url === "/payload/v1/sandbox/execution") {
    const message = JSON.parse(body.toString("utf8"));
    if (
      message.payload?.command?.kind === "resolve" &&
      (await readFile(fault, "utf8").then(
        () => true,
        () => false,
      ))
    ) {
      await rename(fault, `${fault}.consumed`);
      await writeFile(
        `${fault}.entered`,
        JSON.stringify({
          at: new Date().toISOString(),
          pid: process.pid,
          identity: message.payload.identity,
          operation: "resolve",
          fault: "UDS_RESPONSE_DESTROYED_BEFORE_PREPARATION_CONTROL",
        }),
      );
      response.destroy();
      return;
    }
  }
  return payloadHandle.call(this, request, response, body);
};

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
startupStage("service_starting");
process.exitCode = await agent.runAgentService(process.argv.slice(2), output, process.stderr, {
  secretSources: sources,
  modelCompositionFactory: async ({ configuration, repository }) => {
    startupStage("model_composition");
    const preparations = repository.sandboxExecutionPreparations.bind(repository);
    repository.sandboxExecutionPreparations = (...args) => {
      const port = preparations(...args);
      const legacyInput = async (input) => {
        const fault = process.env.HIMAWARI_TEST_PREPARATION_TRANSPORT_FAILURE;
        const mode = fault ? await readFile(fault, "utf8").catch(() => "") : "";
        if (mode !== "legacy") return input;
        const { preparationProtocol: _protocol, ...plan } = input.plan;
        return { ...input, plan };
      };
      return {
        ...port,
        enqueue: async (input) => port.enqueue(await legacyInput(input)),
        reserve: async (input) => port.reserve(await legacyInput(input)),
      };
    };
    const journal = repository.sandboxExecutionJournal.bind(repository);
    repository.sandboxExecutionJournal = (...args) => {
      const port = journal(...args);
      const prepare = port.prepareIntent.bind(port);
      return {
        ...port,
        prepareIntent: async (input) => {
          const result = await prepare(input);
          const fault = process.env.HIMAWARI_TEST_DELIVERY_CRASH;
          if (
            fault &&
            input.kind === "tool_result" &&
            (await readFile(fault, "utf8").then(
              () => true,
              () => false,
            ))
          ) {
            await rename(fault, `${fault}.consumed`);
            await writeFile(
              `${fault}.entered`,
              JSON.stringify({
                jobId: input.identity.jobId,
                runId: input.identity.runId,
                at: new Date().toISOString(),
              }),
            );
            await new Promise(() => {});
          }
          return result;
        },
      };
    };
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
    startupStage("memory_import_started");
    const { Memory } = await import(
      pathToFileURL(path.join(root, "node_modules/mem0ai/dist/oss/index.mjs")).href
    ).catch((error) => {
      if (error.code === "ERR_MODULE_NOT_FOUND") process.stderr.write(`${error.message}\n`);
      throw error;
    });
    startupStage("memory_composition_started");
    const composition = await agent.createProductionMemoryCompositionFromConfiguration({
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
    startupStage("memory_composition_completed");
    return composition;
  },
});
