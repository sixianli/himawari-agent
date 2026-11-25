import { existsSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type TranscriptContext,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createBashToolDefinition,
  createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  ModelDescriptor,
  ModelInvocationAdmissionInput,
  ModelInvocationAdmissionPort,
  ModelInvocationExecutionContext,
  ModelInvocationIdentity,
  ModelInvocationPermit,
  ModelUsageObservation,
  RuntimeBackgroundCommandNotice,
  RuntimeEvent,
  RuntimeProjection,
  RuntimeProjectionPort,
  RuntimeRequest,
  RuntimeToolDescriptor,
  RuntimeToolExecutionResult,
  RuntimeToolPort,
} from "@himawari-agent/application/runtime-port";
import {
  CHAT_TOOL_LOOP_STOPPED,
  TOOL_BUILTIN_READ,
  TOOL_BUILTIN_READ_GUIDELINE,
} from "@himawari-agent/prompt-catalog";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PiAgentRuntimeAdapter,
  type PiAgentRuntimeAdapterDependencies,
  type PiModelBinding,
  type PiModelBindingPort,
} from "../src/index.js";
import { createFauxModelFixture } from "./faux-model-fixture.js";
import { testModelEgress } from "./helpers/model-egress.js";
import { requestContextFor } from "./request-head.ts";

const NOW = "2026-08-25T10:00:00.000Z";
type ProjectionContext = RuntimeProjection;

function fixtureIdentifier<T extends string>(value: string): T {
  return value as T;
}

function fixtureExecutionLease(): ModelInvocationExecutionContext["executionLease"] {
  const claim: ModelInvocationExecutionContext["executionLease"] = {
    executionLeaseId: fixtureIdentifier("execution-pi-runtime-test"),
    expectedLeaseRevision: 1,
    authorityLeaseId: fixtureIdentifier("authority-pi-runtime-test"),
    authorityFencingToken: 1,
    deploymentId: fixtureIdentifier("deployment-pi-runtime-test"),
    authorityEpoch: 1,
    fencingToken: 1,
    consumerId: "pi-runtime-test",
  };
  return Object.freeze(claim);
}

function fixtureAdmissionIdentity(
  scope: {
    readonly ownerId: RuntimeRequest["ownerId"];
    readonly agentId: RuntimeRequest["agentId"];
    readonly runId: RuntimeRequest["runId"];
  },
  input: ModelInvocationAdmissionInput,
  executionLease: ModelInvocationExecutionContext["executionLease"],
): ModelInvocationIdentity {
  return Object.freeze({
    ownerId: scope.ownerId,
    agentId: scope.agentId,
    runId: scope.runId,
    logicalSlot: input.logicalSlot,
    sequence: 1,
    invocationId: "invocation-pi-runtime-test",
    modelRef: input.modelRef,
    provider: input.provider,
    model: input.model,
    modelVersion: input.modelVersion,
    dataClassification: input.dataClassification,
    source: input.source,
    ordinal: input.ordinal,
    pricing: Object.freeze({ ...input.pricing }),
    pricingFingerprint: "fixture-pricing",
    estimatedCostMicros: input.estimatedCostMicros,
    budgetAccountId: "account-pi-runtime-test",
    budgetOperationKey: input.logicalSlot,
    authority: Object.freeze({
      deploymentId: executionLease.deploymentId,
      authorityEpoch: executionLease.authorityEpoch,
      fencingToken: executionLease.fencingToken,
    }),
    authorityLease: Object.freeze({
      leaseId: executionLease.authorityLeaseId,
      fencingToken: executionLease.authorityFencingToken,
    }),
    executionLease,
    status: "reserved",
    reservedAt: NOW,
    startedAt: null,
    observedAt: null,
    settledAt: null,
    releasedAt: null,
    actualCostMicros: null,
    reasonCode: null,
  });
}

function allowAdmission(
  scope: {
    readonly ownerId: RuntimeRequest["ownerId"];
    readonly agentId: RuntimeRequest["agentId"];
    readonly runId: RuntimeRequest["runId"];
    readonly executionLease?: ModelInvocationExecutionContext["executionLease"];
  },
  executionLease = scope.executionLease,
  permit: ModelInvocationPermit = {
    assertActive: async () => undefined,
    markStarted: async () => undefined,
    releaseReserved: async () => undefined,
    settle: async () => undefined,
    markUnknown: async () => undefined,
  },
): ModelInvocationAdmissionPort {
  if (!executionLease) throw new Error("Missing runtime execution lease claim");
  return {
    context: {
      ownerId: scope.ownerId,
      agentId: scope.agentId,
      runId: scope.runId,
      executionLease,
    },
    begin: async (input) => ({
      disposition: "fresh",
      identity: fixtureAdmissionIdentity(scope, input, executionLease),
      permit,
    }),
  };
}

const ADMISSION_MODEL: Model<Api> = {
  id: "admission-fixture-model",
  name: "Admission fixture model",
  api: "faux",
  provider: "admission-fixture-provider",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16384,
  maxTokens: 128,
};

const ADMISSION_DESCRIPTOR: ModelDescriptor = {
  ref: "model-faux-task-11",
  provider: ADMISSION_MODEL.provider,
  model: ADMISSION_MODEL.id,
  version: "admission-fixture-1",
  routingClass: "local",
  priority: 1,
  disclosure: "local_only",
  capabilities: ["text"],
  allowedDataClassifications: ["private"],
  secretRequirement: null,
};

function assistantAnswer(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "admitted answer" }],
    api: ADMISSION_MODEL.api,
    provider: ADMISSION_MODEL.provider,
    model: ADMISSION_MODEL.id,
    usage: {
      input: 4,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 7,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function streamingSessionFactory(
  _original: (
    model: Model<Api>,
    context: unknown,
    options?: unknown,
  ) => AssistantMessageEventStream,
  observedTerminals: string[],
  streamModel: Model<Api> = ADMISSION_MODEL,
  streamOptions: unknown = {},
  shapeContext: (head: TranscriptContext) => unknown = (head) => head,
) {
  return async (rawOptions: Readonly<Record<string, unknown>>) => {
    const governed = rawOptions["modelRuntime"] as {
      streamSimple: (
        model: Model<Api>,
        context: unknown,
        options?: unknown,
      ) => AssistantMessageEventStream;
    };
    let listener: (event: FakePiEvent) => void = () => undefined;
    const session = {
      agent: {},
      subscribe(next: (event: FakePiEvent) => void) {
        listener = next;
        return () => {
          listener = () => undefined;
        };
      },
      async prompt() {
        const response = governed.streamSimple(
          streamModel,
          shapeContext(await requestContextFor(rawOptions)),
          streamOptions,
        );
        for await (const event of response) {
          if (event.type === "done") {
            observedTerminals.push("done");
            listener({ type: "message_end", message: event.message });
          } else if (event.type === "error") {
            observedTerminals.push("error");
            listener({ type: "message_end", message: event.error });
          }
        }
        listener({ type: "agent_settled" });
      },
      async waitForIdle() {},
      async abort() {},
      dispose() {},
    };
    return { session };
  };
}

const ONE_PIXEL_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function lastOwnerWords(messages: readonly unknown[]): string | undefined {
  const last = messages.at(-1) as { role?: string; content?: { type: string; text?: string }[] };
  if (last?.role !== "user") return undefined;
  const text = last.content?.find((part) => part.type === "text")?.text ?? "";
  return /<owner-message>\n([\s\S]*)\n<\/owner-message>$/.exec(text)?.[1];
}

const DEFAULT_CONTEXT: ProjectionContext = {
  systemInstruction: "You are a controlled restaurant assistant.",
  history: [
    {
      id: "message-history-user-task-11",
      role: "user",
      content: [{ type: "text", text: "Earlier request." }],
      occurredAt: NOW,
    },
    {
      id: "message-history-assistant-task-11",
      role: "assistant",
      content: [{ type: "text", text: "Earlier answer." }],
      occurredAt: NOW,
    },
  ],
  prompt: {
    id: "message-prompt-task-11",
    content: "Find a beef restaurant.",
    occurredAt: NOW,
  },
  contextBlocks: [],
};

const request = {
  ownerId: "owner-task-11",
  agentId: "agent-task-11",
  runId: "run-task-11",
  executionLease: fixtureExecutionLease(),
  sessionId: "session-task-11",
  threadId: "thread-task-11",
  modelRef: "model-faux-task-11",
  systemInstructionRef: "payload-system-task-11",
  contextEnvelopeRef: "payload-context-task-11",
  workerResultRefs: [],
  capabilityHandleRefs: ["handle-restaurant-task-11"],
  budget: { maxTurns: 3 },
  correlationId: "correlation-task-11",
  dataClassification: "private",
} as unknown as RuntimeRequest;

function expectLoopStoppedByAppendedMessage(
  observed: readonly unknown[],
  { sameSystemPrompt = true }: { readonly sameSystemPrompt?: boolean } = {},
) {
  const contexts = observed as readonly {
    tools: unknown[];
    systemPrompt: string;
    messages: unknown[];
  }[];
  const first = contexts[0];
  const last = contexts.at(-1);
  if (!first || !last) throw new Error("no model request observed");
  expect(last.tools.length).toBeGreaterThan(0);
  expect(JSON.stringify(last.tools)).toBe(JSON.stringify(first.tools));
  if (sameSystemPrompt) expect(last.systemPrompt).toBe(first.systemPrompt);
  expect(last.systemPrompt).not.toContain(CHAT_TOOL_LOOP_STOPPED.text);
  expect(JSON.stringify(last.messages.at(-1))).toContain(CHAT_TOOL_LOOP_STOPPED.text);
  expect((last.messages.at(-1) as { role: string }).role).toBe("user");
}

class RecordingProjection implements RuntimeProjectionPort {
  readonly finalAnswers: Parameters<RuntimeProjectionPort["captureFinalAnswer"]>[0][] = [];
  readonly captures: unknown[] = [];
  readonly compactions: unknown[] = [];
  readonly context: ProjectionContext;

  constructor(context: ProjectionContext = DEFAULT_CONTEXT) {
    this.context = context;
  }

  async resolveProjection(): Promise<ProjectionContext> {
    return this.context;
  }

  async capture(input: Parameters<RuntimeProjectionPort["capture"]>[0]): Promise<string> {
    await Promise.resolve();
    this.captures.push(input);
    return `captured-${this.captures.length}`;
  }

  async captureFinalAnswer(
    input: Parameters<RuntimeProjectionPort["captureFinalAnswer"]>[0],
  ): Promise<string> {
    this.finalAnswers.push(input);
    return `final-answer-${this.finalAnswers.length}`;
  }

  async proposeCompaction(
    input: Parameters<RuntimeProjectionPort["proposeCompaction"]>[0],
  ): Promise<string> {
    this.compactions.push(input);
    return "compaction-proposal-task-11";
  }
}

class HistoryRecordingProjection extends RecordingProjection {
  readonly histories: unknown[] = [];

  async captureHistory(input: { runId: string; messages: readonly unknown[] }) {
    this.histories.push(structuredClone(input.messages));
    return {
      runId: input.runId as RuntimeRequest["runId"],
      operationKey: `history:${this.histories.length}`,
      payloadRef: `history:${this.histories.length}`,
      dataClassification: "private" as const,
    };
  }
}

class RecordingRuntimeTools implements RuntimeToolPort {
  readonly preflight = vi.fn(async () => ({
    allowed: true,
    permissionDecisionRef: "permission-task-11",
    reasonCode: "grant_allows",
  }));
  readonly execute = vi.fn(
    async (
      _invocation: Parameters<RuntimeToolPort["execute"]>[0],
    ): Promise<RuntimeToolExecutionResult> => ({
      outcome: "succeeded" as const,
      resultRef: "payload-tool-result-task-11",
      errorCode: null,
      externalActionId: null,
      modelContent: "Found one governed result.",
    }),
  );

  async listAuthorized(): Promise<readonly RuntimeToolDescriptor[]> {
    return [
      {
        capabilityRef: "restaurant-search",
        capabilityHandleRef: "handle-restaurant-task-11",
        name: "restaurant_search",
        description: "Search deterministic restaurant fixtures",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
      },
    ];
  }
}

interface FakeSessionOptions {
  readonly thinkingLevel?: string;
  readonly customTools?: readonly {
    readonly name: string;
    readonly description: string;
    readonly parameters: ReturnType<typeof createReadToolDefinition>["parameters"];
    execute(toolCallId: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
  }[];
  readonly noTools?: string;
  readonly tools?: readonly string[];
  readonly sessionManager?: {
    readonly getSessionId?: () => string;
    readonly getEntries?: () => readonly unknown[];
  };
}

type FakePiEvent = Readonly<Record<string, unknown>> & { readonly type: string };

function fakeSessionFactory(
  script: (emit: (event: FakePiEvent) => void, options: FakeSessionOptions) => Promise<void> | void,
  observedOptions: FakeSessionOptions[] = [],
) {
  return async (rawOptions: Readonly<Record<string, unknown>>) => {
    const options = rawOptions as FakeSessionOptions;
    observedOptions.push(options);
    let listener: (event: FakePiEvent) => void = () => undefined;
    let idle = Promise.resolve();
    return {
      session: {
        get messages() {
          return this.agent.state.messages;
        },
        agent: {
          state: { messages: [] },
          abort() {},
        },
        subscribe(next: (event: FakePiEvent) => void) {
          listener = next;
          return () => {
            listener = () => undefined;
          };
        },
        async prompt() {
          idle = Promise.resolve(script((event) => listener(event), options));
          await idle;
        },
        async waitForIdle() {
          await idle;
        },
        async abort() {
          listener({
            type: "message_end",
            message: { role: "assistant", content: [], stopReason: "aborted" },
          });
          listener({ type: "agent_end", messages: [] });
          listener({ type: "agent_settled" });
        },
        dispose() {},
      },
    };
  };
}

async function collect(iterable: AsyncIterable<RuntimeEvent>): Promise<readonly RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function resolvePiAiEntry(piEntry: string): string {
  const packageRoot = dirname(dirname(piEntry));
  let cursor = packageRoot;
  while (true) {
    const candidate = join(cursor, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("Unable to resolve Pi's matching pi-ai package");
    cursor = parent;
  }
}

function createAdapter(
  projection: RecordingProjection,
  tools: RecordingRuntimeTools,
  createSession: ReturnType<typeof fakeSessionFactory>,
  model: Partial<Model<Api>> = {},
  now: () => string = () => NOW,
  onToolCallStarted?: PiAgentRuntimeAdapterDependencies["onToolCallStarted"],
  onModelStreamFailed?: PiAgentRuntimeAdapterDependencies["onModelStreamFailed"],
  onAssistantText?: PiAgentRuntimeAdapterDependencies["onAssistantText"],
) {
  return new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    ...(onToolCallStarted ? { onToolCallStarted } : {}),
    ...(onAssistantText ? { onAssistantText } : {}),
    ...(onModelStreamFailed ? { onModelStreamFailed } : {}),
    projection,
    tools,
    models: {
      resolve: async () => ({ model, modelRuntime: {} }) as unknown as PiModelBinding,
    },
    cwd: process.cwd(),
    now,
    logicalSlot: (request, ordinal) => `${request.runId}:compat:${ordinal}`,
    turnId: (_request, turnIndex) => `turn-task-11-${turnIndex}` as never,
    createSession: createSession as unknown as NonNullable<
      PiAgentRuntimeAdapterDependencies["createSession"]
    >,
  });
}

function createAdmissionAdapter(
  permit: ModelInvocationPermit,
  original: (model: Model<Api>, context: unknown, options?: unknown) => AssistantMessageEventStream,
  observedTerminals: string[],
  streamModel: Model<Api> = ADMISSION_MODEL,
  streamOptions: unknown = {},
  resolveSecret?: () => Promise<string>,
  admissionExecutionLease?: ModelInvocationExecutionContext["executionLease"],
  usage?: PiAgentRuntimeAdapterDependencies["usage"],
  shapeContext?: (head: TranscriptContext) => unknown,
) {
  const createSession = streamingSessionFactory(
    original,
    observedTerminals,
    streamModel,
    streamOptions,
    shapeContext,
  );
  return new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection: new RecordingProjection(),
    tools: new RecordingRuntimeTools(),
    models: {
      resolve: async () => ({
        model: ADMISSION_MODEL,
        modelRuntime: {
          streamSimple: original,
        } as unknown as PiModelBinding["modelRuntime"],
        descriptor:
          resolveSecret === undefined
            ? ADMISSION_DESCRIPTOR
            : {
                ...ADMISSION_DESCRIPTOR,
                secretRequirement: {
                  secretRef: "admission-fixture-secret",
                  secretVersion: "v1",
                  purpose: "model-provider-auth",
                },
              },
        admissionCost: {
          pricing: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
          estimatedCostMicros: 10,
        },
        ...(resolveSecret === undefined ? {} : { resolveSecret }),
      }),
    },
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope, admissionExecutionLease, permit),
    ...(usage === undefined ? {} : { usage }),
    logicalSlot: (runtimeRequest, ordinal) =>
      `${runtimeRequest.runId}:admission-fixture:${ordinal}`,
    createSession: createSession as unknown as NonNullable<
      PiAgentRuntimeAdapterDependencies["createSession"]
    >,
  });
}

function successfulOriginal(): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message = assistantAnswer();
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: "stop", message });
  return stream;
}

function invalidUsageOriginal(): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const message = assistantAnswer();
  const invalidMessage: AssistantMessage = {
    ...message,
    usage: { ...message.usage, cacheRead: -1 },
  };
  stream.push({ type: "start", partial: invalidMessage });
  stream.push({ type: "done", reason: "stop", message: invalidMessage });
  return stream;
}

