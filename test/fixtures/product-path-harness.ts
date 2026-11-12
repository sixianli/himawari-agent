import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  request as requestHttp,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { hostname, release } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PayloadRecord } from "@himawari-agent/application";
import { createAgentId, createDeploymentId, createOwnerId } from "@himawari-agent/domain";
import { SANDBOX_RUNTIME_VERSION } from "@himawari-agent/execution-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import {
  digestSandboxRuntime,
  EnvelopePayloadProtector,
  initializeStateRoot,
  RestrictedSecretFileSource,
  writeAuthorityFile,
} from "@himawari-agent/platform-node";
import { resolveReadOnlyToolchainPaths } from "@himawari-agent/testing/read-only-toolchain";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";
import Database from "better-sqlite3";
import { exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose";
import { ACCEPTANCE_SELECTABLE_MODELS } from "../../apps/control-center/test/release-walkthrough-models.ts";
import {
  buildProductPathConfiguration,
  PRODUCT_PATH_AUDIENCE,
  PRODUCT_PATH_CODING_TOOLS,
} from "./product-path-configuration.ts";
import { prepareProductPathTiming } from "./product-path-timing.ts";

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
const audience = PRODUCT_PATH_AUDIENCE;
const subject = "subject-product-path";
const bootstrapToken = "bootstrap-token-product-path";
const codingTools = PRODUCT_PATH_CODING_TOOLS;

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
      readonly streamMs?: number;
    }
  | {
      readonly kind: "tools";
      readonly calls: readonly {
        readonly name: string;
        readonly arguments: Record<string, unknown>;
      }[];
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

async function listen(server: HttpsServer | HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("PORT_UNAVAILABLE");
  return address.port;
}

async function close(server: HttpsServer | HttpServer | undefined): Promise<void> {
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

async function prepareProductPathBash(testRoot: string, runtimeRoot: string, logDirectory: string) {
  const fileHash = async (filename: string) =>
    createHash("sha256")
      .update(await readFile(filename))
      .digest("hex");
  const source = "/bin/bash";
  const candidate = path.join(testRoot, "test-bash");
  const installed = path.join(runtimeRoot, "pi-tools/bin/bash");
  const toolDirectory = path.dirname(installed);
  const tools: Array<{
    name: string;
    source: string;
    destination: string;
    sha256: string;
  }> = [];
  const commands: Array<{
    command: string;
    args: readonly string[];
    status: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
  }> = [];
  const checked = (command: string, args: readonly string[]) => {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 15_000 });
    commands.push({
      command,
      args,
      status: result.status,
      signal: result.signal,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    });
    if (result.status !== 0) throw new Error(`PRODUCT_PATH_BASH_UNAVAILABLE: ${command}`);
    return result.stdout;
  };
  const installTool = async (name: string, aliases: readonly string[]) => {
    const extra = process.env["HIMAWARI_TEST_PI_TOOLBIN"];
    let located: string | undefined;
    for (const alias of aliases) {
      if (extra) {
        const fromDirectory = path.join(extra, alias);
        if (
          await stat(fromDirectory).then(
            (info) => info.isFile(),
            () => false,
          )
        ) {
          located = fromDirectory;
          break;
        }
      }
      const found = spawnSync("which", [alias], { encoding: "utf8" });
      if (found.status === 0 && found.stdout.trim()) {
        located = found.stdout.trim();
        break;
      }
    }
    const resolved = await realpath(requireLocatedCodingTool(name, aliases, located));
    const destination = path.join(toolDirectory, name);
    await copyFile(resolved, destination);
    await chmod(destination, 0o755);
    tools.push({ name, source: resolved, destination, sha256: await fileHash(destination) });
  };
  const sourceSha256 = await fileHash(source);
  let installedSha256: string | null = null;
  try {
    await copyFile(source, candidate);
    await chmod(candidate, 0o755);
    if (process.platform === "darwin") checked("/usr/bin/codesign", ["-f", "-s", "-", candidate]);
    await mkdir(toolDirectory, { recursive: true });
    await copyFile(candidate, installed);
    await chmod(installed, 0o755);
    installedSha256 = await fileHash(installed);
    if (process.platform === "darwin") {
      checked("/usr/bin/codesign", ["-dv", "--verbose=2", installed]);
      checked("/usr/bin/codesign", ["--verify", "--verbose=2", installed]);
      checked("/usr/bin/otool", ["-L", installed]);
    }
    if (checked(installed, ["-c", "printf product-path-bash-ok"]) !== "product-path-bash-ok")
      throw new Error("PRODUCT_PATH_BASH_OUTPUT_INVALID");
    await installTool("rg", ["rg"]);
    await installTool("fd", ["fd", "fdfind"]);
  } finally {
    await writeFile(
      path.join(logDirectory, "bash-toolchain.json"),
      JSON.stringify(
        { source, sourceSha256, candidate, installed, installedSha256, tools, commands },
        null,
        2,
      ),
    );
  }
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
  delayNextEmbedding(milliseconds: number): void;
  readonly toolStreamStartedAt: number | null;
  setRunDeadline(milliseconds: number): Promise<void>;
  setCodingApproval(approval: "workspace_auto" | "ask"): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  crash(): Promise<void>;
  crashWorker(): Promise<void>;
  armDeliveryCrash(): Promise<void>;
  armPreparationFailure(count?: number): Promise<void>;
  armPreparationFinalHold(): Promise<void>;
  preparationFinalHold(): Promise<{
    pid: number;
    at: string;
    jobId: string;
    attemptId: string;
    directory: string;
    sha256: string;
    byteLength: number;
    hostForks: readonly unknown[];
  } | null>;
  releasePreparationFinalHold(): Promise<void>;
  armPreparationTransportFailure(legacyPlan?: boolean): Promise<void>;
  preparationTransportFailure(): Promise<unknown | null>;
  armPreparationAckLoss(): Promise<void>;
  preparationAckLoss(): Promise<{
    jobId: string;
    directory: string;
    acceptedBeforeAckLoss: boolean;
    hostForks: readonly unknown[];
  } | null>;
  armFinishGate(
    stage?:
      | "before-end"
      | "after-end"
      | "before-reset"
      | "after-reset"
      | "before-final"
      | "after-final"
      | "before-result"
      | "contradict-result"
      | "after-result",
  ): Promise<void>;
  finishGateEntered(): Promise<{ pid: number; at: string } | null>;
  releaseFinishGate(): Promise<void>;
  finishGateOutput(): Promise<string>;
  finishGateResultReceived(): Promise<string | null>;
  sandboxDelivery(runId: string, invocationId: string): Promise<unknown | null>;
  diagnose(runId: string): unknown;
  sandboxReservationAdministration(
    command: "inspect-reservation" | "confirm-reservation-cleanup",
    jobId: string,
    parameters?: readonly string[],
  ): Promise<{ code: number | null; output: string; error: string }>;
  deliveryCrashEntered(): Promise<{ jobId: string; runId: string } | null>;
  running(): boolean;
  close(): Promise<void>;
}

