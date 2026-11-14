import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
  Tool,
  ToolResultMessage,
  TranscriptContext,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  createAssistantMessageEventStream,
  createInitialSystemMessage,
  getCurrentTools,
  getSupportedThinkingLevels,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import {
  type AgentSession,
  type AgentSessionEvent,
  type ContextWithSystemEvent,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentRuntimePort,
  DataClassification,
  ModelDescriptor,
  ModelEgress,
  ModelInvocationAdmissionResolver,
  ModelInvocationPermit,
  ModelInvocationPricing,
  ModelInvocationUsage,
  ModelUsageStorePort,
  RuntimeApprovalWait,
  RuntimeBackgroundCommandNotice,
  RuntimeContinuationPort,
  RuntimeEvent,
  RuntimeProjection,
  RuntimeProjectionContent,
  RuntimeProjectionMessage,
  RuntimeProjectionPort,
  RuntimePromptBundlePort,
  RuntimeRequest,
  RuntimeToolDescriptor,
  RuntimeToolInvocation,
  RuntimeToolPort,
} from "@himawari-agent/application/runtime-port";
import {
  highestClassification,
  isModelVisible,
  memoryDateNote,
} from "@himawari-agent/application/runtime-port";
import {
  CHAT_TOOL_GUIDELINES_HEADER,
  CHAT_TOOL_LOOP_REJECTED,
  CHAT_TOOL_LOOP_STOPPED,
  CHAT_TOOL_SNIPPETS_HEADER,
  CHAT_TURN_ABORTED,
  CHAT_TURN_CONTEXT_PREFACE,
  CHAT_TURN_TIME,
  renderPrompt,
  TOOL_POLICY_BLOCKED_FILE_AUTHORIZATION,
  TOOL_POLICY_BLOCKED_FILE_REQUEST,
  TOOL_POLICY_BLOCKED_HANDLE,
  TOOL_POLICY_BLOCKED_MEMORY_RECALL,
  TOOL_POLICY_BLOCKED_OTHER,
  TOOL_POLICY_BLOCKED_REMINDER,
  TOOL_POLICY_BLOCKED_TASK_MANAGEMENT,
} from "@himawari-agent/prompt-catalog";
import {
  isSensitiveFieldName,
  isSensitiveQueryParameter,
  redactMachineSecrets,
} from "@himawari-agent/sensitive-capture";
import { observeCacheFields } from "./cache-usage-observation.js";
import {
  compactionPrefixMessages,
  sharedSummaryContext,
  sharedSummaryOptions,
  compactionModelOverrides,
} from "./compaction-prefix.js";
import { restoreModelStream, withPlaceholderLegend } from "./egress-context.js";
import { gatewayPayload, observeGatewayFetch } from "./gateway-observation.js";
import {
  observeProviderRejections,
  type ProviderRejection,
} from "./provider-rejection-observation.js";
import { createGovernedPiCodingTools } from "./governed-coding-tools.js";
import { createPiOperationsFromGovernedHostPort } from "./governed-host-operations.js";
import { himawariBuiltinToolText } from "./pi-builtin-tool-text.js";
import { nativeHistoryMessages } from "./pi-native-history.js";
import {
  capturePiToolBatch,
  type PiToolBatchContinuation,
  piToolBatchSessionManager,
  restorePiToolBatch,
} from "./pi-tool-batch-continuation.js";
import { PiToolProgressGuard, type PiToolProgressState } from "./pi-tool-progress-guard.js";
import {
  contextBlockMarker,
  runtimeEnvironmentAfterCompaction,
  splitRuntimeEnvironment,
} from "./runtime-environment-block.js";

function previousFileConflict(
  messages: AgentSession["agent"]["state"]["messages"],
  runId: string,
  target: unknown,
): string | undefined {
  if (typeof target !== "string") return undefined;
  const calls = new Map<string, string>();
  let previous: string | undefined;
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content)
        if (
          part.type === "toolCall" &&
          ["write", "edit"].includes(part.name) &&
          typeof part.arguments["path"] === "string"
        )
          calls.set(part.id, part.arguments["path"]);
    } else if (message.role === "toolResult" && calls.get(message.toolCallId) === target) {
      const details = message.details as
        | {
            productRunId?: unknown;
            productOutcome?: unknown;
            errorCode?: unknown;
          }
        | undefined;
      if (details?.productRunId !== runId) continue;
      previous =
        details.productOutcome === "failed" && details.errorCode === "FILE_VERSION_CONFLICT"
          ? message.toolCallId
          : undefined;
    }
  }
  return previous;
}

type RuntimeTurnId = Extract<RuntimeEvent, { readonly type: "runtime.turn_completed" }>["turnId"];
type PiStreamFunction = (
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;

export interface PiModelBinding {
  readonly model: Model<Api>;
  readonly modelRuntime: ModelRuntime;
  readonly descriptor?: ModelDescriptor;
  readonly admissionCost?: {
    readonly pricing: ModelInvocationPricing;
    readonly estimatedCostMicros: number;
  };
  readonly resolveSecret?: () => Promise<string>;
}

export interface PiModelBindingPort {
  resolve(modelRef: string): Promise<PiModelBinding>;
}

export interface AuthorizedPiResources {
  readonly extensionPaths: readonly string[];
  readonly skillPaths: readonly string[];
  readonly promptTemplatePaths: readonly string[];
}

export interface PiRuntimeResourcePort {
  resolveAuthorized(
    runId: RuntimeRequest["runId"],
    capabilityHandleRefs: readonly string[],
  ): Promise<AuthorizedPiResources>;
}

export interface PiAgentRuntimeAdapterDependencies {
  readonly egress: ModelEgress;
  readonly projection: RuntimeProjectionPort;
  readonly promptBundles?: RuntimePromptBundlePort;
  readonly onHandleTools?: (
    request: RuntimeRequest,
    observation: { readonly generation: number | null; readonly handleTools: number },
  ) => void;
  readonly continuations?: RuntimeContinuationPort;
  readonly tools: RuntimeToolPort;
  readonly models: PiModelBindingPort;
  readonly resources?: PiRuntimeResourcePort;
  readonly cwd: string;
  readonly agentDir?: string;
  readonly timeZone?: string;
  readonly now?: () => string;
  readonly admission?: ModelInvocationAdmissionResolver;
  readonly logicalSlot: (request: RuntimeRequest, ordinal: number) => string;
  readonly turnId?: (request: RuntimeRequest, turnIndex: number) => RuntimeTurnId;
  readonly createSession?: (
    options: CreateAgentSessionOptions,
  ) => Promise<CreateAgentSessionResult>;
  readonly measure?: <T>(runId: string, name: string, work: () => Promise<T>) => Promise<T>;
  readonly onToolCallStarted?: (request: RuntimeRequest, toolName: string) => void;
  readonly onAssistantText?: (
    request: RuntimeRequest,
    message: { readonly timestamp: unknown; readonly text: string },
  ) => void;
  readonly onModelAdmissionFailed?: (
    request: RuntimeRequest,
    failure: { readonly code: string; readonly reason: string | null },
  ) => void;
  readonly onCompactionSummaryRequest?: (
    request: RuntimeRequest,
    summary: { readonly sharedHead: boolean },
  ) => void;
  readonly onModelStreamFailed?: (
    request: RuntimeRequest,
    failure: { readonly code: string; readonly message: string },
  ) => void;
  readonly onModelRequestRejected?: (request: RuntimeRequest, rejection: ProviderRejection) => void;
  readonly usage?: {
    readonly store: ModelUsageStorePort;
    readonly onFailure: (error: unknown) => void;
  };
}

const KNOWN_IGNORED_EVENTS = new Set([
  "agent_end",
  "queue_update",
  "compaction_start",
  "entry_appended",
  "session_info_changed",
  "thinking_level_changed",
  "auto_retry_start",
  "auto_retry_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
  "bash_execution_update",
  "tool_execution_update",
]);

const contentBoundaries = {
  thinking_start: { field: "thinkingBoundary", value: { phase: "started" } },
  thinking_end: { field: "thinkingBoundary", value: { phase: "ended" } },
  text_start: { field: "outputBoundary", value: { kind: "text" } },
  toolcall_start: { field: "outputBoundary", value: { kind: "toolCall" } },
} as const;

function argumentLines(value: unknown): number {
  if (typeof value === "string") return value.length ? value.split("\n").length : 0;
  if (value === null || typeof value !== "object") return 0;
  return Object.entries(value).reduce(
    (total, [key, entry]) => total + (key === "path" ? 0 : argumentLines(entry)),
    0,
  );
}

function withToolCallProgress<T extends { readonly role: string }>(message: T): T {
  if (message.role !== "assistant") return message;
  const assistant = message as unknown as AssistantMessage;
  return {
    ...message,
    content: assistant.content.map((block) => {
      if (block.type !== "toolCall") return block;
      const partial = (block as { readonly partialArgs?: unknown }).partialArgs;
      const path = block.arguments?.["path"];
      return {
        type: "toolCall",
        id: block.id,
        name: block.name,
        arguments: typeof path === "string" ? { path } : {},
        streaming: {
          characters:
            typeof partial === "string"
              ? partial.length
              : JSON.stringify(block.arguments ?? {}).length,
          lines: argumentLines(block.arguments),
        },
      };
    }),
  };
}

function contentBoundary(
  event: { readonly type: string; readonly contentIndex?: number } | undefined,
): Record<string, unknown> {
  if (!event || !Object.hasOwn(contentBoundaries, event.type)) return {};
  const boundary = contentBoundaries[event.type as keyof typeof contentBoundaries];
  return {
    [boundary.field]: { ...boundary.value, contentIndex: event.contentIndex ?? 0 },
  };
}

const EMPTY_RESOURCES: AuthorizedPiResources = Object.freeze({
  extensionPaths: Object.freeze([]),
  skillPaths: Object.freeze([]),
  promptTemplatePaths: Object.freeze([]),
});

function safeArguments(value: unknown): RuntimeToolInvocation["arguments"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as RuntimeToolInvocation["arguments"];
}

function sameExecutionLeaseClaim(
  left: RuntimeRequest["executionLease"],
  right: RuntimeRequest["executionLease"],
): boolean {
  return (
    left.executionLeaseId === right.executionLeaseId &&
    left.expectedLeaseRevision === right.expectedLeaseRevision &&
    left.authorityLeaseId === right.authorityLeaseId &&
    left.authorityFencingToken === right.authorityFencingToken &&
    left.deploymentId === right.deploymentId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.fencingToken === right.fencingToken &&
    left.consumerId === right.consumerId
  );
}

const SERVED_MODEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._:-]{0,94}$/i;

