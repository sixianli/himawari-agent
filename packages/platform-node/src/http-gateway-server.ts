import { readFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  type AgentGatewayPort,
  type AgentGatewayV2Port,
  type AgentThreadGatewayPort,
  ApplicationPortError,
  type AuditLedgerPort,
  type DeviceConfiguration,
  type GatewayAuthenticationContext,
  type GatewayV2StreamItem,
  PORT_ERROR_CODES,
  type RecentAuthenticationGuardPort,
  type VoiceGates,
} from "@himawari-agent/application";
import type { DeploymentHealthSnapshot } from "@himawari-agent/domain";
import {
  ContractValidationError,
  type EventSubscription,
  type GatewayCommand,
  type GatewayQuery,
  type GatewayV2Command,
  type GatewayV2Query,
  gatewayMessageSchema,
  gatewayV2MessageSchema,
  isGatewayErrorReasonCode,
  type StreamEvent,
  type ThreadExecutionEventsSubscription,
  type ThreadExecutionStreamEvent,
  type ThreadGatewayCommand,
  type ThreadGatewayEvent,
  type ThreadGatewayQuery,
  type ThreadGatewaySubscription,
  threadGatewayMessageSchema,
} from "@himawari-agent/gateway-contracts";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { BrowserThreadFileContent, HttpGatewayFilesPort } from "./browser-thread-files.js";
import {
  type DeviceApiRouteOptions,
  type DeviceHomePort,
  type DevicePairingAccess,
  registerDeviceApiRoutes,
  type UtterancePrefetchPort,
} from "./device-api-routes.js";
import { type DeviceGatewayAuditFailure, DeviceGatewayError } from "./device-gateway.js";
import { DeviceSignatureError } from "./device-request-signature.js";
import {
  PAIRED_DEVICE_ERROR_CODES,
  PairedDeviceError,
  type PairedDeviceService,
} from "./paired-device-service.js";
import type { PerceptionService } from "./perception-service.js";
import { withPreviewStorage } from "./preview-page-storage.js";
import type { RuntimeMetricsSnapshot } from "./runtime-observability.js";
import { PLAIN_TEXT_MAXIMUM_CHARACTERS, parseTextAdmission } from "./text-admission.js";

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
  revalidate?(authentication: GatewayAuthenticationContext): Promise<void>;
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

export interface HttpGatewaySlowRequest {
  readonly method: string;
  readonly path: string;
  readonly operation?: string;
  readonly outcome: "answered" | "aborted";
  readonly statusCode?: number;
  readonly totalMs: number;
  readonly concurrentRequests: number;
}

export interface HttpGatewayServerOptions {
  readonly onSlowRequest?: (request: HttpGatewaySlowRequest) => void;
  readonly gateway?: AgentGatewayPort;
  readonly gatewayV2?: AgentGatewayV2Port;
  readonly threadGateway?: AgentThreadGatewayPort;
  readonly payloadAdmission?: HttpGatewayPayloadAdmissionPort;
  readonly payloadRead?: HttpGatewayPayloadReadPort;
  readonly threadSearch?: HttpGatewayThreadSearchPort;
  readonly files?: HttpGatewayFilesPort;
  readonly previewOrigin?: string;
  readonly authentication: HttpGatewayAuthenticationPort;
  readonly recentAuthentication?: RecentAuthenticationGuardPort;
  readonly csrf: HttpGatewayCsrfPort;
  readonly publicOrigin: string;
  readonly staticRoot: string;
  readonly sessionCookieName?: string;
  readonly maximumBodyBytes?: number;
  readonly maximumStaticAssetBytes?: number;
  readonly heartbeatMilliseconds?: number;
  readonly devices?: {
    readonly service: PairedDeviceService;
    readonly configuration: () => DeviceConfiguration;
    readonly audit: AuditLedgerPort;
    readonly onAuditFailed?: (failure: DeviceGatewayAuditFailure) => void;
    readonly pairingAccess?: DevicePairingAccess;
    readonly perception?: PerceptionService;
    readonly home?: DeviceHomePort;
    readonly voiceGates?: () => VoiceGates;
    readonly prefetch?: UtterancePrefetchPort;
    readonly addressee?: DeviceApiRouteOptions["addressee"];
  };
  readonly health?: HttpGatewayHealthPort;
  readonly metrics?: HttpGatewayMetricsPort;
  readonly browserConfiguration?: {
    readonly executionPresentationAvailable?: boolean;
    readonly executionStateAvailable?: boolean;
    readonly executionEventsAvailable?: boolean;
    readonly executionEnvironmentAvailable?: boolean;
    readonly canCancelRun?: boolean;
    readonly availableModels?: readonly {
      ref: string;
      model: string;
      name: string;
      provider: string;
      thinkingLevels: readonly string[];
      images: boolean;
      automatic?: boolean;
      price?: { input: number; output: number };
      priceTier?: "low" | "mid" | "high";
    }[];
    readonly installedGatewayV2Operations?: readonly (GatewayV2Query | GatewayV2Command)["type"][];
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

export type HttpGatewayPayloadContentType =
  | "text/plain"
  | "text/x-himawari-attachment"
  | "text/x-himawari-image";

export interface HttpGatewayPayloadAdmissionPort {
  protect(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly idempotencyKey: string;
    readonly content: string;
    readonly dataClassification: "public" | "private" | "sensitive" | "restricted";
    readonly contentType: HttpGatewayPayloadContentType;
  }): Promise<{ readonly payloadRef: string }>;
}

export interface HttpGatewayPayloadReadPort {
  read(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly agentId: string;
    readonly payloadRef: string;
  }): Promise<{
    readonly content: string;
    readonly dataClassification: "public" | "private" | "sensitive" | "restricted";
    readonly contentType: "text/plain" | "text/x-himawari-image";
  }>;
}

