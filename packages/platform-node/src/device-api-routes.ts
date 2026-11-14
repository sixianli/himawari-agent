import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  type AgentThreadGatewayPort,
  ApplicationPortError,
  type AuditLedgerPort,
  DEVICE_HARD_LIMIT_KEYS,
  DEVICE_HARD_LIMITS,
  type DeviceConfiguration,
  type GatewayAuthenticationContext,
  type PairedDevice,
  type PairedDeviceScope,
  PERCEPTION_SENSES,
  PORT_ERROR_CODES,
  type ThreadGatewayRequestMessage,
  type UploadGrantPurpose,
} from "@himawari-agent/application";
import {
  HOME_LOCALES,
  THREAD_GATEWAY_SCHEMA_VERSION,
  type ThreadExecutionEventsSubscription,
  type ThreadGatewayEvent,
  type ThreadGatewaySubscription,
  threadGatewayMessageSchema,
} from "@himawari-agent/gateway-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  classifyDeviceGatewayRequest,
  DEVICE_GATEWAY_ERROR_CODES,
  DeviceGatewayError,
  type DeviceGatewayAuditFailure,
  type DeviceGateways,
  dispatchDeviceGatewayRequest,
} from "./device-gateway.js";
import type { DeviceSignedRequest } from "./device-request-signature.js";
import {
  type AuthenticatedDeviceRequest,
  PAIRED_DEVICE_ERROR_CODES,
  PairedDeviceError,
  type PairedDeviceService,
} from "./paired-device-service.js";
import type { AuthorizedUpload, PerceptionService } from "./perception-service.js";
import {
  PLAIN_TEXT_MAXIMUM_CHARACTERS,
  parseTextAdmission,
  type TextAdmissionClassification,
} from "./text-admission.js";

export const DEVICE_API_PREFIX = "/api/device/v1" as const;
export const DEVICE_MANAGEMENT_PREFIX = "/api/devices/v1" as const;

const THREAD_ID_SEGMENT = "[A-Za-z0-9][A-Za-z0-9._:-]{0,127}";

export const DEVICE_API_ROUTES = Object.freeze([
  { method: "POST", path: "pair", signed: false },
  { method: "GET", path: "config", signed: true },
  { method: "GET", path: "stream", signed: true },
  { method: "POST", path: "messages", signed: true },
  { method: "GET", path: "threads", signed: true },
  { method: "POST", path: "approvals/challenge", signed: true },
  { method: "POST", path: "gateway", signed: true },
  { method: "GET", path: "home", signed: true },
  { method: "POST", path: "home/act", signed: true },
  { method: "POST", path: "payloads/text/new", signed: true },
  { method: "POST", path: "threads", signed: true },
  { method: "GET", path: "threads/{threadId}", signed: true },
  { method: "GET", path: "threads/{threadId}/execution-stream", signed: true },
  { method: "GET", path: "threads/{threadId}/runs/{runId}/execution", signed: true },
  { method: "POST", path: "payloads/text", signed: true },
  { method: "POST", path: "uploads/begin", signed: true },
  { method: "POST", path: "perception", signed: true, uploadPurpose: "perception" },
  { method: "POST", path: "perception/media", signed: false, uploadPurpose: "media" },
  { method: "POST", path: "track", signed: true, uploadPurpose: "track" },
  { method: "POST", path: "mirror", signed: true },
  { method: "GET", path: "usage", signed: true },
  { method: "GET", path: "perception/deletions", signed: true },
  { method: "POST", path: "usage/report", signed: true },
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
    `^${route.path.replace("{threadId}", THREAD_ID_SEGMENT).replace("{runId}", THREAD_ID_SEGMENT)}$`,
    "u",
  ),
}));

export const DEVICE_PAYLOAD_TEXT_MAXIMUM_REFS = 100;
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
const MACHINE_STRING = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MESSAGE_TEXT_MAXIMUM = PLAIN_TEXT_MAXIMUM_CHARACTERS;
export type DeviceTextClassification = TextAdmissionClassification;

export interface DeviceApiAuthority {
  readonly agentId: string;
  readonly deploymentId: string;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
}

