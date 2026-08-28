import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentGatewayService,
  type AgentGatewayV2Port,
  type AgentThreadGatewayPort,
  ApplicationPortError,
  type GatewayAccessPolicyPort,
  type GatewayAuthenticationContext,
  type GatewayCommandExecution,
  type GatewayControlPlanePort,
  type GatewayReadModelPort,
  PORT_ERROR_CODES,
} from "@himawari-agent/application";
import {
  type EventSubscription,
  type GatewayCommand,
  type GatewayV2Event,
  type GetRunSnapshotQuery,
  type GetThreadSnapshotQuery,
  type RunSnapshot,
  type StreamEvent,
  type ThreadSnapshot,
  type ThreadGatewayEvent,
  type ThreadGatewayRequestResult,
  type TraceQuery,
  threadGatewayMessageSchema,
} from "@himawari-agent/gateway-contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildHttpGatewayServer,
  HTTP_GATEWAY_ERROR_CODES,
  type HttpGatewayAuthenticationPort,
  type HttpGatewayServerOptions,
} from "../src/http-gateway-server.js";
import { RuntimeHealthModel } from "../src/runtime-health.js";
import { RuntimeMetricsRegistry } from "../src/runtime-observability.js";

const ORIGIN = "https://agent.example.test";
const NOW = "2026-08-27T00:00:00.000Z";
const authentication: GatewayAuthenticationContext = Object.freeze({
  subjectId: "owner-01",
  ownerId: "owner-01",
  deviceId: "device-01",
  authenticatedAt: NOW,
  authenticationRef: "session-01",
});

function envelope(kind: "command" | "query" | "subscription", type: string) {
  return {
    schemaVersion: "gateway.v1" as const,
    kind,
    type,
    messageId: `message:${type}`,
    correlationId: "correlation-01",
    causationId: null,
    dataClassification: "private" as const,
    scope: { ownerId: "owner-01", agentId: "agent-01" },
    actor: { actorType: "owner" as const, actorId: "owner-01" },
  };
}

function command(overrides: Partial<GatewayCommand> = {}): GatewayCommand {
  return {
    ...envelope("command", "trigger.admit"),
    kind: "command",
    type: "trigger.admit",
    idempotencyKey: "idempotency-01",
    payload: {
      triggerId: "trigger-01",
      sourceType: "user_message",
      sourceId: "source-01",
      occurredAt: NOW,
      threadId: "thread-01",
      payloadRef: "payload-01",
      sourceProofRef: "proof-01",
    },
    ...overrides,
  } as GatewayCommand;
}

function subscription(afterCursor: string | null = "cursor-01"): EventSubscription {
  return {
    ...envelope("subscription", "events.subscribe"),
    kind: "subscription",
    type: "events.subscribe",
    payload: {
      subscriptionId: "subscription-01",
      sessionId: "session-01",
      threadId: "thread-01",
      runId: "run-01",
      afterCursor,
    },
  };
}

function encodeSubscription(value: EventSubscription): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function event(cursor: string, sequence: number): StreamEvent {
  return {
    ...envelope("subscription", "events.subscribe"),
    kind: "event",
    type: "stream.event",
    messageId: `event:${cursor}`,
    causationId: "message:events.subscribe",
    payload: {
      cursor,
      sessionId: "session-01",
      threadId: "thread-01",
      runId: "run-01",
      turnId: null,
      parentEventId: null,
      sequence,
      occurredAt: NOW,
      recordedAt: NOW,
      eventType: "run.changed",
      payloadRef: null,
    },
  };
}

class AccessPolicy implements GatewayAccessPolicyPort {
  readonly observed: string[] = [];

  async authorize(input: { readonly message: { readonly type: string } }) {
    this.observed.push(input.message.type);
    return { allowed: true, reasonCode: "OWNER_DEVICE_AUTHORIZED" };
  }
}

class ControlPlane implements GatewayControlPlanePort {
  readonly executions: GatewayCommandExecution[] = [];
  private readonly accepted = new Map<string, string>();

  async execute(input: GatewayCommandExecution) {
    this.executions.push(input);
    const existing = this.accepted.get(input.command.idempotencyKey);
    if (existing) return { resultRef: existing, replayed: true };
    const resultRef = "run:run-01";
    this.accepted.set(input.command.idempotencyKey, resultRef);
    return { resultRef, replayed: false };
  }
}

