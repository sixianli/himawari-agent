import {
  PROACTIVE_REPLAY_BUDGET_LIMIT_MICROS,
  PROACTIVE_REPLAY_MAIL_LIMIT,
  PROACTIVE_REPLAY_OUTCOMES,
  PROACTIVE_REPLAY_PAGE_LIMIT,
  PROACTIVE_REPLAY_STATUSES,
  type ProactiveReplayResult,
  type ProactiveReplayRun,
  type ProactiveReplayStorePort,
} from "@himawari-agent/application/proactive-replays";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Input<TName extends keyof ProactiveReplayStorePort> = Parameters<
  ProactiveReplayStorePort[TName]
>[0];

interface Scope {
  readonly ownerId: string;
  readonly agentId: string;
}

const SOURCES = ["gmail"] as const;
const PRIORITIES = ["high", "medium", "low"] as const;

const runColumns = `id, source, range_from AS rangeFrom, range_to AS rangeTo,
  mail_limit AS mailLimit, budget_micros AS budgetMicros, status, reason_code AS reasonCode,
  listed, judged, cost_micros AS costMicros, started_at AS startedAt, finished_at AS finishedAt`;

const resultColumns = `message_id AS messageId, thread_id AS threadId, received_at AS receivedAt,
  sent_by_owner AS sentByOwner, outcome, reason_code AS reasonCode, floor_hit AS floorHit,
  floor_raised AS floorRaised, push, priority, due_at AS dueAt, content_ref AS contentRef,
  cost_micros AS costMicros, judged_at AS judgedAt`;

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