describe("Pi stream admission accounting", () => {
  it("rejects a same-provider and same-model clone before the provider stream", async () => {
    const observedTerminals: string[] = [];
    let providerCalls = 0;
    const permit: ModelInvocationPermit = {
      assertActive: async () => undefined,
      markStarted: async () => undefined,
      releaseReserved: async () => undefined,
      settle: async () => undefined,
      markUnknown: async () => undefined,
    };
    const sameIdentityClone = { ...ADMISSION_MODEL };
    const adapter = createAdmissionAdapter(
      permit,
      () => {
        providerCalls += 1;
        return successfulOriginal();
      },
      observedTerminals,
      sameIdentityClone,
    );

    const events = await collect(adapter.run(request));
    expect(providerCalls).toBe(0);
    expect(observedTerminals).toEqual(["error"]);
    expect(events.at(-1)).toMatchObject({ type: "runtime.failed" });
  });

  it.each([
    [
      "a leading system message whose prompt is not the frozen one",
      (head: TranscriptContext) => ({
        ...head,
        messages: [
          { ...(head.messages[0] as object), content: "Pi's own system prompt" },
          ...head.messages.slice(1),
        ],
      }),
    ],
    [
      "no leading system message",
      (head: TranscriptContext) => ({ ...head, messages: head.messages.slice(1) }),
    ],
    [
      "a second system message after the head",
      (head: TranscriptContext) => ({
        ...head,
        messages: [...head.messages, { role: "system", content: "late" }],
      }),
    ],
  ])("refuses to send a request with %s", async (_name, shape) => {
    const observedTerminals: string[] = [];
    let providerCalls = 0;
    const permit: ModelInvocationPermit = {
      assertActive: async () => undefined,
      markStarted: async () => undefined,
      releaseReserved: async () => undefined,
      settle: async () => undefined,
      markUnknown: async () => undefined,
    };
    const adapter = createAdmissionAdapter(
      permit,
      () => {
        providerCalls += 1;
        return successfulOriginal();
      },
      observedTerminals,
      ADMISSION_MODEL,
      {},
      undefined,
      undefined,
      undefined,
      shape,
    );

    const events = await collect(adapter.run(request));
    expect(providerCalls).toBe(0);
    expect(observedTerminals).toEqual(["error"]);
    expect(events.at(-1)).toMatchObject({ type: "runtime.failed" });
  });

  it("sends the request when the leading system message is the frozen head", async () => {
    const observedTerminals: string[] = [];
    let providerCalls = 0;
    const permit: ModelInvocationPermit = {
      assertActive: async () => undefined,
      markStarted: async () => undefined,
      releaseReserved: async () => undefined,
      settle: async () => undefined,
      markUnknown: async () => undefined,
    };
    const adapter = createAdmissionAdapter(
      permit,
      () => {
        providerCalls += 1;
        return successfulOriginal();
      },
      observedTerminals,
    );

    await collect(adapter.run(request));
    expect(providerCalls).toBe(1);
    expect(observedTerminals).toEqual(["done"]);
  });

  it("rejects an admission gate bound to a different execution lease", async () => {
    const observedTerminals: string[] = [];
    let providerCalls = 0;
    const permit: ModelInvocationPermit = {
      assertActive: async () => undefined,
      markStarted: async () => undefined,
      releaseReserved: async () => undefined,
      settle: async () => undefined,
      markUnknown: async () => undefined,
    };
    const mismatchedClaim: ModelInvocationExecutionContext["executionLease"] = {
      ...request.executionLease,
      executionLeaseId: fixtureIdentifier("execution-pi-runtime-other"),
    };
    const adapter = createAdmissionAdapter(
      permit,
      () => {
        providerCalls += 1;
        return successfulOriginal();
      },
      observedTerminals,
      ADMISSION_MODEL,
      {},
      undefined,
      Object.freeze(mismatchedClaim),
    );

    const events = await collect(adapter.run(request));
    expect(providerCalls).toBe(0);
    expect(observedTerminals).toEqual(["error"]);
    expect(events.at(-1)).toMatchObject({ type: "runtime.failed" });
  });

  it("records one chat usage observation after durable settlement", async () => {
    const order: string[] = [];
    const observations: ModelUsageObservation[] = [];
    const permit: ModelInvocationPermit = {
      assertActive: async () => undefined,
      markStarted: async () => undefined,
      releaseReserved: async () => undefined,
      settle: async () => {
        order.push("settle");
      },
      markUnknown: async () => undefined,
    };
    const adapter = createAdmissionAdapter(
      permit,
      successfulOriginal,
      [],
      ADMISSION_MODEL,
      {},
      undefined,
      undefined,
      {
        store: {
          record: async (observation) => {
            order.push("record");
            observations.push(observation);
          },
        },
        onFailure: () => undefined,
      },
    );

    const events = await collect(adapter.run(request));

    expect(events.at(-1)?.type).toBe("runtime.completed");
    expect(order).toEqual(["settle", "record"]);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      purpose: "chat",
      source: "agent-stream",
      cacheReported: false,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("completes the run when recording the usage observation fails", async () => {
    const failures: unknown[] = [];
    const permit: ModelInvocationPermit = {
      assertActive: async () => undefined,
      markStarted: async () => undefined,
      releaseReserved: async () => undefined,
      settle: async () => undefined,
      markUnknown: async () => undefined,
    };
    const adapter = createAdmissionAdapter(
      permit,
      successfulOriginal,
      [],
      ADMISSION_MODEL,
      {},
      undefined,
      undefined,
      {
        store: {
          record: async () => {
            throw new Error("disk full");
          },
        },
        onFailure: (error) => failures.push(error),
      },
    );

    const events = await collect(adapter.run(request));

    expect(events.at(-1)?.type).toBe("runtime.completed");
    expect(failures).toHaveLength(1);
  });

  it("does not expose done until durable settlement resolves", async () => {
    let releaseSettlement!: () => void;
    const settlementReleased = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    let settlementEntered!: () => void;
    const settlementStarted = new Promise<void>((resolve) => {
      settlementEntered = resolve;
    });
    const observedTerminals: string[] = [];
    const permit: ModelInvocationPermit = {
      assertActive: async () => undefined,
      markStarted: async () => undefined,
      releaseReserved: async () => undefined,
      settle: async () => {
        settlementEntered();
        await settlementReleased;
      },
      markUnknown: async () => undefined,
    };
    const adapter = createAdmissionAdapter(permit, successfulOriginal, observedTerminals);
    const run = collect(adapter.run(request));

    await settlementStarted;
    expect(observedTerminals).toEqual([]);
    releaseSettlement();
    const events = await run;
    expect(observedTerminals).toEqual(["done"]);
    expect(events.at(-1)?.type).toBe("runtime.completed");
  });

  it("does not expose provider success when settlement fails", async () => {
    const observedTerminals: string[] = [];
    const unknown: string[] = [];
    const permit: ModelInvocationPermit = {
      assertActive: async () => undefined,
      markStarted: async () => undefined,
      releaseReserved: async () => undefined,
      settle: async () => {
        throw new Error("durable settlement failed");
      },
      markUnknown: async (reasonCode) => {
        unknown.push(reasonCode);
      },
    };
    const adapter = createAdmissionAdapter(permit, successfulOriginal, observedTerminals);

    const events = await collect(adapter.run(request));
    expect(observedTerminals).toEqual(["error"]);
    expect(unknown).toEqual(["transport_unresolved"]);
    expect(events.at(-1)).toMatchObject({ type: "runtime.failed" });
    expect(events.some(({ type }) => type === "runtime.completed")).toBe(false);
  });

  it("does not expose done or runtime success when terminal usage is invalid", async () => {
    const observedTerminals: string[] = [];
    let providerCalls = 0;
    const unknown: string[] = [];
    const permit: ModelInvocationPermit = {
      assertActive: async () => undefined,
      markStarted: async () => undefined,
      releaseReserved: async () => undefined,
      settle: async () => {
        throw new Error("settle must not run for invalid usage");
      },
      markUnknown: async (reasonCode) => {
        unknown.push(reasonCode);
      },
    };
    const adapter = createAdmissionAdapter(
      permit,
      () => {
        providerCalls += 1;
        return invalidUsageOriginal();
      },
      observedTerminals,
    );

    const events = await collect(adapter.run(request));
    expect(providerCalls).toBe(1);
    expect(unknown).toEqual(["provider_unresolved"]);
    expect(observedTerminals).toEqual(["error"]);
    expect(events.some(({ type }) => type === "runtime.completed")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "runtime.failed" });
  });

  it("releases a reservation when the lease fails before the provider stream", async () => {
    const observedTerminals: string[] = [];
    let providerCalls = 0;
    let releases = 0;
    const permit: ModelInvocationPermit = {
      assertActive: async () => {
        throw new Error("execution lease expired");
      },
      markStarted: async () => {
        throw new Error("markStarted must not run");
      },
      releaseReserved: async () => {
        releases += 1;
      },
      settle: async () => {
        throw new Error("settle must not run");
      },
      markUnknown: async () => {
        throw new Error("unknown must not run while reservation is released");
      },
    };
    const adapter = createAdmissionAdapter(
      permit,
      () => {
        providerCalls += 1;
        return successfulOriginal();
      },
      observedTerminals,
    );

    const events = await collect(adapter.run(request));
    expect(releases).toBe(1);
    expect(providerCalls).toBe(0);
    expect(observedTerminals).toEqual(["error"]);
    expect(events.at(-1)).toMatchObject({ type: "runtime.failed" });
  });

  it("fails with a context window code instead of requesting a clamped one-token answer", async () => {
    const observedTerminals: string[] = [];
    let providerCalls = 0;
    const permit: ModelInvocationPermit = {
      assertActive: async () => {
        throw new Error("admission must not run");
      },
      markStarted: async () => {
        throw new Error("markStarted must not run");
      },
      releaseReserved: async () => {
        throw new Error("release must not run");
      },
      settle: async () => {
        throw new Error("settle must not run");
      },
      markUnknown: async () => {
        throw new Error("unknown must not run");
      },
    };
    const adapter = createAdmissionAdapter(
      permit,
      () => {
        providerCalls += 1;
        return successfulOriginal();
      },
      observedTerminals,
      { ...ADMISSION_MODEL, contextWindow: 4096 },
    );

    const events = await collect(adapter.run(request));
    expect(providerCalls).toBe(0);
    expect(observedTerminals).toEqual(["error"]);
    expect(events.at(-1)).toMatchObject({
      type: "runtime.failed",
      errorCode: "PI_CONTEXT_WINDOW_EXHAUSTED",
    });
  });

  it("releases a reservation when the Pi stream is already aborted before start", async () => {
    const observedTerminals: string[] = [];
    const controller = new AbortController();
    controller.abort();
    let providerCalls = 0;
    let releases = 0;
    const permit: ModelInvocationPermit = {
      assertActive: async () => undefined,
      markStarted: async () => {
        throw new Error("markStarted must not run");
      },
      releaseReserved: async () => {
        releases += 1;
      },
      settle: async () => {
        throw new Error("settle must not run");
      },
      markUnknown: async () => {
        throw new Error("unknown must not run while reservation is released");
      },
    };
    const adapter = createAdmissionAdapter(
      permit,
      () => {
        providerCalls += 1;
        return successfulOriginal();
      },
      observedTerminals,
      ADMISSION_MODEL,
      { signal: controller.signal },
    );

    const events = await collect(adapter.run(request));
    expect(releases).toBe(1);
    expect(providerCalls).toBe(0);
    expect(observedTerminals).toEqual(["error"]);
    expect(events.at(-1)).toMatchObject({ type: "runtime.failed" });
  });

  it("releases a reservation when deferred secret resolution fails", async () => {
    const observedTerminals: string[] = [];
    let providerCalls = 0;
    let releases = 0;
    const permit: ModelInvocationPermit = {
      assertActive: async () => undefined,
      markStarted: async () => {
        throw new Error("markStarted must not run");
      },
      releaseReserved: async () => {
        releases += 1;
      },
      settle: async () => {
        throw new Error("settle must not run");
      },
      markUnknown: async () => {
        throw new Error("unknown must not run while reservation is released");
      },
    };
    const adapter = createAdmissionAdapter(
      permit,
      () => {
        providerCalls += 1;
        return successfulOriginal();
      },
      observedTerminals,
      ADMISSION_MODEL,
      {},
      async () => {
        throw new Error("secret source unavailable");
      },
    );

    const events = await collect(adapter.run(request));
    expect(releases).toBe(1);
    expect(providerCalls).toBe(0);
    expect(observedTerminals).toEqual(["error"]);
    expect(events.at(-1)).toMatchObject({ type: "runtime.failed" });
  });

  it("surfaces an error when unknown accounting cannot be persisted", async () => {
    const observedTerminals: string[] = [];
    const permit: ModelInvocationPermit = {
      assertActive: async () => undefined,
      markStarted: async () => undefined,
      releaseReserved: async () => undefined,
      settle: async () => undefined,
      markUnknown: async () => {
        throw new Error("durable unknown write failed");
      },
    };
    const noTerminalOriginal = () => {
      const stream = createAssistantMessageEventStream();
      stream.end();
      return stream;
    };
    const adapter = createAdmissionAdapter(permit, noTerminalOriginal, observedTerminals);

    const events = await collect(adapter.run(request));
    expect(observedTerminals).toEqual(["error"]);
    expect(events.at(-1)).toMatchObject({ type: "runtime.failed" });
  });
});

describe("Pi Agent Runtime adapter compatibility", () => {
  it("passes the Run-frozen supported thinking level to Pi", async () => {
    let observed: string | undefined;
    const adapter = createAdapter(
      new RecordingProjection(),
      new RecordingRuntimeTools(),
      fakeSessionFactory(async (emit, options) => {
        observed = options.thinkingLevel;
        emit({ type: "agent_start" });
        emit({ type: "agent_settled" });
      }),
      { ...ADMISSION_MODEL, reasoning: true },
    );
    const events = await collect(adapter.run({ ...request, thinkingLevel: "high" }));
    expect(observed).toBe("high");
    expect(events[0]).toMatchObject({
      type: "runtime.model_started",
      modelRef: request.modelRef,
      thinkingLevel: "high",
    });
  });
  it("rejects a thinking level unsupported by the resolved Pi model before creating a session", async () => {
    const factory = vi.fn(fakeSessionFactory(async () => {}));
    const adapter = createAdapter(
      new RecordingProjection(),
      new RecordingRuntimeTools(),
      factory,
      ADMISSION_MODEL,
    );
    const events = await collect(adapter.run({ ...request, thinkingLevel: "high" }));
    expect(factory).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "runtime.failed" });
  });

  it.each(["unknown", "throw"] as const)(
    "never completes a Run after unresolved tool execution (%s) even if Pi supplies a final answer",
    async (mode) => {
      const projection = new RecordingProjection();
      const tools = new RecordingRuntimeTools();
      tools.execute.mockResolvedValue({
        outcome: "result_unknown",
        resultRef: null,
        errorCode: null,
        externalActionId: "external:unknown",
        modelContent: "Result unknown",
      });
      if (mode === "throw") tools.execute.mockRejectedValue(new Error("private transport error"));
      const adapter = createAdapter(
        projection,
        tools,
        fakeSessionFactory(async (emit, options) => {
          await options.customTools?.[0]?.execute("unknown-call", { query: "beef" });
          await expect(
            options.customTools?.[0]?.execute("second-call", { query: "beef" }),
          ).rejects.toThrow("RUNTIME_TOOL_RECONCILIATION_REQUIRED");
          emit({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "Done" }],
            },
          });
          emit({ type: "agent_settled" });
        }),
      );
      const events = await collect(adapter.run(request));
      expect(events.map((event) => event.type)).not.toContain("runtime.completed");
      expect(events.at(-1)).toMatchObject({
        type: "runtime.result_unknown",
        toolCallId: "unknown-call",
        externalActionId: mode === "unknown" ? "external:unknown" : null,
      });
      expect(projection.finalAnswers).toHaveLength(0);
      expect(tools.execute).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(events)).not.toContain("private transport error");
    },
  );

  afterEach(() => vi.restoreAllMocks());

  it.each([
    { stopReason: "length", text: "truncated", code: "PI_FINAL_ANSWER_INCOMPLETE" },
    {
      stopReason: "length",
      text: "truncated",
      usage: { output: 2048 },
      code: "PI_FINAL_ANSWER_INCOMPLETE",
    },
    {
      stopReason: "length",
      text: "x",
      usage: { output: 1 },
      code: "PI_CONTEXT_WINDOW_EXHAUSTED",
    },
    { stopReason: "stop", text: "   ", code: "PI_FINAL_ANSWER_EMPTY" },
  ])(
    "fails incomplete final output: $stopReason $text",
    async ({ stopReason, text, usage, code }) => {
      const projection = new RecordingProjection();
      const adapter = createAdapter(
        projection,
        new RecordingRuntimeTools(),
        fakeSessionFactory((emit) => {
          emit({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason,
              content: [{ type: "text", text }],
              ...(usage ? { usage } : {}),
            },
          });
          emit({ type: "agent_settled" });
        }),
      );
      expect((await collect(adapter.run(request))).at(-1)).toMatchObject({
        type: "runtime.failed",
        errorCode: code,
      });
      expect(projection.finalAnswers).toEqual([]);
    },
  );

  it("fails a final message that still carries a tool call", async () => {
    const projection = new RecordingProjection();
    const adapter = createAdapter(
      projection,
      new RecordingRuntimeTools(),
      fakeSessionFactory((emit) => {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "toolUse",
            content: [
              { type: "text", text: "pending tool" },
              { type: "toolCall", id: "call-1", name: "web_search", arguments: {} },
            ],
          },
        });
        emit({ type: "agent_settled" });
      }),
    );
    expect((await collect(adapter.run(request))).at(-1)).toMatchObject({
      type: "runtime.failed",
      errorCode: "PI_FINAL_ANSWER_INCOMPLETE",
    });
    expect(projection.finalAnswers).toEqual([]);
  });

  it("[I-70] completes when the provider reports toolUse but sent only text and no tool call", async () => {
    const projection = new RecordingProjection();
    const adapter = createAdapter(
      projection,
      new RecordingRuntimeTools(),
      fakeSessionFactory((emit) => {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "toolUse",
            content: [
              { type: "thinking", thinking: "想一下" },
              { type: "text", text: "东京今天晴，21°C。" },
            ],
          },
        });
        emit({ type: "agent_settled" });
      }),
    );
    expect((await collect(adapter.run(request))).at(-1)).toMatchObject({
      type: "runtime.completed",
      output: { kind: "assistant-answer" },
    });
    expect(projection.finalAnswers[0]?.text).toBe("东京今天晴，21°C。");
  });

  it("captures final plain text separately and excludes machine secrets across text parts", async () => {
    const projection = new RecordingProjection();
    const secret = ["sk-", "a".repeat(40)];
    const adapter = createAdapter(
      projection,
      new RecordingRuntimeTools(),
      fakeSessionFactory((emit) => {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [
              { type: "text", text: `回答。\n${secret[0]}` },
              { type: "text", text: secret[1] },
            ],
          },
        });
        emit({ type: "agent_settled" });
      }),
    );
    expect((await collect(adapter.run(request))).at(-1)).toMatchObject({
      type: "runtime.completed",
      output: { kind: "assistant-answer", contentRef: "final-answer-1" },
    });
    expect(projection.finalAnswers[0]?.text).toContain("回答。\n");
    expect(projection.finalAnswers[0]?.text).not.toContain(secret.join(""));
    expect(projection.finalAnswers[0]?.text.startsWith('"')).toBe(false);
  });

  it("coalesces pending Pi snapshots without losing boundaries or retaining mutable messages", async () => {
    const projection = new RecordingProjection();
    const adapter = createAdapter(
      projection,
      new RecordingRuntimeTools(),
      fakeSessionFactory((emit) => {
        const block = { type: "text", text: "" };
        const message = { role: "assistant", content: [block] };
        emit({ type: "message_start", message });
        for (let index = 1; index <= 1000; index++) {
          block.text = `fragment ${index}`;
          emit({ type: "message_update", message });
        }
        emit({ type: "message_end", message: { ...message, stopReason: "stop" } });
        emit({ type: "agent_settled" });
      }),
    );
    const events = await collect(adapter.run(request));
    const messages = events.filter((event) => event.type === "runtime.message");
    expect(messages[0]?.phase).toBe("started");
    expect(messages.at(-1)?.phase).toBe("ended");
    expect(messages.filter((event) => event.phase === "updated").length).toBeLessThanOrEqual(2);
    const captured = projection.captures as {
      kind: string;
      value: { content: { text: string }[] };
    }[];
    expect(captured.find((item) => item.kind === "message")?.value.content[0]?.text).toBe("");
    expect(captured.filter((item) => item.kind === "message").at(-1)?.value.content[0]?.text).toBe(
      "fragment 1000",
    );
    expect(events.at(-1)?.type).toBe("runtime.completed");
  });

  it("retains thinking-stream boundaries while coalescing deltas", async () => {
    const projection = new RecordingProjection();
    const message = {
      role: "assistant",
      timestamp: 123,
      content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }],
    };
    const adapter = createAdapter(
      projection,
      new RecordingRuntimeTools(),
      fakeSessionFactory((emit) => {
        emit({ type: "agent_start" });
        emit({ type: "message_start", message });
        for (const type of ["thinking_start", "thinking_delta", "thinking_delta", "thinking_end"])
          emit({
            type: "message_update",
            message,
            assistantMessageEvent: { type, contentIndex: 0 },
          });
        emit({
          type: "message_end",
          message: { ...message, content: [{ type: "text", text: "Done" }], stopReason: "stop" },
        });
        emit({ type: "agent_settled" });
      }),
    );
    expect((await collect(adapter.run(request))).at(-1)?.type).toBe("runtime.completed");
    const captured = projection.captures as {
      value: { thinkingBoundary?: { phase: string; contentIndex: number } };
    }[];
    expect(
      captured.flatMap((entry) =>
        entry.value.thinkingBoundary ? [entry.value.thinkingBoundary] : [],
      ),
    ).toEqual([
      { phase: "started", contentIndex: 0 },
      { phase: "ended", contentIndex: 0 },
    ]);
  });

  it("[UI-4] records when text and tool-call output start while still coalescing deltas", async () => {
    const projection = new RecordingProjection();
    let tick = 0;
    const clock = (offset: number) =>
      new Date(Date.UTC(2026, 9, 26, 12, 24, 18) + offset * 100).toISOString();
    const expected: Record<string, string> = {};
    const message = {
      role: "assistant",
      timestamp: 456,
      content: [
        { type: "text", text: "Searching" },
        { type: "toolCall", id: "call-1", name: "web_search", arguments: {} },
      ],
    };
    const adapter = createAdapter(
      projection,
      new RecordingRuntimeTools(),
      fakeSessionFactory((emit) => {
        emit({ type: "agent_start" });
        emit({ type: "message_start", message });
        for (const [type, contentIndex] of [
          ["text_start", 0],
          ["text_delta", 0],
          ["text_delta", 0],
          ["toolcall_start", 1],
          ["toolcall_delta", 1],
        ] as const) {
          expected[type] = clock(tick);
          emit({ type: "message_update", message, assistantMessageEvent: { type, contentIndex } });
        }
        emit({
          type: "message_end",
          message: { ...message, content: [{ type: "text", text: "Done" }], stopReason: "stop" },
        });
        emit({ type: "agent_settled" });
      }),
      {},
      () => clock(tick++),
    );
    const events = await collect(adapter.run(request));
    const boundaries = (
      projection.captures as {
        value: { outputBoundary?: { kind: string; contentIndex: number } };
      }[]
    ).flatMap((entry, index) =>
      entry.value.outputBoundary
        ? [{ ref: `captured-${index + 1}`, ...entry.value.outputBoundary }]
        : [],
    );
    expect(boundaries.map(({ kind, contentIndex }) => ({ kind, contentIndex }))).toEqual([
      { kind: "text", contentIndex: 0 },
      { kind: "toolCall", contentIndex: 1 },
    ]);
    const timeOf = (ref: string | undefined) =>
      events.find((event) => event.type === "runtime.message" && event.payloadRef === ref)
        ?.occurredAt;
    expect(timeOf(boundaries[0]?.ref)).toBe(expected["text_start"]);
    expect(timeOf(boundaries[1]?.ref)).toBe(expected["toolcall_start"]);
  });

  it("announces a streamed tool call by name as soon as it starts, before its events are recorded", async () => {
    const projection = new RecordingProjection();
    const started: [string, string][] = [];
    let startedWhenArgumentsBegan = -1;
    const message = {
      role: "assistant",
      timestamp: 456,
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "toolCall", id: "call-1", name: "write", arguments: {} },
        { type: "toolCall", id: "call-2", name: "bash", arguments: {} },
      ],
    };
    const adapter = createAdapter(
      projection,
      new RecordingRuntimeTools(),
      fakeSessionFactory((emit) => {
        emit({ type: "agent_start" });
        emit({ type: "message_start", message });
        emit({
          type: "message_update",
          message,
          assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
        });
        emit({
          type: "message_update",
          message,
          assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
        });
        startedWhenArgumentsBegan = started.length;
        emit({
          type: "message_update",
          message,
          assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1 },
        });
        emit({
          type: "message_update",
          message,
          assistantMessageEvent: { type: "toolcall_start", contentIndex: 2 },
        });
        emit({
          type: "message_end",
          message: { ...message, content: [{ type: "text", text: "Done" }], stopReason: "stop" },
        });
        emit({ type: "agent_settled" });
      }),
      {},
      () => NOW,
      (runRequest, toolName) => started.push([runRequest.runId, toolName]),
    );
    await collect(adapter.run(request));
    expect(startedWhenArgumentsBegan).toBe(1);
    expect(started).toEqual([
      [request.runId, "write"],
      [request.runId, "bash"],
    ]);
  });

  it("hands every growing answer text to the live feed as the model writes it", async () => {
    const projection = new RecordingProjection();
    const seen: Array<[string, unknown, string]> = [];
    const snapshot = (text: string) => ({
      role: "assistant",
      timestamp: 789,
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "text", text },
      ],
    });
    const adapter = createAdapter(
      projection,
      new RecordingRuntimeTools(),
      fakeSessionFactory((emit) => {
        emit({ type: "agent_start" });
        emit({ type: "message_start", message: snapshot("") });
        emit({
          type: "message_update",
          message: snapshot(""),
          assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
        });
        for (const text of ["向", "向日葵", "向日葵的一生"])
          emit({
            type: "message_update",
            message: snapshot(text),
            assistantMessageEvent: { type: "text_delta", contentIndex: 1 },
          });
        emit({
          type: "message_end",
          message: { ...snapshot("向日葵的一生"), stopReason: "stop" },
        });
        emit({ type: "agent_settled" });
      }),
      {},
      () => NOW,
      undefined,
      undefined,
      (runRequest, message) => seen.push([runRequest.runId, message.timestamp, message.text]),
    );
    await collect(adapter.run(request));
    expect(seen).toEqual([
      [request.runId, 789, "向"],
      [request.runId, 789, "向日葵"],
      [request.runId, 789, "向日葵的一生"],
    ]);
  });

  it("records a streamed file write as its path and line count until the call is complete", async () => {
    const projection = new RecordingProjection();
    const lines = Array.from(
      { length: 400 },
      (_, index) => `const row${index} = "${"x".repeat(60)}";`,
    );
    const finalArguments = { path: "game.html", content: lines.join("\n") };
    const snapshot = (written: number) => {
      const content = lines.slice(0, written).join("\n");
      return {
        role: "assistant",
        timestamp: 456,
        content: [
          { type: "thinking", thinking: "plan" },
          {
            type: "toolCall",
            id: "call-1",
            name: "write",
            arguments: { path: "game.html", content },
            partialArgs: JSON.stringify({ path: "game.html", content }),
          },
        ],
      };
    };
    const adapter = createAdapter(
      projection,
      new RecordingRuntimeTools(),
      fakeSessionFactory(async (emit) => {
        emit({ type: "agent_start" });
        emit({ type: "message_start", message: snapshot(0) });
        emit({
          type: "message_update",
          message: snapshot(0),
          assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
        });
        for (let written = 1; written <= lines.length; written += 1) {
          emit({
            type: "message_update",
            message: snapshot(written),
            assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1 },
          });
          await Promise.resolve();
        }
        emit({
          type: "message_end",
          message: {
            ...snapshot(lines.length),
            content: [
              { type: "thinking", thinking: "plan" },
              { type: "toolCall", id: "call-1", name: "write", arguments: finalArguments },
            ],
            stopReason: "toolUse",
          },
        });
        emit({ type: "agent_settled" });
      }),
    );
    await collect(adapter.run(request));
    const captures = projection.captures as { value: { content?: Record<string, unknown>[] } }[];
    const calls = captures.flatMap((entry) =>
      (entry.value.content ?? []).filter((block) => block["type"] === "toolCall"),
    );
    const streamed = calls.filter((block) => block["streaming"] !== undefined);
    const completed = calls.filter((block) => block["streaming"] === undefined);
    expect(streamed.length).toBeGreaterThan(10);
    for (const block of streamed) {
      expect(block["arguments"]).toEqual({ path: "game.html" });
      expect(block).not.toHaveProperty("partialArgs");
    }
    expect(streamed.at(-1)?.["streaming"]).toMatchObject({ lines: lines.length });
    expect(completed.at(-1)?.["arguments"]).toEqual(finalArguments);
    const streamedBytes = streamed.reduce(
      (total, block) => total + JSON.stringify(block).length,
      0,
    );
    expect(streamedBytes).toBeLessThan(finalArguments.content.length);
  });

  it("exposes only authorized custom tools and maps Pi lifecycle events after settlement", async () => {
    const projection = new RecordingProjection();
    const tools = new RecordingRuntimeTools();
    const observedOptions: FakeSessionOptions[] = [];
    const adapter = createAdapter(
      projection,
      tools,
      fakeSessionFactory(async (emit, options) => {
        emit({ type: "agent_start" });
        emit({ type: "turn_start" });
        emit({ type: "message_start", message: { role: "assistant", content: [] } });
        emit({
          type: "message_update",
          message: { role: "assistant", content: [{ type: "text", text: "Searching" }] },
        });
        emit({
          type: "tool_execution_start",
          toolCallId: "tool-call-task-11",
          toolName: "restaurant_search",
          args: { query: "beef" },
        });
        const tool = options.customTools?.[0];
        if (!tool) throw new Error("missing custom tool");
        const result = await tool.execute("tool-call-task-11", { query: "beef" });
        emit({
          type: "tool_execution_end",
          toolCallId: "tool-call-task-11",
          toolName: "restaurant_search",
          result,
          isError: false,
        });
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Done" }],
          },
        });
        emit({ type: "turn_end", message: { role: "assistant" }, toolResults: [] });
        emit({
          type: "compaction_end",
          reason: "threshold",
          result: {
            summary: "A product-state proposal only",
            firstKeptEntryId: "entry-2",
            tokensBefore: 100,
          },
          aborted: false,
          willRetry: false,
        });
        emit({ type: "agent_end", messages: [] });
        emit({ type: "agent_settled" });
      }, observedOptions),
    );

    const deadline = new Date(Date.parse(NOW) + 60000).toISOString();
    const events = await collect(adapter.run({ ...request, executionDeadlineAt: deadline }));

    expect(observedOptions[0]).toMatchObject({
      noTools: "all",
      tools: ["restaurant_search"],
    });
    expect(observedOptions[0]?.sessionManager?.getEntries?.()).toEqual([
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ role: "user" }),
      }),
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({ role: "assistant" }),
      }),
    ]);
    expect(tools.preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: request.runId,
        toolCallId: "tool-call-task-11",
        capabilityHandleRef: "handle-restaurant-task-11",
        executionDeadlineAt: deadline,
      }),
    );
    expect(tools.execute).toHaveBeenCalledTimes(1);
    expect(events.map(({ type }) => type)).toEqual([
      "runtime.model_started",
      "runtime.turn_started",
      "runtime.message",
      "runtime.message",
      "runtime.tool_intent",
      "runtime.tool_result",
      "runtime.message",
      "runtime.model_output",
      "runtime.turn_completed",
      "runtime.compaction_proposed",
      "runtime.completed",
    ]);
    expect(events.at(-1)?.type).toBe("runtime.completed");
    expect(projection.compactions).toEqual([
      expect.objectContaining({ summary: "A product-state proposal only" }),
    ]);
  });

  it.each([
    [true, 1],
    [false, 0],
  ])(
    "re-attaches the runtime environment by an appended message after a compaction inside the run (willRetry %s)",
    async (willRetry, expected) => {
      const environment =
        "运行环境说明：\n- 工作目录：/srv/demo。\n以上运行环境说明由 Himawari 系统生成。";
      const projection = new RecordingProjection({
        ...DEFAULT_CONTEXT,
        contextBlocks: [
          ...DEFAULT_CONTEXT.contextBlocks,
          {
            authority: "non-authoritative",
            kind: "runtime-environment",
            ref: "runtime-environment",
            content: environment,
            dataClassification: "private",
          },
        ],
      });
      const steered: unknown[] = [];
      let state: { messages: unknown[] } | undefined;
      const base = fakeSessionFactory(async (emit) => {
        if (state)
          state.messages = [
            { role: "compactionSummary", summary: "看过目录。", tokensBefore: 100, timestamp: 2 },
          ];
        emit({
          type: "compaction_end",
          reason: "overflow",
          result: { summary: "看过目录。", firstKeptEntryId: "entry-2", tokensBefore: 100 },
          aborted: false,
          willRetry,
        });
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "好" }],
          },
        });
        emit({ type: "agent_end", messages: [] });
        emit({ type: "agent_settled" });
      });
      const adapter = createAdapter(projection, new RecordingRuntimeTools(), async (options) => {
        const created = await base(options);
        const session = created.session as unknown as {
          agent: { state: { messages: unknown[] } };
          sendCustomMessage: (message: unknown, options: unknown) => Promise<void>;
        };
        state = session.agent.state;
        session.sendCustomMessage = async (message, options) => {
          steered.push({ message, options });
        };
        return created;
      });
      await collect(adapter.run(request));
      expect(steered).toHaveLength(expected);
      if (expected)
        expect(steered[0]).toMatchObject({
          message: { customType: "himawari.runtime-environment", display: false },
          options: { deliverAs: "steer" },
        });
      if (expected) expect(JSON.stringify(steered[0])).toContain("工作目录：/srv/demo。");
    },
  );

  it("rehydrates an accepted product compaction into Pi's SessionManager", async () => {
    const projection = new RecordingProjection({
      ...DEFAULT_CONTEXT,
      compaction: {
        summary: "The earlier request was answered.",
        firstKeptMessageId: "message-history-assistant-task-11",
        tokensBefore: 91,
      },
    });
    const tools = new RecordingRuntimeTools();
    const observedOptions: FakeSessionOptions[] = [];
    const adapter = createAdapter(
      projection,
      tools,
      fakeSessionFactory((emit) => emit({ type: "agent_settled" }), observedOptions),
    );

    await collect(adapter.run(request));

    const entries = observedOptions[0]?.sessionManager?.getEntries?.();
    expect(entries).toHaveLength(3);
    expect(entries?.at(-1)).toEqual(
      expect.objectContaining({
        type: "compaction",
        summary: "The earlier request was answered.",
        tokensBefore: 91,
      }),
    );
  });

  it("accepts opaque product Session IDs containing colon without changing product identity", async () => {
    const observedOptions: FakeSessionOptions[] = [];
    const adapter = createAdapter(
      new RecordingProjection(),
      new RecordingRuntimeTools(),
      fakeSessionFactory((emit) => emit({ type: "agent_settled" }), observedOptions),
    );
    const input = {
      ...request,
      sessionId: fixtureIdentifier<RuntimeRequest["sessionId"]>("session:identity-fixture"),
      threadId: null,
    };
    const events = await collect(adapter.run(input));
    expect(events.at(-1)).toMatchObject({ type: "runtime.completed", runId: request.runId });
    const first = observedOptions[0]?.sessionManager?.getSessionId?.();
    expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
    await collect(adapter.run(input));
    expect(observedOptions[1]?.sessionManager?.getSessionId?.()).toBe(first);
    expect(input.sessionId).toBe("session:identity-fixture");
  });

  it("rebuilds Pi Session projections without changing durable product identities", async () => {
    const projection = new RecordingProjection({
      ...DEFAULT_CONTEXT,
      compaction: {
        summary: "The earlier request was answered.",
        firstKeptMessageId: "message-history-assistant-task-11",
        tokensBefore: 91,
      },
    });
    const observedOptions: FakeSessionOptions[] = [];
    const adapter = createAdapter(
      projection,
      new RecordingRuntimeTools(),
      fakeSessionFactory((emit) => emit({ type: "agent_settled" }), observedOptions),
    );

    const firstEvents = await collect(adapter.run({ ...request, threadId: null }));
    const secondEvents = await collect(adapter.run({ ...request, threadId: null }));
    expect(firstEvents.at(-1)).toMatchObject({ type: "runtime.completed", runId: request.runId });
    expect(secondEvents.at(-1)).toEqual(firstEvents.at(-1));
    expect(observedOptions).toHaveLength(2);
    const piIds = observedOptions.map(({ sessionManager }) => sessionManager?.getSessionId?.());
    expect(piIds[0]).toMatch(/^himawari-[a-f0-9]{64}$/u);
    expect(piIds[1]).toBe(piIds[0]);

    const durableSemantics = (options: FakeSessionOptions) =>
      options.sessionManager?.getEntries?.().map((rawEntry) => {
        const entry = rawEntry as {
          readonly type: string;
          readonly message?: { readonly role?: string; readonly content?: unknown };
          readonly summary?: string;
          readonly tokensBefore?: number;
        };
        return entry.type === "message"
          ? { type: entry.type, role: entry.message?.role, content: entry.message?.content }
          : { type: entry.type, summary: entry.summary, tokensBefore: entry.tokensBefore };
      });
    expect(durableSemantics(observedOptions[1] ?? {})).toEqual(
      durableSemantics(observedOptions[0] ?? {}),
    );
    expect(request).toMatchObject({
      threadId: "thread-task-11",
      runId: "run-task-11",
      sessionId: "session-task-11",
    });
  });

  it("rejects tool calls projected as user content instead of silently dropping them", async () => {
    const projection = new RecordingProjection({
      ...DEFAULT_CONTEXT,
      history: [
        {
          id: "message-invalid-user-task-11",
          role: "user",
          content: [
            {
              type: "tool_call",
              id: "tool-call-invalid-task-11",
              name: "restaurant_search",
              arguments: { query: "beef" },
            },
          ],
          occurredAt: NOW,
        },
      ],
    });
    const adapter = createAdapter(
      projection,
      new RecordingRuntimeTools(),
      fakeSessionFactory(() => undefined),
    );

    await expect(collect(adapter.run(request))).resolves.toContainEqual({
      type: "runtime.failed",
      runId: request.runId,
      errorCode: "PI_RUNTIME_ERROR",
      occurredAt: NOW,
    });
  });

  it.each(["read", "write", "edit", "bash", "find", "grep", "ls"] as const)(
    "uses only the Pi %s definition in the Agent and dispatches through the product port",
    async (name) => {
      const tools = new RecordingRuntimeTools();
      vi.spyOn(tools, "listAuthorized").mockResolvedValue([
        {
          definition: "builtin-coding",
          name,
          capabilityRef: `project.${name}`,
          capabilityHandleRef: null,
        },
      ]);
      const adapter = createAdapter(
        new RecordingProjection(),
        tools,
        fakeSessionFactory(async (emit, options) => {
          expect(options.noTools).toBe("all");
          expect(options.tools).toEqual([name]);
          const tool = options.customTools?.[0];
          if (!tool) throw new Error("missing tool");
          emit({ type: "agent_start" });
          const read = vi.spyOn(fsPromises, "readFile");
          const write = vi.spyOn(fsPromises, "writeFile");
          syncBuiltinESMExports();
          try {
            await tool.execute("project-call", { synthetic: "frozen-input" });
            expect(read).not.toHaveBeenCalled();
            expect(write).not.toHaveBeenCalled();
          } finally {
            read.mockRestore();
            write.mockRestore();
            syncBuiltinESMExports();
          }
          emit({ type: "agent_end", messages: [] });
          emit({ type: "agent_settled" });
        }),
      );
      await collect(adapter.run({ ...request, capabilityHandleRefs: [] }));
      expect(tools.execute).toHaveBeenCalledWith(
        expect.objectContaining({ toolCallId: "project-call", capabilityRef: `project.${name}` }),
      );
    },
  );

  it.each([false, true])(
    "reuses Pi read definition and routes through product policy (allowed=%s)",
    async (allowed) => {
      const tools = new RecordingRuntimeTools();
      vi.spyOn(tools, "listAuthorized").mockResolvedValue([
        {
          definition: "builtin-read",
          name: "read",
          capabilityRef: "host.file.read",
          capabilityHandleRef: null,
        },
      ]);
      tools.preflight.mockResolvedValue({
        allowed,
        permissionDecisionRef: "file-read-unavailable",
        reasonCode: "FILE_READ_AUTHORIZATION_UNAVAILABLE",
      });
      const args = { path: "/test/中文.txt", offset: 2, limit: 3 };
      const adapter = createAdapter(
        new RecordingProjection(),
        tools,
        fakeSessionFactory(async (emit, options) => {
          expect(options.noTools).toBe("all");
          expect(options.tools).toEqual(["read"]);
          const tool = options.customTools?.[0];
          if (!tool) throw new Error("missing read tool");
          const upstream = createReadToolDefinition("/workspace");
          expect(tool.parameters).toEqual(upstream.parameters);
          expect(tool.description).toBe(TOOL_BUILTIN_READ.text);
          expect(
            validateToolArguments(tool, {
              type: "toolCall",
              id: "file-call",
              name: "read",
              arguments: args,
            }),
          ).toEqual(args);
          expect(() =>
            validateToolArguments(tool, {
              type: "toolCall",
              id: "invalid-call",
              name: "read",
              arguments: { limit: 3 },
            }),
          ).toThrow();
          emit({ type: "agent_start" });
          const access = vi.spyOn(fsPromises, "access");
          const read = vi.spyOn(fsPromises, "readFile");
          syncBuiltinESMExports();
          try {
            const result = await tool.execute("file-call", args);
            expect(result).toMatchObject(
              allowed
                ? {
                    isError: false,
                    content: [{ type: "text", text: "Found one governed result." }],
                  }
                : { isError: true, details: { reasonCode: "FILE_READ_AUTHORIZATION_UNAVAILABLE" } },
            );
            expect(access).not.toHaveBeenCalled();
            expect(read).not.toHaveBeenCalled();
          } finally {
            access.mockRestore();
            read.mockRestore();
            syncBuiltinESMExports();
          }
          emit({ type: "agent_end", messages: [] });
          emit({ type: "agent_settled" });
        }),
      );
      await collect(adapter.run({ ...request, capabilityHandleRefs: [] }));
      expect(tools.preflight).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: request.runId,
          toolCallId: "file-call",
          capabilityRef: "host.file.read",
          capabilityHandleRef: null,
          arguments: args,
        }),
      );
      expect(tools.execute).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (allowed)
        expect(tools.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            runId: request.runId,
            toolCallId: "file-call",
            capabilityHandleRef: null,
            arguments: args,
          }),
        );
    },
  );

  it("uses product preflight as the final enforcement point", async () => {
    const projection = new RecordingProjection();
    const tools = new RecordingRuntimeTools();
    tools.preflight.mockResolvedValue({
      allowed: false,
      permissionDecisionRef: "permission-denied-task-11",
      reasonCode: "permission_revoked",
    });
    const adapter = createAdapter(
      projection,
      tools,
      fakeSessionFactory(async (emit, options) => {
        emit({ type: "agent_start" });
        const result = await options.customTools?.[0]?.execute("tool-call-denied", {
          query: "beef",
        });
        emit({
          type: "tool_execution_start",
          toolCallId: "tool-call-denied",
          toolName: "restaurant_search",
          args: { query: "beef" },
        });
        emit({
          type: "tool_execution_end",
          toolCallId: "tool-call-denied",
          toolName: "restaurant_search",
          result,
          isError: true,
        });
        emit({ type: "agent_end", messages: [] });
        emit({ type: "agent_settled" });
      }),
    );

    await collect(adapter.run(request));

    expect(tools.preflight).toHaveBeenCalledTimes(1);
    expect(tools.execute).not.toHaveBeenCalled();
  });

  it.each(["before", "during"] as const)(
    "does not execute a tool aborted %s product preflight",
    async (when) => {
      const projection = new RecordingProjection();
      const tools = new RecordingRuntimeTools();
      const controller = new AbortController();
      tools.preflight.mockImplementation(async () => {
        if (when === "during") controller.abort();
        return {
          allowed: true,
          permissionDecisionRef: "permission-abort",
          reasonCode: "grant_allows",
        };
      });
      let toolError: unknown;
      const adapter = createAdapter(
        projection,
        tools,
        fakeSessionFactory(async (emit, options) => {
          if (when === "before") controller.abort();
          try {
            await options.customTools?.[0]?.execute(
              "tool-call-aborted",
              { query: "beef" },
              controller.signal,
            );
          } catch (error) {
            toolError = error;
          }
          emit({ type: "agent_settled" });
        }),
      );
      await collect(adapter.run(request));
      expect(toolError).toMatchObject({ name: "AbortError" });
      expect(tools.preflight).toHaveBeenCalledTimes(when === "before" ? 0 : 1);
      expect(tools.execute).not.toHaveBeenCalled();
    },
  );

  it("maps product cancellation to Pi abort and waits for settled listeners", async () => {
    const projection = new RecordingProjection();
    const tools = new RecordingRuntimeTools();
    let releasePrompt: (() => void) | undefined;
    const promptBlocked = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const adapter = createAdapter(
      projection,
      tools,
      fakeSessionFactory(async (emit) => {
        emit({ type: "agent_start" });
        await promptBlocked;
      }),
    );

    const running = collect(adapter.run(request));
    await vi.waitFor(() => expect(releasePrompt).toBeDefined());
    await adapter.cancel(request.runId);
    releasePrompt?.();
    const events = await running;

    expect(events.at(-1)).toEqual({
      type: "runtime.cancelled",
      runId: request.runId,
      reasonCode: "PI_ABORTED",
      occurredAt: NOW,
    });
    expect(events.some(({ type }) => type === "runtime.completed")).toBe(false);
  });

  it("streams mapped events before the Pi turn settles", async () => {
    const projection = new RecordingProjection();
    const tools = new RecordingRuntimeTools();
    let releasePrompt: (() => void) | undefined;
    const promptBlocked = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const adapter = createAdapter(
      projection,
      tools,
      fakeSessionFactory(async (emit) => {
        emit({ type: "agent_start" });
        await promptBlocked;
        emit({ type: "agent_settled" });
      }),
    );

    const iterator = adapter.run(request)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: "runtime.model_started",
        runId: request.runId,
        modelRef: request.modelRef,
        thinkingLevel: "off",
        occurredAt: NOW,
      },
    });
    releasePrompt?.();
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: "runtime.failed",
        runId: request.runId,
        errorCode: "PI_FINAL_ANSWER_EMPTY",
        occurredAt: NOW,
      },
    });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("fails clearly when Pi emits an unknown upstream event", async () => {
    const projection = new RecordingProjection();
    const tools = new RecordingRuntimeTools();
    const adapter = createAdapter(
      projection,
      tools,
      fakeSessionFactory((emit) => {
        emit({ type: "future_upstream_event", payload: "unknown" });
        emit({ type: "agent_settled" });
      }),
    );

    await expect(collect(adapter.run(request))).resolves.toContainEqual({
      type: "runtime.failed",
      runId: request.runId,
      errorCode: "PI_UNKNOWN_EVENT_TYPE",
      occurredAt: NOW,
    });
  });

  it("maps Pi model errors to a stable product runtime error", async () => {
    const projection = new RecordingProjection();
    const tools = new RecordingRuntimeTools();
    const adapter = createAdapter(
      projection,
      tools,
      fakeSessionFactory((emit) => {
        emit({ type: "agent_start" });
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "provider included an unsafe raw failure",
          },
        });
        emit({ type: "agent_end", messages: [] });
        emit({ type: "agent_settled" });
      }),
    );

    const events = await collect(adapter.run(request));

    expect(events).toContainEqual({
      type: "runtime.failed",
      runId: request.runId,
      errorCode: "PI_MODEL_ERROR",
      occurredAt: NOW,
    });
    expect(events.some(({ type }) => type === "runtime.completed")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("unsafe raw failure");
  });

  it.each([
    ["Model invocation admission was blocked", "Model invocation admission was blocked"],
    ["400: PRIVATE_PROVIDER_DATA", "provider_status_400"],
    ["PI_REQUEST_HEAD_DIVERGED", "PI_REQUEST_HEAD_DIVERGED"],
    ["provider included an unsafe raw failure", "provider_message_withheld"],
  ])(
    "reports why the model stream failed without provider text: %s",
    async (errorMessage, logged) => {
      const failures: { code: string; message: string }[] = [];
      const adapter = createAdapter(
        new RecordingProjection(),
        new RecordingRuntimeTools(),
        fakeSessionFactory((emit) => {
          emit({ type: "agent_start" });
          emit({
            type: "message_end",
            message: { role: "assistant", content: [], stopReason: "error", errorMessage },
          });
          emit({ type: "agent_end", messages: [] });
          emit({ type: "agent_settled" });
        }),
        {},
        () => NOW,
        undefined,
        (_request, failure) => failures.push(failure),
      );
      await collect(adapter.run(request));
      expect(failures).toEqual([{ code: "PI_MODEL_ERROR", message: logged }]);
    },
  );

  it.each([
    ["429: provider overloaded PRIVATE_PROVIDER_DATA", "PI_MODEL_RATE_LIMITED"],
    ["401: PRIVATE_CREDENTIAL", "PI_MODEL_AUTH_FAILED"],
    ["402: User budget exceeded PRIVATE_SPEND", "PI_MODEL_QUOTA_EXCEEDED"],
    ["503: provider unavailable", "PI_MODEL_UNAVAILABLE"],
    [
      "Server requested 120s retry delay (max: 10s). 429 slow down PRIVATE_PROVIDER_DATA",
      "PI_MODEL_RATE_LIMITED",
    ],
    ["arbitrary message containing 429", "PI_MODEL_ERROR"],
    ["Server requested 120s retry delay (max: 10s). arbitrary", "PI_MODEL_ERROR"],
  ])(
    "classifies provider failure without exposing raw data: %s",
    async (errorMessage, errorCode) => {
      const adapter = createAdapter(
        new RecordingProjection(),
        new RecordingRuntimeTools(),
        fakeSessionFactory((emit) => {
          emit({ type: "agent_start" });
          emit({
            type: "message_end",
            message: {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage,
            },
          });
          emit({ type: "agent_settled" });
        }),
      );
      const events = await collect(adapter.run(request));
      expect(events).toContainEqual({
        type: "runtime.failed",
        runId: request.runId,
        errorCode,
        occurredAt: NOW,
      });
      expect(JSON.stringify(events)).not.toContain("PRIVATE_");
      expect(events.some(({ type }) => type === "runtime.completed")).toBe(false);
    },
  );

  it("redacts machine-secret-shaped Pi observations before product capture", async () => {
    const projection = new RecordingProjection();
    const secretShapedOutput = ["password", "x".repeat(12)].join("=");
    const adapter = createAdapter(
      projection,
      new RecordingRuntimeTools(),
      fakeSessionFactory((emit) => {
        emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: secretShapedOutput }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_settled" });
      }),
    );

    await collect(adapter.run(request));

    expect(JSON.stringify(projection.captures)).not.toContain(secretShapedOutput);
    expect(JSON.stringify(projection.captures)).toContain("[MACHINE_SECRET_REDACTED]");
  });

  it("runs the pinned Pi 1.5.0 session with its deterministic faux provider", async () => {
    const piSpecifier: string = "@earendil-works/pi-coding-agent";
    const piEntry = fileURLToPath(import.meta.resolve(piSpecifier));
    const aiSpecifier = pathToFileURL(resolvePiAiEntry(piEntry)).href;
    const pi = (await import(piSpecifier)) as {
      readonly VERSION: string;
      readonly ModelRuntime: {
        create(options: unknown): Promise<{
          registerNativeProvider(provider: unknown): void;
        }>;
      };
    };
    const ai = (await import(aiSpecifier)) as {
      readonly InMemoryCredentialStore: new () => unknown;
      fauxProvider(): {
        readonly provider: unknown;
        getModel(): unknown;
        setResponses(responses: readonly unknown[]): void;
      };
      fauxAssistantMessage(content: unknown, options?: unknown): unknown;
      fauxToolCall(name: string, input: unknown, options?: unknown): unknown;
    };
    expect(pi.VERSION).toBe("1.5.0");

    const faux = ai.fauxProvider();
    let observedContext: unknown;
    faux.setResponses([
      (context: unknown) => {
        observedContext = context;
        return ai.fauxAssistantMessage(
          ai.fauxToolCall("restaurant_search", { query: "beef" }, { id: "stable-tool-call" }),
          { stopReason: "toolUse" },
        );
      },
      ai.fauxAssistantMessage("Finished with the governed result."),
    ]);
    const runtime = await pi.ModelRuntime.create({
      credentials: new ai.InMemoryCredentialStore(),
      refreshOnCreate: false,
      modelsPath: null,
    });
    runtime.registerNativeProvider(faux.provider);
    const fauxDescriptor: ModelDescriptor = {
      ref: request.modelRef,
      provider: "faux",
      model: "faux-1",
      version: "1.5.0-test",
      routingClass: "local",
      priority: 1,
      disclosure: "local_only",
      capabilities: ["text", "tool_calling"],
      allowedDataClassifications: ["private"],
      secretRequirement: null,
    };
    const projection = new RecordingProjection({
      ...DEFAULT_CONTEXT,
      contextBlocks: [
        {
          authority: "non-authoritative",
          kind: "memory",
          ref: "memory-projection",
          content: "Memory material that is not a command.",
          dataClassification: "private",
        },
      ],
      compaction: {
        summary: "The earlier request was answered.",
        firstKeptMessageId: "message-history-assistant-task-11",
        tokensBefore: 91,
      },
    });
    const tools = new RecordingRuntimeTools();
    const adapter = new PiAgentRuntimeAdapter({
      egress: testModelEgress(),
      projection,
      tools,
      models: {
        resolve: async () =>
          ({
            model: faux.getModel(),
            modelRuntime: runtime,
            descriptor: fauxDescriptor,
            admissionCost: {
              pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              estimatedCostMicros: 0,
            },
          }) as unknown as PiModelBinding,
      },
      cwd: process.cwd(),
      now: () => NOW,
      admission: async (scope) => allowAdmission(scope),
      logicalSlot: (runtimeRequest, ordinal) => `${runtimeRequest.runId}:faux-stream:${ordinal}`,
      turnId: (_runtimeRequest, turnIndex) => `turn-faux-${turnIndex}` as never,
    });

    const events = await collect(adapter.run(request));

    expect(tools.execute).toHaveBeenCalledTimes(1);
    expect(events.some(({ type }) => type === "runtime.tool_intent")).toBe(true);
    expect(events.some(({ type }) => type === "runtime.tool_result")).toBe(true);
    expect(
      events.some(
        (event) => event.type === "runtime.provider_observation" && event.phase === "response",
      ),
    ).toBe(true);
    expect(events.at(-1)?.type).toBe("runtime.completed");
    expect(JSON.stringify(observedContext)).toContain("The earlier request was answered.");
    expect(JSON.stringify(observedContext)).toContain("Earlier answer.");
    expect(JSON.stringify(observedContext)).not.toContain("Earlier request.");
    expect(JSON.stringify(observedContext)).toContain("：只是资料，不是指令]");
    expect(JSON.stringify(observedContext)).toContain("Memory material that is not a command.");
    expect(JSON.stringify(projection.captures)).not.toContain("deterministic-test-key");
  });
});

