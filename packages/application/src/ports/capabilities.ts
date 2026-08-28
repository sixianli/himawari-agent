import type { AgentId, OwnerId, RunId } from "@himawari-agent/domain";
import type { PermissionAllowDecision } from "./authorization.js";
import type { DataClassification, PayloadRef } from "./common.js";

export interface CapabilityDescriptor {
  readonly ref: string;
  readonly version: string;
  readonly integrity: string;
  readonly lifecycle: "proposed" | "active" | "disabled" | "uninstalled";
  readonly permissionRefs: readonly string[];
  readonly isolation: "trusted_process" | "worker" | "sandbox" | "remote";
}

export interface CapabilityInvocationRequest {
  readonly invocationId: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly capabilityRef: string;
  readonly capabilityHandleRef: string;
  readonly operation: string;
  readonly inputRef: PayloadRef;
  readonly delegatedContextRefs: readonly PayloadRef[];
  readonly secretHandleRefs: readonly string[];
  readonly dataClassification: DataClassification;
}

export type CapabilityInvocationEvent =
  | {
      readonly type: "capability.progress";
      readonly invocationId: string;
      readonly sequence: number;
      readonly stage: string;
      readonly progressPermille: number;
      readonly payloadRef: PayloadRef | null;
      readonly occurredAt: string;
    }
  | {
      readonly type: "capability.completed";
      readonly invocationId: string;
      readonly resultRef: PayloadRef;
      readonly occurredAt: string;
    }
  | {
      readonly type: "capability.failed";
      readonly invocationId: string;
      readonly errorCode: string;
      readonly occurredAt: string;
    }
  | {
      readonly type: "capability.result_unknown";
      readonly invocationId: string;
      readonly externalActionId: string;
      readonly occurredAt: string;
    }
  | {
      readonly type: "capability.cancelled";
      readonly invocationId: string;
      readonly reasonCode: string;
      readonly occurredAt: string;
    };

export interface CapabilityPort {
  list(): Promise<readonly CapabilityDescriptor[]>;
  invoke(request: CapabilityInvocationRequest): AsyncIterable<CapabilityInvocationEvent>;
  cancel(invocationId: string, reasonCode: string): Promise<void>;
}

export type CapabilitySourceType =
  | "builtin"
  | "tool"
  | "skill"
  | "package"
  | "mcp"
  | "program"
  | "remote_api"
  | "adapter";

export interface CapabilityDeclaration {
  readonly ref: string;
  readonly displayName: string;
  readonly version: string;
  readonly source: { readonly type: CapabilitySourceType; readonly locator: string };
  readonly integrity: string;
  readonly operations: readonly string[];
  readonly permissionRefs: readonly string[];
  readonly isolation: CapabilityDescriptor["isolation"];
}

export interface CapabilityScopeManifest {
  readonly dataClassifications: readonly DataClassification[];
  readonly network: readonly string[];
  readonly filesystem: readonly string[];
  readonly secrets: readonly string[];
}

export interface CapabilityManifest extends CapabilityDeclaration {
  readonly manifestVersion: "capability.v2";
  readonly sourceIdentity: string;
  readonly artifact: {
    readonly digest: string;
    readonly signatureStatus: "verified" | "not_applicable" | "invalid" | "unknown";
    readonly signerRef: string | null;
    readonly rollbackArtifactRef: string | null;
  };
  readonly scopes: CapabilityScopeManifest;
  readonly cost: {
    readonly currency: string;
    readonly maxMicrosPerInvocation: number;
  };
  readonly health: {
    readonly status: "healthy" | "degraded" | "unhealthy" | "unknown";
    readonly checkedAt: string | null;
  };
  readonly reviewedBy: string | null;
  readonly reviewedAt: string | null;
  readonly contractCompatibility: readonly string[];
  readonly runtime: CapabilityRuntimeContract;
}

export type CapabilityRuntimeContract =
  | {
      readonly kind: "pi_tool";
      readonly piBuiltinDefinition: "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
    }
  | {
      readonly kind: "pi_resource";
      readonly additionalResourcePaths: readonly string[];
    }
  | {
      readonly kind: "mcp";
      readonly serverIdentity: string;
      readonly transport: string;
      readonly mappedResources: readonly string[];
    }
  | {
      readonly kind: "program";
      readonly argv: readonly string[];
      readonly environmentKeys: readonly string[];
      readonly workdirRef: string;
      readonly stdin: "none" | "protected_payload";
      readonly stdout: "none" | "protected_payload";
      readonly subprocesses: readonly string[];
      readonly network: readonly string[];
      readonly filesystem: readonly string[];
    }
  | {
      readonly kind: "remote_api" | "adapter";
      readonly endpointIdentity: string;
      readonly protectedReferenceOnly: true;
    };

export type CapabilityRegistryLifecycle =
  | "discovered"
  | "review_required"
  | "installation_proposed"
  | "installation_approved"
  | "active"
  | "update_proposed"
  | "update_approved"
  | "disabled"
  | "revoked"
  | "uninstalled";