export function servedModelFromHeaders(
  headers: Readonly<Record<string, string>>,
): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === "x-magpie-model" && SERVED_MODEL_PATTERN.test(value.trim()))
      return value.trim();
  }
  return undefined;
}

function redactObservation(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      for (const key of [...url.searchParams.keys()]) {
        if (isSensitiveQueryParameter(key)) {
          url.searchParams.set(key, "[REDACTED]");
        }
      }
      return redactMachineSecrets(url.toString());
    } catch {
      return redactMachineSecrets(value);
    }
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[REDACTED_CYCLE]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactObservation(entry, seen));

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSensitiveFieldName(key) ? "[REDACTED]" : redactObservation(entry, seen);
  }
  return result;
}

function runtimeFailure(request: RuntimeRequest, now: string, errorCode: string): RuntimeEvent {
  return { type: "runtime.failed", runId: request.runId, errorCode, occurredAt: now };
}

function toolProgressOutput(
  descriptor: RuntimeToolDescriptor | undefined,
  content: unknown,
): unknown {
  if (descriptor?.definition !== "builtin-coding" && descriptor?.definition !== "builtin-read")
    return content;
  if (!Array.isArray(content) || content.length !== 1) return content;
  const part = content[0];
  if (!part || part.type !== "text" || typeof part.text !== "string") return content;
  try {
    const result = JSON.parse(part.text);
    if (
      !result ||
      result.schemaVersion !== "pi-result.v1" ||
      result.tool !== descriptor.name ||
      !Array.isArray(result.content) ||
      typeof result.isError !== "boolean" ||
      !result.source ||
      typeof result.source.toolCallId !== "string" ||
      result.source.toolCallId.length === 0
    )
      return content;
    const { toolCallId: _invocationId, ...source } = result.source;
    return { ...result, source };
  } catch {
    return content;
  }
}

const PI_CONTEXT_WINDOW_EXHAUSTED = "PI_CONTEXT_WINDOW_EXHAUSTED";
const PI_REQUEST_HEAD_DIVERGED = "PI_REQUEST_HEAD_DIVERGED";
const MIN_CONTEXT_ANSWER_TOKENS = 512;
const BACKGROUND_COMMAND_MESSAGE_TYPE = "himawari.background.command";

const POLICY_BLOCKED_TEXT: Readonly<Record<string, string>> = {
  TASK_RESOURCE_AUTHORITY_REQUIRED: TOOL_POLICY_BLOCKED_TASK_MANAGEMENT.text,
  REMINDER_OWNER_SCOPE: TOOL_POLICY_BLOCKED_REMINDER.text,
  MEMORY_RECALL_OWNER_SCOPE: TOOL_POLICY_BLOCKED_MEMORY_RECALL.text,
  FILE_READ_REQUEST_INVALID: TOOL_POLICY_BLOCKED_FILE_REQUEST.text,
  FILE_READ_AUTHORIZATION_UNAVAILABLE: TOOL_POLICY_BLOCKED_FILE_AUTHORIZATION.text,
  GOVERNED_HANDLE_INVALID: TOOL_POLICY_BLOCKED_HANDLE.text,
};

function policyBlockedText(reasonCode: string): string {
  return Object.hasOwn(POLICY_BLOCKED_TEXT, reasonCode)
    ? (POLICY_BLOCKED_TEXT[reasonCode] as string)
    : TOOL_POLICY_BLOCKED_OTHER.text;
}

const TOOL_LOOP_STOPPED_MESSAGE_TYPE = "himawari.tool-loop.stopped";

function toolLoopStoppedMessage() {
  return {
    customType: TOOL_LOOP_STOPPED_MESSAGE_TYPE,
    content: CHAT_TOOL_LOOP_STOPPED.text,
    display: false,
    details: {},
  };
}

function backgroundCommandMessage(notice: RuntimeBackgroundCommandNotice) {
  return {
    customType: BACKGROUND_COMMAND_MESSAGE_TYPE,
    content: notice.modelContent,
    display: false,
    details: { taskRef: notice.taskRef },
  };
}

const MODEL_REQUEST_MAX_RETRIES = 2;
const MODEL_REQUEST_MAX_RETRY_DELAY_MS = 10_000;

function providerStatusOf(errorMessage: string | undefined): string | undefined {
  const message = errorMessage ?? "";
  return (
    /^(\d{3})(?:\s|:)/.exec(message)?.[1] ??
    /^Server requested \d+s retry delay \(max: \d+s\)\. (\d{3})(?:\s|:)/.exec(message)?.[1]
  );
}

function modelFailureCode(errorMessage: string | undefined): string {
  if (errorMessage === PI_CONTEXT_WINDOW_EXHAUSTED) return PI_CONTEXT_WINDOW_EXHAUSTED;
  const status = providerStatusOf(errorMessage);
  if (status === "429") return "PI_MODEL_RATE_LIMITED";
  if (status === "402") return "PI_MODEL_QUOTA_EXCEEDED";
  if (status === "401" || status === "403") return "PI_MODEL_AUTH_FAILED";
  if (status !== undefined && Number(status) >= 500 && Number(status) <= 599)
    return "PI_MODEL_UNAVAILABLE";
  return "PI_MODEL_ERROR";
}

function loggableModelFailure(errorMessage: string | undefined): string {
  const message = errorMessage ?? "";
  if (
    message.startsWith("Model invocation ") ||
    message === "Model budget accounting is unavailable" ||
    message === PI_REQUEST_HEAD_DIVERGED
  )
    return message;
  const status = providerStatusOf(message);
  return status === undefined ? "provider_message_withheld" : `provider_status_${status}`;
}

function epoch(occurredAt: string): number {
  const timestamp = Date.parse(occurredAt);
  if (!Number.isFinite(timestamp)) throw new TypeError("RUNTIME_PROJECTION_INVALID_TIMESTAMP");
  return timestamp;
}

function textContent(
  content: readonly RuntimeProjectionContent[],
): Extract<RuntimeProjectionContent, { readonly type: "text" }>[] {
  return content.filter(
    (item): item is Extract<RuntimeProjectionContent, { readonly type: "text" }> =>
      item.type === "text",
  );
}

function projectedMessage(message: RuntimeProjectionMessage, model: Model<Api>): Message {
  const timestamp = epoch(message.occurredAt);
  if (message.role === "user") {
    if (message.content.some((item) => item.type !== "text")) {
      throw new TypeError("RUNTIME_PROJECTION_INVALID_USER_CONTENT");
    }
    const projected: UserMessage = {
      role: "user",
      content: textContent(message.content).map(({ text }) => ({ type: "text", text })),
      timestamp,
    };
    return projected;
  }
  if (message.role === "tool_result") {
    const projected: ToolResultMessage = {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content.map(({ text }) => ({ type: "text", text })),
      isError: message.isError,
      timestamp,
    };
    return projected;
  }
  const projected: AssistantMessage = {
    role: "assistant",
    content: message.content.map((item) =>
      item.type === "text"
        ? { type: "text" as const, text: item.text }
        : {
            type: "toolCall" as const,
            id: item.id,
            name: item.name,
            arguments: structuredClone(item.arguments),
          },
    ),
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: message.stopReason ?? "stop",
    timestamp,
  };
  return projected;
}

type PiToolDefinitionText = Pick<
  ToolDefinition,
  | "name"
  | "label"
  | "description"
  | "parameters"
  | "promptSnippet"
  | "promptGuidelines"
  | "constrainedSampling"
>;

function frozenToolText(definition: PiToolDefinitionText) {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.promptSnippet === undefined ? {} : { promptSnippet: definition.promptSnippet }),
    ...(definition.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: definition.promptGuidelines }),
    ...(definition.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: definition.constrainedSampling }),
  };
}

function providerTool(
  definition: Pick<Tool, "name" | "description" | "parameters" | "constrainedSampling">,
): Tool {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.constrainedSampling === undefined
      ? {}
      : { constrainedSampling: definition.constrainedSampling }),
  };
}

function isHandleTool(descriptor: RuntimeToolDescriptor): boolean {
  return (
    descriptor.capabilityHandleRef !== null ||
    ("handleBound" in descriptor && descriptor.handleBound === true)
  );
}

function productSystemPrompt(
  systemInstruction: string,
  tools: readonly PiToolDefinitionText[],
): string {
  const snippets = tools.flatMap(({ name, promptSnippet }) =>
    promptSnippet ? [`- ${name}: ${promptSnippet}`] : [],
  );
  const guidelines = [
    ...new Set(
      tools.flatMap(({ promptGuidelines }) =>
        (promptGuidelines ?? []).map((guideline) => guideline.trim()).filter(Boolean),
      ),
    ),
  ];
  return [
    systemInstruction,
    ...(snippets.length > 0 ? [[CHAT_TOOL_SNIPPETS_HEADER.text, ...snippets].join("\n")] : []),
    ...(guidelines.length > 0
      ? [
          [
            CHAT_TOOL_GUIDELINES_HEADER.text,
            ...guidelines.map((guideline) => `- ${guideline}`),
          ].join("\n"),
        ]
      : []),
  ].join("\n\n");
}

function localTime(occurredAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset",
  }).format(new Date(occurredAt));
}

function localWeekday(occurredAt: string, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(
    new Date(occurredAt),
  );
}

