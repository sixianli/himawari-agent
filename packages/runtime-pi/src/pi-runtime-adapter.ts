import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeProjectionContent,
  RuntimeProjectionMessage,
  RuntimeProjectionPort,
  RuntimeRequest,
  RuntimeToolDescriptor,
  RuntimeToolInvocation,
  RuntimeToolPort,
} from "@himawari-agent/application/runtime-port";
import { redactMachineSecrets } from "@himawari-agent/application/runtime-port";
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
  type ExtensionAPI,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

type RuntimeTurnId = Extract<RuntimeEvent, { readonly type: "runtime.turn_completed" }>["turnId"];

export interface PiModelBinding {
  readonly model: Model<Api>;
  readonly modelRuntime: ModelRuntime;
}

export interface PiModelBindingPort {
  resolve(modelRef: string): Promise<PiModelBinding>;
}

/**
 * Explicit Pi resources that have already passed product authorization. Ambient
 * Pi discovery remains disabled even when this port is present.
 */
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
  readonly projection: RuntimeProjectionPort;
  readonly tools: RuntimeToolPort;
  readonly models: PiModelBindingPort;
  readonly resources?: PiRuntimeResourcePort;
  readonly cwd: string;
  readonly agentDir?: string;
  readonly now?: () => string;
  readonly turnId?: (request: RuntimeRequest, turnIndex: number) => RuntimeTurnId;
  readonly createSession?: (
    options: CreateAgentSessionOptions,
  ) => Promise<CreateAgentSessionResult>;
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

const EMPTY_RESOURCES: AuthorizedPiResources = Object.freeze({
  extensionPaths: Object.freeze([]),
  skillPaths: Object.freeze([]),
  promptTemplatePaths: Object.freeze([]),
});

function safeArguments(value: unknown): RuntimeToolInvocation["arguments"] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as RuntimeToolInvocation["arguments"];
}

