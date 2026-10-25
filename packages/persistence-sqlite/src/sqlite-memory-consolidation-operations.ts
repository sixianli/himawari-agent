import type {
  MemoryConsolidationChange,
  MemoryConsolidationRun,
} from "@himawari-agent/application";
import type { AgentId, OwnerId } from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const ACTIONS = new Set(["merge", "supersede", "archive", "reflect"]);

const runSelect = `SELECT id, owner_id AS ownerId, agent_id AS agentId, day,
  trigger_run_id AS triggerRunId, status, reviewed_through AS reviewedThrough,
  model_called AS modelCalled, change_count AS changeCount, error_code AS errorCode,
  started_at AS startedAt, finished_at AS finishedAt
  FROM memory_consolidation_runs`;

const changeSelect = `SELECT id, consolidation_id AS consolidationId, owner_id AS ownerId,
  agent_id AS agentId, memory_id AS memoryId, related_memory_id AS relatedMemoryId, action,
  before_revision AS beforeRevision, after_revision AS afterRevision,
  before_status AS beforeStatus, before_superseded_by AS beforeSupersededBy,
  before_valid_to AS beforeValidTo, created_at AS createdAt, undone_at AS undoneAt
  FROM memory_consolidation_changes`;

type RunRow = Omit<MemoryConsolidationRun, "modelCalled"> & { readonly modelCalled: number };

export class SqliteMemoryConsolidationOperations {
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
      case "memoryConsolidation.begin":
        return this.begin((payload as { run: MemoryConsolidationRun }).run);
      case "memoryConsolidation.lastCompleted":
        return this.lastCompleted(payload as { ownerId: OwnerId; agentId: AgentId });
      case "memoryConsolidation.finish":
        return this.finish(
          payload as {
            id: string;
            status: "completed" | "failed";
            reviewedThrough: string | null;
            modelCalled: boolean;
            errorCode: string | null;
            finishedAt: string;
          },
        );
      case "memoryConsolidation.recordChange":
        return this.recordChange((payload as { change: MemoryConsolidationChange }).change);
      case "memoryConsolidation.listChanges":
        return this.listChanges(payload as { ownerId: OwnerId; agentId: AgentId; limit: number });
      case "memoryConsolidation.readChange":
        return this.readChange((payload as { id: string }).id);
      case "memoryConsolidation.markUndone":
        return this.markUndone(payload as { id: string; undoneAt: string });
      default:
        return this.fail(
          "PORT_INVALID_OPERATION",
          `Unknown Memory consolidation operation ${operation}`,
        );
    }
  }

  private run(row: RunRow | undefined): MemoryConsolidationRun | undefined {
    return row ? Object.freeze({ ...row, modelCalled: row.modelCalled === 1 }) : undefined;
  }

  private begin(run: MemoryConsolidationRun): boolean {
    this.assertDiskHeadroom();
    if (!DAY.test(run.day) || run.status !== "running")
      this.fail("PORT_INVALID_OPERATION", "Memory consolidation run is invalid");
    const result = this.database
      .prepare(
        `INSERT INTO memory_consolidation_runs (
          id, owner_id, agent_id, day, trigger_run_id, status, reviewed_through, model_called,
          change_count, error_code, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, 'running', NULL, 0, 0, NULL, ?, NULL)
        ON CONFLICT (owner_id, agent_id, day) DO NOTHING`,
      )
      .run(run.id, run.ownerId, run.agentId, run.day, run.triggerRunId, run.startedAt);
    return result.changes === 1;
  }

  private lastCompleted(input: {
    ownerId: OwnerId;
    agentId: AgentId;
  }): MemoryConsolidationRun | undefined {
    return this.run(
      this.database
        .prepare(
          `${runSelect} WHERE owner_id = ? AND agent_id = ? AND status = 'completed'
          ORDER BY day DESC LIMIT 1`,
        )
        .get(input.ownerId, input.agentId) as RunRow | undefined,
    );
  }

  private finish(input: {
    id: string;
    status: "completed" | "failed";
    reviewedThrough: string | null;
    modelCalled: boolean;
    errorCode: string | null;
    finishedAt: string;
  }): void {
    const current = this.run(
      this.database.prepare(`${runSelect} WHERE id = ?`).get(input.id) as RunRow | undefined,
    );
    if (!current || current.status !== "running")
      this.fail("PORT_CONFLICT", "Memory consolidation run is not running");
    if (input.status === "failed" && current?.changeCount === 0) {
      this.database.prepare("DELETE FROM memory_consolidation_runs WHERE id = ?").run(input.id);
      return;
    }
    this.database
      .prepare(
        `UPDATE memory_consolidation_runs SET status = ?, reviewed_through = ?,
          model_called = ?, error_code = ?, finished_at = ?
        WHERE id = ?`,
      )
      .run(
        input.status,
        input.reviewedThrough,
        input.modelCalled ? 1 : 0,
        input.errorCode,
        input.finishedAt,
        input.id,
      );
  }

  private recordChange(change: MemoryConsolidationChange): void {
    this.assertDiskHeadroom();
    if (!ACTIONS.has(change.action) || change.undoneAt !== null)
      this.fail("PORT_INVALID_OPERATION", "Memory consolidation change is invalid");
    const run = this.database
      .prepare(
        "SELECT status FROM memory_consolidation_runs WHERE id = ? AND owner_id = ? AND agent_id = ?",
      )
      .get(change.consolidationId, change.ownerId, change.agentId) as
      | { status: string }
      | undefined;
    if (run?.status !== "running")
      this.fail("PORT_CONFLICT", "Memory consolidation run is not running");
    this.database
      .prepare(
        `INSERT INTO memory_consolidation_changes (
          id, consolidation_id, owner_id, agent_id, memory_id, related_memory_id, action,
          before_revision, after_revision, before_status, before_superseded_by,
          before_valid_to, created_at, undone_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        change.id,
        change.consolidationId,
        change.ownerId,
        change.agentId,
        change.memoryId,
        change.relatedMemoryId,
        change.action,
        change.beforeRevision,
        change.afterRevision,
        change.beforeStatus,
        change.beforeSupersededBy,
        change.beforeValidTo,
        change.createdAt,
      );
    this.database
      .prepare("UPDATE memory_consolidation_runs SET change_count = change_count + 1 WHERE id = ?")
      .run(change.consolidationId);
  }

  private listChanges(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    limit: number;
  }): readonly MemoryConsolidationChange[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > 500)
      this.fail("PORT_INVALID_OPERATION", "Memory consolidation change limit is invalid");
    return Object.freeze(
      (
        this.database
          .prepare(
            `${changeSelect} WHERE owner_id = ? AND agent_id = ?
            ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(input.ownerId, input.agentId, input.limit) as MemoryConsolidationChange[]
      ).map((row) => Object.freeze(row)),
    );
  }

  private readChange(id: string): MemoryConsolidationChange | undefined {
    const row = this.database.prepare(`${changeSelect} WHERE id = ?`).get(id) as
      | MemoryConsolidationChange
      | undefined;
    return row ? Object.freeze(row) : undefined;
  }

  private markUndone(input: { id: string; undoneAt: string }): boolean {
    return (
      this.database
        .prepare(
          "UPDATE memory_consolidation_changes SET undone_at = ? WHERE id = ? AND undone_at IS NULL",
        )
        .run(input.undoneAt, input.id).changes === 1
    );
  }
}
