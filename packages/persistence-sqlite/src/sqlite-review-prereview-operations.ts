import type {
  PrereviewAttempt,
  PrereviewDone,
  PrereviewFailure,
  PrereviewPairRecord,
  PrereviewRecord,
  PrereviewSubjectRef,
  PrereviewVersion,
} from "@himawari-agent/application";
import {
  type CalibrationGroup,
  type CalibrationRating,
  calibrationGroup,
} from "@himawari-agent/calibration";
import { acceptsPrereview, isPrereviewGroup } from "@himawari-agent/calibration/prereview";
import type { AgentId, OwnerId } from "@himawari-agent/domain";
import { GMAIL_SOURCE } from "@himawari-agent/application/proactive-sources";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

interface Scope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

const MAIL_SOURCE = GMAIL_SOURCE.name;
const SUBJECT_LIMIT = 2_000;
const CLASSIFICATIONS: readonly string[] = ["public", "private", "sensitive"];

const OWNER_RATING = `CASE WHEN p.decision_id IS NOT NULL THEN d.owner_rating
    ELSE COALESCE(m.owner_rating, CASE WHEN m.reviewed_at IS NOT NULL THEN 'useful' END) END`;

const JOINED = `FROM decision_prereviews p
  LEFT JOIN decision_ledger d ON d.id = p.decision_id
  LEFT JOIN proactive_processed_messages m
    ON m.owner_id = p.owner_id AND m.agent_id = p.agent_id
    AND m.source = p.mail_source AND m.message_id = p.message_id`;