function redactObservation(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") {
    try {
      const url = new URL(value);
      for (const key of [...url.searchParams.keys()]) {
        if (/token|key|secret|password|signature|credential/i.test(key)) {
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
    result[key] = /authorization|cookie|token|api.?key|secret|password|credential/i.test(key)
      ? "[REDACTED]"
      : redactObservation(entry, seen);
  }
  return result;
}

function runtimeFailure(request: RuntimeRequest, now: string, errorCode: string): RuntimeEvent {
  return { type: "runtime.failed", runId: request.runId, errorCode, occurredAt: now };
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

function prehydrateSession(
  request: RuntimeRequest,
  history: readonly RuntimeProjectionMessage[],
  compaction: Awaited<ReturnType<RuntimeProjectionPort["resolveContext"]>>["compaction"],
  model: Model<Api>,
  cwd: string,
): SessionManager {
  const sessionManager = SessionManager.inMemory(cwd, { id: request.sessionId });
  const piEntryByProductMessage = new Map<string, string>();
  for (const message of history) {
    if (piEntryByProductMessage.has(message.id)) {
      throw new TypeError("RUNTIME_PROJECTION_DUPLICATE_MESSAGE_ID");
    }
    piEntryByProductMessage.set(
      message.id,
      sessionManager.appendMessage(projectedMessage(message, model)),
    );
  }
  if (compaction !== undefined) {
    const firstKeptEntryId = piEntryByProductMessage.get(compaction.firstKeptMessageId);
    if (firstKeptEntryId === undefined) {
      throw new TypeError("RUNTIME_PROJECTION_COMPACTION_ENTRY_NOT_FOUND");
    }
    if (!Number.isSafeInteger(compaction.tokensBefore) || compaction.tokensBefore < 0) {
      throw new TypeError("RUNTIME_PROJECTION_INVALID_TOKEN_COUNT");
    }
    sessionManager.appendCompaction(
      compaction.summary,
      firstKeptEntryId,
      compaction.tokensBefore,
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

class RuntimeEventQueue implements AsyncIterable<RuntimeEvent> {
  readonly #values: RuntimeEvent[] = [];
  readonly #waiters: Array<(result: IteratorResult<RuntimeEvent>) => void> = [];
  #closed = false;

  push(value: RuntimeEvent): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value !== undefined) return { done: false as const, value };
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
      if (this.#activeSessions.has(request.runId)) await this.cancel(request.runId);
      await producer.catch(() => undefined);
      this.#cancelledRuns.delete(request.runId);
    }
  }

  async cancel(runId: RuntimeRequest["runId"]): Promise<void> {
    this.#cancelledRuns.add(runId);
    const session = this.#activeSessions.get(runId);
    if (session) await session.abort();
  }

  private async produce(
    request: RuntimeRequest,
    emit: (event: RuntimeEvent) => void,
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
    const enqueue = (operation: () => Promise<void> | void): Promise<void> => {
      eventChain = eventChain.then(operation);
      return eventChain;
    };

    try {
      const [binding, systemInstruction, context, descriptors, resources] = await Promise.all([
        this.#dependencies.models.resolve(request.modelRef),
        this.#dependencies.projection.resolveSystemInstruction(
          request.runId,
          request.systemInstructionRef,
        ),
        this.#dependencies.projection.resolveContext(request.runId, request.messageRefs),
        this.#dependencies.tools.listAuthorized(request.runId, request.capabilityHandleRefs),
        this.#dependencies.resources?.resolveAuthorized(
          request.runId,
          request.capabilityHandleRefs,
        ) ?? Promise.resolve(EMPTY_RESOURCES),
      ]);
      if (context.prompt.content.trim().length === 0) {
        throw new TypeError("RUNTIME_PROJECTION_EMPTY_PROMPT");
      }
      const descriptorsByName = new Map(
        descriptors.map((descriptor) => [descriptor.name, descriptor]),
      );
      if (descriptorsByName.size !== descriptors.length) {
        throw new TypeError("RUNTIME_DUPLICATE_TOOL_NAME");
      }
      const settingsManager = SettingsManager.inMemory(
        {
          compaction: { enabled: true },
          retry: { enabled: false, maxRetries: 0 },
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
        systemPrompt: systemInstruction,
        additionalExtensionPaths: authorizedPaths(resources.extensionPaths, "extensionPaths"),
        additionalSkillPaths: authorizedPaths(resources.skillPaths, "skillPaths"),
        additionalPromptTemplatePaths: authorizedPaths(
          resources.promptTemplatePaths,
          "promptTemplatePaths",
        ),
        extensionFactories: [
          {
            name: "himawari-provider-observer",
            hidden: true,
            factory: (pi: ExtensionAPI) => {
              pi.on("before_provider_request", async (event) => {
                const payloadRef = await this.#dependencies.projection.capture({
                  runId: request.runId,
                  kind: "provider_request",
                  value: redactObservation(event.payload),
                  dataClassification: request.dataClassification,
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
                const payloadRef = await this.#dependencies.projection.capture({
                  runId: request.runId,
                  kind: "provider_response",
                  value: redactObservation({ status: event.status, headers: event.headers }),
                  dataClassification: request.dataClassification,
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

      const sessionManager = prehydrateSession(
        request,
        context.history,
        context.compaction,
        binding.model,
        this.#dependencies.cwd,
      );
      const sessionFactory = this.#dependencies.createSession ?? createAgentSession;
      const created = await sessionFactory({
        cwd: this.#dependencies.cwd,
        ...(this.#dependencies.agentDir ? { agentDir: this.#dependencies.agentDir } : {}),
        model: binding.model,
        modelRuntime: binding.modelRuntime,
        thinkingLevel: "off",
        noTools: "all",
        tools: descriptors.map(({ name }) => name),
        customTools: descriptors.map((descriptor) => this.createTool(request, descriptor)),
        resourceLoader,
        sessionManager,
        settingsManager,
      });
      const session = created.session;
      this.#activeSessions.set(request.runId, session);

      const unsubscribe = session.subscribe((event) => {
        void enqueue(async () => {
          const mapped = await this.mapEvent(
            request,
            event,
            descriptorsByName,
            () => ++turnIndex,
            () => turnIndex,
            () => ++messageSequence,
          );
          for (const mappedEvent of mapped.events) emit(mappedEvent);
          settled ||= mapped.settled;
          failed ||= mapped.failed;
          aborted ||= mapped.aborted;
        });
      });

      try {
        await session.prompt(context.prompt.content, {
          expandPromptTemplates: false,
          source: "extension",
        });
        await session.waitForIdle();
        await eventChain;
      } finally {
        unsubscribe();
        session.dispose();
        this.#activeSessions.delete(request.runId);
      }

      if (this.#cancelledRuns.has(request.runId) || aborted) {
        emit({
          type: "runtime.cancelled",
          runId: request.runId,
          reasonCode: "PI_ABORTED",
          occurredAt: this.now(),
        });
      } else if (!failed && settled) {
        emit({ type: "runtime.completed", runId: request.runId, occurredAt: this.now() });
      } else if (!failed) {
        emit(runtimeFailure(request, this.now(), "PI_RUNTIME_DID_NOT_SETTLE"));
      }
    } catch (error) {
      await eventChain.catch(() => undefined);
      const code =
        error instanceof Error && error.message.startsWith("PI_UNKNOWN_EVENT_TYPE:")
          ? "PI_UNKNOWN_EVENT_TYPE"
          : "PI_RUNTIME_ERROR";
      emit(runtimeFailure(request, this.now(), code));
      this.#activeSessions.delete(request.runId);
    }
  }

  private createTool(request: RuntimeRequest, descriptor: RuntimeToolDescriptor): ToolDefinition {
    return {
      name: descriptor.name,
      label: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.parameters as ToolDefinition["parameters"],
      executionMode: "sequential",
      execute: async (toolCallId, parameters) => {
        const invocation: RuntimeToolInvocation = {
          runId: request.runId,
          toolCallId,
          capabilityRef: descriptor.capabilityRef,
          capabilityHandleRef: descriptor.capabilityHandleRef,
          arguments: safeArguments(parameters),
          dataClassification: request.dataClassification,
        };
        const decision = await this.#dependencies.tools.preflight(invocation);
        if (!decision.allowed) {
          return {
            content: [{ type: "text", text: `Blocked by product policy: ${decision.reasonCode}` }],
            details: {
              permissionDecisionRef: decision.permissionDecisionRef,
              reasonCode: decision.reasonCode,
            },
            isError: true,
          };
        }
        const result = await this.#dependencies.tools.execute(invocation);
        return {
          content: [{ type: "text", text: result.modelContent }],
          details: {
            resultRef: result.resultRef,
            errorCode: result.errorCode,
            externalActionId: result.externalActionId,
          },
          isError: result.outcome !== "succeeded",
        };
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
  ): Promise<{
    readonly events: readonly RuntimeEvent[];
    readonly settled: boolean;
    readonly failed: boolean;
    readonly aborted: boolean;
  }> {
    const now = this.now();
    const mapped: RuntimeEvent[] = [];
    switch (event.type) {
      case "agent_start":
        mapped.push({ type: "runtime.model_started", runId: request.runId, occurredAt: now });
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
        const payloadRef = await this.#dependencies.projection.capture({
          runId: request.runId,
          kind: "message",
          value: redactObservation(event.message),
          dataClassification: request.dataClassification,
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
            mapped.push(runtimeFailure(request, now, "PI_MODEL_ERROR"));
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
            arguments: event.args,
          }),
          dataClassification: request.dataClassification,
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
            result: event.result,
            isError: event.isError,
          }),
          dataClassification: request.dataClassification,
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
            dataClassification: request.dataClassification,
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

  private now(): string {
    return this.#dependencies.now?.() ?? new Date().toISOString();
  }
}
