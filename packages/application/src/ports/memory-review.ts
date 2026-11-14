import type { AgentId, MemoryId, OwnerId } from "@himawari-agent/domain";

export const MEMORY_REVIEW_LIST_LIMIT = 100;
export const MEMORY_REVIEW_EXPAND_BATCH = 20;

export interface MemoryReviewScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export type MemoryReviewReason =
  | "memory_edited"
  | "memory_superseded"
  | "memory_removed"
  | "memory_restored"
  | "memory_reclassified"
  | "owner_reported";

export interface MemoryReviewItem {
  readonly memoryId: MemoryId;
  readonly upstreamMemoryId: string;
  readonly viaMemoryId: string | null;
  readonly reason: MemoryReviewReason;
  readonly depth: number;
  readonly truncated: boolean;
  readonly flaggedAt: string;
}

export type MemoryReviewResolution = "owner_edited" | "owner_dismissed";

export interface CorrectionAgreementCounts {
  readonly handled: number;
  readonly agreed: number;
  readonly missed: number;
  readonly openMemories: number;
  readonly openRules: number;
}

export interface MemoryReviewStorePort {
  expand(
    input: MemoryReviewScope & { readonly now: string; readonly limit: number },
  ): Promise<number>;
  listOpen(
    input: MemoryReviewScope & { readonly limit: number },
  ): Promise<readonly MemoryReviewItem[]>;
  resolve(
    input: MemoryReviewScope & {
      readonly memoryId: MemoryId;
      readonly resolution: MemoryReviewResolution;
      readonly now: string;
    },
  ): Promise<number>;
  reportMissed(
    input: MemoryReviewScope & {
      readonly memoryId: MemoryId;
      readonly upstreamMemoryId: MemoryId;
      readonly now: string;
    },
  ): Promise<boolean>;
  agreement(input: MemoryReviewScope): Promise<CorrectionAgreementCounts>;
}
