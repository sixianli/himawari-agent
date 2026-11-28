import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as requestHttp, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentId, createDeploymentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import {
  generateSetupCode,
  initializeStateRoot,
  writeAuthorityFile,
  writeSetupCode,
} from "@himawari-agent/platform-node";
import {
  CHAT_MEMORY_SNAPSHOT_MARKER,
  CONVERSATION_RECALL_HEADER,
  MEMORY_CAPTURE,
} from "@himawari-agent/prompt-catalog";
import {
  buildDeviceTestRequest,
  generateDeviceTestKeyPair,
  SoftwarePasskey,
} from "@himawari-agent/testing";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAgentRequest } from "../fixtures/agent-request.ts";
import { installTestNodeRuntime, type TestNodeRuntime } from "../fixtures/node-runtime.ts";
import { readRequestBody } from "../fixtures/request-body.ts";

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
const CHILD_EXIT_TIMEOUT_MS = 5_000;
const PROCESS_REQUEST_TIMEOUT_MS = 10_000;
const PROCESS_RESPONSE_BODY_MAX_BYTES = 1_048_576;
const cleanupRoots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

let testRoot = "";
let runtimePrefix = "";
let installation: TestNodeRuntime | undefined;
let stateRoot = "";
let databasePath = "";
let staticRoot = "";
let secretDirectory = "";
let configurationPath = "";
let caCertificatePath = "";
let providerPort = 0;
let provider: ReturnType<typeof createHttpsServer> | undefined;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];
let jwks: JSONWebKeySet;
let providerAvailable = true;
let dropEmbeddingConnections = false;
let embeddingCostAvailable = true;
let rejectEmbeddingsOverBudget = false;
let embedByCharacters = false;
let mainDiagnostics = "";
let providerSubject = subject;
const providerRequests: Array<{
  readonly path: string;
  readonly cookie: string | undefined;
  readonly assertion: string | undefined;
  readonly accept: string | undefined;
  body?: Readonly<Record<string, unknown>>;
  raw?: string;
}> = [];
type ChatReply = { readonly text: string } | { readonly tool: string; readonly input: object };
let chatReply: ((input: Readonly<Record<string, unknown>>) => ChatReply) | undefined;
const answerFailedRead = (response: ServerResponse) => () => {
  if (response.destroyed || response.writableEnded) return;
  if (!response.headersSent) response.writeHead(500);
  response.end();
};

function characterVector(input: unknown, dimensions: number): number[] {
  const text =
    (Array.isArray(input) ? String(input[0]) : String(input)).split("Query:").at(-1) ?? "";
  const vector = Array<number>(dimensions).fill(0);
  for (const character of text) {
    const slot = createHash("sha256").update(character).digest().readUInt32BE(0) % dimensions;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }
  return vector;
}

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

