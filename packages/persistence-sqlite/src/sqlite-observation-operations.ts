import { randomUUID } from "node:crypto";
import {
  OBSERVATION_DAY_STATUSES,
  OBSERVATION_ITEM_STATUSES,
  type LedgerObservationPort,
  type ObservationCheck,
  type ObservationConsolidationRun,
  type ObservationDayFacts,
  type ObservationDayWindow,
  type ObservationEvent,
  type ObservationEventKind,
  type ObservationFact,
  type ObservationStart,
} from "@himawari-agent/application/ledger-observation";
import { GMAIL_SOURCE } from "@himawari-agent/application/proactive-sources";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";

type Input<TName extends keyof LedgerObservationPort> = Parameters<LedgerObservationPort[TName]>[0];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REVISION = /^[0-9A-Za-z._-]{1,64}$/;
const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const MAX_DAYS = 400;

function validTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function hourStart(at: string): string {
  return `${at.slice(0, 13)}:00:00.000Z`;
}

function validFacts(value: unknown): value is Readonly<Record<string, ObservationFact>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 40 &&
    entries.every(
      ([key, fact]) =>
        key.length >= 1 &&
        key.length <= 64 &&
        (fact === null ||
          typeof fact === "boolean" ||
          (typeof fact === "number" && Number.isFinite(fact)) ||
          (typeof fact === "string" && fact.length <= 256)),
    )
  );
}

function canonical(value: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1))),
  );
}

interface ObservationEventWrite {
  readonly ownerId: string;
  readonly agentId: string;
  readonly kind: ObservationEventKind;
  readonly occurredAt?: string | null;
  readonly detail?: Readonly<Record<string, ObservationFact>>;
}

export function insertObservationEvent(
  database: Database.Database,
  event: ObservationEventWrite,
): void {
  database
    .prepare(
      `INSERT INTO observation_events (id, owner_id, agent_id, kind, occurred_at, sequence, detail)
       VALUES (?, ?, ?, ?, COALESCE(?, ${SQL_NOW}),
         (SELECT coalesce(max(sequence), 0) + 1 FROM observation_events), ?)`,
    )
    .run(
      `observation-event:${randomUUID()}`,
      event.ownerId,
      event.agentId,
      event.kind,
      event.occurredAt ?? null,
      canonical(event.detail ?? {}),
    );
}

function eventFromRow(row: Record<string, unknown>): ObservationEvent {
  return Object.freeze({
    id: row["id"] as string,
    ownerId: row["ownerId"] as ObservationEvent["ownerId"],
    agentId: row["agentId"] as ObservationEvent["agentId"],
    kind: row["kind"] as ObservationEventKind,
    occurredAt: row["occurredAt"] as string,
    detail: Object.freeze(JSON.parse(row["detail"] as string) as Record<string, ObservationFact>),
  });
}

function checkFromRow(row: Record<string, unknown>): ObservationCheck {
  return Object.freeze({
    id: row["id"] as string,
    ownerId: row["ownerId"] as ObservationCheck["ownerId"],
    agentId: row["agentId"] as ObservationCheck["agentId"],
    day: row["day"] as string,
    checkedAt: row["checkedAt"] as string,
    serviceRevision: row["serviceRevision"] as string,
    status: row["status"] as ObservationCheck["status"],
    checks: Object.freeze(JSON.parse(row["checks"] as string) as ObservationCheck["checks"]),
    counts: Object.freeze(JSON.parse(row["counts"] as string) as ObservationCheck["counts"]),
  });
}

