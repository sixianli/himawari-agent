import type { AgentId, OwnerId } from "@himawari-agent/domain";
import type { DataClassification } from "./common.js";
import type { DecisionLedgerWrite } from "./decision-ledger.js";

export const PERCEPTION_SENSES = [
  "hearing",
  "location",
  "body",
  "vision",
  "reading",
  "surroundings",
  "presence",
] as const;
export type PerceptionSense = (typeof PERCEPTION_SENSES)[number];

export const PERCEPTION_ORIGINS = ["owner_spoken", "other"] as const;
export type PerceptionOrigin = (typeof PERCEPTION_ORIGINS)[number];

export const PERCEPTION_CAPTURE_SOURCES = [
  "device_microphone",
  "airpods",
  "wearable_microphone",
  "device_sensor",
  "system_api",
  "share_extension",
  "safari_extension",
  "manual",
] as const;
export type PerceptionCaptureSource = (typeof PERCEPTION_CAPTURE_SOURCES)[number];

export const PERCEPTION_SPEAKER_KINDS = ["owner", "contact", "unknown"] as const;
export type PerceptionSpeakerKind = (typeof PERCEPTION_SPEAKER_KINDS)[number];

export const PERCEPTION_RECORD_STATUSES = ["active", "deleted"] as const;
export type PerceptionRecordStatus = (typeof PERCEPTION_RECORD_STATUSES)[number];

export const PERCEPTION_RECORD_ID_PATTERN = /^perception:[A-Za-z0-9_-]{16,64}$/u;
export const PERCEPTION_EPISODE_ID_PATTERN = /^episode:[0-9a-f]{32}$/u;
export const PERCEPTION_TEXT_MAXIMUM = 32 * 1024;
export const PERCEPTION_DEVICE_TIME_MAXIMUM = 64;
export const PERCEPTION_CONFIDENCE_MAXIMUM = 1000;

export type PerceptionFieldRule =
  | { readonly kind: "string"; readonly maximum: number; readonly optional?: true }
  | {
      readonly kind: "integer" | "number";
      readonly minimum: number;
      readonly maximum: number;
      readonly optional?: true;
    }
  | { readonly kind: "boolean"; readonly optional?: true }
  | { readonly kind: "enum"; readonly values: readonly string[]; readonly optional?: true };

export type PerceptionFieldRules = Readonly<Record<string, PerceptionFieldRule>>;

export type PerceptionRetention = "until_deleted" | "surroundings";

export interface PerceptionRecordTypeDefinition {
  readonly sense: PerceptionSense;
  readonly dataClassification: DataClassification;
  readonly retention: PerceptionRetention;
  readonly lowValue: boolean;
  readonly text: "required" | "optional" | "none";
  readonly evidence: PerceptionFieldRules;
}

const text = (maximum: number): PerceptionFieldRule => ({ kind: "string", maximum });
const optionalText = (maximum: number): PerceptionFieldRule => ({
  kind: "string",
  maximum,
  optional: true,
});
const oneOf = (...values: string[]): PerceptionFieldRule => ({ kind: "enum", values });
const optionalOneOf = (...values: string[]): PerceptionFieldRule => ({
  kind: "enum",
  values,
  optional: true,
});
const flag: PerceptionFieldRule = { kind: "boolean" };
const optionalFlag: PerceptionFieldRule = { kind: "boolean", optional: true };
const latitude: PerceptionFieldRule = { kind: "number", minimum: -90, maximum: 90 };
const longitude: PerceptionFieldRule = { kind: "number", minimum: -180, maximum: 180 };
const optionalLatitude: PerceptionFieldRule = { ...latitude, optional: true };
const optionalLongitude: PerceptionFieldRule = { ...longitude, optional: true };
const optionalMilliseconds: PerceptionFieldRule = {
  kind: "integer",
  minimum: 0,
  maximum: 9_999_999_999_999,
  optional: true,
};
const URL_MAXIMUM = 2048;

function recordType(
  sense: PerceptionSense,
  textMode: PerceptionRecordTypeDefinition["text"],
  evidence: PerceptionFieldRules,
  overrides: Partial<Pick<PerceptionRecordTypeDefinition, "dataClassification">> = {},
): PerceptionRecordTypeDefinition {
  const surroundings = sense === "surroundings";
  return Object.freeze({
    sense,
    dataClassification: overrides.dataClassification ?? "private",
    retention: surroundings ? "surroundings" : "until_deleted",
    lowValue: surroundings,
    text: textMode,
    evidence: Object.freeze(evidence),
  });
}

