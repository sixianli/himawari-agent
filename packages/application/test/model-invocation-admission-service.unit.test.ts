import {
  ApplicationPortError,
  type ModelInvocationAdmissionDescriptor,
  type ModelInvocationAdmissionInput,
  type ModelInvocationAdmissionResult,
  ModelInvocationAdmissionService,
  type ModelInvocationIdentity,
  type ModelInvocationIdentityBeginResult,
  type ModelInvocationIdentityPort,
  type ModelInvocationPermit,
  type ModelInvocationPricing,
  PORT_ERROR_CODES,
  type RunDispatchPort,
  type RunExecutionLease,
  type RunExecutionLeaseClaim,
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

const OWNER_ID = createOwnerId("owner-model-admission");
const AGENT_ID = createAgentId("agent-model-admission");
const RUN_ID = createRunId("run-model-admission");
const AUTHORITY_LEASE_ID = createAuthorityLeaseId("authority-model-admission");
const DEPLOYMENT_ID = createDeploymentId("deployment-model-admission");
const EXECUTION_LEASE_ID = createRunExecutionLeaseId("execution-model-admission");
const NOW = "2026-09-05T00:00:00.000Z";
const LATER = "2026-09-05T00:00:01.000Z";
const FAR_FUTURE = "2099-12-31T23:59:59.999Z";

const PRICING: ModelInvocationPricing = {
  input: 1.5,
  output: 2,
  cacheRead: 0.25,
  cacheWrite: 0.5,
};

const DESCRIPTOR: ModelInvocationAdmissionDescriptor = {
  ref: "provider:model:v1",
  provider: "provider",
  model: "model",
  version: "v1",
  routingClass: "primary",
  priority: 1,
  disclosure: "trusted_remote",
  capabilities: ["chat"],
  allowedDataClassifications: ["private"],
  secretRequirement: null,
  pricing: PRICING,
  estimatedCostMicros: 100,
};

const LIMITS = {
  accountCostMicros: 10_000,
  globalCostMicros: 100_000,
  perClassificationCostMicros: {
    public: 100_000,
    private: 100_000,
    sensitive: 100_000,
    restricted: 100_000,
  },
} as const;

const CLAIM: RunExecutionLeaseClaim = {
  executionLeaseId: EXECUTION_LEASE_ID,
  expectedLeaseRevision: 1,
  authorityLeaseId: AUTHORITY_LEASE_ID,
  authorityFencingToken: 7,
  deploymentId: DEPLOYMENT_ID,
  authorityEpoch: 3,
  fencingToken: 7,
  consumerId: "consumer-model-admission",
};

const LEASE: RunExecutionLease = {
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  runId: RUN_ID,
  authorityLeaseId: AUTHORITY_LEASE_ID,
  deploymentId: DEPLOYMENT_ID,
  authorityEpoch: CLAIM.authorityEpoch,
  fencingToken: CLAIM.fencingToken,
  consumerId: CLAIM.consumerId,
  executionLeaseId: EXECUTION_LEASE_ID,
  revision: CLAIM.expectedLeaseRevision,
  claimedAt: NOW,
  expiresAt: FAR_FUTURE,
  releasedAt: null,
};

const INVALID_INPUTS = [
  ["provider", { provider: "another-provider" }],
  ["model", { model: "another-model" }],
  ["version", { modelVersion: "v2" }],
  ["classification", { dataClassification: "restricted" }],
  ["logical slot", { logicalSlot: "" }],
  ["ordinal", { ordinal: 0 }],
  ["estimate", { estimatedCostMicros: 101 }],
  ["pricing", { pricing: { ...PRICING, output: 9 } }],
] as const satisfies readonly (readonly [string, Partial<ModelInvocationAdmissionInput>])[];

const IDENTITY: ModelInvocationIdentity = Object.freeze({
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  runId: RUN_ID,
  logicalSlot: "run:model-admission:1",
  sequence: 1,
  invocationId: "model-invocation:run-model-admission:slot:1",
  modelRef: DESCRIPTOR.ref,
  provider: DESCRIPTOR.provider,
  model: DESCRIPTOR.model,
  modelVersion: DESCRIPTOR.version,
  dataClassification: "private",
  source: "model-port",
  ordinal: 1,
  pricing: Object.freeze({ ...PRICING }),
  pricingFingerprint: "sha256:model-admission-pricing",
  estimatedCostMicros: DESCRIPTOR.estimatedCostMicros,
  budgetAccountId: "run-account-model-admission",
  budgetOperationKey: "model-invocation:model-admission",
  authority: Object.freeze({
    deploymentId: DEPLOYMENT_ID,
    authorityEpoch: CLAIM.authorityEpoch,
    fencingToken: CLAIM.fencingToken,
  }),
  authorityLease: Object.freeze({
    leaseId: AUTHORITY_LEASE_ID,
    fencingToken: CLAIM.authorityFencingToken,
  }),
  executionLease: CLAIM,
  status: "reserved",
  reservedAt: NOW,
  startedAt: null,
  observedAt: null,
  settledAt: null,
  releasedAt: null,
  actualCostMicros: null,
  reasonCode: null,
});

function identityWith(overrides: Partial<ModelInvocationIdentity>): ModelInvocationIdentity {
  return Object.freeze({ ...IDENTITY, ...overrides });
}

class DispatchStub implements RunDispatchPort {
  readonly assertHeldCalls: Parameters<RunDispatchPort["assertHeld"]>[0][] = [];
  result: RunExecutionLease = LEASE;
  error: Error | undefined;

  async assertHeld(
    input: Parameters<RunDispatchPort["assertHeld"]>[0],
  ): Promise<RunExecutionLease> {
    this.assertHeldCalls.push(input);
    if (this.error !== undefined) throw this.error;
    return this.result;
  }

  async listClaimable(
    _input: Parameters<RunDispatchPort["listClaimable"]>[0],
  ): ReturnType<RunDispatchPort["listClaimable"]> {
    throw new Error("listClaimable was not expected");
  }

  async listReconciliationRequired(
    _input: Parameters<RunDispatchPort["listReconciliationRequired"]>[0],
  ): ReturnType<RunDispatchPort["listReconciliationRequired"]> {
    throw new Error("listReconciliationRequired was not expected");
  }

  async claim(
    _input: Parameters<RunDispatchPort["claim"]>[0],
  ): ReturnType<RunDispatchPort["claim"]> {
    throw new Error("claim was not expected");
  }

  async renew(
    _input: Parameters<RunDispatchPort["renew"]>[0],
  ): ReturnType<RunDispatchPort["renew"]> {
    throw new Error("renew was not expected");
  }

  async release(
    _input: Parameters<RunDispatchPort["release"]>[0],
  ): ReturnType<RunDispatchPort["release"]> {
    throw new Error("release was not expected");
  }
}

class IdentityStub implements ModelInvocationIdentityPort {
  readonly beginCalls: Parameters<ModelInvocationIdentityPort["begin"]>[0][] = [];
  readonly markStartedCalls: Parameters<ModelInvocationIdentityPort["markStarted"]>[0][] = [];
  readonly releaseReservedCalls: Parameters<ModelInvocationIdentityPort["releaseReserved"]>[0][] =
    [];
  readonly settleCalls: Parameters<ModelInvocationIdentityPort["settle"]>[0][] = [];
  readonly unknownCalls: Parameters<ModelInvocationIdentityPort["markUnknown"]>[0][] = [];
  beginResult: ModelInvocationIdentityBeginResult = {
    disposition: "fresh",
    identity: IDENTITY,
  };
  beginError: Error | undefined;
  settleError: Error | undefined;

  async begin(
    input: Parameters<ModelInvocationIdentityPort["begin"]>[0],
  ): Promise<ModelInvocationIdentityBeginResult> {
    this.beginCalls.push(input);
    if (this.beginError !== undefined) throw this.beginError;
    return this.beginResult;
  }

  async markStarted(
    input: Parameters<ModelInvocationIdentityPort["markStarted"]>[0],
  ): Promise<ModelInvocationIdentity> {
    this.markStartedCalls.push(input);
    return identityWith({ status: "started", startedAt: input.at });
  }

  async releaseReserved(
    input: Parameters<ModelInvocationIdentityPort["releaseReserved"]>[0],
  ): Promise<ModelInvocationIdentity> {
    this.releaseReservedCalls.push(input);
    return identityWith({ status: "released", releasedAt: input.at });
  }

  async settle(
    input: Parameters<ModelInvocationIdentityPort["settle"]>[0],
  ): Promise<ModelInvocationIdentity> {
    this.settleCalls.push(input);
    if (this.settleError !== undefined) throw this.settleError;
    return identityWith({
      status: "settled",
      actualCostMicros: input.actualCostMicros,
      settledAt: input.at,
    });
  }

  async markUnknown(
    input: Parameters<ModelInvocationIdentityPort["markUnknown"]>[0],
  ): Promise<ModelInvocationIdentity> {
    this.unknownCalls.push(input);
    return identityWith({ status: "unknown", observedAt: input.at, reasonCode: input.reasonCode });
  }

  async read(
    _input: Parameters<ModelInvocationIdentityPort["read"]>[0],
  ): ReturnType<ModelInvocationIdentityPort["read"]> {
    throw new Error("read was not expected");
  }
}

function serviceFixture() {
  const dispatch = new DispatchStub();
  const invocations = new IdentityStub();
  let currentTime = NOW;
  const service = new ModelInvocationAdmissionService({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    executionLease: CLAIM,
    dispatch,
    invocations,
    clock: { now: () => currentTime },
    limits: LIMITS,
    registry: [DESCRIPTOR],
  });
  return {
    service,
    dispatch,
    invocations,
    setTime: (value: string) => {
      currentTime = value;
    },
  };
}

function input(
  overrides: Partial<ModelInvocationAdmissionInput> = {},
): ModelInvocationAdmissionInput {
  return {
    modelRef: DESCRIPTOR.ref,
    provider: DESCRIPTOR.provider,
    model: DESCRIPTOR.model,
    modelVersion: DESCRIPTOR.version,
    dataClassification: "private",
    logicalSlot: IDENTITY.logicalSlot,
    source: "model-port",
    ordinal: 1,
    estimatedCostMicros: DESCRIPTOR.estimatedCostMicros,
    pricing: PRICING,
    ...overrides,
  };
}

function freshPermit(result: ModelInvocationAdmissionResult): ModelInvocationPermit {
  if (result.disposition !== "fresh") {
    throw new Error(`Expected a fresh model invocation, received ${result.disposition}`);
  }
  return result.permit;
}

describe("ModelInvocationAdmissionService", () => {
  it("freezes the gate context and settles cache-aware usage through the identity port", async () => {
    const fixture = serviceFixture();
    const permit = freshPermit(await fixture.service.begin(input()));

    expect(Object.isFrozen(fixture.service.context)).toBe(true);
    expect(Object.isFrozen(fixture.service.context.executionLease)).toBe(true);
    expect(Reflect.set(fixture.service.context, "runId", createRunId("other-run"))).toBe(false);
    expect(fixture.service.context.runId).toBe(RUN_ID);
    expect(fixture.invocations.beginCalls[0]).toMatchObject({
      logicalSlot: IDENTITY.logicalSlot,
      modelRef: DESCRIPTOR.ref,
      estimatedCostMicros: DESCRIPTOR.estimatedCostMicros,
      runId: RUN_ID,
      executionLease: CLAIM,
    });

    await permit.assertActive();
    await permit.markStarted();
    await permit.settle({
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
    });

    expect(fixture.dispatch.assertHeldCalls).toHaveLength(3);
    expect(fixture.invocations.markStartedCalls).toHaveLength(1);
    expect(fixture.invocations.settleCalls[0]).toMatchObject({
      runId: RUN_ID,
      invocationId: IDENTITY.invocationId,
      budgetOperationKey: IDENTITY.budgetOperationKey,
      actualCostMicros: 18,
    });
    expect(fixture.invocations.settleCalls[0]?.actualCostMicros).not.toBe(0);
  });

  it("releases a pre-start reservation through the durable identity port", async () => {
    const fixture = serviceFixture();
    const permit = freshPermit(await fixture.service.begin(input()));
    await permit.releaseReserved();

    expect(fixture.invocations.releaseReservedCalls).toEqual([
      {
        runId: RUN_ID,
        invocationId: IDENTITY.invocationId,
        budgetOperationKey: IDENTITY.budgetOperationKey,
        executionLease: CLAIM,
        at: NOW,
      },
    ]);
  });

  it.each(INVALID_INPUTS)(
    "rejects an invalid %s before reserve or provider access",
    async (_name, override) => {
      const fixture = serviceFixture();

      await expect(fixture.service.begin(input(override))).rejects.toMatchObject({
        code: PORT_ERROR_CODES.INVALID_OPERATION,
      });
      expect(fixture.dispatch.assertHeldCalls).toHaveLength(0);
      expect(fixture.invocations.beginCalls).toHaveLength(0);
    },
  );

  it("rejects an unregistered model and invalid registry prices at construction", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.begin(input({ modelRef: "unregistered:model:v1" })),
    ).rejects.toMatchObject({
      code: PORT_ERROR_CODES.NOT_FOUND,
    });

    expect(
      () =>
        new ModelInvocationAdmissionService({
          ownerId: OWNER_ID,
          agentId: AGENT_ID,
          runId: RUN_ID,
          executionLease: CLAIM,
          dispatch: fixture.dispatch,
          invocations: fixture.invocations,
          clock: { now: () => NOW },
          limits: LIMITS,
          registry: [{ ...DESCRIPTOR, pricing: { ...PRICING, input: Number.NaN } }],
        }),
    ).toThrowError(
      expect.objectContaining({
        code: PORT_ERROR_CODES.INVALID_OPERATION,
        details: expect.objectContaining({ field: "registry[0].pricing.input" }),
      }),
    );
  });

  it("requires the same live lease for begin and every active transition", async () => {
    const fixture = serviceFixture();
    fixture.dispatch.error = new ApplicationPortError(
      PORT_ERROR_CODES.NOT_AUTHORITATIVE,
      "execution lease is stale",
    );

    await expect(fixture.service.begin(input())).rejects.toMatchObject({
      code: PORT_ERROR_CODES.NOT_AUTHORITATIVE,
    });
    expect(fixture.invocations.beginCalls).toHaveLength(0);

    fixture.dispatch.error = undefined;
    const permit = freshPermit(await fixture.service.begin(input()));
    fixture.dispatch.error = new ApplicationPortError(
      PORT_ERROR_CODES.CONFLICT,
      "run became terminal",
    );
    await expect(permit.assertActive()).rejects.toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });
    await expect(permit.markStarted()).rejects.toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });
    expect(fixture.invocations.markStartedCalls).toHaveLength(0);
  });

  it("rejects an identity result that escapes the bound Run scope", async () => {
    const fixture = serviceFixture();
    fixture.invocations.beginResult = {
      disposition: "fresh",
      identity: identityWith({ ownerId: createOwnerId("other-owner") }),
    };

    await expect(fixture.service.begin(input())).rejects.toMatchObject({
      code: PORT_ERROR_CODES.NOT_AUTHORITATIVE,
    });
  });

  it("allows late settlement and unknown observation without reviving an expired lease", async () => {
    const fixture = serviceFixture();
    const permit = freshPermit(await fixture.service.begin(input()));
    await permit.markStarted();
    fixture.dispatch.error = new ApplicationPortError(
      PORT_ERROR_CODES.NOT_AUTHORITATIVE,
      "execution lease expired",
    );
    fixture.setTime(LATER);

    await permit.settle({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    await permit.markUnknown("cancel_unresolved");

    expect(fixture.dispatch.assertHeldCalls).toHaveLength(2);
    expect(fixture.invocations.settleCalls[0]?.actualCostMicros).toBe(4);
    expect(fixture.invocations.unknownCalls[0]).toMatchObject({
      runId: RUN_ID,
      invocationId: IDENTITY.invocationId,
      budgetOperationKey: IDENTITY.budgetOperationKey,
      reasonCode: "cancel_unresolved",
    });
  });

  it.each([
    [
      "cached tokens exceed input",
      { inputTokens: 2, outputTokens: 0, cacheReadTokens: 2, cacheWriteTokens: 1 },
    ],
    [
      "negative output",
      { inputTokens: 0, outputTokens: -1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ],
    [
      "non-finite output",
      {
        inputTokens: 0,
        outputTokens: Number.POSITIVE_INFINITY,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ],
    [
      "cost overflow",
      {
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ],
  ])("rejects %s before writing a settlement", async (_name, usage) => {
    const fixture = serviceFixture();
    const permit = freshPermit(await fixture.service.begin(input()));

    await expect(permit.settle(usage)).rejects.toMatchObject({
      code: PORT_ERROR_CODES.INVALID_OPERATION,
    });
    expect(fixture.invocations.settleCalls).toHaveLength(0);
  });

  it("preserves underlying replay and conflict semantics instead of owning durable state", async () => {
    const fixture = serviceFixture();
    fixture.invocations.beginResult = {
      disposition: "replay",
      identity: IDENTITY,
      reasonCode: "MODEL_INVOCATION_RECONCILIATION_REQUIRED",
    };
    const replayed = await fixture.service.begin(input());
    expect(replayed.disposition).toBe("replay");
    expect(fixture.invocations.unknownCalls).toHaveLength(0);

    fixture.invocations.beginError = new ApplicationPortError(
      PORT_ERROR_CODES.CONFLICT,
      "operation key has different semantics",
    );
    await expect(
      fixture.service.begin(input({ logicalSlot: "run:model-admission:conflict" })),
    ).rejects.toMatchObject({
      code: PORT_ERROR_CODES.CONFLICT,
    });
  });
});