async function listenProvider(certificatePath: string, keyPath: string): Promise<void> {
  const certificate = await readFile(certificatePath);
  const key = await readFile(keyPath);
  provider = createHttpsServer({ cert: certificate, key }, (request, response) => {
    const requestPath = request.url ?? "/";
    const capturedRequest = {
      path: requestPath,
      cookie: typeof request.headers.cookie === "string" ? request.headers.cookie : undefined,
      assertion:
        typeof request.headers["cf-access-jwt-assertion"] === "string"
          ? request.headers["cf-access-jwt-assertion"]
          : undefined,
      accept: typeof request.headers.accept === "string" ? request.headers.accept : undefined,
    } as (typeof providerRequests)[number];
    providerRequests.push(capturedRequest);
    if (!providerAvailable) {
      response.writeHead(503, { connection: "close" });
      response.end();
      return;
    }
    if (requestPath === "/v1/embeddings") {
      if (dropEmbeddingConnections) {
        request.socket.destroy();
        return;
      }
      if (rejectEmbeddingsOverBudget) {
        response.writeHead(402, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: "User budget exceeded. Current spend: $3.16, limit: $3.00.",
              type: "quota_for_entity_exceeded",
            },
          }),
        );
        return;
      }
      void readRequestBody(request)
        .then((body) => {
          const input = JSON.parse(body);
          capturedRequest.body = input;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              object: "list",
              model: input.model,
              data: [
                {
                  object: "embedding",
                  index: 0,
                  embedding: embedByCharacters
                    ? characterVector(input.input, input.dimensions)
                    : Array(input.dimensions).fill(0.1),
                },
              ],
              usage: { prompt_tokens: 8, total_tokens: 8 },
              ...(embeddingCostAvailable
                ? {
                    providerMetadata: {
                      gateway: {
                        generationId: `embedding-${providerRequests.length}`,
                        routing: { finalProvider: "deepinfra" },
                        cost: "0.000033",
                      },
                    },
                  }
                : {}),
            }),
          );
        })
        .catch(answerFailedRead(response));
      return;
    }
    if (requestPath === "/v1/chat/completions") {
      void readRequestBody(request)
        .then((body) => {
          const input = JSON.parse(body);
          capturedRequest.body = input;
          capturedRequest.raw = body;
          const reply = chatReply?.(input) ?? { text: "安装后的持久回答" };
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            `data: ${JSON.stringify({
              id: "completion-installed",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: input.model,
              choices: [
                {
                  index: 0,
                  delta:
                    "tool" in reply
                      ? {
                          role: "assistant",
                          tool_calls: [
                            {
                              index: 0,
                              id: `call-${providerRequests.length}`,
                              type: "function",
                              function: {
                                name: reply.tool,
                                arguments: JSON.stringify(reply.input),
                              },
                            },
                          ],
                        }
                      : { role: "assistant", content: reply.text },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              id: "completion-installed",
              object: "chat.completion.chunk",
              model: input.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    provider_metadata: {
                      gateway: {
                        generationId: `generation-${providerRequests.length}`,
                        routing: { finalProvider: "morph" },
                        cost: "0.000077",
                      },
                    },
                  },
                  finish_reason: "tool" in reply ? "tool_calls" : "stop",
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: 5,
                total_tokens: 15,
                cost: "0.000077",
              },
            })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
        })
        .catch(answerFailedRead(response));
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
      listenPort: 0,
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
        contextWindow: 32768,
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
      adapter: "himawari-sqlite",
      version: "3.3.1",
      storagePath: path.join(stateRoot, "data", "memory"),
      dimensions: 16,
    },
    repositoryAllowlistRefs: [],
    secretReferences: [
      { ref: "payload-kek", version: "v1", purpose: "payload-encryption", scope: "agent" },
      { ref: "identity-bootstrap", version: "v1", purpose: "identity-bootstrap", scope: "agent" },
      { ref: "identity-csrf", version: "v1", purpose: "identity-csrf", scope: "agent" },
    ],
    concurrency: { totalRuns: 4, foregroundReserved: 1, perCategory: { foreground: 2 } },
    deadlines: { runMs: 60_000, workerRequestMs: 5_000, providerRequestMs: 5_000 },
  };
}

async function signToken(
  options: {
    readonly issuer?: string;
    readonly audience?: string;
    readonly subject?: string;
    readonly issuedAt?: number;
    readonly expiresAt?: number;
  } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "production-process-key" })
    .setIssuer(options.issuer ?? `https://127.0.0.1:${providerPort}`)
    .setAudience(options.audience ?? audience)
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
  stateRoot = await mkdtemp(`${testTemporaryRoot()}/hma-http-state-`);
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
  await initializeTestDatabase();
  await writeFile(configurationPath, JSON.stringify(rawConfiguration()), { mode: 0o600 });
  await chmod(configurationPath, 0o600);
  installation = await installTestNodeRuntime("PROCESS_HTTP");
  runtimePrefix = installation.prefix;
  process.stderr.write(
    `[production-http-process] node runtime install elapsed ${installation.installElapsedMs}ms${
      installation.shared ? " (shared installation reused read-only)" : ""
    }\n`,
  );
}, PROCESS_SETUP_TIMEOUT_MS);

afterAll(async () => {
  const cleanupErrors: unknown[] = [];
  await installation?.close();
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
    let appAddress = running.address;
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

      const exportUrl = "/api/data-export/v1/archive";
      const exported = await httpRequest(appAddress, exportUrl, {
        headers: requestHeaders(token, cookie),
      });
      expect(exported.status).toBe(200);
      expect(exported.headers.get("content-type")).toBe("application/zip");
      expect(exported.headers.get("cache-control")).toBe("no-store");
      expect(exported.raw.startsWith("PK")).toBe(true);
      expect(exported.headers.get("x-himawari-export-rules")).toMatch(/^\d+$/u);
      const anonymousExport = await httpRequest(appAddress, exportUrl, {
        headers: requestHeaders(token),
      });
      expect(anonymousExport.status).toBe(401);
      expect(anonymousExport.raw).toBe("");
      const crossSiteExport = await httpRequest(appAddress, exportUrl, {
        headers: {
          ...Object.fromEntries(requestHeaders(token, cookie)),
          "sec-fetch-site": "cross-site",
        },
      });
      expect(crossSiteExport.status).toBe(403);

      const chatUrl = "/api/data-export/v1/chats";
      const chats = await httpRequest(appAddress, chatUrl, {
        headers: requestHeaders(token, cookie),
      });
      expect(chats.status).toBe(200);
      expect(chats.headers.get("content-type")).toBe("application/zip");
      expect(chats.headers.get("cache-control")).toBe("no-store");
      expect(chats.raw.startsWith("PK")).toBe(true);
      const anonymousChats = await httpRequest(appAddress, chatUrl, {
        headers: requestHeaders(token),
      });
      expect(anonymousChats.status).toBe(401);
      expect(anonymousChats.raw).toBe("");
      const crossSiteChats = await httpRequest(appAddress, chatUrl, {
        headers: {
          ...Object.fromEntries(requestHeaders(token, cookie)),
          "sec-fetch-site": "cross-site",
        },
      });
      expect(crossSiteChats.status).toBe(403);

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
      appAddress = running.address;
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

const WORKSPACE_GRANT_ID = "directory-installed";
const WORKSPACE_PATH = "/srv/himawari/workspace-installed";

async function openInstalledMain(
  options: { readonly coding?: boolean; readonly runPolicy?: Record<string, unknown> } = {},
) {
  stateRoot = await mkdtemp(`${testTemporaryRoot()}/hma-main-state-`);
  cleanupRoots.push(stateRoot);
  await initializeTestDatabase();
  providerAvailable = true;
  providerSubject = subject;
  const raw = rawConfiguration();
  const models = raw["modelDescriptors"] as Array<Record<string, unknown>>;
  raw["modelDescriptors"] = models.map((model) => ({
    ...model,
    provider: "vercel-ai-gateway",
    model:
      model["role"] === "embedding" ? "alibaba/qwen3-embedding-8b" : "deepseek/deepseek-v4.1-flash",
    cost:
      model["role"] === "embedding"
        ? { input: 0.01, output: 0, cacheRead: 0, cacheWrite: 0 }
        : { input: 0.3, output: 2.4, cacheRead: 0.3, cacheWrite: 0.3 },
    ...(model["role"] === "embedding"
      ? { dimensions: 4096 }
      : { providerRouting: { order: ["runware", "deepinfra", "morph"], sort: "cost" } }),
    disclosure: "trusted_remote",
    secretRef: "vercel-ai-gateway-api-key",
  }));
  raw["memory"] = { ...(raw["memory"] as Record<string, unknown>), dimensions: 4096 };
  raw["runPolicy"] = {
    ...options.runPolicy,
    version: "installed-policy-v1",
    systemInstruction: "请用中文回答。",
    memoryLimit: 10,
    ...(options.coding
      ? {
          coding: {
            hostId: "host-installed",
            workerInstanceId: "worker-installed",
            grantId: WORKSPACE_GRANT_ID,
            capabilityRef: "installed.coding",
            capabilityVersion: "1.0.0",
            maximumBytes: 4096,
            enabledTools: ["read"],
          },
        }
      : {}),
  };
  if (options.coding) {
    const seeded = openQualifiedDatabase(databasePath);
    try {
      seeded
        .prepare(
          "INSERT INTO product_state_records (key, owner_id, agent_id, revision, value_json, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
        )
        .run(
          `host-workspace:directory-grant:${WORKSPACE_GRANT_ID}`,
          ownerId,
          agentId,
          JSON.stringify({
            id: WORKSPACE_GRANT_ID,
            revision: 1,
            hostId: "host-installed",
            canonicalRootId: "root-installed",
            displayPath: WORKSPACE_PATH,
            operations: ["read"],
            dataClassification: "private",
            disclosure: "model",
            pathPolicy: "same_filesystem_no_links",
            mountPolicy: "fixed_device",
            authorizationRef: "authorization-installed",
            expiresAt: "2099-01-01T00:00:00.000Z",
            revokedAt: null,
          }),
          new Date().toISOString(),
        );
    } finally {
      seeded.close();
    }
  }
  raw["capabilityDeployment"] = await writeServiceCapabilitySnapshot();
  raw["secretReferences"] = [
    ...(raw["secretReferences"] as object[]),
    {
      ref: "vercel-ai-gateway-api-key",
      version: "v1",
      purpose: "model-provider-auth",
      scope: "agent",
    },
    { ref: "worker-process-token", version: "v1", purpose: "worker-auth", scope: "local-services" },
  ];
  await writeFile(
    path.join(secretDirectory, "vercel-ai-gateway-api-key.v1"),
    "local-provider-fixture",
    {
      mode: 0o600,
    },
  );
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
    main.stderr.on("data", (chunk: Buffer) => {
      mainDiagnostics += chunk.toString("utf8");
      process.stderr.write(`[installed-main-error] ${chunk.toString("utf8")}`);
    });
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
  const query = async (type: string, payload: object) => {
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
        ...envelope("query", type),
        authority: {
          deploymentId: current.deploymentId,
          authorityEpoch: current.authorityEpoch,
          fencingToken: current.fencingToken,
        },
        payload,
      }),
      headers: requestHeaders(token, cookie),
    });
  };
  const readAnswer = async (detail: HttpResult, runId?: string) => {
    const payload = detail.body as {
      payload: { messages: Array<{ role: string; contentRef: string; runId?: string | null }> };
    };
    const answer = payload.payload.messages.find(
      (message) => message.role === "agent" && (runId === undefined || message.runId === runId),
    );
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
  const submit = async (input: {
    threadId: string;
    expectedRevision: number;
    name: string;
    runId: string;
    content: string;
  }) =>
    command("thread.message.submit", `${input.name}-submit`, {
      threadId: input.threadId,
      expectedRevision: input.expectedRevision,
      messageId: `message:${input.name}`,
      turnId: `turn:${input.name}`,
      runId: input.runId,
      sessionId: (session.body as { session: { id: string } }).session.id,
      contentRef: await upload(`${input.name}-content`, input.content),
      sourceProofRef: `proof:${input.name}`,
      dataClassification: "private",
      occurredAt: new Date().toISOString(),
      resultRef: await upload(`${input.name}-submit-payload`, "submit"),
    });
  const web = (action: string, body: object) =>
    httpRequest(running.address, `/api/devices/v1/${action}`, {
      ...jsonRequestBody(body),
      headers: requestHeaders(token, cookie, browserConfig.csrfToken),
    });
  return {
    browser,
    upload,
    command,
    query,
    web,
    readAnswer,
    submit,
    running: () => running,
    restart: async () => {
      await stopChild(running.main);
      await stopChild(running.worker);
      running = await start();
    },
    stop: async () => {
      await stopChild(running.main);
      await stopChild(running.worker);
    },
  };
}

async function waitForRunToLeaveExecution(
  service: Awaited<ReturnType<typeof openInstalledMain>>,
  threadId: string,
  runId: string,
) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const detail = await service.query("thread.detail", {
      threadId,
      afterSequence: 0,
      limit: 100,
    });
    expect(detail.status).toBe(200);
    const run = (
      detail.body as { payload: { runs: Array<{ runId: string; status: string }> } }
    ).payload.runs.find((candidate) => candidate.runId === runId);
    if (run && !["accepted", "building_context", "running"].includes(run.status))
      return { detail, run };
    if (Date.now() >= deadline) return { detail, run };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function turnIndexEmbeddings(runId: string) {
  const database = openQualifiedDatabase(databasePath);
  try {
    return database
      .prepare(
        "SELECT logical_slot AS logicalSlot, status FROM model_invocation_identities WHERE run_id = ? AND source = 'embedding' AND logical_slot LIKE 'conversation-turn-%' ORDER BY logical_slot",
      )
      .all(runId) as { logicalSlot: string; status: string }[];
  } finally {
    database.close();
  }
}

