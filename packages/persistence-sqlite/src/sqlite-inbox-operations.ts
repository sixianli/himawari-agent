import type {
  InboxEnqueueOutcome,
  InboxSettingsRecord,
  InboxStorePort,
  InboxUsage,
  StoredInboxEvent,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Input<TName extends keyof InboxStorePort> = Parameters<InboxStorePort[TName]>[0];

const MAX_LISTED = 200;
const MAX_LIMIT = 100000;
const MAX_BATCH = 1000;
const SETTLED = ["done", "failed"];
const OUTCOME = /^[a-z][a-z0-9_]{0,31}$/u;

const columns = `id, source_kind AS sourceKind, source_ref AS sourceRef,
  source_version AS sourceVersion, external_content AS externalContent,
  from_owner AS fromOwner, priority, thread_id AS threadId, summary_ref AS summaryRef,
  status, outcome, reason_code AS reasonCode, run_id AS runId, attempts,
  created_at AS createdAt, updated_at AS updatedAt`;

type Row = Omit<StoredInboxEvent, "externalContent" | "fromOwner"> & {
  readonly externalContent: number;
  readonly fromOwner: number;
};

function stored(row: Row): StoredInboxEvent {
  return Object.freeze({
    ...row,
    externalContent: row.externalContent === 1,
    fromOwner: row.fromOwner === 1,
  });
}

function valid(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export class SqliteInboxOperations {
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
      case "inbox.enqueue":
        return this.enqueue(payload as Input<"enqueue">);
      case "inbox.claimBatch":
        return this.claimBatch(payload as Input<"claimBatch">);
      case "inbox.finish":
        return this.finish(payload as Input<"finish">);
      case "inbox.release":
        return this.release(payload as Input<"release">);
      case "inbox.recoverStalled":
        return this.recoverStalled(payload as Input<"recoverStalled">);
      case "inbox.usage":
        return this.usage(payload as Input<"usage">);
      case "inbox.settledSummaries":
        return this.settledSummaries(payload as Input<"settledSummaries">);
      case "inbox.summaryReferenced":
        return this.summaryReferenced(payload as Input<"summaryReferenced">);
      case "inbox.clearSummary":
        return this.clearSummary(payload as Input<"clearSummary">);
      case "inbox.readSettings":
        return this.readSettings(payload as Input<"readSettings">);
      case "inbox.changeSettings":
        return this.changeSettings(payload as Input<"changeSettings">);
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown inbox operation ${operation}`);
    }
  }

  private readSettings(input: Input<"readSettings">): InboxSettingsRecord {
    const row = this.database
      .prepare(
        `SELECT revision, overrides, updated_at AS updatedAt FROM inbox_settings
         WHERE owner_id = ? AND agent_id = ?`,
      )
      .get(input.ownerId, input.agentId) as
      | { revision: number; overrides: string; updatedAt: string }
      | undefined;
    if (!row) return Object.freeze({ revision: 0, overrides: Object.freeze({}), updatedAt: null });
    return Object.freeze({
      revision: row.revision,
      overrides: Object.freeze(JSON.parse(row.overrides) as Record<string, number>),
      updatedAt: row.updatedAt,
    });
  }

  private changeSettings(input: Input<"changeSettings">): InboxSettingsRecord {
    if (!valid(input.now)) this.invalid("Inbox settings time is invalid");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
      this.invalid("Inbox settings revision is invalid");
    const entries = Object.entries(input.overrides ?? {});
    if (
      entries.length > 32 ||
      entries.some(
        ([key, value]) =>
          !/^[a-zA-Z]{1,64}$/u.test(key) || !Number.isSafeInteger(value) || value < 0,
      )
    )
      this.invalid("Inbox settings overrides are invalid");
    this.assertDiskHeadroom();
    return this.database.transaction(() => {
      const current = this.readSettings(input);
      if (current.revision !== input.expectedRevision)
        return this.fail("PORT_CONFLICT", "INBOX_SETTINGS_CHANGED");
      const overrides = Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1)));
      this.database
        .prepare(
          `INSERT INTO inbox_settings (owner_id, agent_id, revision, overrides, updated_at)
           VALUES (?, ?, 1, ?, ?)
           ON CONFLICT (owner_id, agent_id) DO UPDATE SET
             revision = revision + 1, overrides = excluded.overrides,
             updated_at = excluded.updated_at`,
        )
        .run(input.ownerId, input.agentId, JSON.stringify(overrides), input.now);
      return this.readSettings(input);
    })();
  }

  private invalid(message: string): never {
    return this.fail("PORT_INVALID_OPERATION", message);
  }

  private text(value: unknown, maximum: number, what: string): string {
    if (typeof value !== "string" || value.length < 1 || value.length > maximum)
      this.invalid(`Inbox ${what} is invalid`);
    return value;
  }

  private limit(value: unknown, maximum = MAX_LIMIT): number {
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum)
      this.invalid("Inbox limit is invalid");
    return value as number;
  }

  private ids(value: unknown): readonly string[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BATCH)
      this.invalid("Inbox ids are invalid");
    const ids = (value as unknown[]).map((id) => this.text(id, 128, "id"));
    if (new Set(ids).size !== ids.length) this.invalid("Inbox ids repeat");
    return ids;
  }

  private fetch(ownerId: string, agentId: string, id: string): StoredInboxEvent | undefined {
    const row = this.database
      .prepare(`SELECT ${columns} FROM inbox_events WHERE owner_id = ? AND agent_id = ? AND id = ?`)
      .get(ownerId, agentId, id) as Row | undefined;
    return row ? stored(row) : undefined;
  }

  private enqueue(input: Input<"enqueue">): InboxEnqueueOutcome {
    this.assertDiskHeadroom();
    const id = this.text(input.id, 128, "id");
    const sourceKind = this.text(input.sourceKind, 64, "source kind");
    const sourceRef = this.text(input.sourceRef, 256, "source reference");
    if (typeof input.sourceVersion !== "string" || input.sourceVersion.length > 256)
      this.invalid("Inbox source version is invalid");
    if (typeof input.externalContent !== "boolean")
      this.invalid("Inbox external content flag is invalid");
    if (typeof input.fromOwner !== "boolean") this.invalid("Inbox owner flag is invalid");
    if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 9)
      this.invalid("Inbox priority is invalid");
    const threadId = input.threadId === null ? null : this.text(input.threadId, 256, "thread");
    const summaryRef = this.text(input.summaryRef, 256, "summary reference");
    if (!valid(input.now)) this.invalid("Inbox time is invalid");
    return this.database.transaction((): InboxEnqueueOutcome => {
      const existing = this.database
        .prepare(
          `SELECT ${columns} FROM inbox_events
           WHERE owner_id = ? AND agent_id = ? AND source_kind = ? AND source_ref = ?
             AND source_version = ?`,
        )
        .get(input.ownerId, input.agentId, sourceKind, sourceRef, input.sourceVersion) as
        | Row
        | undefined;
      if (existing) return { outcome: "duplicate", entry: stored(existing) };
      this.database
        .prepare(
          `INSERT INTO inbox_events (
             id, owner_id, agent_id, source_kind, source_ref, source_version, external_content,
             from_owner, priority, thread_id, summary_ref, status, outcome, reason_code, run_id,
             attempts, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, 0, ?, ?)`,
        )
        .run(
          id,
          input.ownerId,
          input.agentId,
          sourceKind,
          sourceRef,
          input.sourceVersion,
          input.externalContent ? 1 : 0,
          input.fromOwner ? 1 : 0,
          input.priority,
          threadId,
          summaryRef,
          input.now,
          input.now,
        );
      const entry = this.fetch(input.ownerId, input.agentId, id);
      if (!entry) return this.invalid("Inbox event was not stored");
      return { outcome: "queued", entry };
    })();
  }

  private claimBatch(input: Input<"claimBatch">): readonly StoredInboxEvent[] {
    if (!valid(input.now)) this.invalid("Inbox time is invalid");
    const limit = this.limit(input.limit, MAX_BATCH);
    return this.database.transaction(() => {
      const head = this.database
        .prepare(
          `SELECT thread_id AS threadId, from_owner AS fromOwner FROM inbox_events AS queued
           WHERE queued.owner_id = ? AND queued.agent_id = ? AND queued.status = 'queued'
             AND NOT EXISTS (
               SELECT 1 FROM inbox_events AS busy
               WHERE busy.owner_id = queued.owner_id AND busy.agent_id = queued.agent_id
                 AND busy.status = 'running' AND busy.thread_id IS queued.thread_id
             )
           ORDER BY queued.priority, queued.created_at, queued.rowid LIMIT 1`,
        )
        .get(input.ownerId, input.agentId) as
        | { threadId: string | null; fromOwner: number }
        | undefined;
      if (!head) return Object.freeze([]);
      const picked = (
        this.database
          .prepare(
            `SELECT id FROM inbox_events
             WHERE owner_id = ? AND agent_id = ? AND status = 'queued' AND thread_id IS ?
               AND from_owner = ?
             ORDER BY created_at, rowid LIMIT ?`,
          )
          .all(input.ownerId, input.agentId, head.threadId, head.fromOwner, limit) as {
          id: string;
        }[]
      ).map((row) => row.id);
      const claim = this.database.prepare(
        `UPDATE inbox_events SET status = 'running', attempts = attempts + 1, updated_at = ?
         WHERE owner_id = ? AND agent_id = ? AND id = ? AND status = 'queued'`,
      );
      for (const id of picked) claim.run(input.now, input.ownerId, input.agentId, id);
      return Object.freeze(
        picked.flatMap((id) => {
          const entry = this.fetch(input.ownerId, input.agentId, id);
          return entry ? [entry] : [];
        }),
      );
    })();
  }

  private finish(input: Input<"finish">): number {
    const ids = this.ids(input.ids);
    const reasonCode = this.text(input.reasonCode, 64, "reason code");
    if (!["done", "failed"].includes(input.to)) this.invalid("Inbox result is invalid");
    if (
      input.outcome !== null &&
      (typeof input.outcome !== "string" || !OUTCOME.test(input.outcome))
    )
      this.invalid("Inbox outcome is invalid");
    const runId = input.runId === null ? null : this.text(input.runId, 256, "run");
    if (!valid(input.now)) this.invalid("Inbox time is invalid");
    return this.database.transaction(() => {
      const update = this.database.prepare(
        `UPDATE inbox_events SET status = ?, outcome = ?, reason_code = ?, run_id = ?,
           updated_at = ?
         WHERE owner_id = ? AND agent_id = ? AND id = ? AND status = 'running'`,
      );
      let changed = 0;
      for (const id of ids)
        changed += update.run(
          input.to,
          input.outcome,
          reasonCode,
          runId,
          input.now,
          input.ownerId,
          input.agentId,
          id,
        ).changes;
      return changed;
    })();
  }

  private release(input: Input<"release">): number {
    const ids = this.ids(input.ids);
    if (typeof input.countAttempt !== "boolean") this.invalid("Inbox attempt flag is invalid");
    if (!valid(input.now)) this.invalid("Inbox time is invalid");
    const kept = input.countAttempt ? "attempts" : "max(attempts - 1, 0)";
    return this.database.transaction(() => {
      const update = this.database.prepare(
        `UPDATE inbox_events SET status = 'queued', attempts = ${kept},
           updated_at = ?
         WHERE owner_id = ? AND agent_id = ? AND id = ? AND status = 'running'`,
      );
      let changed = 0;
      for (const id of ids)
        changed += update.run(input.now, input.ownerId, input.agentId, id).changes;
      return changed;
    })();
  }

  private recoverStalled(input: Input<"recoverStalled">): number {
    if (!valid(input.stalledBefore) || !valid(input.now)) this.invalid("Inbox time is invalid");
    const maxAttempts = this.limit(input.maxAttempts);
    return this.database.transaction(() => {
      const failed = this.database
        .prepare(
          `UPDATE inbox_events SET status = 'failed', reason_code = 'stalled', updated_at = ?
           WHERE owner_id = ? AND agent_id = ? AND status = 'running' AND updated_at <= ?
             AND attempts >= ?`,
        )
        .run(input.now, input.ownerId, input.agentId, input.stalledBefore, maxAttempts).changes;
      const retried = this.database
        .prepare(
          `UPDATE inbox_events SET status = 'queued', updated_at = ?
           WHERE owner_id = ? AND agent_id = ? AND status = 'running' AND updated_at <= ?
             AND attempts < ?`,
        )
        .run(input.now, input.ownerId, input.agentId, input.stalledBefore, maxAttempts).changes;
      return failed + retried;
    })();
  }

  private usage(input: Input<"usage">): InboxUsage {
    const byStatus: Record<string, number> = {};
    for (const row of this.database
      .prepare(
        `SELECT status, COUNT(*) AS count FROM inbox_events
         WHERE owner_id = ? AND agent_id = ? GROUP BY status ORDER BY status`,
      )
      .all(input.ownerId, input.agentId) as { status: string; count: number }[])
      byStatus[row.status] = row.count;
    return Object.freeze({
      queued: byStatus["queued"] ?? 0,
      running: byStatus["running"] ?? 0,
      byStatus: Object.freeze(byStatus),
    });
  }

  private settledSummaries(
    input: Input<"settledSummaries">,
  ): readonly { readonly id: string; readonly summaryRef: string }[] {
    const limit = Math.min(Math.max(1, Math.trunc(input.limit)), MAX_LISTED);
    return Object.freeze(
      (
        this.database
          .prepare(
            `SELECT id, summary_ref AS summaryRef FROM inbox_events
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
          "SELECT 1 FROM inbox_events WHERE owner_id = ? AND agent_id = ? AND summary_ref = ?",
        )
        .get(input.ownerId, input.agentId, summaryRef) !== undefined
    );
  }

  private clearSummary(input: Input<"clearSummary">): boolean {
    const id = this.text(input.id, 128, "id");
    return (
      this.database
        .prepare(
          `UPDATE inbox_events SET summary_ref = NULL
           WHERE owner_id = ? AND agent_id = ? AND id = ? AND summary_ref = ?
             AND status IN (${SETTLED.map(() => "?").join(", ")})`,
        )
        .run(input.ownerId, input.agentId, id, input.summaryRef, ...SETTLED).changes > 0
    );
  }
}
