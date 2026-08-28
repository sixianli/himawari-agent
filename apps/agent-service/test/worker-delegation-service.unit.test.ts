import type {
  ExecutionTransportPort,
  GovernedCapabilityExecutionHandle,
} from "@himawari-agent/application";
import { WorkerDelegationService } from "@himawari-agent/application";
import {
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionV2Event,
  type ExecutionV2Request,
  type ExecutionV2Response,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import { createBeefRestaurantFixture, createReferenceAdapterSet } from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";

const fixture = createBeefRestaurantFixture();

class RecordingWorkerTransport implements ExecutionTransportPort {
  readonly requests: ExecutionV2Request[] = [];

  async request(message: ExecutionV2Request): Promise<ExecutionV2Response | null> {
    this.requests.push(message);
    if (message.type !== "work.delegate") return null;
    return executionV2MessageSchema.parse({
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "response",
      type: "work.delegate.accepted",
      messageId: "worker-delegation-response-01",
      correlationId: message.correlationId,
      causationId: message.messageId,
      dataClassification: message.dataClassification,
      risk: message.risk,
      authorizationRef: message.authorizationRef,
      scope: message.scope,
      payload: {
        handleRef: message.payload.handle.ref,
        workerBootId: "worker-boot-01",
        acceptedAt: fixture.times.start,
      },
    }) as Extract<ExecutionV2Response, { type: "work.delegate.accepted" }>;
  }

  async *events(_afterCursor: string | null): AsyncIterable<ExecutionV2Event> {}
}

function executeRequest(): Extract<ExecutionV2Request, { type: "work.execute" }> {
  return executionV2MessageSchema.parse({
    schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
    kind: "request",
    type: "work.execute",
    messageId: "work-execute-delegation-01",
    correlationId: fixture.correlationId,
    causationId: "run-admitted-01",
    dataClassification: "private",
    risk: "low",
    authorizationRef: null,
    scope: {
      deploymentId: "deployment-01",
      authorityEpoch: 2,
      fencingToken: 3,
      ownerId: fixture.owner.id,
      agentId: fixture.agent.id,
      runId: fixture.runs.monitoring.id,
      workerRunId: "worker-run-01",
    },
    idempotencyKey: "work-execute-delegation-01",
    payload: {
      capabilityId: "restaurant-search",
      capabilityVersion: "1.0.0",
      operation: "search",
      inputRef: fixture.payloads.restaurantSearchInput,
      capabilityHandleRef: "capability-handle-delegation-01",
      delegatedContextRefs: [],
      secretRefs: [],
      resourceCeiling: {
        maxWallTimeMs: 10_000,
        maxCpuTimeMs: 5_000,
        maxMemoryBytes: 16_777_216,
        maxOutputBytes: 4_096,
        maxProgressEvents: 10,
      },
      requestedAt: fixture.times.start,
      deadlineAt: fixture.times.deadline,
    },
  }) as Extract<ExecutionV2Request, { type: "work.execute" }>;
}

describe("WorkerDelegationService", () => {
  it("consumes durable authority before sending one attenuated Worker Handle", async () => {
    const adapters = createReferenceAdapterSet();
    const declaration = fixture.capabilityDeclarations[0];
    if (!declaration) throw new TypeError("Capability declaration fixture is missing");
    await adapters.capabilityRegistry.create({
      ref: "restaurant-search",
      revision: 1,
      lifecycle: "active",
      declaration,
      pendingDeclaration: null,
      permissionExpansion: false,
      runtimeQualification: null,
      pendingUpdateAssessment: null,
      rollbackDeclaration: null,
      rollbackQualification: null,
      lastVersionTransition: null,
      approvalRefs: [],
      discoveredAt: fixture.times.start,
      updatedAt: fixture.times.start,
    });
    const handle: GovernedCapabilityExecutionHandle = {
      handleVersion: "capability-handle.v2",
      ref: "capability-handle-delegation-01",
      revision: 1,
      authorityFence: 3,
      ownerId: fixture.owner.id,
      agentId: fixture.agent.id,
      runId: fixture.runs.monitoring.id,
      capabilityRef: "restaurant-search",
      capabilityVersion: "1.0.0",
      authorization: { type: "policy", ref: "policy-readonly-01" },
      operations: ["search", "reserve"],
      inputRefs: [fixture.payloads.restaurantSearchInput, "payload-unrelated-01"],
      delegatedContextRefs: ["payload-context-unrelated-01"],
      secretRefs: [],
      maxDataClassification: "sensitive",
      issuedAt: fixture.times.start,
      expiresAt: fixture.times.deadline,
      revokedAt: null,
      operation: "search",
      authorizationRef: "policy-readonly-01",
      maxUses: 4,
      uses: 0,
      maxTotalCostMicros: 10_000,
      spentCostMicros: 0,
      idempotencyKeys: [],
      workerEndedAt: null,
    };
    await adapters.capabilityRegistry.createExecutionHandle(handle);
    const transport = new RecordingWorkerTransport();
    const service = new WorkerDelegationService({
      handles: adapters.capabilityRegistry,
      authorization: adapters.authorization,
      transport,
      authorityFence: () => 3,
      now: () => adapters.clock.now(),
      nextId: (scope) => adapters.ids.next(scope),
    });

    await service.dispatch(executeRequest());

    expect(transport.requests.map(({ type }) => type)).toEqual(["work.delegate", "work.execute"]);
    expect(transport.requests[0]).toMatchObject({
      type: "work.delegate",
      payload: {
        handle: {
          operations: ["search"],
          inputRefs: [fixture.payloads.restaurantSearchInput],
          delegatedContextRefs: [],
          maxDataClassification: "private",
          maxUses: 1,
          uses: 0,
          maxTotalCostMicros: 0,
        },
      },
    });
    await expect(
      adapters.capabilityRegistry.getExecutionHandle("capability-handle-delegation-01"),
    ).resolves.toMatchObject({ uses: 1, idempotencyKeys: ["work-execute-delegation-01"] });
  });
});
