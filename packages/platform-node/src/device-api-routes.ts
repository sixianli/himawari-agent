import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type AgentThreadGatewayPort,
  ApplicationPortError,
  type AuditLedgerPort,
  DEVICE_ACTION_ID_PATTERN,
  DEVICE_ACTION_OPEN_STATES,
  DEVICE_ACTION_RECORD_STATES,
  DEVICE_HARD_LIMIT_KEYS,
  DEVICE_HARD_LIMITS,
  DEVICE_MIRROR_KINDS,
  type DeviceActionService,
  type DeviceConfiguration,
  decideVoiceCommand,
  type GatewayAuthenticationContext,
  isVoiceScore,
  type PairedDevice,
  type PairedDeviceScope,
  PERCEPTION_RECORD_TYPES,
  PERCEPTION_SENSES,
  PERCEPTION_TEXT_MAXIMUM,
  PERCEPTION_UTTERANCE_ID_PATTERN,
  PHONE_VOICE_PROOF_PREFIX,
  PORT_ERROR_CODES,
  TALK_PROOF_PREFIX,
  type ThreadGatewayRequestMessage,
  type UploadGrantPurpose,
  type VaultService,
  VOICE_HEARD_NAME_MAXIMUM_CHARACTERS,
  VOICE_TRIGGERS,
  type VoiceEvidence,
  type VoiceGates,
  type VoiceTrigger,
} from "@himawari-agent/application";
import {
  CHAT_ATTACHMENT_TEXT_CHARACTERS,
  CHAT_ATTACHMENTS_PER_MESSAGE,
  CHAT_IMAGE_DATA_URL,
  CHAT_IMAGE_DATA_URL_CHARACTERS,
  DATA_EXPORT_ID_PATTERN,
  HOME_LOCALES,
  THREAD_GATEWAY_SCHEMA_VERSION,
  type ThreadExecutionEventsSubscription,
  type ThreadGatewayEvent,
  type ThreadGatewaySubscription,
  threadGatewayMessageSchema,
} from "@himawari-agent/gateway-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type DeviceActionHub, withDeviceActionSignals } from "./device-action-hub.js";
import {
  classifyDeviceGatewayRequest,
  DEVICE_GATEWAY_ERROR_CODES,
  DEVICE_REFERENCE_PLACEHOLDER,
  type DeviceGatewayAuditFailure,
  DeviceGatewayError,
  type DeviceGateways,
  dispatchDeviceGatewayRequest,
} from "./device-gateway.js";
import {
  type DeviceNotificationHub,
  type DevicePresence,
  withDeviceNotifications,
} from "./device-notification-hub.js";
import { DEVICE_PUSH_ERROR_CODES, DevicePushError, type DevicePushPort } from "./device-push.js";
import type { DeviceSignedRequest } from "./device-request-signature.js";
import {
  type AuthenticatedDeviceRequest,
  type DeviceStreamDiagnostic,
  PAIRED_DEVICE_ERROR_CODES,
  PairedDeviceError,
  type PairedDeviceService,
} from "./paired-device-service.js";
import type { DeviceSignInService } from "./device-sign-in.js";
import type { AuthorizedUpload, PerceptionService } from "./perception-service.js";
import {
  SPEECH_ERROR_CODES,
  SpeechSynthesisError,
  type SpeechSynthesisPort,
} from "./speech-synthesis.js";
import {
  PLAIN_TEXT_MAXIMUM_CHARACTERS,
  parseTextAdmission,
  type TextAdmissionClassification,
} from "./text-admission.js";

const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const NOTIFICATION_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const SETTLED_MAXIMUM_IDS = 200;

export const DEVICE_API_PREFIX = "/api/device/v1" as const;
export const DEVICE_MANAGEMENT_PREFIX = "/api/devices/v1" as const;

const THREAD_ID_SEGMENT = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";
const FILE_ID_SEGMENT = "[A-Za-z0-9](?:[A-Za-z0-9._:-]|%3[Aa]){0,127}";

export const DEVICE_API_ROUTES = Object.freeze([
  { method: "GET", path: "sign-in", signed: false },
  { method: "POST", path: "sign-in/setup/options", signed: false },
  { method: "POST", path: "sign-in/setup/finish", signed: false },
  { method: "POST", path: "sign-in/options", signed: false },
  { method: "POST", path: "sign-in/finish", signed: false },
  { method: "GET", path: "devices", signed: true },
  { method: "POST", path: "devices/rename", signed: true },
  { method: "POST", path: "devices/revoke", signed: true },
  { method: "GET", path: "config", signed: true },
  { method: "GET", path: "stream", signed: true },
  { method: "POST", path: "messages", signed: true },
  { method: "POST", path: "utterances/partial", signed: true },
  { method: "GET", path: "threads", signed: true },
  { method: "POST", path: "approvals/challenge", signed: true },
  { method: "POST", path: "approvals/respond", signed: true },
  { method: "POST", path: "feedback", signed: true },
  { method: "POST", path: "push/register", signed: true },
  { method: "POST", path: "companions", signed: true },
  { method: "POST", path: "gateway", signed: true },
  { method: "GET", path: "home", signed: true },
  { method: "POST", path: "home/act", signed: true },
  { method: "POST", path: "payloads/text/new", signed: true },
  { method: "POST", path: "threads", signed: true },
  { method: "GET", path: "threads/{threadId}", signed: true },
  { method: "GET", path: "threads/{threadId}/execution-stream", signed: true },
  { method: "GET", path: "threads/{threadId}/runs/{runId}/execution", signed: true },
  { method: "POST", path: "payloads/text", signed: true },
  { method: "POST", path: "attachments", signed: true },
  { method: "POST", path: "voice-timing", signed: true },
  { method: "POST", path: "uploads/begin", signed: true },
  { method: "POST", path: "perception", signed: true, uploadPurpose: "perception" },
  { method: "POST", path: "perception/media", signed: false, uploadPurpose: "media" },
  { method: "POST", path: "track", signed: true, uploadPurpose: "track" },
  { method: "POST", path: "mirror", signed: true },
  { method: "GET", path: "usage", signed: true },
  { method: "GET", path: "perception/deletions", signed: true },
  { method: "GET", path: "data-export/archive", signed: true },
  { method: "GET", path: "files/content/{fileId}", signed: true },
  { method: "POST", path: "usage/report", signed: true },
  { method: "GET", path: "actions", signed: true },
  { method: "POST", path: "actions/claim", signed: true },
  { method: "POST", path: "actions/result", signed: true },
  { method: "POST", path: "actions/open", signed: true },
  { method: "POST", path: "presence", signed: true },
  { method: "POST", path: "notifications/settled", signed: true },
  { method: "POST", path: "actions/supported", signed: true },
  { method: "POST", path: "actions/undo", signed: true },
  { method: "GET", path: "actions/policy", signed: true },
  { method: "POST", path: "actions/policy", signed: true },
  { method: "GET", path: "vault", signed: true },
  { method: "GET", path: "vault/usage", signed: true },
  { method: "POST", path: "vault/change", signed: true },
  { method: "POST", path: "vault/approve", signed: true },
  { method: "POST", path: "vault/deny", signed: true },
  { method: "POST", path: "speech", signed: true },
] as const);

export const DEVICE_UPLOAD_GRANT_HEADER = "himawari-upload-grant" as const;

const DEVICE_UPLOAD_PURPOSES: ReadonlyMap<string, UploadGrantPurpose> = new Map(
  DEVICE_API_ROUTES.flatMap((route) =>
    "uploadPurpose" in route ? [[route.path, route.uploadPurpose] as const] : [],
  ),
);

const DEVICE_ROUTE_PATTERNS = DEVICE_API_ROUTES.map((route) => ({
  method: route.method,
  pattern: new RegExp(
    `^${route.path.replace("{threadId}", THREAD_ID_SEGMENT).replace("{runId}", THREAD_ID_SEGMENT).replace("{fileId}", FILE_ID_SEGMENT)}$`,
    "u",
  ),
}));

export const DEVICE_PAYLOAD_TEXT_MAXIMUM_REFS = 100;
export const DEVICE_ACTION_VIEW_LIMIT = 100;
const DEVICE_ACTION_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export const DEVICE_PAYLOAD_TEXT_RESPONSE_BYTES = 4 * 1024 * 1024;

export const DEVICE_THREAD_EVENT_TYPES: ReadonlySet<string> = new Set([
  "thread.create",
  "thread.fork",
  "thread.rename",
  "thread.archive",
  "thread.restore",
  "thread.trash",
  "thread.delete_permanently",
  "thread.message.submit",
  "thread.message.submit_configured",
  "thread.message.commit_assistant",
  "thread.run.cancel",
  "thread.task.resolve",
]);

const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;
const UTTERANCE_ID_PATTERN = PERCEPTION_UTTERANCE_ID_PATTERN;
const MACHINE_STRING = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MESSAGE_TEXT_MAXIMUM = PLAIN_TEXT_MAXIMUM_CHARACTERS;
const ATTACHMENT_REQUEST_ID = /^[A-Za-z0-9_-]{16,96}$/u;
const ATTACHMENT_ENVELOPE_BYTES = 1024;
const UTF8_BYTES_PER_CHARACTER = 3;
export type DeviceTextClassification = TextAdmissionClassification;
const VOICE_KEYS = [
  "trigger",
  "speakerScore",
  "inputRoute",
  "inEar",
  "loudnessScore",
  "heardName",
] as const;
const VOICE_INPUT_ROUTES = ["airpods", "device_microphone", "wearable_microphone"] as const;
export interface UtterancePrefetchPort {
  prepare(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly deviceId: string;
    readonly utteranceId: string;
    readonly text: string;
  }): Promise<{ readonly prepared: boolean; readonly reason: string | null }>;
  settle(input: {
    readonly deviceId: string;
    readonly utteranceId: string;
    readonly finalText: string;
  }): void;
}

