import type {
  WorkerDelegationAdmissionResult,
  WorkerDelegationAdmissionService,
} from "@himawari-agent/application";
import {
  type ExecutionAdmissionPeerBinding,
  type ExecutionAdmissionWorkExecuteRequest,
  executionAdmissionV1MessageSchema,
  type ResourceCeiling,
} from "@himawari-agent/execution-contracts";
import type {
  ExecutionAdmissionHandlerResult,
  ExecutionAdmissionTrustedHandler,
} from "@himawari-agent/platform-node";

type ExecuteRequest = ExecutionAdmissionWorkExecuteRequest["payload"]["execute"];
type ExecuteScope = ExecuteRequest["scope"];
type DataClassification = ExecuteRequest["dataClassification"];

export interface ProductionExecutionAdmissionParentBinding {
  /** The immutable parent message that authorized this nested execution. */
  readonly parentMessageId: string;
  readonly parentCorrelationId: string;
  /** Monotonic identity of the trusted parent registration. */
  readonly bindingRevision: number;
  /** Digest of the complete trusted parent registration. */
  readonly bindingDigest: string;
  /** Complete owner, Agent, Run and Worker Run scope. */
  readonly scope: {
    readonly deploymentId: string;
    readonly authorityEpoch: number;
    readonly fencingToken: number;
    readonly ownerId: string;
    readonly agentId: string;
    readonly runId: string;
    readonly workerRunId: string;
  };
  /** Binding captured from the authenticated Worker session and Agent authority. */
  readonly authority: ExecutionAdmissionPeerBinding;
  /** Maximum classification and resources allowed for a child admission. */
  readonly dataClassification: DataClassification;
  readonly resourceCeiling: ResourceCeiling;
  readonly deadlineAt: string;
  /** Handle/context references are attenuable; secret authority stays in the Handle. */
  readonly capabilityHandleRefs: readonly string[];
  readonly delegatedContextRefs: readonly string[];
}

/**
 * Read-only lookup supplied by the trusted Agent composition. There is
 * deliberately no registration method on the handler boundary: the sender
 * cannot create or replace the parent it is asking to use.
 */
export interface ProductionExecutionAdmissionParentBindingLookup {
  lookup(parentMessageId: string): Promise<ProductionExecutionAdmissionParentBinding | undefined>;
}

export interface ProductionExecutionAdmissionHandlerOptions {
  /** The sole durable admission owner; this handler never owns DB or KEK state. */
  readonly admission: Pick<WorkerDelegationAdmissionService, "admit">;
  readonly parentBindings: ProductionExecutionAdmissionParentBindingLookup;
  /** Current binding from the authenticated Worker session, not request fields. */
  readonly trustedPeerBinding: () => ExecutionAdmissionPeerBinding;
}

export const PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES = Object.freeze({
  REQUEST_INVALID: "EXECUTION_ADMISSION_REQUEST_INVALID",
  PARENT_NOT_FOUND: "EXECUTION_ADMISSION_PARENT_NOT_FOUND",
  PARENT_LOOKUP_FAILED: "EXECUTION_ADMISSION_PARENT_LOOKUP_FAILED",
  PARENT_BINDING_MISMATCH: "EXECUTION_ADMISSION_PARENT_BINDING_MISMATCH",
  PARENT_BINDING_CHANGED_BEFORE_ADMISSION:
    "EXECUTION_ADMISSION_PARENT_BINDING_CHANGED_BEFORE_ADMISSION",
  PEER_BINDING_LOOKUP_FAILED: "EXECUTION_ADMISSION_PEER_BINDING_LOOKUP_FAILED",
  PEER_BINDING_CHANGED_BEFORE_ADMISSION:
    "EXECUTION_ADMISSION_PEER_BINDING_CHANGED_BEFORE_ADMISSION",
  ADMISSION_FAILED: "EXECUTION_ADMISSION_ADMISSION_FAILED",
  PARENT_CHANGED_AFTER_ADMISSION: "PARENT_BINDING_CHANGED_AFTER_ADMISSION",
  PEER_CHANGED_AFTER_ADMISSION: "PEER_BINDING_CHANGED_AFTER_ADMISSION",
  POST_ADMISSION_REVALIDATION_FAILED: "ADMISSION_REVALIDATION_FAILED",
} as const);

