import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import {
  type AgentThreadGatewayPort,
  DEVICE_HARD_LIMIT_KEYS,
  DEVICE_HARD_LIMITS,
  type DeviceConfiguration,
  type GatewayAuthenticationContext,
  type PairedDevice,
  type PairedDeviceScope,
  type ThreadGatewayRequestMessage,
} from "@himawari-agent/application";
import {
  THREAD_GATEWAY_SCHEMA_VERSION,
  type ThreadGatewaySubscription,
  threadGatewayMessageSchema,
} from "@himawari-agent/gateway-contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { DeviceSignedRequest } from "./device-request-signature.js";
import {
  PAIRED_DEVICE_ERROR_CODES,
  type PairedDeviceError,
  type PairedDeviceService,
} from "./paired-device-service.js";

export const DEVICE_API_PREFIX = "/api/device/v1" as const;
export const DEVICE_MANAGEMENT_PREFIX = "/api/devices/v1" as const;

export const DEVICE_API_ROUTES = Object.freeze([
  { method: "POST", path: "pair", signed: false },
  { method: "GET", path: "config", signed: true },
  { method: "GET", path: "stream", signed: true },
  { method: "POST", path: "messages", signed: true },
  { method: "GET", path: "threads", signed: true },
] as const);

const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/u;
const MACHINE_STRING = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MESSAGE_TEXT_MAXIMUM = 64 * 1024;

export interface DeviceApiAuthority {
  readonly agentId: string;
  readonly deploymentId: string;
  readonly authorityEpoch: number;
  readonly fencingToken: number;
}