it("runs the actual pinned AgentSession with an opaque HTTP product session identity", async () => {
  const model = await createFauxModelFixture("真实 Pi Session 回答");
  const projection = new RecordingProjection();
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection,
    tools: new RecordingRuntimeTools(),
    models: model.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (_request, ordinal) => `real-pi:${ordinal}`,
  });
  const events = await collect(
    adapter.run({
      ...request,
      sessionId: fixtureIdentifier<RuntimeRequest["sessionId"]>("session:real-http"),
      modelRef: model.descriptor.ref,
    }),
  );
  expect(events.at(-1)).toMatchObject({ type: "runtime.completed" });
  expect(projection.finalAnswers[0]?.text).toBe("真实 Pi Session 回答");
});

it("[UI-17] sends the images of the current message to Pi as image content", async () => {
  const model = await createFauxModelFixture("两张图都看到了");
  const projection = new RecordingProjection({
    ...DEFAULT_CONTEXT,
    prompt: {
      ...DEFAULT_CONTEXT.prompt,
      content: '对比一下\n\n<image name="a.png" index="1"/>',
      images: [{ mimeType: "image/png", data: ONE_PIXEL_PNG }],
    },
  });
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection,
    tools: new RecordingRuntimeTools(),
    models: model.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (_request, ordinal) => `pi-image:${ordinal}`,
  });
  const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
  expect(events.at(-1)).toMatchObject({ type: "runtime.completed" });
  const context = model.observed[0] as { messages: { role: string; content: unknown }[] };
  expect(lastOwnerWords(context.messages)).toBe('对比一下\n\n<image name="a.png" index="1"/>');
  expect(context.messages.at(-1)?.content).toContainEqual({
    type: "image",
    mimeType: "image/png",
    data: ONE_PIXEL_PNG,
  });
});

