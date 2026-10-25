import {
  type ThreadExecutionChangedEvent,
  threadGatewayMessageSchema,
} from "@himawari-agent/gateway-contracts";
import type { ControlCenterRuntimeConfiguration } from "./gateway-client.js";
import { threadSubscriptionMessage } from "./messages.js";
import {
  type EventSourceLike,
  type EventStreamOptions,
  ReconnectingEventStream,
  threadStreamUrl,
} from "./event-stream.js";

export interface ThreadExecutionSynchronizerOptions extends EventStreamOptions {
  readonly configuration: ControlCenterRuntimeConfiguration;
  readonly threadId: string;
  readonly onConnected: () => void;
  readonly onChanged: (event: ThreadExecutionChangedEvent["payload"]) => void;
}

export class ThreadExecutionSynchronizer extends ReconnectingEventStream<ThreadExecutionSynchronizerOptions> {
  protected url(): string {
    return threadStreamUrl(
      "execution-events",
      threadSubscriptionMessage(this.options.configuration, "thread.execution_events", {
        threadId: this.options.threadId,
      }),
    );
  }

  protected override opened(): void {
    this.options.onConnected();
  }

  protected bind(source: EventSourceLike, live: () => boolean): void {
    source.addEventListener?.("thread.execution_changed", (message) => {
      if (!live()) return;
      try {
        const parsed = threadGatewayMessageSchema.parseJson(message.data);
        if (
          parsed.type === "thread.execution_changed" &&
          parsed.payload.threadId === this.options.threadId
        )
          return this.options.onChanged(parsed.payload);
      } catch {}
      this.log("CONTROL_CENTER_THREAD_EVENT_REJECTED");
    });
    source.addEventListener?.("thread.execution_unavailable", () => {
      if (live()) this.stop();
    });
  }
}
