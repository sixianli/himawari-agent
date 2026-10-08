import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { release } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const generationModel = "deepseek/deepseek-v4.1-flash";
const embeddingModel = "alibaba/qwen3-embedding-8b";
const embeddingDimensions = 4096;
const codingTools = ["read", "write", "edit", "ls", "bash"];

function textOf(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((entry) => (entry && typeof entry.text === "string" ? entry.text : "")).join("");
}

function absolutePath(value, field) {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value)
    throw new Error(`R2_L6_${field}_PATH_INVALID`);
  return value;
}

async function loadInstalledPackage(runtimeRoot, name) {
  return import(pathToFileURL(path.join(runtimeRoot, "node_modules", name, "dist/index.js")).href);
}

function localModelURL(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/v1" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("R2_L6_LOOPBACK_MODEL_REQUIRED");
  return url.href;
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function sendSse(response, chunks) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

export async function startLocalModelServer({ modelScript, maximumBodyBytes = 256 * 1024 }) {
  if (typeof modelScript !== "function") throw new Error("R2_L6_MODEL_SCRIPT_REQUIRED");
  if (!Number.isSafeInteger(maximumBodyBytes) || maximumBodyBytes < 1)
    throw new Error("R2_L6_MODEL_BODY_LIMIT_INVALID");
  const requests = [];
  const server = createServer((request, response) => {
    if (
      request.method !== "POST" ||
      !["/v1/embeddings", "/v1/chat/completions"].includes(request.url)
    ) {
      request.resume();
      sendJson(response, 404, { error: { code: "R2_L6_MODEL_ROUTE_INVALID" } });
      return;
    }
    const chunks = [];
    let byteLength = 0;
    let refused = false;
    request.on("data", (chunk) => {
      if (refused) return;
      byteLength += chunk.length;
      if (byteLength > maximumBodyBytes) {
        refused = true;
        chunks.length = 0;
        sendJson(response, 413, { error: { code: "R2_L6_MODEL_BODY_LIMIT" } });
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", () => {
      if (!response.writableEnded) response.destroy();
    });
    request.on("end", () => {
      if (refused) return;
      const answer = async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new Error("R2_L6_MODEL_BODY_INVALID");
        const requestNumber = requests.length + 1;
        const observed = { requestNumber, path: request.url, model: body.model, body };
        requests.push(observed);
        if (request.url === "/v1/embeddings") {
          if (body.model !== embeddingModel || body.dimensions !== embeddingDimensions)
            throw new Error("R2_L6_EMBEDDING_MODEL_INVALID");
          observed.kind = "embedding";
          sendJson(response, 200, {
            object: "list",
            model: body.model,
            data: [
              { object: "embedding", index: 0, embedding: Array(embeddingDimensions).fill(0.1) },
            ],
            usage: { prompt_tokens: 8, total_tokens: 8 },
            providerMetadata: {
              gateway: {
                generationId: `embedding-${requestNumber}`,
                routing: { finalProvider: "deepinfra" },
                cost: "0",
              },
            },
          });
          return;
        }
        if (body.model !== generationModel) throw new Error("R2_L6_GENERATION_MODEL_INVALID");
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const lastUser = [...messages].reverse().find((message) => message?.role === "user");
        const lastUserIndex = lastUser ? messages.lastIndexOf(lastUser) : -1;
        const context = {
          lastUserText: textOf(lastUser?.content),
          toolResults: messages
            .slice(lastUserIndex + 1)
            .filter((message) => message?.role === "tool")
            .map((message) => textOf(message.content)),
          hasTools: Array.isArray(body.tools) && body.tools.length > 0,
          body,
          requestNumber,
        };
        observed.lastUserText = context.lastUserText;
        observed.hasTools = context.hasTools;
        observed.toolResultCount = context.toolResults.length;
        const reply = await modelScript(context);
        if (
          !reply ||
          (reply.kind !== "tool" && reply.kind !== "text") ||
          (reply.kind === "text" && typeof reply.text !== "string") ||
          (reply.kind === "tool" &&
            (reply.name !== "bash" ||
              !reply.arguments ||
              typeof reply.arguments !== "object" ||
              Array.isArray(reply.arguments) ||
              typeof reply.arguments.command !== "string" ||
              !context.hasTools))
        )
          throw new Error("R2_L6_MODEL_REPLY_INVALID");
        observed.kind = reply.kind;
        const base = {
          id: `completion-${requestNumber}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model,
        };
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0 };
        const provider_metadata = {
          gateway: {
            generationId: `generation-${requestNumber}`,
            routing: { finalProvider: "morph" },
            cost: "0",
          },
        };
        const tool_calls =
          reply.kind === "tool"
            ? [
                {
                  index: 0,
                  id: `call-${requestNumber}`,
                  type: "function",
                  function: { name: reply.name, arguments: JSON.stringify(reply.arguments) },
                },
              ]
            : undefined;
        const finish_reason = reply.kind === "tool" ? "tool_calls" : "stop";
        if (body.stream !== true) {
          sendJson(response, 200, {
            ...base,
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: reply.kind === "text" ? reply.text : null,
                  ...(tool_calls ? { tool_calls } : {}),
                  provider_metadata,
                },
                finish_reason,
              },
            ],
            usage,
          });
          return;
        }
        sendSse(response, [
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  ...(tool_calls ? { tool_calls } : { content: reply.text }),
                },
                finish_reason: null,
              },
            ],
          },
          {
            ...base,
            choices: [{ index: 0, delta: { provider_metadata }, finish_reason }],
            usage,
          },
        ]);
      };
      void answer().catch((error) => {
        if (!response.writableEnded && !response.headersSent)
          sendJson(response, 400, { error: { code: "R2_L6_MODEL_REQUEST_INVALID" } });
        else if (!response.writableEnded) response.destroy();
        requests.push({
          path: request.url,
          kind: "invalid",
          reasonCode: error?.message ?? "unknown",
        });
      });
    });
  });
  await new Promise((resolve, reject) => {
    const failed = (error) => reject(error);
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", failed);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("R2_L6_MODEL_LISTEN_INVALID");
  return {
    modelURL: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

export async function runInstalledAgent({
  runtimeRoot,
  secretDirectory,
  modelURL,
  serviceArgs,
  output = process.stdout,
  errorOutput = process.stderr,
}) {
  if (process.platform !== "linux") throw new Error("R2_L6_LINUX_REQUIRED");
  const root = await realpath(absolutePath(runtimeRoot, "RUNTIME"));
  const providerUrl = localModelURL(modelURL);
  absolutePath(secretDirectory, "SECRET_DIRECTORY");
  if (!Array.isArray(serviceArgs)) throw new Error("R2_L6_SERVICE_ARGUMENTS_REQUIRED");
  process.env.MEM0_TELEMETRY = "false";
  process.env.MEM0_TELEMETRY_SAMPLE_RATE = "0";
  const [agent, platform] = await Promise.all([
    loadInstalledPackage(root, "@himawari-agent/agent-service"),
    loadInstalledPackage(root, "@himawari-agent/platform-node"),
  ]);
  const sources = {
    provider: new platform.RestrictedProviderSecretSource(secretDirectory),
    keys: new platform.RestrictedSecretFileSource(secretDirectory),
  };
  return agent.runAgentService(serviceArgs, output, errorOutput, {
    secretSources: sources,
    modelCompositionFactory: async ({ configuration, repository, admission }) => {
      const clock = { now: () => new Date().toISOString() };
      const ids = { next: (scope) => `${scope}:${randomUUID()}` };
      const handles = new platform.EphemeralSecretPort({ clock, ids });
      const descriptors = agent.resolveConfiguredModelDescriptorSet(configuration);
      const payloadKeys = configuration.secretReferences.filter(
        (entry) => entry.purpose === "payload-encryption",
      );
      if (payloadKeys.length !== 1) throw new Error("R2_L6_PAYLOAD_KEY_REQUIRED");
      const payloadKey = payloadKeys[0];
      const composition = agent.createProductionModelComposition({
        ownerId: configuration.ownerId,
        agentId: configuration.agentId,
        descriptors: descriptors.generation.map((model) => ({ ...model, baseUrl: providerUrl })),
        handles,
        secretSource: sources.provider,
        payloads: repository.payloadStore(configuration.ownerId, configuration.agentId),
        protector: new platform.EnvelopePayloadProtector({
          keys: sources.keys,
          activeKey: {
            keyRef: payloadKey.ref,
            kekVersion: payloadKey.version,
            dekVersion: "dek-v1",
          },
        }),
        ids,
        clock,
        requestTimeoutMs: configuration.deadlines.providerRequestMs,
        ...(admission === undefined ? {} : { admission }),
      });
      return {
        descriptors,
        handles,
        secretSource: sources.provider,
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
      const { Memory, VectorStoreFactory } = await import(
        pathToFileURL(path.join(root, "node_modules/mem0ai/dist/oss/index.mjs")).href
      );
      return agent.createProductionMemoryCompositionFromConfiguration({
        configuration,
        secretSource: sources.provider,
        load: async () => ({
          VectorStoreFactory,
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
}

export async function writeNonproductionCodingSnapshot({
  snapshotPath,
  runtimeRoot,
  workspace,
  jobsRoot,
  protectedPaths,
  hostId,
  workerInstanceId,
  ownerId,
}) {
  if (process.platform !== "linux") throw new Error("R2_L6_LINUX_REQUIRED");
  absolutePath(snapshotPath, "SNAPSHOT");
  const root = await realpath(absolutePath(runtimeRoot, "RUNTIME"));
  const workspacePath = absolutePath(workspace, "WORKSPACE");
  const privateRoot = absolutePath(jobsRoot, "JOBS");
  if (
    (await realpath(workspacePath)) !== workspacePath ||
    (await realpath(privateRoot)) !== privateRoot
  )
    throw new Error("R2_L6_CANONICAL_DIRECTORIES_REQUIRED");
  if (Buffer.byteLength(privateRoot) > 27) throw new Error("R2_L6_PRIVATE_ROOT_TOO_LONG");
  if (!Array.isArray(protectedPaths)) throw new Error("R2_L6_PROTECTED_PATHS_REQUIRED");
  for (const entry of protectedPaths) absolutePath(entry, "PROTECTED");
  for (const [field, value] of Object.entries({ hostId, workerInstanceId, ownerId })) {
    if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
      throw new Error(`R2_L6_${field}_INVALID`);
  }
  const bash = path.join(root, "pi-tools/bin/bash");
  const bashMetadata = await lstat(bash).catch(() => undefined);
  if (
    !bashMetadata?.isFile() ||
    bashMetadata.isSymbolicLink() ||
    !(bashMetadata.mode & 0o111) ||
    (await realpath(bash)) !== bash
  )
    throw new Error("R2_L6_INSTALLED_BASH_REQUIRED_BEFORE_DIGEST");
  const fileHash = async (filename) =>
    createHash("sha256")
      .update(await readFile(filename))
      .digest("hex");
  const platform = await loadInstalledPackage(root, "@himawari-agent/platform-node");
  const executable = await realpath(process.execPath);
  const runner = path.join(
    root,
    "node_modules/@himawari-agent/agent-service/dist/capability-programs/pi-coding-main.js",
  );
  const runnerDigest = await fileHash(runner);
  const runtimeDigest = await platform.digestSandboxRuntime(root);
  const metadata = await stat(workspacePath);
  const now = new Date().toISOString();
  const artifactDigest = `sha256:${runnerDigest}`;
  const supportedExecutions = [{ schemaVersion: "sandbox-execution.v2", mode: "foreground" }];
  const binding = {
    schemaVersion: "sandbox-host-binding.v1",
    capabilityRef: "himawari.pi-coding",
    capabilityVersion: "1.0.0",
    artifactDigest,
    hostId,
    profileRef: "authorized-project.v1",
    runtimeRoot: root,
    runtimeDigest,
    executable: { path: executable, sha256: await fileHash(executable) },
    runner: { path: runner, sha256: runnerDigest },
    privateRoot,
    roots: [
      {
        canonicalRootId: `${metadata.dev}:${metadata.ino}`,
        canonicalPath: workspacePath,
        device: String(metadata.dev),
        inode: String(metadata.ino),
      },
    ],
    readOnlyToolchainPaths: [
      ...new Set(
        await Promise.all(
          [
            root,
            executable,
            "/bin",
            "/usr/bin",
            "/usr/lib",
            "/lib",
            "/lib64",
            "/proc",
            "/etc/ssl",
            "/etc/hosts",
            "/dev",
          ].map((entry) => realpath(entry)),
        ),
      ),
    ],
    protectedPaths: [...protectedPaths],
    allowedDomains: [],
    maximumResourceCeiling: {
      maxWallTimeMs: 300_000,
      maxCpuTimeMs: 30_000,
      maxMemoryBytes: 536_870_912,
      maxOutputBytes: 524_288,
      maxProgressEvents: 256,
    },
    supportedExecutions,
    operationBindings: codingTools.map((operation) => ({
      operation,
      mode: "foreground",
      contract: {
        ref: "pi-coding-tool",
        version: "1",
        kind:
          operation === "bash"
            ? "command"
            : ["write", "edit"].includes(operation)
              ? "verified_effect"
              : "fixed_read",
        ...(["write", "edit"].includes(operation)
          ? { verifierRef: "pi-atomic-write", verifierVersion: "1", targetRef: "pi-input:path" }
          : {}),
      },
      backendRef: "srt",
      scopeSource: "grant_targets",
      directoryOperations:
        operation === "write"
          ? ["read", "create", "update"]
          : operation === "edit"
            ? ["read", "update"]
            : ["read"],
      network: "disabled",
    })),
  };
  const evidenceDigest = createHash("sha256")
    .update("product-path-test-qualification-not-production")
    .digest("hex");
  const sandbox = {
    schemaVersion: "sandbox-runtime-qualification.v1",
    qualificationRef: `product-path:${evidenceDigest}`,
    hostId,
    profileRef: binding.profileRef,
    srtVersion: "0.0.75",
    platform: process.platform,
    architecture: process.arch,
    osRelease: release(),
    runtimeDigest,
    runnerDigest,
    evidenceDigest,
    resourceMode: "observe_and_stop",
    terminationMode: "verified_tree",
    guarantees: [
      "filesystem_default_deny",
      "network_allowlist",
      "clean_environment",
      "bounded_output",
      "wall_clock_stop",
      "resource_observation",
      "durable_start_admission",
      "unknown_quarantine",
      "restart_reconciliation",
      "task_tree_termination",
      "worker_crash_cleanup",
    ],
    limitations: [],
    supportedExecutions,
  };
  const manifest = {
    manifestVersion: "capability.v2",
    ref: binding.capabilityRef,
    displayName: "产品路径测试 Pi 文件工具",
    version: binding.capabilityVersion,
    source: { type: "program", locator: "artifact:product-path-pi" },
    sourceIdentity: `host:${hostId}`,
    integrity: artifactDigest,
    artifact: {
      digest: artifactDigest,
      signatureStatus: "verified",
      signerRef: `test-signer:${evidenceDigest}`,
      rollbackArtifactRef: null,
    },
    operations: [...codingTools],
    permissionRefs: [],
    isolation: "sandbox",
    scopes: {
      dataClassifications: ["public", "private"],
      network: [],
      filesystem: ["workspace:product-path"],
      secrets: [],
    },
    cost: { currency: "USD", maxMicrosPerInvocation: 0 },
    health: { status: "healthy", checkedAt: now },
    reviewedBy: ownerId,
    reviewedAt: now,
    contractCompatibility: ["capability-conformance.v1"],
    runtime: {
      kind: "program",
      argv: [executable, runner, hostId, workerInstanceId],
      environmentKeys: [],
      workdirRef: "workspace:product-path",
      stdin: "protected_payload",
      stdout: "protected_payload",
      subprocesses: [],
      network: [],
      filesystem: ["workspace:product-path"],
    },
  };
  const snapshot = {
    schemaVersion: "capability-deployment.v1",
    capabilities: [
      {
        manifest,
        binding: { kind: "sandbox", value: binding },
        qualification: {
          qualificationVersion: "capability-runtime-qualification.v1",
          platform: process.platform,
          runtimeIdentity: "srt:0.0.75",
          productionSuitable: true,
          artifactDigest,
          enforcement: {
            filesystem: true,
            network: true,
            processes: true,
            secrets: true,
            resourceCeilings: false,
            termination: true,
          },
          reasonCodes: [],
          checkedAt: now,
          sandbox,
        },
      },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  await writeFile(snapshotPath, bytes, { mode: 0o600, flag: "wx" });
  return {
    snapshotPath,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    binding,
    snapshot,
    evidenceDigest,
    nonproduction: true,
    bash: { path: bash, sha256: await fileHash(bash) },
  };
}
