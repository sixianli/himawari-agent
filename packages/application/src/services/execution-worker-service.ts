import {
  EXECUTION_SCHEMA_VERSION,
  type CancelWorkRequest,
  type ExecuteWorkRequest,
  type ReconcileWorkRequest,
  type WorkCancelledEvent,
  type WorkProgressEvent,
  type WorkReconciledEvent,
  type WorkResultEvent,
} from "@himawari-agent/execution-contracts";
import { createAgentId, createOwnerId, createRunId } from "@himawari-agent/domain";
import type {
  CapabilityExecutionHandle,
  CapabilityExecutionHandleStorePort,
  CapabilityPort,
  CapabilityRegistryStorePort,
  CapabilitySecretReference,
  CapabilityResourceCeiling,
  ExternalActionReconciliationPort,
  SecretPort,
  GovernedCapabilityExecutionHandle,
} from "../ports/capabilities.js";
import { capabilityLifecycleHasActiveAuthority } from "../ports/capabilities.js";
import type { AuthorizationStorePort } from "../ports/authorization.js";
import { PORT_ERROR_CODES, ApplicationPortError } from "../ports/common.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";

const CLASSIFICATION_RANK = Object.freeze({ public: 0, private: 1, sensitive: 2, restricted: 3 });

export type ExecutionWorkerEvent =
  | WorkProgressEvent
  | WorkResultEvent
  | WorkCancelledEvent
  | WorkReconciledEvent;

export interface ExecutionWorkerServiceDependencies {
  readonly handles: CapabilityRegistryStorePort & CapabilityExecutionHandleStorePort;
  readonly capability: CapabilityPort;
  readonly secrets: SecretPort;
  readonly reconciliation?: ExternalActionReconciliationPort;
  readonly clock: ClockPort;
  readonly ids: IdGeneratorPort;
  readonly authorityFence?: () => number;
  readonly authorization?: AuthorizationStorePort;
}

function sameSecret(left: CapabilitySecretReference, right: CapabilitySecretReference): boolean {
  return (
    left.secretRef === right.secretRef &&
    left.secretVersion === right.secretVersion &&
    left.purpose === right.purpose
  );
}

export class ExecutionWorkerService {
  private readonly dependencies: ExecutionWorkerServiceDependencies;
  private readonly cancellations = new Map<string, string>();

  constructor(dependencies: ExecutionWorkerServiceDependencies) {
    this.dependencies = dependencies;
  }

  async *execute(
    request: ExecuteWorkRequest,
    resourceCeiling: CapabilityResourceCeiling | null = null,
    assertCurrentAuthority?: () => void,
  ): AsyncIterable<ExecutionWorkerEvent> {
    const cancellation = this.cancellations.get(request.messageId);
    if (cancellation) {
      yield this.cancelledEvent(request, request.messageId, cancellation);
      return;
    }
    if (this.dependencies.clock.now() >= request.payload.deadlineAt) {
      yield this.resultEvent(request, "failed", null, "EXECUTION_TIMEOUT", null);
      return;
    }

    assertCurrentAuthority?.();
    const handle = await this.requireHandle(request.payload.capabilityHandleRef);
    this.assertDelegation(request, handle);
    assertCurrentAuthority?.();
    await this.consumeGovernedHandle(request, handle);
    const issuedSecretHandles: string[] = [];
    try {
      for (const secret of request.payload.secretRefs) {
        assertCurrentAuthority?.();
        const issued = await this.dependencies.secrets.issueHandle({
          ownerId: createOwnerId(request.scope.ownerId),
          agentId: createAgentId(request.scope.agentId),
          runId: createRunId(request.scope.runId),
          secretRef: secret.secretRef,
          secretVersion: secret.secretVersion,
          purpose: secret.purpose,
          scopeRef: request.messageId,
          expiresAt: request.payload.deadlineAt,
        });
        issuedSecretHandles.push(issued.ref);
      }

      let terminal = false;
      assertCurrentAuthority?.();
      for await (const event of this.dependencies.capability.invoke({
        invocationId: request.messageId,
        ownerId: createOwnerId(request.scope.ownerId),
        agentId: createAgentId(request.scope.agentId),
        runId: createRunId(request.scope.runId),
        capabilityRef: request.payload.capabilityId,
        capabilityHandleRef: handle.ref,
        operation: request.payload.operation,
        inputRef: request.payload.inputRef,
        delegatedContextRefs: request.payload.delegatedContextRefs,
        secretHandleRefs: issuedSecretHandles,
        dataClassification: request.dataClassification,
        resourceCeiling,
      })) {
        if (event.occurredAt >= request.payload.deadlineAt) {
          await this.dependencies.capability.cancel(request.messageId, "deadline_exceeded");
          yield this.resultEvent(request, "failed", null, "EXECUTION_TIMEOUT", null);
          terminal = true;
          break;
        }
        if (event.type === "capability.progress") {
          yield {
            ...this.eventEnvelope(request, "work.progress"),
            payload: {
              requestId: request.messageId,
              sequence: event.sequence,
              occurredAt: event.occurredAt,
              stage: event.stage,
              progressPermille: event.progressPermille,
              payloadRef: event.payloadRef,
            },
          };
        } else if (event.type === "capability.completed") {
          yield this.resultEvent(request, "succeeded", event.resultRef, null, null);
          terminal = true;
        } else if (event.type === "capability.failed") {
          yield this.resultEvent(request, "failed", null, event.errorCode, null);
          terminal = true;
        } else if (event.type === "capability.result_unknown") {
          yield this.resultEvent(request, "result_unknown", null, null, event.externalActionId);
          terminal = true;
        } else {
          yield this.cancelledEvent(request, request.messageId, event.reasonCode);
          terminal = true;
        }
        if (terminal) break;
      }
      if (!terminal) {
        yield this.resultEvent(request, "failed", null, "CAPABILITY_STREAM_INCOMPLETE", null);
      }
    } finally {
      for (const handleRef of issuedSecretHandles) {
        await this.dependencies.secrets.revokeHandle(handleRef, this.dependencies.clock.now());
      }
    }
  }

