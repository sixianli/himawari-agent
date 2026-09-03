import type {
  AgentAuthorityLease,
  AgentId,
  AuthorityLeaseId,
  OwnerId,
  RunId,
  SessionId,
  ThreadId,
} from "@himawari-agent/domain";
import type { AdmitTriggerCommand } from "@himawari-agent/gateway-contracts";
import type {
  ExecutionV2Event,
  ExecutionV2Request,
  ExecutionV2Response,
} from "@himawari-agent/execution-contracts";
import type { DataClassification, JsonObject, PayloadRef } from "./common.js";

export interface WorkerRunBudget {
  readonly maxDurationMs: number;
  readonly maxCostMicros: number;
  readonly maxProgressEvents: number;
}

export interface WorkerRunRequest {
  readonly workerRunId: string;
  readonly idempotencyKey: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly parentRunId: RunId;
  readonly taskRef: PayloadRef;
  readonly selectedModelRef: string;
  readonly allowedModelRefs: readonly string[];
  readonly outputSchema: JsonObject;
  readonly delegatedContextRefs: readonly PayloadRef[];
  readonly capabilityHandleRefs: readonly string[];
  readonly secretRefs: readonly string[];
  readonly dataClassification: DataClassification;
  readonly budget: WorkerRunBudget;
  readonly deadlineAt: string;
}

export type WorkerRunEvent =
  | {
      readonly type: "worker.progress";
      readonly workerRunId: string;
      readonly sequence: number;
      readonly payloadRef: PayloadRef | null;
      readonly occurredAt: string;
    }
  | {
      readonly type: "worker.completed";
      readonly workerRunId: string;
      readonly resultRef: PayloadRef;
      readonly costMicros: number;
      readonly durationMs: number;
      readonly occurredAt: string;
    }
  | {
      readonly type: "worker.failed";
      readonly workerRunId: string;
      readonly errorCode: string;
      readonly occurredAt: string;
    }
  | {
      readonly type: "worker.result_unknown";
      readonly workerRunId: string;
      readonly externalActionId: string;
      readonly occurredAt: string;
    }
  | {
      readonly type: "worker.cancelled";
      readonly workerRunId: string;
      readonly reasonCode: string;
      readonly occurredAt: string;
    };

export interface WorkerRunPort {
  /** Resume the same logical Worker operation for a stable idempotencyKey. */
  run(request: WorkerRunRequest): AsyncIterable<WorkerRunEvent>;
  cancel(workerRunId: string, reasonCode: string): Promise<void>;
}

export interface ExecutionTransportPort {
  request(message: ExecutionV2Request): Promise<ExecutionV2Response | null>;
  events(afterCursor: string | null): AsyncIterable<ExecutionV2Event>;
}

export interface ScheduledJob {
  readonly id: string;
  readonly revision: number;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId | null;
  readonly payloadRef: PayloadRef;
  readonly sourceProofRef: string;
  readonly dataClassification: DataClassification;
  readonly authorizationRef: string;
  readonly taskScopeRef: string;
  readonly capabilityRef: string;
  readonly operation: string;
  readonly resourceRef: string;
  readonly sideEffect: "none" | "reversible" | "irreversible";
  readonly estimatedCostMicros: number;
  readonly intervalMs: number;
  readonly minimumIntervalMs: number;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly nextRunAt: string;
  readonly occurrence: number;
  readonly status: "active" | "paused" | "cancelled";
}

export type ScheduledJobWrite = Omit<ScheduledJob, "revision">;

export interface SchedulerPort {
  read(jobId: string): Promise<ScheduledJob | undefined>;
  upsert(job: ScheduledJobWrite, expectedRevision: number | null): Promise<ScheduledJob>;
  listDue(at: string, limit: number): Promise<readonly ScheduledJob[]>;
  cancel(jobId: string, expectedRevision: number): Promise<ScheduledJob>;
}

export interface TriggerAdmissionResult {
  readonly resultRef: string;
  readonly replayed: boolean;
}

export interface TriggerAdmissionPort {
  admit(command: AdmitTriggerCommand): Promise<TriggerAdmissionResult>;
}

