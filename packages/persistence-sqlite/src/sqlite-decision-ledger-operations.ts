import {
  type CalibrationRowsSnapshot,
  DECISION_CATEGORIES,
  DECISION_KINDS,
  DECISION_OUTCOMES,
  DECISION_RATINGS,
  type DecisionInputs,
  type DecisionLedgerEntry,
  type DecisionLedgerPort,
  type DecisionLedgerWrite,
  type DecisionRating,
  type DecisionRecordRead,
  type DecisionSignalEntry,
  type GapCandidate,
  type GapCaseMarkPort,
  type GapCaseMarkRow,
  type MailTrace,
  type MuseReferenceEntry,
  type MuseReferenceWrite,
} from "@himawari-agent/application/decision-ledger";
import { readCalibrationRows } from "@himawari-agent/calibration";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Input<TName extends keyof DecisionLedgerPort> = Parameters<DecisionLedgerPort[TName]>[0];

type MarkInput<TName extends keyof GapCaseMarkPort> = Parameters<GapCaseMarkPort[TName]>[0];

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
    tentativeMemoryIds?: readonly string[];
    memoryByMail?: Record<string, readonly string[]>;
    memoryRecall?: "off" | "ok" | "partial" | "failed";
    relatedByMail?: Record<string, readonly string[]>;
    relatedRead?: "off" | "ok" | "partial" | "failed";
    relatedStats?: DecisionInputs["relatedStats"];
    relatedFailedSteps?: readonly string[];
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
      tentativeMemoryIds: Object.freeze([...(inputs.tentativeMemoryIds ?? [])]),
      memoryByMail: Object.freeze(
        Object.fromEntries(
          Object.entries(inputs.memoryByMail ?? {}).map(([id, list]) => [
            id,
            Object.freeze([...list]),
          ]),
        ),
      ),
      memoryRecall: inputs.memoryRecall ?? "off",
      relatedByMail: Object.freeze(
        Object.fromEntries(
          Object.entries(inputs.relatedByMail ?? {}).map(([id, list]) => [
            id,
            Object.freeze([...list]),
          ]),
        ),
      ),
      relatedRead: inputs.relatedRead ?? "off",
      relatedStats: Object.freeze(
        inputs.relatedStats ?? {
          requests: 0,
          messages: 0,
          characters: 0,
          durationMs: 0,
        },
      ),
      relatedFailedSteps: Object.freeze([...(inputs.relatedFailedSteps ?? [])]),
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
      case "decisionLedger.read":
        return this.readOne(payload as Input<"read">);
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
      case "decisionLedger.listSignals":
        return this.listSignals(payload as Input<"listSignals">);
      case "decisionLedger.readCalibrationRows":
        return this.readCalibrationRows(payload as Input<"readCalibrationRows">);
      case "decisionLedger.gapMark":
        return this.gapMark(payload as MarkInput<"mark">);
      case "decisionLedger.gapUnmark":
        return this.gapUnmark(payload as MarkInput<"unmark">);
      case "decisionLedger.gapMarks":
        return this.gapMarks(payload as MarkInput<"list">);
      case "decisionLedger.readMailTrace":
        return this.readMailTrace(payload as Input<"readMailTrace">);
      case "decisionLedger.readGapCandidates":
        return this.readGapCandidates(payload as Input<"readGapCandidates">);
      default:
        return this.fail(
          "PORT_INVALID_OPERATION",
          `Unknown decision ledger operation ${operation}`,
        );
    }
  }

  private readCalibrationRows(input: Input<"readCalibrationRows">): CalibrationRowsSnapshot {
    if (!validTime(input.start) || !validTime(input.end) || input.start >= input.end)
      this.fail("PORT_INVALID_OPERATION", "Calibration window is invalid");
    return this.database.transaction(() => {
      try {
        const rows = readCalibrationRows(this.database, input);
        return {
          decisions: rows.decisions.map((row) => ({ ...row })),
          entries: rows.entries.map((row) => ({ ...row })),
          mailJudgments: [...rows.mailJudgments.entries()].map(
            ([id, judgment]) => [id, { ...judgment }] as const,
          ),
          signals: rows.signals.map((row) => ({ ...row })),
        };
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("CALIBRATION_TIMESTAMP_FORMAT"))
          return this.fail("PORT_INVALID_OPERATION", "CALIBRATION_TIMESTAMP_FORMAT");
        throw error;
      }
    })();
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

  private readOne(input: Input<"read">): DecisionRecordRead | undefined {
    if (
      typeof input.decisionId !== "string" ||
      input.decisionId.length < 1 ||
      input.decisionId.length > 128
    )
      this.fail("PORT_INVALID_OPERATION", "Ledger decision id is invalid");
    const row = this.database
      .prepare(
        `SELECT ${entryColumns} FROM decision_ledger
         WHERE owner_id = ? AND agent_id = ? AND id = ?`,
      )
      .get(input.ownerId, input.agentId, input.decisionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const inputFields = Object.keys(JSON.parse(row["inputs"] as string) as object).sort();
    return Object.freeze({
      entry: entryFromRow(row),
      inputFields: Object.freeze(inputFields),
    });
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
    const pairedMessageId = write.pairedMessageId ?? null;
    const common =
      (pairedMessageId === null || text(pairedMessageId, 1, 256)) &&
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
          (write.pairedDecisionId === null || text(write.pairedDecisionId, 1, 128)) &&
          (write.pairedDecisionId !== null || pairedMessageId !== null) &&
          !("timingOk" in write) &&
          !("contentOk" in write) &&
          !("contentRef" in write);
    if (!common || !shape) this.fail("PORT_INVALID_OPERATION", "Muse reference entry is invalid");
    const reminded = write.museReminded === true;
    this.database
      .prepare(
        `INSERT INTO muse_reference_entries (
          id, owner_id, agent_id, muse_at, muse_reminded, timing_ok, content_ok, content_ref,
          note_ref, paired_decision_id, intake_item_key, paired_message_id, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        pairedMessageId,
        write.recordedAt,
      );
  }

  private listSignals(input: Input<"listSignals">): readonly DecisionSignalEntry[] {
    if (!idList(input.decisionIds)) this.fail("PORT_INVALID_OPERATION", "Decision ids are invalid");
    const read = this.database.prepare(
      `SELECT decision_id AS decisionId, signal, occurred_at AS occurredAt, delay_ms AS delayMs,
        detail FROM decision_signals
       WHERE owner_id = ? AND agent_id = ? AND decision_id = ?
       ORDER BY occurred_at, id`,
    );
    return input.decisionIds.flatMap((decisionId) =>
      (
        read.all(input.ownerId, input.agentId, decisionId) as (Omit<
          DecisionSignalEntry,
          "detail"
        > & {
          detail: string;
        })[]
      ).map((row) => ({ ...row, detail: JSON.parse(row.detail) })),
    );
  }

  private gapMark(input: MarkInput<"mark">): boolean {
    return (
      Number(
        this.database
          .prepare(
            `INSERT OR IGNORE INTO gap_case_marks (owner_id, agent_id, case_id, snapshot_ref, marked_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(input.ownerId, input.agentId, input.caseId, input.snapshotRef, input.at).changes,
      ) === 1
    );
  }

  private gapUnmark(input: MarkInput<"unmark">): string | null {
    return this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT snapshot_ref AS snapshotRef FROM gap_case_marks
           WHERE owner_id = ? AND agent_id = ? AND case_id = ?`,
        )
        .get(input.ownerId, input.agentId, input.caseId) as { snapshotRef: string } | undefined;
      if (row === undefined) return null;
      this.database
        .prepare("DELETE FROM gap_case_marks WHERE owner_id = ? AND agent_id = ? AND case_id = ?")
        .run(input.ownerId, input.agentId, input.caseId);
      this.database
        .prepare("DELETE FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?")
        .run(row.snapshotRef, input.ownerId, input.agentId);
      return row.snapshotRef;
    })();
  }

  private gapMarks(input: MarkInput<"list">): readonly GapCaseMarkRow[] {
    return this.database
      .prepare(
        `SELECT case_id AS caseId, snapshot_ref AS snapshotRef, marked_at AS markedAt
         FROM gap_case_marks WHERE owner_id = ? AND agent_id = ?
         ORDER BY marked_at, case_id`,
      )
      .all(input.ownerId, input.agentId) as GapCaseMarkRow[];
  }

  private readMailTrace(input: Input<"readMailTrace">): MailTrace {
    const processedRow = this.database
      .prepare(
        `SELECT decision_id AS decisionId, thread_id AS threadId, outcome, skip_reason AS skipReason,
           owner_rating AS ownerRating, processed_at AS processedAt
         FROM proactive_processed_messages
         WHERE owner_id = ? AND agent_id = ? AND source = 'gmail' AND message_id = ?`,
      )
      .get(input.ownerId, input.agentId, input.messageId) as Record<string, unknown> | undefined;
    const asText = (value: unknown) => (typeof value === "string" ? value : null);
    const entries = this.database
      .prepare(
        `SELECT e.id AS entryId, e.muse_at AS museAt, e.muse_reminded AS museReminded,
           e.timing_ok AS timingOk, e.content_ok AS contentOk, e.content_ref AS contentRef,
           i.kind AS kind, i.state AS state, i.title_ref AS titleRef, i.text_ref AS textRef,
           COALESCE(i.text_withheld, 0) AS textWithheld
         FROM muse_reference_entries e
         LEFT JOIN muse_intake_items i
           ON i.owner_id = e.owner_id AND i.agent_id = e.agent_id
          AND e.intake_item_key = i.kind || ':' || i.natural_key
         WHERE e.owner_id = ? AND e.agent_id = ? AND e.paired_message_id = ?
         ORDER BY e.muse_at, e.id`,
      )
      .all(input.ownerId, input.agentId, input.messageId) as Record<string, unknown>[];
    return Object.freeze({
      processed: processedRow
        ? Object.freeze({
            decisionId: String(processedRow["decisionId"]),
            threadId: String(processedRow["threadId"]),
            outcome: String(processedRow["outcome"]),
            skipReason: asText(processedRow["skipReason"]),
            ownerRating: asText(processedRow["ownerRating"]) as DecisionRating | null,
            processedAt: String(processedRow["processedAt"]),
          })
        : null,
      museEntries: Object.freeze(
        entries.map((row) =>
          Object.freeze({
            entryId: String(row["entryId"]),
            museAt: String(row["museAt"]),
            museReminded: row["museReminded"] === 1,
            timingOk: row["timingOk"] === null ? null : row["timingOk"] === 1,
            contentOk: row["contentOk"] === null ? null : row["contentOk"] === 1,
            kind: asText(row["kind"]),
            state: asText(row["state"]),
            titleRef: asText(row["titleRef"]),
            textRef: asText(row["textRef"]),
            contentRef: asText(row["contentRef"]),
            textWithheld: row["textWithheld"] === 1,
          }),
        ),
      ),
    });
  }

  private readGapCandidates(input: Input<"readGapCandidates">): readonly GapCandidate[] {
    if (!validTime(input.start) || !validTime(input.end) || input.start >= input.end)
      this.fail("PORT_INVALID_OPERATION", "Gap window is invalid");
    const rows = this.database
      .prepare(
        `SELECT e.id AS entryId, e.muse_at AS museAt, e.timing_ok AS timingOk,
           e.content_ok AS contentOk, e.paired_message_id AS pairedMessageId,
           e.content_ref AS museContentRef, i.title_ref AS museTitleRef, i.text_ref AS museTextRef,
           COALESCE(i.text_withheld, 0) AS museTextWithheld,
           d.id AS decisionId, p.outcome AS outcome, p.owner_rating AS ownerRating,
           d.reason_code AS reasonCode, d.reason_ref AS reasonRef, d.checked_at AS decidedAt,
           d.inputs AS inputs
         FROM muse_reference_entries e
         JOIN proactive_processed_messages p
           ON p.owner_id = e.owner_id AND p.agent_id = e.agent_id
          AND p.source = 'gmail' AND p.message_id = e.paired_message_id
         JOIN decision_ledger d ON d.id = p.decision_id
         LEFT JOIN muse_intake_items i
           ON i.owner_id = e.owner_id AND i.agent_id = e.agent_id
          AND e.intake_item_key = i.kind || ':' || i.natural_key
         WHERE e.owner_id = ? AND e.agent_id = ? AND e.muse_at >= ? AND e.muse_at < ?
           AND e.muse_reminded = 1 AND e.paired_message_id IS NOT NULL
         ORDER BY e.muse_at, e.id LIMIT 1000`,
      )
      .all(input.ownerId, input.agentId, input.start, input.end) as Record<string, unknown>[];
    return rows.map((row) => {
      const inputs = JSON.parse(String(row["inputs"])) as DecisionInputs;
      const messageId = String(row["pairedMessageId"]);
      const asText = (value: unknown) => (typeof value === "string" ? value : null);
      return Object.freeze({
        entryId: String(row["entryId"]),
        museAt: String(row["museAt"]),
        timingOk: row["timingOk"] === null ? null : row["timingOk"] === 1,
        contentOk: row["contentOk"] === null ? null : row["contentOk"] === 1,
        pairedMessageId: messageId,
        museTitleRef: asText(row["museTitleRef"]),
        museTextRef: asText(row["museTextRef"]),
        museContentRef: asText(row["museContentRef"]),
        museTextWithheld: row["museTextWithheld"] === 1,
        decisionId: String(row["decisionId"]),
        outcome: String(row["outcome"]),
        ownerRating: asText(row["ownerRating"]) as GapCandidate["ownerRating"],
        reasonCode: String(row["reasonCode"]),
        reasonRef: asText(row["reasonRef"]),
        decidedAt: String(row["decidedAt"]),
        relatedRead: asText(inputs.relatedRead),
        memoryRecall: asText(inputs.memoryRecall),
        memoryHitsForMail: inputs.memoryByMail?.[messageId]?.length ?? 0,
        relatedMessagesForMail: inputs.relatedByMail?.[messageId]?.length ?? 0,
      });
    });
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
           paired_message_id AS pairedMessageId, recorded_at AS recordedAt
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
