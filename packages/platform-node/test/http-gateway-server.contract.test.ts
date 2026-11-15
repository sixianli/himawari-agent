import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
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
  type PayloadProtectorPort,
  type PayloadRecord,
  type PayloadStorePort,
  PORT_ERROR_CODES,
  type ThreadArtifact,
  type ThreadArtifactStorePort,
} from "@himawari-agent/application";
import {
  type EventSubscription,
  type GatewayCommand,
  type GatewayV2Event,
  type GetRunSnapshotQuery,
  type GetThreadSnapshotQuery,
  type RunSnapshot,
  type StreamEvent,
  type ThreadExecutionChangedEvent,
  type ThreadGatewayEvent,
  type ThreadGatewayRequestResult,
  type ThreadSnapshot,
  type TraceQuery,
  threadGatewayMessageSchema,
} from "@himawari-agent/gateway-contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BrowserThreadFiles } from "../src/browser-thread-files.js";
import {
  buildHttpGatewayServer,
  HTTP_GATEWAY_ERROR_CODES,
  type HttpGatewayAuthenticationPort,
  type HttpGatewayServerOptions,
  type HttpGatewaySlowRequest,
} from "../src/http-gateway-server.js";
import { PREVIEW_STORAGE_SCRIPT } from "../src/preview-page-storage.js";
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
  revoked = false;
  async revalidate(): Promise<void> {
    if (this.revoked) throw new Error("SESSION_REVOKED");
  }
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
  await writeFile(path.join(staticRoot, "assets", "worker.mjs"), "self.onmessage = () => {};");
  await writeFile(
    path.join(staticRoot, "assets", "brand.woff2"),
    Buffer.from([0x77, 0x4f, 0x46, 0x32]),
  );
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
    | "browserConfiguration"
    | "payloadAdmission"
    | "payloadRead"
    | "threadSearch"
    | "heartbeatMilliseconds"
    | "files"
    | "previewOrigin"
    | "onSlowRequest"
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
      async issue(input) {
        if (input !== authentication) throw new Error("CSRF_ISSUE_REJECTED");
        return "csrf-issued-01";
      },
      async verify(input) {
        return input.token === "csrf-01" && input.authentication === authentication;
      },
    },
    publicOrigin: ORIGIN,
    staticRoot,
    maximumBodyBytes: 2048,
    heartbeatMilliseconds: extensions.heartbeatMilliseconds ?? 20,
  });
  return { access, controlPlane, reads, auth, app };
}

