import {
  ModelRouterService,
  SessionTraceRecorder,
  type ModelDescriptor,
  type ModelInvocationEvent,
} from "@himawari-agent/application";
import {
  createAgentId,
  createOwnerId,
  createRunId,
  createSessionId,
  createThreadId,
} from "@himawari-agent/domain";
import {
  type SecretMaterialSource,
  TrustedModelProviderAdapter,
  type TrustedModelTransport,
  type TrustedModelTransportInput,
} from "@himawari-agent/platform-node";
import { ManualClock, ScriptedModelPort, createReferenceAdapterSet } from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-model-router");
const AGENT_ID = createAgentId("agent-model-router");
const SESSION_ID = createSessionId("session-model-router");
const THREAD_ID = createThreadId("thread-model-router");
const RUN_ID = createRunId("run-model-router");
const T0 = "2026-08-25T00:00:00.000Z";
const T1 = "2026-08-25T00:00:01.000Z";
const T2 = "2026-08-25T00:00:02.000Z";

function descriptor(
  ref: string,
  routingClass: ModelDescriptor["routingClass"],
  options: Partial<ModelDescriptor> = {},
): ModelDescriptor {
  return {
    ref,
    provider: "deterministic",
    model: ref,
    version: "1.0.0",
    routingClass,
    priority: 10,
    disclosure: routingClass === "local" ? "local_only" : "trusted_remote",
    capabilities: routingClass === "specialist" ? ["vision"] : ["text"],
    allowedDataClassifications: ["public", "private", "sensitive"],
    secretRequirement: null,
    ...options,
  };
}

function completed(modelRef: string): readonly ModelInvocationEvent[] {
  return [
    { type: "model.started", invocationId: `invocation-${modelRef}`, occurredAt: T0 },
    {
      type: "model.output",
      invocationId: `invocation-${modelRef}`,
      sequence: 1,
      payloadRef: `payload-output-${modelRef}`,
      occurredAt: T0,
    },
    {
      type: "model.completed",
      invocationId: `invocation-${modelRef}`,
      inputTokens: 100,
      outputTokens: 25,
      costMicros: 250,
      latencyMs: 1000,
      occurredAt: T1,
    },
  ];
}

function createRouter(
  model: ConstructorParameters<typeof ModelRouterService>[0]["model"],
  clock = new ManualClock(T0),
) {
  const adapters = createReferenceAdapterSet({ clock });
  const trace = new SessionTraceRecorder({
    trace: adapters.trace,
    payloads: adapters.payload,
    protector: adapters.payloadProtector,
    audit: adapters.audit,
    clock,
    ids: adapters.ids,
  });
  return {
    adapters,
    router: new ModelRouterService({
      model,
      secrets: adapters.secret,
      trace,
      clock,
      ids: adapters.ids,
    }),
  };
}

function routeRequest(
  taskProfile: "primary" | "specialist" | "local" = "primary",
  overrides: Partial<Parameters<ModelRouterService["route"]>[0]> = {},
) {
  return {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    threadId: THREAD_ID,
    runId: RUN_ID,
    taskProfile,
    requiredCapabilities: taskProfile === "specialist" ? ["vision"] : ["text"],
    inputRef: "payload-model-input",
    dataClassification: "private" as const,
    maxDisclosure: taskProfile === "local" ? ("local_only" as const) : ("trusted_remote" as const),
    allowedDisclosureRef: "disclosure-policy-model-router",
    forbidFallbackDisclosureExpansion: true,
    correlationId: `correlation-model-${taskProfile}`,
    causationId: `context-formed-${taskProfile}`,
    parentEventId: null,
    actorId: "model-router",
    deadlineAt: T2,
    ...overrides,
  };
}

