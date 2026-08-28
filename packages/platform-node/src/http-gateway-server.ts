import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  type AgentGatewayPort,
  type AgentGatewayV2Port,
  ApplicationPortError,
  type GatewayAuthenticationContext,
  PORT_ERROR_CODES,
} from "@himawari-agent/application";
import type { DeploymentHealthSnapshot } from "@himawari-agent/domain";
import {
  ContractValidationError,
  type EventSubscription,
  type GatewayCommand,
  type GatewayQuery,
  type GatewayV2Command,
  type GatewayV2Event,
  type GatewayV2Query,
  gatewayMessageSchema,
  gatewayV2MessageSchema,
  type StreamEvent,
} from "@himawari-agent/gateway-contracts";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { RuntimeMetricsSnapshot } from "./runtime-observability.js";

export const HTTP_GATEWAY_ERROR_CODES = Object.freeze({
  AUTHENTICATION_REQUIRED: "HTTP_GATEWAY_AUTHENTICATION_REQUIRED",
  BODY_INVALID: "HTTP_GATEWAY_BODY_INVALID",
  CSRF_REJECTED: "HTTP_GATEWAY_CSRF_REJECTED",
  IDEMPOTENCY_MISMATCH: "HTTP_GATEWAY_IDEMPOTENCY_MISMATCH",
  METHOD_INVALID: "HTTP_GATEWAY_METHOD_INVALID",
  ORIGIN_REJECTED: "HTTP_GATEWAY_ORIGIN_REJECTED",
  REQUEST_INVALID: "HTTP_GATEWAY_REQUEST_INVALID",
  SCOPE_REJECTED: "HTTP_GATEWAY_SCOPE_REJECTED",
  STATIC_NOT_FOUND: "HTTP_GATEWAY_STATIC_NOT_FOUND",
} as const);

export interface HttpGatewayAuthenticationInput {
  readonly accessAssertion: string | null;
  readonly sessionToken: string | null;
  readonly method: string;
  readonly path: string;
}

export interface HttpGatewayAuthenticationPort {
  authenticate(input: HttpGatewayAuthenticationInput): Promise<GatewayAuthenticationContext>;
}

export interface HttpGatewayCsrfPort {
  verify(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly token: string | null;
    readonly method: string;
    readonly path: string;
  }): Promise<boolean>;
  issue?(authentication: GatewayAuthenticationContext): Promise<string>;
}

export interface HttpGatewayHealthPort {
  publicSnapshot(): {
    readonly live: boolean;
    readonly ready: boolean;
    readonly status: DeploymentHealthSnapshot["status"];
  };
  authenticatedSnapshot(authenticated: boolean): DeploymentHealthSnapshot;
}

export interface HttpGatewayMetricsPort {
  authenticatedSnapshot(authenticated: boolean): RuntimeMetricsSnapshot;
}

export interface HttpGatewayServerOptions {
  readonly gateway: AgentGatewayPort;
  readonly gatewayV2?: AgentGatewayV2Port;
  readonly payloadAdmission?: HttpGatewayPayloadAdmissionPort;
  readonly authentication: HttpGatewayAuthenticationPort;
  readonly csrf: HttpGatewayCsrfPort;
  readonly publicOrigin: string;
  readonly staticRoot: string;
  readonly sessionCookieName?: string;
  readonly maximumBodyBytes?: number;
  readonly maximumStaticAssetBytes?: number;
  readonly heartbeatMilliseconds?: number;
  readonly health?: HttpGatewayHealthPort;
  readonly metrics?: HttpGatewayMetricsPort;
  readonly browserConfiguration?: {
    readonly agentId: string;
    readonly deploymentId: string;
    readonly authorityEpoch: number;
    readonly fencingToken: number;
    readonly primaryModel?: {
      readonly provider: string;
      readonly model: string;
      readonly version: string;
    };
    readonly primaryModelRef?: string;
    readonly repositoryAllowlistRefs?: readonly string[];
    readonly disclosedDataClassifications?: readonly (
      | "public"
      | "private"
      | "sensitive"
      | "restricted"
    )[];
  };
}

