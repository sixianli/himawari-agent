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
  readonly storage: ControlCenterBrowserStorage;
  readonly createEventSource: (url: string) => EventSourceLike;
  readonly onEvent: (event: GatewayV2Event) => void;
  readonly onConnectionState: (state: "connecting" | "connected" | "offline") => void;
  readonly log: (entry: SafeBrowserLogEntry) => void;
  readonly schedule?: (callback: () => void, milliseconds: number) => number;
  readonly cancelSchedule?: (handle: number) => void;
}

export class SseStateSynchronizer {
  private readonly options: SseSynchronizerOptions;
  private source: EventSourceLike | undefined;
  private reconnectHandle: number | undefined;
  private reconnectAttempt = 0;
  private stopped = true;

  constructor(options: SseSynchronizerOptions) {
    this.options = options;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  reconnectNow(): void {
    if (this.stopped) return;
    this.source?.close();
    this.source = undefined;
    this.clearReconnect();
    this.connect();
  }

  stop(): void {
    this.stopped = true;
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
    source.onopen = () => {
      this.reconnectAttempt = 0;
      this.options.onConnectionState("connected");
    };
    source.onmessage = (message) => {
      try {
        const parsed = gatewayV2MessageSchema.parseJson(message.data);
        if (parsed.kind !== "event") throw new Error("CONTROL_CENTER_EVENT_INVALID");
        this.options.storage.saveLastCursor(parsed.payload.cursor);
        this.reconnectAttempt = 0;
        this.options.onConnectionState("connected");
        this.options.onEvent(parsed);
      } catch {
        this.options.log(safeBrowserLog("CONTROL_CENTER_EVENT_REJECTED"));
      }
    };
    source.onerror = () => {
      if (this.source === source) this.source = undefined;
      source.close();
      this.options.onConnectionState("offline");
      this.scheduleReconnect();
    };
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