export const PERCEPTION_RECORD_TYPES = Object.freeze({
  "speech.utterance": recordType("hearing", "required", {
    durationMs: { kind: "integer", minimum: 0, maximum: 3_600_000 },
    language: optionalText(16),
    utteranceId: optionalText(64),
    transcriber: optionalOneOf("device", "server", "third_party"),
  }),
  "location.visit": recordType("location", "none", {
    latitude,
    longitude,
    accuracyMeters: { kind: "number", minimum: 0, maximum: 100_000, optional: true },
    arrivedAtMs: optionalMilliseconds,
    departedAtMs: optionalMilliseconds,
    placeName: optionalText(128),
  }),
  "location.region": recordType("location", "none", {
    regionId: text(128),
    transition: oneOf("enter", "exit"),
    latitude: optionalLatitude,
    longitude: optionalLongitude,
  }),
  "health.sample": recordType(
    "body",
    "none",
    {
      subtype: oneOf("sleep", "heart_rate", "workout", "steps"),
      value: { kind: "number", minimum: 0, maximum: 1_000_000_000 },
      unit: text(16),
      startMs: optionalMilliseconds,
      endMs: optionalMilliseconds,
      workoutType: optionalText(64),
    },
    { dataClassification: "sensitive" },
  ),
  "motion.activity": recordType("body", "none", {
    activity: oneOf("stationary", "walking", "running", "cycling", "driving"),
    certainty: optionalOneOf("low", "medium", "high"),
  }),
  "photo.asset": recordType("vision", "optional", {
    assetId: text(128),
    latitude: optionalLatitude,
    longitude: optionalLongitude,
  }),
  "photo.screenshot": recordType("vision", "optional", { assetId: text(128) }),
  "camera.capture": recordType("vision", "optional", { assetId: optionalText(128) }),
  "share.item": recordType("vision", "optional", {
    url: optionalText(URL_MAXIMUM),
    title: optionalText(256),
    sourceApp: optionalText(128),
  }),
  "screen.text": recordType("vision", "required", {
    appName: optionalText(128),
    windowTitle: optionalText(256),
  }),
  "web.page": recordType("reading", "optional", {
    url: text(URL_MAXIMUM),
    title: optionalText(256),
  }),
  "message.text": recordType(
    "reading",
    "required",
    {
      service: oneOf("sms", "imessage"),
      sender: optionalText(128),
      direction: optionalOneOf("incoming", "outgoing"),
    },
    { dataClassification: "sensitive" },
  ),
  "clipboard.item": recordType("reading", "required", { sourceApp: optionalText(128) }),
  "context.now_playing": recordType("surroundings", "none", {
    title: text(256),
    artist: optionalText(256),
    app: optionalText(128),
  }),
  "context.connectivity": recordType("surroundings", "none", {
    network: oneOf("wifi", "cellular", "none"),
    bluetoothDevice: optionalText(128),
    carPlay: optionalFlag,
  }),
  "context.power": recordType("surroundings", "none", {
    batteryPercent: { kind: "integer", minimum: 0, maximum: 100 },
    charging: flag,
    lowPowerMode: optionalFlag,
  }),
  "context.focus": recordType("surroundings", "none", {
    active: flag,
    focusName: optionalText(64),
  }),
  "context.app": recordType("surroundings", "none", {
    appName: text(128),
    bundleId: optionalText(256),
  }),
  "home.state": recordType("surroundings", "none", {
    accessoryId: text(128),
    characteristic: text(64),
    value: text(128),
  }),
  "presence.app": recordType("presence", "none", {
    surface: oneOf("iphone", "watch", "mac", "web"),
    visible: flag,
  }),
} as const satisfies Record<string, PerceptionRecordTypeDefinition>);

