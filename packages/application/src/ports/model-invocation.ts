import type { AgentId, OwnerId, ProductAuthorityFence, RunId } from "@himawari-agent/domain";
import type { DataClassification } from "./common.js";
import type { ModelBudgetLimits } from "./model-budget.js";
import type { AuthorityFence } from "./persistence.js";
import type { RunExecutionLeaseClaim } from "./run-dispatch.js";

/** Product paths that can cause a physical provider request. */
export type ModelInvocationSource = "model-port" | "agent-stream" | "embedding";

/**
 * Execution identity captured by Core when it creates an admission gate.
 *
 * The lease claim is intentionally carried by the gate rather than reconstructed
 * from RuntimeRequest.budget or an invocation request. The gate implementation
 * must re-check this identity and cancellation at each lifecycle transition.
 */
export interface ModelInvocationExecutionContext {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly executionLease: RunExecutionLeaseClaim;
}

export interface ModelInvocationAdmissionInput {
  readonly modelRef: string;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string | null;
  readonly dataClassification: DataClassification;
  /** Stable logical slot; never derive this from prompt text or an in-memory ordinal. */
  readonly logicalSlot: string;
  readonly source: ModelInvocationSource;
  /** 1-based ordinal for physical streams within the source execution. */
  readonly ordinal: number;
  readonly estimatedCostMicros: number;
  /** Frozen descriptor pricing, expressed in USD per million tokens. */
  readonly pricing: ModelInvocationPricing;
}

export interface ModelInvocationPricing {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface ModelInvocationUsage {
  /** Total provider prompt tokens, including cacheReadTokens/cacheWriteTokens. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export type ModelInvocationUnknownReason =
  | "provider_unresolved"
  | "transport_unresolved"
  | "cancel_unresolved";

export interface ModelInvocationPermit {
  /** Re-check authority, active lease and cancellation before secret access. */
  assertActive(): Promise<void>;
  /** Mark the allocation started immediately before entering the Pi stream. */
  markStarted(): Promise<void>;
  /**
   * Release a reservation when the provider stream has not started.
   * Implementations must make started/unknown/settled allocations fail closed
   * without changing their execution history.
   */
  releaseReserved(): Promise<void>;
  /** Settle from verified usage and the frozen descriptor price captured at begin. */
  settle(usage: ModelInvocationUsage): Promise<void>;
  /** Preserve uncertainty when a started stream has no trusted terminal usage. */
  markUnknown(reasonCode: ModelInvocationUnknownReason): Promise<void>;
}

export type ModelInvocationIdentityStatus =
  | "reserved"
  | "started"
  | "unknown"
  | "settled"
  | "released";

export interface ModelInvocationIdentity {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  /** Stable logical slot selected by the Core checkpoint owner. */
  readonly logicalSlot: string;
  /** Durable per-slot physical attempt sequence, starting at one. */
  readonly sequence: number;
  /** Stable identity for this physical attempt. */
  readonly invocationId: string;
  readonly modelRef: string;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string | null;
  readonly dataClassification: DataClassification;
  readonly source: ModelInvocationSource;
  readonly ordinal: number;
  readonly pricing: ModelInvocationPricing;
  readonly pricingFingerprint: string;
  readonly estimatedCostMicros: number;
  readonly budgetAccountId: string;
  readonly budgetOperationKey: string;
  /** Product authority and execution claim frozen at first reservation. */
  readonly authority: ProductAuthorityFence;
  readonly authorityLease: AuthorityFence;
  readonly executionLease: RunExecutionLeaseClaim;
  readonly status: ModelInvocationIdentityStatus;
  readonly reservedAt: string;
  readonly startedAt: string | null;
  readonly observedAt: string | null;
  readonly settledAt: string | null;
  readonly releasedAt: string | null;
  readonly actualCostMicros: number | null;
  readonly reasonCode: ModelInvocationUnknownReason | null;
}

export type ModelInvocationIdentityBlockReason =
  | "MODEL_INVOCATION_IDENTITY_CONFLICT"
  | "MODEL_INVOCATION_RECONCILIATION_REQUIRED";

export type ModelInvocationIdentityBeginResult =
  | { readonly disposition: "fresh"; readonly identity: ModelInvocationIdentity }
  | {
      readonly disposition: "replay";
      readonly identity: ModelInvocationIdentity;
      readonly reasonCode: "MODEL_INVOCATION_RECONCILIATION_REQUIRED";
    }
  | {
      readonly disposition: "blocked";
      readonly reasonCode: ModelInvocationIdentityBlockReason;
      readonly details?: Readonly<Record<string, string>>;
    };

export interface ModelInvocationIdentityBeginInput extends ModelInvocationAdmissionInput {
  readonly runId: RunId;
  readonly executionLease: RunExecutionLeaseClaim;
  readonly authority: ProductAuthorityFence;
  readonly authorityLease: AuthorityFence;
  readonly limits: ModelBudgetLimits;
  readonly reservedAt: string;
}

export interface ModelInvocationIdentityTransitionInput {
  readonly runId: RunId;
  readonly invocationId: string;
  readonly budgetOperationKey: string;
  readonly executionLease: RunExecutionLeaseClaim;
  readonly at: string;
}

export interface ModelInvocationIdentityStartedInput
  extends ModelInvocationIdentityTransitionInput {
  readonly executionLease: RunExecutionLeaseClaim;
}

export interface ModelInvocationIdentitySettlementInput
  extends ModelInvocationIdentityTransitionInput {
  readonly actualCostMicros: number;
}

export interface ModelInvocationIdentityUnknownInput
  extends ModelInvocationIdentityTransitionInput {
  readonly reasonCode: ModelInvocationUnknownReason;
}

export interface ModelInvocationIdentityPort {
  begin(input: ModelInvocationIdentityBeginInput): Promise<ModelInvocationIdentityBeginResult>;
  markStarted(input: ModelInvocationIdentityStartedInput): Promise<ModelInvocationIdentity>;
  releaseReserved(input: ModelInvocationIdentityTransitionInput): Promise<ModelInvocationIdentity>;
  settle(input: ModelInvocationIdentitySettlementInput): Promise<ModelInvocationIdentity>;
  markUnknown(input: ModelInvocationIdentityUnknownInput): Promise<ModelInvocationIdentity>;
  read(input: {
    readonly runId: RunId;
    readonly invocationId: string;
  }): Promise<ModelInvocationIdentity | undefined>;
}

export type ModelInvocationAdmissionResult =
  | {
      readonly disposition: "fresh";
      readonly identity: ModelInvocationIdentity;
      readonly permit: ModelInvocationPermit;
    }
  | {
      readonly disposition: "replay";
      readonly identity: ModelInvocationIdentity;
      readonly reasonCode: "MODEL_INVOCATION_RECONCILIATION_REQUIRED";
    }
  | {
      readonly disposition: "blocked";
      readonly reasonCode: ModelInvocationIdentityBlockReason;
      readonly details?: Readonly<Record<string, string>>;
    };

/**
 * A gate is created by the execution owner from a typed lease claim. Its
 * context is immutable so a caller cannot select a different Run after reserve.
 */
export interface ModelInvocationAdmissionPort {
  readonly context: ModelInvocationExecutionContext;
  begin(input: ModelInvocationAdmissionInput): Promise<ModelInvocationAdmissionResult>;
}

export type ModelInvocationAdmissionResolver = (scope: {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  /** Present for AgentRuntime calls; ModelPort callers have no runtime lease field. */
  readonly executionLease?: RunExecutionLeaseClaim;
}) => ModelInvocationAdmissionPort | undefined | Promise<ModelInvocationAdmissionPort | undefined>;
