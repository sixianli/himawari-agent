import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createTcpServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createTlsServer, connect as tlsConnect } from "node:tls";
import { ExecutionLiveFeed } from "@himawari-agent/application";
import type { PiModelBindingPort } from "@himawari-agent/runtime-pi";
import {
  createReferenceAdapterSet,
  ManualClock,
  ScriptedWorkerRunPort,
  testModelEgress,
} from "@himawari-agent/testing";
import { createProductionRunComposition } from "../../apps/agent-service/src/production-run-composition.ts";
import {
  agentId,
  authority,
  authorityLease,
  type Harness,
  harness,
  ownerId,
  pairingCode,
  web,
} from "../fixtures/device-api-harness.ts";
import { ANSWER_ENDING, ANSWER_OPENING, e2eAnswer, LONG_REQUEST } from "./answers.ts";

class LiveClock extends ManualClock {
  override now(): string {
    return new Date().toISOString();
  }
}

export interface E2eBackend {
  readonly origin: string;
  readonly controlOrigin: string;
  readonly caPath: string;
  close(): Promise<void>;
}

const SYSTEM_REF = "ios-e2e-system";
const ANSWER_TOKENS_PER_SECOND = 4;

function openssl(args: readonly string[]) {
  const result = spawnSync("openssl", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`IOS_E2E_OPENSSL_FAILED ${result.stderr}`);
}

function note(line: string) {
  process.stdout.write(`IOS_E2E_${line} at=${new Date().toISOString()}\n`);
}

function gatewayType(body: unknown): string {
  let parsed = body;
  if (Buffer.isBuffer(body) || typeof body === "string") {
    try {
      parsed = JSON.parse(body.toString());
    } catch {
      return "";
    }
  }
  const type = (parsed as { type?: unknown } | undefined)?.type;
  return typeof type === "string" ? ` ${type}` : "";
}

async function certificates(root: string) {
  const ca = { key: path.join(root, "ca-key.pem"), cert: path.join(root, "ca.pem") };
  openssl([
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
    "2",
    "-subj",
    "/CN=Himawari iOS E2E CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  const key = path.join(root, "leaf-key.pem");
  const csr = path.join(root, "leaf.csr");
  const cert = path.join(root, "leaf.pem");
  const ext = path.join(root, "leaf.ext");
  await writeFile(
    ext,
    "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n",
  );
  openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    csr,
    "-subj",
    "/CN=localhost",
  ]);
  openssl([
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    ca.cert,
    "-CAkey",
    ca.key,
    "-CAcreateserial",
    "-out",
    cert,
    "-days",
    "2",
    "-extfile",
    ext,
  ]);
  return { caPath: ca.cert, key: await readFile(key), cert: await readFile(cert) };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function fauxModel(): Promise<{ models: PiModelBindingPort; descriptor: never }> {
  const ai = (await import("@earendil-works/pi-ai")) as unknown as {
    InMemoryCredentialStore: new () => unknown;
    fauxProvider(options: { tokensPerSecond: number; tokenSize: { min: number; max: number } }): {
      provider: unknown;
      getModel(): unknown;
      setResponses(responses: readonly unknown[]): void;
    };
    fauxAssistantMessage(content: unknown): unknown;
  };
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const faux = ai.fauxProvider({
    tokensPerSecond: ANSWER_TOKENS_PER_SECOND,
    tokenSize: { min: 1, max: 2 },
  });
  const respond = (context: unknown) => ai.fauxAssistantMessage(e2eAnswer(lastOwnerText(context)));
  const refill = () => faux.setResponses(Array.from({ length: 500 }, () => respond));
  refill();
  setInterval(refill, 600_000).unref();
  const runtime = await ModelRuntime.create({
    credentials: new ai.InMemoryCredentialStore() as never,
    refreshOnCreate: false,
    modelsPath: null,
  });
  runtime.registerNativeProvider(faux.provider as never);
  const descriptor = {
    ref: "ios-e2e-local",
    provider: "faux",
    model: "faux-1",
    version: "1.0.0-ios-e2e",
    routingClass: "local",
    priority: 1,
    disclosure: "local_only",
    capabilities: ["text", "tool_calling"],
    allowedDataClassifications: ["private"],
    secretRequirement: null,
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    estimatedCostMicros: 1,
  };
  const models: PiModelBindingPort = {
    resolve: async (ref) => {
      if (ref !== descriptor.ref) throw new Error("IOS_E2E_UNKNOWN_MODEL");
      return {
        model: faux.getModel(),
        modelRuntime: runtime,
        descriptor,
        admissionCost: { pricing: descriptor.pricing, estimatedCostMicros: 1 },
      } as never;
    },
  };
  return { models, descriptor: descriptor as never };
}

export function lastOwnerText(context: unknown): string {
  const messages = (context as { messages?: readonly { role?: string; content?: unknown }[] })
    .messages;
  const owner = [...(messages ?? [])].reverse().find((message) => message.role === "user");
  const content = owner?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              part && typeof part === "object" && "text" in part ? String(part.text) : "",
            )
            .join("")
        : "";
  const spoken = [...text.matchAll(/<owner-message[^>]*>\n?([\s\S]*?)\n?<\/owner-message>/gu)].at(
    -1,
  );
  return spoken?.[1] ?? text;
}