function readRunBilling(database: ReturnType<typeof openQualifiedDatabase>, runId: string) {
  const identities = database
    .prepare(
      "SELECT invocation_id AS invocationId, source, provider, model, status, actual_cost_micros AS actualCostMicros, budget_account_id AS accountId, budget_operation_key AS operationKey FROM model_invocation_identities WHERE run_id = ? ORDER BY invocation_id",
    )
    .all(runId) as {
    invocationId: string;
    source: string;
    status: string;
    actualCostMicros: number;
    accountId: string;
    operationKey: string;
  }[];
  const allocations = database
    .prepare(
      "SELECT account_id AS accountId, operation_key AS operationKey, status, actual_cost_micros AS actualCostMicros FROM model_budget_allocations WHERE account_id IN (SELECT budget_account_id FROM model_invocation_identities WHERE run_id = ?) ORDER BY account_id, operation_key",
    )
    .all(runId) as {
    accountId: string;
    operationKey: string;
    status: string;
    actualCostMicros: number;
  }[];
  const accounts = database
    .prepare(
      "SELECT account_id AS accountId, spent_cost_micros AS spentCostMicros FROM model_budget_accounts WHERE account_id IN (SELECT budget_account_id FROM model_invocation_identities WHERE run_id = ?) ORDER BY account_id",
    )
    .all(runId) as { accountId: string; spentCostMicros: number }[];
  return { identities, allocations, accounts };
}

function answerMemoryCapture(memories: readonly object[]) {
  return (input: Readonly<Record<string, unknown>>) =>
    JSON.stringify(input["messages"]).includes(MEMORY_CAPTURE.text.slice(0, 24))
      ? { text: JSON.stringify({ memories }) }
      : { text: "安装后的持久回答" };
}

it("[R2-L5] executes authenticated HTTP requests and persists gateway costs after restart", async () => {
  chatReply = answerMemoryCapture([]);
  const service = await openInstalledMain();
  await service.command("thread.create", "installed-main-create", {
    threadId: "thread-production-main",
    answerLocale: "zh-CN",
    resultRef: await service.upload("installed-main-create-payload", "create"),
  });
  await service.submit({
    threadId: "thread-production-main",
    expectedRevision: 1,
    name: "installed-main",
    runId: "run:installed-main",
    content: "你好",
  });
  const detail = () =>
    service.query("thread.detail", {
      threadId: "thread-production-main",
      afterSequence: 0,
      limit: 100,
    });

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
    await service.readAnswer(result);
    expect(service.browser.body).toMatchObject({ executionEnvironmentAvailable: true });
    const environment = await service.query("thread.execution_environment", {});
    expect(environment.status).toBe(200);
    expect(environment.body).toMatchObject({
      type: "thread.execution_environment_snapshot",
      payload: { environment: { mode: "srt", programs: [], unavailableTools: [] } },
    });
    const ready = await httpRequest(service.running().address, "/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: "ready" });
    expect(providerRequests.some(({ path: route }) => route === "/v1/embeddings")).toBe(true);
    expect(providerRequests.some(({ path: route }) => route === "/v1/chat/completions")).toBe(true);
    await expect
      .poll(() => turnIndexEmbeddings("run:installed-main"), { timeout: 30_000 })
      .toEqual([{ logicalSlot: "conversation-turn-1:run:installed-main", status: "settled" }]);
    await expect
      .poll(
        () => {
          const database = openQualifiedDatabase(databasePath);
          try {
            return readRunBilling(database, "run:installed-main").identities.filter(
              ({ status }) => status === "settled",
            ).length;
          } finally {
            database.close();
          }
        },
        { timeout: 30_000 },
      )
      .toBe(5);
    const modelCalls = providerRequests.filter(({ path: route }) => route.startsWith("/v1/"));
    for (const call of modelCalls) {
      expect(call.body?.["model"]).toBe(
        call.path === "/v1/embeddings"
          ? "alibaba/qwen3-embedding-8b"
          : "deepseek/deepseek-v4.1-flash",
      );
      if (call.path === "/v1/chat/completions") {
        expect(call.body?.["providerOptions"]).toEqual({
          gateway: { order: ["runware", "deepinfra", "morph"], sort: "cost" },
        });
        expect(Number(call.body?.["max_tokens"])).toBeLessThanOrEqual(32768);
      } else expect(call.body?.["dimensions"]).toBe(4096);
    }
    const billingDatabase = openQualifiedDatabase(databasePath);
    let billingBeforeRestart: ReturnType<typeof readRunBilling>;
    try {
      billingBeforeRestart = readRunBilling(billingDatabase, "run:installed-main");
      const { identities, allocations, accounts } = billingBeforeRestart;
      const retained = path.resolve(".ci-output/r2-l5-http", path.basename(stateRoot));
      await mkdir(retained, { recursive: true });
      await writeFile(
        path.join(retained, "billing-before-restart.json"),
        JSON.stringify(billingBeforeRestart, null, 2),
      );
      expect(identities.map(({ source }) => source).sort()).toEqual([
        "agent-stream",
        "embedding",
        "embedding",
        "model-port",
        "model-port",
      ]);
      expect(identities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "embedding",
            provider: "vercel-ai-gateway",
            model: "alibaba/qwen3-embedding-8b",
            status: "settled",
            actualCostMicros: 33,
          }),
          ...["agent-stream", "model-port"].map((source) =>
            expect.objectContaining({
              source,
              provider: "vercel-ai-gateway",
              model: "deepseek/deepseek-v4.1-flash",
              status: "settled",
              actualCostMicros: 77,
            }),
          ),
        ]),
      );
      expect(modelCalls).toHaveLength(identities.length);
      expect(allocations).toHaveLength(identities.length);
      for (const identity of identities) {
        expect(
          allocations.filter(
            (allocation) =>
              allocation.accountId === identity.accountId &&
              allocation.operationKey === identity.operationKey,
          ),
        ).toEqual([
          {
            accountId: identity.accountId,
            operationKey: identity.operationKey,
            status: "settled",
            actualCostMicros: identity.actualCostMicros,
          },
        ]);
      }
      expect(accounts.map(({ accountId }) => accountId)).toEqual([
        "run:run:installed-main",
        "thread-title:run:installed-main",
      ]);
      for (const account of accounts) {
        expect(account.spentCostMicros).toBe(
          identities
            .filter(({ accountId }) => accountId === account.accountId)
            .reduce((sum, row) => sum + row.actualCostMicros, 0),
        );
      }
      expect(accounts.reduce((sum, account) => sum + account.spentCostMicros, 0)).toBe(
        identities.reduce((sum, row) => sum + row.actualCostMicros, 0),
      );
      await writeFile(
        path.join(retained, "provider-model-requests.json"),
        JSON.stringify(
          modelCalls.map(({ path, body }) => ({ path, body })),
          null,
          2,
        ),
      );
    } finally {
      billingDatabase.close();
    }
    const requestsBeforeRestart = providerRequests.filter(({ path: route }) =>
      route.startsWith("/v1/"),
    ).length;
    await service.restart();
    const restored = await detail();
    expect(restored.body).toMatchObject({ payload: { runs: [{ status: "completed" }] } });
    await service.readAnswer(restored);
    const restoredDatabase = openQualifiedDatabase(databasePath);
    try {
      const restoredBilling = readRunBilling(restoredDatabase, "run:installed-main");
      expect(restoredBilling).toEqual(billingBeforeRestart);
      await writeFile(
        path.resolve(
          ".ci-output/r2-l5-http",
          path.basename(stateRoot),
          "billing-after-restart.json",
        ),
        JSON.stringify(restoredBilling, null, 2),
      );
    } finally {
      restoredDatabase.close();
    }
    expect(providerRequests.filter(({ path: route }) => route.startsWith("/v1/")).length).toBe(
      requestsBeforeRestart,
    );
    await stopChild(service.running().worker);
    const unavailable = await httpRequest(service.running().address, "/health/ready");
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).not.toMatchObject({ status: "ready" });
  } finally {
    chatReply = undefined;
    await service.stop();
  }
}, 90_000);

