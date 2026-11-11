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
  readonly afterRevision: number | null;
  readonly beforeSupersededBy: MemoryId | null;
  readonly beforeValidTo: string | null;
  readonly createdAt: string;
  readonly undoneRevision: number | null;
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
  recordChange(change: Omit<MemoryConversationReviewChange, "undoneRevision">): Promise<void>;
  discardChange(input: { readonly reviewId: string; readonly memoryId: MemoryId }): Promise<void>;
  markChangeUndone(input: {
    readonly reviewId: string;
    readonly memoryId: MemoryId;
    readonly undoneRevision: number;
  }): Promise<void>;
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

export const UNDOABLE_REVIEW_STATUSES: ReadonlySet<MemoryConversationReviewStatus> = new Set([
  "completed",
  "gave_up",
]);

type UndoChange = Pick<
  MemoryConversationReviewChange,
  "action" | "afterRevision" | "undoneRevision" | "beforeSupersededBy" | "beforeValidTo"
>;
type UndoMemory = Pick<ProductMemoryRecord, "revision" | "status" | "attributes">;

export function isReviewChangeUndone(change: UndoChange, memory: UndoMemory | undefined): boolean {
  if (memory === undefined || change.undoneRevision === null) return false;
  if (memory.revision !== change.undoneRevision) return false;
  if (change.action === "created") return memory.status === "archived";
  if (change.action === "superseded")
    return (
      (memory.attributes?.supersededBy ?? null) === change.beforeSupersededBy &&
      (memory.attributes?.validTo ?? null) === change.beforeValidTo
    );
  return memory.attributes?.tentative === true;
}

export function isReviewChangeUndoable(
  change: UndoChange,
  memory: UndoMemory | undefined,
): boolean {
  return (
    memory !== undefined &&
    change.afterRevision !== null &&
    (memory.revision === change.afterRevision || isReviewChangeUndone(change, memory))
  );
}
