import type {
  AgentAuthorityLease,
  AgentId,
  AuthorityLeaseId,
  IdempotencyKey,
  OwnerId,
  RunId,
} from "@himawari-agent/domain";
import type { DataClassification, PayloadRef } from "./common.js";

export interface ScheduledJob {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly triggerRef: string;
  readonly idempotencyKey: IdempotencyKey;
  readonly nextRunAt: string;
  readonly status: "active" | "cancelled";
}

export interface SchedulerPort {
  upsert(job: ScheduledJob): Promise<ScheduledJob>;
  listDue(at: string, limit: number): Promise<readonly ScheduledJob[]>;
  cancel(jobId: string): Promise<ScheduledJob>;
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
