import { createHash, timingSafeEqual } from "node:crypto";
import {
  type ClockPort,
  type IdGeneratorPort,
  MUSE_INTAKE_SENDER,
  MUSE_INTAKE_SOURCES,
  type MuseIntakeItemWrite,
  type MuseIntakeKind,
  type MuseIntakePort,
  type MuseIntakeSource,
  type ProactiveScope,
  type ProactiveSealPort,
  scanMachineSecrets,
} from "@himawari-agent/application";
import type { FastifyInstance } from "fastify";
import { containsRestrictedIdentifier } from "./production-memory-capture.js";
import type { MuseChannelPushSource } from "./production-web-push.js";

export const MUSE_INTAKE_PATH = "/api/muse-intake/v1/batch";
export const MUSE_INTAKE_BODY_LIMIT = 262_144;
export const MUSE_INTAKE_MAX_ITEMS = 100;
export const MUSE_INTAKE_MAX_TITLE = 300;
export const MUSE_INTAKE_MAX_TEXT = 8_000;
const AUTHORIZED_PER_MINUTE = 30;
const UNAUTHORIZED_PER_MINUTE = 60;
const WINDOW_MS = 60_000;

const ENVELOPE_KEYS = ["sender_id", "batch_seq", "sent_at_utc", "cursor", "items"];
const PROACTIVE_KEYS = [
  "type",
  "submission_id",
  "edition_id",
  "item_id",
  "item_title",
  "queue_state",
  "reason_code",
  "decision",
  "reason_enum",
  "priority",
  "prepared_at_utc",
  "handoff_accepted_at_utc",
  "outcome_recorded_at_utc",
  "event_received_at_utc",
  "options_offered",
  "delivered_text",
  "muse_feedback_kind",
];
const SCHEDULED_KEYS = [
  "type",
  "run_id",
  "job_id",
  "item_title",
  "trigger_reason",
  "scheduled_for_utc",
  "started_at_utc",
  "finished_at_utc",
  "status",
  "attempt",
  "delivered_text",
];
const FIELD_KEYS = ["value", "source", "provenance", "note"];
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/u;
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u;

type Json = Record<string, unknown>;

interface Field {
  readonly value: unknown;
  readonly source: MuseIntakeSource;
}

export interface MuseItemDraft {
  readonly write: Omit<MuseIntakeItemWrite, "titleRef" | "textRef" | "textWithheld">;
  readonly title: string | null;
  readonly text: string | null;
}

export interface MuseBatchDraft {
  readonly batchSeq: number;
  readonly sentAt: string;
  readonly rejectedCount: number;
  readonly droppedFieldCount: number;
  readonly drafts: readonly MuseItemDraft[];
}

