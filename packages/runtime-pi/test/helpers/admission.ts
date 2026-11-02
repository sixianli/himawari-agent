import type {
  ModelInvocationAdmissionInput,
  ModelInvocationAdmissionPort,
  ModelInvocationExecutionContext,
  ModelInvocationIdentity,
  ModelInvocationPermit,
  RuntimeRequest,
} from "@himawari-agent/application/runtime-port";

const NOW = "2026-08-25T10:00:00.000Z";

export function fixtureIdentifier<T extends string>(value: string): T {
  return value as T;
}

export function fixtureExecutionLease(): ModelInvocationExecutionContext["executionLease"] {
  const claim: ModelInvocationExecutionContext["executionLease"] = {
    executionLeaseId: fixtureIdentifier("execution-pi-runtime-test"),
    expectedLeaseRevision: 1,
    authorityLeaseId: fixtureIdentifier("authority-pi-runtime-test"),
    authorityFencingToken: 1,
    deploymentId: fixtureIdentifier("deployment-pi-runtime-test"),
    authorityEpoch: 1,
    fencingToken: 1,
    consumerId: "pi-runtime-test",
  };
  return Object.freeze(claim);
}

function fixtureAdmissionIdentity(
  scope: {
    readonly ownerId: RuntimeRequest["ownerId"];
    readonly agentId: RuntimeRequest["agentId"];
    readonly runId: RuntimeRequest["runId"];
  },
  input: ModelInvocationAdmissionInput,
  executionLease: ModelInvocationExecutionContext["executionLease"],
): ModelInvocationIdentity {
  return Object.freeze({
    ownerId: scope.ownerId,
    agentId: scope.agentId,
    runId: scope.runId,
    logicalSlot: input.logicalSlot,
    sequence: 1,
    invocationId: "invocation-pi-runtime-test",
    modelRef: input.modelRef,
    provider: input.provider,
    model: input.model,
    modelVersion: input.modelVersion,
    dataClassification: input.dataClassification,
    source: input.source,
    ordinal: input.ordinal,
    pricing: Object.freeze({ ...input.pricing }),
    pricingFingerprint: "fixture-pricing",
    estimatedCostMicros: input.estimatedCostMicros,
    budgetAccountId: "account-pi-runtime-test",
    budgetOperationKey: input.logicalSlot,
    authority: Object.freeze({
      deploymentId: executionLease.deploymentId,
      authorityEpoch: executionLease.authorityEpoch,
      fencingToken: executionLease.fencingToken,
    }),
    authorityLease: Object.freeze({
      leaseId: executionLease.authorityLeaseId,
      fencingToken: executionLease.authorityFencingToken,
    }),
    executionLease,
    status: "reserved",
    reservedAt: NOW,
    startedAt: null,
    observedAt: null,
    settledAt: null,
    releasedAt: null,
    actualCostMicros: null,
    reasonCode: null,
  });
}

export function allowAdmission(
  scope: {
    readonly ownerId: RuntimeRequest["ownerId"];
    readonly agentId: RuntimeRequest["agentId"];
    readonly runId: RuntimeRequest["runId"];
    readonly executionLease?: ModelInvocationExecutionContext["executionLease"];
  },
  executionLease = scope.executionLease,
  permit: ModelInvocationPermit = {
    assertActive: async () => undefined,
    markStarted: async () => undefined,
    releaseReserved: async () => undefined,
    settle: async () => undefined,
    markUnknown: async () => undefined,
  },
): ModelInvocationAdmissionPort {
  if (!executionLease) throw new Error("Missing runtime execution lease claim");
  return {
    context: {
      ownerId: scope.ownerId,
      agentId: scope.agentId,
      runId: scope.runId,
      executionLease,
    },
    begin: async (input) => ({
      disposition: "fresh",
      identity: fixtureAdmissionIdentity(scope, input, executionLease),
      permit,
    }),
  };
}