class ReadModel implements GatewayReadModelPort {
  staleCursor = false;
  delayMilliseconds = 0;
  events: readonly StreamEvent[] = [event("cursor-02", 2)];

  async getThreadSnapshot(query: GetThreadSnapshotQuery): Promise<ThreadSnapshot> {
    return {
      ...query,
      kind: "snapshot",
      type: "thread.snapshot",
      messageId: "snapshot:thread-01",
      causationId: query.messageId,
      payload: {
        threadId: query.payload.threadId,
        status: "open",
        revision: 3,
        sessionIds: ["session-01"],
        runIds: ["run-01"],
      },
    };
  }

  async getRunSnapshot(query: GetRunSnapshotQuery): Promise<RunSnapshot> {
    return {
      ...query,
      kind: "snapshot",
      type: "run.snapshot",
      messageId: "snapshot:run-01",
      causationId: query.messageId,
      payload: {
        runId: query.payload.runId,
        threadId: "thread-01",
        sessionId: "session-01",
        triggerId: "trigger-01",
        status: "completed",
        revision: 4,
        latestSequence: 2,
        activeApprovalRequestId: null,
      },
    };
  }

  async queryTrace(_query: TraceQuery): Promise<readonly StreamEvent[]> {
    return this.events;
  }

  async *subscribe(_subscription: EventSubscription): AsyncIterable<StreamEvent> {
    if (this.staleCursor) {
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "cursor outside retention");
    }
    if (this.delayMilliseconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMilliseconds));
    }
    for (const item of this.events) yield item;
  }
}

class Authentication implements HttpGatewayAuthenticationPort {
  readonly observed: Array<{ readonly accessAssertion: string | null; readonly path: string }> = [];

  async authenticate(input: { readonly accessAssertion: string | null; readonly path: string }) {
    this.observed.push(input);
    if (input.accessAssertion !== "assertion-01") throw new Error("AUTHENTICATION_REJECTED");
    return authentication;
  }
}

let staticRoot: string;

beforeAll(async () => {
  staticRoot = await mkdtemp(path.join(tmpdir(), "himawari-http-gateway-"));
  await mkdir(path.join(staticRoot, "assets"));
  await writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>Himawari</title>");
  await writeFile(path.join(staticRoot, "assets", "app.js"), "globalThis.__himawari = true;");
});

afterAll(async () => {
  await rm(staticRoot, { recursive: true, force: true });
});

function requestHeaders(idempotencyKey = "idempotency-01") {
  return {
    host: "agent.example.test",
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json; charset=utf-8",
    "cf-access-jwt-assertion": "assertion-01",
    cookie: "himawari_session=session-token-01",
    "x-csrf-token": "csrf-01",
    "idempotency-key": idempotencyKey,
  };
}

function omitHeader(headers: ReturnType<typeof requestHeaders>, name: keyof typeof headers) {
  const result: Partial<ReturnType<typeof requestHeaders>> = { ...headers };
  delete result[name];
  return result;
}

function createFixture(
  gatewayV2?: AgentGatewayV2Port,
  threadGateway?: AgentThreadGatewayPort,
  extensions: Pick<
    HttpGatewayServerOptions,
    "browserConfiguration" | "payloadAdmission" | "payloadRead" | "threadSearch"
  > = {},
) {
  const access = new AccessPolicy();
  const controlPlane = new ControlPlane();
  const reads = new ReadModel();
  const auth = new Authentication();
  const gateway = new AgentGatewayService({ access, controlPlane, reads });
  const app = buildHttpGatewayServer({
    gateway,
    ...(gatewayV2 ? { gatewayV2 } : {}),
    ...(threadGateway ? { threadGateway } : {}),
    ...extensions,
    authentication: auth,
    csrf: {
      async verify(input) {
        return input.token === "csrf-01" && input.authentication === authentication;
      },
    },
    publicOrigin: ORIGIN,
    staticRoot,
    maximumBodyBytes: 2048,
    heartbeatMilliseconds: 20,
  });
  return { access, controlPlane, reads, auth, app };
}