export function productPathToolchainPaths(input: {
  readonly platform: NodeJS.Platform;
  readonly runtimeRoot: string;
  readonly executable: string;
}): readonly string[] {
  return [
    input.runtimeRoot,
    input.executable,
    "/bin",
    "/usr/bin",
    "/usr/lib",
    ...(input.platform === "darwin"
      ? ["/System"]
      : ["/lib", "/lib64", "/proc", "/etc/ssl", "/etc/hosts"]),
    "/dev",
  ];
}

export function productPathSandboxCleanup(platform: NodeJS.Platform) {
  return {
    terminationMode: platform === "darwin" ? "best_effort" : "verified_tree",
    terminationEnforced: platform === "linux",
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
      ...(platform === "darwin"
        ? ["best_effort_stop"]
        : ["task_tree_termination", "worker_crash_cleanup"]),
    ],
    limitations: platform === "darwin" ? ["detached_descendants_may_survive_stop"] : [],
  };
}

export function productPathTemporaryPrefix(): string {
  const parent = testTemporaryRoot();
  if (process.env["HIMAWARI_TEST_TEMP_ROOT"] === undefined) return "/tmp/hma-pp-";
  const prefix = path.join(parent, "pp-");
  const installation = `${prefix}XXXXXX`;
  const controlSocket = path.join(
    installation,
    "jobs",
    `control-${"0".repeat(20)}`,
    "control.sock",
  );
  const sockets = [
    path.join(installation, "state/runtime/execution-admission.sock"),
    controlSocket,
    ...(process.platform === "linux"
      ? [
          path.join(
            installation,
            "jobs",
            `j${"0".repeat(43)}`,
            `claude-socks-${"0".repeat(16)}.sock`,
          ),
        ]
      : []),
  ];
  const maximumBytes = process.platform === "darwin" ? 103 : 107;
  for (const socket of sockets) {
    const bytes = Buffer.byteLength(socket);
    const limit = socket === controlSocket ? Math.min(100, maximumBytes) : maximumBytes;
    if (bytes > limit)
      throw new Error(
        `HIMAWARI_TEST_TEMP_ROOT socket path requires ${bytes} bytes; limit ${limit}: ${socket}`,
      );
  }
  return prefix;
}

export function requireLocatedCodingTool(
  name: string,
  aliases: readonly string[],
  located: string | undefined,
): string {
  if (!located)
    throw new Error(
      `PRODUCT_PATH_CODING_TOOL_UNAVAILABLE: ${name} (searched ${aliases.join(", ")})`,
    );
  return located;
}

const STARTUP_FAILURE_LOG_LIMIT = 5 * 1024 * 1024;

async function readFileOrEmpty(file: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
}

async function writeBoundedLog(destination: string, bytes: Buffer): Promise<void> {
  if (bytes.byteLength > STARTUP_FAILURE_LOG_LIMIT) {
    await writeFile(destination, bytes.subarray(bytes.byteLength - STARTUP_FAILURE_LOG_LIMIT));
    await writeFile(
      `${destination}.truncated.txt`,
      `已截断：原文件 ${bytes.byteLength} 字节，只保留最后 ${STARTUP_FAILURE_LOG_LIMIT} 字节。\n`,
    );
    return;
  }
  await writeFile(destination, bytes);
}

