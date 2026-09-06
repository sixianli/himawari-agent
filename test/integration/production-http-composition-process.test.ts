import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as requestHttp } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentId, createDeploymentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { initializeStateRoot, writeAuthorityFile } from "@himawari-agent/platform-node";
import { exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const childFixture = path.join(
  repositoryRoot,
  "test/fixtures/production-http-composition-child.mjs",
);
const ownerId = "owner-production-process";
const agentId = "agent-production-process";
const deploymentId = "deployment-production-process";
const authority = { deploymentId, authorityEpoch: 2, fencingToken: 7 };
const publicOrigin = "https://agent.example.test";
const audience = "access-audience-production-process";
const subject = "subject-production-process";
const bootstrapToken = "bootstrap-token-production-process";
const cookieName = "himawari_session";
const csrfSecret = "11".repeat(32);
const payloadKey = "22".repeat(32);
const PROCESS_SETUP_TIMEOUT_MS = 240_000;
const PROCESS_CLEANUP_TIMEOUT_MS = 30_000;
const NODE_RUNTIME_INSTALL_TIMEOUT_MS = 180_000;
const CHILD_EXIT_TIMEOUT_MS = 5_000;
const PROCESS_REQUEST_TIMEOUT_MS = 10_000;
const PROCESS_RESPONSE_BODY_MAX_BYTES = 1_048_576;
const cleanupRoots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

let testRoot = "";
let runtimePrefix = "";
let stateRoot = "";
let databasePath = "";
let staticRoot = "";
let secretDirectory = "";
let configurationPath = "";
let caCertificatePath = "";
let providerPort = 0;
let appPort = 0;
let provider: ReturnType<typeof createHttpsServer> | undefined;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let jwks: JSONWebKeySet;
let providerAvailable = true;
let providerSubject = subject;
const providerRequests: Array<{
  readonly path: string;
  readonly cookie: string | undefined;
  readonly assertion: string | undefined;
  readonly accept: string | undefined;
}> = [];

type HttpResult = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
  readonly raw: string;
};

function runOpenSsl(arguments_: readonly string[]): void {
  const result = spawnSync("openssl", arguments_, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`openssl failed: ${result.stderr || result.stdout}`);
  }
}

