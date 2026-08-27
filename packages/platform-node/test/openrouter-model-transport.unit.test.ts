import type {
  ClockPort,
  ModelDescriptor,
  ModelInvocationEvent,
  ModelInvocationRequest,
} from "@himawari-agent/application";
import { createRunId } from "@himawari-agent/domain";
import {
  OpenRouterModelTransport,
  type OpenRouterModelPayloadBoundary,
} from "../src/openrouter-model-transport.ts";
import { describe, expect, it } from "vitest";

const MODEL = "deepseek/deepseek-v4-flash-0731";
const NOW = "2026-08-27T16:00:00.000Z";

const descriptor: ModelDescriptor = {
  ref: "model-openrouter-primary",
  provider: "openrouter",
  model: MODEL,
  version: "2026-07-31",
  routingClass: "primary",
  priority: 1,
  disclosure: "trusted_remote",
  capabilities: ["text"],
  allowedDataClassifications: ["public", "private"],
  secretRequirement: {
    secretRef: "openrouter-api-key",
    secretVersion: "v1",
    purpose: "model-provider-auth",
  },
};

const request: ModelInvocationRequest = {
  invocationId: "invocation-openrouter-01",
  runId: createRunId("run-openrouter-01"),
  modelRef: descriptor.ref,
  inputRef: "payload-openrouter-input",
  dataClassification: "private",
  allowedDisclosureRef: "disclosure-openrouter-01",
  secretHandleRefs: ["secret-handle-openrouter-01"],
  correlationId: "correlation-openrouter-01",
};

const clock: ClockPort = { now: () => NOW };

function payloads(
  prompt: string,
  failWrites = false,
): {
  readonly boundary: OpenRouterModelPayloadBoundary;
  readonly writes: string[];
} {
  const writes: string[] = [];
  return {
    writes,
    boundary: {
      readText: async () => prompt,
      writeText: async (input) => {
        if (failWrites) throw new Error("payload write failed");
        writes.push(input.content);
        return `payload-openrouter-output-${input.sequence}`;
      },
    },
  };
}

