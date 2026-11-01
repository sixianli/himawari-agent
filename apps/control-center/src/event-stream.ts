import {
  type ThreadGatewayMessage,
  threadGatewayMessageSchema,
} from "@himawari-agent/gateway-contracts";
import { type SafeBrowserLogEntry, safeBrowserLog } from "./gateway-client.js";

export interface EventSourceLike {
  onopen?: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener?(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}

export interface EventStreamOptions {
  readonly createEventSource?: ((url: string) => EventSourceLike) | undefined;
  readonly onUnauthorized?: () => void;
  readonly log?: (entry: SafeBrowserLogEntry) => void;
  readonly schedule?: (callback: () => void, milliseconds: number) => number;
  readonly cancelSchedule?: (handle: number) => void;
  readonly onConnectionState?: (state: "connecting" | "connected" | "offline") => void;
}

export function threadStreamUrl(path: string, subscription: ThreadGatewayMessage): string {
  const encoded = btoa(threadGatewayMessageSchema.serialize(subscription))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `/api/gateway/thread/v3/${path}?subscription=${encodeURIComponent(encoded)}`;
}

export abstract class ReconnectingEventStream<Options extends EventStreamOptions> {
  protected readonly options: Options;
  #source: EventSourceLike | undefined;
  #handshakeTimer: ReturnType<typeof setTimeout> | undefined;
  #silenceTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeatMilliseconds: number | undefined;
  #reconnectHandle: number | undefined;
  #attempt = 0;
  #stopped = true;
  #networkOffline = false;

  constructor(options: Options) {
    this.options = options;
  }

  protected abstract url(): string;
  protected abstract bind(source: EventSourceLike, live: () => boolean): void;
  protected opened(): void {}

  protected connectionState(state: "connecting" | "connected" | "offline"): void {
    this.options.onConnectionState?.(state);
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
    this.#close();
    this.#clearReconnect();
    this.connectionState("offline");
  }

  reconnectNow(force = false): void {
    if (this.#stopped || this.#networkOffline) return;
    if (this.#source) {
      if (!force) return;
      this.#close();
    }
    this.#clearReconnect();
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#close();
    this.#clearReconnect();
  }

  protected log(code: string): void {
    const entry = safeBrowserLog(code);
    if (this.options.log) this.options.log(entry);
    else window.dispatchEvent(new CustomEvent("himawari:safe-log", { detail: entry }));
  }

  protected resetBackoff(): void {
    this.#attempt = 0;
  }

  #close(): void {
    clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = undefined;
    clearTimeout(this.#silenceTimer);
    this.#silenceTimer = undefined;
    this.#source?.close();
    this.#source = undefined;
  }

  #connect(): void {
    if (this.#stopped || this.#networkOffline || this.#source) return;
    this.connectionState("connecting");
    const source = this.options.createEventSource
      ? this.options.createEventSource(this.url())
      : new EventSource(this.url(), { withCredentials: true });
    this.#source = source;
    const live = () => !this.#stopped && this.#source === source;
    source.onopen = () => {
      if (!live()) return;
      clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = undefined;
      this.#attempt = 0;
      this.opened();
      this.connectionState("connected");
    };
    const disconnect = () => {
      if (!live()) return;
      this.#close();
      this.connectionState("offline");
      this.#scheduleReconnect();
    };
    source.onmessage = null;
    this.bind(source, live);
    const bound = source.onmessage as EventSourceLike["onmessage"];
    source.onmessage = (message: MessageEvent<string>) => {
      if (live()) this.#armSilenceWatchdog(disconnect);
      bound?.(message);
    };
    source.addEventListener?.("gateway.heartbeat", (event) => {
      if (!live()) return;
      try {
        const value: unknown = JSON.parse(event.data);
        const interval =
          value && typeof value === "object" && "intervalMilliseconds" in value
            ? Number(value.intervalMilliseconds)
            : Number.NaN;
        if (Number.isFinite(interval) && interval > 0) this.#heartbeatMilliseconds = interval;
      } catch {}
      this.#armSilenceWatchdog(disconnect);
    });
    source.addEventListener?.("gateway.stream_error", (event) => {
      if (!live()) return;
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
        this.log("CONTROL_CENTER_EVENT_REJECTED");
      }
    });
    source.onerror = disconnect;
    this.#handshakeTimer = setTimeout(disconnect, 10_000);
  }

  #armSilenceWatchdog(onSilence: () => void): void {
    clearTimeout(this.#silenceTimer);
    if (this.#heartbeatMilliseconds === undefined) return;
    this.#silenceTimer = setTimeout(onSilence, this.#heartbeatMilliseconds * 2.5);
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectHandle !== undefined) return;
    const delay = Math.min(5_000, 250 * 2 ** this.#attempt);
    this.#attempt = Math.min(this.#attempt + 1, 5);
    const schedule =
      this.options.schedule ??
      ((callback, milliseconds) => window.setTimeout(callback, milliseconds));
    this.#reconnectHandle = schedule(() => {
      this.#reconnectHandle = undefined;
      this.#connect();
    }, delay);
  }

  #clearReconnect(): void {
    if (this.#reconnectHandle === undefined) return;
    const cancel = this.options.cancelSchedule ?? ((handle) => window.clearTimeout(handle));
    cancel(this.#reconnectHandle);
    this.#reconnectHandle = undefined;
  }
}
