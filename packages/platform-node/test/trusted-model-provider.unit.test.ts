import type {
  ModelDescriptor,
  ModelInvocationAdmissionResult,
  ModelInvocationEvent,
  ModelInvocationIdentity,
  ModelInvocationPermit,
  ModelInvocationUnknownReason,
  ModelInvocationUsage,
  SecretHandle,
  SecretPort,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createOwnerId,
  createRunExecutionLeaseId,
  createRunId,
} from "@himawari-agent/domain";
import { describe, expect, it } from "vitest";
import {
  TrustedModelProviderAdapter,
  type TrustedModelTransport,
  type TrustedModelTransportInput,
} from "../src/trusted-model-provider.js";

const OWNER_ID = createOwnerId("owner-trusted-model-test");
const AGENT_ID = createAgentId("agent-trusted-model-test");
const RUN_ID = createRunId("run-trusted-model-test");
const NOW = "2026-09-05T00:00:00.000Z";

const DESCRIPTOR: ModelDescriptor = Object.freeze({
  ref: "model-trusted-model-test",
  provider: "fixture-provider",
  model: "fixture-model",
  version: "fixture-1",
  routingClass: "primary",
  priority: 1,
  disclosure: "trusted_remote",
  capabilities: ["text"] as const,
  allowedDataClassifications: ["private"] as const,
  secretRequirement: {
    secretRef: "provider-secret",
    secretVersion: "v1",
    purpose: "model-provider-auth",
  },
});

const HANDLE: SecretHandle = Object.freeze({
  ref: "handle-trusted-model-test",
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  runId: RUN_ID,
  secretRef: "provider-secret",
  secretVersion: "v1",
  purpose: "model-provider-auth",
  scopeRef: "invocation-trusted-model-test",
  expiresAt: "2026-09-05T00:01:00.000Z",
  revokedAt: null,
});

const secretPort: SecretPort = {
  issueHandle: async () => {
    throw new Error("unused");
  },
  inspectHandle: async (handleRef) => (handleRef === HANDLE.ref ? HANDLE : undefined),
  revokeHandle: async () => HANDLE,
};

const admissionCost = Object.freeze({
  pricing: Object.freeze({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0.75 }),
  estimatedCostMicros: 10_000,
});

function executionContext() {
  return {
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    executionLease: {
      executionLeaseId: createRunExecutionLeaseId("execution-trusted-model-test"),
      expectedLeaseRevision: 1,
      authorityLeaseId: createAuthorityLeaseId("authority-trusted-model-test"),
      authorityFencingToken: 1,
      deploymentId: createDeploymentId("deployment-trusted-model-test"),
      authorityEpoch: 1,
      fencingToken: 1,
      consumerId: "trusted-model-test",
    },
  };
}

function freshAdmission(permit: ModelInvocationPermit): ModelInvocationAdmissionResult {
  const context = executionContext();
  return {
    disposition: "fresh",
    identity: Object.freeze({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      logicalSlot: HANDLE.scopeRef,
      sequence: 1,
      invocationId: HANDLE.scopeRef,
      modelRef: DESCRIPTOR.ref,
      provider: DESCRIPTOR.provider,
      model: DESCRIPTOR.model,
      modelVersion: DESCRIPTOR.version,
      dataClassification: "private",
      source: "model-port",
      ordinal: 1,
      pricing: Object.freeze({ ...admissionCost.pricing }),
      pricingFingerprint: "sha256:trusted-model-fixture",
      estimatedCostMicros: admissionCost.estimatedCostMicros,
      budgetAccountId: "run-account-trusted-model-test",
      budgetOperationKey: "model-invocation:trusted-model-test",
      authority: Object.freeze({
        deploymentId: context.executionLease.deploymentId,
        authorityEpoch: context.executionLease.authorityEpoch,
        fencingToken: context.executionLease.fencingToken,
      }),
      authorityLease: Object.freeze({
        leaseId: context.executionLease.authorityLeaseId,
        fencingToken: context.executionLease.authorityFencingToken,
      }),
      executionLease: context.executionLease,
      status: "reserved",
      reservedAt: NOW,
      startedAt: null,
      observedAt: null,
      settledAt: null,
      releasedAt: null,
      actualCostMicros: null,
      reasonCode: null,
    } satisfies ModelInvocationIdentity),
    permit,
  };
}