export const VOICE_COMMAND_UNCONFIRMED_CODE = "VOICE_COMMAND_UNCONFIRMED" as const;

function parseVoiceEvidence(value: unknown): VoiceEvidence | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const voice = value as Record<string, unknown>;
  if (Object.keys(voice).some((key) => !(VOICE_KEYS as readonly string[]).includes(key)))
    return null;
  const { trigger, speakerScore, inputRoute, inEar, loudnessScore, heardName } = voice;
  if (!(VOICE_TRIGGERS as readonly unknown[]).includes(trigger)) return null;
  if (speakerScore !== undefined && !isVoiceScore(speakerScore)) return null;
  if (loudnessScore !== undefined && !isVoiceScore(loudnessScore)) return null;
  if (inEar !== undefined && typeof inEar !== "boolean") return null;
  if (inputRoute !== undefined && !(VOICE_INPUT_ROUTES as readonly unknown[]).includes(inputRoute))
    return null;
  if (heardName !== undefined && (trigger === "hands_on" || !isHeardName(heardName))) return null;
  return {
    trigger: trigger as VoiceTrigger,
    speakerScore: (speakerScore as number | undefined) ?? null,
    inputRoute: (inputRoute as VoiceEvidence["inputRoute"] | undefined) ?? null,
    inEar: (inEar as boolean | undefined) ?? null,
    loudnessScore: (loudnessScore as number | undefined) ?? null,
    heardName: (heardName as string | undefined) ?? null,
  };
}

function isHeardName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const length = [...value].length;
  return (
    length >= 1 &&
    length <= VOICE_HEARD_NAME_MAXIMUM_CHARACTERS &&
    value.trim() === value &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

export interface DeviceApiAuthority {
  readonly agentId: string;
  readonly deploymentId: string;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
}

export type DeviceHomeResolution =
  | {
      readonly ok: true;
      readonly type: string;
      readonly payload: Readonly<Record<string, unknown>>;
      readonly ownerPresence: boolean;
      readonly dataClassification: string;
    }
  | {
      readonly ok: false;
      readonly reason: "binding_invalid" | "item_gone" | "action_not_offered" | "binding_stale";
    };

export interface DeviceHomePort {
  readonly resolveAction: (input: {
    readonly key: string;
    readonly action: string;
    readonly binding: string;
  }) => Promise<DeviceHomeResolution>;
}

export interface DeviceDownload {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly fileName: string;
}

export interface DeviceApiRouteOptions {
  readonly home?: DeviceHomePort;
  readonly signIn?: DeviceSignInService;
  readonly publicOrigin: URL;
  readonly devices: PairedDeviceService;
  readonly configuration: () => DeviceConfiguration;
  readonly authority: DeviceApiAuthority;
  readonly perception?: PerceptionService;
  readonly vault?: (scope: PairedDeviceScope) => VaultService | undefined;
  readonly actions?: {
    readonly service: (scope: PairedDeviceScope) => DeviceActionService | undefined;
    readonly hub: DeviceActionHub;
  };
  readonly notifications?: {
    readonly hub: DeviceNotificationHub;
    readonly presence: DevicePresence;
    readonly settled: (input: {
      readonly scope: PairedDeviceScope;
      readonly ids: readonly string[];
    }) => Promise<readonly string[]>;
  };
  readonly voiceGates?: () => VoiceGates;
  readonly prefetch?: UtterancePrefetchPort;
  readonly speech?: SpeechSynthesisPort;
  readonly threadGateway: AgentThreadGatewayPort;
  readonly gateways: DeviceGateways;
  readonly audit: AuditLedgerPort;
  readonly onAuditFailed?: (failure: DeviceGatewayAuditFailure) => void;
  readonly push?: DevicePushPort;
  readonly protectText: (input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly idempotencyKey: string;
    readonly content: string;
    readonly dataClassification?: DeviceTextClassification;
    readonly contentType?: DevicePayloadContentType;
  }) => Promise<string>;
  readonly chatAttachments?: () => DeviceChatAttachments;
  readonly recordVoiceTiming?: (input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly runId: string;
    readonly saidAt: string;
    readonly firstTextAt: string;
    readonly firstSoundAt: string | null;
  }) => Promise<"recorded" | "unknown_run">;
  readonly streamThreadEvents: (input: {
    readonly gateway: AgentThreadGatewayPort;
    readonly authentication: GatewayAuthenticationContext;
    readonly subscription: ThreadGatewaySubscription;
    readonly heartbeatMilliseconds: number;
    readonly revalidate: () => Promise<void>;
    readonly include: (event: ThreadGatewayEvent) => boolean;
  }) => AsyncGenerator<string>;
  readonly readPayload?: (input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly payloadRef: string;
  }) => Promise<{
    readonly content: string;
    readonly dataClassification: string;
    readonly contentType: string;
  }>;
  readonly exportArchive?: (input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly exportId: string;
  }) => DeviceDownload | undefined;
  readonly readFile?: (input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly fileId: string;
  }) => Promise<DeviceDownload>;
  readonly streamExecution?: (input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly subscription: ThreadExecutionEventsSubscription;
    readonly heartbeatMilliseconds: number;
    readonly revalidate: () => Promise<void>;
  }) => AsyncGenerator<string>;
  readonly webAuthenticate: (request: FastifyRequest) => Promise<GatewayAuthenticationContext>;
  readonly webMutationGuard: (
    request: FastifyRequest,
    authentication: GatewayAuthenticationContext,
  ) => Promise<void>;
  readonly setStreamHeaders: (reply: FastifyReply) => void;
  readonly sendJson: (reply: FastifyReply, statusCode: number, body: unknown) => FastifyReply;
  readonly rejectNotAllowed: () => never;
  readonly rejectBody: (statusCode: number) => never;
  readonly rejectError: (error: PairedDeviceError) => never;
  readonly now?: () => Date;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function presentVaultSnapshot(snapshot: Awaited<ReturnType<VaultService["snapshot"]>>) {
  return {
    manifest: snapshot.manifest
      ? { version: snapshot.manifest.version, signature: snapshot.manifest.signature }
      : null,
    items: snapshot.items.map((item) => ({
      id: item.id,
      name: item.name,
      kind: item.kind,
      origins: item.origins,
      fields: item.fields,
      version: item.version,
      backgroundAllowed: item.backgroundAllowed,
      wrappedKey: item.wrappedKey,
      ciphertexts: item.ciphertexts,
      updatedAt: item.updatedAt,
    })),
    pending: snapshot.pending.map((request) => ({
      id: request.id,
      nonce: request.nonce,
      itemIds: request.itemIds,
      itemVersions: request.itemVersions,
      origin: request.origin,
      pageVersion: request.pageVersion,
      ephemeralPublicKey: request.ephemeralPublicKey,
      expiresAt: request.expiresAt,
      createdAt: request.createdAt,
      purpose: request.purpose,
    })),
  };
}

function rawQuery(request: FastifyRequest): string {
  const index = request.url.indexOf("?");
  return index < 0 ? "" : request.url.slice(index + 1);
}

function downloadDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/gu, "_") || "file";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function requestPath(request: FastifyRequest): string {
  return request.url.split("?", 1)[0] ?? request.url;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApplicationPortError && error.code === PORT_ERROR_CODES.NOT_FOUND;
}

const HOME_ACT_REPLAY_WINDOW_MS = 10 * 60 * 1000;
const HOME_ACT_REPLAY_LIMIT = 256;

function stableSuffix(deviceId: string, messageId: string): string {
  return createHash("sha256").update(`${deviceId}\n${messageId}`).digest("hex").slice(0, 40);
}

export function presentPairedDevice(device: PairedDevice) {
  return {
    id: device.id,
    revision: device.revision,
    kind: device.kind,
    name: device.name,
    releaseChannel: device.releaseChannel,
    status: device.status,
    pairedAt: device.pairedAt,
    confirmedAt: device.confirmedAt,
    revokedAt: device.revokedAt,
    lastSeenAt: device.lastSeenAt,
  };
}

export type DevicePayloadContentType =
  | "text/plain"
  | "text/x-himawari-attachment"
  | "text/x-himawari-image";

export interface DeviceChatAttachments {
  readonly images: boolean;
}

export function presentDeviceAttachments(
  configuration: DeviceConfiguration,
  chat: DeviceChatAttachments,
) {
  const room = Math.max(
    0,
    configuration.limits["device.request.body_bytes"] - ATTACHMENT_ENVELOPE_BYTES,
  );
  return {
    textCharacters: Math.min(
      CHAT_ATTACHMENT_TEXT_CHARACTERS,
      Math.floor(room / UTF8_BYTES_PER_CHARACTER),
    ),
    imageCharacters: chat.images ? Math.min(CHAT_IMAGE_DATA_URL_CHARACTERS, room) : 0,
    perMessage: CHAT_ATTACHMENTS_PER_MESSAGE,
    messageCharacters: MESSAGE_TEXT_MAXIMUM,
  };
}

export function presentDeviceLimits(configuration: DeviceConfiguration) {
  return DEVICE_HARD_LIMIT_KEYS.map((key) => ({
    key,
    unit: DEVICE_HARD_LIMITS[key].unit,
    value: configuration.limits[key],
    defaultValue: DEVICE_HARD_LIMITS[key].defaultValue,
    onExceed: DEVICE_HARD_LIMITS[key].onExceed,
  }));
}