async function createLocalCertificate(root: string): Promise<{
  readonly certificatePath: string;
  readonly keyPath: string;
  readonly caCertificatePath: string;
}> {
  const caKeyPath = path.join(root, "ca-key.pem");
  const caPath = path.join(root, "ca.pem");
  const leafKeyPath = path.join(root, "provider-key.pem");
  const leafCsrPath = path.join(root, "provider.csr");
  const leafPath = path.join(root, "provider.pem");
  const extensionsPath = path.join(root, "provider.ext");
  runOpenSsl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKeyPath,
    "-out",
    caPath,
    "-days",
    "1",
    "-subj",
    "/CN=Himawari production process test CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  runOpenSsl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    leafKeyPath,
    "-out",
    leafCsrPath,
    "-subj",
    "/CN=127.0.0.1",
  ]);
  await writeFile(extensionsPath, "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
  runOpenSsl([
    "x509",
    "-req",
    "-in",
    leafCsrPath,
    "-CA",
    caPath,
    "-CAkey",
    caKeyPath,
    "-CAcreateserial",
    "-out",
    leafPath,
    "-days",
    "1",
    "-sha256",
    "-extfile",
    extensionsPath,
  ]);
  await chmod(caKeyPath, 0o600);
  await chmod(leafKeyPath, 0o600);
  return { certificatePath: leafPath, keyPath: leafKeyPath, caCertificatePath: caPath };
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Ephemeral listener has no port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function listenProvider(certificatePath: string, keyPath: string): Promise<void> {
  const certificate = await readFile(certificatePath);
  const key = await readFile(keyPath);
  provider = createHttpsServer({ cert: certificate, key }, (request, response) => {
    const requestPath = request.url ?? "/";
    providerRequests.push({
      path: requestPath,
      cookie: typeof request.headers.cookie === "string" ? request.headers.cookie : undefined,
      assertion:
        typeof request.headers["cf-access-jwt-assertion"] === "string"
          ? request.headers["cf-access-jwt-assertion"]
          : undefined,
      accept: typeof request.headers.accept === "string" ? request.headers.accept : undefined,
    });
    if (!providerAvailable) {
      response.writeHead(503, { connection: "close" });
      response.end();
      return;
    }
    if (requestPath === "/v1/embeddings") {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        const input = JSON.parse(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            model: input.model,
            data: [{ object: "embedding", index: 0, embedding: Array(input.dimensions).fill(0.1) }],
            usage: { prompt_tokens: 8, total_tokens: 8 },
          }),
        );
      });
      return;
    }
    if (requestPath === "/v1/chat/completions") {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            id: "completion-installed",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: "installed-primary",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "安装后的持久回答" },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            id: "completion-installed",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          })}\n\n`,
        );
        response.end("data: [DONE]\n\n");
      });
      return;
    }
    if (requestPath === "/cdn-cgi/access/certs") {
      const body = JSON.stringify(jwks);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
      return;
    }
    if (requestPath === "/cdn-cgi/access/get-identity") {
      const body = JSON.stringify({
        user_uuid: providerSubject,
        iat: Math.floor(Date.now() / 1000),
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    provider?.once("error", reject);
    provider?.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Provider has no bound port");
  providerPort = address.port;
}

async function closeProvider(): Promise<void> {
  if (!provider) return;
  const current = provider;
  provider = undefined;
  if (!current.listening) return;
  await new Promise<void>((resolve, reject) => {
    current.close((error) => (error ? reject(error) : resolve()));
  });
}

function rawConfiguration(): Record<string, unknown> {
  const issuer = `https://127.0.0.1:${providerPort}`;
  return {
    schemaVersion: "himawari.configuration.v1",
    deploymentId,
    ownerId,
    agentId,
    stateRoot,
    runtimeDirectory: path.join(stateRoot, "runtime"),
    cacheDirectory: path.join(stateRoot, "cache"),
    publicOrigin,
    publicMode: true,
    http: {
      listenHost: "127.0.0.1",
      listenPort: appPort,
      staticRoot,
      sessionCookieName: cookieName,
      maximumBodyBytes: 256 * 1024,
      maximumStaticAssetBytes: 8 * 1024 * 1024,
      heartbeatMilliseconds: 15_000,
    },
    identity: {
      issuer,
      audience,
      jwksUrl: `${issuer}/cdn-cgi/access/certs`,
      jwksCacheMilliseconds: 300_000,
      jwksTimeoutMilliseconds: 2_000,
      jwksMaximumBodyBytes: 65_536,
      clockToleranceSeconds: 30,
      identityLookupTimeoutMilliseconds: 2_000,
      identityLookupMaximumBodyBytes: 65_536,
      recentAuthentication: {
        maximumAgeMilliseconds: 900_000,
        clockSkewMilliseconds: 30_000,
      },
      bootstrap: {
        enabled: true,
        expiresAt: "2099-01-01T00:00:00.000Z",
        tokenSecretRef: "identity-bootstrap",
      },
      csrf: { keySecretRef: "identity-csrf", ttlMilliseconds: 1_800_000 },
    },
    modelDescriptors: [
      {
        ref: "model-primary",
        role: "primary",
        provider: "deterministic",
        model: "deterministic-primary",
        version: "v1",
        allowedDataClassifications: ["public", "private"],
        disclosure: "local_only",
        secretRef: null,
        capabilities: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        priority: 1,
        name: "Production process primary",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        contextWindow: 8192,
        maxTokens: 1024,
      },
      {
        ref: "model-fallback",
        role: "fallback",
        provider: "deterministic",
        model: "deterministic-fallback",
        version: "v1",
        allowedDataClassifications: ["private"],
        disclosure: "local_only",
        secretRef: null,
        capabilities: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        priority: 2,
        name: "Production process fallback",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        contextWindow: 8192,
        maxTokens: 1024,
      },
      {
        ref: "model-embedding",
        role: "embedding",
        provider: "deterministic",
        model: "deterministic-embedding",
        version: "v1",
        allowedDataClassifications: ["public", "private", "sensitive", "restricted"],
        disclosure: "local_only",
        secretRef: null,
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
    deadlines: { runMs: 60_000, workerRequestMs: 5_000, providerRequestMs: 5_000 },
  };
}

async function signToken(
  options: {
    readonly issuer?: string;
    readonly subject?: string;
    readonly issuedAt?: number;
    readonly expiresAt?: number;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "production-process-key" })
    .setIssuer(options.issuer ?? `https://127.0.0.1:${providerPort}`)
    .setAudience(audience)
    .setSubject(options.subject ?? subject)
    .setIssuedAt(options.issuedAt ?? now)
    .setExpirationTime(options.expiresAt ?? now + 300)
    .sign(privateKey);
}

function requestHeaders(
  token: string,
  cookie?: string,
  csrf?: string,
  idempotencyKey?: string,
): Headers {
  const headers = new Headers({
    host: "agent.example.test",
    origin: publicOrigin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "cf-access-jwt-assertion": token,
  });
  if (cookie) headers.set("cookie", cookie);
  if (csrf) headers.set("x-csrf-token", csrf);
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
  return headers;
}

