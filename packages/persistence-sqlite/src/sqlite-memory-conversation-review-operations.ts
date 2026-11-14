import type {
  MemoryConversationReview,
  MemoryConversationReviewChange,
  MemoryConversationReviewStatus,
} from "@himawari-agent/application";
import type { AgentId, MemoryId, OwnerId, ThreadId } from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;
const STATUSES = new Set(["completed", "failed", "gave_up"]);
const ACTIONS = new Set(["created", "superseded", "confirmed"]);

const reviewColumns = `id, owner_id AS ownerId, agent_id AS agentId, thread_id AS threadId,
  episode_id AS episodeId, episode_created_at AS episodeCreatedAt, day, status, attempts,
  output_ref AS outputRef, error_code AS errorCode, started_at AS startedAt,
  finished_at AS finishedAt, undone_at AS undoneAt`;

const changeColumns = `review_id AS reviewId, memory_id AS memoryId, action,
  source_message_id AS sourceMessageId, after_revision AS afterRevision,
  before_superseded_by AS beforeSupersededBy, before_valid_to AS beforeValidTo,
  created_at AS createdAt, undone_revision AS undoneRevision`;

function validTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

export class SqliteMemoryConversationReviewOperations {
  private readonly database: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly assertDiskHeadroom: () => void;