export async function presentDevicePerception(
  service: PerceptionService,
  scope: PairedDeviceScope,
) {
  const status = await service.status(scope);
  const settings = await service.settings(scope);
  const usage = await service.usage(scope);
  return {
    recordTextCharacters: PERCEPTION_TEXT_MAXIMUM,
    recordTypes: Object.fromEntries(
      Object.entries(PERCEPTION_RECORD_TYPES).map(([type, { sense, text, evidence }]) => [
        type,
        { sense, text, evidence },
      ]),
    ),
    mirrorKinds: DEVICE_MIRROR_KINDS,
    state: status.state,
    pausedUntil: status.pausedUntil,
    senses: PERCEPTION_SENSES.map((sense) => ({
      sense,
      enabled: status.senses.includes(sense),
    })),
    retentionDays: service.retentionDays(settings),
    deletionRevision: (await service.deletionFeed(scope, Number.MAX_SAFE_INTEGER)).revision,
    usageLimits: usage.limits.map(({ key, unit, limit, onReach, state }) => ({
      key,
      unit,
      limit,
      onReach,
      state,
    })),
  };
}

interface HeldDeviceStream {
  readonly path: string;
  readonly stream: Readable;
  readonly connection: NodeJS.EventEmitter & { destroy(): unknown };
  readonly openedAt: number;
}

const REOPEN_NUMBERS = ["lastConnected", "lastStatus", "lastError", "offline", "attempts"] as const;
const DROP_REASON = /^[A-Za-z]{1,24}$/;
const REPORTED_NUMBER = /^-?\d{1,9}$/;

function reopenReport(query: string): Partial<DeviceStreamDiagnostic> {
  const params = new URLSearchParams(query);
  const lastDrop = params.get("lastDrop");
  if (lastDrop === null || !DROP_REASON.test(lastDrop)) return {};
  const report: Record<string, string | number> = { lastDrop };
  for (const key of REOPEN_NUMBERS) {
    const value = params.get(key);
    if (value !== null && REPORTED_NUMBER.test(value)) report[key] = Number(value);
  }
  return report;
}

function holdDeviceStream(
  held: Map<string, HeldDeviceStream[]>,
  deviceId: string,
  path: string,
  stream: Readable,
  maximum: number,
  connection: NodeJS.EventEmitter & { destroy(): unknown },
  report: (diagnostic: DeviceStreamDiagnostic) => void,
): void {
  const open = held.get(deviceId) ?? [];
  const entry: HeldDeviceStream = { path, stream, connection, openedAt: Date.now() };
  const heldSeconds = (since: number) => Math.round((Date.now() - since) / 1000);
  while (open.length >= maximum) {
    const oldest = open.shift();
    if (!oldest) break;
    report({
      event: "device.stream_replaced",
      deviceId,
      path,
      heldSeconds: heldSeconds(oldest.openedAt),
    });
    oldest.stream.destroy();
    oldest.connection.destroy();
  }
  open.push(entry);
  held.set(deviceId, open);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    report({
      event: "device.stream_closed",
      deviceId,
      path,
      heldSeconds: heldSeconds(entry.openedAt),
    });
    const remaining = (held.get(deviceId) ?? []).filter((other) => other !== entry);
    if (remaining.length > 0) held.set(deviceId, remaining);
    else held.delete(deviceId);
  };
  stream.once("close", release);
  stream.once("error", release);
  connection.once("close", () => {
    release();
    stream.destroy();
  });
}

async function* bounded(
  source: AsyncGenerator<string>,
  maximumMilliseconds: number,
): AsyncGenerator<string> {
  const deadline = Date.now() + maximumMilliseconds;
  const iterator = source[Symbol.asyncIterator]();
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        yield `event: device.reconnect\ndata: ${JSON.stringify({ reasonCode: "CONNECTION_MAX_LIFETIME" })}\n\n`;
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        iterator.next(),
        new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => resolve("deadline"), remaining);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (next === "deadline") continue;
      if (next.done) return;
      yield next.value;
    }
  } finally {
    void iterator.return?.(undefined).catch(() => undefined);
  }
}

