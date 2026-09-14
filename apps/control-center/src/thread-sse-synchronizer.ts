import { threadGatewayMessageSchema } from "@himawari-agent/gateway-contracts";
import type { ControlCenterBrowserStorage } from "./browser-storage.js";
import type { ControlCenterRuntimeConfiguration } from "./gateway-client.js";
import { type SafeBrowserLogEntry, safeBrowserLog } from "./gateway-client.js";
import { threadSubscriptionMessage } from "./messages.js";
import type { EventSourceLike } from "./sse-synchronizer.js";

export interface ThreadSseSynchronizerOptions {
  readonly onUnauthorized?: () => void;
  readonly configuration: ControlCenterRuntimeConfiguration;
  readonly storage: ControlCenterBrowserStorage;
  readonly createEventSource: (url: string) => EventSourceLike;
  readonly onCommittedEvent: () => void;
  readonly onSnapshotRequired: () => void;
  readonly onConnectionState?: (state: "connecting" | "connected" | "offline") => void;
  readonly log: (entry: SafeBrowserLogEntry) => void;
  readonly schedule?: (callback: () => void, milliseconds: number) => number;
  readonly cancelSchedule?: (handle: number) => void;
}

function base64Url(value: string): string {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export class ThreadSseSynchronizer {
  readonly #options: ThreadSseSynchronizerOptions;
  #source: EventSourceLike | undefined;
  #handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectHandle: number | undefined;
  #attempt = 0;
  #stopped = true;
  #networkOffline = false;

  constructor(options: ThreadSseSynchronizerOptions) {
    this.#options = options;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  setNetworkOnline(online: boolean): void {
    this.#networkOffline = !online;
    if (online) {
      this.reconnectNow();
      return;
    }
    this.#clearHandshake();
    this.#source?.close();
    this.#source = undefined;
    this.#clearReconnect();
    this.#options.onConnectionState?.("offline");
  }

  reconnectNow(): void {
    if (this.#stopped || this.#source) return;
    this.#clearReconnect();
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearHandshake();
    this.#source?.close();
    this.#source = undefined;
    this.#clearReconnect();
  }

  #connect(): void {
    if (this.#stopped || this.#networkOffline || this.#source) return;
    this.#options.onConnectionState?.("connecting");
    const subscription = threadSubscriptionMessage(
      this.#options.configuration,
      this.#options.storage.readThreadLastCursor(),
    );
    const url = `/api/gateway/thread/v3/events?subscription=${encodeURIComponent(
      base64Url(threadGatewayMessageSchema.serialize(subscription)),
    )}`;
    const source = this.#options.createEventSource(url);
    this.#source = source;
    source.onopen = () => {
      if (this.#stopped || this.#source !== source) return;
      this.#clearHandshake();
      this.#options.onSnapshotRequired();
      this.#attempt = 0;
      this.#options.onConnectionState?.("connected");
    };
    source.onmessage = (message) => {
      if (this.#stopped || this.#source !== source) return;
      try {
        const parsed = threadGatewayMessageSchema.parseJson(message.data);
        if (parsed.kind !== "event") throw new Error("CONTROL_CENTER_THREAD_EVENT_INVALID");
        const previous = this.#options.storage.readThreadLastCursor();
        const ordinal = (cursor: string | null) => Number(cursor?.match(/:(\d+)$/)?.[1] ?? -1);
        if (
          previous === parsed.payload.cursor ||
          ordinal(previous) >= ordinal(parsed.payload.cursor)
        )
          return;
        this.#options.storage.saveThreadLastCursor(parsed.payload.cursor);
        this.#attempt = 0;
        this.#options.onCommittedEvent();
      } catch {
        this.#options.log(safeBrowserLog("CONTROL_CENTER_THREAD_EVENT_REJECTED"));
      }
    };
    source.addEventListener?.("gateway.stream_error", (event) => {
      if (this.#stopped || this.#source !== source) return;
      try {
        const value: unknown = JSON.parse(event.data);
        if (
          value &&
          typeof value === "object" &&
          "code" in value &&
          value.code === "IDENTITY_SESSION_INVALID"
        ) {
          this.stop();
          this.#options.onUnauthorized?.();
        }
      } catch {
        this.#options.log(safeBrowserLog("CONTROL_CENTER_EVENT_REJECTED"));
      }
    });
    source.addEventListener?.("thread.snapshot_required", () => {
      if (this.#stopped || this.#source !== source) return;
      this.#options.storage.clearThreadLastCursor();
      this.#options.onSnapshotRequired();
    });
    const disconnect = () => {
      if (this.#stopped || this.#source !== source) return;
      this.#clearHandshake();
      this.#source = undefined;
      source.close();
      this.#options.onConnectionState?.("offline");
      this.#scheduleReconnect();
    };
    source.onerror = disconnect;
    this.#handshakeTimer = setTimeout(disconnect, 10_000);
  }

  #clearHandshake(): void {
    clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = undefined;
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectHandle !== undefined) return;
    const delay = Math.min(5_000, 250 * 2 ** this.#attempt);
    this.#attempt = Math.min(this.#attempt + 1, 5);
    const schedule =
      this.#options.schedule ??
      ((callback, milliseconds) => window.setTimeout(callback, milliseconds));
    this.#reconnectHandle = schedule(() => {
      this.#reconnectHandle = undefined;
      this.#connect();
    }, delay);
  }

  #clearReconnect(): void {
    if (this.#reconnectHandle === undefined) return;
    const cancel = this.#options.cancelSchedule ?? ((handle) => window.clearTimeout(handle));
    cancel(this.#reconnectHandle);
    this.#reconnectHandle = undefined;
  }
}
