import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readdir, stat } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const MEM0_VERSION = "3.1.7";
const DIMENSION = 12;
const CUSTOM_INSTRUCTIONS =
  "只提取输入中 MEMORY_FACT 或 MEMORY_PARTIAL 标记的事实；不得推断、扩写或调用外部资源。";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function requiredAbsolutePath(value, code) {
  assert(typeof value === "string" && path.isAbsolute(value), code);
  return path.resolve(value);
}

function vector(text) {
  const digest = createHash("sha256").update(text).digest();
  const values = Array.from({ length: DIMENSION }, (_, index) => digest[index] / 255 - 0.5);
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / magnitude);
}

function messageText(message) {
  if (!message || typeof message !== "object") return "";
  return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
}

function extractedMemories(messages) {
  const combined = messages.map(messageText).join("\n");
  const partial = /MEMORY_PARTIAL::([^|]+)\|([^:]+)::END_PARTIAL/.exec(combined);
  if (partial) {
    return [partial[1], partial[2]].map((text) => ({ text, attributed_to: "owner" }));
  }
  const fact = /MEMORY_FACT::(.+?)::END_FACT/.exec(combined);
  return fact ? [{ text: fact[1], attributed_to: "owner" }] : [];
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function createDeterministicProvider() {
  const calls = [];
  let injectPartialEmbeddingFailure = false;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const body = await readBody(request);
      calls.push({ path: url.pathname, body });
      if (url.pathname === "/v1/embeddings") {
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        if (injectPartialEmbeddingFailure && inputs.some((input) => input === "partial-bad")) {
          sendJson(response, 503, { error: { message: "injected embedding failure" } });
          return;
        }
        sendJson(response, 200, {
          object: "list",
          model: body.model,
          data: inputs.map((input, index) => ({
            object: "embedding",
            index,
            embedding: vector(String(input)),
          })),
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        });
        return;
      }
      if (url.pathname === "/v1/chat/completions") {
        sendJson(response, 200, {
          id: "deterministic-local-response",
          object: "chat.completion",
          created: 0,
          model: body.model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: JSON.stringify({ memory: extractedMemories(body.messages ?? []) }),
              },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
        return;
      }
      sendJson(response, 404, { error: { message: "unsupported local provider route" } });
    } catch (error) {
      sendJson(response, 500, {
        error: { message: error instanceof Error ? error.message : "provider fixture failed" },
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object", "MEM0_PROVIDER_ADDRESS_INVALID");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    port: address.port,
    calls,
    setPartialFailure(value) {
      injectPartialEmbeddingFailure = value;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function configuration(stateRoot, providerBaseUrl, suffix = "primary") {
  const vectorPath = path.join(stateRoot, `${suffix}-vectors.sqlite`);
  const historyPath = path.join(stateRoot, `${suffix}-history.sqlite`);
  return {
    version: "v1.1",
    embedder: {
      provider: "openai",
      config: {
        apiKey: "local-compatibility-only",
        baseURL: providerBaseUrl,
        model: "deterministic-embedding-v1",
        embeddingDims: DIMENSION,
      },
    },
    vectorStore: {
      provider: "memory",
      config: {
        collectionName: `himawari_${suffix}`,
        dimension: DIMENSION,
        dbPath: vectorPath,
      },
    },
    llm: {
      provider: "openai",
      config: {
        apiKey: "local-compatibility-only",
        baseURL: providerBaseUrl,
        model: "deterministic-extraction-v1",
        temperature: 0,
        maxTokens: 256,
      },
    },
    historyStore: {
      provider: "sqlite",
      config: { historyDbPath: historyPath },
    },
    historyDbPath: historyPath,
    disableHistory: false,
    customInstructions: CUSTOM_INSTRUCTIONS,
  };
}

function assertExplicitConfiguration(config, stateRoot) {
  assert(config.version === "v1.1", "MEM0_VERSION_CONFIG_MISSING");
  assert(config.embedder?.provider && config.embedder?.config?.model, "MEM0_EMBEDDER_MISSING");
  assert(config.embedder.config.embeddingDims === DIMENSION, "MEM0_EMBEDDING_DIMENSION_MISSING");
  assert(config.vectorStore?.provider === "memory", "MEM0_VECTOR_STORE_MISSING");
  assert(config.vectorStore.config.dimension === DIMENSION, "MEM0_VECTOR_DIMENSION_MISSING");
  assert(config.llm?.provider && config.llm?.config?.model, "MEM0_LLM_MISSING");
  assert(config.historyStore?.provider === "sqlite", "MEM0_HISTORY_STORE_MISSING");
  assert(config.customInstructions === CUSTOM_INSTRUCTIONS, "MEM0_INSTRUCTIONS_MISSING");
  for (const target of [
    config.vectorStore.config.dbPath,
    config.historyStore.config.historyDbPath,
  ]) {
    assert(path.isAbsolute(target), "MEM0_PATH_NOT_ABSOLUTE");
    const relative = path.relative(stateRoot, target);
    assert(relative !== ".." && !relative.startsWith(`..${path.sep}`), "MEM0_PATH_ESCAPED");
  }
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, target)));
    else if (entry.isFile()) files.push(path.relative(root, target).split(path.sep).join("/"));
    else throw new Error("MEM0_UNEXPECTED_FILESYSTEM_ENTRY");
  }
  return files.sort();
}

async function addProjection(memory, productRecord, infer = false) {
  const result = await memory.add(productRecord.content, {
    userId: productRecord.ownerId,
    agentId: productRecord.agentId,
    runId: productRecord.runId,
    infer,
    metadata: {
      product_memory_id: productRecord.productMemoryId,
      source_ref: productRecord.sourceRef,
      classification: productRecord.classification,
      projection_version: productRecord.projectionVersion,
    },
  });
  assert(result.results.length === 1, "MEM0_PROJECTION_RESULT_COUNT_INVALID");
  return result.results[0].id;
}

const stateRoot = requiredAbsolutePath(argument("--state-root"), "MEM0_STATE_ROOT_REQUIRED");
const platformLabel = argument("--platform") ?? `${process.platform}-${process.arch}`;
await mkdir(stateRoot, { recursive: false });
assert((await readdir(stateRoot)).length === 0, "MEM0_STATE_ROOT_NOT_EMPTY");
const mem0ConfigRoot = path.join(stateRoot, "mem0-config");
await mkdir(mem0ConfigRoot, { recursive: false });
process.env.MEM0_TELEMETRY = "false";
process.env.MEM0_TELEMETRY_SAMPLE_RATE = "0";
process.env.MEM0_DIR = mem0ConfigRoot;

const provider = await createDeterministicProvider();
const originalFetch = globalThis.fetch;
const originalSocketConnect = net.Socket.prototype.connect;
const fetchAttempts = [];
const socketAttempts = [];
globalThis.fetch = async (input, init) => {
  const target = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  fetchAttempts.push(target.href);
  if (target.origin !== new URL(provider.baseUrl).origin) {
    throw new Error(`MEM0_UNDECLARED_NETWORK:${target.origin}`);
  }
  return originalFetch(input, init);
};
net.Socket.prototype.connect = function monitoredConnect(...arguments_) {
  const rawFirst = arguments_[0];
  const first = Array.isArray(rawFirst) ? rawFirst[0] : rawFirst;
  const options = typeof first === "object" && first !== null ? first : null;
  const host = options
    ? (options.host ?? options.hostname ?? "localhost")
    : typeof arguments_[1] === "string"
      ? arguments_[1]
      : "localhost";
  const port = Number(options ? options.port : first);
  socketAttempts.push({ host: String(host), port });
  if (!(["127.0.0.1", "localhost", "::1"].includes(String(host)) && port === provider.port)) {
    throw new Error(`MEM0_UNDECLARED_SOCKET:${String(host)}:${port}`);
  }
  return originalSocketConnect.apply(this, arguments_);
};

const resourcesBefore = process.getActiveResourcesInfo?.() ?? [];
let result;
try {
  const module = await import("mem0ai/oss");
  const Memory = module.Memory;
  assert(typeof Memory === "function", "MEM0_OSS_EXPORT_MISSING");
  const primaryConfig = configuration(stateRoot, provider.baseUrl);
  assertExplicitConfiguration(primaryConfig, stateRoot);
  const memory = new Memory(primaryConfig);

  const inferred = {
    ownerId: "owner-compat",
    agentId: "agent-compat",
    runId: "run-inferred",
    productMemoryId: "memory-inferred",
    sourceRef: "trace-inferred",
    classification: "private",
    projectionVersion: "projection-policy-v1",
    content: "MEMORY_FACT::所有者偏好寿司::END_FACT",
  };
  const inferredResult = await memory.add(inferred.content, {
    userId: inferred.ownerId,
    agentId: inferred.agentId,
    runId: inferred.runId,
    infer: true,
    metadata: {
      product_memory_id: inferred.productMemoryId,
      source_ref: inferred.sourceRef,
      classification: inferred.classification,
      projection_version: inferred.projectionVersion,
    },
  });
  assert(inferredResult.results.length === 1, "MEM0_EXPLICIT_LLM_RESULT_INVALID");

  const productRecord = {
    ownerId: "owner-compat",
    agentId: "agent-compat",
    runId: "run-main",
    productMemoryId: "memory-main",
    sourceRef: "trace-main",
    classification: "private",
    projectionVersion: "projection-policy-v1",
    content: "所有者偏好安静的餐厅",
  };
  const providerId = await addProjection(memory, productRecord);
  const roundTrip = await memory.get(providerId);
  assert(roundTrip?.metadata?.product_memory_id === "memory-main", "MEM0_METADATA_LOST");
  assert(roundTrip?.metadata?.source_ref === "trace-main", "MEM0_SOURCE_LOST");
  assert(roundTrip?.metadata?.classification === "private", "MEM0_CLASSIFICATION_LOST");

  const filtered = await memory.search(productRecord.content, {
    filters: { user_id: "owner-compat", product_memory_id: "memory-main" },
    topK: 10,
    threshold: 0,
  });
  assert(
    filtered.results.some(({ id }) => id === providerId),
    "MEM0_FILTER_SEARCH_FAILED",
  );

  await memory.update(providerId, {
    text: "所有者偏好安静且禁烟的餐厅",
    metadata: { correction_source_ref: "trace-correction" },
  });
  const corrected = await memory.get(providerId);
  assert(corrected?.memory === "所有者偏好安静且禁烟的餐厅", "MEM0_CORRECTION_FAILED");
  assert(
    corrected?.metadata?.correction_source_ref === "trace-correction",
    "MEM0_CORRECTION_METADATA_FAILED",
  );
  const historyBeforeDelete = await memory.history(providerId);
  assert(
    historyBeforeDelete.some(({ action }) => action === "ADD"),
    "MEM0_ADD_HISTORY_MISSING",
  );
  assert(
    historyBeforeDelete.some(({ action }) => action === "UPDATE"),
    "MEM0_UPDATE_HISTORY_MISSING",
  );

  const concurrentRecords = Array.from({ length: 12 }, (_, index) => ({
    ...productRecord,
    runId: `run-concurrent-${index}`,
    productMemoryId: `memory-concurrent-${index}`,
    sourceRef: `trace-concurrent-${index}`,
    content: `并发事实 ${index}`,
  }));
  const second = new Memory(primaryConfig);
  const concurrentProviderIds = await Promise.all(
    concurrentRecords.map((record, index) =>
      addProjection(index % 2 === 0 ? memory : second, record),
    ),
  );
  assert(new Set(concurrentProviderIds).size === 12, "MEM0_CONCURRENT_ID_COLLISION");

  const restarted = new Memory(primaryConfig);
  const afterRestart = await restarted.get(providerId);
  assert(afterRestart?.memory === corrected.memory, "MEM0_RESTART_PERSISTENCE_FAILED");
  assert(
    concurrentProviderIds.every((id) => id) &&
      (await restarted.getAll({ filters: { user_id: "owner-compat" } })).results.length >= 14,
    "MEM0_CONCURRENT_PERSISTENCE_FAILED",
  );

  provider.setPartialFailure(true);
  const partialResult = await restarted.add(
    "MEMORY_PARTIAL::partial-good|partial-bad::END_PARTIAL",
    {
      userId: "owner-compat",
      agentId: "agent-compat",
      runId: "run-partial",
      infer: true,
      metadata: {
        product_memory_id: "memory-partial-probe",
        source_ref: "trace-partial-probe",
        classification: "private",
        projection_version: "projection-policy-v1",
      },
    },
  );
  provider.setPartialFailure(false);
  assert(partialResult.results.length === 1, "MEM0_PARTIAL_FAILURE_BEHAVIOR_CHANGED");
  assert(partialResult.results[0].memory === "partial-good", "MEM0_PARTIAL_SURVIVOR_CHANGED");
  await restarted.delete(partialResult.results[0].id);

  await restarted.delete(providerId);
  assert((await restarted.get(providerId)) === null, "MEM0_DELETE_FAILED");
  const historyAfterDelete = await restarted.history(providerId);
  assert(
    historyAfterDelete.some(({ action }) => action === "DELETE"),
    "MEM0_DELETE_HISTORY_MISSING",
  );
  const afterDeleteSearch = await restarted.search("禁烟", {
    filters: { user_id: "owner-compat", product_memory_id: "memory-main" },
    topK: 10,
    threshold: 0,
  });
  assert(afterDeleteSearch.results.length === 0, "MEM0_DELETED_RECORD_SEARCHABLE");

  await Promise.all(concurrentProviderIds.map((id) => restarted.delete(id)));
  const deletedConcurrent = await restarted.getAll({ filters: { user_id: "owner-compat" } });
  assert(
    deletedConcurrent.results.every(
      ({ metadata }) => !String(metadata?.product_memory_id ?? "").startsWith("memory-concurrent-"),
    ),
    "MEM0_CONCURRENT_DELETE_FAILED",
  );

  const rebuildConfig = configuration(stateRoot, provider.baseUrl, "rebuild");
  assertExplicitConfiguration(rebuildConfig, stateRoot);
  const rebuild = new Memory(rebuildConfig);
  const rebuildProducts = [
    { ...productRecord, productMemoryId: "memory-rebuild-a", content: "重建事实 A" },
    { ...productRecord, productMemoryId: "memory-rebuild-b", content: "重建事实 B" },
  ];
  const rebuiltLinks = await Promise.all(
    rebuildProducts.map(async (record) => ({
      productMemoryId: record.productMemoryId,
      providerId: await addProjection(rebuild, record),
    })),
  );
  for (const link of rebuiltLinks) {
    const item = await rebuild.get(link.providerId);
    assert(
      item?.metadata?.product_memory_id === link.productMemoryId,
      "MEM0_REBUILD_MAPPING_FAILED",
    );
  }

  const files = await listFiles(stateRoot);
  const allowedSuffixes = [".sqlite", ".sqlite-shm", ".sqlite-wal", ".json"];
  assert(
    files.every((file) => allowedSuffixes.some((suffix) => file.endsWith(suffix))),
    "MEM0_UNDECLARED_FILE",
  );
  assert(provider.calls.length > 0, "MEM0_PROVIDER_NOT_EXERCISED");
  assert(socketAttempts.length > 0, "MEM0_SOCKET_MONITOR_NOT_EXERCISED");
  assert(
    socketAttempts.every(
      ({ host, port }) =>
        ["127.0.0.1", "localhost", "::1"].includes(host) && port === provider.port,
    ),
    "MEM0_NETWORK_ESCAPE",
  );
  const resourcesAfter = process.getActiveResourcesInfo?.() ?? [];
  assert(!resourcesAfter.includes("ChildProcess"), "MEM0_UNDECLARED_CHILD_PROCESS");

  result = {
    schemaVersion: 1,
    mem0Version: MEM0_VERSION,
    platform: platformLabel,
    runtime: `${process.platform}-${process.arch} ${process.version}`,
    providers: {
      llm: "openai-compatible/deterministic-extraction-v1@loopback",
      embedder: `openai-compatible/deterministic-embedding-v1@loopback/${DIMENSION}`,
      vectorStore: "memory/sqlite-explicit-path",
      historyStore: "sqlite-explicit-path",
      customInstructionsSha256: createHash("sha256").update(CUSTOM_INSTRUCTIONS).digest("hex"),
    },
    conformance: {
      add: true,
      search: true,
      update: true,
      delete: true,
      history: true,
      filterAndMetadata: true,
      providerIdRoundTrip: true,
      restartPersistence: true,
      concurrentAccess: true,
      correction: true,
      deletion: true,
      productProjectionRebuild: true,
    },
    upstreamRisk: {
      partialEmbeddingFailureObserved: true,
      behavior: "batch fallback can silently keep only successfully embedded items",
      requiredProductBoundary:
        "project exactly one product Memory per Mem0 add and verify one returned provider ID",
    },
    monitoring: {
      telemetryDisabledBeforeImport: process.env.MEM0_TELEMETRY === "false",
      fetchAttempts: fetchAttempts.length,
      socketAttempts: socketAttempts.length,
      undeclaredNetworkAttempts: 0,
      providerCalls: provider.calls.length,
      stateFiles: files,
      childProcesses: 0,
      activeResourcesBefore: resourcesBefore,
      activeResourcesAfter: resourcesAfter,
    },
    rebuiltLinks,
  };
} finally {
  globalThis.fetch = originalFetch;
  net.Socket.prototype.connect = originalSocketConnect;
  await provider.close();
}

const stateInfo = await stat(stateRoot);
assert(stateInfo.isDirectory(), "MEM0_STATE_ROOT_DISAPPEARED");
process.stdout.write(`${JSON.stringify(result)}\n`);
