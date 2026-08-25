import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  RuntimeEvent,
  RuntimeProjectionPort,
  RuntimeRequest,
  RuntimeToolPort,
} from "@himawari-agent/application/runtime-port";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiAgentRuntimeAdapter } from "../src/index.js";

const NOW = "2026-08-25T10:00:00.000Z";
const request = {
  ownerId: "owner-task-11",
  agentId: "agent-task-11",
  runId: "run-task-11",
  sessionId: "session-task-11",
  threadId: "thread-task-11",
  modelRef: "model-faux-task-11",
  systemInstructionRef: "payload-system-task-11",
  messageRefs: ["payload-message-task-11"],
  capabilityHandleRefs: ["handle-restaurant-task-11"],
  budget: { maxTurns: 3 },
  correlationId: "correlation-task-11",
  dataClassification: "private",
} as unknown as RuntimeRequest;

class RecordingProjection implements RuntimeProjectionPort {
  readonly captures: unknown[] = [];
  readonly compactions: unknown[] = [];

  async resolveText(_runId: RuntimeRequest["runId"], payloadRef: string): Promise<string> {
    return payloadRef === request.systemInstructionRef
      ? "You are a controlled restaurant assistant."
      : "Find a beef restaurant.";
  }

  async capture(input: Parameters<RuntimeProjectionPort["capture"]>[0]): Promise<string> {
    await Promise.resolve();
    this.captures.push(input);
    return `captured-${this.captures.length}`;
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
  readonly execute = vi.fn(async () => ({
    outcome: "succeeded" as const,
    resultRef: "payload-tool-result-task-11",
    errorCode: null,
    externalActionId: null,
    modelContent: "Found one governed result.",
  }));

  async listAuthorized() {
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
  readonly customTools?: readonly {
    readonly name: string;
    execute(toolCallId: string, input: unknown): Promise<unknown>;
  }[];
  readonly noTools?: string;
  readonly tools?: readonly string[];
  readonly sessionManager?: { readonly getSessionId?: () => string };
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
) {
  return new PiAgentRuntimeAdapter({
    projection,
    tools,
    models: { resolve: async () => ({ model: {}, modelRuntime: {} }) },
    cwd: process.cwd(),
    now: () => NOW,
    turnId: (_request, turnIndex) => `turn-task-11-${turnIndex}` as never,
    createSession,
  });
}

describe("Pi Agent Runtime adapter compatibility", () => {
  afterEach(() => vi.restoreAllMocks());

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
          message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
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

    const events = await collect(adapter.run(request));

    expect(observedOptions[0]).toMatchObject({
      noTools: "all",
      tools: ["restaurant_search"],
    });
    expect(tools.preflight).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: request.runId,
        toolCallId: "tool-call-task-11",
        capabilityHandleRef: "handle-restaurant-task-11",
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

  it("runs the pinned Pi 0.84.2 session with its deterministic faux provider", async () => {
    const piSpecifier: string = "@earendil-works/pi-coding-agent";
    const piEntry = fileURLToPath(import.meta.resolve(piSpecifier));
    const aiSpecifier = pathToFileURL(resolvePiAiEntry(piEntry)).href;
    const pi = (await import(piSpecifier)) as {
      readonly VERSION: string;
      readonly ModelRuntime: {
        create(options: unknown): Promise<{
          registerNativeProvider(provider: unknown): void;
          setRuntimeApiKey(provider: string, value: string): Promise<void>;
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
    faux.setResponses([
      ai.fauxAssistantMessage(
        ai.fauxToolCall("restaurant_search", { query: "beef" }, { id: "stable-tool-call" }),
        { stopReason: "toolUse" },
      ),
      ai.fauxAssistantMessage("Finished with the governed result."),
    ]);
    const runtime = await pi.ModelRuntime.create({
      credentials: new ai.InMemoryCredentialStore(),
      refreshOnCreate: false,
      modelsPath: null,
    });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey("faux", "deterministic-test-key");
    const projection = new RecordingProjection();
    const tools = new RecordingRuntimeTools();
    const adapter = new PiAgentRuntimeAdapter({
      projection,
      tools,
      models: { resolve: async () => ({ model: faux.getModel(), modelRuntime: runtime }) },
      cwd: process.cwd(),
      now: () => NOW,
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
    expect(JSON.stringify(projection.captures)).not.toContain("deterministic-test-key");
  });
});
