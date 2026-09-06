import { lstat, mkdtemp, rm } from "node:fs/promises";
import http, { type IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  EXECUTION_ADMISSION_V1_SCHEMA_VERSION,
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionAdmissionPeerBinding,
  type ExecutionAdmissionProjection,
  type ExecutionAdmissionReceiptIdentity,
  type ExecutionAdmissionWorkExecuteAccepted,
  type ExecutionAdmissionWorkExecuteRequest,
  executionAdmissionV1MessageSchema,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXECUTION_ADMISSION_UDS_ERROR_CODES,
  type ExecutionAdmissionCredential,
  type ExecutionAdmissionHandlerResult,
  ExecutionAdmissionUdsClient,
  type ExecutionAdmissionUdsClientOptions,
  ExecutionAdmissionUdsServer,
  type ExecutionAdmissionUdsServerOptions,
} from "../src/index.js";

const credential: ExecutionAdmissionCredential = Object.freeze({
  tokenRef: "worker-boot-token-ref",
  tokenValue: "0123456789abcdef0123456789abcdef",
});
const peer: ExecutionAdmissionPeerBinding = Object.freeze({
  agentServiceInstanceId: "agent-service:admission-uds",
  agentServiceBootId: "agent-boot:admission-uds",
  workerInstanceId: "worker:admission-uds",
  workerBootId: "worker-boot:admission-uds",
  deploymentId: "deployment-01",
  authorityEpoch: 8,
  fencingToken: 3,
});
const maximumBodyBytes = 16_384;

const parsedFixtureExecute = executionV2MessageSchema.parse({
  schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
  kind: "request",
  type: "work.execute",
  messageId: "execution-v2-request-01",
  correlationId: "correlation-run-01",
  causationId: "event-worker-delegated-01",
  dataClassification: "sensitive",
  risk: "high",
  authorizationRef: "authorization-work-01",
  scope: {
    deploymentId: "deployment-01",
    authorityEpoch: 8,
    fencingToken: 3,
    ownerId: "owner-01",
    agentId: "agent-01",
    runId: "run-01",
    workerRunId: "worker-run-01",
  },
  idempotencyKey: "work-execute-01",
  payload: {
    capabilityId: "github-read",
    capabilityVersion: "1.0.0",
    operation: "read-repository",
    inputRef: "payload-work-input-01",
    capabilityHandleRef: "capability-handle-01",
    delegatedContextRefs: ["payload-context-01"],
    secretRefs: [
      {
        secretRef: "secret-ref-github-app-01",
        secretVersion: "version-01",
        purpose: "github-installation-token",
      },
    ],
    resourceCeiling: {
      maxWallTimeMs: 30_000,
      maxCpuTimeMs: 10_000,
      maxMemoryBytes: 268_435_456,
      maxOutputBytes: 1_048_576,
      maxProgressEvents: 100,
    },
    requestedAt: "2026-08-26T00:00:02.000Z",
    deadlineAt: "2026-08-26T00:00:32.000Z",
  },
});
if (parsedFixtureExecute.kind !== "request" || parsedFixtureExecute.type !== "work.execute") {
  throw new TypeError("execution.v2 execute admission fixture has an unexpected type");
}
const execute = parsedFixtureExecute;

