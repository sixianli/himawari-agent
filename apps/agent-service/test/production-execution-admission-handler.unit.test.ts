import type {
  CapabilityInvocationAuthority,
  CapabilityInvocationConsumeResult,
  CapabilityInvocationReceiptPort,
  ConsumeCapabilityInvocationInput,
  FrozenCapabilityInvocationReceipt,
} from "@himawari-agent/application";
import {
  createApplicationServiceIdentityFactory,
  WorkerDelegationAdmissionService,
} from "@himawari-agent/application";
import {
  EXECUTION_ADMISSION_V1_SCHEMA_VERSION,
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionAdmissionPeerBinding,
  type ExecutionAdmissionWorkExecuteRequest,
  executionAdmissionV1MessageSchema,
  executionV2MessageSchema,
  type ResourceCeiling,
} from "@himawari-agent/execution-contracts";
import { createV02Fixture } from "@himawari-agent/testing";
import { describe, expect, it } from "vitest";
import {
  PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES,
  ProductionExecutionAdmissionHandler,
  type ProductionExecutionAdmissionParentBinding,
} from "../src/production-execution-admission-handler.js";

type ExecuteRequest = ExecutionAdmissionWorkExecuteRequest["payload"]["execute"];
type CompleteScope = ProductionExecutionAdmissionParentBinding["scope"];

const FIXTURE = createV02Fixture();
const IDENTITY_FACTORY = createApplicationServiceIdentityFactory();
const OWNER_ID = FIXTURE.scope.ownerId;
const AGENT_ID = FIXTURE.scope.agentId;
const RUN_ID = FIXTURE.scope.runId;
const DEPLOYMENT_ID = FIXTURE.scope.authority.deploymentId;
const AUTHORITY_LEASE = IDENTITY_FACTORY.createAuthorityLease({
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  leaseId: "lease:execution-admission-handler",
  holderId: "holder:execution-admission-handler",
});
const AUTHORITY_EPOCH = FIXTURE.scope.authority.authorityEpoch;
const FENCING_TOKEN = FIXTURE.scope.authority.fencingToken;
const HANDLE_REF = "handle:execution-admission-handler";
const INVOCATION_ID = "invocation:execution-admission-handler";
const IDENTITY = Object.freeze({
  agentServiceInstanceId: "agent-service:execution-admission-handler",
  agentServiceBootId: "agent-boot:execution-admission-handler",
  workerInstanceId: "worker:execution-admission-handler",
  workerBootId: "worker-boot:execution-admission-handler",
});

const authority: CapabilityInvocationAuthority = Object.freeze({
  product: {
    deploymentId: DEPLOYMENT_ID,
    authorityEpoch: AUTHORITY_EPOCH,
    fencingToken: FENCING_TOKEN,
  },
  lease: { leaseId: AUTHORITY_LEASE.id, fencingToken: FENCING_TOKEN },
  ...IDENTITY,
});

const peer: ExecutionAdmissionPeerBinding = Object.freeze({
  ...IDENTITY,
  deploymentId: DEPLOYMENT_ID,
  authorityEpoch: AUTHORITY_EPOCH,
  fencingToken: FENCING_TOKEN,
});

const scope: CompleteScope = Object.freeze({
  deploymentId: DEPLOYMENT_ID,
  authorityEpoch: AUTHORITY_EPOCH,
  fencingToken: FENCING_TOKEN,
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  runId: RUN_ID,
  workerRunId: "worker-run:execution-admission-handler",
});

const ceiling: ResourceCeiling = Object.freeze({
  maxWallTimeMs: 30_000,
  maxCpuTimeMs: 10_000,
  maxMemoryBytes: 268_435_456,
  maxOutputBytes: 1_048_576,
  maxProgressEvents: 100,
});