export type MuseBatchParse =
  | { readonly ok: true; readonly batch: MuseBatchDraft }
  | { readonly ok: false; readonly field: string };

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedTime(value: unknown): string | null {
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

class ItemReader {
  dropped = 0;
  private readonly raw: Json;
  readonly sources: Record<string, MuseIntakeSource> = {};

  constructor(raw: Json, allowed: readonly string[]) {
    this.raw = raw;
    for (const key of Object.keys(raw)) if (!allowed.includes(key)) this.dropped += 1;
  }

  field(key: string): Field | null | "invalid" {
    const raw = this.raw[key];
    if (raw === undefined || raw === null) return null;
    if (isRecord(raw) && "value" in raw) {
      for (const inner of Object.keys(raw)) if (!FIELD_KEYS.includes(inner)) this.dropped += 1;
      if (raw["value"] === null || raw["value"] === undefined) return null;
      const source = raw["source"] ?? raw["provenance"] ?? "unknown";
      if (
        typeof source !== "string" ||
        !(MUSE_INTAKE_SOURCES as readonly string[]).includes(source)
      )
        return "invalid";
      return { value: raw["value"], source: source as MuseIntakeSource };
    }
    return { value: raw, source: "unknown" };
  }

  record(column: string, field: Field | null): void {
    if (field) this.sources[column] = field.source;
  }
}

function text(
  reader: ItemReader,
  key: string,
  column: string,
  pattern: RegExp | null,
  max: number,
): string | null | "invalid" {
  const field = reader.field(key);
  if (field === "invalid") return "invalid";
  if (field === null) return null;
  if (
    typeof field.value !== "string" ||
    field.value.length < 1 ||
    field.value.length > max ||
    (pattern !== null && !pattern.test(field.value))
  )
    return "invalid";
  reader.record(column, field);
  return field.value;
}

function time(reader: ItemReader, key: string, column: string): string | null | "invalid" {
  const field = reader.field(key);
  if (field === "invalid") return "invalid";
  if (field === null) return null;
  const parsed = normalizedTime(field.value);
  if (parsed === null) return "invalid";
  reader.record(column, field);
  return parsed;
}

function choice<T extends string>(
  reader: ItemReader,
  key: string,
  column: string,
  allowed: readonly T[],
): T | null | "invalid" {
  const field = reader.field(key);
  if (field === "invalid") return "invalid";
  if (field === null) return null;
  if (typeof field.value !== "string" || !(allowed as readonly string[]).includes(field.value))
    return "invalid";
  reader.record(column, field);
  return field.value as T;
}

function options(reader: ItemReader): readonly string[] | "invalid" {
  const field = reader.field("options_offered");
  if (field === "invalid") return "invalid";
  if (field === null) return [];
  if (
    !Array.isArray(field.value) ||
    field.value.length > 12 ||
    !field.value.every(
      (entry) => typeof entry === "string" && entry.length >= 1 && entry.length <= 80,
    )
  )
    return "invalid";
  reader.record("options", field);
  return field.value as string[];
}

function digestOf(kind: MuseIntakeKind, parts: Json, title: string | null, body: string | null) {
  return sha256(
    JSON.stringify({
      kind,
      ...parts,
      title: title === null ? null : sha256(title),
      text: body === null ? null : sha256(body),
    }),
  );
}

function anyInvalid(values: readonly unknown[]): boolean {
  return values.includes("invalid");
}

function parseProactive(raw: Json, reader: ItemReader): MuseItemDraft | null {
  const submissionId = text(reader, "submission_id", "natural_key", KEY_PATTERN, 128);
  const title = text(reader, "item_title", "title", null, MUSE_INTAKE_MAX_TITLE);
  const state = choice(reader, "queue_state", "queue_state", ["delivered", "suppressed"] as const);
  const reasonCode = text(reader, "reason_code", "reason_code", CODE_PATTERN, 64);
  const decision = choice(reader, "decision", "decision", ["send", "skip", "defer"] as const);
  const reasonEnum = text(reader, "reason_enum", "reason_enum", CODE_PATTERN, 64);
  const priority = choice(reader, "priority", "priority", ["regular", "high"] as const);
  const preparedAt = time(reader, "prepared_at_utc", "prepared_at");
  const handoffAt = time(reader, "handoff_accepted_at_utc", "handoff_accepted_at");
  const occurredAt = time(reader, "outcome_recorded_at_utc", "occurred_at");
  const eventAt = time(reader, "event_received_at_utc", "event_at");
  const offered = options(reader);
  const body = text(reader, "delivered_text", "text", null, MUSE_INTAKE_MAX_TEXT);
  if (
    anyInvalid([
      submissionId,
      title,
      state,
      reasonCode,
      decision,
      reasonEnum,
      priority,
      preparedAt,
      handoffAt,
      occurredAt,
      eventAt,
      offered,
      body,
    ]) ||
    submissionId === null ||
    state === null ||
    occurredAt === null ||
    (state === "suppressed" && reasonCode === null)
  )
    return null;
  const safe = (value: string | null | "invalid") => value as string | null;
  const parts = {
    naturalKey: submissionId,
    state,
    reasonCode: safe(reasonCode),
    decision: decision as string | null,
    reasonEnum: safe(reasonEnum),
    priority: priority as string | null,
    occurredAt,
    preparedAt: safe(preparedAt),
    handoffAt: safe(handoffAt),
    eventAt: safe(eventAt),
    options: offered as readonly string[],
    sources: reader.sources,
    editionId: typeof raw["edition_id"] === "string" ? raw["edition_id"] : null,
  };
  return {
    title: safe(title),
    text: safe(body),
    write: {
      kind: "proactive",
      naturalKey: submissionId,
      state: state as MuseIntakeItemWrite["state"],
      reasonCode: safe(reasonCode),
      decision: decision as MuseIntakeItemWrite["decision"],
      reasonEnum: safe(reasonEnum),
      priority: priority as MuseIntakeItemWrite["priority"],
      occurredAt,
      scheduledFor: null,
      startedAt: null,
      preparedAt: safe(preparedAt),
      handoffAcceptedAt: safe(handoffAt),
      eventAt: safe(eventAt),
      options: offered as readonly string[],
      sources: reader.sources,
      contentDigest: digestOf("proactive", parts, safe(title), safe(body)),
    },
  };
}

function parseScheduled(reader: ItemReader): MuseItemDraft | null {
  const runId = text(reader, "run_id", "natural_key", KEY_PATTERN, 128);
  const jobId = text(reader, "job_id", "title", null, MUSE_INTAKE_MAX_TITLE);
  const title = text(reader, "item_title", "title", null, MUSE_INTAKE_MAX_TITLE);
  const trigger = text(reader, "trigger_reason", "reason_code", CODE_PATTERN, 64);
  const scheduledFor = time(reader, "scheduled_for_utc", "scheduled_for");
  const startedAt = time(reader, "started_at_utc", "started_at");
  const finishedAt = time(reader, "finished_at_utc", "occurred_at");
  const state = choice(reader, "status", "queue_state", ["succeeded", "failed"] as const);
  const body = text(reader, "delivered_text", "text", null, MUSE_INTAKE_MAX_TEXT);
  if (
    anyInvalid([runId, jobId, title, trigger, scheduledFor, startedAt, finishedAt, state, body]) ||
    runId === null ||
    state === null ||
    finishedAt === null
  )
    return null;
  const safe = (value: string | null | "invalid") => value as string | null;
  const shownTitle = safe(title) ?? safe(jobId);
  const parts = {
    naturalKey: runId,
    state,
    reasonCode: safe(trigger),
    occurredAt: finishedAt,
    scheduledFor: safe(scheduledFor),
    startedAt: safe(startedAt),
    sources: reader.sources,
  };
  return {
    title: shownTitle,
    text: safe(body),
    write: {
      kind: "scheduled",
      naturalKey: runId,
      state: state as MuseIntakeItemWrite["state"],
      reasonCode: safe(trigger),
      decision: null,
      reasonEnum: null,
      priority: null,
      occurredAt: finishedAt,
      scheduledFor: safe(scheduledFor),
      startedAt: safe(startedAt),
      preparedAt: null,
      handoffAcceptedAt: null,
      eventAt: null,
      options: [],
      sources: reader.sources,
      contentDigest: digestOf("scheduled", parts, shownTitle, safe(body)),
    },
  };
}

export function parseMuseBatch(body: unknown): MuseBatchParse {
  if (!isRecord(body)) return { ok: false, field: "body" };
  if (body["sender_id"] !== MUSE_INTAKE_SENDER) return { ok: false, field: "sender_id" };
  const seq = body["batch_seq"];
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1)
    return { ok: false, field: "batch_seq" };
  const sentAt = normalizedTime(body["sent_at_utc"]);
  if (sentAt === null) return { ok: false, field: "sent_at_utc" };
  const items = body["items"];
  if (!Array.isArray(items) || items.length > MUSE_INTAKE_MAX_ITEMS)
    return { ok: false, field: "items" };
  let dropped = Object.keys(body).filter((key) => !ENVELOPE_KEYS.includes(key)).length;
  let rejected = 0;
  const drafts: MuseItemDraft[] = [];
  for (const raw of items) {
    if (!isRecord(raw)) {
      rejected += 1;
      continue;
    }
    const type = raw["type"];
    const proactive = type === "muse_proactive_item";
    if (!proactive && type !== "muse_scheduled_run") {
      rejected += 1;
      continue;
    }
    const reader = new ItemReader(raw, proactive ? PROACTIVE_KEYS : SCHEDULED_KEYS);
    const draft = proactive ? parseProactive(raw, reader) : parseScheduled(reader);
    dropped += reader.dropped;
    if (draft) drafts.push(draft);
    else rejected += 1;
  }
  return {
    ok: true,
    batch: {
      batchSeq: seq,
      sentAt,
      rejectedCount: rejected,
      droppedFieldCount: dropped,
      drafts,
    },
  };
}