function invocation() {
  return {
    invocationId: HANDLE.scopeRef,
    runId: RUN_ID,
    modelRef: DESCRIPTOR.ref,
    inputRef: "payload-model-input",
    dataClassification: "private" as const,
    allowedDisclosureRef: "disclosure-model-test",
    secretHandleRefs: [HANDLE.ref],
    correlationId: "correlation-model-test",
  };
}

function providerEvents(usage: {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}): readonly ModelInvocationEvent[] {
  return [
    { type: "model.started", invocationId: HANDLE.scopeRef, occurredAt: NOW },
    {
      type: "model.completed",
      invocationId: HANDLE.scopeRef,
      ...usage,
      costMicros: 999_999,
      latencyMs: 12,
      occurredAt: NOW,
    },
  ];
}

class RecordingTransport implements TrustedModelTransport {
  readonly calls: TrustedModelTransportInput[] = [];
  readonly events: readonly ModelInvocationEvent[];

  constructor(events: readonly ModelInvocationEvent[]) {
    this.events = events;
  }

  async *invoke(input: TrustedModelTransportInput): AsyncIterable<ModelInvocationEvent> {
    this.calls.push(input);
    yield* this.events;
  }
}

function provider(options: {
  readonly transport: TrustedModelTransport;
  readonly admission?: TrustedModelProviderAdapterDependencies["admission"];
  readonly events?: string[];
  readonly resolveSecret?: () => Promise<string>;
}) {
  const events = options.events ?? [];
  return new TrustedModelProviderAdapter({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    descriptors: [DESCRIPTOR],
    handles: secretPort,
    secretSource: {
      resolve: async () => {
        events.push("secret");
        return options.resolveSecret ? await options.resolveSecret() : "scoped-secret-value";
      },
    },
    transport: {
      invoke: async function* (input) {
        events.push("transport");
        yield* options.transport.invoke(input);
      },
    },
    clock: { now: () => NOW },
    ...(options.admission === undefined ? {} : { admission: options.admission }),
    admissionCost: () => admissionCost,
  });
}

type TrustedModelProviderAdapterDependencies = ConstructorParameters<
  typeof TrustedModelProviderAdapter
>[0];

