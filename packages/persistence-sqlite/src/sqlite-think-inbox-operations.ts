import type {
  StoredThinkEntry,
  ThinkEnqueueOutcome,
  ThinkInboxStorePort,
  ThinkInboxUsage,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Input<TName extends keyof ThinkInboxStorePort> = Parameters<
  ThinkInboxStorePort[TName]
>[0];

const MAX_LISTED = 200;
const MAX_LIMIT = 100000;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;
const SETTLED = ["proposed", "skipped", "failed", "expired"];

const columns = `id, source_kind AS sourceKind, source_ref AS sourceRef,
  source_version AS sourceVersion, external_content AS externalContent, summary_ref AS summaryRef,
  status, reason_code AS reasonCode, attempts, day, created_at AS createdAt,
  updated_at AS updatedAt`;

type Row = Omit<StoredThinkEntry, "externalContent"> & {
  readonly externalContent: number;
};

function stored(row: Row): StoredThinkEntry {
  return Object.freeze({ ...row, externalContent: row.externalContent === 1 });
}

function valid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export class SqliteThinkInboxOperations {
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
      case "thinkInbox.enqueue":
        return this.enqueue(payload as Input<"enqueue">);
      case "thinkInbox.claimNext":
        return this.claimNext(payload as Input<"claimNext">);
      case "thinkInbox.finish":
        return this.finish(payload as Input<"finish">);
      case "thinkInbox.recoverStalled":
        return this.recoverStalled(payload as Input<"recoverStalled">);
      case "thinkInbox.expireQueued":
        return this.expireQueued(payload as Input<"expireQueued">);
      case "thinkInbox.usage":
        return this.usage(payload as Input<"usage">);
      case "thinkInbox.settledSummaries":
        return this.settledSummaries(payload as Input<"settledSummaries">);
      case "thinkInbox.summaryReferenced":
        return this.summaryReferenced(payload as Input<"summaryReferenced">);
      case "thinkInbox.clearSummary":
        return this.clearSummary(payload as Input<"clearSummary">);
      default:
        return this.fail(
          "PORT_INVALID_OPERATION",
          `Unknown think inbox operation ${operation}`,
        );
    }
  }

  private invalid(message: string): never {
    return this.fail("PORT_INVALID_OPERATION", message);
  }

  private text(value: unknown, maximum: number, what: string): string {
    if (typeof value !== "string" || value.length < 1 || value.length > maximum)
      this.invalid(`Think inbox ${what} is invalid`);
    return value;
  }

  private limit(value: unknown): number {
    if (
      !Number.isInteger(value) ||
      (value as number) < 1 ||
      (value as number) > MAX_LIMIT
    )
      this.invalid("Think inbox limit is invalid");
    return value as number;
  }

  private fetch(
    ownerId: string,
    agentId: string,
    id: string,
  ): StoredThinkEntry | undefined {
    const row = this.database
      .prepare(
        `SELECT ${columns} FROM think_inbox WHERE owner_id = ? AND agent_id = ? AND id = ?`,
      )
      .get(ownerId, agentId, id) as Row | undefined;
    return row ? stored(row) : undefined;
  }

  private decline(
    ownerId: string,
    agentId: string,
    day: string,
    reasonCode: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO think_inbox_declined (owner_id, agent_id, day, reason_code, declined)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT (owner_id, agent_id, day, reason_code) DO UPDATE SET declined = declined + 1`,
      )
      .run(ownerId, agentId, day, reasonCode);
  }

  private enqueue(input: Input<"enqueue">): ThinkEnqueueOutcome {
    this.assertDiskHeadroom();
    const id = this.text(input.id, 128, "id");
    const sourceKind = this.text(input.sourceKind, 64, "source kind");
    const sourceRef = this.text(input.sourceRef, 256, "source reference");
    if (
      typeof input.sourceVersion !== "string" ||
      input.sourceVersion.length > 256
    )
      this.invalid("Think inbox source version is invalid");
    if (typeof input.externalContent !== "boolean")
      this.invalid("Think inbox external content flag is invalid");
    const summaryRef = this.text(input.summaryRef, 256, "summary reference");
    if (typeof input.day !== "string" || !DAY.test(input.day))
      this.invalid("Think inbox day is invalid");
    if (!valid(input.now)) this.invalid("Think inbox time is invalid");
    const queueLimit = this.limit(input.queueLimit);
    const dailyLimit = this.limit(input.dailyLimit);
    return this.database.transaction((): ThinkEnqueueOutcome => {
      const existing = this.database
        .prepare(
          `SELECT ${columns} FROM think_inbox
           WHERE owner_id = ? AND agent_id = ? AND source_kind = ? AND source_ref = ?
             AND source_version = ?`,
        )
        .get(
          input.ownerId,
          input.agentId,
          sourceKind,
          sourceRef,
          input.sourceVersion,
        ) as Row | undefined;
      if (existing) return { outcome: "duplicate", entry: stored(existing) };
      const queued = (
        this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM think_inbox
             WHERE owner_id = ? AND agent_id = ? AND status IN ('queued', 'thinking')`,
          )
          .get(input.ownerId, input.agentId) as { count: number }
      ).count;
      if (queued >= queueLimit) {
        this.decline(input.ownerId, input.agentId, input.day, "queue_full");
        return { outcome: "queue_full" };
      }
      const accepted = (
        this.database
          .prepare(
            "SELECT COUNT(*) AS count FROM think_inbox WHERE owner_id = ? AND agent_id = ? AND day = ?",
          )
          .get(input.ownerId, input.agentId, input.day) as { count: number }
      ).count;
      if (accepted >= dailyLimit) {
        this.decline(input.ownerId, input.agentId, input.day, "daily_limit");
        return { outcome: "daily_limit" };
      }
      this.database
        .prepare(
          `INSERT INTO think_inbox (
             id, owner_id, agent_id, source_kind, source_ref, source_version, external_content,
             summary_ref, status, reason_code, attempts, day, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, 0, ?, ?, ?)`,
        )
        .run(
          id,
          input.ownerId,
          input.agentId,
          sourceKind,
          sourceRef,
          input.sourceVersion,
          input.externalContent ? 1 : 0,
          summaryRef,
          input.day,
          input.now,
          input.now,
        );
      const entry = this.fetch(input.ownerId, input.agentId, id);
      if (!entry) return this.invalid("Think inbox entry was not stored");
      return { outcome: "queued", entry };
    })();
  }

  private claimNext(input: Input<"claimNext">): StoredThinkEntry | undefined {
    if (!valid(input.now)) this.invalid("Think inbox time is invalid");
    return this.database.transaction(() => {
      const next = this.database
        .prepare(
          `SELECT id FROM think_inbox WHERE owner_id = ? AND agent_id = ? AND status = 'queued'
           ORDER BY created_at, id LIMIT 1`,
        )
        .get(input.ownerId, input.agentId) as { id: string } | undefined;
      if (!next) return undefined;
      this.database
        .prepare(
          `UPDATE think_inbox SET status = 'thinking', attempts = attempts + 1, updated_at = ?
           WHERE owner_id = ? AND agent_id = ? AND id = ? AND status = 'queued'`,
        )
        .run(input.now, input.ownerId, input.agentId, next.id);
      return this.fetch(input.ownerId, input.agentId, next.id);
    })();
  }

  private finish(input: Input<"finish">): StoredThinkEntry | undefined {
    const id = this.text(input.id, 128, "id");
    const reasonCode = this.text(input.reasonCode, 64, "reason code");
    if (!["proposed", "skipped", "failed"].includes(input.to))
      this.invalid("Think inbox result is invalid");
    if (!valid(input.now)) this.invalid("Think inbox time is invalid");
    return this.database.transaction(() => {
      const result = this.database
        .prepare(
          `UPDATE think_inbox SET status = ?, reason_code = ?, updated_at = ?
           WHERE owner_id = ? AND agent_id = ? AND id = ? AND status = 'thinking'`,
        )
        .run(input.to, reasonCode, input.now, input.ownerId, input.agentId, id);
      return result.changes === 0
        ? undefined
        : this.fetch(input.ownerId, input.agentId, id);
    })();
  }

  private recoverStalled(input: Input<"recoverStalled">): number {
    if (!valid(input.stalledBefore) || !valid(input.now))
      this.invalid("Think inbox time is invalid");
    const maxAttempts = this.limit(input.maxAttempts);
    return this.database.transaction(() => {
      const failed = this.database
        .prepare(
          `UPDATE think_inbox SET status = 'failed', reason_code = 'stalled', updated_at = ?
           WHERE owner_id = ? AND agent_id = ? AND status = 'thinking' AND updated_at <= ?
             AND attempts >= ?`,
        )
        .run(
          input.now,
          input.ownerId,
          input.agentId,
          input.stalledBefore,
          maxAttempts,
        ).changes;
      const retried = this.database
        .prepare(
          `UPDATE think_inbox SET status = 'queued', updated_at = ?
           WHERE owner_id = ? AND agent_id = ? AND status = 'thinking' AND updated_at <= ?
             AND attempts < ?`,
        )
        .run(
          input.now,
          input.ownerId,
          input.agentId,
          input.stalledBefore,
          maxAttempts,
        ).changes;
      return failed + retried;
    })();
  }

  private expireQueued(input: Input<"expireQueued">): number {
    if (!valid(input.createdBefore) || !valid(input.now))
      this.invalid("Think inbox time is invalid");
    return this.database
      .prepare(
        `UPDATE think_inbox SET status = 'expired', reason_code = 'expired', updated_at = ?
         WHERE owner_id = ? AND agent_id = ? AND status = 'queued' AND created_at <= ?`,
      )
      .run(input.now, input.ownerId, input.agentId, input.createdBefore)
      .changes;
  }

  private usage(input: Input<"usage">): ThinkInboxUsage {
    if (typeof input.day !== "string" || !DAY.test(input.day))
      this.invalid("Think inbox day is invalid");
    return this.database.transaction(() => {
      const queued = (
        this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM think_inbox
             WHERE owner_id = ? AND agent_id = ? AND status = 'queued'`,
          )
          .get(input.ownerId, input.agentId) as { count: number }
      ).count;
      const thinking = (
        this.database
          .prepare(
            `SELECT COUNT(*) AS count FROM think_inbox
             WHERE owner_id = ? AND agent_id = ? AND status = 'thinking'`,
          )
          .get(input.ownerId, input.agentId) as { count: number }
      ).count;
      const byStatus: Record<string, number> = {};
      let acceptedToday = 0;
      for (const row of this.database
        .prepare(
          `SELECT status, COUNT(*) AS count FROM think_inbox
           WHERE owner_id = ? AND agent_id = ? AND day = ? GROUP BY status ORDER BY status`,
        )
        .all(input.ownerId, input.agentId, input.day) as {
        status: string;
        count: number;
      }[]) {
        byStatus[row.status] = row.count;
        acceptedToday += row.count;
      }
      const declinedToday: Record<string, number> = {};
      for (const row of this.database
        .prepare(
          `SELECT reason_code AS reasonCode, declined FROM think_inbox_declined
           WHERE owner_id = ? AND agent_id = ? AND day = ? ORDER BY reason_code`,
        )
        .all(input.ownerId, input.agentId, input.day) as {
        reasonCode: string;
        declined: number;
      }[])
        declinedToday[row.reasonCode] = row.declined;
      return Object.freeze({
        day: input.day,
        queued,
        thinking,
        acceptedToday,
        byStatus: Object.freeze(byStatus),
        declinedToday: Object.freeze(declinedToday),
      });
    })();
  }

  private settledSummaries(
    input: Input<"settledSummaries">,
  ): readonly { readonly id: string; readonly summaryRef: string }[] {
    const limit = Math.min(Math.max(1, Math.trunc(input.limit)), MAX_LISTED);
    return Object.freeze(
      (
        this.database
          .prepare(
            `SELECT id, summary_ref AS summaryRef FROM think_inbox
             WHERE owner_id = ? AND agent_id = ? AND summary_ref IS NOT NULL
               AND status IN (${SETTLED.map(() => "?").join(", ")})
             ORDER BY updated_at, id LIMIT ?`,
          )
          .all(input.ownerId, input.agentId, ...SETTLED, limit) as {
          id: string;
          summaryRef: string;
        }[]
      ).map((row) => Object.freeze({ ...row })),
    );
  }

  private summaryReferenced(input: Input<"summaryReferenced">): boolean {
    const summaryRef = this.text(input.summaryRef, 256, "summary reference");
    return (
      this.database
        .prepare(
          "SELECT 1 FROM think_inbox WHERE owner_id = ? AND agent_id = ? AND summary_ref = ?",
        )
        .get(input.ownerId, input.agentId, summaryRef) !== undefined
    );
  }

  private clearSummary(input: Input<"clearSummary">): boolean {
    const id = this.text(input.id, 128, "id");
    return (
      this.database
        .prepare(
          `UPDATE think_inbox SET summary_ref = NULL
           WHERE owner_id = ? AND agent_id = ? AND id = ? AND summary_ref = ?
             AND status IN (${SETTLED.map(() => "?").join(", ")})`,
        )
        .run(input.ownerId, input.agentId, id, input.summaryRef, ...SETTLED)
        .changes > 0
    );
  }
}
