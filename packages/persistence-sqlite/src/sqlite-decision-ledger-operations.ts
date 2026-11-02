import {
  DECISION_CATEGORIES,
  DECISION_KINDS,
  DECISION_OUTCOMES,
  DECISION_RATINGS,
  type DecisionLedgerEntry,
  type DecisionLedgerPort,
  type DecisionLedgerWrite,
  type MuseReferenceEntry,
  type MuseReferenceWrite,
} from "@himawari-agent/application/decision-ledger";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Input<TName extends keyof DecisionLedgerPort> = Parameters<DecisionLedgerPort[TName]>[0];

const MAX_IDS = 200;

function validTime(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function text(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function idList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_IDS &&
    value.every((item) => text(item, 1, 256)) &&
    new Set(value).size === value.length
  );
}

export function validateLedgerWrite(write: DecisionLedgerWrite): string | null {
  if (
    !(DECISION_KINDS as readonly string[]).includes(write.kind) ||
    (write.kind as string) === "proactive"
  )
    return "Decision ledger kind is invalid";
  const outcomes = DECISION_OUTCOMES[write.kind] as readonly string[];
  if (!outcomes.includes(write.outcome)) return "Decision ledger outcome is invalid";
  if (!text(write.id, 1, 128) || !text(write.reasonCode, 1, 64))
    return "Decision ledger identifiers are invalid";
  if (write.subjectRef !== null && !text(write.subjectRef, 1, 256))
    return "Decision ledger subject is invalid";
  if (!validTime(write.decidedAt)) return "Decision ledger time is invalid";
  if (!idList(write.inputs?.memoryIds) || !idList(write.inputs?.ruleIds))
    return "Decision ledger inputs are invalid";
  const batchId = write.inputs.batchId ?? null;
  if (
    (batchId !== null && !text(batchId, 1, 256)) ||
    (write.inputs.resultMemoryIds !== undefined && !idList(write.inputs.resultMemoryIds))
  )
    return "Decision ledger inputs are invalid";
  if (
    !Number.isSafeInteger(write.costMicros) ||
    write.costMicros < 0 ||
    !Number.isSafeInteger(write.durationMs) ||
    write.durationMs < 0 ||
    write.durationMs > 86_400_000
  )
    return "Decision ledger cost is invalid";
  const category = write.category ?? null;
  const confidence = write.confidencePermille ?? null;
  const inferred = write.inferred ?? null;
  if (write.kind !== "memory_candidate") {
    if (category !== null || confidence !== null || inferred !== null)
      return "Decision ledger candidate fields belong to memory candidates only";
  } else {
    if (category !== null && !(DECISION_CATEGORIES as readonly string[]).includes(category))
      return "Decision ledger category is invalid";
    if (
      confidence !== null &&
      (!Number.isSafeInteger(confidence) || confidence < 0 || confidence > 1000)
    )
      return "Decision ledger confidence is invalid";
    if (inferred !== null && typeof inferred !== "boolean")
      return "Decision ledger inferred flag is invalid";
  }
  return null;
}

export function insertLedgerRow(database: Database.Database, write: DecisionLedgerWrite): void {
  database
    .prepare(
      `INSERT INTO decision_ledger (
        id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, outcome, reason_code,
        subject_ref, inputs, reason_ref, content_ref, push_source_key, cost_micros, duration_ms,
        owner_rating, rated_at, category, confidence_permille, inferred
      ) VALUES (?, ?, ?, ?, NULL, ?, '{}', NULL, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?)
      ON CONFLICT (id) DO NOTHING`,
    )
    .run(
      write.id,
      write.ownerId,
      write.agentId,
      write.kind,
      write.decidedAt,
      write.outcome,
      write.reasonCode,
      write.subjectRef,
      JSON.stringify({
        memoryIds: write.inputs.memoryIds,
        ruleIds: write.inputs.ruleIds,
        batchId: write.inputs.batchId ?? null,
        resultMemoryIds: write.inputs.resultMemoryIds ?? [],
      }),
      write.reasonRef,
      write.contentRef,
      write.costMicros,
      write.durationMs,
      write.category ?? null,
      write.confidencePermille ?? null,
      write.inferred === undefined || write.inferred === null ? null : write.inferred ? 1 : 0,
    );
}

const entryColumns = `id, kind, checked_at AS decidedAt, COALESCE(outcome, verdict) AS outcome,
  reason_code AS reasonCode, subject_ref AS subjectRef, inputs, reason_ref AS reasonRef,
  content_ref AS contentRef, cost_micros AS costMicros, duration_ms AS durationMs,
  owner_rating AS ownerRating, rated_at AS ratedAt, category,
  confidence_permille AS confidencePermille, inferred`;