it.each(["connection loss", "missing cost", "budget exceeded"] as const)(
  "[P3-2] answers with the memory found by keywords and writes one retrieval fallback record after %s",
  async (failure) => {
    const service = await openInstalledMain();
    const threadId = "thread-memory-fallback";
    const degradeRows = () => {
      const database = openQualifiedDatabase(databasePath);
      try {
        return database
          .prepare(
            "SELECT outcome, reason_code AS reasonCode FROM decision_ledger WHERE kind = 'retrieval_degrade'",
          )
          .all();
      } finally {
        database.close();
      }
    };
    try {
      await service.command("thread.create", "memory-fallback-create", {
        threadId,
        answerLocale: "zh-CN",
        resultRef: await service.upload("memory-fallback-create-payload", "create"),
      });
      chatReply = answerMemoryCapture([
        {
          kind: "durable_fact",
          decision: "create",
          text: "主人的牙医是樱井医生",
          classification: "private",
          confidence: 950,
          explicit: true,
          category: "relationship",
          quote: "请记住，我的牙医是樱井医生",
        },
      ]);
      expect(
        (await submitTurn(service, threadId, "memory-fallback-learn", "请记住，我的牙医是樱井医生"))
          .run?.status,
      ).toBe("completed");
      await expect
        .poll(
          () => {
            const database = openQualifiedDatabase(databasePath);
            try {
              return database
                .prepare(
                  "SELECT count(*) AS indexed FROM memory_search_index WHERE embedding IS NOT NULL",
                )
                .get();
            } finally {
              database.close();
            }
          },
          { timeout: 30_000 },
        )
        .toEqual({ indexed: 1 });
      expect(degradeRows()).toEqual([]);

      chatReply = answerMemoryCapture([]);
      dropEmbeddingConnections = failure === "connection loss";
      embeddingCostAvailable = failure !== "missing cost";
      rejectEmbeddingsOverBudget = failure === "budget exceeded";
      mainDiagnostics = "";
      const embeddingRequestsBefore = providerRequests.filter(
        ({ path: route }) => route === "/v1/embeddings",
      ).length;
      const start = providerRequests.length;
      const recalled = await submitTurn(
        service,
        threadId,
        "memory-fallback-recall",
        "我的牙医叫什么来着？",
      );
      dropEmbeddingConnections = false;
      embeddingCostAvailable = true;
      rejectEmbeddingsOverBudget = false;
      expect(recalled.run?.status).toBe("completed");
      await service.readAnswer(recalled.detail, "run:memory-fallback-recall");
      expect(
        providerRequests.filter(({ path: route }) => route === "/v1/embeddings").length,
      ).toBeGreaterThan(embeddingRequestsBefore);
      const answered = agentRequests(start);
      expect(answered.length).toBeGreaterThan(0);
      expect(lastMessage(answered[0] as (typeof answered)[number])).toContain("樱井医生");
      expect(mainDiagnostics).toContain('"event":"memory.embedding_failed"');
      if (failure === "budget exceeded") {
        expect(mainDiagnostics).toContain('"status":"402"');
        expect(mainDiagnostics).toContain('"gatewayErrorType":"quota_for_entity_exceeded"');
        expect(mainDiagnostics).toContain("User budget exceeded");
      }
      await expect.poll(() => degradeRows().length).toBeGreaterThan(0);
      expect(degradeRows()).toEqual([
        { outcome: "degraded", reasonCode: "vector_search_unavailable" },
      ]);
      const database = openQualifiedDatabase(databasePath);
      try {
        expect(
          database
            .prepare(
              "SELECT source, status FROM model_invocation_identities WHERE run_id = ? AND source = 'embedding' AND logical_slot NOT LIKE 'conversation-turn-%'",
            )
            .all("run:memory-fallback-recall"),
        ).toEqual([{ source: "embedding", status: "settled" }]);
        await expect
          .poll(() => turnIndexEmbeddings("run:memory-fallback-recall"), { timeout: 30_000 })
          .toEqual([
            { logicalSlot: "conversation-turn-1:run:memory-fallback-recall", status: "settled" },
            { logicalSlot: "conversation-turn-2:run:memory-fallback-recall", status: "settled" },
          ]);
        expect(
          database
            .prepare("SELECT status FROM model_budget_accounts WHERE account_id = ?")
            .get("run:run:memory-fallback-recall"),
        ).toEqual({ status: "active" });
      } finally {
        database.close();
      }
      expect(service.running().main.exitCode).toBeNull();
    } finally {
      chatReply = undefined;
      dropEmbeddingConnections = false;
      embeddingCostAvailable = true;
      rejectEmbeddingsOverBudget = false;
      await service.stop();
    }
  },
  90_000,
);

type ChatBody = {
  readonly messages: readonly { readonly role: string; readonly content: unknown }[];
  readonly tools?: unknown;
};

function agentRequests(from: number) {
  return providerRequests
    .slice(from)
    .filter(isAgentRequest)
    .map(({ raw, body }) => ({ raw: raw ?? "", body: body as unknown as ChatBody }));
}

function requestHead(request: { readonly raw: string; readonly body: ChatBody }) {
  const second = request.body.messages[1];
  const end = second === undefined ? -1 : request.raw.indexOf(JSON.stringify(second));
  if (end < 0) throw new Error("REQUEST_HEAD_NOT_FOUND");
  return { prefix: request.raw.slice(0, end), tools: JSON.stringify(request.body.tools ?? null) };
}

function expectAppendOnly(
  previous: { readonly body: ChatBody },
  next: { readonly body: ChatBody },
) {
  expect(next.body.messages.length).toBeGreaterThan(previous.body.messages.length);
  previous.body.messages.forEach((message, index) => {
    expect(JSON.stringify(next.body.messages[index])).toBe(JSON.stringify(message));
  });
}

const lastMessage = (request: { readonly body: ChatBody }) =>
  JSON.stringify(request.body.messages.at(-1));

async function submitTurn(
  service: Awaited<ReturnType<typeof openInstalledMain>>,
  threadId: string,
  name: string,
  content: string,
) {
  const detail = await service.query("thread.detail", { threadId, afterSequence: 0, limit: 100 });
  const revision = (detail.body as { payload: { thread: { revision: number } } }).payload.thread
    .revision;
  await service.submit({
    threadId,
    expectedRevision: revision,
    name,
    runId: `run:${name}`,
    content,
  });
  return waitForRunToLeaveExecution(service, threadId, `run:${name}`);
}

it("[PR-A] keeps the request head byte-identical when the workspace grant expires and sends the runtime environment only when it changes", async () => {
  const service = await openInstalledMain({ coding: true });
  const threadId = "thread-runtime-environment";
  try {
    await service.command("thread.create", "runtime-environment-create", {
      threadId,
      answerLocale: "zh-CN",
      resultRef: await service.upload("runtime-environment-create-payload", "create"),
    });
    const start = providerRequests.length;
    expect((await submitTurn(service, threadId, "environment-first", "第一轮")).run?.status).toBe(
      "completed",
    );
    const first = agentRequests(start);
    expect((await submitTurn(service, threadId, "environment-second", "第二轮")).run?.status).toBe(
      "completed",
    );
    const second = agentRequests(start).slice(first.length);
    const database = openQualifiedDatabase(databasePath);
    try {
      database
        .prepare(
          "UPDATE product_state_records SET value_json = json_set(value_json, '$.expiresAt', ?) WHERE key = ?",
        )
        .run("2020-01-01T00:00:00.000Z", `host-workspace:directory-grant:${WORKSPACE_GRANT_ID}`);
    } finally {
      database.close();
    }
    expect((await submitTurn(service, threadId, "environment-third", "第三轮")).run?.status).toBe(
      "completed",
    );
    const third = agentRequests(start).slice(first.length + second.length);
    const turns = [first.at(-1), second.at(-1), third.at(-1)];
    const [one, two, three] = turns;
    if (!one || !two || !three) throw new Error("AGENT_REQUEST_MISSING");
    expect(requestHead(two)).toEqual(requestHead(one));
    expect(requestHead(three)).toEqual(requestHead(one));
    expect(requestHead(one).prefix).not.toContain(WORKSPACE_PATH);
    expect(requestHead(one).tools).not.toContain(WORKSPACE_PATH);
    expectAppendOnly(one, two);
    expectAppendOnly(two, three);
    expect(lastMessage(one)).toContain(`工作目录：${WORKSPACE_PATH}。`);
    expect(lastMessage(two)).not.toContain("以上运行环境说明");
    expect(lastMessage(two)).not.toContain("工作目录：");
    expect(lastMessage(three)).toContain("工作目录：本轮没有。");
    expect(lastMessage(three)).not.toContain(WORKSPACE_PATH);
  } finally {
    await service.stop();
  }
}, 120_000);

