import type {
  AgentId,
  MemoryGenerationId,
  MemoryId,
  OwnerId,
  ThreadId,
} from "@himawari-agent/domain";
import type { SensitiveMemoryTopic } from "./automatic-memory.js";
import type { DataClassification, PayloadRef } from "./common.js";
import type { DecisionLedgerWrite } from "./decision-ledger.js";
import type { MemoryConsolidationWrite } from "./memory-consolidation.js";

export const MEMORY_CATEGORIES = [
  "identity",
  "preference",
  "relationship",
  "goal",
  "project",
  "rule",
  "health",
  "finance",
  "event",
  "other",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export interface ProductMemoryAttributes {
  readonly category: MemoryCategory;
  readonly importancePermille: number;
  readonly entities: readonly string[];
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly supersededBy: MemoryId | null;
  readonly evidenceVerified: boolean;
  readonly sensitiveTopic?: SensitiveMemoryTopic | null;
  readonly tentative?: boolean;
  readonly subCategory?: string | null;
  readonly importBatchId?: string | null;
  readonly stance?: string | null;
}

export const DEFAULT_MEMORY_ATTRIBUTES: ProductMemoryAttributes = Object.freeze({
  category: "other",
  importancePermille: 500,
  entities: Object.freeze([]),
  validFrom: null,
  validTo: null,
  supersededBy: null,
  evidenceVerified: false,
});

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
  readonly attributes?: ProductMemoryAttributes;
  readonly useCount?: number;
  readonly recordedAt?: string;
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

export const MEMORY_HISTORY_KINDS = [
  "created",
  "updated",
  "reaffirmed",
  "edited",
  "restored",
] as const;

export type MemoryHistoryKind = (typeof MEMORY_HISTORY_KINDS)[number];

export interface MemoryHistoryNote {
  readonly kind: MemoryHistoryKind;
  readonly quoteRef?: PayloadRef | null;
  readonly sourceThreadId?: ThreadId | null;
}

export interface MemoryHistoryEvent {
  readonly id: number;
  readonly memoryId: MemoryId;
  readonly kind: MemoryHistoryKind;
  readonly contentRef: PayloadRef;
  readonly stance: string | null;
  readonly quoteRef: PayloadRef | null;
  readonly sourceThreadId: ThreadId | null;
  readonly sourceDeleted: boolean;
  readonly occurredAt: string;
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
  saveWithProjection(input: {
    readonly memory: ProductMemoryRecord;
    readonly expectedRevision: number | null;
    readonly job: MemoryProjectionJob;
    readonly history?: MemoryHistoryNote;
    readonly ledger?: DecisionLedgerWrite;
    readonly consolidation?: MemoryConsolidationWrite;
  }): Promise<ProductMemoryRecord>;
  listActive(ownerId: OwnerId, agentId: AgentId): Promise<readonly ProductMemoryRecord[]>;
  markUsed(memoryIds: readonly MemoryId[], usedAt: string): Promise<void>;
  appendHistory(input: {
    readonly memoryId: MemoryId;
    readonly note: MemoryHistoryNote;
    readonly occurredAt: string;
  }): Promise<void>;
  listHistory(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly memoryIds: readonly MemoryId[];
  }): Promise<readonly MemoryHistoryEvent[]>;
  readHistory(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly id: number;
  }): Promise<MemoryHistoryEvent | undefined>;
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

export interface MemoryTimeScope {
  readonly includeHistory: boolean;
  readonly from: string | null;
  readonly to: string | null;
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
    readonly scope?: MemoryTimeScope;
    readonly minimumSimilarity?: number;
    readonly relevanceCutoff?: boolean;
    readonly includeTentative?: boolean;
    readonly tentativeOnly?: boolean;
    readonly lexicalOnly?: boolean;
  }): Promise<readonly MemoryProviderHit[]>;
  clearScope(ownerId: OwnerId, agentId: AgentId): Promise<void>;
}

export interface MemoryIndexEmbedding {
  readonly model: string;
  readonly dimensions: number;
  readonly vector: Float32Array;
}

export interface MemoryIndexDocument {
  readonly memoryId: MemoryId;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly revision: number;
  readonly terms: readonly string[];
  readonly embedding: MemoryIndexEmbedding | null;
  readonly indexedAt: string;
}

export interface MemoryIndexCandidate {
  readonly memoryId: MemoryId;
  readonly revision: number;
  readonly importancePermille: number;
  readonly confidencePermille: number;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
  readonly signal: number;
  readonly similarity?: number;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly current: boolean;
}

export interface MemoryIndexSearchResult {
  readonly vector: readonly MemoryIndexCandidate[];
  readonly lexical: readonly MemoryIndexCandidate[];
  readonly entity: readonly MemoryIndexCandidate[];
  readonly vectorEngine: "sqlite-vec" | "javascript" | "none";
}

export interface MemoryIndexStorePort {
  upsert(document: MemoryIndexDocument): Promise<void>;
  delete(memoryId: MemoryId): Promise<void>;
  clearScope(ownerId: OwnerId, agentId: AgentId): Promise<void>;
  search(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly embedding: MemoryIndexEmbedding | null;
    readonly terms: readonly string[];
    readonly queryText: string;
    readonly limit: number;
    readonly minimumSimilarity: number;
    readonly now: string;
    readonly includeHistory?: boolean;
    readonly includeTentative?: boolean;
    readonly tentativeOnly?: boolean;
  }): Promise<MemoryIndexSearchResult>;
  listUnindexed(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly model: string;
    readonly dimensions: number;
    readonly embeddableClassifications: readonly DataClassification[];
    readonly afterMemoryId: MemoryId | null;
    readonly limit: number;
  }): Promise<readonly MemoryId[]>;
}

export interface MemoryContentPort {
  readText(ref: PayloadRef): Promise<string>;
}

export type ProductMemoryProposal =
  | {
      readonly decision: "create";
      readonly memory: Omit<
        ProductMemoryRecord,
        | "revision"
        | "status"
        | "providerRecordId"
        | "lastUsedAt"
        | "updatedAt"
        | "useCount"
        | "recordedAt"
      >;
      readonly supersedes?: MemoryId | null;
      readonly quoteRef?: PayloadRef | null;
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
      readonly attributes?: ProductMemoryAttributes;
      readonly quoteRef?: PayloadRef | null;
      readonly sourceThreadId?: ThreadId | null;
    }
  | {
      readonly decision: "unchanged";
      readonly memoryId: MemoryId;
      readonly quoteRef?: PayloadRef | null;
      readonly sourceThreadId?: ThreadId | null;
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