function turnPrompt(projection: RuntimeProjection, timeZone: string): string {
  const { blocks, environment } = splitRuntimeEnvironment(projection);
  return [
    "<himawari-context>",
    CHAT_TURN_CONTEXT_PREFACE.text,
    renderPrompt(CHAT_TURN_TIME, {
      occurredAt: projection.prompt.occurredAt,
      timeZone,
      localTime: localTime(projection.prompt.occurredAt, timeZone),
      weekday: localWeekday(projection.prompt.occurredAt, timeZone),
    }),
    ...blocks.map((block) => contextBlockContent(block, timeZone)),
    ...(environment ? [contextBlockContent(environment, timeZone)] : []),
    "</himawari-context>",
    "",
    "<owner-message>",
    projection.prompt.content,
    "</owner-message>",
  ].join("\n");
}

function contextBlockContent(
  block: RuntimeProjection["contextBlocks"][number],
  timeZone: string,
): string {
  const dated = block.dates ? memoryDateNote(block.dates, timeZone) : "";
  return `${contextBlockMarker(block)}\n${block.content}${dated}`;
}

function frozenRequestTools(
  messages: ContextWithSystemEvent["messages"],
  frozenTools: Tool[] | undefined,
): Tool[] | undefined {
  const piTools = getCurrentTools(messages);
  const tools = frozenTools ?? piTools.map(providerTool);
  const declared = new Set(tools.map(({ name }) => name));
  if (piTools.length !== declared.size || piTools.some(({ name }) => !declared.has(name)))
    return undefined;
  return tools;
}

function himawariRequestHead(
  messages: ContextWithSystemEvent["messages"],
  systemPrompt: string,
  frozenTools: Tool[] | undefined,
): ContextWithSystemEvent["messages"] | undefined {
  const tools = frozenRequestTools(messages, frozenTools);
  if (!tools) return undefined;
  const head = createInitialSystemMessage(systemPrompt, tools);
  return [...(head ? [head] : []), ...messages.filter((message) => message.role !== "system")];
}

function himawariRequestContext(
  requested: TranscriptContext,
  systemPrompt: string,
  frozenTools: Tool[] | undefined,
): Context | undefined {
  const tools = frozenTools ?? getCurrentTools(requested.messages).map(providerTool);
  const head = createInitialSystemMessage(systemPrompt, tools);
  const [first, ...rest] = requested.messages;
  if (!head || !isDeepStrictEqual(first, head)) return undefined;
  if (rest.some((message) => message.role === "system")) return undefined;
  return { systemPrompt, tools, messages: rest };
}

function himawariSummaryContext(requested: TranscriptContext): Context | undefined {
  if (getCurrentTools(requested.messages).length > 0) return undefined;
  const [first, ...rest] = requested.messages;
  if (first?.role !== "system" || typeof first.content !== "string") return undefined;
  return {
    systemPrompt: first.content,
    tools: [],
    messages: rest.filter((message) => message.role !== "system"),
  };
}

function piSessionId(request: RuntimeRequest): string {
  return `himawari-${createHash("sha256")
    .update(
      JSON.stringify([
        "pi-session.v1",
        request.ownerId,
        request.agentId,
        request.sessionId,
        request.threadId,
      ]),
    )
    .digest("hex")}`;
}

function prehydrateSession(
  request: RuntimeRequest,
  projection: RuntimeProjection,
  model: Model<Api>,
  cwd: string,
): SessionManager {
  const sessionManager = SessionManager.inMemory(cwd, { id: piSessionId(request) });
  if (projection.nativeHistory) {
    for (const message of nativeHistoryMessages(projection.nativeHistory.messages))
      sessionManager.appendMessage(message);
  }
  if (projection.interruptedRunId)
    sessionManager.appendCustomMessageEntry("himawari.turn_aborted", CHAT_TURN_ABORTED.text, false);
  const piEntryByProductMessage = new Map<string, string>();
  for (const message of projection.history) {
    if (piEntryByProductMessage.has(message.id)) {
      throw new TypeError("RUNTIME_PROJECTION_DUPLICATE_MESSAGE_ID");
    }
    piEntryByProductMessage.set(
      message.id,
      sessionManager.appendMessage(projectedMessage(message, model)),
    );
  }
  if (projection.compaction !== undefined) {
    const firstKeptEntryId = piEntryByProductMessage.get(projection.compaction.firstKeptMessageId);
    if (firstKeptEntryId === undefined) {
      throw new TypeError("RUNTIME_PROJECTION_COMPACTION_ENTRY_NOT_FOUND");
    }
    if (
      !Number.isSafeInteger(projection.compaction.tokensBefore) ||
      projection.compaction.tokensBefore < 0
    ) {
      throw new TypeError("RUNTIME_PROJECTION_INVALID_TOKEN_COUNT");
    }
    sessionManager.appendCompaction(
      projection.compaction.summary,
      firstKeptEntryId,
      projection.compaction.tokensBefore,
      { source: "himawari-product-checkpoint" },
      true,
    );
  }
  return sessionManager;
}

function authorizedPaths(paths: readonly string[], field: string): string[] {
  if (paths.some((path) => typeof path !== "string" || path.trim().length === 0)) {
    throw new TypeError(`${field} must contain non-empty paths`);
  }
  if (new Set(paths).size !== paths.length) {
    throw new TypeError(`${field} must not contain duplicate paths`);
  }
  return [...paths];
}

function safePiUsage(message: AssistantMessage): ModelInvocationUsage | undefined {
  const usage = message.usage;
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  const outputTokens = usage.output;
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    !Number.isSafeInteger(usage.input) ||
    usage.input < 0 ||
    !Number.isSafeInteger(usage.cacheRead) ||
    usage.cacheRead < 0 ||
    !Number.isSafeInteger(usage.cacheWrite) ||
    usage.cacheWrite < 0
  ) {
    return undefined;
  }
  return Object.freeze({
    inputTokens,
    outputTokens,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
  });
}

function piErrorEvent(
  model: Model<Api>,
  errorMessage: string,
): Extract<AssistantMessageEvent, { readonly type: "error" }> {
  const error: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
  return { type: "error", reason: "error", error };
}

function admissionFailure(error: unknown): {
  readonly code: string;
  readonly reason: string | null;
} {
  const code =
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,127}$/.test(error.code)
      ? error.code
      : error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.message)
        ? error.message
        : "MODEL_ADMISSION_UNEXPECTED";
  const reason =
    code.startsWith("PORT_") && error instanceof Error ? error.message.slice(0, 160) : null;
  return { code, reason };
}

function failedPiStream(model: Model<Api>, errorMessage: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push(piErrorEvent(model, errorMessage));
  return stream;
}

function deferredPiStream(
  model: Model<Api>,
  start: () => Promise<AssistantMessageEventStream>,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  void (async () => {
    try {
      for await (const event of await start()) output.push(event);
    } catch {
      output.push(piErrorEvent(model, "Model request failed"));
    } finally {
      output.end();
    }
  })().catch(() => undefined);
  return output;
}

function governedModelRuntime(
  target: ModelRuntime,
  govern: (
    model: Model<Api>,
    context: TranscriptContext,
    options: SimpleStreamOptions | undefined,
    forward: PiStreamFunction,
  ) => Promise<AssistantMessageEventStream>,
): ModelRuntime {
  const forward: PiStreamFunction = (model, context, options) =>
    target.streamSimple(model, context, options);
  return new Proxy(target, {
    get(runtime, property) {
      if (property === "streamSimple")
        return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) =>
          deferredPiStream(model, () => govern(model, context, options, forward));
      const value = Reflect.get(runtime, property, runtime);
      return typeof value === "function" ? value.bind(runtime) : value;
    },
  });
}

function relayAdmittedPiStream(
  stream: AssistantMessageEventStream,
  permit: ModelInvocationPermit,
  model: Model<Api>,
  signal: AbortSignal | undefined,
  gateway: ReturnType<typeof observeGatewayFetch> | undefined,
  recordUsage: (usage: ModelInvocationUsage, cacheReported: boolean) => Promise<void>,
  cacheReported: () => Promise<boolean>,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  let accounted = false;
  const markUnknown = async (
    reasonCode: "provider_unresolved" | "transport_unresolved" | "cancel_unresolved",
  ): Promise<boolean> => {
    if (accounted) return true;
    try {
      await permit.markUnknown(reasonCode);
      accounted = true;
      return true;
    } catch {
      return false;
    }
  };
  void (async () => {
    try {
      for await (const event of stream) {
        if (event.type === "done") {
          let usage = safePiUsage(event.message);
          if (gateway !== undefined && usage !== undefined) {
            const observation = await gateway.result();
            if (signal?.aborted || observation.status !== "verified") {
              const accountedUnknown = await markUnknown(
                signal?.aborted ? "cancel_unresolved" : "provider_unresolved",
              );
              output.push(
                piErrorEvent(
                  model,
                  accountedUnknown
                    ? "Model provider billing is unavailable"
                    : "Model budget accounting is unavailable",
                ),
              );
              return;
            }
            usage = { ...usage, reportedCostMicros: observation.billing.costMicros };
          }
          if (usage === undefined) {
            const accountedUnknown = await markUnknown("provider_unresolved");
            output.push(
              piErrorEvent(
                model,
                accountedUnknown
                  ? "Model provider usage is unavailable"
                  : "Model budget accounting is unavailable",
              ),
            );
          } else {
            try {
              await permit.settle(usage);
              accounted = true;
              await recordUsage(usage, await cacheReported());
              output.push(event);
            } catch {
              const accountedUnknown = await markUnknown("transport_unresolved");
              output.push(
                piErrorEvent(
                  model,
                  accountedUnknown
                    ? "Model budget settlement failed"
                    : "Model budget accounting is unavailable",
                ),
              );
            }
          }
          return;
        }
        if (event.type === "error") {
          const accountedUnknown = await markUnknown(
            signal?.aborted ? "cancel_unresolved" : "provider_unresolved",
          );
          output.push(
            accountedUnknown
              ? event
              : piErrorEvent(model, "Model budget accounting is unavailable"),
          );
          return;
        }
        output.push(event);
      }
      const accountedUnknown = await markUnknown(
        signal?.aborted ? "cancel_unresolved" : "transport_unresolved",
      );
      output.push(
        piErrorEvent(
          model,
          accountedUnknown
            ? "Model provider stream ended without a terminal event"
            : "Model budget accounting is unavailable",
        ),
      );
    } catch {
      const accountedUnknown = await markUnknown(
        signal?.aborted ? "cancel_unresolved" : "transport_unresolved",
      );
      output.push(
        accountedUnknown
          ? piErrorEvent(model, "Model provider stream failed")
          : piErrorEvent(model, "Model budget accounting is unavailable"),
      );
    } finally {
      output.end();
    }
  })().catch(() => undefined);
  return output;
}

