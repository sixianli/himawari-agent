import type {
  CapabilityDescriptor,
  CapabilityExecutionHandle,
  CapabilityExecutionHandleStorePort,
  ConsumeCapabilityExecutionHandleInput,
  GovernedCapabilityExecutionHandle,
  CapabilityInvocationEvent,
  CapabilityInvocationRequest,
  CapabilityPort,
  CapabilityRegistryRecord,
  CapabilityRegistryStorePort,
  ExternalActionReconciliationPort,
  ExternalActionReconciliationRequest,
  ExternalActionReconciliationResult,
  IdGeneratorPort,
  SecretHandle,
  SecretHandleRequest,
  SecretPort,
} from "@himawari-agent/application";
import { PORT_ERROR_CODES, ApplicationPortError } from "@himawari-agent/application";
import type { RunId } from "@himawari-agent/domain";
import { type FailureScheduler, NO_FAILURES } from "../deterministic.js";
import { frozenCopy } from "./helpers.js";

export class ScriptedCapabilityPort implements CapabilityPort {
  private readonly descriptors: readonly CapabilityDescriptor[];
  private readonly events: readonly CapabilityInvocationEvent[];

  constructor(
    descriptors: readonly CapabilityDescriptor[] = [],
    events: readonly CapabilityInvocationEvent[] = [],
  ) {
    this.descriptors = frozenCopy([...descriptors]);
    this.events = frozenCopy([...events]);
  }

  async list(): Promise<readonly CapabilityDescriptor[]> {
    return frozenCopy([...this.descriptors]);
  }

