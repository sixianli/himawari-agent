import type { GatewayV2Event, ThreadGatewayEvent } from "@himawari-agent/gateway-contracts";
import { describe, expect, it, vi } from "vitest";
import { ControlCenterBrowserStorage } from "../src/browser-storage.js";
import {
  createBrowserSession,
  GatewayClient,
  loadRuntimeConfiguration,
  refreshRuntimeConfiguration,
  safeBrowserLog,
} from "../src/gateway-client.js";
import {
  commandMessage,
  queryMessage,
  threadCommandMessage,
  threadQueryMessage,
} from "../src/messages.js";
import { type EventSourceLike, SseStateSynchronizer } from "../src/sse-synchronizer.js";
import { ThreadSseSynchronizer } from "../src/thread-sse-synchronizer.js";

const configuration = {
  ownerId: "owner-01",
  agentId: "agent-01",
  deploymentId: "deployment-01",
  authorityEpoch: 1,
  fencingToken: 1,
  actorId: "owner-01",
  csrfToken: "csrf-01",
} as const;

it.each(["gateway", "thread"] as const)(
  "clears authenticated UI state and stops reconnecting on %s session revocation",
  (kind) => {
    const handlers = new Map<string, (event: MessageEvent<string>) => void>();
    const source: EventSourceLike = {
      onmessage: null,
      onerror: null,
      close: vi.fn(),
      addEventListener: (name, handler) => {
        handlers.set(name, handler);
      },
    };
    const onUnauthorized = vi.fn();
    const schedule = vi.fn(() => 1);
    const options = {
      storage: new ControlCenterBrowserStorage(new MemoryStorage()),
      createEventSource: () => source,
      onUnauthorized,
      schedule,
      onConnectionState: vi.fn(),
      log: vi.fn(),
    };
    const synchronizer =
      kind === "gateway"
        ? new SseStateSynchronizer({ ...options, onEvent: vi.fn() })
        : new ThreadSseSynchronizer({
            ...options,
            configuration,
            onCommittedEvent: vi.fn(),
            onSnapshotRequired: vi.fn(),
          });
    synchronizer.start();
    handlers.get("gateway.stream_error")?.({
      data: JSON.stringify({ code: "IDENTITY_SESSION_INVALID" }),
    } as MessageEvent<string>);
    source.onerror?.(new Event("error"));
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  },
);

