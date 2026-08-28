import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type CapabilityExecutionHandle,
  type CapabilityExecutionHandleStorePort,
  type CapabilityRegistryRecord,
  type CapabilityRegistryStorePort,
  type ConsumeCapabilityExecutionHandleInput,
  type GovernedCapabilityExecutionHandle,
} from "@himawari-agent/application";
import type { DelegatedCapabilityHandleV2 } from "@himawari-agent/execution-contracts";
import type { RegisteredWorkerAdapter } from "./production-execution-worker.js";

export interface WorkerDelegationStoreOptions {
  readonly authorityFence: number;
  readonly adapters: readonly RegisteredWorkerAdapter[];
  readonly now: () => string;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Boot-scoped, volatile authority projection used by the isolated Worker.
 *
 * The Agent Service remains the durable authority and must consume the source
 * Capability Handle before sending a one-use delegation. This store never
 * opens product.sqlite and cannot issue or expand authority.
 */
export class WorkerDelegationStore
  implements CapabilityRegistryStorePort, CapabilityExecutionHandleStorePort
{
  readonly #authorityFence: number;
  readonly #now: () => string;
  readonly #records = new Map<string, CapabilityRegistryRecord>();
  readonly #handles = new Map<string, GovernedCapabilityExecutionHandle>();
  readonly #fingerprints = new Map<string, string>();

  constructor(options: WorkerDelegationStoreOptions) {
    this.#authorityFence = options.authorityFence;
    this.#now = options.now;
    for (const adapter of options.adapters) {
      const existing = this.#records.get(adapter.capabilityId);
      if (existing && existing.declaration.version !== adapter.capabilityVersion) {
        throw new ApplicationPortError(
          PORT_ERROR_CODES.CONFLICT,
          `Worker adapter ${adapter.capabilityId} has competing versions`,
        );
      }
      this.#records.set(adapter.capabilityId, {
        ref: adapter.capabilityId,
        revision: 1,
        lifecycle: "active",
        declaration: {
          ref: adapter.capabilityId,
          displayName: adapter.capabilityId,
          version: adapter.capabilityVersion,
          source: { type: "builtin", locator: `execution-worker:${adapter.capabilityId}` },
          integrity: `sha256:${"0".repeat(64)}`,
          operations: Object.freeze([...adapter.operations]),
          permissionRefs: Object.freeze([]),
          isolation: "worker",
        },
        pendingDeclaration: null,
        permissionExpansion: false,
        runtimeQualification: null,
        pendingUpdateAssessment: null,
        rollbackDeclaration: null,
        rollbackQualification: null,
        lastVersionTransition: null,
        approvalRefs: Object.freeze([]),
        discoveredAt: this.#now(),
        updatedAt: this.#now(),
      });
    }
  }

  accept(handle: DelegatedCapabilityHandleV2): GovernedCapabilityExecutionHandle {
    const fingerprint = JSON.stringify(handle);
    const previous = this.#fingerprints.get(handle.ref);
    if (previous !== undefined) {
      if (previous !== fingerprint)
        this.#conflict(`Delegation ${handle.ref} changed after admission`);
      const admitted = this.#handles.get(handle.ref);
      if (!admitted) this.#conflict(`Delegation ${handle.ref} is missing after admission`);
      return copy(admitted);
    }
    const capability = this.#records.get(handle.capabilityRef);
    if (
      !capability ||
      capability.declaration.version !== handle.capabilityVersion ||
      !capability.declaration.operations.includes(handle.operation) ||
      !handle.operations.includes(handle.operation)
    ) {
      this.#reject(`Delegation ${handle.ref} does not match a registered Worker adapter`);
    }
    if (
      handle.authorityFence !== this.#authorityFence ||
      handle.revokedAt !== null ||
      handle.workerEndedAt !== null ||
      handle.expiresAt <= this.#now() ||
      handle.maxUses !== 1 ||
      handle.uses !== 0 ||
      handle.spentCostMicros > handle.maxTotalCostMicros
    ) {
      this.#reject(`Delegation ${handle.ref} is stale, expanded, or already consumed`);
    }
    const admitted: GovernedCapabilityExecutionHandle = {
      handleVersion: "capability-handle.v2",
      ref: handle.ref,
      revision: handle.revision,
      authorityFence: handle.authorityFence,
      ownerId: handle.ownerId as GovernedCapabilityExecutionHandle["ownerId"],
      agentId: handle.agentId as GovernedCapabilityExecutionHandle["agentId"],
      runId: handle.runId as GovernedCapabilityExecutionHandle["runId"],
      capabilityRef: handle.capabilityRef,
      capabilityVersion: handle.capabilityVersion,
      authorization: { type: handle.authorizationType, ref: handle.authorizationRef },
      operations: Object.freeze([...handle.operations]),
      inputRefs: Object.freeze([...handle.inputRefs]),
      delegatedContextRefs: Object.freeze([...handle.delegatedContextRefs]),
      secretRefs: Object.freeze(handle.secretRefs.map((secret) => ({ ...secret }))),
      maxDataClassification: handle.maxDataClassification,
      issuedAt: handle.issuedAt,
      expiresAt: handle.expiresAt,
      revokedAt: handle.revokedAt,
      operation: handle.operation,
      authorizationRef: handle.authorizationRef,
      maxUses: handle.maxUses,
      uses: handle.uses,
      maxTotalCostMicros: handle.maxTotalCostMicros,
      spentCostMicros: handle.spentCostMicros,
      idempotencyKeys: Object.freeze([...handle.idempotencyKeys]),
      workerEndedAt: handle.workerEndedAt,
    };
    this.#fingerprints.set(handle.ref, fingerprint);
    this.#handles.set(handle.ref, admitted);
    return copy(admitted);
  }

  async get(capabilityRef: string): Promise<CapabilityRegistryRecord | undefined> {
    const record = this.#records.get(capabilityRef);
    return record ? copy(record) : undefined;
  }

  async list(): Promise<readonly CapabilityRegistryRecord[]> {
    return [...this.#records.values()].map(copy);
  }

  async create(_record: CapabilityRegistryRecord): Promise<CapabilityRegistryRecord> {
    this.#reject("Worker cannot create durable Capability Registry records");
  }

  async save(
    _record: CapabilityRegistryRecord,
    _expectedRevision: number,
  ): Promise<CapabilityRegistryRecord> {
    this.#reject("Worker cannot mutate durable Capability Registry records");
  }

  async createExecutionHandle(
    _handle: CapabilityExecutionHandle,
  ): Promise<CapabilityExecutionHandle> {
    this.#reject("Worker accepts only Agent Service delegations");
  }

  async getExecutionHandle(handleRef: string): Promise<CapabilityExecutionHandle | undefined> {
    const handle = this.#handles.get(handleRef);
    return handle ? copy(handle) : undefined;
  }

  async revokeExecutionHandle(
    handleRef: string,
    revokedAt: string,
  ): Promise<CapabilityExecutionHandle> {
    const current = this.#handles.get(handleRef);
    if (!current) this.#notFound(`Delegation ${handleRef} was not found`);
    if (current.revokedAt !== null) return copy(current);
    const revoked = { ...current, revision: current.revision + 1, revokedAt };
    this.#handles.set(handleRef, revoked);
    return copy(revoked);
  }

  async consumeExecutionHandle(
    input: ConsumeCapabilityExecutionHandleInput,
  ): Promise<GovernedCapabilityExecutionHandle> {
    const current = this.#handles.get(input.handleRef);
    if (!current) this.#notFound(`Delegation ${input.handleRef} was not found`);
    if (current.idempotencyKeys.includes(input.idempotencyKey)) return copy(current);
    if (
      current.revision !== input.expectedRevision ||
      current.revokedAt !== null ||
      current.workerEndedAt !== null ||
      input.consumedAt >= current.expiresAt ||
      current.authorityFence !== input.authorityFence ||
      current.uses >= current.maxUses ||
      current.spentCostMicros + input.costMicros > current.maxTotalCostMicros
    ) {
      this.#conflict(`Delegation ${input.handleRef} is not consumable`);
    }
    const consumed: GovernedCapabilityExecutionHandle = {
      ...current,
      revision: current.revision + 1,
      uses: current.uses + 1,
      spentCostMicros: current.spentCostMicros + input.costMicros,
      idempotencyKeys: Object.freeze([...current.idempotencyKeys, input.idempotencyKey]),
    };
    this.#handles.set(current.ref, consumed);
    return copy(consumed);
  }

  clear(): void {
    this.#handles.clear();
    this.#fingerprints.clear();
  }

  #reject(message: string): never {
    throw new ApplicationPortError(PORT_ERROR_CODES.NOT_AUTHORITATIVE, message);
  }

  #conflict(message: string): never {
    throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, message);
  }

  #notFound(message: string): never {
    throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, message);
  }
}