function storable(value: string | null): boolean {
  return (
    value === null ||
    (value.trim().length > 0 &&
      scanMachineSecrets(value).length === 0 &&
      !containsRestrictedIdentifier(value))
  );
}

export interface MuseIntakeHttpResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export class ProductionMuseIntake {
  private readonly scope: ProactiveScope;
  private readonly store: MuseIntakePort;
  private readonly seal: ProactiveSealPort;
  private readonly ids: IdGeneratorPort;
  private readonly clock: ClockPort;
  private readonly secretDigest: Buffer;
  private readonly authorized: number[] = [];
  private readonly unauthorized: number[] = [];

  constructor(options: {
    readonly scope: ProactiveScope;
    readonly store: MuseIntakePort;
    readonly seal: ProactiveSealPort;
    readonly ids: IdGeneratorPort;
    readonly clock: ClockPort;
    readonly secret: string;
  }) {
    if (options.secret.length < 32) throw new Error("MUSE_INTAKE_SECRET_TOO_SHORT");
    this.scope = options.scope;
    this.store = options.store;
    this.seal = options.seal;
    this.ids = options.ids;
    this.clock = options.clock;
    this.secretDigest = createHash("sha256").update(options.secret).digest();
  }

  admit(authorization: string | undefined): "ok" | "unauthorized" | "rate_limited" {
    const now = Date.parse(this.clock.now());
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const matches = timingSafeEqual(
      createHash("sha256").update(bearer).digest(),
      this.secretDigest,
    );
    const window = matches ? this.authorized : this.unauthorized;
    while (window.length > 0 && now - (window[0] as number) >= WINDOW_MS) window.shift();
    if (window.length >= (matches ? AUTHORIZED_PER_MINUTE : UNAUTHORIZED_PER_MINUTE))
      return "rate_limited";
    window.push(now);
    return matches ? "ok" : "unauthorized";
  }