export function registerDeviceApiRoutes(app: FastifyInstance, options: DeviceApiRouteOptions) {
  const heldStreams = new Map<string, HeldDeviceStream[]>();
  const holdStream = (
    request: FastifyRequest,
    deviceId: string,
    stream: Readable,
    maximum: number,
    connection: NodeJS.EventEmitter & { destroy(): unknown },
  ) => {
    const path = request.url.slice(DEVICE_API_PREFIX.length + 1).split("?")[0] ?? "";
    options.devices.reportStream({
      event: "device.stream_opened",
      deviceId,
      path,
      ...reopenReport(rawQuery(request)),
    });
    holdDeviceStream(heldStreams, deviceId, path, stream, maximum, connection, (diagnostic) =>
      options.devices.reportStream(diagnostic),
    );
  };
  const scope = (authentication: GatewayAuthenticationContext): PairedDeviceScope =>
    ({
      ownerId: authentication.ownerId,
      agentId: options.authority.agentId,
    }) as PairedDeviceScope;
  const now = () => (options.now ?? (() => new Date()))();
  const homeActReplays = new Map<string, { readonly response: unknown; readonly at: number }>();

  app.register(
    async (device) => {
      device.addHook("onRoute", (route) => {
        route.bodyLimit = DEVICE_HARD_LIMITS["device.request.body_bytes"].maximum;
      });
      const uploads = new WeakMap<
        FastifyRequest,
        { readonly authorized: AuthorizedUpload; readonly device: AuthenticatedDeviceRequest }
      >();
      const bodyLimit = (request: FastifyRequest) =>
        uploads.get(request)?.authorized.grant.bytes ??
        options.configuration().limits["device.request.body_bytes"];
      const tooLarge = (request: FastifyRequest): Error => {
        const upload = uploads.get(request);
        if (upload)
          return new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.UPLOAD_TOO_LARGE, 413, {
            limit: upload.authorized.grant.bytes,
            key: "device.upload.file_bytes",
          });
        try {
          return options.rejectBody(413);
        } catch (error) {
          return error as Error;
        }
      };
      device.removeAllContentTypeParsers();
      device.addContentTypeParser("*", (request, payload, done) => {
        if (uploads.has(request)) return done(null, payload);
        const chunks: Buffer[] = [];
        payload.on("data", (chunk: Buffer) => chunks.push(chunk));
        payload.once("error", (error) => done(error));
        payload.once("end", () => done(null, Buffer.concat(chunks)));
      });
      device.addHook("preParsing", async (request, _reply, payload) => {
        const limit = bodyLimit(request);
        let received = 0;
        const bounded = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            received += chunk.length;
            if (received <= limit) return callback(null, chunk);
            callback(tooLarge(request));
          },
        });
        payload.once("error", (error) => bounded.destroy(error));
        return payload.pipe(bounded);
      });
      device.addHook("onRequest", async (request) => {
        const path = requestPath(request).slice(DEVICE_API_PREFIX.length + 1);
        if (
          !DEVICE_ROUTE_PATTERNS.some(
            (route) => route.method === request.method && route.pattern.test(path),
          )
        )
          options.rejectNotAllowed();
        const token = header(request, DEVICE_UPLOAD_GRANT_HEADER);
        const purpose = DEVICE_UPLOAD_PURPOSES.get(path);
        if (token !== undefined) {
          if (!options.perception) options.rejectNotAllowed();
          if (purpose === undefined || request.method !== "POST")
            throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.UPLOAD_GRANT_PATH, 403);
          const authorized = await (options.perception as PerceptionService).authorizeUpload({
            token,
            purpose,
          });
          uploads.set(request, {
            authorized,
            device: await options.devices.authenticateStored(authorized.grant.deviceId),
          });
        }
        const declared = Number(header(request, "content-length") ?? "0");
        if (Number.isFinite(declared) && declared > bodyLimit(request)) throw tooLarge(request);
      });

      const signed = (
        request: FastifyRequest,
      ): DeviceSignedRequest & { readonly body: Uint8Array } => {
        const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        if (body.length > options.configuration().limits["device.request.body_bytes"])
          options.rejectBody(413);
        return {
          method: request.method,
          authority: header(request, "host") ?? "",
          path: requestPath(request),
          rawQuery: rawQuery(request),
          signatureInput: header(request, "signature-input"),
          signature: header(request, "signature"),
          contentDigest: header(request, "content-digest"),
          contentType: header(request, "content-type"),
          body,
        };
      };
      const authenticate = (request: FastifyRequest) =>
        options.devices.authenticate({
          request: signed(request),
          expectedAuthority: options.publicOrigin.host,
        });
      const json = (request: FastifyRequest): Record<string, unknown> => {
        const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const type = header(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (type !== "application/json") options.rejectBody(415);
        try {
          const parsed: unknown = JSON.parse(body.toString("utf8"));
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            return parsed as Record<string, unknown>;
        } catch {}
        return options.rejectBody(400);
      };

      device.all("/", async () => options.rejectNotAllowed());
      device.all("/*", async () => options.rejectNotAllowed());

      const signIn = (): DeviceSignInService => options.signIn ?? options.rejectNotAllowed();

      device.get("/sign-in", async (_request, reply) =>
        options.sendJson(reply, 200, signIn().publicInfo()),
      );

      device.post("/sign-in/setup/options", async (request, reply) =>
        options.sendJson(reply, 200, await signIn().setupOptions(json(request))),
      );

      device.post("/sign-in/setup/finish", async (request, reply) =>
        options.sendJson(reply, 201, {
          device: presentPairedDevice(await signIn().setupFinish(json(request))),
        }),
      );

      device.post("/sign-in/options", async (request, reply) =>
        options.sendJson(reply, 200, await signIn().signInOptions(json(request))),
      );

      device.post("/sign-in/finish", async (request, reply) =>
        options.sendJson(reply, 200, {
          device: presentPairedDevice(await signIn().signInFinish(json(request))),
        }),
      );

      const deviceChange = (body: Record<string, unknown>, extra: readonly string[] = []) => {
        only(body, ["deviceId", "expectedRevision", ...extra]);
        if (
          typeof body["deviceId"] !== "string" ||
          !/^dev_[A-Za-z0-9_-]{22}$/u.test(body["deviceId"]) ||
          !Number.isSafeInteger(body["expectedRevision"]) ||
          (body["expectedRevision"] as number) < 0
        )
          options.rejectBody(400);
        return {
          deviceId: body["deviceId"] as string,
          expectedRevision: body["expectedRevision"] as number,
        };
      };

      device.get("/devices", async (request, reply) => {
        const authenticated = await authenticate(request);
        const devices = await options.devices.list(scope(authenticated.authentication));
        return options.sendJson(reply, 200, {
          thisDeviceId: authenticated.device.id,
          devices: devices
            .filter((listed) => listed.status === "active")
            .map((listed) => ({
              ...presentPairedDevice(listed),
              online: (heldStreams.get(listed.id) ?? []).some((held) => held.path === "stream"),
            })),
          server: {
            origin: options.publicOrigin.origin,
            since: options.signIn ? await options.signIn.firstPasskeyAt() : null,
          },
        });
      });

      device.post("/devices/rename", async (request, reply) => {
        const authenticated = await authenticate(request);
        const body = json(request);
        const target = deviceChange(body, ["name"]);
        if (typeof body["name"] !== "string") options.rejectBody(400);
        const renamed = await options.devices.rename({
          ...scope(authenticated.authentication),
          ...target,
          name: body["name"] as string,
        });
        return options.sendJson(reply, 200, { device: presentPairedDevice(renamed) });
      });

      device.post("/devices/revoke", async (request, reply) => {
        const authenticated = await authenticate(request);
        const target = deviceChange(json(request));
        if (target.deviceId !== authenticated.device.id && !authenticated.confirmed)
          throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.CONFIRMATION_REQUIRED, 403);
        const revoked = await options.devices.revoke({
          ...scope(authenticated.authentication),
          ...target,
        });
        return options.sendJson(reply, 200, { device: presentPairedDevice(revoked) });
      });

      device.get("/config", async (request, reply) => {
        const authenticated = await authenticate(request);
        const configuration = options.configuration();
        return options.sendJson(reply, 200, {
          heartbeatSeconds: configuration.heartbeatSeconds,
          connectionMaxSeconds: configuration.connectionMaxSeconds,
          streamConnections: configuration.streamConnections,
          signatureToleranceSeconds: configuration.signatureToleranceSeconds,
          limits: presentDeviceLimits(configuration),
          ...(options.chatAttachments
            ? { attachments: presentDeviceAttachments(configuration, options.chatAttachments()) }
            : {}),
          ...(options.perception
            ? {
                perception: await presentDevicePerception(
                  options.perception,
                  scope(authenticated.authentication),
                ),
              }
            : {}),
        });
      });

      const perception = (): PerceptionService => options.perception ?? options.rejectNotAllowed();
      const only = (body: Record<string, unknown>, keys: readonly string[]) => {
        if (Object.keys(body).some((key) => !keys.includes(key))) options.rejectBody(400);
      };
      const receiveUpload = async (
        request: FastifyRequest,
        reply: FastifyReply,
        upload: {
          readonly authorized: AuthorizedUpload;
          readonly device: AuthenticatedDeviceRequest;
        },
      ) => {
        const service = perception();
        const source = request.body as Readable;
        if (upload.authorized.replay !== null) {
          source.resume();
          return options.sendJson(reply, 200, upload.authorized.replay);
        }
        const encoding = header(request, "content-encoding")?.trim().toLowerCase();
        if (encoding !== undefined && encoding !== "gzip" && encoding !== "identity")
          options.rejectBody(415);
        const file = service.temporaryUploadPath();
        const hash = createHash("sha256");
        let bytes = 0;
        try {
          await pipeline(
            source,
            new Transform({
              transform(chunk: Buffer, _encoding, callback) {
                bytes += chunk.length;
                hash.update(chunk);
                callback(null, chunk);
              },
            }),
            createWriteStream(file, { flags: "wx", mode: 0o600 }),
          );
        } catch (error) {
          await rm(file, { force: true });
          throw error;
        }
        const result = await service.consumeUpload({
          scope: scope(upload.device.authentication),
          authentication: upload.device.authentication,
          grant: upload.authorized.grant,
          upload: { file, bytes, sha256: hash.digest("hex"), gzip: encoding === "gzip" },
        });
        return options.sendJson(reply, 200, result);
      };

      device.post("/uploads/begin", async (request, reply) => {
        const authenticated = await authenticate(request);
        const granted = await perception().beginUpload({
          scope: scope(authenticated.authentication),
          deviceId: authenticated.device.id,
          body: json(request),
        });
        return options.sendJson(reply, 201, {
          grant: granted.grant,
          expiresAt: granted.expiresAt,
          path: `${DEVICE_API_PREFIX}/${granted.path}`,
          header: DEVICE_UPLOAD_GRANT_HEADER,
        });
      });

      device.post("/perception", async (request, reply) => {
        const upload = uploads.get(request);
        if (upload) return receiveUpload(request, reply, upload);
        const authenticated = await authenticate(request);
        const body = json(request);
        only(body, ["records"]);
        return options.sendJson(
          reply,
          200,
          await perception().ingest({
            scope: scope(authenticated.authentication),
            authentication: authenticated.authentication,
            deviceId: authenticated.device.id,
            records: body["records"],
          }),
        );
      });

      device.post("/perception/media", async (request, reply) => {
        const upload = uploads.get(request);
        if (!upload)
          throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.UPLOAD_GRANT_INVALID, 401);
        return receiveUpload(request, reply, upload);
      });

      device.post("/track", async (request, reply) => {
        const upload = uploads.get(request);
        if (upload) return receiveUpload(request, reply, upload);
        const authenticated = await authenticate(request);
        const body = json(request);
        only(body, ["points"]);
        return options.sendJson(
          reply,
          200,
          await perception().track({
            scope: scope(authenticated.authentication),
            deviceId: authenticated.device.id,
            points: body["points"],
          }),
        );
      });

      device.post("/mirror", async (request, reply) => {
        const authenticated = await authenticate(request);
        return options.sendJson(
          reply,
          200,
          await perception().syncMirror({
            scope: scope(authenticated.authentication),
            deviceId: authenticated.device.id,
            body: json(request),
          }),
        );
      });

      device.get("/usage", async (request, reply) => {
        const authenticated = await authenticate(request);
        return options.sendJson(
          reply,
          200,
          await perception().usage(scope(authenticated.authentication)),
        );
      });

      device.get("/perception/deletions", async (request, reply) => {
        const authenticated = await authenticate(request);
        const query = new URLSearchParams(rawQuery(request));
        const after = query.get("after") ?? "0";
        if (
          [...query.keys()].some((name) => name !== "after") ||
          query.getAll("after").length > 1 ||
          !/^\d{1,15}$/u.test(after)
        )
          return options.rejectBody(400);
        const feed = await perception().deletionFeed(
          scope(authenticated.authentication),
          Number(after),
        );
        const last = feed.scopes.at(-1)?.revision;
        return options.sendJson(reply, 200, {
          revision: last ?? feed.revision,
          latest: feed.revision,
          scopes: feed.scopes.map((entry) => ({
            revision: entry.revision,
            kind: entry.kind,
            deviceId: entry.deviceId,
            day: entry.day,
            types: entry.types,
            recordIds: entry.recordIds,
            includesTrack: entry.track,
            through: new Date(entry.boundMs).toISOString(),
          })),
        });
      });

      const sendDownload = (reply: FastifyReply, download: DeviceDownload): FastifyReply =>
        reply
          .code(200)
          .header("cache-control", "no-store")
          .header("referrer-policy", "no-referrer")
          .header("x-content-type-options", "nosniff")
          .header("content-disposition", downloadDisposition(download.fileName))
          .type(download.mediaType)
          .send(Buffer.from(download.bytes));

      device.get("/data-export/archive", async (request, reply) => {
        const authenticated = await authenticate(request);
        const exportArchive = options.exportArchive ?? options.rejectNotAllowed();
        const query = new URLSearchParams(rawQuery(request));
        const exportId = query.get("exportId");
        if (
          [...query.keys()].some((key) => key !== "exportId") ||
          query.getAll("exportId").length !== 1 ||
          exportId === null ||
          !DATA_EXPORT_ID_PATTERN.test(exportId)
        )
          return options.rejectBody(400);
        const download = exportArchive({ authentication: authenticated.authentication, exportId });
        if (!download)
          throw new ApplicationPortError(PORT_ERROR_CODES.NOT_FOUND, "Data export was not found");
        return sendDownload(reply, download);
      });

      device.get("/files/content/:fileId", async (request, reply) => {
        const authenticated = await authenticate(request);
        const readFile = options.readFile ?? options.rejectNotAllowed();
        if (rawQuery(request) !== "") return options.rejectBody(400);
        const fileId = (request.params as { readonly fileId: string }).fileId;
        return sendDownload(
          reply,
          await readFile({ authentication: authenticated.authentication, fileId }),
        );
      });

      device.post("/speech", async (request, reply) => {
        await authenticate(request);
        const body = json(request);
        only(body, ["text"]);
        const text = body["text"];
        if (typeof text !== "string") return options.rejectBody(400);
        if (!options.speech) return options.sendJson(reply, 503, { code: "SPEECH_UNAVAILABLE" });
        const abort = new AbortController();
        request.raw.once("close", () => abort.abort());
        let audio: Awaited<ReturnType<SpeechSynthesisPort["synthesize"]>>;
        try {
          audio = await options.speech.synthesize({ text, signal: abort.signal });
        } catch (error) {
          const code =
            error instanceof SpeechSynthesisError ? error.code : SPEECH_ERROR_CODES.UPSTREAM_FAILED;
          request.log.warn(
            {
              event: "speech.failed",
              code,
              ...(error instanceof SpeechSynthesisError && error.upstreamStatus !== undefined
                ? { upstreamStatus: error.upstreamStatus }
                : {}),
            },
            "speech synthesis failed",
          );
          const status =
            code === SPEECH_ERROR_CODES.INPUT_INVALID || code === SPEECH_ERROR_CODES.SENSITIVE_TEXT
              ? 422
              : code === SPEECH_ERROR_CODES.FIRST_AUDIO_TIMEOUT
                ? 504
                : 502;
          return options.sendJson(reply, status, { code });
        }
        const started = performance.now();
        let bytes = 0;
        const log = request.log;
        const counted = Readable.from(
          (async function* () {
            let completed = false;
            try {
              for await (const chunk of audio.chunks) {
                bytes += chunk.byteLength;
                yield Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
              }
              completed = true;
            } finally {
              log.info(
                {
                  event: "speech.synthesized",
                  completed,
                  characters: audio.characters,
                  firstAudioMs: audio.firstAudioMs,
                  streamMs: Math.round(performance.now() - started),
                  bytes,
                },
                "speech synthesized",
              );
            }
          })(),
        );
        return reply
          .code(200)
          .header("cache-control", "no-store")
          .header("x-himawari-speech-first-audio-ms", String(audio.firstAudioMs))
          .header("x-himawari-speech-sample-rate", String(audio.sampleRate))
          .type(audio.mediaType)
          .send(counted);
      });

      device.post("/usage/report", async (request, reply) => {
        const authenticated = await authenticate(request);
        await perception().reportDeviceUsage({
          scope: scope(authenticated.authentication),
          deviceId: authenticated.device.id,
          body: json(request),
        });
        return options.sendJson(reply, 200, { accepted: true });
      });

      const actions = (authenticated: AuthenticatedDeviceRequest): DeviceActionService =>
        options.actions?.service(scope(authenticated.authentication)) ?? options.rejectNotAllowed();

      device.get("/actions", async (request, reply) => {
        const authenticated = await authenticate(request);
        const query = new URLSearchParams(rawQuery(request));
        const finishedSince = query.get("finishedSince");
        if (
          [...query.keys()].some((key) => key !== "finishedSince") ||
          (finishedSince !== null &&
            (!DEVICE_ACTION_TIMESTAMP.test(finishedSince) ||
              Number.isNaN(Date.parse(finishedSince))))
        )
          options.rejectBody(400);
        return options.sendJson(reply, 200, {
          actions: await actions(authenticated).views({
            deviceId: authenticated.device.id,
            limit: DEVICE_ACTION_VIEW_LIMIT,
            ...(finishedSince === null
              ? { states: DEVICE_ACTION_OPEN_STATES }
              : { states: DEVICE_ACTION_RECORD_STATES, finishedSince }),
          }),
        });
      });

      device.post("/actions/claim", async (request, reply) => {
        const authenticated = await authenticate(request);
        only(json(request), []);
        return options.sendJson(reply, 200, {
          actions: await actions(authenticated).claim(authenticated.device.id),
        });
      });

      device.post("/presence", async (request, reply) => {
        const authenticated = await authenticate(request);
        if (authenticated.device.kind !== "mac") options.rejectNotAllowed();
        const notifications = options.notifications;
        if (!notifications)
          return options.sendJson(reply, 200, { ok: false, reason: "unavailable" });
        const body = json(request);
        const lastInputAt = body["lastInputAt"];
        if (
          Object.keys(body).some((key) => key !== "lastInputAt") ||
          typeof lastInputAt !== "string" ||
          !ISO_MILLISECONDS.test(lastInputAt)
        )
          options.rejectBody(400);
        const reported = Date.parse(lastInputAt as string);
        if (!Number.isFinite(reported)) options.rejectBody(400);
        const serverTime = now();
        notifications.presence.record(
          authenticated.device.id,
          Math.min(reported, serverTime.getTime()),
        );
        return options.sendJson(reply, 200, { ok: true, serverTime: serverTime.toISOString() });
      });

      device.post("/notifications/settled", async (request, reply) => {
        const authenticated = await authenticate(request);
        const notifications = options.notifications;
        if (!notifications) return options.sendJson(reply, 200, { settledIds: [] });
        const body = json(request);
        const ids = body["ids"];
        if (
          Object.keys(body).some((key) => key !== "ids") ||
          !Array.isArray(ids) ||
          ids.length > SETTLED_MAXIMUM_IDS ||
          ids.some((id) => typeof id !== "string" || !NOTIFICATION_ID.test(id))
        )
          options.rejectBody(400);
        return options.sendJson(reply, 200, {
          settledIds: await notifications.settled({
            scope: scope(authenticated.authentication),
            ids: ids as string[],
          }),
        });
      });

      device.post("/actions/open", async (request, reply) => {
        const authenticated = await authenticate(request);
        only(json(request), []);
        return options.sendJson(reply, 200, {
          actions: await actions(authenticated).reopen(authenticated.device.id),
        });
      });

      device.post("/actions/result", async (request, reply) => {
        const authenticated = await authenticate(request);
        const result = await actions(authenticated).report(authenticated.device.id, json(request));
        if ("state" in result)
          return options.sendJson(reply, 200, {
            state: result.state,
            replayed: result.kind === "replayed",
          });
        if (result.kind === "invalid") return options.rejectBody(400);
        return options.sendJson(reply, result.kind === "not_found" ? 404 : 409, {
          code: `DEVICE_ACTION_${result.kind.toUpperCase()}`,
        });
      });

      device.post("/actions/undo", async (request, reply) => {
        const authenticated = await authenticate(request);
        const body = json(request);
        only(body, ["id"]);
        if (typeof body["id"] !== "string" || !DEVICE_ACTION_ID_PATTERN.test(body["id"]))
          return options.rejectBody(400);
        const outcome = await actions(authenticated).undo({
          device: authenticated.device,
          actionId: body["id"],
          ownerPresent: authenticated.confirmed,
        });
        if (outcome.kind === "not_found" || outcome.kind === "not_undoable")
          return options.sendJson(reply, outcome.kind === "not_found" ? 404 : 409, {
            code: `DEVICE_ACTION_${outcome.kind.toUpperCase()}`,
          });
        if (outcome.kind !== "recorded")
          return options.sendJson(reply, 409, { code: "DEVICE_ACTION_NOT_UNDOABLE" });
        return options.sendJson(reply, 200, { id: outcome.actionId, state: outcome.state });
      });

      device.post("/actions/supported", async (request, reply) => {
        const authenticated = await authenticate(request);
        const body = json(request);
        only(body, ["actions"]);
        const kept = await actions(authenticated).reportSupported(
          authenticated.device,
          body["actions"],
        );
        if (!kept) options.rejectBody(400);
        return options.sendJson(reply, 200, { actions: kept });
      });

      const vault = (authenticated: AuthenticatedDeviceRequest): VaultService =>
        options.vault?.(scope(authenticated.authentication)) ?? options.rejectNotAllowed();

      device.get("/vault", async (request, reply) => {
        const authenticated = await authenticate(request);
        const snapshot = await vault(authenticated).snapshot(scope(authenticated.authentication));
        return options.sendJson(reply, 200, presentVaultSnapshot(snapshot));
      });

      device.get("/vault/usage", async (request, reply) => {
        const authenticated = await authenticate(request);
        const itemId = new URLSearchParams(rawQuery(request)).get("itemId");
        const entries = await vault(authenticated).usage(
          scope(authenticated.authentication),
          itemId,
        );
        return options.sendJson(reply, 200, { usage: entries });
      });

      device.post("/vault/change", async (request, reply) => {
        const authenticated = await authenticate(request);
        const manifest = await vault(authenticated).applyDeviceChange(
          scope(authenticated.authentication),
          json(request),
        );
        return options.sendJson(reply, 200, { manifest });
      });

      device.post("/vault/approve", async (request, reply) => {
        const authenticated = await authenticate(request);
        await vault(authenticated).approve(
          scope(authenticated.authentication),
          { deviceId: authenticated.device.id, confirmed: authenticated.confirmed },
          json(request),
        );
        return options.sendJson(reply, 200, { approved: true });
      });

      device.post("/vault/deny", async (request, reply) => {
        const authenticated = await authenticate(request);
        await vault(authenticated).deny(scope(authenticated.authentication), json(request));
        return options.sendJson(reply, 200, { denied: true });
      });

      device.get("/actions/policy", async (request, reply) => {
        const authenticated = await authenticate(request);
        return options.sendJson(
          reply,
          200,
          await actions(authenticated).policy(authenticated.device),
        );
      });

      device.post("/actions/policy", async (request, reply) => {
        const authenticated = await authenticate(request);
        const body = json(request);
        only(body, ["expectedRevision", "blockedActions"]);
        const service = actions(authenticated);
        const outcome = await service.changePolicy({
          device: authenticated.device,
          ownerPresent: authenticated.confirmed,
          expectedRevision: body["expectedRevision"],
          blockedActions: body["blockedActions"],
        });
        if (outcome === "invalid") options.rejectBody(400);
        if (outcome === "owner_presence_required")
          return options.sendJson(reply, 403, { code: "DEVICE_OWNER_PRESENCE_REQUIRED" });
        if (outcome === "revision_conflict")
          return options.sendJson(reply, 409, {
            code: "DEVICE_POLICY_REVISION_CONFLICT",
            ...(await service.policy(authenticated.device)),
          });
        return options.sendJson(reply, 200, await service.policy(authenticated.device));
      });

      const envelope = (
        authenticated: {
          readonly authentication: GatewayAuthenticationContext;
          readonly device: PairedDevice;
        },
        kind: "query" | "command" | "subscription",
        type: string,
        messageId: string,
      ) => ({
        schemaVersion: THREAD_GATEWAY_SCHEMA_VERSION,
        kind,
        type,
        messageId,
        correlationId: `device:${authenticated.device.id}`,
        causationId: null,
        scope: {
          ownerId: authenticated.authentication.ownerId,
          agentId: options.authority.agentId,
        },
        authority: {
          deploymentId: options.authority.deploymentId,
          authorityEpoch: options.authority.authorityEpoch,
          fencingToken: options.authority.fencingToken,
        },
        actor: { actorType: "owner", actorId: authenticated.authentication.ownerId },
      });

      device.get("/threads", async (request, reply) => {
        const authenticated = await authenticate(request);
        const query = new URLSearchParams(rawQuery(request));
        const afterCursor = query.get("after");
        if (afterCursor !== null && !MACHINE_STRING.test(afterCursor)) options.rejectBody(400);
        const response = await options.threadGateway.request(
          authenticated.authentication,
          threadGatewayMessageSchema.parse({
            ...envelope(
              authenticated,
              "query",
              "thread.list",
              `device-query:${stableSuffix(authenticated.device.id, now().toISOString())}`,
            ),
            payload: {
              statuses: ["active"],
              pinnedOnly: false,
              afterCursor,
              limit: 100,
            },
          }) as ThreadGatewayRequestMessage,
        );
        return options.sendJson(reply, 200, response);
      });

      const threadIdOf = (request: FastifyRequest) => {
        const threadId = requestPath(request)
          .slice(DEVICE_API_PREFIX.length + "/threads/".length)
          .split("/", 1)[0];
        if (!threadId || !MACHINE_STRING.test(threadId)) options.rejectBody(400);
        return threadId as string;
      };

      device.post("/threads", async (request, reply) => {
        const authenticated = await authenticate(request);
        const { authentication } = authenticated;
        const body = json(request);
        if (
          Object.keys(body).some((key) => !["requestId", "answerLocale"].includes(key)) ||
          typeof body["requestId"] !== "string" ||
          !MESSAGE_ID_PATTERN.test(body["requestId"]) ||
          !["zh-CN", "en", "ja"].includes(String(body["answerLocale"]))
        )
          options.rejectBody(400);
        const suffix = stableSuffix(authenticated.device.id, `thread:${body["requestId"]}`);
        const resultRef = await options.protectText({
          authentication,
          idempotencyKey: `device-thread-result:${suffix}`,
          content: "thread-action:create",
        });
        const command = threadGatewayMessageSchema.parse({
          ...envelope(authenticated, "command", "thread.create", `command:thread:${suffix}`),
          idempotencyKey: `device-thread:${suffix}`,
          payload: {
            threadId: `thread-device-${suffix.slice(0, 32)}`,
            answerLocale: body["answerLocale"],
            resultRef,
          },
        }) as ThreadGatewayRequestMessage;
        return options.sendJson(
          reply,
          200,
          await options.threadGateway.request(authentication, command),
        );
      });

      device.get("/threads/*", async (request, reply) => {
        const authenticated = await authenticate(request);
        const { authentication } = authenticated;
        const threadId = threadIdOf(request);
        const segments = requestPath(request)
          .slice(DEVICE_API_PREFIX.length + "/threads/".length)
          .split("/");
        if (segments.length === 2 && segments[1] === "execution-stream") {
          if (!options.streamExecution) return options.rejectNotAllowed();
          const configuration = options.configuration();
          const subscription = threadGatewayMessageSchema.parse({
            ...envelope(
              authenticated,
              "subscription",
              "thread.execution_events",
              `device-execution:${stableSuffix(authenticated.device.id, `${threadId}\n${now().toISOString()}`)}`,
            ),
            payload: { threadId },
          }) as ThreadExecutionEventsSubscription;
          const stream = Readable.from(
            bounded(
              options.streamExecution({
                authentication,
                subscription,
                heartbeatMilliseconds: configuration.heartbeatSeconds * 1000,
                revalidate: async () => {
                  if (!(await options.devices.stillActive(authenticated.device.id)))
                    throw new Error(PAIRED_DEVICE_ERROR_CODES.DEVICE_REVOKED);
                },
              }),
              configuration.connectionMaxSeconds * 1000,
            ),
          );
          holdStream(
            request,
            authenticated.device.id,
            stream,
            configuration.streamConnections,
            reply.raw,
          );
          try {
            options.setStreamHeaders(reply);
            return reply.send(stream);
          } catch (error) {
            stream.destroy();
            throw error;
          }
        }
        const after = new URLSearchParams(rawQuery(request)).get("after") ?? "0";
        if (!/^(0|[1-9][0-9]{0,15})$/u.test(after)) options.rejectBody(400);
        const runId = segments.length === 4 ? segments[2] : undefined;
        if (runId !== undefined && !MACHINE_STRING.test(runId)) options.rejectBody(400);
        const query = threadGatewayMessageSchema.parse({
          ...envelope(
            authenticated,
            "query",
            runId === undefined ? "thread.detail" : "thread.execution",
            `device-query:${stableSuffix(authenticated.device.id, `${threadId}\n${runId ?? ""}\n${now().toISOString()}`)}`,
          ),
          payload: {
            threadId,
            ...(runId === undefined ? {} : { runId }),
            afterSequence: Number(after),
            limit: 200,
          },
        }) as ThreadGatewayRequestMessage;
        return options.sendJson(
          reply,
          200,
          await options.threadGateway.request(authentication, query),
        );
      });

      device.post("/payloads/text", async (request, reply) => {
        const { authentication } = await authenticate(request);
        if (!options.readPayload) return options.rejectNotAllowed();
        const body = json(request);
        const refs = body["refs"];
        if (
          Object.keys(body).some((key) => key !== "refs") ||
          !Array.isArray(refs) ||
          refs.length === 0 ||
          refs.some((ref) => typeof ref !== "string" || !MACHINE_STRING.test(ref)) ||
          new Set(refs).size !== refs.length
        )
          options.rejectBody(400);
        if ((refs as string[]).length > DEVICE_PAYLOAD_TEXT_MAXIMUM_REFS) options.rejectBody(413);
        const readPayload = options.readPayload;
        const items: Record<string, unknown> = {};
        const deferred: string[] = [];
        let responseBytes = 0;
        for (const payloadRef of refs as string[]) {
          if (deferred.length > 0) {
            deferred.push(payloadRef);
            continue;
          }
          try {
            const payload = await readPayload({ authentication, payloadRef });
            const item = {
              text: payload.content,
              contentType: payload.contentType,
              dataClassification: payload.dataClassification,
            };
            const bytes = Buffer.byteLength(JSON.stringify(item), "utf8");
            if (responseBytes > 0 && responseBytes + bytes > DEVICE_PAYLOAD_TEXT_RESPONSE_BYTES) {
              deferred.push(payloadRef);
              continue;
            }
            responseBytes += bytes;
            items[payloadRef] = item;
          } catch (error) {
            if (!isNotFound(error)) throw error;
            items[payloadRef] = null;
          }
        }
        return options.sendJson(reply, 200, { items, deferred });
      });

      device.post("/messages", async (request, reply) => {
        const authenticated = await authenticate(request);
        const { authentication } = authenticated;
        const body = json(request);
        if (
          Object.keys(body).some(
            (key) =>
              ![
                "messageId",
                "threadId",
                "expectedRevision",
                "text",
                "utteranceId",
                "voice",
                "spoken",
              ].includes(key),
          ) ||
          (body["spoken"] !== undefined &&
            (body["spoken"] !== true || body["voice"] !== undefined)) ||
          (body["voice"] !== undefined &&
            (body["utteranceId"] === undefined || parseVoiceEvidence(body["voice"]) === null)) ||
          (body["utteranceId"] !== undefined &&
            (typeof body["utteranceId"] !== "string" ||
              !UTTERANCE_ID_PATTERN.test(body["utteranceId"]))) ||
          typeof body["messageId"] !== "string" ||
          !MESSAGE_ID_PATTERN.test(body["messageId"]) ||
          typeof body["threadId"] !== "string" ||
          !MACHINE_STRING.test(body["threadId"]) ||
          !Number.isSafeInteger(body["expectedRevision"]) ||
          (body["expectedRevision"] as number) < 1 ||
          typeof body["text"] !== "string" ||
          body["text"].trim().length === 0 ||
          body["text"].length > MESSAGE_TEXT_MAXIMUM
        )
          options.rejectBody(400);
        let heardByPhone = false;
        if (body["voice"] !== undefined) {
          const evidence = parseVoiceEvidence(body["voice"]) as VoiceEvidence;
          const verdict = decideVoiceCommand(evidence, options.voiceGates?.());
          if (!verdict.accepted)
            return options.sendJson(reply, 409, {
              error: { code: VOICE_COMMAND_UNCONFIRMED_CODE, reason: verdict.reason },
            });
          heardByPhone = evidence.trigger !== "hands_on";
        }
        if (typeof body["utteranceId"] === "string")
          options.prefetch?.settle({
            deviceId: authenticated.device.id,
            utteranceId: body["utteranceId"],
            finalText: body["text"] as string,
          });
        const suffix = stableSuffix(authenticated.device.id, body["messageId"] as string);
        const contentRef = await options.protectText({
          authentication,
          idempotencyKey: `device-content:${suffix}`,
          content: body["text"] as string,
        });
        const resultRef = await options.protectText({
          authentication,
          idempotencyKey: `device-result:${suffix}`,
          content: "thread-action:submit",
        });
        const idempotencyKey = `device-message:${suffix}`;
        const command = threadGatewayMessageSchema.parse({
          schemaVersion: THREAD_GATEWAY_SCHEMA_VERSION,
          kind: "command",
          type: "thread.message.submit",
          messageId: `command:${suffix}`,
          correlationId: `correlation:${suffix}`,
          causationId: null,
          scope: { ownerId: authentication.ownerId, agentId: options.authority.agentId },
          authority: {
            deploymentId: options.authority.deploymentId,
            authorityEpoch: options.authority.authorityEpoch,
            fencingToken: options.authority.fencingToken,
          },
          actor: { actorType: "owner", actorId: authentication.ownerId },
          idempotencyKey,
          payload: {
            threadId: body["threadId"],
            expectedRevision: body["expectedRevision"],
            messageId: `message:${suffix}`,
            turnId: `turn:${suffix}`,
            runId: `run:${suffix}`,
            sessionId: authentication.sessionId,
            contentRef,
            sourceProofRef: `${heardByPhone ? PHONE_VOICE_PROOF_PREFIX : body["spoken"] === true ? TALK_PROOF_PREFIX : "device:"}${authenticated.device.id}`,
            dataClassification: "private",
            occurredAt: now().toISOString(),
            resultRef,
          },
        }) as ThreadGatewayRequestMessage;
        const accepted = await options.threadGateway.request(authentication, command);
        if (typeof body["utteranceId"] === "string" && options.perception)
          await options.perception.recordCommandUtterance(
            scope(authentication),
            body["utteranceId"],
          );
        return options.sendJson(reply, 200, accepted);
      });

      device.post("/voice-timing", async (request, reply) => {
        const { device: paired, authentication } = await authenticate(request);
        if (!options.recordVoiceTiming) return options.rejectNotAllowed();
        const body = json(request);
        only(body, ["messageId", "saidAt", "firstTextAt", "firstSoundAt"]);
        const { messageId, saidAt, firstTextAt, firstSoundAt } = body;
        const instant = (value: unknown): value is string =>
          typeof value === "string" &&
          ISO_MILLISECONDS.test(value) &&
          !Number.isNaN(Date.parse(value));
        if (
          typeof messageId !== "string" ||
          !MESSAGE_ID_PATTERN.test(messageId) ||
          !instant(saidAt) ||
          !instant(firstTextAt) ||
          (firstSoundAt !== null && !instant(firstSoundAt))
        )
          return options.rejectBody(400);
        const outcome = await options.recordVoiceTiming({
          authentication,
          runId: `run:${stableSuffix(paired.id, messageId)}`,
          saidAt,
          firstTextAt,
          firstSoundAt,
        });
        if (outcome === "unknown_run") return options.rejectBody(404);
        return options.sendJson(reply, 200, { recorded: true });
      });

      device.post("/attachments", async (request, reply) => {
        const { device: paired, authentication } = await authenticate(request);
        const chat = options.chatAttachments?.();
        if (!chat) return options.rejectNotAllowed();
        const body = json(request);
        only(body, ["requestId", "content", "as"]);
        const { requestId, content } = body;
        const kind = body["as"];
        if (
          typeof requestId !== "string" ||
          !ATTACHMENT_REQUEST_ID.test(requestId) ||
          typeof content !== "string" ||
          content.length === 0 ||
          (kind !== "text" && kind !== "image")
        )
          return options.rejectBody(400);
        if (kind === "image" && !chat.images) return options.rejectBody(415);
        const limits = presentDeviceAttachments(options.configuration(), chat);
        if (content.length > (kind === "image" ? limits.imageCharacters : limits.textCharacters))
          return options.rejectBody(413);
        if (kind === "image" && !CHAT_IMAGE_DATA_URL.test(content)) return options.rejectBody(400);
        const ref = await options.protectText({
          authentication,
          idempotencyKey: `device-attachment:${stableSuffix(paired.id, requestId)}`,
          content,
          contentType: kind === "image" ? "text/x-himawari-image" : "text/x-himawari-attachment",
        });
        return options.sendJson(reply, 201, { ref });
      });

      device.post("/payloads/text/new", async (request, reply) => {
        const { device: paired, authentication } = await authenticate(request);
        const { idempotencyKey, ...text } = json(request);
        const admitted = parseTextAdmission(text, PLAIN_TEXT_MAXIMUM_CHARACTERS);
        if (
          typeof idempotencyKey !== "string" ||
          !MESSAGE_ID_PATTERN.test(idempotencyKey) ||
          !admitted
        )
          return options.rejectBody(400);
        const payloadRef = await options.protectText({
          authentication,
          idempotencyKey: `device-text:${stableSuffix(paired.id, idempotencyKey)}`,
          ...admitted,
        });
        return options.sendJson(reply, 201, { payloadRef });
      });

      device.post("/approvals/challenge", async (request, reply) => {
        const { device: paired } = await authenticate(request);
        return options.sendJson(reply, 201, options.devices.issueConfirmChallenge(paired.id));
      });

      const pushPort = (): DevicePushPort => {
        if (!options.push) throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.NOT_CONFIGURED, 503);
        return options.push;
      };

      device.post("/push/register", async (request, reply) => {
        const authenticated = await authenticate(request);
        return options.sendJson(
          reply,
          200,
          await pushPort().register({
            scope: scope(authenticated.authentication),
            device: authenticated.device,
            body: json(request),
          }),
        );
      });

      device.post("/feedback", async (request, reply) => {
        const authenticated = await authenticate(request);
        return options.sendJson(
          reply,
          200,
          await pushPort().feedback({
            scope: scope(authenticated.authentication),
            body: json(request),
          }),
        );
      });

      device.post("/companions", async (request, reply) => {
        const authenticated = await authenticate(request);
        return options.sendJson(
          reply,
          200,
          await pushPort().linkCompanion({
            scope: scope(authenticated.authentication),
            device: authenticated.device,
            body: json(request),
          }),
        );
      });

      device.post("/approvals/respond", async (request, reply) => {
        const authenticated = await authenticate(request);
        if (!options.gateways.v2)
          throw new DeviceGatewayError(DEVICE_GATEWAY_ERROR_CODES.GATEWAY_UNAVAILABLE, 503);
        const token = await pushPort().takeAction({
          device: authenticated.device,
          confirmed: authenticated.confirmed,
          body: json(request),
        });
        const approval = token.approval;
        if (approval === null)
          throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.ACTION_INVALID, 410);
        const decisions = { approve: "approved", deny: "denied" } as const;
        const reference = token.tokenHash.slice(0, 40);
        try {
          return options.sendJson(
            reply,
            200,
            await dispatchDeviceGatewayRequest({
              request: classifyDeviceGatewayRequest({
                gateway: "v2",
                type: "approval.respond",
                messageId: `notification-action:${reference}`,
                idempotencyKey: `notification-action:${reference}`,
                dataClassification: "private",
                risk: "medium",
                payload: {
                  approvalRequestId: approval.requestId,
                  expectedRevision: approval.revision,
                  decision: decisions[token.action],
                  semanticSnapshotHash: approval.snapshotHash,
                  editedPayloadRef: null,
                  recentAuthenticationRef: DEVICE_REFERENCE_PLACEHOLDER,
                },
              }),
              confirmed: authenticated.confirmed,
              notificationAction: true,
              pairedDeviceId: authenticated.device.id,
              authentication: authenticated.authentication,
              authority: options.authority,
              gateways: options.gateways,
              audit: options.audit,
              ...(options.onAuditFailed ? { onAuditFailed: options.onAuditFailed } : {}),
              now,
            }),
          );
        } catch (error) {
          if (error instanceof ApplicationPortError)
            throw new DevicePushError(DEVICE_PUSH_ERROR_CODES.ACTION_INVALID, 410);
          throw error;
        }
      });

      device.post("/gateway", async (request, reply) => {
        const authenticated = await authenticate(request);
        const classified = classifyDeviceGatewayRequest(json(request));
        return options.sendJson(
          reply,
          200,
          await dispatchDeviceGatewayRequest({
            request: classified,
            confirmed: authenticated.confirmed,
            pairedDeviceId: authenticated.device.id,
            authentication: authenticated.authentication,
            authority: options.authority,
            gateways: options.gateways,
            audit: options.audit,
            ...(options.onAuditFailed ? { onAuditFailed: options.onAuditFailed } : {}),
            now,
          }),
        );
      });

      device.get("/home", async (request, reply) => {
        const authenticated = await authenticate(request);
        const query = new URLSearchParams(rawQuery(request));
        const locale = query.get("locale");
        if (
          [...query.keys()].some((name) => name !== "locale") ||
          query.getAll("locale").length !== 1 ||
          !(HOME_LOCALES as readonly string[]).includes(locale ?? "")
        )
          return options.rejectBody(400);
        const result = (await dispatchDeviceGatewayRequest({
          request: classifyDeviceGatewayRequest({
            gateway: "v2",
            type: "home.read",
            messageId: `home-${stableSuffix(authenticated.device.id, now().toISOString())}`,
            dataClassification: "private",
            risk: "low",
            payload: { locale },
          }),
          confirmed: authenticated.confirmed,
          pairedDeviceId: authenticated.device.id,
          authentication: authenticated.authentication,
          authority: options.authority,
          gateways: options.gateways,
          audit: options.audit,
          now,
        })) as { readonly payload: unknown };
        return options.sendJson(reply, 200, result.payload);
      });

      device.post("/home/act", async (request, reply) => {
        const authenticated = await authenticate(request);
        const body = json(request);
        const { key, action, binding, requestId } = body;
        if (
          Object.keys(body).some(
            (name) => !["key", "action", "binding", "requestId"].includes(name),
          ) ||
          typeof key !== "string" ||
          typeof action !== "string" ||
          typeof requestId !== "string" ||
          !MACHINE_STRING.test(requestId) ||
          !options.home
        )
          return options.rejectBody(400);
        if (typeof binding !== "string")
          throw new DeviceGatewayError(DEVICE_GATEWAY_ERROR_CODES.HOME_ACTION_INVALID, 400);
        const replayKey = `${authenticated.device.id}\n${requestId}`;
        const replay = homeActReplays.get(replayKey);
        if (replay && now().getTime() - replay.at < HOME_ACT_REPLAY_WINDOW_MS)
          return options.sendJson(reply, 200, replay.response);
        const resolved = await options.home.resolveAction({ key, action, binding });
        if (!resolved.ok)
          throw new DeviceGatewayError(
            resolved.reason === "binding_invalid" || resolved.reason === "action_not_offered"
              ? DEVICE_GATEWAY_ERROR_CODES.HOME_ACTION_INVALID
              : DEVICE_GATEWAY_ERROR_CODES.HOME_ACTION_STALE,
            resolved.reason === "binding_invalid" || resolved.reason === "action_not_offered"
              ? 400
              : 409,
          );
        const suffix = stableSuffix(authenticated.device.id, `home-act:${requestId}`);
        const rememberHomeAct = (target: typeof reply, status: number, response: unknown) => {
          homeActReplays.set(replayKey, { response, at: now().getTime() });
          if (homeActReplays.size > HOME_ACT_REPLAY_LIMIT)
            homeActReplays.delete(homeActReplays.keys().next().value as string);
          return options.sendJson(target, status, response);
        };
        const classified = classifyDeviceGatewayRequest({
          gateway: "v2",
          type: resolved.type,
          messageId: `home-act-${suffix}`,
          idempotencyKey: `home-act-${suffix}`,
          dataClassification: resolved.dataClassification,
          risk: "low",
          payload: resolved.payload,
        });
        return rememberHomeAct(
          reply,
          200,
          await dispatchDeviceGatewayRequest({
            request: { ...classified, tier: resolved.ownerPresence ? "change" : "tighten" },
            confirmed: authenticated.confirmed,
            pairedDeviceId: authenticated.device.id,
            authentication: authenticated.authentication,
            authority: options.authority,
            gateways: options.gateways,
            audit: options.audit,
            auditAction: "device.home.act",
            ...(options.onAuditFailed ? { onAuditFailed: options.onAuditFailed } : {}),
            now,
          }),
        );
      });

      device.post("/utterances/partial", async (request, reply) => {
        const authenticated = await authenticate(request);
        const body = json(request);
        if (
          Object.keys(body).some((key) => !["utteranceId", "text"].includes(key)) ||
          typeof body["utteranceId"] !== "string" ||
          !UTTERANCE_ID_PATTERN.test(body["utteranceId"]) ||
          typeof body["text"] !== "string" ||
          body["text"].trim().length === 0 ||
          body["text"].length > MESSAGE_TEXT_MAXIMUM
        )
          options.rejectBody(400);
        if (!options.prefetch)
          return options.sendJson(reply, 200, { prepared: false, reason: "unavailable" });
        return options.sendJson(
          reply,
          200,
          await options.prefetch.prepare({
            authentication: authenticated.authentication,
            deviceId: authenticated.device.id,
            utteranceId: body["utteranceId"] as string,
            text: body["text"] as string,
          }),
        );
      });

      device.get("/stream", async (request, reply) => {
        const authenticated = await authenticate(request);
        const { authentication } = authenticated;
        const after = new URLSearchParams(rawQuery(request)).get("after");
        if (after !== null && !MACHINE_STRING.test(after)) options.rejectBody(400);
        const configuration = options.configuration();
        const subscription = threadGatewayMessageSchema.parse({
          schemaVersion: THREAD_GATEWAY_SCHEMA_VERSION,
          kind: "subscription",
          type: "thread.events",
          messageId: `device-stream:${stableSuffix(authenticated.device.id, now().toISOString())}`,
          correlationId: `device:${authenticated.device.id}`,
          causationId: null,
          scope: { ownerId: authentication.ownerId, agentId: options.authority.agentId },
          authority: {
            deploymentId: options.authority.deploymentId,
            authorityEpoch: options.authority.authorityEpoch,
            fencingToken: options.authority.fencingToken,
          },
          actor: { actorType: "owner", actorId: authentication.ownerId },
          payload: { afterCursor: after },
        }) as ThreadGatewaySubscription;
        const mac = authenticated.device.kind === "mac";
        const signalled = (source: AsyncGenerator<string>) => {
          const withActions = options.actions
            ? withDeviceActionSignals(source, options.actions.hub, authenticated.device.id)
            : source;
          return mac && options.notifications
            ? withDeviceNotifications(
                withActions,
                options.notifications.hub,
                authenticated.device.id,
              )
            : withActions;
        };
        const stream = Readable.from(
          bounded(
            signalled(
              options.streamThreadEvents({
                gateway: options.threadGateway,
                authentication,
                subscription,
                heartbeatMilliseconds: configuration.heartbeatSeconds * 1000,
                include: (event) => DEVICE_THREAD_EVENT_TYPES.has(event.payload.eventType),
                revalidate: async () => {
                  if (!(await options.devices.stillActive(authenticated.device.id)))
                    throw new Error(PAIRED_DEVICE_ERROR_CODES.DEVICE_REVOKED);
                  options.push?.streamAlive(authenticated.device.id);
                },
              }),
            ),
            configuration.connectionMaxSeconds * 1000,
          ),
        );
        holdStream(
          request,
          authenticated.device.id,
          stream,
          configuration.streamConnections,
          reply.raw,
        );
        if (!mac) {
          options.push?.streamOpened(authenticated.device.id);
          stream.once("close", () => options.push?.streamClosed(authenticated.device.id));
        }
        try {
          options.setStreamHeaders(reply);
          return reply.send(stream);
        } catch (error) {
          stream.destroy();
          throw error;
        }
      });
    },
    { prefix: DEVICE_API_PREFIX },
  );

  const managed = async (request: FastifyRequest) => {
    const authentication = await options.webAuthenticate(request);
    await options.webMutationGuard(request, authentication);
    return authentication;
  };
  const emptyBody = (request: FastifyRequest) => {
    const body = request.body;
    if (
      body !== undefined &&
      body !== null &&
      (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0)
    )
      options.rejectBody(400);
  };
  const deviceAction = (request: FastifyRequest, extra: readonly string[] = []) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (
      !body ||
      typeof body !== "object" ||
      Object.keys(body).some((key) => !["deviceId", "expectedRevision", ...extra].includes(key)) ||
      typeof body["deviceId"] !== "string" ||
      !/^dev_[A-Za-z0-9_-]{22}$/u.test(body["deviceId"]) ||
      !Number.isSafeInteger(body["expectedRevision"]) ||
      (body["expectedRevision"] as number) < 0
    )
      options.rejectBody(400);
    return body as { deviceId: string; expectedRevision: number; name?: unknown };
  };

  app.post(`${DEVICE_MANAGEMENT_PREFIX}/list`, async (request, reply) => {
    const authentication = await managed(request);
    emptyBody(request);
    const devices = await options.devices.list(scope(authentication));
    return options.sendJson(reply, 200, {
      devices: devices.map(presentPairedDevice),
      limits: presentDeviceLimits(options.configuration()),
    });
  });

  app.post(`${DEVICE_MANAGEMENT_PREFIX}/rename`, async (request, reply) => {
    const authentication = await managed(request);
    const body = deviceAction(request, ["name"]);
    if (typeof body.name !== "string") options.rejectBody(400);
    const device = await options.devices.rename({
      ...scope(authentication),
      deviceId: body.deviceId,
      expectedRevision: body.expectedRevision,
      name: body.name as string,
    });
    return options.sendJson(reply, 200, { device: presentPairedDevice(device) });
  });

  app.post(`${DEVICE_MANAGEMENT_PREFIX}/revoke`, async (request, reply) => {
    const authentication = await managed(request);
    const body = deviceAction(request);
    const device = await options.devices.revoke({ ...scope(authentication), ...body });
    return options.sendJson(reply, 200, { device: presentPairedDevice(device) });
  });
}
