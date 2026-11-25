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
  type RuleLastUse,
  SPOKEN_VERDICTS,
} from "@himawari-agent/application/decision-ledger";
import { GMAIL_SOURCE } from "@himawari-agent/application/proactive-sources";
import { parseRuleRef, type RuleBookVersion } from "@himawari-agent/application/rule-ref";
import { readCalibrationRows } from "@himawari-agent/calibration";
import { readPrereviewWeek } from "@himawari-agent/calibration/prereview";
import type Database from "better-sqlite3";
import { summaryInputsValid } from "./sqlite-decision-summary-inputs.ts";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";
import { defaultRuleParameters } from "./sqlite-proactive-operations.ts";

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
    !summaryInputsValid(write.inputs, MAX_IDS) ||
    (write.inputs.summaryRead !== undefined && write.kind !== "external_read")
  )
    return "Decision ledger summary inputs are invalid";
  const budget = write.inputs.profileBudget ?? null;
  if (
    budget !== null &&
    (write.kind !== "context_truncation" ||
      !Number.isSafeInteger(budget.limit) ||
      budget.limit < 1 ||
      !Number.isSafeInteger(budget.used) ||
      budget.used < 0 ||
      !Number.isSafeInteger(budget.pinned) ||
      budget.pinned < 0 ||
      budget.pinned > budget.used)
  )
    return "Decision ledger profile budget is invalid";
  const change = write.inputs.limitChange ?? null;
  const limitValue = (value: unknown) =>
    value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
  if ((write.kind === "limit_change") !== (change !== null))
    return "Decision ledger limit change is invalid";
  if (
    change !== null &&
    (!text(change.key, 1, 128) ||
      !limitValue(change.from) ||
      !limitValue(change.to) ||
      change.from === change.to)
  )
    return "Decision ledger limit change is invalid";
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
  if (
    !summaryInputsValid(write.inputs, MAX_IDS) ||
    (write.inputs.summaryRead !== undefined && write.kind !== "external_read")
  )
    throw new Error("Decision ledger summary inputs are invalid");
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
        ...(write.inputs.profileBudget ? { profileBudget: write.inputs.profileBudget } : {}),
        ...(write.inputs.limitChange ? { limitChange: write.inputs.limitChange } : {}),
        ...(write.inputs.summaryRead === undefined
          ? {}
          : {
              summaryInjected: write.inputs.summaryInjected,
              summaryIds: write.inputs.summaryIds,
              summaryDays: write.inputs.summaryDays,
              summaryCharacters: write.inputs.summaryCharacters,
              summaryRead: write.inputs.summaryRead,
              summaryGenerated: write.inputs.summaryGenerated,
            }),
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
    ruleHits?: Record<string, readonly string[]>;
    memoryInjected?: boolean;
    usedMemoryIds?: readonly string[];
    tentativeMemoryIds?: readonly string[];
    memoryByMail?: Record<string, readonly string[]>;
    memoryRecall?: "off" | "ok" | "partial" | "failed";
    relatedByMail?: Record<string, readonly string[]>;
    relatedRead?: "off" | "ok" | "partial" | "failed";
    relatedStats?: DecisionInputs["relatedStats"];
    relatedFailedSteps?: readonly string[];
    summaryInjected?: boolean;
    summaryIds?: readonly string[];
    summaryDays?: readonly string[];
    summaryCharacters?: number;
    summaryRead?: "off" | "ok" | "partial" | "failed";
    summaryGenerated?: number;
    profileBudget?: DecisionInputs["profileBudget"];
    limitChange?: DecisionInputs["limitChange"];
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
      ruleHits: Object.freeze(
        Object.fromEntries(
          Object.entries(inputs.ruleHits ?? {}).map(([id, rules]) => [
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
      summaryInjected: inputs.summaryInjected ?? false,
      summaryIds: Object.freeze([...(inputs.summaryIds ?? [])]),
      summaryDays: Object.freeze([...(inputs.summaryDays ?? [])]),
      summaryCharacters: inputs.summaryCharacters ?? 0,
      summaryRead: inputs.summaryRead ?? "off",
      summaryGenerated: inputs.summaryGenerated ?? 0,
      profileBudget: inputs.profileBudget ? Object.freeze({ ...inputs.profileBudget }) : null,
      limitChange: inputs.limitChange ? Object.freeze({ ...inputs.limitChange }) : null,
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
      case "decisionLedger.recordSpoken":
        return this.recordSpoken(payload as Input<"recordSpoken">);
      case "decisionLedger.appendIfChanged":
        return this.appendIfChanged(payload as Input<"appendIfChanged">);
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
      case "decisionLedger.lastRuleUses":
        return this.lastRuleUses(payload as Input<"lastRuleUses">);
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
          prereviews: readPrereviewWeek(this.database, input).map((row) => ({ ...row })),
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

  private recordSpoken(write: Input<"recordSpoken">): boolean {
    this.assertDiskHeadroom();
    if (
      !text(write.id, 1, 128) ||
      !text(write.scenario, 1, 64) ||
      !/^[a-z][a-z0-9_]*$/u.test(write.scenario) ||
      !(SPOKEN_VERDICTS as readonly string[]).includes(write.verdict) ||
      !text(write.reasonCode, 1, 64) ||
      !text(write.subjectRef, 1, 256) ||
      !text(write.runId, 1, 256) ||
      (write.messageId !== null && !text(write.messageId, 1, 256)) ||
      (write.pushSourceKey !== null && !text(write.pushSourceKey, 1, 256)) ||
      !idList(write.sourceIds) ||
      !validTime(write.decidedAt) ||
      !Number.isSafeInteger(write.durationMs) ||
      write.durationMs < 0 ||
      write.durationMs > 86_400_000
    )
      this.fail("PORT_INVALID_OPERATION", "Spoken decision is invalid");
    return (
      this.database
        .prepare(
          `INSERT INTO decision_ledger (
            id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, outcome,
            reason_code, subject_ref, inputs, reason_ref, content_ref, push_source_key,
            cost_micros, duration_ms, owner_rating, rated_at
          ) VALUES (?, ?, ?, 'proactive', ?, ?, '{}', ?, NULL, ?, ?, ?, ?, NULL, ?, 0, ?, NULL, NULL)
          ON CONFLICT (id) DO NOTHING`,
        )
        .run(
          write.id,
          write.ownerId,
          write.agentId,
          write.scenario,
          write.decidedAt,
          write.verdict,
          write.reasonCode,
          write.subjectRef,
          JSON.stringify({
            memoryIds: [],
            ruleIds: [],
            sourceIds: write.sourceIds,
            runId: write.runId,
            messageId: write.messageId,
          }),
          write.reasonRef,
          write.pushSourceKey,
          write.durationMs,
        ).changes > 0
    );
  }

  private appendIfChanged(input: Input<"appendIfChanged">): boolean {
    this.assertDiskHeadroom();
    const { write, reasonCodes } = input;
    const problem = validateLedgerWrite(write);
    if (problem) this.fail("PORT_INVALID_OPERATION", problem);
    if (
      !Array.isArray(reasonCodes) ||
      reasonCodes.length < 1 ||
      reasonCodes.length > 16 ||
      !reasonCodes.every((code) => text(code, 1, 64)) ||
      !reasonCodes.includes(write.reasonCode)
    )
      this.fail("PORT_INVALID_OPERATION", "Decision ledger reason codes are invalid");
    return this.database.transaction(() => {
      const latest = this.database
        .prepare(
          `SELECT reason_code AS reasonCode, inputs FROM decision_ledger
           WHERE owner_id = ? AND agent_id = ? AND kind = ?
             AND reason_code IN (SELECT value FROM json_each(?))
           ORDER BY rowid DESC LIMIT 1`,
        )
        .get(write.ownerId, write.agentId, write.kind, JSON.stringify(reasonCodes)) as
        | { reasonCode: string; inputs: string }
        | undefined;
      if (latest?.reasonCode === write.reasonCode) {
        const before = (JSON.parse(latest.inputs) as { memoryIds?: readonly string[] }).memoryIds;
        const now = write.inputs.memoryIds;
        if (before?.length === now.length && new Set([...before, ...now]).size === now.length)
          return false;
      }
      insertLedgerRow(this.database, write);
      return true;
    })();
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
    const entry = entryFromRow(row);
    return Object.freeze({
      entry,
      inputFields: Object.freeze(inputFields),
      ruleVersions: this.readRuleVersions(input, entry.inputs.ruleIds),
    });
  }

  private readRuleVersions(
    scope: Input<"read">,
    refs: readonly string[],
  ): Readonly<Record<string, RuleBookVersion>> {
    const current = this.database.prepare(
      `SELECT rule_id AS ruleId, revision, parameters, status, source_memory_id AS sourceMemoryId,
         updated_at AS changedAt
       FROM rule_book_rules WHERE owner_id = ? AND agent_id = ? AND rule_id = ?`,
    );
    const past = this.database.prepare(
      `SELECT rule_id AS ruleId, revision, parameters, status, source_memory_id AS sourceMemoryId,
         changed_at AS changedAt
       FROM rule_book_history
       WHERE owner_id = ? AND agent_id = ? AND rule_id = ? AND revision = ?`,
    );
    const versions: Record<string, RuleBookVersion> = Object.create(null);
    for (const ref of new Set(refs)) {
      const { ruleId, revision } = parseRuleRef(ref);
      const found = (
        revision === null
          ? current.get(scope.ownerId, scope.agentId, ruleId)
          : past.get(scope.ownerId, scope.agentId, ruleId, revision)
      ) as
        | {
            ruleId: string;
            revision: number;
            parameters: string;
            status: RuleBookVersion["status"];
            sourceMemoryId: string | null;
            changedAt: string;
          }
        | undefined;
      if (found) {
        versions[ref] = Object.freeze({
          ...found,
          parameters: Object.freeze(JSON.parse(found.parameters) as Record<string, unknown>),
        });
        continue;
      }
      const defaults = revision === 0 ? defaultRuleParameters(ruleId) : undefined;
      if (defaults)
        versions[ref] = Object.freeze({
          ruleId,
          revision: 0,
          parameters: defaults,
          status: "active",
          sourceMemoryId: null,
          changedAt: null,
        });
    }
    return Object.freeze(versions);
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
           AND kind <> 'web_push'
           AND (kind <> 'proactive' OR verdict IN ('pushed', 'deferred', 'silent'))
           AND kind <> 'memory_review'
           AND NOT (kind = 'rule_review' AND substr(outcome, 1, 6) = 'owner_')
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
         WHERE owner_id = ? AND agent_id = ? AND source = '${GMAIL_SOURCE.name}' AND message_id = ?`,
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
         ORDER BY e.muse_at, e.id LIMIT 1000`,
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
          AND p.source = '${GMAIL_SOURCE.name}' AND p.message_id = e.paired_message_id
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

  private lastRuleUses(input: Input<"lastRuleUses">): readonly RuleLastUse[] {
    if (
      !Array.isArray(input.ruleIds) ||
      input.ruleIds.length > 64 ||
      input.ruleIds.some((id) => typeof id !== "string" || id.length < 1 || id.length > 128)
    )
      this.fail("PORT_INVALID_OPERATION", "Ledger rule ids are invalid");
    const statement = this.database.prepare(
      `SELECT id, kind, checked_at AS decidedAt FROM decision_ledger
       WHERE owner_id = ? AND agent_id = ? AND kind = 'proactive' AND json_array_length(inputs, '$.ruleIds') > 0
         AND EXISTS (
           SELECT 1 FROM json_each(decision_ledger.inputs, '$.ruleIds') AS ref
           WHERE ref.value = ? OR substr(ref.value, 1, length(?) + 1) = ? || '@'
         )
       ORDER BY checked_at DESC, id DESC LIMIT 1`,
    );
    const found: RuleLastUse[] = [];
    for (const ruleId of [...new Set(input.ruleIds)]) {
      const row = statement.get(input.ownerId, input.agentId, ruleId, ruleId, ruleId) as
        | { id: string; kind: string; decidedAt: string }
        | undefined;
      if (row)
        found.push(
          Object.freeze({
            ruleId,
            decisionId: row.id,
            kind: row.kind as RuleLastUse["kind"],
            decidedAt: row.decidedAt,
          }),
        );
    }
    return found;
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
