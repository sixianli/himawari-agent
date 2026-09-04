import type { ExecutionTransportPort } from "@himawari-agent/application";
import type {
  ExecutionV2Event,
  ExecutionV2Request,
  ExecutionV2Response,
} from "@himawari-agent/execution-contracts";
import type { ProductionExecutionAdmissionParentBinding } from "./production-execution-admission-handler.js";
import type { ProductionWorkerParentBindingRegistryWriter } from "./production-worker-parent-binding-registry.js";

export const PRODUCTION_WORKER_FORWARD_ERROR_CODES = Object.freeze({
  BINDING_MESSAGE_MISMATCH: "PRODUCTION_WORKER_FORWARD_BINDING_MESSAGE_MISMATCH",
} as const);

export type ProductionWorkerForwardErrorCode =
  (typeof PRODUCTION_WORKER_FORWARD_ERROR_CODES)[keyof typeof PRODUCTION_WORKER_FORWARD_ERROR_CODES];

export class ProductionWorkerForwardTransportError extends Error {
  readonly code: ProductionWorkerForwardErrorCode;

  constructor(code: ProductionWorkerForwardErrorCode) {
    super(code);
    this.name = "ProductionWorkerForwardTransportError";
    this.code = code;
  }
}

export type ProductionWorkerForwardRequest = Extract<
  ExecutionV2Request,
  { readonly type: "work.delegate" | "work.execute" }
>;

function sameScope(
  bindingScope: ProductionExecutionAdmissionParentBinding["scope"],
  messageScope: ProductionWorkerForwardRequest["scope"],
): boolean {
  return (
    messageScope.ownerId !== null &&
    messageScope.agentId !== null &&
    messageScope.runId !== null &&
    messageScope.workerRunId !== null &&
    bindingScope.deploymentId === messageScope.deploymentId &&
    bindingScope.authorityEpoch === messageScope.authorityEpoch &&
    bindingScope.fencingToken === messageScope.fencingToken &&
    bindingScope.ownerId === messageScope.ownerId &&
    bindingScope.agentId === messageScope.agentId &&
    bindingScope.runId === messageScope.runId &&
    bindingScope.workerRunId === messageScope.workerRunId
  );
}

function sameCeiling(
  left: ProductionExecutionAdmissionParentBinding["resourceCeiling"],
  right: Extract<
    ProductionWorkerForwardRequest,
    { readonly type: "work.execute" }
  >["payload"]["resourceCeiling"],
): boolean {
  return (
    left.maxWallTimeMs === right.maxWallTimeMs &&
    left.maxCpuTimeMs === right.maxCpuTimeMs &&
    left.maxMemoryBytes === right.maxMemoryBytes &&
    left.maxOutputBytes === right.maxOutputBytes &&
    left.maxProgressEvents === right.maxProgressEvents
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function matchesMessage(
  binding: ProductionExecutionAdmissionParentBinding,
  message: ProductionWorkerForwardRequest,
): boolean {
  try {
    if (message.type === "work.delegate") {
      return (
        message.causationId !== null &&
        binding.parentMessageId === message.causationId &&
        binding.parentCorrelationId === message.correlationId &&
        sameScope(binding.scope, message.scope) &&
        binding.dataClassification === message.dataClassification &&
        sameStrings(binding.capabilityHandleRefs, [message.payload.handle.ref]) &&
        sameStrings(binding.delegatedContextRefs, message.payload.handle.delegatedContextRefs) &&
        Date.parse(binding.deadlineAt) <= Date.parse(message.payload.handle.expiresAt)
      );
    }
    return (
      binding.parentMessageId === message.messageId &&
      binding.parentCorrelationId === message.correlationId &&
      sameScope(binding.scope, message.scope) &&
      binding.dataClassification === message.dataClassification &&
      sameCeiling(binding.resourceCeiling, message.payload.resourceCeiling) &&
      binding.deadlineAt === message.payload.deadlineAt &&
      sameStrings(binding.capabilityHandleRefs, [message.payload.capabilityHandleRef]) &&
      sameStrings(binding.delegatedContextRefs, message.payload.delegatedContextRefs)
    );
  } catch {
    return false;
  }
}

export interface ProductionWorkerForwardTransportOptions {
  /** The authenticated AgentServiceExecutionClient or another ExecutionTransportPort. */
  readonly transport: ExecutionTransportPort;
  /** The sole process-local writer; the forwarder has no read or replace capability. */
  readonly parentBindingWriter: ProductionWorkerParentBindingRegistryWriter;
  /** Resolve a complete trusted parent from Agent-side delegation state. */
  readonly parentBindingFor: (
    message: ProductionWorkerForwardRequest,
  ) => ProductionExecutionAdmissionParentBinding;
}

/**
 * Registers a parent before forwarding any delegate or execute request to the
 * authenticated Worker transport. It never retries or removes a binding when
 * the underlying send has an unknown outcome.
 */
export class ProductionWorkerForwardTransport implements ExecutionTransportPort {
  readonly #options: ProductionWorkerForwardTransportOptions;

  constructor(options: ProductionWorkerForwardTransportOptions) {
    this.#options = options;
  }

  async request(message: ExecutionV2Request): Promise<ExecutionV2Response | null> {
    if (message.type === "work.delegate" || message.type === "work.execute") {
      const binding = this.#options.parentBindingFor(message);
      if (!matchesMessage(binding, message)) {
        throw new ProductionWorkerForwardTransportError(
          PRODUCTION_WORKER_FORWARD_ERROR_CODES.BINDING_MESSAGE_MISMATCH,
        );
      }
      this.#options.parentBindingWriter.register(binding);
    }
    return this.#options.transport.request(message);
  }

  events(afterCursor: string | null): AsyncIterable<ExecutionV2Event> {
    return this.#options.transport.events(afterCursor);
  }
}