describe("TrustedModelProviderAdapter invocation admission", () => {
  it("admits before resolving a secret and settles from usage, not costMicros", async () => {
    const order: string[] = [];
    let settled: ModelInvocationUsage | undefined;
    const gate = {
      context: executionContext(),
      begin: async () => {
        order.push("begin");
        return freshAdmission({
          assertActive: async () => {
            order.push("assert");
          },
          markStarted: async () => {
            order.push("started");
          },
          releaseReserved: async () => {
            order.push("released");
          },
          settle: async (usage: ModelInvocationUsage) => {
            order.push("settle");
            settled = usage;
          },
          markUnknown: async () => {
            order.push("unknown");
          },
        });
      },
    };
    const transport = new RecordingTransport(
      providerEvents({
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 20,
        cacheWriteTokens: 5,
      }),
    );
    const model = provider({
      transport,
      events: order,
      admission: async () => gate,
    });

    const events: ModelInvocationEvent[] = [];
    for await (const event of model.invoke(invocation())) events.push(event);

    expect(order).toEqual([
      "begin",
      "assert",
      "secret",
      "assert",
      "started",
      "transport",
      "settle",
    ]);
    expect(settled).toEqual({
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
    });
    expect(transport.calls[0]?.secretValues).toEqual(["scoped-secret-value"]);
    expect(events.at(-1)).toMatchObject({ type: "model.completed", costMicros: 999_999 });
  });

  it("fails closed before secret or transport when no gate is supplied", async () => {
    let secretCalls = 0;
    let transportCalls = 0;
    const model = new TrustedModelProviderAdapter({
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      descriptors: [DESCRIPTOR],
      handles: secretPort,
      secretSource: {
        resolve: async () => {
          secretCalls += 1;
          return "secret";
        },
      },
      transport: {
        invoke: () => {
          transportCalls += 1;
          return {
            [Symbol.asyncIterator](): AsyncIterator<ModelInvocationEvent> {
              return {
                next: async () => ({ done: true as const, value: undefined }),
              };
            },
          };
        },
      },
      clock: { now: () => NOW },
      admissionCost: () => admissionCost,
    });

    await expect(async () => {
      for await (const _event of model.invoke(invocation())) return;
    }).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
    expect(secretCalls).toBe(0);
    expect(transportCalls).toBe(0);
  });

  it("preserves unknown when terminal usage is incomplete", async () => {
    const unknown: string[] = [];
    const gate = {
      context: executionContext(),
      begin: async () =>
        freshAdmission({
          assertActive: async () => undefined,
          markStarted: async () => undefined,
          releaseReserved: async () => undefined,
          settle: async () => {
            throw new Error("settle must not run");
          },
          markUnknown: async (reasonCode: ModelInvocationUnknownReason) => {
            unknown.push(reasonCode);
          },
        }),
    };
    const model = provider({
      transport: new RecordingTransport(providerEvents({ inputTokens: 100, outputTokens: 10 })),
      admission: async () => gate,
    });

    const events: ModelInvocationEvent[] = [];
    for await (const event of model.invoke(invocation())) events.push(event);

    expect(unknown).toEqual(["provider_unresolved"]);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "model.completed" }));
    expect(events.at(-1)).toMatchObject({
      type: "model.failed",
      errorCode: "MODEL_PROVIDER_USAGE_UNAVAILABLE",
    });
  });

  it("does not expose provider success when durable settlement fails", async () => {
    const unknown: string[] = [];
    const gate = {
      context: executionContext(),
      begin: async () =>
        freshAdmission({
          assertActive: async () => undefined,
          markStarted: async () => undefined,
          releaseReserved: async () => undefined,
          settle: async () => {
            throw new Error("durable settlement failed");
          },
          markUnknown: async (reasonCode: ModelInvocationUnknownReason) => {
            unknown.push(reasonCode);
          },
        }),
    };
    const model = provider({
      transport: new RecordingTransport(
        providerEvents({
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 20,
          cacheWriteTokens: 5,
        }),
      ),
      admission: async () => gate,
    });

    await expect(async () => {
      for await (const _event of model.invoke(invocation())) {
        // Drain the generator so settlement is observed.
      }
    }).rejects.toMatchObject({
      code: "PORT_INVALID_OPERATION",
      message: "Model budget settlement failed",
    });
    expect(unknown).toEqual(["transport_unresolved"]);
  });

  it("releases a reservation when secret resolution fails before the provider stream", async () => {
    const released: string[] = [];
    let transportCalls = 0;
    const gate = {
      context: executionContext(),
      begin: async () =>
        freshAdmission({
          assertActive: async () => undefined,
          markStarted: async () => {
            throw new Error("markStarted must not run");
          },
          releaseReserved: async () => {
            released.push("released");
          },
          settle: async () => {
            throw new Error("settle must not run");
          },
          markUnknown: async () => {
            throw new Error("unknown must not run");
          },
        }),
    };
    const model = provider({
      transport: {
        invoke: async function* () {
          transportCalls += 1;
          yield* [] as readonly ModelInvocationEvent[];
        },
      },
      admission: async () => gate,
      resolveSecret: async () => {
        throw new Error("secret source unavailable");
      },
    });

    await expect(async () => {
      for await (const _event of model.invoke(invocation())) {
        // Drain the generator so the pre-start failure is observed.
      }
    }).rejects.toMatchObject({ code: "PORT_NOT_FOUND" });
    expect(released).toEqual(["released"]);
    expect(transportCalls).toBe(0);
  });
});
