import { type GatewayV2Event, gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import type { ControlCenterBrowserStorage } from "./browser-storage.js";
import { safeBrowserLog, type SafeBrowserLogEntry } from "./gateway-client.js";

export interface EventSourceLike {
  onopen?: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener?(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface SseSynchronizerOptions {
  readonly onUnauthorized?: () => void;
  readonly storage: ControlCenterBrowserStorage;
  readonly createEventSource: (url: string) => EventSourceLike;
  readonly onEvent: (event: GatewayV2Event) => void;
  readonly onSnapshotRequired?: (
    reason:
      | "cursor_retention_gap"
      | "event_sequence_gap"
      | "authority_scope_changed"
      | "state_changed",
  ) => void;
  readonly onConnectionState: (state: "connecting" | "connected" | "offline") => void;
  readonly log: (entry: SafeBrowserLogEntry) => void;
  readonly schedule?: (callback: () => void, milliseconds: number) => number;
  readonly cancelSchedule?: (handle: number) => void;
}

export class SseStateSynchronizer {
  private readonly options: SseSynchronizerOptions;
  private source: EventSourceLike | undefined;
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectHandle: number | undefined;
  private reconnectAttempt = 0;
  private stopped = true;
  private readonly seenEventIds = new Set<string>();
  private readonly scopeSequences = new Map<string, number>();
  private authorityScope: string | undefined;

  constructor(options: SseSynchronizerOptions) {
    this.options = options;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  reconnectNow(): void {
    if (this.stopped || this.source) return;
    this.clearReconnect();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearHandshake();
    this.source?.close();
    this.source = undefined;
    this.clearReconnect();
  }

  private connect(): void {
    if (this.stopped || this.source) return;
    this.options.onConnectionState("connecting");
    const cursor = this.options.storage.readLastCursor();
    const url = cursor
      ? `/api/gateway/v2/events?afterCursor=${encodeURIComponent(cursor)}`
      : "/api/gateway/v2/events";
    const source = this.options.createEventSource(url);
    this.source = source;
    source.addEventListener?.("gateway.stream_error", (event) => {
      if (this.stopped || this.source !== source) return;
      try {
        const value: unknown = JSON.parse(event.data);
        if (
          value &&
          typeof value === "object" &&
          "code" in value &&
          value.code === "IDENTITY_SESSION_INVALID"
        ) {
          this.stop();
          this.options.onUnauthorized?.();
        }
      } catch {
        this.options.log(safeBrowserLog("CONTROL_CENTER_EVENT_REJECTED"));
      }
    });
    source.addEventListener?.("gateway.snapshot_required", (message) => {
      if (this.stopped || this.source !== source) return;
      try {
        const notification = JSON.parse(message.data) as { readonly reason?: unknown };
        if (notification.reason !== "state_changed") throw new Error("INVALID_SNAPSHOT_REASON");
        this.options.onSnapshotRequired?.("state_changed");
      } catch {
        this.options.log(safeBrowserLog("CONTROL_CENTER_EVENT_REJECTED"));
      }
    });
    source.onopen = () => {
      if (this.stopped || this.source !== source) return;
      this.clearHandshake();
      this.reconnectAttempt = 0;
      this.options.onConnectionState("connected");
    };
    source.onmessage = (message) => {
      if (this.stopped || this.source !== source) return;
      try {
        const parsed = gatewayV2MessageSchema.parseJson(message.data);
        if (parsed.kind !== "event") throw new Error("CONTROL_CENTER_EVENT_INVALID");
        const disposition = this.reduceEvent(parsed);
        if (disposition === "ignore") return;
        if (disposition !== "apply") {
          this.options.storage.clearLastCursor();
          this.scopeSequences.clear();
          this.seenEventIds.clear();
          this.options.onSnapshotRequired?.(disposition);
          this.options.log(safeBrowserLog(`CONTROL_CENTER_SNAPSHOT_REQUIRED:${disposition}`));
          return;
        }
        this.options.storage.saveLastCursor(parsed.payload.cursor);
        this.reconnectAttempt = 0;
        this.options.onConnectionState("connected");
        this.options.onEvent(parsed);
      } catch {
        this.options.log(safeBrowserLog("CONTROL_CENTER_EVENT_REJECTED"));
      }
    };
    const disconnect = () => {
      if (this.stopped || this.source !== source) return;
      this.clearHandshake();
      this.source = undefined;
      source.close();
      this.options.onConnectionState("offline");
      this.scheduleReconnect();
    };
    source.onerror = disconnect;
    this.handshakeTimer = setTimeout(disconnect, 10_000);
  }

  private clearHandshake(): void {
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
  }

  private reduceEvent(
    event: GatewayV2Event,
  ):
    | "apply"
    | "ignore"
    | "cursor_retention_gap"
    | "event_sequence_gap"
    | "authority_scope_changed" {
    const storedCursor = this.options.storage.readLastCursor();
    const storedOrdinal = cursorOrdinal(storedCursor);
    const retentionOrdinal = cursorOrdinal(event.payload.retentionStartCursor);
    if (
      storedCursor &&
      storedOrdinal !== undefined &&
      retentionOrdinal !== undefined &&
      storedOrdinal < retentionOrdinal
    ) {
      return "cursor_retention_gap";
    }

    if (this.seenEventIds.has(event.payload.eventId)) return "ignore";

    const authorityScope = [
      event.scope.ownerId,
      event.scope.agentId,
      event.authority.deploymentId,
      event.authority.authorityEpoch,
      event.authority.fencingToken,
    ].join(":");
    if (this.authorityScope && this.authorityScope !== authorityScope) {
      this.authorityScope = authorityScope;
      return "authority_scope_changed";
    }
    this.authorityScope = authorityScope;

    const scopeKey = `${event.payload.scopeKind}:${event.payload.scopeId}`;
    const previousSequence = this.scopeSequences.get(scopeKey);
    if (previousSequence !== undefined) {
      if (event.payload.sequence <= previousSequence) return "ignore";
      if (event.payload.sequence > previousSequence + 1) return "event_sequence_gap";
    }

    this.scopeSequences.set(scopeKey, event.payload.sequence);
    this.seenEventIds.add(event.payload.eventId);
    if (this.seenEventIds.size > 2_048) {
      const oldest = this.seenEventIds.values().next().value;
      if (oldest) this.seenEventIds.delete(oldest);
    }
    return "apply";
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectHandle !== undefined) return;
    const delay = Math.min(5_000, 250 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 5);
    const schedule =
      this.options.schedule ??
      ((callback, milliseconds) => window.setTimeout(callback, milliseconds));
    this.reconnectHandle = schedule(() => {
      this.reconnectHandle = undefined;
      this.connect();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectHandle === undefined) return;
    const cancel = this.options.cancelSchedule ?? ((handle) => window.clearTimeout(handle));
    cancel(this.reconnectHandle);
    this.reconnectHandle = undefined;
  }
}

function cursorOrdinal(cursor: string | null): number | undefined {
  if (!cursor) return undefined;
  const match = cursor.match(/(?:^|[-_:])(\d+)$/);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}