export interface HttpGatewayPayloadAdmissionPort {
  protect(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly content: string;
    readonly dataClassification: "public" | "private" | "sensitive" | "restricted";
    readonly contentType: "text/plain";
  }): Promise<{ readonly payloadRef: string }>;
}

const JSON_CONTENT_TYPE = "application/json";
const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";
const DEFAULT_BODY_LIMIT = 256 * 1024;
const DEFAULT_ASSET_LIMIT = 8 * 1024 * 1024;
const DEFAULT_HEARTBEAT_MILLISECONDS = 15_000;

class HttpGatewayError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number) {
    super(code);
    this.name = "HttpGatewayError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" ? value : null;
}

function cookie(request: FastifyRequest, name: string): string | null {
  const source = header(request, "cookie");
  if (!source) return null;
  for (const pair of source.split(";")) {
    const index = pair.indexOf("=");
    if (index < 0) continue;
    const key = pair.slice(0, index).trim();
    if (key !== name) continue;
    const value = pair.slice(index + 1).trim();
    if (!value || value.length > 4096) return null;
    return value;
  }
  return null;
}

function requestPath(request: FastifyRequest): string {
  return request.url.split("?", 1)[0] ?? request.url;
}

function assertPublicHost(request: FastifyRequest, publicOrigin: URL): void {
  if (header(request, "host") !== publicOrigin.host) {
    throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.ORIGIN_REJECTED, 403);
  }
}

function assertMutationBoundary(request: FastifyRequest, publicOrigin: URL): void {
  assertPublicHost(request, publicOrigin);
  if (
    header(request, "origin") !== publicOrigin.origin ||
    header(request, "sec-fetch-site") !== "same-origin"
  ) {
    throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.ORIGIN_REJECTED, 403);
  }
  const mediaType = header(request, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== JSON_CONTENT_TYPE) {
    throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.BODY_INVALID, 415);
  }
}

function setSecurityHeaders(reply: FastifyReply): void {
  reply
    .header(
      "content-security-policy",
      "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; script-src 'self'; style-src 'self'",
    )
    .header("cross-origin-opener-policy", "same-origin")
    .header("cross-origin-resource-policy", "same-origin")
    .header("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-frame-options", "DENY");
}

function sendJson(reply: FastifyReply, statusCode: number, body: unknown): FastifyReply {
  return reply
    .code(statusCode)
    .header("cache-control", "no-store")
    .type("application/json; charset=utf-8")
    .send(body);
}

function parseBusinessMessage(input: unknown, expectedKind: "command"): GatewayCommand;
function parseBusinessMessage(input: unknown, expectedKind: "query"): GatewayQuery;
function parseBusinessMessage(input: unknown, expectedKind: "command" | "query") {
  const parsed = gatewayMessageSchema.parse(input);
  if (parsed.kind !== expectedKind) {
    throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.METHOD_INVALID, 400);
  }
  return parsed;
}

function parseV2BusinessMessage(input: unknown, expectedKind: "command"): GatewayV2Command;
function parseV2BusinessMessage(input: unknown, expectedKind: "query"): GatewayV2Query;
function parseV2BusinessMessage(input: unknown, expectedKind: "command" | "query") {
  const parsed = gatewayV2MessageSchema.parse(input);
  if (parsed.kind !== expectedKind) {
    throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.METHOD_INVALID, 400);
  }
  return parsed;
}

function parseSubscription(encoded: unknown): EventSubscription {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > 8192) {
    throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.REQUEST_INVALID, 400);
  }
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.REQUEST_INVALID, 400);
  }
  const parsed = gatewayMessageSchema.parseJson(decoded);
  if (parsed.kind !== "subscription") {
    throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.METHOD_INVALID, 400);
  }
  return parsed;
}

function serializeSse(input: {
  readonly event: string;
  readonly data: unknown;
  readonly id?: string;
}) {
  const id = input.id ? `id: ${input.id}\n` : "";
  return `${id}event: ${input.event}\ndata: ${JSON.stringify(input.data)}\n\n`;
}

