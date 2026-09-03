import type { AgentId, OwnerId, RunId } from "@himawari-agent/domain";
import type { AutonomyScope, DataClassification, JsonObject, PayloadRef } from "./common.js";

export interface DelegationBudget {
  readonly maximumDurationMs: number;
  readonly maximumCostMicros: number;
  readonly maximumProgressEvents: number;
}

export interface Delegation {
  readonly id: string;
  readonly revision: number;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly parentRunId: RunId;
  readonly traceRef: string;
  readonly workerRunId: string;
  readonly subtaskRef: PayloadRef;
  readonly outputSchema: JsonObject;
  readonly contextRefs: readonly PayloadRef[];
  readonly capabilityHandleRefs: readonly string[];
  readonly allowedModelRefs: readonly string[];
  readonly selectedModelRef: string;
  readonly dataClassification: DataClassification;
  readonly budget: DelegationBudget;
  readonly progressEventsObserved: number;
  readonly progressReceipts: readonly { readonly sequence: number; readonly fingerprint: string }[];
  readonly executionGeneration: number;
  readonly executionClaim: { readonly id: string; readonly leaseUntil: string } | null;
  readonly pendingResultRef: PayloadRef | null;
  readonly handlesEndedAt: string | null;
  readonly workerCancelledAt: string | null;
  readonly deadlineAt: string;
  readonly depth: 1;
  readonly status: "created" | "running" | "validating" | "completed" | "failed" | "cancelled";
  readonly proposalRef: PayloadRef | null;
  readonly failureReasonCode: string | null;
  readonly workerResult: WorkerResult | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WorkerResult {
  readonly workerRunId: string;
  readonly conclusionRef: PayloadRef;
  readonly citationRefs: readonly string[];
  readonly artifactRefs: readonly string[];
  readonly unresolvedRefs: readonly string[];
  readonly actualModelRef: string;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly costMicros: number;
  readonly durationMs: number;
  readonly executionRecordRefs: readonly string[];
  readonly dataClassification: DataClassification;
  readonly output: JsonObject;
}

export interface DelegationStatePort {
  read(scope: AutonomyScope, delegationId: string): Promise<Delegation | undefined>;
  list(ownerId: OwnerId, agentId: AgentId): Promise<readonly Delegation[]>;
  create(delegation: Delegation): Promise<Delegation>;
  save(delegation: Delegation, expectedRevision: number): Promise<Delegation>;
}

export interface DelegationHandleLifecyclePort {
  endHandles(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly parentRunId: RunId;
    readonly handleRefs: readonly string[];
    readonly endedAt: string;
  }): Promise<void>;
}

export interface DelegationProposalPort {
  protectScopeExpansion(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly parentRunId: RunId;
    readonly requestedContextRefs: readonly PayloadRef[];
    readonly requestedCapabilityHandleRefs: readonly string[];
    readonly requestedModelRefs: readonly string[];
    readonly requestedCostMicros: number;
    readonly requestedRecipientRef: string | null;
  }): Promise<PayloadRef>;
}

export interface WorkerResultReaderPort {
  read(resultRef: PayloadRef): Promise<WorkerResult>;
}

export interface WorkerResultVerificationPort {
  /** Validate output against delegation.outputSchema as well as provenance and citations. */
  verify(input: { readonly delegation: Delegation; readonly result: WorkerResult }): Promise<{
    readonly valid: boolean;
    readonly conflictRefs: readonly string[];
    readonly invalidCitationRefs: readonly string[];
    readonly reasonCode: string | null;
  }>;
}
