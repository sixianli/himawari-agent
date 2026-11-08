import {
  MUSE_CHANNEL_DOWN_MS,
  MUSE_CHANNEL_STALE_MS,
  MUSE_INTAKE_DECISIONS,
  MUSE_INTAKE_KINDS,
  MUSE_INTAKE_PRIORITIES,
  MUSE_INTAKE_SENDER,
  MUSE_INTAKE_SOURCES,
  MUSE_INTAKE_STATES,
  museIntakeItemKey,
  type MuseChannelState,
  type MuseChannelStatus,
  type MuseIntakeBatchOutcome,
  type MuseIntakeBatchWrite,
  type MuseIntakeItem,
  type MuseIntakeItemWrite,
  type MuseIntakePort,
} from "@himawari-agent/application/muse-intake";
import type Database from "better-sqlite3";
import type { SqliteApplicationFailure } from "./sqlite-durable-operations.ts";

type Input<TName extends keyof MuseIntakePort> = Parameters<MuseIntakePort[TName]>[0];

const MAX_ITEMS_PER_BATCH = 200;
const MAX_OPTIONS = 12;

function validTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function text(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function nullableText(value: unknown, max: number): boolean {
  return value === null || text(value, 1, max);
}

const GMAIL_MESSAGE_ID = /^[A-Za-z0-9_-]{1,256}$/u;

function gmailMessageId(value: unknown): boolean {
  return value === null || (typeof value === "string" && GMAIL_MESSAGE_ID.test(value));
}

function nullableTime(value: unknown): boolean {
  return value === null || validTime(value);
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function itemProblem(item: MuseIntakeItemWrite): string | null {
  if (!(MUSE_INTAKE_KINDS as readonly string[]).includes(item.kind)) return "kind";
  if (!text(item.naturalKey, 1, 150)) return "natural key";
  if (!(MUSE_INTAKE_STATES[item.kind] as readonly string[]).includes(item.state)) return "state";
  if (!nullableText(item.reasonCode, 64) || !nullableText(item.reasonEnum, 64)) return "reason";
  if (
    item.decision !== null &&
    !(MUSE_INTAKE_DECISIONS as readonly string[]).includes(item.decision)
  )
    return "decision";
  if (
    item.priority !== null &&
    !(MUSE_INTAKE_PRIORITIES as readonly string[]).includes(item.priority)
  )
    return "priority";
  if (
    !validTime(item.occurredAt) ||
    !nullableTime(item.scheduledFor) ||
    !nullableTime(item.startedAt) ||
    !nullableTime(item.preparedAt) ||
    !nullableTime(item.handoffAcceptedAt) ||
    !nullableTime(item.eventAt)
  )
    return "time";
  if (!nullableText(item.titleRef, 256) || !nullableText(item.textRef, 256)) return "text ref";
  if (typeof item.textWithheld !== "boolean") return "withheld flag";
  if (
    !Array.isArray(item.options) ||
    item.options.length > MAX_OPTIONS ||
    !item.options.every((option) => text(option, 1, 80))
  )
    return "options";
  if (!gmailMessageId(item.gmailMessageId)) return "gmail message id";
  if (typeof item.sources !== "object" || item.sources === null) return "sources";
  const sources = Object.entries(item.sources);
  if (
    sources.length > 32 ||
    !sources.every(
      ([field, source]) =>
        text(field, 1, 64) && (MUSE_INTAKE_SOURCES as readonly string[]).includes(source),
    )
  )
    return "sources";
  if (!text(item.contentDigest, 8, 128)) return "digest";
  return null;
}

function refsOf(items: readonly MuseIntakeItemWrite[]): string[] {
  return items
    .flatMap((item) => [item.titleRef, item.textRef])
    .filter((ref): ref is string => !!ref);
}

export class SqliteMuseIntakeOperations {
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
      case "museIntake.ingestBatch":
        return this.ingestBatch(payload as Input<"ingestBatch">);
      case "museIntake.listItems":
        return this.listItems(payload as Input<"listItems">);
      case "museIntake.channelStatus":
        return this.channelStatus(payload as Input<"channelStatus">);
      case "museIntake.checkChannel":
        return this.checkChannel(payload as Input<"checkChannel">);
      case "museIntake.setPaused":
        return this.setPaused(payload as Input<"setPaused">);
      case "museIntake.rate":
        return this.rate(payload as Input<"rate">);
      case "museIntake.clearAll":
        return this.clearAll(payload as Input<"clearAll">);
      default:
        return this.fail("PORT_INVALID_OPERATION", `Unknown Muse intake operation ${operation}`);
    }
  }

  private readChannel(ownerId: string, agentId: string): Record<string, unknown> | undefined {
    return this.database
      .prepare(
        `SELECT last_batch_at AS lastBatchAt, last_seq AS lastSeq, gap_count AS gapCount,
           paused, outage_started_at AS outageStartedAt, outage_notified_at AS outageNotifiedAt
         FROM muse_intake_channel WHERE owner_id = ? AND agent_id = ?`,
      )
      .get(ownerId, agentId) as Record<string, unknown> | undefined;
  }

  private ingestBatch(write: MuseIntakeBatchWrite): MuseIntakeBatchOutcome {
    this.assertDiskHeadroom();
    if (
      write.senderId !== MUSE_INTAKE_SENDER ||
      !text(write.batchId, 1, 128) ||
      !Number.isSafeInteger(write.batchSeq) ||
      write.batchSeq < 1 ||
      !validTime(write.sentAt) ||
      !validTime(write.receivedAt) ||
      !count(write.rejectedCount) ||
      !count(write.droppedFieldCount) ||
      !Array.isArray(write.items) ||
      write.items.length > MAX_ITEMS_PER_BATCH
    )
      this.fail("PORT_INVALID_OPERATION", "Muse intake batch is invalid");
    for (const item of write.items) {
      const problem = itemProblem(item);
      if (problem) this.fail("PORT_INVALID_OPERATION", `Muse intake item ${problem} is invalid`);
    }
    const allRefs = refsOf(write.items);
    return this.database.transaction((): MuseIntakeBatchOutcome => {
      const channel = this.readChannel(write.ownerId, write.agentId);
      const lastSeq = (channel?.["lastSeq"] as number | undefined) ?? 0;
      if (channel?.["paused"] === 1)
        return {
          status: "paused",
          expectedNextSeq: lastSeq + 1,
          unusedRefs: allRefs,
        };
      const inserted = this.database
        .prepare(
          `INSERT INTO muse_intake_batches (
            id, owner_id, agent_id, sender_id, batch_seq, sent_at, received_at, item_count,
            accepted_count, duplicate_count, conflict_count, rejected_count, dropped_field_count
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
          ON CONFLICT (owner_id, agent_id, sender_id, batch_seq) DO NOTHING`,
        )
        .run(
          write.batchId,
          write.ownerId,
          write.agentId,
          write.senderId,
          write.batchSeq,
          write.sentAt,
          write.receivedAt,
          write.items.length,
          write.rejectedCount,
          write.droppedFieldCount,
        );
      if (inserted.changes === 0)
        return {
          status: "replay",
          expectedNextSeq: lastSeq + 1,
          unusedRefs: allRefs,
        };

      let accepted = 0;
      let duplicate = 0;
      let conflict = 0;
      const unused: string[] = [];
      const insertItem = this.database.prepare(
        `INSERT INTO muse_intake_items (
          owner_id, agent_id, kind, natural_key, state, reason_code, decision, reason_enum,
          priority, occurred_at, scheduled_for, started_at, prepared_at, handoff_accepted_at, event_at,
          title_ref, text_ref, text_withheld, options, sources, content_digest, batch_id, received_at,
          gmail_message_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (owner_id, agent_id, kind, natural_key) DO NOTHING`,
      );
      const existingDigest = this.database.prepare(
        `SELECT content_digest AS digest FROM muse_intake_items
         WHERE owner_id = ? AND agent_id = ? AND kind = ? AND natural_key = ?`,
      );
      const fillGmailMessage = this.database.prepare(
        `UPDATE muse_intake_items SET gmail_message_id = ?
         WHERE owner_id = ? AND agent_id = ? AND kind = ? AND natural_key = ?
           AND gmail_message_id IS NULL`,
      );
      const fillPairedMessage = this.database.prepare(
        `UPDATE muse_reference_entries SET paired_message_id = ?
         WHERE owner_id = ? AND agent_id = ? AND intake_item_key = ? AND paired_message_id IS NULL`,
      );
      const noteConflict = this.database.prepare(
        `INSERT INTO muse_intake_conflicts (
          owner_id, agent_id, kind, natural_key, conflict_count, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT (owner_id, agent_id, kind, natural_key)
        DO UPDATE SET conflict_count = conflict_count + 1, last_seen_at = excluded.last_seen_at`,
      );
      for (const item of write.items) {
        const result = insertItem.run(
          write.ownerId,
          write.agentId,
          item.kind,
          item.naturalKey,
          item.state,
          item.reasonCode,
          item.decision,
          item.reasonEnum,
          item.priority,
          item.occurredAt,
          item.scheduledFor,
          item.startedAt,
          item.preparedAt,
          item.handoffAcceptedAt,
          item.eventAt,
          item.titleRef,
          item.textRef,
          item.textWithheld ? 1 : 0,
          JSON.stringify(item.options),
          JSON.stringify(item.sources),
          item.contentDigest,
          write.batchId,
          write.receivedAt,
          item.gmailMessageId,
        );
        if (result.changes === 1) {
          accepted += 1;
          continue;
        }
        unused.push(...refsOf([item]));
        const stored = existingDigest.get(
          write.ownerId,
          write.agentId,
          item.kind,
          item.naturalKey,
        ) as { digest: string } | undefined;
        if (stored?.digest === item.contentDigest) {
          duplicate += 1;
          if (item.gmailMessageId !== null) {
            const filled = fillGmailMessage.run(
              item.gmailMessageId,
              write.ownerId,
              write.agentId,
              item.kind,
              item.naturalKey,
            );
            if (filled.changes === 1)
              fillPairedMessage.run(
                item.gmailMessageId,
                write.ownerId,
                write.agentId,
                museIntakeItemKey(item.kind, item.naturalKey),
              );
          }
        } else {
          conflict += 1;
          noteConflict.run(
            write.ownerId,
            write.agentId,
            item.kind,
            item.naturalKey,
            write.receivedAt,
            write.receivedAt,
          );
        }
      }
      this.database
        .prepare(
          `UPDATE muse_intake_batches SET accepted_count = ?, duplicate_count = ?, conflict_count = ?
           WHERE id = ?`,
        )
        .run(accepted, duplicate, conflict, write.batchId);
      const gap = write.batchSeq > lastSeq + 1 && channel !== undefined && lastSeq > 0;
      const nextSeq = Math.max(lastSeq, write.batchSeq);
      this.database
        .prepare(
          `INSERT INTO muse_intake_channel (
            owner_id, agent_id, last_batch_at, last_seq, gap_count, paused,
            outage_started_at, outage_notified_at
          ) VALUES (?, ?, ?, ?, ?, 0, NULL, NULL)
          ON CONFLICT (owner_id, agent_id) DO UPDATE SET
            last_batch_at = excluded.last_batch_at,
            last_seq = excluded.last_seq,
            gap_count = muse_intake_channel.gap_count + ?,
            outage_started_at = NULL,
            outage_notified_at = NULL`,
        )
        .run(write.ownerId, write.agentId, write.receivedAt, nextSeq, 0, gap ? 1 : 0);
      return {
        status: "accepted",
        accepted,
        duplicate,
        conflict,
        gap,
        expectedNextSeq: nextSeq + 1,
        unusedRefs: unused,
      };
    })();
  }

  private listItems(input: Input<"listItems">): readonly MuseIntakeItem[] {
    if (!validTime(input.since)) this.fail("PORT_INVALID_OPERATION", "Muse intake time is invalid");
    if (!Number.isSafeInteger(input.limit) || input.limit < 0 || input.limit > 5000)
      this.fail("PORT_INVALID_OPERATION", "Muse intake limit is invalid");
    return this.database
      .prepare(
        `SELECT i.kind, i.natural_key AS naturalKey, i.state, i.reason_code AS reasonCode,
           i.decision, i.reason_enum AS reasonEnum, i.priority, i.occurred_at AS occurredAt,
           i.scheduled_for AS scheduledFor, i.event_at AS eventAt, i.title_ref AS titleRef, i.text_ref AS textRef,
           i.text_withheld AS textWithheld, i.options, i.gmail_message_id AS gmailMessageId,
           i.sources, i.received_at AS receivedAt,
           e.timing_ok AS timingOk, e.content_ok AS contentOk, e.recorded_at AS ratedAt
         FROM muse_intake_items i
         LEFT JOIN muse_reference_entries e
           ON e.owner_id = i.owner_id AND e.agent_id = i.agent_id
          AND e.intake_item_key = i.kind || ':' || i.natural_key
         WHERE i.owner_id = ? AND i.agent_id = ? AND i.occurred_at >= ?
           AND (? = 0 OR e.id IS NULL)
         ORDER BY i.occurred_at DESC, i.natural_key DESC LIMIT ?`,
      )
      .all(input.ownerId, input.agentId, input.since, input.unratedOnly ? 1 : 0, input.limit)
      .map((row) => {
        const entry = row as Record<string, unknown>;
        return Object.freeze({
          ...(entry as unknown as MuseIntakeItem),
          intakeItemKey: museIntakeItemKey(
            entry["kind"] as MuseIntakeItem["kind"],
            entry["naturalKey"] as string,
          ),
          textWithheld: entry["textWithheld"] === 1,
          options: Object.freeze(JSON.parse(entry["options"] as string) as string[]),
          sources: Object.freeze(
            JSON.parse(entry["sources"] as string) as MuseIntakeItem["sources"],
          ),
          timingOk: entry["timingOk"] === null ? null : entry["timingOk"] === 1,
          contentOk: entry["contentOk"] === null ? null : entry["contentOk"] === 1,
        });
      });
  }

  private statusFrom(row: Record<string, unknown> | undefined, now: string): MuseChannelStatus {
    if (!row)
      return {
        state: "never",
        lastBatchAt: null,
        lastSeq: 0,
        gapCount: 0,
        paused: false,
        outageStartedAt: null,
        outageNotifiedAt: null,
      };
    const paused = row["paused"] === 1;
    const lastBatchAt = row["lastBatchAt"] as string | null;
    let state: MuseChannelState = "never";
    if (paused) state = "paused";
    else if (lastBatchAt !== null) {
      const elapsed = Date.parse(now) - Date.parse(lastBatchAt);
      state =
        elapsed >= MUSE_CHANNEL_DOWN_MS
          ? "down"
          : elapsed >= MUSE_CHANNEL_STALE_MS
            ? "stale"
            : "ok";
    }
    return {
      state,
      lastBatchAt,
      lastSeq: row["lastSeq"] as number,
      gapCount: row["gapCount"] as number,
      paused,
      outageStartedAt: row["outageStartedAt"] as string | null,
      outageNotifiedAt: row["outageNotifiedAt"] as string | null,
    };
  }

  private channelStatus(input: Input<"channelStatus">): MuseChannelStatus {
    if (!validTime(input.now)) this.fail("PORT_INVALID_OPERATION", "Muse intake time is invalid");
    return this.statusFrom(this.readChannel(input.ownerId, input.agentId), input.now);
  }

  private checkChannel(input: Input<"checkChannel">): MuseChannelStatus & { notify: boolean } {
    if (!validTime(input.now)) this.fail("PORT_INVALID_OPERATION", "Muse intake time is invalid");
    return this.database.transaction(() => {
      const row = this.readChannel(input.ownerId, input.agentId);
      const status = this.statusFrom(row, input.now);
      if (status.state !== "down" || status.outageNotifiedAt !== null || !status.lastBatchAt)
        return { ...status, notify: false };
      const outageStartedAt = new Date(
        Date.parse(status.lastBatchAt) + MUSE_CHANNEL_STALE_MS,
      ).toISOString();
      this.database
        .prepare(
          `UPDATE muse_intake_channel SET outage_started_at = ?, outage_notified_at = ?
           WHERE owner_id = ? AND agent_id = ? AND outage_notified_at IS NULL`,
        )
        .run(outageStartedAt, input.now, input.ownerId, input.agentId);
      return {
        ...status,
        outageStartedAt,
        outageNotifiedAt: input.now,
        notify: true,
      };
    })();
  }

  private setPaused(input: Input<"setPaused">): void {
    if (typeof input.paused !== "boolean")
      this.fail("PORT_INVALID_OPERATION", "Muse intake pause flag is invalid");
    this.database
      .prepare(
        `INSERT INTO muse_intake_channel (
          owner_id, agent_id, last_batch_at, last_seq, gap_count, paused,
          outage_started_at, outage_notified_at
        ) VALUES (?, ?, NULL, 0, 0, ?, NULL, NULL)
        ON CONFLICT (owner_id, agent_id) DO UPDATE SET
          paused = excluded.paused, outage_started_at = NULL, outage_notified_at = NULL`,
      )
      .run(input.ownerId, input.agentId, input.paused ? 1 : 0);
  }

  private rate(input: Input<"rate">): boolean {
    this.assertDiskHeadroom();
    const cleared = input.timingOk === null && input.contentOk === null;
    const rated = typeof input.timingOk === "boolean" && typeof input.contentOk === "boolean";
    if (
      !(MUSE_INTAKE_KINDS as readonly string[]).includes(input.kind) ||
      !text(input.naturalKey, 1, 150) ||
      !text(input.entryId, 1, 128) ||
      !validTime(input.now) ||
      (!cleared && !rated)
    )
      this.fail("PORT_INVALID_OPERATION", "Muse intake rating is invalid");
    return this.database.transaction(() => {
      const item = this.database
        .prepare(
          `SELECT occurred_at AS occurredAt, gmail_message_id AS gmailMessageId FROM muse_intake_items
           WHERE owner_id = ? AND agent_id = ? AND kind = ? AND natural_key = ?`,
        )
        .get(input.ownerId, input.agentId, input.kind, input.naturalKey) as
        | { occurredAt: string; gmailMessageId: string | null }
        | undefined;
      if (!item) return false;
      const key = museIntakeItemKey(input.kind, input.naturalKey);
      this.database
        .prepare(
          `DELETE FROM muse_reference_entries
           WHERE owner_id = ? AND agent_id = ? AND intake_item_key = ?`,
        )
        .run(input.ownerId, input.agentId, key);
      if (rated)
        this.database
          .prepare(
            `INSERT INTO muse_reference_entries (
              id, owner_id, agent_id, muse_at, muse_reminded, timing_ok, content_ok, content_ref,
              note_ref, paired_decision_id, intake_item_key, paired_message_id, recorded_at
            ) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
          )
          .run(
            input.entryId,
            input.ownerId,
            input.agentId,
            item.occurredAt,
            input.timingOk ? 1 : 0,
            input.contentOk ? 1 : 0,
            key,
            item.gmailMessageId,
            input.now,
          );
      return true;
    })();
  }

  private clearAll(input: Input<"clearAll">): { refs: readonly string[] } {
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `SELECT title_ref AS titleRef, text_ref AS textRef FROM muse_intake_items
           WHERE owner_id = ? AND agent_id = ?`,
        )
        .all(input.ownerId, input.agentId) as {
        titleRef: string | null;
        textRef: string | null;
      }[];
      this.database
        .prepare(
          `DELETE FROM muse_reference_entries
           WHERE owner_id = ? AND agent_id = ? AND intake_item_key IS NOT NULL`,
        )
        .run(input.ownerId, input.agentId);
      this.database
        .prepare("DELETE FROM muse_intake_items WHERE owner_id = ? AND agent_id = ?")
        .run(input.ownerId, input.agentId);
      this.database
        .prepare("DELETE FROM muse_intake_conflicts WHERE owner_id = ? AND agent_id = ?")
        .run(input.ownerId, input.agentId);
      this.database
        .prepare("DELETE FROM muse_intake_batches WHERE owner_id = ? AND agent_id = ?")
        .run(input.ownerId, input.agentId);
      this.database
        .prepare(
          `UPDATE muse_intake_channel SET last_batch_at = NULL, last_seq = 0, gap_count = 0,
             outage_started_at = NULL, outage_notified_at = NULL
           WHERE owner_id = ? AND agent_id = ?`,
        )
        .run(input.ownerId, input.agentId);
      return {
        refs: rows
          .flatMap((row) => [row.titleRef, row.textRef])
          .filter((ref): ref is string => !!ref),
      };
    })();
  }
}
