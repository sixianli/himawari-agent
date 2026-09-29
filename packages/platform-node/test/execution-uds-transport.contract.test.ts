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
import { setTimeout as delay } from "node:timers/promises";
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

const paginationHeader = "x-himawari-events-pagination";
const pageHeader = "x-himawari-events-page";
const nextCursorHeader = "x-himawari-events-next-cursor";

function fixtureValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required fixture value missing");
  return value;
}

function historyEvents(count: number): ExecutionV2Event[] {
  const first = fixtureValue(new ContractTransport().replay[0]);
  return Array.from({ length: count }, (_, index) => {
    const event = executionV2MessageSchema.parse({
      ...first,
      messageId: `result-${index}`,
      payload: { ...first.payload, cursor: `cursor:${index}`, sequence: index + 1 },
    });
    if (event.kind !== "event") throw new Error("Event fixture required");
    return event;
  });
}

function eventLine(event: ExecutionV2Event): string {
  return `${executionV2MessageSchema.serialize(event)}\n`;
}

async function collectEvents(events: AsyncIterable<ExecutionV2Event>) {
  const result = [];
  for await (const event of events) result.push(event);
  return result;
}

async function pagedServer(history: ExecutionV2Event[], maximumBodyBytes: number) {
  const cursors: (string | null)[] = [];
  const server = new ExecutionUdsServer({
    runtimeDirectory: await runtimeDirectory(),
    credential,
    allowedAgentServiceInstanceIds: [agentInstanceId],
    maximumBodyBytes,
    requestTimeoutMs: 1_000,
    transport: {
      request: (message) => new ContractTransport().request(message),
      async *events(afterCursor) {
        cursors.push(afterCursor);
        const start =
          afterCursor === null
            ? 0
            : history.findIndex((event) => event.payload.cursor === afterCursor) + 1;
        if (afterCursor !== null && start === 0) throw new Error("Unknown cursor");
        yield* history.slice(start);
      },
    },
  });
  await server.start();
  return { server, cursors };
}

