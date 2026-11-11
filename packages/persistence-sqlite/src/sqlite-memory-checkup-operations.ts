import type {
  MemoryCheckupAction,
  MemoryCheckupBefore,
  MemoryCheckupItem,
  MemoryCheckupReason,
} from "@himawari-agent/application";
import type { AgentId, MemoryId, OwnerId } from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

interface Scope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

interface Row {
  readonly id: string;
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
  readonly weekStart: string;
  readonly memoryId: MemoryId;
  readonly relatedMemoryId: MemoryId | null;
  readonly reason: MemoryCheckupReason;
  readonly action: MemoryCheckupAction | null;
  readonly keptMemoryId: MemoryId | null;
  readonly beforeState: string | null;
  readonly handledAt: string | null;
  readonly undoneAt: string | null;
  readonly createdAt: string;
}

const REASONS: readonly MemoryCheckupReason[] = [
  "conflict",
  "unused",
  "low_confidence",
  "source_unavailable",
];
const ACTIONS: readonly MemoryCheckupAction[] = ["confirm", "delete", "merge"];

const select = `SELECT id, owner_id AS ownerId, agent_id AS agentId, week_start AS weekStart,
  memory_id AS memoryId, related_memory_id AS relatedMemoryId, reason, action,
  kept_memory_id AS keptMemoryId, before_state AS beforeState, handled_at AS handledAt,
  undone_at AS undoneAt, created_at AS createdAt
  FROM memory_checkup_items`;

function valid(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function item({ beforeState, ...row }: Row): MemoryCheckupItem {
  return Object.freeze({
    ...row,
    before: beforeState === null ? null : (JSON.parse(beforeState) as MemoryCheckupBefore),
  });
}

export class SqliteMemoryCheckupOperations {
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
      case "memoryCheckup.listWeek":
        return this.listWeek(payload as Scope & { weekStart: string });
      case "memoryCheckup.createWeek":
        return this.createWeek(
          payload as Scope & {
            weekStart: string;
            items: readonly Pick<
              MemoryCheckupItem,
              "id" | "memoryId" | "relatedMemoryId" | "reason"
            >[];
            createdAt: string;
          },
        );
      case "memoryCheckup.read":
        return this.read(payload as Scope & { id: string });
      case "memoryCheckup.recordAction":
        return this.recordAction(
          payload as Scope & {
            id: string;
            action: MemoryCheckupAction;
            keptMemoryId: MemoryId | null;
            before: MemoryCheckupBefore;
            handledAt: string;
          },
        );
      case "memoryCheckup.recordUndo":
        return this.recordUndo(payload as Scope & { id: string; undoneAt: string });
      case "memoryCheckup.listConfirmedSince":
        return this.listConfirmedSince(payload as Scope & { since: string });
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown Memory checkup operation ${operation}`);
    }
  }

  private listWeek(input: Scope & { weekStart: string }): readonly MemoryCheckupItem[] {
    return (
      this.database
        .prepare(
          `${select} WHERE owner_id = ? AND agent_id = ? AND week_start = ?
          ORDER BY rowid`,
        )
        .all(input.ownerId, input.agentId, input.weekStart) as Row[]
    ).map(item);
  }

  private createWeek(
    input: Scope & {
      weekStart: string;
      items: readonly Pick<MemoryCheckupItem, "id" | "memoryId" | "relatedMemoryId" | "reason">[];
      createdAt: string;
    },
  ): boolean {
    this.assertDiskHeadroom();
    if (
      !valid(input.weekStart) ||
      !valid(input.createdAt) ||
      input.items.some(
        ({ reason, relatedMemoryId }) =>
          !REASONS.includes(reason) || (relatedMemoryId !== null && reason !== "conflict"),
      )
    )
      this.fail("PORT_INVALID_OPERATION", "Memory checkup week is invalid");
    const owned = this.database.prepare(
      "SELECT 1 FROM memory_records WHERE id = ? AND owner_id = ? AND agent_id = ?",
    );
    const insert = this.database.prepare(
      `INSERT INTO memory_checkup_items (
        id, owner_id, agent_id, week_start, memory_id, related_memory_id, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    return this.database.transaction(() => {
      const existing = this.database
        .prepare(
          "SELECT 1 FROM memory_checkup_items WHERE owner_id = ? AND agent_id = ? AND week_start = ? LIMIT 1",
        )
        .get(input.ownerId, input.agentId, input.weekStart);
      if (existing) return false;
      for (const entry of input.items) {
        for (const memoryId of [entry.memoryId, entry.relatedMemoryId])
          if (memoryId !== null && !owned.get(memoryId, input.ownerId, input.agentId))
            this.fail("PORT_NOT_FOUND", "Memory for checkup not found");
        insert.run(
          entry.id,
          input.ownerId,
          input.agentId,
          input.weekStart,
          entry.memoryId,
          entry.relatedMemoryId,
          entry.reason,
          input.createdAt,
        );
      }
      return true;
    })();
  }

  private read(input: Scope & { id: string }): MemoryCheckupItem | undefined {
    const row = this.database
      .prepare(`${select} WHERE id = ? AND owner_id = ? AND agent_id = ?`)
      .get(input.id, input.ownerId, input.agentId) as Row | undefined;
    return row ? item(row) : undefined;
  }

  private recordAction(
    input: Scope & {
      id: string;
      action: MemoryCheckupAction;
      keptMemoryId: MemoryId | null;
      before: MemoryCheckupBefore;
      handledAt: string;
    },
  ): boolean {
    this.assertDiskHeadroom();
    if (!ACTIONS.includes(input.action) || !valid(input.handledAt))
      this.fail("PORT_INVALID_OPERATION", "Memory checkup action is invalid");
    return (
      this.database
        .prepare(
          `UPDATE memory_checkup_items SET action = ?, kept_memory_id = ?, before_state = ?,
            handled_at = ?, undone_at = NULL
          WHERE id = ? AND owner_id = ? AND agent_id = ? AND action IS NULL`,
        )
        .run(
          input.action,
          input.keptMemoryId,
          JSON.stringify(input.before),
          input.handledAt,
          input.id,
          input.ownerId,
          input.agentId,
        ).changes === 1
    );
  }

  private recordUndo(input: Scope & { id: string; undoneAt: string }): boolean {
    this.assertDiskHeadroom();
    if (!valid(input.undoneAt))
      this.fail("PORT_INVALID_OPERATION", "Memory checkup undo is invalid");
    return (
      this.database
        .prepare(
          `UPDATE memory_checkup_items SET action = NULL, kept_memory_id = NULL,
            before_state = NULL, handled_at = NULL, undone_at = ?
          WHERE id = ? AND owner_id = ? AND agent_id = ? AND action IS NOT NULL`,
        )
        .run(input.undoneAt, input.id, input.ownerId, input.agentId).changes === 1
    );
  }

  private listConfirmedSince(input: Scope & { since: string }): readonly MemoryId[] {
    if (!valid(input.since)) this.fail("PORT_INVALID_OPERATION", "Memory checkup time is invalid");
    return (
      this.database
        .prepare(
          `SELECT DISTINCT memory_id AS memoryId FROM memory_checkup_items
          WHERE owner_id = ? AND agent_id = ? AND action = 'confirm' AND handled_at >= ?
          ORDER BY memory_id`,
        )
        .all(input.ownerId, input.agentId, input.since) as { memoryId: MemoryId }[]
    ).map(({ memoryId }) => memoryId);
  }
}
