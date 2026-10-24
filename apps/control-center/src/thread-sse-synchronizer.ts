import { threadGatewayMessageSchema } from "@himawari-agent/gateway-contracts";
import type { ControlCenterBrowserStorage } from "./browser-storage.js";
import type { ControlCenterRuntimeConfiguration } from "./gateway-client.js";
import { threadSubscriptionMessage } from "./messages.js";
import {
  type EventSourceLike,
  type EventStreamOptions,
  ReconnectingEventStream,
  threadStreamUrl,
} from "./event-stream.js";

export interface ThreadSseSynchronizerOptions extends EventStreamOptions {
  readonly configuration: ControlCenterRuntimeConfiguration;
  readonly storage: ControlCenterBrowserStorage;
  readonly onCommittedEvent: (threadId: string) => void;
  readonly onSnapshotRequired: () => void;
}

export class ThreadSseSynchronizer extends ReconnectingEventStream<ThreadSseSynchronizerOptions> {
  protected url(): string {
    return threadStreamUrl(
      "events",
      threadSubscriptionMessage(this.options.configuration, "thread.events", {
        afterCursor: this.options.storage.readThreadLastCursor(),
      }),
    );
  }

  protected override opened(): void {
    this.options.onSnapshotRequired();
  }

  protected bind(source: EventSourceLike, live: () => boolean): void {
    source.onmessage = (message) => {
      if (!live()) return;
      try {
        const parsed = threadGatewayMessageSchema.parseJson(message.data);
        if (parsed.type === "thread.event") {
          const previous = this.options.storage.readThreadLastCursor();
          const ordinal = (cursor: string | null) => Number(cursor?.match(/:(\d+)$/)?.[1] ?? -1);
          if (
            previous === parsed.payload.cursor ||
            ordinal(previous) >= ordinal(parsed.payload.cursor)
          )
            return;
          this.options.storage.saveThreadLastCursor(parsed.payload.cursor);
          this.resetBackoff();
          return this.options.onCommittedEvent(parsed.payload.threadId);
        }
      } catch {}
      this.log("CONTROL_CENTER_THREAD_EVENT_REJECTED");
    };
    source.addEventListener?.("thread.snapshot_required", () => {
      if (!live()) return;
      this.options.storage.clearThreadLastCursor();
      this.options.onSnapshotRequired();
    });
  }
}
