import type {
  ProactiveConnection,
  ProactiveCounts,
  ProactiveDecision,
  ProactiveInsight,
  ProactiveModelPayload,
  ProactiveProcessedMessage,
  ProactivePush,
  ProactiveQuietPeriod,
  ProactiveRecordResult,
  ProactiveScope,
  ProactiveSettings,
  ProactiveStorePort,
} from "@himawari-agent/application";
import { LIMIT_CHANGE_REASON_CODE } from "@himawari-agent/application/decision-ledger";
import {
  defaultProactiveSourceSettings,
  PROACTIVE_ITEMS_PER_CHECK_MAXIMUM,
  PROACTIVE_SOURCES,
  type ProactiveSource,
  type ProactiveSourceSafetyLimits,
  type ProactiveSourceSettings,
  proactiveSourceLimitKey,
  proactiveSourceLimitsValid,
} from "@himawari-agent/application/proactive-sources";
import type Database from "better-sqlite3";
import { recordDecisionSignal } from "./decision-signals.ts";
import {
  applyBackoffWrites,
  listBackoff,
  previewBackoff,
  restoreBackoff,
} from "./proactive-push-backoff.ts";
import { insertLedgerRow } from "./sqlite-decision-ledger-operations.ts";
import { summaryInputsValid } from "./sqlite-decision-summary-inputs.ts";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.js";
import { insertObservationEvent } from "./sqlite-observation-operations.ts";

type Input<TName extends keyof ProactiveStorePort> = Parameters<ProactiveStorePort[TName]>[0];

export interface SqliteProactiveSource {
  readonly name: string;
  readonly safetyLimits: ProactiveSourceSafetyLimits;
}

export function registeredSqliteProactiveSources(): readonly SqliteProactiveSource[] {
  return PROACTIVE_SOURCES.definitions.map(({ name, safetyLimits }) => ({ name, safetyLimits }));
}

