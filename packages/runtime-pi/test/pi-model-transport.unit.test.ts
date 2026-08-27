// biome-ignore-all lint/complexity/useLiteralKeys: fake Pi options are intentionally inspected as a record
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import type {
  ClockPort,
  ModelDescriptor,
  ModelInvocationEvent,
  ModelInvocationRequest,
} from "@himawari-agent/application/runtime-port";
import { describe, expect, it, vi } from "vitest";
import {
  type PiModelBinding,
  type PiModelPayloadBoundary,
  PiModelTransport,
} from "../src/index.js";

const NOW = "2026-08-27T16:00:00.000Z";
const MODEL_ID = "deepseek/deepseek-v4-flash-0731";
const PROVIDER_SECRET = ["provider", "secret"].join("-");
const model = {
  id: MODEL_ID,
  name: "DeepSeek V4 Flash 0731",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.03, output: 0.1, cacheRead: 0.007, cacheWrite: 0 },
  contextWindow: 1_310_720,
  maxTokens: 131_072,
} satisfies Model<"openai-completions">;

const descriptor: ModelDescriptor = {
  ref: "model-openrouter-primary",
  provider: "openrouter",
  model: MODEL_ID,
  version: "catalog-2026-08-28",
  routingClass: "primary",
  priority: 1,
  disclosure: "external_remote",
  capabilities: ["text"],
  allowedDataClassifications: ["private"],
  secretRequirement: {
    secretRef: "openrouter-api-key",
    secretVersion: "v1",
    purpose: "model-provider-auth",
  },
};

const request: ModelInvocationRequest = {
  invocationId: "invocation-pi-transport-01",
  runId: "run-pi-transport-01" as never,
  modelRef: descriptor.ref,
  inputRef: "payload-pi-input-01",
  dataClassification: "private",
  allowedDisclosureRef: "disclosure-pi-transport-01",
  secretHandleRefs: ["handle-pi-transport-01"],
  correlationId: "correlation-pi-transport-01",
};

function assistant(content: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    responseId: "pi-response-01",
    usage: {
      input: 7,
      output: 2,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 10,
      cost: { input: 0.000001, output: 0.000002, cacheRead: 0, cacheWrite: 0, total: 0.000003 },
    },
    stopReason: "stop",
    timestamp: Date.parse(NOW),
  };
}

function payloadBoundary(prompt = "Say hello"): {
  readonly boundary: PiModelPayloadBoundary;
  readonly writes: string[];
} {
  const writes: string[] = [];
  return {
    writes,
    boundary: {
      readText: async () => prompt,
      writeText: async (input) => {
        writes.push(input.content);
        return `payload-pi-output-${input.sequence}`;
      },
    },
  };
}