function entryFromRow(row: Record<string, unknown>): DecisionLedgerEntry {
  const inputs = JSON.parse(row["inputs"] as string) as {
    memoryIds?: readonly string[];
    ruleIds?: readonly string[];
    batchId?: string | null;
    resultMemoryIds?: readonly string[];
    sourceIds?: readonly string[];
    floorHits?: Record<string, readonly string[]>;
    memoryInjected?: boolean;
    usedMemoryIds?: readonly string[];
    memoryByMail?: Record<string, readonly string[]>;
    memoryRecall?: "off" | "ok" | "partial" | "failed";
  };
  return Object.freeze({
    ...(row as unknown as DecisionLedgerEntry),
    inferred: row["inferred"] === null ? null : row["inferred"] === 1,
    inputs: Object.freeze({
      memoryIds: Object.freeze([...(inputs.memoryIds ?? [])]),
      ruleIds: Object.freeze([...(inputs.ruleIds ?? [])]),
      batchId: inputs.batchId ?? null,
      resultMemoryIds: Object.freeze([...(inputs.resultMemoryIds ?? [])]),
      sourceIds: Object.freeze([...(inputs.sourceIds ?? [])]),
      floorHits: Object.freeze(
        Object.fromEntries(
          Object.entries(inputs.floorHits ?? {}).map(([id, rules]) => [
            id,
            Object.freeze([...rules]),
          ]),
        ),
      ),
      memoryInjected: inputs.memoryInjected ?? false,
      usedMemoryIds: Object.freeze([...(inputs.usedMemoryIds ?? [])]),
      memoryByMail: Object.freeze(
        Object.fromEntries(
          Object.entries(inputs.memoryByMail ?? {}).map(([id, list]) => [
            id,
            Object.freeze([...list]),
          ]),
        ),
      ),
      memoryRecall: inputs.memoryRecall ?? "off",
    }),
  });
}