it("[PR-A] stops a tool loop by appending one message, keeps the head unchanged and keeps the message for the next turn", async () => {
  const service = await openInstalledMain();
  const threadId = "thread-tool-loop";
  let chosen = "";
  chatReply = (input) => {
    const names = ((input["tools"] as { function: { name: string } }[] | undefined) ?? []).map(
      (tool) => tool.function.name,
    );
    chosen ||= names.includes("reminder_list") ? "reminder_list" : (names[0] ?? "");
    const messages = input["messages"] as { role: string; content: unknown }[];
    if (JSON.stringify(messages.at(-1)).includes("不要说整个任务已经成功"))
      return { text: "已确认的结果：提醒列表是空的；这一步卡住了，我换个办法。" };
    if (!isAgentRequest({ path: "/v1/chat/completions", body: input }) || !chosen)
      return { text: "安装后的持久回答" };
    return { tool: chosen, input: {} };
  };
  try {
    await service.command("thread.create", "tool-loop-create", {
      threadId,
      answerLocale: "zh-CN",
      resultRef: await service.upload("tool-loop-create-payload", "create"),
    });
    const start = providerRequests.length;
    const stopped = await submitTurn(service, threadId, "tool-loop-first", "列出提醒");
    expect(chosen).not.toBe("");
    expect(stopped.run?.status).toBe("failed");
    const loop = agentRequests(start);
    expect(loop.length).toBe(5);
    const [before, summary] = [loop.at(-2), loop.at(-1)];
    if (!before || !summary) throw new Error("LOOP_REQUESTS_MISSING");
    expect(requestHead(summary)).toEqual(requestHead(loop[0] as (typeof loop)[number]));
    expect(JSON.parse(requestHead(summary).tools)).not.toEqual([]);
    expectAppendOnly(before, summary);
    expect(summary.body.messages.length).toBe(before.body.messages.length + 3);
    expect(summary.body.messages.at(-1)?.role).toBe("user");
    expect(lastMessage(summary)).toContain("不要说整个任务已经成功");
    expect(requestHead(summary).prefix).not.toContain("不要说整个任务已经成功");
    chatReply = undefined;
    expect((await submitTurn(service, threadId, "tool-loop-second", "好的")).run?.status).toBe(
      "completed",
    );
    const next = agentRequests(start).slice(loop.length).at(-1);
    if (!next) throw new Error("NEXT_TURN_REQUEST_MISSING");
    expect(requestHead(next)).toEqual(requestHead(summary));
    expectAppendOnly(summary, next);
    expect(
      next.body.messages
        .slice(0, -1)
        .some((message) => JSON.stringify(message).includes("不要说整个任务已经成功")),
    ).toBe(true);
  } finally {
    chatReply = undefined;
    await service.stop();
  }
}, 120_000);

async function reconfigure(
  service: Awaited<ReturnType<typeof openInstalledMain>>,
  change: (raw: Record<string, unknown> & { runPolicy: Record<string, unknown> }) => void,
) {
  const raw = JSON.parse(await readFile(configurationPath, "utf8"));
  change(raw);
  await writeFile(configurationPath, JSON.stringify(raw), { mode: 0o600 });
  await service.restart();
}

function bundleRows(threadId: string) {
  const database = openQualifiedDatabase(databasePath);
  try {
    return database
      .prepare(
        `SELECT generation, origin, superseded_at IS NOT NULL AS superseded
         FROM thread_prompt_bundles WHERE thread_id = ? ORDER BY generation`,
      )
      .all(threadId) as Array<{ generation: number; origin: string; superseded: number }>;
  } finally {
    database.close();
  }
}

function invalidationTraces(threadId: string) {
  const database = openQualifiedDatabase(databasePath);
  try {
    return database
      .prepare(
        "SELECT run_id AS runId FROM trace_events WHERE thread_id = ? AND event_type = 'prompt.bundle.invalidated' ORDER BY occurred_at, sequence",
      )
      .all(threadId) as Array<{ runId: string }>;
  } finally {
    database.close();
  }
}

const toolNames = (request: { readonly body: ChatBody }) =>
  ((request.body.tools as { function: { name: string } }[] | undefined) ?? []).map(
    (tool) => tool.function.name,
  );

async function systemInstructionChange(runPolicy: Record<string, unknown>) {
  const service = await openInstalledMain({ runPolicy });
  const threadId = `thread-frozen-instruction-${Object.keys(runPolicy).length}`;
  try {
    await service.command("thread.create", `${threadId}-create`, {
      threadId,
      answerLocale: "zh-CN",
      resultRef: await service.upload(`${threadId}-create-payload`, "create"),
    });
    const start = providerRequests.length;
    expect((await submitTurn(service, threadId, `${threadId}-1`, "第一轮")).run?.status).toBe(
      "completed",
    );
    const first = agentRequests(start).at(-1);
    await reconfigure(service, (raw) => {
      raw.runPolicy["systemInstruction"] = "请用中文回答，语气更轻松。";
    });
    expect((await submitTurn(service, threadId, `${threadId}-2`, "第二轮")).run?.status).toBe(
      "completed",
    );
    const second = agentRequests(start).at(-1);
    if (!first || !second || first === second) throw new Error("AGENT_REQUEST_MISSING");
    return { first, second, rows: bundleRows(threadId) };
  } finally {
    await service.stop();
  }
}

it("[P5-3] serves the MCP entry only to an OAuth access token and points a bare request to the sign-in details", async () => {
  const service = await openInstalledMain();
  try {
    const token = seedMcpConnection();
    const call = async (bearer?: string) =>
      httpRequest(service.running().address, "/api/mcp/v1", {
        ...jsonRequestBody({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "today_context", arguments: {} },
        }),
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18",
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
      });
    const bare = await call();
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toContain(
      `resource_metadata="${publicOrigin}/.well-known/oauth-protected-resource/api/mcp/v1"`,
    );
    const metadata = await httpRequest(
      service.running().address,
      "/.well-known/oauth-protected-resource/api/mcp/v1",
      { method: "GET" },
    );
    expect(metadata.status).toBe(200);
    expect(JSON.parse(metadata.raw)).toMatchObject({
      resource: `${publicOrigin}/api/mcp/v1`,
      authorization_servers: [publicOrigin],
    });
    expect((await call(await signToken())).status).toBe(401);
    expect((await call("B".repeat(43))).status).toBe(401);
    const served = await call(token);
    expect(served.status).toBe(200);
    expect(served.raw).toContain(String(new Date().getUTCFullYear()));
    const names = await installedMcpToolNames(service.running().address, token);
    expect(names).toEqual(
      expect.arrayContaining(["today_context", "propose_memory", "propose_rule"]),
    );
  } finally {
    await service.stop();
  }
}, 120_000);

