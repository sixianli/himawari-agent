import type { GatewayV2Event, ThreadGatewayEvent } from "@himawari-agent/gateway-contracts";
import { describe, expect, it, vi } from "vitest";
import { ControlCenterBrowserStorage } from "../src/browser-storage.js";
import { GatewayClient, loadRuntimeConfiguration, safeBrowserLog } from "../src/gateway-client.js";
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
  it("loads scoped governance authentication references without exposing credentials", async () => {
    const loaded = await loadRuntimeConfiguration(
      (async () =>
        new Response(
          JSON.stringify({
            ...configuration,
            authorizationRef: "authentication:owner-session-01",
            recentAuthenticationRef: "authentication:owner-session-01",
          }),
          { status: 200 },
        )) as typeof fetch,
    );

    expect(loaded).toMatchObject({
      authorizationRef: "authentication:owner-session-01",
      recentAuthenticationRef: "authentication:owner-session-01",
    });
    expect(JSON.stringify(loaded)).not.toContain("password");
    expect(JSON.stringify(loaded)).not.toContain("accessToken");
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

  it("resumes Thread events from a separate cursor and requests a snapshot on retention loss", () => {
    const storage = new ControlCenterBrowserStorage(new MemoryStorage());
    storage.saveThreadLastCursor("thread-cursor:01");
    const urls: string[] = [];
    const sources: Array<
      EventSourceLike & { listeners: Map<string, (event: MessageEvent<string>) => void> }
    > = [];
    const callbacks: string[] = [];
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
      log: vi.fn(),
    });
    synchronizer.start();
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
    expect(callbacks).toEqual(["event", "snapshot"]);
    expect(storage.readThreadLastCursor()).toBeNull();
    synchronizer.stop();
  });
});