export interface DevicePairingAccess {
  readonly clientId: string;
  readonly clientSecret: string;
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

export interface DeviceApiRouteOptions {
  readonly home?: DeviceHomePort;
  readonly pairingAccess?: DevicePairingAccess;
  readonly publicOrigin: URL;
  readonly devices: PairedDeviceService;
  readonly configuration: () => DeviceConfiguration;
  readonly authority: DeviceApiAuthority;
  readonly perception?: PerceptionService;
  readonly threadGateway: AgentThreadGatewayPort;
  readonly gateways: DeviceGateways;
  readonly audit: AuditLedgerPort;
  readonly onAuditFailed?: (failure: DeviceGatewayAuditFailure) => void;
  readonly protectText: (input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly idempotencyKey: string;
    readonly content: string;
    readonly dataClassification?: DeviceTextClassification;
  }) => Promise<string>;
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

function rawQuery(request: FastifyRequest): string {
  const index = request.url.indexOf("?");
  return index < 0 ? "" : request.url.slice(index + 1);
}

function requestPath(request: FastifyRequest): string {
  return request.url.split("?", 1)[0] ?? request.url;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApplicationPortError && error.code === PORT_ERROR_CODES.NOT_FOUND;
}

export function pairingAccessFields({ clientId, clientSecret }: DevicePairingAccess) {
  return { clientId, clientSecret };
}

const HOME_ACT_REPLAY_WINDOW_MS = 10 * 60 * 1000;
const HOME_ACT_REPLAY_LIMIT = 256;

function stableSuffix(deviceId: string, messageId: string): string {
  return createHash("sha256").update(`${deviceId}\n${messageId}`).digest("hex").slice(0, 40);
}

export function devicePairingNumber(input: {
  readonly devicePublicKey: string;
  readonly confirmPublicKey: string;
}): string {
  const digest = createHash("sha256")
    .update(Buffer.from("himawari-pairing-v1", "utf8"))
    .update(Buffer.from(input.devicePublicKey, "base64"))
    .update(Buffer.from(input.confirmPublicKey, "base64"))
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

export function presentPairedDevice(device: PairedDevice) {
  return {
    pairingNumber: device.status === "pending" ? devicePairingNumber(device) : null,
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

function holdDeviceStream(
  counts: Map<string, number>,
  deviceId: string,
  stream: Readable,
  maximum: number,
  connection: NodeJS.EventEmitter,
): void {
  const open = counts.get(deviceId) ?? 0;
  if (open >= maximum) {
    stream.destroy();
    throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.STREAM_LIMIT, 429, {
      streamConnections: maximum,
    });
  }
  counts.set(deviceId, open + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const remaining = (counts.get(deviceId) ?? 1) - 1;
    if (remaining > 0) counts.set(deviceId, remaining);
    else counts.delete(deviceId);
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
  const streamCounts = new Map<string, number>();
  const holdStream = (
    deviceId: string,
    stream: Readable,
    maximum: number,
    connection: NodeJS.EventEmitter,
  ) => {
    holdDeviceStream(streamCounts, deviceId, stream, maximum, connection);
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

      device.post("/pair", async (request, reply) => {
        const paired = await options.devices.pair(json(request));
        return options.sendJson(reply, paired.replayed ? 200 : 201, {
          device: presentPairedDevice(paired.device),
        });
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
        return options.sendJson(reply, 200, {
          revision: feed.revision,
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

      device.post("/usage/report", async (request, reply) => {
        const authenticated = await authenticate(request);
        await perception().reportDeviceUsage({
          scope: scope(authenticated.authentication),
          deviceId: authenticated.device.id,
          body: json(request),
        });
        return options.sendJson(reply, 200, { accepted: true });
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
          holdStream(authenticated.device.id, stream, configuration.streamConnections, reply.raw);
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
            (key) => !["messageId", "threadId", "expectedRevision", "text"].includes(key),
          ) ||
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
            sourceProofRef: `device:${authenticated.device.id}`,
            dataClassification: "private",
            occurredAt: now().toISOString(),
            resultRef,
          },
        }) as ThreadGatewayRequestMessage;
        return options.sendJson(
          reply,
          200,
          await options.threadGateway.request(authentication, command),
        );
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
        const stream = Readable.from(
          bounded(
            options.streamThreadEvents({
              gateway: options.threadGateway,
              authentication,
              subscription,
              heartbeatMilliseconds: configuration.heartbeatSeconds * 1000,
              include: (event) => DEVICE_THREAD_EVENT_TYPES.has(event.payload.eventType),
              revalidate: async () => {
                if (!(await options.devices.stillActive(authenticated.device.id)))
                  throw new Error(PAIRED_DEVICE_ERROR_CODES.DEVICE_REVOKED);
              },
            }),
            configuration.connectionMaxSeconds * 1000,
          ),
        );
        holdStream(authenticated.device.id, stream, configuration.streamConnections, reply.raw);
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

  app.post(`${DEVICE_MANAGEMENT_PREFIX}/pairing-codes`, async (request, reply) => {
    const authentication = await managed(request);
    emptyBody(request);
    if (!authentication.sessionId) options.rejectBody(403);
    const pairing = await options.devices.startPairing({
      ...scope(authentication),
      sessionId: authentication.sessionId as string,
    });
    return options.sendJson(reply, 201, {
      expiresAt: pairing.expiresAt,
      pairingUri: `himawari-pair:${Buffer.from(
        JSON.stringify({
          v: 1,
          origin: options.publicOrigin.origin,
          code: pairing.code,
          ...(options.pairingAccess
            ? {
                access: pairingAccessFields(options.pairingAccess),
              }
            : {}),
        }),
      ).toString("base64url")}`,
    });
  });

  app.post(`${DEVICE_MANAGEMENT_PREFIX}/confirm`, async (request, reply) => {
    const authentication = await managed(request);
    const body = deviceAction(request);
    const device = await options.devices.confirm({ ...scope(authentication), ...body });
    return options.sendJson(reply, 200, { device: presentPairedDevice(device) });
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
