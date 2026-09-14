import type {
  ExecutionAdmissionPeerBinding,
  ResourceCeiling,
} from "@himawari-agent/execution-contracts";
import type {
  ProductionExecutionAdmissionParentBinding,
  ProductionExecutionAdmissionParentBindingLookup,
} from "./production-execution-admission-handler.js";

export const PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES = Object.freeze({
  CONFIGURATION_INVALID: "PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_CONFIGURATION_INVALID",
  BINDING_INVALID: "PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_BINDING_INVALID",
  BINDING_PEER_MISMATCH: "PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_BINDING_PEER_MISMATCH",
  IDENTITY_CONFLICT: "PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_IDENTITY_CONFLICT",
  PEER_SCOPE_CHANGED: "PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_PEER_SCOPE_CHANGED",
} as const);

export type ProductionWorkerParentBindingRegistryErrorCode =
  (typeof PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES)[keyof typeof PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES];

export class ProductionWorkerParentBindingRegistryError extends Error {
  readonly code: ProductionWorkerParentBindingRegistryErrorCode;

  constructor(code: ProductionWorkerParentBindingRegistryErrorCode) {
    super(code);
    this.name = "ProductionWorkerParentBindingRegistryError";
    this.code = code;
  }
}

export interface ProductionWorkerParentBindingRegistryOptions {
  /** Read the current peer from the authenticated Agent/Worker session. */
  readonly trustedPeerBinding: () => ExecutionAdmissionPeerBinding;
}

export interface ProductionWorkerParentBindingRegistryReader
  extends ProductionExecutionAdmissionParentBindingLookup {}

export interface ProductionWorkerParentBindingRegistryWriter {
  /** Register once before the parent can be sent to the Worker. */
  register(binding: ProductionExecutionAdmissionParentBinding): void;
}

export interface ProductionWorkerParentBindingRegistry {
  /** The handler receives this read-only view; it cannot register or replace parents. */
  readonly reader: ProductionWorkerParentBindingRegistryReader;
  /** The Agent-side dispatch owner receives the only write capability. */
  readonly writer: ProductionWorkerParentBindingRegistryWriter;
}

