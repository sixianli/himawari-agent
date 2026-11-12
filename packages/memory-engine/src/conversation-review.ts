import {
  ApplicationPortError,
  type DurableMemoryService,
  isReviewChangeUndoable,
  isReviewChangeUndone,
  type MemoryConversationReview,
  type MemoryConversationReviewStorePort,
  PORT_ERROR_CODES,
  type ProductMemoryStatePort,
  UNDOABLE_REVIEW_STATUSES,
} from "@himawari-agent/application";
import type { MemoryGenerationId, MemoryId } from "@himawari-agent/domain";

export interface MemoryConversationReviewUndoOptions {
  readonly store: Pick<
    MemoryConversationReviewStorePort,
    "read" | "listChanges" | "markUndone" | "markChangeUndone"
  >;
  readonly state: Pick<ProductMemoryStatePort, "read">;
  readonly memory: Pick<DurableMemoryService, "revise">;
  readonly generationFor: (memoryId: MemoryId) => Promise<MemoryGenerationId | undefined>;
  readonly now: () => string;
}

export async function undoConversationReview(
  options: MemoryConversationReviewUndoOptions,
  reviewId: string,
): Promise<MemoryConversationReview> {
  const review = await options.store.read(reviewId);
  if (!review)
    throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Conversation review not found");
  if (review.undoneAt !== null)
    throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Conversation review undone");
  if (!UNDOABLE_REVIEW_STATUSES.has(review.status))
    throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Conversation review not finished");
  const changes = (await options.store.listChanges(review.id)).filter(
    ({ afterRevision }) => afterRevision !== null,
  );
  if (changes.length === 0)
    throw new ApplicationPortError(
      PORT_ERROR_CODES.NOT_FOUND,
      "Conversation review has no changes",
    );
  const planned = [];
  for (const change of changes) {
    const memory = await options.state.read(change.memoryId);
    if (!memory || !isReviewChangeUndoable(change, memory))
      throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "MEMORY_CHANGED_AFTER_REVIEW");
    if (isReviewChangeUndone(change, memory)) continue;
    const generationId = await options.generationFor(memory.id);
    if (!generationId)
      throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Memory generation not found");
    planned.push({ change, memory, generationId });
  }
  for (const { change, memory, generationId } of planned) {
    const expected = memory.revision + 1;
    await options.store.markChangeUndone({
      reviewId: review.id,
      memoryId: memory.id,
      undoneRevision: expected,
    });
    await options.memory.revise({
      memoryId: memory.id,
      expectedRevision: memory.revision,
      generationId,
      ...(change.action === "created"
        ? { status: "archived" as const }
        : change.action === "superseded"
          ? {
              attributes: {
                supersededBy: change.beforeSupersededBy,
                validTo: change.beforeValidTo,
              },
            }
          : { attributes: { tentative: true } }),
    });
  }
  const undoneAt = options.now();
  if (!(await options.store.markUndone({ id: review.id, undoneAt })))
    throw new ApplicationPortError(PORT_ERROR_CODES.CONFLICT, "Conversation review undone");
  return Object.freeze({ ...review, undoneAt });
}