describe.each(["gateway", "thread"] as const)("%s connection lifecycle", (kind) => {
  function setup() {
    const sources: EventSourceLike[] = [];
    const retries: Array<() => void> = [];
    const onConnectionState = vi.fn();
    const options = {
      storage: new ControlCenterBrowserStorage(new MemoryStorage()),
      createEventSource: () => {
        const source: EventSourceLike = { onmessage: null, onerror: null, close: vi.fn() };
        sources.push(source);
        return source;
      },
      onConnectionState,
      log: vi.fn(),
      schedule: (retry: () => void) => retries.push(retry),
      cancelSchedule: vi.fn(),
    };
    const synchronizer =
      kind === "gateway"
        ? new SseStateSynchronizer({ ...options, onEvent: vi.fn() })
        : new ThreadSseSynchronizer({
            ...options,
            configuration,
            onCommittedEvent: vi.fn(),
            onSnapshotRequired: vi.fn(),
          });
    return { synchronizer, sources, retries, onConnectionState };
  }

  it("closes the stream immediately while offline and reconnects only after recovery", () => {
    const { synchronizer, sources, onConnectionState } = setup();
    try {
      synchronizer.start();
      sources[0]?.onopen?.(new Event("open"));
      synchronizer.setNetworkOnline(false);
      expect(sources[0]?.close).toHaveBeenCalledOnce();
      expect(onConnectionState).toHaveBeenLastCalledWith("offline");
      synchronizer.reconnectNow();
      expect(sources).toHaveLength(1);
      synchronizer.setNetworkOnline(true);
      expect(sources).toHaveLength(2);
      sources[1]?.onopen?.(new Event("open"));
      expect(onConnectionState).toHaveBeenLastCalledWith("connected");
    } finally {
      synchronizer.stop();
    }
  });

  it("preserves an opening or healthy connection when the page resumes", () => {
    const { synchronizer, sources, onConnectionState } = setup();
    try {
      synchronizer.start();
      synchronizer.reconnectNow();
      expect(sources).toHaveLength(1);
      sources[0]?.onopen?.(new Event("open"));
      synchronizer.reconnectNow();
      expect(sources).toHaveLength(1);
      expect(sources[0]?.close).not.toHaveBeenCalled();
      expect(onConnectionState).toHaveBeenLastCalledWith("connected");
    } finally {
      synchronizer.stop();
    }
  });

  it("retries a stalled handshake and ignores callbacks from the expired source", () => {
    vi.useFakeTimers();
    const { synchronizer, sources, retries, onConnectionState } = setup();
    try {
      synchronizer.start();
      vi.advanceTimersByTime(10_000);
      expect(sources[0]?.close).toHaveBeenCalledOnce();
      expect(onConnectionState).toHaveBeenLastCalledWith("offline");
      expect(retries).toHaveLength(1);
      sources[0]?.onopen?.(new Event("open"));
      sources[0]?.onerror?.(new Event("error"));
      expect(onConnectionState).toHaveBeenLastCalledWith("offline");
      expect(retries).toHaveLength(1);
      retries[0]?.();
      expect(sources).toHaveLength(2);
      sources[1]?.onopen?.(new Event("open"));
      vi.advanceTimersByTime(20_000);
      expect(sources[1]?.close).not.toHaveBeenCalled();
      expect(onConnectionState).toHaveBeenLastCalledWith("connected");
      synchronizer.stop();
      sources[1]?.onopen?.(new Event("open"));
      sources[1]?.onerror?.(new Event("error"));
      expect(retries).toHaveLength(1);
    } finally {
      synchronizer.stop();
      vi.useRealTimers();
    }
  });
});

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function collectionSnapshot() {
  return {
    schemaVersion: "gateway.v2",
    kind: "snapshot",
    type: "collection.snapshot",
    messageId: "snapshot-01",
    correlationId: "correlation-01",
    causationId: "message-01",
    dataClassification: "private",
    risk: "low",
    authorizationRef: null,
    scope: { ownerId: "owner-01", agentId: "agent-01" },
    authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "system", actorId: "system-01" },
    payload: {
      category: "threads",
      itemRefs: ["thread-01"],
      nextCursor: null,
      snapshotRef: "snapshot-ref-01",
      generatedAt: "2026-08-27T00:00:00.000Z",
    },
  };
}

function streamEvent(): GatewayV2Event {
  return {
    schemaVersion: "gateway.v2",
    kind: "event",
    type: "stream.event",
    messageId: "event-01",
    correlationId: "correlation-01",
    causationId: "message-01",
    dataClassification: "private",
    risk: "low",
    authorizationRef: null,
    scope: { ownerId: "owner-01", agentId: "agent-01" },
    authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "system", actorId: "system-01" },
    payload: {
      cursor: "cursor-02",
      retentionStartCursor: "cursor-01",
      eventId: "event-01",
      scopeKind: "run",
      scopeId: "run-01",
      sequence: 2,
      occurredAt: "2026-08-27T00:00:00.000Z",
      eventType: "run.completed",
      payloadRef: null,
    },
  };
}

function threadEvent(): ThreadGatewayEvent {
  return {
    schemaVersion: "gateway.thread.v3",
    kind: "event",
    type: "thread.event",
    messageId: "thread-event-01",
    correlationId: "correlation-01",
    causationId: "thread-command-01",
    scope: { ownerId: "owner-01", agentId: "agent-01" },
    authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "system", actorId: "thread-gateway" },
    payload: {
      eventId: "thread-event-01",
      threadId: "thread-01",
      revision: 2,
      cursor: "thread-cursor:02",
      causationCommandId: "thread-command-01",
      eventType: "thread.message.submit",
      payloadRef: "payload-result-01",
      occurredAt: "2026-08-27T00:00:00.000Z",
    },
  };
}