async function admitPiStream(
  request: RuntimeRequest,
  binding: PiModelBinding,
  resolver: ModelInvocationAdmissionResolver | undefined,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  ordinal: number,
  original: PiStreamFunction,
  logicalSlotFor: (request: RuntimeRequest, ordinal: number) => string,
  egress: ModelEgress,
  onAdmissionFailed?: PiAgentRuntimeAdapterDependencies["onModelAdmissionFailed"],
  usageRecording?: PiAgentRuntimeAdapterDependencies["usage"],
  redactionRuleset?: number,
  usagePurpose: "chat" | "other" = "chat",
  onRequestRejected?: PiAgentRuntimeAdapterDependencies["onModelRequestRejected"],
): Promise<AssistantMessageEventStream> {
  let permit: ModelInvocationPermit | undefined;
  let started = false;
  let releaseAttempted = false;
  let reservationReleased = false;
  const releaseBeforeStart = async (): Promise<boolean> => {
    if (started || permit === undefined) return true;
    if (releaseAttempted) return reservationReleased;
    releaseAttempted = true;
    try {
      await permit.releaseReserved();
      reservationReleased = true;
    } catch {
      await permit.markUnknown("transport_unresolved").catch(() => undefined);
    }
    return reservationReleased;
  };
  try {
    const desiredMaxTokens = options?.maxTokens ?? model.maxTokens;
    const transcript = normalizeContext(withPlaceholderLegend(context));
    if (
      clampMaxTokensToContext(model, transcript, desiredMaxTokens) <
      Math.min(desiredMaxTokens, MIN_CONTEXT_ANSWER_TOKENS)
    )
      return failedPiStream(model, PI_CONTEXT_WINDOW_EXHAUSTED);
    const gate = await resolver?.({
      ownerId: request.ownerId,
      agentId: request.agentId,
      runId: request.runId,
      executionLease: request.executionLease,
    });
    if (
      !gate ||
      gate.context.ownerId !== request.ownerId ||
      gate.context.agentId !== request.agentId ||
      gate.context.runId !== request.runId ||
      !Object.isFrozen(request.executionLease) ||
      !Object.isFrozen(gate.context.executionLease) ||
      !sameExecutionLeaseClaim(gate.context.executionLease, request.executionLease) ||
      binding.descriptor === undefined ||
      binding.admissionCost === undefined ||
      (binding.descriptor.secretRequirement !== null && binding.resolveSecret === undefined)
    ) {
      return failedPiStream(model, "Model invocation admission is unavailable");
    }
    if (model !== binding.model) {
      return failedPiStream(model, "Model invocation binding mismatch");
    }
    const isGateway = binding.descriptor.provider === "vercel-ai-gateway";
    if (
      isGateway &&
      (binding.descriptor.providerRouting === undefined ||
        (options?.maxTokens !== undefined &&
          (!Number.isSafeInteger(options.maxTokens) ||
            options.maxTokens < 1 ||
            options.maxTokens > Math.min(model.maxTokens, 32768))))
    )
      return failedPiStream(model, "Model invocation gateway options are invalid");
    const logicalSlot = logicalSlotFor(request, ordinal);
    if (typeof logicalSlot !== "string" || logicalSlot.trim().length === 0) {
      return failedPiStream(model, "Model invocation logical slot is unavailable");
    }
    const admission = await gate.begin({
      modelRef: binding.descriptor.ref,
      provider: binding.descriptor.provider,
      model: binding.descriptor.model,
      modelVersion: binding.descriptor.version,
      dataClassification: request.dataClassification,
      logicalSlot,
      source: "agent-stream",
      ordinal,
      estimatedCostMicros: binding.admissionCost.estimatedCostMicros,
      pricing: binding.admissionCost.pricing,
    });
    if (admission.disposition !== "fresh") {
      return failedPiStream(
        model,
        admission.disposition === "replay"
          ? "Model invocation reconciliation is required"
          : "Model invocation admission was blocked",
      );
    }
    permit = admission.permit;
    await permit.assertActive();
    if (options?.signal?.aborted) {
      const released = await releaseBeforeStart();
      return failedPiStream(
        model,
        released ? "Model invocation was cancelled" : "Model budget accounting is unavailable",
      );
    }
    const withoutAmbientApiKey: SimpleStreamOptions = { ...options };
    delete withoutAmbientApiKey.apiKey;
    const exchange = egress.exchange({
      ownerId: request.ownerId,
      agentId: request.agentId,
      threadId: request.threadId,
      source: "chat",
      purpose: "chat",
      ...(redactionRuleset === undefined ? {} : { redactionRuleset }),
    });
    const cacheFields = observeCacheFields(
      observeProviderRejections(
        exchange.wrapFetch(options?.fetch ?? globalThis.fetch),
        onRequestRejected === undefined
          ? undefined
          : (rejection) => onRequestRejected(request, rejection),
      ),
    );
    withoutAmbientApiKey.fetch = cacheFields.fetch;
    const gateway = isGateway ? observeGatewayFetch(cacheFields.fetch, model.id) : undefined;
    if (gateway !== undefined) {
      withoutAmbientApiKey.fetch = gateway.fetch;
      withoutAmbientApiKey.onPayload = async (payload, chosenModel) => {
        const replacement = await options?.onPayload?.(payload, chosenModel);
        return gatewayPayload(
          replacement === undefined ? payload : replacement,
          binding.descriptor?.providerRouting,
        );
      };
    }
    const secret = binding.resolveSecret ? await binding.resolveSecret() : undefined;
    await permit.assertActive();
    if (options?.signal?.aborted) {
      const released = await releaseBeforeStart();
      return failedPiStream(
        model,
        released ? "Model invocation was cancelled" : "Model budget accounting is unavailable",
      );
    }
    await permit.markStarted();
    started = true;
    if (options?.signal?.aborted) {
      await permit.markUnknown("cancel_unresolved");
      return failedPiStream(model, "Model invocation was cancelled");
    }
    const stream = restoreModelStream(
      await original(model, transcript, {
        ...withoutAmbientApiKey,
        ...(secret === undefined ? {} : { apiKey: secret }),
        maxRetries: MODEL_REQUEST_MAX_RETRIES,
        maxRetryDelayMs: MODEL_REQUEST_MAX_RETRY_DELAY_MS,
      }),
      exchange,
    );
    const invocationId = admission.identity.invocationId;
    const recordUsage = async (
      usage: ModelInvocationUsage,
      cacheReported: boolean,
    ): Promise<void> => {
      if (usageRecording === undefined) return;
      try {
        await usageRecording.store.record({
          ownerId: request.ownerId,
          agentId: request.agentId,
          runId: request.runId,
          invocationId,
          purpose: usagePurpose,
          source: "agent-stream",
          provider: model.provider,
          model: model.id,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: cacheReported ? usage.cacheReadTokens : 0,
          cacheWriteTokens: cacheReported ? usage.cacheWriteTokens : 0,
          cacheReported,
          occurredAt: new Date().toISOString(),
        });
      } catch (error) {
        usageRecording.onFailure(error);
      }
    };
    return relayAdmittedPiStream(
      stream,
      permit,
      model,
      options?.signal,
      gateway,
      recordUsage,
      cacheFields.reported,
    );
  } catch (error) {
    onAdmissionFailed?.(request, admissionFailure(error));
    if (started && permit !== undefined) {
      await permit.markUnknown("transport_unresolved").catch(() => undefined);
    } else {
      const released = await releaseBeforeStart();
      if (!released) return failedPiStream(model, "Model budget accounting is unavailable");
    }
    return failedPiStream(model, "Model invocation admission failed");
  }
}

class RuntimeEventQueue implements AsyncIterable<RuntimeEvent> {
  readonly #values: { value: RuntimeEvent; accepted: () => void }[] = [];
  readonly #waiters: Array<(result: IteratorResult<RuntimeEvent>) => void> = [];
  #closed = false;