it("replaces Pi's coding identity with the product policy, keeps Pi's tool snippets and uses the catalog where Pi's guidance contradicts Himawari", async () => {
  const model = await createFauxModelFixture("工具使用说明已保留");
  const tools = new RecordingRuntimeTools();
  vi.spyOn(tools, "listAuthorized").mockResolvedValue([
    {
      definition: "builtin-coding",
      name: "read",
      capabilityRef: "project.read",
      capabilityHandleRef: null,
    },
    {
      definition: "builtin-coding",
      name: "bash",
      capabilityRef: "project.bash",
      capabilityHandleRef: null,
    },
  ]);
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection: new RecordingProjection(),
    tools,
    models: model.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (_request, ordinal) => `pi-guidance:${ordinal}`,
  });
  const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
  expect(events.at(-1)).toMatchObject({ type: "runtime.completed" });
  const context = model.observed[0] as { systemPrompt: string };
  const read = createReadToolDefinition(process.cwd());
  const bash = createBashToolDefinition(process.cwd());
  expect(context.systemPrompt.startsWith(DEFAULT_CONTEXT.systemInstruction)).toBe(true);
  expect(context.systemPrompt).toContain(`- read: ${read.promptSnippet}`);
  expect(context.systemPrompt).toContain(`- bash: ${bash.promptSnippet}`);
  expect(context.systemPrompt).toContain(`- ${TOOL_BUILTIN_READ_GUIDELINE.text}`);
  for (const guideline of [...(read.promptGuidelines ?? []), ...(bash.promptGuidelines ?? [])])
    expect(context.systemPrompt).not.toContain(guideline);
  expect(context.systemPrompt).not.toContain("coding assistant");
  expect(context.systemPrompt).not.toContain("Pi documentation");
  expect(tools.execute).not.toHaveBeenCalled();
});