const parsedFixtureDelegate = executionV2MessageSchema.parse({
  schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
  kind: "request",
  type: "work.delegate",
  messageId: "execution-v2-delegate-01",
  correlationId: "correlation-run-01",
  causationId: "event-worker-delegated-01",
  dataClassification: "sensitive",
  risk: "high",
  authorizationRef: "authorization-work-01",
  scope: {
    deploymentId: "deployment-01",
    authorityEpoch: 8,
    fencingToken: 3,
    ownerId: "owner-01",
    agentId: "agent-01",
    runId: "run-01",
    workerRunId: "worker-run-01",
  },
  idempotencyKey: "work-delegate-01",
  payload: {
    handle: {
      handleVersion: "capability-handle.v2",
      ref: "capability-handle-01",
      revision: 3,
      authorityFence: 3,
      ownerId: "owner-01",
      agentId: "agent-01",
      runId: "run-01",
      capabilityRef: "github-read",
      capabilityVersion: "1.0.0",
      authorizationType: "grant",
      authorizationRef: "authorization-work-01",
      operations: ["read-repository"],
      inputRefs: ["payload-work-input-01"],
      delegatedContextRefs: ["payload-context-01"],
      secretRefs: [
        {
          secretRef: "secret-ref-github-app-01",
          secretVersion: "version-01",
          purpose: "github-installation-token",
        },
      ],
      maxDataClassification: "sensitive",
      issuedAt: "2026-08-26T00:00:01.000Z",
      expiresAt: "2026-08-26T00:00:32.000Z",
      revokedAt: null,
      operation: "read-repository",
      maxUses: 1,
      uses: 0,
      maxTotalCostMicros: 0,
      spentCostMicros: 0,
      idempotencyKeys: [],
      workerEndedAt: null,
    },
    requestedAt: "2026-08-26T00:00:01.500Z",
  },
});
if (parsedFixtureDelegate.kind !== "request" || parsedFixtureDelegate.type !== "work.delegate") {
  throw new TypeError("execution.v2 delegate admission fixture has an unexpected type");
}
const nullAuthorizationExecute: typeof execute = (() => {
  const parsed = executionV2MessageSchema.parse({
    ...execute,
    messageId: "execution-v2-null-authorization",
    idempotencyKey: "work-execute-null-authorization",
    risk: "low",
    authorizationRef: null,
  });
  if (parsed.kind === "request" && parsed.type === "work.execute") return parsed;
  throw new TypeError("execution.v2 null-authorization fixture has an unexpected type");
})();
const delegateFixture: Extract<
  ReturnType<typeof executionV2MessageSchema.parse>,
  { type: "work.delegate" }
> = parsedFixtureDelegate.kind === "request" && parsedFixtureDelegate.type === "work.delegate"
  ? parsedFixtureDelegate
  : (() => {
      throw new TypeError("execution.v2 delegate admission fixture has an unexpected type");
    })();
const receipt: ExecutionAdmissionReceiptIdentity = Object.freeze({
  receiptRef: "receipt:admission-uds",
  handleRef: execute.payload.capabilityHandleRef,
  invocationId: execute.messageId,
  idempotencyKey: execute.idempotencyKey,
  ownerId: execute.scope.ownerId ?? "owner:missing",
  agentId: execute.scope.agentId ?? "agent:missing",
  runId: execute.scope.runId ?? "run:missing",
  workerRunId: execute.scope.workerRunId ?? "worker-run:missing",
});

function receiptFor(
  request: ExecutionAdmissionWorkExecuteRequest["payload"]["execute"],
): ExecutionAdmissionReceiptIdentity {
  return Object.freeze({
    ...receipt,
    invocationId: request.messageId,
    idempotencyKey: request.idempotencyKey,
  });
}

let idSequence = 0;
const cleanup: Array<() => Promise<void>> = [];

function nextId(scope: string): string {
  idSequence += 1;
  return `${scope}:${idSequence}`;
}

function now(): string {
  return "2026-09-05T00:00:00.000Z";
}

function projectionFor(
  request: ExecutionAdmissionWorkExecuteRequest["payload"]["execute"],
): ExecutionAdmissionProjection {
  const delegate = executionV2MessageSchema.parse({
    ...delegateFixture,
    messageId: "delegate:admission-uds",
    correlationId: request.correlationId,
    causationId: request.messageId,
    dataClassification: request.dataClassification,
    risk: request.risk,
    authorizationRef: request.authorizationRef,
    scope: request.scope,
    idempotencyKey: `${request.idempotencyKey}:delegate`,
    payload: {
      ...delegateFixture.payload,
      requestedAt: request.payload.requestedAt,
      handle: {
        ...delegateFixture.payload.handle,
        ref: request.payload.capabilityHandleRef,
        ownerId: request.scope.ownerId ?? "owner:missing",
        agentId: request.scope.agentId ?? "agent:missing",
        runId: request.scope.runId ?? "run:missing",
        capabilityRef: request.payload.capabilityId,
        capabilityVersion: request.payload.capabilityVersion,
        authorizationRef: request.authorizationRef ?? "authorization:admission-uds",
        operations: [request.payload.operation],
        inputRefs: [request.payload.inputRef],
        delegatedContextRefs: request.payload.delegatedContextRefs,
        secretRefs: request.payload.secretRefs,
        maxDataClassification: request.dataClassification,
        operation: request.payload.operation,
        authorityFence: request.scope.fencingToken,
      },
    },
  });
  if (delegate.kind !== "request" || delegate.type !== "work.delegate") {
    throw new TypeError("admission delegate projection is invalid");
  }
  return Object.freeze({ delegate, execute: request });
}