const parentBinding: ProductionExecutionAdmissionParentBinding = Object.freeze({
  parentMessageId: "parent:execution-admission-handler",
  parentCorrelationId: "correlation:execution-admission-handler",
  bindingRevision: 1,
  bindingDigest: "digest:execution-admission-handler:v1",
  scope,
  authority: peer,
  dataClassification: "sensitive",
  resourceCeiling: ceiling,
  deadlineAt: "2026-09-05T00:00:30.000Z",
  capabilityHandleRefs: [HANDLE_REF],
  delegatedContextRefs: [],
});

const receipt: FrozenCapabilityInvocationReceipt = Object.freeze({
  receiptVersion: "capability-invocation.v1",
  receiptRef: "receipt:execution-admission-handler",
  ownerId: OWNER_ID,
  agentId: AGENT_ID,
  runId: RUN_ID,
  handleRef: HANDLE_REF,
  handleRevision: 4,
  invocationId: INVOCATION_ID,
  workerRunId: scope.workerRunId,
  idempotencyKey: "idempotency:execution-admission-handler",
  capabilityRef: "capability:execution-admission-handler",
  capabilityVersion: "1.0.0",
  authorization: { type: "policy" as const, ref: "policy:execution-admission-handler" },
  authorizationRef: "policy:execution-admission-handler",
  operation: "execute",
  inputRef: "payload:execution-admission-handler",
  delegatedContextRefs: [],
  secretRefs: [],
  dataClassification: "private",
  resourceCeiling: ceiling,
  requestedAt: "2026-09-05T00:00:00.000Z",
  deadlineAt: "2026-09-05T00:00:30.000Z",
  effectiveExpiresAt: "2026-09-05T00:00:30.000Z",
  authority,
  semanticFingerprint: "fingerprint:execution-admission-handler",
  consumedAt: "2026-09-05T00:00:01.000Z",
});

function executeRequest(
  overrides: {
    readonly peer?: ExecutionAdmissionPeerBinding;
    readonly scope?: CompleteScope;
    readonly resourceCeiling?: ResourceCeiling;
    readonly causationId?: string;
    readonly correlationId?: string;
  } = {},
): ExecuteRequest {
  const parsed = executionV2MessageSchema.parse({
    schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
    kind: "request",
    type: "work.execute",
    messageId: INVOCATION_ID,
    correlationId: overrides.correlationId ?? parentBinding.parentCorrelationId,
    causationId: overrides.causationId ?? parentBinding.parentMessageId,
    dataClassification: "private",
    risk: "low",
    authorizationRef: null,
    scope: overrides.scope ?? scope,
    idempotencyKey: "idempotency:execution-admission-handler",
    payload: {
      capabilityId: receipt.capabilityRef,
      capabilityVersion: receipt.capabilityVersion,
      operation: receipt.operation,
      inputRef: receipt.inputRef,
      capabilityHandleRef: HANDLE_REF,
      delegatedContextRefs: [],
      secretRefs: [],
      resourceCeiling: overrides.resourceCeiling ?? ceiling,
      requestedAt: receipt.requestedAt,
      deadlineAt: receipt.deadlineAt,
    },
  });
  if (parsed.kind !== "request" || parsed.type !== "work.execute") {
    throw new TypeError("execution admission execute fixture is invalid");
  }
  return parsed;
}

function admissionRequest(
  execute: ExecuteRequest = executeRequest(),
  requestPeer: ExecutionAdmissionPeerBinding = peer,
): ExecutionAdmissionWorkExecuteRequest {
  const parsed = executionAdmissionV1MessageSchema.parse({
    schemaVersion: EXECUTION_ADMISSION_V1_SCHEMA_VERSION,
    kind: "request",
    type: "admission.work.execute",
    messageId: "admission:execution-admission-handler",
    correlationId: "admission-correlation:execution-admission-handler",
    causationId: execute.messageId,
    idempotencyKey: "admission-idempotency:execution-admission-handler",
    payload: { peer: requestPeer, execute },
  });
  if (parsed.kind !== "request" || parsed.type !== "admission.work.execute") {
    throw new TypeError("execution admission request fixture is invalid");
  }
  return parsed;
}