async function collect(
  events: AsyncIterable<ModelInvocationEvent>,
): Promise<ModelInvocationEvent[]> {
  const result: ModelInvocationEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function successResponse(): Response {
  const chunks = [
    {
      id: "gen-openrouter-01",
      model: MODEL,
      choices: [{ delta: { content: "hello" } }],
      openrouter_metadata: {
        attempts: [{ provider: "OpenInference", model: MODEL, status: 200 }],
      },
    },
    {
      id: "gen-openrouter-01",
      model: MODEL,
      choices: [{ delta: { content: " world" } }],
    },
    {
      id: "gen-openrouter-01",
      model: MODEL,
      choices: [],
      usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9, cost: 0.000012 },
    },
    "[DONE]",
  ];
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function responseWithContent(content: string): Response {
  const chunks = [
    {
      id: "gen-openrouter-redaction-01",
      model: MODEL,
      choices: [{ delta: { content } }],
      openrouter_metadata: {
        attempts: [{ provider: "OpenInference", model: MODEL, status: 200 }],
      },
    },
    {
      id: "gen-openrouter-redaction-01",
      model: MODEL,
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost: 0.000001 },
    },
    "[DONE]",
  ];
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function responseWithChunks(chunks: readonly unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("OpenRouterModelTransport", () => {
  it("streams protected output refs and records provider/usage metadata", async () => {
    const input = payloads("Say hello");
    const calls: { readonly url: string; readonly init: RequestInit }[] = [];
    const transport = new OpenRouterModelTransport({
      payloads: input.boundary,
      clock,
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return successResponse();
      },
      baseUrl: "http://127.0.0.1:8787/api/v1",
      maxOutputTokens: 32,
      temperature: 0,
      siteUrl: "https://agent.example.test",
      appName: "Himawari",
    });

    const events = await collect(transport.invoke({ descriptor, request, secretValues: ["k"] }));

    expect(events.map(({ type }) => type)).toEqual([
      "model.started",
      "model.output",
      "model.output",
      "model.completed",
    ]);
    expect(input.writes).toEqual(["hello", " world"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8787/api/v1/chat/completions");
    expect(calls[0]?.init.headers).toMatchObject({
      Authorization: "Bearer k",
      "Content-Type": "application/json",
      "X-OpenRouter-Metadata": "enabled",
      "HTTP-Referer": "https://agent.example.test",
      "X-OpenRouter-Title": "Himawari",
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      model: MODEL,
      stream: true,
      max_tokens: 32,
      temperature: 0,
      messages: [{ role: "user", content: "Say hello" }],
    });
    expect(events.at(-1)).toMatchObject({
      type: "model.completed",
      inputTokens: 7,
      outputTokens: 2,
      costMicros: 12,
      providerObservation: {
        provider: "OpenInference",
        model: MODEL,
        generationId: "gen-openrouter-01",
      },
    });
    expect(transport.observations()).toEqual([
      {
        invocationId: request.invocationId,
        requestedModel: MODEL,
        generationId: "gen-openrouter-01",
        provider: "OpenInference",
        responseModel: MODEL,
        promptTokens: 7,
        completionTokens: 2,
        costMicros: 12,
      },
    ]);
  });

  it("maps retryable HTTP failures without exposing response content", async () => {
    const input = payloads("Say hello");
    const transport = new OpenRouterModelTransport({
      payloads: input.boundary,
      clock,
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "private" } }), { status: 429 }),
      baseUrl: "http://127.0.0.1:8787/api/v1",
    });

    await expect(
      collect(transport.invoke({ descriptor, request, secretValues: ["k"] })),
    ).resolves.toMatchObject([
      { type: "model.started" },
      { type: "model.failed", errorCode: "OPENROUTER_RATE_LIMITED", retryable: true },
    ]);
    expect(input.writes).toEqual([]);
  });

  it("rejects machine-secret input before making a provider request", async () => {
    const input = payloads(`password=${"x".repeat(12)}`);
    let called = false;
    const transport = new OpenRouterModelTransport({
      payloads: input.boundary,
      clock,
      fetch: async () => {
        called = true;
        return successResponse();
      },
      baseUrl: "http://127.0.0.1:8787/api/v1",
    });

    await expect(
      collect(transport.invoke({ descriptor, request, secretValues: ["k"] })),
    ).resolves.toMatchObject([
      { type: "model.started" },
      { type: "model.failed", errorCode: "OPENROUTER_INPUT_REJECTED", retryable: false },
    ]);
    expect(called).toBe(false);
  });

  it("redacts machine-secret-shaped provider output before protected persistence", async () => {
    const input = payloads("Say hello");
    const transport = new OpenRouterModelTransport({
      payloads: input.boundary,
      clock,
      fetch: async () => responseWithContent(`password=${"x".repeat(12)}`),
      baseUrl: "http://127.0.0.1:8787/api/v1",
    });

    await expect(
      collect(transport.invoke({ descriptor, request, secretValues: ["k"] })),
    ).resolves.toMatchObject([
      { type: "model.started" },
      { type: "model.output" },
      { type: "model.completed" },
    ]);
    expect(input.writes).toEqual(["[MACHINE_SECRET_REDACTED]"]);
  });

  it("redacts a machine secret split across provider deltas", async () => {
    const input = payloads("Say hello");
    const transport = new OpenRouterModelTransport({
      payloads: input.boundary,
      clock,
      fetch: async () =>
        responseWithChunks([
          {
            id: "gen-openrouter-split-secret-01",
            model: MODEL,
            choices: [{ delta: { content: "pass" } }],
          },
          {
            id: "gen-openrouter-split-secret-01",
            model: MODEL,
            choices: [{ delta: { content: `word=${"x".repeat(12)}` } }],
          },
          {
            id: "gen-openrouter-split-secret-01",
            model: MODEL,
            choices: [],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5, cost: 0.000001 },
            openrouter_metadata: {
              attempts: [{ provider: "OpenInference", model: MODEL, status: 200 }],
            },
          },
          "[DONE]",
        ]),
      baseUrl: "http://127.0.0.1:8787/api/v1",
    });

    await expect(
      collect(transport.invoke({ descriptor, request, secretValues: ["k"] })),
    ).resolves.toMatchObject([
      { type: "model.started" },
      { type: "model.output" },
      { type: "model.completed" },
    ]);
    expect(input.writes).toEqual(["[MACHINE_SECRET_REDACTED]"]);
  });

  it("fails closed when OpenRouter does not disclose the actual provider identity", async () => {
    const input = payloads("Say hello");
    const transport = new OpenRouterModelTransport({
      payloads: input.boundary,
      clock,
      fetch: async () =>
        responseWithChunks([
          {
            id: "gen-openrouter-no-provider-01",
            model: MODEL,
            choices: [{ delta: { content: "hello" } }],
          },
          {
            id: "gen-openrouter-no-provider-01",
            model: MODEL,
            choices: [],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, cost: 0.000001 },
          },
          "[DONE]",
        ]),
      baseUrl: "http://127.0.0.1:8787/api/v1",
    });

    await expect(
      collect(transport.invoke({ descriptor, request, secretValues: ["k"] })),
    ).resolves.toMatchObject([
      { type: "model.started" },
      { type: "model.output" },
      {
        type: "model.failed",
        errorCode: "OPENROUTER_PROVIDER_METADATA_MISSING",
        retryable: false,
      },
    ]);
  });

  it("does not fall through after an output persistence failure", async () => {
    const input = payloads("Say hello", true);
    const transport = new OpenRouterModelTransport({
      payloads: input.boundary,
      clock,
      fetch: async () => successResponse(),
      baseUrl: "http://127.0.0.1:8787/api/v1",
    });

    await expect(
      collect(transport.invoke({ descriptor, request, secretValues: ["k"] })),
    ).resolves.toMatchObject([
      { type: "model.started" },
      { type: "model.failed", errorCode: "OPENROUTER_OUTPUT_PERSIST_FAILED", retryable: false },
    ]);
  });
});