async function httpRequest(
  address: string,
  requestPath: string,
  init: RequestInit = {},
): Promise<HttpResult> {
  const target = new URL(requestPath, address);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") {
    throw new Error(`Production HTTP process test requires a loopback HTTP child: ${target}`);
  }
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", "agent.example.test");
  if (!headers.has("origin")) headers.set("origin", publicOrigin);
  if (!headers.has("sec-fetch-site")) headers.set("sec-fetch-site", "same-origin");
  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (init.body !== undefined && typeof init.body !== "string") {
    throw new Error("Production HTTP process test only supports string request bodies");
  }

  const response = await new Promise<{
    readonly status: number;
    readonly headers: Headers;
    readonly raw: string;
  }>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let request: ReturnType<typeof requestHttp> | undefined;

    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      callback();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      request?.destroy();
      finish(() =>
        reject(
          new Error(
            `${init.method ?? "GET"} ${requestPath}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
      );
    };

    timeout = setTimeout(() => {
      fail(
        new Error(
          `Production HTTP process request timed out after ${PROCESS_REQUEST_TIMEOUT_MS}ms`,
        ),
      );
    }, PROCESS_REQUEST_TIMEOUT_MS);
    request = requestHttp(
      {
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        port: target.port,
        method: init.method ?? "GET",
        headers: Object.fromEntries([...headers]),
      },
      (incoming) => {
        let bodyBytes = 0;
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.from(chunk);
          bodyBytes += buffer.byteLength;
          if (bodyBytes > PROCESS_RESPONSE_BODY_MAX_BYTES) {
            incoming.destroy();
            fail(
              new Error(
                `Production HTTP process response exceeded ${PROCESS_RESPONSE_BODY_MAX_BYTES} bytes`,
              ),
            );
            return;
          }
          chunks.push(buffer);
        });
        incoming.once("aborted", () => fail(new Error("Production HTTP process response aborted")));
        incoming.once("error", fail);
        incoming.once("end", () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) {
            if (Array.isArray(value)) {
              for (const item of value) responseHeaders.append(name, item);
            } else if (value !== undefined) {
              responseHeaders.set(name, value);
            }
          }
          finish(() =>
            resolve({
              status: incoming.statusCode ?? 0,
              headers: responseHeaders,
              raw: Buffer.concat(chunks).toString("utf8"),
            }),
          );
        });
      },
    );
    request.once("error", fail);
    request.end(init.body);
  });
  let body: unknown = null;
  if (response.raw) {
    try {
      body = JSON.parse(response.raw) as unknown;
    } catch {
      body = response.raw;
    }
  }
  return { status: response.status, headers: response.headers, body, raw: response.raw };
}

function jsonRequestBody(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

function envelope(kind: "command" | "query", type: string) {
  return {
    schemaVersion: "gateway.thread.v3" as const,
    kind,
    type,
    messageId: `message:${type}`,
    correlationId: `correlation:${type}`,
    causationId: null,
    scope: { ownerId, agentId },
    authority,
    actor: { actorType: "owner" as const, actorId: ownerId },
  };
}

async function waitForChildReady(
  child: ChildProcessWithoutNullStreams,
): Promise<{ readonly address: string }> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) reject(new Error(`HTTP child readiness timed out: ${errors}`));
    }, 20_000);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const line = output
        .split("\n")
        .find((candidate) => candidate.startsWith("HIMAWARI_PRODUCTION_HTTP_READY "));
      if (line) {
        try {
          finish(() => resolve(JSON.parse(line.slice("HIMAWARI_PRODUCTION_HTTP_READY ".length))));
        } catch (error) {
          finish(() => reject(error));
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8");
    });
    child.once("exit", (code, signal) => {
      finish(() =>
        reject(new Error(`HTTP child exited before ready: ${code ?? signal}: ${errors}`)),
      );
    });
  });
}

async function startChild(caPath: string): Promise<{
  readonly child: ChildProcessWithoutNullStreams;
  readonly address: string;
}> {
  const child = spawn(process.execPath, ["--no-global-search-paths", childFixture], {
    cwd: testRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HIMAWARI_TEST_RUNTIME_ROOT: path.join(runtimePrefix, "lib/himawari-agent"),
      HIMAWARI_TEST_CONFIGURATION: configurationPath,
      HIMAWARI_TEST_STATE_ROOT: stateRoot,
      HIMAWARI_TEST_DATABASE: databasePath,
      HIMAWARI_TEST_STATIC_ROOT: staticRoot,
      HIMAWARI_TEST_SECRET_DIRECTORY: secretDirectory,
      HIMAWARI_TEST_AUTHORITY: JSON.stringify(authority),
      NODE_PATH: "",
      NODE_OPTIONS: "",
      NODE_EXTRA_CA_CERTS: caPath,
    },
  });
  children.add(child);
  const ready = await waitForChildReady(child);
  return { child, address: ready.address };
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    children.delete(child);
    return;
  }
  const waitForExit = (timeoutMs: number): Promise<boolean> => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.removeListener("exit", onExit);
        resolve(false);
      }, timeoutMs);
      const onExit = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(true);
      };
      child.once("exit", onExit);
    });
  };

  child.kill("SIGTERM");
  let exited = await waitForExit(CHILD_EXIT_TIMEOUT_MS);
  if (!exited) {
    child.kill("SIGKILL");
    exited = await waitForExit(CHILD_EXIT_TIMEOUT_MS);
  }
  if (!exited) {
    throw new Error("HTTP child did not exit after SIGKILL");
  }
  children.delete(child);
}

async function initializeTestDatabase(): Promise<void> {
  databasePath = path.join((await initializeStateRoot(stateRoot)).data, "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(ownerId);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(agentId, ownerId);
  database
    .prepare(
      `INSERT INTO deployments (
        id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
      ) VALUES (?, ?, ?, 0, 'active', ?, ?)`,
    )
    .run(deploymentId, ownerId, agentId, authority.authorityEpoch, authority.fencingToken);
  database.close();
}

beforeAll(async () => {
  const { HIMAWARI_TEST_ARTIFACT: artifact, HIMAWARI_TEST_CONTEXT: contextFile } = process.env;
  if (!artifact || !contextFile) {
    throw new Error(
      "PROCESS_HTTP_TEST_REQUIRES_PREBUILT_ARTIFACT: provide HIMAWARI_TEST_ARTIFACT and HIMAWARI_TEST_CONTEXT",
    );
  }
  testRoot = await mkdtemp(path.join(os.tmpdir(), "himawari-production-http-process-"));
  cleanupRoots.push(testRoot);
  runtimePrefix = path.join(testRoot, "prefix");
  stateRoot = await mkdtemp("/tmp/hma-http-state-");
  cleanupRoots.push(stateRoot);
  staticRoot = path.join(testRoot, "browser");
  secretDirectory = path.join(testRoot, "secrets");
  configurationPath = path.join(testRoot, "configuration.json");
  caCertificatePath = path.join(testRoot, "ca.pem");
  await mkdir(staticRoot, { mode: 0o700 });
  await mkdir(secretDirectory, { mode: 0o700 });
  await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>Himawari</title>", {
    mode: 0o600,
  });
  await writeFile(path.join(secretDirectory, "payload-kek.v1"), payloadKey, { mode: 0o600 });
  await writeFile(path.join(secretDirectory, "identity-csrf.v1"), csrfSecret, { mode: 0o600 });
  await writeFile(path.join(secretDirectory, "identity-bootstrap.v1"), bootstrapToken, {
    mode: 0o600,
  });
  const tls = await createLocalCertificate(testRoot);
  caCertificatePath = tls.caCertificatePath;
  const keyPair = await generateKeyPair("RS256", { extractable: true });
  privateKey = keyPair.privateKey;
  jwks = {
    keys: [
      { ...(await exportJWK(keyPair.publicKey)), kid: "production-process-key", alg: "RS256" },
    ],
  };
  await listenProvider(tls.certificatePath, tls.keyPath);
  appPort = await reservePort();
  await initializeTestDatabase();
  await writeFile(configurationPath, JSON.stringify(rawConfiguration()), { mode: 0o600 });
  await chmod(configurationPath, 0o600);
  const installStartedAt = Date.now();
  const install = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, "scripts/install-node-runtime.mjs"),
      "--prefix",
      runtimePrefix,
      "--artifact",
      artifact,
      "--context",
      contextFile,
    ],
    {
      cwd: testRoot,
      encoding: "utf8",
      timeout: NODE_RUNTIME_INSTALL_TIMEOUT_MS,
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
    },
  );
  const installElapsedMs = Date.now() - installStartedAt;
  process.stderr.write(
    `[production-http-process] node runtime install elapsed ${installElapsedMs}ms\n`,
  );
  if (install.status !== 0) {
    throw new Error(
      `Node runtime install failed after ${installElapsedMs}ms${
        install.signal ? ` (${install.signal})` : ""
      }: ${install.stderr || install.stdout || install.error?.message || "unknown error"}`,
    );
  }
}, PROCESS_SETUP_TIMEOUT_MS);

afterAll(async () => {
  const cleanupErrors: unknown[] = [];
  await Promise.all(
    [...children].map(async (child) => {
      try {
        await stopChild(child);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }),
  );
  await closeProvider();
  if (cleanupErrors.length > 0) {
    throw cleanupErrors[0];
  }
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })),
  );
}, PROCESS_CLEANUP_TIMEOUT_MS);

describe("production HTTP composition over a real installed process", { timeout: 120_000 }, () => {
  it("uses default TLS provider fetch, durable SQLite, and fail-closed routes across restart", async () => {
    const untrustedProvider = await fetch(
      `https://127.0.0.1:${providerPort}/cdn-cgi/access/certs`,
    ).then(
      () => false,
      () => true,
    );
    expect(untrustedProvider).toBe(true);
    const token = await signToken();
    let running = await startChild(caCertificatePath);
    const appAddress = running.address;
    try {
      expect(new URL(appAddress).hostname).toBe("127.0.0.1");

      const missingV1 = await httpRequest(
        appAddress,
        "/api/gateway/v1/commands",
        jsonRequestBody({}),
      );
      expect(missingV1.status).toBe(404);
      const missingBreakGlass = await httpRequest(appAddress, "/break-glass", jsonRequestBody({}));
      expect(missingBreakGlass.status).toBe(404);

      const bootstrap = await httpRequest(
        appAddress,
        "/bootstrap",
        jsonRequestBody({ token: bootstrapToken, ownerId, assertionToken: token }),
      );
      expect(bootstrap.status).toBe(201);

      const session = await httpRequest(appAddress, "/api/identity/v1/sessions", {
        ...jsonRequestBody({ deviceLabel: "production process fixture" }),
        headers: requestHeaders(token),
      });
      expect(session.status).toBe(201);
      const setCookie = session.headers.get("set-cookie");
      expect(setCookie).toContain(`${cookieName}=`);
      const cookie = setCookie?.split(";", 1)[0];
      if (!cookie) throw new Error("Session response did not set a cookie");
      const sessionBody = session.body as {
        readonly session: { readonly id: string; readonly authenticationRef: string };
      };

      const browserConfig = await httpRequest(appAddress, "/api/control-center/v1/config", {
        headers: requestHeaders(token, cookie),
      });
      expect(browserConfig.status).toBe(200);
      const browserConfigBody = browserConfig.body as {
        readonly csrfToken: string;
        readonly recentAuthenticationRef: string;
      };
      expect(browserConfigBody.recentAuthenticationRef).toBe(sessionBody.session.authenticationRef);

      const identityRequest = providerRequests.find((request) =>
        request.path.endsWith("/cdn-cgi/access/get-identity"),
      );
      expect(identityRequest).toMatchObject({
        cookie: `CF_Authorization=${token}`,
        assertion: undefined,
        accept: "application/json",
      });
      expect(
        providerRequests.some((request) => request.path.endsWith("/cdn-cgi/access/certs")),
      ).toBe(true);

      const csrfRejected = await httpRequest(appAddress, "/api/payload/v1/text", {
        ...jsonRequestBody({ content: "must not persist", dataClassification: "private" }),
        headers: requestHeaders(token, cookie, undefined, "payload-no-csrf"),
      });
      expect(csrfRejected.status).toBe(403);

      async function upload(idempotencyKey: string, content: string): Promise<string> {
        const response = await httpRequest(appAddress, "/api/payload/v1/text", {
          ...jsonRequestBody({ content, dataClassification: "private" }),
          headers: requestHeaders(token, cookie, browserConfigBody.csrfToken, idempotencyKey),
        });
        expect(response.status).toBe(201);
        return (response.body as { readonly payloadRef: string }).payloadRef;
      }

      const createResultRef = await upload("payload-create-process", "create-result");
      const createCommand = {
        ...envelope("command", "thread.create"),
        idempotencyKey: "thread-create-production-process",
        payload: {
          threadId: "thread-production-process",
          answerLocale: "zh-CN" as const,
          resultRef: createResultRef,
        },
      };
      const created = await httpRequest(appAddress, "/api/gateway/thread/v3/commands", {
        ...jsonRequestBody(createCommand),
        headers: requestHeaders(
          token,
          cookie,
          browserConfigBody.csrfToken,
          createCommand.idempotencyKey,
        ),
      });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({
        type: "thread.command_result",
        payload: { threadRevision: 1, replayed: false },
      });

      const submitResultRef = await upload("payload-submit-process", "submit-result");
      const contentRef = await upload("payload-content-process", "hello from the process owner");
      const submitCommand = {
        ...envelope("command", "thread.message.submit"),
        messageId: "message:production-process-submit",
        correlationId: "correlation:production-process-submit",
        idempotencyKey: "thread-submit-production-process",
        payload: {
          threadId: "thread-production-process",
          expectedRevision: 1,
          messageId: "message:production-process-owner",
          turnId: "turn:production-process-owner",
          runId: "run:production-process-owner",
          sessionId: sessionBody.session.id,
          contentRef,
          sourceProofRef: "proof:production-process-fixture",
          dataClassification: "private" as const,
          occurredAt: new Date().toISOString(),
          resultRef: submitResultRef,
        },
      };
      const admitted = await httpRequest(appAddress, "/api/gateway/thread/v3/commands", {
        ...jsonRequestBody(submitCommand),
        headers: requestHeaders(
          token,
          cookie,
          browserConfigBody.csrfToken,
          submitCommand.idempotencyKey,
        ),
      });
      expect(admitted.status).toBe(200);
      expect(admitted.body).toMatchObject({
        type: "thread.command_result",
        payload: { threadRevision: 2, replayed: false },
      });

      const detail = await httpRequest(appAddress, "/api/gateway/thread/v3/queries", {
        ...jsonRequestBody({
          ...envelope("query", "thread.detail"),
          messageId: "message:production-process-detail",
          payload: { threadId: "thread-production-process", afterSequence: 0, limit: 10 },
        }),
        headers: requestHeaders(token, cookie),
      });
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({
        payload: { thread: { revision: 2 }, runs: [{ status: "accepted" }] },
      });

      const expiredToken = await signToken({
        issuedAt: Math.floor(Date.now() / 1000) - 600,
        expiresAt: Math.floor(Date.now() / 1000) - 120,
      });
      const expiredSession = await httpRequest(appAddress, "/api/identity/v1/sessions", {
        ...jsonRequestBody({ deviceLabel: "expired" }),
        headers: requestHeaders(expiredToken),
      });
      expect(expiredSession.status).toBe(403);
      const wrongIssuer = await signToken({ issuer: `https://wrong.example:${providerPort}` });
      const wrongIssuerSession = await httpRequest(appAddress, "/api/identity/v1/sessions", {
        ...jsonRequestBody({ deviceLabel: "wrong issuer" }),
        headers: requestHeaders(wrongIssuer),
      });
      expect(wrongIssuerSession.status).toBe(403);
      const wrongSubject = await signToken({ subject: "not-bound-to-owner" });
      const wrongSubjectSession = await httpRequest(appAddress, "/api/identity/v1/sessions", {
        ...jsonRequestBody({ deviceLabel: "wrong subject" }),
        headers: requestHeaders(wrongSubject),
      });
      expect(wrongSubjectSession.status).toBe(403);

      const deleteCommand = (idempotencyKey: string) => ({
        ...envelope("command", "thread.delete_permanently"),
        messageId: `message:${idempotencyKey}`,
        correlationId: `correlation:${idempotencyKey}`,
        idempotencyKey,
        payload: {
          threadId: "thread-production-process",
          expectedRevision: 2,
          reasonCode: "process-freshness-negative",
          authorizationRef: "authorization:production-process",
          recentAuthenticationRef: sessionBody.session.authenticationRef,
          resultRef: "payload:production-process-delete-result",
        },
      });

      providerSubject = "different-provider-subject";
      const mismatchedConfig = await httpRequest(appAddress, "/api/control-center/v1/config", {
        headers: requestHeaders(token, cookie),
      });
      expect(mismatchedConfig.status).toBe(200);
      expect(mismatchedConfig.body).toMatchObject({ recentAuthenticationRef: null });
      const mismatchedDelete = await httpRequest(appAddress, "/api/gateway/thread/v3/commands", {
        ...jsonRequestBody(deleteCommand("thread-delete-provider-mismatch")),
        headers: requestHeaders(
          token,
          cookie,
          browserConfigBody.csrfToken,
          "thread-delete-provider-mismatch",
        ),
      });
      expect(mismatchedDelete.status).toBe(403);
      expect(mismatchedDelete.body).toMatchObject({ error: { code: "PORT_NOT_AUTHORITATIVE" } });
      providerSubject = subject;

      providerAvailable = false;
      const unavailableConfig = await httpRequest(appAddress, "/api/control-center/v1/config", {
        headers: requestHeaders(token, cookie),
      });
      expect(unavailableConfig.status).toBe(200);
      expect(unavailableConfig.body).toMatchObject({ recentAuthenticationRef: null });
      const readWithoutProvider = await httpRequest(appAddress, "/api/gateway/thread/v3/queries", {
        ...jsonRequestBody({
          ...envelope("query", "thread.detail"),
          messageId: "message:production-process-detail-provider-down",
          payload: { threadId: "thread-production-process", afterSequence: 0, limit: 10 },
        }),
        headers: requestHeaders(token, cookie),
      });
      expect(readWithoutProvider.status).toBe(200);
      expect(readWithoutProvider.body).toMatchObject({
        payload: { thread: { revision: 2 }, runs: [{ status: "accepted" }] },
      });
      const unavailableDelete = await httpRequest(appAddress, "/api/gateway/thread/v3/commands", {
        ...jsonRequestBody(deleteCommand("thread-delete-provider-down")),
        headers: requestHeaders(
          token,
          cookie,
          browserConfigBody.csrfToken,
          "thread-delete-provider-down",
        ),
      });
      expect(unavailableDelete.status).toBe(403);
      expect(unavailableDelete.body).toMatchObject({ error: { code: "PORT_NOT_AUTHORITATIVE" } });
      providerAvailable = true;

      await stopChild(running.child);
      running = await startChild(caCertificatePath);
      const replay = await httpRequest(appAddress, "/api/gateway/thread/v3/commands", {
        ...jsonRequestBody(submitCommand),
        headers: requestHeaders(
          token,
          cookie,
          browserConfigBody.csrfToken,
          submitCommand.idempotencyKey,
        ),
      });
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({
        type: "thread.command_result",
        payload: { threadRevision: 2, replayed: true },
      });
      const detailAfterRestart = await httpRequest(appAddress, "/api/gateway/thread/v3/queries", {
        ...jsonRequestBody({
          ...envelope("query", "thread.detail"),
          messageId: "message:production-process-detail-restarted",
          payload: { threadId: "thread-production-process", afterSequence: 0, limit: 10 },
        }),
        headers: requestHeaders(token, cookie),
      });
      expect(detailAfterRestart.status).toBe(200);
      expect(detailAfterRestart.body).toMatchObject({
        payload: { thread: { revision: 2 }, runs: [{ status: "accepted" }] },
      });
    } finally {
      await stopChild(running.child);
    }
  });
});

