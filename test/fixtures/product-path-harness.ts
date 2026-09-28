import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import { release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentId, createDeploymentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import {
  digestSandboxRuntime,
  initializeStateRoot,
  writeAuthorityFile,
} from "@himawari-agent/platform-node";
import { exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const publicHost = "agent.example.test";
export const publicOrigin = `https://${publicHost}`;
const ownerId = "owner-product-path";
const agentId = "agent-product-path";
const deploymentId = "deployment-product-path";
const hostId = "product-path-host";
const workerInstanceId = `execution-worker:${deploymentId}`;
const grantId = "directory:product-path-workspace";
const authority = { deploymentId, authorityEpoch: 1, fencingToken: 1 };
const audience = "access-audience-product-path";
const subject = "subject-product-path";
const bootstrapToken = "bootstrap-token-product-path";
const codingTools = ["read", "write", "edit", "ls"] as const;

export type ModelRequest = {
  readonly path: string;
  readonly model: string | undefined;
  readonly body: Record<string, unknown>;
};

export type ModelReply =
  | { readonly kind: "text"; readonly text: string; readonly delayMs?: number }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    }
  | { readonly kind: "http-error"; readonly status: number }
  | { readonly kind: "drop" };

export type ModelScript = (request: {
  readonly lastUserText: string;
  readonly toolResults: readonly string[];
  readonly hasTools: boolean;
}) => ModelReply;

function runOpenSsl(arguments_: readonly string[]): void {
  const result = spawnSync("openssl", arguments_, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`openssl failed: ${result.stderr || result.stdout}`);
}

async function createCertificates(root: string) {
  const ca = { key: path.join(root, "ca-key.pem"), cert: path.join(root, "ca.pem") };
  runOpenSsl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    ca.key,
    "-out",
    ca.cert,
    "-days",
    "1",
    "-subj",
    "/CN=Himawari product path test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  const leaf = (name: string, altName: string) => {
    const key = path.join(root, `${name}-key.pem`);
    const csr = path.join(root, `${name}.csr`);
    const cert = path.join(root, `${name}.pem`);
    const extensions = path.join(root, `${name}.ext`);
    runOpenSsl([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      csr,
      "-subj",
      `/CN=${name}`,
    ]);
    return { key, csr, cert, extensions, altName };
  };
  const provider = leaf("provider", "IP:127.0.0.1");
  const front = leaf("front", `DNS:${publicHost}`);
  for (const item of [provider, front]) {
    await writeFile(
      item.extensions,
      `subjectAltName=${item.altName}\nextendedKeyUsage=serverAuth\n`,
    );
    runOpenSsl([
      "x509",
      "-req",
      "-in",
      item.csr,
      "-CA",
      ca.cert,
      "-CAkey",
      ca.key,
      "-CAcreateserial",
      "-out",
      item.cert,
      "-days",
      "1",
      "-sha256",
      "-extfile",
      item.extensions,
    ]);
    await chmod(item.key, 0o600);
  }
  await chmod(ca.key, 0o600);
  return { ca: ca.cert, provider, front };
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("PORT_UNAVAILABLE");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function listen(server: HttpsServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("PORT_UNAVAILABLE");
  return address.port;
}

async function close(server: HttpsServer | undefined): Promise<void> {
  if (!server?.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
  return "";
}

function sse(response: import("node:http").ServerResponse, chunks: readonly object[]): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 180_000 });
  if (result.status !== 0)
    throw new Error(
      `${path.basename(command)} ${args[0] ?? ""} failed: ${result.stderr || result.stdout || result.error?.message}`,
    );
  return result.stdout;
}

export interface ProductPathInstallation {
  readonly origin: string;
  readonly frontPort: number;
  readonly workspace: string;
  readonly stateRoot: string;
  readonly databasePath: string;
  readonly logDirectory: string;
  readonly modelRequests: ModelRequest[];
  setModelScript(script: ModelScript): void;
  setEmbeddingAvailable(available: boolean): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  crash(): Promise<void>;
  armDeliveryCrash(): Promise<void>;
  deliveryCrashEntered(): Promise<{ jobId: string; runId: string } | null>;
  running(): boolean;
  close(): Promise<void>;
}