  constructor(
    database: Database.Database,
    fail: SqliteApplicationFailure,
    assertDiskHeadroom: () => void,
  ) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
  }

  execute(operation: string, payload: unknown): unknown {
    switch (operation) {
      case "memoryConversationReview.position":
        return this.position(payload as { ownerId: OwnerId; agentId: AgentId });
      case "memoryConversationReview.begin":
        return this.begin(
          payload as Parameters<SqliteMemoryConversationReviewOperations["begin"]>[0],
        );
      case "memoryConversationReview.attachOutput":
        return this.attachOutput(payload as { id: string; outputRef: string });
      case "memoryConversationReview.finish":
        return this.finish(
          payload as {
            id: string;
            status: Exclude<MemoryConversationReviewStatus, "running">;
            errorCode: string | null;
            finishedAt: string;
          },
        );
      case "memoryConversationReview.recordChange":
        return this.recordChange(
          (payload as { change: Omit<MemoryConversationReviewChange, "undoneRevision"> }).change,
        );
      case "memoryConversationReview.discardChange":
        return this.discardChange(payload as { reviewId: string; memoryId: MemoryId });
      case "memoryConversationReview.markChangeUndone":
        return this.markChangeUndone(
          payload as { reviewId: string; memoryId: MemoryId; undoneRevision: number },
        );
      case "memoryConversationReview.read":
        return this.read((payload as { id: string }).id);
      case "memoryConversationReview.listWithChanges":
        return this.listWithChanges(
          payload as { ownerId: OwnerId; agentId: AgentId; limit: number },
        );
      case "memoryConversationReview.listChanges":
        return this.listChanges((payload as { reviewId: string }).reviewId);
      case "memoryConversationReview.dayUsage":
        return this.dayUsage(payload as { ownerId: OwnerId; agentId: AgentId; day: string });
      case "memoryConversationReview.markUndone":
        return this.markUndone(payload as { id: string; undoneAt: string });
      default:
        return this.fail(
          "PORT_INVALID_OPERATION",
          `Unknown conversation review operation ${operation}`,
        );
    }
  }

  private position(input: { ownerId: OwnerId; agentId: AgentId }) {
    const row = this.database
      .prepare(
        `SELECT episode_created_at AS createdAt, episode_id AS episodeId
        FROM memory_conversation_reviews r
        WHERE owner_id = ? AND agent_id = ? AND status IN ('completed', 'gave_up')
          AND EXISTS (SELECT 1 FROM memory_episodes e WHERE e.id = r.episode_id)
        ORDER BY episode_created_at DESC, episode_id DESC LIMIT 1`,
      )
      .get(input.ownerId, input.agentId) as { createdAt: string; episodeId: string } | undefined;
    return row ? Object.freeze(row) : null;
  }

  private begin(input: {
    id: string;
    ownerId: OwnerId;
    agentId: AgentId;
    threadId: ThreadId;
    episodeId: string;
    episodeCreatedAt: string;
    day: string;
    startedAt: string;
  }): MemoryConversationReview {
    this.assertDiskHeadroom();
    if (
      !text(input.id, 128) ||
      !text(input.episodeId, 256) ||
      !validTime(input.episodeCreatedAt) ||
      !validTime(input.startedAt) ||
      typeof input.day !== "string" ||
      !DAY.test(input.day)
    )
      this.fail("PORT_INVALID_OPERATION", "Conversation review is invalid");
    return this.database.transaction(() => {
      const existing = this.read(input.id);
      if (existing) {
        if (
          existing.ownerId !== input.ownerId ||
          existing.agentId !== input.agentId ||
          existing.episodeId !== input.episodeId
        )
          this.fail("PORT_CONFLICT", "Conversation review identity conflicts");
        if (existing.status === "completed" || existing.status === "gave_up") {
          this.database
            .prepare("UPDATE memory_conversation_reviews SET episode_created_at = ? WHERE id = ?")
            .run(input.episodeCreatedAt, input.id);
        } else {
          this.database
            .prepare(
              `UPDATE memory_conversation_reviews SET status = 'running',
                attempts = min(attempts + 1, 100), day = ?, started_at = ?, finished_at = NULL,
                episode_created_at = ?
              WHERE id = ?`,
            )
            .run(input.day, input.startedAt, input.episodeCreatedAt, input.id);
        }
      } else {
        const thread = this.database
          .prepare("SELECT 1 FROM threads WHERE id = ? AND owner_id = ? AND agent_id = ?")
          .get(input.threadId, input.ownerId, input.agentId);
        if (!thread) this.fail("PORT_NOT_FOUND", "Thread for conversation review not found");
        this.database
          .prepare(
            `INSERT INTO memory_conversation_reviews (
              id, owner_id, agent_id, thread_id, episode_id, episode_created_at, day, status,
              attempts, output_ref, error_code, started_at, finished_at, undone_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', 1, NULL, NULL, ?, NULL, NULL)`,
          )
          .run(
            input.id,
            input.ownerId,
            input.agentId,
            input.threadId,
            input.episodeId,
            input.episodeCreatedAt,
            input.day,
            input.startedAt,
          );
      }
      const saved = this.read(input.id);
      if (!saved) return this.fail("PORT_NOT_FOUND", "Conversation review not found");
      return saved;
    })();
  }

  private attachOutput(input: { id: string; outputRef: string }): void {
    this.assertDiskHeadroom();
    if (!text(input.outputRef, 400))
      this.fail("PORT_INVALID_OPERATION", "Conversation review output is invalid");
    const changed = this.database
      .prepare(
        "UPDATE memory_conversation_reviews SET output_ref = ? WHERE id = ? AND status = 'running'",
      )
      .run(input.outputRef, input.id).changes;
    if (changed !== 1) this.fail("PORT_CONFLICT", "Conversation review is not running");
  }

  private finish(input: {
    id: string;
    status: Exclude<MemoryConversationReviewStatus, "running">;
    errorCode: string | null;
    finishedAt: string;
  }): void {
    if (
      !STATUSES.has(input.status) ||
      !validTime(input.finishedAt) ||
      (input.errorCode !== null && !ERROR_CODE.test(input.errorCode))
    )
      this.fail("PORT_INVALID_OPERATION", "Conversation review finish is invalid");
    this.database
      .prepare(
        `UPDATE memory_conversation_reviews SET status = ?, error_code = ?, finished_at = ?
        WHERE id = ?`,
      )
      .run(input.status, input.errorCode, input.finishedAt, input.id);
  }

  private recordChange(change: Omit<MemoryConversationReviewChange, "undoneRevision">): void {
    this.assertDiskHeadroom();
    if (
      !ACTIONS.has(change.action) ||
      !text(change.sourceMessageId, 256) ||
      !(
        change.afterRevision === null ||
        (Number.isSafeInteger(change.afterRevision) && change.afterRevision >= 1)
      ) ||
      !validTime(change.createdAt)
    )
      this.fail("PORT_INVALID_OPERATION", "Conversation review change is invalid");
    const review = this.read(change.reviewId);
    const memory = this.database
      .prepare("SELECT owner_id AS ownerId, agent_id AS agentId FROM memory_records WHERE id = ?")
      .get(change.memoryId) as { ownerId: string; agentId: string } | undefined;
    const pendingCreation = change.action === "created" && change.afterRevision === null;
    if (
      !review ||
      !text(change.memoryId, 256) ||
      (memory
        ? memory.ownerId !== review.ownerId || memory.agentId !== review.agentId
        : !pendingCreation)
    )
      this.fail("PORT_NOT_FOUND", "Conversation review change scope not found");
    this.database
      .prepare(
        `INSERT INTO memory_conversation_review_changes (
          review_id, memory_id, action, source_message_id, after_revision,
          before_superseded_by, before_valid_to, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (review_id, memory_id) DO UPDATE SET
          after_revision = coalesce(excluded.after_revision, after_revision)
        WHERE undone_revision IS NULL`,
      )
      .run(
        change.reviewId,
        change.memoryId,
        change.action,
        change.sourceMessageId,
        change.afterRevision,
        change.beforeSupersededBy,
        change.beforeValidTo,
        change.createdAt,
      );
  }

  private discardChange(input: { reviewId: string; memoryId: MemoryId }): void {
    this.database
      .prepare(
        `DELETE FROM memory_conversation_review_changes
        WHERE review_id = ? AND memory_id = ? AND after_revision IS NULL`,
      )
      .run(input.reviewId, input.memoryId);
  }

  private markChangeUndone(input: {
    reviewId: string;
    memoryId: MemoryId;
    undoneRevision: number;
  }): void {
    this.assertDiskHeadroom();
    if (!Number.isSafeInteger(input.undoneRevision) || input.undoneRevision < 2)
      this.fail("PORT_INVALID_OPERATION", "Conversation review undo revision is invalid");
    const changed = this.database
      .prepare(
        `UPDATE memory_conversation_review_changes SET undone_revision = ?
        WHERE review_id = ? AND memory_id = ? AND after_revision IS NOT NULL
          AND after_revision < ?`,
      )
      .run(input.undoneRevision, input.reviewId, input.memoryId, input.undoneRevision).changes;
    if (changed !== 1) this.fail("PORT_CONFLICT", "Conversation review change cannot be undone");
  }

  private read(id: string): MemoryConversationReview | undefined {
    const row = this.database
      .prepare(`SELECT ${reviewColumns} FROM memory_conversation_reviews WHERE id = ?`)
      .get(id) as MemoryConversationReview | undefined;
    return row ? Object.freeze({ ...row }) : undefined;
  }

  private listWithChanges(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    limit: number;
  }): readonly MemoryConversationReview[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200)
      this.fail("PORT_INVALID_OPERATION", "Conversation review listing is invalid");
    return (
      this.database
        .prepare(
          `SELECT ${reviewColumns} FROM memory_conversation_reviews r
          WHERE owner_id = ? AND agent_id = ? AND status IN ('completed', 'gave_up')
            AND EXISTS (
              SELECT 1 FROM memory_conversation_review_changes c
              WHERE c.review_id = r.id AND c.after_revision IS NOT NULL
            )
          ORDER BY coalesce(finished_at, started_at) DESC, id ASC LIMIT ?`,
        )
        .all(input.ownerId, input.agentId, input.limit) as MemoryConversationReview[]
    ).map((row) => Object.freeze({ ...row }));
  }

  private listChanges(reviewId: string): readonly MemoryConversationReviewChange[] {
    return (
      this.database
        .prepare(
          `SELECT ${changeColumns} FROM memory_conversation_review_changes
          WHERE review_id = ? ORDER BY created_at ASC, memory_id ASC`,
        )
        .all(reviewId) as (MemoryConversationReviewChange & { memoryId: MemoryId })[]
    ).map((row) => Object.freeze({ ...row }));
  }

  private dayUsage(input: { ownerId: OwnerId; agentId: AgentId; day: string }) {
    if (typeof input.day !== "string" || !DAY.test(input.day))
      this.fail("PORT_INVALID_OPERATION", "Conversation review day is invalid");
    const row = this.database
      .prepare(
        `SELECT
          (SELECT count(*) FROM memory_conversation_reviews
            WHERE owner_id = @ownerId AND agent_id = @agentId AND day = @day) AS reviews,
          (SELECT count(*) FROM memory_conversation_review_changes c
            JOIN memory_conversation_reviews r ON r.id = c.review_id
            WHERE r.owner_id = @ownerId AND r.agent_id = @agentId AND r.day = @day
              AND c.action = 'created' AND c.after_revision IS NOT NULL) AS created`,
      )
      .get(input) as { reviews: number; created: number };
    return Object.freeze({ reviews: row.reviews, created: row.created });
  }

  private markUndone(input: { id: string; undoneAt: string }): boolean {
    if (!validTime(input.undoneAt))
      this.fail("PORT_INVALID_OPERATION", "Conversation review undo time is invalid");
    return (
      this.database
        .prepare(
          `UPDATE memory_conversation_reviews SET undone_at = ?
          WHERE id = ? AND undone_at IS NULL`,
        )
        .run(input.undoneAt, input.id).changes === 1
    );
  }
}