function refreshQueries(subscription: EventSubscription): readonly GatewayQuery[] {
  const base = {
    schemaVersion: "gateway.v1" as const,
    kind: "query" as const,
    correlationId: subscription.correlationId,
    causationId: subscription.messageId,
    dataClassification: subscription.dataClassification,
    scope: subscription.scope,
    actor: subscription.actor,
  };
  const queries: GatewayQuery[] = [];
  if (subscription.payload.threadId) {
    queries.push({
      ...base,
      type: "thread.get_snapshot",
      messageId: `${subscription.messageId}:refresh:thread`.slice(0, 128),
      payload: { threadId: subscription.payload.threadId },
    });
  }
  if (subscription.payload.runId) {
    queries.push({
      ...base,
      type: "run.get_snapshot",
      messageId: `${subscription.messageId}:refresh:run`.slice(0, 128),
      payload: { runId: subscription.payload.runId },
    });
  }
  return queries.map((query) => gatewayMessageSchema.parse(query) as GatewayQuery);
}

async function* streamGatewayEvents(input: {
  readonly gateway: AgentGatewayPort;
  readonly authentication: GatewayAuthenticationContext;
  readonly subscription: EventSubscription;
  readonly heartbeatMilliseconds: number;
}): AsyncGenerator<string> {
  const iterator = input.gateway
    .subscribe(input.authentication, input.subscription)
    [Symbol.asyncIterator]();
  let pending = iterator.next();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result:
      | { readonly kind: "item"; readonly value: IteratorResult<StreamEvent> }
      | { readonly kind: "heartbeat" };
    try {
      result = await Promise.race([
        pending.then((value) => ({ kind: "item" as const, value })),
        new Promise<{ readonly kind: "heartbeat" }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "heartbeat" }), input.heartbeatMilliseconds);
        }),
      ]);
    } catch (error) {
      if (error instanceof ApplicationPortError && error.code !== PORT_ERROR_CODES.NOT_FOUND) {
        yield serializeSse({
          event: "gateway.stream_error",
          data: { code: error.code },
        });
        return;
      }
      throw error;
    }
    if (timer) clearTimeout(timer);
    if (result.kind === "heartbeat") {
      yield ": heartbeat\n\n";
      continue;
    }
    if (result.value.done) return;
    const event = result.value.value;
    pending = iterator.next();
    yield serializeSse({ event: "message", id: event.payload.cursor, data: event });
  }
}

async function* streamGatewayV2Events(input: {
  readonly gateway: AgentGatewayV2Port;
  readonly authentication: GatewayAuthenticationContext;
  readonly afterCursor: string | null;
  readonly heartbeatMilliseconds: number;
}): AsyncGenerator<string> {
  const iterator = input.gateway
    .subscribe(input.authentication, input.afterCursor)
    [Symbol.asyncIterator]();
  let pending = iterator.next();
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result:
      | { readonly kind: "item"; readonly value: IteratorResult<GatewayV2Event> }
      | { readonly kind: "heartbeat" };
    try {
      result = await Promise.race([
        pending.then((value) => ({ kind: "item" as const, value })),
        new Promise<{ readonly kind: "heartbeat" }>((resolve) => {
          timer = setTimeout(() => resolve({ kind: "heartbeat" }), input.heartbeatMilliseconds);
        }),
      ]);
    } catch (error) {
      if (error instanceof ApplicationPortError) {
        yield serializeSse({ event: "gateway.stream_error", data: { code: error.code } });
        return;
      }
      throw error;
    }
    if (timer) clearTimeout(timer);
    if (result.kind === "heartbeat") {
      yield ": heartbeat\n\n";
      continue;
    }
    if (result.value.done) return;
    const event = result.value.value;
    pending = iterator.next();
    yield serializeSse({ event: "message", id: event.payload.cursor, data: event });
  }
}

async function authenticate(
  request: FastifyRequest,
  options: HttpGatewayServerOptions,
): Promise<GatewayAuthenticationContext> {
  try {
    return await options.authentication.authenticate({
      accessAssertion: header(request, "cf-access-jwt-assertion"),
      sessionToken: cookie(request, options.sessionCookieName ?? "himawari_session"),
      method: request.method,
      path: requestPath(request),
    });
  } catch {
    throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.AUTHENTICATION_REQUIRED, 401);
  }
}