export async function installProductPath(options: {
  readonly artifact: string;
  readonly context: string;
  readonly logDirectory: string;
}): Promise<ProductPathInstallation> {
  const testRoot = await realpath(await mkdtemp("/tmp/hma-pp-"));
  const stateRoot = path.join(testRoot, "state");
  const runtimePrefix = path.join(testRoot, "prefix");
  const staticRoot = path.join(testRoot, "browser");
  const secretDirectory = path.join(testRoot, "secrets");
  const workspace = path.join(testRoot, "workspace");
  const jobsRoot = path.join(testRoot, "jobs");
  const configurationPath = path.join(testRoot, "configuration.json");
  await mkdir(options.logDirectory, { recursive: true });
  for (const directory of [stateRoot, secretDirectory, workspace, jobsRoot, staticRoot])
    await mkdir(directory, { recursive: true, mode: 0o700 });
  const certificates = await createCertificates(testRoot);
  const keyPair = await generateKeyPair("RS256", { extractable: true });
  const jwks: JSONWebKeySet = {
    keys: [{ ...(await exportJWK(keyPair.publicKey)), kid: "product-path-key", alg: "RS256" }],
  };

  let modelScript: ModelScript = () => ({ kind: "text", text: "默认回答" });
  let embeddingAvailable = true;
  const modelRequests: ModelRequest[] = [];
  let providerPort = 0;
  const issuer = () => `https://127.0.0.1:${providerPort}`;
  const provider = createHttpsServer(
    {
      cert: await readFile(certificates.provider.cert),
      key: await readFile(certificates.provider.key),
    },
    (request, response) => {
      const requestPath = request.url ?? "/";
      if (requestPath === "/cdn-cgi/access/certs") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(jwks));
        return;
      }
      if (requestPath === "/cdn-cgi/access/get-identity") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ user_uuid: subject, iat: Math.floor(Date.now() / 1000) }));
        return;
      }
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        modelRequests.push({
          path: requestPath,
          model: typeof body["model"] === "string" ? body["model"] : undefined,
          body,
        });
        if (requestPath === "/v1/embeddings") {
          if (!embeddingAvailable) {
            request.socket.destroy();
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              object: "list",
              model: body["model"],
              data: [
                {
                  object: "embedding",
                  index: 0,
                  embedding: Array(Number(body["dimensions"]) || 16).fill(0.1),
                },
              ],
              usage: { prompt_tokens: 8, total_tokens: 8 },
            }),
          );
          return;
        }
        if (requestPath !== "/v1/chat/completions") {
          response.writeHead(404);
          response.end();
          return;
        }
        const messages = Array.isArray(body["messages"])
          ? (body["messages"] as Array<{ role?: string; content?: unknown }>)
          : [];
        const lastUser = [...messages].reverse().find((message) => message.role === "user");
        const lastUserIndex = lastUser ? messages.lastIndexOf(lastUser) : -1;
        const reply = modelScript({
          lastUserText: textOf(lastUser?.content),
          toolResults: messages
            .slice(lastUserIndex + 1)
            .filter((message) => message.role === "tool")
            .map((message) => textOf(message.content)),
          hasTools: Array.isArray(body["tools"]) && body["tools"].length > 0,
        });
        const base = {
          id: `completion-${modelRequests.length}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body["model"],
        };
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0 };
        const openrouter_metadata = {
          attempts: [{ provider: "ProductPathProvider", model: body["model"], status: 200 }],
        };
        if (reply.kind === "drop") {
          request.socket.destroy();
          return;
        }
        if (reply.kind === "http-error") {
          response.writeHead(reply.status, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: { message: "scripted failure", code: reply.status } }),
          );
          return;
        }
        if (reply.kind === "tool") {
          sse(response, [
            {
              ...base,
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: `call-${modelRequests.length}`,
                        type: "function",
                        function: { name: reply.name, arguments: JSON.stringify(reply.arguments) },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
              usage,
              openrouter_metadata,
            },
          ]);
          return;
        }
        const finish = () =>
          sse(response, [
            {
              ...base,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: reply.text },
                  finish_reason: null,
                },
              ],
            },
            {
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              usage,
              openrouter_metadata,
            },
          ]);
        if (reply.delayMs) setTimeout(finish, reply.delayMs);
        else finish();
      });
    },
  );
  providerPort = await listen(provider);

  const signAssertion = () => {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "product-path-key" })
      .setIssuer(issuer())
      .setAudience(audience)
      .setSubject(subject)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(keyPair.privateKey);
  };

  const appPort = await reservePort();
  const front = createHttpsServer(
    { cert: await readFile(certificates.front.cert), key: await readFile(certificates.front.key) },
    (request, response) => {
      void signAssertion().then((assertion) => {
        const upstream = requestHttp(
          {
            host: "127.0.0.1",
            port: appPort,
            method: request.method,
            path: request.url,
            headers: { ...request.headers, "cf-access-jwt-assertion": assertion },
          },
          (answer) => {
            response.writeHead(answer.statusCode ?? 502, answer.headers);
            answer.on("close", () => {
              if (!answer.complete) response.destroy();
            });
            answer.pipe(response);
          },
        );
        upstream.on("error", () => {
          if (!response.headersSent) response.writeHead(502);
          response.end();
        });
        response.on("close", () => upstream.destroy());
        request.pipe(upstream);
      });
    },
  );
  const frontPort = await listen(front);

  const installEnv = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" };
  run(
    process.execPath,
    [
      path.join(repositoryRoot, "scripts/install-node-runtime.mjs"),
      "--prefix",
      runtimePrefix,
      "--artifact",
      options.artifact,
      "--context",
      options.context,
    ],
    installEnv,
    testRoot,
  );
  run("tar", ["-xzf", options.artifact, "-C", testRoot, "browser"], installEnv, testRoot);
  const runtimeRoot = path.join(runtimePrefix, "lib/himawari-agent");

  const layout = await initializeStateRoot(stateRoot);
  const databasePath = path.join(layout.data, "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(ownerId);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(agentId, ownerId);
  database
    .prepare(
      "INSERT INTO deployments (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token) VALUES (?, ?, ?, 0, 'active', ?, ?)",
    )
    .run(deploymentId, ownerId, agentId, authority.authorityEpoch, authority.fencingToken);
  database.close();
  await writeAuthorityFile(layout, {
    ownerId: createOwnerId(ownerId),
    agentId: createAgentId(agentId),
    id: createDeploymentId(deploymentId),
    revision: 0,
    status: "active",
    authorityEpoch: authority.authorityEpoch,
    fencingToken: authority.fencingToken,
    transferId: null,
  });
  const tokenPath = path.join(layout.runtime, "worker-token.json");
  await writeFile(
    tokenPath,
    JSON.stringify({
      tokenRef: "worker-process-token",
      tokenValue: "0123456789abcdef0123456789abcdef",
    }),
    { mode: 0o600 },
  );
  for (const [name, value] of [
    ["payload-kek.v1", "22".repeat(32)],
    ["identity-csrf.v1", "11".repeat(32)],
    ["identity-bootstrap.v1", bootstrapToken],
    ["openrouter-api-key.v1", "local-provider-fixture"],
  ] as const)
    await writeFile(path.join(secretDirectory, name), value, { mode: 0o600 });

  const snapshotPath = path.join(testRoot, "capability-deployment.json");
  const qualifyCapabilities = () =>
    writeCodingSnapshot({
      snapshotPath,
      runtimeRoot,
      workspace,
      jobsRoot,
      protectedPaths: [stateRoot, path.join(workspace, ".env")],
    });
  const capabilityDeployment = await qualifyCapabilities();

  const model = (role: string, ref: string, priority: number) => ({
    ref,
    role,
    provider: "openrouter",
    model: `product-path-${role}`,
    version: "v1",
    allowedDataClassifications: role === "fallback" ? ["private"] : ["public", "private"],
    disclosure: "trusted_remote",
    secretRef: "openrouter-api-key",
    capabilities: ["text", "tools"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    priority,
    name: `Product path ${role}`,
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 2048,
  });
  const configuration = {
    schemaVersion: "himawari.configuration.v1",
    deploymentId,
    ownerId,
    agentId,
    stateRoot,
    runtimeDirectory: layout.runtime,
    cacheDirectory: path.join(stateRoot, "cache"),
    publicOrigin,
    publicMode: true,
    http: {
      listenHost: "127.0.0.1",
      listenPort: appPort,
      staticRoot,
      sessionCookieName: "himawari_session",
      maximumBodyBytes: 256 * 1024,
      maximumStaticAssetBytes: 8 * 1024 * 1024,
      heartbeatMilliseconds: 5_000,
    },
    identity: {
      issuer: issuer(),
      audience,
      jwksUrl: `${issuer()}/cdn-cgi/access/certs`,
      jwksCacheMilliseconds: 300_000,
      jwksTimeoutMilliseconds: 2_000,
      jwksMaximumBodyBytes: 65_536,
      clockToleranceSeconds: 30,
      identityLookupTimeoutMilliseconds: 2_000,
      identityLookupMaximumBodyBytes: 65_536,
      recentAuthentication: { maximumAgeMilliseconds: 900_000, clockSkewMilliseconds: 30_000 },
      bootstrap: {
        enabled: true,
        expiresAt: "2099-01-01T00:00:00.000Z",
        tokenSecretRef: "identity-bootstrap",
      },
      csrf: { keySecretRef: "identity-csrf", ttlMilliseconds: 1_800_000 },
    },
    modelDescriptors: [
      model("primary", "model-primary", 1),
      model("fallback", "model-fallback", 2),
      {
        ref: "model-embedding",
        role: "embedding",
        provider: "openrouter",
        model: "product-path-embedding",
        version: "v1",
        allowedDataClassifications: ["public", "private", "sensitive", "restricted"],
        disclosure: "trusted_remote",
        secretRef: "openrouter-api-key",
        capabilities: ["embedding"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        dimensions: 16,
      },
    ],
    memory: {
      adapter: "mem0-oss",
      version: "3.1.7",
      storagePath: path.join(stateRoot, "data", "memory"),
      dimensions: 16,
    },
    repositoryAllowlistRefs: [],
    secretReferences: [
      { ref: "payload-kek", version: "v1", purpose: "payload-encryption", scope: "agent" },
      { ref: "identity-bootstrap", version: "v1", purpose: "identity-bootstrap", scope: "agent" },
      { ref: "identity-csrf", version: "v1", purpose: "identity-csrf", scope: "agent" },
      { ref: "openrouter-api-key", version: "v1", purpose: "model-provider-auth", scope: "agent" },
      {
        ref: "worker-process-token",
        version: "v1",
        purpose: "worker-auth",
        scope: "local-services",
      },
    ],
    budgets: {
      globalCostMicros: 1_000_000,
      perRunCostMicros: 100_000,
      perClassificationCostMicros: {
        public: 100_000,
        private: 100_000,
        sensitive: 0,
        restricted: 0,
      },
    },
    concurrency: { totalRuns: 4, foregroundReserved: 1, perCategory: { foreground: 2 } },
    deadlines: { runMs: 900_000, workerRequestMs: 300_000, providerRequestMs: 120_000 },
    capabilityDeployment,
    runPolicy: {
      version: "product-path-v1",
      systemInstruction: "请用中文回答。文件工具使用工作目录内的相对路径。",
      memoryLimit: 5,
      maxSelectedMemories: 0,
      maxMemoryClassification: "private",
      coding: {
        hostId,
        workerInstanceId,
        grantId,
        capabilityRef: "himawari.pi-coding",
        capabilityVersion: "1.0.0",
        maximumBytes: 49152,
        enabledTools: [...codingTools],
      },
      timeZone: "Asia/Tokyo",
    },
  };
  await writeFile(configurationPath, JSON.stringify(configuration), { mode: 0o600 });

  const cli = path.join(runtimePrefix, "bin/himawari");
  run(
    cli,
    [
      "capabilities",
      "register",
      "--config",
      configurationPath,
      "--confirm",
      capabilityDeployment.sha256,
    ],
    installEnv,
    testRoot,
  );
  run(
    cli,
    [
      "workspace",
      "grant",
      "--config",
      configurationPath,
      "--directory",
      workspace,
      "--host-id",
      hostId,
      "--id",
      grantId,
      "--expires-at",
      new Date(Date.now() + 86_400_000).toISOString(),
      "--confirm",
      workspace,
    ],
    installEnv,
    testRoot,
  );

  const serviceEnv = {
    ...process.env,
    NODE_PATH: "",
    NODE_OPTIONS: "",
    NODE_EXTRA_CA_CERTS: certificates.ca,
    HIMAWARI_TEST_RUNTIME_ROOT: runtimeRoot,
    HIMAWARI_TEST_CONFIGURATION: configurationPath,
    HIMAWARI_TEST_SECRET_DIRECTORY: secretDirectory,
    HIMAWARI_TEST_DELIVERY_CRASH: path.join(testRoot, "delivery-crash"),
    HIMAWARI_TEST_MODEL_URL: `https://127.0.0.1:${providerPort}/v1`,
  };
  const serviceArgs = [
    "--config",
    configurationPath,
    "--worker-token-file",
    tokenPath,
    "--profile",
    "production",
  ];
  let processes:
    | { main: ChildProcessWithoutNullStreams; worker: ChildProcessWithoutNullStreams }
    | undefined;
  let generation = 0;
  const alive = (child: ChildProcessWithoutNullStreams) =>
    child.exitCode === null && child.signalCode === null;
  const exited = (child: ChildProcessWithoutNullStreams, timeoutMs: number) =>
    alive(child)
      ? new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), timeoutMs);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve(true);
          });
        })
      : Promise.resolve(true);
  const terminate = async (child: ChildProcessWithoutNullStreams) => {
    if (!alive(child)) return;
    child.kill("SIGTERM");
    if (!(await exited(child, 15_000))) {
      child.kill("SIGKILL");
      await exited(child, 5_000);
    }
  };
  const logTo = async (name: string, child: ChildProcessWithoutNullStreams) => {
    const file = path.join(options.logDirectory, `${name}-${generation}.log`);
    const { createWriteStream } = await import("node:fs");
    const stream = createWriteStream(file, { flags: "a" });
    child.stdout.pipe(stream);
    child.stderr.pipe(stream);
  };

  let bootstrapped = false;
  const start = async () => {
    if (processes) throw new Error("PRODUCT_PATH_ALREADY_RUNNING");
    if (generation > 0) {
      configuration.capabilityDeployment = await qualifyCapabilities();
      await writeFile(configurationPath, JSON.stringify(configuration), { mode: 0o600 });
    }
    generation += 1;
    const main = spawn(
      process.execPath,
      [
        "--no-global-search-paths",
        path.join(repositoryRoot, "test/fixtures/production-service-main-child.mjs"),
        ...serviceArgs,
      ],
      { cwd: testRoot, stdio: ["pipe", "pipe", "pipe"], env: serviceEnv },
    );
    const worker = spawn(path.join(runtimePrefix, "bin/himawari-execution-worker"), serviceArgs, {
      cwd: testRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: serviceEnv,
    });
    processes = { main, worker };
    await logTo("agent", main);
    await logTo("worker", worker);
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("PRODUCT_PATH_READY_TIMEOUT")), 60_000);
      main.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.includes("HIMAWARI_PRODUCTION_HTTP_READY ")) {
          clearTimeout(timer);
          resolve();
        }
      });
      main.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`PRODUCT_PATH_MAIN_EXITED:${code ?? signal}`));
      });
    });
    if (!bootstrapped) {
      const assertion = await signAssertion();
      const answer = await fetch(`http://127.0.0.1:${appPort}/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: bootstrapToken, ownerId, assertionToken: assertion }),
      });
      if (answer.status !== 201) throw new Error(`PRODUCT_PATH_BOOTSTRAP_FAILED:${answer.status}`);
      bootstrapped = true;
    }
  };
  const stop = async () => {
    const current = processes;
    processes = undefined;
    if (!current) return;
    await terminate(current.main);
    await terminate(current.worker);
  };

  return {
    origin: publicOrigin,
    frontPort,
    workspace,
    stateRoot,
    databasePath,
    logDirectory: options.logDirectory,
    modelRequests,
    setModelScript: (script) => {
      modelScript = script;
    },
    setEmbeddingAvailable: (available) => {
      embeddingAvailable = available;
    },
    start,
    stop,
    crash: async () => {
      const current = processes;
      processes = undefined;
      if (!current) throw new Error("PRODUCT_PATH_NOT_RUNNING");
      current.main.kill("SIGKILL");
      current.worker.kill("SIGKILL");
      if (!(await exited(current.main, 5000)) || !(await exited(current.worker, 5000)))
        throw new Error("PRODUCT_PATH_CRASH_TIMEOUT");
    },
    armDeliveryCrash: async () => {
      await rm(`${serviceEnv.HIMAWARI_TEST_DELIVERY_CRASH}.entered`, { force: true });
      await writeFile(serviceEnv.HIMAWARI_TEST_DELIVERY_CRASH, "armed");
    },
    deliveryCrashEntered: async () =>
      readFile(`${serviceEnv.HIMAWARI_TEST_DELIVERY_CRASH}.entered`, "utf8").then(
        (text) => JSON.parse(text),
        () => null,
      ),
    running: () => (processes ? alive(processes.main) : false),
    close: async () => {
      await stop();
      for (const suffix of ["", "-wal", "-shm"])
        await copyFile(
          `${databasePath}${suffix}`,
          path.join(options.logDirectory, `product.sqlite${suffix}`),
        ).catch(() => undefined);
      await close(front);
      await close(provider);
      if (process.env["HIMAWARI_PRODUCT_PATH_KEEP_ROOT"] === "1")
        await writeFile(path.join(options.logDirectory, "kept-root.txt"), `${testRoot}\n`);
      else await rm(testRoot, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

async function writeCodingSnapshot(input: {
  readonly snapshotPath: string;
  readonly runtimeRoot: string;
  readonly workspace: string;
  readonly jobsRoot: string;
  readonly protectedPaths: readonly string[];
}) {
  const fileHash = async (filename: string) =>
    createHash("sha256")
      .update(await readFile(filename))
      .digest("hex");
  const runtimeRoot = await realpath(input.runtimeRoot);
  const executable = await realpath(process.execPath);
  const runner = path.join(
    runtimeRoot,
    "node_modules/@himawari-agent/agent-service/dist/capability-programs/pi-coding-main.js",
  );
  const runnerDigest = await fileHash(runner);
  const runtimeDigest = await digestSandboxRuntime(runtimeRoot);
  const metadata = await stat(input.workspace);
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
    runtimeRoot,
    runtimeDigest,
    executable: { path: executable, sha256: await fileHash(executable) },
    runner: { path: runner, sha256: runnerDigest },
    privateRoot: input.jobsRoot,
    roots: [
      {
        canonicalRootId: `${metadata.dev}:${metadata.ino}`,
        canonicalPath: input.workspace,
        device: String(metadata.dev),
        inode: String(metadata.ino),
      },
    ],
    readOnlyToolchainPaths: [
      ...new Set(
        await Promise.all(
          [runtimeRoot, executable, "/bin", "/usr/bin", "/usr/lib", "/System", "/dev"].map(
            (entry) => realpath(entry),
          ),
        ),
      ),
    ],
    protectedPaths: [...input.protectedPaths],
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
        kind: ["write", "edit"].includes(operation) ? "verified_effect" : "fixed_read",
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
    terminationMode: "best_effort",
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
      "best_effort_stop",
    ],
    limitations: ["detached_descendants_may_survive_stop"],
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
            termination: false,
          },
          reasonCodes: [],
          checkedAt: now,
          sandbox,
        },
      },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  await writeFile(input.snapshotPath, bytes, { mode: 0o600 });
  return {
    snapshotPath: input.snapshotPath,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}