export class SqliteLedgerObservationOperations {
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
      case "ledgerObservation.readStart":
        return this.readStart(payload as Input<"readStart">);
      case "ledgerObservation.setStart":
        return this.setStart(payload as Input<"setStart">);
      case "ledgerObservation.beat":
        return this.beat(payload as Input<"beat">);
      case "ledgerObservation.firstHeartbeat":
        return this.firstHeartbeat(payload as Input<"firstHeartbeat">);
      case "ledgerObservation.ensureSnapshot":
        return this.ensureSnapshot(payload as Input<"ensureSnapshot">);
      case "ledgerObservation.readDayFacts":
        return this.readDayFacts(payload as Input<"readDayFacts">);
      case "ledgerObservation.countDays":
        return this.countDays(payload as Input<"countDays">);
      case "ledgerObservation.appendCheck":
        return this.appendCheck(payload as Input<"appendCheck">);
      case "ledgerObservation.listChecks":
        return this.listChecks(payload as Input<"listChecks">);
      case "ledgerObservation.listEvents":
        return this.listEvents(payload as Input<"listEvents">);
      default:
        return this.fail(
          "PORT_INVALID_OPERATION",
          `Unknown ledger observation operation ${operation}`,
        );
    }
  }

  private invalid(message: string): never {
    return this.fail("PORT_INVALID_OPERATION", message);
  }

  private window(input: ObservationDayWindow): void {
    if (!DAY.test(input.day) || !validTime(input.start) || !validTime(input.end))
      this.invalid("Observation day is invalid");
    if (input.start >= input.end) this.invalid("Observation day is invalid");
  }

  private readStart(input: Input<"readStart">): ObservationStart | null {
    const row = this.database
      .prepare(
        `SELECT owner_id AS ownerId, agent_id AS agentId, start_day AS startDay, set_at AS setAt,
           service_revision AS serviceRevision, first_boot_at AS firstBootAt
         FROM ledger_observation_start WHERE owner_id = ? AND agent_id = ?`,
      )
      .get(input.ownerId, input.agentId) as ObservationStart | undefined;
    return row ? Object.freeze({ ...row }) : null;
  }

  private setStart(start: Input<"setStart">): void {
    this.assertDiskHeadroom();
    if (
      !DAY.test(start.startDay) ||
      !validTime(start.setAt) ||
      !validTime(start.firstBootAt) ||
      !REVISION.test(start.serviceRevision)
    )
      this.invalid("Observation start is invalid");
    if (this.readStart(start)) this.fail("PORT_CONFLICT", "LEDGER_OBSERVATION_START_ALREADY_SET");
    this.database
      .prepare(
        `INSERT INTO ledger_observation_start (
           owner_id, agent_id, start_day, set_at, service_revision, first_boot_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        start.ownerId,
        start.agentId,
        start.startDay,
        start.setAt,
        start.serviceRevision,
        start.firstBootAt,
      );
  }

  private beat(input: Input<"beat">): void {
    if (!validTime(input.at) || !REVISION.test(input.serviceRevision))
      this.invalid("Heartbeat is invalid");
    this.database
      .prepare(
        `INSERT INTO service_heartbeats (
           owner_id, agent_id, hour_start, first_seen_at, last_seen_at, service_revision
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_id, agent_id, hour_start) DO UPDATE SET
           last_seen_at = max(last_seen_at, excluded.last_seen_at),
           service_revision = excluded.service_revision`,
      )
      .run(
        input.ownerId,
        input.agentId,
        hourStart(input.at),
        input.at,
        input.at,
        input.serviceRevision,
      );
  }

  private firstHeartbeat(input: Input<"firstHeartbeat">): string | null {
    const row = this.database
      .prepare(
        `SELECT min(first_seen_at) AS at FROM service_heartbeats WHERE owner_id = ? AND agent_id = ?`,
      )
      .get(input.ownerId, input.agentId) as { at: string | null };
    return row.at;
  }

  private currentState(input: Input<"readStart">): {
    proactiveEnabled: boolean;
    sourceStatus: ObservationDayFacts["sourceStatus"];
    capturePaused: boolean;
  } {
    const settings = this.database
      .prepare("SELECT enabled FROM proactive_settings WHERE owner_id = ? AND agent_id = ?")
      .get(input.ownerId, input.agentId) as { enabled: number } | undefined;
    const connection = this.database
      .prepare(
        `SELECT status FROM proactive_connections
         WHERE owner_id = ? AND agent_id = ? AND source = '${GMAIL_SOURCE.name}'`,
      )
      .get(input.ownerId, input.agentId) as { status: "connected" | "needs_reconnect" } | undefined;
    const memory = this.database
      .prepare(
        "SELECT capture_paused AS paused FROM memory_settings WHERE owner_id = ? AND agent_id = ?",
      )
      .get(input.ownerId, input.agentId) as { paused: number } | undefined;
    return {
      proactiveEnabled: settings?.enabled === 1,
      sourceStatus: connection?.status ?? "disconnected",
      capturePaused: memory?.paused === 1,
    };
  }

  private ensureSnapshot(input: Input<"ensureSnapshot">): void {
    if (!validTime(input.at)) this.invalid("Observation time is invalid");
    this.database.transaction(() => {
      const existing = this.database
        .prepare(
          `SELECT 1 FROM observation_events
           WHERE owner_id = ? AND agent_id = ? AND kind = 'state_snapshot' LIMIT 1`,
        )
        .get(input.ownerId, input.agentId);
      if (existing) return;
      const state = this.currentState(input);
      insertObservationEvent(this.database, {
        ownerId: input.ownerId,
        agentId: input.agentId,
        kind: "state_snapshot",
        occurredAt: input.at,
        detail: state,
      });
    })();
  }

  private countsFor(
    input: Input<"readStart">,
    window: ObservationDayWindow,
  ): Record<string, number> {
    const rows = this.database
      .prepare(
        `SELECT kind, count(*) AS n FROM decision_ledger
         WHERE owner_id = ? AND agent_id = ? AND checked_at >= ? AND checked_at < ?
         GROUP BY kind ORDER BY kind`,
      )
      .all(input.ownerId, input.agentId, window.start, window.end) as {
      kind: string;
      n: number;
    }[];
    return Object.fromEntries(rows.map(({ kind, n }) => [kind, n]));
  }

  private readDayFacts(input: Input<"readDayFacts">): ObservationDayFacts {
    this.window(input);
    if (!validTime(input.until) || input.until < input.end)
      this.invalid("Observation time is invalid");
    return this.database.transaction(() => {
      const scope = [input.ownerId, input.agentId] as const;
      const heartbeatHours = (
        this.database
          .prepare(
            `SELECT hour_start AS hour FROM service_heartbeats
             WHERE owner_id = ? AND agent_id = ? AND hour_start >= ? AND hour_start < ?
             ORDER BY hour_start`,
          )
          .all(...scope, input.start, input.end) as { hour: string }[]
      ).map(({ hour }) => hour);
      const proactiveTimes = (
        this.database
          .prepare(
            `SELECT checked_at AS at FROM decision_ledger
             WHERE owner_id = ? AND agent_id = ? AND kind = 'proactive'
               AND checked_at >= ? AND checked_at < ?
             ORDER BY checked_at`,
          )
          .all(...scope, input.start, input.end) as { at: string }[]
      ).map(({ at }) => at);
      const malformed = this.database
        .prepare(
          `SELECT count(*) AS n FROM decision_ledger
           WHERE owner_id = ? AND agent_id = ?
             AND checked_at >= ? AND checked_at < ?
             AND (length(checked_at) != 24 OR checked_at NOT GLOB
               '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z')`,
        )
        .get(...scope, input.start, input.end) as { n: number };
      const consolidationRuns = (
        this.database
          .prepare(
            `SELECT run.id AS id, run.day AS day, run.status AS status,
               run.change_count AS changeCount, run.started_at AS startedAt,
               (SELECT count(*) FROM decision_ledger ledger
                WHERE ledger.owner_id = run.owner_id AND ledger.agent_id = run.agent_id
                  AND ledger.kind = 'consolidation'
                  AND json_extract(ledger.inputs, '$.batchId') = run.id) AS ledgerRows
             FROM memory_consolidation_runs run
             WHERE run.owner_id = ? AND run.agent_id = ? AND run.day = ?
             ORDER BY run.started_at`,
          )
          .all(...scope, input.day) as ObservationConsolidationRun[]
      ).map((row) => Object.freeze({ ...row }));
      const events = (
        this.database
          .prepare(
            `SELECT id, owner_id AS ownerId, agent_id AS agentId, kind,
               occurred_at AS occurredAt, detail
             FROM observation_events
             WHERE owner_id = ? AND agent_id = ? AND occurred_at < ?
             ORDER BY occurred_at, sequence`,
          )
          .all(...scope, input.until) as Record<string, unknown>[]
      ).map(eventFromRow);
      return Object.freeze({
        heartbeatHours: Object.freeze(heartbeatHours),
        proactiveTimes: Object.freeze(proactiveTimes),
        counts: Object.freeze(this.countsFor(input, input)),
        malformedTimes: malformed.n,
        consolidationRuns: Object.freeze(consolidationRuns),
        events: Object.freeze(events),
        ...this.currentState(input),
      });
    })();
  }

  private countDays(input: Input<"countDays">): Record<string, Record<string, number>> {
    if (!Array.isArray(input.days) || input.days.length > MAX_DAYS)
      this.invalid("Observation days are invalid");
    for (const window of input.days) this.window(window);
    return this.database.transaction(() =>
      Object.fromEntries(input.days.map((window) => [window.day, this.countsFor(input, window)])),
    )();
  }

  private appendCheck(check: Input<"appendCheck">): void {
    this.assertDiskHeadroom();
    if (
      typeof check.id !== "string" ||
      check.id.length < 1 ||
      check.id.length > 128 ||
      !DAY.test(check.day) ||
      !validTime(check.checkedAt) ||
      !REVISION.test(check.serviceRevision) ||
      !(OBSERVATION_DAY_STATUSES as readonly string[]).includes(check.status) ||
      !Array.isArray(check.checks) ||
      check.checks.length > 20 ||
      check.checks.some(
        (item) =>
          typeof item.code !== "string" ||
          item.code.length < 1 ||
          item.code.length > 64 ||
          typeof item.reason !== "string" ||
          item.reason.length < 1 ||
          item.reason.length > 64 ||
          !(OBSERVATION_ITEM_STATUSES as readonly string[]).includes(item.status) ||
          !validFacts(item.facts),
      ) ||
      !validFacts(check.counts) ||
      Object.values(check.counts).some((n) => !Number.isSafeInteger(n) || (n as number) < 0)
    )
      this.invalid("Observation check is invalid");
    this.database
      .prepare(
        `INSERT INTO ledger_observation_checks (
           id, owner_id, agent_id, day, checked_at, service_revision, status, checks, counts
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        check.id,
        check.ownerId,
        check.agentId,
        check.day,
        check.checkedAt,
        check.serviceRevision,
        check.status,
        JSON.stringify(
          check.checks.map((item) => ({
            code: item.code,
            status: item.status,
            reason: item.reason,
            facts: JSON.parse(canonical(item.facts)),
          })),
        ),
        canonical(check.counts),
      );
  }

  private listChecks(input: Input<"listChecks">): readonly ObservationCheck[] {
    return (
      this.database
        .prepare(
          `SELECT id, owner_id AS ownerId, agent_id AS agentId, day, checked_at AS checkedAt,
             service_revision AS serviceRevision, status, checks, counts
           FROM ledger_observation_checks WHERE owner_id = ? AND agent_id = ?
           ORDER BY day, checked_at, id`,
        )
        .all(input.ownerId, input.agentId) as Record<string, unknown>[]
    ).map(checkFromRow);
  }

  private listEvents(input: Input<"listEvents">): readonly ObservationEvent[] {
    if (!validTime(input.since)) this.invalid("Observation time is invalid");
    return (
      this.database
        .prepare(
          `SELECT id, owner_id AS ownerId, agent_id AS agentId, kind, occurred_at AS occurredAt,
             detail
           FROM observation_events WHERE owner_id = ? AND agent_id = ? AND occurred_at >= ?
           ORDER BY occurred_at, sequence LIMIT 500`,
        )
        .all(input.ownerId, input.agentId, input.since) as Record<string, unknown>[]
    ).map(eventFromRow);
  }
}