function valid(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function refOf(row: {
  readonly decisionId: string | null;
  readonly messageId: string | null;
}): PrereviewSubjectRef {
  return row.decisionId !== null
    ? { source: "ledger", id: row.decisionId }
    : { source: "mail", id: row.messageId as string };
}

export class SqliteReviewPrereviewOperations {
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
      case "reviewPrereview.listDone":
        return this.listDone(
          payload as Scope & PrereviewVersion & { subjects: readonly PrereviewSubjectRef[] },
        );
      case "reviewPrereview.listRecentFailures":
        return this.listRecentFailures(
          payload as Scope &
            PrereviewVersion & { subjects: readonly PrereviewSubjectRef[]; since: string },
        );
      case "reviewPrereview.countSince":
        return this.countSince(payload as Scope & { since: string });
      case "reviewPrereview.ownerHistory":
        return this.ownerHistory(
          payload as Scope & { group: CalibrationGroup; category: string | null; since: string },
        );
      case "reviewPrereview.listPairs":
        return this.listPairs(payload as Scope & PrereviewVersion & { since: string });
      case "reviewPrereview.record":
        return this.record(payload as Scope & PrereviewRecord);
      case "reviewPrereview.recordFailure":
        return this.recordFailure(payload as Scope & PrereviewFailure);
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown prereview operation ${operation}`);
    }
  }

  private subjects(subjects: readonly PrereviewSubjectRef[]): string {
    if (
      subjects.length > SUBJECT_LIMIT ||
      subjects.some(
        (subject) =>
          (subject.source !== "ledger" && subject.source !== "mail") ||
          typeof subject.id !== "string" ||
          subject.id.length === 0 ||
          subject.id.length > 256,
      )
    )
      this.fail("PORT_INVALID_OPERATION", "Prereview subjects are invalid");
    return JSON.stringify(subjects.map(({ source, id }) => [source, id]));
  }

  private listDone(
    input: Scope & PrereviewVersion & { subjects: readonly PrereviewSubjectRef[] },
  ): readonly PrereviewDone[] {
    if (input.subjects.length === 0) return [];
    const subjects = this.subjects(input.subjects);
    const rows = this.database
      .prepare(
        `SELECT p.decision_id AS decisionId, p.message_id AS messageId,
          p.calibration_group AS "group", p.rating, p.confidence_permille AS confidencePermille,
          p.history_conflict AS historyConflict, p.text_digest AS textDigest
        FROM decision_prereviews p
        JOIN json_each(?) wanted
          ON (json_extract(wanted.value, '$[0]') = 'ledger'
              AND p.decision_id = json_extract(wanted.value, '$[1]'))
          OR (json_extract(wanted.value, '$[0]') = 'mail'
              AND p.mail_source = '${MAIL_SOURCE}'
              AND p.message_id = json_extract(wanted.value, '$[1]'))
        WHERE p.owner_id = ? AND p.agent_id = ? AND p.status = 'done'
          AND p.model_ref = ? AND p.prompt_id = ?
        ORDER BY p.created_at, p.id`,
      )
      .all(subjects, input.ownerId, input.agentId, input.modelRef, input.promptId) as {
      decisionId: string | null;
      messageId: string | null;
      group: CalibrationGroup;
      rating: PrereviewDone["rating"];
      confidencePermille: number;
      historyConflict: number;
      textDigest: string;
    }[];
    return rows.map((row) =>
      Object.freeze({
        subject: refOf(row),
        group: row.group,
        rating: row.rating,
        confidencePermille: row.confidencePermille,
        historyConflict: row.historyConflict === 1,
        textDigest: row.textDigest,
      }),
    );
  }

  private listRecentFailures(
    input: Scope & PrereviewVersion & { subjects: readonly PrereviewSubjectRef[]; since: string },
  ): readonly PrereviewSubjectRef[] {
    if (!valid(input.since)) this.fail("PORT_INVALID_OPERATION", "Prereview time is invalid");
    if (input.subjects.length === 0) return [];
    const subjects = this.subjects(input.subjects);
    return (
      this.database
        .prepare(
          `SELECT DISTINCT p.decision_id AS decisionId, p.message_id AS messageId
          FROM decision_prereviews p
          JOIN json_each(?) wanted
            ON (json_extract(wanted.value, '$[0]') = 'ledger'
                AND p.decision_id = json_extract(wanted.value, '$[1]'))
            OR (json_extract(wanted.value, '$[0]') = 'mail'
                AND p.mail_source = '${MAIL_SOURCE}'
                AND p.message_id = json_extract(wanted.value, '$[1]'))
          WHERE p.owner_id = ? AND p.agent_id = ? AND p.status = 'failed'
            AND p.model_ref = ? AND p.prompt_id = ? AND p.created_at >= ?
          ORDER BY p.decision_id, p.message_id`,
        )
        .all(
          subjects,
          input.ownerId,
          input.agentId,
          input.modelRef,
          input.promptId,
          input.since,
        ) as { decisionId: string | null; messageId: string | null }[]
    ).map(refOf);
  }

  private countSince(input: Scope & { since: string }): {
    attempts: number;
    costMicros: number;
  } {
    if (!valid(input.since)) this.fail("PORT_INVALID_OPERATION", "Prereview time is invalid");
    const row = this.database
      .prepare(
        `SELECT count(*) AS attempts, COALESCE(sum(cost_micros), 0) AS costMicros
        FROM decision_prereviews WHERE owner_id = ? AND agent_id = ? AND created_at >= ?`,
      )
      .get(input.ownerId, input.agentId, input.since) as { attempts: number; costMicros: number };
    return { attempts: row.attempts, costMicros: row.costMicros };
  }

  private ownerHistory(
    input: Scope & { group: CalibrationGroup; category: string | null; since: string },
  ): readonly CalibrationRating[] {
    if (!valid(input.since) || !isPrereviewGroup(input.group))
      this.fail("PORT_INVALID_OPERATION", "Prereview history query is invalid");
    const decisions = this.database
      .prepare(
        `SELECT kind, COALESCE(outcome, verdict) AS outcome, owner_rating AS ownerRating, category
        FROM decision_ledger
        WHERE owner_id = ? AND agent_id = ? AND owner_rating IS NOT NULL AND checked_at >= ?
        ORDER BY checked_at, id`,
      )
      .all(input.ownerId, input.agentId, input.since) as {
      kind: string;
      outcome: string | null;
      ownerRating: CalibrationRating;
      category: string | null;
    }[];
    const ratings = decisions
      .filter(
        (row) =>
          row.category === input.category &&
          calibrationGroup({ ...row, delivered: false }) === input.group,
      )
      .map(({ ownerRating }) => ownerRating);
    if (input.group !== "proactive_silent" || input.category !== null) return ratings;
    const mail = this.database
      .prepare(
        `SELECT COALESCE(owner_rating, CASE WHEN reviewed_at IS NOT NULL THEN 'useful' END) AS rating
        FROM proactive_processed_messages
        WHERE owner_id = ? AND agent_id = ? AND source = '${MAIL_SOURCE}' AND outcome = 'skipped'
          AND processed_at >= ? AND (owner_rating IS NOT NULL OR reviewed_at IS NOT NULL)
        ORDER BY processed_at, message_id`,
      )
      .all(input.ownerId, input.agentId, input.since) as { rating: CalibrationRating }[];
    return [...ratings, ...mail.map(({ rating }) => rating)];
  }

  private listPairs(
    input: Scope & PrereviewVersion & { since: string },
  ): readonly PrereviewPairRecord[] {
    if (!valid(input.since)) this.fail("PORT_INVALID_OPERATION", "Prereview time is invalid");
    return (
      this.database
        .prepare(
          `SELECT p.calibration_group AS "group", p.rating,
            p.confidence_permille AS confidencePermille, p.history_conflict AS historyConflict,
            ${OWNER_RATING} AS ownerRating
          ${JOINED}
          WHERE p.owner_id = ? AND p.agent_id = ? AND p.status = 'done'
            AND p.model_ref = ? AND p.prompt_id = ?
            AND COALESCE(d.checked_at, m.processed_at) >= ?
          ORDER BY p.created_at, p.id`,
        )
        .all(input.ownerId, input.agentId, input.modelRef, input.promptId, input.since) as {
        group: CalibrationGroup;
        rating: PrereviewPairRecord["rating"];
        confidencePermille: number;
        historyConflict: number;
        ownerRating: CalibrationRating | null;
      }[]
    ).map((row) => Object.freeze({ ...row, historyConflict: row.historyConflict === 1 }));
  }

  private checkAttempt(input: Scope & PrereviewAttempt): void {
    if (
      !isPrereviewGroup(input.group) ||
      !valid(input.createdAt) ||
      !CLASSIFICATIONS.includes(input.dataClassification) ||
      !/^[0-9a-f]{64}$/u.test(input.textDigest) ||
      !Number.isSafeInteger(input.costMicros) ||
      input.costMicros < 0 ||
      !Number.isSafeInteger(input.durationMs) ||
      input.durationMs < 0 ||
      (input.subject.source === "mail" &&
        (input.group !== "proactive_silent" || input.category !== null))
    )
      this.fail("PORT_INVALID_OPERATION", "Prereview record is invalid");
    const owned =
      input.subject.source === "ledger"
        ? this.database
            .prepare("SELECT 1 FROM decision_ledger WHERE id = ? AND owner_id = ? AND agent_id = ?")
            .get(input.subject.id, input.ownerId, input.agentId)
        : this.database
            .prepare(
              `SELECT 1 FROM proactive_processed_messages
              WHERE owner_id = ? AND agent_id = ? AND source = '${MAIL_SOURCE}' AND message_id = ?`,
            )
            .get(input.ownerId, input.agentId, input.subject.id);
    if (!owned) this.fail("PORT_NOT_FOUND", "Prereview subject not found");
  }

  private insert(
    input: Scope & PrereviewAttempt,
    result: {
      status: "done" | "failed";
      rating: string | null;
      confidencePermille: number | null;
      historyConflict: number | null;
      failureCode: string | null;
    },
  ): void {
    this.database
      .prepare(
        `INSERT INTO decision_prereviews (
          id, owner_id, agent_id, decision_id, mail_source, message_id, calibration_group,
          category, status, rating, confidence_permille, history_conflict, failure_code,
          model_ref, prompt_id, text_digest, data_classification, cost_micros, duration_ms,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING`,
      )
      .run(
        input.id,
        input.ownerId,
        input.agentId,
        input.subject.source === "ledger" ? input.subject.id : null,
        input.subject.source === "mail" ? MAIL_SOURCE : null,
        input.subject.source === "mail" ? input.subject.id : null,
        input.group,
        input.category,
        result.status,
        result.rating,
        result.confidencePermille,
        result.historyConflict,
        result.failureCode,
        input.modelRef,
        input.promptId,
        input.textDigest,
        input.dataClassification,
        input.costMicros,
        input.durationMs,
        input.createdAt,
      );
  }

  private record(input: Scope & PrereviewRecord): void {
    this.assertDiskHeadroom();
    this.checkAttempt(input);
    if (
      !acceptsPrereview(input.group, input.rating) ||
      !Number.isInteger(input.confidencePermille) ||
      input.confidencePermille < 0 ||
      input.confidencePermille > 1000 ||
      typeof input.historyConflict !== "boolean"
    )
      this.fail("PORT_INVALID_OPERATION", "Prereview rating is invalid");
    this.insert(input, {
      status: "done",
      rating: input.rating,
      confidencePermille: input.confidencePermille,
      historyConflict: input.historyConflict ? 1 : 0,
      failureCode: null,
    });
  }

  private recordFailure(input: Scope & PrereviewFailure): void {
    this.assertDiskHeadroom();
    this.checkAttempt(input);
    if (
      typeof input.failureCode !== "string" ||
      input.failureCode.length === 0 ||
      input.failureCode.length > 128
    )
      this.fail("PORT_INVALID_OPERATION", "Prereview failure is invalid");
    this.insert(input, {
      status: "failed",
      rating: null,
      confidencePermille: null,
      historyConflict: null,
      failureCode: input.failureCode,
    });
  }
}