  async ingest(body: unknown): Promise<MuseIntakeHttpResult> {
    const parsed = parseMuseBatch(body);
    if (!parsed.ok) return { status: 400, body: { error: "batch_invalid", field: parsed.field } };
    const { batch } = parsed;
    const receivedAt = this.clock.now();
    const sealed: string[] = [];
    try {
      const items: MuseIntakeItemWrite[] = [];
      for (const draft of batch.drafts) {
        const keep =
          storable(draft.title) &&
          storable(draft.text) &&
          draft.write.options.every((option) => storable(option));
        const seal = async (value: string | null) => {
          if (value === null || !keep) return null;
          const ref = await this.seal.seal({ ...this.scope, text: value, at: receivedAt });
          sealed.push(ref);
          return ref;
        };
        items.push({
          ...draft.write,
          options: keep ? draft.write.options : [],
          titleRef: await seal(draft.title),
          textRef: await seal(draft.text),
          textWithheld: !keep,
        });
      }
      const outcome = await this.store.ingestBatch({
        ...this.scope,
        batchId: this.ids.next("muse-intake-batch"),
        senderId: MUSE_INTAKE_SENDER,
        batchSeq: batch.batchSeq,
        sentAt: batch.sentAt,
        receivedAt,
        rejectedCount: batch.rejectedCount,
        droppedFieldCount: batch.droppedFieldCount,
        items,
      });
      if (outcome.unusedRefs.length > 0)
        await this.seal.release({ ...this.scope, refs: outcome.unusedRefs });
      if (outcome.status === "paused")
        return {
          status: 423,
          body: { error: "paused", expected_next_seq: outcome.expectedNextSeq },
        };
      if (outcome.status === "replay")
        return {
          status: 200,
          body: { replayed: true, expected_next_seq: outcome.expectedNextSeq },
        };
      return {
        status: 200,
        body: {
          accepted: outcome.accepted,
          duplicate: outcome.duplicate,
          conflict: outcome.conflict,
          rejected: batch.rejectedCount,
          expected_next_seq: outcome.expectedNextSeq,
        },
      };
    } catch (error) {
      if (sealed.length > 0)
        await this.seal.release({ ...this.scope, refs: sealed }).catch(() => undefined);
      throw error;
    }
  }
}

const MUSE_OUTAGE_PUSH_WINDOW_MS = 12 * 3_600_000;

export function createMuseChannelPushSource(options: {
  readonly scope: ProactiveScope;
  readonly store: MuseIntakePort;
}): MuseChannelPushSource {
  const { scope, store } = options;
  return Object.freeze<MuseChannelPushSource>({
    async listActive(now) {
      await store.checkChannel({ ...scope, now });
      const status = await store.channelStatus({ ...scope, now });
      if (
        status.state !== "down" ||
        status.outageStartedAt === null ||
        status.outageNotifiedAt === null ||
        Date.parse(now) - Date.parse(status.outageNotifiedAt) >= MUSE_OUTAGE_PUSH_WINDOW_MS
      )
        return [];
      return [{ outageStartedAt: status.outageStartedAt }];
    },
  });
}

export function registerMuseIntakeRoute(app: FastifyInstance, intake: ProductionMuseIntake): void {
  void app.register(async (scope) => {
    scope.setErrorHandler((error, _request, reply) => {
      const status =
        typeof error === "object" && error !== null && "statusCode" in error
          ? (error.statusCode as number)
          : 500;
      const known = status === 400 || status === 413 || status === 415;
      return reply
        .code(known ? status : 500)
        .header("cache-control", "no-store")
        .send({ error: known ? "request_invalid" : "failed" });
    });
    scope.post(
      MUSE_INTAKE_PATH,
      {
        bodyLimit: MUSE_INTAKE_BODY_LIMIT,
        onRequest: async (request, reply) => {
          const gate = intake.admit(request.headers.authorization);
          if (gate === "ok") {
            const type = request.headers["content-type"] ?? "";
            if (/^application\/json(\s*;|$)/iu.test(type)) return;
            return reply.code(415).header("cache-control", "no-store").send();
          }
          return reply
            .code(gate === "unauthorized" ? 401 : 429)
            .header("cache-control", "no-store")
            .send();
        },
      },
      async (request, reply) => {
        const result = await intake.ingest(request.body);
        return reply.code(result.status).header("cache-control", "no-store").send(result.body);
      },
    );
  });
}