export type PerceptionRecordType = keyof typeof PERCEPTION_RECORD_TYPES;
export const PERCEPTION_RECORD_TYPE_NAMES = Object.freeze(
  Object.keys(PERCEPTION_RECORD_TYPES) as PerceptionRecordType[],
);
export const PERCEPTION_EPISODE_ANCHOR_TYPES: readonly PerceptionRecordType[] = Object.freeze([
  "speech.utterance",
]);
export const PERCEPTION_EPISODE_BOUNDARY_TYPES: readonly PerceptionRecordType[] = Object.freeze([
  "location.visit",
  "location.region",
]);

export function perceptionTypesOfSense(sense: PerceptionSense): readonly PerceptionRecordType[] {
  return PERCEPTION_RECORD_TYPE_NAMES.filter(
    (type) => PERCEPTION_RECORD_TYPES[type].sense === sense,
  );
}

export const DEVICE_MIRROR_KINDS = Object.freeze({
  calendar_event: Object.freeze({
    title: text(512),
    startsAtMs: { kind: "integer", minimum: 0, maximum: 9_999_999_999_999 },
    endsAtMs: { kind: "integer", minimum: 0, maximum: 9_999_999_999_999 },
    allDay: flag,
    calendarName: optionalText(128),
    location: optionalText(512),
    notes: optionalText(4096),
    attendeeCount: { kind: "integer", minimum: 0, maximum: 10_000, optional: true },
  }),
  reminder: Object.freeze({
    title: text(512),
    completed: flag,
    dueAtMs: optionalMilliseconds,
    listName: optionalText(128),
    notes: optionalText(4096),
  }),
  contact: Object.freeze({
    name: text(256),
    organization: optionalText(256),
    phones: optionalText(1024),
    emails: optionalText(1024),
    birthday: optionalText(16),
  }),
  home_accessory: Object.freeze({
    name: text(128),
    category: text(64),
    room: optionalText(128),
    reachable: optionalFlag,
  }),
} as const satisfies Record<string, PerceptionFieldRules>);

export type DeviceMirrorKind = keyof typeof DEVICE_MIRROR_KINDS;
export const DEVICE_MIRROR_KIND_NAMES = Object.freeze(
  Object.keys(DEVICE_MIRROR_KINDS) as DeviceMirrorKind[],
);
export const DEVICE_MIRROR_EXTERNAL_ID_MAXIMUM = 256;
export const DEVICE_MIRROR_SYNC_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;

export function validatePerceptionFields(
  rules: PerceptionFieldRules,
  input: unknown,
): Readonly<Record<string, string | number | boolean>> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const source = input as Record<string, unknown>;
  if (Object.keys(source).some((key) => !Object.hasOwn(rules, key))) return null;
  const ordered: Record<string, string | number | boolean> = {};
  for (const [key, rule] of Object.entries(rules)) {
    const value = source[key];
    if (value === undefined) {
      if (rule.optional) continue;
      return null;
    }
    switch (rule.kind) {
      case "string":
        if (typeof value !== "string" || value.length === 0 || [...value].length > rule.maximum)
          return null;
        break;
      case "integer":
        if (!Number.isSafeInteger(value)) return null;
        if ((value as number) < rule.minimum || (value as number) > rule.maximum) return null;
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value)) return null;
        if (value < rule.minimum || value > rule.maximum) return null;
        break;
      case "boolean":
        if (typeof value !== "boolean") return null;
        break;
      case "enum":
        if (typeof value !== "string" || !rule.values.includes(value)) return null;
        break;
    }
    ordered[key] = value as string | number | boolean;
  }
  return Object.freeze(ordered);
}

export function resolvePerceptionOrigin(input: {
  readonly type: PerceptionRecordType;
  readonly speakerKind: PerceptionSpeakerKind | null;
  readonly ownerVoiceQualified: boolean;
}): PerceptionOrigin {
  return input.ownerVoiceQualified &&
    PERCEPTION_EPISODE_ANCHOR_TYPES.includes(input.type) &&
    input.speakerKind === "owner"
    ? "owner_spoken"
    : "other";
}

export const UPLOAD_GRANT_PURPOSES = ["perception", "track", "media"] as const;
export type UploadGrantPurpose = (typeof UPLOAD_GRANT_PURPOSES)[number];
export const UPLOAD_BATCH_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;
export const PERCEPTION_MEDIA_KINDS = ["audio", "image", "screen"] as const;
export type PerceptionMediaKind = (typeof PERCEPTION_MEDIA_KINDS)[number];