function consumedResult(
  request: ExecutionAdmissionWorkExecuteRequest["payload"]["execute"] = execute,
): ExecutionAdmissionHandlerResult {
  return {
    disposition: "consumed",
    receipt: receiptFor(request),
    projection: projectionFor(request),
    reasonCode: null,
  };
}

function replayedResult(): ExecutionAdmissionHandlerResult {
  return { disposition: "replayed", receipt, projection: null, reasonCode: null };
}

function serverOptions(
  runtimeDirectory: string,
  handler: ExecutionAdmissionUdsServerOptions["handler"],
  overrides: Partial<ExecutionAdmissionUdsServerOptions> = {},
): ExecutionAdmissionUdsServerOptions {
  return {
    runtimeDirectory,
    credential,
    trustedPeerBinding: () => peer,
    maximumBodyBytes,
    requestTimeoutMs: 1_000,
    now,
    nextId,
    handler,
    ...overrides,
  };
}

function clientOptions(
  socketPath: string,
  overrides: Partial<ExecutionAdmissionUdsClientOptions> = {},
): ExecutionAdmissionUdsClientOptions {
  return {
    socketPath,
    credential,
    peerBinding: peer,
    maximumBodyBytes,
    requestTimeoutMs: 1_000,
    nextId,
    now,
    ...overrides,
  };
}