function seedMcpConnection(): string {
  const token = "A".repeat(43);
  const now = new Date().toISOString();
  const seeded = openQualifiedDatabase(databasePath);
  try {
    seeded
      .prepare(
        `INSERT OR IGNORE INTO mcp_connections (
          id, owner_id, agent_id, name, secret_sha256, capabilities, read_ceiling, push_policy,
          status, reported_client, created_at, updated_at, secret_rotated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, '["mcp"]', 'private', 'ask', 'active', NULL, ?, ?, NULL, NULL)`,
      )
      .run(
        "conn-installed-process",
        ownerId,
        agentId,
        "installed-process",
        createHash("sha256").update("unused-installed-process").digest("hex"),
        now,
        now,
      );
    seeded
      .prepare(
        `INSERT OR IGNORE INTO mcp_oauth_clients (
          client_id, owner_id, agent_id, registration, client_name, redirect_uris,
          connection_id, created_at, updated_at
        ) VALUES (?, ?, ?, 'dynamic', 'installed-process', '["http://127.0.0.1/callback"]', ?, ?, ?)`,
      )
      .run("client-installed-process", ownerId, agentId, "conn-installed-process", now, now);
    seeded
      .prepare(
        `INSERT OR REPLACE INTO mcp_oauth_tokens (
          token_sha256, owner_id, agent_id, kind, connection_id, client_id, family_id, scopes,
          resource, created_at, expires_at, used_at, revoked_at
        ) VALUES (?, ?, ?, 'access', ?, ?, ?, '["himawari:read","himawari:write"]', ?, ?, ?, NULL, NULL)`,
      )
      .run(
        createHash("sha256").update(token, "utf8").digest("hex"),
        ownerId,
        agentId,
        "conn-installed-process",
        "client-installed-process",
        "family-installed-process",
        `${publicOrigin}/api/mcp/v1`,
        now,
        new Date(Date.now() + 3_600_000).toISOString(),
      );
  } finally {
    seeded.close();
  }
  return token;
}

async function installedMcpToolNames(address: string, token: string): Promise<string[]> {
  const client = new Client(
    { name: "claude-code", version: "2.1.400" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      capabilities: { elicitation: { form: {} } },
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/api/mcp/v1", address), {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${token}`);
        const target = new URL(input instanceof Request ? input.url : String(input));
        const result = await httpRequest(address, `${target.pathname}${target.search}`, {
          method: init?.method ?? "GET",
          headers,
          ...(typeof init?.body === "string" ? { body: init.body } : {}),
        });
        return new Response(result.status === 204 ? null : result.raw, {
          status: result.status,
          headers: result.headers,
        });
      },
    }),
  );
  try {
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
}

it("[PR-B] keeps the request head byte-identical when the configured system instruction changes between turns", async () => {
  const { first, second, rows } = await systemInstructionChange({});
  expect(requestHead(second)).toEqual(requestHead(first));
  expectAppendOnly(first, second);
  expect(requestHead(second).prefix).toContain("请用中文回答。");
  expect(requestHead(second).prefix).not.toContain("语气更轻松");
  expect(rows).toEqual([{ generation: 1, origin: "new_thread", superseded: 0 }]);
}, 120_000);

it("[PR-B] REVERSE: with the production switch turning the freeze off, the same change rewrites the request head", async () => {
  const { first, second, rows } = await systemInstructionChange({ freezeThreadPrompts: false });
  expect(requestHead(second)).not.toEqual(requestHead(first));
  expect(requestHead(second).prefix).toContain("语气更轻松");
  expect(rows).toEqual([]);
}, 120_000);

it("[PR-B] renews the frozen prompt once when web search is turned on and once when the model changes, and the next turn can call web_search", async () => {
  const service = await openInstalledMain();
  const threadId = "thread-frozen-renewal";
  try {
    await service.command("thread.create", "frozen-renewal-create", {
      threadId,
      answerLocale: "zh-CN",
      resultRef: await service.upload("frozen-renewal-create-payload", "create"),
    });
    const start = providerRequests.length;
    expect((await submitTurn(service, threadId, "renewal-first", "第一轮")).run?.status).toBe(
      "completed",
    );
    const first = agentRequests(start).at(-1);
    await reconfigure(service, (raw) => {
      raw.runPolicy["publicSearch"] = {
        hostId: "host-installed",
        workerInstanceId: "worker-installed",
        capabilityRef: "installed.search",
        capabilityVersion: "1.0.0",
        maximumBytes: 4096,
        scopeSource: "private_temp",
      };
    });
    expect((await submitTurn(service, threadId, "renewal-second", "第二轮")).run?.status).toBe(
      "completed",
    );
    const second = agentRequests(start).at(-1);
    expect((await submitTurn(service, threadId, "renewal-third", "第三轮")).run?.status).toBe(
      "completed",
    );
    const third = agentRequests(start).at(-1);
    if (!first || !second || !third) throw new Error("AGENT_REQUEST_MISSING");
    expect(toolNames(first)).not.toContain("web_search");
    expect(toolNames(second)).toContain("web_search");
    expect(requestHead(second)).not.toEqual(requestHead(first));
    expect(requestHead(third)).toEqual(requestHead(second));
    expectAppendOnly(second, third);
    expect(bundleRows(threadId)).toEqual([
      { generation: 1, origin: "new_thread", superseded: 1 },
      { generation: 2, origin: "tool_set_changed", superseded: 0 },
    ]);
    await reconfigure(service, (raw) => {
      const models = raw["modelDescriptors"] as Array<Record<string, unknown>>;
      raw["modelDescriptors"] = models.map((model) =>
        model["role"] === "primary" ? { ...model, ref: "model-primary-next" } : model,
      );
    });
    expect((await submitTurn(service, threadId, "renewal-fourth", "第四轮")).run?.status).toBe(
      "completed",
    );
    expect(bundleRows(threadId)).toEqual([
      { generation: 1, origin: "new_thread", superseded: 1 },
      { generation: 2, origin: "tool_set_changed", superseded: 1 },
      { generation: 3, origin: "model_changed", superseded: 0 },
    ]);
    expect(invalidationTraces(threadId)).toEqual([
      { runId: "run:renewal-second" },
      { runId: "run:renewal-fourth" },
    ]);
  } finally {
    await service.stop();
  }
}, 180_000);

const turnTime = /本轮请求时间（UTC）：[^。]+。配置时区 (\S+) 的当地时间：[^，]+，[^。]+。/gu;
const withoutTurnTime = (raw: string) =>
  raw.replace(turnTime, "本轮请求时间（UTC）：<time>。配置时区 $1 的当地时间：<time>。");