export interface HttpGatewayThreadSearchPort {
  prepare(input: {
    readonly authentication: GatewayAuthenticationContext;
    readonly agentId: string;
    readonly query: string;
  }): Promise<{
    readonly queryRef: string;
    readonly tokenRefs: readonly string[];
    readonly projectionVersion: string;
  }>;
}

const JSON_CONTENT_TYPE = "application/json";
const SSE_CONTENT_TYPE = "text/event-stream; charset=utf-8";
const DEFAULT_BODY_LIMIT = 256 * 1024;
const DEFAULT_ASSET_LIMIT = 8 * 1024 * 1024;
const ATTACHMENT_TEXT_CHARACTERS = 256 * 1024;
const ATTACHMENT_BODY_LIMIT = 2 * 1024 * 1024;
const IMAGE_DATA_URL_CHARACTERS = 1_500_000;
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const DEFAULT_HEARTBEAT_MILLISECONDS = 15_000;
const SLOW_REQUEST_MILLISECONDS = 2_000;
const STREAM_PATH = /\/(?:execution-)?events$/;

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

function fileContentId(request: FastifyRequest): string | null {
  let path: string;
  try {
    path = decodeURIComponent(requestPath(request));
  } catch {
    return null;
  }
  return FILE_CONTENT_PATH.exec(path)?.[1] ?? null;
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

const FILE_CONTENT_PATH = /^\/api\/files\/v1\/content\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})$/;
const HEALTH_PATH = /^\/health\/[a-z]+$/;
const FILE_PREVIEW_PATH = /^\/preview\/([A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{1,128})$/;
const FILE_PREVIEW_TICKET_MAXIMUM_LENGTH = 512 + 1 + 128;
const FILE_KINDS = ["document", "code", "web", "image", "pdf", "data", "other"] as const;

function setPreviewHeaders(reply: FastifyReply, publicOrigin: URL): void {
  reply
    .header(
      "content-security-policy",
      `sandbox allow-scripts allow-modals allow-popups allow-downloads; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob: https:; style-src 'unsafe-inline' data: https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${publicOrigin.origin}`,
    )
    .header("cross-origin-resource-policy", "cross-origin")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("cache-control", "no-store");
}

function setFileContentHeaders(reply: FastifyReply): void {
  reply
    .header(
      "content-security-policy",
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'",
    )
    .header("cross-origin-opener-policy", "same-origin")
    .header("cross-origin-resource-policy", "same-origin")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-frame-options", "SAMEORIGIN")
    .header("cache-control", "private, no-store");
}

function contentDisposition(content: BrowserThreadFileContent): string {
  const ascii = content.fileName.replace(/[^\x20-\x7e]|["\\]/g, "_") || "file";
  return `${content.disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(content.fileName)}`;
}

function sendFileContent(reply: FastifyReply, content: BrowserThreadFileContent): FastifyReply {
  return reply
    .code(200)
    .header("content-disposition", contentDisposition(content))
    .type(
      content.mediaType.startsWith("text/")
        ? `${content.mediaType}; charset=utf-8`
        : content.mediaType,
    )
    .send(Buffer.from(content.bytes));
}

function setSecurityHeaders(reply: FastifyReply, previewOrigin?: URL): void {
  reply
    .header(
      "content-security-policy",
      `default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'self'; font-src 'self'; frame-ancestors 'none'; frame-src 'self'${previewOrigin ? ` ${previewOrigin.origin}` : ""}; img-src 'self' data:; manifest-src 'self'; script-src 'self'; style-src 'self'; worker-src 'self'`,
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

function parseThreadBusinessMessage(input: unknown, expectedKind: "command"): ThreadGatewayCommand;
function parseThreadBusinessMessage(input: unknown, expectedKind: "query"): ThreadGatewayQuery;
function parseThreadBusinessMessage(input: unknown, expectedKind: "command" | "query") {
  const parsed = threadGatewayMessageSchema.parse(input);
  if (parsed.kind !== expectedKind) {
    throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.METHOD_INVALID, 400);
  }
  return parsed;
}

function parseThreadSubscription(encoded: unknown): ThreadGatewaySubscription {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > 8192) {
    throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.REQUEST_INVALID, 400);
  }
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.REQUEST_INVALID, 400);
  }
  const parsed = threadGatewayMessageSchema.parseJson(decoded);
  if (parsed.type !== "thread.events") {
    throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.METHOD_INVALID, 400);
  }
  return parsed;
}

