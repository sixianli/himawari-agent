import type {
  CapabilityExecutionHandleStorePort,
  CapabilityManifest,
  CapabilityRegistryStorePort,
  GovernedCapabilityExecutionHandle,
} from "../ports/capabilities.js";
import { capabilityLifecycleHasActiveAuthority } from "../ports/capabilities.js";
import type { PayloadRef } from "../ports/common.js";
import { ApplicationPortError, PORT_ERROR_CODES } from "../ports/common.js";
import type { ClockPort, IdGeneratorPort } from "../ports/system.js";
import type { AgentId, OwnerId, RunId } from "@himawari-agent/domain";
import type { PermissionAllowDecision } from "../ports/authorization.js";

export interface IssueGovernedCapabilityHandleInput {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly authorityFence: number;
  readonly capabilityRef: string;
  readonly capabilityVersion: string;
  readonly operation: string;
  readonly permission: PermissionAllowDecision;
  readonly inputRefs: readonly PayloadRef[];
  readonly delegatedContextRefs: readonly PayloadRef[];
  readonly secretRefs: readonly {
    readonly secretRef: string;
    readonly secretVersion: string;
    readonly purpose: string;
  }[];
  readonly maxUses: number;
  readonly maxTotalCostMicros: number;
  readonly expiresAt: string;
}

export class CapabilityHandleService {
  private readonly dependencies: {
    readonly store: CapabilityRegistryStorePort & CapabilityExecutionHandleStorePort;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
  };

  constructor(dependencies: {
    readonly store: CapabilityRegistryStorePort & CapabilityExecutionHandleStorePort;
    readonly clock: ClockPort;
    readonly ids: IdGeneratorPort;
  }) {
    this.dependencies = dependencies;
  }

  async issue(
    input: IssueGovernedCapabilityHandleInput,
  ): Promise<GovernedCapabilityExecutionHandle> {
    const record = await this.dependencies.store.get(input.capabilityRef);
    const manifest = record?.declaration as CapabilityManifest | undefined;
    const now = this.dependencies.clock.now();
    if (
      !record ||
      !capabilityLifecycleHasActiveAuthority(record.lifecycle) ||
      !manifest ||
      manifest.manifestVersion !== "capability.v2" ||
      manifest.health.status !== "healthy" ||
      manifest.version !== input.capabilityVersion ||
      !manifest.operations.includes(input.operation) ||
      input.permission.executionScope.capabilityRef !== input.capabilityRef ||
      !input.permission.executionScope.operations.includes(input.operation) ||
      input.inputRefs.length === 0 ||
      input.maxUses < 1 ||
      input.maxTotalCostMicros < 0 ||
      input.authorityFence < 1 ||
      input.expiresAt <= now ||
      input.secretRefs.some(({ secretRef }) => !manifest.scopes.secrets.includes(secretRef))
    )
      this.rejected("Capability Handle scope is not authorized");
    const handle: GovernedCapabilityExecutionHandle = Object.freeze({
      ref: this.dependencies.ids.next("capability-handle"),
      handleVersion: "capability-handle.v2",
      revision: 1,
      ownerId: input.ownerId,
      agentId: input.agentId,
      runId: input.runId,
      authorityFence: input.authorityFence,
      capabilityRef: input.capabilityRef,
      capabilityVersion: input.capabilityVersion,
      authorization: input.permission.basis,
      authorizationRef: input.permission.basis.ref,
      operations: Object.freeze([input.operation]),
      operation: input.operation,
      inputRefs: Object.freeze([...input.inputRefs]),
      delegatedContextRefs: Object.freeze([...input.delegatedContextRefs]),
      secretRefs: Object.freeze(input.secretRefs.map((secret) => Object.freeze({ ...secret }))),
      maxDataClassification: input.permission.executionScope.maxDataClassification,
      maxUses: input.maxUses,
      uses: 0,
      maxTotalCostMicros: input.maxTotalCostMicros,
      spentCostMicros: 0,
      idempotencyKeys: Object.freeze([]),
      issuedAt: now,
      expiresAt: input.expiresAt,
      revokedAt: null,
      workerEndedAt: null,
    });
    return this.dependencies.store.createExecutionHandle(
      handle,
    ) as Promise<GovernedCapabilityExecutionHandle>;
  }

  async endRun(runId: RunId): Promise<number> {
    if (!this.dependencies.store.endRunExecutionHandles) {
      this.rejected("Capability Handle store cannot invalidate authority at Run end");
    }
    return this.dependencies.store.endRunExecutionHandles(runId, this.dependencies.clock.now());
  }

  private rejected(message: string): never {
    throw new ApplicationPortError(PORT_ERROR_CODES.HANDLE_REVOKED, message);
  }
}