export interface DeviceApiRouteOptions {
  readonly publicOrigin: URL;
  readonly devices: PairedDeviceService;
  readonly configuration: () => DeviceConfiguration;
  readonly authority: DeviceApiAuthority;
  readonly threadGateway: AgentThreadGatewayPort;
  readonly protectText: (input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly idempotencyKey: string;
    readonly content: string;
  }) => Promise<string>;
  readonly streamThreadEvents: (input: {
    readonly gateway: AgentThreadGatewayPort;
    readonly authentication: GatewayAuthenticationContext;
    readonly subscription: ThreadGatewaySubscription;
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

function stableSuffix(deviceId: string, messageId: string): string {
  return createHash("sha256").update(`${deviceId}\n${messageId}`).digest("hex").slice(0, 40);
}

function presentDevice(device: PairedDevice) {
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

function presentLimits(configuration: DeviceConfiguration) {
  return DEVICE_HARD_LIMIT_KEYS.map((key) => ({
    key,
    unit: DEVICE_HARD_LIMITS[key].unit,
    value: configuration.limits[key],
    defaultValue: DEVICE_HARD_LIMITS[key].defaultValue,
    onExceed: DEVICE_HARD_LIMITS[key].onExceed,
  }));
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
  const scope = (authentication: GatewayAuthenticationContext): PairedDeviceScope =>
    ({
      ownerId: authentication.ownerId,
      agentId: options.authority.agentId,
    }) as PairedDeviceScope;
  const now = () => (options.now ?? (() => new Date()))();

  app.register(
    async (device) => {
      device.removeAllContentTypeParsers();
      device.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) =>
        done(null, body),
      );
      device.addHook("onRequest", async (request) => {
        const path = requestPath(request).slice(DEVICE_API_PREFIX.length + 1);
        if (
          !DEVICE_API_ROUTES.some((route) => route.method === request.method && route.path === path)
        )
          options.rejectNotAllowed();
        const limit = options.configuration().limits["device.request.body_bytes"];
        const declared = Number(header(request, "content-length") ?? "0");
        if (Number.isFinite(declared) && declared > limit) options.rejectBody(413);
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

      device.all("/*", async () => options.rejectNotAllowed());

      device.post("/pair", async (request, reply) => {
        const paired = await options.devices.pair(json(request));
        return options.sendJson(reply, 201, { device: presentDevice(paired) });
      });

      device.get("/config", async (request, reply) => {
        await authenticate(request);
        const configuration = options.configuration();
        return options.sendJson(reply, 200, {
          heartbeatSeconds: configuration.heartbeatSeconds,
          connectionMaxSeconds: configuration.connectionMaxSeconds,
          signatureToleranceSeconds: configuration.signatureToleranceSeconds,
          limits: presentLimits(configuration),
        });
      });

      device.get("/threads", async (request, reply) => {
        const { authentication } = await authenticate(request);
        const query = new URLSearchParams(rawQuery(request));
        const afterCursor = query.get("after");
        if (afterCursor !== null && !MACHINE_STRING.test(afterCursor)) options.rejectBody(400);
        const response = await options.threadGateway.request(
          authentication,
          threadGatewayMessageSchema.parse({
            schemaVersion: THREAD_GATEWAY_SCHEMA_VERSION,
            kind: "query",
            type: "thread.list",
            messageId: `device-query:${stableSuffix(authentication.deviceId, now().toISOString())}`,
            correlationId: `device:${authentication.deviceId}`.slice(0, 128),
            causationId: null,
            scope: { ownerId: authentication.ownerId, agentId: options.authority.agentId },
            authority: {
              deploymentId: options.authority.deploymentId,
              authorityEpoch: options.authority.authorityEpoch,
              fencingToken: options.authority.fencingToken,
            },
            actor: { actorType: "owner", actorId: authentication.ownerId },
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
              revalidate: async () => {
                if (!(await options.devices.stillActive(authenticated.device.id)))
                  throw new Error(PAIRED_DEVICE_ERROR_CODES.DEVICE_REVOKED);
              },
            }),
            configuration.connectionMaxSeconds * 1000,
          ),
        );
        options.setStreamHeaders(reply);
        return reply.send(stream);
      });
    },
    { prefix: DEVICE_API_PREFIX },
  );

  const managed = async (request: FastifyRequest) => {
    const authentication = await options.webAuthenticate(request);
    await options.webMutationGuard(request, authentication);
    return authentication;
  };
  const deviceAction = (request: FastifyRequest) => {
    const body = request.body as Record<string, unknown> | undefined;
    if (
      !body ||
      typeof body !== "object" ||
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
    const devices = await options.devices.list(scope(authentication));
    return options.sendJson(reply, 200, {
      devices: devices.map(presentDevice),
      limits: presentLimits(options.configuration()),
    });
  });

  app.post(`${DEVICE_MANAGEMENT_PREFIX}/pairing-codes`, async (request, reply) => {
    const authentication = await managed(request);
    if (!authentication.sessionId) options.rejectBody(403);
    const pairing = await options.devices.startPairing({
      ...scope(authentication),
      sessionId: authentication.sessionId as string,
    });
    return options.sendJson(reply, 201, {
      expiresAt: pairing.expiresAt,
      pairingUri: `himawari-pair:${Buffer.from(
        JSON.stringify({ v: 1, origin: options.publicOrigin.origin, code: pairing.code }),
      ).toString("base64url")}`,
    });
  });

  app.post(`${DEVICE_MANAGEMENT_PREFIX}/confirm`, async (request, reply) => {
    const authentication = await managed(request);
    const body = deviceAction(request);
    const device = await options.devices.confirm({ ...scope(authentication), ...body });
    return options.sendJson(reply, 200, { device: presentDevice(device) });
  });

  app.post(`${DEVICE_MANAGEMENT_PREFIX}/rename`, async (request, reply) => {
    const authentication = await managed(request);
    const body = deviceAction(request);
    if (typeof body.name !== "string") options.rejectBody(400);
    const device = await options.devices.rename({
      ...scope(authentication),
      deviceId: body.deviceId,
      expectedRevision: body.expectedRevision,
      name: body.name as string,
    });
    return options.sendJson(reply, 200, { device: presentDevice(device) });
  });

  app.post(`${DEVICE_MANAGEMENT_PREFIX}/revoke`, async (request, reply) => {
    const authentication = await managed(request);
    const body = deviceAction(request);
    const device = await options.devices.revoke({ ...scope(authentication), ...body });
    return options.sendJson(reply, 200, { device: presentDevice(device) });
  });
}
