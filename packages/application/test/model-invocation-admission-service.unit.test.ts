import {
  ApplicationPortError,
  type ModelBudgetAccount,
  type ModelBudgetAllocation,
  type ModelBudgetOperationResult,
  type ModelBudgetPort,
  type ModelInvocationAdmissionDescriptor,
  type ModelInvocationAdmissionInput,
  ModelInvocationAdmissionService,
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
  ["operation key", { operationKey: "" }],
  ["ordinal", { ordinal: 0 }],
  ["estimate", { estimatedCostMicros: 101 }],
  ["pricing", { pricing: { ...PRICING, output: 9 } }],
] as const satisfies readonly (readonly [string, Partial<ModelInvocationAdmissionInput>])[];

const ACCOUNT: ModelBudgetAccount = {
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  accountId: "run-account-model-admission",
  parent: { kind: "run", runId: RUN_ID },
  dataClassification: "private",
  reservedCostMicros: 100,
  spentCostMicros: 0,
  status: "active",
  revision: 1,
};

const ALLOCATION: ModelBudgetAllocation = {
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  accountId: ACCOUNT.accountId,
  operationKey: "run:model-admission:1",
  modelRef: DESCRIPTOR.ref,
  dataClassification: "private",
  estimatedCostMicros: DESCRIPTOR.estimatedCostMicros,
  actualCostMicros: null,
  status: "reserved",
  reservedAt: NOW,
  startedAt: null,
  observedAt: null,
  settledAt: null,
  reasonCode: null,
};

