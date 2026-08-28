import { threadGatewayMessageSchema } from "@himawari-agent/gateway-contracts";
import type { ControlCenterBrowserStorage } from "./browser-storage.js";
import type { ControlCenterRuntimeConfiguration } from "./gateway-client.js";
import { safeBrowserLog, type SafeBrowserLogEntry } from "./gateway-client.js";
import { threadSubscriptionMessage } from "./messages.js";
import type { EventSourceLike } from "./sse-synchronizer.js";

export interface ThreadSseSynchronizerOptions {
  readonly configuration: ControlCenterRuntimeConfiguration;
  readonly storage: ControlCenterBrowserStorage;
  readonly createEventSource: (url: string) => EventSourceLike;
  readonly onCommittedEvent: () => void;
  readonly onSnapshotRequired: () => void;
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
  #reconnectHandle: number | undefined;
  #attempt = 0;
  #stopped = true;

  constructor(options: ThreadSseSynchronizerOptions) {
    this.#options = options;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  reconnectNow(): void {
    if (this.#stopped) return;
    this.#source?.close();
    this.#source = undefined;
    this.#clearReconnect();
    this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#source?.close();
    this.#source = undefined;
    this.#clearReconnect();
  }

  #connect(): void {
    if (this.#stopped || this.#source) return;
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
      this.#attempt = 0;
    };
    source.onmessage = (message) => {
      try {
        const parsed = threadGatewayMessageSchema.parseJson(message.data);
        if (parsed.kind !== "event") throw new Error("CONTROL_CENTER_THREAD_EVENT_INVALID");
        this.#options.storage.saveThreadLastCursor(parsed.payload.cursor);
        this.#attempt = 0;
        this.#options.onCommittedEvent();
      } catch {
        this.#options.log(safeBrowserLog("CONTROL_CENTER_THREAD_EVENT_REJECTED"));
      }
    };
    source.addEventListener?.("thread.snapshot_required", () => {
      this.#options.storage.clearThreadLastCursor();
      this.#options.onSnapshotRequired();
    });
    source.onerror = () => {
      if (this.#source === source) this.#source = undefined;
      source.close();
      this.#scheduleReconnect();
    };
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