async function writeServiceCapabilitySnapshot() {
  const capabilityDeploymentPath = path.join(stateRoot, "runtime", "capability-deployment.json");
  const checkedAt = new Date().toISOString();
  const artifactDigest = `sha256:${"a".repeat(64)}`;
  const snapshot = {
    schemaVersion: "capability-deployment.v1",
    capabilities: [
      {
        manifest: {
          manifestVersion: "capability.v2",
          ref: "installed-endpoint",
          displayName: "Installed endpoint",
          version: "1.0.0",
          source: { type: "remote_api", locator: "endpoint:installed" },
          sourceIdentity: "publisher:installed",
          integrity: artifactDigest,
          artifact: {
            digest: artifactDigest,
            signatureStatus: "not_applicable",
            signerRef: null,
            rollbackArtifactRef: null,
          },
          operations: ["invoke"],
          permissionRefs: [],
          isolation: "remote",
          scopes: {
            dataClassifications: ["public", "private"],
            network: [],
            filesystem: [],
            secrets: [],
          },
          cost: { currency: "USD", maxMicrosPerInvocation: 100 },
          health: { status: "healthy", checkedAt },
          reviewedBy: null,
          reviewedAt: null,
          contractCompatibility: ["capability-conformance.v1"],
          runtime: {
            kind: "remote_api",
            endpointIdentity: "endpoint:installed",
            protectedReferenceOnly: true,
          },
        },
        qualification: {
          qualificationVersion: "capability-runtime-qualification.v1",
          platform: process.platform === "darwin" ? "darwin" : "linux",
          runtimeIdentity: "node-fetch:endpoint:installed",
          productionSuitable: true,
          artifactDigest,
          enforcement: {
            filesystem: true,
            network: true,
            processes: true,
            secrets: true,
            resourceCeilings: true,
            termination: true,
          },
          reasonCodes: [],
          checkedAt,
        },
        binding: {
          kind: "endpoint",
          value: {
            endpointIdentity: "endpoint:installed",
            artifactDigest,
            url: "https://capability.example.test",
            allowedMethods: ["POST"],
            operations: { invoke: { method: "POST", path: "/invoke", secretHeaders: {} } },
            productionSuitable: true,
            allowLoopbackQualification: false,
          },
        },
      },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(snapshot), "utf8");
  const capabilityDeploymentSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  await writeFile(capabilityDeploymentPath, bytes, { mode: 0o600 });
  return { snapshotPath: capabilityDeploymentPath, sha256: capabilityDeploymentSha256 };
}

it("executes authenticated HTTP requests through installed service-main and reads results after restart", async () => {
  stateRoot = await mkdtemp("/tmp/hma-main-state-");
  cleanupRoots.push(stateRoot);
  await initializeTestDatabase();
  providerAvailable = true;
  providerSubject = subject;
  const raw = rawConfiguration();
  const models = raw["modelDescriptors"] as Array<Record<string, unknown>>;
  raw["modelDescriptors"] = models.map((model) => ({
    ...model,
    provider: "openrouter",
    model: model["role"] === "embedding" ? "installed-embedding" : `installed-${model["role"]}`,
    disclosure: "trusted_remote",
    secretRef: "openrouter-api-key",
  }));
  raw["runPolicy"] = {
    version: "installed-policy-v1",
    systemInstruction: "请用中文回答。",
    memoryLimit: 10,
    maxSelectedMemories: 5,
    maxMemoryClassification: "private",
  };
  raw["capabilityDeployment"] = await writeServiceCapabilitySnapshot();
  raw["secretReferences"] = [
    ...(raw["secretReferences"] as object[]),
    { ref: "openrouter-api-key", version: "v1", purpose: "model-provider-auth", scope: "agent" },
    { ref: "worker-process-token", version: "v1", purpose: "worker-auth", scope: "local-services" },
  ];
  await writeFile(path.join(secretDirectory, "openrouter-api-key.v1"), "local-provider-fixture", {
    mode: 0o600,
  });
  await writeFile(configurationPath, JSON.stringify(raw), { mode: 0o600 });
  const layout = await initializeStateRoot(stateRoot);
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
  const args = [
    "--config",
    configurationPath,
    "--worker-token-file",
    tokenPath,
    "--profile",
    "production",
  ];
  const start = async () => {
    const env = {
      ...process.env,
      NODE_PATH: "",
      NODE_OPTIONS: "",
      NODE_EXTRA_CA_CERTS: caCertificatePath,
      HIMAWARI_TEST_RUNTIME_ROOT: path.join(runtimePrefix, "lib/himawari-agent"),
      HIMAWARI_TEST_CONFIGURATION: configurationPath,
      HIMAWARI_TEST_SECRET_DIRECTORY: secretDirectory,
      HIMAWARI_TEST_MODEL_URL: `https://127.0.0.1:${providerPort}/v1`,
    };
    const main = spawn(
      process.execPath,
      [
        "--no-global-search-paths",
        path.join(repositoryRoot, "test/fixtures/production-service-main-child.mjs"),
        ...args,
      ],
      { cwd: testRoot, stdio: ["pipe", "pipe", "pipe"], env },
    );
    children.add(main);
    main.stdout.on("data", (chunk: Buffer) =>
      process.stderr.write(`[installed-main] ${chunk.toString("utf8")}`),
    );
    main.stderr.on("data", (chunk: Buffer) =>
      process.stderr.write(`[installed-main-error] ${chunk.toString("utf8")}`),
    );
    const worker = spawn(path.join(runtimePrefix, "bin/himawari-execution-worker"), args, {
      cwd: testRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    children.add(worker);
    let workerDiagnostic = "";
    worker.stderr.on("data", (chunk: Buffer) => {
      workerDiagnostic += chunk.toString("utf8");
    });
    const ready = await waitForChildReady(main).catch((error: unknown) => {
      throw new Error(
        `${error instanceof Error ? error.message : "SERVICE_START_FAILED"}; Worker: ${workerDiagnostic}`,
      );
    });
    return { main, worker, address: ready.address };
  };
  let running = await start();
  const token = await signToken();
  let session = await httpRequest(running.address, "/api/identity/v1/sessions", {
    ...jsonRequestBody({ deviceLabel: "installed execution" }),
    headers: requestHeaders(token),
  });
  if (session.status === 401 || session.status === 403) {
    const bootstrap = await httpRequest(
      running.address,
      "/bootstrap",
      jsonRequestBody({ token: bootstrapToken, ownerId, assertionToken: token }),
    );
    expect(bootstrap.status).toBe(201);
    session = await httpRequest(running.address, "/api/identity/v1/sessions", {
      ...jsonRequestBody({ deviceLabel: "installed execution" }),
      headers: requestHeaders(token),
    });
  }
  expect(session.status).toBe(201);
  const cookie = session.headers.get("set-cookie")?.split(";", 1)[0];
  if (!cookie) throw new Error("SESSION_COOKIE_MISSING");
  const browser = await httpRequest(running.address, "/api/control-center/v1/config", {
    headers: requestHeaders(token, cookie),
  });
  const browserConfig = browser.body as {
    deploymentId: string;
    authorityEpoch: number;
    fencingToken: number;
    csrfToken: string;
  };
  const currentAuthority = {
    deploymentId: browserConfig.deploymentId,
    authorityEpoch: browserConfig.authorityEpoch,
    fencingToken: browserConfig.fencingToken,
  };
  const upload = async (name: string, content: string) => {
    const response = await httpRequest(running.address, "/api/payload/v1/text", {
      ...jsonRequestBody({ content, dataClassification: "private" }),
      headers: requestHeaders(token, cookie, browserConfig.csrfToken, name),
    });
    expect(response.status).toBe(201);
    return (response.body as { payloadRef: string }).payloadRef;
  };
  const command = async (type: string, key: string, payload: object) => {
    const result = await httpRequest(running.address, "/api/gateway/thread/v3/commands", {
      ...jsonRequestBody({
        ...envelope("command", type),
        authority: currentAuthority,
        idempotencyKey: key,
        payload,
      }),
      headers: requestHeaders(token, cookie, browserConfig.csrfToken, key),
    });
    expect(result.status).toBe(200);
  };
  await command("thread.create", "installed-main-create", {
    threadId: "thread-production-main",
    answerLocale: "zh-CN",
    resultRef: await upload("installed-main-create-payload", "create"),
  });
  const sessionId = (session.body as { session: { id: string } }).session.id;
  await command("thread.message.submit", "installed-main-submit", {
    threadId: "thread-production-main",
    expectedRevision: 1,
    messageId: "message:installed-main",
    turnId: "turn:installed-main",
    runId: "run:installed-main",
    sessionId,
    contentRef: await upload("installed-main-content", "你好"),
    sourceProofRef: "proof:installed-main",
    dataClassification: "private",
    occurredAt: new Date().toISOString(),
    resultRef: await upload("installed-main-submit-payload", "submit"),
  });
  const detail = async () => {
    const config = await httpRequest(running.address, "/api/control-center/v1/config", {
      headers: requestHeaders(token, cookie),
    });
    expect(config.status).toBe(200);
    const current = config.body as {
      deploymentId: string;
      authorityEpoch: number;
      fencingToken: number;
    };
    return httpRequest(running.address, "/api/gateway/thread/v3/queries", {
      ...jsonRequestBody({
        ...envelope("query", "thread.detail"),
        authority: {
          deploymentId: current.deploymentId,
          authorityEpoch: current.authorityEpoch,
          fencingToken: current.fencingToken,
        },
        payload: { threadId: "thread-production-main", afterSequence: 0, limit: 100 },
      }),
      headers: requestHeaders(token, cookie),
    });
  };
  const readAnswer = async (detail: HttpResult) => {
    const payload = detail.body as {
      payload: { messages: Array<{ role: string; contentRef: string }> };
    };
    const answer = payload.payload.messages.find(({ role }) => role === "agent");
    if (!answer) throw new Error("PERSISTENT_ANSWER_MISSING");
    const browser = await httpRequest(running.address, "/api/control-center/v1/config", {
      headers: requestHeaders(token, cookie),
    });
    expect(browser.status).toBe(200);
    const csrfToken = (browser.body as { csrfToken: string }).csrfToken;
    const read = await httpRequest(running.address, "/api/payload/v1/text/read", {
      ...jsonRequestBody({ payloadRef: answer.contentRef }),
      headers: requestHeaders(token, cookie, csrfToken),
    });
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ content: "安装后的持久回答" });
  };

  try {
    let result = await detail();
    const deadline = Date.now() + 20_000;
    while (
      !/"status":"(?:completed|failed|cancelled)"/u.test(JSON.stringify(result.body)) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      result = await detail();
    }
    expect(result.status).toBe(200);
    if (!JSON.stringify(result.body).includes('"status":"completed"')) {
      const diagnostic = openQualifiedDatabase(databasePath);
      try {
        process.stderr.write(
          `[installed-run-diagnostic] ${JSON.stringify({
            checkpoints: diagnostic
              .prepare("SELECT phase, diagnostic_code FROM run_coordination_checkpoints")
              .all(),
            invocations: diagnostic
              .prepare("SELECT source, status FROM model_invocation_identities")
              .all(),
            providerPaths: providerRequests
              .map(({ path }) => path)
              .filter((route) => route.startsWith("/v1/")),
          })}\n`,
        );
      } finally {
        diagnostic.close();
      }
    }
    expect(result.body).toMatchObject({ payload: { runs: [{ status: "completed" }] } });
    await readAnswer(result);
    const ready = await httpRequest(running.address, "/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: "ready" });
    expect(providerRequests.some(({ path: route }) => route === "/v1/embeddings")).toBe(true);
    expect(providerRequests.some(({ path: route }) => route === "/v1/chat/completions")).toBe(true);
    const requestsBeforeRestart = providerRequests.filter(({ path: route }) =>
      route.startsWith("/v1/"),
    ).length;
    await stopChild(running.main);
    await stopChild(running.worker);
    running = await start();
    const restored = await detail();
    expect(restored.body).toMatchObject({ payload: { runs: [{ status: "completed" }] } });
    await readAnswer(restored);
    expect(providerRequests.filter(({ path: route }) => route.startsWith("/v1/")).length).toBe(
      requestsBeforeRestart,
    );
    await stopChild(running.worker);
    const unavailable = await httpRequest(running.address, "/health/ready");
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).not.toMatchObject({ status: "ready" });
  } finally {
    await stopChild(running.main);
    await stopChild(running.worker);
  }
}, 90_000);