export class SqliteDecisionLedgerOperations {
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
      case "decisionLedger.append":
        return this.append(payload as Input<"append">);
      case "decisionLedger.list":
        return this.list(payload as Input<"list">);
      case "decisionLedger.rate":
        return this.rate(payload as Input<"rate">);
      case "decisionLedger.listReviewPool":
        return this.listReviewPool(payload as Input<"listReviewPool">);
      case "decisionLedger.rateMany":
        return this.rateMany(payload as Input<"rateMany">);
      case "decisionLedger.recordMuse":
        return this.recordMuse(payload as Input<"recordMuse">);
      case "decisionLedger.listMuse":
        return this.listMuse(payload as Input<"listMuse">);
      default:
        return this.fail(
          "PORT_INVALID_OPERATION",
          `Unknown decision ledger operation ${operation}`,
        );
    }
  }

  private append(write: Input<"append">): void {
    this.assertDiskHeadroom();
    const problem = validateLedgerWrite(write);
    if (problem) this.fail("PORT_INVALID_OPERATION", problem);
    insertLedgerRow(this.database, write);
  }

  private list(input: Input<"list">): readonly DecisionLedgerEntry[] {
    if (!validTime(input.since)) this.fail("PORT_INVALID_OPERATION", "Ledger time is invalid");
    if (!Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > 500)
      this.fail("PORT_INVALID_OPERATION", "Ledger limit is invalid");
    if (input.kind !== undefined && !(DECISION_KINDS as readonly string[]).includes(input.kind))
      this.fail("PORT_INVALID_OPERATION", "Ledger kind is invalid");
    return this.database
      .prepare(
        `SELECT ${entryColumns} FROM decision_ledger
         WHERE owner_id = ? AND agent_id = ? AND checked_at >= ? AND (? IS NULL OR kind = ?)
         ORDER BY checked_at DESC, id DESC LIMIT ?`,
      )
      .all(
        input.ownerId,
        input.agentId,
        input.since,
        input.kind ?? null,
        input.kind ?? null,
        input.limit,
      )
      .map((row) => entryFromRow(row as Record<string, unknown>));
  }

  private rate(input: Input<"rate">): boolean {
    if (!validTime(input.now)) this.fail("PORT_INVALID_OPERATION", "Ledger time is invalid");
    if (input.rating !== null && !(DECISION_RATINGS as readonly string[]).includes(input.rating))
      this.fail("PORT_INVALID_OPERATION", "Ledger rating is invalid");
    return (
      this.database
        .prepare(
          `UPDATE decision_ledger SET owner_rating = ?, rated_at = ?
           WHERE owner_id = ? AND agent_id = ? AND id = ?`,
        )
        .run(
          input.rating,
          input.rating === null ? null : input.now,
          input.ownerId,
          input.agentId,
          input.decisionId,
        ).changes > 0
    );
  }

  private listReviewPool(input: Input<"listReviewPool">): readonly DecisionLedgerEntry[] {
    if (!validTime(input.since) || !validTime(input.ratedSince))
      this.fail("PORT_INVALID_OPERATION", "Ledger time is invalid");
    if (!Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > 500)
      this.fail("PORT_INVALID_OPERATION", "Ledger limit is invalid");
    return this.database
      .prepare(
        `SELECT ${entryColumns} FROM decision_ledger
         WHERE owner_id = ? AND agent_id = ? AND checked_at >= ?
           AND (owner_rating IS NULL OR rated_at >= ?)
           AND (kind <> 'proactive' OR verdict IN ('pushed', 'deferred', 'silent'))
         ORDER BY checked_at DESC, id DESC LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, input.since, input.ratedSince, input.limit)
      .map((row) => entryFromRow(row as Record<string, unknown>));
  }

  private rateMany(input: Input<"rateMany">): number {
    if (!validTime(input.now)) this.fail("PORT_INVALID_OPERATION", "Ledger time is invalid");
    if (
      !Array.isArray(input.ratings) ||
      input.ratings.length < 1 ||
      input.ratings.length > 50 ||
      new Set(input.ratings.map(({ decisionId }) => decisionId)).size !== input.ratings.length
    )
      this.fail("PORT_INVALID_OPERATION", "Ledger ratings are invalid");
    for (const { rating } of input.ratings)
      if (rating !== null && !(DECISION_RATINGS as readonly string[]).includes(rating))
        this.fail("PORT_INVALID_OPERATION", "Ledger rating is invalid");
    const update = this.database.prepare(
      `UPDATE decision_ledger SET owner_rating = ?, rated_at = ?
       WHERE owner_id = ? AND agent_id = ? AND id = ?`,
    );
    return this.database.transaction(() => {
      let changed = 0;
      for (const { decisionId, rating } of input.ratings) {
        const result = update.run(
          rating,
          rating === null ? null : input.now,
          input.ownerId,
          input.agentId,
          decisionId,
        );
        if (result.changes === 0) this.fail("PORT_NOT_FOUND", "Ledger decision was not found");
        changed += result.changes;
      }
      return changed;
    })();
  }

  private recordMuse(write: MuseReferenceWrite): void {
    this.assertDiskHeadroom();
    const intakeItemKey = write.intakeItemKey ?? null;
    const common =
      text(write.id, 1, 128) &&
      validTime(write.museAt) &&
      validTime(write.recordedAt) &&
      (write.noteRef === null || text(write.noteRef, 1, 256)) &&
      (intakeItemKey === null || text(intakeItemKey, 3, 200));
    const shape =
      write.museReminded === true
        ? typeof write.timingOk === "boolean" &&
          typeof write.contentOk === "boolean" &&
          (write.contentRef === null || text(write.contentRef, 1, 256)) &&
          (write.contentRef !== null || intakeItemKey !== null) &&
          (write.pairedDecisionId === null || text(write.pairedDecisionId, 1, 128))
        : write.museReminded === false &&
          text(write.pairedDecisionId, 1, 128) &&
          !("timingOk" in write) &&
          !("contentOk" in write) &&
          !("contentRef" in write);
    if (!common || !shape) this.fail("PORT_INVALID_OPERATION", "Muse reference entry is invalid");
    const reminded = write.museReminded === true;
    this.database
      .prepare(
        `INSERT INTO muse_reference_entries (
          id, owner_id, agent_id, muse_at, muse_reminded, timing_ok, content_ok, content_ref,
          note_ref, paired_decision_id, intake_item_key, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        write.id,
        write.ownerId,
        write.agentId,
        write.museAt,
        reminded ? 1 : 0,
        reminded ? (write.timingOk ? 1 : 0) : null,
        reminded ? (write.contentOk ? 1 : 0) : null,
        reminded ? write.contentRef : null,
        write.noteRef,
        write.pairedDecisionId,
        intakeItemKey,
        write.recordedAt,
      );
  }

  private listMuse(input: Input<"listMuse">): readonly MuseReferenceEntry[] {
    if (!validTime(input.since)) this.fail("PORT_INVALID_OPERATION", "Ledger time is invalid");
    if (!Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > 500)
      this.fail("PORT_INVALID_OPERATION", "Ledger limit is invalid");
    return this.database
      .prepare(
        `SELECT id, muse_at AS museAt, muse_reminded AS museReminded, timing_ok AS timingOk,
           content_ok AS contentOk, content_ref AS contentRef, note_ref AS noteRef,
           paired_decision_id AS pairedDecisionId, intake_item_key AS intakeItemKey,
           recorded_at AS recordedAt
         FROM muse_reference_entries
         WHERE owner_id = ? AND agent_id = ? AND muse_at >= ?
         ORDER BY muse_at DESC, id DESC LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, input.since, input.limit)
      .map((row) => {
        const entry = row as Record<string, unknown>;
        return Object.freeze({
          ...(entry as unknown as MuseReferenceEntry),
          museReminded: entry["museReminded"] === 1,
          timingOk: entry["timingOk"] === null ? null : entry["timingOk"] === 1,
          contentOk: entry["contentOk"] === null ? null : entry["contentOk"] === 1,
        });
      });
  }
}