describe("HTTP Gateway contract and security boundary", () => {
  it("reports a conversation read that the server took more than two seconds to answer", async () => {
    let clock = 1_000;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const slow: HttpGatewaySlowRequest[] = [];
    const threadGateway: AgentThreadGatewayPort = {
      async request(_authentication, message) {
        if (message.type === "thread.list" && message.payload.limit === 2) clock += 2_500;
        return threadGatewayMessageSchema.parse({
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
        }) as ThreadGatewayRequestResult;
      },
      async *subscribe() {},
    };
    const { app } = createFixture(undefined, threadGateway, {
      onSlowRequest: (request) => slow.push(request),
    });
    const query = (limit: number) =>
      app.inject({
        method: "POST",
        url: "/api/gateway/thread/v3/queries",
        headers: requestHeaders(),
        payload: {
          schemaVersion: "gateway.thread.v3",
          messageId: `message:thread-v3-${limit}`,
          correlationId: "correlation-01",
          causationId: null,
          scope: { ownerId: "owner-01", agentId: "agent-01" },
          authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
          actor: { actorType: "owner", actorId: "owner-01" },
          kind: "query",
          type: "thread.list",
          payload: { statuses: ["active"], pinnedOnly: false, afterCursor: null, limit },
        },
      });
    try {
      expect((await query(1)).statusCode).toBe(200);
      expect(slow).toEqual([]);
      expect((await query(2)).statusCode).toBe(200);
      expect(slow).toEqual([
        {
          method: "POST",
          path: "/api/gateway/thread/v3/queries",
          operation: "thread.list",
          outcome: "answered",
          statusCode: 200,
          totalMs: 2_500,
          concurrentRequests: 1,
        },
      ]);
    } finally {
      now.mockRestore();
      await app.close();
    }
  });
  it("[P5-B] reports a slow request by its route, so a key in the path never reaches the log", async () => {
    let clock = 1_000;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const slow: HttpGatewaySlowRequest[] = [];
    const { app } = createFixture(undefined, undefined, {
      onSlowRequest: (request) => slow.push(request),
    });
    const key = "k".repeat(43);
    app.get("/api/mcp/v1/:secret", async () => {
      clock += 2_500;
      return { ok: true };
    });
    try {
      expect(
        (await app.inject({ url: `/api/mcp/v1/${key}?probe=1`, headers: requestHeaders() }))
          .statusCode,
      ).toBe(200);
      expect(slow).toEqual([
        {
          method: "GET",
          path: "/api/mcp/v1/:secret",
          outcome: "answered",
          statusCode: 200,
          totalMs: 2_500,
          concurrentRequests: 1,
        },
      ]);
      now.mockImplementation(() => {
        clock += 2_500;
        return clock;
      });
      const fallback = await app.inject({
        url: `/api/mcp/v1/${key}/extra`,
        headers: requestHeaders(),
      });
      expect(fallback.statusCode).toBe(404);
      expect(slow.at(-1)).toMatchObject({ method: "GET", path: "/*", statusCode: 404 });
      const unmatched = await app.inject({
        method: "POST",
        url: `/api/mcp/v1/${key}/extra`,
        headers: { ...requestHeaders(), "content-type": "application/json" },
        payload: {},
      });
      expect(unmatched.statusCode).toBe(404);
      expect(slow.at(-1)).toMatchObject({ method: "POST", path: "(no route)", statusCode: 404 });
      expect(JSON.stringify(slow)).not.toContain(key);
    } finally {
      now.mockRestore();
      await app.close();
    }
  });
  it("stops an already open stream before emitting another event after session revocation", async () => {
    const fixture = createFixture({
      request: async () => {
        throw new Error("unused");
      },
      async *subscribe() {
        yield {
          kind: "snapshot_required" as const,
          scope: { ownerId: "owner-01", agentId: "agent-01" },
          reason: "state_changed" as const,
        };
        fixture.auth.revoked = true;
        yield {
          kind: "snapshot_required" as const,
          scope: { ownerId: "owner-01", agentId: "agent-01" },
          reason: "state_changed" as const,
        };
      },
    });
    try {
      const response = await fixture.app.inject({
        url: "/api/gateway/v2/events",
        headers: requestHeaders(),
      });
      expect(response.body.match(/event: gateway.snapshot_required/g)).toHaveLength(1);
      expect(response.body).toContain("IDENTITY_SESSION_INVALID");
    } finally {
      await fixture.app.close();
    }
  });
  it("reports uninstalled operations as 501 and publishes installed operations", async () => {
    const { app } = createFixture(
      {
        async request() {
          throw new ApplicationPortError(
            PORT_ERROR_CODES.OPERATION_NOT_INSTALLED,
            "internal detail",
            { internal: "private detail" },
          );
        },
        async *subscribe() {},
      },
      undefined,
      {
        browserConfiguration: {
          agentId: "agent-01",
          deploymentId: "deployment-01",
          authorityEpoch: 1,
          fencingToken: 1,
          installedGatewayV2Operations: ["approval.list", "approval.detail", "approval.respond"],
        },
      },
    );
    try {
      const configuration = await app.inject({
        method: "GET",
        url: "/api/control-center/v1/config",
        headers: requestHeaders(),
      });
      expect(configuration.statusCode).toBe(200);
      expect(configuration.json().installedGatewayV2Operations).toEqual([
        "approval.list",
        "approval.detail",
        "approval.respond",
      ]);
      const response = await app.inject({
        method: "POST",
        url: "/api/gateway/v2/queries",
        headers: requestHeaders(),
        payload: {
          ...envelope("query", "workspace.list"),
          schemaVersion: "gateway.v2",
          risk: "low",
          authorizationRef: null,
          authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
          payload: { afterCursor: null, limit: 10 },
        },
      });
      expect(response.statusCode).toBe(501);
      expect(response.json()).toEqual({ error: { code: "PORT_OPERATION_NOT_INSTALLED" } });
    } finally {
      await app.close();
    }
  });

  it("passes only listed reason codes through as reasonCode", async () => {
    const reasons = ["LOGIN_DEVICES_STILL_CHANGING", "EMBEDDING_LOCAL_NOT_READY", "disk headroom"];
    const { app } = createFixture({
      async request() {
        throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, reasons.shift() ?? "", {
          internal: "private detail",
        });
      },
      async *subscribe() {},
    });
    let attempt = 0;
    const query = () => {
      attempt += 1;
      const idempotencyKey = `idempotency-reason-${attempt}`;
      return app.inject({
        method: "POST",
        url: "/api/gateway/v2/commands",
        headers: requestHeaders(idempotencyKey),
        payload: {
          ...envelope("command", "login.devices.revoke_others"),
          schemaVersion: "gateway.v2",
          risk: "low",
          authorizationRef: null,
          authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
          idempotencyKey,
          payload: { recentAuthenticationRef: null },
        },
      });
    };
    try {
      const machine = await query();
      expect(machine.statusCode).toBe(409);
      expect(machine.json()).toEqual({
        error: { code: "PORT_CONFLICT", reasonCode: "LOGIN_DEVICES_STILL_CHANGING" },
      });
      for (const unlisted of [await query(), await query()]) {
        expect(unlisted.statusCode).toBe(409);
        expect(unlisted.json()).toEqual({ error: { code: "PORT_CONFLICT" } });
      }
    } finally {
      await app.close();
    }
  });

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
    const worker = await app.inject({
      method: "GET",
      url: "/assets/worker.mjs",
      headers: { host: "agent.example.test" },
    });
    expect(worker.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    const font = await app.inject({
      method: "GET",
      url: "/assets/brand.woff2",
      headers: { host: "agent.example.test" },
    });
    expect(font.statusCode).toBe(200);
    expect(font.headers["content-type"]).toBe("font/woff2");
    expect(font.rawPayload).toEqual(Buffer.from([0x77, 0x4f, 0x46, 0x32]));
    expect(page.headers["content-security-policy"]).toContain("font-src 'self'");
  });

  it("[WP-6] serves the home screen app files with their types and lets the page install a worker", async () => {
    const shell = new URL("../../../apps/control-center/public/", import.meta.url);
    await mkdir(path.join(staticRoot, "icons"), { recursive: true });
    for (const file of [
      "sw.js",
      "manifest.webmanifest",
      "apple-touch-icon.png",
      "icons/icon-192.png",
    ])
      await writeFile(path.join(staticRoot, file), await readFile(new URL(file, shell)));
    const { app } = fixture();
    const get = (url: string) =>
      app.inject({ method: "GET", url, headers: { accept: "*/*", host: "agent.example.test" } });
    const worker = await get("/sw.js");
    const manifest = await get("/manifest.webmanifest");
    const touchIcon = await get("/apple-touch-icon.png");
    const icon = await get("/icons/icon-192.png");
    const missing = await get("/icons/missing.png");
    const traversal = await get("/icons/..%2Findex.html");

    expect(worker.statusCode).toBe(200);
    expect(worker.headers["content-type"]).toContain("text/javascript");
    expect(worker.headers["cache-control"]).toBe("no-cache");
    expect(worker.body).toContain('addEventListener("push"');
    expect(worker.body).not.toContain('addEventListener("fetch"');
    expect(manifest.headers["content-type"]).toContain("application/manifest+json");
    expect(JSON.parse(manifest.body)).toMatchObject({ display: "standalone", start_url: "/" });
    expect(manifest.headers["cache-control"]).toBe("no-cache");
    expect(touchIcon.headers["content-type"]).toBe("image/png");
    expect(icon.statusCode).toBe(200);
    expect(icon.headers["cache-control"]).toBe("public, max-age=86400");
    expect(missing.statusCode).toBe(404);
    expect(traversal.statusCode).toBe(404);
    expect(worker.headers["content-security-policy"]).toContain("manifest-src 'self'");
    expect(worker.headers["content-security-policy"]).toContain("worker-src 'self'");
  });

  it("does not expose legacy v1 routes when no legacy gateway is composed", async () => {
    const auth = new Authentication();
    const app = buildHttpGatewayServer({
      authentication: auth,
      csrf: {
        async verify() {
          return true;
        },
      },
      publicOrigin: ORIGIN,
      staticRoot,
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/gateway/v1/commands",
        headers: requestHeaders(),
        payload: command(),
      });
      expect(response.statusCode).toBe(404);
      expect(auth.observed).toHaveLength(0);
    } finally {
      await app.close();
    }
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

  it("emits heartbeat events while waiting and rejects malformed event ordering", async () => {
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
    expect(heartbeat.body).toContain("event: gateway.heartbeat");
    expect(heartbeat.body).toContain('"intervalMilliseconds":20');
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

  it.each(["v2", "thread"] as const)(
    "opens an idle %s stream before its first heartbeat",
    async (kind) => {
      const idle = async function* () {
        await new Promise((resolve) => setTimeout(resolve, 700));
      };
      const request = async () => {
        throw new Error("unused");
      };
      const { app } = createFixture(
        kind === "v2" ? { request, subscribe: idle } : undefined,
        kind === "thread" ? { request, subscribe: idle } : undefined,
        { heartbeatMilliseconds: 2_000 },
      );
      const subscription = Buffer.from(
        JSON.stringify({
          schemaVersion: "gateway.thread.v3",
          messageId: "subscription-01",
          correlationId: "correlation-01",
          causationId: null,
          scope: { ownerId: "owner-01", agentId: "agent-01" },
          authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
          actor: { actorType: "owner", actorId: "owner-01" },
          kind: "subscription",
          type: "thread.events",
          payload: { afterCursor: null },
        }),
      ).toString("base64url");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 500);
      try {
        const origin = await app.listen({ host: "127.0.0.1", port: 0 });
        const endpoint =
          kind === "v2"
            ? "/api/gateway/v2/events"
            : `/api/gateway/thread/v3/events?subscription=${subscription}`;
        const response = await new Promise<IncomingMessage>((resolve, reject) => {
          const req = httpRequest(
            `${origin}${endpoint}`,
            { headers: requestHeaders(), signal: controller.signal },
            resolve,
          );
          req.on("error", reject);
          req.end();
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toContain("text/event-stream");
        const first = await response[Symbol.asyncIterator]().next();
        expect(String(first.value)).toContain(": connected\n\n");
        response.destroy();
      } finally {
        clearTimeout(timeout);
        controller.abort();
        await app.close();
      }
    },
  );

  it("keeps an idle v2 subscription open and aborts it when the HTTP client closes", async () => {
    let subscriptionSignal: AbortSignal | undefined;
    let released = false;
    const { app } = createFixture({
      request: async () => {
        throw new Error("unused");
      },
      async *subscribe(_authentication, _afterCursor, signal) {
        subscriptionSignal = signal;
        try {
          yield {
            kind: "snapshot_required",
            scope: { ownerId: "owner-01", agentId: "agent-01" },
            reason: "state_changed",
          };
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else signal?.addEventListener("abort", () => resolve(), { once: true });
          });
        } finally {
          released = true;
        }
      },
    });
    const controller = new AbortController();
    try {
      const origin = await app.listen({ host: "127.0.0.1", port: 0 });
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        const request = httpRequest(
          `${origin}/api/gateway/v2/events`,
          { headers: requestHeaders(), signal: controller.signal },
          resolve,
        );
        request.on("error", reject);
        request.end();
      });
      expect(response.statusCode).toBe(200);
      const reader = response[Symbol.asyncIterator]();
      const first = await reader.next();
      expect(first.done).toBe(false);
      expect(String(first.value)).toContain("event: gateway.snapshot_required");
      const heartbeat = await reader.next();
      expect(heartbeat.done).toBe(false);
      expect(String(heartbeat.value)).toContain("event: gateway.heartbeat");
      expect(released).toBe(false);
      response.destroy();
      await expect.poll(() => subscriptionSignal?.aborted).toBe(true);
      await expect.poll(() => released).toBe(true);
    } finally {
      controller.abort();
      await app.close();
    }
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

  it("streams Thread execution changes as named hints and ends an unreadable Thread", async () => {
    const watched: string[] = [];
    const base = {
      schemaVersion: "gateway.thread.v3",
      messageId: "message:thread-execution",
      correlationId: "correlation-01",
      causationId: null,
      scope: { ownerId: "owner-01", agentId: "agent-01" },
      authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
      actor: { actorType: "owner", actorId: "owner-01" },
    } as const;
    const threadGateway: AgentThreadGatewayPort = {
      request: async () => {
        throw new Error("unused");
      },
      async *subscribe() {},
      async *watchExecution(_authentication, subscription) {
        watched.push(subscription.payload.threadId);
        if (subscription.payload.threadId === "thread-missing")
          throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "THREAD_EXECUTION_NOT_FOUND");
        yield threadGatewayMessageSchema.parse({
          ...subscription,
          kind: "event",
          type: "thread.execution_changed",
          messageId: "execution:1:message",
          actor: { actorType: "system", actorId: "thread-gateway" },
          payload: {
            threadId: subscription.payload.threadId,
            runId: "run-01",
            runRevision: 2,
            traceSequence: 5,
            resourceRevision: null,
            observedAt: NOW,
          },
        }) as ThreadExecutionChangedEvent;
      },
    };
    const encoded = (threadId: string, type = "thread.execution_events") =>
      Buffer.from(
        JSON.stringify({ ...base, kind: "subscription", type, payload: { threadId } }),
      ).toString("base64url");
    const configured = createFixture(undefined, threadGateway, {
      browserConfiguration: {
        agentId: "agent-01",
        deploymentId: "deployment-01",
        authorityEpoch: 1,
        fencingToken: 1,
        executionEventsAvailable: true,
      },
    }).app;
    const headers = { host: "agent.example.test", "cf-access-jwt-assertion": "assertion-01" };
    const stream = await configured.inject({
      method: "GET",
      url: `/api/gateway/thread/v3/execution-events?subscription=${encoded("thread-01")}`,
      headers,
    });
    expect(stream.statusCode).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.body).toContain(": connected\n\n");
    expect(stream.body).toContain("event: thread.execution_changed\n");
    expect(stream.body).not.toContain("id: ");
    expect(stream.body).toContain('"traceSequence":5');
    const missing = await configured.inject({
      method: "GET",
      url: `/api/gateway/thread/v3/execution-events?subscription=${encoded("thread-missing")}`,
      headers,
    });
    expect(missing.body).toContain("event: thread.execution_unavailable\n");
    const wrongType = await configured.inject({
      method: "GET",
      url: `/api/gateway/thread/v3/execution-events?subscription=${Buffer.from(
        JSON.stringify({
          ...base,
          kind: "subscription",
          type: "thread.events",
          payload: { afterCursor: null },
        }),
      ).toString("base64url")}`,
      headers,
    });
    expect(wrongType.statusCode).toBe(400);
    expect(watched).toEqual(["thread-01", "thread-missing"]);
    const configuration = await configured.inject({
      method: "GET",
      url: "/api/control-center/v1/config",
      headers,
    });
    expect(configuration.json()).toMatchObject({ executionEventsAvailable: true });
    const unconfigured = createFixture(undefined, threadGateway).app;
    const absent = await unconfigured.inject({
      method: "GET",
      url: `/api/gateway/thread/v3/execution-events?subscription=${encoded("thread-01")}`,
      headers,
    });
    expect(absent.statusCode).not.toBe(200);
    await configured.close();
    await unconfigured.close();
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

  it("[UI-16] admits a large attachment text as its own Payload type and keeps the message limit", async () => {
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
          calls.push(`${input.contentType}:${input.content.length}`);
          return { payloadRef: "payload-attachment-01" };
        },
      },
    });
    const send = (url: string, content: string, key: string) =>
      app.inject({
        method: "POST",
        url,
        headers: requestHeaders(key),
        payload: { content, dataClassification: "private" },
      });
    const attachment = await send(
      "/api/payload/v1/attachment",
      "页".repeat(200 * 1024),
      "attachment-01",
    );
    const tooLarge = await send(
      "/api/payload/v1/attachment",
      "x".repeat(256 * 1024 + 1),
      "attachment-02",
    );
    const message = await send("/api/payload/v1/text", "x".repeat(64 * 1024 + 1), "text-01");
    expect(attachment.statusCode).toBe(201);
    expect(attachment.json()).toEqual({ payloadRef: "payload-attachment-01" });
    expect(tooLarge.statusCode).toBe(400);
    expect([400, 413]).toContain(message.statusCode);
    expect(calls).toEqual([`text/x-himawari-attachment:${200 * 1024}`]);
  });

  it("[UI-17] admits a browser-prepared image only as a base64 image data URL", async () => {
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
          calls.push(`${input.contentType}:${input.content.length}`);
          return { payloadRef: "payload-image-01" };
        },
      },
    });
    const send = (content: string, key: string) =>
      app.inject({
        method: "POST",
        url: "/api/payload/v1/image",
        headers: requestHeaders(key),
        payload: { content, dataClassification: "private" },
      });
    const photo = `data:image/jpeg;base64,${"A".repeat(1_200_000)}==`;
    const accepted = await send(photo, "image-01");
    const svg = await send("data:image/svg+xml;base64,PHN2Zz4=", "image-02");
    const text = await send("一张图片", "image-03");
    const huge = await send(`data:image/png;base64,${"A".repeat(1_500_000)}`, "image-04");
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toEqual({ payloadRef: "payload-image-01" });
    expect([svg.statusCode, text.statusCode]).toEqual([400, 400]);
    expect([400, 413]).toContain(huge.statusCode);
    expect(calls).toEqual([`text/x-himawari-image:${photo.length}`]);
  });

  it("[FD-2] [FD-3] serves delivered files only to the signed-in owner and previews HTML on its own origin", async () => {
    const PREVIEW = "https://files.example.test";
    let clock = NOW;
    const artifacts: ThreadArtifact[] = [
      ["file-html-1", "game/index.html", "web", "text/html", 1],
      ["file-html-2", "game/index.html", "web", "text/html", 2],
      ["file-png", "out/图表.png", "image", "image/png", 1],
      ["thread-artifact:4dbdf5fa-e238-4e2a-9958-564a64351b80", "snake.html", "web", "text/html", 1],
    ].map(([id, path, kind, mediaType, version]) => ({
      id: id as string,
      threadId: "thread-01",
      runId: "run-01",
      toolCallId: `call-${id}`,
      source: "bash",
      path: path as string,
      kind: kind as ThreadArtifact["kind"],
      mediaType: mediaType as string,
      sizeBytes: 5,
      sha256: null,
      version: version as number,
      turn: 2,
      copyRef: `copy-${id}`,
      overlapped: false,
      createdAt: NOW,
      deletedAt: null,
    }));
    const store: ThreadArtifactStorePort = {
      register: async () => {
        throw new Error("unused");
      },
      latest: async () => null,
      get: async ({ id }) => artifacts.find((artifact) => artifact.id === id) ?? null,
      versions: async ({ path }) => artifacts.filter((artifact) => artifact.path === path),
      list: async () => ({ items: artifacts, nextCursor: null }),
      markDeleted: async () => {
        throw new Error("unused");
      },
    };
    const payloads = {
      get: async (ref: string) => ({ ref }) as unknown as PayloadRecord,
    } as unknown as PayloadStorePort;
    const protector = {
      unprotect: async ({ payload }: { payload: { ref: string } }) =>
        new TextEncoder().encode(`bytes:${payload.ref}`),
    } as unknown as PayloadProtectorPort;
    const files = new BrowserThreadFiles({
      ownerId: "owner-01",
      agentId: "agent-01",
      store,
      payloads: () => payloads,
      protector,
      previewOrigin: PREVIEW,
      ticketKey: new Uint8Array(32).fill(7),
      now: () => clock,
      commandKey: (runId, toolCallId) => `background-command:${runId}:${toolCallId}`,
    });
    const { app } = createFixture(undefined, undefined, {
      browserConfiguration: {
        agentId: "agent-01",
        deploymentId: "deployment-01",
        authorityEpoch: 1,
        fencingToken: 1,
      },
      files,
      previewOrigin: PREVIEW,
    });
    const contentHeaders = {
      host: "agent.example.test",
      "sec-fetch-site": "same-origin",
      "cf-access-jwt-assertion": "assertion-01",
      cookie: "himawari_session=session-token-01",
    };

    const list = await app.inject({
      method: "POST",
      url: "/api/files/v1/list",
      headers: requestHeaders(),
      payload: { kind: "web", limit: 20 },
    });
    expect(list.statusCode).toBe(200);
    expect(
      list.json().items.map(({ id, name, stored }: Record<string, unknown>) => [id, name, stored]),
    ).toEqual([
      ["file-html-1", "index.html", true],
      ["file-html-2", "index.html", true],
      ["file-png", "图表.png", true],
      ["thread-artifact:4dbdf5fa-e238-4e2a-9958-564a64351b80", "snake.html", true],
    ]);
    expect(list.json().items[0]).not.toHaveProperty("copyRef");
    expect(list.json().items[0]).toMatchObject({
      turn: 2,
      commandKey: "background-command:run-01:call-file-html-1",
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/files/v1/list",
          headers: omitHeader(requestHeaders(), "x-csrf-token"),
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/files/v1/list",
          headers: requestHeaders(),
          payload: { path: "/etc/passwd" },
        })
      ).statusCode,
    ).toBe(400);
    const versions = await app.inject({
      method: "POST",
      url: "/api/files/v1/versions",
      headers: requestHeaders(),
      payload: { fileId: "file-html-2" },
    });
    expect(versions.json().items.map(({ version }: { version: number }) => version)).toEqual([
      1, 2,
    ]);

    const signedOut = await app.inject({
      method: "GET",
      url: "/api/files/v1/content/file-png",
      headers: { host: "agent.example.test" },
    });
    expect(signedOut.statusCode).toBe(401);
    const image = await app.inject({
      method: "GET",
      url: "/api/files/v1/content/file-png",
      headers: contentHeaders,
    });
    expect(image.statusCode).toBe(200);
    expect(image.body).toBe("bytes:copy-file-png");
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.headers["content-disposition"]).toBe(
      `inline; filename="__.png"; filename*=UTF-8''${encodeURIComponent("图表.png")}`,
    );
    expect(image.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(image.headers["cache-control"]).toBe("private, no-store");
    const htmlOnMainSite = await app.inject({
      method: "GET",
      url: "/api/files/v1/content/file-html-2",
      headers: contentHeaders,
    });
    expect(htmlOnMainSite.headers["content-disposition"]).toMatch(/^attachment;/);
    const download = await app.inject({
      method: "GET",
      url: "/api/files/v1/content/file-png?download=1",
      headers: contentHeaders,
    });
    expect(download.headers["content-disposition"]).toMatch(/^attachment;/);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/files/v1/content/file-png",
          headers: { ...contentHeaders, "sec-fetch-site": "cross-site" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/files/v1/content/missing",
          headers: contentHeaders,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/files/v1/content/..%2F..%2Fetc%2Fpasswd",
          headers: contentHeaders,
        })
      ).statusCode,
    ).toBe(400);

    const imageTicket = await app.inject({
      method: "POST",
      url: "/api/files/v1/preview-ticket",
      headers: requestHeaders(),
      payload: { fileId: "file-png" },
    });
    expect(imageTicket.statusCode).toBe(404);
    const ticketResponse = await app.inject({
      method: "POST",
      url: "/api/files/v1/preview-ticket",
      headers: requestHeaders(),
      payload: { fileId: "file-html-2" },
    });
    const ticket = ticketResponse.json() as { url: string; expiresAt: string };
    expect(ticket.url.startsWith(`${PREVIEW}/preview/`)).toBe(true);
    expect(ticket.expiresAt).toBe("2026-08-27T00:05:00.000Z");
    const previewPath = new URL(ticket.url).pathname;
    const preview = await app.inject({
      method: "GET",
      url: previewPath,
      headers: { host: "files.example.test" },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toBe(`${PREVIEW_STORAGE_SCRIPT}bytes:copy-file-html-2`);
    expect(preview.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(preview.headers["content-security-policy"]).toMatch(
      /^sandbox allow-scripts allow-modals allow-popups allow-downloads; /,
    );
    expect(preview.headers["content-security-policy"]).toContain(`frame-ancestors ${ORIGIN}`);
    expect(preview.headers["content-security-policy"]).toContain("connect-src 'none'");
    expect(preview.headers["set-cookie"]).toBeUndefined();
    const storedId = "thread-artifact:4dbdf5fa-e238-4e2a-9958-564a64351b80";
    const storedDownload = await app.inject({
      method: "GET",
      url: `/api/files/v1/content/${encodeURIComponent(storedId)}?download=1`,
      headers: contentHeaders,
    });
    expect(storedDownload.statusCode).toBe(200);
    expect(storedDownload.body).toBe(`bytes:copy-${storedId}`);
    expect(storedDownload.headers["content-disposition"]).toBe(
      `attachment; filename="snake.html"; filename*=UTF-8''snake.html`,
    );
    expect(storedDownload.headers["x-frame-options"]).toBe("SAMEORIGIN");
    const storedTicket = (
      await app.inject({
        method: "POST",
        url: "/api/files/v1/preview-ticket",
        headers: requestHeaders(),
        payload: { fileId: storedId },
      })
    ).json() as { url: string };
    const storedPreviewPath = new URL(storedTicket.url).pathname;
    expect(storedPreviewPath.length).toBeGreaterThan(160);
    const storedPreview = await app.inject({
      method: "GET",
      url: storedPreviewPath,
      headers: { host: "files.example.test" },
    });
    expect(storedPreview.statusCode).toBe(200);
    expect(storedPreview.body).toBe(`${PREVIEW_STORAGE_SCRIPT}bytes:copy-${storedId}`);
    expect(
      (
        await app.inject({
          method: "GET",
          url: previewPath,
          headers: { host: "agent.example.test" },
        })
      ).statusCode,
    ).toBe(404);
    const [body, signature] = previewPath.slice("/preview/".length).split(".");
    const forged = Buffer.from(JSON.stringify(["file-png", "2099-01-01T00:00:00.000Z"])).toString(
      "base64url",
    );
    for (const [url, status] of [
      [`/preview/${forged}.${signature}`, 404],
      [`/preview/${body}.${"A".repeat(signature?.length ?? 43)}`, 404],
      ["/api/files/v1/content/file-png", 403],
      ["/", 403],
      ["/assets/app.js", 403],
    ] as const) {
      expect(
        (
          await app.inject({
            method: "GET",
            url,
            headers: { ...contentHeaders, host: "files.example.test" },
          })
        ).statusCode,
      ).toBe(status);
    }
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/files/v1/list",
          headers: { ...requestHeaders(), host: "files.example.test" },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    clock = "2026-08-27T00:05:00.000Z";
    expect(
      (
        await app.inject({
          method: "GET",
          url: previewPath,
          headers: { host: "files.example.test" },
        })
      ).statusCode,
    ).toBe(404);
    const mainPage = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "agent.example.test" },
    });
    expect(mainPage.headers["content-security-policy"]).toContain(`frame-src 'self' ${PREVIEW};`);
    const configuration = await app.inject({
      method: "GET",
      url: "/api/control-center/v1/config",
      headers: requestHeaders(),
    });
    expect(configuration.json()).toMatchObject({
      filesAvailable: true,
      filePreviewAvailable: true,
    });
  });

  it("[FD-3] answers a host other than the public one only with previews and health checks, whatever the method", async () => {
    for (const previewOrigin of ["https://files.example.test", undefined]) {
      const { app } = createFixture(undefined, undefined, previewOrigin ? { previewOrigin } : {});
      const reached: string[] = [];
      app.post("/bootstrap", async (request) => {
        reached.push(request.url);
        return { ok: true };
      });
      app.post("/api/identity/v1/sessions", async (request) => {
        reached.push(request.url);
        return { ok: true };
      });
      for (const request of [
        { method: "POST", url: "/bootstrap" },
        { method: "POST", url: "/api/identity/v1/sessions" },
        { method: "POST", url: "/api/gateway/v1/commands" },
        { method: "PUT", url: "/preview/abc.def" },
        { method: "POST", url: "/preview/abc.def" },
        { method: "DELETE", url: "/api/files/v1/content/file-png" },
        { method: "OPTIONS", url: "/bootstrap" },
        {
          method: "GET",
          url: "/api/gateway/v1/events",
          headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13" },
        },
      ] as const) {
        const response = await app.inject({
          method: request.method,
          url: request.url,
          headers: {
            ...requestHeaders(),
            ...("headers" in request ? request.headers : {}),
            host: "files.example.test",
            origin: "https://files.example.test",
          },
          ...(request.method === "GET" || request.method === "OPTIONS" ? {} : { payload: {} }),
        });
        expect(response.statusCode, `${previewOrigin} ${request.method} ${request.url}`).toBe(403);
        expect(response.json()).toEqual({ error: { code: "HTTP_GATEWAY_ORIGIN_REJECTED" } });
      }
      expect(reached).toEqual([]);
      const health = await app.inject({
        method: "GET",
        url: "/health/live",
        headers: { host: "files.example.test" },
      });
      expect(health.statusCode).toBe(200);
      const bootstrap = await app.inject({
        method: "POST",
        url: "/bootstrap",
        headers: requestHeaders(),
        payload: {},
      });
      expect(bootstrap.statusCode).toBe(200);
      expect(reached).toEqual(["/bootstrap"]);
    }
  });

  it("does not advertise a session reference as recent authentication proof", async () => {
    const { app } = createFixture(undefined, undefined, {
      browserConfiguration: {
        agentId: "agent-01",
        deploymentId: "deployment-01",
        authorityEpoch: 1,
        fencingToken: 1,
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/control-center/v1/config",
      headers: {
        host: "agent.example.test",
        "cf-access-jwt-assertion": "assertion-01",
        cookie: "himawari_session=session-token-01",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ownerId: "owner-01",
      agentId: "agent-01",
      csrfToken: "csrf-issued-01",
      authorizationRef: authentication.authenticationRef,
      recentAuthenticationRef: null,
    });
    expect(response.body).not.toContain("session-token-01");
    expect(response.body).not.toContain("assertion-01");
  });
});
