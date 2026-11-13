import type { MemoryReminder } from "@himawari-agent/application";
import type { AgentId, OwnerId } from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

const reminderSelect = `SELECT r.id, r.owner_id AS ownerId, r.agent_id AS agentId,
  r.memory_id AS memoryId, r.due_at AS dueAt, r.remind_at AS remindAt, r.repeat, r.status,
  r.dismissed_at AS dismissedAt, r.created_at AS createdAt, r.updated_at AS updatedAt
  FROM memory_reminders r`;

const liveMemory = `JOIN memory_records m ON m.id = r.memory_id AND m.status = 'active'
  AND m.superseded_by IS NULL AND m.tentative = 0`;

function valid(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export class SqliteMemoryReminderOperations {
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
      case "memoryReminder.schedule":
        return this.schedule((payload as { reminder: MemoryReminder }).reminder);
      case "memoryReminder.listDue":
        return this.listDue(
          payload as { ownerId: OwnerId; agentId: AgentId; now: string; limit: number },
        );
      case "memoryReminder.countDue":
        return this.countDue(payload as { ownerId: OwnerId; agentId: AgentId; now: string });
      case "memoryReminder.listUpcoming":
        return this.listUpcoming(
          payload as {
            ownerId: OwnerId;
            agentId: AgentId;
            from: string;
            to: string;
            limit: number;
            remindAfter?: string;
          },
        );
      case "memoryReminder.read":
        return this.read((payload as { id: string }).id);
      case "memoryReminder.update":
        return this.update(
          payload as {
            id: string;
            expectedUpdatedAt: string;
            status: MemoryReminder["status"];
            dueAt: string;
            remindAt: string;
            dismissedAt: string | null;
            updatedAt: string;
          },
        );
      default:
        return this.fail(
          "PORT_INVALID_OPERATION",
          `Unknown Memory reminder operation ${operation}`,
        );
    }
  }

  private limit(value: number) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 200)
      this.fail("PORT_INVALID_OPERATION", "Memory reminder limit is invalid");
  }

  private schedule(reminder: MemoryReminder): void {
    this.assertDiskHeadroom();
    if (
      !valid(reminder.dueAt) ||
      !valid(reminder.remindAt) ||
      reminder.status !== "scheduled" ||
      !["none", "yearly"].includes(reminder.repeat)
    )
      this.fail("PORT_INVALID_OPERATION", "Memory reminder is invalid");
    const memory = this.database
      .prepare("SELECT 1 FROM memory_records WHERE id = ? AND owner_id = ? AND agent_id = ?")
      .get(reminder.memoryId, reminder.ownerId, reminder.agentId);
    if (!memory) this.fail("PORT_NOT_FOUND", "Memory for reminder not found");
    this.database
      .prepare(
        `INSERT INTO memory_reminders (
          id, owner_id, agent_id, memory_id, due_at, remind_at, repeat, status, dismissed_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', NULL, ?, ?)
        ON CONFLICT (memory_id) DO UPDATE SET due_at = excluded.due_at,
          remind_at = excluded.remind_at, repeat = excluded.repeat, status = 'scheduled',
          dismissed_at = NULL, updated_at = excluded.updated_at`,
      )
      .run(
        reminder.id,
        reminder.ownerId,
        reminder.agentId,
        reminder.memoryId,
        reminder.dueAt,
        reminder.remindAt,
        reminder.repeat,
        reminder.createdAt,
        reminder.updatedAt,
      );
  }

  private listDue(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    now: string;
    limit: number;
  }): readonly MemoryReminder[] {
    this.limit(input.limit);
    return this.database
      .prepare(
        `${reminderSelect} ${liveMemory}
        WHERE r.owner_id = ? AND r.agent_id = ? AND r.status = 'scheduled' AND r.remind_at <= ?
        ORDER BY r.remind_at, r.id LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, input.now, input.limit) as MemoryReminder[];
  }

  private countDue(input: { ownerId: OwnerId; agentId: AgentId; now: string }): number {
    return this.database
      .prepare(
        `SELECT COUNT(*) FROM memory_reminders r ${liveMemory}
        WHERE r.owner_id = ? AND r.agent_id = ? AND r.status = 'scheduled' AND r.remind_at <= ?`,
      )
      .pluck()
      .get(input.ownerId, input.agentId, input.now) as number;
  }

  private listUpcoming(input: {
    ownerId: OwnerId;
    agentId: AgentId;
    from: string;
    to: string;
    limit: number;
    remindAfter?: string;
  }): readonly MemoryReminder[] {
    this.limit(input.limit);
    const remindAfter = input.remindAfter ?? null;
    return this.database
      .prepare(
        `${reminderSelect} ${liveMemory}
        WHERE r.owner_id = ? AND r.agent_id = ? AND r.status = 'scheduled'
          AND r.due_at >= ? AND r.due_at <= ? AND (? IS NULL OR r.remind_at > ?)
        ORDER BY r.due_at, r.id LIMIT ?`,
      )
      .all(
        input.ownerId,
        input.agentId,
        input.from,
        input.to,
        remindAfter,
        remindAfter,
        input.limit,
      ) as MemoryReminder[];
  }

  private read(id: string): MemoryReminder | undefined {
    return this.database.prepare(`${reminderSelect} WHERE r.id = ?`).get(id) as
      | MemoryReminder
      | undefined;
  }

  private update(input: {
    id: string;
    expectedUpdatedAt: string;
    status: MemoryReminder["status"];
    dueAt: string;
    remindAt: string;
    dismissedAt: string | null;
    updatedAt: string;
  }): boolean {
    if (
      !valid(input.dueAt) ||
      !valid(input.remindAt) ||
      (input.status === "scheduled") !== (input.dismissedAt === null)
    )
      this.fail("PORT_INVALID_OPERATION", "Memory reminder update is invalid");
    return (
      this.database
        .prepare(
          `UPDATE memory_reminders SET status = ?, due_at = ?, remind_at = ?, dismissed_at = ?,
            updated_at = ?
          WHERE id = ? AND updated_at = ?`,
        )
        .run(
          input.status,
          input.dueAt,
          input.remindAt,
          input.dismissedAt,
          input.updatedAt,
          input.id,
          input.expectedUpdatedAt,
        ).changes === 1
    );
  }
}
