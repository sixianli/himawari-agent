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
}

export interface PayloadRecord {
  readonly ref: PayloadRef;
  readonly dataClassification: DataClassification;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly createdAt: string;
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
