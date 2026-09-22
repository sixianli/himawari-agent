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

function answer(value: string, confidence = 0.95): { value: string; confidence: number } {
  return { value, confidence };
}

function jevResponse(answers: Record<string, unknown>, model = "jev-latest"): string {
  return JSON.stringify({ model, version: "jev-1.13.0", answers, usage: { input_tokens: 412 } });
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
  const seen: { url: string; body: unknown; authorization: string | null }[] = [];
  const transport = new TypeSafeJevTransport({
    secrets: { resolve: async () => "unused" },
    payloads,
    clock: { now: () => NOW },
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
      secretValues: ["typesafe-secret-value"],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(seen[0]?.authorization).toBe("Bearer typesafe-secret-value");
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
    expect(events[1]).toMatchObject({ inputTokens: 412, outputTokens: 0, cacheReadTokens: 0 });
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
    // Only an approval carries the gate-relevant confidence.
    expect(decision["confidence"]).toBeUndefined();
  });

  it("never approves when the scope answer is outside or unclear", async () => {
    for (const scope of ["outside", "unclear"]) {
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

  it("accepts a bare choice and treats it as fully confident", async () => {
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
    await collect(transport, {
      descriptor: descriptor(),
      request: request(),
      secretValues: ["key"],
    });
    expect(JSON.parse(payloads.written[0] ?? "{}")).toMatchObject({
      decision: "approve",
      confidence: 1,
    });
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
        decision: { value: "approve", confidence: 1.4 },
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
      requestTimeoutMs: 5_000,
      fetch: (async () => {
        calls += 1;
        if (calls === 1) return new Response("busy", { status: 503 });
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
      fetch: (async () => {
        calls += 1;
        controller.abort();
        return new Response("busy", { status: 503 });
      }) as unknown as typeof globalThis.fetch,
    });
    const events = await collect(transport, {
      descriptor: descriptor(),
      request: request({ signal: controller.signal }),
      secretValues: ["key"],
    });
    expect(calls).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({ type: "model.failed", errorCode: "TYPESAFE_HTTP_503" }),
    ]);
  });

  it("reserves budget on input tokens only", () => {
    expect(
      TypeSafeJevTransport.estimatedAdmissionCost({
        cost: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ).toEqual({
      pricing: { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
      estimatedCostMicros: Math.ceil(2_048 * 0.042),
    });
  });
});