const DATA_CLASSIFICATIONS = new Set(["public", "private", "sensitive", "restricted"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface PeerCandidate {
  readonly agentServiceInstanceId: unknown;
  readonly agentServiceBootId: unknown;
  readonly workerInstanceId: unknown;
  readonly workerBootId: unknown;
  readonly deploymentId: unknown;
  readonly authorityEpoch: unknown;
  readonly fencingToken: unknown;
}

function isPeerCandidate(value: unknown): value is PeerCandidate {
  return (
    isRecord(value) &&
    "agentServiceInstanceId" in value &&
    "agentServiceBootId" in value &&
    "workerInstanceId" in value &&
    "workerBootId" in value &&
    "deploymentId" in value &&
    "authorityEpoch" in value &&
    "fencingToken" in value
  );
}

interface ResourceCeilingCandidate {
  readonly maxWallTimeMs: unknown;
  readonly maxCpuTimeMs: unknown;
  readonly maxMemoryBytes: unknown;
  readonly maxOutputBytes: unknown;
  readonly maxProgressEvents: unknown;
}

function isResourceCeilingCandidate(value: unknown): value is ResourceCeilingCandidate {
  return (
    isRecord(value) &&
    "maxWallTimeMs" in value &&
    "maxCpuTimeMs" in value &&
    "maxMemoryBytes" in value &&
    "maxOutputBytes" in value &&
    "maxProgressEvents" in value
  );
}

interface ParentScopeCandidate {
  readonly deploymentId: unknown;
  readonly authorityEpoch: unknown;
  readonly fencingToken: unknown;
  readonly ownerId: unknown;
  readonly agentId: unknown;
  readonly runId: unknown;
  readonly workerRunId: unknown;
}

function isParentScopeCandidate(value: unknown): value is ParentScopeCandidate {
  return (
    isRecord(value) &&
    "deploymentId" in value &&
    "authorityEpoch" in value &&
    "fencingToken" in value &&
    "ownerId" in value &&
    "agentId" in value &&
    "runId" in value &&
    "workerRunId" in value
  );
}

interface ParentBindingCandidate {
  readonly parentMessageId: unknown;
  readonly parentCorrelationId: unknown;
  readonly bindingRevision: unknown;
  readonly bindingDigest: unknown;
  readonly scope: unknown;
  readonly authority: unknown;
  readonly dataClassification: unknown;
  readonly resourceCeiling: unknown;
  readonly deadlineAt: unknown;
  readonly capabilityHandleRefs: unknown;
  readonly delegatedContextRefs: unknown;
}

function isParentBindingCandidate(value: unknown): value is ParentBindingCandidate {
  return (
    isRecord(value) &&
    "parentMessageId" in value &&
    "parentCorrelationId" in value &&
    "bindingRevision" in value &&
    "bindingDigest" in value &&
    "scope" in value &&
    "authority" in value &&
    "dataClassification" in value &&
    "resourceCeiling" in value &&
    "deadlineAt" in value &&
    "capabilityHandleRefs" in value &&
    "delegatedContextRefs" in value
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function canonicalTimestamp(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function validStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(nonEmptyString);
}

function validPeerBinding(value: unknown): value is ExecutionAdmissionPeerBinding {
  if (!isPeerCandidate(value)) return false;
  return (
    nonEmptyString(value.agentServiceInstanceId) &&
    nonEmptyString(value.agentServiceBootId) &&
    nonEmptyString(value.workerInstanceId) &&
    nonEmptyString(value.workerBootId) &&
    nonEmptyString(value.deploymentId) &&
    positiveSafeInteger(value.authorityEpoch) &&
    positiveSafeInteger(value.fencingToken)
  );
}

function validResourceCeiling(value: unknown): value is ResourceCeiling {
  if (!isResourceCeilingCandidate(value)) return false;
  return (
    positiveSafeInteger(value.maxWallTimeMs) &&
    positiveSafeInteger(value.maxCpuTimeMs) &&
    positiveSafeInteger(value.maxMemoryBytes) &&
    positiveSafeInteger(value.maxOutputBytes) &&
    positiveSafeInteger(value.maxProgressEvents)
  );
}

function validParentScope(
  value: unknown,
): value is ProductionExecutionAdmissionParentBinding["scope"] {
  if (!isParentScopeCandidate(value)) return false;
  return (
    nonEmptyString(value.deploymentId) &&
    positiveSafeInteger(value.authorityEpoch) &&
    positiveSafeInteger(value.fencingToken) &&
    nonEmptyString(value.ownerId) &&
    nonEmptyString(value.agentId) &&
    nonEmptyString(value.runId) &&
    nonEmptyString(value.workerRunId)
  );
}

function validParentBinding(value: unknown): value is ProductionExecutionAdmissionParentBinding {
  if (!isParentBindingCandidate(value)) return false;
  if (!validParentScope(value.scope) || !validPeerBinding(value.authority)) return false;
  return (
    nonEmptyString(value.parentMessageId) &&
    nonEmptyString(value.parentCorrelationId) &&
    positiveSafeInteger(value.bindingRevision) &&
    nonEmptyString(value.bindingDigest) &&
    DATA_CLASSIFICATIONS.has(String(value.dataClassification)) &&
    validResourceCeiling(value.resourceCeiling) &&
    canonicalTimestamp(value.deadlineAt) &&
    validStringArray(value.capabilityHandleRefs) &&
    validStringArray(value.delegatedContextRefs) &&
    value.scope.deploymentId === value.authority.deploymentId &&
    value.scope.authorityEpoch === value.authority.authorityEpoch &&
    value.scope.fencingToken === value.authority.fencingToken
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

function sameScope(
  left: ProductionExecutionAdmissionParentBinding["scope"],
  right: ProductionExecutionAdmissionParentBinding["scope"],
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

function sameCeiling(left: ResourceCeiling, right: ResourceCeiling): boolean {
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

function sameBinding(
  left: ProductionExecutionAdmissionParentBinding,
  right: ProductionExecutionAdmissionParentBinding,
): boolean {
  return (
    left.parentMessageId === right.parentMessageId &&
    left.parentCorrelationId === right.parentCorrelationId &&
    left.bindingRevision === right.bindingRevision &&
    left.bindingDigest === right.bindingDigest &&
    sameScope(left.scope, right.scope) &&
    samePeer(left.authority, right.authority) &&
    left.dataClassification === right.dataClassification &&
    sameCeiling(left.resourceCeiling, right.resourceCeiling) &&
    left.deadlineAt === right.deadlineAt &&
    sameStrings(left.capabilityHandleRefs, right.capabilityHandleRefs) &&
    sameStrings(left.delegatedContextRefs, right.delegatedContextRefs)
  );
}

function freezePeer(peer: ExecutionAdmissionPeerBinding): ExecutionAdmissionPeerBinding {
  return Object.freeze({ ...peer });
}

function freezeBinding(
  binding: ProductionExecutionAdmissionParentBinding,
): ProductionExecutionAdmissionParentBinding {
  return Object.freeze({
    ...binding,
    scope: Object.freeze({ ...binding.scope }),
    authority: freezePeer(binding.authority),
    resourceCeiling: Object.freeze({ ...binding.resourceCeiling }),
    capabilityHandleRefs: Object.freeze([...binding.capabilityHandleRefs]),
    delegatedContextRefs: Object.freeze([...binding.delegatedContextRefs]),
  });
}

class RegistryState {
  readonly #trustedPeerBinding: () => ExecutionAdmissionPeerBinding;
  readonly #bootPeer: ExecutionAdmissionPeerBinding;
  readonly #bindings = new Map<string, ProductionExecutionAdmissionParentBinding>();
  #poisoned = false;

  constructor(options: ProductionWorkerParentBindingRegistryOptions) {
    let initialPeer: ExecutionAdmissionPeerBinding;
    try {
      initialPeer = options.trustedPeerBinding();
    } catch {
      throw new ProductionWorkerParentBindingRegistryError(
        PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES.CONFIGURATION_INVALID,
      );
    }
    if (!validPeerBinding(initialPeer)) {
      throw new ProductionWorkerParentBindingRegistryError(
        PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES.CONFIGURATION_INVALID,
      );
    }
    this.#trustedPeerBinding = options.trustedPeerBinding;
    this.#bootPeer = freezePeer(initialPeer);
  }

  register(binding: ProductionExecutionAdmissionParentBinding): void {
    const currentPeer = this.#currentPeerOrInvalidate();
    if (!currentPeer) {
      throw new ProductionWorkerParentBindingRegistryError(
        PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES.PEER_SCOPE_CHANGED,
      );
    }
    if (!validParentBinding(binding)) {
      throw new ProductionWorkerParentBindingRegistryError(
        PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES.BINDING_INVALID,
      );
    }
    if (!samePeer(binding.authority, currentPeer)) {
      throw new ProductionWorkerParentBindingRegistryError(
        PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES.BINDING_PEER_MISMATCH,
      );
    }

    const existing = this.#bindings.get(binding.parentMessageId);
    if (existing) {
      if (!sameBinding(existing, binding)) {
        throw new ProductionWorkerParentBindingRegistryError(
          PRODUCTION_WORKER_PARENT_BINDING_REGISTRY_ERROR_CODES.IDENTITY_CONFLICT,
        );
      }
      return;
    }
    this.#bindings.set(binding.parentMessageId, freezeBinding(binding));
  }

  async lookup(
    parentMessageId: string,
  ): Promise<ProductionExecutionAdmissionParentBinding | undefined> {
    if (!this.#currentPeerOrInvalidate()) return undefined;
    return this.#bindings.get(parentMessageId);
  }

  #currentPeerOrInvalidate(): ExecutionAdmissionPeerBinding | undefined {
    if (this.#poisoned) return undefined;

    let currentPeer: ExecutionAdmissionPeerBinding;
    try {
      currentPeer = this.#trustedPeerBinding();
    } catch {
      this.#bindings.clear();
      this.#poisoned = true;
      return undefined;
    }
    if (!validPeerBinding(currentPeer) || !samePeer(currentPeer, this.#bootPeer)) {
      this.#bindings.clear();
      this.#poisoned = true;
      return undefined;
    }
    return currentPeer;
  }
}

export function createProductionWorkerParentBindingRegistry(
  options: ProductionWorkerParentBindingRegistryOptions,
): ProductionWorkerParentBindingRegistry {
  const state = new RegistryState(options);
  return Object.freeze({
    reader: Object.freeze({
      lookup: (parentMessageId: string) => state.lookup(parentMessageId),
    }),
    writer: Object.freeze({
      register: (binding: ProductionExecutionAdmissionParentBinding) => state.register(binding),
    }),
  });
}
