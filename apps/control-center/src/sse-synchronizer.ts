import { type GatewayV2Event, gatewayV2MessageSchema } from "@himawari-agent/gateway-contracts";
import type { ControlCenterBrowserStorage } from "./browser-storage.js";
import {
  type EventSourceLike,
  type EventStreamOptions,
  ReconnectingEventStream,
} from "./event-stream.js";

export type { EventSourceLike } from "./event-stream.js";

export interface SseSynchronizerOptions extends EventStreamOptions {
  readonly storage: ControlCenterBrowserStorage;
  readonly onEvent: (event: GatewayV2Event) => void;
  readonly onSnapshotRequired?: (
    reason:
      | "cursor_retention_gap"
      | "event_sequence_gap"
      | "authority_scope_changed"
      | "state_changed",
  ) => void;
  readonly onConnectionState: (state: "connecting" | "connected" | "offline") => void;
}

export class SseStateSynchronizer extends ReconnectingEventStream<SseSynchronizerOptions> {
  private readonly seenEventIds = new Set<string>();
  private readonly scopeSequences = new Map<string, number>();
  private authorityScope: string | undefined;

  protected url(): string {
    const cursor = this.options.storage.readLastCursor();
    return cursor
      ? `/api/gateway/v2/events?afterCursor=${encodeURIComponent(cursor)}`
      : "/api/gateway/v2/events";
  }

  protected bind(source: EventSourceLike, live: () => boolean): void {
    source.addEventListener?.("gateway.snapshot_required", (message) => {
      if (!live()) return;
      try {
        const notification = JSON.parse(message.data) as { readonly reason?: unknown };
        if (notification.reason === "state_changed")
          return this.options.onSnapshotRequired?.("state_changed");
      } catch {}
      this.log("CONTROL_CENTER_EVENT_REJECTED");
    });
    source.onmessage = (message) => {
      if (!live()) return;
      try {
        const parsed = gatewayV2MessageSchema.parseJson(message.data);
        if (parsed.kind === "event") {
          const disposition = this.reduceEvent(parsed);
          if (disposition === "ignore") return;
          if (disposition !== "apply") {
            this.options.storage.clearLastCursor();
            this.scopeSequences.clear();
            this.seenEventIds.clear();
            this.options.onSnapshotRequired?.(disposition);
            return this.log(`CONTROL_CENTER_SNAPSHOT_REQUIRED:${disposition}`);
          }
          this.options.storage.saveLastCursor(parsed.payload.cursor);
          this.resetBackoff();
          this.connectionState("connected");
          return this.options.onEvent(parsed);
        }
      } catch {}
      this.log("CONTROL_CENTER_EVENT_REJECTED");
    };
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
}

function cursorOrdinal(cursor: string | null): number | undefined {
  if (!cursor) return undefined;
  const match = cursor.match(/(?:^|[-_:])(\d+)$/);
  if (!match?.[1]) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}
