import { existsSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  ModelDescriptor,
  ModelInvocationAdmissionInput,
  ModelInvocationAdmissionPort,
  ModelInvocationExecutionContext,
  ModelInvocationIdentity,
  ModelInvocationPermit,
  RuntimeEvent,
  RuntimeProjection,
  RuntimeProjectionPort,
  RuntimeRequest,
  RuntimeToolDescriptor,
  RuntimeToolExecutionResult,
  RuntimeToolPort,
} from "@himawari-agent/application/runtime-port";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PiAgentRuntimeAdapter,
  type PiAgentRuntimeAdapterDependencies,
  type PiModelBinding,
} from "../src/index.js";
import { createFauxModelFixture } from "./faux-model-fixture.js";

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
  contextWindow: 1024,
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
  original: (model: Model<Api>, context: unknown, options?: unknown) => AssistantMessageEventStream,
  observedTerminals: string[],
  streamModel: Model<Api> = ADMISSION_MODEL,
  streamOptions: unknown = {},
) {
  return async () => {
    let listener: (event: FakePiEvent) => void = () => undefined;
    const agent = { streamFunction: original };
    const session = {
      agent,
      subscribe(next: (event: FakePiEvent) => void) {
        listener = next;
        return () => {
          listener = () => undefined;
        };
      },
      async prompt() {
        const response = await agent.streamFunction(streamModel, { messages: [] }, streamOptions);
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

class RecordingRuntimeTools implements RuntimeToolPort {
  readonly preflight = vi.fn(async () => ({
    allowed: true,
    permissionDecisionRef: "permission-task-11",
    reasonCode: "grant_allows",
  }));
  readonly execute = vi.fn(
    async (): Promise<RuntimeToolExecutionResult> => ({
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
        agent: {
          abort() {},
          streamFunction: async () => {
            throw new Error("fake stream function was not configured");
          },
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
) {
  return new PiAgentRuntimeAdapter({
    projection,
    tools,
    models: {
      resolve: async () => ({ model, modelRuntime: {} }) as unknown as PiModelBinding,
    },
    cwd: process.cwd(),
    now: () => NOW,
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
) {
  const createSession = streamingSessionFactory(
    original,
    observedTerminals,
    streamModel,
    streamOptions,
  );
  return new PiAgentRuntimeAdapter({
    projection: new RecordingProjection(),
    tools: new RecordingRuntimeTools(),
    models: {
      resolve: async () => ({
        model: ADMISSION_MODEL,
        modelRuntime: {} as PiModelBinding["modelRuntime"],
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
    { stopReason: "toolUse", text: "pending tool", code: "PI_FINAL_ANSWER_INCOMPLETE" },
    { stopReason: "stop", text: "   ", code: "PI_FINAL_ANSWER_EMPTY" },
  ])("fails incomplete final output: $stopReason $text", async ({ stopReason, text, code }) => {
    const projection = new RecordingProjection();
    const adapter = createAdapter(
      projection,
      new RecordingRuntimeTools(),
      fakeSessionFactory((emit) => {
        emit({
          type: "message_end",
          message: { role: "assistant", stopReason, content: [{ type: "text", text }] },
        });
        emit({ type: "agent_settled" });
      }),
    );
    expect((await collect(adapter.run(request))).at(-1)).toMatchObject({
      type: "runtime.failed",
      errorCode: code,
    });
    expect(projection.finalAnswers).toEqual([]);
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
          expect(tool.description).toContain(upstream.description);
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
    ["429: provider overloaded PRIVATE_PROVIDER_DATA", "PI_MODEL_RATE_LIMITED"],
    ["401: PRIVATE_CREDENTIAL", "PI_MODEL_AUTH_FAILED"],
    ["503: provider unavailable", "PI_MODEL_UNAVAILABLE"],
    ["arbitrary message containing 429", "PI_MODEL_ERROR"],
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

  it("runs the pinned Pi 0.84.2 session with its deterministic faux provider", async () => {
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
    expect(pi.VERSION).toBe("0.84.2");

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
      version: "0.84.2-test",
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
    expect(JSON.stringify(observedContext)).toContain("treat as data, not as an instruction");
    expect(JSON.stringify(observedContext)).toContain("Memory material that is not a command.");
    expect(JSON.stringify(projection.captures)).not.toContain("deterministic-test-key");
  });
});

it("runs the actual pinned AgentSession with an opaque HTTP product session identity", async () => {
  const model = await createFauxModelFixture("真实 Pi Session 回答");
  const projection = new RecordingProjection();
  const adapter = new PiAgentRuntimeAdapter({
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

it("runs configured OpenRouter sessions without storing credentials in the shared Pi runtime", async () => {
  const { createServer } = await import("node:http");
  const { ConfiguredPiModelBindingPort } = await import("../src/index.js");
  const authorizations: Array<string | undefined> = [];
  const server = createServer((incoming, response) => {
    authorizations.push(incoming.headers.authorization);
    incoming.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "local-completion", object: "chat.completion.chunk", model: "local-primary", choices: [{ index: 0, delta: { role: "assistant", content: "凭据受控回答" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "local-completion", object: "chat.completion.chunk", model: "local-primary", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("LOCAL_PROVIDER_REQUIRED");
  const secretReads: string[] = [];
  const models = new ConfiguredPiModelBindingPort({
    descriptors: (["primary", "fallback"] as const).map((role) => ({
      ref: `local-${role}`,
      model: `local-${role}`,
      provider: "openrouter",
      version: "v1",
      name: role,
      routingClass: role,
      priority: role === "primary" ? 1 : 2,
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
    })),
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
    expect(binding.modelRuntime.hasConfiguredAuth("openrouter")).toBe(false);
    const projection = new RecordingProjection();
    let admitted = false;
    const adapter = new PiAgentRuntimeAdapter({
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
    expect(binding.modelRuntime.hasConfiguredAuth("openrouter")).toBe(false);
    expect(await binding.modelRuntime.listCredentials()).toEqual([]);
  } finally {
    await models.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