it("does not load ambient prompt files or interpret product policy as a file path", async () => {
  const cwd = await fsPromises.mkdtemp(join(tmpdir(), "himawari-pi-prompt-"));
  try {
    const agentDir = join(cwd, "agent");
    await fsPromises.mkdir(agentDir);
    await fsPromises.mkdir(join(cwd, ".pi"));
    const marker = "UNAUTHORIZED_AMBIENT_PROMPT";
    for (const directory of [agentDir, join(cwd, ".pi")]) {
      await fsPromises.writeFile(join(directory, "SYSTEM.md"), marker);
      await fsPromises.writeFile(join(directory, "APPEND_SYSTEM.md"), marker);
    }
    const policy = join(cwd, "policy.txt");
    await fsPromises.writeFile(policy, marker);
    const model = await createFauxModelFixture("只使用显式授权的文本");
    const adapter = new PiAgentRuntimeAdapter({
      egress: testModelEgress(),
      projection: new RecordingProjection({ ...DEFAULT_CONTEXT, systemInstruction: policy }),
      tools: new RecordingRuntimeTools(),
      models: model.models,
      cwd,
      agentDir,
      now: () => NOW,
      admission: async (scope) => allowAdmission(scope),
      logicalSlot: (_request, ordinal) => `pi-prompt-sources:${ordinal}`,
    });
    const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
    expect(events.at(-1)).toMatchObject({ type: "runtime.completed" });
    const context = model.observed[0] as { systemPrompt: string };
    expect(context.systemPrompt).toContain(policy);
    expect(context.systemPrompt).not.toContain(marker);
  } finally {
    await fsPromises.rm(cwd, { recursive: true, force: true });
  }
});

it.each(["approved", "denied", "effect_without_receipt"] as const)(
  "suspends and resumes a generic side-effect tool: %s",
  async (resolution) => {
    const model = await createFauxModelFixture("操作结果已说明", {
      name: "controlled_action",
      id: "controlled-call",
      arguments: { recipient: "test-only" },
    });
    const projection = new RecordingProjection();
    let decision: "pending" | typeof resolution = "pending";
    let effects = 0;
    const snapshots = new Map<string, string>();
    const slots: number[] = [];
    const tools: RuntimeToolPort = {
      listAuthorized: async () => [
        {
          name: "controlled_action",
          description: "Controlled side effect",
          capabilityRef: "test.communicate",
          capabilityHandleRef: null,
          parameters: {
            type: "object",
            properties: { recipient: { type: "string" } },
            required: ["recipient"],
          },
        },
      ],
      preflight: async () => ({
        allowed: true,
        permissionDecisionRef: "test",
        reasonCode: "evaluate",
      }),
      execute: async (call) => {
        expect(call.toolCallId).toBe("controlled-call");
        if (decision === "pending")
          return {
            outcome: "awaiting_approval",
            approval: {
              approvalRequestId: "approval-generic",
              semanticSnapshotHash: "frozen-action",
              expiresAt: "2999-01-01T00:00:00.000Z",
            },
            resultRef: null,
            errorCode: null,
            externalActionId: null,
            modelContent: "",
          };
        if (decision === "denied")
          return {
            outcome: "failed",
            resultRef: null,
            errorCode: "OWNER_DENIED",
            externalActionId: null,
            modelContent: "用户拒绝，未执行",
          };
        effects += 1;
        if (decision === "effect_without_receipt")
          return {
            outcome: "result_unknown",
            resultRef: null,
            errorCode: "RECEIPT_LOST",
            externalActionId: "test-effect",
            modelContent: "结果待核查",
          };
        return {
          outcome: "succeeded",
          resultRef: "protected-result",
          errorCode: null,
          externalActionId: "test-effect",
          modelContent: "测试操作已执行",
        };
      },
    };
    const create = () =>
      new PiAgentRuntimeAdapter({
        egress: testModelEgress(),
        projection,
        tools,
        models: model.models,
        cwd: process.cwd(),
        now: () => NOW,
        admission: async (scope) => allowAdmission(scope),
        logicalSlot: (_request, ordinal) => {
          slots.push(ordinal);
          return `durable-test:${ordinal}`;
        },
        continuations: {
          save: async (_request, value) => {
            const ref = `continuation-${snapshots.size}`;
            snapshots.set(ref, JSON.stringify(value));
            return ref;
          },
          load: async (_request, ref) => JSON.parse(snapshots.get(ref) ?? "null"),
        },
      });
    const input = { ...request, modelRef: model.descriptor.ref };
    const before = await collect(create().run(input));
    const suspended = before.at(-1);
    expect(suspended).toMatchObject({
      type: "runtime.suspended",
      approval: { approvalRequestId: "approval-generic" },
    });
    expect(effects).toBe(0);
    expect(model.observed).toHaveLength(1);
    expect(projection.finalAnswers).toHaveLength(0);
    if (suspended?.type !== "runtime.suspended") throw new Error("Expected suspension");
    decision = resolution;
    const resumed = await collect(
      create().run({
        ...input,
        continuationRef: suspended.continuationRef,
        executionLease: Object.freeze({
          ...input.executionLease,
          executionLeaseId:
            fixtureIdentifier<RuntimeRequest["executionLease"]["executionLeaseId"]>(
              "fresh-execution-lease",
            ),
          expectedLeaseRevision: 2,
        }),
      }),
    );
    expect(effects).toBe(resolution === "denied" ? 0 : 1);
    expect(projection.captures).toContainEqual(
      expect.objectContaining({
        kind: "tool_result",
        value: expect.objectContaining({
          toolCallId: "controlled-call",
          isError: resolution !== "approved",
        }),
      }),
    );
    if (resolution === "effect_without_receipt") {
      expect(resumed.at(-1)).toMatchObject({ type: "runtime.result_unknown" });
      expect(slots).toEqual([1]);
      expect(projection.finalAnswers).toHaveLength(0);
    } else {
      expect(resumed.at(-1), JSON.stringify(resumed.at(-1))).toMatchObject({
        type: "runtime.completed",
      });
      expect(slots).toEqual([1, 2]);
      expect(JSON.stringify(model.observed.at(-1))).toContain(
        resolution === "denied" ? "用户拒绝，未执行" : "测试操作已执行",
      );
    }
  },
);