type ProductionExecutionAdmissionErrorCode =
  (typeof PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES)[keyof typeof PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES];

export class ProductionExecutionAdmissionHandlerError extends Error {
  readonly code: ProductionExecutionAdmissionErrorCode;

  constructor(code: ProductionExecutionAdmissionErrorCode) {
    super(code);
    this.name = "ProductionExecutionAdmissionHandlerError";
    this.code = code;
  }
}

const CLASSIFICATION_RANK: Readonly<Record<DataClassification, number>> = Object.freeze({
  public: 0,
  private: 1,
  sensitive: 2,
  restricted: 3,
});

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function containsAll(container: readonly string[], values: readonly string[]): boolean {
  return values.every((value) => container.includes(value));
}

function sameCompleteScope(
  left: ProductionExecutionAdmissionParentBinding["scope"],
  right: ExecuteScope,
): boolean {
  return (
    right.ownerId !== null &&
    right.agentId !== null &&
    right.runId !== null &&
    right.workerRunId !== null &&
    left.deploymentId === right.deploymentId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.fencingToken === right.fencingToken &&
    left.ownerId === right.ownerId &&
    left.agentId === right.agentId &&
    left.runId === right.runId &&
    left.workerRunId === right.workerRunId
  );
}

function samePeer(
  left: ExecutionAdmissionPeerBinding,
  right: ExecutionAdmissionPeerBinding,
): boolean {
  return (
    left.agentServiceInstanceId === right.agentServiceInstanceId &&
    left.agentServiceBootId === right.agentServiceBootId &&
    left.workerInstanceId === right.workerInstanceId &&
    left.workerBootId === right.workerBootId &&
    left.deploymentId === right.deploymentId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.fencingToken === right.fencingToken
  );
}

function sameCeiling(left: ResourceCeiling, right: ResourceCeiling): boolean {
  return (
    left.maxWallTimeMs === right.maxWallTimeMs &&
    left.maxCpuTimeMs === right.maxCpuTimeMs &&
    left.maxMemoryBytes === right.maxMemoryBytes &&
    left.maxOutputBytes === right.maxOutputBytes &&
    left.maxProgressEvents === right.maxProgressEvents
  );
}

function ceilingWithin(child: ResourceCeiling, parent: ResourceCeiling): boolean {
  return (
    child.maxWallTimeMs <= parent.maxWallTimeMs &&
    child.maxCpuTimeMs <= parent.maxCpuTimeMs &&
    child.maxMemoryBytes <= parent.maxMemoryBytes &&
    child.maxOutputBytes <= parent.maxOutputBytes &&
    child.maxProgressEvents <= parent.maxProgressEvents
  );
}

function copyPeer(peer: ExecutionAdmissionPeerBinding): ExecutionAdmissionPeerBinding {
  return { ...peer };
}

function copyParentBinding(
  binding: ProductionExecutionAdmissionParentBinding,
): ProductionExecutionAdmissionParentBinding {
  return {
    ...binding,
    scope: { ...binding.scope },
    authority: copyPeer(binding.authority),
    resourceCeiling: { ...binding.resourceCeiling },
    capabilityHandleRefs: [...binding.capabilityHandleRefs],
    delegatedContextRefs: [...binding.delegatedContextRefs],
  };
}

function sameParentBinding(
  left: ProductionExecutionAdmissionParentBinding,
  right: ProductionExecutionAdmissionParentBinding,
): boolean {
  return (
    left.parentMessageId === right.parentMessageId &&
    left.parentCorrelationId === right.parentCorrelationId &&
    left.bindingRevision === right.bindingRevision &&
    left.bindingDigest === right.bindingDigest &&
    sameCompleteScope(left.scope, right.scope) &&
    samePeer(left.authority, right.authority) &&
    left.dataClassification === right.dataClassification &&
    sameCeiling(left.resourceCeiling, right.resourceCeiling) &&
    left.deadlineAt === right.deadlineAt &&
    sameStrings(left.capabilityHandleRefs, right.capabilityHandleRefs) &&
    sameStrings(left.delegatedContextRefs, right.delegatedContextRefs)
  );
}

function validPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function validPeerBinding(peer: ExecutionAdmissionPeerBinding): boolean {
  const values = [
    peer.agentServiceInstanceId,
    peer.agentServiceBootId,
    peer.workerInstanceId,
    peer.workerBootId,
    peer.deploymentId,
  ];
  return (
    values.every((value) => typeof value === "string" && value.length > 0) &&
    validPositiveInteger(peer.authorityEpoch) &&
    validPositiveInteger(peer.fencingToken)
  );
}

function validParentBinding(binding: ProductionExecutionAdmissionParentBinding): boolean {
  const scope = binding.scope;
  const authority = binding.authority;
  const values = [
    binding.parentMessageId,
    binding.parentCorrelationId,
    binding.bindingDigest,
    scope.deploymentId,
    scope.ownerId,
    scope.agentId,
    scope.runId,
    scope.workerRunId,
    authority.agentServiceInstanceId,
    authority.agentServiceBootId,
    authority.workerInstanceId,
    authority.workerBootId,
    authority.deploymentId,
    binding.deadlineAt,
  ];
  return (
    values.every((value) => typeof value === "string" && value.length > 0) &&
    validPositiveInteger(binding.bindingRevision) &&
    validPositiveInteger(scope.authorityEpoch) &&
    validPositiveInteger(scope.fencingToken) &&
    validPositiveInteger(authority.authorityEpoch) &&
    validPositiveInteger(authority.fencingToken) &&
    scope.deploymentId === authority.deploymentId &&
    scope.authorityEpoch === authority.authorityEpoch &&
    scope.fencingToken === authority.fencingToken &&
    Object.values(binding.resourceCeiling).every(validPositiveInteger) &&
    Object.keys(CLASSIFICATION_RANK).includes(binding.dataClassification) &&
    Number.isFinite(Date.parse(binding.deadlineAt)) &&
    binding.capabilityHandleRefs.every((value) => typeof value === "string" && value.length > 0) &&
    binding.delegatedContextRefs.every((value) => typeof value === "string" && value.length > 0)
  );
}

function receiptIdentity(result: WorkerDelegationAdmissionResult): {
  readonly receiptRef: string;
  readonly handleRef: string;
  readonly invocationId: string;
  readonly idempotencyKey: string;
  readonly ownerId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly workerRunId: string;
} {
  const receipt = result.receipt;
  return {
    receiptRef: receipt.receiptRef,
    handleRef: receipt.handleRef,
    invocationId: receipt.invocationId,
    idempotencyKey: receipt.idempotencyKey,
    ownerId: receipt.ownerId,
    agentId: receipt.agentId,
    runId: receipt.runId,
    workerRunId: receipt.workerRunId,
  };
}

function receiptMatchesRequest(
  result: WorkerDelegationAdmissionResult,
  request: ExecuteRequest,
): boolean {
  const receipt = result.receipt;
  return (
    receipt.handleRef === request.payload.capabilityHandleRef &&
    receipt.invocationId === request.messageId &&
    receipt.idempotencyKey === request.idempotencyKey &&
    receipt.ownerId === request.scope.ownerId &&
    receipt.agentId === request.scope.agentId &&
    receipt.runId === request.scope.runId &&
    receipt.workerRunId === request.scope.workerRunId &&
    receipt.capabilityRef === request.payload.capabilityId &&
    receipt.capabilityVersion === request.payload.capabilityVersion &&
    receipt.operation === request.payload.operation &&
    receipt.inputRef === request.payload.inputRef &&
    sameStrings(receipt.delegatedContextRefs, request.payload.delegatedContextRefs) &&
    receipt.dataClassification === request.dataClassification &&
    sameCeiling(receipt.resourceCeiling, request.payload.resourceCeiling) &&
    receipt.requestedAt === request.payload.requestedAt &&
    receipt.deadlineAt === request.payload.deadlineAt
  );
}

