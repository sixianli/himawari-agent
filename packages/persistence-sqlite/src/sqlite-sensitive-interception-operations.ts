import { createHash } from "node:crypto";
import {
  SENSITIVE_INTERCEPTION_CATEGORIES,
  SENSITIVE_INTERCEPTION_OUTCOMES,
  SENSITIVE_INTERCEPTION_PAGE_LIMIT,
  SENSITIVE_INTERCEPTION_PARTS,
  SENSITIVE_INTERCEPTION_SOURCES,
  type SensitiveInterception,
  type SensitiveInterceptionListInput,
  type SensitiveInterceptionObservation,
  type SensitiveInterceptionPage,
  type SensitiveInterceptionRecordInput,
  type SensitiveInterceptionRecordResult,
  type SensitiveInterceptionScope,
  type SensitiveInterceptionSummary,
} from "@himawari-agent/application/sensitive-interceptions";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

const MAXIMUM_OBSERVATIONS_PER_WRITE = 500;

const columns = `dedupe_key AS id, thread_id AS threadId, source, purpose, part, category,
  rule_id AS ruleId, outcome, first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt,
  seen_count AS seenCount`;

function oneOf(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum;
}

function exactTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function validScope(input: SensitiveInterceptionScope): boolean {
  return boundedText(input?.ownerId, 256) && boundedText(input?.agentId, 256);
}

function validObservation(item: SensitiveInterceptionObservation): boolean {
  return (
    (item.threadId === null || boundedText(item.threadId, 256)) &&
    (item.runId === undefined || item.runId === null || boundedText(item.runId, 256)) &&
    oneOf(SENSITIVE_INTERCEPTION_SOURCES, item.source) &&
    (item.purpose === null || boundedText(item.purpose, 64)) &&
    oneOf(SENSITIVE_INTERCEPTION_PARTS, item.part) &&
    oneOf(SENSITIVE_INTERCEPTION_CATEGORIES, item.category) &&
    boundedText(item.ruleId, 128) &&
    typeof item.fingerprint === "string" &&
    /^[0-9a-f]{16,64}$/u.test(item.fingerprint) &&
    oneOf(SENSITIVE_INTERCEPTION_OUTCOMES, item.outcome) &&
    Number.isSafeInteger(item.occurrences) &&
    item.occurrences >= 1
  );
}

export function sensitiveInterceptionDedupeKey(item: SensitiveInterceptionObservation): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        item.threadId,
        item.source,
        item.purpose,
        item.part,
        item.category,
        item.fingerprint,
        item.outcome,
      ]),
    )
    .digest("hex");
}