  async assertSubtaskDelegation(input: {
    readonly scope: ExecuteWorkRequest["scope"];
    readonly dataClassification: ExecuteWorkRequest["dataClassification"];
    readonly capabilityHandleRefs: readonly string[];
    readonly deadlineAt: string;
    readonly authorityFence: number;
  }): Promise<void> {
    if (this.dependencies.clock.now() >= input.deadlineAt)
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Worker subtask deadline expired",
      );
    if (
      !this.dependencies.authorityFence ||
      this.dependencies.authorityFence() !== input.authorityFence
    )
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Worker subtask authority changed",
      );
    for (const ref of input.capabilityHandleRefs) {
      const handle = await this.requireHandle(ref);
      const governed = handle as Partial<GovernedCapabilityExecutionHandle>;
      if (
        handle.ownerId !== input.scope.ownerId ||
        handle.agentId !== input.scope.agentId ||
        handle.runId !== input.scope.runId ||
        CLASSIFICATION_RANK[input.dataClassification] >
          CLASSIFICATION_RANK[handle.maxDataClassification] ||
        governed.handleVersion !== "capability-handle.v2" ||
        governed.authorityFence !== input.authorityFence ||
        governed.workerEndedAt !== null ||
        governed.uses === undefined ||
        governed.maxUses === undefined ||
        governed.uses >= governed.maxUses
      )
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "Worker subtask exceeds delegated authority",
        );
      await this.assertGovernedAuthorization(handle);
    }
  }

  async cancel(request: CancelWorkRequest): Promise<WorkCancelledEvent> {
    this.cancellations.set(request.payload.targetRequestId, request.payload.reasonCode);
    await this.dependencies.capability.cancel(
      request.payload.targetRequestId,
      request.payload.reasonCode,
    );
    return {
      ...this.eventEnvelope(request, "work.cancelled"),
      payload: {
        requestId: request.payload.targetRequestId,
        cancelledAt: this.dependencies.clock.now(),
        reasonCode: request.payload.reasonCode,
      },
    };
  }

  async reconcile(request: ReconcileWorkRequest): Promise<WorkReconciledEvent> {
    const result = this.dependencies.reconciliation
      ? await this.dependencies.reconciliation.reconcile({
          externalActionId: request.payload.externalActionId,
          resultLookupRef: request.payload.resultLookupRef,
        })
      : {
          outcome: "still_unknown" as const,
          resultRef: null,
          errorCode: null,
        };
    const valid =
      (result.outcome === "confirmed_succeeded" &&
        result.resultRef !== null &&
        result.errorCode === null) ||
      (result.outcome === "confirmed_failed" &&
        result.resultRef === null &&
        result.errorCode !== null) ||
      (result.outcome === "still_unknown" &&
        result.resultRef === null &&
        result.errorCode === null);
    if (!valid) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        `External reconciliation ${request.payload.externalActionId} returned an invalid result`,
        { externalActionId: request.payload.externalActionId },
      );
    }
    return {
      ...this.eventEnvelope(request, "work.reconciled"),
      payload: {
        requestId: request.messageId,
        externalActionId: request.payload.externalActionId,
        reconciledAt: this.dependencies.clock.now(),
        outcome: result.outcome,
        resultRef: result.resultRef,
        errorCode: result.errorCode,
      },
    };
  }

  private async requireHandle(handleRef: string): Promise<CapabilityExecutionHandle> {
    const handle = await this.dependencies.handles.getExecutionHandle(handleRef);
    if (!handle) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Capability handle ${handleRef} not found`,
        { handleRef },
      );
    }
    const record = await this.dependencies.handles.get(handle.capabilityRef);
    if (
      handle.revokedAt !== null ||
      this.dependencies.clock.now() >= handle.expiresAt ||
      !record ||
      !capabilityLifecycleHasActiveAuthority(record.lifecycle) ||
      record.declaration.version !== handle.capabilityVersion
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.HANDLE_REVOKED,
        `Capability handle ${handleRef} is no longer usable`,
        { handleRef },
      );
    }
    return handle;
  }

  private assertDelegation(request: ExecuteWorkRequest, handle: CapabilityExecutionHandle): void {
    const valid =
      handle.ownerId === request.scope.ownerId &&
      handle.agentId === request.scope.agentId &&
      handle.runId === request.scope.runId &&
      handle.capabilityRef === request.payload.capabilityId &&
      handle.capabilityVersion === request.payload.capabilityVersion &&
      handle.operations.includes(request.payload.operation) &&
      handle.inputRefs.includes(request.payload.inputRef) &&
      request.payload.delegatedContextRefs.every((ref) =>
        handle.delegatedContextRefs.includes(ref),
      ) &&
      request.payload.secretRefs.every((secret) =>
        handle.secretRefs.some((allowed) => sameSecret(allowed, secret)),
      ) &&
      CLASSIFICATION_RANK[request.dataClassification] <=
        CLASSIFICATION_RANK[handle.maxDataClassification];
    if (!valid) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        `Execution request ${request.messageId} exceeds its delegated handle`,
        { requestId: request.messageId, handleRef: handle.ref },
      );
    }
  }

  private async consumeGovernedHandle(
    request: ExecuteWorkRequest,
    handle: CapabilityExecutionHandle,
  ): Promise<void> {
    const governed = handle as Partial<GovernedCapabilityExecutionHandle>;
    if (governed.handleVersion !== "capability-handle.v2") return;
    if (
      governed.authorityFence === undefined ||
      !this.dependencies.authorityFence ||
      governed.authorityFence !== this.dependencies.authorityFence()
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.HANDLE_REVOKED,
        `Capability Handle ${handle.ref} has a stale authority fence`,
      );
    }
    if (
      !this.dependencies.handles.consumeExecutionHandle ||
      !this.dependencies.authorization ||
      governed.revision === undefined ||
      governed.authorizationRef === undefined
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        `Execution request ${request.messageId} cannot revalidate its governed Handle`,
      );
    }
    await this.assertGovernedAuthorization(handle);
    await this.dependencies.handles.consumeExecutionHandle({
      handleRef: handle.ref,
      expectedRevision: governed.revision,
      authorityFence: governed.authorityFence,
      operation: request.payload.operation,
      inputRef: request.payload.inputRef,
      delegatedContextRefs: request.payload.delegatedContextRefs,
      secretRefs: request.payload.secretRefs.map(({ secretRef }) => secretRef),
      dataClassification: request.dataClassification,
      costMicros: 0,
      idempotencyKey: request.idempotencyKey,
      consumedAt: this.dependencies.clock.now(),
    });
  }

  private async assertGovernedAuthorization(handle: CapabilityExecutionHandle): Promise<void> {
    if (handle.authorization.type === "grant") {
      if (!this.dependencies.authorization)
        throw new ApplicationPortError(
          PORT_ERROR_CODES.NOT_AUTHORITATIVE,
          "Worker cannot revalidate delegated Grant",
        );
      const grants = await this.dependencies.authorization.listGrants(
        handle.ownerId,
        handle.agentId,
      );
      const grant = grants.find(({ id }) => id === handle.authorization.ref);
      const now = this.dependencies.clock.now();
      if (!grant || grant.revokedAt !== null || now < grant.validFrom || now >= grant.expiresAt) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.HANDLE_REVOKED,
          `Grant for Capability Handle ${handle.ref} is no longer active`,
        );
      }
    }
  }

  private eventEnvelope<
    TType extends "work.progress" | "work.result" | "work.cancelled" | "work.reconciled",
  >(request: ExecuteWorkRequest | CancelWorkRequest | ReconcileWorkRequest, type: TType) {
    return {
      schemaVersion: EXECUTION_SCHEMA_VERSION,
      kind: "event" as const,
      type,
      messageId: this.dependencies.ids.next("execution-event"),
      correlationId: request.correlationId,
      causationId: request.messageId,
      dataClassification: request.dataClassification,
      scope: request.scope,
    };
  }

  private resultEvent(
    request: ExecuteWorkRequest,
    outcome: WorkResultEvent["payload"]["outcome"],
    outputRef: string | null,
    errorCode: string | null,
    externalActionId: string | null,
  ): WorkResultEvent {
    return {
      ...this.eventEnvelope(request, "work.result"),
      payload: {
        requestId: request.messageId,
        completedAt: this.dependencies.clock.now(),
        outcome,
        outputRef,
        errorCode,
        externalActionId,
      },
    };
  }

  private cancelledEvent(
    request: ExecuteWorkRequest,
    requestId: string,
    reasonCode: string,
  ): WorkCancelledEvent {
    return {
      ...this.eventEnvelope(request, "work.cancelled"),
      payload: {
        requestId,
        cancelledAt: this.dependencies.clock.now(),
        reasonCode,
      },
    };
  }
}