function observationResponse(): Response {
  const body = [
    {
      id: "openrouter-generation-01",
      model: MODEL_ID,
      choices: [],
      usage: { cost: 0.000012 },
      openrouter_metadata: {
        attempts: [{ provider: "OpenInference", model: MODEL_ID, status: 200 }],
      },
    },
    "[DONE]",
  ]
    .map((entry) => `data: ${JSON.stringify(entry)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function errorMessage(message: string): AssistantMessage {
  return { ...assistant(""), stopReason: "error", errorMessage: message };
}

function runtimeWithTerminal(
  terminal: AssistantMessage,
  options: {
    readonly fetchProvider?: boolean;
    readonly deltas?: readonly string[];
  } = {},
) {
  return {
    stream(_model: Model<Api>, _context: Context, streamOptions?: Record<string, unknown>) {
      const events = async function* (): AsyncIterable<AssistantMessageEvent> {
        if (options.fetchProvider !== false) {
          const piFetch = streamOptions?.["fetch"] as typeof globalThis.fetch;
          await piFetch("https://openrouter.ai/api/v1/chat/completions");
        }
        const partial = assistant("");
        for (const delta of options.deltas ?? []) {
          yield { type: "text_delta", contentIndex: 0, delta, partial };
        }
        if (terminal.stopReason === "pending") throw new Error("terminal message is pending");
        if (terminal.stopReason === "error" || terminal.stopReason === "aborted") {
          yield { type: "error", reason: terminal.stopReason, error: terminal };
        } else {
          yield { type: "done", reason: terminal.stopReason, message: terminal };
        }
      };
      return events();
    },
  };
}

async function collect(
  events: AsyncIterable<ModelInvocationEvent>,
): Promise<ModelInvocationEvent[]> {
  const collected: ModelInvocationEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("PiModelTransport", () => {
  it("delegates streaming to Pi and only observes OpenRouter metadata", async () => {
    const payloads = payloadBoundary();
    const fetch = vi.fn(async () => observationResponse());
    let observedContext: Context | undefined;
    let observedOptions: Record<string, unknown> | undefined;
    const runtime = {
      stream(_model: Model<Api>, context: Context, options?: Record<string, unknown>) {
        observedContext = context;
        observedOptions = options;
        const events = async function* (): AsyncIterable<AssistantMessageEvent> {
          const piFetch = options?.["fetch"] as typeof globalThis.fetch;
          await piFetch("https://openrouter.ai/api/v1/chat/completions");
          const partial = assistant("");
          yield { type: "start", partial };
          yield { type: "text_delta", contentIndex: 0, delta: "hello", partial };
          yield { type: "text_delta", contentIndex: 0, delta: " world", partial };
          yield { type: "done", reason: "stop", message: assistant("hello world") };
        };
        return events();
      },
    };
    const transport = new PiModelTransport({
      models: {
        resolve: async () => ({ model, modelRuntime: runtime }) as unknown as PiModelBinding,
      },
      payloads: payloads.boundary,
      clock: { now: () => NOW } satisfies ClockPort,
      fetch,
      maxOutputTokens: 32,
      temperature: 0,
      siteUrl: "https://agent.example.test",
      appName: "Himawari",
    });

    const events = await collect(
      transport.invoke({ descriptor, request, secretValues: [PROVIDER_SECRET] }),
    );

    expect(events.map(({ type }) => type)).toEqual([
      "model.started",
      "model.output",
      "model.output",
      "model.completed",
    ]);
    expect(payloads.writes).toEqual(["hello", " world"]);
    expect(observedContext?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "Say hello" }),
    ]);
    expect(observedOptions).toMatchObject({
      ["apiKey"]: PROVIDER_SECRET,
      maxTokens: 32,
      maxRetries: 0,
      temperature: 0,
      headers: {
        "X-OpenRouter-Metadata": "enabled",
        "HTTP-Referer": "https://agent.example.test",
        "X-OpenRouter-Title": "Himawari",
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "model.completed",
      inputTokens: 8,
      outputTokens: 2,
      costMicros: 12,
      providerObservation: {
        provider: "OpenInference",
        model: MODEL_ID,
        generationId: "openrouter-generation-01",
      },
    });
    expect(transport.observations()).toEqual([
      expect.objectContaining({
        requestedModel: MODEL_ID,
        provider: "OpenInference",
        costMicros: 12,
      }),
    ]);
  });

  it("redacts a machine secret split across Pi deltas", async () => {
    const payloads = payloadBoundary();
    const terminal = assistant(`password=${"x".repeat(12)}`);
    const runtime = {
      stream() {
        const events = async function* (): AsyncIterable<AssistantMessageEvent> {
          yield { type: "text_delta", contentIndex: 0, delta: "pass", partial: assistant("") };
          yield {
            type: "text_delta",
            contentIndex: 0,
            delta: `word=${"x".repeat(12)}`,
            partial: terminal,
          };
          yield { type: "done", reason: "stop", message: terminal };
        };
        return events();
      },
    };
    const transport = new PiModelTransport({
      models: {
        resolve: async () => ({ model, modelRuntime: runtime }) as unknown as PiModelBinding,
      },
      payloads: payloads.boundary,
      clock: { now: () => NOW },
      fetch: async () => observationResponse(),
    });

    await collect(transport.invoke({ descriptor, request, secretValues: [PROVIDER_SECRET] }));

    expect(payloads.writes).toEqual(["[MACHINE_SECRET_REDACTED]"]);
  });

  it("maps retryable provider failures without exposing the provider response", async () => {
    const payloads = payloadBoundary();
    const fetch = vi.fn(async () => new Response("unsafe response", { status: 429 }));
    const transport = new PiModelTransport({
      models: {
        resolve: async () =>
          ({
            model,
            modelRuntime: runtimeWithTerminal(errorMessage("unsafe provider response")),
          }) as unknown as PiModelBinding,
      },
      payloads: payloads.boundary,
      clock: { now: () => NOW },
      fetch,
    });

    const events = await collect(
      transport.invoke({ descriptor, request, secretValues: [PROVIDER_SECRET] }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "model.failed",
      errorCode: "OPENROUTER_RATE_LIMITED",
      retryable: true,
    });
    expect(JSON.stringify(events)).not.toContain("unsafe");
  });

  it("maps a provider stream error returned with HTTP 200 as a response failure", async () => {
    const payloads = payloadBoundary();
    const transport = new PiModelTransport({
      models: {
        resolve: async () =>
          ({
            model,
            modelRuntime: runtimeWithTerminal(errorMessage("provider stream error")),
          }) as unknown as PiModelBinding,
      },
      payloads: payloads.boundary,
      clock: { now: () => NOW },
      fetch: async () => observationResponse(),
    });

    const events = await collect(
      transport.invoke({ descriptor, request, secretValues: [PROVIDER_SECRET] }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "model.failed",
      errorCode: "OPENROUTER_RESPONSE_ERROR",
      retryable: false,
    });
  });

  it("rejects machine-secret input before resolving a Pi model", async () => {
    const payloads = payloadBoundary(["password", "x".repeat(12)].join("="));
    const resolve = vi.fn();
    const transport = new PiModelTransport({
      models: { resolve },
      payloads: payloads.boundary,
      clock: { now: () => NOW },
      fetch: async () => observationResponse(),
    });

    const events = await collect(
      transport.invoke({ descriptor, request, secretValues: [PROVIDER_SECRET] }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "model.failed",
      errorCode: "OPENROUTER_INPUT_REJECTED",
      retryable: false,
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("fails closed when the bound Pi model drifts from the canonical descriptor", async () => {
    const payloads = payloadBoundary();
    const stream = vi.fn();
    const transport = new PiModelTransport({
      models: {
        resolve: async () =>
          ({
            model: { ...model, id: "drifted/model" },
            modelRuntime: { stream },
          }) as unknown as PiModelBinding,
      },
      payloads: payloads.boundary,
      clock: { now: () => NOW },
      fetch: async () => observationResponse(),
    });

    const events = await collect(
      transport.invoke({ descriptor, request, secretValues: [PROVIDER_SECRET] }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "model.failed",
      errorCode: "PI_MODEL_BINDING_MISMATCH",
      retryable: false,
    });
    expect(stream).not.toHaveBeenCalled();
  });

  it("fails closed when OpenRouter omits actual provider or cost metadata", async () => {
    const payloads = payloadBoundary();
    const response = new Response(
      `data: ${JSON.stringify({ id: "generation-without-provider", model: MODEL_ID, choices: [] })}`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const transport = new PiModelTransport({
      models: {
        resolve: async () =>
          ({
            model,
            modelRuntime: runtimeWithTerminal(assistant("answer")),
          }) as unknown as PiModelBinding,
      },
      payloads: payloads.boundary,
      clock: { now: () => NOW },
      fetch: async () => response,
    });

    const events = await collect(
      transport.invoke({ descriptor, request, secretValues: [PROVIDER_SECRET] }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "model.failed",
      errorCode: "OPENROUTER_PROVIDER_METADATA_MISSING",
      retryable: false,
    });
    expect(events.some(({ type }) => type === "model.completed")).toBe(false);
  });

  it("does not fall through after protected output persistence fails", async () => {
    const transport = new PiModelTransport({
      models: {
        resolve: async () =>
          ({
            model,
            modelRuntime: runtimeWithTerminal(assistant("answer"), { deltas: ["answer"] }),
          }) as unknown as PiModelBinding,
      },
      payloads: {
        readText: async () => "question",
        writeText: async () => {
          throw new Error("persistence unavailable");
        },
      },
      clock: { now: () => NOW },
      fetch: async () => observationResponse(),
    });

    const events = await collect(
      transport.invoke({ descriptor, request, secretValues: [PROVIDER_SECRET] }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "model.failed",
      errorCode: "OPENROUTER_OUTPUT_PERSIST_FAILED",
      retryable: false,
    });
    expect(events.some(({ type }) => type === "model.completed")).toBe(false);
  });

  it("rejects tool calls on the plain model port", async () => {
    const payloads = payloadBoundary();
    const terminal = {
      ...assistant(""),
      content: [
        {
          type: "toolCall" as const,
          id: "tool-call-unsupported",
          name: "read",
          arguments: { path: "README.md" },
        },
      ],
      stopReason: "toolUse" as const,
    } satisfies AssistantMessage;
    const transport = new PiModelTransport({
      models: {
        resolve: async () =>
          ({ model, modelRuntime: runtimeWithTerminal(terminal) }) as unknown as PiModelBinding,
      },
      payloads: payloads.boundary,
      clock: { now: () => NOW },
      fetch: async () => observationResponse(),
    });

    const events = await collect(
      transport.invoke({ descriptor, request, secretValues: [PROVIDER_SECRET] }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "model.failed",
      errorCode: "OPENROUTER_TOOL_CALL_UNSUPPORTED",
      retryable: false,
    });
    expect(payloads.writes).toEqual([]);
  });

  it("does not report a max-token truncation as a completed result", async () => {
    const payloads = payloadBoundary();
    const terminal = { ...assistant("partial"), stopReason: "length" as const };
    const transport = new PiModelTransport({
      models: {
        resolve: async () =>
          ({
            model,
            modelRuntime: runtimeWithTerminal(terminal, { deltas: ["partial"] }),
          }) as unknown as PiModelBinding,
      },
      payloads: payloads.boundary,
      clock: { now: () => NOW },
      fetch: async () => observationResponse(),
    });

    const events = await collect(
      transport.invoke({ descriptor, request, secretValues: [PROVIDER_SECRET] }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "model.failed",
      errorCode: "OPENROUTER_OUTPUT_TRUNCATED",
      retryable: false,
    });
    expect(events.some(({ type }) => type === "model.completed")).toBe(false);
  });

  it("treats a successful provider response without output as retryable", async () => {
    const payloads = payloadBoundary();
    const transport = new PiModelTransport({
      models: {
        resolve: async () =>
          ({
            model,
            modelRuntime: runtimeWithTerminal(assistant("")),
          }) as unknown as PiModelBinding,
      },
      payloads: payloads.boundary,
      clock: { now: () => NOW },
      fetch: async () => observationResponse(),
    });

    const events = await collect(
      transport.invoke({ descriptor, request, secretValues: [PROVIDER_SECRET] }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "model.failed",
      errorCode: "OPENROUTER_EMPTY_RESPONSE",
      retryable: true,
    });
    expect(payloads.writes).toEqual([]);
  });
});
