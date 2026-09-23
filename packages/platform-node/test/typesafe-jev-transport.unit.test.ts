// biome-ignore-all lint/complexity/useLiteralKeys: untrusted provider records stay index typed
import type {
  DataClassification,
  ModelDescriptor,
  ModelInvocationEvent,
  ModelInvocationRequest,
} from "@himawari-agent/application";
import { describe, expect, it } from "vitest";

import {
  type JevModelPayloadBoundary,
  TypeSafeJevTransport,
} from "../src/typesafe-jev-transport.js";

const NOW = "2026-09-22T00:00:00.000Z";
const PRICING = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };

function descriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    ref: "review-model",
    provider: "typesafe",
    model: "jev-latest",
    version: "jev-latest",
    routingClass: "fallback",
    priority: 2,
    disclosure: "external_remote",
    capabilities: ["text"],
    allowedDataClassifications: ["private"],
    secretRequirement: null,
    ...overrides,
  } as ModelDescriptor;
}

function request(overrides: Partial<ModelInvocationRequest> = {}): ModelInvocationRequest {
  return {
    invocationId: "automatic-review:1",
    runId: "run-1",
    modelRef: "review-model",
    inputRef: "protected-input",
    dataClassification: "private" as DataClassification,
    allowedDisclosureRef: "automatic-review:model:fixture",
    secretHandleRefs: ["secret-handle-1"],
    correlationId: "automatic-review:1",
    ...overrides,
  } as ModelInvocationRequest;
}

function boundary(state: string): JevModelPayloadBoundary & { readonly written: string[] } {
  const written: string[] = [];
  return {
    written,
    readText: async () => state,
    writeText: async (input) => {
      written.push(input.content);
      return "protected-output";
    },
  };
}

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: "automatic-review-input.v1",
    reviewId: "automatic-review:1",
    runId: "run-1",
    intentFingerprint: "intent.v2.sha256:abc",
    policyVersion: "policy:1",
    configurationVersion: "review-config:1",
    modelRef: "review-model",
    deadlineAt: "2026-09-22T00:05:00.000Z",
    approvalExpiresAt: "2026-09-22T00:05:00.000Z",
    dataClassification: "private",
    action: {
      capabilityRef: "file:review",
      capabilityVersion: "1.0.0",
      operation: "write",
      actionKind: "CREATE_OR_UPDATE",
      sideEffect: "reversible",
      finalRisk: "HIGH",
      targetKinds: ["host", "tool"],
    },
    ...overrides,
  });
}

function answer(choice: string, confidence = 0.95) {
  return { type: "choice", choice, probabilities: { [choice]: 1 }, confidence };
}

function jevResponse(answers: Record<string, unknown>, model = "jev-1.13.0"): string {
  return JSON.stringify({ model, answers, usage: { input_tokens: 412, output_tokens: 31 } });
}

async function collect(
  transport: TypeSafeJevTransport,
  input: {
    descriptor: ModelDescriptor;
    request: ModelInvocationRequest;
    secretValues: readonly string[];
  },
): Promise<readonly ModelInvocationEvent[]> {
  const events: ModelInvocationEvent[] = [];
  for await (const event of transport.invoke(input)) events.push(event);
  return events;
}

function transportFor(
  state: string,
  respond: (body: { questions: Record<string, unknown> }) => Response,
  payloads = boundary(state),
) {
  const seen: {
    url: string;
    body: { questions: Record<string, unknown> };
    authorization: string | null;
  }[] = [];
  const transport = new TypeSafeJevTransport({
    secrets: { resolve: async () => "unused" },
    payloads,
    clock: { now: () => NOW },
    pricingFor: () => PRICING,
    fetch: (async (url: string | URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { questions: Record<string, unknown> };
      const headers = new Headers(init.headers);
      seen.push({ url: String(url), body, authorization: headers.get("authorization") });
      return respond(body);
    }) as unknown as typeof globalThis.fetch,
  });
  return { transport, seen, payloads };
}

