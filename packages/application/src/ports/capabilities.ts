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

export type CapabilitySourceType = "builtin" | "package" | "mcp" | "remote_api";

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

export type CapabilityRegistryLifecycle =
  | "discovered"
  | "installation_proposed"
  | "installation_approved"
  | "active"
  | "update_proposed"
  | "update_approved"
  | "disabled"
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

export interface CapabilityExecutionHandleStorePort {
  createExecutionHandle(handle: CapabilityExecutionHandle): Promise<CapabilityExecutionHandle>;
  getExecutionHandle(handleRef: string): Promise<CapabilityExecutionHandle | undefined>;
  revokeExecutionHandle(handleRef: string, revokedAt: string): Promise<CapabilityExecutionHandle>;
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