async function saveStartupFailureLogs(input: {
  readonly evidenceDirectory: string;
  readonly logDirectory: string;
  readonly label: string;
}): Promise<void> {
  await mkdir(input.evidenceDirectory, { recursive: true });
  const names = await readdir(input.logDirectory);
  const joinNumbered = async (prefix: string) => {
    const selected = names
      .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".log"))
      .sort((left, right) => {
        const leftGeneration = Number(left.slice(prefix.length + 1, -".log".length));
        const rightGeneration = Number(right.slice(prefix.length + 1, -".log".length));
        return leftGeneration - rightGeneration;
      });
    const parts: Buffer[] = [];
    for (const name of selected) {
      const generation = name.slice(prefix.length + 1, -".log".length);
      parts.push(Buffer.from(`--- generation ${generation} ---\n`));
      const body = await readFileOrEmpty(path.join(input.logDirectory, name));
      parts.push(body);
      if (body.byteLength > 0 && body[body.byteLength - 1] !== 10) parts.push(Buffer.from("\n"));
    }
    return Buffer.concat(parts);
  };
  await writeBoundedLog(
    path.join(input.evidenceDirectory, `${input.label}.job-host-stderr.txt`),
    await joinNumbered("job-host-stderr"),
  );
  await writeBoundedLog(
    path.join(input.evidenceDirectory, `${input.label}.worker-stderr.txt`),
    await joinNumbered("worker-stderr"),
  );
  const failed: string[] = [];
  const agentLogs = names
    .filter((entry) => entry.startsWith("agent-") && entry.endsWith(".log"))
    .sort();
  for (const name of agentLogs) {
    const text = (await readFileOrEmpty(path.join(input.logDirectory, name))).toString("utf8");
    for (const line of text.split("\n")) {
      if (line.includes('"event":"sandbox.preparation.failed"')) failed.push(line);
    }
  }
  await writeBoundedLog(
    path.join(input.evidenceDirectory, `${input.label}.sandbox-preparation-failed.log`),
    Buffer.from(failed.length === 0 ? "" : `${failed.join("\n")}\n`),
  );
}

export function assertLoopbackMagpieUrl(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/v1"
  )
    throw new Error("REAL_MAGPIE_MUST_BE_LOOPBACK");
}