class SwitchableFront {
  readonly #sockets = new Set<Socket>();
  #server: Server | undefined;
  #online = true;

  readonly #port: number;
  readonly #target: number;
  readonly #tls: { key: Buffer; cert: Buffer };

  constructor(port: number, target: number, tls: { key: Buffer; cert: Buffer }) {
    this.#port = port;
    this.#target = target;
    this.#tls = tls;
  }

  get online() {
    return this.#online;
  }

  async start() {
    this.#online = true;
    const server = createTlsServer({ key: this.#tls.key, cert: this.#tls.cert }, (client) => {
      const upstream = connect(this.#target, "127.0.0.1");
      this.#sockets.add(client);
      this.#sockets.add(upstream);
      const forget = () => {
        this.#sockets.delete(client);
        this.#sockets.delete(upstream);
        client.destroy();
        upstream.destroy();
      };
      client.on("error", forget).on("close", forget);
      upstream.on("error", forget).on("close", forget);
      client.pipe(upstream).pipe(client);
    });
    server.on("tlsClientError", (error) => note(`TLS_ERROR front ${error.message}`));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#port, "127.0.0.1", () => resolve());
    });
    this.#server = server;
  }

  async stop() {
    this.#online = false;
    const server = this.#server;
    this.#server = undefined;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function ownerMessages(h: Harness) {
  const threads = h.repository.threadRepository();
  const main = await threads.readMain(ownerId, agentId);
  if (!main) return [];
  const messages = await threads.listMessages(ownerId, agentId, main, 0, 1000);
  return Promise.all(
    messages.map(async (message) => ({
      role: message.role,
      text: message.contentRef ? ((await h.readText(message.contentRef)) ?? "") : "",
    })),
  );
}

async function confirmPending(h: Harness) {
  const listed = await web(h, "list");
  const devices = (listed.body["devices"] ?? []) as {
    id: string;
    revision: number;
    status: string;
  }[];
  for (const device of devices.filter((candidate) => candidate.status === "pending"))
    await web(h, "confirm", { deviceId: device.id, expectedRevision: device.revision });
}

