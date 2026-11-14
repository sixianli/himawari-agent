import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import {
  DEVICE_MIRROR_EXTERNAL_ID_MAXIMUM,
  DEVICE_MIRROR_KIND_NAMES,
  DEVICE_MIRROR_KINDS,
  DEVICE_MIRROR_SYNC_ID_PATTERN,
  type DecisionLedgerWrite,
  type DeviceConfiguration,
  type DeviceMirrorItemInput,
  type DeviceMirrorKind,
  type GatewayAuthenticationContext,
  isOwnerSpoken,
  isUsageLimitKey,
  isVoiceScore,
  LIMIT_CHANGE_REASON_CODE,
  ownerDayBounds,
  ownerLocalDay,
  PERCEPTION_CAPTURE_SOURCES,
  PERCEPTION_CONFIDENCE_MAXIMUM,
  PERCEPTION_CONFIGURATION_RANGES,
  PERCEPTION_DEVICE_TIME_MAXIMUM,
  PERCEPTION_EPISODE_ANCHOR_TYPES,
  PERCEPTION_EPISODE_BOUNDARY_TYPES,
  PERCEPTION_MEDIA_KINDS,
  PERCEPTION_RECORD_ID_PATTERN,
  PERCEPTION_RECORD_TYPE_NAMES,
  PERCEPTION_RECORD_TYPES,
  PERCEPTION_RETENTION_CONFIGURATION,
  PERCEPTION_RETENTION_KEYS,
  PERCEPTION_SENSES,
  PERCEPTION_SPEAKER_KINDS,
  PERCEPTION_TEXT_MAXIMUM,
  PERCEPTION_UTTERANCE_ID_PATTERN,
  type PerceptionCaptureSource,
  type PerceptionConfiguration,
  type PerceptionDayPage,
  type PerceptionIngestOutcome,
  type PerceptionMediaKind,
  type PerceptionRecordInput,
  type PerceptionRecordType,
  type PerceptionRetentionKey,
  type PerceptionScope,
  type PerceptionSense,
  type PerceptionSettings,
  type PerceptionSpeakerKind,
  type PerceptionStorePort,
  perceptionTypesOfSense,
  resolvePerceptionOrigin,
  type TrackPointInput,
  UPLOAD_BATCH_ID_PATTERN,
  UPLOAD_GRANT_PURPOSES,
  type UploadGrant,
  type UploadGrantPurpose,
  USAGE_LIMIT_KEYS,
  USAGE_LIMITS,
  type UsageLimitKey,
  type UsageLimitView,
  usageLimitState,
  type VoiceGates,
  validatePerceptionFields,
} from "@himawari-agent/application";
import { PAIRED_DEVICE_ERROR_CODES, PairedDeviceError } from "./paired-device-service.js";

export type PerceptionOutcome = PerceptionIngestOutcome | "sense_off" | "paused";

export interface PerceptionStatus {
  readonly state: "sensing" | "paused" | "off";
  readonly pausedUntil: string | null;
  readonly senses: readonly PerceptionSense[];
  readonly day: string;
  readonly todayCount: number;
}

export type PerceptionSettingsChange =
  | { readonly kind: "sense"; readonly sense: PerceptionSense; readonly enabled: boolean }
  | { readonly kind: "pause"; readonly until: string }
  | { readonly kind: "resume" }
  | {
      readonly kind: "retention";
      readonly key: PerceptionRetentionKey;
      readonly days: number | null;
    }
  | { readonly kind: "limit"; readonly key: string; readonly value: number | null };

export interface PerceptionLimitWarning {
  readonly event: "perception.limit_near" | "perception.limit_reached";
  readonly key: string;
  readonly used: number;
  readonly limit: number;
}

export interface PerceptionServiceOptions {
  readonly store: PerceptionStorePort;
  readonly deviceConfiguration: () => DeviceConfiguration;
  readonly configuration: () => PerceptionConfiguration;
  readonly timeZone: () => string;
  readonly protectText: (input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly idempotencyKey: string;
    readonly content: string;
    readonly dataClassification: "public" | "private" | "sensitive" | "restricted";
  }) => Promise<string>;
  readonly uploadDirectory: string;
  readonly voiceGates?: () => VoiceGates;
  readonly searchIndex?: {
    readonly document: (scope: PerceptionScope, text: string) => Promise<readonly string[]>;
    readonly query: (scope: PerceptionScope, text: string) => Promise<readonly string[]>;
  };
  readonly proactiveUsage?: {
    readonly limit: () => number;
    readonly usedSince: (scope: PerceptionScope, since: string) => Promise<number>;
  };
  readonly onLimitWarning?: (warning: PerceptionLimitWarning) => void;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Buffer;
}

export interface ReceivedUpload {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly gzip: boolean;
}

export interface AuthorizedUpload {
  readonly grant: UploadGrant;
  readonly replay: Readonly<Record<string, unknown>> | null;
}

const DEVICE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const RECORD_KEYS = [
  "id",
  "type",
  "captureSource",
  "occurredAt",
  "confidence",
  "text",
  "speaker",
  "evidence",
];
const POINT_KEYS = [
  "occurredAt",
  "latitude",
  "longitude",
  "accuracyMeters",
  "speedMetersPerSecond",
];

function invalid(reason: string): never {
  throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.REQUEST_INVALID, 400, { reason });
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface ParsedRecord {
  readonly sense: PerceptionSense;
  readonly text: string | null;
  readonly input: Omit<PerceptionRecordInput, "contentRef">;
}

export class PerceptionService {
  readonly #options: PerceptionServiceOptions;
  readonly #consuming = new Set<string>();
  readonly #placing = new Set<string>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #prunedAt = new Map<string, number>();

  constructor(options: PerceptionServiceOptions) {
    this.#options = options;
  }

  #now(): Date {
    return (this.#options.now ?? (() => new Date()))();
  }

