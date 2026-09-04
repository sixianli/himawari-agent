import {
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionV2Request,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import type {
  CapabilityInvocationAuthority,
  CapabilityInvocationReceiptPort,
  FrozenCapabilityInvocationReceipt,
} from "../ports/capability-invocations.js";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type { ExecutionTransportPort } from "../ports/coordination.js";

type ExecuteRequest = Extract<ExecutionV2Request, { type: "work.execute" }>;
type CompleteExecutionScope = {
  readonly deploymentId: string;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
  readonly ownerId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly workerRunId: string;
};

function completeScope(scope: ExecuteRequest["scope"]): CompleteExecutionScope {
  if (
    scope.ownerId === null ||
    scope.agentId === null ||
    scope.runId === null ||
    scope.workerRunId === null
  ) {
    throw new ApplicationPortError(
      PORT_ERROR_CODES.NOT_AUTHORITATIVE,
      "work.execute must carry a complete owner, Agent, Run, and Worker scope",
    );
  }
  return {
    deploymentId: scope.deploymentId,
    authorityEpoch: scope.authorityEpoch,
    fencingToken: scope.fencingToken,
    ownerId: scope.ownerId,
    agentId: scope.agentId,
    runId: scope.runId,
    workerRunId: scope.workerRunId,
  };
}

function receiptScope(receipt: FrozenCapabilityInvocationReceipt): CompleteExecutionScope {
  return {
    deploymentId: receipt.authority.product.deploymentId,
    authorityEpoch: receipt.authority.product.authorityEpoch,
    fencingToken: receipt.authority.product.fencingToken,
    ownerId: receipt.ownerId,
    agentId: receipt.agentId,
    runId: receipt.runId,
    workerRunId: receipt.workerRunId,
  };
}

function scopeMatches(
  left: CompleteExecutionScope | ExecuteRequest["scope"],
  right: CompleteExecutionScope | ExecuteRequest["scope"],
): boolean {
  return (
    left.deploymentId === right.deploymentId &&
    left.authorityEpoch === right.authorityEpoch &&
    left.fencingToken === right.fencingToken &&
    left.ownerId === right.ownerId &&
    left.agentId === right.agentId &&
    left.runId === right.runId &&
    left.workerRunId === right.workerRunId
  );
}

export interface WorkerDelegationServiceOptions {
  /** Agent-scoped atomic consume port backed by the durable authority owner. */
  readonly invocations: CapabilityInvocationReceiptPort;
  /** Trusted current Agent/Worker attempt and product lease identity. */
  readonly invocationAuthority: () => CapabilityInvocationAuthority;
  readonly transport: ExecutionTransportPort;
  readonly now: () => string;
  readonly nextId: (scope: string) => string;
}

/**
 * Consumes durable Agent Service authority before projecting an attenuated,
 * one-use Handle into the isolated Worker process.
 */
export class WorkerDelegationService {
  readonly #options: WorkerDelegationServiceOptions;

  constructor(options: WorkerDelegationServiceOptions) {
    this.#options = options;
  }

  async dispatch(request: ExecuteRequest): Promise<void> {
    const parsed = executionV2MessageSchema.parse(request);
    if (parsed.kind !== "request" || parsed.type !== "work.execute") {
      throw new TypeError("Worker delegation accepts work.execute requests only");
    }
    const scope = completeScope(parsed.scope);
    const authority = this.#options.invocationAuthority();
    const consumed = await this.#consume(parsed, scope, authority, this.#options.now());
    if (consumed.replayed) return;

    const receipt = consumed.receipt;
    const delegate = executionV2MessageSchema.parse({
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "request",
      type: "work.delegate",
      messageId: this.#options.nextId("worker-delegation"),
      correlationId: parsed.correlationId,
      causationId: parsed.messageId,
      dataClassification: receipt.dataClassification,
      risk: parsed.risk,
      authorizationRef: receipt.authorizationRef,
      scope: receiptScope(receipt),
      idempotencyKey: `${receipt.idempotencyKey}:delegate`,
      payload: {
        handle: {
          handleVersion: "capability-handle.v2",
          ref: receipt.handleRef,
          revision: receipt.handleRevision,
          authorityFence: receipt.authority.product.fencingToken,
          ownerId: receipt.ownerId,
          agentId: receipt.agentId,
          runId: receipt.runId,
          capabilityRef: receipt.capabilityRef,
          capabilityVersion: receipt.capabilityVersion,
          authorizationType: receipt.authorization.type,
          authorizationRef: receipt.authorizationRef,
          operations: [receipt.operation],
          inputRefs: [receipt.inputRef],
          delegatedContextRefs: receipt.delegatedContextRefs,
          secretRefs: receipt.secretRefs,
          maxDataClassification: receipt.dataClassification,
          issuedAt: receipt.consumedAt,
          expiresAt: receipt.effectiveExpiresAt,
          revokedAt: null,
          operation: receipt.operation,
          maxUses: 1,
          uses: 0,
          maxTotalCostMicros: 0,
          spentCostMicros: 0,
          idempotencyKeys: [],
          workerEndedAt: null,
        },
        requestedAt: receipt.requestedAt,
      },
    });
    if (delegate.kind !== "request" || delegate.type !== "work.delegate") {
      throw new TypeError("Worker delegation message is invalid");
    }
    const accepted = await this.#options.transport.request(delegate);
    if (
      accepted?.kind !== "response" ||
      accepted?.type !== "work.delegate.accepted" ||
      accepted.payload.handleRef !== receipt.handleRef ||
      accepted.payload.workerBootId !== receipt.authority.workerBootId ||
      accepted.correlationId !== delegate.correlationId ||
      accepted.causationId !== delegate.messageId ||
      !scopeMatches(accepted.scope, receiptScope(receipt))
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.PROVIDER_FAILURE,
        "Worker did not accept the attenuated Capability Handle",
      );
    }
    const execute = executionV2MessageSchema.parse({
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "request",
      type: "work.execute",
      messageId: receipt.invocationId,
      correlationId: parsed.correlationId,
      causationId: parsed.causationId,
      dataClassification: receipt.dataClassification,
      risk: parsed.risk,
      authorizationRef: receipt.authorizationRef,
      scope: receiptScope(receipt),
      idempotencyKey: receipt.idempotencyKey,
      payload: {
        capabilityId: receipt.capabilityRef,
        capabilityVersion: receipt.capabilityVersion,
        operation: receipt.operation,
        inputRef: receipt.inputRef,
        capabilityHandleRef: receipt.handleRef,
        delegatedContextRefs: receipt.delegatedContextRefs,
        secretRefs: receipt.secretRefs,
        resourceCeiling: receipt.resourceCeiling,
        requestedAt: receipt.requestedAt,
        deadlineAt: receipt.deadlineAt,
      },
    });
    if (execute.kind !== "request" || execute.type !== "work.execute") {
      throw new TypeError("Worker execution message is invalid");
    }
    const response = await this.#options.transport.request(execute);
    if (response !== null) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.PROVIDER_FAILURE,
        "Worker returned an unexpected synchronous work response",
      );
    }
  }

  async #consume(
    request: ExecuteRequest,
    scope: CompleteExecutionScope,
    authority: CapabilityInvocationAuthority,
    consumedAt: string,
  ) {
    return this.#options.invocations.consume({
      receiptRef: this.#options.nextId("capability-invocation-receipt"),
      handleRef: request.payload.capabilityHandleRef,
      invocationId: request.messageId,
      requestScope: scope,
      capabilityRef: request.payload.capabilityId,
      capabilityVersion: request.payload.capabilityVersion,
      authorizationRef: request.authorizationRef,
      idempotencyKey: request.idempotencyKey,
      operation: request.payload.operation,
      inputRef: request.payload.inputRef,
      delegatedContextRefs: request.payload.delegatedContextRefs,
      secretRefs: request.payload.secretRefs,
      dataClassification: request.dataClassification,
      resourceCeiling: request.payload.resourceCeiling,
      requestedAt: request.payload.requestedAt,
      deadlineAt: request.payload.deadlineAt,
      authority,
      consumedAt,
    });
  }
}