it("[R2-L5] runs configured Gateway sessions without storing credentials in the shared Pi runtime", async () => {
  const { createServer } = await import("node:http");
  const { ConfiguredPiModelBindingPort } = await import("../src/index.js");
  const authorizations: Array<string | undefined> = [];
  const server = createServer((incoming, response) => {
    authorizations.push(incoming.headers.authorization);
    incoming.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "local-completion", object: "chat.completion.chunk", model: "deepseek/deepseek-v4.1-flash", choices: [{ index: 0, delta: { role: "assistant", content: "凭据受控回答" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "local-completion", object: "chat.completion.chunk", model: "deepseek/deepseek-v4.1-flash", choices: [{ index: 0, delta: { provider_metadata: { gateway: { generationId: "gen:fixture", routing: { finalProvider: "morph" }, cost: "0" } } }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: "0" } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LOCAL_PROVIDER_REQUIRED");
  const secretReads: string[] = [];
  const models = new ConfiguredPiModelBindingPort({
    descriptors: [
      {
        ref: "local-primary",
        model: "deepseek/deepseek-v4.1-flash",
        provider: "vercel-ai-gateway",
        version: "v1",
        name: "DeepSeek V4.1 Flash",
        routingClass: "primary",
        providerRouting: { order: ["runware", "deepinfra", "morph"], sort: "cost" },
        priority: 1,
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: false,
        input: ["text"],
        contextWindow: 8192,
        maxTokens: 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        capabilities: ["text"],
        disclosure: "trusted_remote",
        allowedDataClassifications: ["private"],
        secretRequirement: {
          secretRef: "fixture-key",
          secretVersion: "v1",
          purpose: "model-provider-auth",
        },
      },
    ],
    secretSource: {
      productionSuitable: true,
      resolve: async (ref) => {
        secretReads.push(ref);
        return "fixture-request-key";
      },
    },
  });
  try {
    const binding = await models.resolve("local-primary");
    expect(await binding.modelRuntime.checkAuth("vercel-ai-gateway")).toEqual({
      type: "api_key",
      source: "himawari-host-secret",
    });
    expect(binding.modelRuntime.hasConfiguredAuth("vercel-ai-gateway")).toBe(true);
    expect(await binding.modelRuntime.getAuth(binding.model)).toBeUndefined();
    expect(
      (await binding.modelRuntime.getAuth(binding.model, { apiKey: FIXTURE_KEY }))?.auth.apiKey,
    ).toBe(FIXTURE_KEY);
    expect(secretReads).toEqual([]);
    const projection = new RecordingProjection();
    let admitted = false;
    const adapter = new PiAgentRuntimeAdapter({
      egress: testModelEgress(),
      projection,
      tools: new RecordingRuntimeTools(),
      models,
      cwd: process.cwd(),
      now: () => NOW,
      admission: async (scope) => {
        expect(secretReads).toEqual([]);
        admitted = true;
        return allowAdmission(scope);
      },
      logicalSlot: (_request, ordinal) => `configured-pi:${ordinal}`,
    });
    const events = await collect(
      adapter.run({
        ...request,
        modelRef: "local-primary",
        sessionId: fixtureIdentifier<RuntimeRequest["sessionId"]>("session:configured-http"),
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "runtime.completed" });
    expect(admitted).toBe(true);
    expect(secretReads).toEqual(["fixture-key"]);
    expect(authorizations.map((value) => value?.split(" "))).toEqual([
      ["Bearer", "fixture-request-key"],
    ]);
    expect(projection.finalAnswers[0]?.text).toBe("凭据受控回答");
    expect(await binding.modelRuntime.listCredentials()).toEqual([]);
  } finally {
    await models.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

type CapturedModelRequest = {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
};

const FIXTURE_KEY = "fixture-request-key";

const VOLATILE_HEADER =
  /^(host|connection|content-length|user-agent|accept-encoding|accept-language|sec-fetch-mode|x-stainless-.*)$/u;

async function captureConfiguredModelRequest(options: {
  readonly provider: "vercel-ai-gateway" | "magpie";
  readonly maxTokens?: number;
}): Promise<readonly CapturedModelRequest[]> {
  const { createServer } = await import("node:http");
  const { ConfiguredPiModelBindingPort } = await import("../src/index.js");
  const captured: CapturedModelRequest[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (VOLATILE_HEADER.test(name)) continue;
        const text = Array.isArray(value) ? value.join(", ") : (value ?? "");
        headers[name] =
          name === "authorization" && text === `Bearer ${FIXTURE_KEY}` ? "Bearer [fixture]" : text;
      }
      captured.push({
        method: incoming.method,
        path: incoming.url,
        headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ id: "local-completion", object: "chat.completion.chunk", model: "deepseek/deepseek-v4.1-flash", choices: [{ index: 0, delta: { role: "assistant", content: "凭据受控回答" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "local-completion", object: "chat.completion.chunk", model: "deepseek/deepseek-v4.1-flash", choices: [{ index: 0, delta: { provider_metadata: { gateway: { generationId: "gen:fixture", routing: { finalProvider: "morph" }, cost: "0" } } }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: "0" } })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LOCAL_PROVIDER_REQUIRED");
  const models = new ConfiguredPiModelBindingPort({
    descriptors: [
      {
        ref: "golden-primary",
        model: "deepseek/deepseek-v4.1-flash",
        provider: options.provider,
        version: "v1",
        name: "DeepSeek V4.1 Flash",
        routingClass: "primary",
        ...(options.provider === "vercel-ai-gateway"
          ? { providerRouting: { order: ["runware", "deepinfra", "morph"], sort: "cost" as const } }
          : {}),
        priority: 1,
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        reasoning: true,
        input: ["text"],
        contextWindow: 8192,
        maxTokens: options.maxTokens ?? 1024,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        capabilities: ["text", "structured_outputs"],
        disclosure: "trusted_remote",
        allowedDataClassifications: ["private"],
        secretRequirement: {
          secretRef: "fixture-key",
          secretVersion: "v1",
          purpose: "model-provider-auth",
        },
      },
    ],
    secretSource: { productionSuitable: true, resolve: async () => "fixture-request-key" },
  });
  try {
    const adapter = new PiAgentRuntimeAdapter({
      egress: testModelEgress(),
      projection: new RecordingProjection(),
      tools: new RecordingRuntimeTools(),
      models,
      cwd: process.cwd(),
      now: () => NOW,
      admission: async (scope) => allowAdmission(scope),
      logicalSlot: (_request, ordinal) => `golden-pi:${ordinal}`,
    });
    const events = await collect(
      adapter.run({
        ...request,
        modelRef: "golden-primary",
        sessionId: fixtureIdentifier<RuntimeRequest["sessionId"]>("session:golden-request"),
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "runtime.completed" });
    return captured;
  } finally {
    await models.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("[D4] configured provider request bytes", () => {
  const goldenPath = new URL("./fixtures/d4-golden-requests.json", import.meta.url);

  async function readGolden(): Promise<Record<string, readonly CapturedModelRequest[]>> {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(goldenPath, "utf8")) as Record<
      string,
      readonly CapturedModelRequest[]
    >;
  }

  it.each(["magpie", "vercel-ai-gateway"] as const)(
    "sends the same method, path, headers and body for %s as the recorded golden request",
    async (provider) => {
      const actual = await captureConfiguredModelRequest({ provider });
      const golden = await readGolden();
      expect(actual).toEqual(golden[provider]);
      expect(actual).toHaveLength(1);
      expect(actual[0]?.body).toContain('"max_tokens":1024');
    },
  );

  it("fails the golden comparison when a model field that changes the request is altered", async () => {
    const golden = await readGolden();
    const altered = await captureConfiguredModelRequest({ provider: "magpie", maxTokens: 512 });
    expect(altered).not.toEqual(golden["magpie"]);
  });
});

it("preserves a denied tool call across native session restart and delivers only the new prompt", async () => {
  class HistoryProjection extends RecordingProjection {
    saved: readonly unknown[] = [];
    async captureHistory(input: { messages: readonly unknown[] }) {
      this.saved = JSON.parse(JSON.stringify(input.messages)) as unknown[];
      return {
        runId: request.runId,
        operationKey: "snapshot:test",
        payloadRef: "native-test",
        dataClassification: "private" as const,
      };
    }
  }
  const firstModel = await createFauxModelFixture("请求被拒绝，未写入", {
    name: "restaurant_search",
    id: "refused-call",
    arguments: { query: "test" },
  });
  const firstProjection = new HistoryProjection({
    ...DEFAULT_CONTEXT,
    history: [],
    prompt: { id: "first", content: "执行测试工具", occurredAt: NOW },
  });
  const tools = new RecordingRuntimeTools();
  tools.execute.mockResolvedValue({
    outcome: "failed",
    resultRef: null,
    errorCode: "approval_denied",
    externalActionId: null,
    modelContent: "用户拒绝，未执行",
  });
  const make = (projection: RecordingProjection, models: typeof firstModel.models) =>
    new PiAgentRuntimeAdapter({
      egress: testModelEgress(),
      projection,
      tools,
      models,
      cwd: process.cwd(),
      now: () => NOW,
      admission: async (scope) => allowAdmission(scope),
      logicalSlot: (r, n) => `${r.runId}:history:${n}`,
    });
  expect(
    (
      await collect(
        make(firstProjection, firstModel.models).run({
          ...request,
          modelRef: firstModel.descriptor.ref,
        }),
      )
    ).at(-1)?.type,
  ).toBe("runtime.completed");
  expect(firstProjection.saved).toContainEqual(
    expect.objectContaining({ role: "toolResult", toolCallId: "refused-call", isError: true }),
  );
  const secondModel = await createFauxModelFixture("处理新的天气问题");
  const nextProjection = new HistoryProjection({
    ...DEFAULT_CONTEXT,
    history: [],
    nativeHistory: { messages: firstProjection.saved, coveredRunIds: [request.runId] },
    prompt: { id: "weather", content: "现在的天气怎么样？", occurredAt: NOW },
  });
  const nextRequest = {
    ...request,
    runId: fixtureIdentifier<RuntimeRequest["runId"]>("history-second-run"),
    modelRef: secondModel.descriptor.ref,
  };
  expect(
    (await collect(make(nextProjection, secondModel.models).run(nextRequest))).at(-1)?.type,
  ).toBe("runtime.completed");
  const context = secondModel.observed[0] as { messages: unknown[] };
  expect(context.messages).toContainEqual(
    expect.objectContaining({ role: "toolResult", toolCallId: "refused-call", isError: true }),
  );
  expect(JSON.stringify(context.messages)).toContain("approval_denied");
  expect(lastOwnerWords(context.messages)).toBe("现在的天气怎么样？");
  expect(tools.execute).toHaveBeenCalledTimes(1);
});

it("puts the turn time and owner material in the last user turn and saves that turn exactly as sent", async () => {
  class HistoryProjection extends RecordingProjection {
    saved: readonly unknown[] = [];
    async captureHistory(input: { messages: readonly unknown[] }) {
      this.saved = JSON.parse(JSON.stringify(input.messages)) as unknown[];
      return {
        runId: request.runId,
        operationKey: "snapshot:owner-material",
        payloadRef: "native-owner-material",
        dataClassification: "private" as const,
      };
    }
  }
  const model = await createFauxModelFixture("记下了，你老婆叫管冬融。");
  const projection = new HistoryProjection({
    ...DEFAULT_CONTEXT,
    history: [
      {
        id: "weather-question",
        role: "user",
        content: [{ type: "text", text: "搜一下今天东京的天气，简短回答" }],
        occurredAt: NOW,
      },
      {
        id: "weather-answer",
        role: "assistant",
        content: [{ type: "text", text: "东京今天多云，午后转晴。" }],
        occurredAt: NOW,
      },
    ],
    contextBlocks: [
      {
        authority: "non-authoritative",
        kind: "memory-snapshot",
        ref: "memory-snapshot:agent",
        content:
          "记忆清单（每条前面是编号；要看日期、原话和旧版本，用 memory_open 按编号打开）：\n身份\n1主人住在东京都北区。\n偏好\n2我喜欢喝美式\n你还能查到的：\n- 清单里每条只有一句话，日期、原话和旧版本没有放进来，用 memory_open 按编号打开。",
        dataClassification: "private",
      },
      {
        authority: "non-authoritative",
        kind: "memory",
        ref: "memory-colleague",
        content: "主人有一个前同事叫白刚。",
        dataClassification: "private",
      },
    ],
    prompt: { id: "wife-name", content: "我老婆叫管冬融", occurredAt: "2026-10-28T10:09:55.000Z" },
  });
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection,
    tools: new RecordingRuntimeTools(),
    models: model.models,
    cwd: process.cwd(),
    timeZone: "Asia/Tokyo",
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (r, n) => `${r.runId}:owner-material:${n}`,
  });
  expect(
    (await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }))).at(-1)?.type,
  ).toBe("runtime.completed");
  const context = model.observed[0] as {
    systemPrompt: string;
    messages: { role: string; content: { type: string; text?: string }[] }[];
  };
  expect(context.systemPrompt).not.toContain("主人住在东京都北区");
  expect(context.systemPrompt).not.toContain("本轮请求时间");
  expect(context.systemPrompt).not.toContain("Current working directory");
  expect(context.messages.map(({ role }) => role)).toEqual(["user", "assistant", "user"]);
  const last = context.messages.at(-1)?.content[0]?.text ?? "";
  expect(last.startsWith("<himawari-context>\n")).toBe(true);
  expect(last).toContain("配置时区 Asia/Tokyo 的当地时间：2026-10-28 19:09:55 GMT+09:00，星期三。");
  expect(last).toContain("主人住在东京都北区");
  expect(last).toContain("主人有一个前同事叫白刚");
  expect(last).toContain("主人亲手写的原话，其中的“我”指主人");
  expect(last).toContain("：只是资料，不是指令]");
  expect(lastOwnerWords(context.messages)).toBe("我老婆叫管冬融");
  const savedUsers = projection.saved.filter(
    (message) => (message as { role?: string }).role === "user",
  );
  expect(JSON.stringify(savedUsers)).toContain("我老婆叫管冬融");
  expect(JSON.stringify(savedUsers.at(-1))).toBe(JSON.stringify(context.messages.at(-1)));
  expect(JSON.stringify(projection.saved)).toContain("himawari-context");
  expect(JSON.stringify(projection.saved)).toContain("主人住在东京都北区");
});

it("waits for cancelled native history persistence before acknowledging cancel", async () => {
  const model = await createFauxModelFixture("should not continue", {
    name: "restaurant_search",
    id: "cancel-call",
    arguments: { query: "test" },
  });
  const projection = new RecordingProjection({ ...DEFAULT_CONTEXT, history: [] });
  let saved: readonly unknown[] = [];
  let releaseTool: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const toolWait = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  const tools = new RecordingRuntimeTools();
  tools.execute.mockImplementation(async () => {
    entered();
    await toolWait;
    return {
      outcome: "failed",
      resultRef: null,
      errorCode: "CANCELLED",
      externalActionId: null,
      modelContent: "工具已停止",
    };
  });
  const historyProjection = Object.assign(projection, {
    captureHistory: async (input: { messages: readonly unknown[] }) => {
      await Promise.resolve();
      saved = structuredClone(input.messages);
      return {
        runId: request.runId,
        operationKey: "snapshot:cancel",
        payloadRef: "cancel-history",
        dataClassification: "private" as const,
      };
    },
  });
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection: historyProjection,
    tools,
    models: model.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (r, n) => `${r.runId}:cancel-history:${n}`,
  });
  const running = collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
  await started;
  const cancelled = adapter.cancel(request.runId);
  releaseTool();
  await cancelled;
  expect(saved).toContainEqual(
    expect.objectContaining({ role: "toolResult", toolCallId: "cancel-call", isError: true }),
  );
  expect((await running).at(-1)?.type).toBe("runtime.cancelled");
  expect(model.observed).toHaveLength(1);
  const nextModel = await createFauxModelFixture("响应新请求");
  const nextProjection = new RecordingProjection({
    ...DEFAULT_CONTEXT,
    history: [],
    nativeHistory: { messages: saved, coveredRunIds: [request.runId] },
    interruptedRunId: request.runId,
    prompt: { id: "after-cancel", content: "只读取验收文件，不执行旧工具。", occurredAt: NOW },
  });
  const next = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection: nextProjection,
    tools,
    models: nextModel.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (r, n) => `${r.runId}:after-cancel:${n}`,
  });
  await collect(
    next.run({
      ...request,
      modelRef: nextModel.descriptor.ref,
      runId: fixtureIdentifier("after-cancel"),
    }),
  );
  expect(JSON.stringify(nextModel.observed[0])).toContain("turn_aborted");
  expect(lastOwnerWords((nextModel.observed[0] as { messages: unknown[] }).messages)).toBe(
    "只读取验收文件，不执行旧工具。",
  );
  expect(tools.execute).toHaveBeenCalledTimes(1);
});

it("does not call the model when native history cannot be persisted", async () => {
  const model = await createFauxModelFixture("must not run");
  const projection = Object.assign(new RecordingProjection(), {
    captureHistory: async () => {
      throw new Error("DISK_WRITE_FAILED");
    },
  });
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection,
    tools: new RecordingRuntimeTools(),
    models: model.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (_r, n) => `failed-history:${n}`,
  });
  const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
  expect(model.observed).toEqual([]);
  expect(events.at(-1)?.type).toBe("runtime.failed");
  expect(events.some((event) => event.type === "runtime.completed")).toBe(false);
});

it("does not execute a tool when saving its assistant request fails", async () => {
  const model = await createFauxModelFixture("must not finish", {
    name: "restaurant_search",
    id: "unsaved-call",
    arguments: { query: "test" },
  });
  const tools = new RecordingRuntimeTools();
  const projection = Object.assign(new RecordingProjection({ ...DEFAULT_CONTEXT, history: [] }), {
    captureHistory: async (input: { messages: readonly unknown[] }) => {
      if (
        input.messages.some(
          (message) =>
            message !== null &&
            typeof message === "object" &&
            "role" in message &&
            message.role === "assistant",
        )
      )
        throw new Error("DISK_WRITE_FAILED");
      return {
        runId: request.runId,
        operationKey: "snapshot:user",
        payloadRef: "persisted-user",
        dataClassification: "private" as const,
      };
    },
  });
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection,
    tools,
    models: model.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (_r, n) => `unsaved-tool:${n}`,
  });
  const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
  expect(model.observed).toHaveLength(1);
  expect(tools.execute).not.toHaveBeenCalled();
  expect(events.at(-1)?.type).not.toBe("runtime.completed");
});

it("[TG-1] times the waits before a tool runs: history write, event backlog and recovery save", async () => {
  const model = await createFauxModelFixture("完成", {
    name: "restaurant_search",
    id: "timed-call",
    arguments: { query: "test" },
  });
  const tools = new RecordingRuntimeTools();
  const measured: string[] = [];
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection: new RecordingProjection({ ...DEFAULT_CONTEXT, history: [] }),
    tools,
    models: model.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (_r, n) => `timed-tool:${n}`,
    continuations: {
      save: async () => "continuation:timed",
      load: async () => null,
    },
    measure: async (runId, name, work) => {
      expect(runId).toBe(request.runId);
      measured.push(name);
      return work();
    },
  });
  const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
  expect(tools.execute).toHaveBeenCalledTimes(1);
  expect(events.at(-1)?.type).toBe("runtime.completed");
  expect(measured).toEqual(["tool.history_wait", "tool.checkpoint.drain", "tool.checkpoint.save"]);
});

it("restores already disclosed batch results across consecutive approvals without re-entering expired executions", async () => {
  const model = await createFauxModelFixture("完成", [
    { name: "controlled_action", id: "completed-before-wait", arguments: { value: "first" } },
    { name: "controlled_action", id: "waiting-action", arguments: { value: "second" } },
    { name: "controlled_action", id: "third-action", arguments: { value: "third" } },
  ]);
  const projection = new RecordingProjection();
  const snapshots = new Map<string, string>();
  const calls: string[] = [];
  let approvals = 0;
  const tools: RuntimeToolPort = {
    listAuthorized: async () => [
      {
        name: "controlled_action",
        description: "Controlled fixture",
        capabilityRef: "test.batch",
        capabilityHandleRef: null,
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    ],
    preflight: async () => ({
      allowed: true,
      permissionDecisionRef: "test",
      reasonCode: "evaluate",
    }),
    execute: async (call) => {
      calls.push(call.toolCallId);
      if (
        (approvals > 0 && call.toolCallId === "completed-before-wait") ||
        (approvals > 1 && call.toolCallId === "waiting-action")
      )
        throw new Error("PORT_HANDLE_REVOKED");
      if (
        (approvals === 0 && call.toolCallId === "waiting-action") ||
        (approvals === 1 && call.toolCallId === "third-action")
      )
        return {
          outcome: "awaiting_approval",
          approval: {
            approvalRequestId: `approval:${call.toolCallId}`,
            semanticSnapshotHash: `frozen:${call.toolCallId}`,
            expiresAt: "2999-01-01T00:00:00Z",
          },
          resultRef: null,
          errorCode: null,
          externalActionId: null,
          modelContent: "",
        };
      return {
        outcome: "succeeded",
        resultRef: `result:${call.toolCallId}`,
        errorCode: null,
        externalActionId: null,
        modelContent:
          call.toolCallId === "completed-before-wait"
            ? "first confirmed result"
            : "second confirmed result",
      };
    },
  };
  const create = () =>
    new PiAgentRuntimeAdapter({
      egress: testModelEgress(),
      projection,
      tools,
      models: model.models,
      cwd: process.cwd(),
      now: () => NOW,
      admission: async (scope) => allowAdmission(scope),
      logicalSlot: (_request, ordinal) => `batch-history:${ordinal}`,
      continuations: {
        save: async (_request, value) => {
          const ref = `continuation:${snapshots.size}`;
          snapshots.set(ref, JSON.stringify(value));
          return ref;
        },
        load: async (_request, ref) => JSON.parse(snapshots.get(ref) ?? "null"),
      },
    });
  const input = { ...request, modelRef: model.descriptor.ref };
  const first = await collect(create().run(input));
  const suspended = first.at(-1);
  expect(suspended?.type).toBe("runtime.suspended");
  if (suspended?.type !== "runtime.suspended") throw new Error("Expected approval wait");
  expect(snapshots.size).toBe(2);
  expect(JSON.parse(snapshots.get(suspended.continuationRef) ?? "null")).toMatchObject({
    batch: {
      waitingToolCallId: "waiting-action",
      completedResults: [
        {
          toolCallId: "completed-before-wait",
          content: [{ type: "text", text: "first confirmed result" }],
        },
      ],
    },
  });
  approvals = 1;
  const secondWait = await collect(
    create().run({ ...input, continuationRef: suspended.continuationRef }),
  );
  const nextWait = secondWait.at(-1);
  expect(nextWait?.type).toBe("runtime.suspended");
  if (nextWait?.type !== "runtime.suspended") throw new Error("Expected third approval wait");
  approvals = 2;
  const resumed = await collect(
    create().run({ ...input, continuationRef: nextWait.continuationRef }),
  );
  expect(resumed.at(-1)).toMatchObject({ type: "runtime.completed" });
  expect(calls).toEqual([
    "completed-before-wait",
    "waiting-action",
    "waiting-action",
    "third-action",
    "third-action",
  ]);
  expect(model.observed).toHaveLength(2);
  const sent = JSON.stringify(model.observed.at(-1));
  expect(sent).toContain("first confirmed result");
  expect(sent).toContain("second confirmed result");
  expect(sent).not.toContain("PORT_HANDLE_REVOKED");
});

it.each([
  ["the later search asks second", 0, 60],
  ["the later search asks first", 60, 0],
])(
  "waits for every parallel search of the step to reach its approval before suspending, when %s",
  async (_label, tokyoDelay, osakaDelay) => {
    const model = await createFauxModelFixture("完成", [
      { name: "web_search", id: "search-tokyo", arguments: { query: "Tokyo weather" } },
      { name: "web_search", id: "search-osaka", arguments: { query: "Osaka weather" } },
    ]);
    const settled: string[] = [];
    const delays: Record<string, number> = {
      "search-tokyo": tokyoDelay,
      "search-osaka": osakaDelay,
    };
    const tools: RuntimeToolPort = {
      listAuthorized: async () => [
        {
          name: "web_search",
          description: "Search",
          capabilityRef: "search.web_search",
          capabilityHandleRef: null,
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
          executionMode: "parallel",
        },
      ],
      preflight: async (call) => {
        await new Promise((resolve) => setTimeout(resolve, delays[call.toolCallId] ?? 0));
        return { allowed: true, permissionDecisionRef: "test", reasonCode: "evaluate" };
      },
      execute: async (call) => {
        settled.push(call.toolCallId);
        return {
          outcome: "awaiting_approval",
          approval: {
            approvalRequestId: `approval:${call.toolCallId}`,
            semanticSnapshotHash: `frozen:${call.toolCallId}`,
            expiresAt: "2999-01-01T00:00:00Z",
          },
          resultRef: null,
          errorCode: null,
          externalActionId: null,
          modelContent: "",
        };
      },
    };
    const snapshots = new Map<string, string>();
    const adapter = new PiAgentRuntimeAdapter({
      egress: testModelEgress(),
      projection: new RecordingProjection(),
      tools,
      models: model.models,
      cwd: process.cwd(),
      now: () => NOW,
      admission: async (scope) => allowAdmission(scope),
      logicalSlot: (_request, ordinal) => `parallel-approval:${ordinal}`,
      continuations: {
        save: async (_request, value) => {
          const ref = `continuation:${snapshots.size}`;
          snapshots.set(ref, JSON.stringify(value));
          return ref;
        },
        load: async (_request, ref) => JSON.parse(snapshots.get(ref) ?? "null"),
      },
    });
    const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
    const suspended = events.at(-1);
    expect(suspended?.type).toBe("runtime.suspended");
    expect([...settled].sort()).toEqual(["search-osaka", "search-tokyo"]);
    expect(suspended).toMatchObject({
      approval: { approvalRequestId: `approval:${settled.at(-1)}` },
    });
    expect(model.observed).toHaveLength(1);
  },
);

it("summarizes confirmed results once after a loop without declaring task success", async () => {
  const calls = Array.from({ length: 4 }, (_, index) => ({
    name: "restaurant_search",
    id: `repeat-${index}`,
    arguments: { query: "same request" },
  }));
  const model = await createFauxModelFixture(
    "Confirmed results are available; the task was stopped by the loop guard",
    calls[0],
    calls.slice(1).map((call) => [call]),
  );
  const projection = new HistoryRecordingProjection();
  const tools = new RecordingRuntimeTools();
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection,
    tools,
    models: model.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (_request, ordinal) => `loop:${ordinal}`,
  });
  const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
  expect(events.at(-1)).toMatchObject({
    type: "runtime.failed",
    errorCode: "PI_TOOL_LOOP_DETECTED",
  });
  expect(events.some((event) => event.type === "runtime.completed")).toBe(false);
  expect(tools.execute).toHaveBeenCalledTimes(4);
  expect(model.observed).toHaveLength(5);
  const finalContext = model.observed.at(-1) as {
    tools: unknown[];
    messages: unknown[];
    systemPrompt: string;
  };
  expectLoopStoppedByAppendedMessage(model.observed);
  expect(
    finalContext.messages.filter((m) => (m as { role: string }).role === "toolResult"),
  ).toHaveLength(4);
  const saved = JSON.stringify(projection.histories.at(-1));
  expect(saved).toContain('"customType":"himawari.tool-loop.stopped"');
  expect(saved).toContain(CHAT_TOOL_LOOP_STOPPED.text);
  expect(JSON.stringify(projection.captures)).toContain("Confirmed results are available");
  expect(projection.finalAnswers).toHaveLength(0);
});