export class SqliteSensitiveInterceptionOperations {
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
      case "sensitiveInterception.record":
        return this.record(payload as SensitiveInterceptionRecordInput);
      case "sensitiveInterception.list":
        return this.list(payload as SensitiveInterceptionListInput);
      case "sensitiveInterception.summarize":
        return this.summarize(payload as SensitiveInterceptionScope);
      case "sensitiveInterception.clear":
        return this.clear(payload as SensitiveInterceptionScope);
      default:
        return this.fail("PORT_INVALID_OPERATION", "Unknown sensitive interception operation");
    }
  }

  private record(input: SensitiveInterceptionRecordInput): SensitiveInterceptionRecordResult {
    if (
      !validScope(input) ||
      !exactTime(input.now) ||
      !Array.isArray(input.observations) ||
      input.observations.length > MAXIMUM_OBSERVATIONS_PER_WRITE ||
      !input.observations.every(validObservation)
    )
      return this.fail("PORT_INVALID_OPERATION", "Sensitive interception record is invalid");
    if (input.observations.length === 0) return { recorded: 0, skipped: 0 };
    this.assertDiskHeadroom();
    const threadExists = this.database.prepare(
      "SELECT 1 FROM threads WHERE owner_id = ? AND agent_id = ? AND id = ?",
    );
    const runThread = this.database
      .prepare("SELECT thread_id FROM runs WHERE owner_id = ? AND agent_id = ? AND id = ?")
      .pluck();
    const upsert = this.database.prepare(
      `INSERT INTO sensitive_interceptions (
         owner_id, agent_id, dedupe_key, thread_id, source, purpose, part, category, rule_id,
         fingerprint, outcome, first_seen_at, last_seen_at, seen_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, agent_id, dedupe_key) DO UPDATE SET
         last_seen_at = max(last_seen_at, excluded.last_seen_at),
         seen_count = seen_count + excluded.seen_count`,
    );
    return this.database
      .transaction((): SensitiveInterceptionRecordResult => {
        let recorded = 0;
        let skipped = 0;
        for (const observed of input.observations) {
          const run =
            observed.threadId === null && observed.runId
              ? (runThread.get(input.ownerId, input.agentId, observed.runId) as
                  | string
                  | null
                  | undefined)
              : null;
          const item = {
            ...observed,
            threadId: run ?? observed.threadId,
          } as SensitiveInterceptionObservation;
          if (
            run === undefined ||
            (item.threadId !== null &&
              !threadExists.get(input.ownerId, input.agentId, item.threadId))
          ) {
            skipped += 1;
            continue;
          }
          upsert.run(
            input.ownerId,
            input.agentId,
            sensitiveInterceptionDedupeKey(item),
            item.threadId,
            item.source,
            item.purpose,
            item.part,
            item.category,
            item.ruleId,
            item.fingerprint,
            item.outcome,
            input.now,
            input.now,
            item.occurrences,
          );
          recorded += 1;
        }
        return { recorded, skipped };
      })
      .immediate();
  }

  private list(input: SensitiveInterceptionListInput): SensitiveInterceptionPage {
    if (
      !validScope(input) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > SENSITIVE_INTERCEPTION_PAGE_LIMIT ||
      (input.before !== null &&
        (!exactTime(input.before?.firstSeenAt) || !/^[0-9a-f]{64}$/u.test(input.before?.id)))
    )
      return this.fail("PORT_INVALID_OPERATION", "Sensitive interception page is invalid");
    const rows = (
      input.before === null
        ? this.database
            .prepare(
              `SELECT ${columns} FROM sensitive_interceptions
               WHERE owner_id = ? AND agent_id = ?
               ORDER BY first_seen_at DESC, dedupe_key DESC LIMIT ?`,
            )
            .all(input.ownerId, input.agentId, input.limit + 1)
        : this.database
            .prepare(
              `SELECT ${columns} FROM sensitive_interceptions
               WHERE owner_id = ? AND agent_id = ?
                 AND (first_seen_at < ? OR (first_seen_at = ? AND dedupe_key < ?))
               ORDER BY first_seen_at DESC, dedupe_key DESC LIMIT ?`,
            )
            .all(
              input.ownerId,
              input.agentId,
              input.before.firstSeenAt,
              input.before.firstSeenAt,
              input.before.id,
              input.limit + 1,
            )
    ) as SensitiveInterception[];
    const items = rows.slice(0, input.limit).map((row) => Object.freeze({ ...row }));
    const last = items.at(-1);
    return Object.freeze({
      items: Object.freeze(items),
      next:
        rows.length > input.limit && last
          ? Object.freeze({ firstSeenAt: last.firstSeenAt, id: last.id })
          : null,
    });
  }

  private summarize(input: SensitiveInterceptionScope): SensitiveInterceptionSummary {
    if (!validScope(input))
      return this.fail("PORT_INVALID_OPERATION", "Sensitive interception scope is invalid");
    const rows = this.database
      .prepare(
        `SELECT outcome, COUNT(*) AS count FROM sensitive_interceptions
         WHERE owner_id = ? AND agent_id = ? GROUP BY outcome`,
      )
      .all(input.ownerId, input.agentId) as { outcome: string; count: number }[];
    const counts = { masked: 0, withheld: 0, not_saved: 0 };
    for (const { outcome, count } of rows)
      if (outcome === "masked" || outcome === "withheld" || outcome === "not_saved")
        counts[outcome] = count;
    return Object.freeze(counts);
  }

  private clear(input: SensitiveInterceptionScope): { readonly cleared: number } {
    if (!validScope(input))
      return this.fail("PORT_INVALID_OPERATION", "Sensitive interception scope is invalid");
    const result = this.database
      .prepare("DELETE FROM sensitive_interceptions WHERE owner_id = ? AND agent_id = ?")
      .run(input.ownerId, input.agentId);
    return { cleared: result.changes };
  }
}
