import { isDeepStrictEqual } from "node:util";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type NewSessionOptions,
  convertToLlm,
  type SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

type PiMessages = AgentSession["agent"]["state"]["messages"];
type PiToolResult = Extract<PiMessages[number], { role: "toolResult" }>;

export const PI_TOOL_BATCH_VERSION = "pi-tool-batch.v3";

export interface PiToolBatchContinuation {
  readonly version: typeof PI_TOOL_BATCH_VERSION;
  readonly entries: SessionEntry[];
  readonly systemPrompt: string;
  readonly assistant: AssistantMessage;
  readonly completedResults: PiToolResult[];
  readonly waitingToolCallId: string;
  readonly completedStreamOrdinal: number;
  readonly parallel?: true;
}

type BatchSession = Pick<
  AgentSession,
  "sessionManager" | "messages" | "getActiveToolNames" | "getToolDefinition"
>;

export function capturePiToolBatch(
  session: BatchSession,
  waitingToolCallId: string,
  completedStreamOrdinal: number,
  systemPrompt: string,
): PiToolBatchContinuation {
  const messages = session.messages;
  const index = messages.findLastIndex((message) => message.role === "assistant");
  const assistant = messages[index];
  if (!assistant || assistant.role !== "assistant")
    throw new Error("PI_CONTINUATION_BATCH_INVALID");
  const branch = session.sessionManager.getBranch();
  const entryIndex = branch.findLastIndex(
    (entry) => entry.type === "message" && isDeepStrictEqual(entry.message, assistant),
  );
  if (entryIndex < 0) throw new Error("PI_CONTINUATION_BATCH_INVALID");
  const entries = branch.slice(0, entryIndex);
  if (
    modelVisible(batchSessionManager(entries, "/").buildSessionContext().messages) !==
    modelVisible(messages.slice(0, index))
  )
    throw new Error("PI_CONTINUATION_PREFIX_INVALID");
  return checkedBatch({
    version: PI_TOOL_BATCH_VERSION,
    entries,
    systemPrompt,
    assistant,
    completedResults: messages.slice(index + 1) as PiToolResult[],
    waitingToolCallId,
    completedStreamOrdinal,
    ...(runsInParallel(session, assistant) ? { parallel: true as const } : {}),
  });
}

function modelVisible(messages: PiMessages): string {
  return JSON.stringify(
    convertToLlm(messages)
      .filter((message) => message.role !== "system")
      .map(({ timestamp: _timestamp, ...message }) => message),
  );
}

function runsInParallel(session: BatchSession, assistant: AssistantMessage): boolean {
  const active = new Set(session.getActiveToolNames());
  return assistant.content
    .filter((part) => part.type === "toolCall")
    .every((call) => {
      const tool = active.has(call.name) ? session.getToolDefinition(call.name) : undefined;
      return tool !== undefined && tool.executionMode !== "sequential";
    });
}

function batchSessionManager(
  entries: readonly SessionEntry[],
  cwd: string,
  options?: NewSessionOptions,
): SessionManager {
  if (
    !Array.isArray(entries) ||
    entries.some(
      (entry) =>
        entry === null ||
        typeof entry !== "object" ||
        entry.type === ("session" as string) ||
        typeof entry.type !== "string" ||
        typeof entry.id !== "string",
    )
  )
    throw new Error("PI_CONTINUATION_PREFIX_INVALID");
  return SessionManager.inMemory(cwd, options, structuredClone([...entries]));
}

function checkedBatch(saved: PiToolBatchContinuation): PiToolBatchContinuation {
  if (saved?.version !== PI_TOOL_BATCH_VERSION) throw new Error("PI_CONTINUATION_VERSION_INVALID");
  const { assistant, waitingToolCallId, completedStreamOrdinal, completedResults } = saved;
  const parallel = saved.parallel === true;
  if (
    !Number.isSafeInteger(completedStreamOrdinal) ||
    completedStreamOrdinal < 1 ||
    typeof saved.systemPrompt !== "string" ||
    !assistant ||
    assistant.role !== "assistant" ||
    assistant.stopReason !== "toolUse" ||
    !assistant.content.some((part) => part.type === "toolCall" && part.id === waitingToolCallId)
  )
    throw new Error("PI_CONTINUATION_BATCH_INVALID");
  const calls = assistant.content.filter((part) => part.type === "toolCall");
  const waitingIndex = calls.findIndex((call) => call.id === waitingToolCallId);
  if (
    !Array.isArray(completedResults) ||
    completedResults.length !== (parallel ? 0 : waitingIndex) ||
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
  const prefix = batchSessionManager(saved.entries, "/").buildSessionContext().messages;
  const last = prefix.at(-1);
  if (!last || last.role === "assistant") throw new Error("PI_CONTINUATION_PREFIX_INVALID");
  return structuredClone({
    version: PI_TOOL_BATCH_VERSION,
    entries: saved.entries,
    systemPrompt: saved.systemPrompt,
    assistant,
    completedResults,
    waitingToolCallId,
    completedStreamOrdinal,
    ...(parallel ? { parallel: true as const } : {}),
  });
}

export function piToolBatchSessionManager(
  saved: PiToolBatchContinuation,
  systemPrompt: string,
  cwd: string,
  options?: NewSessionOptions,
): SessionManager {
  const checked = checkedBatch(saved);
  if (checked.systemPrompt !== systemPrompt)
    throw new Error("PI_CONTINUATION_SYSTEM_PROMPT_CHANGED");
  return batchSessionManager(checked.entries, cwd, options);
}

export function restorePiToolBatch(session: BatchSession, saved: PiToolBatchContinuation) {
  const checked = checkedBatch(saved);
  if (checked.parallel && !runsInParallel(session, checked.assistant))
    throw new Error("PI_CONTINUATION_PARALLEL_BATCH_INVALID");
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

export function inspectPiToolBatch(value: unknown) {
  if ((value as { version?: unknown } | null)?.version !== PI_TOOL_BATCH_VERSION) return undefined;
  const saved = checkedBatch(value as PiToolBatchContinuation);
  const waiting = saved.assistant.content.find(
    (part) => part.type === "toolCall" && part.id === saved.waitingToolCallId,
  );
  if (!waiting || waiting.type !== "toolCall") throw new Error("PI_CONTINUATION_BATCH_INVALID");
  return {
    completedStreamOrdinal: saved.completedStreamOrdinal,
    completedToolCallIds: saved.completedResults.map((result) => result.toolCallId),
    waitingToolCallId: waiting.id,
    toolName: waiting.name,
    arguments: structuredClone(waiting.arguments),
  };
}
