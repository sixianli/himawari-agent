import type {
  AgentRuntimePort,
  RuntimeEvent,
  RuntimeProjectionPort,
  RuntimeRequest,
  RuntimeToolDescriptor,
  RuntimeToolInvocation,
  RuntimeToolPort,
} from "@himawari-agent/application/runtime-port";

type PiModel = unknown;
type PiModelRuntime = unknown;
type RuntimeTurnId = Extract<RuntimeEvent, { readonly type: "runtime.turn_completed" }>["turnId"];

interface PiSessionEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface PiSession {
  prompt(text: string, options: Readonly<Record<string, unknown>>): Promise<void>;
  waitForIdle(): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
}

interface PiSessionResult {
  readonly session: PiSession;
}

interface PiToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly executionMode: "sequential";
  execute(toolCallId: string, parameters: unknown): Promise<Readonly<Record<string, unknown>>>;
}

interface PiSdk {
  readonly createAgentSession: (
    options: Readonly<Record<string, unknown>>,
  ) => Promise<PiSessionResult>;
  readonly DefaultResourceLoader: new (
    options: Readonly<Record<string, unknown>>,
  ) => {
    reload(): Promise<void>;
  };
  readonly SessionManager: {
    inMemory(cwd: string, options: { readonly id: string }): unknown;
  };
  readonly SettingsManager: {
    inMemory(settings: unknown, options: { readonly projectTrusted: boolean }): unknown;
  };
}

interface PiExtensionApi {
  on(
    eventName: string,
    handler: (event: Readonly<Record<string, unknown>>) => Promise<unknown>,
  ): void;
}

async function loadPiSdk(): Promise<PiSdk> {
  const moduleSpecifier: string = "@earendil-works/pi-coding-agent";
  return (await import(moduleSpecifier)) as PiSdk;
}

export interface PiModelBinding {
  readonly model: PiModel;
  readonly modelRuntime: PiModelRuntime;
}

export interface PiModelBindingPort {
  resolve(modelRef: string): Promise<PiModelBinding>;
}

