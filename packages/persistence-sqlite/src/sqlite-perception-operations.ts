import { createHash } from "node:crypto";
import type {
  DeviceMirrorItem,
  PerceptionDeletion,
  PerceptionDeletionCounts,
  PerceptionDeletionScope,
  PerceptionDeletionTarget,
  LimitUsageRow,
  PerceptionDayPage,
  PerceptionDayRow,
  PerceptionExtractionState,
  PerceptionEpisode,
  PerceptionIngestOutcome,
  PerceptionIngestResult,
  PerceptionMediaItem,
  PerceptionRecord,
  PerceptionRecordInput,
  PerceptionRecordType,
  PerceptionScope,
  PerceptionSettings,
  PerceptionStorePort,
  PerceptionEpisodeOverview,
  UploadGrant,
} from "@himawari-agent/application";
import type Database from "better-sqlite3";
import { insertLedgerRow, validateLedgerWrite } from "./sqlite-decision-ledger-operations.ts";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.ts";

type Input<TName extends keyof PerceptionStorePort> = Parameters<PerceptionStorePort[TName]>[0];

const recordColumns = `id, device_id AS deviceId, type, origin, capture_source AS captureSource,
  occurred_at_ms AS occurredAtMs, received_at_ms AS receivedAtMs,
  occurred_at_device AS occurredAtDevice, local_day AS localDay, confidence,
  speaker_kind AS speakerKind, speaker_ref AS speakerRef, episode_id AS episodeId,
  content_ref AS contentRef, data_classification AS dataClassification, evidence, status`;

const episodeColumns = `id, started_at_ms AS startedAtMs, ended_at_ms AS endedAtMs,
  local_day AS localDay, record_count AS recordCount, status`;

const grantColumns = `token_hash AS tokenHash, device_id AS deviceId, purpose, sha256, bytes,
  record_id_first AS recordIdFirst, record_id_last AS recordIdLast, batch_id AS batchId,
  media_kind AS mediaKind, media_ms AS mediaMilliseconds, created_at AS createdAt,
  expires_at AS expiresAt, used_at AS usedAt, result`;

type RecordRow = Omit<PerceptionRecord, "evidence"> & { readonly evidence: string };
function toRecord(row: RecordRow): PerceptionRecord {
  return Object.freeze({ ...row, evidence: Object.freeze(JSON.parse(row.evidence)) });
}