function parseThreadExecutionSubscription(encoded: unknown): ThreadExecutionEventsSubscription {
  if (typeof encoded !== "string" || encoded.length === 0 || encoded.length > 8192) {
    throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.REQUEST_INVALID, 400);
  }
  const parsed = threadGatewayMessageSchema.parseJson(
    Buffer.from(encoded, "base64url").toString("utf8"),
  );
  if (parsed.type !== "thread.execution_events") {
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

function heartbeatFrame(intervalMilliseconds: number) {
  return serializeSse({ event: "gateway.heartbeat", data: { intervalMilliseconds } });
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
  readonly revalidate: () => Promise<void>;
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
    try {
      await input.revalidate();
    } catch {
      yield serializeSse({
        event: "gateway.stream_error",
        data: { code: "IDENTITY_SESSION_INVALID" },
      });
      return;
    }
    if (result.kind === "heartbeat") {
      yield heartbeatFrame(input.heartbeatMilliseconds);
      continue;
    }
    if (result.value.done) return;
    const event = result.value.value;
    pending = iterator.next();
    yield serializeSse({ event: "message", id: event.payload.cursor, data: event });
  }
}

async function* streamGatewayV2Events(input: {
  readonly revalidate: () => Promise<void>;
  readonly gateway: AgentGatewayV2Port;
  readonly authentication: GatewayAuthenticationContext;
  readonly afterCursor: string | null;
  readonly heartbeatMilliseconds: number;
  readonly signal: AbortSignal;
}): AsyncGenerator<string> {
  yield ": connected\n\n";
  const iterator = input.gateway
    .subscribe(input.authentication, input.afterCursor, input.signal)
    [Symbol.asyncIterator]();
  let pending = iterator.next();
  let onAbort: () => void = () => {};
  const aborted = new Promise<{ readonly kind: "aborted" }>((resolve) => {
    onAbort = () => resolve({ kind: "aborted" });
    if (input.signal.aborted) onAbort();
    else input.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (!input.signal.aborted) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result:
        | { readonly kind: "item"; readonly value: IteratorResult<GatewayV2StreamItem> }
        | { readonly kind: "heartbeat" }
        | { readonly kind: "aborted" };
      try {
        result = await Promise.race([
          pending.then((value) => ({ kind: "item" as const, value })),
          aborted,
          new Promise<{ readonly kind: "heartbeat" }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: "heartbeat" }), input.heartbeatMilliseconds);
          }),
        ]);
      } catch (error) {
        if (input.signal.aborted) return;
        if (error instanceof ApplicationPortError) {
          yield serializeSse({ event: "gateway.stream_error", data: { code: error.code } });
          return;
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (input.signal.aborted || result.kind === "aborted") return;
      try {
        await input.revalidate();
      } catch {
        yield serializeSse({
          event: "gateway.stream_error",
          data: { code: "IDENTITY_SESSION_INVALID" },
        });
        return;
      }
      if (result.kind === "heartbeat") {
        yield heartbeatFrame(input.heartbeatMilliseconds);
        continue;
      }
      if (result.value.done) return;
      const event = result.value.value;
      if (event.kind === "snapshot_required") {
        yield serializeSse({ event: "gateway.snapshot_required", data: { reason: event.reason } });
      } else {
        yield serializeSse({ event: "message", id: event.payload.cursor, data: event });
      }
      pending = iterator.next();
    }
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    void pending.catch(() => undefined);
    void iterator.return?.().catch(() => undefined);
  }
}

async function* streamThreadGatewayEvents(input: {
  readonly revalidate: () => Promise<void>;
  readonly gateway: AgentThreadGatewayPort;
  readonly authentication: GatewayAuthenticationContext;
  readonly subscription: ThreadGatewaySubscription;
  readonly heartbeatMilliseconds: number;
  readonly include?: (event: ThreadGatewayEvent) => boolean;
}): AsyncGenerator<string> {
  yield ": connected\n\n";
  const controller = new AbortController();
  const iterator = input.gateway
    .subscribe(input.authentication, input.subscription, controller.signal)
    [Symbol.asyncIterator]();
  let pending = iterator.next();
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result:
        | { readonly kind: "item"; readonly value: IteratorResult<ThreadGatewayEvent> }
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
          yield serializeSse({
            event:
              error.code === PORT_ERROR_CODES.NOT_FOUND
                ? "thread.snapshot_required"
                : "gateway.stream_error",
            data: {
              code: error.code,
              ...(error.code === PORT_ERROR_CODES.NOT_FOUND
                ? { reasonCode: "CURSOR_OUTSIDE_RETENTION" }
                : {}),
            },
          });
          return;
        }
        throw error;
      }
      if (timer) clearTimeout(timer);
      try {
        await input.revalidate();
      } catch {
        yield serializeSse({
          event: "gateway.stream_error",
          data: { code: "IDENTITY_SESSION_INVALID" },
        });
        return;
      }
      if (result.kind === "heartbeat") {
        yield heartbeatFrame(input.heartbeatMilliseconds);
        continue;
      }
      if (result.value.done) return;
      const event = result.value.value;
      yield input.include && !input.include(event)
        ? serializeSse({
            event: "device.scanned",
            id: event.payload.cursor,
            data: { cursor: event.payload.cursor },
          })
        : serializeSse({ event: "message", id: event.payload.cursor, data: event });
      pending = iterator.next();
    }
  } finally {
    controller.abort();
    void pending.catch(() => undefined);
    void iterator.return?.().catch(() => undefined);
  }
}

