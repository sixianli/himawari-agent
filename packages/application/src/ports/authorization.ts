import type { AgentId, IdempotencyKey, OwnerId, RunId } from "@himawari-agent/domain";
import type { DataClassification } from "./common.js";

export type PermissionDecisionKind = "ALLOW" | "ASK" | "DENY";
export type ActionSideEffect = "none" | "reversible" | "irreversible";
export const ACTION_KINDS = Object.freeze([
  "READ",
  "CREATE_OR_UPDATE",
  "DELETE",
  "COMMUNICATE",
  "PURCHASE_OR_FUNDS",
  "CREDENTIAL_OR_ACCESS",
  "PRODUCTION_OR_RECOVERY",
  "PUBLICATION",
  "LEGAL_COMMITMENT",
  "PHYSICAL_SAFETY",
  "INSTALL_OR_EXECUTE_CODE",
] as const);
export type ActionKind = (typeof ACTION_KINDS)[number];
export const ACTION_RISK_LEVELS = Object.freeze(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const);
export type ActionRiskLevel = (typeof ACTION_RISK_LEVELS)[number];
export type DisclosureMode = "none" | "same_owner" | "named_recipients" | "public";

export interface ActionTarget {
  readonly type: string;
  readonly ref: string;
}

export interface DeterministicPolicyFact {
  readonly code: string;
  readonly minimumRisk: ActionRiskLevel;
  readonly source: "product" | "manifest" | "runtime";
}

export interface ActionFrequency {
  readonly count: number;
  readonly intervalMs: number | null;
}

export interface ActionIntent {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly capabilityRef: string;
  readonly operation: string;
  readonly resourceRef: string;
  readonly dataClassification: DataClassification;
  readonly sideEffect: ActionSideEffect;
  readonly estimatedCostMicros: number;
  readonly frequency: ActionFrequency;
  readonly idempotencyKey: IdempotencyKey;
  readonly reversible: boolean;
  readonly requestedAt: string;
}

/** Strict v0.2 action contract. Foundation ActionIntent remains execution.v1 compatible. */
export interface GovernedActionIntent extends ActionIntent {
  readonly contractVersion: "authorization.v2";
  readonly threadId: string;
  readonly actionKind: ActionKind;
  readonly capabilityVersion: string;
  readonly targets: readonly ActionTarget[];
  readonly resourceRefs: readonly string[];
  readonly disclosure: DisclosureMode;
  readonly recipients: readonly string[];
  readonly credentialOrAccessChange: boolean;
  readonly expiresAt: string;
  readonly modelClassification: {
    readonly actionKind: ActionKind;
    readonly suggestedRisk: ActionRiskLevel;
    readonly reasonCode: string;
  };
  readonly deterministicFacts: readonly DeterministicPolicyFact[];
  readonly finalRisk: ActionRiskLevel;
}

export interface PermissionPolicyRule {
  readonly id: string;
  readonly effect: "ALLOW" | "DENY";
  readonly capabilityRefs: readonly string[];
  readonly operations: readonly string[];
  readonly resourcePrefixes: readonly string[];
  readonly dataClassifications: readonly DataClassification[];
  readonly sideEffects: readonly ActionSideEffect[];
  readonly maxCostMicros: number;
  readonly reasonCode: string;
}

/** Host-owned review outcome. It reports what the coordinator durably committed; it is never an
 * execution grant, and "alternative" carries untrusted text that can only seed a new request.
 * A coordinator that only persists its decision may resolve to `undefined`; absence is never
 * an approval. */
export type AutomaticReviewOutcome =
  | { readonly decision: "approve" | "deny" | "human" }
  | {
      readonly decision: "alternative";
      readonly reasonCode: string;
      readonly suggestionRef: string | null;
    };

/** Host-owned review coordinator, not an untrusted model response or execution grant.
 * It may persist a validated decision through the original Approval/Grant boundary.
 * Apply only while the signal, request deadline and delegated policy remain current;
 * repeated or late results must never overwrite another decision or repeat execution.
 * A missing or unreadable outcome leaves the original human/deny path untouched.
 * A coordinator that persists nothing returns undefined: absence is never an approval. */
export interface AutomaticActionReviewPort {
  readonly maximumWaitMs: number;
  review(
    input: {
      readonly intent: GovernedActionIntent;
      readonly policyVersion: string;
      readonly deadlineAt: string;
      readonly approvalExpiresAt: string;
    },
    signal: AbortSignal,
  ): Promise<AutomaticReviewOutcome | undefined>;
}

export interface PermissionPolicy {
  readonly version: string;
  readonly rules: readonly PermissionPolicyRule[];
}

export interface GrantScope {
  readonly capabilityRef: string;
  readonly operations: readonly string[];
  readonly exactResourceRef: string | null;
  readonly resourcePrefixes: readonly string[];
  readonly maxDataClassification: DataClassification;
  readonly sideEffects: readonly ActionSideEffect[];
  readonly maxCostMicrosPerUse: number;
  readonly maxFrequency: ActionFrequency;
}

export interface LongTermGrantScope {
  readonly capabilityRef: string;
  readonly operations: readonly string[];
  readonly resourcePrefixes: readonly string[];
  readonly maxDataClassification: DataClassification;
  readonly sideEffects: readonly ActionSideEffect[];
  readonly maxCostMicrosPerUse: number;
  readonly maxFrequency: ActionFrequency;
  readonly maxTotalCostMicros: number;
  readonly maxUses: number;
  readonly expiresAt: string;
}

