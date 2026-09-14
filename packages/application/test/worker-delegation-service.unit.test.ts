import type {
  CapabilityInvocationAuthority,
  CapabilityInvocationConsumeResult,
  CapabilityInvocationReceiptPort,
  ConsumeCapabilityInvocationInput,
  ExecutionTransportPort,
  FrozenCapabilityInvocationReceipt,
} from "@himawari-agent/application";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createOwnerId,
  createRunId,
} from "@himawari-agent/domain";
import {
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionV2Event,
  type ExecutionV2Request,
  type ExecutionV2Response,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import { describe, expect, it } from "vitest";
import { WorkerDelegationAdmissionService, WorkerDelegationService } from "../src/index.ts";

const START = "2026-08-25T00:00:00.000Z";
const DEADLINE = "2026-08-25T00:05:00.000Z";
const CORRELATION_ID = "correlation-worker-delegation";
const OWNER_ID = createOwnerId("owner-worker-delegation");
const AGENT_ID = createAgentId("agent-worker-delegation");
const RUN_ID = createRunId("run-worker-delegation");
const DEPLOYMENT_ID = createDeploymentId("deployment-01");
const LEASE_ID = createAuthorityLeaseId("lease-01");
const INPUT_REF = "payload-search-beef-tokyo";

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
        acceptedAt: START,
      },
    }) as Extract<ExecutionV2Response, { type: "work.delegate.accepted" }>;
  }

  async *events(_afterCursor: string | null): AsyncIterable<ExecutionV2Event> {}
}

const invocationAuthority: CapabilityInvocationAuthority = {
  product: {
    deploymentId: DEPLOYMENT_ID,
    authorityEpoch: 2,
    fencingToken: 3,
  },
  lease: { leaseId: LEASE_ID, fencingToken: 3 },
  agentServiceInstanceId: "agent-service-instance-01",
  agentServiceBootId: "agent-service-boot-01",
  workerInstanceId: "worker-instance-01",
  workerBootId: "worker-boot-01",
};

class RecordingInvocationPort implements CapabilityInvocationReceiptPort {
  readonly consumes: ConsumeCapabilityInvocationInput[] = [];
  private receipt: FrozenCapabilityInvocationReceipt | undefined;

  async consume(
    input: ConsumeCapabilityInvocationInput,
  ): Promise<CapabilityInvocationConsumeResult> {
    this.consumes.push(input);
    if (this.receipt) return { replayed: true, receipt: this.receipt };
    this.receipt = Object.freeze({
      receiptVersion: "capability-invocation.v1" as const,
      receiptRef: input.receiptRef,
      ownerId: input.requestScope.ownerId as FrozenCapabilityInvocationReceipt["ownerId"],
      agentId: input.requestScope.agentId as FrozenCapabilityInvocationReceipt["agentId"],
      runId: input.requestScope.runId as FrozenCapabilityInvocationReceipt["runId"],
      handleRef: input.handleRef,
      handleRevision: 2,
      invocationId: input.invocationId,
      workerRunId: input.requestScope.workerRunId,
      idempotencyKey: input.idempotencyKey,
      capabilityRef: input.capabilityRef,
      capabilityVersion: input.capabilityVersion,
      authorization: { type: "policy" as const, ref: "policy-readonly-01" },
      authorizationRef: "policy-readonly-01",
      operation: input.operation,
      inputRef: input.inputRef,
      delegatedContextRefs: input.delegatedContextRefs,
      secretRefs: input.secretRefs,
      dataClassification: input.dataClassification,
      resourceCeiling: input.resourceCeiling,
      requestedAt: input.requestedAt,
      deadlineAt: input.deadlineAt,
      effectiveExpiresAt: input.deadlineAt,
      authority: invocationAuthority,
      semanticFingerprint: "fingerprint-worker-delegation-01",
      consumedAt: input.consumedAt,
    });
    return { replayed: false, receipt: this.receipt };
  }

  async read(): Promise<FrozenCapabilityInvocationReceipt | undefined> {
    throw new Error("WorkerDelegationService does not use the read path");
  }
}

