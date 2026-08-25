import type { AgentId, OwnerId, RunId } from "@himawari-agent/domain";
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
  readonly secretHandleRefs: readonly string[];
  readonly dataClassification: DataClassification;
}

export type CapabilityInvocationEvent =
  | {
      readonly type: "capability.progress";
      readonly invocationId: string;
      readonly sequence: number;
      readonly progressPermille: number;
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
    };

export interface CapabilityPort {
  list(): Promise<readonly CapabilityDescriptor[]>;
  invoke(request: CapabilityInvocationRequest): AsyncIterable<CapabilityInvocationEvent>;
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
