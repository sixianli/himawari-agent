import type {
  AgentId,
  OccurrenceId,
  OwnerId,
  ProductDataClassification,
  ProductAuthorityFence,
  RunId,
} from "@himawari-agent/domain";
import type { DataClassification } from "./common.js";
import type { AuthorityFence } from "./persistence.js";
import type { RunExecutionLeaseClaim } from "./run-dispatch.js";

export type ModelBudgetAccountParent =
  | { readonly kind: "run"; readonly runId: RunId }
  | { readonly kind: "occurrence"; readonly occurrenceId: OccurrenceId };

export type ModelBudgetActiveParent =
  | {
      readonly kind: "run";
      readonly runId: RunId;
      readonly executionLease: RunExecutionLeaseClaim;
    }
  | {
      readonly kind: "occurrence";
      readonly occurrenceId: OccurrenceId;
      readonly expectedRevision: number;
      readonly workLeaseId: string;
      readonly workLeaseHolderId: string;
    };

export interface ModelBudgetScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly authority: ProductAuthorityFence;
  readonly authorityLease: AuthorityFence;
}

export interface ModelBudgetLimits {
  readonly accountCostMicros: number;
  readonly globalCostMicros: number;
  readonly perClassificationCostMicros: Readonly<Record<DataClassification, number>>;
}

export interface ModelBudgetAllocationIdentity {
  readonly parent: ModelBudgetAccountParent;
  readonly operationKey: string;
}

export interface ModelBudgetReserveInput {
  readonly parent: ModelBudgetActiveParent;
  readonly operationKey: string;
  readonly modelRef: string;
  readonly dataClassification: ProductDataClassification;
  readonly estimatedCostMicros: number;
  readonly limits: ModelBudgetLimits;
  readonly reservedAt: string;
}

export interface ModelBudgetMarkStartedInput {
  readonly parent: ModelBudgetActiveParent;
  readonly operationKey: string;
  readonly startedAt: string;
}

export interface ModelBudgetSettlementInput extends ModelBudgetAllocationIdentity {
  readonly actualCostMicros: number;
  readonly settledAt: string;
}

export interface ModelBudgetUnknownInput extends ModelBudgetAllocationIdentity {
  readonly observedAt: string;
  readonly reasonCode: "provider_unresolved" | "transport_unresolved" | "cancel_unresolved";
}

export interface ModelBudgetFinalizeInput {
  readonly parent: Extract<ModelBudgetAccountParent, { readonly kind: "run" }>;
  readonly finalizedAt: string;
}

export type ModelBudgetAllocationStatus =
  | "reserved"
  | "started"
  | "unknown"
  | "settled"
  | "released";
export type ModelBudgetAccountStatus = "active" | "reconcile_required" | "over_budget";

export interface ModelBudgetAccount {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly accountId: string;
  readonly parent: ModelBudgetAccountParent;
  readonly dataClassification: ProductDataClassification;
  readonly reservedCostMicros: number;
  readonly spentCostMicros: number;
  readonly status: ModelBudgetAccountStatus;
  readonly revision: number;
}

export interface ModelBudgetAllocation {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly accountId: string;
  readonly operationKey: string;
  readonly modelRef: string;
  readonly dataClassification: ProductDataClassification;
  readonly estimatedCostMicros: number;
  readonly actualCostMicros: number | null;
  readonly status: ModelBudgetAllocationStatus;
  readonly reservedAt: string;
  readonly startedAt: string | null;
  readonly observedAt: string | null;
  readonly settledAt: string | null;
  readonly reasonCode: "provider_unresolved" | "transport_unresolved" | "cancel_unresolved" | null;
}

export interface ModelBudgetSnapshot {
  readonly account: ModelBudgetAccount;
  readonly allocations: readonly ModelBudgetAllocation[];
  readonly nextOperationKey: string | null;
}

export interface ModelBudgetOperationResult {
  readonly account: ModelBudgetAccount;
  readonly allocation: ModelBudgetAllocation;
  readonly replayed: boolean;
}

export interface ModelBudgetReadInput {
  readonly parent: ModelBudgetAccountParent;
  readonly limit: number;
  readonly afterOperationKey?: string | null;
}

export interface ModelBudgetPort {
  read(input: ModelBudgetReadInput): Promise<ModelBudgetSnapshot | undefined>;
  reserve(input: ModelBudgetReserveInput): Promise<ModelBudgetOperationResult>;
  markStarted(input: ModelBudgetMarkStartedInput): Promise<ModelBudgetOperationResult>;
  settle(input: ModelBudgetSettlementInput): Promise<ModelBudgetOperationResult>;
  markUnknown(input: ModelBudgetUnknownInput): Promise<ModelBudgetOperationResult>;
  finalize(input: ModelBudgetFinalizeInput): Promise<ModelBudgetAccount>;
}