export interface PerceptionConfiguration {
  readonly episodeSilenceSeconds: number;
  readonly episodeMaximumSeconds: number;
  readonly uploadGrantTtlSeconds: number;
  readonly warnPermille: number;
  readonly pauseMaximumSeconds: number;
  readonly trackRetentionDays: number;
  readonly surroundingsRetentionDays: number;
  readonly pruneIntervalSeconds: number;
  readonly listPageRows: number;
  readonly previewCharacters: number;
  readonly mediaRetentionDays: number;
}

export const PERCEPTION_CONFIGURATION_DEFAULTS: PerceptionConfiguration = Object.freeze({
  episodeSilenceSeconds: 300,
  episodeMaximumSeconds: 3600,
  uploadGrantTtlSeconds: 7 * 24 * 3600,
  warnPermille: 800,
  pauseMaximumSeconds: 24 * 3600,
  trackRetentionDays: 90,
  surroundingsRetentionDays: 30,
  pruneIntervalSeconds: 3600,
  listPageRows: 100,
  previewCharacters: 200,
  mediaRetentionDays: 7,
});

export const PERCEPTION_CONFIGURATION_RANGES: Readonly<
  Record<keyof PerceptionConfiguration, readonly [number, number]>
> = Object.freeze({
  episodeSilenceSeconds: [10, 3600],
  episodeMaximumSeconds: [60, 24 * 3600],
  uploadGrantTtlSeconds: [60, 30 * 24 * 3600],
  warnPermille: [1, 999],
  pauseMaximumSeconds: [60, 30 * 24 * 3600],
  trackRetentionDays: [1, 3650],
  surroundingsRetentionDays: [1, 3650],
  pruneIntervalSeconds: [60, 24 * 3600],
  listPageRows: [1, 500],
  previewCharacters: [20, 2000],
  mediaRetentionDays: [1, 90],
});

export const PERCEPTION_RETENTION_KEYS = ["track", "surroundings"] as const;
export type PerceptionRetentionKey = (typeof PERCEPTION_RETENTION_KEYS)[number];
export const PERCEPTION_RETENTION_CONFIGURATION = Object.freeze({
  track: "trackRetentionDays",
  surroundings: "surroundingsRetentionDays",
} as const satisfies Record<PerceptionRetentionKey, keyof PerceptionConfiguration>);

export interface PerceptionScope {
  readonly ownerId: OwnerId;
  readonly agentId: AgentId;
}

export interface PerceptionSettings {
  readonly revision: number;
  readonly disabledSenses: readonly PerceptionSense[];
  readonly pausedFrom: string | null;
  readonly pausedUntil: string | null;
  readonly retentionDays: Readonly<Partial<Record<PerceptionRetentionKey, number>>>;
  readonly limitOverrides: Readonly<Record<string, number>>;
  readonly updatedAt: string | null;
}

export interface PerceptionRecordInput {
  readonly searchTerms?: readonly string[];
  readonly id: string;
  readonly type: PerceptionRecordType;
  readonly origin: PerceptionOrigin;
  readonly captureSource: PerceptionCaptureSource;
  readonly occurredAtMs: number;
  readonly occurredAtDevice: string;
  readonly localDay: string;
  readonly confidence: number;
  readonly speakerKind: PerceptionSpeakerKind | null;
  readonly speakerRef: string | null;
  readonly contentRef: string | null;
  readonly dataClassification: DataClassification;
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
  readonly lowValue: boolean;
  readonly audioMilliseconds: number;
}

export type PerceptionIngestOutcome = "stored" | "duplicate" | "limit_reached";

export interface PerceptionIngestResult {
  readonly outcomes: readonly { readonly id: string; readonly outcome: PerceptionIngestOutcome }[];
  readonly reached: readonly string[];
}

export interface PerceptionRecord {
  readonly id: string;
  readonly deviceId: string;
  readonly type: PerceptionRecordType;
  readonly origin: PerceptionOrigin;
  readonly captureSource: PerceptionCaptureSource;
  readonly occurredAtMs: number;
  readonly receivedAtMs: number;
  readonly occurredAtDevice: string;
  readonly localDay: string;
  readonly confidence: number;
  readonly speakerKind: PerceptionSpeakerKind | null;
  readonly speakerRef: string | null;
  readonly episodeId: string | null;
  readonly contentRef: string | null;
  readonly dataClassification: DataClassification;
  readonly evidence: Readonly<Record<string, string | number | boolean>>;
  readonly status: PerceptionRecordStatus;
}