export async function startE2eBackend(): Promise<E2eBackend> {
  const root = await mkdtemp(path.join(tmpdir(), "himawari-ios-e2e-"));
  const tls = await certificates(root);
  const frontPort = await freePort();
  const appPort = await freePort();
  const controlPort = await freePort();
  const origin = `https://localhost:${frontPort}`;
  const clock = new LiveClock();
  const live = new ExecutionLiveFeed();
  const h = await harness({
    origin,
    clock,
    live,
    mainThread: true,
    beforeReady: (app) => {
      app.addHook("onRequest", async (request) => {
        if (request.url.includes("-stream")) note(`STREAM_OPEN ${request.url.split("?")[0]}`);
      });
      app.addHook("onResponse", async (request, reply) => {
        if (!request.url.startsWith("/api/device/")) return;
        const type = gatewayType(request.body);
        note(`REQUEST ${request.method} ${request.url.split("?")[0]}${type} ${reply.statusCode}`);
      });
    },
  });
  live.subscribe((event) => {
    if (event.kind === "text") note(`LIVE_TEXT ${event.runId} +${event.text.length}`);
  });
  h.configuration.current = { ...h.configuration.current, heartbeatSeconds: 15 };
  await h.app.listen({ host: "127.0.0.1", port: appPort });
  const payloads = h.repository.payloadStore(ownerId, agentId);
  await payloads.put(
    await h.protector.protect({
      ownerId,
      agentId,
      ref: SYSTEM_REF,
      dataClassification: "private",
      contentType: "text/plain",
      plaintext: new TextEncoder().encode("你是 Himawari。"),
      createdAt: clock.now(),
    }),
  );
  const model = await fauxModel();
  const adapters = createReferenceAdapterSet({ clock });
  const stateDirectory = path.join(root, "pi");
  await mkdir(stateDirectory, { recursive: true });
  const failures: unknown[] = [];
  const runs = createProductionRunComposition({
    egress: testModelEgress(),
    configuration: {
      ownerId,
      agentId,
      concurrency: { totalRuns: 2, foregroundReserved: 1, perCategory: {} },
      deadlines: { runMs: 120_000, workerRequestMs: 10_000, providerRequestMs: 60_000 },
    },
    repository: h.repository,
    authority: {
      authorityFence: () => authority,
      authorityLease: () => authorityLease,
      assertActive: async () => undefined,
      isAccepting: () => true,
    },
    models: model.models,
    modelRegistry: [model.descriptor],
    protector: h.protector,
    memory: adapters.memory,
    tools: {
      listAuthorized: async () => [],
      preflight: async () => {
        throw new Error("IOS_E2E_NO_TOOLS");
      },
      execute: async () => {
        throw new Error("IOS_E2E_NO_TOOLS");
      },
    },
    workers: new ScriptedWorkerRunPort(),
    live,
    policy: async () => ({
      modelRef: "ios-e2e-local",
      systemInstructionRef: SYSTEM_REF,
      policyVersion: "ios-e2e-policy",
      policies: [],
      capabilities: [],
      capabilityHandleRefs: [],
      memoryLimit: 5,
    }),
    clock,
    ids: { next: (namespace: string) => `${namespace}:${randomUUID()}` },
    instanceId: "ios-e2e",
    cwd: stateDirectory,
    agentDir: path.join(stateDirectory, "agent"),
    onFailure: (failure) => {
      failures.push(failure);
      process.stderr.write(`IOS_E2E_RUN_FAILURE ${JSON.stringify(failure)}\n`);
    },
  });
  void runs.loop.start();
  const confirming = setInterval(() => {
    confirmPending(h).catch((error) =>
      process.stderr.write(`IOS_E2E_CONFIRM_FAILED ${String(error)}\n`),
    );
  }, 300);
  const front = new SwitchableFront(frontPort, appPort, tls);
  await front.start();
  const control = createHttpServer((request, response) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    const route = `${request.method} ${request.url}`;
    note(`CONTROL ${route}`);
    (async () => {
      if (route === "POST /pairing-link") {
        const started = await web(h, "pairing-codes");
        pairingCode(started.body["pairingUri"]);
        return reply(201, { link: started.body["pairingUri"] });
      }
      if (route === "POST /offline") {
        await front.stop();
        return reply(200, { online: false });
      }
      if (route === "POST /online") {
        if (!front.online) await front.start();
        return reply(200, { online: true });
      }
      if (route === "GET /answers")
        return reply(200, {
          opening: ANSWER_OPENING,
          ending: ANSWER_ENDING,
          longRequest: LONG_REQUEST,
        });
      if (route === "GET /messages") return reply(200, { messages: await ownerMessages(h) });
      if (route === "GET /health")
        return reply(200, { online: front.online, failures: failures.length });
      return reply(404, { error: "not_found" });
    })().catch((error) => reply(500, { error: String(error) }));
  });
  await new Promise<void>((resolve) => control.listen(controlPort, "127.0.0.1", () => resolve()));
  return {
    origin,
    controlOrigin: `http://127.0.0.1:${controlPort}`,
    caPath: tls.caPath,
    close: async () => {
      clearInterval(confirming);
      await runs.loop.stop(5_000);
      await front.stop();
      await new Promise<void>((resolve) => control.close(() => resolve()));
      await h.app.close();
    },
  };
}

export async function connectivityProbe(origin: string, caPath: string): Promise<void> {
  const url = new URL(origin);
  const ca = await readFile(caPath);
  await new Promise<void>((resolve, reject) => {
    const socket = tlsConnect(
      { host: "127.0.0.1", port: Number(url.port), servername: "localhost", ca },
      () => {
        socket.end();
        resolve();
      },
    );
    socket.once("error", reject);
  });
}
