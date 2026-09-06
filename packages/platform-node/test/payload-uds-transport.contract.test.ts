import { mkdtemp, rm } from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { CapabilityInvocationRequest } from "@himawari-agent/application";
import {
  PAYLOAD_BROKER_V1_SCHEMA_VERSION,
  payloadBrokerV1MessageSchema,
} from "@himawari-agent/execution-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  PAYLOAD_UDS_ERROR_CODES,
  type PayloadBrokerTrustedHandler,
  PayloadUdsClient,
  type PayloadUdsClientOptions,
  type PayloadUdsCredential,
  PayloadUdsServer,
  type PayloadUdsServerOptions,
} from "../src/index.js";

const credential: PayloadUdsCredential = Object.freeze({
  tokenRef: "worker-boot-token-ref",
  tokenValue: "0123456789abcdef0123456789abcdef",
});
const agentServiceInstanceId = "agent-service:payload-contract";
const agentServiceBootId = "agent-boot:payload-contract";
const workerInstanceId = "worker:payload-contract";
const workerBootId = "worker-boot:payload-contract";
const authorityEpoch = 4;
const fencingToken = 9;
const maximumBodyBytes = 16_384;
const maximumPayloadBytes = 1_024;

const invocation: CapabilityInvocationRequest = {
  invocationId: "invocation:payload-contract",
  ownerId: "owner:payload-contract" as CapabilityInvocationRequest["ownerId"],
  agentId: "agent:payload-contract" as CapabilityInvocationRequest["agentId"],
  runId: "run:payload-contract" as CapabilityInvocationRequest["runId"],
  capabilityRef: "capability:payload-contract",
  capabilityHandleRef: "handle:payload-contract",
  operation: "read",
  inputRef: "payload:input:payload-contract",
  delegatedContextRefs: [],
  secretHandleRefs: [],
  dataClassification: "private",
  resourceCeiling: {
    maxWallTimeMs: 1_000,
    maxCpuTimeMs: 500,
    maxMemoryBytes: 16_777_216,
    maxOutputBytes: maximumPayloadBytes,
    maxProgressEvents: 8,
  },
};

const identity = {
  handleRef: invocation.capabilityHandleRef,
  invocationId: invocation.invocationId,
  workerInstanceId,
  workerBootId,
  authorityEpoch,
  fencingToken,
} as const;

let idSequence = 0;
const cleanup: Array<() => Promise<void>> = [];

async function runtimeDirectory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "himawari-payload-uds-"));
}

function nextId(scope: string): string {
  idSequence += 1;
  return `${scope}:${idSequence}`;
}

function serverOptions(
  runtimeDirectory: string,
  handler: PayloadBrokerTrustedHandler,
  overrides: Partial<PayloadUdsServerOptions> = {},
): PayloadUdsServerOptions {
  return {
    runtimeDirectory,
    credential,
    agentServiceInstanceId,
    agentServiceBootId,
    allowedWorkerIdentities: [{ workerInstanceId, workerBootId }],
    authorityEpoch,
    fencingToken,
    maximumBodyBytes,
    maximumPayloadBytes,
    requestTimeoutMs: 1_000,
    handler,
    ...overrides,
  };
}

function clientOptions(
  socketPath: string,
  overrides: Partial<PayloadUdsClientOptions> = {},
): PayloadUdsClientOptions {
  return {
    socketPath,
    credential,
    agentServiceInstanceId,
    agentServiceBootId,
    workerInstanceId,
    workerBootId,
    authorityEpoch,
    fencingToken,
    maximumBodyBytes,
    maximumPayloadBytes,
    requestTimeoutMs: 1_000,
    nextId,
    ...overrides,
  };
}