export interface AttentionCandidate {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly threadId: ThreadId | null;
  readonly resultRef: PayloadRef;
  readonly dataClassification: DataClassification;
  readonly urgency: number;
  readonly confidence: number;
  readonly duplicateKey: string;
  readonly generatedAt: string;
  readonly deviceState: "available" | "unavailable" | "unknown";
  readonly interruptAuthorizationRef: string | null;
}

export interface AttentionDecision {
  readonly candidateId: string;
  readonly level: "SILENT" | "INBOX" | "DIGEST" | "NOTIFY" | "INTERRUPT";
  readonly reasonCode: string;
  readonly interruptAuthorizationRef: string | null;
}

export interface AttentionPort {
  evaluate(candidate: AttentionCandidate): Promise<AttentionDecision>;
}

export type DeliveryLevel = Exclude<AttentionDecision["level"], "SILENT">;

export interface AttentionDecisionRecord {
  readonly candidateId: string;
  readonly candidateFingerprint: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly duplicateKey: string;
  readonly decision: AttentionDecision;
  readonly deliveryRequestId: string | null;
  readonly decidedAt: string;
}

export interface DeliveryRequest {
  readonly id: string;
  readonly revision: number;
  readonly candidateId: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly runId: RunId;
  readonly resultRef: PayloadRef;
  readonly dataClassification: DataClassification;
  readonly level: DeliveryLevel;
  readonly status: "pending" | "delivering" | "delivered";
  readonly assignedClientId: string | null;
  readonly attempts: number;
  readonly acknowledgementRef: string | null;
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type DeliveryRequestWrite = Omit<DeliveryRequest, "revision">;

export interface AttentionPolicyState {
  readonly revision: number;
  readonly decisions: readonly AttentionDecisionRecord[];
}

export interface AttentionDecisionCommit {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly expectedRevision: number;
  readonly record: AttentionDecisionRecord;
  readonly delivery: DeliveryRequestWrite | null;
}

export interface AttentionDecisionCommitResult {
  readonly state: AttentionPolicyState;
  readonly record: AttentionDecisionRecord;
  readonly delivery: DeliveryRequest | null;
}

export interface DeliveryClaim {
  readonly claimed: boolean;
  readonly request: DeliveryRequest;
  readonly reasonCode: "CLAIMED" | "ALREADY_CLAIMED" | "ALREADY_DELIVERED";
}

export interface DeliverySettlement {
  readonly requestId: string;
  readonly expectedRevision: number;
  readonly clientId: string;
  readonly outcome: "delivered" | "unavailable" | "failed";
  readonly acknowledgementRef: string | null;
  readonly errorCode: string | null;
  readonly settledAt: string;
}

export interface AttentionStatePort {
  readPolicyState(ownerId: OwnerId, agentId: AgentId): Promise<AttentionPolicyState>;
  commitDecision(input: AttentionDecisionCommit): Promise<AttentionDecisionCommitResult>;
  readDelivery(requestId: string): Promise<DeliveryRequest | undefined>;
  claimDelivery(requestId: string, clientId: string, claimedAt: string): Promise<DeliveryClaim>;
  settleDelivery(input: DeliverySettlement): Promise<DeliveryRequest>;
}

export interface DeliveryAttempt {
  readonly request: DeliveryRequest;
  readonly clientId: string;
}

export interface DeliveryAttemptResult {
  readonly outcome: "delivered" | "unavailable" | "failed";
  readonly acknowledgementRef: string | null;
  readonly errorCode: string | null;
}

export interface DeliveryPort {
  deliver(input: DeliveryAttempt): Promise<DeliveryAttemptResult>;
}

export interface AuthorityLeaseRecord {
  readonly lease: AgentAuthorityLease;
  readonly fencingToken: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface AuthorityLeasePort {
  claim(lease: AgentAuthorityLease, durationMs: number): Promise<AuthorityLeaseRecord>;
  current(agentId: AgentId): Promise<AuthorityLeaseRecord | undefined>;
  renew(leaseId: AuthorityLeaseId, durationMs: number): Promise<AuthorityLeaseRecord>;
  release(leaseId: AuthorityLeaseId): Promise<void>;
}