export interface PerceptionEpisode {
  readonly id: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly localDay: string;
  readonly recordCount: number;
  readonly status: PerceptionRecordStatus;
}

export interface PerceptionEpisodeOverview {
  readonly types: readonly PerceptionRecordType[];
  readonly deviceIds: readonly string[];
  readonly lead: PerceptionRecord | null;
}

export type PerceptionDayRow =
  | {
      readonly kind: "episode";
      readonly atMs: number;
      readonly episode: PerceptionEpisode;
      readonly overview: PerceptionEpisodeOverview;
    }
  | { readonly kind: "record"; readonly atMs: number; readonly record: PerceptionRecord };

export interface PerceptionDayPage {
  readonly rows: readonly PerceptionDayRow[];
  readonly total: number;
  readonly nextCursor: string | null;
}

export interface DeviceMirrorItemInput {
  readonly externalId: string;
  readonly version: number;
  readonly deleted: boolean;
  readonly data: Readonly<Record<string, string | number | boolean>> | null;
}

export interface DeviceMirrorItem extends DeviceMirrorItemInput {
  readonly deviceId: string;
  readonly kind: DeviceMirrorKind;
  readonly updatedAtMs: number;
}

export interface TrackPointInput {
  readonly occurredAtMs: number;
  readonly latitudeE7: number;
  readonly longitudeE7: number;
  readonly accuracyDecimeters: number | null;
  readonly speedCentimetersPerSecond: number | null;
  readonly localDay: string;
}

export interface UploadGrant {
  readonly tokenHash: string;
  readonly deviceId: string;
  readonly purpose: UploadGrantPurpose;
  readonly sha256: string;
  readonly bytes: number;
  readonly recordIdFirst: string | null;
  readonly recordIdLast: string | null;
  readonly batchId: string | null;
  readonly mediaKind: PerceptionMediaKind | null;
  readonly mediaMilliseconds: number | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedAt: string | null;
  readonly result: string | null;
}

export interface LimitUsageRow {
  readonly key: string;
  readonly deviceId: string;
  readonly periodStart: string;
  readonly used: number;
  readonly warnedAt: string | null;
}

export interface LimitReservation {
  readonly key: string;
  readonly amount: number;
  readonly limit: number | null;
}

export interface PerceptionMediaItem {
  readonly id: string;
  readonly deviceId: string;
  readonly kind: PerceptionMediaKind;
  readonly bytes: number;
  readonly sha256: string;
  readonly milliseconds: number | null;
  readonly receivedAt: string;
  readonly status: "pending" | "processed" | "deleted";
}

