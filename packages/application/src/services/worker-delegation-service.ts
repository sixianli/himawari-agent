import {
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionV2Request,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import type { AuthorizationStorePort } from "../ports/authorization.js";
import {
  capabilityLifecycleHasActiveAuthority,
  type CapabilityExecutionHandleStorePort,
  type CapabilityRegistryStorePort,
  type GovernedCapabilityExecutionHandle,
} from "../ports/capabilities.js";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type { ExecutionTransportPort } from "../ports/coordination.js";

const CLASSIFICATION_RANK = Object.freeze({ public: 0, private: 1, sensitive: 2, restricted: 3 });

type ExecuteRequest = Extract<ExecutionV2Request, { type: "work.execute" }>;

export interface WorkerDelegationServiceOptions {
  readonly handles: CapabilityRegistryStorePort & CapabilityExecutionHandleStorePort;
  readonly authorization: AuthorizationStorePort;
  readonly transport: ExecutionTransportPort;
  readonly authorityFence: () => number;
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
    if (this.#options.now() >= parsed.payload.deadlineAt) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.INVALID_OPERATION,
        "Expired work cannot consume a durable Capability Handle",
      );
    }
    const source = await this.#requiredGovernedHandle(parsed);
    const consumed = await this.#consume(parsed, source);
    const expiresAt =
      consumed.expiresAt <= parsed.payload.deadlineAt
        ? consumed.expiresAt
        : parsed.payload.deadlineAt;
    const delegate = executionV2MessageSchema.parse({
      schemaVersion: EXECUTION_V2_SCHEMA_VERSION,
      kind: "request",
      type: "work.delegate",
      messageId: this.#options.nextId("worker-delegation"),
      correlationId: parsed.correlationId,
      causationId: parsed.messageId,
      dataClassification: parsed.dataClassification,
      risk: parsed.risk,
      authorizationRef: consumed.authorizationRef,
      scope: parsed.scope,
      idempotencyKey: `${parsed.idempotencyKey}:delegate`,
      payload: {
        handle: {
          handleVersion: "capability-handle.v2",
          ref: consumed.ref,
          revision: consumed.revision,
          authorityFence: consumed.authorityFence,
          ownerId: consumed.ownerId,
          agentId: consumed.agentId,
          runId: consumed.runId,
          capabilityRef: consumed.capabilityRef,
          capabilityVersion: consumed.capabilityVersion,
          authorizationType: consumed.authorization.type,
          authorizationRef: consumed.authorizationRef,
          operations: [parsed.payload.operation],
          inputRefs: [parsed.payload.inputRef],
          delegatedContextRefs: parsed.payload.delegatedContextRefs,
          secretRefs: parsed.payload.secretRefs,
          maxDataClassification: parsed.dataClassification,
          issuedAt: this.#options.now(),
          expiresAt,
          revokedAt: null,
          operation: parsed.payload.operation,
          maxUses: 1,
          uses: 0,
          maxTotalCostMicros: 0,
          spentCostMicros: 0,
          idempotencyKeys: [],
          workerEndedAt: null,
        },
        requestedAt: this.#options.now(),
      },
    });
    if (delegate.kind !== "request" || delegate.type !== "work.delegate") {
      throw new TypeError("Worker delegation message is invalid");
    }
    const accepted = await this.#options.transport.request(delegate);
    if (
      accepted?.type !== "work.delegate.accepted" ||
      accepted.payload.handleRef !== consumed.ref
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.PROVIDER_FAILURE,
        "Worker did not accept the attenuated Capability Handle",
      );
    }
    const response = await this.#options.transport.request(parsed);
    if (response !== null) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.PROVIDER_FAILURE,
        "Worker returned an unexpected synchronous work response",
      );
    }
  }

  async #requiredGovernedHandle(request: ExecuteRequest) {
    const handle = await this.#options.handles.getExecutionHandle(
      request.payload.capabilityHandleRef,
    );
    const governed = handle as GovernedCapabilityExecutionHandle | undefined;
    const capability = handle ? await this.#options.handles.get(handle.capabilityRef) : undefined;
    const valid =
      governed?.handleVersion === "capability-handle.v2" &&
      governed.revokedAt === null &&
      governed.workerEndedAt === null &&
      this.#options.now() < governed.expiresAt &&
      governed.authorityFence === this.#options.authorityFence() &&
      capability !== undefined &&
      capabilityLifecycleHasActiveAuthority(capability.lifecycle) &&
      capability.declaration.version === governed.capabilityVersion &&
      governed.ownerId === request.scope.ownerId &&
      governed.agentId === request.scope.agentId &&
      governed.runId === request.scope.runId &&
      governed.capabilityRef === request.payload.capabilityId &&
      governed.capabilityVersion === request.payload.capabilityVersion &&
      governed.operations.includes(request.payload.operation) &&
      governed.inputRefs.includes(request.payload.inputRef) &&
      request.payload.delegatedContextRefs.every((ref) =>
        governed.delegatedContextRefs.includes(ref),
      ) &&
      request.payload.secretRefs.every((secret) =>
        governed.secretRefs.some(
          (allowed) =>
            allowed.secretRef === secret.secretRef &&
            allowed.secretVersion === secret.secretVersion &&
            allowed.purpose === secret.purpose,
        ),
      ) &&
      CLASSIFICATION_RANK[request.dataClassification] <=
        CLASSIFICATION_RANK[governed.maxDataClassification] &&
      (request.authorizationRef === null || request.authorizationRef === governed.authorizationRef);
    if (!valid) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        `Execution request ${request.messageId} exceeds its durable Capability Handle`,
      );
    }
    return governed;
  }

  async #consume(request: ExecuteRequest, handle: GovernedCapabilityExecutionHandle) {
    if (!this.#options.handles.consumeExecutionHandle) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_AUTHORITATIVE,
        "Durable Capability Handle consumption is unavailable",
      );
    }
    if (handle.authorization.type === "grant") {
      const grants = await this.#options.authorization.listGrants(handle.ownerId, handle.agentId);
      const grant = grants.find(({ id }) => id === handle.authorization.ref);
      const now = this.#options.now();
      if (!grant || grant.revokedAt !== null || now < grant.validFrom || now >= grant.expiresAt) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.HANDLE_REVOKED,
          `Grant for Capability Handle ${handle.ref} is no longer active`,
        );
      }
    }
    return this.#options.handles.consumeExecutionHandle({
      handleRef: handle.ref,
      expectedRevision: handle.revision,
      authorityFence: handle.authorityFence,
      operation: request.payload.operation,
      inputRef: request.payload.inputRef,
      delegatedContextRefs: request.payload.delegatedContextRefs,
      secretRefs: request.payload.secretRefs.map(({ secretRef }) => secretRef),
      dataClassification: request.dataClassification,
      costMicros: 0,
      idempotencyKey: request.idempotencyKey,
      consumedAt: this.#options.now(),
    });
  }
}
