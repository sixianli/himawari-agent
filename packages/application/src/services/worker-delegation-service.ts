import {
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionV2Request,
  executionV2MessageSchema,
  type SandboxJobIdentity,
  sandboxExecutionPlanCandidateSchema,
  sandboxJobReceiptSchema,
} from "@himawari-agent/execution-contracts";
import type {
  CapabilityInvocationAuthority,
  CapabilityInvocationReceiptPort,
  ConsumeCapabilityInvocationInput,
  FrozenCapabilityInvocationReceipt,
} from "../ports/capability-invocations.js";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type { ExecutionTransportPort } from "../ports/coordination.js";
import type { SandboxJobJournalPort } from "../ports/sandbox-execution.js";
import type { SandboxScopeService } from "./sandbox-scope-service.js";

export type WorkerExecuteRequest = Extract<ExecutionV2Request, { type: "work.execute" }>;
export type WorkerDelegateRequest = Extract<ExecutionV2Request, { type: "work.delegate" }>;
type CompleteExecutionScope = {
  readonly deploymentId: string;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
  readonly ownerId: string;
  readonly agentId: string;
  readonly runId: string;
  readonly workerRunId: string;
};

function completeScope(scope: WorkerExecuteRequest["scope"]): CompleteExecutionScope {
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
  left: CompleteExecutionScope | WorkerExecuteRequest["scope"],
  right: CompleteExecutionScope | WorkerExecuteRequest["scope"],
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

export interface WorkerDelegationAdmissionServiceOptions {
  /** Agent-scoped atomic consume port backed by the durable authority owner. */
  readonly invocations: CapabilityInvocationReceiptPort;
  /** Trusted composition selects this mode only for SRT executions. Preparation
   * resolves authorized scope/qualification; failure never falls back to consume.
   * It must return a stable persisted job identity when handling a replay. */
  readonly sandbox?: {
    readonly journal: Pick<SandboxJobJournalPort, "admit">;
    readonly scopes: Pick<SandboxScopeService, "read">;
    readonly prepare: (
      invocation: ConsumeCapabilityInvocationInput,
    ) => Promise<Omit<Parameters<SandboxJobJournalPort["admit"]>[0], "invocation">>;
  };
  /** Trusted current Agent/Worker attempt and product lease identity. */
  readonly invocationAuthority: () => CapabilityInvocationAuthority;
  readonly now: () => string;
  readonly nextId: (scope: string) => string;
}

export interface WorkerDelegationProjection {
  readonly delegate: WorkerDelegateRequest;
  readonly execute: WorkerExecuteRequest;
}

export type WorkerDelegationAdmissionResult =
  | {
      /** A new durable receipt was consumed and has not been sent to the Worker yet. */
      readonly disposition: "consumed";
      readonly receipt: FrozenCapabilityInvocationReceipt;
      readonly projection: WorkerDelegationProjection;
    }
  | {
      /** The durable receipt already existed; this does not prove delivery or execution. */
      readonly disposition: "replayed";
      readonly receipt: FrozenCapabilityInvocationReceipt;
    };

/**
 * Performs durable capability-invocation admission without sending a Worker
 * message. A replay only returns the existing receipt, so callers cannot
 * accidentally turn uncertain delivery into a second executable projection.
 */
export class WorkerDelegationAdmissionService {
  readonly #options: WorkerDelegationAdmissionServiceOptions;

  constructor(options: WorkerDelegationAdmissionServiceOptions) {
    this.#options = options;
  }

  async admit(request: WorkerExecuteRequest): Promise<WorkerDelegationAdmissionResult> {
    const parsed = executionV2MessageSchema.parse(request);
    if (parsed.kind !== "request" || parsed.type !== "work.execute") {
      throw new TypeError("Worker delegation accepts work.execute requests only");
    }
    if (parsed.payload.sandboxJob)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Sandbox job identity is assigned by trusted admission",
      );
    const scope = completeScope(parsed.scope);
    const authority = this.#options.invocationAuthority();
    const consumed = await this.#consume(parsed, scope, authority, this.#options.now());
    if (consumed.replayed) {
      return {
        disposition: "replayed",
        receipt: consumed.receipt,
      };
    }
    return {
      disposition: "consumed",
      receipt: consumed.receipt,
      projection: this.#project(parsed, consumed.receipt, consumed.sandboxJob),
    };
  }

  #project(
    request: WorkerExecuteRequest,
    receipt: FrozenCapabilityInvocationReceipt,
    sandboxJob?: SandboxJobIdentity,
  ): WorkerDelegationProjection {
    const delegate = executionV2MessageSchema.parse({
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "request",
      type: "work.delegate",
      messageId: this.#options.nextId("worker-delegation"),
      correlationId: request.correlationId,
      causationId: request.messageId,
      dataClassification: receipt.dataClassification,
      risk: request.risk,
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
    const execute = executionV2MessageSchema.parse({
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "request",
      type: "work.execute",
      messageId: receipt.invocationId,
      correlationId: request.correlationId,
      causationId: request.causationId,
      dataClassification: receipt.dataClassification,
      risk: request.risk,
      authorizationRef: receipt.authorizationRef,
      scope: receiptScope(receipt),
      idempotencyKey: receipt.idempotencyKey,
      payload: {
        ...(sandboxJob ? { sandboxJob } : {}),
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
    return { delegate, execute };
  }

  async #consume(
    request: WorkerExecuteRequest,
    scope: CompleteExecutionScope,
    authority: CapabilityInvocationAuthority,
    consumedAt: string,
  ) {
    const input: ConsumeCapabilityInvocationInput = {
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
    };
    const sandbox = this.#options.sandbox;
    if (!sandbox) {
      return { ...(await this.#options.invocations.consume(input)), sandboxJob: undefined };
    }
    // Keep the request used for admission separate from the async resolver's copy.
    const prepared = await sandbox.prepare(structuredClone(input));
    const plan = sandboxExecutionPlanCandidateSchema.parse(prepared.plan);
    const observation = sandboxJobReceiptSchema.parse(prepared.observation);
    await sandbox.scopes.read(plan, request.causationId);
    const admitted = await sandbox.journal.admit({
      plan,
      observation,
      invocation: { ...input, consumedAt: this.#options.now() },
    });
    return {
      replayed: !admitted.applied,
      receipt: admitted.receipt,
      sandboxJob: admitted.record.plan.identity,
    };
  }
}

export interface WorkerDelegationServiceOptions extends WorkerDelegationAdmissionServiceOptions {
  readonly transport: ExecutionTransportPort;
}

/**
 * Consumes durable Agent Service authority before projecting an attenuated,
 * one-use Handle into the isolated Worker process.
 */
export class WorkerDelegationService {
  readonly #options: WorkerDelegationServiceOptions;
  readonly #admission: WorkerDelegationAdmissionService;

  constructor(options: WorkerDelegationServiceOptions) {
    this.#options = options;
    this.#admission = new WorkerDelegationAdmissionService(options);
  }

  async dispatch(request: WorkerExecuteRequest): Promise<void> {
    const admission = await this.#admission.admit(request);
    if (admission.disposition === "replayed") return;

    const { receipt, projection } = admission;
    const accepted = await this.#options.transport.request(projection.delegate);
    if (
      accepted?.kind !== "response" ||
      accepted?.type !== "work.delegate.accepted" ||
      accepted.payload.handleRef !== receipt.handleRef ||
      accepted.payload.workerBootId !== receipt.authority.workerBootId ||
      accepted.correlationId !== projection.delegate.correlationId ||
      accepted.causationId !== projection.delegate.messageId ||
      !scopeMatches(accepted.scope, receiptScope(receipt))
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.PROVIDER_FAILURE,
        "Worker did not accept the attenuated Capability Handle",
      );
    }
    const response = await this.#options.transport.request(projection.execute);
    if (response !== null) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.PROVIDER_FAILURE,
        "Worker returned an unexpected synchronous work response",
      );
    }
  }
}
