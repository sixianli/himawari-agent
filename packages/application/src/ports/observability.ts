import type { AgentId, OwnerId, RunId, SessionId, ThreadId, TurnId } from "@himawari-agent/domain";
import type {
  CausationId,
  CorrelationId,
  DataClassification,
  PayloadRef,
  TraceEventId,
} from "./common.js";

export interface TraceEvent {
  readonly id: TraceEventId;
  readonly schemaVersion: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly threadId: ThreadId | null;
  readonly runId: RunId;
  readonly turnId: TurnId | null;
  readonly parentEventId: TraceEventId | null;
  readonly causationId: CausationId | null;
  readonly correlationId: CorrelationId;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly actorId: string;
  readonly dataClassification: DataClassification;
  readonly eventType: string;
  readonly payloadRef: PayloadRef | null;
}

export interface TraceStorePort {
  append(event: TraceEvent): Promise<void>;
  readRun(runId: RunId, afterSequence: number, limit: number): Promise<readonly TraceEvent[]>;
  readSession(
    sessionId: SessionId,
    afterRecordedAt: string | null,
    limit: number,
  ): Promise<readonly TraceEvent[]>;
}

export interface PayloadEncryptionMetadata {
  readonly algorithm: string;
  readonly keyRef: string;
}

export interface PayloadRecord {
  readonly ref: PayloadRef;
  readonly dataClassification: DataClassification;
  readonly contentType: string;
  readonly ciphertext: Uint8Array;
  readonly encryption: PayloadEncryptionMetadata;
  readonly contentDigest: string;
  readonly createdAt: string;
}

export interface PayloadProtectionRequest {
  readonly ref: PayloadRef;
  readonly dataClassification: DataClassification;
  readonly contentType: string;
  readonly plaintext: Uint8Array;
  readonly createdAt: string;
}

export interface PayloadProtectorPort {
  protect(request: PayloadProtectionRequest): Promise<PayloadRecord>;
}

export interface PayloadStorePort {
  put(payload: PayloadRecord): Promise<void>;
  get(ref: PayloadRef): Promise<PayloadRecord | undefined>;
  delete(ref: PayloadRef): Promise<boolean>;
}

export interface AuditRecord {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly action: string;
  readonly targetRef: string;
  readonly outcome: "accepted" | "rejected" | "completed" | "failed";
  readonly occurredAt: string;
}

export interface AuditLedgerPort {
  append(record: AuditRecord): Promise<void>;
  listByAgent(agentId: AgentId, afterId: string | null): Promise<readonly AuditRecord[]>;
}

export const DELETION_TARGETS = ["payload", "search", "cache", "archive"] as const;

export type DeletionTarget = (typeof DELETION_TARGETS)[number];
export type DeletionTargetStatus = "pending" | "verified" | "failed";

export interface DeletionTargetState {
  readonly status: DeletionTargetStatus;
  readonly attempts: number;
  readonly lastErrorCode: string | null;
  readonly verifiedAt: string | null;
}

export interface SessionDeletionRecord {
  readonly id: string;
  readonly revision: number;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly sessionId: SessionId;
  readonly status: "pending" | "incomplete" | "verified";
  readonly targets: Readonly<Record<DeletionTarget, DeletionTargetState>>;
  readonly requestedAt: string;
  readonly updatedAt: string;
}

export interface SessionDeletionStatePort {
  create(record: SessionDeletionRecord): Promise<SessionDeletionRecord>;
  get(deletionId: string): Promise<SessionDeletionRecord | undefined>;
  save(record: SessionDeletionRecord, expectedRevision: number): Promise<SessionDeletionRecord>;
}

export interface SessionDeletionTargetPort {
  readonly target: DeletionTarget;
  deleteSession(sessionId: SessionId): Promise<void>;
  verifySessionDeleted(sessionId: SessionId): Promise<boolean>;
}