export interface PerceptionStorePort {
  readSettings(input: PerceptionScope): Promise<PerceptionSettings>;
  writeSettings(
    input: PerceptionScope & {
      readonly expectedRevision: number;
      readonly now: string;
      readonly values: Omit<PerceptionSettings, "revision" | "updatedAt">;
      readonly decisions: readonly DecisionLedgerWrite[];
    },
  ): Promise<PerceptionSettings>;
  knownRecordIds(
    input: PerceptionScope & { readonly ids: readonly string[] },
  ): Promise<readonly string[]>;
  releaseContent(input: PerceptionScope & { readonly refs: readonly string[] }): Promise<number>;
  knownMediaDigests(input: { readonly digests: readonly string[] }): Promise<readonly string[]>;
  ingestRecords(
    input: PerceptionScope & {
      readonly deviceId: string;
      readonly now: string;
      readonly periodStart: string;
      readonly records: readonly PerceptionRecordInput[];
      readonly recordLimit: number;
      readonly audioLimit: number;
      readonly recordLimitKey: string;
      readonly audioLimitKey: string;
      readonly episodeSilenceMs: number;
      readonly episodeMaximumMs: number;
      readonly episodeAnchorTypes: readonly PerceptionRecordType[];
      readonly episodeBoundaryTypes: readonly PerceptionRecordType[];
    },
  ): Promise<PerceptionIngestResult>;
  listDay(
    input: PerceptionScope & {
      readonly day: string;
      readonly types: readonly PerceptionRecordType[] | null;
      readonly cursor: string | null;
      readonly limit: number;
    },
  ): Promise<PerceptionDayPage>;
  searchRecords(
    input: PerceptionScope & {
      readonly terms: readonly string[];
      readonly limit: number;
    },
  ): Promise<readonly PerceptionRecord[]>;
  countDay(
    input: PerceptionScope & {
      readonly day: string;
      readonly types: readonly PerceptionRecordType[] | null;
    },
  ): Promise<number>;
  readEpisode(
    input: PerceptionScope & {
      readonly episodeId: string;
      readonly cursor: string | null;
      readonly limit: number;
    },
  ): Promise<
    | {
        readonly episode: PerceptionEpisode;
        readonly overview: PerceptionEpisodeOverview;
        readonly records: readonly PerceptionRecord[];
        readonly nextCursor: string | null;
      }
    | undefined
  >;
  setRecordStatus(
    input: PerceptionScope & {
      readonly recordId: string;
      readonly status: PerceptionRecordStatus;
    },
  ): Promise<boolean>;
  syncMirror(
    input: PerceptionScope & {
      readonly deviceId: string;
      readonly kind: DeviceMirrorKind;
      readonly mode: "full" | "delta";
      readonly syncId: string;
      readonly final: boolean;
      readonly now: string;
      readonly items: readonly DeviceMirrorItemInput[];
    },
  ): Promise<{
    readonly applied: number;
    readonly stale: number;
    readonly removed: number;
    readonly active: number;
  }>;
  listMirror(
    input: PerceptionScope & { readonly kind: DeviceMirrorKind; readonly includeDeleted: boolean },
  ): Promise<readonly DeviceMirrorItem[]>;
  insertTrackPoints(
    input: PerceptionScope & {
      readonly deviceId: string;
      readonly now: string;
      readonly periodStart: string;
      readonly limitKey: string;
      readonly limit: number;
      readonly points: readonly TrackPointInput[];
    },
  ): Promise<{
    readonly stored: number;
    readonly duplicates: number;
    readonly limitReached: number;
  }>;
  countTrackPoints(input: PerceptionScope & { readonly day: string }): Promise<number>;
  createUploadGrant(
    input: PerceptionScope & Omit<UploadGrant, "usedAt" | "result" | "createdAt"> & { now: string },
  ): Promise<"created" | "batch_used">;
  readUploadGrant(input: { readonly tokenHash: string }): Promise<UploadGrant | undefined>;
  completeUploadGrant(input: {
    readonly tokenHash: string;
    readonly now: string;
    readonly result: string;
  }): Promise<void>;
  recordMedia(
    input: PerceptionScope & {
      readonly item: Omit<PerceptionMediaItem, "status">;
      readonly periodStart: string;
      readonly reservations: readonly LimitReservation[];
    },
  ): Promise<{
    readonly stored: boolean;
    readonly duplicate: boolean;
    readonly reached: string | null;
  }>;
  listMedia(
    input: PerceptionScope & { readonly status: PerceptionMediaItem["status"] },
  ): Promise<readonly PerceptionMediaItem[]>;
  readUsage(
    input: PerceptionScope & { readonly periodStart: string },
  ): Promise<readonly LimitUsageRow[]>;
  reserveUsage(
    input: PerceptionScope & {
      readonly key: string;
      readonly periodStart: string;
      readonly amount: number;
      readonly limit: number | null;
    },
  ): Promise<boolean>;
  reportDeviceUsage(
    input: PerceptionScope & {
      readonly deviceId: string;
      readonly key: string;
      readonly periodStart: string;
      readonly value: number;
    },
  ): Promise<void>;
  markUsageWarned(
    input: PerceptionScope & {
      readonly key: string;
      readonly periodStart: string;
      readonly now: string;
    },
  ): Promise<boolean>;
  prune(
    input: PerceptionScope & {
      readonly now: string;
      readonly trackBeforeMs: number;
      readonly surroundingsBeforeMs: number;
      readonly surroundingsTypes: readonly PerceptionRecordType[];
      readonly mediaBefore: string;
    },
  ): Promise<{
    readonly trackPoints: number;
    readonly records: number;
    readonly grants: number;
    readonly media: number;
  }>;
}
