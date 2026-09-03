import type { AgentId, OwnerId, RunId } from "@himawari-agent/domain";
import type { DataClassification, JsonObject, PayloadRef } from "./common.js";

export type SuggestionStatus =
  | "candidate"
  | "delivered"
  | "approved"
  | "rejected"
  | "expired"
  | "superseded";

export interface SuggestionTaskDraft {
  readonly goalRef: PayloadRef;
  readonly trigger: "owner_approved_suggestion";
  readonly capabilityRefs: readonly string[];
  readonly dataClassification: DataClassification;
  readonly estimatedCostMicros: number;
  readonly timezone: string;
  readonly timeoutMs: number;
}

export interface SuggestionCandidate {
  readonly id: string;
  readonly revision: number;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly generationRunId: RunId;
  readonly traceRef: string;
  readonly kind: string;
  readonly titleRef: PayloadRef;
  readonly bodyRef: PayloadRef;
  readonly evidenceRefs: readonly string[];
  readonly sourceWatermark: string;
  readonly goalRef: string | null;
  readonly commitmentRef: string | null;
  readonly taskDraft: SuggestionTaskDraft;
  readonly confidencePermille: number;
  readonly noveltyPermille: number;
  readonly semanticKey: string;
  readonly evidenceFingerprint: string;
  readonly ownerScopeRevision: number;
  readonly estimatedDataClasses: readonly DataClassification[];
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly status: SuggestionStatus;
  readonly deliveryRef: string | null;
  readonly taskRef: string | null;
  readonly taskCreationKey: string | null;
  readonly responseIdempotencyKeys: readonly string[];
}

export interface ReflectionDefinition {
  readonly id: "global-reflection";
  readonly revision: number;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly schedule: string;
  readonly timezone: string;
  readonly dailySuggestionQuota: number;
  readonly maximumContextItems: number;
  readonly maximumCostMicros: number;
  readonly timeoutMs: number;
  readonly maximumCandidates: number;
  readonly enabled: boolean;
}

export interface ReflectionCheckpoint {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly generationRunId: RunId;
  readonly traceRef: string;
  readonly scheduledAt: string;
  readonly inputWatermark: string;
  readonly outcome: "running" | "no_change" | "candidates" | "missed" | "failed";
  readonly candidateRefs: readonly string[];
  readonly costMicros: number;
  readonly attempts: number;
  readonly errorCode: string | null;
  readonly completedAt: string;
  readonly definition: ReflectionDefinition;
  readonly context: {
    readonly inputRef: PayloadRef;
    readonly watermark: string;
    readonly itemCount: number;
  } | null;
  readonly output: Awaited<ReturnType<ReflectionModelPort["reflect"]>> | null;
  readonly claim: {
    readonly id: string;
    readonly generation: number;
    readonly leaseUntil: string;
  } | null;
  readonly reservedCostMicros: number;
}

export interface ProactivityState {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly suggestions: readonly SuggestionCandidate[];
  readonly reflectionDefinition: ReflectionDefinition | null;
  readonly reflectionCheckpoints: readonly ReflectionCheckpoint[];
  readonly quotaOverflowByCivilDay: Readonly<Record<string, number>>;
}

export interface ProactivityStatePort {
  read(ownerId: OwnerId, agentId: AgentId): Promise<{ revision: number; state: ProactivityState }>;
  compareAndSet(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly expectedRevision: number;
    readonly state: ProactivityState;
  }): Promise<{ revision: number; state: ProactivityState }>;
}

export interface SuggestionDeliveryPort {
  enqueue(input: {
    readonly suggestion: SuggestionCandidate;
    readonly idempotencyKey: string;
    readonly resultRef: PayloadRef;
    readonly level: "INBOX";
  }): Promise<string>;
}

export interface SuggestionTaskCreationPort {
  /** Persist one Task per idempotencyKey, including retries after a lost acknowledgement. */
  createOrdinaryTask(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly suggestionId: string;
    readonly draft: SuggestionTaskDraft;
    readonly idempotencyKey: string;
    readonly capabilityHandleRefs: readonly [];
    readonly approvalRefs: readonly [];
  }): Promise<string>;
}

export interface ReflectionContextPort {
  select(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly afterWatermark: string;
    readonly maximumItems: number;
  }): Promise<{
    readonly inputRef: PayloadRef;
    readonly watermark: string;
    readonly itemCount: number;
  }>;
}

export interface ReflectionCandidateDraft {
  readonly kind: string;
  readonly titleRef: PayloadRef;
  readonly bodyRef: PayloadRef;
  readonly evidenceRefs: readonly string[];
  readonly sourceWatermark: string;
  readonly goalRef: string | null;
  readonly commitmentRef: string | null;
  readonly taskDraft: SuggestionTaskDraft;
  readonly confidencePermille: number;
  readonly noveltyPermille: number;
  readonly targetEntity: string;
  readonly proposedAction: string;
  readonly ownerScopeRevision: number;
  readonly estimatedDataClasses: readonly DataClassification[];
  readonly expiresAt: string;
}

export interface ReflectionModelPort {
  /** A stable key identifies one bounded model operation; recovery must return its prior result. */
  reflect(input: {
    readonly idempotencyKey: string;
    readonly contextRef: PayloadRef;
    readonly maximumCandidates: number;
    readonly maximumCostMicros: number;
    readonly timeoutMs: number;
  }): Promise<{
    readonly outcome: "no_change" | "candidates";
    readonly candidates: readonly ReflectionCandidateDraft[];
    readonly costMicros: number;
    readonly metadata: JsonObject;
  }>;
}