function executeRequest(): Extract<ExecutionV2Request, { type: "work.execute" }> {
  return executionV2MessageSchema.parse({
    schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
    kind: "request",
    type: "work.execute",
    messageId: "work-execute-delegation-01",
    correlationId: CORRELATION_ID,
    causationId: "run-admitted-01",
    dataClassification: "private",
    risk: "low",
    authorizationRef: null,
    scope: {
      deploymentId: DEPLOYMENT_ID,
      authorityEpoch: 2,
      fencingToken: 3,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      runId: RUN_ID,
      workerRunId: "worker-run-01",
    },
    idempotencyKey: "work-execute-delegation-01",
    payload: {
      capabilityId: "restaurant-search",
      capabilityVersion: "1.0.0",
      operation: "search",
      inputRef: INPUT_REF,
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
      requestedAt: START,
      deadlineAt: DEADLINE,
    },
  }) as Extract<ExecutionV2Request, { type: "work.execute" }>;
}

describe("WorkerDelegationService", () => {
  it("rejects caller-assigned sandbox identity before consuming authority", async () => {
    const invocations = new RecordingInvocationPort();
    const service = new WorkerDelegationAdmissionService({
      invocations,
      invocationAuthority: () => invocationAuthority,
      now: () => START,
      nextId: (scope) => `${scope}-01`,
    });
    const request = executeRequest();
    await expect(
      service.admit({
        ...request,
        payload: {
          ...request.payload,
          sandboxJob: {
            jobId: "job",
            attemptId: "attempt",
            receiptRef: "receipt",
            hostId: "host",
            threadId: "thread",
            toolCallId: "tool",
            invocationId: request.messageId,
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            runId: RUN_ID,
          },
        },
      }),
    ).rejects.toThrow("assigned by trusted admission");
    expect(invocations.consumes).toEqual([]);
  });

  it("returns an executable projection only for a newly consumed receipt", async () => {
    const invocations = new RecordingInvocationPort();
    const admission = new WorkerDelegationAdmissionService({
      invocations,
      invocationAuthority: () => invocationAuthority,
      now: () => START,
      nextId: (scope) => `${scope}-01`,
    });

    const consumed = await admission.admit(executeRequest());
    expect(consumed.disposition).toBe("consumed");
    if (consumed.disposition !== "consumed") throw new Error("expected a fresh receipt");
    expect(consumed.projection.delegate.type).toBe("work.delegate");
    expect(consumed.projection.execute.type).toBe("work.execute");
    expect(consumed.projection.execute.messageId).toBe(consumed.receipt.invocationId);

    const replayed = await admission.admit(executeRequest());
    expect(replayed.disposition).toBe("replayed");
    expect("projection" in replayed).toBe(false);
  });

  it("consumes durable authority before sending one attenuated Worker Handle", async () => {
    const transport = new RecordingWorkerTransport();
    const invocations = new RecordingInvocationPort();
    const service = new WorkerDelegationService({
      invocations,
      invocationAuthority: () => invocationAuthority,
      transport,
      now: () => START,
      nextId: (scope) => `${scope}-01`,
    });

    await service.dispatch(executeRequest());

    expect(transport.requests.map(({ type }) => type)).toEqual(["work.delegate", "work.execute"]);
    expect(transport.requests[0]).toMatchObject({
      type: "work.delegate",
      payload: {
        handle: {
          ref: "capability-handle-delegation-01",
          revision: 2,
          operations: ["search"],
          inputRefs: [INPUT_REF],
          delegatedContextRefs: [],
          maxDataClassification: "private",
          maxUses: 1,
          uses: 0,
          maxTotalCostMicros: 0,
        },
      },
    });
    expect(transport.requests[1]).toMatchObject({
      type: "work.execute",
      messageId: "work-execute-delegation-01",
      idempotencyKey: "work-execute-delegation-01",
      payload: {
        capabilityId: "restaurant-search",
        capabilityVersion: "1.0.0",
        operation: "search",
        inputRef: INPUT_REF,
        capabilityHandleRef: "capability-handle-delegation-01",
      },
    });
    expect(invocations.consumes).toHaveLength(1);
    expect(invocations.consumes[0]).toMatchObject({
      invocationId: "work-execute-delegation-01",
      handleRef: "capability-handle-delegation-01",
      requestScope: executeRequest().scope,
    });

    await service.dispatch(executeRequest());

    expect(transport.requests.map(({ type }) => type)).toEqual(["work.delegate", "work.execute"]);
    expect(invocations.consumes).toHaveLength(2);
  });
});
