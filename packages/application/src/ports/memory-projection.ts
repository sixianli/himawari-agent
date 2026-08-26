import type {
  AgentId,
  MemoryGenerationId,
  MemoryId,
  OwnerId,
  ThreadId,
} from "@himawari-agent/domain";
import type { DataClassification, PayloadRef } from "./common.js";

export interface ProductMemoryRecord {
  readonly id: MemoryId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly revision: number;
  readonly status: "active" | "archived" | "trashed" | "deletion_pending" | "deleted_verified";
  readonly contentRef: PayloadRef;
  readonly dataClassification: DataClassification;
  readonly sourceThreadId: ThreadId | null;
  readonly sourceRefs: readonly string[];
  readonly inference: boolean;
  readonly confidencePermille: number;
  readonly policyVersion: string;
  readonly providerRecordId: string | null;
  readonly updatedAt: string;
}

export interface MemoryProjectionJob {
  readonly id: string;
  readonly memoryId: MemoryId;
  readonly memoryRevision: number;
  readonly generationId: MemoryGenerationId;
  readonly operation: "upsert" | "delete";
  readonly status: "pending" | "claimed" | "completed" | "retry_wait" | "failed_terminal";
  readonly attemptCount: number;
  readonly nextRetryAt: string | null;
  readonly providerRecordId: string | null;
  readonly errorCode: string | null;
}

export interface ProductMemoryStatePort {
  read(memoryId: MemoryId): Promise<ProductMemoryRecord | undefined>;
  searchActive(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly queryRef: PayloadRef;
    readonly limit: number;
  }): Promise<readonly ProductMemoryRecord[]>;
  save(memory: ProductMemoryRecord, expectedRevision: number | null): Promise<ProductMemoryRecord>;
  listActive(ownerId: OwnerId, agentId: AgentId): Promise<readonly ProductMemoryRecord[]>;
}

export interface MemoryProjectionPort {
  propose(input: {
    readonly memory: ProductMemoryRecord;
    readonly operation: "upsert" | "delete";
    readonly generationId: MemoryGenerationId;
  }): Promise<MemoryProjectionJob>;
  listPending(limit: number): Promise<readonly MemoryProjectionJob[]>;
  project(job: MemoryProjectionJob): Promise<MemoryProjectionJob>;
  rebuild(records: readonly ProductMemoryRecord[]): Promise<readonly MemoryProjectionJob[]>;
}