export interface GrantRecord {
  readonly id: string;
  readonly revision: number;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly kind: "one_time" | "long_term";
  readonly scope: GrantScope;
  readonly intentFingerprint: string | null;
  readonly sourceApprovalRequestId: string;
  readonly validFrom: string;
  readonly expiresAt: string;
  readonly maxUses: number;
  readonly uses: number;
  readonly maxTotalCostMicros: number;
  readonly spentCostMicros: number;
  readonly revokedAt: string | null;
  readonly revocationReasonCode: string | null;
}

export interface ApprovalRequest {
  readonly automaticReview?: {
    readonly reviewId: string;
    readonly configurationVersion: string;
    readonly modelRef: string;
    readonly outputRef: string;
  };
  /** A durable Owner policy decision, never a claim of a per-action human click. */
  readonly policyAuthorization?: { readonly key: string; readonly revision: number };
  readonly id: string;
  readonly revision: number;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly intentId: string;
  readonly intentSnapshot: ActionIntent;
  readonly semanticSnapshotHash: string;
  readonly status: "pending" | "approved" | "denied" | "expired";
  readonly deliveryState: "deliverable" | "queued_no_ui";
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
  readonly grantId: string | null;
}

export interface GovernedApprovalRequest extends ApprovalRequest {
  readonly intentSnapshot: GovernedActionIntent;
  readonly finalRisk: ActionRiskLevel;
  readonly recentAuthenticationRequired: boolean;
  readonly recentAuthenticationRef: string | null;
}

export interface ResolveApprovalInput {
  readonly approvalRequestId: string;
  readonly expectedRevision: number;
  readonly semanticSnapshotHash: string;
  readonly resolution: "approved" | "denied" | "expired";
  readonly decidedAt: string;
  readonly grant: GrantRecord | null;
  readonly recentAuthenticationRef?: string | null;
}

export interface ConsumeGrantInput {
  readonly grantId: string;
  readonly expectedRevision: number;
  readonly costMicros: number;
  readonly consumedAt: string;
  /** Stable per-intent usage identity. Stores use it to make retries idempotent. */
  readonly usageId?: string;
  /** Frozen ActionIntent identity used as the durable Trace causation. */
  readonly intentId?: string;
  readonly runId?: RunId;
  readonly operation?: string;
}

export interface GovernedGrantScope extends GrantScope {
  readonly capabilityVersion: string;
  readonly resourceIdentities: readonly string[];
  readonly disclosure: DisclosureMode;
  readonly recipients: readonly string[];
  readonly credentialOrAccessChange: false;
}

export interface GovernedGrantRecord extends GrantRecord {
  readonly scope: GovernedGrantScope;
  readonly intentFingerprint: string | null;
}

export interface AuthorizationReservation {
  readonly id: string;
  readonly grantId: string;
  readonly intent: GovernedActionIntent;
  readonly semanticSnapshotHash: string;
  readonly status: "reserved" | "committed" | "released";
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly handleRef: string | null;
  readonly invocationRef: string | null;
  readonly resolvedAt: string | null;
  readonly reasonCode: string | null;
}

export interface ReserveAuthorizationInput {
  readonly grantId: string;
  readonly intent: GovernedActionIntent;
  readonly now: string;
}

export interface AuthorizationStorePort {
  getAuthorizationReservation?(id: string): Promise<AuthorizationReservation | undefined>;
  reserveAuthorization?(input: ReserveAuthorizationInput): Promise<AuthorizationReservation>;
  releaseAuthorization?(input: {
    readonly reservationId: string;
    readonly now: string;
    readonly reasonCode: string;
  }): Promise<AuthorizationReservation>;
  isPolicyAuthorizationCurrent?(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    key: string;
    revision: number;
  }): Promise<boolean>;
  createApproval(request: ApprovalRequest): Promise<ApprovalRequest>;
  findApprovalByIntent(intentId: string): Promise<ApprovalRequest | undefined>;
  getApproval(approvalRequestId: string): Promise<ApprovalRequest | undefined>;
  listApprovals(ownerId: OwnerId, agentId: AgentId): Promise<readonly ApprovalRequest[]>;
  resolveApproval(input: ResolveApprovalInput): Promise<ApprovalRequest>;
  listGrants(ownerId: OwnerId, agentId: AgentId): Promise<readonly GrantRecord[]>;
  consumeGrant(input: ConsumeGrantInput): Promise<GrantRecord>;
  revokeGrant(
    grantId: string,
    revokedAt: string,
    reasonCode: string,
    expectedRevision?: number,
  ): Promise<GrantRecord>;
}

export interface PermissionAllowDecision {
  /** Local durable reservation; it is never a Worker-authority wire credential. */
  readonly authorizationReservation?: {
    readonly id: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  };
  readonly decision: "ALLOW";
  readonly basis: { readonly type: "policy" | "grant"; readonly ref: string };
  readonly executionScope: GrantScope;
}

export interface PermissionAskDecision {
  readonly decision: "ASK";
  readonly approvalRequest: ApprovalRequest;
}

export interface PermissionDenyDecision {
  readonly decision: "DENY";
  readonly reasonCode: string;
  readonly alternativesAllowed: boolean;
  /** Set only when a host review coordinator durably recorded a safer alternative for this
   * exact request. The referenced text is untrusted and may only seed a new request. */
  readonly automaticReview?: {
    readonly outcome: "alternative";
    readonly reasonCode: string;
    readonly suggestionRef: string | null;
  };
}

export type PermissionDecision =
  | PermissionAllowDecision
  | PermissionAskDecision
  | PermissionDenyDecision;
