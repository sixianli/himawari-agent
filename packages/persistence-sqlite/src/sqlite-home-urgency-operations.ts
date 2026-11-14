import type {
  HomeUrgencyAttempt,
  HomeUrgencyFailure,
  HomeUrgencyItemRef,
  HomeUrgencyRecord,
  HomeUrgencyScore,
} from "@himawari-agent/application";
import type { AgentId, OwnerId } from "@himawari-agent/domain";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

interface Scope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

const ITEM_LIMIT = 2_000;
const SCORE_MAX = 1000;
const LABEL_MAX = 64;
const CLASSIFICATIONS: readonly string[] = ["public", "private", "sensitive"];
const DIGEST = /^[0-9a-f]{64}$/u;

function valid(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export class SqliteHomeUrgencyOperations {
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
      case "homeUrgency.listScores":
        return this.listScores(payload as Scope & { items: readonly HomeUrgencyItemRef[] });
      case "homeUrgency.listRecentFailures":
        return this.listRecentFailures(
          payload as Scope & { items: readonly HomeUrgencyItemRef[]; since: string },
        );
      case "homeUrgency.countSince":
        return this.countSince(payload as Scope & { since: string });
      case "homeUrgency.recordCall":
        return this.recordCall(
          payload as Scope & {
            records: readonly HomeUrgencyRecord[];
            failures: readonly HomeUrgencyFailure[];
          },
        );
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown home urgency operation ${operation}`);
    }
  }

  private items(items: readonly HomeUrgencyItemRef[]): string {
    if (
      !Array.isArray(items) ||
      items.length > ITEM_LIMIT ||
      items.some(
        (item) =>
          !bounded(item.itemKey, 256) ||
          typeof item.textDigest !== "string" ||
          !DIGEST.test(item.textDigest),
      )
    )
      this.fail("PORT_INVALID_OPERATION", "Home urgency items are invalid");
    return JSON.stringify(items.map(({ itemKey, textDigest }) => [itemKey, textDigest]));
  }

  private listScores(
    input: Scope & { items: readonly HomeUrgencyItemRef[] },
  ): readonly HomeUrgencyScore[] {
    const items = this.items(input.items);
    if (input.items.length === 0) return [];
    return (
      this.database
        .prepare(
          `SELECT s.item_key AS itemKey, s.text_digest AS textDigest, s.score,
            s.approval_request_id AS approvalRequestId, s.sentence_ref AS sentenceRef,
            s.affirm_label AS affirmLabel, s.copy_locale AS copyLocale
          FROM home_item_scores s
          JOIN json_each(?) wanted
            ON s.item_key = json_extract(wanted.value, '$[0]')
            AND s.text_digest = json_extract(wanted.value, '$[1]')
          WHERE s.owner_id = ? AND s.agent_id = ? AND s.status = 'done'
          ORDER BY s.item_key, s.text_digest`,
        )
        .all(items, input.ownerId, input.agentId) as HomeUrgencyScore[]
    ).map((row) => Object.freeze({ ...row }));
  }

  private listRecentFailures(
    input: Scope & { items: readonly HomeUrgencyItemRef[]; since: string },
  ): readonly HomeUrgencyItemRef[] {
    if (!valid(input.since)) this.fail("PORT_INVALID_OPERATION", "Home urgency time is invalid");
    const items = this.items(input.items);
    if (input.items.length === 0) return [];
    return (
      this.database
        .prepare(
          `SELECT DISTINCT s.item_key AS itemKey, s.text_digest AS textDigest
          FROM home_item_scores s
          JOIN json_each(?) wanted
            ON s.item_key = json_extract(wanted.value, '$[0]')
            AND s.text_digest = json_extract(wanted.value, '$[1]')
          WHERE s.owner_id = ? AND s.agent_id = ? AND s.status = 'failed' AND s.created_at >= ?
          ORDER BY s.item_key, s.text_digest`,
        )
        .all(items, input.ownerId, input.agentId, input.since) as HomeUrgencyItemRef[]
    ).map((row) => Object.freeze({ ...row }));
  }

  private countSince(input: Scope & { since: string }): { calls: number; costMicros: number } {
    if (!valid(input.since)) this.fail("PORT_INVALID_OPERATION", "Home urgency time is invalid");
    const row = this.database
      .prepare(
        `SELECT count(*) AS calls, COALESCE(sum(cost), 0) AS costMicros FROM (
          SELECT max(cost_micros) AS cost FROM home_item_scores
          WHERE owner_id = ? AND agent_id = ? AND created_at >= ?
          GROUP BY invocation_id
        )`,
      )
      .get(input.ownerId, input.agentId, input.since) as { calls: number; costMicros: number };
    return { calls: row.calls, costMicros: row.costMicros };
  }

  private checkAttempt(input: Scope, attempt: HomeUrgencyAttempt): void {
    if (
      !bounded(attempt.id, 128) ||
      !bounded(attempt.invocationId, 128) ||
      !bounded(attempt.itemKey, 256) ||
      !bounded(attempt.modelRef, 256) ||
      !bounded(attempt.promptId, 128) ||
      typeof attempt.textDigest !== "string" ||
      !DIGEST.test(attempt.textDigest) ||
      !valid(attempt.createdAt) ||
      !CLASSIFICATIONS.includes(attempt.dataClassification) ||
      !Number.isSafeInteger(attempt.costMicros) ||
      attempt.costMicros < 0 ||
      !Number.isSafeInteger(attempt.durationMs) ||
      attempt.durationMs < 0 ||
      (attempt.approvalRequestId !== null && !bounded(attempt.approvalRequestId, 256))
    )
      this.fail("PORT_INVALID_OPERATION", "Home urgency record is invalid");
    if (
      attempt.approvalRequestId !== null &&
      !this.database
        .prepare("SELECT 1 FROM approval_requests WHERE id = ? AND owner_id = ? AND agent_id = ?")
        .get(attempt.approvalRequestId, input.ownerId, input.agentId)
    )
      this.fail("PORT_NOT_FOUND", "Home urgency approval not found");
  }

  private recordCall(
    input: Scope & {
      records: readonly HomeUrgencyRecord[];
      failures: readonly HomeUrgencyFailure[];
    },
  ): void {
    this.assertDiskHeadroom();
    if (
      !Array.isArray(input.records) ||
      !Array.isArray(input.failures) ||
      input.records.length + input.failures.length === 0 ||
      input.records.length + input.failures.length > ITEM_LIMIT
    )
      this.fail("PORT_INVALID_OPERATION", "Home urgency call is invalid");
    const invocations = new Set(
      [...input.records, ...input.failures].map(({ invocationId }) => invocationId),
    );
    if (invocations.size !== 1)
      this.fail("PORT_INVALID_OPERATION", "Home urgency call mixes invocations");
    for (const record of input.records) {
      this.checkAttempt(input, record);
      const copy = record.sentenceRef !== null || record.affirmLabel !== null;
      if (
        !Number.isInteger(record.score) ||
        record.score < 0 ||
        record.score > SCORE_MAX ||
        (record.sentenceRef !== null && !bounded(record.sentenceRef, 512)) ||
        (record.affirmLabel !== null && !bounded(record.affirmLabel, LABEL_MAX)) ||
        (copy && record.approvalRequestId === null) ||
        copy !== (record.copyLocale !== null) ||
        (record.copyLocale !== null &&
          (typeof record.copyLocale !== "string" ||
            record.copyLocale.length < 2 ||
            record.copyLocale.length > 16))
      )
        this.fail("PORT_INVALID_OPERATION", "Home urgency score is invalid");
      if (
        record.sentenceRef !== null &&
        !this.database
          .prepare("SELECT 1 FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?")
          .get(record.sentenceRef, input.ownerId, input.agentId)
      )
        this.fail("PORT_NOT_FOUND", "Home urgency sentence payload not found");
    }
    for (const failure of input.failures) {
      this.checkAttempt(input, failure);
      if (!bounded(failure.failureCode, 128))
        this.fail("PORT_INVALID_OPERATION", "Home urgency failure is invalid");
    }
    const insert = this.database.prepare(
      `INSERT INTO home_item_scores (
        id, owner_id, agent_id, invocation_id, item_key, approval_request_id, status, score,
        sentence_ref, affirm_label, copy_locale, failure_code, model_ref, prompt_id, text_digest,
        data_classification, cost_micros, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const row = (
      attempt: HomeUrgencyAttempt,
      result: {
        status: "done" | "failed";
        score: number | null;
        sentenceRef: string | null;
        affirmLabel: string | null;
        copyLocale: string | null;
        failureCode: string | null;
      },
    ) =>
      insert.run(
        attempt.id,
        input.ownerId,
        input.agentId,
        attempt.invocationId,
        attempt.itemKey,
        attempt.approvalRequestId,
        result.status,
        result.score,
        result.sentenceRef,
        result.affirmLabel,
        result.copyLocale,
        result.failureCode,
        attempt.modelRef,
        attempt.promptId,
        attempt.textDigest,
        attempt.dataClassification,
        attempt.costMicros,
        attempt.durationMs,
        attempt.createdAt,
      );
    this.database.transaction(() => {
      for (const record of input.records)
        row(record, {
          status: "done",
          score: record.score,
          sentenceRef: record.sentenceRef,
          affirmLabel: record.affirmLabel,
          copyLocale: record.copyLocale,
          failureCode: null,
        });
      for (const failure of input.failures)
        row(failure, {
          status: "failed",
          score: null,
          sentenceRef: null,
          affirmLabel: null,
          copyLocale: null,
          failureCode: failure.failureCode,
        });
    })();
  }
}