describe("typed browser Gateway client", () => {
  it("reads and validates the existing authenticated health endpoint", async () => {
    const value = {
      id: "health-01",
      live: true,
      ready: true,
      status: "healthy",
      dependencies: [{ name: "sqlite", required: true, status: "healthy", reasonCode: null }],
    };
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify(value)));
    const client = new GatewayClient({ fetch: fetchImplementation, csrfToken: () => "unused" });
    expect(await client.healthDependencies()).toEqual(value);
    expect(fetchImplementation).toHaveBeenCalledWith(
      "/api/health/v1/dependencies",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    fetchImplementation.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ...value, dependencies: [{ name: "sqlite", status: "invented" }] }),
      ),
    );
    await expect(client.healthDependencies()).rejects.toThrow("CONTROL_CENTER_RESPONSE_INVALID");
    fetchImplementation.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "HTTP_GATEWAY_AUTHENTICATION_REQUIRED" } }), {
        status: 401,
      }),
    );
    await expect(client.healthDependencies()).rejects.toMatchObject({ status: 401 });
  });
  it("loads explicit deployment operations and rejects malformed availability", async () => {
    const load = (operations: unknown) =>
      loadRuntimeConfiguration(
        async () =>
          new Response(
            JSON.stringify({ ...configuration, installedGatewayV2Operations: operations }),
          ),
      );
    expect(
      (await load(["approval.list", "approval.detail", "approval.respond"]))
        .installedGatewayV2Operations,
    ).toEqual(["approval.list", "approval.detail", "approval.respond"]);
    expect((await load(undefined)).installedGatewayV2Operations).toEqual([]);
    await expect(load("all")).rejects.toThrow("CONTROL_CENTER_CONFIGURATION_INVALID");
    await expect(load([false])).rejects.toThrow("CONTROL_CENTER_CONFIGURATION_INVALID");
  });

  it("loads scoped governance authentication references without exposing credentials", async () => {
    const loaded = await loadRuntimeConfiguration(
      (async () =>
        new Response(
          JSON.stringify({
            ...configuration,
            sessionId: "session:verified-browser",
            authorizationRef: "authentication:owner-session-01",
            recentAuthenticationRef: "authentication:owner-session-01",
          }),
          { status: 200 },
        )) as typeof fetch,
    );

    expect(loaded).toMatchObject({
      sessionId: "session:verified-browser",
      authorizationRef: "authentication:owner-session-01",
      recentAuthenticationRef: "authentication:owner-session-01",
    });
    expect(JSON.stringify(loaded)).not.toContain("password");
    expect(JSON.stringify(loaded)).not.toContain("accessToken");
  });

  it("rejects malformed product session identity from browser configuration", async () => {
    await expect(
      loadRuntimeConfiguration(
        (async () =>
          new Response(
            JSON.stringify({
              ...configuration,
              sessionId: { token: "not-a-session-id" },
            }),
          )) as typeof fetch,
      ),
    ).rejects.toThrow("CONTROL_CENTER_CONFIGURATION_INVALID");
  });

  it("strictly serializes commands, keeps one idempotency key and reports replay", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const client = new GatewayClient({
      csrfToken: () => "csrf-01",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ resultRef: "run:run-01", replayed: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    const message = commandMessage(configuration, "thread.message.submit", {
      threadId: "thread-01",
      messageId: "client-message-01",
      contentRef: "payload-01",
      clientCreatedAt: "2026-08-27T00:00:00.000Z",
    });
    const result = await client.mutate(message);

    expect(result.status).toBe("replayed");
    expect(new Headers(calls[0]?.init.headers).get("idempotency-key")).toBe(message.idempotencyKey);
    expect(new Headers(calls[0]?.init.headers).get("x-csrf-token")).toBe("csrf-01");
  });

  it("builds an explicit GitHub monitor lifecycle command without raw content", () => {
    const message = commandMessage(
      { ...configuration, primaryModelRef: "model:fixture-primary:v1" },
      "github.monitor.set_state",
      {
        monitorId: "monitor-01",
        action: "enable",
        expectedRevision: 1,
        historyPolicy: null,
        disclosure: {
          confirmationRef: "confirmation:github-01",
          primaryModelRef: "model:fixture-primary:v1",
          repositoryRef: "owner/repository",
          disclosedDataClassifications: ["private"],
          machineSecretsExcluded: true,
        },
      },
      { risk: "high", authorizationRef: "authorization:recent-owner" },
    );

    expect(message).toMatchObject({
      type: "github.monitor.set_state",
      risk: "high",
      authorizationRef: "authorization:recent-owner",
      payload: { action: "enable", disclosure: { machineSecretsExcluded: true } },
    });
    expect(JSON.stringify(message)).not.toContain("accessToken");
  });

  it("builds revision-bound governance commands with a caller-owned idempotency key", () => {
    const message = commandMessage(
      configuration,
      "approval.respond",
      {
        approvalRequestId: "approval-01",
        expectedRevision: 3,
        decision: "approved",
        semanticSnapshotHash: "sha256:approval-snapshot-01",
        editedPayloadRef: null,
        recentAuthenticationRef: "authentication:owner-session-01",
      },
      {
        risk: "critical",
        authorizationRef: "authentication:owner-session-01",
        idempotencyKey: "governance:approval-01:revision-3",
      },
    );

    expect(message).toMatchObject({
      type: "approval.respond",
      risk: "critical",
      authorizationRef: "authentication:owner-session-01",
      idempotencyKey: "governance:approval-01:revision-3",
      payload: {
        approvalRequestId: "approval-01",
        expectedRevision: 3,
        semanticSnapshotHash: "sha256:approval-snapshot-01",
      },
    });
  });

  it("accepts only strict snapshots and protects plaintext through a separate endpoint", async () => {
    const bodies: string[] = [];
    const client = new GatewayClient({
      csrfToken: () => "csrf-01",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        return String(url).includes("payload")
          ? new Response(JSON.stringify({ payloadRef: "payload-protected-01" }), { status: 201 })
          : new Response(JSON.stringify(collectionSnapshot()), { status: 200 });
      }) as typeof fetch,
    });
    expect(await client.protectText("私人正文")).toBe("payload-protected-01");
    expect(
      await client.query(
        queryMessage(configuration, "thread.list", { afterCursor: null, limit: 10 }),
      ),
    ).toMatchObject({ type: "collection.snapshot" });
    expect(bodies[0]).toContain("私人正文");
    expect(bodies[1]).not.toContain("私人正文");
  });

  it("refreshes an expired CSRF token once without changing the request or idempotency key", async () => {
    const calls: RequestInit[] = [];
    let refreshes = 0;
    const client = new GatewayClient({
      csrfToken: () => "expired",
      refreshCsrfToken: async () => {
        refreshes += 1;
        return "fresh";
      },
      fetch: (async (_url, init) => {
        calls.push(init ?? {});
        return new Headers(init?.headers).get("x-csrf-token") === "expired"
          ? new Response(JSON.stringify({ error: { code: "HTTP_GATEWAY_CSRF_REJECTED" } }), {
              status: 403,
            })
          : new Response(JSON.stringify({ payloadRef: "payload-01" }), { status: 201 });
      }) as typeof fetch,
    });
    expect(await client.protectText("同一条消息", "private", "same-command")).toBe("payload-01");
    expect(refreshes).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toBe(calls[0]?.body);
    expect(new Headers(calls[1]?.headers).get("idempotency-key")).toBe("same-command");
    await client.protectText("下一条消息", "private", "next-command");
    expect(refreshes).toBe(1);
    expect(new Headers(calls[2]?.headers).get("x-csrf-token")).toBe("fresh");
  });

  it.each(["HTTP_GATEWAY_CSRF_REJECTED", "HTTP_GATEWAY_FORBIDDEN"])(
    "does not loop or retry unrelated rejection: %s",
    async (code) => {
      let calls = 0;
      let refreshes = 0;
      const client = new GatewayClient({
        csrfToken: () => "old",
        refreshCsrfToken: async () => {
          refreshes += 1;
          return "new";
        },
        fetch: (async () => {
          calls += 1;
          return new Response(JSON.stringify({ error: { code } }), { status: 403 });
        }) as typeof fetch,
      });
      await expect(client.protectText("message")).rejects.toThrow(code);
      expect(calls).toBe(code === "HTTP_GATEWAY_CSRF_REJECTED" ? 2 : 1);
      expect(refreshes).toBe(code === "HTTP_GATEWAY_CSRF_REJECTED" ? 1 : 0);
    },
  );

  it("shares token refresh across concurrent rejected requests", async () => {
    let release: (token: string) => void = () => {};
    const refresh = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const tokens: string[] = [];
    const client = new GatewayClient({
      csrfToken: () => "expired",
      refreshCsrfToken: refresh,
      fetch: (async (_url, init) => {
        const token = new Headers(init?.headers).get("x-csrf-token") ?? "";
        tokens.push(token);
        return token === "expired"
          ? new Response(JSON.stringify({ error: { code: "HTTP_GATEWAY_CSRF_REJECTED" } }), {
              status: 403,
            })
          : new Response(JSON.stringify({ payloadRef: "payload-01" }), { status: 201 });
      }) as typeof fetch,
    });
    const requests = [client.protectText("first"), client.protectText("second")];
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    release("fresh");
    await expect(Promise.all(requests)).resolves.toEqual(["payload-01", "payload-01"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(tokens).toEqual(["expired", "expired", "fresh", "fresh"]);
  });

  it("does not retry a network failure whose dispatch status is unknown", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("network interrupted");
    });
    const refresh = vi.fn(async () => "fresh");
    const client = new GatewayClient({ fetch, csrfToken: () => "old", refreshCsrfToken: refresh });
    await expect(client.protectText("message")).rejects.toThrow("network interrupted");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    ["ownerId", "other-owner"],
    ["actorId", "other-actor"],
    ["agentId", "other-agent"],
    ["deploymentId", "other-deployment"],
    ["sessionId", "other-session"],
    ["authorityEpoch", 2],
    ["fencingToken", 2],
  ])("does not refresh into another authentication scope: %s", async (key, value) => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ...configuration, csrfToken: "fresh", [key]: value })),
    );
    await expect(refreshRuntimeConfiguration(fetch, configuration)).rejects.toThrow(
      "CONTROL_CENTER_AUTHENTICATION_SCOPE_CHANGED",
    );
  });

  it("accepts a renewed token for the same authenticated scope", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ ...configuration, csrfToken: "fresh" })),
    );
    await expect(refreshRuntimeConfiguration(fetch, configuration)).resolves.toMatchObject({
      csrfToken: "fresh",
    });
  });

  it("uses strict Thread v3 endpoints and preserves a caller-supplied idempotency key", async () => {
    const calls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const client = new GatewayClient({
      csrfToken: () => "csrf-01",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        const request = JSON.parse(String(init?.body)) as { type: string; messageId: string };
        if (request.type === "thread.list") {
          return new Response(
            JSON.stringify({
              schemaVersion: "gateway.thread.v3",
              kind: "snapshot",
              type: "thread.collection_snapshot",
              messageId: "snapshot-thread-01",
              correlationId: "correlation-01",
              causationId: request.messageId,
              scope: { ownerId: "owner-01", agentId: "agent-01" },
              authority: {
                deploymentId: "deployment-01",
                authorityEpoch: 1,
                fencingToken: 1,
              },
              actor: { actorType: "system", actorId: "thread-gateway" },
              payload: {
                threads: [],
                nextCursor: null,
                snapshotRef: "snapshot-ref-01",
                generatedAt: "2026-08-27T00:00:00.000Z",
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            schemaVersion: "gateway.thread.v3",
            kind: "result",
            type: "thread.command_result",
            messageId: "result-thread-01",
            correlationId: "correlation-01",
            causationId: request.messageId,
            scope: { ownerId: "owner-01", agentId: "agent-01" },
            authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
            actor: { actorType: "system", actorId: "thread-gateway" },
            payload: {
              commandType: "thread.pin",
              commandId: request.messageId,
              threadId: "thread-01",
              threadRevision: 2,
              resultRef: "payload-result-01",
              replayed: false,
              committedAt: "2026-08-27T00:00:00.000Z",
            },
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    await client.queryThread(
      threadQueryMessage(configuration, "thread.list", {
        statuses: ["active"],
        pinnedOnly: false,
        afterCursor: null,
        limit: 10,
      }),
    );
    await client.mutateThread(
      threadCommandMessage(
        configuration,
        "thread.pin",
        {
          threadId: "thread-01",
          expectedRevision: 1,
          pinOrder: 0,
          resultRef: "payload-result-01",
        },
        "idempotency-thread-01",
      ),
    );

    expect(calls.map(({ url }) => url)).toEqual([
      "/api/gateway/thread/v3/queries",
      "/api/gateway/thread/v3/commands",
    ]);
    expect(new Headers(calls[1]?.init.headers).get("idempotency-key")).toBe(
      "idempotency-thread-01",
    );
  });
});

describe("browser storage and SSE recovery", () => {
  it("retains the initial search-setting retry identity without accepting revision zero for existing objects", () => {
    const storage = new ControlCenterBrowserStorage(new MemoryStorage());
    const pending = {
      operationKey: "search-authorization:0:enable",
      idempotencyKey: "governance:search-enable",
      commandType: "search.authorization.set",
      objectRef: "search-authorization",
      expectedRevision: 0,
    };
    storage.savePendingGovernanceMutation(pending);
    expect(storage.readPendingGovernanceMutation(pending.operationKey)).toEqual(pending);
    expect(() =>
      storage.savePendingGovernanceMutation({ ...pending, commandType: "approval.respond" }),
    ).toThrow("CONTROL_CENTER_MUTATION_IDENTITY_INVALID");
  });

  it("stores only draft, preferences and durable cursor while logs omit content", () => {
    const raw = new MemoryStorage();
    const storage = new ControlCenterBrowserStorage(raw);
    storage.saveDraft("thread-01", "未发送草稿");
    storage.saveLastCursor("cursor-01");
    storage.saveThreadLastCursor("thread-cursor:01");
    storage.savePendingThreadMutation({
      operationKey: "op:pin:1:thread-01",
      idempotencyKey: "idempotency-thread-01",
      commandType: "thread.pin",
      threadId: "thread-01",
    });
    storage.savePendingGovernanceMutation({
      operationKey: "approval.approve:approval-01:3",
      idempotencyKey: "governance:approval-01:revision-3",
      commandType: "approval.respond",
      objectRef: "approval-01",
      expectedRevision: 3,
    });
    storage.savePreferences({
      density: "compact",
      detailPanePercent: 22,
      listPanePercent: 28,
      theme: "dark",
    });

    expect([...Array(raw.length)].map((_, index) => raw.key(index))).toEqual(
      expect.arrayContaining([
        "himawari.control-center.v1.draft.thread-01",
        "himawari.control-center.v1.lastCursor",
        "himawari.control-center.v1.threadLastCursor",
        "himawari.control-center.v1.mutation.op:pin:1:thread-01",
        "himawari.control-center.v1.governanceMutation.approval.approve:approval-01:3",
        "himawari.control-center.v1.preferences",
      ]),
    );
    expect(raw.getItem("himawari.control-center.v1.mutation.op:pin:1:thread-01")).not.toContain(
      "未发送草稿",
    );
    const governanceIdentity = raw.getItem(
      "himawari.control-center.v1.governanceMutation.approval.approve:approval-01:3",
    );
    expect(governanceIdentity).toContain("governance:approval-01:revision-3");
    expect(governanceIdentity).not.toContain("semanticSnapshotHash");
    expect(governanceIdentity).not.toContain("authentication:owner-session-01");
    const log = safeBrowserLog("EVENT", {
      type: "stream.event",
      messageId: "event-01",
      payload: { cursor: "cursor-01", content: "机器秘密 sk-secret" },
    });
    expect(JSON.stringify(log)).not.toContain("机器秘密");
  });

  it("persists cursor, rejects malformed events and reconnects from the last cursor", () => {
    const storage = new ControlCenterBrowserStorage(new MemoryStorage());
    storage.saveLastCursor("cursor-01");
    const urls: string[] = [];
    const sources: EventSourceLike[] = [];
    const events: GatewayV2Event[] = [];
    const logs: string[] = [];
    const scheduled: Array<() => void> = [];
    const synchronizer = new SseStateSynchronizer({
      storage,
      createEventSource(url) {
        urls.push(url);
        const source: EventSourceLike = { onmessage: null, onerror: null, close: vi.fn() };
        sources.push(source);
        return source;
      },
      onEvent: (event) => events.push(event),
      onConnectionState: vi.fn(),
      log: (entry) => logs.push(entry.code),
      schedule(callback) {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancelSchedule: vi.fn(),
    });
    synchronizer.start();
    sources[0]?.onmessage?.({ data: JSON.stringify(streamEvent()) } as MessageEvent<string>);
    sources[0]?.onmessage?.({ data: JSON.stringify({ raw: "secret" }) } as MessageEvent<string>);
    sources[0]?.onerror?.(new Event("error"));
    scheduled[0]?.();

    expect(events).toHaveLength(1);
    expect(logs).toEqual(["CONTROL_CENTER_EVENT_REJECTED"]);
    expect(storage.readLastCursor()).toBe("cursor-02");
    expect(urls).toEqual([
      "/api/gateway/v2/events?afterCursor=cursor-01",
      "/api/gateway/v2/events?afterCursor=cursor-02",
    ]);
    synchronizer.stop();
  });

  it("refreshes snapshots without changing durable cursors or reconnecting on invalidation hints", () => {
    const storage = new ControlCenterBrowserStorage(new MemoryStorage());
    storage.saveLastCursor("cursor-01");
    const listeners = new Map<string, (event: MessageEvent<string>) => void>();
    const refresh = vi.fn();
    const connect = vi.fn(() => ({
      onmessage: null,
      onerror: null,
      close: vi.fn(),
      addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
        listeners.set(type, listener);
      },
    }));
    const synchronizer = new SseStateSynchronizer({
      storage,
      createEventSource: connect,
      onEvent: vi.fn(),
      onSnapshotRequired: refresh,
      onConnectionState: vi.fn(),
      log: vi.fn(),
    });
    synchronizer.start();
    const notify = () =>
      listeners.get("gateway.snapshot_required")?.({
        data: JSON.stringify({ reason: "state_changed" }),
      } as MessageEvent<string>);
    notify();
    expect(refresh).toHaveBeenCalledWith("state_changed");
    expect(storage.readLastCursor()).toBe("cursor-01");
    expect(connect).toHaveBeenCalledTimes(1);
    synchronizer.stop();
    notify();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("deduplicates events and requests a snapshot for gaps or authority changes", () => {
    const storage = new ControlCenterBrowserStorage(new MemoryStorage());
    storage.saveLastCursor("cursor-01");
    const sources: EventSourceLike[] = [];
    const events: GatewayV2Event[] = [];
    const snapshotReasons: string[] = [];
    const synchronizer = new SseStateSynchronizer({
      storage,
      createEventSource() {
        const source: EventSourceLike = { onmessage: null, onerror: null, close: vi.fn() };
        sources.push(source);
        return source;
      },
      onEvent: (event) => events.push(event),
      onSnapshotRequired: (reason) => snapshotReasons.push(reason),
      onConnectionState: vi.fn(),
      log: vi.fn(),
    });
    synchronizer.start();

    const first = streamEvent();
    sources[0]?.onmessage?.({ data: JSON.stringify(first) } as MessageEvent<string>);
    sources[0]?.onmessage?.({ data: JSON.stringify(first) } as MessageEvent<string>);
    const outOfOrder = {
      ...first,
      messageId: "event-out-of-order",
      payload: { ...first.payload, eventId: "event-out-of-order", sequence: 1 },
    };
    sources[0]?.onmessage?.({ data: JSON.stringify(outOfOrder) } as MessageEvent<string>);
    const gap = {
      ...first,
      messageId: "event-gap",
      payload: {
        ...first.payload,
        cursor: "cursor-04",
        eventId: "event-gap",
        sequence: 4,
      },
    };
    sources[0]?.onmessage?.({ data: JSON.stringify(gap) } as MessageEvent<string>);

    expect(events).toEqual([first]);
    expect(snapshotReasons).toEqual(["event_sequence_gap"]);
    expect(storage.readLastCursor()).toBeNull();

    const afterGap = {
      ...first,
      messageId: "event-after-gap",
      authority: { ...first.authority, authorityEpoch: 2 },
      payload: {
        ...first.payload,
        cursor: "cursor-05",
        eventId: "event-after-gap",
        sequence: 5,
      },
    };
    sources[0]?.onmessage?.({ data: JSON.stringify(afterGap) } as MessageEvent<string>);
    expect(snapshotReasons).toEqual(["event_sequence_gap", "authority_scope_changed"]);
    expect(events).toEqual([first]);
    synchronizer.stop();
  });

  it("rejects a cursor that predates the retention window", () => {
    const storage = new ControlCenterBrowserStorage(new MemoryStorage());
    storage.saveLastCursor("cursor-02");
    const sources: EventSourceLike[] = [];
    const snapshotReasons: string[] = [];
    const synchronizer = new SseStateSynchronizer({
      storage,
      createEventSource() {
        const source: EventSourceLike = { onmessage: null, onerror: null, close: vi.fn() };
        sources.push(source);
        return source;
      },
      onEvent: vi.fn(),
      onSnapshotRequired: (reason) => snapshotReasons.push(reason),
      onConnectionState: vi.fn(),
      log: vi.fn(),
    });
    synchronizer.start();
    const retained = streamEvent();
    sources[0]?.onmessage?.({
      data: JSON.stringify({
        ...retained,
        payload: { ...retained.payload, retentionStartCursor: "cursor-03" },
      }),
    } as MessageEvent<string>);

    expect(snapshotReasons).toEqual(["cursor_retention_gap"]);
    expect(storage.readLastCursor()).toBeNull();
    synchronizer.stop();
  });

  it("ignores replay and callbacks from disconnected Thread sources", () => {
    const storage = new ControlCenterBrowserStorage(new MemoryStorage());
    const sources: EventSourceLike[] = [];
    const changed = vi.fn();
    const states: string[] = [];
    const synchronizer = new ThreadSseSynchronizer({
      configuration,
      storage,
      createEventSource: () => {
        const source: EventSourceLike = { onmessage: null, onerror: null, close: vi.fn() };
        sources.push(source);
        return source;
      },
      onCommittedEvent: changed,
      onSnapshotRequired: vi.fn(),
      onConnectionState: (state) => states.push(state),
      log: vi.fn(),
    });
    synchronizer.start();
    const message = { data: JSON.stringify(threadEvent()) } as MessageEvent<string>;
    sources[0]?.onmessage?.(message);
    sources[0]?.onmessage?.(message);
    expect(changed).toHaveBeenCalledTimes(1);
    synchronizer.setNetworkOnline(false);
    sources[0]?.onopen?.(new Event("open"));
    sources[0]?.onmessage?.(message);
    expect(states.at(-1)).toBe("offline");
    expect(changed).toHaveBeenCalledTimes(1);
    synchronizer.setNetworkOnline(true);
    expect(sources).toHaveLength(2);
    sources[1]?.onopen?.(new Event("open"));
    expect(states.at(-1)).toBe("connected");
    synchronizer.stop();
  });

  it("resumes Thread events from a separate cursor and requests a snapshot on retention loss", () => {
    const storage = new ControlCenterBrowserStorage(new MemoryStorage());
    storage.saveThreadLastCursor("thread-cursor:01");
    const urls: string[] = [];
    const sources: Array<
      EventSourceLike & { listeners: Map<string, (event: MessageEvent<string>) => void> }
    > = [];
    const callbacks: string[] = [];
    const connectionStates: string[] = [];
    const synchronizer = new ThreadSseSynchronizer({
      configuration,
      storage,
      createEventSource(url) {
        urls.push(url);
        const listeners = new Map<string, (event: MessageEvent<string>) => void>();
        const source = {
          listeners,
          onopen: null,
          onmessage: null,
          onerror: null,
          addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
            listeners.set(type, listener);
          },
          close: vi.fn(),
        } satisfies EventSourceLike & {
          listeners: Map<string, (event: MessageEvent<string>) => void>;
        };
        sources.push(source);
        return source;
      },
      onCommittedEvent: () => callbacks.push("event"),
      onSnapshotRequired: () => callbacks.push("snapshot"),
      onConnectionState: (state) => connectionStates.push(state),
      log: vi.fn(),
    });
    synchronizer.start();
    expect(connectionStates).toEqual(["connecting"]);
    sources[0]?.onopen?.(new Event("open"));
    expect(connectionStates).toEqual(["connecting", "connected"]);
    sources[0]?.onmessage?.({ data: JSON.stringify(threadEvent()) } as MessageEvent<string>);
    sources[0]?.listeners.get("thread.snapshot_required")?.(
      new MessageEvent("thread.snapshot_required", { data: "{}" }),
    );

    const encoded = new URL(`https://fixture.test${urls[0]}`).searchParams.get("subscription");
    const normalized = (encoded ?? "").replaceAll("-", "+").replaceAll("_", "/");
    const subscription = JSON.parse(
      atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")),
    );
    expect(subscription).toMatchObject({
      type: "thread.events",
      payload: { afterCursor: "thread-cursor:01" },
    });
    expect(callbacks).toEqual(["snapshot", "event", "snapshot"]);
    expect(storage.readThreadLastCursor()).toBeNull();
    synchronizer.stop();
  });
});

describe("browser identity session", () => {
  it("creates the session through the authenticated same-origin route", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("{}", { status: 201 }));
    await createBrowserSession(fetch, "My browser");
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/identity/v1/sessions", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ deviceLabel: "My browser" }),
    });
  });
  it("preserves rejected identity and does not retry automatically", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "IDENTITY_SUBJECT_UNBOUND" } }), {
        status: 403,
      }),
    );
    await expect(createBrowserSession(fetch, "My browser")).rejects.toMatchObject({
      message: "IDENTITY_SUBJECT_UNBOUND",
      status: 403,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