async function startServer(
  handler: ExecutionAdmissionUdsServerOptions["handler"],
  overrides: Partial<ExecutionAdmissionUdsServerOptions> = {},
): Promise<ExecutionAdmissionUdsServer> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "himawari-admission-uds-"));
  const server = new ExecutionAdmissionUdsServer(serverOptions(directory, handler, overrides));
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
): Promise<{ readonly statusCode: number; readonly body: Buffer; readonly contentType?: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path: requestPath,
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.tokenValue}`,
          "content-type": "application/json",
          "x-himawari-worker-instance": peer.workerInstanceId,
          ...headers,
        },
      },
      (response) => {
        void readBody(response).then(
          (responseBody) =>
            resolve({
              statusCode: response.statusCode ?? 0,
              body: responseBody,
              ...(response.headers["content-type"] === undefined
                ? {}
                : { contentType: response.headers["content-type"] }),
            }),
          reject,
        );
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

function admissionRequest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: EXECUTION_ADMISSION_V1_SCHEMA_VERSION,
    kind: "request",
    type: "admission.work.execute",
    messageId: "admission-request:uds",
    correlationId: "admission-correlation:uds",
    causationId: execute.messageId,
    idempotencyKey: "admission-idempotency:uds",
    payload: {
      peer,
      execute,
    },
    ...overrides,
  };
}

function handshakeRequest() {
  return {
    schemaVersion: EXECUTION_ADMISSION_V1_SCHEMA_VERSION,
    kind: "request" as const,
    type: "admission.handshake" as const,
    messageId: "admission-handshake:uds",
    correlationId: "admission-handshake-correlation:uds",
    causationId: null,
    idempotencyKey: "admission-handshake-idempotency:uds",
    payload: { peer, requestedAt: now() },
  };
}

async function closeCleanup(): Promise<void> {
  for (const dispose of cleanup.splice(0)) await dispose();
}

describe("execution-admission.v1 authenticated UDS transport", () => {
  it("binds the peer, returns one executable projection, and makes replay non-executable", async () => {
    const requests: ExecutionAdmissionWorkExecuteRequest[] = [];
    const server = await startServer({
      admit: async (request) => {
        requests.push(request);
        return requests.length === 1 ? consumedResult(request.payload.execute) : replayedResult();
      },
    });
    const directoryStats = await lstat(path.dirname(server.socketPath));
    const socketStats = await lstat(server.socketPath);
    expect(directoryStats.mode & 0o777).toBe(0o700);
    expect(socketStats.mode & 0o777).toBe(0o600);

    const client = new ExecutionAdmissionUdsClient(clientOptions(server.socketPath));
    await expect(client.connect()).resolves.toMatchObject({
      type: "admission.handshake.accepted",
      payload: { peer, ready: true },
    });
    const first = await client.admit(execute);
    expect(first.disposition).toBe("consumed");
    if (first.disposition !== "consumed") throw new Error("expected first admission to consume");
    expect(first.projection.execute.messageId).toBe(execute.messageId);
    expect(first.projection.delegate.type).toBe("work.delegate");

    const second = await client.admit(execute);
    expect(second).toMatchObject({
      disposition: "replayed",
      receipt,
      requestMessageId: execute.messageId,
      peer,
      projection: null,
      reasonCode: null,
    });
    expect(requests).toHaveLength(2);
  });

  it("accepts an equivalent consumed projection with a null authorizationRef", async () => {
    const server = await startServer({
      admit: async () => consumedResult(nullAuthorizationExecute),
    });
    const client = new ExecutionAdmissionUdsClient(clientOptions(server.socketPath));
    await client.connect();

    const result = await client.admit(nullAuthorizationExecute);
    expect(result.disposition).toBe("consumed");
    if (result.disposition !== "consumed") throw new Error("expected a consumed admission");
    expect(result.projection.execute.authorizationRef).toBe(null);
  });

  it("rejects a changed non-null authorizationRef when the request omitted it", async () => {
    const server = await startServer({
      admit: async () => {
        const result = consumedResult(nullAuthorizationExecute);
        if (result.disposition !== "consumed") {
          throw new TypeError("expected a consumed admission result");
        }
        const changedExecute = executionV2MessageSchema.parse({
          ...result.projection.execute,
          authorizationRef: "authorization:changed",
        });
        if (changedExecute.kind !== "request" || changedExecute.type !== "work.execute") {
          throw new TypeError("changed execution projection has an unexpected type");
        }
        return {
          disposition: "consumed",
          receipt: result.receipt,
          projection: { ...result.projection, execute: changedExecute },
          reasonCode: null,
        };
      },
    });
    const client = new ExecutionAdmissionUdsClient(clientOptions(server.socketPath));
    await client.connect();

    await expect(client.admit(nullAuthorizationExecute)).rejects.toMatchObject({
      code: EXECUTION_ADMISSION_UDS_ERROR_CODES.RESPONSE_IDENTITY_MISMATCH,
    });
  });

  it("rejects authentication, peer, handshake, schema and size failures before handler dispatch", async () => {
    let calls = 0;
    const server = await startServer({
      admit: async () => {
        calls += 1;
        return consumedResult();
      },
    });

    await expect(
      new ExecutionAdmissionUdsClient(
        clientOptions(server.socketPath, {
          credential: { ...credential, tokenValue: "f".repeat(32) },
        }),
      ).connect(),
    ).rejects.toMatchObject({ code: EXECUTION_ADMISSION_UDS_ERROR_CODES.AUTHENTICATION_FAILED });
    await expect(
      new ExecutionAdmissionUdsClient(
        clientOptions(server.socketPath, {
          peerBinding: { ...peer, workerBootId: "worker-boot:stale" },
        }),
      ).connect(),
    ).rejects.toMatchObject({ code: EXECUTION_ADMISSION_UDS_ERROR_CODES.INSTANCE_REJECTED });
    await expect(
      new ExecutionAdmissionUdsClient(
        clientOptions(server.socketPath, {
          peerBinding: { ...peer, agentServiceBootId: "agent-boot:stale" },
        }),
      ).connect(),
    ).rejects.toMatchObject({ code: EXECUTION_ADMISSION_UDS_ERROR_CODES.INSTANCE_REJECTED });
    await expect(
      rawRequest(
        server.socketPath,
        "/admission/v1/work/execute",
        JSON.stringify(admissionRequest()),
      ),
    ).resolves.toMatchObject({ statusCode: 401 });

    const connected = new ExecutionAdmissionUdsClient(clientOptions(server.socketPath));
    await connected.connect();
    const invalidMessages: Array<{ readonly body: string | Uint8Array; readonly code: string }> = [
      {
        body: JSON.stringify({ ...admissionRequest(), extra: "caller-owned-scope" }),
        code: EXECUTION_ADMISSION_UDS_ERROR_CODES.INVALID_REQUEST,
      },
      {
        body: JSON.stringify({ ...admissionRequest(), schemaVersion: "execution-admission.v2" }),
        code: EXECUTION_ADMISSION_UDS_ERROR_CODES.INVALID_REQUEST,
      },
      {
        body: Buffer.from([0xff, 0xfe]),
        code: EXECUTION_ADMISSION_UDS_ERROR_CODES.INVALID_REQUEST,
      },
      {
        body: "x".repeat(maximumBodyBytes + 1),
        code: EXECUTION_ADMISSION_UDS_ERROR_CODES.BODY_TOO_LARGE,
      },
    ];
    for (const invalid of invalidMessages) {
      const response = await rawRequest(
        server.socketPath,
        "/admission/v1/work/execute",
        invalid.body,
      );
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(JSON.parse(response.body.toString("utf8"))).toEqual({ error: { code: invalid.code } });
    }
    expect(calls).toBe(0);
  });

  it.each([
    "capabilityId",
    "capabilityVersion",
    "operation",
    "inputRef",
    "delegatedContextRefs",
    "secretRefs",
    "dataClassification",
    "resourceCeiling",
    "deadlineAt",
  ] as const)("rejects a consumed projection with a changed %s", async (field) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "himawari-admission-raw-"));
    const socketPath = path.join(directory, "raw.sock");
    const rawServer = http.createServer(async (request, response) => {
      const body = executionAdmissionV1MessageSchema.parse(
        JSON.parse((await readBody(request)).toString("utf8")) as unknown,
      );
      if (body.type === "admission.handshake") {
        const accepted = executionAdmissionV1MessageSchema.parse({
          schemaVersion: EXECUTION_ADMISSION_V1_SCHEMA_VERSION,
          kind: "response",
          type: "admission.handshake.accepted",
          messageId: "raw-handshake-accepted",
          correlationId: body.correlationId,
          causationId: body.messageId,
          payload: { peer, ready: true, acceptedAt: now() },
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(accepted));
        return;
      }
      if (body.type !== "admission.work.execute") {
        response.writeHead(404);
        response.end();
        return;
      }
      const projection = projectionFor(body.payload.execute);
      const changedExecutePayload = {
        ...projection.execute.payload,
        ...(field === "capabilityId" ? { capabilityId: "capability:changed" } : {}),
        ...(field === "capabilityVersion" ? { capabilityVersion: "9.9.9" } : {}),
        ...(field === "operation" ? { operation: "changed-operation" } : {}),
        ...(field === "inputRef" ? { inputRef: "payload:changed-input" } : {}),
        ...(field === "delegatedContextRefs"
          ? { delegatedContextRefs: ["payload:changed-context"] }
          : {}),
        ...(field === "secretRefs"
          ? {
              secretRefs: [
                {
                  secretRef: "secret:changed",
                  secretVersion: "version:changed",
                  purpose: "purpose:changed",
                },
              ],
            }
          : {}),
        ...(field === "resourceCeiling"
          ? {
              resourceCeiling: { ...projection.execute.payload.resourceCeiling, maxOutputBytes: 2 },
            }
          : {}),
        ...(field === "deadlineAt" ? { deadlineAt: "2026-08-26T00:00:31.000Z" } : {}),
      };
      const changedExecute = executionV2MessageSchema.parse({
        ...projection.execute,
        ...(field === "dataClassification" ? { dataClassification: "private" } : {}),
        payload: changedExecutePayload,
      });
      if (changedExecute.kind !== "request" || changedExecute.type !== "work.execute") {
        throw new TypeError("raw changed projection is invalid");
      }
      const changedProjection = {
        ...projection,
        execute: changedExecute,
      };
      const parsedAccepted = executionAdmissionV1MessageSchema.parse({
        schemaVersion: EXECUTION_ADMISSION_V1_SCHEMA_VERSION,
        kind: "response",
        type: "admission.work.execute.accepted",
        messageId: "raw-admission-accepted",
        correlationId: body.correlationId,
        causationId: body.messageId,
        payload: {
          requestMessageId: body.payload.execute.messageId,
          peer,
          receipt,
          disposition: "consumed",
          projection: changedProjection,
          reasonCode: null,
        },
      });
      if (parsedAccepted.type !== "admission.work.execute.accepted") {
        throw new TypeError("raw admission response has an unexpected type");
      }
      const accepted: ExecutionAdmissionWorkExecuteAccepted = parsedAccepted;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(accepted));
    });
    await new Promise<void>((resolve, reject) => {
      rawServer.once("error", reject);
      rawServer.listen(socketPath, resolve);
    });
    try {
      const client = new ExecutionAdmissionUdsClient(clientOptions(socketPath));
      await client.connect();
      await expect(client.admit(execute)).rejects.toMatchObject({
        code: EXECUTION_ADMISSION_UDS_ERROR_CODES.RESPONSE_IDENTITY_MISMATCH,
      });
    } finally {
      await new Promise<void>((resolve) => rawServer.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects stale response correlation, causation, peer and request identity", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "himawari-admission-raw-"));
    const socketPath = path.join(directory, "raw.sock");
    const rawServer = http.createServer(async (request, response) => {
      const body = executionAdmissionV1MessageSchema.parse(
        JSON.parse((await readBody(request)).toString("utf8")) as unknown,
      );
      const common = {
        schemaVersion: EXECUTION_ADMISSION_V1_SCHEMA_VERSION,
        kind: "response" as const,
        messageId: "raw-response",
        correlationId: "stale-correlation",
        causationId: body.messageId,
      };
      const result =
        body.type === "admission.handshake"
          ? {
              ...common,
              type: "admission.handshake.accepted" as const,
              payload: { peer, ready: true, acceptedAt: now() },
            }
          : {
              ...common,
              type: "admission.work.execute.accepted" as const,
              payload: {
                requestMessageId: "different-invocation",
                peer: { ...peer, workerBootId: "worker-boot:stale" },
                receipt,
                disposition: "replayed" as const,
                projection: null,
                reasonCode: null,
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
      const client = new ExecutionAdmissionUdsClient(clientOptions(socketPath));
      await expect(client.connect()).rejects.toMatchObject({
        code: EXECUTION_ADMISSION_UDS_ERROR_CODES.RESPONSE_IDENTITY_MISMATCH,
      });
    } finally {
      await new Promise<void>((resolve) => rawServer.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("does not turn handler failures into success or leak private errors", async () => {
    const server = await startServer({
      admit: async () => {
        throw new Error("private durable consume details");
      },
    });
    const client = new ExecutionAdmissionUdsClient(clientOptions(server.socketPath));
    await client.connect();
    await expect(client.admit(execute)).rejects.toMatchObject({
      code: EXECUTION_ADMISSION_UDS_ERROR_CODES.HANDLER_FAILED,
    });
    expect(client.isReady()).toBe(false);
    const raw = await rawRequest(
      server.socketPath,
      "/admission/v1/handshake",
      JSON.stringify(handshakeRequest()),
    );
    expect(raw.body.toString("utf8")).not.toContain("private durable consume details");
  });

  it("returns unknown when the trusted peer changes after durable admission", async () => {
    let currentPeer = peer;
    const server = await startServer(
      {
        admit: async () => {
          currentPeer = { ...peer, workerBootId: "worker-boot:rotated" };
          return consumedResult();
        },
      },
      { trustedPeerBinding: () => currentPeer },
    );
    const client = new ExecutionAdmissionUdsClient(clientOptions(server.socketPath));
    await client.connect();
    const result = await client.admit(execute);
    expect(result).toMatchObject({
      disposition: "unknown",
      receipt,
      requestMessageId: execute.messageId,
      peer,
      projection: null,
      reasonCode: "PEER_BINDING_CHANGED_AFTER_ADMISSION",
    });
    expect(client.isReady()).toBe(false);
  });

  it("uses a wall-clock deadline for a handler and never dispatches a late body", async () => {
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = await startServer(
      {
        admit: async () => {
          calls += 1;
          await pending;
          return consumedResult();
        },
      },
      { requestTimeoutMs: 35 },
    );
    const client = new ExecutionAdmissionUdsClient(
      clientOptions(server.socketPath, { requestTimeoutMs: 250 }),
    );
    await client.connect();
    await expect(client.admit(execute)).rejects.toMatchObject({
      code: EXECUTION_ADMISSION_UDS_ERROR_CODES.DEADLINE_EXCEEDED,
    });
    expect(calls).toBe(1);
    release();
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(client.isReady()).toBe(false);
  });
});

afterEach(async () => {
  await closeCleanup();
  idSequence = 0;
});