  push(value: RuntimeEvent): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value });
      return Promise.resolve();
    }
    return new Promise((accepted) => this.#values.push({ value, accepted }));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#values) pending.accepted();
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    return {
      next: async () => {
        const pending = this.#values.shift();
        if (pending !== undefined) {
          pending.accepted();
          return { done: false as const, value: pending.value };
        }
        if (this.#closed) return { done: true as const, value: undefined };
        return new Promise<IteratorResult<RuntimeEvent>>((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

export class PiAgentRuntimeAdapter implements AgentRuntimePort {
  readonly #dependencies: PiAgentRuntimeAdapterDependencies;
  readonly #activeSessions = new Map<RuntimeRequest["runId"], AgentSession>();
  readonly #cancelledRuns = new Set<RuntimeRequest["runId"]>();
  readonly #historyWrites = new Map<RuntimeRequest["runId"], Promise<unknown>>();
  readonly #visibleClassification = new Map<RuntimeRequest["runId"], DataClassification>();

  constructor(dependencies: PiAgentRuntimeAdapterDependencies) {
    this.#dependencies = dependencies;
  }

  async *run(request: RuntimeRequest): AsyncIterable<RuntimeEvent> {
    const queue = new RuntimeEventQueue();
    const producer = this.produce(request, (event) => queue.push(event)).finally(() =>
      queue.close(),
    );
    try {
      for await (const event of queue) yield event;
      await producer;
    } finally {
      queue.close();
      if (this.#activeSessions.has(request.runId)) await this.cancel(request.runId);
      await producer.catch(() => undefined);
      this.#cancelledRuns.delete(request.runId);
      this.#visibleClassification.delete(request.runId);
    }
  }

  #visibleOf(request: RuntimeRequest): DataClassification {
    return this.#visibleClassification.get(request.runId) ?? request.dataClassification;
  }

  #raiseVisible(
    runId: RuntimeRequest["runId"],
    classification: DataClassification,
    floor: DataClassification,
  ): void {
    if (!isModelVisible(classification)) throw new TypeError("RUNTIME_CONTENT_NOT_MODEL_VISIBLE");
    this.#visibleClassification.set(
      runId,
      highestClassification(floor, [
        classification,
        this.#visibleClassification.get(runId) ?? floor,
      ]),
    );
  }

  async cancel(runId: RuntimeRequest["runId"]): Promise<void> {
    this.#cancelledRuns.add(runId);
    const session = this.#activeSessions.get(runId);
    if (session) await session.abort();
    await this.#historyWrites.get(runId);
  }

  async #continueForSteeredNotices(
    session: AgentSession,
    canContinue: () => boolean,
  ): Promise<void> {
    if (!this.#dependencies.tools.subscribeBackground) return;
    while (canContinue() && session.agent.hasQueuedMessages()) {
      await session.agent.continue();
      await session.waitForIdle();
    }
  }

  private async produce(
    request: RuntimeRequest,
    emit: (event: RuntimeEvent) => Promise<void>,
  ): Promise<void> {
    if (this.#cancelledRuns.has(request.runId)) {
      emit({
        type: "runtime.cancelled",
        runId: request.runId,
        reasonCode: "RUNTIME_CANCELLED",
        occurredAt: this.now(),
      });
      return;
    }

    let eventChain = Promise.resolve();
    let settled = false;
    let failed = false;
    let aborted = false;
    let turnIndex = 0;
    let messageSequence = 0;
    let servedModel: string | undefined;
    let finalAssistant: AssistantMessage | undefined;
    let suspended: Extract<RuntimeEvent, { type: "runtime.suspended" }> | undefined;
    let unknownTool: Extract<RuntimeEvent, { type: "runtime.result_unknown" }> | undefined;
    const parallelToolsInFlight = new Set<string>();
    let abortWhenToolsSettle = false;
    let pendingUpdate: { event: AgentSessionEvent; occurredAt: string } | undefined;
    const enqueue = (operation: () => Promise<void> | void): Promise<void> => {
      pendingUpdate = undefined;
      eventChain = eventChain.then(operation);
      return eventChain;
    };

    try {
      const [binding, projection, descriptors, resources] = await Promise.all([
        this.#dependencies.models.resolve(request.modelRef),
        this.#dependencies.projection.resolveProjection(request),
        this.#dependencies.tools.listAuthorized(request.runId, request.capabilityHandleRefs),
        this.#dependencies.resources?.resolveAuthorized(
          request.runId,
          request.capabilityHandleRefs,
        ) ?? Promise.resolve(EMPTY_RESOURCES),
      ]);
      request = {
        ...request,
        thinkingLevel:
          request.thinkingLevel ?? getSupportedThinkingLevels(binding.model)[0] ?? "off",
      };
      if (projection.prompt.content.trim().length === 0) {
        throw new TypeError("RUNTIME_PROJECTION_EMPTY_PROMPT");
      }
      this.#raiseVisible(
        request.runId,
        projection.contentClassification ?? request.dataClassification,
        request.dataClassification,
      );
      const turn = turnPrompt(projection, this.#dependencies.timeZone ?? "UTC");
      const frozenDescriptors = descriptors.filter((descriptor) => !isHandleTool(descriptor));
      const handleDescriptors = descriptors.filter(isHandleTool);
      const frozenDefinitions = frozenDescriptors.map((descriptor) =>
        this.toolDefinition(descriptor),
      );
      const bundle = await this.#dependencies.promptBundles?.resolve({
        request,
        identity: {
          toolNames: frozenDescriptors.map(({ name }) => name),
          modelRef: request.modelRef,
          thinkingLevel: request.thinkingLevel ?? "off",
          answerLocale: projection.answerLocaleRef ?? null,
        },
        candidate: {
          systemPrompt: productSystemPrompt(projection.systemInstruction, frozenDefinitions),
          tools: JSON.stringify(frozenDefinitions.map(frozenToolText)),
        },
        hasHistory: projection.nativeHistory !== undefined || projection.history.length > 0,
      });
      const systemPrompt =
        bundle?.systemPrompt ??
        productSystemPrompt(
          projection.systemInstruction,
          descriptors.map((descriptor) => this.toolDefinition(descriptor)),
        );
      const requestTools = bundle
        ? [
            ...(JSON.parse(bundle.tools) as Tool[]).map(providerTool),
            ...handleDescriptors.map((descriptor) => providerTool(this.toolDefinition(descriptor))),
          ]
        : undefined;
      if (handleDescriptors.length > 0)
        this.#dependencies.onHandleTools?.(request, {
          generation: bundle?.generation ?? null,
          handleTools: handleDescriptors.length,
        });
      const identity = createHash("sha256")
        .update(
          JSON.stringify({
            model: binding.descriptor,
            descriptors,
            resources,
            systemPrompt,
            frozenTools: bundle?.tools ?? null,
            cwd: this.#dependencies.cwd,
          }),
        )
        .digest("hex");
      const continuation =
        request.continuationRef === undefined
          ? undefined
          : ((await this.#dependencies.continuations?.load(request, request.continuationRef)) as
              | {
                  identity: string;
                  batch: PiToolBatchContinuation;
                  turnIndex: number;
                  messageSequence: number;
                  toolProgress?: PiToolProgressState;
                }
              | undefined);
      if (request.continuationRef && (!continuation || continuation.identity !== identity))
        throw new Error("RUNTIME_CONTINUATION_BINDING_CHANGED");
      if (
        request.knownToolResult &&
        (!continuation ||
          request.knownToolResult.continuationRef !== request.continuationRef ||
          request.knownToolResult.toolCallId !== continuation.batch.waitingToolCallId)
      )
        throw new Error("RUNTIME_KNOWN_RESULT_BATCH_MISMATCH");
      if (continuation) {
        if (
          !Number.isSafeInteger(continuation.turnIndex) ||
          continuation.turnIndex < 1 ||
          !Number.isSafeInteger(continuation.messageSequence) ||
          continuation.messageSequence < 1
        )
          throw new Error("RUNTIME_CONTINUATION_COUNTERS_INVALID");
        turnIndex = continuation.turnIndex;
        messageSequence = continuation.messageSequence;
      }
      let streamOrdinal = continuation?.batch.completedStreamOrdinal ?? 0;
      const toolProgress = new PiToolProgressGuard(continuation?.toolProgress);
      let loopStoppedAppended = false;
      const appendLoopStopped = () => {
        const active = this.#activeSessions.get(request.runId);
        if (loopStoppedAppended || !active) return;
        loopStoppedAppended = true;
        if (active.isStreaming)
          void active
            .sendCustomMessage(toolLoopStoppedMessage(), { deliverAs: "steer" })
            .catch(() => active.abort());
        else
          active.agent.steer({
            role: "custom",
            ...toolLoopStoppedMessage(),
            timestamp: Date.now(),
          });
      };
      const replayedResults = new Set<string>();
      const descriptorsByName = new Map(
        descriptors.map((descriptor) => [descriptor.name, descriptor]),
      );
      if (descriptorsByName.size !== descriptors.length) {
        throw new TypeError("RUNTIME_DUPLICATE_TOOL_NAME");
      }
      const settingsManager = SettingsManager.inMemory(
        {
          compaction: { enabled: true, modelOverrides: compactionModelOverrides(binding.model) },
          retry: { enabled: false, maxRetries: 0 },
          cacheWarming: "streaming",
          defaultTools: [],
        },
        { projectTrusted: false },
      );
      const resourceLoader = new DefaultResourceLoader({
        cwd: this.#dependencies.cwd,
        agentDir: this.#dependencies.agentDir ?? this.#dependencies.cwd,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: "",
        systemPromptOverride: () => systemPrompt,
        appendSystemPrompt: [],
        appendSystemPromptOverride: () => [],
        additionalExtensionPaths: authorizedPaths(resources.extensionPaths, "extensionPaths"),
        additionalSkillPaths: authorizedPaths(resources.skillPaths, "skillPaths"),
        additionalPromptTemplatePaths: authorizedPaths(
          resources.promptTemplatePaths,
          "promptTemplatePaths",
        ),
        extensionFactories: [
          {
            name: "himawari-compaction-prefix",
            hidden: true,
            factory: (pi: ExtensionAPI) => {
              pi.on("session_before_compact", (event) => {
                try {
                  compactionPrefix = compactionPrefixMessages(event);
                } catch {
                  compactionPrefix = undefined;
                }
                return undefined;
              });
            },
          },
          {
            name: "himawari-request-head",
            hidden: true,
            factory: (pi: ExtensionAPI) => {
              pi.on("context_with_system", (event) => {
                const messages = himawariRequestHead(event.messages, systemPrompt, requestTools);
                return messages ? { messages } : undefined;
              });
            },
          },
          {
            name: "himawari-tool-outcomes",
            hidden: true,
            factory: (pi: ExtensionAPI) => {
              pi.on("tool_call", () => {
                if (toolProgress.blocked)
                  return { block: true, reason: CHAT_TOOL_LOOP_REJECTED.text };
              });
              pi.on("tool_result", (event) => {
                const details = event.details as
                  | { productOutcome?: unknown; errorCode?: unknown }
                  | undefined;
                if (!suspended && !unknownTool && !replayedResults.delete(event.toolCallId))
                  toolProgress.observe(
                    event.toolName,
                    event.input,
                    toolProgressOutput(descriptorsByName.get(event.toolName), event.content),
                    event.isError || details?.productOutcome === "failed",
                    descriptorsByName.get(event.toolName)?.definition === "builtin-coding" &&
                      typeof details?.errorCode === "string"
                      ? details.errorCode
                      : undefined,
                  );
                if (toolProgress.blocked) appendLoopStopped();
                if (
                  details?.productOutcome === "failed" ||
                  details?.productOutcome === "result_unknown"
                )
                  return { isError: true };
              });
            },
          },
          {
            name: "himawari-provider-observer",
            hidden: true,
            factory: (pi: ExtensionAPI) => {
              pi.on("before_provider_request", async (event) => {
                const payloadRef = await this.#dependencies.projection.capture({
                  runId: request.runId,
                  kind: "provider_request",
                  value: redactObservation(event.payload),
                  dataClassification: this.#visibleOf(request),
                });
                await enqueue(() => {
                  emit({
                    type: "runtime.provider_observation",
                    runId: request.runId,
                    phase: "request",
                    payloadRef,
                    occurredAt: this.now(),
                  });
                });
                return event.payload;
              });
              pi.on("after_provider_response", async (event) => {
                servedModel = servedModelFromHeaders(event.headers);
                const payloadRef = await this.#dependencies.projection.capture({
                  runId: request.runId,
                  kind: "provider_response",
                  value: redactObservation({ status: event.status, headers: event.headers }),
                  dataClassification: this.#visibleOf(request),
                });
                await enqueue(() => {
                  emit({
                    type: "runtime.provider_observation",
                    runId: request.runId,
                    phase: "response",
                    payloadRef,
                    occurredAt: this.now(),
                  });
                });
              });
            },
          },
        ],
      });
      await resourceLoader.reload();

      const sessionManager = continuation
        ? piToolBatchSessionManager(continuation.batch, systemPrompt, this.#dependencies.cwd, {
            id: piSessionId(request),
          })
        : prehydrateSession(request, projection, binding.model, this.#dependencies.cwd);
      const sessionFactory = this.#dependencies.createSession ?? createAgentSession;
      let restored: ReturnType<typeof restorePiToolBatch> | undefined;
      if (!getSupportedThinkingLevels(binding.model).includes(request.thinkingLevel ?? "off"))
        throw new Error("PI_THINKING_LEVEL_UNSUPPORTED");
      const toolCheckpoints = new Map<string, string>();
      const saveToolCheckpoint = async (invocation: RuntimeToolInvocation) => {
        const key = `${streamOrdinal}:${invocation.toolCallId}`;
        const saved = toolCheckpoints.get(key);
        if (saved) return saved;
        const active = this.#activeSessions.get(request.runId);
        const continuations = this.#dependencies.continuations;
        if (!active || !continuations) throw new Error("RUNTIME_CONTINUATION_STORAGE_UNAVAILABLE");
        await this.#measure(request.runId, "tool.checkpoint.drain", () => eventChain);
        const batch = capturePiToolBatch(
          active,
          invocation.toolCallId,
          streamOrdinal,
          systemPrompt,
        );
        const ref = await this.#measure(request.runId, "tool.checkpoint.save", () =>
          continuations.save(request, {
            identity,
            batch,
            turnIndex,
            messageSequence,
            toolProgress: toolProgress.snapshot(),
          }),
        );
        toolCheckpoints.set(key, ref);
        return ref;
      };
      let loopSummaryAttempted = false;
      let compacting = false;
      let compactionPrefix: Message[] | undefined;
      let lastRequest:
        | { readonly context: Context; readonly options: SimpleStreamOptions | undefined }
        | undefined;
      const governedRuntime = governedModelRuntime(
        binding.modelRuntime,
        async (model, requested, options, forward) => {
          const summaryContext = compacting ? himawariSummaryContext(requested) : undefined;
          const shared =
            summaryContext && lastRequest
              ? sharedSummaryContext(
                  lastRequest.context,
                  compactionPrefix,
                  model.contextWindow,
                  options?.maxTokens ?? model.maxTokens,
                )
              : undefined;
          const context =
            shared ??
            summaryContext ??
            himawariRequestContext(requested, systemPrompt, requestTools);
          if (shared) options = sharedSummaryOptions(options, lastRequest?.options);
          await this.#historyWrites.get(request.runId);
          const replay = restored?.takeReplay();
          if (replay) return replay;
          if (!context) return failedPiStream(model, PI_REQUEST_HEAD_DIVERGED);
          if (suspended || unknownTool)
            return failedPiStream(model, "Runtime tool reconciliation is required");
          if (toolProgress.blocked) {
            if (loopSummaryAttempted) return failedPiStream(model, "PI_TOOL_LOOP_DETECTED");
            loopSummaryAttempted = true;
          }
          if (!summaryContext) lastRequest = { context, options };
          else
            this.#dependencies.onCompactionSummaryRequest?.(request, {
              sharedHead: shared !== undefined,
            });
          return admitPiStream(
            { ...request, dataClassification: this.#visibleOf(request) },
            binding,
            this.#dependencies.admission,
            model,
            context,
            options,
            ++streamOrdinal,
            forward,
            this.#dependencies.logicalSlot,
            this.#dependencies.egress,
            this.#dependencies.onModelAdmissionFailed,
            this.#dependencies.usage,
            bundle?.redactionRuleset,
            summaryContext ? "other" : "chat",
            this.#dependencies.onModelRequestRejected,
          );
        },
      );
      const created = await sessionFactory({
        cwd: this.#dependencies.cwd,
        ...(this.#dependencies.agentDir ? { agentDir: this.#dependencies.agentDir } : {}),
        model: binding.model,
        modelRuntime: governedRuntime,
        thinkingLevel: request.thinkingLevel ?? "off",
        noTools: "all",
        tools: descriptors.map(({ name }) => name),
        customTools: descriptors.map((descriptor) =>
          this.createTool(request, descriptor, {
            completedResult: (toolCallId) => {
              const result = restored?.completedResult(toolCallId, descriptor.name);
              if (result) replayedResults.add(toolCallId);
              return result;
            },
            begin: (toolCallId, parallel) => {
              if (parallel && !suspended && !unknownTool) parallelToolsInFlight.add(toolCallId);
            },
            settle: (toolCallId) => {
              parallelToolsInFlight.delete(toolCallId);
              if (abortWhenToolsSettle && parallelToolsInFlight.size === 0)
                this.#activeSessions.get(request.runId)?.agent.abort();
            },
            assertKnown: (toolCallId) => {
              if (
                compacting ||
                unknownTool ||
                (suspended && !parallelToolsInFlight.has(toolCallId))
              )
                throw new Error("RUNTIME_TOOL_EXECUTION_STOPPED");
            },
            checkpoint: (invocation) =>
              this.#dependencies.continuations
                ? saveToolCheckpoint(invocation)
                : Promise.resolve(undefined),
            suspend: async (invocation, approval) => {
              const active = this.#activeSessions.get(request.runId);
              if (!active) throw new Error("RUNTIME_CONTINUATION_STORAGE_UNAVAILABLE");
              const continuationRef = await saveToolCheckpoint(invocation);
              suspended = {
                type: "runtime.suspended",
                runId: request.runId,
                continuationRef,
                approval,
                occurredAt: this.now(),
              };
              if (parallelToolsInFlight.size === 0) active.agent.abort();
              else abortWhenToolsSettle = true;
            },
            unknown: (invocation, result) => {
              unknownTool ??= {
                type: "runtime.result_unknown",
                runId: request.runId,
                toolCallId: invocation.toolCallId,
                capabilityRef: invocation.capabilityRef,
                externalActionId: result.externalActionId,
                occurredAt: this.now(),
              };
              this.#activeSessions.get(request.runId)?.agent.abort();
            },
          }),
        ),
        resourceLoader,
        sessionManager,
        settingsManager,
      });
      const session = created.session;
      restored = continuation ? restorePiToolBatch(session, continuation.batch) : undefined;
      this.#activeSessions.set(request.runId, session);
      const unsubscribeBackground = this.#dependencies.tools.subscribeBackground?.(
        request.runId,
        (notice) => {
          if (!session.isStreaming) return false;
          void session
            .sendCustomMessage(backgroundCommandMessage(notice), { deliverAs: "steer" })
            .catch(() => session.abort());
          return true;
        },
      );

      const unsubscribe = session.subscribe((event) => {
        if (event.type === "compaction_start") compacting = true;
        if (event.type === "compaction_end") {
          compacting = false;
          compactionPrefix = undefined;
          if (event.result === undefined && !event.aborted && event.errorMessage)
            this.#dependencies.onModelStreamFailed?.(request, {
              code: "PI_COMPACTION_FAILED",
              message: loggableModelFailure(event.errorMessage),
            });
        }
        if (
          !suspended &&
          this.#dependencies.projection.captureHistory &&
          (event.type === "message_end" || event.type === "compaction_end")
        ) {
          const messages = structuredClone(
            session.messages.filter((message) => message.role !== "system"),
          );
          const pending = (this.#historyWrites.get(request.runId) ?? Promise.resolve()).then(() =>
            this.#dependencies.projection.captureHistory?.({
              runId: request.runId,
              dataClassification: this.#visibleOf(request),
              coveredRunIds: projection.coveredRunIds ?? [],
              messages,
            }),
          );
          this.#historyWrites.set(request.runId, pending);
          void pending.catch(() => session.abort());
        }

        if (
          event.type === "compaction_end" &&
          event.willRetry &&
          !event.aborted &&
          event.result !== undefined
        ) {
          const environment = runtimeEnvironmentAfterCompaction(session.messages, projection);
          if (environment)
            void session
              .sendCustomMessage(environment, { deliverAs: "steer" })
              .catch(() => session.abort());
        }

        if (
          event.type === "message_update" &&
          event.assistantMessageEvent?.type === "toolcall_start"
        ) {
          const content = event.message.role === "assistant" ? event.message.content : [];
          const block = content[event.assistantMessageEvent.contentIndex];
          if (block?.type === "toolCall" && block.name.length > 0)
            this.#dependencies.onToolCallStarted?.(request, block.name);
        }

        if (
          this.#dependencies.onAssistantText &&
          event.type === "message_update" &&
          event.message.role === "assistant" &&
          ["text_start", "text_delta", "text_end"].includes(event.assistantMessageEvent?.type ?? "")
        ) {
          try {
            this.#dependencies.onAssistantText(request, {
              timestamp: event.message.timestamp,
              text: event.message.content
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("\n"),
            });
          } catch {}
        }

        const observed = {
          event:
            event.type === "message_start" ||
            event.type === "message_update" ||
            event.type === "message_end"
              ? structuredClone(event)
              : event,
          occurredAt: this.now(),
        };
        const coalescible =
          event.type === "message_update" &&
          !Object.hasOwn(contentBoundaries, event.assistantMessageEvent?.type ?? "");
        if (coalescible && pendingUpdate) {
          Object.assign(pendingUpdate, observed);
          return;
        }
        void enqueue(async () => {
          if (pendingUpdate === observed) pendingUpdate = undefined;
          const event = observed.event;
          if (suspended) return;
          if (restored && event.type === "agent_end") settled = true;
          if (event.type === "message_end" && event.message.role === "assistant")
            finalAssistant = event.message;
          const mapped = await this.mapEvent(
            request,
            event,
            descriptorsByName,
            () => ++turnIndex,
            () => turnIndex,
            () => ++messageSequence,
            () => {
              const answered = servedModel;
              servedModel = undefined;
              return answered;
            },
            observed.occurredAt,
          );
          for (const mappedEvent of mapped.events) {
            if (toolProgress.blocked && mappedEvent.type === "runtime.failed") continue;
            if (
              unknownTool &&
              (mappedEvent.type === "runtime.failed" || mappedEvent.type === "runtime.cancelled")
            )
              continue;
            await emit(mappedEvent);
          }
          settled ||= mapped.settled;
          failed ||= mapped.failed;
          aborted ||= mapped.aborted;
        });
        if (coalescible) pendingUpdate = observed;
      });

      try {
        if (restored) await session.agent.continue();
        else
          await session.prompt(turn, {
            expandPromptTemplates: false,
            source: "extension",
            ...(projection.prompt.images?.length
              ? {
                  images: projection.prompt.images.map(({ mimeType, data }) => ({
                    type: "image" as const,
                    mimeType,
                    data,
                  })),
                }
              : {}),
          });
        await session.waitForIdle();
        await eventChain;
        await this.#continueForSteeredNotices(session, () => {
          return (
            !suspended &&
            !unknownTool &&
            !failed &&
            !aborted &&
            !toolProgress.blocked &&
            !this.#cancelledRuns.has(request.runId)
          );
        });
        await eventChain;
        await this.#historyWrites.get(request.runId);
      } finally {
        unsubscribeBackground?.();
        unsubscribe();
        session.dispose();
        this.#activeSessions.delete(request.runId);
        this.#historyWrites.delete(request.runId);
      }

      if (suspended && !this.#cancelledRuns.has(request.runId)) {
        emit(suspended);
      } else if (unknownTool) {
        emit(unknownTool);
      } else if (this.#cancelledRuns.has(request.runId) || aborted) {
        emit({
          type: "runtime.cancelled",
          runId: request.runId,
          reasonCode: "PI_ABORTED",
          occurredAt: this.now(),
        });
      } else if (toolProgress.blocked) {
        emit(runtimeFailure(request, this.now(), "PI_TOOL_LOOP_DETECTED"));
      } else if (!failed && settled) {
        if (
          finalAssistant &&
          (finalAssistant.content.some((part) => part.type === "toolCall") ||
            (finalAssistant.stopReason !== "stop" && finalAssistant.stopReason !== "toolUse"))
        ) {
          emit(
            runtimeFailure(
              request,
              this.now(),
              finalAssistant.stopReason === "length" &&
                (finalAssistant.usage?.output ?? MIN_CONTEXT_ANSWER_TOKENS) <
                  MIN_CONTEXT_ANSWER_TOKENS
                ? PI_CONTEXT_WINDOW_EXHAUSTED
                : "PI_FINAL_ANSWER_INCOMPLETE",
            ),
          );
          return;
        }
        const text =
          finalAssistant?.content
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("") ?? "";
        if (!text.trim()) {
          emit(
            request.threadId !== null
              ? runtimeFailure(request, this.now(), "PI_FINAL_ANSWER_EMPTY")
              : {
                  type: "runtime.completed",
                  runId: request.runId,
                  output: { kind: "no-answer" },
                  occurredAt: this.now(),
                },
          );
          return;
        }
        const contentRef = await this.#dependencies.projection.captureFinalAnswer({
          runId: request.runId,
          text: redactMachineSecrets(text),
          dataClassification: this.#visibleOf(request),
        });
        if (this.#cancelledRuns.has(request.runId)) {
          emit({
            type: "runtime.cancelled",
            runId: request.runId,
            reasonCode: "PI_ABORTED",
            occurredAt: this.now(),
          });
          return;
        }
        emit({
          type: "runtime.completed",
          runId: request.runId,
          output: { kind: "assistant-answer", contentRef },
          occurredAt: this.now(),
        });
      } else if (!failed) {
        emit(runtimeFailure(request, this.now(), "PI_RUNTIME_DID_NOT_SETTLE"));
      }
    } catch (error) {
      await eventChain.catch(() => undefined);
      const code =
        error instanceof Error && error.message.startsWith("PI_UNKNOWN_EVENT_TYPE:")
          ? "PI_UNKNOWN_EVENT_TYPE"
          : "PI_RUNTIME_ERROR";
      emit(
        unknownTool ??
          (request.knownToolResult
            ? {
                type: "runtime.result_unknown",
                runId: request.runId,
                toolCallId: request.knownToolResult.toolCallId,
                capabilityRef: request.knownToolResult.capabilityRef,
                externalActionId: request.knownToolResult.jobId,
                occurredAt: this.now(),
              }
            : runtimeFailure(request, this.now(), code)),
      );
      this.#activeSessions.delete(request.runId);
    }
  }

  private toolDefinition(descriptor: RuntimeToolDescriptor): PiToolDefinitionText {
    const unavailable = async (): Promise<never> => {
      throw new Error("PI_AGENT_SERVICE_FILE_IO_FORBIDDEN");
    };
    if (descriptor.definition === "builtin-read" || descriptor.definition === "builtin-coding") {
      const [builtin] = createGovernedPiCodingTools({
        cwd: this.#dependencies.cwd,
        enabled: [descriptor.name],
        operations: {
          ...createPiOperationsFromGovernedHostPort({
            access: unavailable,
            readFile: unavailable,
            writeFile: unavailable,
            makeDirectory: unavailable,
            executeCommand: unavailable,
          }),
          find: { exists: unavailable, glob: unavailable },
          grep: { isDirectory: unavailable, readFile: unavailable },
          ls: { exists: unavailable, stat: unavailable, readdir: unavailable },
        },
      });
      if (!builtin) throw new Error("PI_READ_DEFINITION_MISSING");
      const text = himawariBuiltinToolText(builtin);
      return {
        name: builtin.name,
        label: builtin.label,
        description: text.description,
        parameters: text.parameters,
        ...(builtin.promptSnippet === undefined ? {} : { promptSnippet: builtin.promptSnippet }),
        ...(text.promptGuidelines === undefined
          ? {}
          : { promptGuidelines: [...text.promptGuidelines] }),
        ...(builtin.constrainedSampling === undefined
          ? {}
          : { constrainedSampling: builtin.constrainedSampling }),
      };
    }
    return {
      name: descriptor.name,
      label: descriptor.name,
      description: "description" in descriptor ? descriptor.description : "",
      parameters: descriptor.parameters as ToolDefinition["parameters"],
    };
  }

  private createTool(
    request: RuntimeRequest,
    descriptor: RuntimeToolDescriptor,
    reconciliation: {
      completedResult(
        toolCallId: string,
      ): PiToolBatchContinuation["completedResults"][number] | undefined;
      begin(toolCallId: string, parallel: boolean): void;
      settle(toolCallId: string): void;
      assertKnown(toolCallId: string): void;
      checkpoint(invocation: RuntimeToolInvocation): Promise<string | undefined>;
      suspend(invocation: RuntimeToolInvocation, approval: RuntimeApprovalWait): Promise<void>;
      unknown(
        invocation: RuntimeToolInvocation,
        result: Awaited<ReturnType<RuntimeToolPort["execute"]>>,
      ): void;
    },
  ): ToolDefinition {
    const definition = this.toolDefinition(descriptor);
    const parallel = "executionMode" in descriptor && descriptor.executionMode === "parallel";
    if (
      parallel &&
      descriptor.definition === "builtin-coding" &&
      !["read", "ls", "find", "grep"].includes(descriptor.name)
    )
      throw new TypeError("RUNTIME_TOOL_EXECUTION_MODE_INVALID");
    const executeTool: ToolDefinition["execute"] = async (toolCallId, parameters, signal) => {
      await this.#measure(
        request.runId,
        "tool.history_wait",
        async () => await this.#historyWrites.get(request.runId),
      );
      signal?.throwIfAborted();
      reconciliation.assertKnown(toolCallId);
      const completed = reconciliation.completedResult(toolCallId);
      if (completed)
        return {
          content: completed.content,
          details: completed.details,
          isError: completed.isError,
        };
      const conflictOf =
        descriptor.definition === "builtin-coding" && ["write", "edit"].includes(descriptor.name)
          ? previousFileConflict(
              this.#activeSessions.get(request.runId)?.messages ?? [],
              request.runId,
              (parameters as Record<string, unknown>)["path"],
            )
          : undefined;
      let invocation: RuntimeToolInvocation = {
        ...(conflictOf ? { fileConflictOf: conflictOf } : {}),
        runId: request.runId,
        context: {
          threadId: request.threadId,
          modelRef: request.modelRef,
          executionLease: request.executionLease,
          ...(request.continuationRef ? { continuationRef: request.continuationRef } : {}),
        },
        toolCallId,
        ...(request.executionDeadlineAt === undefined
          ? {}
          : { executionDeadlineAt: request.executionDeadlineAt }),
        capabilityRef: descriptor.capabilityRef,
        capabilityHandleRef: descriptor.capabilityHandleRef,
        arguments: safeArguments(parameters),
        dataClassification: request.dataClassification,
      };
      let result: Awaited<ReturnType<RuntimeToolPort["execute"]>>;
      const recovery = request.knownToolResult;
      if (recovery?.toolCallId === toolCallId) {
        try {
          if (!this.#dependencies.tools.recoverResult)
            throw new Error("RUNTIME_KNOWN_RESULT_READER_UNAVAILABLE");
          result = await this.#dependencies.tools.recoverResult(invocation, recovery);
        } catch {
          result = {
            outcome: "result_unknown",
            dispatchState: "possibly_sent",
            resultRef: null,
            errorCode: "RUNTIME_KNOWN_RESULT_UNAVAILABLE",
            externalActionId: recovery.jobId,
            modelContent: "原工具结果仍需核验，未重新执行。",
          };
        }
      } else {
        const decision = await this.#dependencies.tools.preflight(invocation);
        signal?.throwIfAborted();
        if (!decision.allowed) {
          return {
            content: [{ type: "text", text: policyBlockedText(decision.reasonCode) }],
            details: {
              permissionDecisionRef: decision.permissionDecisionRef,
              reasonCode: decision.reasonCode,
              productOutcome: "failed",
              dispatchState: "not_sent",
            },
            isError: true,
          };
        }
        reconciliation.assertKnown(toolCallId);
        try {
          const continuationRef = await reconciliation.checkpoint(invocation);
          if (continuationRef && invocation.context)
            invocation = { ...invocation, context: { ...invocation.context, continuationRef } };
        } catch {
          return {
            content: [{ type: "text", text: "工具未执行：无法保存恢复记录。" }],
            details: {
              productOutcome: "failed",
              dispatchState: "not_sent",
              errorCode: "RUNTIME_TOOL_CHECKPOINT_FAILED",
            },
            isError: true,
          };
        }
        signal?.throwIfAborted();
        try {
          result = await this.#dependencies.tools.execute(
            invocation,
            ...(signal ? [{ signal }] : []),
          );
        } catch {
          result = {
            outcome: "result_unknown",
            dispatchState: "possibly_sent",
            resultRef: null,
            errorCode: "RUNTIME_TOOL_EXECUTION_UNRESOLVED",
            externalActionId: null,
            modelContent: "Tool execution needs reconciliation before continuing.",
          };
        }
      }
      if (result.outcome === "awaiting_approval") {
        try {
          await reconciliation.suspend(invocation, result.approval);
        } catch {
          reconciliation.unknown(invocation, result);
        }
        throw new Error("RUNTIME_TOOL_SUSPENDED");
      }
      if (result.outcome === "result_unknown") reconciliation.unknown(invocation, result);
      if (result.contentClassification)
        this.#raiseVisible(request.runId, result.contentClassification, request.dataClassification);
      return {
        content: [{ type: "text", text: result.modelContent }],
        details: {
          ...(result.executionTiming ? { executionTiming: result.executionTiming } : {}),
          productOutcome: result.outcome,
          ...(result.dispatchState ? { dispatchState: result.dispatchState } : {}),
          productRunId: request.runId,
          resultRef: result.resultRef,
          errorCode: result.errorCode,
          externalActionId: result.externalActionId,
        },
        isError: result.outcome !== "succeeded",
      };
    };
    return {
      ...definition,
      executionMode: parallel ? "parallel" : "sequential",
      execute: async (toolCallId, parameters, signal, onUpdate, context) => {
        reconciliation.begin(toolCallId, parallel);
        try {
          return await executeTool(toolCallId, parameters, signal, onUpdate, context);
        } finally {
          reconciliation.settle(toolCallId);
        }
      },
    };
  }

  private async mapEvent(
    request: RuntimeRequest,
    event: AgentSessionEvent,
    descriptors: ReadonlyMap<string, RuntimeToolDescriptor>,
    nextTurnIndex: () => number,
    currentTurnIndex: () => number,
    nextMessageSequence: () => number,
    takeServedModel: () => string | undefined,
    now: string,
  ): Promise<{
    readonly events: readonly RuntimeEvent[];
    readonly settled: boolean;
    readonly failed: boolean;
    readonly aborted: boolean;
  }> {
    const mapped: RuntimeEvent[] = [];
    switch (event.type) {
      case "agent_start":
        mapped.push({
          type: "runtime.model_started",
          runId: request.runId,
          modelRef: request.modelRef,
          thinkingLevel: request.thinkingLevel ?? "off",
          occurredAt: now,
        });
        break;
      case "agent_settled":
        return { events: mapped, settled: true, failed: false, aborted: false };
      case "turn_start":
        mapped.push({
          type: "runtime.turn_started",
          runId: request.runId,
          turnIndex: nextTurnIndex(),
          occurredAt: now,
        });
        break;
      case "turn_end":
        mapped.push({
          type: "runtime.turn_completed",
          runId: request.runId,
          turnId: this.turnId(request, currentTurnIndex()),
          occurredAt: now,
        });
        break;
      case "message_start":
      case "message_update":
      case "message_end": {
        const observation = redactObservation(
          event.type === "message_update" ? withToolCallProgress(event.message) : event.message,
        );
        const servedModel =
          event.type === "message_end" && event.message.role === "assistant"
            ? takeServedModel()
            : undefined;
        const answeredBy = servedModel === undefined ? {} : { servedModel };
        const payloadRef = await this.#dependencies.projection.capture({
          runId: request.runId,
          kind: "message",
          value: {
            ...(observation as Record<string, unknown>),
            ...(event.type === "message_update"
              ? contentBoundary(event.assistantMessageEvent)
              : {}),
            ...answeredBy,
          },
          dataClassification: this.#visibleOf(request),
        });
        const sequence = nextMessageSequence();
        const phase =
          event.type === "message_start"
            ? "started"
            : event.type === "message_update"
              ? "updated"
              : "ended";
        mapped.push({
          type: "runtime.message",
          runId: request.runId,
          phase,
          role: event.message.role,
          sequence,
          payloadRef,
          occurredAt: now,
        });
        if (event.type === "message_end" && event.message.role === "assistant") {
          mapped.push({
            type: "runtime.model_output",
            runId: request.runId,
            sequence,
            payloadRef,
            occurredAt: now,
          });
          if (event.message.stopReason === "error") {
            const code = modelFailureCode(event.message.errorMessage);
            this.#dependencies.onModelStreamFailed?.(request, {
              code,
              message: loggableModelFailure(event.message.errorMessage),
            });
            mapped.push(runtimeFailure(request, now, code));
          }
        }
        return {
          events: mapped,
          settled: false,
          failed:
            event.type === "message_end" &&
            event.message.role === "assistant" &&
            event.message.stopReason === "error",
          aborted:
            event.type === "message_end" &&
            event.message.role === "assistant" &&
            event.message.stopReason === "aborted",
        };
      }
      case "tool_execution_start": {
        const descriptor = descriptors.get(event.toolName);
        if (!descriptor) throw new Error(`PI_UNKNOWN_TOOL:${event.toolName}`);
        const payloadRef = await this.#dependencies.projection.capture({
          runId: request.runId,
          kind: "tool_intent",
          value: redactObservation({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            description: "description" in descriptor ? descriptor.description : "",
            arguments: event.args,
          }),
          dataClassification: this.#visibleOf(request),
        });
        mapped.push({
          type: "runtime.tool_intent",
          runId: request.runId,
          capabilityRef: descriptor.capabilityRef,
          payloadRef,
          occurredAt: now,
        });
        break;
      }
      case "tool_execution_end": {
        const descriptor = descriptors.get(event.toolName);
        if (!descriptor) throw new Error(`PI_UNKNOWN_TOOL:${event.toolName}`);
        const payloadRef = await this.#dependencies.projection.capture({
          runId: request.runId,
          kind: "tool_result",
          value: redactObservation({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            result: event.result,
            isError: event.isError,
          }),
          dataClassification: this.#visibleOf(request),
        });
        mapped.push({
          type: "runtime.tool_result",
          runId: request.runId,
          capabilityRef: descriptor.capabilityRef,
          payloadRef,
          occurredAt: now,
        });
        break;
      }
      case "compaction_end":
        if (event.result && !event.aborted) {
          const proposalRef = await this.#dependencies.projection.proposeCompaction({
            runId: request.runId,
            sessionId: request.sessionId,
            summary: event.result.summary,
            firstKeptEntryId: event.result.firstKeptEntryId,
            tokensBefore: event.result.tokensBefore,
            dataClassification: this.#visibleOf(request),
          });
          mapped.push({
            type: "runtime.compaction_proposed",
            runId: request.runId,
            proposalRef,
            occurredAt: now,
          });
        }
        break;
      default: {
        const eventType = (event as { readonly type: string }).type;
        if (!KNOWN_IGNORED_EVENTS.has(eventType)) {
          throw new Error(`PI_UNKNOWN_EVENT_TYPE:${eventType}`);
        }
      }
    }
    return { events: mapped, settled: false, failed: false, aborted: false };
  }

  private turnId(request: RuntimeRequest, turnIndex: number): RuntimeTurnId {
    if (this.#dependencies.turnId) return this.#dependencies.turnId(request, turnIndex);
    return `${request.runId}:turn:${turnIndex}` as RuntimeTurnId;
  }

  #measure<T>(runId: string, name: string, work: () => Promise<T>): Promise<T> {
    return this.#dependencies.measure ? this.#dependencies.measure(runId, name, work) : work();
  }

  private now(): string {
    return this.#dependencies.now?.() ?? new Date().toISOString();
  }
}