async function* streamThreadExecutionEvents(input: {
  readonly revalidate: () => Promise<void>;
  readonly watch: NonNullable<AgentThreadGatewayPort["watchExecution"]>;
  readonly authentication: GatewayAuthenticationContext;
  readonly subscription: ThreadExecutionEventsSubscription;
  readonly heartbeatMilliseconds: number;
}): AsyncGenerator<string> {
  yield ": connected\n\n";
  const controller = new AbortController();
  const iterator = input
    .watch(input.authentication, input.subscription, controller.signal)
    [Symbol.asyncIterator]();
  let pending = iterator.next();
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result:
        | { readonly kind: "item"; readonly value: IteratorResult<ThreadExecutionStreamEvent> }
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
          yield error.code === PORT_ERROR_CODES.NOT_FOUND
            ? serializeSse({
                event: "thread.execution_unavailable",
                data: { code: error.code },
              })
            : serializeSse({ event: "gateway.stream_error", data: { code: error.code } });
          return;
        }
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
      try {
        await input.revalidate();
      } catch {
        yield serializeSse({
          event: "gateway.stream_error",
          data: { code: "IDENTITY_SESSION_INVALID" },
        });
        return;
      }
      if (result.kind === "heartbeat") {
        yield heartbeatFrame(input.heartbeatMilliseconds);
        continue;
      }
      if (result.value.done) return;
      yield serializeSse({ event: result.value.value.type, data: result.value.value });
      pending = iterator.next();
    }
  } finally {
    controller.abort();
    void pending.catch(() => undefined);
    void iterator.return?.().catch(() => undefined);
  }
}

export function authenticateHttpRequest(
  request: FastifyRequest,
  options: Pick<HttpGatewayServerOptions, "authentication" | "sessionCookieName">,
): Promise<GatewayAuthenticationContext> {
  return authenticate(request, options);
}