describe("HTTP Gateway contract and security boundary", () => {
  const fixtures: ReturnType<typeof createFixture>[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(({ app }) => app.close()));
  });

  function fixture() {
    const result = createFixture();
    fixtures.push(result);
    return result;
  }

  it("serves only same-origin static assets with restrictive browser headers", async () => {
    const { app } = fixture();
    const page = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "agent.example.test" },
    });
    const asset = await app.inject({
      method: "GET",
      url: "/assets/app.js",
      headers: { host: "agent.example.test" },
    });

    expect(page.statusCode).toBe(200);
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["cache-control"]).toBe("no-cache");
    expect(asset.headers["cache-control"]).toContain("immutable");
  });

  it("serves the SPA shell for HTML deep links without masking API or asset failures", async () => {
    const { app } = fixture();
    const deepLink = await app.inject({
      method: "GET",
      url: "/threads/thread-01?cursor=cursor-01",
      headers: { accept: "text/html", host: "agent.example.test" },
    });
    const unknownApi = await app.inject({
      method: "GET",
      url: "/api/not-defined",
      headers: { accept: "text/html", host: "agent.example.test" },
    });
    const nonHtmlDeepLink = await app.inject({
      method: "GET",
      url: "/threads/thread-01",
      headers: { accept: "application/json", host: "agent.example.test" },
    });

    expect(deepLink.statusCode).toBe(200);
    expect(deepLink.headers["content-type"]).toContain("text/html");
    expect(deepLink.headers["cache-control"]).toBe("no-cache");
    expect(deepLink.body).toContain("<title>Himawari</title>");
    expect(unknownApi.statusCode).toBe(404);
    expect(unknownApi.headers["content-type"]).toContain("application/json");
    expect(nonHtmlDeepLink.statusCode).toBe(404);
  });

  it("parses, authenticates, authorizes and replays idempotent commands", async () => {
    const { access, controlPlane, auth, app } = fixture();
    const first = await app.inject({
      method: "POST",
      url: "/api/gateway/v1/commands",
      headers: requestHeaders(),
      payload: command(),
    });
    const replay = await app.inject({
      method: "POST",
      url: "/api/gateway/v1/commands",
      headers: requestHeaders(),
      payload: command(),
    });

    expect(first.json()).toEqual({ resultRef: "run:run-01", replayed: false });
    expect(replay.json()).toEqual({ resultRef: "run:run-01", replayed: true });
    expect(auth.observed).toHaveLength(2);
    expect(access.observed).toEqual(["trigger.admit", "trigger.admit"]);
    expect(controlPlane.executions.map(({ authentication }) => authentication)).toEqual([
      authentication,
      authentication,
    ]);
  });

  it("routes strict queries through authentication, scope policy and Read Model", async () => {
    const { access, app } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/gateway/v1/queries",
      headers: requestHeaders(),
      payload: {
        ...envelope("query", "run.get_snapshot"),
        kind: "query",
        type: "run.get_snapshot",
        payload: { runId: "run-01" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ type: "run.snapshot", payload: { revision: 4 } });
    expect(access.observed).toEqual(["run.get_snapshot"]);
  });

  it("resumes SSE by durable cursor and performs bounded snapshot refresh for stale cursors", async () => {
    const current = fixture();
    const resumed = await current.app.inject({
      method: "GET",
      url: `/api/gateway/v1/events?subscription=${encodeSubscription(subscription())}`,
      headers: {
        host: "agent.example.test",
        "cf-access-jwt-assertion": "assertion-01",
      },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.headers["content-type"]).toContain("text/event-stream");
    expect(resumed.body).toContain("id: cursor-02");
    expect(resumed.body).toContain("event: message");

    const stale = fixture();
    stale.reads.staleCursor = true;
    const refreshed = await stale.app.inject({
      method: "GET",
      url: `/api/gateway/v1/events?subscription=${encodeSubscription(subscription("cursor-old"))}`,
      headers: {
        host: "agent.example.test",
        "cf-access-jwt-assertion": "assertion-01",
      },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.body.match(/event: gateway\.snapshot/g)).toHaveLength(2);
    expect(stale.access.observed).toEqual([
      "events.subscribe",
      "thread.get_snapshot",
      "run.get_snapshot",
    ]);
    expect(stale.controlPlane.executions).toEqual([]);
  });

  it("emits heartbeat comments while waiting and rejects malformed event ordering", async () => {
    const delayed = fixture();
    delayed.reads.delayMilliseconds = 35;
    const heartbeat = await delayed.app.inject({
      method: "GET",
      url: `/api/gateway/v1/events?subscription=${encodeSubscription(subscription())}`,
      headers: {
        host: "agent.example.test",
        "cf-access-jwt-assertion": "assertion-01",
      },
    });
    expect(heartbeat.body).toContain(": heartbeat");
    expect(heartbeat.body).toContain("id: cursor-02");

    const duplicate = fixture();
    duplicate.reads.events = [event("cursor-02", 2), event("cursor-02", 3)];
    const duplicateResponse = await duplicate.app.inject({
      method: "GET",
      url: `/api/gateway/v1/events?subscription=${encodeSubscription(subscription())}`,
      headers: {
        host: "agent.example.test",
        "cf-access-jwt-assertion": "assertion-01",
      },
    });
    expect(duplicateResponse.body).toContain("event: gateway.stream_error");
    expect(duplicateResponse.body).toContain(PORT_ERROR_CODES.INVALID_OPERATION);

    const nonIncreasing = fixture();
    nonIncreasing.reads.events = [event("cursor-02", 2), event("cursor-03", 1)];
    const nonIncreasingResponse = await nonIncreasing.app.inject({
      method: "GET",
      url: `/api/gateway/v1/events?subscription=${encodeSubscription(subscription())}`,
      headers: {
        host: "agent.example.test",
        "cf-access-jwt-assertion": "assertion-01",
      },
    });
    expect(nonIncreasingResponse.body).toContain(PORT_ERROR_CODES.INVALID_OPERATION);
  });

  it.each([
    ["missing assertion", omitHeader(requestHeaders(), "cf-access-jwt-assertion"), 401],
    ["forged assertion", { ...requestHeaders(), "cf-access-jwt-assertion": "forged" }, 401],
    ["wrong origin", { ...requestHeaders(), origin: "https://evil.example" }, 403],
    ["direct origin host", { ...requestHeaders(), host: "127.0.0.1:8787" }, 403],
    ["cross-site fetch", { ...requestHeaders(), "sec-fetch-site": "cross-site" }, 403],
    ["missing csrf", omitHeader(requestHeaders(), "x-csrf-token"), 403],
    ["wrong media type", { ...requestHeaders(), "content-type": "text/plain" }, 415],
    ["wrong idempotency key", requestHeaders("different-key"), 400],
  ])("rejects %s before the Control Plane", async (_label, headers, statusCode) => {
    const { controlPlane, app } = fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/gateway/v1/commands",
      headers,
      payload: command(),
    });
    expect(response.statusCode).toBe(statusCode);
    expect(controlPlane.executions).toEqual([]);
  });

  it("rejects unsupported schemas, spoofed identity and cross-owner scope before Control Plane", async () => {
    const unsupported = fixture();
    const unsupportedResponse = await unsupported.app.inject({
      method: "POST",
      url: "/api/gateway/v1/commands",
      headers: requestHeaders(),
      payload: { ...command(), schemaVersion: "gateway.v999" },
    });
    expect(unsupportedResponse.statusCode).toBe(400);
    expect(unsupported.controlPlane.executions).toEqual([]);

    const crossOwner = fixture();
    const crossOwnerResponse = await crossOwner.app.inject({
      method: "POST",
      url: "/api/gateway/v1/commands",
      headers: { ...requestHeaders(), "x-owner-id": "owner-02" },
      payload: command({ scope: { ownerId: "owner-02", agentId: "agent-01" } }),
    });
    expect(crossOwnerResponse.statusCode).toBe(403);
    expect(crossOwner.controlPlane.executions).toEqual([]);
  });

  it("bounds request bodies and exposes health on separate minimal routes", async () => {
    const { app } = fixture();
    const oversized = await app.inject({
      method: "POST",
      url: "/api/gateway/v1/commands",
      headers: requestHeaders(),
      payload: { value: "x".repeat(4096) },
    });
    const health = await app.inject({ method: "GET", url: "/health/live" });

    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toEqual({
      error: { code: HTTP_GATEWAY_ERROR_CODES.BODY_INVALID },
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "alive" });
  });

  it("keeps public health minimal and requires authentication for dependency details", async () => {
    const health = new RuntimeHealthModel({ publicMode: true, now: () => NOW });
    const metrics = new RuntimeMetricsRegistry({ now: () => NOW });
    metrics.increment("model_calls_total", 2);
    health.setLive(true);
    const app = buildHttpGatewayServer({
      gateway: new AgentGatewayService({
        access: new AccessPolicy(),
        controlPlane: new ControlPlane(),
        reads: new ReadModel(),
      }),
      authentication: new Authentication(),
      csrf: { verify: async () => true },
      publicOrigin: ORIGIN,
      staticRoot,
      health,
      metrics,
    });
    fixtures.push({
      access: new AccessPolicy(),
      controlPlane: new ControlPlane(),
      reads: new ReadModel(),
      auth: new Authentication(),
      app,
    });
    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/api/health/v1/dependencies",
      headers: { host: "agent.example.test" },
    });
    const detailed = await app.inject({
      method: "GET",
      url: "/api/health/v1/dependencies",
      headers: {
        host: "agent.example.test",
        "cf-access-jwt-assertion": "assertion-01",
        cookie: "himawari_session=session-token-01",
      },
    });
    const unauthenticatedMetrics = await app.inject({
      method: "GET",
      url: "/api/metrics/v1",
      headers: { host: "agent.example.test" },
    });
    const detailedMetrics = await app.inject({
      method: "GET",
      url: "/api/metrics/v1",
      headers: {
        host: "agent.example.test",
        "cf-access-jwt-assertion": "assertion-01",
        cookie: "himawari_session=session-token-01",
      },
    });
    expect(live).toMatchObject({ statusCode: 200 });
    expect(live.json()).toEqual({ status: "alive" });
    expect(ready).toMatchObject({ statusCode: 503 });
    expect(ready.json()).toEqual({ status: "not_ready" });
    expect(unauthenticated).toMatchObject({ statusCode: 401 });
    expect(unauthenticated.body).not.toContain("authority");
    expect(detailed).toMatchObject({ statusCode: 200 });
    expect(detailed.json()).toMatchObject({
      live: true,
      ready: false,
      dependencies: expect.arrayContaining([
        expect.objectContaining({ name: "authority", reasonCode: "NOT_STARTED" }),
      ]),
    });
    expect(detailed.body).not.toContain("/Users/");
    expect(unauthenticatedMetrics).toMatchObject({ statusCode: 401 });
    expect(detailedMetrics).toMatchObject({ statusCode: 200 });
    expect(detailedMetrics.json()).toMatchObject({
      schemaVersion: 1,
      metrics: expect.arrayContaining([
        { name: "model_calls_total", kind: "counter", value: 2, updatedAt: NOW },
      ]),
    });
    expect(detailedMetrics.body).not.toContain("owner-01");
  });

  it("applies the authenticated boundary to typed v2 commands, queries and events", async () => {
    const requests: string[] = [];
    const cursors: Array<string | null> = [];
    const gatewayV2: AgentGatewayV2Port = {
      async request(_authentication, message) {
        requests.push(message.type);
        if (message.kind === "command") return { resultRef: "message:accepted", replayed: false };
        return {
          ...message,
          kind: "snapshot",
          type: "collection.snapshot",
          messageId: "snapshot:v2",
          causationId: message.messageId,
          payload: {
            category: "threads",
            itemRefs: ["thread-01"],
            nextCursor: null,
            snapshotRef: "snapshot-ref-01",
            generatedAt: NOW,
          },
        };
      },
      async *subscribe(_authentication, afterCursor) {
        cursors.push(afterCursor);
        const item: GatewayV2Event = {
          schemaVersion: "gateway.v2",
          kind: "event",
          type: "stream.event",
          messageId: "event:v2",
          correlationId: "correlation-01",
          causationId: null,
          dataClassification: "private",
          risk: "low",
          authorizationRef: null,
          scope: { ownerId: "owner-01", agentId: "agent-01" },
          authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
          actor: { actorType: "system", actorId: "system-01" },
          payload: {
            cursor: "cursor-v2-02",
            retentionStartCursor: "cursor-v2-01",
            eventId: "event-v2-02",
            scopeKind: "run",
            scopeId: "run-01",
            sequence: 2,
            occurredAt: NOW,
            eventType: "run.completed",
            payloadRef: null,
          },
        };
        yield item;
      },
    };
    const { app } = createFixture(gatewayV2);
    const v2Base = {
      schemaVersion: "gateway.v2",
      messageId: "message:v2",
      correlationId: "correlation-01",
      causationId: null,
      dataClassification: "private",
      risk: "low",
      authorizationRef: null,
      scope: { ownerId: "owner-01", agentId: "agent-01" },
      authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
      actor: { actorType: "owner", actorId: "owner-01" },
    } as const;
    const query = await app.inject({
      method: "POST",
      url: "/api/gateway/v2/queries",
      headers: requestHeaders(),
      payload: {
        ...v2Base,
        kind: "query",
        type: "thread.list",
        payload: { afterCursor: null, limit: 10 },
      },
    });
    const commandResponse = await app.inject({
      method: "POST",
      url: "/api/gateway/v2/commands",
      headers: requestHeaders("idempotency-v2"),
      payload: {
        ...v2Base,
        kind: "command",
        type: "thread.message.submit",
        idempotencyKey: "idempotency-v2",
        payload: {
          threadId: "thread-01",
          messageId: "client-message-01",
          contentRef: "payload-01",
          clientCreatedAt: NOW,
        },
      },
    });
    const stream = await app.inject({
      method: "GET",
      url: "/api/gateway/v2/events?afterCursor=cursor-v2-01",
      headers: { host: "agent.example.test", "cf-access-jwt-assertion": "assertion-01" },
    });

    expect(query.json()).toMatchObject({ type: "collection.snapshot" });
    expect(commandResponse.json()).toEqual({ resultRef: "message:accepted", replayed: false });
    expect(stream.body).toContain("id: cursor-v2-02");
    expect(requests).toEqual(["thread.list", "thread.message.submit"]);
    expect(cursors).toEqual(["cursor-v2-01"]);
  });

  it("routes strict Thread v3 commands, queries and durable cursor events", async () => {
    const requests: string[] = [];
    const subscriptions: Array<string | null> = [];
    const threadGateway: AgentThreadGatewayPort = {
      async request(_authentication, message) {
        requests.push(message.type);
        const response =
          message.kind === "command"
            ? {
                schemaVersion: message.schemaVersion,
                messageId: "result:thread.create",
                correlationId: message.correlationId,
                causationId: message.messageId,
                scope: message.scope,
                authority: message.authority,
                actor: { actorType: "system", actorId: "thread-gateway" },
                kind: "result",
                type: "thread.command_result",
                payload: {
                  commandType: message.type,
                  commandId: message.messageId,
                  threadId: "thread-01",
                  threadRevision: 1,
                  resultRef: "payload:thread-created",
                  replayed: false,
                  committedAt: NOW,
                },
              }
            : {
                ...message,
                kind: "snapshot",
                type: "thread.collection_snapshot",
                messageId: "snapshot:thread-list",
                causationId: message.messageId,
                payload: {
                  threads: [],
                  nextCursor: null,
                  snapshotRef: "snapshot-ref-01",
                  generatedAt: NOW,
                },
              };
        return threadGatewayMessageSchema.parse(response) as ThreadGatewayRequestResult;
      },
      async *subscribe(_authentication, subscription) {
        subscriptions.push(subscription.payload.afterCursor);
        yield threadGatewayMessageSchema.parse({
          ...subscription,
          kind: "event",
          type: "thread.event",
          messageId: "event:thread-02",
          causationId: "message:thread.create",
          payload: {
            eventId: "event:thread-02",
            threadId: "thread-01",
            revision: 1,
            cursor: "thread-cursor:02",
            causationCommandId: "message:thread.create",
            eventType: "thread.created",
            payloadRef: "payload:thread-created",
            occurredAt: NOW,
          },
        }) as ThreadGatewayEvent;
      },
    };
    const { app } = createFixture(undefined, threadGateway);
    const base = {
      schemaVersion: "gateway.thread.v3",
      messageId: "message:thread-v3",
      correlationId: "correlation-01",
      causationId: null,
      scope: { ownerId: "owner-01", agentId: "agent-01" },
      authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
      actor: { actorType: "owner", actorId: "owner-01" },
    } as const;
    const query = await app.inject({
      method: "POST",
      url: "/api/gateway/thread/v3/queries",
      headers: requestHeaders(),
      payload: {
        ...base,
        kind: "query",
        type: "thread.list",
        payload: { statuses: ["active"], pinnedOnly: false, afterCursor: null, limit: 10 },
      },
    });
    const commandResponse = await app.inject({
      method: "POST",
      url: "/api/gateway/thread/v3/commands",
      headers: requestHeaders("idempotency-thread-v3"),
      payload: {
        ...base,
        kind: "command",
        type: "thread.create",
        idempotencyKey: "idempotency-thread-v3",
        payload: {
          threadId: "thread-01",
          answerLocale: "zh-CN",
          resultRef: "payload:thread-created",
        },
      },
    });
    const encodedSubscription = Buffer.from(
      JSON.stringify({
        ...base,
        kind: "subscription",
        type: "thread.events",
        payload: { afterCursor: "thread-cursor:01" },
      }),
    ).toString("base64url");
    const stream = await app.inject({
      method: "GET",
      url: `/api/gateway/thread/v3/events?subscription=${encodedSubscription}`,
      headers: { host: "agent.example.test", "cf-access-jwt-assertion": "assertion-01" },
    });

    expect(query.json()).toMatchObject({ type: "thread.collection_snapshot" });
    expect(commandResponse.json()).toMatchObject({
      type: "thread.command_result",
      payload: { threadId: "thread-01", threadRevision: 1 },
    });
    expect(stream.body).toContain("id: thread-cursor:02");
    expect(requests).toEqual(["thread.list", "thread.create"]);
    expect(subscriptions).toEqual(["thread-cursor:01"]);
  });

  it("keeps browser plaintext behind authenticated scoped Payload and search boundaries", async () => {
    const calls: string[] = [];
    const { app } = createFixture(undefined, undefined, {
      browserConfiguration: {
        agentId: "agent-01",
        deploymentId: "deployment-01",
        authorityEpoch: 1,
        fencingToken: 1,
      },
      payloadAdmission: {
        async protect(input) {
          calls.push(`protect:${input.idempotencyKey}:${input.content}`);
          return { payloadRef: "payload-private-01" };
        },
      },
      payloadRead: {
        async read(input) {
          calls.push(`read:${input.agentId}:${input.payloadRef}`);
          return {
            content: "私人正文",
            dataClassification: "private",
            contentType: "text/plain",
          };
        },
      },
      threadSearch: {
        async prepare(input) {
          calls.push(`search:${input.agentId}:${input.query}`);
          return {
            queryRef: "payload-search-01",
            tokenRefs: ["search-token-01"],
            projectionVersion: "thread-search-v1",
          };
        },
      },
    });
    const protectedPayload = await app.inject({
      method: "POST",
      url: "/api/payload/v1/text",
      headers: requestHeaders("payload-idempotency-01"),
      payload: { content: "私人正文", dataClassification: "private" },
    });
    const missingIdempotency = await app.inject({
      method: "POST",
      url: "/api/payload/v1/text",
      headers: omitHeader(requestHeaders(), "idempotency-key"),
      payload: { content: "私人正文", dataClassification: "private" },
    });
    const read = await app.inject({
      method: "POST",
      url: "/api/payload/v1/text/read",
      headers: requestHeaders(),
      payload: { payloadRef: "payload-private-01" },
    });
    const search = await app.inject({
      method: "POST",
      url: "/api/thread-search/v1/prepare",
      headers: requestHeaders(),
      payload: { query: "私人搜索" },
    });

    expect(protectedPayload).toMatchObject({ statusCode: 201 });
    expect(missingIdempotency).toMatchObject({ statusCode: 400 });
    expect(missingIdempotency.json()).toEqual({
      error: { code: HTTP_GATEWAY_ERROR_CODES.IDEMPOTENCY_MISMATCH },
    });
    expect(read.json()).toEqual({
      content: "私人正文",
      dataClassification: "private",
      contentType: "text/plain",
    });
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(search.json()).toEqual({
      queryRef: "payload-search-01",
      tokenRefs: ["search-token-01"],
      projectionVersion: "thread-search-v1",
    });
    expect(calls).toEqual([
      "protect:payload-idempotency-01:私人正文",
      "read:agent-01:payload-private-01",
      "search:agent-01:私人搜索",
    ]);
  });
});
