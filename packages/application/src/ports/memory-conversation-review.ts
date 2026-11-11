import type { AgentId, MemoryId, OwnerId, ThreadId } from "@himawari-agent/domain";
import type { MemoryEpisodePosition } from "./memory-episodes.js";
import type { ProductMemoryRecord } from "./memory-projection.js";

export type MemoryConversationReviewStatus = "running" | "completed" | "failed" | "gave_up";

export type MemoryConversationReviewAction = "created" | "superseded" | "confirmed";

export const MEMORY_CONVERSATION_REVIEW_MAX_ATTEMPTS = 3;

export interface MemoryConversationReview {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly threadId: ThreadId;
  readonly episodeId: string;
  readonly episodeCreatedAt: string;
  readonly day: string;
  readonly status: MemoryConversationReviewStatus;
  readonly attempts: number;
  readonly outputRef: string | null;
  readonly errorCode: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly undoneAt: string | null;
}

export interface MemoryConversationReviewChange {
  readonly reviewId: string;
  readonly memoryId: MemoryId;
  readonly action: MemoryConversationReviewAction;
  readonly sourceMessageId: string;
  readonly afterRevision: number;
  readonly beforeSupersededBy: MemoryId | null;
  readonly beforeValidTo: string | null;
  readonly createdAt: string;
}

export interface MemoryConversationReviewStorePort {
  position(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
  }): Promise<MemoryEpisodePosition | null>;
  begin(input: {
    readonly id: string;
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly threadId: ThreadId;
    readonly episodeId: string;
    readonly episodeCreatedAt: string;
    readonly day: string;
    readonly startedAt: string;
  }): Promise<MemoryConversationReview>;
  attachOutput(input: { readonly id: string; readonly outputRef: string }): Promise<void>;
  finish(input: {
    readonly id: string;
    readonly status: Exclude<MemoryConversationReviewStatus, "running">;
    readonly errorCode: string | null;
    readonly finishedAt: string;
  }): Promise<void>;
  recordChange(change: MemoryConversationReviewChange): Promise<void>;
  read(id: string): Promise<MemoryConversationReview | undefined>;
  listWithChanges(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly limit: number;
  }): Promise<readonly MemoryConversationReview[]>;
  listChanges(reviewId: string): Promise<readonly MemoryConversationReviewChange[]>;
  dayUsage(input: {
    readonly ownerId: OwnerId;
    readonly agentId: AgentId;
    readonly day: string;
  }): Promise<{ readonly reviews: number; readonly created: number }>;
  markUndone(input: { readonly id: string; readonly undoneAt: string }): Promise<boolean>;
}

export function isReviewChangeUndoable(
  change: Pick<MemoryConversationReviewChange, "afterRevision">,
  memory: Pick<ProductMemoryRecord, "revision"> | undefined,
): boolean {
  return memory !== undefined && memory.revision === change.afterRevision;
}
