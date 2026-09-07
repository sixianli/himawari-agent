import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type PiMessages = AgentSession["agent"]["state"]["messages"];

/** Stored only in a product-protected Payload; never a public trace body. */
export interface PiToolBatchContinuation {
  readonly version: "pi-tool-batch.v1";
  readonly prefix: PiMessages;
  readonly systemPrompt: string;
  readonly assistant: AssistantMessage;
  readonly waitingToolCallId: string;
  readonly completedStreamOrdinal: number;
}

/** Freeze before Pi appends a synthetic abort/error result for the waiting call. */
export function capturePiToolBatch(
  session: AgentSession,
  waitingToolCallId: string,
  completedStreamOrdinal: number,
): PiToolBatchContinuation {
  return freezeBatch(
    session.agent.state.messages,
    waitingToolCallId,
    completedStreamOrdinal,
    session.agent.state.systemPrompt,
  );
}

function freezeBatch(
  messages: PiMessages,
  waitingToolCallId: string,
  completedStreamOrdinal: number,
  systemPrompt: string,
): PiToolBatchContinuation {
  const index = messages.findLastIndex((message) => message.role === "assistant");
  const assistant = messages[index];
  if (
    !Number.isSafeInteger(completedStreamOrdinal) ||
    completedStreamOrdinal < 1 ||
    !assistant ||
    assistant.role !== "assistant" ||
    assistant.stopReason !== "toolUse" ||
    !assistant.content.some((part) => part.type === "toolCall" && part.id === waitingToolCallId)
  )
    throw new Error("PI_CONTINUATION_BATCH_INVALID");
  const prefix = messages.slice(0, index);
  const last = prefix.at(-1);
  if (!last || last.role === "assistant") throw new Error("PI_CONTINUATION_PREFIX_INVALID");
  return structuredClone({
    version: "pi-tool-batch.v1",
    systemPrompt,
    prefix,
    assistant,
    waitingToolCallId,
    completedStreamOrdinal,
  });
}

/**
 * Feed a previously completed model message back through Pi's tool executor.
 * This is a local replay, not a new provider call. Product execution must replay
 * confirmed tool results and reconcile unknown effects before using this helper.
 */
export function restorePiToolBatch(session: AgentSession, saved: PiToolBatchContinuation) {
  if (saved.version !== "pi-tool-batch.v1") throw new Error("PI_CONTINUATION_VERSION_INVALID");
  // Reuse capture validation, including that the waiting call belongs to this batch.
  const transcript = [...saved.prefix, saved.assistant];
  const checked = freezeBatch(
    transcript,
    saved.waitingToolCallId,
    saved.completedStreamOrdinal,
    saved.systemPrompt,
  );
  session.agent.state.messages = checked.prefix;
  session.agent.state.systemPrompt = checked.systemPrompt;
  let consumed = false;
  return {
    completedStreamOrdinal: checked.completedStreamOrdinal,
    takeReplay() {
      if (consumed) return undefined;
      consumed = true;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: structuredClone(checked.assistant) });
      stream.push({ type: "done", reason: "toolUse", message: structuredClone(checked.assistant) });
      stream.end();
      return stream;
    },
  };
}