async function rawPage(socketPath: string, headers: Record<string, string> = {}, cursor?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>(
    (resolve, reject) => {
      const request = http.request(
        {
          socketPath,
          path: `/execution/v2/events${cursor ? `?afterCursor=${encodeURIComponent(cursor)}` : ""}`,
          headers: {
            authorization: `Bearer ${credential.tokenValue}`,
            "x-himawari-agent-service-instance": agentInstanceId,
            [paginationHeader]: "1",
            ...headers,
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.once("error", reject);
          response.once("end", () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      request.once("error", reject);
      request.end();
    },
  );
}

async function scriptedPages(
  handler: (request: http.IncomingMessage, response: http.ServerResponse, index: number) => void,
  timeoutMs = 1_000,
) {
  const socketPath = path.join(await runtimeDirectory(), "scripted.sock");
  const requests: http.IncomingMessage[] = [];
  const server = http.createServer((request, response) => {
    requests.push(request);
    handler(request, response, requests.length - 1);
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    requests,
    client: new ExecutionUdsClient({
      socketPath,
      credential,
      agentServiceInstanceId: agentInstanceId,
      maximumBodyBytes: 16_384,
      requestTimeoutMs: timeoutMs,
    }),
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function sendPage(
  response: http.ServerResponse,
  events: ExecutionV2Event[],
  more: boolean,
  overrides: Record<string, string> = {},
) {
  response.writeHead(200, {
    "content-type": "application/x-ndjson",
    [paginationHeader]: "1",
    [pageHeader]: more ? "more" : "complete",
    ...(events.length
      ? { [nextCursorHeader]: encodeURIComponent(fixtureValue(events.at(-1)).payload.cursor) }
      : {}),
    ...overrides,
  });
  response.end(events.map(eventLine).join(""));
}

describe("execution.v2 HTTP/JSON over UDS transport", () => {
  it.each([0, -1])(
    "counts serialized bytes including newlines at the exact page boundary (%i)",
    async (adjustment) => {
      const history = historyEvents(3);
      const maximumBodyBytes =
        Buffer.byteLength(
          eventLine(fixtureValue(history[0])) + eventLine(fixtureValue(history[1])),
        ) + adjustment;
      const { server } = await pagedServer(history, maximumBodyBytes);
      try {
        const first = await rawPage(server.socketPath);
        const expectedCount = adjustment === 0 ? 2 : 1;
        expect(first.status).toBe(200);
        expect(first.body).toEqual(
          Buffer.from(history.slice(0, expectedCount).map(eventLine).join("")),
        );
        expect(first.body.byteLength).toBeLessThanOrEqual(maximumBodyBytes);
        expect(first.headers[paginationHeader]).toBe("1");
        expect(first.headers[pageHeader]).toBe("more");
        expect(first.headers[nextCursorHeader]).toBe(
          encodeURIComponent(fixtureValue(history[expectedCount - 1]).payload.cursor),
        );
        expect(await collectEvents(client(server.socketPath).events(null))).toEqual(history);
        const empty = await rawPage(
          server.socketPath,
          {},
          fixtureValue(history.at(-1)).payload.cursor,
        );
        expect(empty.headers[pageHeader]).toBe("complete");
        expect(empty.headers[nextCursorHeader]).toBeUndefined();
        expect(empty.body.byteLength).toBe(0);
      } finally {
        await server.stop();
      }
    },
  );

  it("rejects a single oversized event with a readable error and no partial NDJSON", async () => {
    const history = historyEvents(1);
    const { server } = await pagedServer(
      history,
      Buffer.byteLength(eventLine(fixtureValue(history[0]))) - 1,
    );
    try {
      const response = await rawPage(server.socketPath);
      expect(response.status).toBe(413);
      expect(JSON.parse(response.body.toString())).toMatchObject({
        error: { code: EXECUTION_UDS_ERROR_CODES.BODY_TOO_LARGE },
      });
      await expect(collectEvents(client(server.socketPath).events(null))).rejects.toMatchObject({
        code: EXECUTION_UDS_ERROR_CODES.BODY_TOO_LARGE,
      });
    } finally {
      await server.stop();
    }
  });

  it.each(["", "0", "2"])(
    "rejects absent or unsupported Agent pagination version %s before reading history",
    async (version) => {
      const { server, cursors } = await pagedServer(historyEvents(2), 16_384);
      try {
        const response = await rawPage(server.socketPath, { [paginationHeader]: version });
        expect(response.status).toBe(400);
        expect(cursors).toEqual([]);
      } finally {
        await server.stop();
      }
    },
  );

  it.each([
    { authorization: "Bearer wrong-token", code: EXECUTION_UDS_ERROR_CODES.AUTHENTICATION_FAILED },
    {
      "x-himawari-agent-service-instance": "wrong-instance",
      code: EXECUTION_UDS_ERROR_CODES.INSTANCE_REJECTED,
    },
  ])("authenticates every continuation request: $code", async ({ code, ...headers }) => {
    const history = historyEvents(3);
    const { server, cursors } = await pagedServer(
      history,
      Buffer.byteLength(eventLine(fixtureValue(history[0]))),
    );
    try {
      expect((await rawPage(server.socketPath)).status).toBe(200);
      const response = await rawPage(
        server.socketPath,
        headers as Record<string, string>,
        fixtureValue(history[0]).payload.cursor,
      );
      expect(JSON.parse(response.body.toString())).toMatchObject({ error: { code } });
      expect(cursors).toEqual([null]);
    } finally {
      await server.stop();
    }
  });

  it.each([
    {
      name: "missing version",
      headers: { [paginationHeader]: "" },
      events: 1,
      more: false,
      code: EXECUTION_UDS_ERROR_CODES.INVALID_RESPONSE,
    },
    {
      name: "unknown version",
      headers: { [paginationHeader]: "2" },
      events: 1,
      more: false,
      code: EXECUTION_UDS_ERROR_CODES.INVALID_RESPONSE,
    },
    {
      name: "missing completion",
      headers: { [pageHeader]: "" },
      events: 1,
      more: false,
      code: EXECUTION_UDS_ERROR_CODES.INVALID_RESPONSE,
    },
    {
      name: "unknown completion",
      headers: { [pageHeader]: "unknown" },
      events: 1,
      more: false,
      code: EXECUTION_UDS_ERROR_CODES.INVALID_RESPONSE,
    },
    {
      name: "mismatched cursor",
      headers: { [nextCursorHeader]: "wrong" },
      events: 1,
      more: true,
      code: EXECUTION_UDS_ERROR_CODES.CURSOR_INVALID,
    },
    {
      name: "missing cursor",
      headers: { [nextCursorHeader]: "" },
      events: 1,
      more: true,
      code: EXECUTION_UDS_ERROR_CODES.CURSOR_INVALID,
    },
    {
      name: "empty continuing page",
      headers: {},
      events: 0,
      more: true,
      code: EXECUTION_UDS_ERROR_CODES.CURSOR_INVALID,
    },
    {
      name: "empty final page with cursor",
      headers: { [nextCursorHeader]: "wrong" },
      events: 0,
      more: false,
      code: EXECUTION_UDS_ERROR_CODES.CURSOR_INVALID,
    },
  ])(
    "fails closed before yielding a malformed page: $name",
    async ({ headers, events, more, code }) => {
      const scripted = await scriptedPages((_request, response) =>
        sendPage(response, historyEvents(events), more, headers),
      );
      try {
        await expect(
          scripted.client.events(null)[Symbol.asyncIterator]().next(),
        ).rejects.toMatchObject({ code });
        expect(scripted.requests).toHaveLength(1);
      } finally {
        await scripted.stop();
      }
    },
  );

  it.each(["within-page", "across-pages", "initial-cursor"])(
    "rejects duplicate or non-advancing cursors: %s",
    async (mode) => {
      const [event] = historyEvents(1);
      const scripted = await scriptedPages((_request, response) =>
        sendPage(
          response,
          mode === "within-page"
            ? [fixtureValue(event), fixtureValue(event)]
            : [fixtureValue(event)],
          mode === "across-pages",
        ),
      );
      try {
        await expect(
          collectEvents(
            scripted.client.events(
              mode === "initial-cursor" ? fixtureValue(event).payload.cursor : null,
            ),
          ),
        ).rejects.toMatchObject({ code: EXECUTION_UDS_ERROR_CODES.CURSOR_INVALID });
        expect(scripted.requests).toHaveLength(mode === "across-pages" ? 2 : 1);
      } finally {
        await scripted.stop();
      }
    },
  );

  it("stops fetching pages when the caller exits early", async () => {
    const history = historyEvents(3);
    const scripted = await scriptedPages((_request, response, index) =>
      sendPage(response, [fixtureValue(history[index])], index < 2),
    );
    try {
      for await (const event of scripted.client.events(null)) {
        expect(event).toEqual(history[0]);
        break;
      }
      expect(scripted.requests).toHaveLength(1);
      expect(fixtureValue(scripted.requests[0]).headers[paginationHeader]).toBe("1");
    } finally {
      await scripted.stop();
    }
  });

  it("cancels an in-flight continuation when the caller returns the iterator", async () => {
    const history = historyEvents(2);
    let requested!: () => void;
    let closed!: () => void;
    const continuationRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    const continuationClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const scripted = await scriptedPages((_request, response, index) => {
      if (index === 0) sendPage(response, [fixtureValue(history[0])], true);
      else {
        response.once("close", closed);
        requested();
      }
    }, 5_000);
    try {
      const iterator = scripted.client.events(null)[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual(history[0]);
      const pending = iterator.next().catch((error: unknown) => error);
      await continuationRequested;
      if (!iterator.return) throw new Error("Cancellable iterator required");
      const returned = iterator.return();
      await Promise.race([
        Promise.all([returned, continuationClosed]),
        delay(500).then(() => {
          throw new Error("Cancellation did not close continuation");
        }),
      ]);
      await pending;
      expect(scripted.requests).toHaveLength(2);
    } finally {
      await scripted.stop();
    }
  });

  it("uses one deadline across pages, including caller processing time", async () => {
    const history = historyEvents(2);
    const scripted = await scriptedPages((_request, response, index) => {
      if (index === 0) sendPage(response, [fixtureValue(history[0])], true);
    }, 300);
    try {
      const iterator = scripted.client.events(null)[Symbol.asyncIterator]();
      await iterator.next();
      await delay(200);
      const started = performance.now();
      await expect(iterator.next()).rejects.toMatchObject({
        code: EXECUTION_UDS_ERROR_CODES.DEADLINE_EXCEEDED,
      });
      expect(performance.now() - started).toBeLessThan(200);
      expect(scripted.requests).toHaveLength(2);
    } finally {
      await scripted.stop();
    }
  });

  it("does not fetch another page once the original deadline has expired", async () => {
    const scripted = await scriptedPages(
      (_request, response) => sendPage(response, historyEvents(1), true),
      50,
    );
    try {
      const iterator = scripted.client.events(null)[Symbol.asyncIterator]();
      await iterator.next();
      await delay(70);
      await expect(iterator.next()).rejects.toMatchObject({
        code: EXECUTION_UDS_ERROR_CODES.DEADLINE_EXCEEDED,
      });
      expect(scripted.requests).toHaveLength(1);
    } finally {
      await scripted.stop();
    }
  });

  it("continues from the last delivered cursor when new events arrive between pages", async () => {
    const history = historyEvents(2);
    const { server, cursors } = await pagedServer(
      history,
      Buffer.byteLength(eventLine(fixtureValue(history[0]))),
    );
    try {
      const iterator = client(server.socketPath).events(null)[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toEqual(history[0]);
      history.push(fixtureValue(historyEvents(3)[2]));
      expect((await iterator.next()).value).toEqual(history[1]);
      expect((await iterator.next()).value).toEqual(history[2]);
      expect((await iterator.next()).done).toBe(true);
      expect(cursors).toEqual([
        null,
        fixtureValue(history[0]).payload.cursor,
        fixtureValue(history[1]).payload.cursor,
      ]);
    } finally {
      await server.stop();
    }
  });

  it("replays every bounded event when the accumulated history exceeds one response budget", async () => {
    const directory = await runtimeDirectory();
    const transport = new ContractTransport();
    const first = transport.replay[0];
    if (!first || first.type !== "work.result") throw new Error("Result fixture required");
    const history = Array.from({ length: 100 }, (_, index) => {
      const event = executionV2MessageSchema.parse({
        ...first,
        messageId: `result-history-${index}`,
        payload: { ...first.payload, cursor: `cursor-history-${index}`, sequence: index + 1 },
      });
      if (event.kind !== "event") throw new Error("Event fixture required");
      return event;
    });
    const maximumBodyBytes = 65_536;
    const sizes = history.map((event) =>
      Buffer.byteLength(`${executionV2MessageSchema.serialize(event)}\n`),
    );
    expect(Math.max(...sizes)).toBeLessThan(maximumBodyBytes);
    expect(sizes.reduce((total, size) => total + size, 0)).toBeGreaterThan(maximumBodyBytes);
    const server = new ExecutionUdsServer({
      runtimeDirectory: directory,
      credential,
      allowedAgentServiceInstanceIds: [agentInstanceId],
      maximumBodyBytes,
      requestTimeoutMs: 1_000,
      transport: {
        request: (message) => transport.request(message),
        async *events(afterCursor) {
          const start =
            afterCursor === null
              ? 0
              : history.findIndex((event) => event.payload.cursor === afterCursor) + 1;
          if (afterCursor !== null && start === 0) throw new Error("Unknown cursor");
          yield* history.slice(start);
        },
      },
    });
    await server.start();
    try {
      const udsClient = new ExecutionUdsClient({
        socketPath: server.socketPath,
        credential,
        agentServiceInstanceId: agentInstanceId,
        maximumBodyBytes,
        requestTimeoutMs: 1_000,
      });
      await udsClient.connect(handshake());
      const received: ExecutionV2Event[] = [];
      for await (const event of udsClient.events(null)) received.push(event);
      expect(received).toEqual(history);
      const resumed: ExecutionV2Event[] = [];
      for await (const event of udsClient.events("cursor-history-95")) resumed.push(event);
      expect(resumed).toEqual(history.slice(96));
    } finally {
      await server.stop();
    }
  });

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
