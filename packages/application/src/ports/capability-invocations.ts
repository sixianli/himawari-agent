import type { AgentId, OwnerId, ProductAuthorityFence, RunId } from "@himawari-agent/domain";
import type { PermissionAllowDecision } from "./authorization.js";
import type { CapabilityResourceCeiling, CapabilitySecretReference } from "./capabilities.js";
import type { DataClassification, PayloadRef } from "./common.js";
import type { AuthorityFence } from "./persistence.js";

/**
 * Authority and process identities captured for the first trusted dispatch.
 * Worker/Agent boot identities are an attempt binding, not semantic replay data.
 */
export interface CapabilityInvocationAuthority {
  readonly product: ProductAuthorityFence;
  readonly lease: AuthorityFence;
  readonly agentServiceInstanceId: string;
  readonly agentServiceBootId: string;
  readonly workerInstanceId: string;
  readonly workerBootId: string;
}

export interface ConsumeCapabilityInvocationInput {
  /** Candidate receipt id. It is ignored when an equivalent receipt already exists. */
  readonly receiptRef: string;
  readonly handleRef: string;
  /** Current execution.v2 work.execute messageId. */
  readonly invocationId: string;
  /** Untrusted work.execute scope, checked against the scoped adapter and Handle. */
  readonly requestScope: {
    readonly deploymentId: string;
    readonly authorityEpoch: number;
    readonly fencingToken: number;
    readonly ownerId: string;
    readonly agentId: string;
    readonly runId: string;
    readonly workerRunId: string;
  };
  /** Untrusted work.execute capability identity, checked against the Handle. */
  readonly capabilityRef: string;
  readonly capabilityVersion: string;
  /** Nullable on low-risk requests; a non-null value must match the Handle. */
  readonly authorizationRef: string | null;
  /** The original request key; the work.delegate suffix is not used here. */
  readonly idempotencyKey: string;
  readonly operation: string;
  readonly inputRef: PayloadRef;
  readonly delegatedContextRefs: readonly PayloadRef[];
  readonly secretRefs: readonly CapabilitySecretReference[];
  readonly dataClassification: DataClassification;
  readonly resourceCeiling: CapabilityResourceCeiling;
  readonly requestedAt: string;
  readonly deadlineAt: string;
  readonly authority: CapabilityInvocationAuthority;
  readonly consumedAt: string;
}

export interface ReadCapabilityInvocationInput {
  readonly handleRef: string;
  readonly invocationId: string;
  readonly authority: CapabilityInvocationAuthority;
  readonly now: string;
}

export interface FrozenCapabilityInvocationReceipt {
  readonly receiptVersion: "capability-invocation.v1";
  readonly receiptRef: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly handleRef: string;
  /** Revision after the durable Handle was consumed. */
  readonly handleRevision: number;
  readonly invocationId: string;
  readonly workerRunId: string;
  readonly idempotencyKey: string;
  readonly capabilityRef: string;
  readonly capabilityVersion: string;
  readonly authorization: PermissionAllowDecision["basis"];
  readonly authorizationRef: string;
  readonly operation: string;
  readonly inputRef: PayloadRef;
  readonly delegatedContextRefs: readonly PayloadRef[];
  readonly secretRefs: readonly CapabilitySecretReference[];
  readonly dataClassification: DataClassification;
  readonly resourceCeiling: CapabilityResourceCeiling;
  readonly requestedAt: string;
  readonly deadlineAt: string;
  readonly effectiveExpiresAt: string;
  readonly authority: CapabilityInvocationAuthority;
  readonly semanticFingerprint: string;
  readonly consumedAt: string;
}

export interface CapabilityInvocationConsumeResult {
  readonly replayed: boolean;
  readonly receipt: FrozenCapabilityInvocationReceipt;
}

/**
 * Agent-scoped durable authority. ownerId/agentId are bound by the adapter,
 * never supplied by an isolated Worker request.
 */
export interface CapabilityInvocationReceiptPort {
  consume(input: ConsumeCapabilityInvocationInput): Promise<CapabilityInvocationConsumeResult>;
  /** Read path for a trusted Agent Payload handler; it revalidates live authority. */
  read(
    input: ReadCapabilityInvocationInput,
  ): Promise<FrozenCapabilityInvocationReceipt | undefined>;
}