it("[ADR-0257] stops the run after the configured refusals in a row, even when each call asks for something different", async () => {
  const calls = Array.from({ length: 3 }, (_, index) => ({
    name: "restaurant_search",
    id: `refused-${index}`,
    arguments: { query: `different request ${index}` },
  }));
  const model = await createFauxModelFixture(
    "The owner should decide; nothing was done",
    calls[0],
    calls.slice(1).map((call) => [call]),
  );
  const projection = new HistoryRecordingProjection();
  const tools = new RecordingRuntimeTools();
  tools.execute.mockImplementation(async () => ({
    outcome: "failed" as const,
    refused: true as const,
    dispatchState: "not_sent" as const,
    resultRef: null,
    errorCode: "action_rule_refused",
    externalActionId: null,
    modelContent: "操作未执行：action_rule_refused",
  }));
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection,
    tools,
    models: model.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (_request, ordinal) => `refused:${ordinal}`,
    toolRefusalLimits: { consecutive: 3, total: 20 },
  });
  const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
  expect(events.at(-1)).toMatchObject({
    type: "runtime.failed",
    errorCode: "PI_TOOL_LOOP_DETECTED",
  });
  expect(tools.execute).toHaveBeenCalledTimes(3);
  expectLoopStoppedByAppendedMessage(model.observed);
  expect(JSON.stringify(projection.captures)).toContain("The owner should decide");
});

it("[ADR-0257] counts a call the tool layer refuses before dispatch toward the refusal limit", async () => {
  const calls = Array.from({ length: 3 }, (_, index) => ({
    name: "restaurant_search",
    id: `preflight-refused-${index}`,
    arguments: { query: `different request ${index}` },
  }));
  const model = await createFauxModelFixture(
    "Nothing was allowed",
    calls[0],
    calls.slice(1).map((call) => [call]),
  );
  const tools = new RecordingRuntimeTools();
  tools.preflight.mockImplementation(async () => ({
    allowed: false,
    permissionDecisionRef: "denied",
    reasonCode: "OWNER_SCOPE",
  }));
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection: new HistoryRecordingProjection(),
    tools,
    models: model.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (_request, ordinal) => `preflight-refused:${ordinal}`,
    toolRefusalLimits: { consecutive: 3, total: 20 },
  });
  const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
  expect(events.at(-1)).toMatchObject({
    type: "runtime.failed",
    errorCode: "PI_TOOL_LOOP_DETECTED",
  });
  expect(tools.preflight).toHaveBeenCalledTimes(3);
  expect(tools.execute).not.toHaveBeenCalled();
});

it("[ADR-0257] keeps going below the refusal limit", async () => {
  const calls = Array.from({ length: 2 }, (_, index) => ({
    name: "restaurant_search",
    id: `refused-below-${index}`,
    arguments: { query: `different request ${index}` },
  }));
  const model = await createFauxModelFixture(
    "Told the owner what was refused",
    calls[0],
    calls.slice(1).map((call) => [call]),
  );
  const tools = new RecordingRuntimeTools();
  tools.execute.mockImplementation(async () => ({
    outcome: "failed" as const,
    refused: true as const,
    dispatchState: "not_sent" as const,
    resultRef: null,
    errorCode: "action_rule_refused",
    externalActionId: null,
    modelContent: "操作未执行：action_rule_refused",
  }));
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection: new HistoryRecordingProjection(),
    tools,
    models: model.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (_request, ordinal) => `refused-below:${ordinal}`,
    toolRefusalLimits: { consecutive: 3, total: 20 },
  });
  const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
  expect(events.at(-1)).toMatchObject({ type: "runtime.completed" });
  expect(tools.execute).toHaveBeenCalledTimes(2);
});

it.each([
  "matching-id",
  "worker-id",
  "content",
  "details",
  "source",
  "non-string-id",
  "mismatched-tool",
  "custom-tool",
])(
  "compares governed tool results independently of invocation identity (other change: %s)",
  async (change) => {
    const calls = Array.from({ length: 4 }, (_, index) => ({
      name: "ls",
      id: `provenance-${index}`,
      arguments: { path: "/authorized" },
    }));
    const model = await createFauxModelFixture(
      "Results reported",
      calls[0],
      calls.slice(1).map((call) => [call]),
    );
    const tools = new RecordingRuntimeTools();
    vi.spyOn(tools, "listAuthorized").mockResolvedValue([
      change === "custom-tool"
        ? {
            name: "ls",
            capabilityRef: "custom",
            capabilityHandleRef: null,
            description: "Custom tool",
            parameters: { type: "object", properties: { path: { type: "string" } } },
          }
        : {
            definition: "builtin-coding",
            name: "ls",
            capabilityRef: "project.ls",
            capabilityHandleRef: null,
          },
    ]);
    tools.execute.mockImplementation(async (call) => ({
      outcome: "succeeded",
      resultRef: `result:${call.toolCallId}`,
      errorCode: null,
      externalActionId: null,
      modelContent: JSON.stringify({
        schemaVersion: "pi-result.v1",
        tool: change === "mismatched-tool" ? "another_tool" : "ls",
        content: [{ type: "text", text: change === "content" ? call.toolCallId : "same result" }],
        details: change === "details" ? { observed: call.toolCallId } : {},
        fullOutput: null,
        isError: false,
        commandExitCode: null,
        verifiedWrite: null,
        source: {
          toolCallId:
            change === "matching-id" || change === "custom-tool"
              ? call.toolCallId
              : change === "non-string-id"
                ? Number(call.toolCallId.slice(-1))
                : `file-phase:${call.toolCallId}`,
          workspace: change === "source" ? `/authorized/${call.toolCallId}` : "/authorized",
          parameters: call.arguments,
        },
      }),
    }));
    const adapter = new PiAgentRuntimeAdapter({
      egress: testModelEgress(),
      projection: new RecordingProjection(),
      tools,
      models: model.models,
      cwd: process.cwd(),
      now: () => NOW,
      admission: async (scope) => allowAdmission(scope),
      logicalSlot: (_request, ordinal) => `provenance:${ordinal}`,
    });
    const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
    expect(events.at(-1)).toMatchObject(
      !["matching-id", "worker-id"].includes(change)
        ? { type: "runtime.completed" }
        : { type: "runtime.failed", errorCode: "PI_TOOL_LOOP_DETECTED" },
    );
    expect(tools.execute).toHaveBeenCalledTimes(4);
    expect(model.observed).toHaveLength(5);
    const context = model.observed.at(-1) as { tools: unknown[]; messages: unknown[] };
    expect(context.tools.length).toBeGreaterThan(0);
    expect(JSON.stringify(context.messages.at(-1)).includes(CHAT_TOOL_LOOP_STOPPED.text)).toBe(
      ["matching-id", "worker-id"].includes(change),
    );
    expect(JSON.stringify(context.messages)).toContain("provenance-3");
  },
);

it("preserves loop detection across approval without counting local result replay", async () => {
  const calls = Array.from({ length: 4 }, (_, index) => ({
    name: "restaurant_search",
    id: `approval-loop-${index}`,
    arguments: { query: "same request" },
  }));
  const model = await createFauxModelFixture("Partial results after approval", calls);
  const projection = new RecordingProjection();
  const tools = new RecordingRuntimeTools();
  let approved = false;
  tools.execute.mockImplementation(async (call) => {
    if (call.toolCallId === "approval-loop-3" && !approved)
      return {
        outcome: "awaiting_approval",
        approval: {
          approvalRequestId: "loop-approval",
          semanticSnapshotHash: "loop-frozen",
          expiresAt: "2999-01-01T00:00:00Z",
        },
        resultRef: null,
        errorCode: null,
        externalActionId: null,
        modelContent: "",
      };
    return {
      outcome: "succeeded",
      resultRef: "same-result",
      errorCode: null,
      externalActionId: null,
      modelContent: "same output",
    };
  });
  let saved: unknown;
  const create = () =>
    new PiAgentRuntimeAdapter({
      egress: testModelEgress(),
      projection,
      tools,
      models: model.models,
      cwd: process.cwd(),
      now: () => NOW,
      admission: async (scope) => allowAdmission(scope),
      logicalSlot: (_request, ordinal) => `approval-loop:${ordinal}`,
      continuations: {
        save: async (_request, value) => {
          saved = structuredClone(value);
          return "loop-continuation";
        },
        load: async () => structuredClone(saved),
      },
    });
  const input = { ...request, modelRef: model.descriptor.ref };
  const waiting = (await collect(create().run(input))).at(-1);
  expect(waiting?.type).toBe("runtime.suspended");
  if (waiting?.type !== "runtime.suspended") throw new Error("Expected approval wait");
  approved = true;
  const resumed = await collect(
    create().run({ ...input, continuationRef: waiting.continuationRef }),
  );
  expect(resumed.at(-1)).toMatchObject({
    type: "runtime.failed",
    errorCode: "PI_TOOL_LOOP_DETECTED",
  });
  expect(tools.execute).toHaveBeenCalledTimes(5);
  expect(model.observed).toHaveLength(2);
  expectLoopStoppedByAppendedMessage(model.observed);
  expect(projection.finalAnswers).toHaveLength(0);
});

it("preserves native cancellation provenance across repeated session restoration", async () => {
  const marker = {
    role: "custom",
    customType: "himawari.turn_aborted",
    content: "<turn_aborted>Old task cancelled; do not resume automatically.</turn_aborted>",
    display: false,
    timestamp: 1,
  };
  let history: readonly unknown[] = [{ role: "user", content: "old task", timestamp: 0 }, marker];
  for (let turn = 0; turn < 2; turn++) {
    const model = await createFauxModelFixture("new task answered");
    const projection = Object.assign(
      new RecordingProjection({
        ...DEFAULT_CONTEXT,
        history: [],
        nativeHistory: { messages: history, coveredRunIds: [] },
        prompt: { id: `new-${turn}`, content: `new task ${turn}`, occurredAt: NOW },
      }),
      {
        captureHistory: async (input: { messages: readonly unknown[] }) => {
          history = structuredClone(input.messages);
          return {
            runId: request.runId,
            operationKey: `custom:${turn}`,
            payloadRef: `custom:${turn}`,
            dataClassification: "private" as const,
          };
        },
      },
    );
    const tools = new RecordingRuntimeTools();
    const adapter = new PiAgentRuntimeAdapter({
      egress: testModelEgress(),
      projection,
      tools,
      models: model.models,
      cwd: process.cwd(),
      now: () => NOW,
      admission: async (scope) => allowAdmission(scope),
      logicalSlot: (_request, ordinal) => `native-custom:${turn}:${ordinal}`,
    });
    expect(
      (await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }))).at(-1),
    ).toMatchObject({ type: "runtime.completed" });
    expect(history).toContainEqual(marker);
    const outbound = model.observed[0] as { messages: Array<{ role: string; content: unknown }> };
    expect(outbound.messages.every((message) => message.role !== "custom")).toBe(true);
    expect(JSON.stringify(outbound)).toContain("Old task cancelled");
    expect(tools.execute).not.toHaveBeenCalled();
  }
});

it("allows ordinary multi-step work and repeated reads below the loop threshold", async () => {
  const calls = Array.from({ length: 3 }, (_, index) => ({
    name: "restaurant_search",
    id: `valid-step-${index}`,
    arguments: { query: "same request" },
  }));
  const model = await createFauxModelFixture(
    "Task completed",
    calls[0],
    calls.slice(1).map((call) => [call]),
  );
  const tools = new RecordingRuntimeTools();
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection: new RecordingProjection(),
    tools,
    models: model.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (_request, ordinal) => `valid-step:${ordinal}`,
  });
  const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
  expect(events.at(-1)?.type).toBe("runtime.completed");
  expect(tools.execute).toHaveBeenCalledTimes(3);
  expect(model.observed).toHaveLength(4);
  expect((model.observed.at(-1) as { tools: unknown[] }).tools.length).toBeGreaterThan(0);
});

it("does not execute tools or pay for a second summary if the finalizer requests a tool", async () => {
  const calls = Array.from({ length: 5 }, (_, index) => ({
    name: "restaurant_search",
    id: `stubborn-${index}`,
    arguments: { query: "same request" },
  }));
  const model = await createFauxModelFixture(
    "Must never reach a second summary",
    calls[0],
    calls.slice(1).map((call) => [call]),
  );
  const tools = new RecordingRuntimeTools();
  const projection = new RecordingProjection();
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection,
    tools,
    models: model.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (_request, ordinal) => `stubborn:${ordinal}`,
  });
  const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
  expect(events.at(-1)).toMatchObject({
    type: "runtime.failed",
    errorCode: "PI_TOOL_LOOP_DETECTED",
  });
  expect(tools.execute).toHaveBeenCalledTimes(4);
  expect(model.observed).toHaveLength(5);
  expectLoopStoppedByAppendedMessage(model.observed);
  expect(projection.finalAnswers).toHaveLength(0);
});

it("keeps summary generation behind the model admission gate", async () => {
  const calls = Array.from({ length: 4 }, (_, index) => ({
    name: "restaurant_search",
    id: `budget-loop-${index}`,
    arguments: { query: "same request" },
  }));
  const model = await createFauxModelFixture(
    "Must not spend without admission",
    calls[0],
    calls.slice(1).map((call) => [call]),
  );
  const tools = new RecordingRuntimeTools();
  let admissions = 0;
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection: new RecordingProjection(),
    tools,
    models: model.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => {
      admissions++;
      if (admissions === 5) throw new Error("budget exhausted");
      return allowAdmission(scope);
    },
    logicalSlot: (_request, ordinal) => `budget-loop:${ordinal}`,
  });
  const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
  expect(events.at(-1)).toMatchObject({
    type: "runtime.failed",
    errorCode: "PI_TOOL_LOOP_DETECTED",
  });
  expect(admissions).toBe(5);
  expect(model.observed).toHaveLength(4);
  expect(tools.execute).toHaveBeenCalledTimes(4);
});