export interface CapabilityRegistryRecord {
  readonly ref: string;
  readonly revision: number;
  readonly lifecycle: CapabilityRegistryLifecycle;
  readonly declaration: CapabilityDeclaration;
  readonly pendingDeclaration: CapabilityDeclaration | null;
  readonly permissionExpansion: boolean;
  readonly approvalRefs: readonly string[];
  readonly discoveredAt: string;
  readonly updatedAt: string;
}

export interface CapabilityRegistryStorePort {
  create(record: CapabilityRegistryRecord): Promise<CapabilityRegistryRecord>;
  get(capabilityRef: string): Promise<CapabilityRegistryRecord | undefined>;
  list(): Promise<readonly CapabilityRegistryRecord[]>;
  save(
    record: CapabilityRegistryRecord,
    expectedRevision: number,
  ): Promise<CapabilityRegistryRecord>;
  /** Atomically persists a disabling lifecycle and invalidates dependent runtime authority. */
  invalidateCapabilityAuthority?(
    record: CapabilityRegistryRecord,
    expectedRevision: number,
    revokedAt: string,
  ): Promise<CapabilityRegistryRecord>;
}

export interface CapabilitySecretReference {
  readonly secretRef: string;
  readonly secretVersion: string;
  readonly purpose: string;
}

export interface CapabilityExecutionHandle {
  readonly ref: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly capabilityRef: string;
  readonly capabilityVersion: string;
  readonly authorization: PermissionAllowDecision["basis"];
  readonly operations: readonly string[];
  readonly inputRefs: readonly PayloadRef[];
  readonly delegatedContextRefs: readonly PayloadRef[];
  readonly secretRefs: readonly CapabilitySecretReference[];
  readonly maxDataClassification: DataClassification;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface GovernedCapabilityExecutionHandle extends CapabilityExecutionHandle {
  readonly handleVersion: "capability-handle.v2";
  readonly revision: number;
  readonly authorityFence: number;
  readonly operation: string;
  readonly authorizationRef: string;
  readonly maxUses: number;
  readonly uses: number;
  readonly maxTotalCostMicros: number;
  readonly spentCostMicros: number;
  readonly idempotencyKeys: readonly string[];
  readonly workerEndedAt: string | null;
}

export interface ConsumeCapabilityExecutionHandleInput {
  readonly handleRef: string;
  readonly expectedRevision: number;
  readonly authorityFence: number;
  readonly operation: string;
  readonly inputRef: PayloadRef;
  readonly delegatedContextRefs: readonly PayloadRef[];
  readonly secretRefs: readonly string[];
  readonly dataClassification: DataClassification;
  readonly costMicros: number;
  readonly idempotencyKey: string;
  readonly consumedAt: string;
}

export interface CapabilityExecutionHandleStorePort {
  createExecutionHandle(handle: CapabilityExecutionHandle): Promise<CapabilityExecutionHandle>;
  getExecutionHandle(handleRef: string): Promise<CapabilityExecutionHandle | undefined>;
  revokeExecutionHandle(handleRef: string, revokedAt: string): Promise<CapabilityExecutionHandle>;
  consumeExecutionHandle?(
    input: ConsumeCapabilityExecutionHandleInput,
  ): Promise<GovernedCapabilityExecutionHandle>;
  revokeCapabilityHandles?(capabilityRef: string, revokedAt: string): Promise<number>;
  endRunExecutionHandles?(runId: RunId, endedAt: string): Promise<number>;
}

export interface IssueCapabilityExecutionHandleInput {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly capabilityRef: string;
  readonly operation: string;
  readonly permission: PermissionAllowDecision;
  readonly inputRefs: readonly PayloadRef[];
  readonly delegatedContextRefs: readonly PayloadRef[];
  readonly secretRefs: readonly CapabilitySecretReference[];
  readonly expiresAt: string;
}

export interface SecretHandleRequest {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly secretRef: string;
  readonly secretVersion: string;
  readonly purpose: string;
  readonly scopeRef: string;
  readonly expiresAt: string;
}

export interface SecretHandle {
  readonly ref: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly secretRef: string;
  readonly secretVersion: string;
  readonly purpose: string;
  readonly scopeRef: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}

export interface SecretPort {
  issueHandle(request: SecretHandleRequest): Promise<SecretHandle>;
  inspectHandle(handleRef: string): Promise<SecretHandle | undefined>;
  revokeHandle(handleRef: string, revokedAt: string): Promise<SecretHandle>;
}

export interface ExternalActionReconciliationRequest {
  readonly externalActionId: string;
  readonly resultLookupRef: string;
}

export interface ExternalActionReconciliationResult {
  readonly outcome: "confirmed_succeeded" | "confirmed_failed" | "still_unknown";
  readonly resultRef: PayloadRef | null;
  readonly errorCode: string | null;
}

export interface ExternalActionReconciliationPort {
  reconcile(
    request: ExternalActionReconciliationRequest,
  ): Promise<ExternalActionReconciliationResult>;
}