function safeAssetPath(staticRoot: string, requestedPath: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestedPath);
  } catch {
    throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.STATIC_NOT_FOUND, 404);
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const root = path.resolve(staticRoot);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.STATIC_NOT_FOUND, 404);
  }
  return target;
}

function staticContentType(target: string): string {
  switch (path.extname(target)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    default:
      return "text/html; charset=utf-8";
  }
}

export function buildHttpGatewayServer(options: HttpGatewayServerOptions): FastifyInstance {
  const publicOrigin = new URL(options.publicOrigin);
  if (publicOrigin.origin !== options.publicOrigin) {
    throw new Error("HTTP_GATEWAY_PUBLIC_ORIGIN_INVALID");
  }
  const heartbeatMilliseconds = options.heartbeatMilliseconds ?? DEFAULT_HEARTBEAT_MILLISECONDS;
  if (!Number.isSafeInteger(heartbeatMilliseconds) || heartbeatMilliseconds < 10) {
    throw new Error("HTTP_GATEWAY_HEARTBEAT_INVALID");
  }
  const app = Fastify({
    bodyLimit: options.maximumBodyBytes ?? DEFAULT_BODY_LIMIT,
    logger: false,
    trustProxy: false,
  });

  app.addHook("onSend", async (_request, reply) => {
    setSecurityHeaders(reply);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpGatewayError) {
      sendJson(reply, error.statusCode, { error: { code: error.code } });
      return;
    }
    if (error instanceof ContractValidationError) {
      sendJson(reply, 400, { error: { code: HTTP_GATEWAY_ERROR_CODES.REQUEST_INVALID } });
      return;
    }
    if (error instanceof ApplicationPortError) {
      const statusCode =
        error.code === PORT_ERROR_CODES.NOT_AUTHORITATIVE
          ? 403
          : error.code === PORT_ERROR_CODES.NOT_FOUND
            ? 404
            : 409;
      sendJson(reply, statusCode, { error: { code: error.code } });
      return;
    }
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      error.statusCode === 413
        ? 413
        : 500;
    sendJson(reply, statusCode, {
      error: {
        code:
          statusCode === 413
            ? HTTP_GATEWAY_ERROR_CODES.BODY_INVALID
            : HTTP_GATEWAY_ERROR_CODES.REQUEST_INVALID,
      },
    });
  });

  app.get("/health/live", async (_request, reply) => {
    const snapshot = options.health?.publicSnapshot();
    const live = snapshot?.live ?? true;
    return sendJson(reply, live ? 200 : 503, { status: live ? "alive" : "unavailable" });
  });
  app.get("/health/ready", async (_request, reply) => {
    const snapshot = options.health?.publicSnapshot();
    const ready = snapshot?.ready ?? true;
    return sendJson(reply, ready ? 200 : 503, {
      status: ready ? "ready" : (snapshot?.status ?? "not_ready"),
    });
  });
  if (options.health) {
    app.get("/api/health/v1/dependencies", async (request, reply) => {
      assertPublicHost(request, publicOrigin);
      await authenticate(request, options);
      return sendJson(reply, 200, options.health?.authenticatedSnapshot(true));
    });
  }
  if (options.metrics) {
    app.get("/api/metrics/v1", async (request, reply) => {
      assertPublicHost(request, publicOrigin);
      await authenticate(request, options);
      return sendJson(reply, 200, options.metrics?.authenticatedSnapshot(true));
    });
  }

  if (options.browserConfiguration && options.csrf.issue) {
    const configuration = options.browserConfiguration;
    const issueCsrf = options.csrf.issue.bind(options.csrf);
    app.get("/api/control-center/v1/config", async (request, reply) => {
      assertPublicHost(request, publicOrigin);
      const authentication = await authenticate(request, options);
      return sendJson(reply, 200, {
        ownerId: authentication.ownerId,
        agentId: configuration.agentId,
        deploymentId: configuration.deploymentId,
        authorityEpoch: configuration.authorityEpoch,
        fencingToken: configuration.fencingToken,
        actorId: authentication.subjectId,
        csrfToken: await issueCsrf(authentication),
        primaryModel: configuration.primaryModel ?? null,
        primaryModelRef: configuration.primaryModelRef ?? null,
        repositoryAllowlistRefs: configuration.repositoryAllowlistRefs ?? [],
        disclosedDataClassifications: configuration.disclosedDataClassifications ?? ["private"],
      });
    });
  }

  app.post("/api/gateway/v1/commands", async (request, reply) => {
    assertMutationBoundary(request, publicOrigin);
    const authentication = await authenticate(request, options);
    const csrfAccepted = await options.csrf.verify({
      authentication,
      token: header(request, "x-csrf-token"),
      method: request.method,
      path: requestPath(request),
    });
    if (!csrfAccepted) {
      throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.CSRF_REJECTED, 403);
    }
    const command = parseBusinessMessage(request.body, "command");
    if (header(request, "idempotency-key") !== command.idempotencyKey) {
      throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.IDEMPOTENCY_MISMATCH, 400);
    }
    return sendJson(reply, 200, await options.gateway.request(authentication, command));
  });

  app.post("/api/gateway/v1/queries", async (request, reply) => {
    assertMutationBoundary(request, publicOrigin);
    const authentication = await authenticate(request, options);
    const query = parseBusinessMessage(request.body, "query");
    return sendJson(reply, 200, await options.gateway.request(authentication, query));
  });

  app.get<{ Querystring: { readonly subscription?: string } }>(
    "/api/gateway/v1/events",
    async (request, reply) => {
      assertPublicHost(request, publicOrigin);
      const authentication = await authenticate(request, options);
      const subscription = parseSubscription(request.query.subscription);
      let stream: Readable;
      try {
        const source = streamGatewayEvents({
          gateway: options.gateway,
          authentication,
          subscription,
          heartbeatMilliseconds,
        });
        const first = await source.next();
        stream = Readable.from(
          (async function* () {
            if (!first.done) yield first.value;
            yield* source;
          })(),
        );
      } catch (error) {
        if (!(error instanceof ApplicationPortError) || error.code !== PORT_ERROR_CODES.NOT_FOUND) {
          throw error;
        }
        const snapshots = [];
        for (const query of refreshQueries(subscription).slice(0, 2)) {
          snapshots.push(await options.gateway.request(authentication, query));
        }
        stream = Readable.from(
          snapshots.length > 0
            ? snapshots.map((snapshot, index) =>
                serializeSse({
                  event: "gateway.snapshot",
                  id: `snapshot:${index + 1}`,
                  data: snapshot,
                }),
              )
            : [
                serializeSse({
                  event: "gateway.snapshot_required",
                  data: { reasonCode: "CURSOR_OUTSIDE_RETENTION" },
                }),
              ],
        );
      }
      setSecurityHeaders(reply);
      reply
        .header("cache-control", "no-cache, no-store")
        .header("connection", "keep-alive")
        .header("x-accel-buffering", "no")
        .type(SSE_CONTENT_TYPE);
      return reply.send(stream);
    },
  );

  if (options.gatewayV2) {
    const gatewayV2 = options.gatewayV2;
    app.post("/api/gateway/v2/commands", async (request, reply) => {
      assertMutationBoundary(request, publicOrigin);
      const authentication = await authenticate(request, options);
      const csrfAccepted = await options.csrf.verify({
        authentication,
        token: header(request, "x-csrf-token"),
        method: request.method,
        path: requestPath(request),
      });
      if (!csrfAccepted) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.CSRF_REJECTED, 403);
      }
      const command = parseV2BusinessMessage(request.body, "command");
      if (header(request, "idempotency-key") !== command.idempotencyKey) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.IDEMPOTENCY_MISMATCH, 400);
      }
      return sendJson(reply, 200, await gatewayV2.request(authentication, command));
    });

    app.post("/api/gateway/v2/queries", async (request, reply) => {
      assertMutationBoundary(request, publicOrigin);
      const authentication = await authenticate(request, options);
      const query = parseV2BusinessMessage(request.body, "query");
      return sendJson(reply, 200, await gatewayV2.request(authentication, query));
    });

    app.get<{ Querystring: { readonly afterCursor?: string } }>(
      "/api/gateway/v2/events",
      async (request, reply) => {
        assertPublicHost(request, publicOrigin);
        const authentication = await authenticate(request, options);
        const candidate = request.query.afterCursor ?? header(request, "last-event-id");
        const afterCursor = candidate === undefined ? null : candidate;
        if (
          afterCursor !== null &&
          (afterCursor.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(afterCursor))
        ) {
          throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.REQUEST_INVALID, 400);
        }
        const stream = Readable.from(
          streamGatewayV2Events({
            gateway: gatewayV2,
            authentication,
            afterCursor,
            heartbeatMilliseconds,
          }),
        );
        setSecurityHeaders(reply);
        reply
          .header("cache-control", "no-cache, no-store")
          .header("connection", "keep-alive")
          .header("x-accel-buffering", "no")
          .type(SSE_CONTENT_TYPE);
        return reply.send(stream);
      },
    );
  }

  if (options.payloadAdmission) {
    const payloadAdmission = options.payloadAdmission;
    app.post("/api/payload/v1/text", async (request, reply) => {
      assertMutationBoundary(request, publicOrigin);
      const authentication = await authenticate(request, options);
      const csrfAccepted = await options.csrf.verify({
        authentication,
        token: header(request, "x-csrf-token"),
        method: request.method,
        path: requestPath(request),
      });
      if (!csrfAccepted) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.CSRF_REJECTED, 403);
      }
      if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.BODY_INVALID, 400);
      }
      const body = request.body as Readonly<{
        content?: unknown;
        dataClassification?: unknown;
      }>;
      if (
        Object.keys(body).some((key) => !["content", "dataClassification"].includes(key)) ||
        typeof body.content !== "string" ||
        body.content.length === 0 ||
        body.content.length > 64 * 1024 ||
        !["public", "private", "sensitive", "restricted"].includes(
          body.dataClassification as string,
        )
      ) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.BODY_INVALID, 400);
      }
      return sendJson(
        reply,
        201,
        await payloadAdmission.protect({
          authentication,
          content: body.content,
          dataClassification: body.dataClassification as
            | "public"
            | "private"
            | "sensitive"
            | "restricted",
          contentType: "text/plain",
        }),
      );
    });
  }

  app.get("/", async (request, reply) => {
    assertPublicHost(request, publicOrigin);
    const target = safeAssetPath(options.staticRoot, "/");
    const content = await readFile(target).catch(() => null);
    if (!content || content.byteLength > (options.maximumStaticAssetBytes ?? DEFAULT_ASSET_LIMIT)) {
      throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.STATIC_NOT_FOUND, 404);
    }
    return reply.header("cache-control", "no-cache").type(staticContentType(target)).send(content);
  });

  app.get<{ Params: { readonly "*": string } }>("/assets/*", async (request, reply) => {
    assertPublicHost(request, publicOrigin);
    const target = safeAssetPath(options.staticRoot, `/assets/${request.params["*"]}`);
    const content = await readFile(target).catch(() => null);
    if (!content || content.byteLength > (options.maximumStaticAssetBytes ?? DEFAULT_ASSET_LIMIT)) {
      throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.STATIC_NOT_FOUND, 404);
    }
    return reply
      .header("cache-control", "public, max-age=31536000, immutable")
      .type(staticContentType(target))
      .send(content);
  });

  app.get<{ Params: { readonly "*": string } }>("/*", async (request, reply) => {
    assertPublicHost(request, publicOrigin);
    const requestedPath = requestPath(request);
    const accept = header(request, "accept") ?? "";
    if (
      requestedPath === "/api" ||
      requestedPath.startsWith("/api/") ||
      requestedPath === "/assets" ||
      requestedPath.startsWith("/assets/") ||
      !accept.split(",").some((value) => value.trim().startsWith("text/html"))
    ) {
      throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.STATIC_NOT_FOUND, 404);
    }
    const target = safeAssetPath(options.staticRoot, "/");
    const content = await readFile(target).catch(() => null);
    if (!content || content.byteLength > (options.maximumStaticAssetBytes ?? DEFAULT_ASSET_LIMIT)) {
      throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.STATIC_NOT_FOUND, 404);
    }
    return reply.header("cache-control", "no-cache").type(staticContentType(target)).send(content);
  });

  return app;
}