function validTime(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function encodeCursor(atMs: number, id: string): string {
  return Buffer.from(`${atMs}\n${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { readonly atMs: number; readonly id: string } | null {
  const [at, id, ...rest] = Buffer.from(cursor, "base64url").toString("utf8").split("\n");
  const atMs = Number(at);
  if (rest.length > 0 || !id || !Number.isSafeInteger(atMs) || atMs < 0) return null;
  return { atMs, id };
}

function dayRows(types: readonly PerceptionRecordType[] | null): string {
  if (types !== null)
    return `WITH day_rows AS (
      SELECT 'record' AS kind, id, occurred_at_ms AS at_ms FROM perception_records
       WHERE owner_id = @ownerId AND agent_id = @agentId AND local_day = @day
         AND status = 'active' AND type IN (SELECT value FROM json_each(@types))
    )`;
  return `WITH day_rows AS (
    SELECT 'episode' AS kind, id, started_at_ms AS at_ms FROM perception_episodes
     WHERE owner_id = @ownerId AND agent_id = @agentId AND local_day = @day AND status = 'active'
    UNION ALL
    SELECT 'record' AS kind, id, occurred_at_ms AS at_ms FROM perception_records
     WHERE owner_id = @ownerId AND agent_id = @agentId AND local_day = @day
       AND status = 'active' AND episode_id IS NULL
  )`;
}

export class SqlitePerceptionOperations {
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
    const name = operation.slice("perception.".length) as keyof PerceptionStorePort;
    const handler = (this as unknown as Record<string, ((input: unknown) => unknown) | undefined>)[
      `op_${name}`
    ];
    if (!operation.startsWith("perception.") || typeof handler !== "function")
      return this.fail("PORT_INVALID_OPERATION", `Unknown perception operation ${operation}`);
    return handler.call(this, payload);
  }

  private time(value: string): string {
    if (!validTime(value)) this.fail("PORT_INVALID_OPERATION", "Perception time is invalid");
    return value;
  }

  private amount(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0)
      this.fail("PORT_INVALID_OPERATION", "Usage amount is invalid");
    return value;
  }

  protected op_readSettings(input: Input<"readSettings">): PerceptionSettings {
    const row = this.database
      .prepare(
        `SELECT revision, disabled_senses AS disabledSenses, paused_from AS pausedFrom,
                paused_until AS pausedUntil, retention_days AS retentionDays,
                limit_overrides AS limitOverrides, updated_at AS updatedAt
           FROM perception_settings WHERE owner_id = ? AND agent_id = ?`,
      )
      .get(input.ownerId, input.agentId) as
      | {
          revision: number;
          disabledSenses: string;
          pausedFrom: string | null;
          pausedUntil: string | null;
          retentionDays: string;
          limitOverrides: string;
          updatedAt: string;
        }
      | undefined;
    if (!row)
      return Object.freeze({
        revision: 0,
        disabledSenses: Object.freeze([]),
        pausedFrom: null,
        pausedUntil: null,
        retentionDays: Object.freeze({}),
        limitOverrides: Object.freeze({}),
        updatedAt: null,
      });
    return Object.freeze({
      revision: row.revision,
      disabledSenses: Object.freeze(JSON.parse(row.disabledSenses)),
      pausedFrom: row.pausedFrom,
      pausedUntil: row.pausedUntil,
      retentionDays: Object.freeze(JSON.parse(row.retentionDays)),
      limitOverrides: Object.freeze(JSON.parse(row.limitOverrides)),
      updatedAt: row.updatedAt,
    });
  }

  protected op_writeSettings(input: Input<"writeSettings">): PerceptionSettings {
    this.assertDiskHeadroom();
    const now = this.time(input.now);
    for (const decision of input.decisions) {
      const problem = validateLedgerWrite(decision);
      if (problem) this.fail("PORT_INVALID_OPERATION", problem);
    }
    return this.database.transaction(() => {
      const current = this.op_readSettings(input);
      if (current.revision !== input.expectedRevision)
        return this.fail("PORT_CONFLICT", "Perception settings changed");
      const values = [
        JSON.stringify(input.values.disabledSenses),
        input.values.pausedFrom,
        input.values.pausedUntil,
        JSON.stringify(input.values.retentionDays),
        JSON.stringify(input.values.limitOverrides),
        now,
      ];
      this.database
        .prepare(
          `INSERT INTO perception_settings
             (owner_id, agent_id, revision, disabled_senses, paused_from, paused_until,
              retention_days, limit_overrides, updated_at)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (owner_id, agent_id) DO UPDATE SET
             revision = revision + 1, disabled_senses = excluded.disabled_senses,
             paused_from = excluded.paused_from, paused_until = excluded.paused_until,
             retention_days = excluded.retention_days,
             limit_overrides = excluded.limit_overrides, updated_at = excluded.updated_at`,
        )
        .run(input.ownerId, input.agentId, ...values);
      for (const decision of input.decisions) insertLedgerRow(this.database, decision);
      return this.op_readSettings(input);
    })();
  }

  protected op_knownRecordIds(input: Input<"knownRecordIds">): readonly string[] {
    if (input.ids.length === 0) return [];
    return (
      this.database
        .prepare(
          `SELECT id FROM perception_records
            WHERE owner_id = ? AND agent_id = ? AND id IN (SELECT value FROM json_each(?))`,
        )
        .all(input.ownerId, input.agentId, JSON.stringify(input.ids)) as { id: string }[]
    ).map((row) => row.id);
  }

  protected op_releaseContent(input: Input<"releaseContent">): number {
    if (input.refs.length === 0) return 0;
    return this.database
      .prepare(
        `DELETE FROM payloads
          WHERE owner_id = ? AND agent_id = ? AND ref IN (SELECT value FROM json_each(?))
            AND NOT EXISTS (SELECT 1 FROM perception_records WHERE content_ref = payloads.ref)`,
      )
      .run(input.ownerId, input.agentId, JSON.stringify(input.refs)).changes;
  }

  protected op_knownMediaDigests(input: Input<"knownMediaDigests">): readonly string[] {
    if (input.digests.length === 0) return [];
    return this.database
      .prepare(
        `SELECT DISTINCT sha256 FROM perception_media_items
          WHERE sha256 IN (SELECT value FROM json_each(?))`,
      )
      .pluck()
      .all(JSON.stringify(input.digests)) as string[];
  }

  private used(scope: PerceptionScope, key: string, periodStart: string): number {
    const row = this.database
      .prepare(
        `SELECT used FROM limit_usage
          WHERE owner_id = ? AND agent_id = ? AND key = ? AND period_start = ? AND device_id = ''`,
      )
      .get(scope.ownerId, scope.agentId, key, periodStart) as { used: number } | undefined;
    return row?.used ?? 0;
  }

  private reserve(
    scope: PerceptionScope,
    key: string,
    periodStart: string,
    amount: number,
    limit: number | null,
  ): boolean {
    this.amount(amount);
    if (limit !== null) this.amount(limit);
    const result = this.database
      .prepare(
        `INSERT INTO limit_usage (owner_id, agent_id, key, period_start, device_id, used)
         SELECT @ownerId, @agentId, @key, @periodStart, '', @amount
          WHERE @limit IS NULL OR @amount <= @limit
         ON CONFLICT (owner_id, agent_id, key, period_start, device_id) DO UPDATE
           SET used = used + excluded.used
         WHERE @limit IS NULL OR limit_usage.used + excluded.used <= @limit`,
      )
      .run({
        ownerId: scope.ownerId,
        agentId: scope.agentId,
        key,
        periodStart,
        amount,
        limit,
      });
    return result.changes === 1;
  }

  protected op_ingestRecords(input: Input<"ingestRecords">): PerceptionIngestResult {
    this.assertDiskHeadroom();
    const now = Date.parse(this.time(input.now));
    const periodStart = this.time(input.periodStart);
    return this.database.transaction((): PerceptionIngestResult => {
      const outcomes = new Map<string, PerceptionIngestOutcome>();
      const known = new Set(
        this.op_knownRecordIds({ ...input, ids: input.records.map((record) => record.id) }),
      );
      const fresh: PerceptionRecordInput[] = [];
      for (const record of input.records) {
        if (known.has(record.id) || outcomes.has(record.id)) {
          if (!outcomes.has(record.id)) outcomes.set(record.id, "duplicate");
          continue;
        }
        if (this.suppressed(input, input.deviceId, record)) {
          outcomes.set(record.id, "suppressed_by_deletion");
          continue;
        }
        outcomes.set(record.id, "stored");
        fresh.push(record);
      }
      const reached = new Set<string>();
      const byPriority = [...fresh].sort(
        (left, right) =>
          Number(left.lowValue) - Number(right.lowValue) ||
          left.occurredAtMs - right.occurredAtMs ||
          (left.id < right.id ? -1 : 1),
      );
      let audioRoom = Math.max(
        0,
        input.audioLimit - this.used(input, input.audioLimitKey, periodStart),
      );
      let recordRoom = Math.max(
        0,
        input.recordLimit - this.used(input, input.recordLimitKey, periodStart),
      );
      const admitted: PerceptionRecordInput[] = [];
      let audio = 0;
      for (const record of byPriority) {
        if (record.audioMilliseconds > audioRoom) {
          outcomes.set(record.id, "limit_reached");
          reached.add(input.audioLimitKey);
          continue;
        }
        if (recordRoom === 0) {
          outcomes.set(record.id, "limit_reached");
          reached.add(input.recordLimitKey);
          continue;
        }
        audioRoom -= record.audioMilliseconds;
        audio += record.audioMilliseconds;
        recordRoom -= 1;
        admitted.push(record);
      }
      if (
        admitted.length > 0 &&
        (!this.reserve(
          input,
          input.recordLimitKey,
          periodStart,
          admitted.length,
          input.recordLimit,
        ) ||
          (audio > 0 &&
            !this.reserve(input, input.audioLimitKey, periodStart, audio, input.audioLimit)))
      )
        return this.fail("PORT_CONFLICT", "Usage changed while reserving");
      admitted.sort(
        (left, right) => left.occurredAtMs - right.occurredAtMs || (left.id < right.id ? -1 : 1),
      );
      for (const record of admitted) this.insertRecord(input, record, now);
      return Object.freeze({
        outcomes: Object.freeze(
          input.records
            .filter(
              (record, index, all) => all.findIndex((item) => item.id === record.id) === index,
            )
            .map((record) =>
              Object.freeze({
                id: record.id,
                outcome: outcomes.get(record.id) as PerceptionIngestOutcome,
              }),
            ),
        ),
        reached: Object.freeze([...reached].sort()),
      });
    })();
  }

  private insertRecord(
    input: Input<"ingestRecords">,
    record: PerceptionRecordInput,
    receivedAtMs: number,
  ): void {
    const episodeId = this.assignEpisode(input, record);
    this.database
      .prepare(
        `INSERT INTO perception_records
           (id, owner_id, agent_id, device_id, type, origin, capture_source, occurred_at_ms,
            received_at_ms, occurred_at_device, local_day, confidence, speaker_kind, speaker_ref,
            episode_id, content_ref, data_classification, evidence, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
      )
      .run(
        record.id,
        input.ownerId,
        input.agentId,
        input.deviceId,
        record.type,
        record.origin,
        record.captureSource,
        record.occurredAtMs,
        receivedAtMs,
        record.occurredAtDevice,
        record.localDay,
        record.confidence,
        record.speakerKind,
        record.speakerRef,
        episodeId,
        record.contentRef,
        record.dataClassification,
        JSON.stringify(record.evidence),
      );
    if (episodeId === null) return;
    this.database
      .prepare(
        `UPDATE perception_records SET episode_id = @episodeId
          WHERE owner_id = @ownerId AND agent_id = @agentId AND status = 'active'
            AND episode_id IS NULL
            AND local_day = (SELECT local_day FROM perception_episodes WHERE id = @episodeId)
            AND type NOT IN (SELECT value FROM json_each(@excluded))
            AND occurred_at_ms BETWEEN
              (SELECT started_at_ms FROM perception_episodes WHERE id = @episodeId) AND
              (SELECT ended_at_ms FROM perception_episodes WHERE id = @episodeId)`,
      )
      .run({
        episodeId,
        ownerId: input.ownerId,
        agentId: input.agentId,
        excluded: JSON.stringify([...input.episodeAnchorTypes, ...input.episodeBoundaryTypes]),
      });
    this.recount([episodeId]);
  }

  private recount(episodeIds: readonly string[]): void {
    if (episodeIds.length === 0) return;
    this.database
      .prepare(
        `UPDATE perception_episodes SET
           record_count = (SELECT COUNT(*) FROM perception_records
                            WHERE episode_id = perception_episodes.id AND status = 'active'),
           status = CASE WHEN EXISTS (SELECT 1 FROM perception_records
                            WHERE episode_id = perception_episodes.id AND status = 'active')
                         THEN 'active' ELSE 'deleted' END
         WHERE id IN (${placeholders(episodeIds)})`,
      )
      .run(...episodeIds);
  }

  private assignEpisode(
    input: Input<"ingestRecords">,
    record: PerceptionRecordInput,
  ): string | null {
    const at = record.occurredAtMs;
    if ((input.episodeBoundaryTypes as readonly string[]).includes(record.type)) return null;
    if (!(input.episodeAnchorTypes as readonly string[]).includes(record.type)) {
      const inside = this.database
        .prepare(
          `SELECT id FROM perception_episodes
            WHERE owner_id = ? AND agent_id = ? AND status = 'active' AND local_day = ?
              AND started_at_ms <= ? AND ended_at_ms >= ?
            ORDER BY started_at_ms DESC, id LIMIT 1`,
        )
        .get(input.ownerId, input.agentId, record.localDay, at, at) as { id: string } | undefined;
      return inside?.id ?? null;
    }
    const candidates = this.database
      .prepare(
        `SELECT id, started_at_ms AS startedAtMs, ended_at_ms AS endedAtMs
           FROM perception_episodes
          WHERE owner_id = ? AND agent_id = ? AND status = 'active' AND local_day = ?
            AND started_at_ms <= ? AND ended_at_ms >= ?
          ORDER BY started_at_ms, id`,
      )
      .all(
        input.ownerId,
        input.agentId,
        record.localDay,
        at + input.episodeSilenceMs,
        at - input.episodeSilenceMs,
      ) as { id: string; startedAtMs: number; endedAtMs: number }[];
    const distance = (episode: { startedAtMs: number; endedAtMs: number }) =>
      at > episode.endedAtMs
        ? at - episode.endedAtMs
        : at < episode.startedAtMs
          ? episode.startedAtMs - at
          : 0;
    candidates.sort(
      (left, right) => distance(left) - distance(right) || (left.id < right.id ? -1 : 1),
    );
    for (const episode of candidates) {
      const startedAtMs = Math.min(episode.startedAtMs, at);
      const endedAtMs = Math.max(episode.endedAtMs, at);
      if (endedAtMs - startedAtMs > input.episodeMaximumMs) continue;
      const gap =
        at > episode.endedAtMs
          ? [episode.endedAtMs, at]
          : at < episode.startedAtMs
            ? [at, episode.startedAtMs]
            : null;
      if (gap) {
        const moved = this.database
          .prepare(
            `SELECT 1 FROM perception_records
              WHERE owner_id = ? AND agent_id = ? AND status = 'active'
                AND type IN (SELECT value FROM json_each(?))
                AND occurred_at_ms > ? AND occurred_at_ms < ? LIMIT 1`,
          )
          .get(
            input.ownerId,
            input.agentId,
            JSON.stringify(input.episodeBoundaryTypes),
            gap[0],
            gap[1],
          );
        if (moved) continue;
      }
      this.database
        .prepare(
          `UPDATE perception_episodes SET started_at_ms = ?, ended_at_ms = ?,
                  record_count = record_count + 1
            WHERE id = ?`,
        )
        .run(startedAtMs, endedAtMs, episode.id);
      return episode.id;
    }
    const id = `episode:${createHash("sha256").update(record.id).digest("hex").slice(0, 32)}`;
    this.database
      .prepare(
        `INSERT INTO perception_episodes
           (id, owner_id, agent_id, started_at_ms, ended_at_ms, local_day, record_count, status)
         VALUES (?, ?, ?, ?, ?, ?, 1, 'active')`,
      )
      .run(id, input.ownerId, input.agentId, at, at, record.localDay);
    return id;
  }

  private dayParameters(input: Input<"countDay">) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.day))
      this.fail("PORT_INVALID_OPERATION", "Perception day is invalid");
    return {
      ownerId: input.ownerId,
      agentId: input.agentId,
      day: input.day,
      ...(input.types === null ? {} : { types: JSON.stringify(input.types) }),
    };
  }

  protected op_countDay(input: Input<"countDay">): number {
    const row = this.database
      .prepare(`${dayRows(input.types)} SELECT COUNT(*) AS total FROM day_rows`)
      .get(this.dayParameters(input)) as { total: number };
    return row.total;
  }

  protected op_listDay(input: Input<"listDay">): PerceptionDayPage {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)
      this.fail("PORT_INVALID_OPERATION", "Perception page size is invalid");
    const cursor = input.cursor === null ? null : decodeCursor(input.cursor);
    if (input.cursor !== null && cursor === null)
      this.fail("PORT_INVALID_OPERATION", "Perception cursor is invalid");
    const found = this.database
      .prepare(
        `${dayRows(input.types)}
         SELECT kind, id, at_ms AS atMs FROM day_rows
          WHERE @cursorAt IS NULL OR at_ms < @cursorAt OR (at_ms = @cursorAt AND id < @cursorId)
          ORDER BY at_ms DESC, id DESC LIMIT @limit`,
      )
      .all({
        ...this.dayParameters(input),
        cursorAt: cursor?.atMs ?? null,
        cursorId: cursor?.id ?? null,
        limit: input.limit + 1,
      }) as { kind: "episode" | "record"; id: string; atMs: number }[];
    const page = found.slice(0, input.limit);
    const rows = page.map((row): PerceptionDayRow => {
      if (row.kind === "episode")
        return Object.freeze({
          kind: "episode",
          atMs: row.atMs,
          episode: this.database
            .prepare(`SELECT ${episodeColumns} FROM perception_episodes WHERE id = ?`)
            .get(row.id) as PerceptionEpisode,
          overview: this.episodeOverview(row.id),
        });
      return Object.freeze({
        kind: "record",
        atMs: row.atMs,
        record: toRecord(
          this.database
            .prepare(`SELECT ${recordColumns} FROM perception_records WHERE id = ?`)
            .get(row.id) as RecordRow,
        ),
      });
    });
    const last = page.at(-1);
    return Object.freeze({
      rows: Object.freeze(rows),
      total: this.op_countDay(input),
      nextCursor: found.length > input.limit && last ? encodeCursor(last.atMs, last.id) : null,
    });
  }

  private episodeOverview(episodeId: string): PerceptionEpisodeOverview {
    const distinct = (column: "type" | "device_id") =>
      this.database
        .prepare(
          `SELECT ${column} AS value FROM perception_records
            WHERE episode_id = ? AND status = 'active'
            GROUP BY ${column} ORDER BY MIN(occurred_at_ms), ${column}`,
        )
        .pluck()
        .all(episodeId) as string[];
    const lead = this.database
      .prepare(
        `SELECT ${recordColumns} FROM perception_records
          WHERE episode_id = ? AND status = 'active' AND content_ref IS NOT NULL
          ORDER BY occurred_at_ms, id LIMIT 1`,
      )
      .get(episodeId) as RecordRow | undefined;
    return Object.freeze({
      types: Object.freeze(distinct("type") as PerceptionRecordType[]),
      deviceIds: Object.freeze(distinct("device_id")),
      lead: lead ? toRecord(lead) : null,
    });
  }

  protected op_readEpisode(input: Input<"readEpisode">) {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)
      this.fail("PORT_INVALID_OPERATION", "Perception page size is invalid");
    const cursor = input.cursor === null ? null : decodeCursor(input.cursor);
    if (input.cursor !== null && cursor === null)
      this.fail("PORT_INVALID_OPERATION", "Perception cursor is invalid");
    const episode = this.database
      .prepare(
        `SELECT ${episodeColumns} FROM perception_episodes
          WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'active'`,
      )
      .get(input.episodeId, input.ownerId, input.agentId) as PerceptionEpisode | undefined;
    if (!episode) return undefined;
    const found = this.database
      .prepare(
        `SELECT ${recordColumns} FROM perception_records
          WHERE episode_id = @episodeId AND status = 'active'
            AND (@cursorAt IS NULL OR occurred_at_ms > @cursorAt
                 OR (occurred_at_ms = @cursorAt AND id > @cursorId))
          ORDER BY occurred_at_ms, id LIMIT @limit`,
      )
      .all({
        episodeId: input.episodeId,
        cursorAt: cursor?.atMs ?? null,
        cursorId: cursor?.id ?? null,
        limit: input.limit + 1,
      }) as RecordRow[];
    const page = found.slice(0, input.limit).map(toRecord);
    const last = page.at(-1);
    return Object.freeze({
      episode: Object.freeze(episode),
      overview: this.episodeOverview(input.episodeId),
      records: Object.freeze(page),
      nextCursor:
        found.length > input.limit && last ? encodeCursor(last.occurredAtMs, last.id) : null,
    });
  }

  protected op_setRecordStatus(input: Input<"setRecordStatus">): boolean {
    return this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT episode_id AS episodeId, status FROM perception_records
            WHERE id = ? AND owner_id = ? AND agent_id = ?`,
        )
        .get(input.recordId, input.ownerId, input.agentId) as
        | { episodeId: string | null; status: string }
        | undefined;
      if (!row || row.status === input.status) return false;
      this.database
        .prepare("UPDATE perception_records SET status = ? WHERE id = ?")
        .run(input.status, input.recordId);
      if (row.episodeId) this.recount([row.episodeId]);
      return true;
    })();
  }

  protected op_syncMirror(input: Input<"syncMirror">) {
    this.assertDiskHeadroom();
    const now = Date.parse(this.time(input.now));
    return this.database.transaction(() => {
      let applied = 0;
      let stale = 0;
      const key = [input.ownerId, input.agentId, input.deviceId, input.kind] as const;
      const read = this.database.prepare(
        `SELECT version FROM device_mirror_items
          WHERE owner_id = ? AND agent_id = ? AND device_id = ? AND kind = ? AND external_id = ?`,
      );
      const touch = this.database.prepare(
        `UPDATE device_mirror_items SET sync_id = ?
          WHERE owner_id = ? AND agent_id = ? AND device_id = ? AND kind = ? AND external_id = ?`,
      );
      const write = this.database.prepare(
        `INSERT INTO device_mirror_items
           (owner_id, agent_id, device_id, kind, external_id, version, deleted, data, sync_id,
            updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_id, agent_id, device_id, kind, external_id) DO UPDATE SET
           version = excluded.version, deleted = excluded.deleted, data = excluded.data,
           sync_id = excluded.sync_id, updated_at_ms = excluded.updated_at_ms`,
      );
      for (const item of input.items) {
        const existing = read.get(...key, item.externalId) as { version: number } | undefined;
        if (existing && existing.version >= item.version) {
          stale += 1;
          touch.run(input.syncId, ...key, item.externalId);
          continue;
        }
        write.run(
          ...key,
          item.externalId,
          item.version,
          item.deleted ? 1 : 0,
          item.deleted || item.data === null ? null : JSON.stringify(item.data),
          input.syncId,
          now,
        );
        applied += 1;
      }
      const removed =
        input.mode === "full" && input.final
          ? this.database
              .prepare(
                `UPDATE device_mirror_items
                    SET deleted = 1, data = NULL, version = version + 1, updated_at_ms = ?
                  WHERE owner_id = ? AND agent_id = ? AND device_id = ? AND kind = ?
                    AND sync_id <> ? AND deleted = 0`,
              )
              .run(now, ...key, input.syncId).changes
          : 0;
      const { active } = this.database
        .prepare(
          `SELECT count(*) AS active FROM device_mirror_items
            WHERE owner_id = ? AND agent_id = ? AND device_id = ? AND kind = ? AND deleted = 0`,
        )
        .get(...key) as { active: number };
      return Object.freeze({ applied, stale, removed, active });
    })();
  }

  protected op_listMirror(input: Input<"listMirror">): readonly DeviceMirrorItem[] {
    return (
      this.database
        .prepare(
          `SELECT device_id AS deviceId, kind, external_id AS externalId, version, deleted, data,
                  updated_at_ms AS updatedAtMs
             FROM device_mirror_items
            WHERE owner_id = ? AND agent_id = ? AND kind = ? AND (? = 1 OR deleted = 0)
            ORDER BY device_id, external_id`,
        )
        .all(input.ownerId, input.agentId, input.kind, input.includeDeleted ? 1 : 0) as (Omit<
        DeviceMirrorItem,
        "deleted" | "data"
      > & { deleted: number; data: string | null })[]
    ).map((row) =>
      Object.freeze({
        ...row,
        deleted: row.deleted === 1,
        data: row.data === null ? null : Object.freeze(JSON.parse(row.data)),
      }),
    );
  }

  protected op_insertTrackPoints(input: Input<"insertTrackPoints">) {
    this.assertDiskHeadroom();
    this.time(input.now);
    const periodStart = this.time(input.periodStart);
    return this.database.transaction(() => {
      const exists = this.database.prepare(
        `SELECT 1 FROM location_track_points
          WHERE owner_id = ? AND agent_id = ? AND device_id = ? AND occurred_at_ms = ?`,
      );
      const insert = this.database.prepare(
        `INSERT INTO location_track_points
           (owner_id, agent_id, device_id, occurred_at_ms, latitude_e7, longitude_e7,
            accuracy_dm, speed_cms, local_day)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let room = Math.max(0, input.limit - this.used(input, input.limitKey, periodStart));
      let stored = 0;
      let duplicates = 0;
      let limitReached = 0;
      const seen = new Set<number>();
      for (const point of [...input.points].sort(
        (left, right) => left.occurredAtMs - right.occurredAtMs,
      )) {
        if (
          seen.has(point.occurredAtMs) ||
          exists.get(input.ownerId, input.agentId, input.deviceId, point.occurredAtMs)
        ) {
          duplicates += 1;
          continue;
        }
        seen.add(point.occurredAtMs);
        if (this.trackSuppressed(input, input.deviceId, point)) {
          duplicates += 1;
          continue;
        }
        if (room === 0) {
          limitReached += 1;
          continue;
        }
        room -= 1;
        insert.run(
          input.ownerId,
          input.agentId,
          input.deviceId,
          point.occurredAtMs,
          point.latitudeE7,
          point.longitudeE7,
          point.accuracyDecimeters,
          point.speedCentimetersPerSecond,
          point.localDay,
        );
        stored += 1;
      }
      if (stored > 0 && !this.reserve(input, input.limitKey, periodStart, stored, input.limit))
        return this.fail("PORT_CONFLICT", "Usage changed while reserving");
      return Object.freeze({ stored, duplicates, limitReached });
    })();
  }

  protected op_countTrackPoints(input: Input<"countTrackPoints">): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS total FROM location_track_points
          WHERE owner_id = ? AND agent_id = ? AND local_day = ?`,
      )
      .get(input.ownerId, input.agentId, input.day) as { total: number };
    return row.total;
  }

  protected op_createUploadGrant(input: Input<"createUploadGrant">): "created" | "batch_used" {
    this.assertDiskHeadroom();
    const now = this.time(input.now);
    const expiresAt = this.time(input.expiresAt);
    if (expiresAt <= now) this.fail("PORT_INVALID_OPERATION", "Upload grant lifetime is invalid");
    return this.database.transaction(() => {
      if (
        input.batchId !== null &&
        this.database
          .prepare(
            `SELECT 1 FROM device_upload_grants
              WHERE device_id = ? AND purpose = ? AND batch_id = ?`,
          )
          .get(input.deviceId, input.purpose, input.batchId)
      )
        return "batch_used" as const;
      this.database
        .prepare(
          `INSERT INTO device_upload_grants
             (token_hash, owner_id, agent_id, device_id, purpose, sha256, bytes, record_id_first,
              record_id_last, batch_id, media_kind, media_ms, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.tokenHash,
          input.ownerId,
          input.agentId,
          input.deviceId,
          input.purpose,
          input.sha256,
          input.bytes,
          input.recordIdFirst,
          input.recordIdLast,
          input.batchId,
          input.mediaKind,
          input.mediaMilliseconds,
          now,
          expiresAt,
        );
      for (const recordId of input.recordIds)
        this.database
          .prepare(
            "INSERT OR IGNORE INTO device_upload_grant_records (token_hash, record_id) VALUES (?, ?)",
          )
          .run(input.tokenHash, recordId);
      return "created" as const;
    })();
  }

  protected op_readUploadGrant(input: Input<"readUploadGrant">): UploadGrant | undefined {
    const row = this.database
      .prepare(`SELECT ${grantColumns} FROM device_upload_grants WHERE token_hash = ?`)
      .get(input.tokenHash) as Omit<UploadGrant, "recordIds"> | undefined;
    if (!row) return undefined;
    const recordIds = this.database
      .prepare(
        "SELECT record_id FROM device_upload_grant_records WHERE token_hash = ? ORDER BY record_id",
      )
      .pluck()
      .all(input.tokenHash) as string[];
    return Object.freeze({ ...row, recordIds: Object.freeze(recordIds) });
  }

  protected op_completeUploadGrant(input: Input<"completeUploadGrant">): void {
    const now = this.time(input.now);
    this.database
      .prepare(
        `UPDATE device_upload_grants SET used_at = ?, result = ?
          WHERE token_hash = ? AND used_at IS NULL`,
      )
      .run(now, input.result, input.tokenHash);
  }

  protected op_recordMedia(input: Input<"recordMedia">) {
    this.assertDiskHeadroom();
    const periodStart = this.time(input.periodStart);
    const receivedAt = this.time(input.item.receivedAt);
    return this.database.transaction(() => {
      const link = () => {
        for (const recordId of input.recordIds ?? [])
          this.database
            .prepare(
              `INSERT OR IGNORE INTO perception_media_links (owner_id, agent_id, media_id, record_id)
               VALUES (?, ?, ?, ?)`,
            )
            .run(input.ownerId, input.agentId, input.item.id, recordId);
      };
      if (
        this.database
          .prepare(
            "SELECT 1 FROM perception_media_items WHERE id = ? AND owner_id = ? AND agent_id = ?",
          )
          .get(input.item.id, input.ownerId, input.agentId)
      ) {
        link();
        return Object.freeze({ stored: false, duplicate: true, reached: null });
      }
      for (const reservation of input.reservations) {
        const room =
          reservation.limit === null
            ? Number.MAX_SAFE_INTEGER
            : reservation.limit - this.used(input, reservation.key, periodStart);
        if (reservation.amount > room)
          return Object.freeze({ stored: false, duplicate: false, reached: reservation.key });
      }
      for (const reservation of input.reservations)
        if (
          !this.reserve(input, reservation.key, periodStart, reservation.amount, reservation.limit)
        )
          return this.fail("PORT_CONFLICT", "Usage changed while reserving");
      this.database
        .prepare(
          `INSERT INTO perception_media_items
             (id, owner_id, agent_id, device_id, kind, bytes, sha256, milliseconds, received_at,
              status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .run(
          input.item.id,
          input.ownerId,
          input.agentId,
          input.item.deviceId,
          input.item.kind,
          input.item.bytes,
          input.item.sha256,
          input.item.milliseconds,
          receivedAt,
        );
      link();
      return Object.freeze({ stored: true, duplicate: false, reached: null });
    })();
  }

  protected op_listMedia(input: Input<"listMedia">): readonly PerceptionMediaItem[] {
    return this.database
      .prepare(
        `SELECT id, device_id AS deviceId, kind, bytes, sha256, milliseconds,
                received_at AS receivedAt, status
           FROM perception_media_items
          WHERE owner_id = ? AND agent_id = ? AND status = ? ORDER BY received_at, id`,
      )
      .all(input.ownerId, input.agentId, input.status) as PerceptionMediaItem[];
  }

  protected op_readUsage(input: Input<"readUsage">): readonly LimitUsageRow[] {
    return this.database
      .prepare(
        `SELECT key, device_id AS deviceId, period_start AS periodStart, used,
                warned_at AS warnedAt
           FROM limit_usage
          WHERE owner_id = ? AND agent_id = ? AND period_start = ? ORDER BY key, device_id`,
      )
      .all(input.ownerId, input.agentId, this.time(input.periodStart)) as LimitUsageRow[];
  }

  protected op_reserveUsage(input: Input<"reserveUsage">): boolean {
    this.assertDiskHeadroom();
    return this.reserve(input, input.key, this.time(input.periodStart), input.amount, input.limit);
  }

  protected op_reportDeviceUsage(input: Input<"reportDeviceUsage">): void {
    this.assertDiskHeadroom();
    this.database
      .prepare(
        `INSERT INTO limit_usage (owner_id, agent_id, key, period_start, device_id, used)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_id, agent_id, key, period_start, device_id) DO UPDATE
           SET used = excluded.used`,
      )
      .run(
        input.ownerId,
        input.agentId,
        input.key,
        this.time(input.periodStart),
        input.deviceId,
        this.amount(input.value),
      );
  }

  protected op_markUsageWarned(input: Input<"markUsageWarned">): boolean {
    return (
      this.database
        .prepare(
          `UPDATE limit_usage SET warned_at = ?
            WHERE owner_id = ? AND agent_id = ? AND key = ? AND period_start = ?
              AND device_id = '' AND warned_at IS NULL`,
        )
        .run(
          this.time(input.now),
          input.ownerId,
          input.agentId,
          input.key,
          this.time(input.periodStart),
        ).changes === 1
    );
  }

  private ids(values: readonly string[], maximum: number): string {
    if (values.length > maximum || values.some((value) => typeof value !== "string"))
      this.fail("PORT_INVALID_OPERATION", "Perception id list is invalid");
    return JSON.stringify(values);
  }

  protected op_listRecordsBetween(input: Input<"listRecordsBetween">) {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 500 ||
      !Number.isSafeInteger(input.fromMs) ||
      !Number.isSafeInteger(input.toMs) ||
      input.fromMs < 0 ||
      input.toMs < input.fromMs
    )
      this.fail("PORT_INVALID_OPERATION", "Perception range is invalid");
    const parameters = {
      ownerId: input.ownerId,
      agentId: input.agentId,
      fromMs: input.fromMs,
      toMs: input.toMs,
      types: input.types === null ? null : JSON.stringify(input.types),
    };
    const where = `owner_id = @ownerId AND agent_id = @agentId AND status = 'active'
      AND occurred_at_ms BETWEEN @fromMs AND @toMs
      AND (@types IS NULL OR type IN (SELECT value FROM json_each(@types)))`;
    const rows = this.database
      .prepare(
        `SELECT ${recordColumns} FROM perception_records WHERE ${where}
            AND (@afterMs IS NULL OR occurred_at_ms > @afterMs
                 OR (occurred_at_ms = @afterMs AND id > @afterId))
          ORDER BY occurred_at_ms, id LIMIT @limit`,
      )
      .all({
        ...parameters,
        afterMs: input.after?.atMs ?? null,
        afterId: input.after?.id ?? null,
        limit: input.limit,
      }) as RecordRow[];
    const { total } = this.database
      .prepare(`SELECT COUNT(*) AS total FROM perception_records WHERE ${where}`)
      .get(parameters) as { total: number };
    return Object.freeze({ records: Object.freeze(rows.map(toRecord)), total });
  }

  protected op_readRecords(input: Input<"readRecords">): readonly PerceptionRecord[] {
    if (input.ids.length === 0) return Object.freeze([]);
    return Object.freeze(
      (
        this.database
          .prepare(
            `SELECT ${recordColumns} FROM perception_records
              WHERE owner_id = ? AND agent_id = ? AND status = 'active'
                AND id IN (SELECT value FROM json_each(?))
              ORDER BY occurred_at_ms, id`,
          )
          .all(input.ownerId, input.agentId, this.ids(input.ids, 2000)) as RecordRow[]
      ).map(toRecord),
    );
  }

  private extraction(episodeId: string): PerceptionExtractionState | undefined {
    const row = this.database
      .prepare(
        `SELECT episode_id AS episodeId, status, attempts, record_count AS recordCount,
                next_attempt_at AS nextAttemptAt, error_code AS errorCode,
                cost_micros AS costMicros, updated_at AS updatedAt
           FROM perception_extractions WHERE episode_id = ?`,
      )
      .get(episodeId) as PerceptionExtractionState | undefined;
    return row ? Object.freeze(row) : undefined;
  }

  private ownedEpisode(scope: PerceptionScope, episodeId: string): PerceptionEpisode | undefined {
    return this.database
      .prepare(
        `SELECT ${episodeColumns} FROM perception_episodes
          WHERE id = ? AND owner_id = ? AND agent_id = ? AND status = 'active'`,
      )
      .get(episodeId, scope.ownerId, scope.agentId) as PerceptionEpisode | undefined;
  }

  protected op_listEpisodesToExtract(
    input: Input<"listEpisodesToExtract">,
  ): readonly PerceptionEpisode[] {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500)
      this.fail("PORT_INVALID_OPERATION", "Perception page size is invalid");
    return Object.freeze(
      this.database
        .prepare(
          `SELECT ${episodeColumns
            .split(",")
            .map((column) => `e.${column.trim()}`)
            .join(", ")}
             FROM perception_episodes e
             LEFT JOIN perception_extractions x ON x.episode_id = e.id
            WHERE e.owner_id = @ownerId AND e.agent_id = @agentId AND e.status = 'active'
              AND e.ended_at_ms < @endedBeforeMs
              AND (x.episode_id IS NULL
                   OR (x.status IN ('done', 'failed') AND x.record_count <> e.record_count)
                   OR (x.status IN ('running', 'retry', 'waiting_budget')
                       AND x.next_attempt_at <= @now
                       AND (x.attempts < @maximumAttempts OR x.status = 'waiting_budget'
                            OR x.record_count <> e.record_count)))
            ORDER BY e.ended_at_ms, e.id LIMIT @limit`,
        )
        .all({
          ownerId: input.ownerId,
          agentId: input.agentId,
          endedBeforeMs: input.endedBeforeMs,
          now: this.time(input.now),
          maximumAttempts: input.maximumAttempts,
          limit: input.limit,
        }) as PerceptionEpisode[],
    );
  }

  protected op_readExtraction(
    input: Input<"readExtraction">,
  ): PerceptionExtractionState | undefined {
    return this.ownedEpisode(input, input.episodeId) ? this.extraction(input.episodeId) : undefined;
  }

  protected op_beginExtraction(
    input: Input<"beginExtraction">,
  ): PerceptionExtractionState | undefined {
    this.assertDiskHeadroom();
    const now = this.time(input.now);
    const leaseUntil = this.time(input.leaseUntil);
    if (leaseUntil <= now) this.fail("PORT_INVALID_OPERATION", "Extraction lease is invalid");
    return this.database.transaction(() => {
      if (!this.ownedEpisode(input, input.episodeId)) return undefined;
      const current = this.extraction(input.episodeId);
      if (
        current?.status === "running" &&
        current.nextAttemptAt !== null &&
        current.nextAttemptAt > now
      )
        return undefined;
      const fresh = !current || current.recordCount !== input.recordCount;
      this.database
        .prepare(
          `INSERT INTO perception_extractions
             (episode_id, owner_id, agent_id, status, attempts, record_count, next_attempt_at,
              error_code, cost_micros, updated_at)
           VALUES (@episodeId, @ownerId, @agentId, 'running', 1, @recordCount, @leaseUntil,
                   NULL, 0, @now)
           ON CONFLICT (episode_id) DO UPDATE SET
             status = 'running', attempts = @attempts, record_count = @recordCount,
             next_attempt_at = @leaseUntil, error_code = NULL, updated_at = @now`,
        )
        .run({
          episodeId: input.episodeId,
          ownerId: input.ownerId,
          agentId: input.agentId,
          recordCount: this.amount(input.recordCount),
          leaseUntil,
          now,
          attempts: fresh
            ? 1
            : (current?.attempts ?? 0) + (current?.status === "waiting_budget" ? 0 : 1),
        });
      return this.extraction(input.episodeId);
    })();
  }

  protected op_settleExtraction(input: Input<"settleExtraction">): PerceptionExtractionState {
    this.assertDiskHeadroom();
    const now = this.time(input.now);
    const waits = input.status === "retry" || input.status === "waiting_budget";
    if (waits !== (input.nextAttemptAt !== null))
      this.fail("PORT_INVALID_OPERATION", "Extraction retry time is invalid");
    if (input.nextAttemptAt !== null) this.time(input.nextAttemptAt);
    for (const decision of input.decisions) {
      const problem = validateLedgerWrite(decision);
      if (problem) this.fail("PORT_INVALID_OPERATION", problem);
    }
    return this.database.transaction(() => {
      if (!this.ownedEpisode(input, input.episodeId) && !this.extraction(input.episodeId))
        return this.fail("PORT_NOT_FOUND", "Extraction was not found");
      const changed = this.database
        .prepare(
          `UPDATE perception_extractions
              SET status = ?, next_attempt_at = ?, error_code = ?,
                  cost_micros = cost_micros + ?, updated_at = ?
            WHERE episode_id = ? AND owner_id = ? AND agent_id = ? AND status = 'running'`,
        )
        .run(
          input.status,
          input.nextAttemptAt,
          input.errorCode,
          this.amount(input.costMicros),
          now,
          input.episodeId,
          input.ownerId,
          input.agentId,
        ).changes;
      if (changed !== 1) return this.fail("PORT_CONFLICT", "Extraction is not running");
      for (const decision of input.decisions) insertLedgerRow(this.database, decision);
      return this.extraction(input.episodeId) as PerceptionExtractionState;
    })();
  }

  protected op_recordCommandUtterance(input: Input<"recordCommandUtterance">): void {
    this.assertDiskHeadroom();
    if (input.utteranceId.length < 1 || input.utteranceId.length > 64)
      this.fail("PORT_INVALID_OPERATION", "Utterance id is invalid");
    this.database
      .prepare(
        `INSERT INTO perception_command_utterances (owner_id, agent_id, utterance_id, recorded_at)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(input.ownerId, input.agentId, input.utteranceId, this.time(input.now));
  }

  protected op_commandUtterances(input: Input<"commandUtterances">): readonly string[] {
    if (input.utteranceIds.length === 0) return Object.freeze([]);
    return Object.freeze(
      this.database
        .prepare(
          `SELECT utterance_id FROM perception_command_utterances
            WHERE owner_id = ? AND agent_id = ?
              AND utterance_id IN (SELECT value FROM json_each(?))
            ORDER BY utterance_id`,
        )
        .pluck()
        .all(input.ownerId, input.agentId, this.ids(input.utteranceIds, 5000)) as string[],
    );
  }

  protected op_prune(input: Input<"prune">) {
    const now = this.time(input.now);
    return this.database.transaction(() => {
      const trackPoints = this.database
        .prepare(
          `DELETE FROM location_track_points
            WHERE owner_id = ? AND agent_id = ? AND occurred_at_ms < ?`,
        )
        .run(input.ownerId, input.agentId, input.trackBeforeMs).changes;
      const parameters = {
        ownerId: input.ownerId,
        agentId: input.agentId,
        before: input.surroundingsBeforeMs,
        types: JSON.stringify(input.surroundingsTypes),
      };
      const expired = `owner_id = @ownerId AND agent_id = @agentId AND occurred_at_ms < @before
        AND type IN (SELECT value FROM json_each(@types))`;
      const episodes = (
        this.database
          .prepare(
            `SELECT DISTINCT episode_id AS id FROM perception_records
              WHERE ${expired} AND episode_id IS NOT NULL`,
          )
          .all(parameters) as { id: string }[]
      ).map((row) => row.id);
      const records = this.database
        .prepare(`DELETE FROM perception_records WHERE ${expired}`)
        .run(parameters).changes;
      this.recount(episodes);
      const grants = this.database
        .prepare(
          `DELETE FROM device_upload_grants
            WHERE owner_id = ? AND agent_id = ? AND expires_at <= ?`,
        )
        .run(input.ownerId, input.agentId, now).changes;
      const media = this.database
        .prepare(
          `DELETE FROM perception_media_items
            WHERE owner_id = ? AND agent_id = ? AND received_at < ?`,
        )
        .run(input.ownerId, input.agentId, this.time(input.mediaBefore)).changes;
      this.database
        .prepare(
          `DELETE FROM perception_deletions
            WHERE owner_id = ? AND agent_id = ? AND status = 'planned' AND expires_at <= ?`,
        )
        .run(input.ownerId, input.agentId, now);
      return Object.freeze({ trackPoints, records, grants, media });
    })();
  }

  private deletionTime(value: string): string {
    return this.time(value);
  }

  private scopeMatch(
    input: PerceptionScope,
    deviceId: string,
    record: {
      readonly id?: string;
      readonly type?: string;
      readonly localDay: string;
      readonly occurredAtMs: number;
    },
    track: boolean,
  ): boolean {
    const rows = this.database
      .prepare(
        `SELECT kind, local_day AS day, types, record_ids AS recordIds, track
           FROM perception_deletion_scopes
          WHERE owner_id = ? AND agent_id = ? AND bound_ms >= ?
            AND (device_id IS NULL OR device_id = ?)`,
      )
      .all(input.ownerId, input.agentId, record.occurredAtMs, deviceId) as {
      kind: string;
      day: string | null;
      types: string;
      recordIds: string;
      track: number;
    }[];
    for (const row of rows) {
      if (track) {
        if (row.track !== 1) continue;
        if (row.kind === "day" && row.day === record.localDay) return true;
        if (row.kind === "types") return true;
        continue;
      }
      if (
        (row.kind === "records" || row.kind === "episode") &&
        record.id !== undefined &&
        (JSON.parse(row.recordIds) as string[]).includes(record.id)
      )
        return true;
      if (row.kind === "day" && row.day === record.localDay) return true;
      if (
        row.kind === "types" &&
        record.type !== undefined &&
        (JSON.parse(row.types) as string[]).includes(record.type)
      )
        return true;
    }
    return false;
  }

  private suppressed(
    input: PerceptionScope,
    deviceId: string,
    record: {
      readonly id: string;
      readonly type: string;
      readonly localDay: string;
      readonly occurredAtMs: number;
    },
  ): boolean {
    const idScopes = this.database
      .prepare(
        `SELECT 1 FROM perception_deletion_scopes
          WHERE owner_id = ? AND agent_id = ?
            AND EXISTS (SELECT 1 FROM json_each(record_ids) WHERE value = ?)`,
      )
      .get(input.ownerId, input.agentId, record.id);
    if (idScopes) return true;
    return this.scopeMatch(input, deviceId, record, false);
  }

  private trackSuppressed(
    input: PerceptionScope,
    deviceId: string,
    point: { readonly localDay: string; readonly occurredAtMs: number },
  ): boolean {
    return this.scopeMatch(input, deviceId, point, true);
  }

  private deletionRecordIds(
    scope: PerceptionScope,
    target: PerceptionDeletionTarget,
    boundMs: number,
  ): string[] {
    const base = { ownerId: scope.ownerId, agentId: scope.agentId, device: target.deviceId };
    const device = "AND (@device IS NULL OR device_id = @device)";
    const rows = (sql: string, extra: Record<string, unknown>) =>
      this.database
        .prepare(sql)
        .pluck()
        .all({ ...base, ...extra }) as string[];
    switch (target.kind) {
      case "records":
        return rows(
          `SELECT id FROM perception_records
            WHERE owner_id = @ownerId AND agent_id = @agentId
              AND id IN (SELECT value FROM json_each(@ids)) ORDER BY id`,
          { ids: JSON.stringify(target.ids) },
        );
      case "episode":
        return rows(
          `SELECT id FROM perception_records
            WHERE owner_id = @ownerId AND agent_id = @agentId AND episode_id = @episode
              AND received_at_ms <= @bound ORDER BY id`,
          { episode: target.episodeId, bound: boundMs },
        );
      case "day":
        return rows(
          `SELECT id FROM perception_records
            WHERE owner_id = @ownerId AND agent_id = @agentId AND local_day = @day
              AND received_at_ms <= @bound ${device} ORDER BY id`,
          { day: target.day, bound: boundMs },
        );
      case "types":
        return rows(
          `SELECT id FROM perception_records
            WHERE owner_id = @ownerId AND agent_id = @agentId
              AND type IN (SELECT value FROM json_each(@types))
              AND received_at_ms <= @bound ${device} ORDER BY id`,
          { types: JSON.stringify(target.types), bound: boundMs },
        );
    }
  }

  private deletionTrack(target: PerceptionDeletionTarget, trackTypes: readonly string[]): boolean {
    return (
      target.kind === "day" ||
      (target.kind === "types" && target.types.some((type) => trackTypes.includes(type)))
    );
  }

  private trackWhere(target: PerceptionDeletionTarget): string {
    return `owner_id = @ownerId AND agent_id = @agentId AND occurred_at_ms <= @bound
      AND (@device IS NULL OR device_id = @device)
      ${target.kind === "day" ? "AND local_day = @day" : ""}`;
  }

  private trackParameters(
    scope: PerceptionScope,
    target: PerceptionDeletionTarget,
    boundMs: number,
  ) {
    return {
      ownerId: scope.ownerId,
      agentId: scope.agentId,
      bound: boundMs,
      device: target.deviceId,
      ...(target.kind === "day" ? { day: target.day } : {}),
    };
  }

  private deletionMedia(scope: PerceptionScope, ids: readonly string[]): string[] {
    if (ids.length === 0) return [];
    return this.database
      .prepare(
        `SELECT DISTINCT l.media_id FROM perception_media_links l
          WHERE l.owner_id = ? AND l.agent_id = ?
            AND l.record_id IN (SELECT value FROM json_each(?))
            AND NOT EXISTS (
              SELECT 1 FROM perception_media_links other
                JOIN perception_records r ON r.id = other.record_id
               WHERE other.media_id = l.media_id
                 AND other.record_id NOT IN (SELECT value FROM json_each(?)))`,
      )
      .pluck()
      .all(scope.ownerId, scope.agentId, JSON.stringify(ids), JSON.stringify(ids)) as string[];
  }

  private readDeletionRow(scope: PerceptionScope, id: string): PerceptionDeletion | undefined {
    const row = this.database
      .prepare(
        `SELECT id, status, target, bound_ms AS boundMs, plan, receipt, created_at AS createdAt,
                expires_at AS expiresAt, started_at AS startedAt, finished_at AS finishedAt,
                json_array_length(pending_refs) AS pendingPayloads
           FROM perception_deletions WHERE id = ? AND owner_id = ? AND agent_id = ?`,
      )
      .get(id, scope.ownerId, scope.agentId) as
      | (Omit<PerceptionDeletion, "target" | "plan" | "receipt"> & {
          target: string;
          plan: string;
          receipt: string | null;
        })
      | undefined;
    if (!row) return undefined;
    return Object.freeze({
      ...row,
      target: Object.freeze(JSON.parse(row.target)) as PerceptionDeletionTarget,
      plan: Object.freeze(JSON.parse(row.plan)) as PerceptionDeletionCounts,
      receipt: row.receipt
        ? (Object.freeze(JSON.parse(row.receipt)) as PerceptionDeletionCounts)
        : null,
    });
  }

  protected op_planDeletion(input: Input<"planDeletion">) {
    const now = this.deletionTime(input.now);
    const expiresAt = this.deletionTime(input.expiresAt);
    const boundMs = Date.parse(now);
    return this.database.transaction(() => {
      if (
        input.target.deviceId !== null &&
        !this.database
          .prepare("SELECT 1 FROM paired_devices WHERE id = ? AND owner_id = ? AND agent_id = ?")
          .get(input.target.deviceId, input.ownerId, input.agentId)
      )
        return "device_unknown" as const;
      if (
        input.target.kind === "episode" &&
        !this.database
          .prepare(
            "SELECT 1 FROM perception_episodes WHERE id = ? AND owner_id = ? AND agent_id = ?",
          )
          .get(input.target.episodeId, input.ownerId, input.agentId)
      )
        return "episode_unknown" as const;
      const ids = this.deletionRecordIds(input, input.target, boundMs);
      const track = this.deletionTrack(input.target, input.trackTypes)
        ? (this.database
            .prepare(
              `SELECT COUNT(*) FROM location_track_points WHERE ${this.trackWhere(input.target)}`,
            )
            .pluck()
            .get(this.trackParameters(input, input.target, boundMs)) as number)
        : 0;
      const plan: PerceptionDeletionCounts = {
        records: ids.length,
        trackPoints: track,
        media: this.deletionMedia(input, ids).length,
      };
      this.database
        .prepare(
          `INSERT INTO perception_deletions
             (id, owner_id, agent_id, status, target, bound_ms, plan, created_at, expires_at)
           VALUES (?, ?, ?, 'planned', ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.ownerId,
          input.agentId,
          JSON.stringify(input.target),
          boundMs,
          JSON.stringify(plan),
          now,
          expiresAt,
        );
      return this.readDeletionRow(input, input.id) as PerceptionDeletion;
    })();
  }

  protected op_readDeletion(input: Input<"readDeletion">) {
    return this.readDeletionRow(input, input.id);
  }

  protected op_startDeletion(input: Input<"startDeletion">) {
    const now = this.deletionTime(input.now);
    return this.database.transaction(() => {
      const deletion = this.readDeletionRow(input, input.id);
      if (!deletion) return "unknown" as const;
      if (deletion.status !== "planned") return deletion;
      if (deletion.expiresAt <= now) return "expired" as const;
      const { target, boundMs } = deletion;
      const ids = this.deletionRecordIds(input, target, boundMs);
      const mediaIds = this.deletionMedia(input, ids);
      const refs = ids.length
        ? (this.database
            .prepare(
              `SELECT DISTINCT content_ref FROM perception_records
                WHERE id IN (SELECT value FROM json_each(?)) AND content_ref IS NOT NULL`,
            )
            .pluck()
            .all(JSON.stringify(ids)) as string[])
        : [];
      const episodes = ids.length
        ? (this.database
            .prepare(
              `SELECT DISTINCT episode_id FROM perception_records
                WHERE id IN (SELECT value FROM json_each(?)) AND episode_id IS NOT NULL`,
            )
            .pluck()
            .all(JSON.stringify(ids)) as string[])
        : [];
      this.database
        .prepare("DELETE FROM perception_records WHERE id IN (SELECT value FROM json_each(?))")
        .run(JSON.stringify(ids));
      this.recount(episodes);
      if (mediaIds.length)
        this.database
          .prepare(
            "DELETE FROM perception_media_items WHERE id IN (SELECT value FROM json_each(?))",
          )
          .run(JSON.stringify(mediaIds));
      const track = this.deletionTrack(target, input.trackTypes);
      const trackPoints = track
        ? this.database
            .prepare(`DELETE FROM location_track_points WHERE ${this.trackWhere(target)}`)
            .run(this.trackParameters(input, target, boundMs)).changes
        : 0;
      this.database
        .prepare(
          `INSERT INTO perception_deletion_scopes
             (deletion_id, owner_id, agent_id, kind, device_id, local_day, types, record_ids, track,
              bound_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.ownerId,
          input.agentId,
          target.kind,
          target.deviceId,
          target.kind === "day" ? target.day : null,
          JSON.stringify(target.kind === "types" ? target.types : []),
          JSON.stringify(ids),
          track ? 1 : 0,
          boundMs,
          now,
        );
      const receipt: PerceptionDeletionCounts = {
        records: ids.length,
        trackPoints,
        media: mediaIds.length,
      };
      this.database
        .prepare(
          `UPDATE perception_deletions
              SET status = 'running', started_at = ?, receipt = ?, pending_refs = ?
            WHERE id = ?`,
        )
        .run(now, JSON.stringify(receipt), JSON.stringify(refs), input.id);
      return this.readDeletionRow(input, input.id) as PerceptionDeletion;
    })();
  }

  protected op_cleanDeletion(input: Input<"cleanDeletion">) {
    const now = this.deletionTime(input.now);
    return this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT pending_refs AS pending, status, attempts FROM perception_deletions
            WHERE id = ? AND owner_id = ? AND agent_id = ?`,
        )
        .get(input.id, input.ownerId, input.agentId) as
        | { pending: string; status: string; attempts: number }
        | undefined;
      if (!row) return this.fail("PORT_NOT_FOUND", "Perception deletion is unknown");
      const deletion = this.readDeletionRow(input, input.id) as PerceptionDeletion;
      if (row.status !== "running")
        return Object.freeze({ deletion, paths: Object.freeze([]), progressed: false });
      const pending = JSON.parse(row.pending) as string[];
      const take = pending.slice(0, Math.max(1, input.chunk));
      const rest = pending.slice(take.length);
      const paths: string[] = [];
      for (const ref of take) {
        const payload = this.database
          .prepare(
            "SELECT ciphertext_path AS path FROM payloads WHERE ref = ? AND owner_id = ? AND agent_id = ?",
          )
          .get(ref, input.ownerId, input.agentId) as { path: string | null } | undefined;
        if (!payload) continue;
        this.database.prepare("DELETE FROM payloads WHERE ref = ?").run(ref);
        if (payload.path) paths.push(payload.path);
      }
      this.database
        .prepare(
          "UPDATE perception_deletions SET pending_refs = ?, attempts = attempts + 1 WHERE id = ?",
        )
        .run(JSON.stringify(rest), input.id);
      if (rest.length === 0) {
        const remaining = this.deletionRecordIds(input, deletion.target, deletion.boundMs);
        if (remaining.length === 0)
          this.database
            .prepare(
              "UPDATE perception_deletions SET status = 'verified', finished_at = ? WHERE id = ?",
            )
            .run(now, input.id);
      }
      const after = this.readDeletionRow(input, input.id) as PerceptionDeletion;
      return Object.freeze({
        deletion: after,
        paths: Object.freeze(paths),
        progressed: take.length > 0 || after.status === "verified",
      });
    })();
  }

  protected op_openDeletions(input: Input<"openDeletions">): readonly string[] {
    return this.database
      .prepare(
        `SELECT id FROM perception_deletions
          WHERE owner_id = ? AND agent_id = ? AND status = 'running' ORDER BY created_at, id`,
      )
      .pluck()
      .all(input.ownerId, input.agentId) as string[];
  }

  protected op_readDeletionScopes(input: Input<"readDeletionScopes">) {
    const rows = this.database
      .prepare(
        `SELECT revision, kind, device_id AS deviceId, local_day AS day, types,
                CASE WHEN kind IN ('records', 'episode') THEN record_ids ELSE '[]' END AS recordIds,
                track, bound_ms AS boundMs
           FROM perception_deletion_scopes
          WHERE owner_id = ? AND agent_id = ? AND revision > ? ORDER BY revision LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, input.after, input.limit) as {
      revision: number;
      kind: PerceptionDeletionScope["kind"];
      deviceId: string | null;
      day: string | null;
      types: string;
      recordIds: string;
      track: number;
      boundMs: number;
    }[];
    const revision =
      (this.database
        .prepare(
          "SELECT MAX(revision) FROM perception_deletion_scopes WHERE owner_id = ? AND agent_id = ?",
        )
        .pluck()
        .get(input.ownerId, input.agentId) as number | null) ?? 0;
    return Object.freeze({
      scopes: Object.freeze(
        rows.map((row) =>
          Object.freeze({
            revision: row.revision,
            kind: row.kind,
            deviceId: row.deviceId,
            day: row.day,
            types: Object.freeze(JSON.parse(row.types) as string[]),
            recordIds: Object.freeze(JSON.parse(row.recordIds) as string[]),
            track: row.track === 1,
            boundMs: row.boundMs,
          }),
        ),
      ),
      revision,
    });
  }
}
