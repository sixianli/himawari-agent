import type { AgentId, OwnerId, ProductAuthorityFence, RunId } from "@himawari-agent/domain";
import type { DataClassification } from "./common.js";
import type { AuthorityFence } from "./persistence.js";
import type { RunExecutionLeaseClaim } from "./run-dispatch.js";

export type ModelInvocationSource = "model-port" | "agent-stream" | "embedding";

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
  readonly logicalSlot: string;
  readonly source: ModelInvocationSource;
  readonly ordinal: number;
  readonly estimatedCostMicros: number;
  readonly pricing: ModelInvocationPricing;
  readonly budgetAccount?: ModelInvocationBudgetAccount;
}

export type ModelInvocationBudgetAccount = "run" | "thread-title";

export interface ModelInvocationPricing {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface ModelInvocationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly reportedCostMicros?: number;
}

export type ModelInvocationUnknownReason =
  | "provider_unresolved"
  | "transport_unresolved"
  | "cancel_unresolved";

export interface ModelInvocationPermit {
  assertActive(): Promise<void>;
  markStarted(): Promise<void>;
  releaseReserved(): Promise<void>;
  settle(usage: ModelInvocationUsage): Promise<void>;
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
  readonly logicalSlot: string;
  readonly sequence: number;
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

export interface ModelInvocationAdmissionPort {
  readonly context: ModelInvocationExecutionContext;
  begin(input: ModelInvocationAdmissionInput): Promise<ModelInvocationAdmissionResult>;
}

export type ModelInvocationAdmissionResolver = (scope: {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly executionLease?: RunExecutionLeaseClaim;
}) => ModelInvocationAdmissionPort | undefined | Promise<ModelInvocationAdmissionPort | undefined>;
