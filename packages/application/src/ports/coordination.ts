import type {
  AgentAuthorityLease,
  AgentId,
  AuthorityLeaseId,
  OwnerId,
  RunId,
  ThreadId,
} from "@himawari-agent/domain";
import type { AdmitTriggerCommand } from "@himawari-agent/gateway-contracts";
import type { DataClassification, PayloadRef } from "./common.js";

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
  run(request: WorkerRunRequest): AsyncIterable<WorkerRunEvent>;
  cancel(workerRunId: string, reasonCode: string): Promise<void>;
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
  readonly status: "active" | "cancelled";
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
  readonly resultRef: PayloadRef;
  readonly dataClassification: DataClassification;
  readonly urgency: number;
  readonly confidence: number;
  readonly duplicateKey: string;
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
