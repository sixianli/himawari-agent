import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";

type PiMessages = AgentSession["agent"]["state"]["messages"];

/** Stored only in a product-protected Payload; never a public trace body. */
export interface PiToolBatchContinuation {
  readonly version: "pi-tool-batch.v2";
  readonly prefix: PiMessages;
  readonly systemPrompt: string;
  readonly assistant: AssistantMessage;
  readonly completedResults: Extract<PiMessages[number], { role: "toolResult" }>[];
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
  const calls = assistant.content.filter((part) => part.type === "toolCall");
  const waitingIndex = calls.findIndex((call) => call.id === waitingToolCallId);
  const completedResults = messages.slice(index + 1);
  if (
    completedResults.length !== waitingIndex ||
    new Set(calls.map((call) => call.id)).size !== calls.length ||
    completedResults.some(
      (result, position) =>
        result.role !== "toolResult" ||
        result.toolCallId !== calls[position]?.id ||
        result.toolName !== calls[position]?.name ||
        (result.details as { productOutcome?: unknown } | undefined)?.productOutcome ===
          "result_unknown",
    )
  )
    throw new Error("PI_CONTINUATION_RESULTS_INVALID");
  const last = prefix.at(-1);
  if (!last || last.role === "assistant") throw new Error("PI_CONTINUATION_PREFIX_INVALID");
  return structuredClone({
    version: "pi-tool-batch.v2",
    systemPrompt,
    prefix,
    assistant,
    completedResults: completedResults as PiToolBatchContinuation["completedResults"],
    waitingToolCallId,
    completedStreamOrdinal,
  });
}

/**
 * Feed a previously completed model message back through Pi's tool executor.
 * This is a local replay, not a new provider call. Previously disclosed results
 * are restored as conversation state; only unfinished calls enter product execution.
 */
export function restorePiToolBatch(session: AgentSession, saved: PiToolBatchContinuation) {
  if (saved.version !== "pi-tool-batch.v2") throw new Error("PI_CONTINUATION_VERSION_INVALID");
  // Reuse capture validation, including that the waiting call belongs to this batch.
  const transcript = [...saved.prefix, saved.assistant, ...saved.completedResults];
  const checked = freezeBatch(
    transcript,
    saved.waitingToolCallId,
    saved.completedStreamOrdinal,
    saved.systemPrompt,
  );
  session.agent.state.messages = checked.prefix;
  session.agent.state.systemPrompt = checked.systemPrompt;
  let consumed = false;
  const restoredResults = new Set<string>();
  return {
    completedStreamOrdinal: checked.completedStreamOrdinal,
    completedResult(toolCallId: string, toolName: string) {
      if (restoredResults.has(toolCallId)) return undefined;
      const result = checked.completedResults.find((result) => result.toolCallId === toolCallId);
      if (result && result.toolName !== toolName)
        throw new Error("PI_CONTINUATION_RESULT_TOOL_MISMATCH");
      if (result) restoredResults.add(toolCallId);
      return result ? structuredClone(result) : undefined;
    },
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
