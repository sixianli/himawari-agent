import { chmod, lstat, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { ExecutionTransportPort } from "@himawari-agent/application";
import {
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionV2Event,
  type ExecutionV2Request,
  type ExecutionV2Response,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXECUTION_UDS_ERROR_CODES,
  ExecutionUdsClient,
  type ExecutionUdsCredential,
  ExecutionUdsServer,
  readRestrictedExecutionTokenFile,
} from "../src/index.js";

const credential = Object.freeze({
  tokenRef: "secret-ref-worker-boot-test",
  tokenValue: "0123456789abcdef0123456789abcdef",
});
const agentInstanceId = "agent-service-contract-test";
const now = "2026-08-27T00:00:00.000Z";
const future = "2099-08-27T00:00:00.000Z";

function scope(work = false) {
  return {
    deploymentId: "deployment-contract-test",
    authorityEpoch: 1,
    fencingToken: 1,
    ownerId: work ? "owner-contract-test" : null,
    agentId: work ? "agent-contract-test" : null,
    runId: work ? "run-contract-test" : null,
    workerRunId: work ? "worker-run-contract-test" : null,
  };
}

function requestEnvelope(type: string, work = false) {
  return {
    schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
    kind: "request",
    type,
    messageId: `message-${type.replaceAll(".", "-")}`,
    correlationId: "correlation-contract-test",
    causationId: null,
    dataClassification: "private",
    risk: "low",
    authorizationRef: null,
    scope: scope(work),
    idempotencyKey: `idempotency-${type.replaceAll(".", "-")}`,
  };
}

function handshake(): Extract<ExecutionV2Request, { type: "worker.handshake" }> {
  return executionV2MessageSchema.parse({
    ...requestEnvelope("worker.handshake"),
    payload: {
      agentServiceInstanceId: agentInstanceId,
      bootTokenRef: credential.tokenRef,
      supportedSchemaVersions: [EXECUTION_V2_SCHEMA_VERSION],
      requestedAt: now,
    },
  }) as Extract<ExecutionV2Request, { type: "worker.handshake" }>;
}

function executeRequest(): Extract<ExecutionV2Request, { type: "work.execute" }> {
  return executionV2MessageSchema.parse({
    ...requestEnvelope("work.execute", true),
    causationId: "worker-delegation-contract-test",
    payload: {
      capabilityId: "contract-adapter",
      capabilityVersion: "1.0.0",
      operation: "read",
      inputRef: "payload-input-contract-test",
      capabilityHandleRef: "capability-handle-contract-test",
      delegatedContextRefs: [],
      secretRefs: [],
      resourceCeiling: {
        maxWallTimeMs: 10_000,
        maxCpuTimeMs: 5_000,
        maxMemoryBytes: 16_777_216,
        maxOutputBytes: 1_024,
        maxProgressEvents: 10,
      },
      requestedAt: now,
      deadlineAt: future,
    },
  }) as Extract<ExecutionV2Request, { type: "work.execute" }>;
}

class ContractTransport implements ExecutionTransportPort {
  requests: ExecutionV2Request[] = [];
  readonly replay: ExecutionV2Event[];

  constructor() {
    const event = executionV2MessageSchema.parse({
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "event",
      type: "work.result",
      messageId: "worker-result-contract-test",
      correlationId: "correlation-contract-test",
      causationId: "message-work-execute",
      dataClassification: "private",
      risk: "low",
      authorizationRef: null,
      scope: scope(true),
      payload: {
        requestId: "message-work-execute",
        cursor: "worker-cursor-contract-1",
        sequence: 1,
        completedAt: now,
        outcome: "succeeded",
        outputRef: "payload-result-contract-test",
        errorCode: null,
        externalActionId: null,
      },
    });
    if (event.kind !== "event") throw new TypeError("fixture must be an event");
    this.replay = [event];
  }

  async request(message: ExecutionV2Request): Promise<ExecutionV2Response | null> {
    this.requests.push(message);
    if (message.type !== "worker.handshake") return null;
    const response = executionV2MessageSchema.parse({
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "response",
      type: "worker.handshake.accepted",
      messageId: "worker-handshake-response-contract-test",
      correlationId: message.correlationId,
      causationId: message.messageId,
      dataClassification: message.dataClassification,
      risk: message.risk,
      authorizationRef: message.authorizationRef,
      scope: message.scope,
      payload: {
        workerInstanceId: "execution-worker-contract-test",
        workerBootId: "worker-boot-contract-test",
        selectedSchemaVersion: EXECUTION_V2_SCHEMA_VERSION,
        ready: true,
        acceptedAt: now,
      },
    });
    if (response.kind !== "response") throw new TypeError("fixture must be a response");
    return response;
  }

  async *events(afterCursor: string | null): AsyncIterable<ExecutionV2Event> {
    const start = afterCursor === null ? 0 : 1;
    for (const event of this.replay.slice(start)) yield event;
  }
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const cleanupPath of cleanupPaths.splice(0)) {
    await rm(cleanupPath, { recursive: true, force: true });
  }
});

async function runtimeDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "himawari-execution-uds-"));
  cleanupPaths.push(directory);
  return directory;
}

function client(socketPath: string, overrides: Partial<ExecutionUdsCredential> = {}) {
  return new ExecutionUdsClient({
    socketPath,
    credential: { ...credential, ...overrides },
    agentServiceInstanceId: agentInstanceId,
    maximumBodyBytes: 16_384,
    requestTimeoutMs: 1_000,
  });
}