it("preserves owner cancellation during admission of the loop summary", async () => {
  const calls = Array.from({ length: 4 }, (_, index) => ({
    name: "restaurant_search",
    id: `cancel-summary-${index}`,
    arguments: { query: "same request" },
  }));
  const model = await createFauxModelFixture(
    "Must not answer after cancellation",
    calls[0],
    calls.slice(1).map((call) => [call]),
  );
  const tools = new RecordingRuntimeTools();
  let admissions = 0;
  let cancellation: Promise<void> | undefined;
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection: new RecordingProjection(),
    tools,
    models: model.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => {
      if (++admissions === 5) cancellation = adapter.cancel(request.runId);
      return allowAdmission(scope);
    },
    logicalSlot: (_request, ordinal) => `cancel-summary:${ordinal}`,
  });
  const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
  await cancellation;
  expect(events.at(-1)?.type).toBe("runtime.cancelled");
  expect(events.some((event) => event.type === "runtime.completed")).toBe(false);
  expect(model.observed).toHaveLength(4);
  expect(tools.execute).toHaveBeenCalledTimes(4);
});

it.each(["saved", "storage-failed"] as const)(
  "persists a protected Pi batch before entering the product tool: %s",
  async (mode) => {
    const model = await createFauxModelFixture("完成", {
      name: "controlled_action",
      id: "checkpoint-call",
      arguments: { value: "test" },
    });
    const projection = new RecordingProjection();
    let effects = 0;
    const snapshots: unknown[] = [];
    const save = vi.fn(async (_request: RuntimeRequest, value: unknown) => {
      expect(effects).toBe(0);
      if (mode === "storage-failed") throw new Error("private checkpoint storage diagnostic");
      snapshots.push(structuredClone(value));
      return "protected-before-tool";
    });
    const execute = vi.fn(async (call: Parameters<RuntimeToolPort["execute"]>[0]) => {
      expect(call.context?.continuationRef).toBe("protected-before-tool");
      expect(snapshots).toHaveLength(1);
      effects++;
      return {
        outcome: "succeeded" as const,
        resultRef: "result",
        errorCode: null,
        externalActionId: null,
        modelContent: "已执行",
      };
    });
    const adapter = new PiAgentRuntimeAdapter({
      egress: testModelEgress(),
      projection,
      models: model.models,
      cwd: process.cwd(),
      now: () => NOW,
      admission: async (scope) => allowAdmission(scope),
      logicalSlot: (_request, ordinal) => `pre-tool-checkpoint:${ordinal}`,
      tools: {
        listAuthorized: async () => [
          {
            name: "controlled_action",
            description: "test",
            capabilityRef: "test.checkpoint",
            capabilityHandleRef: null,
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        ],
        preflight: async () => ({
          allowed: true,
          permissionDecisionRef: "test",
          reasonCode: "test",
        }),
        execute,
      },
      continuations: {
        save,
        load: async () => {
          throw new Error("not a resumed call");
        },
      },
    });
    const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(mode === "saved" ? 1 : 0);
    if (mode === "saved")
      expect(snapshots[0]).toMatchObject({
        batch: {
          version: "pi-tool-batch.v3",
          waitingToolCallId: "checkpoint-call",
          completedResults: [],
        },
      });
    else {
      expect(JSON.stringify(events)).not.toContain("private checkpoint storage diagnostic");
      expect(projection.captures).toContainEqual(
        expect.objectContaining({
          kind: "tool_result",
          value: expect.objectContaining({ toolCallId: "checkpoint-call", isError: true }),
        }),
      );
    }
  },
);

it.each(["known", "rejected", "missing-reader", "wrong-call"] as const)(
  "restores a known result without reentering tool execution: %s",
  async (scenario) => {
    const model = await createFauxModelFixture("已收到原结果", {
      name: "controlled_action",
      id: "late-result-call",
      arguments: { value: "original" },
    });
    const projection = new RecordingProjection();
    const snapshots = new Map<string, unknown>();
    const slots: number[] = [];
    const preflight = vi.fn(async () => ({
      allowed: true,
      permissionDecisionRef: "test",
      reasonCode: "test",
    }));
    const execute = vi.fn(async () => ({
      outcome: "result_unknown" as const,
      resultRef: null,
      errorCode: "WAIT_EXPIRED",
      externalActionId: "original-job",
      modelContent: "结果待核查",
    }));
    const recoverResult = vi.fn(async () => {
      if (scenario === "rejected") throw new Error("RESULT_NO_LONGER_DISCLOSABLE");
      return {
        outcome: "succeeded" as const,
        resultRef: "original-output",
        errorCode: null,
        externalActionId: "original-job",
        modelContent: "原工具的确定结果",
      };
    });
    const tools = {
      listAuthorized: async () => [
        {
          name: "controlled_action",
          description: "test",
          capabilityRef: "test.late-result",
          capabilityHandleRef: null,
          parameters: { type: "object", properties: { value: { type: "string" } } },
        },
      ],
      preflight,
      execute,
      ...(scenario === "missing-reader" ? {} : { recoverResult }),
    };
    const create = () =>
      new PiAgentRuntimeAdapter({
        egress: testModelEgress(),
        projection,
        tools,
        models: model.models,
        cwd: process.cwd(),
        now: () => NOW,
        admission: async (scope) => allowAdmission(scope),
        logicalSlot: (_request, ordinal) => {
          slots.push(ordinal);
          return `late-result:${ordinal}`;
        },
        continuations: {
          save: async (_request, value) => {
            const ref = `late-snapshot:${snapshots.size}`;
            snapshots.set(ref, structuredClone(value));
            return ref;
          },
          load: async (_request, ref) => structuredClone(snapshots.get(ref)),
        },
      });
    const input = { ...request, modelRef: model.descriptor.ref };
    expect((await collect(create().run(input))).at(-1)?.type).toBe("runtime.result_unknown");
    expect(execute).toHaveBeenCalledTimes(1);
    const resumedInput = {
      ...input,
      continuationRef: "late-snapshot:0",
      knownToolResult: {
        capabilityRef: "test.late-result",
        continuationRef: "late-snapshot:0",
        toolCallId: scenario === "wrong-call" ? "different-call" : "late-result-call",
        jobId: "original-job",
        invocationId: "original-invocation",
      },
    };
    const resumed = await collect(create().run(resumedInput));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(snapshots.size).toBe(1);
    if (scenario === "known") {
      expect(recoverResult).toHaveBeenCalledTimes(1);
      expect(resumed.at(-1)?.type).toBe("runtime.completed");
      expect(slots).toEqual([1, 2]);
      expect(JSON.stringify(model.observed.at(-1))).toContain("原工具的确定结果");
    } else {
      expect(resumed.at(-1)?.type).not.toBe("runtime.completed");
      expect(slots).toEqual([1]);
      expect(model.observed).toHaveLength(1);
    }
  },
);

it("forwards Pi cancellation to a product tool without persisting the signal in its identity", async () => {
  const model = await createFauxModelFixture("Must not answer after Stop", {
    name: "restaurant_search",
    id: "stop-review-call",
    arguments: { query: "test" },
  });
  const defaults = new RecordingRuntimeTools();
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal: AbortSignal | undefined;
  let identity: unknown;
  const execute = vi.fn(
    async (
      call: Parameters<RuntimeToolPort["execute"]>[0],
      options?: { signal?: AbortSignal },
    ): Promise<RuntimeToolExecutionResult> => {
      identity = structuredClone(call);
      signal = options?.signal;
      signal?.addEventListener("abort", release, { once: true });
      started();
      await waiting;
      return {
        outcome: "failed",
        resultRef: null,
        errorCode: "action_cancelled",
        externalActionId: null,
        modelContent: "操作已取消",
      };
    },
  );
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection: new RecordingProjection(),
    models: model.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (_request, ordinal) => `stop-review:${ordinal}`,
    tools: {
      listAuthorized: () => defaults.listAuthorized(),
      preflight: defaults.preflight,
      execute,
    },
  });
  const pending = collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
  await entered;
  try {
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(identity).not.toHaveProperty("signal");
    await adapter.cancel(request.runId);
    expect(signal?.aborted).toBe(true);
    expect((await pending).at(-1)?.type).toBe("runtime.cancelled");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.observed).toHaveLength(1);
  } finally {
    release();
    await adapter.cancel(request.runId);
    await pending;
  }
});

it("links regenerated file calls through native Pi history and stops changing-content conflicts", async () => {
  const calls = Array.from({ length: 4 }, (_, index) => ({
    name: "write",
    id: `file-conflict-${index}`,
    arguments: { path: "note.txt", content: `new candidate ${index}` },
  }));
  const model = await createFauxModelFixture(
    "文件持续变化，已停止重试并保留候选。",
    calls[0],
    calls
      .slice(1)
      .flatMap((call, index) => [
        [{ name: "read", id: `refresh-${index}`, arguments: { path: "note.txt" } }],
        [call],
      ]),
  );
  const tools = new RecordingRuntimeTools();
  vi.spyOn(tools, "listAuthorized").mockResolvedValue(
    ["read", "write"].map((name) => ({
      definition: "builtin-coding" as const,
      name: name as "read" | "write",
      capabilityRef: `coding.${name}`,
      capabilityHandleRef: null,
    })),
  );
  tools.execute.mockImplementation(async (call) => ({
    outcome: call.capabilityRef === "coding.write" ? "failed" : "succeeded",
    resultRef: null,
    errorCode: call.capabilityRef === "coding.write" ? "FILE_VERSION_CONFLICT" : null,
    externalActionId: null,
    modelContent:
      call.capabilityRef === "coding.write" ? "重新读取最新内容后生成新请求" : "其他人的修改",
  }));
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection: new RecordingProjection(),
    tools,
    models: model.models,
    cwd: process.cwd(),
    now: () => NOW,
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (_request, ordinal) => `file-conflict:${ordinal}`,
  });
  const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
  const writes = tools.execute.mock.calls
    .map(([call]) => call)
    .filter((call) => call.capabilityRef === "coding.write");
  expect(writes.map((call) => call.fileConflictOf)).toEqual([
    undefined,
    "file-conflict-0",
    "file-conflict-1",
    "file-conflict-2",
  ]);
  expect(events.at(-1)).toMatchObject({
    type: "runtime.failed",
    errorCode: "PI_TOOL_LOOP_DETECTED",
  });
  expect(model.observed).toHaveLength(8);
  expectLoopStoppedByAppendedMessage(model.observed);
});

describe("[NL-1] product-selected tool execution mode", () => {
  const searchParameters = {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  };
  class ModeTools extends RecordingRuntimeTools {
    readonly descriptors: readonly RuntimeToolDescriptor[];
    constructor(descriptors: readonly RuntimeToolDescriptor[]) {
      super();
      this.descriptors = descriptors;
    }
    override async listAuthorized(): Promise<readonly RuntimeToolDescriptor[]> {
      return this.descriptors;
    }
  }

  it("lets only product-marked read-only tools run in parallel and keeps the rest sequential", async () => {
    const observedOptions: FakeSessionOptions[] = [];
    const adapter = createAdapter(
      new RecordingProjection(),
      new ModeTools([
        {
          definition: "builtin-coding",
          name: "grep",
          capabilityRef: "coding.grep",
          capabilityHandleRef: null,
          executionMode: "parallel",
        },
        {
          name: "web_search",
          capabilityRef: "search.web_search",
          capabilityHandleRef: null,
          description: "Search",
          parameters: searchParameters,
          executionMode: "parallel",
        },
        {
          definition: "builtin-coding",
          name: "write",
          capabilityRef: "coding.write",
          capabilityHandleRef: null,
        },
      ]),
      fakeSessionFactory(async (emit) => {
        emit({ type: "agent_settled" });
      }, observedOptions),
    );
    await collect(adapter.run(request));
    const modes = (
      observedOptions[0]?.customTools as unknown as readonly {
        name: string;
        executionMode?: string;
      }[]
    ).map(({ name, executionMode }) => [name, executionMode]);
    expect(modes).toEqual([
      ["grep", "parallel"],
      ["web_search", "parallel"],
      ["write", "sequential"],
    ]);
  });

  it("refuses a run that marks a file-changing tool as parallel before creating a session", async () => {
    const factory = vi.fn(fakeSessionFactory(async () => {}));
    const adapter = createAdapter(
      new RecordingProjection(),
      new ModeTools([
        {
          definition: "builtin-coding",
          name: "bash",
          capabilityRef: "coding.bash",
          capabilityHandleRef: null,
          executionMode: "parallel",
        },
      ]),
      factory,
    );
    const events = await collect(adapter.run(request));
    expect(factory).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "runtime.failed" });
  });
});

class BackgroundRuntimeTools extends RecordingRuntimeTools {
  listener: ((notice: RuntimeBackgroundCommandNotice) => boolean) | undefined;
  delivered: boolean[] = [];

  subscribeBackground(
    _runId: string,
    listener: (notice: RuntimeBackgroundCommandNotice) => boolean,
  ) {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  finish(text: string) {
    this.delivered.push(
      this.listener?.({ taskRef: "background-command:test", modelContent: text }) ?? false,
    );
  }
}

function backgroundAdapter(tools: BackgroundRuntimeTools, model: { models: PiModelBindingPort }) {
  return new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection: new RecordingProjection(),
    tools,
    models: model.models,
    cwd: process.cwd(),
    now: () => new Date().toISOString(),
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (_request, ordinal) => `background:${ordinal}`,
  });
}

function messageText(context: unknown): string {
  return JSON.stringify((context as { messages: unknown[] }).messages);
}

function movedToBackground() {
  return {
    outcome: "succeeded" as const,
    resultRef: "payload-background",
    errorCode: null,
    externalActionId: null,
    modelContent: "命令已转入后台继续运行。",
  };
}

it("[BG-2] answers right away and leaves a later background result for a new turn", async () => {
  const model = await createFauxModelFixture("测试还在后台运行，结束后我再告诉你", {
    name: "restaurant_search",
    id: "long-test",
    arguments: { query: "run tests" },
  });
  const tools = new BackgroundRuntimeTools();
  tools.execute.mockImplementation(async () => movedToBackground());
  const adapter = backgroundAdapter(tools, model);
  const events = await collect(
    adapter.run({
      ...request,
      modelRef: model.descriptor.ref,
      executionDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  expect(events.at(-1)).toMatchObject({ type: "runtime.completed" });
  expect(model.observed).toHaveLength(2);
  tools.finish("后台命令已结束。输出：42 passed");
  expect(tools.delivered).toEqual([false]);
  expect(model.observed).toHaveLength(2);
});

it("[BG-2] delivers a background result before the next model call while the run is still working", async () => {
  const model = await createFauxModelFixture("已经看到后台结果", {
    name: "restaurant_search",
    id: "quick-finish",
    arguments: { query: "run tests" },
  });
  const tools = new BackgroundRuntimeTools();
  tools.execute.mockImplementation(async () => {
    tools.finish("后台命令已结束。输出：7 passed");
    return movedToBackground();
  });
  const adapter = backgroundAdapter(tools, model);
  const events = await collect(
    adapter.run({
      ...request,
      modelRef: model.descriptor.ref,
      executionDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  expect(events.at(-1)).toMatchObject({ type: "runtime.completed" });
  expect(tools.delivered).toEqual([true]);
  expect(model.observed).toHaveLength(2);
  expect(messageText(model.observed.at(-1))).toContain("7 passed");
});

it("[D5-NOTICE] delivers a background result that arrives as the last answer ends", async () => {
  const model = await createFauxModelFixture("先回答一次", undefined, [], ["已经看到后台结果"]);
  const tools = new BackgroundRuntimeTools();
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection: new RecordingProjection(),
    tools,
    models: model.models,
    cwd: process.cwd(),
    now: () => new Date().toISOString(),
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (_request, ordinal) => `background:${ordinal}`,
    createSession: async (options) => {
      const created = await createAgentSession(options);
      const stop = created.session.subscribe((event) => {
        if (event.type !== "agent_end") return;
        stop();
        tools.finish("后台命令已结束。输出：3 passed");
      });
      return created;
    },
  });
  const events = await collect(
    adapter.run({
      ...request,
      modelRef: model.descriptor.ref,
      executionDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  expect(events.at(-1)).toMatchObject({ type: "runtime.completed" });
  expect(tools.delivered).toEqual([true]);
  expect(model.observed).toHaveLength(2);
  expect(messageText(model.observed.at(-1))).toContain("3 passed");
  expect(messageText(model.observed.at(0))).not.toContain("3 passed");
});

it("[D7] pins Pi cache warming to streaming so a Pi upgrade cannot turn on idle warming", async () => {
  const model = await createFauxModelFixture("好");
  const modes: string[] = [];
  const adapter = new PiAgentRuntimeAdapter({
    egress: testModelEgress(),
    projection: new RecordingProjection(),
    tools: new RecordingRuntimeTools(),
    models: model.models,
    cwd: process.cwd(),
    now: () => new Date().toISOString(),
    admission: async (scope) => allowAdmission(scope),
    logicalSlot: (_request, ordinal) => `warming:${ordinal}`,
    createSession: async (options) => {
      modes.push(options.settingsManager?.getGlobalSettings().cacheWarming ?? "unset");
      modes.push(options.settingsManager?.getCacheWarmingMode() ?? "unset");
      return createAgentSession(options);
    },
  });
  const events = await collect(adapter.run({ ...request, modelRef: model.descriptor.ref }));
  expect(events.at(-1)).toMatchObject({ type: "runtime.completed" });
  expect(modes).toEqual(["streaming", "streaming"]);
});
