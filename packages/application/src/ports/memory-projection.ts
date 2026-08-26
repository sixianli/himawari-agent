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
  readonly lastUsedAt: string | null;
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
  readonly claimedBy: string | null;
  readonly claimExpiresAt: string | null;
}

export interface ProductMemoryStatePort {
  read(memoryId: MemoryId): Promise<ProductMemoryRecord | undefined>;
  readMany(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly memoryIds: readonly MemoryId[];
  }): Promise<readonly ProductMemoryRecord[]>;
  searchActive(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly queryRef: PayloadRef;
    readonly limit: number;
  }): Promise<readonly ProductMemoryRecord[]>;
  save(memory: ProductMemoryRecord, expectedRevision: number | null): Promise<ProductMemoryRecord>;
  listActive(ownerId: OwnerId, agentId: AgentId): Promise<readonly ProductMemoryRecord[]>;
  markUsed(memoryIds: readonly MemoryId[], usedAt: string): Promise<void>;
}

export interface MemoryProjectionJobStatePort {
  propose(input: {
    readonly job: MemoryProjectionJob;
    readonly requeueCompleted?: boolean;
  }): Promise<MemoryProjectionJob>;
  listPending(now: string, limit: number): Promise<readonly MemoryProjectionJob[]>;
  claim(input: {
    readonly jobId: string;
    readonly claimedBy: string;
    readonly claimedAt: string;
    readonly expiresAt: string;
  }): Promise<MemoryProjectionJob | undefined>;
  complete(input: {
    readonly jobId: string;
    readonly claimedBy: string;
    readonly providerRecordId: string | null;
  }): Promise<MemoryProjectionJob>;
  retry(input: {
    readonly jobId: string;
    readonly claimedBy: string;
    readonly errorCode: string;
    readonly nextRetryAt: string | null;
  }): Promise<MemoryProjectionJob>;
  listByMemory(memoryId: MemoryId): Promise<readonly MemoryProjectionJob[]>;
}

export interface MemoryProviderHit {
  readonly providerRecordId: string;
  readonly productMemoryId: MemoryId;
  readonly score: number;
}

export interface MemoryProviderProjectionPort {
  upsert(input: {
    readonly memory: ProductMemoryRecord;
    readonly content: string;
  }): Promise<string>;
  delete(providerRecordId: string): Promise<void>;
  search(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly MemoryProviderHit[]>;
  clearScope(ownerId: OwnerId, agentId: AgentId): Promise<void>;
}

export interface MemoryContentPort {
  readText(ref: PayloadRef): Promise<string>;
}

export type ProductMemoryProposal =
  | {
      readonly decision: "create";
      readonly memory: Omit<
        ProductMemoryRecord,
        "revision" | "status" | "providerRecordId" | "lastUsedAt" | "updatedAt"
      >;
    }
  | {
      readonly decision: "update" | "merge";
      readonly memoryId: MemoryId;
      readonly contentRef: PayloadRef;
      readonly sourceRefs: readonly string[];
      readonly dataClassification: DataClassification;
      readonly inference: boolean;
      readonly confidencePermille: number;
      readonly policyVersion: string;
    }
  | {
      readonly decision: "unchanged";
      readonly memoryId: MemoryId;
    };

export interface ProductMemorySearchResult {
  readonly memory: ProductMemoryRecord;
  readonly providerRecordId: string;
  readonly score: number;
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