async function startServer(
  handler: PayloadBrokerTrustedHandler,
  overrides: Partial<PayloadUdsServerOptions> = {},
): Promise<PayloadUdsServer> {
  const directory = await runtimeDirectory();
  const server = new PayloadUdsServer(serverOptions(directory, handler, overrides));
  await server.start();
  cleanup.push(async () => {
    await server.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  return server;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function rawRequest(
  socketPath: string,
  requestPath: string,
  body: string | Uint8Array,
  headers: Record<string, string> = {},
): Promise<{
  readonly statusCode: number;
  readonly body: Buffer;
  readonly contentType: string | undefined;
}> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path: requestPath,
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.tokenValue}`,
          "content-type": "application/json",
          "x-himawari-worker-instance": workerInstanceId,
          ...headers,
        },
      },
      (response) => {
        void readBody(response).then(
          (responseBody) =>
            resolve({
              statusCode: response.statusCode ?? 0,
              body: responseBody,
              contentType: response.headers["content-type"],
            }),
          reject,
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

async function dripRequestBody(socketPath: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const responseChunks: Buffer[] = [];
    let interval: NodeJS.Timeout | undefined;
    let responseText = "";
    const finish = () => {
      if (interval) clearInterval(interval);
      socket.destroy();
      resolve(responseText);
    };
    socket.once("error", (error) => {
      if (interval) clearInterval(interval);
      reject(error);
    });
    socket.on("data", (chunk: Buffer) => {
      responseChunks.push(chunk);
      responseText = Buffer.concat(responseChunks).toString("utf8");
      if (responseText.includes("PAYLOAD_UDS_DEADLINE_EXCEEDED")) finish();
    });
    socket.once("connect", () => {
      socket.write(
        [
          "POST /payload/v1/input/read HTTP/1.1",
          "Host: payload.local",
          `Authorization: Bearer ${credential.tokenValue}`,
          "Content-Type: application/json",
          `X-Himawari-Worker-Instance: ${workerInstanceId}`,
          `Content-Length: ${Buffer.byteLength(body)}`,
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );
      let offset = 0;
      interval = setInterval(() => {
        if (offset >= body.length || socket.destroyed) {
          if (interval) clearInterval(interval);
          return;
        }
        const character = body[offset];
        if (character === undefined) return;
        socket.write(character);
        offset += 1;
      }, 10);
    });
  });
}

function inputReadMessage(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: PAYLOAD_BROKER_V1_SCHEMA_VERSION,
    kind: "request",
    type: "payload.input.read",
    messageId: "payload-input-raw-message",
    correlationId: "payload-input-raw-correlation",
    causationId: null,
    idempotencyKey: "payload-input-raw-idempotency",
    payload: identity,
    ...overrides,
  };
}

function outputWriteMessage(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: PAYLOAD_BROKER_V1_SCHEMA_VERSION,
    kind: "request",
    type: "payload.output.write",
    messageId: "payload-output-raw-message",
    correlationId: "payload-output-raw-correlation",
    causationId: null,
    idempotencyKey: "payload-output-raw-idempotency",
    payload: {
      ...identity,
      bytesBase64: Buffer.from("raw output").toString("base64"),
      contentType: "text/plain",
    },
    ...overrides,
  };
}

async function closeCleanup(): Promise<void> {
  for (const dispose of cleanup.splice(0)) await dispose();
}

describe("payload-broker.v1 authenticated UDS transport", () => {
  it("hands the Worker only opaque operation identity and never echoes output bytes", async () => {
    const inputRequests: unknown[] = [];
    const outputRequests: unknown[] = [];
    const handler: PayloadBrokerTrustedHandler = {
      readInput: async (request) => {
        inputRequests.push(request);
        return new TextEncoder().encode('{"input":"ok"}');
      },
      writeOutput: async (request, plaintext, contentType) => {
        outputRequests.push({ request, plaintext, contentType });
        return { outputRef: "payload:output:stable", replayed: false };
      },
    };
    const server = await startServer(handler);
    const client = new PayloadUdsClient(clientOptions(server.socketPath));

    await expect(client.connect()).resolves.toMatchObject({
      type: "payload.handshake.accepted",
      payload: {
        agentServiceInstanceId,
        agentServiceBootId,
        workerInstanceId,
        workerBootId,
      },
    });
    await expect(client.readInput(identity)).resolves.toEqual(
      new TextEncoder().encode('{"input":"ok"}'),
    );
    await expect(
      client.writeOutput(identity, new TextEncoder().encode('{"result":true}'), "application/json"),
    ).resolves.toEqual({ outputRef: "payload:output:stable", replayed: false });

    expect(inputRequests).toHaveLength(1);
    expect(Object.keys(inputRequests[0] as object).sort()).toEqual([
      "causationId",
      "correlationId",
      "idempotencyKey",
      "kind",
      "messageId",
      "payload",
      "schemaVersion",
      "type",
    ]);
    expect((inputRequests[0] as { payload: object }).payload).toEqual(identity);
    expect(outputRequests).toHaveLength(1);
    expect(outputRequests[0]).toMatchObject({ contentType: "application/json" });
    expect(
      new TextDecoder().decode((outputRequests[0] as { plaintext: Uint8Array }).plaintext),
    ).toBe('{"result":true}');
    const outputRequest = outputWriteMessage();
    const rawResponse = await rawRequest(
      server.socketPath,
      "/payload/v1/output/write",
      JSON.stringify(outputRequest),
    );
    expect(rawResponse.statusCode).toBe(200);
    const parsed = payloadBrokerV1MessageSchema.parse(
      JSON.parse(rawResponse.body.toString("utf8")),
    );
    expect(parsed.type).toBe("payload.output.write.accepted");
    if (parsed.type !== "payload.output.write.accepted") throw new Error("expected output receipt");
    expect(parsed.payload).toMatchObject({
      handleRef: identity.handleRef,
      invocationId: identity.invocationId,
      workerInstanceId,
      workerBootId,
      authorityEpoch,
      fencingToken,
      agentServiceInstanceId,
      agentServiceBootId,
      outputRef: "payload:output:stable",
      replayed: false,
    });
    expect(parsed.payload).not.toHaveProperty("bytesBase64");
    expect(parsed.payload).not.toHaveProperty("contentType");
  });

  it("keeps the configured socket basename inside the runtime directory", async () => {
    const handler: PayloadBrokerTrustedHandler = {
      readInput: async () => new Uint8Array(),
      writeOutput: async () => ({ outputRef: "payload:unused", replayed: false }),
    };
    expect(
      () =>
        new PayloadUdsServer(
          serverOptions("/tmp/himawari-payload-runtime", handler, {
            socketName: "../payload.sock",
          }),
        ),
    ).toThrow();
    expect(
      () =>
        new PayloadUdsServer(
          serverOptions("/tmp/himawari-payload-runtime", handler, { socketName: ".." }),
        ),
    ).toThrow();
  });

  it("rejects oversized UTF-8 socket paths before the OS can truncate them", () => {
    const handler: PayloadBrokerTrustedHandler = {
      readInput: async () => new Uint8Array(),
      writeOutput: async () => ({ outputRef: "payload:unused", replayed: false }),
    };
    expect(() => new PayloadUdsServer(serverOptions(`/tmp/${"界".repeat(40)}`, handler))).toThrow(
      "socket path exceeds",
    );
  });

  it("rejects authentication, boot, schema, encoding, content and size failures before dispatch", async () => {
    let readCalls = 0;
    let writeCalls = 0;
    const server = await startServer(
      {
        readInput: async () => {
          readCalls += 1;
          return new Uint8Array([1]);
        },
        writeOutput: async () => {
          writeCalls += 1;
          return { outputRef: "payload:unexpected", replayed: false };
        },
      },
      { maximumBodyBytes: 2_048, maximumPayloadBytes: 128 },
    );

    await expect(
      new PayloadUdsClient(
        clientOptions(server.socketPath, {
          credential: { ...credential, tokenValue: "f".repeat(32) },
        }),
      ).connect(),
    ).rejects.toMatchObject({ code: PAYLOAD_UDS_ERROR_CODES.AUTHENTICATION_FAILED });
    await expect(
      new PayloadUdsClient(
        clientOptions(server.socketPath, { workerBootId: "worker-boot:stale" }),
      ).connect(),
    ).rejects.toMatchObject({ code: PAYLOAD_UDS_ERROR_CODES.INSTANCE_REJECTED });
    await expect(
      new PayloadUdsClient(
        clientOptions(server.socketPath, { agentServiceBootId: "agent-boot:stale" }),
      ).connect(),
    ).rejects.toMatchObject({ code: PAYLOAD_UDS_ERROR_CODES.INSTANCE_REJECTED });

    const connected = new PayloadUdsClient(clientOptions(server.socketPath));
    await connected.connect();
    const invalidMessages: Array<{
      readonly body: string | Uint8Array;
      readonly expected: string;
    }> = [
      {
        body: JSON.stringify({ ...inputReadMessage(), ownerId: "not-authoritative" }),
        expected: PAYLOAD_UDS_ERROR_CODES.INVALID_REQUEST,
      },
      {
        body: JSON.stringify({
          ...inputReadMessage(),
          payload: { ...identity, ownerId: "not-authoritative" },
        }),
        expected: PAYLOAD_UDS_ERROR_CODES.INVALID_REQUEST,
      },
      {
        body: JSON.stringify({ ...inputReadMessage(), schemaVersion: "payload-broker.v2" }),
        expected: PAYLOAD_UDS_ERROR_CODES.INVALID_REQUEST,
      },
      {
        body: JSON.stringify({
          ...outputWriteMessage(),
          payload: { ...outputWriteMessage().payload, bytesBase64: "AB==" },
        }),
        expected: PAYLOAD_UDS_ERROR_CODES.INVALID_REQUEST,
      },
      { body: Buffer.from([0xff, 0xfe]), expected: PAYLOAD_UDS_ERROR_CODES.INVALID_REQUEST },
      { body: "x".repeat(4_000), expected: PAYLOAD_UDS_ERROR_CODES.BODY_TOO_LARGE },
    ];
    for (const invalid of invalidMessages) {
      const response = await rawRequest(server.socketPath, "/payload/v1/input/read", invalid.body);
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(JSON.parse(response.body.toString("utf8"))).toEqual({
        error: { code: invalid.expected },
      });
    }
    const unsupportedContent = await rawRequest(
      server.socketPath,
      "/payload/v1/input/read",
      JSON.stringify(inputReadMessage()),
      { "content-type": "text/plain" },
    );
    expect(unsupportedContent.statusCode).toBe(415);
    expect(JSON.parse(unsupportedContent.body.toString("utf8"))).toEqual({
      error: { code: PAYLOAD_UDS_ERROR_CODES.CONTENT_TYPE_UNSUPPORTED },
    });
    expect(readCalls).toBe(0);
    expect(writeCalls).toBe(0);
  });

  it("does not turn handler errors into successful output and does not expose private error text", async () => {
    const server = await startServer({
      readInput: async () => {
        throw new Error("private input details");
      },
      writeOutput: async () => {
        throw new Error("private output details");
      },
    });
    const client = new PayloadUdsClient(clientOptions(server.socketPath));
    await client.connect();

    await expect(client.readInput(identity)).rejects.toMatchObject({
      code: PAYLOAD_UDS_ERROR_CODES.HANDLER_FAILED,
    });
    await expect(
      client.writeOutput(identity, new TextEncoder().encode("result"), "text/plain"),
    ).rejects.toMatchObject({ code: PAYLOAD_UDS_ERROR_CODES.HANDLER_FAILED });
    const rawResponse = await rawRequest(
      server.socketPath,
      "/payload/v1/output/write",
      JSON.stringify(outputWriteMessage()),
    );
    expect(rawResponse.statusCode).toBe(500);
    expect(rawResponse.body.toString("utf8")).not.toContain("private output details");
    expect(JSON.parse(rawResponse.body.toString("utf8"))).toEqual({
      error: { code: PAYLOAD_UDS_ERROR_CODES.HANDLER_FAILED },
    });
  });

  it.each(["handshake-correlation", "handshake-boot", "read", "write"] as const)(
    "rejects a stale %s response correlation or causation identity",
    async (mode) => {
      const directory = await runtimeDirectory();
      const socketPath = path.join(directory, "raw.sock");
      const rawServer = http.createServer(async (request, response) => {
        const body = JSON.parse((await readBody(request)).toString("utf8")) as {
          readonly type: string;
          readonly messageId: string;
          readonly correlationId: string;
          readonly payload: typeof identity;
        };
        const common = {
          schemaVersion: PAYLOAD_BROKER_V1_SCHEMA_VERSION,
          kind: "response" as const,
          messageId: body.messageId,
          correlationId:
            mode === "handshake-correlation" && body.type === "payload.handshake"
              ? "stale-correlation"
              : body.correlationId,
          causationId:
            mode === "write" && body.type === "payload.output.write"
              ? "stale-causation"
              : body.messageId,
        };
        const result =
          body.type === "payload.handshake"
            ? {
                ...common,
                type: "payload.handshake.accepted" as const,
                payload: {
                  agentServiceInstanceId,
                  agentServiceBootId:
                    mode === "handshake-boot" ? "agent-boot:stale" : agentServiceBootId,
                  workerInstanceId,
                  workerBootId,
                  authorityEpoch,
                  fencingToken,
                  acceptedAt: "2026-09-04T00:00:00.000Z",
                },
              }
            : body.type === "payload.input.read"
              ? {
                  ...common,
                  type: "payload.input.read.result" as const,
                  correlationId: mode === "read" ? "stale-correlation" : body.correlationId,
                  payload: {
                    ...identity,
                    agentServiceInstanceId,
                    agentServiceBootId,
                    bytesBase64: "AQ==",
                  },
                }
              : {
                  ...common,
                  type: "payload.output.write.accepted" as const,
                  payload: {
                    ...identity,
                    agentServiceInstanceId,
                    agentServiceBootId,
                    outputRef: "payload:stable",
                    replayed: false,
                  },
                };
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      });
      await new Promise<void>((resolve, reject) => {
        rawServer.once("error", reject);
        rawServer.listen(socketPath, resolve);
      });
      try {
        const client = new PayloadUdsClient(clientOptions(socketPath));
        if (mode === "handshake-correlation" || mode === "handshake-boot") {
          await expect(client.connect()).rejects.toMatchObject({
            code: PAYLOAD_UDS_ERROR_CODES.RESPONSE_IDENTITY_MISMATCH,
          });
        } else {
          await client.connect();
          if (mode === "read") {
            await expect(client.readInput(identity)).rejects.toMatchObject({
              code: PAYLOAD_UDS_ERROR_CODES.RESPONSE_IDENTITY_MISMATCH,
            });
          } else {
            await expect(
              client.writeOutput(identity, new TextEncoder().encode("result"), "text/plain"),
            ).rejects.toMatchObject({
              code: PAYLOAD_UDS_ERROR_CODES.RESPONSE_IDENTITY_MISMATCH,
            });
          }
        }
      } finally {
        await new Promise<void>((resolve) => rawServer.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("uses a wall-clock deadline even when a response drips bytes", async () => {
    const directory = await runtimeDirectory();
    const socketPath = path.join(directory, "drip.sock");
    const dripServer = http.createServer(async (request, response) => {
      await readBody(request);
      const body = JSON.stringify({
        schemaVersion: PAYLOAD_BROKER_V1_SCHEMA_VERSION,
        kind: "response",
        type: "payload.handshake.accepted",
        messageId: "drip-message",
        correlationId: "payload-handshake:1",
        causationId: "payload-handshake:1",
        payload: {
          agentServiceInstanceId,
          agentServiceBootId,
          workerInstanceId,
          workerBootId,
          authorityEpoch,
          fencingToken,
          acceptedAt: "2026-09-04T00:00:00.000Z",
        },
      });
      response.on("error", () => undefined);
      response.writeHead(200, { "content-type": "application/json" });
      let offset = 0;
      const interval = setInterval(() => {
        if (response.destroyed) {
          clearInterval(interval);
          return;
        }
        if (offset >= body.length) {
          clearInterval(interval);
          response.end();
          return;
        }
        response.write(body[offset]);
        offset += 1;
      }, 10);
      response.once("close", () => clearInterval(interval));
    });
    await new Promise<void>((resolve, reject) => {
      dripServer.once("error", reject);
      dripServer.listen(socketPath, resolve);
    });
    try {
      const client = new PayloadUdsClient(clientOptions(socketPath, { requestTimeoutMs: 40 }));
      await expect(client.connect()).rejects.toMatchObject({
        code: PAYLOAD_UDS_ERROR_CODES.DEADLINE_EXCEEDED,
      });
    } finally {
      await new Promise<void>((resolve) => dripServer.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns a stable deadline error without cancelling a handler that may already be committing", async () => {
    let started = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await startServer(
      {
        readInput: async () => {
          started = true;
          await pending;
          return new Uint8Array([1]);
        },
        writeOutput: async () => ({ outputRef: "payload:unused", replayed: false }),
      },
      { requestTimeoutMs: 25 },
    );
    const client = new PayloadUdsClient(
      clientOptions(server.socketPath, { requestTimeoutMs: 250 }),
    );
    await client.connect();
    await expect(client.readInput(identity)).rejects.toMatchObject({
      code: PAYLOAD_UDS_ERROR_CODES.DEADLINE_EXCEEDED,
    });
    expect(started).toBe(true);
    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.isReady()).toBe(true);
  });

  it("does not dispatch a request whose body misses the absolute deadline", async () => {
    let readCalls = 0;
    const server = await startServer(
      {
        readInput: async () => {
          readCalls += 1;
          return new Uint8Array([1]);
        },
        writeOutput: async () => ({ outputRef: "payload:unused", replayed: false }),
      },
      { requestTimeoutMs: 35 },
    );
    const response = await dripRequestBody(server.socketPath, JSON.stringify(inputReadMessage()));
    expect(response).toContain("PAYLOAD_UDS_DEADLINE_EXCEEDED");
    expect(readCalls).toBe(0);
  });
});

afterEach(async () => {
  await closeCleanup();
});