  async *invoke(request: CapabilityInvocationRequest): AsyncIterable<CapabilityInvocationEvent> {
    const descriptor = this.descriptors.find(({ ref }) => ref === request.capabilityRef);
    if (!descriptor || descriptor.lifecycle !== "active") {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Active capability ${request.capabilityRef} not found`,
        { capabilityRef: request.capabilityRef },
      );
    }
    for (const event of this.events) yield frozenCopy(event);
  }

  async cancel(_invocationId: string, _reasonCode: string): Promise<void> {}
}

export class InMemoryCapabilityRegistryStore
  implements CapabilityRegistryStorePort, CapabilityExecutionHandleStorePort
{
  private readonly records = new Map<string, CapabilityRegistryRecord>();
  private readonly handles = new Map<string, CapabilityExecutionHandle>();
  private readonly failures: FailureScheduler;

  constructor(failures: FailureScheduler = NO_FAILURES) {
    this.failures = failures;
  }

  async create(record: CapabilityRegistryRecord): Promise<CapabilityRegistryRecord> {
    this.failures.checkpoint("capabilityRegistry.create");
    if (this.records.has(record.ref)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.DUPLICATE,
        `Capability ${record.ref} already exists`,
        { capabilityRef: record.ref },
      );
    }
    this.records.set(record.ref, frozenCopy(record));
    return frozenCopy(record);
  }

  async get(capabilityRef: string): Promise<CapabilityRegistryRecord | undefined> {
    const record = this.records.get(capabilityRef);
    return record ? frozenCopy(record) : undefined;
  }

  async list(): Promise<readonly CapabilityRegistryRecord[]> {
    return [...this.records.values()].map(frozenCopy);
  }

  async save(
    record: CapabilityRegistryRecord,
    expectedRevision: number,
  ): Promise<CapabilityRegistryRecord> {
    this.failures.checkpoint("capabilityRegistry.save");
    const current = this.records.get(record.ref);
    if (!current) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Capability ${record.ref} not found`,
        { capabilityRef: record.ref },
      );
    }
    if (current.revision !== expectedRevision || record.revision !== expectedRevision + 1) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Capability ${record.ref} has a stale revision`,
        { capabilityRef: record.ref },
      );
    }
    this.records.set(record.ref, frozenCopy(record));
    return frozenCopy(record);
  }

  async invalidateCapabilityAuthority(
    record: CapabilityRegistryRecord,
    expectedRevision: number,
    revokedAt: string,
  ): Promise<CapabilityRegistryRecord> {
    const saved = await this.save(record, expectedRevision);
    await this.revokeCapabilityHandles(record.ref, revokedAt);
    return saved;
  }

  async switchCapabilityVersion(
    record: CapabilityRegistryRecord,
    expectedRevision: number,
    switchedAt: string,
  ): Promise<CapabilityRegistryRecord> {
    const saved = await this.save(record, expectedRevision);
    await this.revokeCapabilityHandles(record.ref, switchedAt);
    return saved;
  }

  async createExecutionHandle(
    handle: CapabilityExecutionHandle,
  ): Promise<CapabilityExecutionHandle> {
    this.failures.checkpoint("capabilityHandle.create");
    if (this.handles.has(handle.ref)) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.DUPLICATE,
        `Capability handle ${handle.ref} already exists`,
        { handleRef: handle.ref },
      );
    }
    this.handles.set(handle.ref, frozenCopy(handle));
    return frozenCopy(handle);
  }

  async getExecutionHandle(handleRef: string): Promise<CapabilityExecutionHandle | undefined> {
    const handle = this.handles.get(handleRef);
    return handle ? frozenCopy(handle) : undefined;
  }

  async revokeExecutionHandle(
    handleRef: string,
    revokedAt: string,
  ): Promise<CapabilityExecutionHandle> {
    this.failures.checkpoint("capabilityHandle.revoke");
    const current = this.handles.get(handleRef);
    if (!current) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Capability handle ${handleRef} not found`,
        { handleRef },
      );
    }
    if (current.revokedAt !== null) return frozenCopy(current);
    const revoked = frozenCopy({ ...current, revokedAt });
    this.handles.set(handleRef, revoked);
    return frozenCopy(revoked);
  }

  async consumeExecutionHandle(
    input: ConsumeCapabilityExecutionHandleInput,
  ): Promise<GovernedCapabilityExecutionHandle> {
    this.failures.checkpoint("capabilityHandle.consume");
    const current = this.handles.get(input.handleRef) as
      | GovernedCapabilityExecutionHandle
      | undefined;
    if (!current || current.handleVersion !== "capability-handle.v2") {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Capability handle ${input.handleRef} not found`,
      );
    }
    if (current.idempotencyKeys.includes(input.idempotencyKey)) return frozenCopy(current);
    if (
      current.revision !== input.expectedRevision ||
      current.revokedAt !== null ||
      current.workerEndedAt !== null ||
      input.consumedAt >= current.expiresAt ||
      current.authorityFence !== input.authorityFence ||
      current.uses >= current.maxUses ||
      current.spentCostMicros + input.costMicros > current.maxTotalCostMicros
    ) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.CONFLICT,
        `Capability handle ${input.handleRef} is not consumable`,
      );
    }
    const consumed: GovernedCapabilityExecutionHandle = frozenCopy({
      ...current,
      revision: current.revision + 1,
      uses: current.uses + 1,
      spentCostMicros: current.spentCostMicros + input.costMicros,
      idempotencyKeys: [...current.idempotencyKeys, input.idempotencyKey],
    });
    this.handles.set(current.ref, consumed);
    return frozenCopy(consumed);
  }

  async revokeCapabilityHandles(capabilityRef: string, revokedAt: string): Promise<number> {
    let count = 0;
    for (const [ref, handle] of this.handles) {
      if (handle.capabilityRef !== capabilityRef || handle.revokedAt !== null) continue;
      this.handles.set(ref, frozenCopy({ ...handle, revokedAt }));
      count += 1;
    }
    return count;
  }

  async endRunExecutionHandles(runId: RunId, endedAt: string): Promise<number> {
    let count = 0;
    for (const [ref, handle] of this.handles) {
      const governed = handle as Partial<GovernedCapabilityExecutionHandle>;
      if (
        handle.runId !== runId ||
        governed.handleVersion !== "capability-handle.v2" ||
        governed.workerEndedAt !== null
      )
        continue;
      const ended: GovernedCapabilityExecutionHandle = {
        ...(handle as GovernedCapabilityExecutionHandle),
        revision: (governed.revision ?? 0) + 1,
        workerEndedAt: endedAt,
      };
      this.handles.set(ref, frozenCopy(ended));
      count += 1;
    }
    return count;
  }
}

export class DeterministicRestaurantCapabilityPort implements CapabilityPort {
  private readonly invocations: CapabilityInvocationRequest[] = [];
  private readonly cancellations = new Map<string, string>();
  private readonly startedAt: string;
  private readonly completedAt: string;
  private readonly reservationResultUnknown: boolean;

  constructor(
    startedAt: string,
    completedAt: string,
    options: { readonly reservationResultUnknown?: boolean } = {},
  ) {
    this.startedAt = startedAt;
    this.completedAt = completedAt;
    this.reservationResultUnknown = options.reservationResultUnknown ?? false;
  }

  async list(): Promise<readonly CapabilityDescriptor[]> {
    return [
      {
        ref: "restaurant-search",
        version: "1.0.0",
        integrity: `sha256:${"a".repeat(64)}`,
        lifecycle: "active",
        permissionRefs: ["network:maps.test", "secret:map-provider"],
        isolation: "worker",
      },
      {
        ref: "restaurant-reservation",
        version: "1.0.0",
        integrity: `sha256:${"a".repeat(64)}`,
        lifecycle: "active",
        permissionRefs: ["network:booking.test", "secret:booking-provider"],
        isolation: "worker",
      },
    ];
  }

  async *invoke(request: CapabilityInvocationRequest): AsyncIterable<CapabilityInvocationEvent> {
    this.invocations.push(frozenCopy(request));
    const reasonCode = this.cancellations.get(request.invocationId);
    if (reasonCode) {
      yield {
        type: "capability.cancelled",
        invocationId: request.invocationId,
        reasonCode,
        occurredAt: this.startedAt,
      };
      return;
    }
    const valid =
      (request.capabilityRef === "restaurant-search" && request.operation === "search") ||
      (request.capabilityRef === "restaurant-reservation" && request.operation === "reserve");
    if (!valid) {
      yield {
        type: "capability.failed",
        invocationId: request.invocationId,
        errorCode: "CAPABILITY_OPERATION_UNSUPPORTED",
        occurredAt: this.startedAt,
      };
      return;
    }
    yield {
      type: "capability.progress",
      invocationId: request.invocationId,
      sequence: 1,
      stage: "deterministic_provider_call",
      progressPermille: 500,
      payloadRef: null,
      occurredAt: this.startedAt,
    };
    if (request.capabilityRef === "restaurant-reservation" && this.reservationResultUnknown) {
      yield {
        type: "capability.result_unknown",
        invocationId: request.invocationId,
        externalActionId: `external:${request.invocationId}`,
        occurredAt: this.completedAt,
      };
      return;
    }
    yield {
      type: "capability.completed",
      invocationId: request.invocationId,
      resultRef: `${request.capabilityRef}-result:${request.invocationId}`,
      occurredAt: this.completedAt,
    };
  }

  async cancel(invocationId: string, reasonCode: string): Promise<void> {
    this.cancellations.set(invocationId, reasonCode);
  }

  observedInvocations(): readonly CapabilityInvocationRequest[] {
    return this.invocations.map(frozenCopy);
  }
}

export class InMemorySecretPort implements SecretPort {
  private readonly handles = new Map<string, SecretHandle>();
  private readonly ids: IdGeneratorPort;
  private readonly failures: FailureScheduler;

  constructor(ids: IdGeneratorPort, failures: FailureScheduler = NO_FAILURES) {
    this.ids = ids;
    this.failures = failures;
  }

  async issueHandle(request: SecretHandleRequest): Promise<SecretHandle> {
    this.failures.checkpoint("secret.issueHandle");
    const handle = frozenCopy({
      ref: this.ids.next("secret-handle"),
      ownerId: request.ownerId,
      agentId: request.agentId,
      runId: request.runId,
      secretRef: request.secretRef,
      secretVersion: request.secretVersion,
      purpose: request.purpose,
      scopeRef: request.scopeRef,
      expiresAt: request.expiresAt,
      revokedAt: null,
    });
    this.handles.set(handle.ref, handle);
    return frozenCopy(handle);
  }

  async inspectHandle(handleRef: string): Promise<SecretHandle | undefined> {
    const handle = this.handles.get(handleRef);
    return handle ? frozenCopy(handle) : undefined;
  }

  async revokeHandle(handleRef: string, revokedAt: string): Promise<SecretHandle> {
    this.failures.checkpoint("secret.revokeHandle");
    const current = this.handles.get(handleRef);
    if (!current) {
      throw new ApplicationPortError(
        PORT_ERROR_CODES.NOT_FOUND,
        `Secret handle ${handleRef} not found`,
        { handleRef },
      );
    }
    const revoked = frozenCopy({ ...current, revokedAt });
    this.handles.set(handleRef, revoked);
    return frozenCopy(revoked);
  }
}

export class ScriptedExternalActionReconciliationPort implements ExternalActionReconciliationPort {
  private readonly results: Readonly<Record<string, ExternalActionReconciliationResult>>;
  private readonly requests: ExternalActionReconciliationRequest[] = [];

  constructor(results: Readonly<Record<string, ExternalActionReconciliationResult>> = {}) {
    this.results = frozenCopy(results);
  }

  async reconcile(
    request: ExternalActionReconciliationRequest,
  ): Promise<ExternalActionReconciliationResult> {
    this.requests.push(frozenCopy(request));
    return frozenCopy(
      this.results[request.externalActionId] ?? {
        outcome: "still_unknown",
        resultRef: null,
        errorCode: null,
      },
    );
  }

  observedRequests(): readonly ExternalActionReconciliationRequest[] {
    return this.requests.map(frozenCopy);
  }
}
