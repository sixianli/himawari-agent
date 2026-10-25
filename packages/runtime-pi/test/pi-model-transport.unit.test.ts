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
const MODEL_ID = "deepseek/deepseek-v4.1-flash";
const PROVIDER_SECRET = ["provider", "secret"].join("-");
const model = {
  id: MODEL_ID,
  name: "DeepSeek V4.1 Flash",
  api: "openai-completions",
  provider: "vercel-ai-gateway",
  baseUrl: "https://ai-gateway.vercel.sh/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0.03, output: 0.1, cacheRead: 0.007, cacheWrite: 0 },
  contextWindow: 1_310_720,
  maxTokens: 32768,
} satisfies Model<"openai-completions">;

const descriptor: ModelDescriptor = {
  ref: "model-vercel-ai-gateway-primary",
  provider: "vercel-ai-gateway",
  model: MODEL_ID,
  version: "catalog-2026-08-28",
  routingClass: "primary",
  priority: 1,
  disclosure: "external_remote",
  capabilities: ["text"],
  allowedDataClassifications: ["private"],
  providerRouting: { order: ["runware", "deepinfra", "morph"], sort: "cost" },
  secretRequirement: {
    secretRef: "vercel-ai-gateway-api-key",
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
      id: "vercel-ai-gateway-generation-01",
      model: MODEL_ID,
      choices: [
        {
          index: 0,
          delta: {
            provider_metadata: {
              gateway: {
                generationId: "vercel-ai-gateway-generation-01",
                routing: { finalProvider: "deepinfra" },
                cost: "0.000012",
              },
            },
          },
        },
      ],
      usage: { cost: "0.000012" },
    },
    "[DONE]",
  ]
    .map((entry) => `data: ${typeof entry === "string" ? entry : JSON.stringify(entry)}\n\n`)
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
          await piFetch("https://ai-gateway.vercel.sh/v1/chat/completions");
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
  it.each([
    { usageCost: "0.00000019", metadataCost: "0.00000019", expected: 1 },
    { usageCost: "0", metadataCost: "0", expected: 0 },
    { usageCost: "0.0000001", metadataCost: "0.0000002", expected: null },
    { usageCost: "not-a-fee", metadataCost: "0.00000019", expected: null },
    { usageCost: "0.00000019", metadataCost: "not-a-fee", expected: null },
    { usageCost: undefined, metadataCost: "0.00000019", expected: null },
  ])(
    "[R2-L5] validates terminal gateway fees $usageCost and $metadataCost",
    async ({ usageCost, metadataCost, expected }) => {
      const payloads = payloadBoundary();
      const body = {
        id: "chatcmpl-gateway-fee",
        model: MODEL_ID,
        usage: { cost: usageCost },
        choices: [
          {
            index: 0,
            delta: {
              provider_metadata: {
                gateway: {
                  generationId: "gen-gateway-fee",
                  routing: { finalProvider: "deepinfra" },
                  cost: metadataCost,
                },
              },
            },
          },
        ],
      };
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
        fetch: async () =>
          new Response(`data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
      });
      const events = await collect(
        transport.invoke({ descriptor, request, secretValues: [PROVIDER_SECRET] }),
      );
      if (expected === null) {
        expect(events.at(-1)).toMatchObject({
          type: "model.failed",
          errorCode: "AI_GATEWAY_PROVIDER_METADATA_MISSING",
        });
        expect(transport.observations()).toHaveLength(0);
      } else {
        expect(events.at(-1)).toMatchObject({
          type: "model.completed",
          costMicros: expected,
          providerObservation: {
            provider: "deepinfra",
            generationId: "gen-gateway-fee",
            model: MODEL_ID,
          },
        });
      }
    },
  );

  it("[R2-L5] rejects a transport output limit above 32768 before any request", () => {
    expect(
      () =>
        new PiModelTransport({
          models: {
            resolve: async () => {
              throw new Error("No binding access");
            },
          },
          payloads: payloadBoundary().boundary,
          clock: { now: () => NOW },
          maxOutputTokens: 32769,
        }),
    ).toThrow("Pi maxOutputTokens must be an integer from 1 to 32768");
  });

  it.each([32, 32768])(
    "[R2-L5] delegates streaming with limit %s while preserving the configured cap",
    async (requestedLimit) => {
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
            await piFetch("https://ai-gateway.vercel.sh/v1/chat/completions");
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
          resolve: async () =>
            ({
              model: { ...model, maxTokens: 32 },
              modelRuntime: runtime,
            }) as unknown as PiModelBinding,
        },
        payloads: payloads.boundary,
        clock: { now: () => NOW } satisfies ClockPort,
        fetch,
        maxOutputTokens: requestedLimit,
        temperature: 0,
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
      });
      const routePayload = observedOptions?.["onPayload"] as (payload: unknown) => unknown;
      expect(await routePayload({ model: MODEL_ID })).toMatchObject({
        providerOptions: { gateway: { order: ["runware", "deepinfra", "morph"], sort: "cost" } },
      });
      expect(JSON.stringify(observedOptions)).not.toContain("X-OpenRouter");
      expect(events.at(-1)).toMatchObject({
        type: "model.completed",
        inputTokens: 8,
        outputTokens: 2,
        costMicros: 12,
        providerObservation: {
          provider: "deepinfra",
          model: MODEL_ID,
          generationId: "vercel-ai-gateway-generation-01",
        },
      });
      expect(transport.observations()).toEqual([
        expect.objectContaining({
          requestedModel: MODEL_ID,
          provider: "deepinfra",
          costMicros: 12,
        }),
      ]);
    },
  );

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
      errorCode: "AI_GATEWAY_RATE_LIMITED",
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
      errorCode: "AI_GATEWAY_RESPONSE_ERROR",
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
      errorCode: "AI_GATEWAY_INPUT_REJECTED",
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

  it("fails closed when AI Gateway omits actual provider or cost metadata", async () => {
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
      errorCode: "AI_GATEWAY_PROVIDER_METADATA_MISSING",
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
      errorCode: "AI_GATEWAY_OUTPUT_PERSIST_FAILED",
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
      errorCode: "AI_GATEWAY_TOOL_CALL_UNSUPPORTED",
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
      errorCode: "AI_GATEWAY_OUTPUT_TRUNCATED",
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
      errorCode: "AI_GATEWAY_EMPTY_RESPONSE",
      retryable: true,
    });
    expect(payloads.writes).toEqual([]);
  });
});

it("passes cancellation to the pinned Pi provider API without adding tools", async () => {
  const controller = new AbortController();
  let received: Record<string, unknown> | undefined;
  let context: Context | undefined;
  const runtime = runtimeWithTerminal(assistant("{}"), { fetchProvider: false });
  const transport = new PiModelTransport({
    models: {
      resolve: async () =>
        ({
          model,
          modelRuntime: {
            stream: (chosen: Model<Api>, input: Context, options?: Record<string, unknown>) => {
              received = options;
              context = input;
              return runtime.stream(chosen, input, options);
            },
          },
        }) as unknown as PiModelBinding,
    },
    payloads: payloadBoundary().boundary,
    clock: { now: () => NOW },
  });
  await collect(
    transport.invoke({
      descriptor,
      request: { ...request, signal: controller.signal },
      secretValues: [PROVIDER_SECRET],
    }),
  );
  expect(received?.["signal"]).toBe(controller.signal);
  expect(context?.tools).toBeUndefined();
});

it("does not read model input or resolve a binding after request cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const readText = vi.fn(async () => "private text");
  const resolve = vi.fn(
    async () =>
      ({
        model,
        modelRuntime: runtimeWithTerminal(assistant("{}"), { fetchProvider: false }),
      }) as unknown as PiModelBinding,
  );
  const transport = new PiModelTransport({
    models: { resolve },
    payloads: { ...payloadBoundary().boundary, readText },
    clock: { now: () => NOW },
  });
  await expect(
    collect(
      transport.invoke({
        descriptor,
        request: { ...request, signal: controller.signal },
        secretValues: [PROVIDER_SECRET],
      }),
    ),
  ).rejects.toThrow();
  expect(readText).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
});

it("does not offer a retry after the caller cancels an active Pi stream", async () => {
  const controller = new AbortController();
  const transport = new PiModelTransport({
    models: {
      resolve: async () =>
        ({
          model,
          modelRuntime: {
            stream: () =>
              (async function* (): AsyncIterable<AssistantMessageEvent> {
                controller.abort();
                yield {
                  type: "error",
                  reason: "aborted",
                  error: { ...assistant(""), stopReason: "aborted" },
                };
              })(),
          },
        }) as unknown as PiModelBinding,
    },
    payloads: payloadBoundary().boundary,
    clock: { now: () => NOW },
  });
  const events = await collect(
    transport.invoke({
      descriptor,
      request: { ...request, signal: controller.signal },
      secretValues: [PROVIDER_SECRET],
    }),
  );
  expect(events.at(-1)).toMatchObject({
    type: "model.failed",
    errorCode: "MODEL_REQUEST_CANCELLED",
    retryable: false,
  });
});