const MAX_CHANGE_ID_LENGTH = 100;
const RESULTS = ["act", "know", "check", "ignore"] as const;
const INSIGHT_STATUSES = ["open", "replied", "done", "muted"] as const;
const RATINGS = ["useful", "unneeded", "missed"] as const;
const VERDICTS = [
  "pushed",
  "silent",
  "deferred",
  "failed",
  "capped",
  "capped_daily",
  "needs_owner",
] as const;
const MAX_INPUT_IDS = PROACTIVE_ITEMS_PER_CHECK_MAXIMUM;
const MAX_MODEL_PAYLOADS = 5000;
const SKIP_REASONS = ["category", "sensitive", "own_mail"] as const;
const PRIORITIES = ["high", "medium", "low"] as const;
const COUNT_KEYS: readonly (keyof ProactiveCounts)[] = [
  "fetched",
  "skipped",
  "judged",
  "act",
  "know",
  "check",
  "ignore",
  "floorRaised",
  "pushed",
];
const QUIET_HOURS_RULE_ID = "quiet_hours";
const IMPORTANT_SENDER_RULE_ID = "floor_important_sender";
const DEFAULT_QUIET_HOURS: readonly ProactiveQuietPeriod[] = Object.freeze([
  Object.freeze({
    days: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
    start: "23:00",
    end: "07:00",
  }),
]);
export function defaultRuleParameters(
  ruleId: string,
): Readonly<Record<string, unknown>> | undefined {
  if (ruleId === QUIET_HOURS_RULE_ID) return Object.freeze({ periods: DEFAULT_QUIET_HOURS });
  if (ruleId === IMPORTANT_SENDER_RULE_ID) return Object.freeze({ senders: Object.freeze([]) });
  return undefined;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/u;

const decisionColumns = `id, scenario, checked_at AS checkedAt, counts, verdict,
  reason_code AS reasonCode, push_source_key AS pushSourceKey, cost_micros AS costMicros,
  duration_ms AS durationMs, owner_rating AS ownerRating, rated_at AS ratedAt`;

const insightColumns = `id, source, thread_id AS threadId, last_message_id AS lastMessageId, result,
  floor_raised AS floorRaised, content_ref AS contentRef, due_at AS dueAt, priority, status,
  decision_id AS decisionId, owner_rating AS ownerRating, push_source_key AS pushSourceKey,
  created_at AS createdAt, updated_at AS updatedAt`;

const processedColumns = `source, message_id AS messageId, thread_id AS threadId,
  decision_id AS decisionId, outcome, skip_reason AS skipReason, header_ref AS headerRef,
  processed_at AS processedAt, reviewed_at AS reviewedAt, owner_rating AS ownerRating`;

const pushColumns = `id, ready_at AS readyAt, insight_ids AS insightIds, status,
  created_at AS createdAt`;

function valid(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function includes<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function decisionFromRow(row: Record<string, unknown>): ProactiveDecision {
  return Object.freeze({
    ...(row as unknown as ProactiveDecision),
    counts: Object.freeze(JSON.parse(row["counts"] as string) as ProactiveCounts),
  });
}

function insightFromRow(row: Record<string, unknown>): ProactiveInsight {
  return Object.freeze({
    ...(row as unknown as ProactiveInsight),
    floorRaised: row["floorRaised"] === 1,
  });
}

function pushFromRow(row: Record<string, unknown>): ProactivePush {
  return Object.freeze({
    ...(row as unknown as ProactivePush),
    insightIds: Object.freeze(JSON.parse(row["insightIds"] as string) as string[]),
  });
}

export class SqliteProactiveOperations {
  private readonly database: Database.Database;
  private readonly fail: SqliteApplicationFailure;
  private readonly assertDiskHeadroom: () => void;
  private readonly sources: ReadonlyMap<string, SqliteProactiveSource>;

  constructor(
    database: Database.Database,
    fail: SqliteApplicationFailure,
    assertDiskHeadroom: () => void,
    sources: readonly SqliteProactiveSource[] = registeredSqliteProactiveSources(),
  ) {
    this.database = database;
    this.fail = fail;
    this.assertDiskHeadroom = assertDiskHeadroom;
    this.sources = new Map(sources.map((source) => [source.name, source]));
  }

  execute(operation: string, payload: unknown): unknown {
    switch (operation) {
      case "proactive.readSettings":
        return this.readSettings(payload as ProactiveScope);
      case "proactive.writeSettings":
        return this.writeSettings(payload as Input<"writeSettings">);
      case "proactive.setEnabled":
        return this.setEnabled(payload as Input<"setEnabled">);
      case "proactive.readConnection":
        return this.readConnection(payload as Input<"readConnection">);
      case "proactive.saveConnection":
        return this.saveConnection(payload as Input<"saveConnection">);
      case "proactive.markConnection":
        return this.markConnection(payload as Input<"markConnection">);
      case "proactive.removeSource":
        return this.removeSource(payload as Input<"removeSource">);
      case "proactive.clearRecords":
        return this.clearRecords(payload as Input<"clearRecords">);
      case "proactive.readDecisionPayloads":
        return this.readDecisionPayloads(payload as Input<"readDecisionPayloads">);
      case "proactive.unprocessed":
        return this.unprocessed(payload as Input<"unprocessed">);
      case "proactive.readInsight":
        return this.readInsight(payload as Input<"readInsight">);
      case "proactive.record":
        return this.record(payload as Input<"record">);
      case "proactive.costSince":
        return this.costSince(payload as Input<"costSince">);
      case "proactive.listInsights":
        return this.listInsights(payload as Input<"listInsights">);
      case "proactive.listDecisions":
        return this.listDecisions(payload as Input<"listDecisions">);
      case "proactive.listProcessed":
        return this.listProcessed(payload as Input<"listProcessed">);
      case "proactive.reviewedCount":
        return this.reviewedCount(payload as ProactiveScope);
      case "proactive.updateInsight":
        return this.updateInsight(payload as Input<"updateInsight">);
      case "proactive.previewBackoff": {
        const request = payload as Input<"previewBackoff">;
        this.time(request.now);
        return previewBackoff(
          this.database,
          request,
          this.source(request.source).name,
          request.classKeys,
          request.settings,
          request.now,
        );
      }
      case "proactive.listBackoff":
        return listBackoff(this.database, payload as ProactiveScope);
      case "proactive.restoreBackoff": {
        const request = payload as Input<"restoreBackoff">;
        this.time(request.now);
        return restoreBackoff(this.database, request, request.classKey, request.now);
      }
      case "proactive.rateDecision":
        return this.rateDecision(payload as Input<"rateDecision">);
      case "proactive.rateProcessed":
        return this.rateProcessed(payload as Input<"rateProcessed">);
      case "proactive.markReviewed":
        return this.markReviewed(payload as Input<"markReviewed">);
      case "proactive.pendingPush":
        return this.pendingPush(payload as Input<"pendingPush">);
      case "proactive.listReadyPushes":
        return this.listReadyPushes(payload as Input<"listReadyPushes">);
      case "proactive.markPushEnqueued":
        return this.markPushEnqueued(payload as Input<"markPushEnqueued">);
      case "proactive.readPush":
        return this.readPush(payload as Input<"readPush">);
      case "proactive.readInsights":
        return this.readInsights(payload as Input<"readInsights">);
      case "proactive.listSourceSettings":
        return this.listSourceSettings(payload as ProactiveScope);
      case "proactive.writeSourceSettings":
        return this.writeSourceSettings(payload as Input<"writeSourceSettings">);
      case "proactive.processedSince":
        return this.processedSince(payload as Input<"processedSince">);
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown proactive operation ${operation}`);
    }
  }

  private invalid(message: string): never {
    return this.fail("PORT_INVALID_OPERATION", message) as never;
  }

  private time(value: string | null) {
    if (value !== null && !valid(value)) this.invalid("Proactive time is invalid");
  }

  private limit(value: number) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 500)
      this.invalid("Proactive limit is invalid");
  }

  private source(value: unknown): SqliteProactiveSource {
    const source = typeof value === "string" ? this.sources.get(value) : undefined;
    if (source === undefined) return this.invalid("Proactive source is not registered");
    return source;
  }

  private listSourceSettings(scope: ProactiveScope): readonly ProactiveSourceSettings[] {
    const stored = new Map(
      (
        this.database
          .prepare(
            `SELECT source, enabled, per_day AS perDay, per_check AS perCheck,
               updated_at AS updatedAt FROM proactive_source_settings
             WHERE owner_id = ? AND agent_id = ?`,
          )
          .all(scope.ownerId, scope.agentId) as {
          source: string;
          enabled: number;
          perDay: number;
          perCheck: number;
          updatedAt: string;
        }[]
      ).map((row) => [row.source, row]),
    );
    return [...this.sources.values()].map((definition) => {
      const row = stored.get(definition.name);
      return row
        ? Object.freeze({
            source: row.source as ProactiveSource,
            enabled: row.enabled === 1,
            perDay: row.perDay,
            perCheck: row.perCheck,
            updatedAt: row.updatedAt,
          })
        : defaultProactiveSourceSettings(definition);
    });
  }

  private writeSourceSettings(input: Input<"writeSourceSettings">): void {
    this.assertDiskHeadroom();
    const definition = this.source(input.source);
    this.time(input.now);
    if (
      typeof input.enabled !== "boolean" ||
      !proactiveSourceLimitsValid(definition, input) ||
      typeof input.changeId !== "string" ||
      input.changeId.length < 1 ||
      input.changeId.length > MAX_CHANGE_ID_LENGTH
    )
      this.invalid("Proactive source settings are invalid");
    this.database.transaction(() => {
      const current =
        this.listSourceSettings(input).find(({ source }) => source === definition.name) ??
        defaultProactiveSourceSettings(definition);
      this.database
        .prepare(
          `INSERT INTO proactive_source_settings (
             owner_id, agent_id, source, enabled, per_day, per_check, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (owner_id, agent_id, source) DO UPDATE SET enabled = excluded.enabled,
             per_day = excluded.per_day, per_check = excluded.per_check,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.ownerId,
          input.agentId,
          input.source,
          input.enabled ? 1 : 0,
          input.perDay,
          input.perCheck,
          input.now,
        );
      for (const key of ["perDay", "perCheck"] as const) {
        if (current[key] === input[key]) continue;
        insertLedgerRow(this.database, {
          id: `${input.changeId}:${key}`,
          ownerId: input.ownerId,
          agentId: input.agentId,
          kind: "limit_change",
          decidedAt: input.now,
          outcome: "changed",
          reasonCode: LIMIT_CHANGE_REASON_CODE,
          subjectRef: `limit:${proactiveSourceLimitKey(definition.name, key)}`,
          inputs: {
            memoryIds: [],
            ruleIds: [],
            limitChange: {
              key: proactiveSourceLimitKey(definition.name, key),
              from: current[key],
              to: input[key],
            },
          },
          reasonRef: null,
          contentRef: null,
          costMicros: 0,
          durationMs: 0,
        });
      }
    })();
  }

  private processedSince(input: Input<"processedSince">): number {
    this.source(input.source);
    this.time(input.since);
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS total FROM proactive_processed_messages
         WHERE owner_id = ? AND agent_id = ? AND source = ? AND processed_at >= ?`,
      )
      .get(input.ownerId, input.agentId, input.source, input.since) as { total: number };
    return row.total;
  }

  private rating(value: unknown) {
    if (value !== null && !includes(RATINGS, value)) this.invalid("Proactive rating is invalid");
  }

  private readSettings(scope: ProactiveScope): ProactiveSettings {
    const row = this.database
      .prepare(
        "SELECT enabled, updated_at AS updatedAt FROM proactive_settings WHERE owner_id = ? AND agent_id = ?",
      )
      .get(scope.ownerId, scope.agentId) as { enabled: number; updatedAt: string } | undefined;
    const rules = this.database
      .prepare(
        `SELECT rule_id AS ruleId, revision, parameters FROM rule_book_rules
         WHERE owner_id = ? AND agent_id = ? AND status IN ('active', 'needs_review')`,
      )
      .all(scope.ownerId, scope.agentId) as {
      ruleId: string;
      revision: number;
      parameters: string;
    }[];
    const quiet = rules.find(({ ruleId }) => ruleId === QUIET_HOURS_RULE_ID);
    const senders = rules.find(({ ruleId }) => ruleId === IMPORTANT_SENDER_RULE_ID);
    return Object.freeze({
      enabled: row?.enabled === 1,
      quietHours: Object.freeze(
        quiet
          ? (JSON.parse(quiet.parameters) as { periods: ProactiveQuietPeriod[] }).periods
          : DEFAULT_QUIET_HOURS,
      ),
      quietHoursRevision: quiet?.revision ?? 0,
      importantSenders: Object.freeze(
        senders
          ? (JSON.parse(senders.parameters) as { senders: string[] }).senders.filter(
              (sender) => !/\p{Surrogate}/u.test(sender),
            )
          : [],
      ),
      importantSendersRevision: senders?.revision ?? 0,
      updatedAt: row?.updatedAt ?? null,
    });
  }

  private writeSettings(input: Input<"writeSettings">): void {
    this.assertDiskHeadroom();
    this.time(input.now);
    if (
      typeof input.enabled !== "boolean" ||
      input.quietHours.length > 8 ||
      input.quietHours.some(
        (period) =>
          !CLOCK.test(period.start) ||
          !CLOCK.test(period.end) ||
          period.start === period.end ||
          period.days.length < 1 ||
          period.days.length > 7 ||
          new Set(period.days).size !== period.days.length ||
          period.days.some((day) => !Number.isInteger(day) || day < 0 || day > 6),
      ) ||
      input.importantSenders.length > 200 ||
      input.importantSenders.some(
        (sender) =>
          typeof sender !== "string" ||
          sender.length < 1 ||
          sender.length > 254 ||
          /\p{Surrogate}/u.test(sender) ||
          [...sender].some((character) => {
            const code = character.charCodeAt(0);
            return code < 0x20 || code === 0x7f;
          }),
      )
    )
      this.invalid("Proactive settings are invalid");
    this.database.transaction(() => {
      this.writeEnabled(input);
      this.writeRule(
        input,
        QUIET_HOURS_RULE_ID,
        JSON.stringify({
          periods: input.quietHours.map(({ days, start, end }) => ({
            days: [...days].sort((left, right) => left - right),
            start,
            end,
          })),
        }),
        "owner setting: quiet hours",
      );
      this.writeRule(
        input,
        IMPORTANT_SENDER_RULE_ID,
        JSON.stringify({ senders: input.importantSenders }),
        "owner setting: important senders",
      );
    })();
  }

  private setEnabled(input: Input<"setEnabled">): void {
    this.assertDiskHeadroom();
    this.time(input.now);
    if (typeof input.enabled !== "boolean") this.invalid("Proactive settings are invalid");
    this.database.transaction(() => this.writeEnabled(input))();
  }

  private writeEnabled(input: Input<"setEnabled">): void {
    const before = this.database
      .prepare("SELECT enabled FROM proactive_settings WHERE owner_id = ? AND agent_id = ?")
      .get(input.ownerId, input.agentId) as { enabled: number } | undefined;
    this.database
      .prepare(
        `INSERT INTO proactive_settings (owner_id, agent_id, enabled, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (owner_id, agent_id) DO UPDATE SET enabled = excluded.enabled,
          updated_at = excluded.updated_at`,
      )
      .run(input.ownerId, input.agentId, input.enabled ? 1 : 0, input.now);
    if ((before?.enabled === 1) !== input.enabled)
      insertObservationEvent(this.database, {
        ownerId: input.ownerId,
        agentId: input.agentId,
        kind: input.enabled ? "proactive_enabled" : "proactive_disabled",
        occurredAt: input.now,
      });
  }

  private writeRule(
    input: Input<"writeSettings">,
    ruleId: string,
    parameters: string,
    source: string,
  ): void {
    const current = this.database
      .prepare(
        "SELECT revision, parameters FROM rule_book_rules WHERE owner_id = ? AND agent_id = ? AND rule_id = ?",
      )
      .get(input.ownerId, input.agentId, ruleId) as
      | { revision: number; parameters: string }
      | undefined;
    if (current && current.parameters === parameters) return;
    const revision = (current?.revision ?? 0) + 1;
    this.database
      .prepare(
        `INSERT INTO rule_book_rules (
          owner_id, agent_id, rule_id, revision, parameters, status, source, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT (owner_id, agent_id, rule_id) DO UPDATE SET revision = excluded.revision,
          parameters = excluded.parameters, status = 'active', source = excluded.source,
          updated_at = excluded.updated_at, review_after = NULL, review_attempts = 0,
          review_failure = NULL, suspend_reason = NULL, suggestion = NULL`,
      )
      .run(input.ownerId, input.agentId, ruleId, revision, parameters, source, input.now);
    this.database
      .prepare(
        `INSERT INTO rule_book_history (
          owner_id, agent_id, rule_id, revision, parameters, status, source, source_memory_id,
          changed_at
        ) SELECT owner_id, agent_id, rule_id, revision, parameters, status, source,
          source_memory_id, updated_at
        FROM rule_book_rules WHERE owner_id = ? AND agent_id = ? AND rule_id = ?`,
      )
      .run(input.ownerId, input.agentId, ruleId);
  }

  private readConnection(input: Input<"readConnection">): ProactiveConnection | undefined {
    this.source(input.source);
    const row = this.database
      .prepare(
        `SELECT source, account_ref AS accountRef, token_ref AS tokenRef, cursor, status,
          connected_at AS connectedAt, updated_at AS updatedAt
         FROM proactive_connections WHERE owner_id = ? AND agent_id = ? AND source = ?`,
      )
      .get(input.ownerId, input.agentId, input.source) as ProactiveConnection | undefined;
    return row ? Object.freeze({ ...row }) : undefined;
  }

  private saveConnection(input: Input<"saveConnection">): readonly string[] {
    this.assertDiskHeadroom();
    const { connection } = input;
    this.source(connection.source);
    this.time(connection.connectedAt);
    this.time(connection.updatedAt);
    if (!["connected", "needs_reconnect"].includes(connection.status))
      this.invalid("Proactive connection status is invalid");
    return this.database.transaction(() => {
      const before = this.readConnection({ ...input, source: connection.source });
      this.database
        .prepare(
          `INSERT INTO proactive_connections (
            owner_id, agent_id, source, account_ref, token_ref, cursor, status, connected_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (owner_id, agent_id, source) DO UPDATE SET
            account_ref = excluded.account_ref, token_ref = excluded.token_ref,
            cursor = excluded.cursor, status = excluded.status,
            connected_at = excluded.connected_at, updated_at = excluded.updated_at`,
        )
        .run(
          input.ownerId,
          input.agentId,
          connection.source,
          connection.accountRef,
          connection.tokenRef,
          connection.cursor,
          connection.status,
          connection.connectedAt,
          connection.updatedAt,
        );
      if (before?.status !== connection.status)
        insertObservationEvent(this.database, {
          ownerId: input.ownerId,
          agentId: input.agentId,
          kind: connection.status === "connected" ? "source_connected" : "source_needs_reconnect",
          occurredAt: connection.updatedAt,
          detail: { source: connection.source },
        });
      return before
        ? [before.accountRef, before.tokenRef].filter(
            (ref) => ref !== connection.accountRef && ref !== connection.tokenRef,
          )
        : [];
    })();
  }

  private markConnection(input: Input<"markConnection">): void {
    this.source(input.source);
    this.time(input.now);
    if (!["connected", "needs_reconnect"].includes(input.status))
      this.invalid("Proactive connection status is invalid");
    this.database.transaction(() => {
      const before = this.readConnection(input);
      this.database
        .prepare(
          `UPDATE proactive_connections SET status = ?, cursor = COALESCE(?, cursor), updated_at = ?
           WHERE owner_id = ? AND agent_id = ? AND source = ?`,
        )
        .run(input.status, input.cursor, input.now, input.ownerId, input.agentId, input.source);
      if (before && before.status !== input.status)
        insertObservationEvent(this.database, {
          ownerId: input.ownerId,
          agentId: input.agentId,
          kind: input.status === "connected" ? "source_connected" : "source_needs_reconnect",
          occurredAt: input.now,
          detail: { source: input.source },
        });
    })();
  }

  private collectRefs(scope: ProactiveScope, sourceFilter: string | null): string[] {
    const where = sourceFilter === null ? "" : " AND source = ?";
    const parameters = [scope.ownerId, scope.agentId, ...(sourceFilter ? [sourceFilter] : [])];
    const insightRefs = this.database
      .prepare(
        `SELECT content_ref AS ref FROM source_insights WHERE owner_id = ? AND agent_id = ?${where}`,
      )
      .all(...parameters) as { ref: string }[];
    const headerRefs = this.database
      .prepare(
        `SELECT header_ref AS ref FROM proactive_processed_messages
         WHERE owner_id = ? AND agent_id = ? AND header_ref IS NOT NULL${where}`,
      )
      .all(...parameters) as { ref: string }[];
    const modelRefs = this.database
      .prepare(
        `SELECT link.payload_ref AS ref FROM decision_ledger_payloads link
         JOIN decision_ledger ledger ON ledger.id = link.decision_id
         WHERE ledger.owner_id = ? AND ledger.agent_id = ? AND ledger.kind = 'proactive'${
           sourceFilter === null ? "" : " AND ledger.scenario = ?"
         }`,
      )
      .all(...parameters) as { ref: string }[];
    return [...insightRefs, ...headerRefs, ...modelRefs].map(({ ref }) => ref);
  }

  private deleteModelLinks(scope: ProactiveScope, sourceFilter: string | null): void {
    this.database
      .prepare(
        `DELETE FROM decision_ledger_payloads WHERE decision_id IN (
           SELECT id FROM decision_ledger
           WHERE owner_id = ? AND agent_id = ? AND kind = 'proactive'${
             sourceFilter === null ? "" : " AND scenario = ?"
           })`,
      )
      .run(scope.ownerId, scope.agentId, ...(sourceFilter ? [sourceFilter] : []));
  }

  private readDecisionPayloads(
    input: Input<"readDecisionPayloads">,
  ): readonly ProactiveModelPayload[] {
    return (
      this.database
        .prepare(
          `SELECT link.payload_ref AS ref, link.role AS role
           FROM decision_ledger_payloads link
           JOIN decision_ledger ledger ON ledger.id = link.decision_id
           WHERE link.decision_id = ? AND ledger.owner_id = ? AND ledger.agent_id = ?
             AND ledger.kind = 'proactive'
           ORDER BY link.sequence`,
        )
        .all(input.decisionId, input.ownerId, input.agentId) as ProactiveModelPayload[]
    ).map((row) => Object.freeze({ ref: row.ref, role: row.role }));
  }

  private removeSource(input: Input<"removeSource">): readonly string[] {
    this.source(input.source);
    return this.database.transaction(() => {
      const refs = this.collectRefs(input, input.source);
      const connection = this.readConnection(input);
      const scope = [input.ownerId, input.agentId, input.source] as const;
      this.deleteModelLinks(input, input.source);
      const removedInsights = new Set(
        (
          this.database
            .prepare(
              "SELECT id FROM source_insights WHERE owner_id = ? AND agent_id = ? AND source = ?",
            )
            .all(...scope) as { id: string }[]
        ).map(({ id }) => id),
      );
      this.database
        .prepare("DELETE FROM source_insights WHERE owner_id = ? AND agent_id = ? AND source = ?")
        .run(...scope);
      this.database
        .prepare(
          "DELETE FROM proactive_processed_messages WHERE owner_id = ? AND agent_id = ? AND source = ?",
        )
        .run(...scope);
      this.database
        .prepare(
          "DELETE FROM proactive_connections WHERE owner_id = ? AND agent_id = ? AND source = ?",
        )
        .run(...scope);
      this.database
        .prepare(
          "DELETE FROM proactive_push_backoff WHERE owner_id = ? AND agent_id = ? AND source = ?",
        )
        .run(...scope);
      this.dropInsightsFromPushes(input, removedInsights, "pending");
      if (connection)
        insertObservationEvent(this.database, {
          ownerId: input.ownerId,
          agentId: input.agentId,
          kind: "source_disconnected",
          detail: { source: input.source },
        });
      return connection ? [...refs, connection.accountRef, connection.tokenRef] : refs;
    })();
  }

  private dropInsightsFromPushes(
    scope: ProactiveScope,
    removed: ReadonlySet<string>,
    only: "pending" | "any",
  ): void {
    const pushes = this.database
      .prepare(
        `SELECT id, insight_ids AS insightIds FROM proactive_pushes
         WHERE owner_id = ? AND agent_id = ?${only === "pending" ? " AND status = 'pending'" : ""}`,
      )
      .all(scope.ownerId, scope.agentId) as { id: string; insightIds: string }[];
    for (const push of pushes) {
      const all = JSON.parse(push.insightIds) as string[];
      const kept = all.filter((id) => !removed.has(id));
      if (kept.length === all.length) continue;
      if (kept.length === 0)
        this.database.prepare("DELETE FROM proactive_pushes WHERE id = ?").run(push.id);
      else
        this.database
          .prepare("UPDATE proactive_pushes SET insight_ids = ? WHERE id = ?")
          .run(JSON.stringify(kept), push.id);
    }
  }

  private clearRecords(input: Input<"clearRecords">): readonly string[] {
    const source = this.source(input.source).name;
    return this.database.transaction(() => {
      const scope = [input.ownerId, input.agentId, source] as const;
      const refs = this.collectRefs(input, source);
      this.deleteModelLinks(input, source);
      const removedInsights = new Set(
        (
          this.database
            .prepare(
              "SELECT id FROM source_insights WHERE owner_id = ? AND agent_id = ? AND source = ?",
            )
            .all(...scope) as { id: string }[]
        ).map(({ id }) => id),
      );
      for (const table of [
        "source_insights",
        "proactive_processed_messages",
        "proactive_push_backoff",
      ])
        this.database
          .prepare(`DELETE FROM ${table} WHERE owner_id = ? AND agent_id = ? AND source = ?`)
          .run(...scope);
      this.dropInsightsFromPushes(input, removedInsights, "any");
      const cleared = this.database
        .prepare(
          `DELETE FROM decision_ledger
           WHERE owner_id = ? AND agent_id = ? AND kind = 'proactive' AND scenario = ?`,
        )
        .run(...scope).changes;
      if (cleared > 0)
        insertObservationEvent(this.database, {
          ownerId: input.ownerId,
          agentId: input.agentId,
          kind: "proactive_records_cleared",
          detail: { source, rows: cleared },
        });
      return refs;
    })();
  }

  private unprocessed(input: Input<"unprocessed">): readonly string[] {
    this.source(input.source);
    if (input.messageIds.length > 2000) this.invalid("Proactive message list is too long");
    const known = this.database.prepare(
      `SELECT 1 FROM proactive_processed_messages
       WHERE owner_id = ? AND agent_id = ? AND source = ? AND message_id = ?`,
    );
    return input.messageIds.filter(
      (messageId, index, all) =>
        all.indexOf(messageId) === index &&
        known.get(input.ownerId, input.agentId, input.source, messageId) === undefined,
    );
  }

  private readInsight(input: Input<"readInsight">): ProactiveInsight | undefined {
    this.source(input.source);
    const row = this.database
      .prepare(
        `SELECT ${insightColumns} FROM source_insights
         WHERE owner_id = ? AND agent_id = ? AND source = ? AND thread_id = ?`,
      )
      .get(input.ownerId, input.agentId, input.source, input.threadId) as
      | Record<string, unknown>
      | undefined;
    return row ? insightFromRow(row) : undefined;
  }

  private validateDecision(decision: ProactiveDecision) {
    this.time(decision.checkedAt);
    this.source(decision.scenario);
    if (
      !includes(VERDICTS, decision.verdict) ||
      typeof decision.reasonCode !== "string" ||
      decision.reasonCode.length < 1 ||
      decision.reasonCode.length > 64 ||
      !Number.isSafeInteger(decision.costMicros) ||
      decision.costMicros < 0 ||
      !Number.isSafeInteger(decision.durationMs) ||
      decision.durationMs < 0 ||
      COUNT_KEYS.some((key) => {
        const value = decision.counts[key];
        return !Number.isSafeInteger(value) || value < 0;
      })
    )
      this.invalid("Proactive decision is invalid");
  }

  private relatedInputsValid(
    inputs: Input<"record">["inputs"],
    ids: (value: unknown, max: number) => boolean,
  ): boolean {
    const byMail = inputs.relatedByMail ?? {};
    const stats = inputs.relatedStats;
    return (
      ["off", "ok", "partial", "failed"].includes(inputs.relatedRead ?? "off") &&
      typeof byMail === "object" &&
      byMail !== null &&
      Object.keys(byMail).length <= MAX_INPUT_IDS &&
      Object.entries(byMail).every(
        ([messageId, list]) => messageId.length >= 1 && messageId.length <= 256 && ids(list, 64),
      ) &&
      (inputs.relatedFailedSteps === undefined ||
        (Array.isArray(inputs.relatedFailedSteps) &&
          inputs.relatedFailedSteps.length <= 16 &&
          inputs.relatedFailedSteps.every(
            (step) => typeof step === "string" && step.length >= 1 && step.length <= 64,
          ))) &&
      (stats === undefined ||
        [stats.requests, stats.messages, stats.characters, stats.durationMs].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ))
    );
  }

  private validateInputs(input: Input<"record">) {
    const { inputs, modelPayloads } = input;
    const ids = (value: unknown, max: number) =>
      Array.isArray(value) &&
      value.length <= max &&
      value.every((item) => typeof item === "string" && item.length >= 1 && item.length <= 256) &&
      new Set(value).size === value.length;
    const floorHits = inputs?.floorHits;
    if (
      !ids(inputs?.ruleIds, MAX_INPUT_IDS) ||
      !ids(inputs?.sourceIds, MAX_INPUT_IDS) ||
      typeof inputs.memoryInjected !== "boolean" ||
      !ids(inputs.memoryIds, MAX_INPUT_IDS) ||
      !ids(inputs.usedMemoryIds, MAX_INPUT_IDS) ||
      (inputs.tentativeMemoryIds !== undefined && !ids(inputs.tentativeMemoryIds, MAX_INPUT_IDS)) ||
      !["off", "ok", "partial", "failed"].includes(inputs.memoryRecall) ||
      typeof inputs.memoryByMail !== "object" ||
      inputs.memoryByMail === null ||
      Object.keys(inputs.memoryByMail).length > MAX_INPUT_IDS ||
      Object.entries(inputs.memoryByMail).some(
        ([messageId, list]) => messageId.length < 1 || messageId.length > 256 || !ids(list, 16),
      ) ||
      !this.relatedInputsValid(inputs, ids) ||
      !summaryInputsValid(inputs, MAX_INPUT_IDS) ||
      typeof floorHits !== "object" ||
      floorHits === null ||
      Object.keys(floorHits).length > MAX_INPUT_IDS ||
      Object.entries(floorHits).some(
        ([messageId, rules]) => messageId.length < 1 || messageId.length > 256 || !ids(rules, 16),
      ) ||
      (inputs.ruleHits !== undefined &&
        (typeof inputs.ruleHits !== "object" ||
          inputs.ruleHits === null ||
          Object.keys(inputs.ruleHits).length > MAX_INPUT_IDS ||
          Object.entries(inputs.ruleHits).some(
            ([messageId, rules]) =>
              messageId.length < 1 || messageId.length > 256 || !ids(rules, 16),
          ))) ||
      (inputs.observations !== undefined &&
        (!Number.isSafeInteger(inputs.observations.handedOff) ||
          inputs.observations.handedOff < 0 ||
          inputs.observations.handedOff > MAX_INPUT_IDS ||
          !["not_connected", "port"].includes(inputs.observations.sink))) ||
      !Array.isArray(modelPayloads) ||
      modelPayloads.length > MAX_MODEL_PAYLOADS ||
      modelPayloads.some(
        (payload) =>
          !["model_input", "model_output"].includes(payload.role) ||
          typeof payload.ref !== "string" ||
          payload.ref.length < 1,
      )
    )
      this.invalid("Proactive check inputs are invalid");
  }

  private record(input: Input<"record">): ProactiveRecordResult {
    this.assertDiskHeadroom();
    const { decision } = input;
    this.validateDecision(decision);
    if (input.push) this.time(input.push.readyAt);
    this.validateInputs(input);
    for (const message of input.processed)
      if (
        !this.sources.has(message.source) ||
        !(includes(RESULTS, message.outcome) || message.outcome === "skipped") ||
        (message.outcome === "skipped") !== includes(SKIP_REASONS, message.skipReason)
      )
        this.invalid("Proactive processed message is invalid");
    for (const insight of input.insights) {
      this.time(insight.dueAt);
      if (
        !["act", "know", "check"].includes(insight.result) ||
        (insight.priority !== null && !includes(PRIORITIES, insight.priority))
      )
        this.invalid("Proactive insight is invalid");
    }
    const guard = input.onlyIfNew;
    if (guard !== undefined) {
      this.source(guard.source);
      this.time(guard.since);
    }
    return this.database.transaction(() => {
      const scope = [input.ownerId, input.agentId] as const;
      if (guard !== undefined) {
        const seen = this.database.prepare(
          `SELECT 1 FROM proactive_processed_messages
           WHERE owner_id = ? AND agent_id = ? AND source = ? AND message_id = ?`,
        );
        if (
          input.processed.some(
            (message) =>
              message.source !== guard.source ||
              seen.get(...scope, message.source, message.messageId) !== undefined,
          )
        )
          return { insightIds: [], releasedRefs: [], refused: "already_recorded" as const };
        const perDay = this.listSourceSettings(input).find(
          ({ source }) => source === guard.source,
        )?.perDay;
        if (
          perDay !== undefined &&
          this.processedSince({ ...input, source: guard.source, since: guard.since }) +
            input.processed.length >
            perDay
        )
          return { insightIds: [], releasedRefs: [], refused: "daily_limit" as const };
      }
      this.database
        .prepare(
          `INSERT INTO decision_ledger (
            id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, outcome, reason_code,
            subject_ref, inputs, reason_ref, content_ref, push_source_key, cost_micros, duration_ms,
            owner_rating, rated_at
          ) VALUES (?, ?, ?, 'proactive', ?, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          decision.id,
          ...scope,
          decision.scenario,
          decision.checkedAt,
          JSON.stringify(Object.fromEntries(COUNT_KEYS.map((key) => [key, decision.counts[key]]))),
          decision.verdict,
          decision.reasonCode,
          JSON.stringify({
            memoryIds: input.inputs.memoryIds,
            ruleIds: input.inputs.ruleIds,
            sourceIds: input.inputs.sourceIds,
            floorHits: input.inputs.floorHits,
            ruleHits: input.inputs.ruleHits ?? {},
            memoryInjected: input.inputs.memoryInjected,
            usedMemoryIds: input.inputs.usedMemoryIds,
            tentativeMemoryIds: input.inputs.tentativeMemoryIds ?? [],
            memoryByMail: input.inputs.memoryByMail,
            memoryRecall: input.inputs.memoryRecall,
            relatedByMail: input.inputs.relatedByMail ?? {},
            relatedRead: input.inputs.relatedRead ?? "off",
            relatedStats: input.inputs.relatedStats ?? {
              requests: 0,
              messages: 0,
              characters: 0,
              durationMs: 0,
            },
            relatedFailedSteps: input.inputs.relatedFailedSteps ?? [],
            ...(input.inputs.summaryRead === undefined
              ? {}
              : {
                  summaryInjected: input.inputs.summaryInjected ?? false,
                  summaryIds: input.inputs.summaryIds ?? [],
                  summaryDays: input.inputs.summaryDays ?? [],
                  summaryCharacters: input.inputs.summaryCharacters ?? 0,
                  summaryRead: input.inputs.summaryRead,
                  summaryGenerated: input.inputs.summaryGenerated ?? 0,
                }),
            ...(input.inputs.observations === undefined
              ? {}
              : {
                  observations: {
                    handedOff: input.inputs.observations.handedOff,
                    sink: input.inputs.observations.sink,
                  },
                }),
          }),
          decision.pushSourceKey,
          decision.costMicros,
          decision.durationMs,
        );
      const insertModelPayload = this.database.prepare(
        `INSERT INTO decision_ledger_payloads (decision_id, sequence, role, payload_ref)
         VALUES (?, ?, ?, ?)`,
      );
      input.modelPayloads.forEach((payload, sequence) => {
        insertModelPayload.run(decision.id, sequence, payload.role, payload.ref);
      });
      const insertProcessed = this.database.prepare(
        `INSERT INTO proactive_processed_messages (
          owner_id, agent_id, source, message_id, thread_id, decision_id, outcome, skip_reason,
          header_ref, processed_at, received_at, reviewed_at, owner_rating
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT (owner_id, agent_id, source, message_id) DO NOTHING`,
      );
      const releasedRefs: string[] = [];
      for (const message of input.processed) {
        const inserted = insertProcessed.run(
          ...scope,
          message.source,
          message.messageId,
          message.threadId,
          decision.id,
          message.outcome,
          message.skipReason,
          message.headerRef,
          decision.checkedAt,
          message.receivedAt,
        ).changes;
        if (inserted === 0 && message.headerRef) releasedRefs.push(message.headerRef);
      }
      const insightIds: string[] = [];
      for (const insight of input.insights) {
        const existing = this.readInsight({
          ownerId: input.ownerId,
          agentId: input.agentId,
          source: decision.scenario,
          threadId: insight.threadId,
        });
        if (existing) {
          if (existing.contentRef !== insight.contentRef) releasedRefs.push(existing.contentRef);
          this.database
            .prepare(
              `UPDATE source_insights SET last_message_id = ?, result = ?, floor_raised = ?,
                content_ref = ?, due_at = ?, priority = ?,
                status = CASE WHEN status = 'muted' THEN 'muted' ELSE 'open' END,
                decision_id = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(
              insight.lastMessageId,
              insight.result,
              insight.floorRaised ? 1 : 0,
              insight.contentRef,
              insight.dueAt,
              insight.priority,
              decision.id,
              decision.checkedAt,
              existing.id,
            );
          insightIds.push(existing.id);
        } else {
          this.database
            .prepare(
              `INSERT INTO source_insights (
                id, owner_id, agent_id, source, thread_id, last_message_id, result, floor_raised,
                content_ref, due_at, priority, status, decision_id, owner_rating, push_source_key,
                created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL, ?, ?)`,
            )
            .run(
              insight.id,
              ...scope,
              decision.scenario,
              insight.threadId,
              insight.lastMessageId,
              insight.result,
              insight.floorRaised ? 1 : 0,
              insight.contentRef,
              insight.dueAt,
              insight.priority,
              decision.id,
              decision.checkedAt,
              decision.checkedAt,
            );
          insightIds.push(insight.id);
        }
      }
      const markReplied = this.database.prepare(
        `UPDATE source_insights SET status = 'replied', updated_at = ?
         WHERE owner_id = ? AND agent_id = ? AND source = ? AND thread_id = ? AND status = 'open'
           AND NOT EXISTS (
             SELECT 1 FROM proactive_processed_messages later
             WHERE later.owner_id = ? AND later.agent_id = ? AND later.source = ?
               AND later.thread_id = ? AND later.received_at > ?
           )`,
      );
      const openForReply = this.database.prepare(
        `SELECT id, decision_id AS decisionId, updated_at AS updatedAt,
           push_source_key AS pushSourceKey FROM source_insights
         WHERE owner_id = ? AND agent_id = ? AND source = ? AND thread_id = ? AND status = 'open'
           AND NOT EXISTS (
             SELECT 1 FROM proactive_processed_messages later
             WHERE later.owner_id = ? AND later.agent_id = ? AND later.source = ?
               AND later.thread_id = ? AND later.received_at > ?
           )`,
      );
      for (const { threadId, receivedAt } of input.repliedThreads) {
        this.time(receivedAt);
        const waiting = openForReply.all(
          ...scope,
          decision.scenario,
          threadId,
          ...scope,
          decision.scenario,
          threadId,
          receivedAt,
        ) as {
          id: string;
          decisionId: string;
          updatedAt: string;
          pushSourceKey: string | null;
        }[];
        markReplied.run(
          decision.checkedAt,
          ...scope,
          decision.scenario,
          threadId,
          ...scope,
          decision.scenario,
          threadId,
          receivedAt,
        );
        for (const row of waiting.filter((entry) => entry.pushSourceKey !== null))
          recordDecisionSignal(this.database, {
            ownerId: String(scope[0]),
            agentId: String(scope[1]),
            decisionId: this.pushingDecisionId(scope, row.pushSourceKey as string, row.decisionId),
            signal: "replied",
            occurredAt: receivedAt,
            delayMs: Date.parse(receivedAt) - Date.parse(row.updatedAt),
            detail: {},
            sourceRef: `${row.id}@${receivedAt}`,
            recordedAt: decision.checkedAt,
          });
      }
      if (input.push) {
        const pushed = input.insights
          .map((insight, index) => ({ insight, id: insightIds[index] as string }))
          .filter(({ insight }) => insight.push)
          .map(({ id }) => id);
        const current = this.readPush({ ...input, pushId: input.push.id });
        if (current && current.status !== "pending") this.invalid("Proactive push is closed");
        const ids = [...new Set([...(current?.insightIds ?? []), ...pushed])];
        if (current)
          this.database
            .prepare("UPDATE proactive_pushes SET insight_ids = ? WHERE id = ?")
            .run(JSON.stringify(ids), input.push.id);
        else
          this.database
            .prepare(
              `INSERT INTO proactive_pushes (
                id, owner_id, agent_id, ready_at, insight_ids, status, created_at, enqueued_at
              ) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
            )
            .run(
              input.push.id,
              ...scope,
              input.push.readyAt,
              JSON.stringify(ids),
              decision.checkedAt,
            );
        const setKey = this.database.prepare(
          "UPDATE source_insights SET push_source_key = ? WHERE id = ?",
        );
        const setClass = this.database.prepare(
          "UPDATE source_insights SET push_class = ? WHERE id = ?",
        );
        input.insights.forEach((insight, index) => {
          if (insight.push) setClass.run(insight.pushClass ?? null, insightIds[index] as string);
        });
        for (const id of pushed) setKey.run(`proactive:${input.push.id}`, id);
      }
      if (input.backoff && input.backoff.length > 0)
        applyBackoffWrites(
          this.database,
          { ownerId: input.ownerId, agentId: input.agentId },
          decision.scenario,
          decision.id,
          input.backoff,
          decision.checkedAt,
        );
      if (input.cursor !== null)
        this.database
          .prepare(
            `UPDATE proactive_connections SET cursor = ?, updated_at = ?
             WHERE owner_id = ? AND agent_id = ? AND source = ?`,
          )
          .run(input.cursor, decision.checkedAt, ...scope, decision.scenario);
      return Object.freeze({
        insightIds: Object.freeze(insightIds),
        releasedRefs: Object.freeze(releasedRefs),
      });
    })();
  }

  private costSince(input: Input<"costSince">): number {
    this.time(input.since);
    const row = this.database
      .prepare(
        `SELECT COALESCE(SUM(cost_micros), 0) AS total FROM decision_ledger
         WHERE owner_id = ? AND agent_id = ? AND kind = 'proactive' AND checked_at >= ?`,
      )
      .get(input.ownerId, input.agentId, input.since) as { total: number };
    return row.total;
  }

  private listInsights(input: Input<"listInsights">): readonly ProactiveInsight[] {
    if (input.statuses.some((status) => !includes(INSIGHT_STATUSES, status)))
      this.invalid("Proactive insight status is invalid");
    if (input.statuses.length === 0) return [];
    return this.database
      .prepare(
        `SELECT ${insightColumns} FROM source_insights
         WHERE owner_id = ? AND agent_id = ? AND status IN (${input.statuses.map(() => "?").join(", ")})
         ORDER BY due_at IS NULL, due_at, updated_at DESC, id LIMIT 500`,
      )
      .all(input.ownerId, input.agentId, ...input.statuses)
      .map((row) => insightFromRow(row as Record<string, unknown>));
  }

  private listDecisions(input: Input<"listDecisions">): readonly ProactiveDecision[] {
    this.time(input.since);
    this.limit(input.limit);
    return this.database
      .prepare(
        `SELECT ${decisionColumns} FROM decision_ledger
         WHERE owner_id = ? AND agent_id = ? AND kind = 'proactive' AND checked_at >= ?
         ORDER BY checked_at DESC, id DESC LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, input.since, input.limit)
      .map((row) => decisionFromRow(row as Record<string, unknown>));
  }

  private listProcessed(input: Input<"listProcessed">): readonly ProactiveProcessedMessage[] {
    this.time(input.since);
    this.limit(input.limit);
    if (!includes(RESULTS, input.outcome) && input.outcome !== "skipped")
      this.invalid("Proactive outcome is invalid");
    return this.database
      .prepare(
        `SELECT ${processedColumns} FROM proactive_processed_messages
         WHERE owner_id = ? AND agent_id = ? AND outcome = ? AND processed_at >= ?
         ORDER BY processed_at DESC, message_id LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, input.outcome, input.since, input.limit)
      .map((row) => Object.freeze({ ...(row as ProactiveProcessedMessage) }));
  }

  private reviewedCount(scope: ProactiveScope): number {
    const reviewed = this.database
      .prepare(
        `SELECT COUNT(*) AS total FROM proactive_processed_messages
         WHERE owner_id = ? AND agent_id = ? AND reviewed_at IS NOT NULL`,
      )
      .get(scope.ownerId, scope.agentId) as { total: number };
    const rated = this.database
      .prepare(
        `SELECT COUNT(*) AS total FROM decision_ledger
         WHERE owner_id = ? AND agent_id = ? AND kind = 'proactive' AND owner_rating IS NOT NULL`,
      )
      .get(scope.ownerId, scope.agentId) as { total: number };
    return reviewed.total + rated.total;
  }

  private pushingDecisionId(
    scope: readonly unknown[],
    pushSourceKey: string,
    fallback: string,
  ): string {
    const row = this.database
      .prepare(
        `SELECT id FROM decision_ledger
         WHERE owner_id = ? AND agent_id = ? AND kind = 'proactive' AND push_source_key = ?
         ORDER BY checked_at, id LIMIT 1`,
      )
      .get(scope[0], scope[1], pushSourceKey) as { id: string } | undefined;
    return row?.id ?? fallback;
  }

  private updateInsight(input: Input<"updateInsight">): boolean {
    this.time(input.now);
    if (input.status !== undefined && !includes(INSIGHT_STATUSES, input.status))
      this.invalid("Proactive insight status is invalid");
    if (input.rating !== undefined) this.rating(input.rating);
    return this.database.transaction(() => {
      const before = this.database
        .prepare(
          `SELECT status, decision_id AS decisionId, updated_at AS updatedAt,
             push_source_key AS pushSourceKey FROM source_insights
           WHERE owner_id = ? AND agent_id = ? AND id = ?`,
        )
        .get(input.ownerId, input.agentId, input.insightId) as
        | { status: string; decisionId: string; updatedAt: string; pushSourceKey: string | null }
        | undefined;
      const changed =
        this.database
          .prepare(
            `UPDATE source_insights SET status = COALESCE(?, status),
              owner_rating = CASE WHEN ? THEN ? ELSE owner_rating END, updated_at = ?
             WHERE owner_id = ? AND agent_id = ? AND id = ?`,
          )
          .run(
            input.status ?? null,
            input.rating === undefined ? 0 : 1,
            input.rating ?? null,
            input.now,
            input.ownerId,
            input.agentId,
            input.insightId,
          ).changes > 0;
      if (
        changed &&
        before !== undefined &&
        before.pushSourceKey !== null &&
        input.status === "open" &&
        (before.status === "done" || before.status === "muted")
      )
        recordDecisionSignal(this.database, {
          ownerId: input.ownerId,
          agentId: input.agentId,
          decisionId: this.pushingDecisionId(
            [input.ownerId, input.agentId],
            before.pushSourceKey,
            before.decisionId,
          ),
          signal: "undone",
          occurredAt: input.now,
          delayMs: Date.parse(input.now) - Date.parse(before.updatedAt),
          detail: { from: before.status },
          sourceRef: `${input.insightId}@${input.now}`,
          recordedAt: input.now,
        });
      return changed;
    })();
  }

  private rateDecision(input: Input<"rateDecision">): boolean {
    this.time(input.now);
    this.rating(input.rating);
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

  private rateProcessed(input: Input<"rateProcessed">): boolean {
    this.source(input.source);
    this.time(input.now);
    this.rating(input.rating);
    return (
      this.database
        .prepare(
          `UPDATE proactive_processed_messages SET owner_rating = ?
           WHERE owner_id = ? AND agent_id = ? AND source = ? AND message_id = ?`,
        )
        .run(input.rating, input.ownerId, input.agentId, input.source, input.messageId).changes > 0
    );
  }

  private markReviewed(input: Input<"markReviewed">): number {
    this.source(input.source);
    this.time(input.now);
    if (input.messageIds.length > 500) this.invalid("Proactive message list is too long");
    const mark = this.database.prepare(
      `UPDATE proactive_processed_messages SET reviewed_at = ?
       WHERE owner_id = ? AND agent_id = ? AND source = ? AND message_id = ?
         AND reviewed_at IS NULL`,
    );
    return this.database.transaction(() =>
      input.messageIds.reduce(
        (total, messageId) =>
          total +
          mark.run(input.now, input.ownerId, input.agentId, input.source, messageId).changes,
        0,
      ),
    )();
  }

  private pendingPush(input: Input<"pendingPush">): ProactivePush | undefined {
    this.time(input.readyAt);
    const row = this.database
      .prepare(
        `SELECT ${pushColumns} FROM proactive_pushes
         WHERE owner_id = ? AND agent_id = ? AND status = 'pending' AND ready_at = ?
         ORDER BY created_at LIMIT 1`,
      )
      .get(input.ownerId, input.agentId, input.readyAt) as Record<string, unknown> | undefined;
    return row ? pushFromRow(row) : undefined;
  }

  private listReadyPushes(input: Input<"listReadyPushes">): readonly ProactivePush[] {
    this.time(input.now);
    this.limit(input.limit);
    return this.database
      .prepare(
        `SELECT ${pushColumns} FROM proactive_pushes
         WHERE owner_id = ? AND agent_id = ? AND status = 'pending' AND ready_at <= ?
         ORDER BY ready_at, id LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, input.now, input.limit)
      .map((row) => pushFromRow(row as Record<string, unknown>));
  }

  private markPushEnqueued(input: Input<"markPushEnqueued">): boolean {
    this.time(input.now);
    return (
      this.database
        .prepare(
          `UPDATE proactive_pushes SET status = 'enqueued', enqueued_at = ?
           WHERE owner_id = ? AND agent_id = ? AND id = ? AND status = 'pending'`,
        )
        .run(input.now, input.ownerId, input.agentId, input.pushId).changes > 0
    );
  }

  private readPush(input: Input<"readPush">): ProactivePush | undefined {
    const row = this.database
      .prepare(
        `SELECT ${pushColumns} FROM proactive_pushes WHERE owner_id = ? AND agent_id = ? AND id = ?`,
      )
      .get(input.ownerId, input.agentId, input.pushId) as Record<string, unknown> | undefined;
    return row ? pushFromRow(row) : undefined;
  }

  private readInsights(input: Input<"readInsights">): readonly ProactiveInsight[] {
    if (input.insightIds.length > 500) this.invalid("Proactive insight list is too long");
    const read = this.database.prepare(
      `SELECT ${insightColumns} FROM source_insights WHERE owner_id = ? AND agent_id = ? AND id = ?`,
    );
    return input.insightIds.flatMap((id) => {
      const row = read.get(input.ownerId, input.agentId, id) as Record<string, unknown> | undefined;
      return row ? [insightFromRow(row)] : [];
    });
  }
}