  #incoming(): string {
    return path.join(this.#options.uploadDirectory, "incoming");
  }

  #media(): string {
    return path.join(this.#options.uploadDirectory, "media");
  }

  async prepareDirectories(): Promise<void> {
    await mkdir(this.#incoming(), { recursive: true });
    await mkdir(this.#media(), { recursive: true });
    for (const name of await readdir(this.#incoming()))
      await rm(path.join(this.#incoming(), name), { force: true });
  }

  temporaryUploadPath(): string {
    return path.join(
      this.#incoming(),
      (this.#options.randomBytes ?? randomBytes)(16).toString("hex"),
    );
  }

  settings(scope: PerceptionScope): Promise<PerceptionSettings> {
    return this.#options.store.readSettings(this.#scope(scope));
  }

  async reserveModelCost(scope: PerceptionScope, amountMicros: number): Promise<boolean> {
    const settings = await this.settings(scope);
    return this.#options.store.reserveUsage({
      ...this.#scope(scope),
      key: "perception.model_cost.daily",
      periodStart: ownerDayBounds(this.#now().toISOString(), this.#options.timeZone()).start,
      amount: amountMicros,
      limit: this.#limit(settings, "perception.model_cost.daily"),
    });
  }

  #scope(scope: PerceptionScope): PerceptionScope {
    return { ownerId: scope.ownerId, agentId: scope.agentId };
  }

  #limit(settings: PerceptionSettings, key: UsageLimitKey): number | null {
    return settings.limitOverrides[key] ?? USAGE_LIMITS[key].defaultLimit;
  }

  #serverLimit(settings: PerceptionSettings, key: UsageLimitKey): number {
    return this.#limit(settings, key) ?? Number.MAX_SAFE_INTEGER;
  }

  retentionDays(settings: PerceptionSettings): Readonly<Record<PerceptionRetentionKey, number>> {
    const configuration = this.#options.configuration();
    return Object.freeze({
      track:
        settings.retentionDays.track ?? configuration[PERCEPTION_RETENTION_CONFIGURATION.track],
      surroundings:
        settings.retentionDays.surroundings ??
        configuration[PERCEPTION_RETENTION_CONFIGURATION.surroundings],
    });
  }

  async status(scope: PerceptionScope): Promise<PerceptionStatus> {
    const now = this.#now();
    const settings = await this.settings(scope);
    const senses = PERCEPTION_SENSES.filter((sense) => !settings.disabledSenses.includes(sense));
    const paused = settings.pausedUntil !== null && settings.pausedUntil > now.toISOString();
    const day = ownerLocalDay(now.getTime(), this.#options.timeZone());
    return Object.freeze({
      state: senses.length === 0 ? "off" : paused ? "paused" : "sensing",
      pausedUntil: paused ? settings.pausedUntil : null,
      senses: Object.freeze(senses),
      day,
      todayCount: await this.#options.store.countDay({ ...this.#scope(scope), day, types: null }),
    });
  }

  async changeSettings(
    scope: PerceptionScope,
    expectedRevision: number,
    change: PerceptionSettingsChange,
  ): Promise<PerceptionSettings> {
    const store = this.#options.store;
    const current = await this.settings(scope);
    const now = this.#now();
    const refuse = (reason: string): never => {
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.SETTINGS_INVALID, 400, { reason });
    };
    let values: Omit<PerceptionSettings, "revision" | "updatedAt"> = {
      disabledSenses: current.disabledSenses,
      pausedFrom: current.pausedFrom,
      pausedUntil: current.pausedUntil,
      retentionDays: current.retentionDays,
      limitOverrides: current.limitOverrides,
    };
    const decisions: DecisionLedgerWrite[] = [];
    switch (change.kind) {
      case "sense": {
        if (!PERCEPTION_SENSES.includes(change.sense)) refuse("sense");
        const disabled = new Set(current.disabledSenses);
        if (change.enabled) disabled.delete(change.sense);
        else disabled.add(change.sense);
        values = {
          ...values,
          disabledSenses: PERCEPTION_SENSES.filter((sense) => disabled.has(sense)),
        };
        break;
      }
      case "pause": {
        const until = Date.parse(change.until);
        const maximum = now.getTime() + this.#options.configuration().pauseMaximumSeconds * 1000;
        if (
          !Number.isFinite(until) ||
          new Date(until).toISOString() !== change.until ||
          until <= now.getTime() ||
          until > maximum
        )
          refuse("pause_until");
        values = { ...values, pausedFrom: now.toISOString(), pausedUntil: change.until };
        break;
      }
      case "resume":
        values = { ...values, pausedFrom: null, pausedUntil: null };
        break;
      case "retention": {
        if (!PERCEPTION_RETENTION_KEYS.includes(change.key)) refuse("retention_key");
        const retention = { ...current.retentionDays };
        if (change.days === null) delete retention[change.key];
        else {
          const [minimum, maximum] =
            PERCEPTION_CONFIGURATION_RANGES[PERCEPTION_RETENTION_CONFIGURATION[change.key]];
          if (!Number.isSafeInteger(change.days) || change.days < minimum || change.days > maximum)
            refuse("retention_days");
          retention[change.key] = change.days;
        }
        values = { ...values, retentionDays: retention };
        break;
      }
      case "limit": {
        if (!isUsageLimitKey(change.key)) return refuse("limit_key");
        const definition = USAGE_LIMITS[change.key];
        if (!definition.adjustable) refuse("limit_fixed");
        if (
          change.value !== null &&
          (!Number.isSafeInteger(change.value) ||
            change.value < definition.minimum ||
            change.value > definition.maximum)
        )
          refuse("limit_value");
        const overrides = { ...current.limitOverrides };
        if (change.value === null) delete overrides[change.key];
        else overrides[change.key] = change.value;
        const from = this.#limit(current, change.key);
        const to = change.value ?? definition.defaultLimit;
        values = { ...values, limitOverrides: overrides };
        if (from !== to)
          decisions.push({
            id: `limit-change:${digest(
              `${scope.ownerId}\n${scope.agentId}\n${change.key}\n${expectedRevision}`,
            ).slice(0, 32)}`,
            ownerId: scope.ownerId,
            agentId: scope.agentId,
            kind: "limit_change",
            decidedAt: now.toISOString(),
            outcome: "changed",
            reasonCode: LIMIT_CHANGE_REASON_CODE,
            subjectRef: `limit:${change.key}`,
            inputs: { memoryIds: [], ruleIds: [], limitChange: { key: change.key, from, to } },
            reasonRef: null,
            contentRef: null,
            costMicros: 0,
            durationMs: 0,
          });
        break;
      }
    }
    return store.writeSettings({
      ...this.#scope(scope),
      expectedRevision,
      now: now.toISOString(),
      values,
      decisions,
    });
  }

  #parseRecord(raw: unknown, now: number, timeZone: string): ParsedRecord {
    const record = plainObject(raw);
    if (!record || !onlyKeys(record, RECORD_KEYS)) return invalid("record_shape");
    const { id, type, captureSource, occurredAt, confidence, text, speaker } = record;
    if (typeof id !== "string" || !PERCEPTION_RECORD_ID_PATTERN.test(id)) return invalid("id");
    if (
      typeof type !== "string" ||
      !(PERCEPTION_RECORD_TYPE_NAMES as readonly string[]).includes(type)
    )
      return invalid("type");
    const definition = PERCEPTION_RECORD_TYPES[type as PerceptionRecordType];
    if (
      typeof captureSource !== "string" ||
      !(PERCEPTION_CAPTURE_SOURCES as readonly string[]).includes(captureSource)
    )
      return invalid("capture_source");
    if (
      typeof occurredAt !== "string" ||
      occurredAt.length > PERCEPTION_DEVICE_TIME_MAXIMUM ||
      !DEVICE_TIME_PATTERN.test(occurredAt)
    )
      return invalid("occurred_at");
    const occurredAtMs = Date.parse(occurredAt);
    const skew = this.#options.deviceConfiguration().signatureToleranceSeconds * 1000;
    if (!Number.isFinite(occurredAtMs) || occurredAtMs < 0 || occurredAtMs > now + skew)
      return invalid("occurred_at");
    if (
      !Number.isSafeInteger(confidence) ||
      (confidence as number) < 0 ||
      (confidence as number) > PERCEPTION_CONFIDENCE_MAXIMUM
    )
      return invalid("confidence");
    if (definition.text === "none" ? text !== undefined : false) return invalid("text");
    if (definition.text === "required" && text === undefined) return invalid("text");
    if (
      text !== undefined &&
      (typeof text !== "string" || text.length === 0 || text.length > PERCEPTION_TEXT_MAXIMUM)
    )
      return invalid("text");
    let speakerKind: PerceptionSpeakerKind | null = null;
    let speakerRef: string | null = null;
    let speakerScore: number | null = null;
    if (speaker !== undefined) {
      const parsed = plainObject(speaker);
      if (
        definition.sense !== "hearing" ||
        !parsed ||
        !onlyKeys(parsed, ["kind", "contactRef", "score"]) ||
        !(PERCEPTION_SPEAKER_KINDS as readonly unknown[]).includes(parsed["kind"]) ||
        (parsed["score"] !== undefined && !isVoiceScore(parsed["score"]))
      )
        return invalid("speaker");
      speakerKind = parsed["kind"] as PerceptionSpeakerKind;
      speakerScore = (parsed["score"] as number | undefined) ?? null;
      const contactRef = parsed["contactRef"];
      if ((contactRef !== undefined) !== (speakerKind === "contact")) return invalid("speaker");
      if (contactRef !== undefined) {
        if (typeof contactRef !== "string" || contactRef.length < 1 || contactRef.length > 128)
          return invalid("speaker");
        speakerRef = contactRef;
      }
    }
    const evidence = validatePerceptionFields(definition.evidence, record["evidence"]);
    if (!evidence) return invalid("evidence");
    const audio = type === "speech.utterance" ? Number(evidence["durationMs"]) : 0;
    return {
      sense: definition.sense,
      text: (text as string | undefined) ?? null,
      input: {
        id,
        type: type as PerceptionRecordType,
        origin: resolvePerceptionOrigin({
          type: type as PerceptionRecordType,
          speakerKind,
          ownerVoiceQualified: isOwnerSpoken(speakerScore, this.#options.voiceGates?.()),
        }),
        captureSource: captureSource as PerceptionCaptureSource,
        occurredAtMs,
        occurredAtDevice: occurredAt,
        localDay: ownerLocalDay(occurredAtMs, timeZone),
        confidence: confidence as number,
        speakerKind,
        speakerRef,
        dataClassification: definition.dataClassification,
        evidence,
        lowValue: definition.lowValue,
        audioMilliseconds: audio,
      },
    };
  }

  async ingest(input: {
    readonly scope: PerceptionScope;
    readonly authentication: GatewayAuthenticationContext;
    readonly deviceId: string;
    readonly records: unknown;
    readonly idRange?: { readonly first: string; readonly last: string };
  }): Promise<{
    readonly outcomes: readonly { readonly id: string; readonly outcome: PerceptionOutcome }[];
    readonly reached: readonly string[];
  }> {
    const scope = this.#scope(input.scope);
    const limits = this.#options.deviceConfiguration().limits;
    if (!Array.isArray(input.records) || input.records.length === 0) return invalid("records");
    if (input.records.length > limits["device.perception.batch_records"])
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.BATCH_TOO_LARGE, 413, {
        limit: limits["device.perception.batch_records"],
        key: "device.perception.batch_records",
      });
    const now = this.#now();
    const timeZone = this.#options.timeZone();
    const parsed = input.records.map((raw) => this.#parseRecord(raw, now.getTime(), timeZone));
    if (new Set(parsed.map((record) => record.input.id)).size !== parsed.length)
      return invalid("duplicate_id");
    if (
      input.idRange &&
      parsed.some(
        ({ input: record }) =>
          record.id < (input.idRange?.first ?? "") || record.id > (input.idRange?.last ?? ""),
      )
    )
      return invalid("id_range");
    const settings = await this.settings(scope);
    const pausedFrom = settings.pausedFrom === null ? null : Date.parse(settings.pausedFrom);
    const pausedUntil = settings.pausedUntil === null ? null : Date.parse(settings.pausedUntil);
    const blocked = new Map<string, PerceptionOutcome>();
    for (const record of parsed) {
      if (settings.disabledSenses.includes(record.sense)) blocked.set(record.input.id, "sense_off");
      else if (
        pausedFrom !== null &&
        pausedUntil !== null &&
        record.input.occurredAtMs >= pausedFrom &&
        record.input.occurredAtMs < pausedUntil
      )
        blocked.set(record.input.id, "paused");
    }
    const candidates = parsed.filter((record) => !blocked.has(record.input.id));
    const known = new Set(
      await this.#options.store.knownRecordIds({
        ...scope,
        ids: candidates.map((record) => record.input.id),
      }),
    );
    const prepared: PerceptionRecordInput[] = [];
    const bounds = ownerDayBounds(now.toISOString(), timeZone);
    const configuration = this.#options.configuration();
    const stored = await this.#exclusive(`ingest:${scope.ownerId}\n${scope.agentId}`, async () => {
      try {
        for (const record of candidates) {
          const contentRef =
            record.text === null || known.has(record.input.id)
              ? null
              : await this.#options.protectText({
                  authentication: input.authentication,
                  idempotencyKey: `perception-content:${digest(record.input.id).slice(0, 40)}`,
                  content: record.text,
                  dataClassification: record.input.dataClassification,
                });
          const searchTerms =
            record.text === null || known.has(record.input.id) || !this.#options.searchIndex
              ? undefined
              : await this.#options.searchIndex.document(scope, record.text).catch(() => undefined);
          prepared.push({
            ...record.input,
            contentRef,
            ...(searchTerms ? { searchTerms } : {}),
          });
        }
        return prepared.length === 0
          ? { outcomes: [], reached: [] }
          : await this.#options.store.ingestRecords({
              ...scope,
              deviceId: input.deviceId,
              now: now.toISOString(),
              periodStart: bounds.start,
              records: prepared,
              recordLimitKey: "perception.records.daily",
              recordLimit: this.#serverLimit(settings, "perception.records.daily"),
              audioLimitKey: "perception.audio.daily",
              audioLimit: this.#serverLimit(settings, "perception.audio.daily"),
              episodeSilenceMs: configuration.episodeSilenceSeconds * 1000,
              episodeMaximumMs: configuration.episodeMaximumSeconds * 1000,
              episodeAnchorTypes: PERCEPTION_EPISODE_ANCHOR_TYPES,
              episodeBoundaryTypes: PERCEPTION_EPISODE_BOUNDARY_TYPES,
            });
      } finally {
        await this.#options.store.releaseContent({
          ...scope,
          refs: prepared.flatMap(({ contentRef }) => (contentRef === null ? [] : [contentRef])),
        });
      }
    });
    const outcome = new Map<string, PerceptionOutcome>([
      ...blocked,
      ...stored.outcomes.map(({ id, outcome: result }) => [id, result] as const),
    ]);
    await this.#afterWrite(scope, settings, bounds.start, [
      "perception.records.daily",
      "perception.audio.daily",
    ]);
    return Object.freeze({
      outcomes: Object.freeze(
        parsed.map(({ input: record }) =>
          Object.freeze({ id: record.id, outcome: outcome.get(record.id) as PerceptionOutcome }),
        ),
      ),
      reached: stored.reached,
    });
  }

  async #afterWrite(
    scope: PerceptionScope,
    settings: PerceptionSettings,
    periodStart: string,
    keys: readonly UsageLimitKey[],
  ): Promise<void> {
    const now = this.#now();
    const configuration = this.#options.configuration();
    const rows = await this.#options.store.readUsage({ ...scope, periodStart });
    for (const key of keys) {
      const limit = this.#limit(settings, key);
      const row = rows.find((item) => item.key === key && item.deviceId === "");
      if (limit === null || !row || row.warnedAt !== null) continue;
      const state = usageLimitState(row.used, limit, configuration.warnPermille);
      if (state === "ok") continue;
      if (
        await this.#options.store.markUsageWarned({
          ...scope,
          key,
          periodStart,
          now: now.toISOString(),
        })
      )
        this.#options.onLimitWarning?.({
          event: state === "stopped" ? "perception.limit_reached" : "perception.limit_near",
          key,
          used: row.used,
          limit,
        });
    }
    const scopeKey = `${scope.ownerId}\n${scope.agentId}`;
    const pruned = this.#prunedAt.get(scopeKey);
    if (pruned !== undefined && now.getTime() - pruned < configuration.pruneIntervalSeconds * 1000)
      return;
    this.#prunedAt.set(scopeKey, now.getTime());
    await this.prune(scope);
  }

  async search(input: {
    readonly scope: PerceptionScope;
    readonly query: string;
    readonly limit: number;
  }) {
    const scope = this.#scope(input.scope);
    const terms = this.#options.searchIndex
      ? await this.#options.searchIndex.query(scope, input.query)
      : [];
    return terms.length === 0
      ? []
      : this.#options.store.searchRecords({ ...scope, terms, limit: input.limit });
  }

  async prune(scope: PerceptionScope) {
    const now = this.#now();
    const settings = await this.settings(scope);
    const retention = this.retentionDays(settings);
    const day = 86_400_000;
    const pruned = await this.#options.store.prune({
      ...this.#scope(scope),
      now: now.toISOString(),
      trackBeforeMs: now.getTime() - retention.track * day,
      surroundingsBeforeMs: now.getTime() - retention.surroundings * day,
      surroundingsTypes: PERCEPTION_RECORD_TYPE_NAMES.filter(
        (type) => PERCEPTION_RECORD_TYPES[type].retention === "surroundings",
      ),
      mediaBefore: new Date(
        now.getTime() - this.#options.configuration().mediaRetentionDays * day,
      ).toISOString(),
    });
    await this.#sweepMedia();
    return pruned;
  }

  async syncMirror(input: {
    readonly scope: PerceptionScope;
    readonly deviceId: string;
    readonly body: Record<string, unknown>;
  }) {
    const { body } = input;
    const limit = this.#options.deviceConfiguration().limits["device.mirror.batch_items"];
    if (
      !onlyKeys(body, ["kind", "mode", "syncId", "final", "items"]) ||
      typeof body["kind"] !== "string" ||
      !(DEVICE_MIRROR_KIND_NAMES as readonly string[]).includes(body["kind"]) ||
      (body["mode"] !== "full" && body["mode"] !== "delta") ||
      typeof body["syncId"] !== "string" ||
      !DEVICE_MIRROR_SYNC_ID_PATTERN.test(body["syncId"]) ||
      typeof body["final"] !== "boolean" ||
      !Array.isArray(body["items"])
    )
      return invalid("mirror_shape");
    if (body["items"].length > limit)
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.BATCH_TOO_LARGE, 413, {
        limit,
        key: "device.mirror.batch_items",
      });
    const kind = body["kind"] as DeviceMirrorKind;
    const items = body["items"].map((raw): DeviceMirrorItemInput => {
      const item = plainObject(raw);
      if (
        !item ||
        !onlyKeys(item, ["externalId", "version", "deleted", "data"]) ||
        typeof item["externalId"] !== "string" ||
        item["externalId"].length < 1 ||
        item["externalId"].length > DEVICE_MIRROR_EXTERNAL_ID_MAXIMUM ||
        !Number.isSafeInteger(item["version"]) ||
        (item["version"] as number) < 0 ||
        (item["deleted"] !== undefined && typeof item["deleted"] !== "boolean")
      )
        return invalid("mirror_item");
      const deleted = item["deleted"] === true;
      if (deleted !== (item["data"] === undefined)) return invalid("mirror_item");
      const data = deleted
        ? null
        : validatePerceptionFields(DEVICE_MIRROR_KINDS[kind], item["data"]);
      if (!deleted && data === null) return invalid("mirror_data");
      return {
        externalId: item["externalId"],
        version: item["version"] as number,
        deleted,
        data,
      };
    });
    if (new Set(items.map((item) => item.externalId)).size !== items.length)
      return invalid("mirror_duplicate");
    return this.#options.store.syncMirror({
      ...this.#scope(input.scope),
      deviceId: input.deviceId,
      kind,
      mode: body["mode"],
      syncId: body["syncId"],
      final: body["final"],
      now: this.#now().toISOString(),
      items,
    });
  }

  async track(input: {
    readonly scope: PerceptionScope;
    readonly deviceId: string;
    readonly points: unknown;
  }) {
    const scope = this.#scope(input.scope);
    const limit = this.#options.deviceConfiguration().limits["device.track.batch_points"];
    if (!Array.isArray(input.points) || input.points.length === 0) return invalid("points");
    if (input.points.length > limit)
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.BATCH_TOO_LARGE, 413, {
        limit,
        key: "device.track.batch_points",
      });
    const now = this.#now();
    const timeZone = this.#options.timeZone();
    const skew = this.#options.deviceConfiguration().signatureToleranceSeconds * 1000;
    const optional = (value: unknown, maximum: number): number | null | undefined => {
      if (value === undefined) return null;
      return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum
        ? value
        : undefined;
    };
    const points = input.points.map((raw): TrackPointInput => {
      const point = plainObject(raw);
      if (!point || !onlyKeys(point, POINT_KEYS)) return invalid("point_shape");
      const { occurredAt, latitude, longitude } = point;
      const accuracy = optional(point["accuracyMeters"], 100_000);
      const speed = optional(point["speedMetersPerSecond"], 1_000_000);
      const occurredAtMs = typeof occurredAt === "string" ? Date.parse(occurredAt) : Number.NaN;
      if (
        typeof occurredAt !== "string" ||
        !DEVICE_TIME_PATTERN.test(occurredAt) ||
        !Number.isFinite(occurredAtMs) ||
        occurredAtMs < 0 ||
        occurredAtMs > now.getTime() + skew ||
        typeof latitude !== "number" ||
        !(latitude >= -90 && latitude <= 90) ||
        typeof longitude !== "number" ||
        !(longitude >= -180 && longitude <= 180) ||
        accuracy === undefined ||
        speed === undefined
      )
        return invalid("point");
      return {
        occurredAtMs,
        latitudeE7: Math.round(latitude * 1e7),
        longitudeE7: Math.round(longitude * 1e7),
        accuracyDecimeters: accuracy === null ? null : Math.round(accuracy * 10),
        speedCentimetersPerSecond: speed === null ? null : Math.round(speed * 100),
        localDay: ownerLocalDay(occurredAtMs, timeZone),
      };
    });
    const settings = await this.settings(scope);
    const bounds = ownerDayBounds(now.toISOString(), timeZone);
    const result = await this.#options.store.insertTrackPoints({
      ...scope,
      deviceId: input.deviceId,
      now: now.toISOString(),
      periodStart: bounds.start,
      limitKey: "perception.track.daily",
      limit: this.#serverLimit(settings, "perception.track.daily"),
      points,
    });
    await this.#afterWrite(scope, settings, bounds.start, ["perception.track.daily"]);
    return result;
  }

  async beginUpload(input: {
    readonly scope: PerceptionScope;
    readonly deviceId: string;
    readonly body: Record<string, unknown>;
  }): Promise<{ readonly grant: string; readonly expiresAt: string; readonly path: string }> {
    const { body } = input;
    const limits = this.#options.deviceConfiguration().limits;
    const purpose = body["purpose"];
    if (
      !onlyKeys(body, [
        "purpose",
        "sha256",
        "bytes",
        "recordIdFirst",
        "recordIdLast",
        "batchId",
        "mediaKind",
        "durationMs",
      ]) ||
      typeof purpose !== "string" ||
      !(UPLOAD_GRANT_PURPOSES as readonly string[]).includes(purpose) ||
      typeof body["sha256"] !== "string" ||
      !SHA256_PATTERN.test(body["sha256"]) ||
      !Number.isSafeInteger(body["bytes"]) ||
      (body["bytes"] as number) < 1
    )
      return invalid("upload_shape");
    if ((body["bytes"] as number) > limits["device.upload.file_bytes"])
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.UPLOAD_TOO_LARGE, 413, {
        limit: limits["device.upload.file_bytes"],
        key: "device.upload.file_bytes",
      });
    const records = purpose === "perception";
    const first = body["recordIdFirst"];
    const last = body["recordIdLast"];
    const batchId = body["batchId"];
    const mediaKind = body["mediaKind"];
    const duration = body["durationMs"];
    if (
      records
        ? typeof first !== "string" ||
          typeof last !== "string" ||
          !PERCEPTION_RECORD_ID_PATTERN.test(first) ||
          !PERCEPTION_RECORD_ID_PATTERN.test(last) ||
          first > last ||
          batchId !== undefined
        : first !== undefined ||
          last !== undefined ||
          typeof batchId !== "string" ||
          !UPLOAD_BATCH_ID_PATTERN.test(batchId)
    )
      return invalid("upload_binding");
    if (
      purpose === "media"
        ? !(PERCEPTION_MEDIA_KINDS as readonly unknown[]).includes(mediaKind) ||
          (mediaKind === "audio"
            ? !Number.isSafeInteger(duration) ||
              (duration as number) < 0 ||
              (duration as number) > 86_400_000
            : duration !== undefined)
        : mediaKind !== undefined || duration !== undefined
    )
      return invalid("upload_media");
    const now = this.#now();
    const token = (this.#options.randomBytes ?? randomBytes)(32).toString("base64url");
    const expiresAt = new Date(
      now.getTime() + this.#options.configuration().uploadGrantTtlSeconds * 1000,
    ).toISOString();
    const created = await this.#options.store.createUploadGrant({
      ...this.#scope(input.scope),
      tokenHash: digest(token),
      deviceId: input.deviceId,
      purpose: purpose as UploadGrantPurpose,
      sha256: body["sha256"],
      bytes: body["bytes"] as number,
      recordIdFirst: records ? (first as string) : null,
      recordIdLast: records ? (last as string) : null,
      batchId: records ? null : (batchId as string),
      mediaKind: purpose === "media" ? (mediaKind as PerceptionMediaKind) : null,
      mediaMilliseconds: mediaKind === "audio" ? (duration as number) : null,
      now: now.toISOString(),
      expiresAt,
    });
    if (created === "batch_used")
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.UPLOAD_BATCH_USED, 409);
    return Object.freeze({
      grant: token,
      expiresAt,
      path:
        purpose === "perception"
          ? "perception"
          : purpose === "track"
            ? "track"
            : "perception/media",
    });
  }

  async authorizeUpload(input: {
    readonly token: string;
    readonly purpose: UploadGrantPurpose | null;
  }): Promise<AuthorizedUpload> {
    const grant = /^[A-Za-z0-9_-]{43}$/u.test(input.token)
      ? await this.#options.store.readUploadGrant({ tokenHash: digest(input.token) })
      : undefined;
    if (!grant) throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.UPLOAD_GRANT_INVALID, 401);
    if (input.purpose !== grant.purpose)
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.UPLOAD_GRANT_PATH, 403);
    if (grant.result !== null)
      return Object.freeze({ grant, replay: Object.freeze(JSON.parse(grant.result)) });
    if (grant.expiresAt <= this.#now().toISOString())
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.UPLOAD_GRANT_EXPIRED, 401);
    return Object.freeze({ grant, replay: null });
  }

  async #exclusive<TResult>(key: string, run: () => Promise<TResult>): Promise<TResult> {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous.then(run, run);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.#queues.set(key, settled);
    try {
      return await current;
    } finally {
      if (this.#queues.get(key) === settled) this.#queues.delete(key);
    }
  }

  async #sweepMedia(): Promise<void> {
    const names = (await readdir(this.#media())).filter((name) => /^[0-9a-f]{64}$/u.test(name));
    const known = new Set(await this.#options.store.knownMediaDigests({ digests: names }));
    for (const name of names)
      if (!known.has(name))
        await this.#exclusive(`media:${name}`, async () => {
          const kept = await this.#options.store.knownMediaDigests({ digests: [name] });
          if (kept.length === 0) await rm(path.join(this.#media(), name), { force: true });
        });
  }

  async #lines(upload: ReceivedUpload, maximumLines: number, key: string): Promise<unknown[]> {
    const limits = this.#options.deviceConfiguration().limits;
    const cap = limits["device.upload.expanded_bytes"];
    const lineCap = limits["device.request.body_bytes"];
    const tooLong = (): never => {
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.UPLOAD_EXPANDED_TOO_LARGE, 413, {
        limit: lineCap,
        key: "device.request.body_bytes",
      });
    };
    const source = createReadStream(upload.file);
    const expanded = upload.gzip ? source.pipe(createGunzip()) : source;
    source.once("error", (error) => expanded.destroy(error));
    const decoder = new StringDecoder("utf8");
    const lines: unknown[] = [];
    const take = (line: string) => {
      if (line.trim().length === 0) return;
      if (Buffer.byteLength(line) > lineCap) tooLong();
      if (lines.length >= maximumLines)
        throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.BATCH_TOO_LARGE, 413, {
          limit: maximumLines,
          key,
        });
      try {
        lines.push(JSON.parse(line));
      } catch {
        invalid("upload_line");
      }
    };
    let bytes = 0;
    let pending = "";
    try {
      for await (const chunk of expanded as AsyncIterable<Buffer>) {
        bytes += chunk.length;
        if (bytes > cap)
          throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.UPLOAD_EXPANDED_TOO_LARGE, 413, {
            limit: cap,
            key: "device.upload.expanded_bytes",
          });
        const parts = (pending + decoder.write(chunk)).split("\n");
        pending = parts.pop() ?? "";
        if (Buffer.byteLength(pending) > lineCap) tooLong();
        for (const part of parts) take(part);
      }
      take(pending + decoder.end());
    } catch (error) {
      if (error instanceof PairedDeviceError) throw error;
      return invalid("upload_encoding");
    } finally {
      expanded.destroy();
      source.destroy();
    }
    return lines;
  }

  async consumeUpload(input: {
    readonly scope: PerceptionScope;
    readonly authentication: GatewayAuthenticationContext;
    readonly grant: UploadGrant;
    readonly upload: ReceivedUpload;
  }): Promise<Readonly<Record<string, unknown>>> {
    const { grant, upload } = input;
    const scope = this.#scope(input.scope);
    if (this.#consuming.has(grant.tokenHash)) {
      await rm(upload.file, { force: true });
      throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.UPLOAD_IN_PROGRESS, 409);
    }
    this.#consuming.add(grant.tokenHash);
    try {
      const again = await this.#options.store.readUploadGrant({ tokenHash: grant.tokenHash });
      if (!again) throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.UPLOAD_GRANT_INVALID, 401);
      if (again.result !== null) return Object.freeze(JSON.parse(again.result));
      if (upload.bytes !== grant.bytes || upload.sha256 !== grant.sha256)
        throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.UPLOAD_DIGEST_MISMATCH, 422);
      const limits = this.#options.deviceConfiguration().limits;
      let result: Record<string, unknown>;
      if (grant.purpose === "perception") {
        const ingested = await this.ingest({
          scope,
          authentication: input.authentication,
          deviceId: grant.deviceId,
          records: await this.#lines(
            upload,
            limits["device.perception.batch_records"],
            "device.perception.batch_records",
          ),
          idRange: { first: grant.recordIdFirst as string, last: grant.recordIdLast as string },
        });
        const counts: Record<string, number> = {};
        for (const { outcome } of ingested.outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1;
        result = { purpose: grant.purpose, counts, reached: ingested.reached };
      } else if (grant.purpose === "track") {
        result = {
          purpose: grant.purpose,
          ...(await this.track({
            scope,
            deviceId: grant.deviceId,
            points: await this.#lines(
              upload,
              limits["device.track.batch_points"],
              "device.track.batch_points",
            ),
          })),
        };
      } else {
        if (upload.gzip) return invalid("upload_encoding");
        const settings = await this.settings(scope);
        const now = this.#now();
        const bounds = ownerDayBounds(now.toISOString(), this.#options.timeZone());
        const final = path.join(this.#media(), grant.sha256);
        const image = grant.mediaKind === "image" || grant.mediaKind === "screen";
        const stored = await this.#exclusive(`media:${grant.sha256}`, async () => {
          this.#placing.add(grant.sha256);
          try {
            await rename(upload.file, final);
            const outcome = await this.#options.store.recordMedia({
              ...scope,
              periodStart: bounds.start,
              item: {
                id: `media:${grant.sha256}`,
                deviceId: grant.deviceId,
                kind: grant.mediaKind as PerceptionMediaKind,
                bytes: grant.bytes,
                sha256: grant.sha256,
                milliseconds: grant.mediaMilliseconds,
                receivedAt: now.toISOString(),
              },
              reservations: [
                {
                  key: "perception.media.daily_bytes",
                  amount: grant.bytes,
                  limit: this.#limit(settings, "perception.media.daily_bytes"),
                },
                ...(image
                  ? [
                      {
                        key: "perception.images.daily",
                        amount: 1,
                        limit: this.#limit(settings, "perception.images.daily"),
                      },
                    ]
                  : []),
                ...(grant.mediaMilliseconds === null
                  ? []
                  : [
                      {
                        key: "perception.server_asr.daily",
                        amount: grant.mediaMilliseconds,
                        limit: this.#limit(settings, "perception.server_asr.daily"),
                      },
                    ]),
              ],
            });
            if (!outcome.stored && !outcome.duplicate) await rm(final, { force: true });
            return outcome;
          } catch (error) {
            const kept = await this.#options.store
              .knownMediaDigests({ digests: [grant.sha256] })
              .catch(() => [grant.sha256]);
            if (kept.length === 0) await rm(final, { force: true });
            throw error;
          }
        });
        await this.#afterWrite(scope, settings, bounds.start, [
          "perception.media.daily_bytes",
          "perception.images.daily",
          "perception.server_asr.daily",
        ]);
        result = {
          purpose: grant.purpose,
          stored: stored.stored,
          duplicate: stored.duplicate,
          reached: stored.reached === null ? [] : [stored.reached],
        };
      }
      await this.#options.store.completeUploadGrant({
        tokenHash: grant.tokenHash,
        now: this.#now().toISOString(),
        result: JSON.stringify(result),
      });
      return Object.freeze(result);
    } finally {
      this.#consuming.delete(grant.tokenHash);
      await rm(upload.file, { force: true });
    }
  }

  async reportDeviceUsage(input: {
    readonly scope: PerceptionScope;
    readonly deviceId: string;
    readonly body: Record<string, unknown>;
  }): Promise<void> {
    const reported = USAGE_LIMIT_KEYS.filter((key) => USAGE_LIMITS[key].counter === "device");
    if (!onlyKeys(input.body, reported) || Object.keys(input.body).length === 0)
      return invalid("usage_report");
    const bounds = ownerDayBounds(this.#now().toISOString(), this.#options.timeZone());
    for (const key of reported) {
      const value = input.body[key];
      if (value === undefined) continue;
      const definition = USAGE_LIMITS[key];
      if (
        !Number.isSafeInteger(value) ||
        (value as number) < 0 ||
        (definition.unit === "percent" && (value as number) > 100)
      )
        return invalid("usage_report");
    }
    for (const key of reported) {
      const value = input.body[key];
      if (value === undefined) continue;
      await this.#options.store.reportDeviceUsage({
        ...this.#scope(input.scope),
        deviceId: input.deviceId,
        key,
        periodStart: bounds.start,
        value: value as number,
      });
    }
  }

  async usage(scope: PerceptionScope): Promise<{
    readonly day: string;
    readonly resetsAt: string;
    readonly warnPermille: number;
    readonly limits: readonly UsageLimitView[];
  }> {
    const now = this.#now();
    const bounds = ownerDayBounds(now.toISOString(), this.#options.timeZone());
    const settings = await this.settings(scope);
    const rows = await this.#options.store.readUsage({
      ...this.#scope(scope),
      periodStart: bounds.start,
    });
    const { warnPermille } = this.#options.configuration();
    const limits: UsageLimitView[] = [];
    for (const key of USAGE_LIMIT_KEYS) {
      const definition = USAGE_LIMITS[key];
      const own = rows.filter((row) => row.key === key);
      let limit = this.#limit(settings, key);
      let used = own.find((row) => row.deviceId === "")?.used ?? 0;
      const devices = own
        .filter((row) => row.deviceId !== "")
        .map((row) => Object.freeze({ deviceId: row.deviceId, used: row.used }));
      if (definition.counter === "device")
        used = devices.reduce((most, device) => Math.max(most, device.used), 0);
      if (definition.counter === "proactive") {
        if (!this.#options.proactiveUsage) continue;
        limit = this.#options.proactiveUsage.limit();
        used = await this.#options.proactiveUsage.usedSince(this.#scope(scope), bounds.start);
      }
      limits.push(
        Object.freeze({
          key,
          unit: definition.unit,
          limit,
          defaultLimit: definition.defaultLimit,
          minimum: definition.minimum,
          maximum: definition.maximum,
          adjustable: definition.adjustable,
          used,
          devices: Object.freeze(devices),
          resetsAt: bounds.end,
          onReach: definition.onReach,
          state: usageLimitState(used, limit, warnPermille),
        }),
      );
    }
    return Object.freeze({
      day: bounds.day,
      resetsAt: bounds.end,
      warnPermille,
      limits: Object.freeze(limits),
    });
  }

  async countDayBySense(
    scope: PerceptionScope,
    day: string,
  ): Promise<readonly { readonly sense: PerceptionSense; readonly count: number }[]> {
    if (!DAY_PATTERN.test(day)) return invalid("day");
    return Object.freeze(
      await Promise.all(
        PERCEPTION_SENSES.map(async (sense) =>
          Object.freeze({
            sense,
            count: await this.#options.store.countDay({
              ...this.#scope(scope),
              day,
              types: [...perceptionTypesOfSense(sense)],
            }),
          }),
        ),
      ),
    );
  }

  async listDay(input: {
    readonly scope: PerceptionScope;
    readonly day: string | null;
    readonly sense: string | null;
    readonly types: readonly string[] | null;
    readonly cursor: string | null;
  }): Promise<PerceptionDayPage & { readonly day: string }> {
    const day = input.day ?? ownerLocalDay(this.#now().getTime(), this.#options.timeZone());
    if (!DAY_PATTERN.test(day)) return invalid("day");
    let types: PerceptionRecordType[] | null = null;
    if (input.sense !== null) {
      if (!(PERCEPTION_SENSES as readonly string[]).includes(input.sense)) return invalid("sense");
      types = [...perceptionTypesOfSense(input.sense as PerceptionSense)];
    }
    if (input.types !== null) {
      if (
        input.types.length === 0 ||
        input.types.some(
          (type) => !(PERCEPTION_RECORD_TYPE_NAMES as readonly string[]).includes(type),
        )
      )
        return invalid("types");
      const requested = input.types as PerceptionRecordType[];
      types = types === null ? requested : types.filter((type) => requested.includes(type));
    }
    const page = await this.#options.store.listDay({
      ...this.#scope(input.scope),
      day,
      types,
      cursor: input.cursor,
      limit: this.#options.configuration().listPageRows,
    });
    return Object.freeze({ ...page, day });
  }

  readEpisode(input: {
    readonly scope: PerceptionScope;
    readonly episodeId: string;
    readonly cursor: string | null;
  }) {
    return this.#options.store.readEpisode({
      ...this.#scope(input.scope),
      episodeId: input.episodeId,
      cursor: input.cursor,
      limit: this.#options.configuration().listPageRows,
    });
  }

  async recordCommandUtterance(scope: PerceptionScope, utteranceId: string): Promise<void> {
    if (!PERCEPTION_UTTERANCE_ID_PATTERN.test(utteranceId)) return invalid("utteranceId");
    await this.#options.store.recordCommandUtterance({
      ...this.#scope(scope),
      utteranceId,
      now: this.#now().toISOString(),
    });
  }
}