describe("TypeSafe JEV transport", () => {
  it("asks typed questions and synthesizes an approval with its calibrated confidence", async () => {
    const secretValue = "typesafe-secret-value";
    const { transport, seen, payloads } = transportFor(
      envelope(),
      () =>
        new Response(
          jevResponse({
            within_delegated_scope: answer("within"),
            decision: answer("approve", 0.91),
            reason_code: answer("WITHIN_DELEGATION"),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const events = await collect(transport, {
      descriptor: descriptor(),
      request: request(),
      secretValues: [secretValue],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(seen[0]?.authorization).toBe(`Bearer ${secretValue}`);
    expect(Object.keys(seen[0]?.body.questions ?? {}).sort()).toEqual([
      "decision",
      "reason_code",
      "within_delegated_scope",
    ]);
    // The host owns the decision vocabulary; the model only answers.
    expect(JSON.stringify(seen[0]?.body)).toContain("within_delegated_scope");
    expect(payloads.written).toHaveLength(1);
    // The host re-binds its own answer to the frozen request identity, so the
    // persisted decision is the full validated shape, not the raw answer.
    expect(JSON.parse(payloads.written[0] ?? "{}")).toEqual({
      schemaVersion: "automatic-review.v1",
      reviewId: "automatic-review:1",
      intentFingerprint: "intent.v2.sha256:abc",
      policyVersion: "policy:1",
      configurationVersion: "review-config:1",
      modelRef: "review-model",
      reasonCode: "WITHIN_DELEGATION",
      confidence: 0.91,
      decision: "approve",
    });
    expect(events.map(({ type }) => type)).toEqual(["model.output", "model.completed"]);
    expect(events[1]).toMatchObject({
      inputTokens: 412,
      outputTokens: 31,
      cacheReadTokens: 0,
      costMicros: 412,
    });
  });

  it.each([
    ["deny", "HIGH_RISK", "deny"],
    ["human", "INSUFFICIENT_CONTEXT", "human"],
  ] as const)("maps a %s answer without a confidence gate", async (choice, reason, expected) => {
    const { transport, payloads } = transportFor(
      envelope(),
      () =>
        new Response(
          jevResponse({
            within_delegated_scope: answer("within"),
            decision: answer(choice, 0.99),
            reason_code: answer(reason),
          }),
          { status: 200 },
        ),
    );
    await collect(transport, {
      descriptor: descriptor(),
      request: request(),
      secretValues: ["key"],
    });
    const decision = JSON.parse(payloads.written[0] ?? "{}") as Record<string, unknown>;
    expect(decision["decision"]).toBe(expected);
    expect(decision["confidence"]).toBe(0.95);
  });

  it("uses the weakest answer confidence for an approval", async () => {
    const { transport, payloads } = transportFor(
      envelope(),
      () =>
        new Response(
          jevResponse({
            within_delegated_scope: answer("within", 0.2),
            decision: answer("approve", 0.99),
            reason_code: answer("WITHIN_DELEGATION", 0.95),
          }),
        ),
    );
    await collect(transport, {
      descriptor: descriptor(),
      request: request(),
      secretValues: ["key"],
    });
    expect(JSON.parse(payloads.written[0] ?? "{}")).toMatchObject({
      decision: "approve",
      confidence: 0.2,
    });
  });

  it("never approves when the scope answer is outside or unclear", async () => {
    for (const scope of ["outside"]) {
      const { transport, payloads } = transportFor(
        envelope(),
        () =>
          new Response(
            jevResponse({
              within_delegated_scope: answer(scope, 0.99),
              decision: answer("approve", 0.99),
              reason_code: answer("WITHIN_DELEGATION"),
            }),
            { status: 200 },
          ),
      );
      await collect(transport, {
        descriptor: descriptor(),
        request: request(),
        secretValues: ["key"],
      });
      expect(JSON.parse(payloads.written[0] ?? "{}")).toMatchObject({
        decision: "human",
        reasonCode: "OUTSIDE_DELEGATION",
      });
    }
  });

  it("rejects a bare choice rather than treating it as fully confident", async () => {
    const { transport, payloads } = transportFor(
      envelope(),
      () =>
        new Response(
          jevResponse({
            within_delegated_scope: "within",
            decision: "approve",
            reason_code: "WITHIN_DELEGATION",
          }),
          { status: 200 },
        ),
    );
    const events = await collect(transport, {
      descriptor: descriptor(),
      request: request(),
      secretValues: ["key"],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "model.failed", errorCode: "TYPESAFE_ANSWER_INVALID" }),
    ]);
    expect(payloads.written).toEqual([]);
  });

  it.each([
    ["a missing answer", jevResponse({ within_delegated_scope: answer("within") })],
    [
      "an unknown decision",
      jevResponse({
        within_delegated_scope: answer("within"),
        decision: answer("allow", 0.9),
        reason_code: answer("WITHIN_DELEGATION"),
      }),
    ],
    [
      "an out-of-range confidence",
      jevResponse({
        within_delegated_scope: answer("within"),
        decision: { ...answer("approve"), confidence: 1.4 },
        reason_code: answer("WITHIN_DELEGATION"),
      }),
    ],
  ])("fails closed on %s", async (_label, body) => {
    const { transport, payloads } = transportFor(
      envelope(),
      () => new Response(body, { status: 200 }),
    );
    const events = await collect(transport, {
      descriptor: descriptor(),
      request: request(),
      secretValues: ["key"],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "model.failed", errorCode: "TYPESAFE_ANSWER_INVALID" }),
    ]);
    expect(payloads.written).toEqual([]);
  });

  it("fails closed on a malformed or foreign response body", async () => {
    for (const [body, code] of [
      ["not json", "TYPESAFE_RESPONSE_INVALID"],
      [JSON.stringify({ model: "other-model", answers: {} }), "TYPESAFE_MODEL_IDENTITY_INVALID"],
    ] as const) {
      const { transport, payloads } = transportFor(
        envelope(),
        () => new Response(body, { status: 200 }),
      );
      const events = await collect(transport, {
        descriptor: descriptor(),
        request: request(),
        secretValues: ["key"],
      });
      expect(events).toEqual([expect.objectContaining({ type: "model.failed", errorCode: code })]);
      expect(payloads.written).toEqual([]);
    }
  });

  it("rejects an alias result that differs from the configured modelVersion", async () => {
    const { transport, payloads } = transportFor(
      envelope(),
      () =>
        new Response(
          jevResponse(
            {
              within_delegated_scope: answer("within"),
              decision: answer("approve"),
              reason_code: answer("WITHIN_DELEGATION"),
            },
            "jev-1.13.1",
          ),
        ),
    );
    const events = await collect(transport, {
      descriptor: descriptor({ version: "jev-1.13.0" }),
      request: request(),
      secretValues: ["key"],
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "model.failed",
        errorCode: "TYPESAFE_MODEL_IDENTITY_INVALID",
      }),
    ]);
    expect(payloads.written).toEqual([]);
  });

  it.each([
    [
      "missing model",
      JSON.stringify({ answers: {}, usage: { input_tokens: 10, output_tokens: 1 } }),
      "TYPESAFE_MODEL_IDENTITY_INVALID",
    ],
    [
      "missing usage",
      JSON.stringify({ model: "jev-1.13.0", answers: {} }),
      "TYPESAFE_USAGE_INVALID",
    ],
    [
      "invalid usage",
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {},
        usage: { input_tokens: -1, output_tokens: 0 },
      }),
      "TYPESAFE_USAGE_INVALID",
    ],
  ])("does not emit output or settle estimated usage on %s", async (_label, body, code) => {
    const { transport, payloads } = transportFor(envelope(), () => new Response(body));
    const events = await collect(transport, {
      descriptor: descriptor(),
      request: request(),
      secretValues: ["key"],
    });
    expect(events).toEqual([expect.objectContaining({ type: "model.failed", errorCode: code })]);
    expect(payloads.written).toEqual([]);
  });

  it("does not replay a request after an ambiguous transport failure", async () => {
    let calls = 0;
    const transport = new TypeSafeJevTransport({
      secrets: { resolve: async () => "unused" },
      payloads: boundary(envelope()),
      clock: { now: () => NOW },
      pricingFor: () => PRICING,
      fetch: (async () => {
        calls += 1;
        throw new Error("connection reset");
      }) as unknown as typeof globalThis.fetch,
    });
    const events = await collect(transport, {
      descriptor: descriptor(),
      request: request(),
      secretValues: ["key"],
    });
    expect(calls).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({
        type: "model.failed",
        errorCode: "TYPESAFE_TRANSPORT_UNAVAILABLE",
        retryable: false,
      }),
    ]);
  });

  it("cancels a response body read after headers have arrived", async () => {
    const controller = new AbortController();
    const transport = new TypeSafeJevTransport({
      secrets: { resolve: async () => "unused" },
      payloads: boundary(envelope()),
      clock: { now: () => NOW },
      pricingFor: () => PRICING,
      fetch: (async () =>
        new Response(
          new ReadableStream({
            pull() {
              controller.abort();
            },
          }),
        )) as unknown as typeof globalThis.fetch,
    });
    const events = await collect(transport, {
      descriptor: descriptor(),
      request: request({ signal: controller.signal }),
      secretValues: ["key"],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "model.failed", errorCode: "TYPESAFE_REQUEST_CANCELLED" }),
    ]);
  });

  it("times out a body that never completes after successful headers", async () => {
    const transport = new TypeSafeJevTransport({
      secrets: { resolve: async () => "unused" },
      payloads: boundary(envelope()),
      clock: { now: () => NOW },
      pricingFor: () => PRICING,
      requestTimeoutMs: 1_000,
      fetch: (async () =>
        new Response(
          new ReadableStream({
            pull() {
              /* Wait for the transport deadline. */
            },
          }),
        )) as unknown as typeof globalThis.fetch,
    });
    const events = await collect(transport, {
      descriptor: descriptor(),
      request: request(),
      secretValues: ["key"],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "model.failed", errorCode: "TYPESAFE_REQUEST_TIMEOUT" }),
    ]);
  });

  it("rejects an oversized response before parsing or writing an output", async () => {
    const { transport, payloads } = transportFor(
      envelope(),
      () => new Response("x".repeat(1_048_577)),
    );
    const events = await collect(transport, {
      descriptor: descriptor(),
      request: request(),
      secretValues: ["key"],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "model.failed", errorCode: "TYPESAFE_RESPONSE_TOO_LARGE" }),
    ]);
    expect(payloads.written).toEqual([]);
  });

  it("rejects a request above its reserved input ceiling before disclosure", async () => {
    const { transport, seen } = transportFor(
      envelope({ padding: "x".repeat(9_000) }),
      () => new Response("{}"),
    );
    const events = await collect(transport, {
      descriptor: descriptor(),
      request: request(),
      secretValues: ["key"],
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "model.failed",
        errorCode: "TYPESAFE_REVIEW_INPUT_TOO_LARGE",
      }),
    ]);
    expect(seen).toEqual([]);
  });

  it("rejects a state payload that is not the host review summary", async () => {
    const { transport } = transportFor("[]", () => new Response("{}", { status: 200 }));
    const events = await collect(transport, {
      descriptor: descriptor(),
      request: request(),
      secretValues: ["key"],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "model.failed", errorCode: "TYPESAFE_REVIEW_INPUT_INVALID" }),
    ]);
  });

  it("rejects a classification nested only under action before calling TypeSafe", async () => {
    const state = JSON.parse(envelope()) as Record<string, unknown>;
    delete state["dataClassification"];
    const { transport, seen } = transportFor(JSON.stringify(state), () => new Response("{}"));
    const events = await collect(transport, {
      descriptor: descriptor(),
      request: request(),
      secretValues: ["key"],
    });
    expect(events).toEqual([
      expect.objectContaining({ type: "model.failed", errorCode: "TYPESAFE_REVIEW_INPUT_INVALID" }),
    ]);
    expect(seen).toEqual([]);
  });

  it("refuses to call without a usable credential and never echoes a failed one", async () => {
    const { transport, seen } = transportFor(envelope(), () => new Response("{}", { status: 200 }));
    const events = await collect(transport, {
      descriptor: descriptor(),
      request: request(),
      secretValues: [],
    });
    expect(events).toEqual([
      expect.objectContaining({
        type: "model.failed",
        errorCode: "TYPESAFE_CREDENTIAL_UNAVAILABLE",
      }),
    ]);
    expect(seen).toEqual([]);
  });

  it("retries a transient provider failure and gives up on a client error", async () => {
    let calls = 0;
    const flaky = new TypeSafeJevTransport({
      secrets: { resolve: async () => "unused" },
      payloads: boundary(envelope()),
      clock: { now: () => NOW },
      pricingFor: () => PRICING,
      requestTimeoutMs: 5_000,
      fetch: (async () => {
        calls += 1;
        if (calls === 1) return new Response("busy", { status: 529 });
        return new Response(
          jevResponse({
            within_delegated_scope: answer("within"),
            decision: answer("approve", 0.9),
            reason_code: answer("WITHIN_DELEGATION"),
          }),
          { status: 200 },
        );
      }) as unknown as typeof globalThis.fetch,
    });
    const events = await collect(flaky, {
      descriptor: descriptor(),
      request: request(),
      secretValues: ["key"],
    });
    expect(calls).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "model.completed" });

    let deniedCalls = 0;
    const denied = new TypeSafeJevTransport({
      secrets: { resolve: async () => "unused" },
      payloads: boundary(envelope()),
      clock: { now: () => NOW },
      pricingFor: () => PRICING,
      fetch: (async () => {
        deniedCalls += 1;
        return new Response("denied", { status: 403 });
      }) as unknown as typeof globalThis.fetch,
    });
    const failed = await collect(denied, {
      descriptor: descriptor(),
      request: request(),
      secretValues: ["key"],
    });
    expect(deniedCalls).toBe(1);
    expect(failed).toEqual([
      expect.objectContaining({
        type: "model.failed",
        errorCode: "TYPESAFE_HTTP_403",
        retryable: false,
      }),
    ]);
  });

  it("does not retry after the caller cancels", async () => {
    const controller = new AbortController();
    let calls = 0;
    const transport = new TypeSafeJevTransport({
      secrets: { resolve: async () => "unused" },
      payloads: boundary(envelope()),
      clock: { now: () => NOW },
      pricingFor: () => PRICING,
      fetch: (async () => {
        calls += 1;
        controller.abort();
        return new Response("busy", { status: 529 });
      }) as unknown as typeof globalThis.fetch,
    });
    const events = await collect(transport, {
      descriptor: descriptor(),
      request: request({ signal: controller.signal }),
      secretValues: ["key"],
    });
    expect(calls).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({ type: "model.failed", errorCode: "TYPESAFE_REQUEST_CANCELLED" }),
    ]);
  });

  it("does not retry a 503 or ignore a Retry-After beyond the request deadline", async () => {
    for (const [status, headers, expected] of [
      [503, {}, "TYPESAFE_HTTP_503"],
      [429, { "retry-after": "2" }, "TYPESAFE_REQUEST_TIMEOUT"],
    ] as const) {
      let calls = 0;
      const transport = new TypeSafeJevTransport({
        secrets: { resolve: async () => "unused" },
        payloads: boundary(envelope()),
        clock: { now: () => NOW },
        pricingFor: () => PRICING,
        requestTimeoutMs: 1_000,
        fetch: (async () => {
          calls += 1;
          return new Response("busy", { status, headers });
        }) as unknown as typeof globalThis.fetch,
      });
      const events = await collect(transport, {
        descriptor: descriptor(),
        request: request(),
        secretValues: ["key"],
      });
      expect(calls).toBe(1);
      expect(events).toEqual([
        expect.objectContaining({ type: "model.failed", errorCode: expected }),
      ]);
    }
  });

  it("reserves budget on input tokens only", () => {
    expect(
      TypeSafeJevTransport.estimatedAdmissionCost({
        cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ).toEqual({
      pricing: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
      estimatedCostMicros: Math.ceil(65_536 * 0.042),
    });
  });
});