function unknownResult(
  result: WorkerDelegationAdmissionResult,
  reasonCode: string,
): ExecutionAdmissionHandlerResult {
  return {
    disposition: "unknown",
    receipt: receiptIdentity(result),
    projection: null,
    reasonCode,
  };
}

export class ProductionExecutionAdmissionHandler implements ExecutionAdmissionTrustedHandler {
  readonly #options: ProductionExecutionAdmissionHandlerOptions;

  constructor(options: ProductionExecutionAdmissionHandlerOptions) {
    this.#options = options;
  }

  async admit(
    request: ExecutionAdmissionWorkExecuteRequest,
  ): Promise<ExecutionAdmissionHandlerResult> {
    let parsed: ExecutionAdmissionWorkExecuteRequest;
    try {
      const candidate = executionAdmissionV1MessageSchema.parse(request);
      if (candidate.kind !== "request" || candidate.type !== "admission.work.execute") {
        throw new TypeError("execution admission request type is invalid");
      }
      parsed = candidate;
    } catch {
      throw new ProductionExecutionAdmissionHandlerError(
        PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.REQUEST_INVALID,
      );
    }

    try {
      return await this.#admitParsed(parsed);
    } catch (error) {
      if (error instanceof ProductionExecutionAdmissionHandlerError) throw error;
      throw new ProductionExecutionAdmissionHandlerError(
        PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.ADMISSION_FAILED,
      );
    }
  }

