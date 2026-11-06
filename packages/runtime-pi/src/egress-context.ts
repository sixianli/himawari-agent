import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
  EGRESS_PLACEHOLDER_LEGEND,
  EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE,
  type ModelEgressExchange,
  type StreamingPlaceholderRestorer,
} from "@himawari-agent/application/runtime-port";

export function withPlaceholderLegend(context: Context): Context {
  const systemPrompt =
    context.systemPrompt === undefined
      ? EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE
      : `${context.systemPrompt}\n\n${EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE}`;
  return { ...context, systemPrompt };
}

export function backgroundModelContext(prompt: string, timestamp: number): Context {
  return {
    systemPrompt: EGRESS_PLACEHOLDER_LEGEND,
    messages: [{ role: "user", content: prompt, timestamp }],
  };
}

function restoredMessage(
  message: AssistantMessage,
  text: (index: number, original: string) => string,
): AssistantMessage {
  return {
    ...message,
    content: message.content.map((block, index) =>
      block.type === "text" ? { ...block, text: text(index, block.text) } : block,
    ),
  };
}

export function restoreModelStream(
  source: AssistantMessageEventStream,
  exchange: ModelEgressExchange,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const restorers = new Map<number, StreamingPlaceholderRestorer>();
  const emitted = new Map<number, string>();
  const restorerFor = (index: number): StreamingPlaceholderRestorer => {
    let restorer = restorers.get(index);
    if (restorer === undefined) {
      restorer = exchange.streamingRestorer();
      restorers.set(index, restorer);
    }
    return restorer;
  };
  const patch = (message: AssistantMessage): AssistantMessage =>
    restoredMessage(message, (index, original) => emitted.get(index) ?? exchange.restore(original));
  const restoreEvent = (event: AssistantMessageEvent): AssistantMessageEvent | undefined => {
    switch (event.type) {
      case "text_delta": {
        const safe = restorerFor(event.contentIndex).append(event.delta);
        if (safe.length === 0 && event.delta.length > 0) return undefined;
        emitted.set(event.contentIndex, (emitted.get(event.contentIndex) ?? "") + safe);
        return { ...event, delta: safe, partial: patch(event.partial) };
      }
      case "text_end": {
        const tail = restorerFor(event.contentIndex).flush();
        emitted.set(event.contentIndex, (emitted.get(event.contentIndex) ?? "") + tail);
        if (tail.length > 0)
          output.push({
            type: "text_delta",
            contentIndex: event.contentIndex,
            delta: tail,
            partial: patch(event.partial),
          });
        return {
          ...event,
          content: emitted.get(event.contentIndex) ?? "",
          partial: patch(event.partial),
        };
      }
      case "done":
        return {
          ...event,
          message: restoredMessage(event.message, (_index, original) => exchange.restore(original)),
        };
      case "error":
        return {
          ...event,
          error: restoredMessage(event.error, (_index, original) => exchange.restore(original)),
        };
      default:
        return { ...event, partial: patch(event.partial) } as AssistantMessageEvent;
    }
  };
  void (async () => {
    try {
      for await (const event of source) {
        const restored = restoreEvent(event);
        if (restored !== undefined) output.push(restored);
      }
    } finally {
      output.end();
    }
  })().catch(() => undefined);
  return output;
}