class RecordingInvocationPort implements CapabilityInvocationReceiptPort {
  readonly consumes: ConsumeCapabilityInvocationInput[] = [];
  #replayed = false;
  readonly #afterConsume: () => void;

  constructor(afterConsume: () => void = () => undefined) {
    this.#afterConsume = afterConsume;
  }

  async consume(
    input: ConsumeCapabilityInvocationInput,
  ): Promise<CapabilityInvocationConsumeResult> {
    this.consumes.push(input);
    this.#afterConsume();
    if (this.#replayed) return { replayed: true, receipt };
    this.#replayed = true;
    return { replayed: false, receipt };
  }

  async read(): Promise<FrozenCapabilityInvocationReceipt | undefined> {
    return undefined;
  }
}

interface HandlerState {
  parent: ProductionExecutionAdmissionParentBinding | undefined;
  currentPeer: ExecutionAdmissionPeerBinding;
}

function handlerFixture(
  options: {
    readonly parentSnapshots?: readonly (ProductionExecutionAdmissionParentBinding | undefined)[];
    readonly afterConsume?: () => void;
    readonly admission?: Pick<WorkerDelegationAdmissionService, "admit">;
    readonly failPeerLookupAfterConsume?: boolean;
  } = {},
) {
  const state: HandlerState = { parent: parentBinding, currentPeer: peer };
  const snapshots = [...(options.parentSnapshots ?? [])];
  let peerLookupFailed = false;
  const invocations = new RecordingInvocationPort(() => {
    options.afterConsume?.();
    peerLookupFailed = options.failPeerLookupAfterConsume ?? false;
  });
  const admission =
    options.admission ??
    new WorkerDelegationAdmissionService({
      invocations,
      invocationAuthority: () => authority,
      now: () => "2026-09-05T00:00:01.000Z",
      nextId: (namespace: string) => `${namespace}:execution-admission-handler`,
    });
  const handler = new ProductionExecutionAdmissionHandler({
    admission,
    parentBindings: {
      lookup: async () => (snapshots.length > 0 ? snapshots.shift() : state.parent),
    },
    trustedPeerBinding: () => {
      if (peerLookupFailed) throw new Error("private peer lookup details");
      return state.currentPeer;
    },
  });
  return { handler, invocations, state };
}

describe("ProductionExecutionAdmissionHandler", () => {
  it("rejects a missing parent before durable consume", async () => {
    const fixture = handlerFixture({ parentSnapshots: [undefined] });

    await expect(fixture.handler.admit(admissionRequest())).rejects.toMatchObject({
      code: PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.PARENT_NOT_FOUND,
    });
    expect(fixture.invocations.consumes).toHaveLength(0);
  });

  it.each([
    ["scope", () => ({ scope: { ...scope, runId: "run:wrong" } })],
    ["correlation", () => ({ correlationId: "correlation:wrong" })],
    ["authority", () => ({ peer: { ...peer, fencingToken: FENCING_TOKEN + 1 } })],
    ["boot", () => ({ peer: { ...peer, workerBootId: "worker-boot:wrong" } })],
    [
      "ceiling",
      () => ({
        resourceCeiling: { ...ceiling, maxMemoryBytes: ceiling.maxMemoryBytes + 1 },
      }),
    ],
  ] as const)("rejects a pre-consume %s mismatch", async (_name, overrides) => {
    const fixture = handlerFixture();
    const changed = overrides();
    const execute = executeRequest(changed);
    const requestPeer = "peer" in changed ? changed.peer : peer;

    await expect(
      fixture.handler.admit(admissionRequest(execute, requestPeer)),
    ).rejects.toMatchObject({
      code: PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.PARENT_BINDING_MISMATCH,
    });
    expect(fixture.invocations.consumes).toHaveLength(0);
  });

  it.each([
    ["digest", { ...parentBinding, bindingDigest: "digest:changed" }],
    ["revision", { ...parentBinding, bindingRevision: parentBinding.bindingRevision + 1 }],
  ] as const)("rejects an unstable pre-consume parent %s", async (_name, changed) => {
    const fixture = handlerFixture({ parentSnapshots: [parentBinding, changed] });

    await expect(fixture.handler.admit(admissionRequest())).rejects.toMatchObject({
      code: PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.PARENT_BINDING_CHANGED_BEFORE_ADMISSION,
    });
    expect(fixture.invocations.consumes).toHaveLength(0);
  });

  it("returns a receipt and executable projection only for a fresh consume", async () => {
    const fixture = handlerFixture();

    const result = await fixture.handler.admit(admissionRequest());

    expect(result.disposition).toBe("consumed");
    if (result.disposition !== "consumed") throw new Error("expected consumed admission");
    expect(result.receipt).toMatchObject({
      receiptRef: receipt.receiptRef,
      invocationId: receipt.invocationId,
      handleRef: receipt.handleRef,
    });
    expect(result.projection.execute.messageId).toBe(receipt.invocationId);
    expect(result.projection.delegate.type).toBe("work.delegate");
    expect(fixture.invocations.consumes).toHaveLength(1);
  });

  it("returns replay without an executable projection", async () => {
    const fixture = handlerFixture();

    await fixture.handler.admit(admissionRequest());
    const replay = await fixture.handler.admit(admissionRequest());

    expect(replay).toMatchObject({
      disposition: "replayed",
      receipt: {
        receiptRef: receipt.receiptRef,
        invocationId: receipt.invocationId,
      },
      projection: null,
      reasonCode: null,
    });
    expect(fixture.invocations.consumes).toHaveLength(2);
  });

  it("returns unknown after consume when the parent binding changes without rollback", async () => {
    const fixture = handlerFixture({
      afterConsume: () => {
        fixture.state.parent = { ...parentBinding, bindingRevision: 2, bindingDigest: "digest:v2" };
      },
    });

    const result = await fixture.handler.admit(admissionRequest());

    expect(result).toMatchObject({
      disposition: "unknown",
      receipt: { receiptRef: receipt.receiptRef },
      projection: null,
      reasonCode: PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.PARENT_CHANGED_AFTER_ADMISSION,
    });
    expect(fixture.invocations.consumes).toHaveLength(1);
  });

  it("returns unknown after consume when the authenticated peer changes", async () => {
    const fixture = handlerFixture({
      afterConsume: () => {
        fixture.state.currentPeer = { ...peer, workerBootId: "worker-boot:rotated" };
      },
    });

    const result = await fixture.handler.admit(admissionRequest());

    expect(result).toMatchObject({
      disposition: "unknown",
      receipt: { receiptRef: receipt.receiptRef },
      projection: null,
      reasonCode: PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.PEER_CHANGED_AFTER_ADMISSION,
    });
    expect(fixture.invocations.consumes).toHaveLength(1);
  });

  it("returns unknown after consume when peer revalidation fails", async () => {
    const fixture = handlerFixture({ failPeerLookupAfterConsume: true });

    const result = await fixture.handler.admit(admissionRequest());

    expect(result).toMatchObject({
      disposition: "unknown",
      receipt: { receiptRef: receipt.receiptRef },
      projection: null,
      reasonCode: PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.POST_ADMISSION_REVALIDATION_FAILED,
    });
    expect(fixture.invocations.consumes).toHaveLength(1);
  });

  it("stabilizes private admission errors and never returns success", async () => {
    const admission: Pick<WorkerDelegationAdmissionService, "admit"> = {
      admit: async () => {
        throw new Error("private durable receipt details");
      },
    };
    const fixture = handlerFixture({ admission });

    await expect(fixture.handler.admit(admissionRequest())).rejects.toMatchObject({
      code: PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.ADMISSION_FAILED,
    });
    await expect(fixture.handler.admit(admissionRequest())).rejects.not.toThrow(
      "private durable receipt details",
    );
  });
});