async function pairInstalledDevice(service: Awaited<ReturnType<typeof openInstalledMain>>) {
  const setupCode = generateSetupCode();
  await writeSetupCode({
    stateRoot,
    scope: { ownerId: createOwnerId(ownerId), agentId: createAgentId(agentId) },
    code: setupCode,
    now: new Date(),
    minutes: 15,
  });
  const keys = generateDeviceTestKeyPair();
  const confirmKeys = generateDeviceTestKeyPair();
  const passkey = new SoftwarePasskey(publicOrigin);
  const signIn = (route: string, body: object) =>
    httpRequest(service.running().address, `/api/device/v1/sign-in/${route}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  const options = await signIn("setup/options", {
    setupCode,
    device: {
      kind: "iphone",
      name: "Andy iPhone",
      releaseChannel: "direct",
      devicePublicKey: keys.publicKeySpkiBase64,
      confirmPublicKey: confirmKeys.publicKeySpkiBase64,
    },
  });
  expect(options.status, options.raw).toBe(200);
  const started = options.body as {
    flowId: string;
    publicKey: { challenge: string; rp: { id: string } };
  };
  const finished = await signIn("setup/finish", {
    flowId: started.flowId,
    credential: passkey.create(started.publicKey),
  });
  expect(finished.status, finished.raw).toBe(201);
  const device = (finished.body as { device: { id: string; revision: number } }).device;
  const post = async (route: string, body: object, nonce?: string) => {
    const signed = buildDeviceTestRequest({
      origin: publicOrigin,
      deviceId: device.id,
      deviceKey: keys.privateKey,
      method: "POST",
      path: `/api/device/v1/${route}`,
      body: JSON.stringify(body),
      ...(nonce === undefined ? {} : { confirmKey: confirmKeys.privateKey, nonce }),
    });
    return httpRequest(service.running().address, `/api/device/v1/${route}`, {
      method: "POST",
      headers: signed.headers,
      body: signed.body?.toString("utf8") ?? "",
    });
  };
  return async (route: string, body: object, confirmed = false) => {
    if (!confirmed) return post(route, body);
    const issued = await post("approvals/challenge", {});
    expect(issued.status, issued.raw).toBe(201);
    return post(route, body, (issued.body as { challenge: string }).challenge);
  };
}

async function waitForThreadRun(
  service: Awaited<ReturnType<typeof openInstalledMain>>,
  threadId: string,
) {
  await expect
    .poll(
      async () => {
        const detail = await service.query("thread.detail", {
          threadId,
          afterSequence: 0,
          limit: 100,
        });
        return (detail.body as { payload: { runs: { status: string }[] } }).payload.runs.map(
          ({ status }) => status,
        );
      },
      { timeout: 30_000, interval: 200 },
    )
    .toEqual(["completed"]);
}

it("[PR-A] [iOS-8] a half sentence prepared while the owner speaks sends the model the same bytes, memories and order as no preparation", async () => {
  const service = await openInstalledMain();
  const remembered = [
    "主人想把每周的会都改到下午开",
    "主人想把明天的例会改到下午三点",
    "主人的牙医是樱井医生",
  ];
  embedByCharacters = true;
  try {
    await service.command("thread.create", "prefetch-bytes-seed-create", {
      threadId: "thread-prefetch-bytes-seed",
      answerLocale: "zh-CN",
      resultRef: await service.upload("prefetch-bytes-seed-payload", "create"),
    });
    for (const [index, text] of remembered.entries()) {
      const quote = `请记住，${text.replace("主人", "我")}`;
      chatReply = answerMemoryCapture([
        {
          kind: "durable_fact",
          decision: "create",
          text,
          classification: "private",
          confidence: 950,
          explicit: true,
          category: "schedule",
          quote,
        },
      ]);
      expect(
        (
          await submitTurn(
            service,
            "thread-prefetch-bytes-seed",
            `prefetch-bytes-seed-${index}`,
            quote,
          )
        ).run?.status,
      ).toBe("completed");
    }
    await expect
      .poll(
        () => {
          const database = openQualifiedDatabase(databasePath);
          try {
            return database
              .prepare(
                "SELECT count(*) AS indexed FROM memory_search_index WHERE embedding IS NOT NULL",
              )
              .get();
          } finally {
            database.close();
          }
        },
        { timeout: 30_000 },
      )
      .toEqual({ indexed: remembered.length });
    chatReply = answerMemoryCapture([]);
    const device = await pairInstalledDevice(service);
    const finalWords = "帮我把明天的会改到下午。";
    const spoken = async (name: string, partial: string | null) => {
      const created = await device("threads", {
        requestId: `device-request-${name}-0001`,
        answerLocale: "zh-CN",
      });
      expect(created.status, created.raw).toBe(200);
      const threadId = (created.body as { payload: { threadId: string } }).payload.threadId;
      const start = providerRequests.length;
      if (partial !== null) {
        const prepared = await device("utterances/partial", {
          utteranceId: `utt-${name}`,
          text: partial,
        });
        expect(prepared.body).toEqual({ prepared: true, reason: null });
      }
      const afterPartial = providerRequests.length;
      const sent = await device("messages", {
        messageId: `device-message-${name}-0001`,
        threadId,
        expectedRevision: 1,
        text: finalWords,
        utteranceId: `utt-${name}`,
      });
      expect(sent.status, sent.raw).toBe(200);
      await waitForThreadRun(service, threadId);
      const embedded = (from: number, to?: number) =>
        providerRequests
          .slice(from, to)
          .filter(({ path: route }) => route === "/v1/embeddings")
          .map(({ body }) => String(body?.["input"]))
          .filter((input) => input.includes("Query:"))
          .map((input) => input.split("Query:").at(-1));
      const request = agentRequests(afterPartial)[0];
      if (!request) throw new Error("AGENT_REQUEST_MISSING");
      return {
        request,
        whilePreparing: embedded(start, afterPartial),
        afterFinal: embedded(afterPartial),
      };
    };
    const cold = await spoken("prefetch-bytes-cold", null);
    const warm = await spoken("prefetch-bytes-warm", "帮我把明天的会改到下午");

    expect(cold.whilePreparing).toEqual([]);
    expect(cold.afterFinal).toEqual(["帮我把明天的会改到下午"]);
    expect(warm.whilePreparing).toEqual(["帮我把明天的会改到下午"]);
    expect(warm.afterFinal).toEqual([]);

    const outsideSnapshot = (message: string) => {
      const start = message.indexOf(CHAT_MEMORY_SNAPSHOT_MARKER.text);
      if (start < 0) return message;
      const end = message.indexOf("\\n[", start + CHAT_MEMORY_SNAPSHOT_MARKER.text.length);
      return message.slice(0, start) + (end < 0 ? "" : message.slice(end));
    };
    const fullCold = lastMessage(cold.request);
    expect(fullCold).toContain(CHAT_MEMORY_SNAPSHOT_MARKER.text);
    for (const text of remembered) expect(fullCold).toContain(text);
    const lastCold = outsideSnapshot(fullCold);
    const order = (message: string) =>
      remembered
        .map((text) => [text, message.indexOf(text)] as const)
        .filter(([, at]) => at >= 0)
        .sort((a, b) => a[1] - b[1])
        .map(([text]) => text);
    expect(order(lastCold).length).toBeGreaterThanOrEqual(2);
    expect(order(lastCold)).not.toContain("主人的牙医是樱井医生");
    expect(order(outsideSnapshot(lastMessage(warm.request)))).toEqual(order(lastCold));
    expect(lastCold).toContain(finalWords);
    const withoutRecall = (raw: string) => {
      const header = raw.indexOf(CONVERSATION_RECALL_HEADER.text);
      if (header < 0) return raw;
      const start = raw.lastIndexOf("\\n[Himawari 资料 ", header);
      const ends = ["\\n[Himawari", "\\n[记忆变化", "\\n</himawari-context>"]
        .map((next) => raw.indexOf(next, header))
        .filter((at) => at >= 0);
      if (start < 0 || ends.length === 0) throw new Error("CONVERSATION_RECALL_BLOCK_UNBOUNDED");
      return raw.slice(0, start) + raw.slice(Math.min(...ends));
    };
    expect(withoutTurnTime(withoutRecall(warm.request.raw))).toBe(
      withoutTurnTime(withoutRecall(cold.request.raw)),
    );
    expect(warm.request.raw.match(turnTime)).toHaveLength(1);
  } finally {
    chatReply = undefined;
    embedByCharacters = false;
    await service.stop();
  }
}, 180_000);

async function settingsConversation(service: Awaited<ReturnType<typeof openInstalledMain>>) {
  const device = await pairInstalledDevice(service);
  let script: ChatReply[] = [];
  let captured: readonly object[] = [];
  chatReply = (input) => {
    if (!isAgentRequest({ path: "/v1/chat/completions", body: input }))
      return answerMemoryCapture(captured)(input);
    const messages = input["messages"] as { role: string }[];
    if (messages.at(-1)?.role === "tool") return script.shift() ?? { text: "好了" };
    return script.shift() ?? { text: "好了" };
  };
  const created = await device("threads", {
    requestId: "device-request-settings-0001",
    answerLocale: "zh-CN",
  });
  expect(created.status, created.raw).toBe(200);
  const threadId = (created.body as { payload: { threadId: string } }).payload.threadId;
  let sent = 0;
  const say = async (text: string, replies: ChatReply[], memories: readonly object[] = []) => {
    script = [...replies];
    captured = memories;
    const start = providerRequests.length;
    const detail = await service.query("thread.detail", { threadId, afterSequence: 0, limit: 100 });
    const revision = (detail.body as { payload: { thread: { revision: number } } }).payload.thread
      .revision;
    sent += 1;
    const posted = await device("messages", {
      messageId: `device-message-settings-${String(sent).padStart(4, "0")}`,
      threadId,
      expectedRevision: revision,
      text,
    });
    expect(posted.status, posted.raw).toBe(200);
    let status: string[] = [];
    await expect
      .poll(
        async () => {
          const current = await service.query("thread.detail", {
            threadId,
            afterSequence: 0,
            limit: 100,
          });
          status = (current.body as { payload: { runs: { status: string }[] } }).payload.runs.map(
            (run) => run.status,
          );
          return (
            status.length === sent &&
            !["accepted", "building_context", "running"].includes(status.at(-1) ?? "")
          );
        },
        { timeout: 30_000, interval: 200 },
      )
      .toBe(true);
    const messages = agentRequests(start).at(-1)?.body.messages ?? [];
    const asked = messages.map((message) => message.role).lastIndexOf("user");
    const results = messages
      .slice(asked + 1)
      .filter((message) => message.role === "tool")
      .map((message) => JSON.parse(String(message.content)) as Record<string, unknown>);
    return { status: status.at(-1), results, requests: agentRequests(start) };
  };
  let reads = 0;
  const read = async (type: string, payload: object = {}) => {
    reads += 1;
    const answered = await device("gateway", {
      gateway: "v2",
      type,
      messageId: `settings-read-${reads}`,
      dataClassification: "private",
      risk: "low",
      payload,
    });
    expect(answered.status, answered.raw).toBe(200);
    return (answered.body as { payload: Record<string, unknown> }).payload;
  };
  let approvals = 0;
  const approve = async (detail: Record<string, unknown>) => {
    approvals += 1;
    const approval = detail as {
      approvalRequestId: string;
      revision: number;
      finalRisk: string;
      semanticSnapshotHash: string;
    };
    const answered = await device(
      "gateway",
      {
        gateway: "v2",
        type: "approval.respond",
        messageId: `settings-approve-${approvals}`,
        idempotencyKey: `settings-approve-key-${approvals}`,
        dataClassification: "private",
        risk: approval.finalRisk,
        payload: {
          approvalRequestId: approval.approvalRequestId,
          expectedRevision: approval.revision,
          decision: "approved",
          semanticSnapshotHash: approval.semanticSnapshotHash,
          editedPayloadRef: null,
          recentAuthenticationRef: "device",
        },
      },
      true,
    );
    expect(answered.status, answered.raw).toBe(200);
  };
  return { say, read, approve };
}

function settingsApprovals() {
  const database = openQualifiedDatabase(databasePath);
  try {
    return (
      database
        .prepare("SELECT status, record_json AS record FROM approval_requests ORDER BY rowid")
        .all() as { status: string; record: string }[]
    ).map(
      ({ status, record }) =>
        ({ ...(JSON.parse(record) as Record<string, unknown>), status }) as Record<string, unknown>,
    );
  } finally {
    database.close();
  }
}

it("[ADR 0315][SET-1] 在聊天里说“暂停记忆”就直接暂停，读回确认，设置页读到暂停；说“撤销”改回；“打开勿扰”直接打开", async () => {
  const service = await openInstalledMain();
  try {
    const chat = await settingsConversation(service);
    const listed = await chat.say("你能改哪些设置？", [
      { tool: "settings_list", input: {} },
      { text: "这些都能改。" },
    ]);
    const catalog = listed.results[0] as { settings: { setting: string; tier: number }[] };
    expect(catalog.settings.map(({ setting }) => setting)).toEqual(
      expect.arrayContaining(["memory.settings.set", "quiet_hours.set", "owner.preferences.set"]),
    );
    expect(JSON.stringify(catalog)).not.toMatch(/vault/iu);
    const tools = (listed.requests[0]?.body.tools ?? []) as { function: { name: string } }[];
    expect(tools.map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining(["settings_list", "settings_change", "settings_undo"]),
    );
    expect(JSON.stringify(tools)).not.toContain("quiet_hours.set");

    expect((await chat.read("memory.overview.read"))["capturePaused"]).toBe(false);
    const paused = await chat.say("暂停记忆", [
      {
        tool: "settings_change",
        input: { setting: "memory.settings.set", values: { capturePaused: true } },
      },
      { text: "已暂停记忆，想撤销说一声就行。" },
    ]);
    expect(paused.status).toBe("completed");
    const change = paused.results[0] as Record<string, unknown>;
    expect(change).toMatchObject({
      setting: "memory.settings.set",
      tier: 1,
      confirmed: true,
      before: { capturePaused: false },
      after: { capturePaused: true },
    });
    expect((await chat.read("memory.overview.read"))["capturePaused"]).toBe(true);

    const undone = await chat.say("撤销", [
      { tool: "settings_undo", input: { changeId: change["changeId"] } },
      { text: "已恢复记忆。" },
    ]);
    expect(undone.results[0]).toMatchObject({
      tier: 2,
      confirmed: true,
      after: { capturePaused: false },
      undoOf: change["changeId"],
    });
    expect((await chat.read("memory.overview.read"))["capturePaused"]).toBe(false);

    const fact = "主人的牙医是樱井医生";
    await chat.say(
      "请记住，我的牙医是樱井医生",
      [{ text: "记下了。" }],
      [
        {
          kind: "durable_fact",
          decision: "create",
          text: fact,
          classification: "private",
          confidence: 950,
          explicit: true,
          category: "health",
          quote: "请记住，我的牙医是樱井医生",
        },
      ],
    );
    await expect
      .poll(
        () => {
          const database = openQualifiedDatabase(databasePath);
          try {
            return database.prepare("SELECT count(*) AS made FROM memory_generations").get();
          } finally {
            database.close();
          }
        },
        { timeout: 30_000 },
      )
      .not.toEqual({ made: 0 });
    const quiet = await chat.read("quiet_hours.read");
    const opened = await chat.say("打开勿扰", [
      {
        tool: "settings_change",
        input: {
          setting: "quiet_hours.set",
          values: { enabled: true, start: "23:00", end: "07:00" },
        },
      },
      { text: "已打开勿扰。" },
    ]);
    expect(opened.results[0]).toMatchObject({
      tier: 1,
      confirmed: true,
      after: { enabled: true, start: "23:00", end: "07:00" },
    });
    const after = await chat.read("quiet_hours.read");
    expect(after).toMatchObject({ enabled: true, start: "23:00", end: "07:00" });
    expect(after["version"]).not.toBe(quiet["version"]);
    expect(settingsApprovals().filter((card) => card["status"] === "pending")).toEqual([]);
  } finally {
    chatReply = undefined;
    await service.stop();
  }
}, 180_000);

it("[ADR 0315][SET-2][reverse] 只问用法不改设置；改名先出同意卡片、移除设备卡片要 Face ID，没点同意什么都不变；不存在的设置和保险箱被拒绝", async () => {
  const service = await openInstalledMain();
  try {
    const chat = await settingsConversation(service);
    const asked = await chat.say("记忆功能怎么用？", [{ text: "记忆会自动记下你说过的事。" }]);
    expect(asked.results).toEqual([]);
    expect((await chat.read("memory.overview.read"))["capturePaused"]).toBe(false);

    const devices = (await chat.read("device.list.read"))["devices"] as {
      id: string;
      name: string;
    }[];
    const phone = devices[0];
    if (!phone) throw new Error("DEVICE_MISSING");
    const renamed = await chat.say("把这台手机改名叫小葵", [
      {
        tool: "settings_change",
        input: { setting: "device.rename", values: { deviceId: phone.id, name: "小葵" } },
      },
      { text: "等你同意。" },
    ]);
    expect(renamed.status).not.toBe("completed");
    const card = settingsApprovals().at(-1);
    expect(card).toMatchObject({
      status: "pending",
      recentAuthenticationRequired: false,
      display: { displayTitle: "改设置 · 给设备改名" },
    });
    const preview = String((card?.["display"] as { bodyPreview: string }).bodyPreview);
    expect(preview).toContain("小葵");
    expect(preview).not.toContain("expectedRevision");
    const named = (await chat.read("device.list.read"))["devices"] as { name: string }[];
    expect(named[0]?.name).toBe(phone.name);

    const detail = await chat.read("approval.detail", { approvalRequestId: card?.["id"] });
    await chat.approve(detail);
    await expect
      .poll(
        async () =>
          ((await chat.read("device.list.read"))["devices"] as { name: string }[])[0]?.name,
        { timeout: 30_000, interval: 200 },
      )
      .toBe("小葵");

    const removed = await chat.say("把这台手机移除", [
      {
        tool: "settings_change",
        input: { setting: "device.revoke", values: { deviceId: phone.id } },
      },
      { text: "等你确认。" },
    ]);
    expect(removed.status).not.toBe("completed");
    expect(settingsApprovals().at(-1)).toMatchObject({
      status: "pending",
      recentAuthenticationRequired: true,
      display: { displayTitle: "改设置 · 移除一台设备" },
    });
    expect(((await chat.read("device.list.read"))["devices"] as unknown[]).length).toBe(
      devices.length,
    );
  } finally {
    chatReply = undefined;
    await service.stop();
  }
}, 180_000);