describe("Task 10 Model Router and trusted Provider secrets", () => {
  it.each([
    { profile: "primary" as const, selected: "model-primary" },
    { profile: "specialist" as const, selected: "model-specialist" },
    { profile: "local" as const, selected: "model-local" },
  ])("selects the $profile candidate before Provider execution", async ({ profile, selected }) => {
    const descriptors = [
      descriptor("model-primary", "primary"),
      descriptor("model-specialist", "specialist"),
      descriptor("model-local", "local"),
      descriptor("model-fallback", "fallback"),
    ];
    const model = new ScriptedModelPort(descriptors, [], {
      [selected]: completed(selected),
    });
    const { adapters, router } = createRouter(model);

    await expect(router.route(routeRequest(profile))).resolves.toMatchObject({
      status: "completed",
      selectedModelRef: selected,
      attempts: 1,
      usage: { inputTokens: 100, outputTokens: 25, costMicros: 250, latencyMs: 1000 },
    });
    expect(model.observedRequests().map(({ modelRef }) => modelRef)).toEqual([selected]);
    expect((await adapters.trace.readRun(RUN_ID, 0, 10)).map(({ eventType }) => eventType)).toEqual(
      ["model.route_decided", "model.request", "model.started", "model.output", "model.completed"],
    );
  });

  it("preserves the provider observation from a trusted transport in the terminal Trace", async () => {
    const primary = descriptor("model-primary-observed", "primary");
    const model = new ScriptedModelPort([primary], [], {
      [primary.ref]: completed(primary.ref).map((event) =>
        event.type === "model.completed"
          ? {
              ...event,
              providerObservation: {
                provider: "OpenInference",
                model: "deepseek/deepseek-v4-flash-0731",
                generationId: "gen-model-router-01",
              },
            }
          : event,
      ),
    });
    const { adapters, router } = createRouter(model);

    await expect(router.route(routeRequest())).resolves.toMatchObject({ status: "completed" });
    const events = await adapters.trace.readRun(RUN_ID, 0, 20);
    const terminal = events.at(-1);
    if (!terminal?.payloadRef) throw new Error("Expected terminal model Trace payload");
    const payload = await adapters.payload.get(terminal.payloadRef);
    if (!payload) throw new Error("Expected provider observation payload");
    await expect(adapters.payloadProtector.revealForTest(payload)).resolves.toMatchObject({
      providerObservation: {
        provider: "OpenInference",
        model: "deepseek/deepseek-v4-flash-0731",
        generationId: "gen-model-router-01",
      },
    });
  });

  it("retries a compatible fallback and traces failure, retry, usage, cost, and latency", async () => {
    const primary = descriptor("model-primary", "primary");
    const fallback = descriptor("model-fallback", "fallback", { priority: 1 });
    const model = new ScriptedModelPort([primary, fallback], [], {
      [primary.ref]: [
        { type: "model.started", invocationId: "primary-call", occurredAt: T0 },
        {
          type: "model.failed",
          invocationId: "primary-call",
          errorCode: "PROVIDER_UNAVAILABLE",
          retryable: true,
          latencyMs: 400,
          occurredAt: T0,
        },
      ],
      [fallback.ref]: completed(fallback.ref),
    });
    const { adapters, router } = createRouter(model);

    await expect(router.route(routeRequest())).resolves.toMatchObject({
      status: "completed",
      selectedModelRef: fallback.ref,
      attempts: 2,
      usage: { inputTokens: 100, outputTokens: 25, costMicros: 250, latencyMs: 1000 },
    });
    expect(model.observedRequests().map(({ modelRef }) => modelRef)).toEqual([
      primary.ref,
      fallback.ref,
    ]);
    const events = await adapters.trace.readRun(RUN_ID, 0, 20);
    expect(events.map(({ eventType }) => eventType)).toEqual([
      "model.route_decided",
      "model.request",
      "model.started",
      "model.failed",
      "model.retry",
      "model.route_decided",
      "model.request",
      "model.started",
      "model.output",
      "model.completed",
    ]);
    const completedEvent = events.at(-1);
    const payload = await adapters.payload.get(completedEvent?.payloadRef ?? "missing");
    if (!payload) throw new Error("Expected completed model Trace payload");
    await expect(adapters.payloadProtector.revealForTest(payload)).resolves.toMatchObject({
      modelRef: fallback.ref,
      inputTokens: 100,
      outputTokens: 25,
      costMicros: 250,
      latencyMs: 1000,
    });
  });

  it("blocks a fallback that would expand disclosure even when the request ceiling is broader", async () => {
    const primary = descriptor("model-primary", "primary", { disclosure: "trusted_remote" });
    const fallback = descriptor("model-fallback-external", "fallback", {
      disclosure: "external_remote",
    });
    const model = new ScriptedModelPort([primary, fallback], [], {
      [primary.ref]: [
        { type: "model.started", invocationId: "primary-call", occurredAt: T0 },
        {
          type: "model.failed",
          invocationId: "primary-call",
          errorCode: "PROVIDER_UNAVAILABLE",
          retryable: true,
          latencyMs: 400,
          occurredAt: T0,
        },
      ],
      [fallback.ref]: completed(fallback.ref),
    });
    const { adapters, router } = createRouter(model);

    await expect(
      router.route(
        routeRequest("primary", {
          maxDisclosure: "external_remote",
          forbidFallbackDisclosureExpansion: true,
        }),
      ),
    ).resolves.toMatchObject({
      status: "blocked",
      selectedModelRef: primary.ref,
      attempts: 1,
      errorCode: "MODEL_FALLBACK_DISCLOSURE_BLOCKED",
    });
    expect(model.observedRequests().map(({ modelRef }) => modelRef)).toEqual([primary.ref]);
    expect((await adapters.trace.readRun(RUN_ID, 0, 20)).at(-1)?.eventType).toBe(
      "model.fallback_blocked",
    );
  });

  it("resolves raw credentials only inside the trusted Provider adapter and never traces them", async () => {
    const rawSecret = "provider-secret-material";
    const secretSource: SecretMaterialSource = {
      async resolve(secretRef, secretVersion) {
        if (secretRef !== "provider-primary" || secretVersion !== "v1") {
          throw new Error("unexpected secret reference");
        }
        return rawSecret;
      },
    };
    class DeterministicTransport implements TrustedModelTransport {
      readonly observations: { modelRef: string; credentialMatched: boolean }[] = [];

      async *invoke(input: TrustedModelTransportInput): AsyncIterable<ModelInvocationEvent> {
        this.observations.push({
          modelRef: input.descriptor.ref,
          credentialMatched: input.secretValues.length === 1 && input.secretValues[0] === rawSecret,
        });
        yield* completed(input.descriptor.ref);
      }
    }
    const clock = new ManualClock(T0);
    const adapters = createReferenceAdapterSet({ clock });
    const primary = descriptor("model-primary-secret", "primary", {
      secretRequirement: {
        secretRef: "provider-primary",
        secretVersion: "v1",
        purpose: "model-provider-auth",
      },
    });
    const transport = new DeterministicTransport();
    const provider = new TrustedModelProviderAdapter({
      descriptors: [primary],
      handles: adapters.secret,
      secretSource,
      transport,
      clock,
    });
    const trace = new SessionTraceRecorder({
      trace: adapters.trace,
      payloads: adapters.payload,
      protector: adapters.payloadProtector,
      audit: adapters.audit,
      clock,
      ids: adapters.ids,
    });
    const router = new ModelRouterService({
      model: provider,
      secrets: adapters.secret,
      trace,
      clock,
      ids: adapters.ids,
    });

    await expect(router.route(routeRequest())).resolves.toMatchObject({ status: "completed" });
    expect(transport.observations).toEqual([{ modelRef: primary.ref, credentialMatched: true }]);
    expect(provider.resolutionLog()).toMatchObject([
      {
        modelRef: primary.ref,
        secretRef: "provider-primary",
        secretVersion: "v1",
        purpose: "model-provider-auth",
      },
    ]);
    expect((await adapters.secret.inspectHandle("secret-handle-0001"))?.revokedAt).toBe(T0);

    for (const event of await adapters.trace.readRun(RUN_ID, 0, 20)) {
      if (!event.payloadRef) continue;
      const payload = await adapters.payload.get(event.payloadRef);
      if (!payload) throw new Error("Expected model Trace payload");
      expect(JSON.stringify(await adapters.payloadProtector.revealForTest(payload))).not.toContain(
        rawSecret,
      );
    }
  });

  it("deduplicates repeated streamed output sequences and terminal provider results", async () => {
    const primary = descriptor("model-duplicate", "primary");
    const model = new ScriptedModelPort([primary], [], {
      [primary.ref]: [
        { type: "model.started", invocationId: "duplicate-call", occurredAt: T0 },
        {
          type: "model.output",
          invocationId: "duplicate-call",
          sequence: 1,
          payloadRef: "payload-duplicate-first",
          occurredAt: T0,
        },
        {
          type: "model.output",
          invocationId: "duplicate-call",
          sequence: 1,
          payloadRef: "payload-duplicate-retry",
          occurredAt: T0,
        },
        {
          type: "model.completed",
          invocationId: "duplicate-call",
          inputTokens: 2,
          outputTokens: 1,
          costMicros: 3,
          latencyMs: 4,
          occurredAt: T1,
        },
        {
          type: "model.completed",
          invocationId: "duplicate-call",
          inputTokens: 2,
          outputTokens: 1,
          costMicros: 3,
          latencyMs: 4,
          occurredAt: T1,
        },
      ],
    });
    const { adapters, router } = createRouter(model);
    await expect(router.route(routeRequest())).resolves.toMatchObject({
      status: "completed",
      outputRefs: ["payload-duplicate-first"],
    });
    const events = await adapters.trace.readRun(RUN_ID, 0, 20);
    expect(events.filter(({ eventType }) => eventType === "model.output")).toHaveLength(1);
    expect(events.filter(({ eventType }) => eventType === "model.completed")).toHaveLength(1);
  });

  it("stops the trusted transport after the first terminal result", async () => {
    const clock = new ManualClock(T0);
    const adapters = createReferenceAdapterSet({ clock });
    const primary = descriptor("model-trusted-duplicate", "primary");
    const transport: TrustedModelTransport = {
      async *invoke(): AsyncIterable<ModelInvocationEvent> {
        yield {
          type: "model.completed",
          invocationId: "ignored-by-adapter",
          inputTokens: 1,
          outputTokens: 1,
          costMicros: 1,
          latencyMs: 1,
          occurredAt: T1,
        };
        yield {
          type: "model.completed",
          invocationId: "ignored-by-adapter",
          inputTokens: 99,
          outputTokens: 99,
          costMicros: 99,
          latencyMs: 99,
          occurredAt: T1,
        };
      },
    };
    const provider = new TrustedModelProviderAdapter({
      descriptors: [primary],
      handles: adapters.secret,
      secretSource: { resolve: async () => "unused" },
      transport,
      clock,
    });
    const events: ModelInvocationEvent[] = [];
    for await (const event of provider.invoke({
      invocationId: "invocation-duplicate",
      runId: RUN_ID,
      modelRef: primary.ref,
      inputRef: "payload-model-input",
      dataClassification: "private",
      allowedDisclosureRef: "disclosure-policy-model-router",
      secretHandleRefs: [],
      correlationId: "correlation-model-duplicate",
    })) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("model.completed");
  });
});