describe("execution.v2 HTTP/JSON over UDS transport", () => {
  it("enforces directory/socket permissions, boot authentication, handshake and cursor replay", async () => {
    const directory = await runtimeDirectory();
    const transport = new ContractTransport();
    const server = new ExecutionUdsServer({
      runtimeDirectory: directory,
      credential,
      allowedAgentServiceInstanceIds: [agentInstanceId],
      transport,
      maximumBodyBytes: 16_384,
      requestTimeoutMs: 1_000,
    });
    await server.start();

    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(server.socketPath)).mode & 0o777).toBe(0o600);
    const udsClient = client(server.socketPath);
    await expect(udsClient.connect(handshake())).resolves.toMatchObject({
      type: "worker.handshake.accepted",
      payload: { selectedSchemaVersion: EXECUTION_V2_SCHEMA_VERSION, ready: true },
    });
    await expect(udsClient.request(executeRequest())).resolves.toBeNull();
    const first = [];
    for await (const event of udsClient.events(null)) first.push(event);
    expect(first).toHaveLength(1);
    const cursor = first[0]?.payload;
    expect(cursor && "cursor" in cursor ? cursor.cursor : null).toBe("worker-cursor-contract-1");
    const resumed = [];
    for await (const event of udsClient.events("worker-cursor-contract-1")) resumed.push(event);
    expect(resumed).toEqual([]);
    expect(transport.requests.map(({ type }) => type)).toEqual([
      "worker.handshake",
      "work.execute",
    ]);

    await server.stop();
  });

  it("rejects wrong boot token, unsupported content and oversized bodies before dispatch", async () => {
    const directory = await runtimeDirectory();
    const transport = new ContractTransport();
    const server = new ExecutionUdsServer({
      runtimeDirectory: directory,
      credential,
      allowedAgentServiceInstanceIds: [agentInstanceId],
      transport,
      maximumBodyBytes: 512,
      requestTimeoutMs: 1_000,
    });
    await server.start();

    await expect(
      client(server.socketPath, { tokenValue: "x".repeat(32) }).connect(handshake()),
    ).rejects.toMatchObject({ code: EXECUTION_UDS_ERROR_CODES.AUTHENTICATION_FAILED });
    const oversized = {
      ...executeRequest(),
      payload: {
        ...executeRequest().payload,
        delegatedContextRefs: Array.from(
          { length: 20 },
          (_, index) => `payload-delegated-contract-${index}`,
        ),
      },
    };
    await expect(client(server.socketPath).request(oversized)).rejects.toMatchObject({
      code: EXECUTION_UDS_ERROR_CODES.BODY_TOO_LARGE,
    });
    expect(transport.requests).toEqual([]);

    const status = await new Promise<number>((resolve, reject) => {
      const request = http.request(
        {
          socketPath: server.socketPath,
          path: "/execution/v2/messages",
          method: "POST",
          headers: {
            authorization: `Bearer ${credential.tokenValue}`,
            "content-type": "text/plain",
            "x-himawari-agent-service-instance": agentInstanceId,
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.once("error", reject);
      request.end("{}");
    });
    expect(status).toBe(415);
    await server.stop();
  });

  it("fails closed on handler deadline and never reuses an existing socket path", async () => {
    const directory = await runtimeDirectory();
    const transport: ExecutionTransportPort = {
      request: () => new Promise(() => {}),
      async *events() {},
    };
    const server = new ExecutionUdsServer({
      runtimeDirectory: directory,
      credential,
      allowedAgentServiceInstanceIds: [agentInstanceId],
      transport,
      maximumBodyBytes: 16_384,
      requestTimeoutMs: 25,
    });
    await server.start();
    await expect(client(server.socketPath).request(handshake())).rejects.toMatchObject({
      code: EXECUTION_UDS_ERROR_CODES.DEADLINE_EXCEEDED,
    });
    const competing = new ExecutionUdsServer({
      runtimeDirectory: directory,
      credential,
      allowedAgentServiceInstanceIds: [agentInstanceId],
      transport,
      maximumBodyBytes: 16_384,
      requestTimeoutMs: 25,
    });
    await expect(competing.start()).rejects.toMatchObject({
      code: EXECUTION_UDS_ERROR_CODES.SOCKET_EXISTS,
    });
    await server.stop();
  });

  it("does not unlink a socket path replaced after bind", async () => {
    const directory = await runtimeDirectory();
    const server = new ExecutionUdsServer({
      runtimeDirectory: directory,
      credential,
      allowedAgentServiceInstanceIds: [agentInstanceId],
      transport: new ContractTransport(),
      maximumBodyBytes: 16_384,
      requestTimeoutMs: 1_000,
    });
    await server.start();
    await rename(server.socketPath, `${server.socketPath}.bound`);
    await writeFile(server.socketPath, "replacement", { mode: 0o600 });
    await expect(server.stop()).rejects.toMatchObject({
      code: EXECUTION_UDS_ERROR_CODES.SOCKET_REPLACED,
    });
    expect((await lstat(server.socketPath)).isFile()).toBe(true);
    await rename(server.socketPath, `${server.socketPath}.replacement`);
    await rename(`${server.socketPath}.bound`, server.socketPath);
    await server.stop();
  });

  it("accepts only owner-only boot token files with a complete scoped credential", async () => {
    const directory = await runtimeDirectory();
    const tokenPath = path.join(directory, "worker-token.json");
    await writeFile(tokenPath, JSON.stringify(credential), { mode: 0o600 });
    await expect(readRestrictedExecutionTokenFile(tokenPath)).resolves.toEqual(credential);
    await chmod(tokenPath, 0o644);
    await expect(readRestrictedExecutionTokenFile(tokenPath)).rejects.toMatchObject({
      code: EXECUTION_UDS_ERROR_CODES.AUTHENTICATION_FAILED,
    });
  });
});
