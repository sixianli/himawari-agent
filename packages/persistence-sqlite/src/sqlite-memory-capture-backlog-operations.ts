import type { MemoryCaptureBacklogEntry } from "@himawari-agent/application";
import type { AgentId, OwnerId } from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/;

function validTime(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= max;
}

export class SqliteMemoryCaptureBacklogOperations {
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
      case "memoryCaptureBacklog.enqueue":
        return this.enqueue(
          (payload as { entry: Omit<MemoryCaptureBacklogEntry, "attempts" | "updatedAt"> }).entry,
        );
      case "memoryCaptureBacklog.oldest":
        return this.oldest(
          payload as { ownerId: OwnerId; agentId: AgentId; excludeGenerationId: string },
        );
      case "memoryCaptureBacklog.recordAttempt":
        return this.recordAttempt(
          payload as { generationId: string; errorCode: string; updatedAt: string },
        );
      case "memoryCaptureBacklog.has":
        return this.has((payload as { generationId: string }).generationId);
      case "memoryCaptureBacklog.remove":
        return this.remove((payload as { generationId: string }).generationId);
      default:
        return this.fail(
          "PORT_INVALID_OPERATION",
          `Unknown memory capture backlog operation ${operation}`,
        );
    }
  }

  private enqueue(entry: Omit<MemoryCaptureBacklogEntry, "attempts" | "updatedAt">): void {
    this.assertDiskHeadroom();
    if (
      !text(entry.generationId, 256) ||
      !text(entry.sourceRunId, 256) ||
      !ERROR_CODE.test(entry.lastErrorCode) ||
      !validTime(entry.createdAt)
    )
      this.fail("PORT_INVALID_OPERATION", "Memory capture backlog entry is invalid");
    const thread = this.database
      .prepare("SELECT 1 FROM threads WHERE id = ? AND owner_id = ? AND agent_id = ?")
      .get(entry.threadId, entry.ownerId, entry.agentId);
    if (!thread) this.fail("PORT_NOT_FOUND", "Thread for memory capture backlog not found");
    this.database
      .prepare(
        `INSERT INTO memory_capture_backlog (
          generation_id, owner_id, agent_id, thread_id, source_run_id, attempts, last_error_code,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
        ON CONFLICT (generation_id) DO UPDATE SET last_error_code = excluded.last_error_code,
          updated_at = excluded.updated_at`,
      )
      .run(
        entry.generationId,
        entry.ownerId,
        entry.agentId,
        entry.threadId,
        entry.sourceRunId,
        entry.lastErrorCode,
        entry.createdAt,
        entry.createdAt,
      );
  }

  private oldest(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    excludeGenerationId: string;
  }): MemoryCaptureBacklogEntry | undefined {
    return this.database
      .prepare(
        `SELECT b.generation_id AS generationId, b.owner_id AS ownerId, b.agent_id AS agentId,
          b.thread_id AS threadId, b.source_run_id AS sourceRunId, b.attempts,
          b.last_error_code AS lastErrorCode, b.created_at AS createdAt, b.updated_at AS updatedAt
        FROM memory_capture_backlog b
        JOIN threads t ON t.id = b.thread_id AND t.status = 'open' AND t.archived_at IS NULL
        WHERE b.owner_id = ? AND b.agent_id = ? AND b.generation_id <> ?
        ORDER BY b.created_at, b.generation_id
        LIMIT 1`,
      )
      .get(input.ownerId, input.agentId, input.excludeGenerationId) as
      | MemoryCaptureBacklogEntry
      | undefined;
  }

  private recordAttempt(input: {
    generationId: string;
    errorCode: string;
    updatedAt: string;
  }): number {
    this.assertDiskHeadroom();
    if (!ERROR_CODE.test(input.errorCode) || !validTime(input.updatedAt))
      this.fail("PORT_INVALID_OPERATION", "Memory capture backlog attempt is invalid");
    const row = this.database
      .prepare(
        `UPDATE memory_capture_backlog SET attempts = attempts + 1, last_error_code = ?,
          updated_at = ? WHERE generation_id = ? RETURNING attempts`,
      )
      .get(input.errorCode, input.updatedAt, input.generationId) as
      | { attempts: number }
      | undefined;
    if (!row) return this.fail("PORT_NOT_FOUND", "Memory capture backlog entry not found");
    return row.attempts;
  }

  private has(generationId: string): boolean {
    return (
      this.database
        .prepare("SELECT 1 FROM memory_capture_backlog WHERE generation_id = ?")
        .get(generationId) !== undefined
    );
  }

  private remove(generationId: string): void {
    this.database
      .prepare("DELETE FROM memory_capture_backlog WHERE generation_id = ?")
      .run(generationId);
  }
}