  async #admitParsed(
    request: ExecutionAdmissionWorkExecuteRequest,
  ): Promise<ExecutionAdmissionHandlerResult> {
    const execute = request.payload.execute;
    if (execute.causationId === null || request.causationId !== execute.messageId) {
      throw new ProductionExecutionAdmissionHandlerError(
        PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.REQUEST_INVALID,
      );
    }
    const parentMessageId = execute.causationId;
    const first = await this.#lookupBefore(parentMessageId);
    if (!first) {
      throw new ProductionExecutionAdmissionHandlerError(
        PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.PARENT_NOT_FOUND,
      );
    }
    const firstPeer = this.#peerBefore();
    this.#assertRequestFitsParent(request, first, firstPeer);

    const second = await this.#lookupBefore(parentMessageId);
    if (!second || !sameParentBinding(first, second)) {
      throw new ProductionExecutionAdmissionHandlerError(
        PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.PARENT_BINDING_CHANGED_BEFORE_ADMISSION,
      );
    }
    const admissionPeer = this.#peerBefore();
    if (!samePeer(firstPeer, admissionPeer)) {
      throw new ProductionExecutionAdmissionHandlerError(
        PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.PEER_BINDING_CHANGED_BEFORE_ADMISSION,
      );
    }
    const stableParent = copyParentBinding(first);
    this.#assertRequestFitsParent(request, stableParent, admissionPeer);

    const admitted = await this.#runAdmission(execute);
    if (!receiptMatchesRequest(admitted, execute)) {
      throw new ProductionExecutionAdmissionHandlerError(
        PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.ADMISSION_FAILED,
      );
    }

    const post = await this.#lookupAfter(parentMessageId);
    if (!post)
      return unknownResult(
        admitted,
        PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.PARENT_CHANGED_AFTER_ADMISSION,
      );
    const postPeer = await this.#peerAfter();
    if (!postPeer) {
      return unknownResult(
        admitted,
        PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.POST_ADMISSION_REVALIDATION_FAILED,
      );
    }
    if (!sameParentBinding(stableParent, post)) {
      return unknownResult(
        admitted,
        PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.PARENT_CHANGED_AFTER_ADMISSION,
      );
    }
    if (!samePeer(admissionPeer, postPeer)) {
      return unknownResult(
        admitted,
        PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.PEER_CHANGED_AFTER_ADMISSION,
      );
    }
    try {
      this.#assertRequestFitsParent(request, post, postPeer);
    } catch {
      return unknownResult(
        admitted,
        PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.PARENT_CHANGED_AFTER_ADMISSION,
      );
    }

    if (admitted.disposition === "replayed") {
      return {
        disposition: "replayed",
        receipt: receiptIdentity(admitted),
        projection: null,
        reasonCode: null,
      };
    }
    return {
      disposition: "consumed",
      receipt: receiptIdentity(admitted),
      projection: admitted.projection,
      reasonCode: null,
    };
  }

  async #lookupBefore(
    parentMessageId: string,
  ): Promise<ProductionExecutionAdmissionParentBinding | undefined> {
    try {
      const binding = await this.#options.parentBindings.lookup(parentMessageId);
      if (binding && !validParentBinding(binding)) {
        throw new ProductionExecutionAdmissionHandlerError(
          PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.PARENT_BINDING_MISMATCH,
        );
      }
      return binding ? copyParentBinding(binding) : undefined;
    } catch (error) {
      if (error instanceof ProductionExecutionAdmissionHandlerError) throw error;
      throw new ProductionExecutionAdmissionHandlerError(
        PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.PARENT_LOOKUP_FAILED,
      );
    }
  }

  async #lookupAfter(
    parentMessageId: string,
  ): Promise<ProductionExecutionAdmissionParentBinding | undefined> {
    try {
      const binding = await this.#options.parentBindings.lookup(parentMessageId);
      if (binding && !validParentBinding(binding)) return undefined;
      return binding ? copyParentBinding(binding) : undefined;
    } catch {
      return undefined;
    }
  }

  #peerBefore(): ExecutionAdmissionPeerBinding {
    try {
      const peer = this.#options.trustedPeerBinding();
      if (!validPeerBinding(peer)) throw new TypeError("peer binding is invalid");
      return copyPeer(peer);
    } catch (error) {
      if (error instanceof ProductionExecutionAdmissionHandlerError) throw error;
      throw new ProductionExecutionAdmissionHandlerError(
        PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.PEER_BINDING_LOOKUP_FAILED,
      );
    }
  }

  async #peerAfter(): Promise<ExecutionAdmissionPeerBinding | undefined> {
    try {
      const peer = this.#options.trustedPeerBinding();
      if (!validPeerBinding(peer)) return undefined;
      return copyPeer(peer);
    } catch {
      return undefined;
    }
  }

  async #runAdmission(execute: ExecuteRequest): Promise<WorkerDelegationAdmissionResult> {
    try {
      return await this.#options.admission.admit(execute);
    } catch {
      throw new ProductionExecutionAdmissionHandlerError(
        PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.ADMISSION_FAILED,
      );
    }
  }

  #assertRequestFitsParent(
    request: ExecutionAdmissionWorkExecuteRequest,
    parent: ProductionExecutionAdmissionParentBinding,
    trustedPeer: ExecutionAdmissionPeerBinding,
  ): void {
    const execute = request.payload.execute;
    if (
      !samePeer(request.payload.peer, trustedPeer) ||
      !samePeer(parent.authority, trustedPeer) ||
      !sameCompleteScope(parent.scope, execute.scope) ||
      execute.causationId !== parent.parentMessageId ||
      execute.correlationId !== parent.parentCorrelationId ||
      request.causationId !== execute.messageId ||
      execute.dataClassification === undefined ||
      CLASSIFICATION_RANK[execute.dataClassification] >
        CLASSIFICATION_RANK[parent.dataClassification] ||
      !ceilingWithin(execute.payload.resourceCeiling, parent.resourceCeiling) ||
      !parent.capabilityHandleRefs.includes(execute.payload.capabilityHandleRef) ||
      !containsAll(parent.delegatedContextRefs, execute.payload.delegatedContextRefs) ||
      !Number.isFinite(Date.parse(execute.payload.deadlineAt)) ||
      Date.parse(execute.payload.deadlineAt) > Date.parse(parent.deadlineAt)
    ) {
      throw new ProductionExecutionAdmissionHandlerError(
        PRODUCTION_EXECUTION_ADMISSION_ERROR_CODES.PARENT_BINDING_MISMATCH,
      );
    }
  }
}
