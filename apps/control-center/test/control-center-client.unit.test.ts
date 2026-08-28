import type { GatewayV2Event } from "@himawari-agent/gateway-contracts";
import { describe, expect, it, vi } from "vitest";
import { ControlCenterBrowserStorage } from "../src/browser-storage.js";
import { GatewayClient, safeBrowserLog } from "../src/gateway-client.js";
import { commandMessage, queryMessage } from "../src/messages.js";
import { type EventSourceLike, SseStateSynchronizer } from "../src/sse-synchronizer.js";

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

describe("typed browser Gateway client", () => {
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
});

describe("browser storage and SSE recovery", () => {
  it("stores only draft, preferences and durable cursor while logs omit content", () => {
    const raw = new MemoryStorage();
    const storage = new ControlCenterBrowserStorage(raw);
    storage.saveDraft("thread-01", "未发送草稿");
    storage.saveLastCursor("cursor-01");
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
        "himawari.control-center.v1.preferences",
      ]),
    );
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
});