async function authenticate(
  request: FastifyRequest,
  options: Pick<HttpGatewayServerOptions, "authentication" | "sessionCookieName">,
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
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".woff2":
      return "font/woff2";
    case ".bcmap":
    case ".pfb":
    case ".ttf":
      return "application/octet-stream";
    case ".wasm":
      return "application/wasm";
    case ".webmanifest":
      return "application/manifest+json";
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
    forceCloseConnections: true,
    routerOptions: { maxParamLength: FILE_PREVIEW_TICKET_MAXIMUM_LENGTH },
  });

  const previewOrigin = options.previewOrigin ? new URL(options.previewOrigin) : undefined;
  const deviceApiInstalled = Boolean(
    options.devices &&
      options.threadGateway &&
      options.payloadAdmission &&
      options.browserConfiguration,
  );
  if (
    previewOrigin &&
    (previewOrigin.origin !== options.previewOrigin || previewOrigin.host === publicOrigin.host)
  ) {
    throw new Error("HTTP_GATEWAY_PREVIEW_ORIGIN_INVALID");
  }
  const previewRequest = (request: FastifyRequest) =>
    previewOrigin !== undefined && header(request, "host") === previewOrigin.host;

  const onSlowRequest = options.onSlowRequest;
  if (onSlowRequest) {
    const started = new WeakMap<FastifyRequest, { at: number; concurrent: number }>();
    let inFlight = 0;
    const finish = (
      request: FastifyRequest,
      outcome: HttpGatewaySlowRequest["outcome"],
      statusCode?: number,
    ) => {
      const start = started.get(request);
      if (!start) return;
      started.delete(request);
      inFlight -= 1;
      const totalMs = Math.round(performance.now() - start.at);
      const path = requestPath(request);
      if (totalMs < SLOW_REQUEST_MILLISECONDS || STREAM_PATH.test(path)) return;
      const body = request.body as { readonly type?: unknown } | undefined;
      onSlowRequest({
        method: request.method,
        path,
        ...(typeof body?.type === "string" ? { operation: body.type } : {}),
        outcome,
        ...(statusCode === undefined ? {} : { statusCode }),
        totalMs,
        concurrentRequests: start.concurrent,
      });
    };
    app.addHook("onRequest", async (request) => {
      inFlight += 1;
      started.set(request, { at: performance.now(), concurrent: inFlight });
    });
    app.addHook("onResponse", async (request, reply) =>
      finish(request, "answered", reply.statusCode),
    );
    app.addHook("onRequestAbort", async (request) => finish(request, "aborted"));
  }

  app.addHook("onRequest", async (request) => {
    const path = requestPath(request);
    if (header(request, "host") === publicOrigin.host || HEALTH_PATH.test(path)) return;
    if (previewRequest(request) && request.method === "GET" && FILE_PREVIEW_PATH.test(path)) return;
    throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.ORIGIN_REJECTED, 403);
  });

  app.addHook("onSend", async (request, reply) => {
    if (previewRequest(request)) {
      setPreviewHeaders(reply, publicOrigin);
      return;
    }
    if (fileContentId(request) !== null && reply.statusCode === 200) {
      setFileContentHeaders(reply);
      return;
    }
    setSecurityHeaders(reply, previewOrigin);
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof PairedDeviceError) {
      sendJson(reply, error.statusCode, { error: { ...error.details, code: error.code } });
      return;
    }
    if (error instanceof DeviceGatewayError) {
      sendJson(reply, error.statusCode, { error: { code: error.code } });
      return;
    }
    if (error instanceof DeviceSignatureError) {
      sendJson(reply, 401, {
        error: {
          code: error.code,
          ...(error.serverTime === undefined ? {} : { serverTime: error.serverTime }),
        },
      });
      return;
    }
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
            : error.code === PORT_ERROR_CODES.OPERATION_NOT_INSTALLED
              ? 501
              : 409;
      sendJson(reply, statusCode, {
        error: {
          code: error.code,
          ...(isGatewayErrorReasonCode(error.message) ? { reasonCode: error.message } : {}),
        },
      });
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
      let recentAuthenticationRef: string | null = null;
      if (options.recentAuthentication) {
        try {
          const evidence = await options.recentAuthentication.assertRecentAuthentication({
            authentication,
            expectedAuthenticationRef:
              authentication.recentAuthenticationEvidence?.authenticationRef ?? null,
          });
          recentAuthenticationRef = evidence.authenticationRef;
        } catch (error) {
          if (
            !(error instanceof ApplicationPortError) ||
            error.code !== PORT_ERROR_CODES.NOT_AUTHORITATIVE
          ) {
            throw error;
          }
        }
      }
      return sendJson(reply, 200, {
        ownerId: authentication.ownerId,
        installedGatewayV2Operations: configuration.installedGatewayV2Operations ?? [],
        healthDependenciesAvailable: options.health !== undefined,
        filesAvailable: options.files !== undefined,
        filePreviewAvailable: options.files !== undefined && previewOrigin !== undefined,
        installedDeviceApi: deviceApiInstalled,
        agentId: configuration.agentId,
        deploymentId: configuration.deploymentId,
        authorityEpoch: configuration.authorityEpoch,
        fencingToken: configuration.fencingToken,
        actorId: authentication.subjectId,
        sessionId: authentication.sessionId ?? null,
        csrfToken: await issueCsrf(authentication),
        authorizationRef: authentication.authenticationRef,
        recentAuthenticationRef,
        executionPresentationAvailable: configuration.executionPresentationAvailable ?? false,
        executionStateAvailable: configuration.executionStateAvailable ?? false,
        executionEventsAvailable: configuration.executionEventsAvailable ?? false,
        executionEnvironmentAvailable: configuration.executionEnvironmentAvailable ?? false,
        canCancelRun: configuration.canCancelRun ?? false,
        availableModels: configuration.availableModels ?? [],
        primaryModel: configuration.primaryModel ?? null,
        primaryModelRef: configuration.primaryModelRef ?? null,
        repositoryAllowlistRefs: configuration.repositoryAllowlistRefs ?? [],
        disclosedDataClassifications: configuration.disclosedDataClassifications ?? ["private"],
      });
    });
  }

  if (options.gateway) {
    const gateway = options.gateway;
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
      return sendJson(reply, 200, await gateway.request(authentication, command));
    });

    app.post("/api/gateway/v1/queries", async (request, reply) => {
      assertMutationBoundary(request, publicOrigin);
      const authentication = await authenticate(request, options);
      const query = parseBusinessMessage(request.body, "query");
      return sendJson(reply, 200, await gateway.request(authentication, query));
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
            gateway,
            authentication,
            subscription,
            heartbeatMilliseconds,
            revalidate: () =>
              options.authentication.revalidate?.(authentication) ?? Promise.resolve(),
          });
          const first = await source.next();
          stream = Readable.from(
            (async function* () {
              if (!first.done) yield first.value;
              yield* source;
            })(),
          );
        } catch (error) {
          if (
            !(error instanceof ApplicationPortError) ||
            error.code !== PORT_ERROR_CODES.NOT_FOUND
          ) {
            throw error;
          }
          const snapshots = [];
          for (const query of refreshQueries(subscription).slice(0, 2)) {
            snapshots.push(await gateway.request(authentication, query));
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
        setSecurityHeaders(reply, previewOrigin);
        reply
          .header("cache-control", "no-cache, no-store")
          .header("connection", "keep-alive")
          .header("x-accel-buffering", "no")
          .type(SSE_CONTENT_TYPE);
        return reply.send(stream);
      },
    );
  }

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
        const controller = new AbortController();
        reply.raw.once("close", () => controller.abort());
        const stream = Readable.from(
          streamGatewayV2Events({
            gateway: gatewayV2,
            authentication,
            afterCursor,
            heartbeatMilliseconds,
            revalidate: () =>
              options.authentication.revalidate?.(authentication) ?? Promise.resolve(),
            signal: controller.signal,
          }),
        );
        setSecurityHeaders(reply, previewOrigin);
        reply
          .header("cache-control", "no-cache, no-store")
          .header("connection", "keep-alive")
          .header("x-accel-buffering", "no")
          .type(SSE_CONTENT_TYPE);
        return reply.send(stream);
      },
    );
  }

  if (options.threadGateway) {
    const threadGateway = options.threadGateway;
    app.post("/api/gateway/thread/v3/commands", async (request, reply) => {
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
      const command = parseThreadBusinessMessage(request.body, "command");
      if (header(request, "idempotency-key") !== command.idempotencyKey) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.IDEMPOTENCY_MISMATCH, 400);
      }
      return sendJson(reply, 200, await threadGateway.request(authentication, command));
    });

    app.post("/api/gateway/thread/v3/queries", async (request, reply) => {
      assertMutationBoundary(request, publicOrigin);
      const authentication = await authenticate(request, options);
      const query = parseThreadBusinessMessage(request.body, "query");
      return sendJson(reply, 200, await threadGateway.request(authentication, query));
    });

    app.get<{ Querystring: { readonly subscription?: string } }>(
      "/api/gateway/thread/v3/events",
      async (request, reply) => {
        assertPublicHost(request, publicOrigin);
        const authentication = await authenticate(request, options);
        const subscription = parseThreadSubscription(request.query.subscription);
        const stream = Readable.from(
          streamThreadGatewayEvents({
            gateway: threadGateway,
            authentication,
            subscription,
            heartbeatMilliseconds,
            revalidate: () =>
              options.authentication.revalidate?.(authentication) ?? Promise.resolve(),
          }),
        );
        setSecurityHeaders(reply, previewOrigin);
        reply
          .header("cache-control", "no-cache, no-store")
          .header("connection", "keep-alive")
          .header("x-accel-buffering", "no")
          .type(SSE_CONTENT_TYPE);
        return reply.send(stream);
      },
    );

    const watchExecution = threadGateway.watchExecution?.bind(threadGateway);
    if (watchExecution && options.browserConfiguration?.executionEventsAvailable) {
      app.get<{ Querystring: { readonly subscription?: string } }>(
        "/api/gateway/thread/v3/execution-events",
        async (request, reply) => {
          assertPublicHost(request, publicOrigin);
          const authentication = await authenticate(request, options);
          const subscription = parseThreadExecutionSubscription(request.query.subscription);
          const stream = Readable.from(
            streamThreadExecutionEvents({
              watch: watchExecution,
              authentication,
              subscription,
              heartbeatMilliseconds,
              revalidate: () =>
                options.authentication.revalidate?.(authentication) ?? Promise.resolve(),
            }),
          );
          setSecurityHeaders(reply, previewOrigin);
          reply
            .header("cache-control", "no-cache, no-store")
            .header("connection", "keep-alive")
            .header("x-accel-buffering", "no")
            .type(SSE_CONTENT_TYPE);
          return reply.send(stream);
        },
      );
    }
  }

  if (
    options.devices &&
    options.threadGateway &&
    options.payloadAdmission &&
    options.browserConfiguration
  ) {
    const payloadAdmission = options.payloadAdmission;
    const browserConfiguration = options.browserConfiguration;
    const deviceWatchExecution = options.threadGateway.watchExecution?.bind(options.threadGateway);
    registerDeviceApiRoutes(app, {
      publicOrigin,
      ...(options.devices.home ? { home: options.devices.home } : {}),
      devices: options.devices.service,
      configuration: options.devices.configuration,
      ...(options.devices.pairingAccess ? { pairingAccess: options.devices.pairingAccess } : {}),
      ...(options.devices.perception ? { perception: options.devices.perception } : {}),
      ...(options.devices.voiceGates ? { voiceGates: options.devices.voiceGates } : {}),
      ...(options.devices.prefetch ? { prefetch: options.devices.prefetch } : {}),
      ...(options.devices.addressee ? { addressee: options.devices.addressee } : {}),
      authority: {
        agentId: browserConfiguration.agentId,
        deploymentId: browserConfiguration.deploymentId,
        authorityEpoch: browserConfiguration.authorityEpoch,
        fencingToken: browserConfiguration.fencingToken,
      },
      threadGateway: options.threadGateway,
      gateways: {
        ...(options.gateway ? { v1: options.gateway } : {}),
        ...(options.gatewayV2 ? { v2: options.gatewayV2 } : {}),
        "thread-v3": options.threadGateway,
      },
      audit: options.devices.audit,
      ...(options.devices.onAuditFailed ? { onAuditFailed: options.devices.onAuditFailed } : {}),
      protectText: async (input) =>
        (
          await payloadAdmission.protect({
            authentication: input.authentication,
            idempotencyKey: input.idempotencyKey,
            content: input.content,
            dataClassification: input.dataClassification ?? "private",
            contentType: "text/plain",
          })
        ).payloadRef,
      streamThreadEvents: streamThreadGatewayEvents,
      ...(options.payloadRead
        ? {
            readPayload: ({ authentication, payloadRef }) =>
              (options.payloadRead as HttpGatewayPayloadReadPort).read({
                authentication,
                agentId: browserConfiguration.agentId,
                payloadRef,
              }),
          }
        : {}),
      ...(deviceWatchExecution
        ? {
            streamExecution: (input) =>
              streamThreadExecutionEvents({ ...input, watch: deviceWatchExecution }),
          }
        : {}),
      webAuthenticate: (request) => {
        assertMutationBoundary(request, publicOrigin);
        return authenticate(request, options);
      },
      webMutationGuard: async (request, authentication) => {
        const accepted = await options.csrf.verify({
          authentication,
          token: header(request, "x-csrf-token"),
          method: request.method,
          path: requestPath(request),
        });
        if (!accepted) throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.CSRF_REJECTED, 403);
      },
      setStreamHeaders: (reply) => {
        setSecurityHeaders(reply, previewOrigin);
        reply
          .header("cache-control", "no-cache, no-store")
          .header("connection", "keep-alive")
          .header("x-accel-buffering", "no")
          .type(SSE_CONTENT_TYPE);
      },
      sendJson,
      rejectNotAllowed: () => {
        throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.PATH_NOT_ALLOWED, 404);
      },
      rejectBody: (statusCode) => {
        if (statusCode === 413)
          throw new PairedDeviceError(PAIRED_DEVICE_ERROR_CODES.BODY_TOO_LARGE, 413);
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.BODY_INVALID, statusCode);
      },
      rejectError: (error) => {
        throw error;
      },
    });
  }

  if (options.payloadAdmission) {
    const payloadAdmission = options.payloadAdmission;
    const admitText =
      (
        maximumCharacters: number,
        contentType: HttpGatewayPayloadContentType,
        accepts: (content: string) => boolean = () => true,
      ) =>
      async (request: FastifyRequest, reply: FastifyReply) => {
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
        const idempotencyKey = header(request, "idempotency-key");
        if (
          !idempotencyKey ||
          idempotencyKey.length > 128 ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(idempotencyKey)
        ) {
          throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.IDEMPOTENCY_MISMATCH, 400);
        }
        if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
          throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.BODY_INVALID, 400);
        }
        const admitted = parseTextAdmission(
          request.body as Readonly<Record<string, unknown>>,
          maximumCharacters,
          accepts,
        );
        if (!admitted) throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.BODY_INVALID, 400);
        return sendJson(
          reply,
          201,
          await payloadAdmission.protect({
            authentication,
            idempotencyKey,
            ...admitted,
            contentType,
          }),
        );
      };
    app.post("/api/payload/v1/text", admitText(PLAIN_TEXT_MAXIMUM_CHARACTERS, "text/plain"));
    app.post(
      "/api/payload/v1/attachment",
      { bodyLimit: ATTACHMENT_BODY_LIMIT },
      admitText(ATTACHMENT_TEXT_CHARACTERS, "text/x-himawari-attachment"),
    );
    app.post(
      "/api/payload/v1/image",
      { bodyLimit: ATTACHMENT_BODY_LIMIT },
      admitText(IMAGE_DATA_URL_CHARACTERS, "text/x-himawari-image", (content) =>
        IMAGE_DATA_URL.test(content),
      ),
    );
  }

  if (options.payloadRead) {
    const payloadRead = options.payloadRead;
    app.post("/api/payload/v1/text/read", async (request, reply) => {
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
      const body = request.body as { readonly payloadRef?: unknown };
      if (
        Object.keys(body).some((key) => key !== "payloadRef") ||
        typeof body.payloadRef !== "string" ||
        body.payloadRef.length > 128 ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(body.payloadRef)
      ) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.BODY_INVALID, 400);
      }
      const agentId = options.browserConfiguration?.agentId;
      if (!agentId) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.SCOPE_REJECTED, 403);
      }
      return sendJson(
        reply,
        200,
        await payloadRead.read({
          authentication,
          agentId,
          payloadRef: body.payloadRef,
        }),
      );
    });
  }

  if (options.files) {
    const files = options.files;
    const filesRequest = async (request: FastifyRequest) => {
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
      const agentId = options.browserConfiguration?.agentId;
      if (!agentId) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.SCOPE_REJECTED, 403);
      }
      if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.BODY_INVALID, 400);
      }
      return { authentication, agentId, body: request.body as Record<string, unknown> };
    };
    const fileId = (body: Record<string, unknown>): string => {
      if (
        Object.keys(body).some((key) => key !== "fileId") ||
        typeof body["fileId"] !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body["fileId"])
      ) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.BODY_INVALID, 400);
      }
      return body["fileId"];
    };
    const optionalText = (value: unknown, maximum: number): string | null => {
      if (value === undefined || value === null) return null;
      if (typeof value !== "string" || value.length > maximum) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.BODY_INVALID, 400);
      }
      return value;
    };
    app.post("/api/files/v1/list", async (request, reply) => {
      const { authentication, agentId, body } = await filesRequest(request);
      if (
        Object.keys(body).some(
          (key) => !["threadId", "kind", "origin", "search", "before", "limit"].includes(key),
        ) ||
        (body["origin"] !== undefined &&
          body["origin"] !== null &&
          body["origin"] !== "uploaded" &&
          body["origin"] !== "generated") ||
        (body["kind"] !== undefined &&
          body["kind"] !== null &&
          !FILE_KINDS.includes(body["kind"] as (typeof FILE_KINDS)[number])) ||
        (body["limit"] !== undefined &&
          (!Number.isSafeInteger(body["limit"]) ||
            Number(body["limit"]) < 1 ||
            Number(body["limit"]) > 200))
      ) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.BODY_INVALID, 400);
      }
      return sendJson(
        reply,
        200,
        await files.list({
          authentication,
          agentId,
          threadId: optionalText(body["threadId"], 128),
          kind: (body["kind"] ?? null) as (typeof FILE_KINDS)[number] | null,
          origin: (body["origin"] ?? null) as "uploaded" | "generated" | null,
          search: optionalText(body["search"], 256),
          before: optionalText(body["before"], 512),
          limit: (body["limit"] as number | undefined) ?? 50,
        }),
      );
    });
    app.post("/api/files/v1/versions", async (request, reply) => {
      const { authentication, agentId, body } = await filesRequest(request);
      return sendJson(
        reply,
        200,
        await files.versions({ authentication, agentId, fileId: fileId(body) }),
      );
    });
    app.post("/api/files/v1/preview-ticket", async (request, reply) => {
      const { authentication, agentId, body } = await filesRequest(request);
      return sendJson(
        reply,
        200,
        await files.previewTicket({ authentication, agentId, fileId: fileId(body) }),
      );
    });
    app.get("/api/files/v1/content/:fileId", async (request, reply) => {
      assertPublicHost(request, publicOrigin);
      const contentId = fileContentId(request);
      if (!contentId) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.REQUEST_INVALID, 400);
      }
      const site = header(request, "sec-fetch-site");
      if (site !== null && site !== "same-origin" && site !== "none") {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.ORIGIN_REJECTED, 403);
      }
      const authentication = await authenticate(request, options);
      const agentId = options.browserConfiguration?.agentId;
      if (!agentId) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.SCOPE_REJECTED, 403);
      }
      const query = request.query as Record<string, unknown>;
      if (Object.keys(query).some((key) => key !== "download")) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.REQUEST_INVALID, 400);
      }
      return sendFileContent(
        reply,
        await files.content({
          authentication,
          agentId,
          fileId: contentId,
          download: query["download"] === "1",
        }),
      );
    });
    if (previewOrigin) {
      app.get("/preview/:ticket", async (request, reply) => {
        const match = FILE_PREVIEW_PATH.exec(requestPath(request));
        if (!previewRequest(request) || !match?.[1]) {
          throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.STATIC_NOT_FOUND, 404);
        }
        return sendFileContent(
          reply,
          withPreviewStorage(await files.preview({ ticket: match[1] })),
        );
      });
    }
  }

  if (options.threadSearch) {
    const threadSearch = options.threadSearch;
    app.post("/api/thread-search/v1/prepare", async (request, reply) => {
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
      const agentId = options.browserConfiguration?.agentId;
      if (!agentId) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.SCOPE_REJECTED, 403);
      }
      if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.BODY_INVALID, 400);
      }
      const body = request.body as { readonly query?: unknown };
      if (
        Object.keys(body).some((key) => key !== "query") ||
        typeof body.query !== "string" ||
        body.query.trim().length === 0 ||
        body.query.length > 2048
      ) {
        throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.BODY_INVALID, 400);
      }
      return sendJson(
        reply,
        200,
        await threadSearch.prepare({ authentication, agentId, query: body.query }),
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

  const sendHomeScreenFile = async (
    request: FastifyRequest,
    reply: FastifyReply,
    relative: string,
    cacheControl: string,
  ) => {
    assertPublicHost(request, publicOrigin);
    const target = safeAssetPath(options.staticRoot, relative);
    const content = await readFile(target).catch(() => null);
    if (!content || content.byteLength > (options.maximumStaticAssetBytes ?? DEFAULT_ASSET_LIMIT)) {
      throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.STATIC_NOT_FOUND, 404);
    }
    return reply
      .header("cache-control", cacheControl)
      .type(staticContentType(target))
      .send(content);
  };
  for (const file of ["/sw.js", "/manifest.webmanifest"])
    app.get(file, (request, reply) => sendHomeScreenFile(request, reply, file, "no-cache"));
  app.get("/apple-touch-icon.png", (request, reply) =>
    sendHomeScreenFile(request, reply, "/apple-touch-icon.png", "public, max-age=86400"),
  );
  app.get<{ Params: { readonly "*": string } }>("/icons/*", (request, reply) => {
    if (!/^[a-z0-9-]+\.png$/.test(request.params["*"]))
      throw new HttpGatewayError(HTTP_GATEWAY_ERROR_CODES.STATIC_NOT_FOUND, 404);
    return sendHomeScreenFile(
      request,
      reply,
      `/icons/${request.params["*"]}`,
      "public, max-age=86400",
    );
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