function count(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

function validScope(input: Scope): boolean {
  return boundedText(input?.ownerId, 256) && boundedText(input?.agentId, 256);
}

function validResult(result: ProactiveReplayResult): boolean {
  const failedOrSkipped = result.outcome === "skipped" || result.outcome === "failed";
  return (
    boundedText(result.messageId, 256) &&
    boundedText(result.threadId, 256) &&
    exactTime(result.receivedAt) &&
    typeof result.sentByOwner === "boolean" &&
    oneOf(PROACTIVE_REPLAY_OUTCOMES, result.outcome) &&
    (result.reasonCode === null || boundedText(result.reasonCode, 64)) &&
    failedOrSkipped === (result.reasonCode !== null) &&
    typeof result.floorHit === "boolean" &&
    typeof result.floorRaised === "boolean" &&
    typeof result.push === "boolean" &&
    (result.priority === null || oneOf(PRIORITIES, result.priority)) &&
    (result.dueAt === null || exactTime(result.dueAt)) &&
    (result.contentRef === null || boundedText(result.contentRef, 256)) &&
    (!failedOrSkipped || result.contentRef === null) &&
    count(result.costMicros) &&
    exactTime(result.judgedAt)
  );
}

function runFromRow(row: Record<string, unknown>): ProactiveReplayRun {
  return Object.freeze(row as unknown as ProactiveReplayRun);
}

function resultFromRow(row: Record<string, unknown>): ProactiveReplayResult {
  return Object.freeze({
    ...(row as unknown as ProactiveReplayResult),
    sentByOwner: row["sentByOwner"] === 1,
    floorHit: row["floorHit"] === 1,
    floorRaised: row["floorRaised"] === 1,
    push: row["push"] === 1,
  });
}

export function deleteProactiveReplays(
  database: Database.Database,
  scope: Scope,
  source: string | null,
): string[] {
  const where = source === null ? "" : " AND source = ?";
  const parameters = [scope.ownerId, scope.agentId, ...(source === null ? [] : [source])];
  const refs = database
    .prepare(
      `SELECT result.content_ref AS ref FROM proactive_replay_results result
       JOIN proactive_replay_runs run ON run.id = result.run_id
       WHERE run.owner_id = ? AND run.agent_id = ?${where} AND result.content_ref IS NOT NULL`,
    )
    .all(...parameters) as { ref: string }[];
  database
    .prepare(`DELETE FROM proactive_replay_runs WHERE owner_id = ? AND agent_id = ?${where}`)
    .run(...parameters);
  return refs.map(({ ref }) => ref);
}

export class SqliteProactiveReplayOperations {
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
      case "proactiveReplay.startRun":
        return this.startRun(payload as Input<"startRun">);
      case "proactiveReplay.markListed":
        return this.markListed(payload as Input<"markListed">);
      case "proactiveReplay.recordResult":
        return this.recordResult(payload as Input<"recordResult">);
      case "proactiveReplay.finishRun":
        return this.finishRun(payload as Input<"finishRun">);
      case "proactiveReplay.interruptRunning":
        return this.interruptRunning(payload as Input<"interruptRunning">);
      case "proactiveReplay.readRun":
        return this.readRun(payload as Input<"readRun">);
      case "proactiveReplay.listResults":
        return this.listResults(payload as Input<"listResults">);
      case "proactiveReplay.deleteRun":
        return this.deleteRun(payload as Input<"deleteRun">);
      default:
        return this.fail("PORT_INVALID_OPERATION", "Unknown proactive replay operation");
    }
  }

  private invalid(message: string): never {
    return this.fail("PORT_INVALID_OPERATION", message);
  }

  private runId(input: Scope & { readonly runId: string }): void {
    if (!validScope(input) || !boundedText(input.runId, 128))
      this.invalid("Proactive replay run is invalid");
  }

  private startRun(input: Input<"startRun">): boolean {
    if (
      !validScope(input) ||
      !boundedText(input.id, 128) ||
      !oneOf(SOURCES, input.source) ||
      !exactTime(input.rangeFrom) ||
      !exactTime(input.rangeTo) ||
      input.rangeFrom >= input.rangeTo ||
      !Number.isSafeInteger(input.mailLimit) ||
      input.mailLimit < 1 ||
      input.mailLimit > PROACTIVE_REPLAY_MAIL_LIMIT ||
      !Number.isSafeInteger(input.budgetMicros) ||
      input.budgetMicros < 1 ||
      input.budgetMicros > PROACTIVE_REPLAY_BUDGET_LIMIT_MICROS ||
      !exactTime(input.now)
    )
      return this.invalid("Proactive replay run is invalid");
    this.assertDiskHeadroom();
    return (
      this.database
        .prepare(
          `INSERT INTO proactive_replay_runs (
             id, owner_id, agent_id, source, range_from, range_to, mail_limit, budget_micros,
             status, started_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
           ON CONFLICT DO NOTHING`,
        )
        .run(
          input.id,
          input.ownerId,
          input.agentId,
          input.source,
          input.rangeFrom,
          input.rangeTo,
          input.mailLimit,
          input.budgetMicros,
          input.now,
        ).changes === 1
    );
  }

  private markListed(input: Input<"markListed">): void {
    this.runId(input);
    if (!count(input.listed, PROACTIVE_REPLAY_MAIL_LIMIT))
      this.invalid("Proactive replay count is invalid");
    this.database
      .prepare(
        `UPDATE proactive_replay_runs SET listed = ?
         WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'running'`,
      )
      .run(input.listed, input.runId, input.ownerId, input.agentId);
  }

  private recordResult(input: Input<"recordResult">): boolean {
    this.runId(input);
    if (!validResult(input.result)) return this.invalid("Proactive replay result is invalid");
    this.assertDiskHeadroom();
    const result = input.result;
    return this.database.transaction(() => {
      const advanced = this.database
        .prepare(
          `UPDATE proactive_replay_runs
           SET judged = judged + 1, cost_micros = cost_micros + ?
           WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'running'`,
        )
        .run(result.costMicros, input.runId, input.ownerId, input.agentId).changes;
      if (advanced === 0) return false;
      const inserted = this.database
        .prepare(
          `INSERT INTO proactive_replay_results (
             run_id, message_id, thread_id, received_at, sent_by_owner, outcome, reason_code,
             floor_hit, floor_raised, push, priority, due_at, content_ref, cost_micros, judged_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .run(
          input.runId,
          result.messageId,
          result.threadId,
          result.receivedAt,
          result.sentByOwner ? 1 : 0,
          result.outcome,
          result.reasonCode,
          result.floorHit ? 1 : 0,
          result.floorRaised ? 1 : 0,
          result.push ? 1 : 0,
          result.priority,
          result.dueAt,
          result.contentRef,
          result.costMicros,
          result.judgedAt,
        ).changes;
      if (inserted === 0) throw new Error("PROACTIVE_REPLAY_DUPLICATE_RESULT");
      return true;
    })();
  }

  private finishRun(input: Input<"finishRun">): void {
    this.runId(input);
    if (
      !oneOf(
        PROACTIVE_REPLAY_STATUSES.filter((status) => status !== "running"),
        input.status,
      ) ||
      !boundedText(input.reasonCode, 64) ||
      !exactTime(input.now)
    )
      this.invalid("Proactive replay finish is invalid");
    this.database
      .prepare(
        `UPDATE proactive_replay_runs SET status = ?, reason_code = ?, finished_at = ?
         WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'running'`,
      )
      .run(input.status, input.reasonCode, input.now, input.runId, input.ownerId, input.agentId);
  }

  private interruptRunning(input: Input<"interruptRunning">): number {
    if (!validScope(input) || !exactTime(input.now))
      return this.invalid("Proactive replay scope is invalid");
    return this.database
      .prepare(
        `UPDATE proactive_replay_runs
         SET status = 'interrupted', reason_code = 'SERVICE_RESTARTED', finished_at = ?
         WHERE owner_id = ? AND agent_id = ? AND status = 'running'`,
      )
      .run(input.now, input.ownerId, input.agentId).changes;
  }

  private readRun(input: Input<"readRun">): ProactiveReplayRun | undefined {
    this.runId(input);
    const row = this.database
      .prepare(
        `SELECT ${runColumns} FROM proactive_replay_runs
         WHERE id = ? AND owner_id = ? AND agent_id = ?`,
      )
      .get(input.runId, input.ownerId, input.agentId) as Record<string, unknown> | undefined;
    return row ? runFromRow(row) : undefined;
  }

  private listResults(input: Input<"listResults">): readonly ProactiveReplayResult[] {
    this.runId(input);
    if (
      (input.afterMessageId !== null && !boundedText(input.afterMessageId, 256)) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > PROACTIVE_REPLAY_PAGE_LIMIT
    )
      return this.invalid("Proactive replay page is invalid");
    const rows = this.database
      .prepare(
        `SELECT ${resultColumns} FROM proactive_replay_results
         WHERE run_id IN (
           SELECT id FROM proactive_replay_runs WHERE id = ? AND owner_id = ? AND agent_id = ?
         ) AND message_id > ?
         ORDER BY message_id
         LIMIT ?`,
      )
      .all(
        input.runId,
        input.ownerId,
        input.agentId,
        input.afterMessageId ?? "",
        input.limit,
      ) as Record<string, unknown>[];
    return Object.freeze(rows.map(resultFromRow));
  }

  private deleteRun(input: Input<"deleteRun">): readonly string[] {
    this.runId(input);
    return this.database.transaction(() => {
      const refs = this.database
        .prepare(
          `SELECT result.content_ref AS ref FROM proactive_replay_results result
           JOIN proactive_replay_runs run ON run.id = result.run_id
           WHERE run.id = ? AND run.owner_id = ? AND run.agent_id = ?
             AND result.content_ref IS NOT NULL`,
        )
        .all(input.runId, input.ownerId, input.agentId) as { ref: string }[];
      this.database
        .prepare("DELETE FROM proactive_replay_runs WHERE id = ? AND owner_id = ? AND agent_id = ?")
        .run(input.runId, input.ownerId, input.agentId);
      return refs.map(({ ref }) => ref);
    })();
  }
}