function operationResult(
  overrides: Partial<ModelBudgetAllocation> = {},
  replayed = false,
): ModelBudgetOperationResult {
  return {
    account: ACCOUNT,
    allocation: { ...ALLOCATION, ...overrides },
    replayed,
  };
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

class BudgetStub implements ModelBudgetPort {
  readonly reserveCalls: Parameters<ModelBudgetPort["reserve"]>[0][] = [];
  readonly markStartedCalls: Parameters<ModelBudgetPort["markStarted"]>[0][] = [];
  readonly releaseReservedCalls: Parameters<ModelBudgetPort["releaseReserved"]>[0][] = [];
  readonly settleCalls: Parameters<ModelBudgetPort["settle"]>[0][] = [];
  readonly unknownCalls: Parameters<ModelBudgetPort["markUnknown"]>[0][] = [];
  reserveResult = operationResult();
  reserveError: Error | undefined;
  settleError: Error | undefined;

  async read(_input: Parameters<ModelBudgetPort["read"]>[0]): ReturnType<ModelBudgetPort["read"]> {
    throw new Error("read was not expected");
  }

  async reserve(
    input: Parameters<ModelBudgetPort["reserve"]>[0],
  ): Promise<ModelBudgetOperationResult> {
    this.reserveCalls.push(input);
    if (this.reserveError !== undefined) throw this.reserveError;
    return this.reserveResult;
  }

  async markStarted(
    input: Parameters<ModelBudgetPort["markStarted"]>[0],
  ): Promise<ModelBudgetOperationResult> {
    this.markStartedCalls.push(input);
    return operationResult({ status: "started", startedAt: input.startedAt });
  }

  async settle(
    input: Parameters<ModelBudgetPort["settle"]>[0],
  ): Promise<ModelBudgetOperationResult> {
    this.settleCalls.push(input);
    if (this.settleError !== undefined) throw this.settleError;
    return operationResult({ status: "settled", actualCostMicros: input.actualCostMicros });
  }

  async releaseReserved(
    input: Parameters<ModelBudgetPort["releaseReserved"]>[0],
  ): Promise<ModelBudgetOperationResult> {
    this.releaseReservedCalls.push(input);
    return operationResult({ status: "released" });
  }

  async markUnknown(
    input: Parameters<ModelBudgetPort["markUnknown"]>[0],
  ): Promise<ModelBudgetOperationResult> {
    this.unknownCalls.push(input);
    return operationResult({
      status: "unknown",
      observedAt: input.observedAt,
      reasonCode: input.reasonCode,
    });
  }

  async finalize(
    _input: Parameters<ModelBudgetPort["finalize"]>[0],
  ): ReturnType<ModelBudgetPort["finalize"]> {
    throw new Error("finalize was not expected");
  }
}

function serviceFixture() {
  const dispatch = new DispatchStub();
  const budget = new BudgetStub();
  let currentTime = NOW;
  const service = new ModelInvocationAdmissionService({
    ownerId: OWNER_ID,
    agentId: AGENT_ID,
    runId: RUN_ID,
    executionLease: CLAIM,
    dispatch,
    budget,
    clock: { now: () => currentTime },
    limits: LIMITS,
    registry: [DESCRIPTOR],
  });
  return {
    service,
    dispatch,
    budget,
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
    operationKey: ALLOCATION.operationKey,
    source: "model-port",
    ordinal: 1,
    estimatedCostMicros: DESCRIPTOR.estimatedCostMicros,
    pricing: PRICING,
    ...overrides,
  };
}

describe("ModelInvocationAdmissionService", () => {
  it("freezes the gate context and settles cache-aware usage through the budget port", async () => {
    const fixture = serviceFixture();
    const permit = await fixture.service.begin(input());

    expect(Object.isFrozen(fixture.service.context)).toBe(true);
    expect(Object.isFrozen(fixture.service.context.executionLease)).toBe(true);
    expect(Reflect.set(fixture.service.context, "runId", createRunId("other-run"))).toBe(false);
    expect(fixture.service.context.runId).toBe(RUN_ID);
    expect(fixture.budget.reserveCalls[0]).toMatchObject({
      operationKey: ALLOCATION.operationKey,
      modelRef: DESCRIPTOR.ref,
      estimatedCostMicros: DESCRIPTOR.estimatedCostMicros,
      parent: { kind: "run", runId: RUN_ID, executionLease: CLAIM },
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
    expect(fixture.budget.markStartedCalls).toHaveLength(1);
    expect(fixture.budget.settleCalls[0]).toMatchObject({
      parent: { kind: "run", runId: RUN_ID },
      actualCostMicros: 18,
    });
    expect(fixture.budget.settleCalls[0]?.actualCostMicros).not.toBe(0);
  });

  it("releases a pre-start reservation through the durable budget port", async () => {
    const fixture = serviceFixture();
    const permit = await fixture.service.begin(input());
    await permit.releaseReserved();

    expect(fixture.budget.releaseReservedCalls).toEqual([
      {
        parent: { kind: "run", runId: RUN_ID },
        operationKey: ALLOCATION.operationKey,
        releasedAt: NOW,
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
      expect(fixture.budget.reserveCalls).toHaveLength(0);
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
          budget: fixture.budget,
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
    expect(fixture.budget.reserveCalls).toHaveLength(0);

    fixture.dispatch.error = undefined;
    const permit = await fixture.service.begin(input());
    fixture.dispatch.error = new ApplicationPortError(
      PORT_ERROR_CODES.CONFLICT,
      "run became terminal",
    );
    await expect(permit.assertActive()).rejects.toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });
    await expect(permit.markStarted()).rejects.toMatchObject({ code: PORT_ERROR_CODES.CONFLICT });
    expect(fixture.budget.markStartedCalls).toHaveLength(0);
  });

  it("rejects a budget result that escapes the bound Run scope", async () => {
    const fixture = serviceFixture();
    fixture.budget.reserveResult = operationResult({ ownerId: createOwnerId("other-owner") });

    await expect(fixture.service.begin(input())).rejects.toMatchObject({
      code: PORT_ERROR_CODES.NOT_AUTHORITATIVE,
    });
  });

  it("allows late settlement and unknown observation without reviving an expired lease", async () => {
    const fixture = serviceFixture();
    const permit = await fixture.service.begin(input());
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
    expect(fixture.budget.settleCalls[0]?.actualCostMicros).toBe(4);
    expect(fixture.budget.unknownCalls[0]).toMatchObject({
      parent: { kind: "run", runId: RUN_ID },
      operationKey: ALLOCATION.operationKey,
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
    const permit = await fixture.service.begin(input());

    await expect(permit.settle(usage)).rejects.toMatchObject({
      code: PORT_ERROR_CODES.INVALID_OPERATION,
    });
    expect(fixture.budget.settleCalls).toHaveLength(0);
  });

  it("preserves underlying replay and conflict semantics instead of owning durable state", async () => {
    const fixture = serviceFixture();
    fixture.budget.reserveResult = operationResult({}, true);
    const replayed = await fixture.service.begin(input());
    expect(fixture.budget.reserveResult.replayed).toBe(true);
    await replayed.markUnknown("provider_unresolved");

    fixture.budget.reserveError = new ApplicationPortError(
      PORT_ERROR_CODES.CONFLICT,
      "operation key has different semantics",
    );
    await expect(
      fixture.service.begin(input({ operationKey: "run:model-admission:conflict" })),
    ).rejects.toMatchObject({
      code: PORT_ERROR_CODES.CONFLICT,
    });
  });
});