export async function installProductPath(options: {
  readonly artifact: string;
  readonly context: string;
  readonly logDirectory: string;
  readonly timing?: boolean;
  readonly sourceRoot?: string;
  readonly approval?: "workspace_auto" | "ask";
  readonly webSearch?: boolean;
  readonly selectableModels?: boolean;
  readonly realMagpie?: { readonly url: string; readonly keyFile: string };
}): Promise<ProductPathInstallation> {
  if (options.realMagpie) assertLoopbackMagpieUrl(options.realMagpie.url);
  const testRoot = await realpath(await mkdtemp(productPathTemporaryPrefix()));
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
  const recordHostIdentity = async (phase: string, generation: number) => {
    const encoded = await readFile(
      path.join(stateRoot, ".himawari-state-root.lock", "owner.json"),
      "utf8",
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const owner = encoded === null ? null : (JSON.parse(encoded) as Record<string, unknown>);
    await appendFile(
      path.join(options.logDirectory, "host-identity.jsonl"),
      `${JSON.stringify({
        at: new Date().toISOString(),
        phase,
        generation,
        testRoot,
        observerPid: process.pid,
        hostname: hostname(),
        lock: owner === null ? null : { host: owner["host"], pid: owner["pid"] },
      })}\n`,
    );
  };
  await recordHostIdentity("installation-before", 0);
  const certificates = await createCertificates(testRoot);
  const keyPair = await generateKeyPair("RS256", { extractable: true });
  const jwks: JSONWebKeySet = {
    keys: [{ ...(await exportJWK(keyPair.publicKey)), kid: "product-path-key", alg: "RS256" }],
  };

  let modelScript: ModelScript = () => ({ kind: "text", text: "默认回答" });
  let embeddingAvailable = true;
  let nextEmbeddingDelayMs = 0;
  let toolStreamStartedAt: number | null = null;
  const modelRequests: ModelRequest[] = [];
  let providerPort = 0;
  let appPort = 0;
  const issuer = () => `https://127.0.0.1:${providerPort}`;
  const handleProvider = (request: IncomingMessage, response: ServerResponse) => {
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
    const received: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      received.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(received).toString("utf8");
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
        const delayMs = nextEmbeddingDelayMs;
        nextEmbeddingDelayMs = 0;
        const answer = () => {
          if (response.destroyed) return;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              object: "list",
              model: body["model"],
              data: [
                {
                  object: "embedding",
                  index: 0,
                  embedding: Array(Number(body["dimensions"])).fill(0.1),
                },
              ],
              usage: { prompt_tokens: 8, total_tokens: 8 },
              providerMetadata: {
                gateway: {
                  generationId: `embedding-${modelRequests.length}`,
                  routing: { finalProvider: "deepinfra" },
                  cost: "0",
                },
              },
            }),
          );
        };
        if (delayMs > 0) setTimeout(answer, delayMs);
        else answer();
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
      const provider_metadata = {
        gateway: {
          generationId: `generation-${modelRequests.length}`,
          routing: { finalProvider: "morph" },
          cost: "0",
        },
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
      if (reply.kind === "tool" && reply.streamMs) {
        const id = `call-${modelRequests.length}-0`;
        const argumentsText = JSON.stringify(reply.arguments);
        const pieces = 40;
        const size = Math.ceil(argumentsText.length / pieces);
        const chunk = (delta: object, finish: string | null, extra: object = {}) =>
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          chunk(
            {
              role: "assistant",
              tool_calls: [
                { index: 0, id, type: "function", function: { name: reply.name, arguments: "" } },
              ],
            },
            null,
          ),
        );
        toolStreamStartedAt = Date.now();
        let sent = 0;
        const timer = setInterval(() => {
          if (response.destroyed) return clearInterval(timer);
          const piece = argumentsText.slice(sent * size, (sent + 1) * size);
          sent += 1;
          if (piece)
            response.write(
              chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }, null),
            );
          if (sent < pieces) return;
          clearInterval(timer);
          response.write(chunk({ provider_metadata }, "tool_calls", { usage }));
          response.end("data: [DONE]\n\n");
        }, reply.streamMs / pieces);
        return;
      }
      if (reply.kind === "tool" || reply.kind === "tools") {
        const calls = reply.kind === "tool" ? [reply] : reply.calls;
        sse(response, [
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: calls.map((call, index) => ({
                    index,
                    id: `call-${modelRequests.length}-${index}`,
                    type: "function",
                    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                  })),
                },
                finish_reason: null,
              },
            ],
          },
          {
            ...base,
            choices: [{ index: 0, delta: { provider_metadata }, finish_reason: "tool_calls" }],
            usage,
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
            choices: [{ index: 0, delta: { provider_metadata }, finish_reason: "stop" }],
            usage,
          },
        ]);
      if (reply.delayMs) setTimeout(finish, reply.delayMs);
      else finish();
    });
  };
  const provider = createHttpsServer(
    {
      cert: await readFile(certificates.provider.cert),
      key: await readFile(certificates.provider.key),
    },
    handleProvider,
  );
  providerPort = await listen(provider);
  const catalog = options.selectableModels
    ? createHttpServer((request, response) => {
        if (!(request.method === "GET" && request.url === "/v1/models")) {
          handleProvider(request, response);
          return;
        }
        const listed = (id: string, label: string) => ({
          id,
          object: "model",
          type: "model",
          display_name: label,
          magpie_label: label,
          context_window: 32768,
          context_length: 32768,
          max_input_tokens: 32768,
          max_output_tokens: 2048,
          modalities: { input: ["text"], output: ["text"] },
          reasoning: false,
          tool_call: true,
        });
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
      })
    : undefined;
  const catalogPort = catalog ? await listen(catalog) : 0;
  const magpieUrl = options.realMagpie
    ? options.realMagpie.url
    : catalog
      ? `http://127.0.0.1:${catalogPort}/v1`
      : undefined;

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
  const writeListenerPorts = () =>
    writeFile(
      path.join(options.logDirectory, "listener-ports.json"),
      JSON.stringify({ appPort, providerPort, frontPort }),
    );

  const installEnv = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" };
  if (options.sourceRoot) {
    run(
      process.execPath,
      [
        path.join(repositoryRoot, "test/fixtures/product-path-install.mjs"),
        runtimePrefix,
        options.artifact,
        options.context,
        options.sourceRoot,
      ],
      {
        ...installEnv,
        GIT_DIR: path.join(repositoryRoot, ".git"),
        GIT_WORK_TREE: options.sourceRoot,
      },
      testRoot,
    );
  } else {
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
  }
  run("tar", ["-xzf", options.artifact, "-C", testRoot, "browser"], installEnv, testRoot);
  const runtimeRoot = path.join(runtimePrefix, "lib/himawari-agent");
  await prepareProductPathBash(testRoot, runtimeRoot, options.logDirectory);

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
    [
      "vercel-ai-gateway-api-key.v1",
      options.realMagpie
        ? (await readFile(options.realMagpie.keyFile, "utf8")).trim()
        : "local-provider-fixture",
    ],
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
      webSearch: options.webSearch === true,
    });
  const capabilityDeployment = await qualifyCapabilities();

  const configuration = buildProductPathConfiguration({
    deploymentId,
    ownerId,
    agentId,
    stateRoot,
    runtimeDirectory: layout.runtime,
    publicOrigin,
    staticRoot,
    issuer: issuer(),
    hostId,
    workerInstanceId,
    grantId,
    capabilityDeployment,
    approval: options.approval,
    webSearch: options.webSearch,
    modelCatalogUrl: magpieUrl,
  });
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

  const timingManifest = path.join(testRoot, "timing-manifest.json");
  const timingHook = path.join(repositoryRoot, "test/fixtures/product-path-timing-hook.mjs");
  if (options.timing) await prepareProductPathTiming(runtimeRoot, timingManifest);
  const serviceEnv = {
    ...process.env,
    NODE_PATH: "",
    NODE_OPTIONS: "",
    NODE_EXTRA_CA_CERTS: certificates.ca,
    ...(options.timing
      ? {
          HIMAWARI_TEST_TIMING_MANIFEST: timingManifest,
          HIMAWARI_TEST_TIMING_OUTPUT: path.join(options.logDirectory, "tool-timing.jsonl"),
        }
      : {}),
    HIMAWARI_TEST_RUNTIME_ROOT: runtimeRoot,
    HIMAWARI_TEST_CONFIGURATION: configurationPath,
    HIMAWARI_TEST_SECRET_DIRECTORY: secretDirectory,
    HIMAWARI_TEST_DELIVERY_CRASH: path.join(testRoot, "delivery-crash"),
    HIMAWARI_TEST_PREPARATION_FAILURE: path.join(testRoot, "preparation-failure"),
    HIMAWARI_TEST_PREPARATION_FINAL_GATE: path.join(testRoot, "preparation-final-gate"),
    HIMAWARI_TEST_PREPARATION_TRANSPORT_FAILURE: path.join(
      testRoot,
      "preparation-transport-failure",
    ),
    HIMAWARI_TEST_PREPARATION_ACK_LOSS: path.join(testRoot, "preparation-ack-loss"),
    HIMAWARI_TEST_HOST_FINISH_GATE: path.join(testRoot, "host-finish-gate"),
    HIMAWARI_TEST_MODEL_URL: `https://127.0.0.1:${providerPort}/v1`,
    ...(magpieUrl ? { HIMAWARI_TEST_MAGPIE_URL: magpieUrl } : {}),
    HIMAWARI_TEST_JOB_HOST_STDERR: path.join(options.logDirectory, "job-host-stderr-0.log"),
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
  const { createWriteStream } = await import("node:fs");
  const streams: Array<ReturnType<typeof createWriteStream>> = [];
  const waitStreams = async () => {
    await Promise.all(
      streams.map(
        (stream) =>
          new Promise<void>((resolve) => {
            if (stream.closed) {
              resolve();
              return;
            }
            const timer = setTimeout(() => {
              if (stream.closed) {
                resolve();
                return;
              }
              stream.end(() => resolve());
            }, 1000);
            stream.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
          }),
      ),
    );
  };
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
  const logTo = (name: string, child: ChildProcessWithoutNullStreams) => {
    const stream = createWriteStream(path.join(options.logDirectory, `${name}-${generation}.log`), {
      flags: "a",
    });
    streams.push(stream);
    child.stdout.pipe(stream);
    child.stderr.pipe(stream);
    if (name === "worker") {
      const errStream = createWriteStream(
        path.join(options.logDirectory, `worker-stderr-${generation}.log`),
        { flags: "a" },
      );
      streams.push(errStream);
      child.stderr.pipe(errStream);
    }
  };

  let bootstrapped = false;
  const startServices = async () => {
    if (processes) throw new Error("PRODUCT_PATH_ALREADY_RUNNING");
    if (generation > 0) {
      configuration.capabilityDeployment = await qualifyCapabilities();
      await writeFile(configurationPath, JSON.stringify(configuration), { mode: 0o600 });
    }
    generation += 1;
    const jobHostStderr = path.join(options.logDirectory, `job-host-stderr-${generation}.log`);
    serviceEnv.HIMAWARI_TEST_JOB_HOST_STDERR = jobHostStderr;
    await writeFile(jobHostStderr, "", { flag: "a" });
    await writeFile(path.join(options.logDirectory, `worker-stderr-${generation}.log`), "", {
      flag: "a",
    });
    const main = spawn(
      process.execPath,
      [
        "--no-global-search-paths",
        ...(options.timing ? ["--import", timingHook] : []),
        path.join(repositoryRoot, "test/fixtures/production-service-main-child.mjs"),
        ...serviceArgs,
      ],
      { cwd: testRoot, stdio: ["pipe", "pipe", "pipe"], env: serviceEnv },
    );
    const worker = spawn(
      process.execPath,
      [
        "--no-global-search-paths",
        "--import",
        path.join(repositoryRoot, "test/fixtures/product-path-preparation-hook.mjs"),
        ...(options.timing ? ["--import", timingHook] : []),
        path.join(runtimeRoot, "node_modules/@himawari-agent/execution-worker/dist/main.js"),
        ...serviceArgs,
      ],
      {
        cwd: testRoot,
        stdio: ["pipe", "pipe", "pipe"],
        env: serviceEnv,
      },
    );
    processes = { main, worker };
    logTo("agent", main);
    logTo("worker", worker);
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("PRODUCT_PATH_READY_TIMEOUT")), 60_000);
      main.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const line = output
          .split("\n")
          .find((candidate) => candidate.startsWith("HIMAWARI_PRODUCTION_HTTP_READY "));
        if (line) {
          clearTimeout(timer);
          const ready = JSON.parse(line.slice("HIMAWARI_PRODUCTION_HTTP_READY ".length));
          const port = new URL(ready.address).port;
          if (!port) reject(new Error("PRODUCT_PATH_READY_PORT_MISSING"));
          else {
            appPort = Number(port);
            resolve();
          }
        }
      });
      main.once("exit", (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`PRODUCT_PATH_MAIN_EXITED:${code ?? signal}`));
      });
    });
    await writeListenerPorts();
    if (!bootstrapped) {
      const assertion = await signAssertion();
      const body = JSON.stringify({ token: bootstrapToken, ownerId, assertionToken: assertion });
      const status = await new Promise<number>((resolve, reject) => {
        const outgoing = requestHttp(
          {
            host: "127.0.0.1",
            port: appPort,
            method: "POST",
            path: "/bootstrap",
            headers: {
              host: publicHost,
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            },
          },
          (answer) => {
            answer.resume();
            resolve(answer.statusCode ?? 0);
          },
        );
        outgoing.once("error", reject);
        outgoing.end(body);
      });
      if (status !== 201) throw new Error(`PRODUCT_PATH_BOOTSTRAP_FAILED:${status}`);
      bootstrapped = true;
    }
  };
  const start = async () => {
    const nextGeneration = generation + 1;
    await recordHostIdentity("start-before", nextGeneration);
    try {
      await startServices();
      await recordHostIdentity("start-ready", nextGeneration);
    } catch (error) {
      await recordHostIdentity("start-failed", nextGeneration);
      throw error;
    }
  };
  const stop = async () => {
    const current = processes;
    processes = undefined;
    if (!current) return;
    await terminate(current.main);
    await terminate(current.worker);
  };

  await recordHostIdentity("installation-after", 0);
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
    delayNextEmbedding: (milliseconds) => {
      nextEmbeddingDelayMs = milliseconds;
    },
    get toolStreamStartedAt() {
      return toolStreamStartedAt;
    },
    setRunDeadline: async (milliseconds) => {
      if (processes || !Number.isSafeInteger(milliseconds) || milliseconds < 1000)
        throw new Error("PRODUCT_PATH_DEADLINE_CONFIGURATION_INVALID");
      configuration.deadlines.runMs = milliseconds;
      await writeFile(configurationPath, JSON.stringify(configuration), { mode: 0o600 });
    },
    setCodingApproval: async (approval) => {
      if (processes || (approval !== "workspace_auto" && approval !== "ask"))
        throw new Error("PRODUCT_PATH_APPROVAL_CONFIGURATION_INVALID");
      configuration.runPolicy.coding.approval = approval;
      await writeFile(configurationPath, JSON.stringify(configuration), { mode: 0o600 });
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
    crashWorker: async () => {
      const current = processes;
      if (!current || !alive(current.main)) throw new Error("PRODUCT_PATH_NOT_RUNNING");
      current.worker.kill("SIGKILL");
      if (!(await exited(current.worker, 5000)))
        throw new Error("PRODUCT_PATH_WORKER_CRASH_TIMEOUT");
    },
    armPreparationAckLoss: async () => {
      const gate = serviceEnv.HIMAWARI_TEST_PREPARATION_ACK_LOSS;
      for (const suffix of [".entered", ".consumed", ".hosts.jsonl"])
        await rm(`${gate}${suffix}`, { force: true });
      await writeFile(gate, "armed");
    },
    preparationAckLoss: async () => {
      const gate = serviceEnv.HIMAWARI_TEST_PREPARATION_ACK_LOSS;
      const entered = await readFile(`${gate}.entered`, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (entered === null) return null;
      const hosts = await readFile(`${gate}.hosts.jsonl`, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        },
      );
      return {
        ...JSON.parse(entered),
        hostForks: hosts
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      };
    },
    armPreparationTransportFailure: async (legacyPlan = false) => {
      await writeFile(
        serviceEnv.HIMAWARI_TEST_PREPARATION_TRANSPORT_FAILURE,
        legacyPlan ? "legacy" : "armed",
      );
    },
    preparationTransportFailure: async () =>
      readFile(`${serviceEnv.HIMAWARI_TEST_PREPARATION_TRANSPORT_FAILURE}.entered`, "utf8").then(
        (text) => JSON.parse(text),
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      ),
    armPreparationFailure: async (count = 1) => {
      await writeFile(
        serviceEnv.HIMAWARI_TEST_PREPARATION_FAILURE,
        count > 1 ? String(count) : "armed",
      );
    },
    armPreparationFinalHold: async () => {
      const gate = serviceEnv.HIMAWARI_TEST_PREPARATION_FINAL_GATE;
      for (const suffix of [".entered", ".entered.pending", ".consumed", ".hosts.jsonl"])
        await rm(`${gate}${suffix}`, { force: true });
      await writeFile(gate, "armed", { mode: 0o600 });
      await writeFile(serviceEnv.HIMAWARI_TEST_PREPARATION_FAILURE, "armed");
    },
    preparationFinalHold: async () => {
      const gate = serviceEnv.HIMAWARI_TEST_PREPARATION_FINAL_GATE;
      const entered = await readFile(`${gate}.entered`, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      );
      if (entered === null) return null;
      const hosts = await readFile(`${gate}.hosts.jsonl`, "utf8");
      return {
        ...JSON.parse(entered),
        hostForks: hosts
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      };
    },
    releasePreparationFinalHold: async () => {
      const entered = JSON.parse(
        await readFile(`${serviceEnv.HIMAWARI_TEST_PREPARATION_FINAL_GATE}.entered`, "utf8"),
      ) as { directory: string; sha256: string; byteLength: number };
      const directory = await realpath(entered.directory);
      if (path.dirname(directory) !== jobsRoot)
        throw new Error("PRODUCT_PATH_PREPARATION_FINAL_DIRECTORY_INVALID");
      const heldPath = path.join(directory, "final-held.json");
      const bytes = await readFile(heldPath);
      if (
        bytes.byteLength !== entered.byteLength ||
        createHash("sha256").update(bytes).digest("hex") !== entered.sha256
      )
        throw new Error("PRODUCT_PATH_PREPARATION_FINAL_BYTES_CHANGED");
      await rename(heldPath, path.join(directory, "final.json"));
    },
    armFinishGate: async (stage = "after-reset") => {
      const gate = serviceEnv.HIMAWARI_TEST_HOST_FINISH_GATE;
      for (const suffix of [
        ".entered",
        ".released",
        ".output.jsonl",
        ".consumed",
        ".result-received",
      ])
        await rm(`${gate}${suffix}`, { force: true });
      await writeFile(gate, stage);
    },
    finishGateEntered: async () =>
      readFile(`${serviceEnv.HIMAWARI_TEST_HOST_FINISH_GATE}.entered`, "utf8").then(
        (text) => JSON.parse(text),
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      ),
    releaseFinishGate: async () => {
      await writeFile(`${serviceEnv.HIMAWARI_TEST_HOST_FINISH_GATE}.released`, "released");
    },
    finishGateResultReceived: async () =>
      readFile(`${serviceEnv.HIMAWARI_TEST_HOST_FINISH_GATE}.result-received`, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        },
      ),
    finishGateOutput: async () => {
      const lines = await readFile(
        `${serviceEnv.HIMAWARI_TEST_HOST_FINISH_GATE}.output.jsonl`,
        "utf8",
      );
      return lines
        .trim()
        .split("\n")
        .map((line) => Buffer.from(JSON.parse(line).bytes, "base64").toString("utf8"))
        .join("");
    },
    sandboxDelivery: async (runId, invocationId) => {
      if (!invocationId.startsWith("runtime-tool:")) throw new Error("TEST_INVOCATION_REQUIRED");
      const database = new Database(databasePath, { readonly: true });
      try {
        const row = database
          .prepare(`SELECT a.created_at AS acceptedAt, p.ref,
          p.classification AS dataClassification, p.content_type AS contentType, p.ciphertext,
          p.encryption_metadata_json AS encryption, p.content_digest AS contentDigest, p.created_at AS createdAt
          FROM run_payload_artifacts a JOIN payloads p ON p.owner_id=a.owner_id AND p.agent_id=a.agent_id AND p.ref=a.payload_ref
          WHERE a.owner_id=? AND a.agent_id=? AND a.run_id=? AND a.purpose='trace' AND a.operation_key=?
        `)
          .get(
            ownerId,
            agentId,
            runId,
            `runtime-sandbox-delivery:${invocationId.slice("runtime-tool:".length)}`,
          ) as
          | (Omit<PayloadRecord, "encryption"> & { encryption: string; acceptedAt: string })
          | undefined;
        if (!row) return null;
        const protector = new EnvelopePayloadProtector({
          keys: new RestrictedSecretFileSource(secretDirectory),
          activeKey: { keyRef: "payload-kek", kekVersion: "v1", dekVersion: "dek-v1" },
        });
        const plaintext = await protector.unprotect({
          ownerId: createOwnerId(ownerId),
          agentId: createAgentId(agentId),
          payload: { ...row, encryption: JSON.parse(row.encryption) },
        });
        return {
          acceptedAt: row.acceptedAt,
          content: JSON.parse(Buffer.from(plaintext).toString("utf8")),
        };
      } finally {
        database.close();
      }
    },
    diagnose: (runId) =>
      JSON.parse(
        run(
          path.join(runtimePrefix, "bin/himawari"),
          [
            "diagnose",
            "run",
            "--config",
            configurationPath,
            "--secret-dir",
            secretDirectory,
            "--run",
            runId,
          ],
          serviceEnv,
          testRoot,
        ),
      ),
    sandboxReservationAdministration: async (command, jobId, parameters = []) => {
      const args = [
        "sandbox",
        command,
        "--config",
        configurationPath,
        "--job",
        jobId,
        ...parameters,
      ];
      const result = spawnSync(cli, args, {
        cwd: testRoot,
        env: serviceEnv,
        encoding: "utf8",
        timeout: 10_000,
      });
      if (result.error) throw result.error;
      const record = { code: result.status, output: result.stdout, error: result.stderr };
      await appendFile(
        path.join(options.logDirectory, "sandbox-reservation-administration.jsonl"),
        `${JSON.stringify({ at: new Date().toISOString(), args, ...record })}\n`,
      );
      return record;
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
      await waitStreams();
      const evidenceDirectory =
        process.env["HIMAWARI_PRODUCT_PATH_EVIDENCE"] ?? options.logDirectory;
      const logLabel = [
        path.basename(path.dirname(options.logDirectory)),
        path.basename(options.logDirectory),
      ].join("-");
      await saveStartupFailureLogs({
        evidenceDirectory,
        logDirectory: options.logDirectory,
        label: logLabel,
      });
      for (const suffix of ["", "-wal", "-shm"])
        await copyFile(
          `${databasePath}${suffix}`,
          path.join(options.logDirectory, `product.sqlite${suffix}`),
        ).catch(() => undefined);
      await close(front);
      await close(provider);
      await close(catalog);
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
  readonly webSearch: boolean;
}) {
  const fileHash = async (filename: string) =>
    createHash("sha256")
      .update(await readFile(filename))
      .digest("hex");
  const runtimeRoot = await realpath(input.runtimeRoot);
  const executable = await realpath(process.execPath);
  const runtimeDigest = await digestSandboxRuntime(runtimeRoot);
  const metadata = await stat(input.workspace);
  const now = new Date().toISOString();
  const supportedExecutions = [{ schemaVersion: "sandbox-execution.v2", mode: "foreground" }];
  const readOnlyToolchainPaths = await resolveReadOnlyToolchainPaths(
    productPathToolchainPaths({ platform: process.platform, runtimeRoot, executable }),
  );
  const evidenceDigest = createHash("sha256")
    .update("product-path-test-qualification-not-production")
    .digest("hex");
  const cleanup = productPathSandboxCleanup(process.platform);
  const webNetwork = ["mcp.exa.ai:443"];
  const webOperation = (operation: string, contractRef: string) => ({
    operation,
    mode: "foreground",
    contract: { ref: contractRef, version: "1", kind: "network_only" },
    backendRef: "srt",
    scopeSource: "private_temp",
    directoryOperations: [],
    network: "grant_targets",
  });
  const programs = [
    {
      capabilityRef: "himawari.pi-coding",
      displayName: "产品路径测试 Pi 文件工具",
      runnerFile: "pi-coding-main.js",
      network: [] as string[],
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
          operation === "write" || operation === "bash"
            ? ["read", "create", "update"]
            : operation === "edit"
              ? ["read", "update"]
              : ["read"],
        network: "disabled",
      })),
    },
    ...(input.webSearch
      ? [
          {
            capabilityRef: "himawari.public-search",
            displayName: "产品路径测试公开网页搜索",
            runnerFile: "web-search-main.js",
            network: webNetwork,
            operationBindings: [webOperation("web_search", "public-web-search")],
          },
          {
            capabilityRef: "himawari.public-fetch",
            displayName: "产品路径测试公开网页读取",
            runnerFile: "web-fetch-main.js",
            network: webNetwork,
            operationBindings: [webOperation("web_fetch", "public-web-fetch")],
          },
        ]
      : []),
  ];
  const capabilities = [];
  for (const program of programs) {
    const runner = path.join(
      runtimeRoot,
      "node_modules/@himawari-agent/agent-service/dist/capability-programs",
      program.runnerFile,
    );
    const runnerDigest = await fileHash(runner);
    const artifactDigest = `sha256:${runnerDigest}`;
    const binding = {
      schemaVersion: "sandbox-host-binding.v1",
      capabilityRef: program.capabilityRef,
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
      readOnlyToolchainPaths,
      protectedPaths: [...input.protectedPaths],
      allowedDomains: program.network,
      maximumResourceCeiling: {
        maxWallTimeMs: 300_000,
        maxCpuTimeMs: 30_000,
        maxMemoryBytes: 536_870_912,
        maxOutputBytes: 524_288,
        maxProgressEvents: 256,
      },
      supportedExecutions,
      operationBindings: program.operationBindings,
    };
    const sandbox = {
      schemaVersion: "sandbox-runtime-qualification.v1",
      qualificationRef: `product-path:${evidenceDigest}`,
      hostId,
      profileRef: binding.profileRef,
      srtVersion: SANDBOX_RUNTIME_VERSION,
      platform: process.platform,
      architecture: process.arch,
      osRelease: release(),
      runtimeDigest,
      runnerDigest,
      evidenceDigest,
      resourceMode: "observe_and_stop",
      terminationMode: cleanup.terminationMode,
      guarantees: cleanup.guarantees,
      limitations: cleanup.limitations,
      supportedExecutions,
    };
    const manifest = {
      manifestVersion: "capability.v2",
      ref: binding.capabilityRef,
      displayName: program.displayName,
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
      operations: program.operationBindings.map((entry) => entry.operation),
      permissionRefs: [],
      isolation: "sandbox",
      scopes: {
        dataClassifications: ["public", "private"],
        network: program.network,
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
        network: program.network,
        filesystem: ["workspace:product-path"],
      },
    };
    capabilities.push({
      manifest,
      binding: { kind: "sandbox", value: binding },
      qualification: {
        qualificationVersion: "capability-runtime-qualification.v1",
        platform: process.platform,
        runtimeIdentity: `srt:${SANDBOX_RUNTIME_VERSION}`,
        productionSuitable: true,
        artifactDigest,
        enforcement: {
          filesystem: true,
          network: true,
          processes: true,
          secrets: true,
          resourceCeilings: false,
          termination: cleanup.terminationEnforced,
        },
        reasonCodes: [],
        checkedAt: now,
        sandbox,
      },
    });
  }
  const snapshot = { schemaVersion: "capability-deployment.v1", capabilities };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  await writeFile(input.snapshotPath, bytes, { mode: 0o600 });
  return {
    snapshotPath: input.snapshotPath,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}