export interface PiAgentRuntimeAdapterDependencies {
  readonly projection: RuntimeProjectionPort;
  readonly tools: RuntimeToolPort;
  readonly models: PiModelBindingPort;
  readonly cwd: string;
  readonly agentDir?: string;
  readonly now?: () => string;
  readonly turnId?: (request: RuntimeRequest, turnIndex: number) => RuntimeTurnId;
  readonly createSession?: (options: Readonly<Record<string, unknown>>) => Promise<PiSessionResult>;
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

function asObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function read(value: unknown, key: string): unknown {
  return asObject(value)?.[key];
}

function roleOf(message: unknown): string {
  const role = read(message, "role");
  return typeof role === "string" ? role : "unknown";
}

function isAbortedMessage(message: unknown): boolean {
  return read(message, "stopReason") === "aborted";
}

function isErrorMessage(message: unknown): boolean {
  return read(message, "stopReason") === "error";
}

function safeArguments(value: unknown): RuntimeToolInvocation["arguments"] {
  const object = asObject(value);
  if (!object) return {};
  return object as RuntimeToolInvocation["arguments"];
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
      return url.toString();
    } catch {
      return value;
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

export class PiAgentRuntimeAdapter implements AgentRuntimePort {
  private readonly dependencies: PiAgentRuntimeAdapterDependencies;
  private readonly activeSessions = new Map<RuntimeRequest["runId"], PiSession>();
  private readonly cancelledRuns = new Set<RuntimeRequest["runId"]>();

  constructor(dependencies: PiAgentRuntimeAdapterDependencies) {
    this.dependencies = dependencies;
  }

  async *run(request: RuntimeRequest): AsyncIterable<RuntimeEvent> {
    if (this.cancelledRuns.has(request.runId)) {
      yield {
        type: "runtime.cancelled",
        runId: request.runId,
        reasonCode: "RUNTIME_CANCELLED",
        occurredAt: this.now(),
      };
      return;
    }

    const events: RuntimeEvent[] = [];
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
      const [binding, systemInstruction, messages, descriptors] = await Promise.all([
        this.dependencies.models.resolve(request.modelRef),
        this.dependencies.projection.resolveText(request.runId, request.systemInstructionRef),
        Promise.all(
          request.messageRefs.map((ref) =>
            this.dependencies.projection.resolveText(request.runId, ref),
          ),
        ),
        this.dependencies.tools.listAuthorized(request.runId, request.capabilityHandleRefs),
      ]);
      const descriptorsByName = new Map(
        descriptors.map((descriptor) => [descriptor.name, descriptor]),
      );
      const piSdk = await loadPiSdk();
      const settingsManager = piSdk.SettingsManager.inMemory(
        {
          compaction: { enabled: true },
          retry: { enabled: false, maxRetries: 0 },
          defaultTools: [],
        },
        { projectTrusted: false },
      );
      const resourceLoader = new piSdk.DefaultResourceLoader({
        cwd: this.dependencies.cwd,
        agentDir: this.dependencies.agentDir ?? this.dependencies.cwd,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: systemInstruction,
        extensionFactories: [
          {
            name: "himawari-provider-observer",
            hidden: true,
            factory: (pi: PiExtensionApi) => {
              pi.on("before_provider_request", async (event) => {
                const payloadRef = await this.dependencies.projection.capture({
                  runId: request.runId,
                  kind: "provider_request",
                  value: redactObservation(read(event, "payload")),
                  dataClassification: request.dataClassification,
                });
                await enqueue(() => {
                  events.push({
                    type: "runtime.provider_observation",
                    runId: request.runId,
                    phase: "request",
                    payloadRef,
                    occurredAt: this.now(),
                  });
                });
                return read(event, "payload");
              });
              pi.on("after_provider_response", async (event) => {
                const payloadRef = await this.dependencies.projection.capture({
                  runId: request.runId,
                  kind: "provider_response",
                  value: redactObservation({
                    status: read(event, "status"),
                    headers: read(event, "headers"),
                  }),
                  dataClassification: request.dataClassification,
                });
                await enqueue(() => {
                  events.push({
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

      const sessionFactory = this.dependencies.createSession ?? piSdk.createAgentSession;
      const created = await sessionFactory({
        cwd: this.dependencies.cwd,
        ...(this.dependencies.agentDir ? { agentDir: this.dependencies.agentDir } : {}),
        model: binding.model,
        modelRuntime: binding.modelRuntime,
        thinkingLevel: "off",
        noTools: "all",
        tools: descriptors.map(({ name }) => name),
        customTools: descriptors.map((descriptor) => this.createTool(request, descriptor)),
        resourceLoader,
        sessionManager: piSdk.SessionManager.inMemory(this.dependencies.cwd, {
          id: request.sessionId,
        }),
        settingsManager,
      });
      const session = created.session;
      this.activeSessions.set(request.runId, session);

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
          for (const mappedEvent of mapped.events) events.push(mappedEvent);
          settled ||= mapped.settled;
          failed ||= mapped.failed;
          aborted ||= mapped.aborted;
        });
      });

      try {
        await session.prompt(messages.join("\n\n"), {
          expandPromptTemplates: false,
          source: "extension",
        });
        await session.waitForIdle();
        await eventChain;
      } finally {
        unsubscribe();
        session.dispose();
        this.activeSessions.delete(request.runId);
      }

      if (this.cancelledRuns.has(request.runId) || aborted) {
        events.push({
          type: "runtime.cancelled",
          runId: request.runId,
          reasonCode: "PI_ABORTED",
          occurredAt: this.now(),
        });
      } else if (!failed && settled) {
        events.push({ type: "runtime.completed", runId: request.runId, occurredAt: this.now() });
      } else if (!failed) {
        events.push(runtimeFailure(request, this.now(), "PI_RUNTIME_DID_NOT_SETTLE"));
      }
    } catch (error) {
      await eventChain.catch(() => undefined);
      const code =
        error instanceof Error && error.message.startsWith("PI_UNKNOWN_EVENT_TYPE:")
          ? "PI_UNKNOWN_EVENT_TYPE"
          : "PI_RUNTIME_ERROR";
      events.push(runtimeFailure(request, this.now(), code));
      this.activeSessions.delete(request.runId);
    }

    for (const event of events) yield event;
  }

  async cancel(runId: RuntimeRequest["runId"]): Promise<void> {
    this.cancelledRuns.add(runId);
    const session = this.activeSessions.get(runId);
    if (session) await session.abort();
  }

  private createTool(request: RuntimeRequest, descriptor: RuntimeToolDescriptor): PiToolDefinition {
    return {
      name: descriptor.name,
      label: descriptor.name,
      description: descriptor.description,
      parameters: descriptor.parameters,
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
        const decision = await this.dependencies.tools.preflight(invocation);
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
        const result = await this.dependencies.tools.execute(invocation);
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
    event: PiSessionEvent,
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
      case "turn_start": {
        const turnIndex = nextTurnIndex();
        mapped.push({
          type: "runtime.turn_started",
          runId: request.runId,
          turnIndex,
          occurredAt: now,
        });
        break;
      }
      case "turn_end": {
        const turnIndex = currentTurnIndex();
        mapped.push({
          type: "runtime.turn_completed",
          runId: request.runId,
          turnId: this.turnId(request, turnIndex),
          occurredAt: now,
        });
        break;
      }
      case "message_start":
      case "message_update":
      case "message_end": {
        const payloadRef = await this.dependencies.projection.capture({
          runId: request.runId,
          kind: "message",
          value: redactObservation(read(event, "message")),
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
          role: roleOf(read(event, "message")),
          sequence,
          payloadRef,
          occurredAt: now,
        });
        if (event.type === "message_end" && roleOf(read(event, "message")) === "assistant") {
          mapped.push({
            type: "runtime.model_output",
            runId: request.runId,
            sequence,
            payloadRef,
            occurredAt: now,
          });
          if (isErrorMessage(read(event, "message"))) {
            mapped.push(runtimeFailure(request, now, "PI_MODEL_ERROR"));
          }
        }
        return {
          events: mapped,
          settled: false,
          failed: event.type === "message_end" && isErrorMessage(read(event, "message")),
          aborted: event.type === "message_end" && isAbortedMessage(read(event, "message")),
        };
      }
      case "tool_execution_start": {
        const rawToolName = read(event, "toolName");
        const toolName = typeof rawToolName === "string" ? rawToolName : "";
        const descriptor = descriptors.get(toolName);
        if (!descriptor) throw new Error(`PI_UNKNOWN_TOOL:${toolName}`);
        const payloadRef = await this.dependencies.projection.capture({
          runId: request.runId,
          kind: "tool_intent",
          value: redactObservation({
            toolCallId: read(event, "toolCallId"),
            arguments: read(event, "args"),
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
        const rawToolName = read(event, "toolName");
        const toolName = typeof rawToolName === "string" ? rawToolName : "";
        const descriptor = descriptors.get(toolName);
        if (!descriptor) throw new Error(`PI_UNKNOWN_TOOL:${toolName}`);
        const payloadRef = await this.dependencies.projection.capture({
          runId: request.runId,
          kind: "tool_result",
          value: redactObservation({
            toolCallId: read(event, "toolCallId"),
            result: read(event, "result"),
            isError: read(event, "isError"),
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
      case "compaction_end": {
        const result = asObject(read(event, "result"));
        if (result && read(event, "aborted") !== true) {
          const summary = read(result, "summary");
          const firstKeptEntryId = read(result, "firstKeptEntryId");
          const tokensBefore = read(result, "tokensBefore");
          if (
            typeof summary !== "string" ||
            typeof firstKeptEntryId !== "string" ||
            typeof tokensBefore !== "number"
          ) {
            throw new Error("PI_INVALID_COMPACTION_RESULT");
          }
          const proposalRef = await this.dependencies.projection.proposeCompaction({
            runId: request.runId,
            sessionId: request.sessionId,
            summary,
            firstKeptEntryId,
            tokensBefore,
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
      }
      default:
        if (!KNOWN_IGNORED_EVENTS.has(event.type)) {
          throw new Error(`PI_UNKNOWN_EVENT_TYPE:${event.type}`);
        }
    }
    return { events: mapped, settled: false, failed: false, aborted: false };
  }

  private turnId(request: RuntimeRequest, turnIndex: number): RuntimeTurnId {
    if (this.dependencies.turnId) return this.dependencies.turnId(request, turnIndex);
    return `${request.runId}:turn:${turnIndex}` as RuntimeTurnId;
  }

  private now(): string {
    return this.dependencies.now?.() ?? new Date().toISOString();
  }
}
