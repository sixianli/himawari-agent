import { lstat, readFile } from "node:fs/promises";
import process from "node:process";
import type { ExecutionTransportPort } from "@himawari-agent/application";
import {
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionV2Event,
  type ExecutionV2Request,
  type ExecutionV2Response,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";
import {
  AuthenticatedUdsClient,
  type AuthenticatedUdsCredential,
  AuthenticatedUdsServer,
  AuthenticatedUdsTransportError,
} from "./authenticated-uds-transport.js";

const MESSAGE_PATH = "/execution/v2/messages";
const EVENTS_PATH = "/execution/v2/events";
const JSON_CONTENT_TYPE = "application/json";
const NDJSON_CONTENT_TYPE = "application/x-ndjson";
const EVENTS_PAGINATION_HEADER = "x-himawari-events-pagination";
const EVENTS_PAGE_HEADER = "x-himawari-events-page";
const EVENTS_NEXT_CURSOR_HEADER = "x-himawari-events-next-cursor";
const EVENTS_PAGINATION_VERSION = "1";

export const EXECUTION_UDS_ERROR_CODES = Object.freeze({
  AUTHENTICATION_FAILED: "EXECUTION_UDS_AUTHENTICATION_FAILED",
  BODY_TOO_LARGE: "EXECUTION_UDS_BODY_TOO_LARGE",
  CONTENT_TYPE_UNSUPPORTED: "EXECUTION_UDS_CONTENT_TYPE_UNSUPPORTED",
  CURSOR_INVALID: "EXECUTION_UDS_CURSOR_INVALID",
  DEADLINE_EXCEEDED: "EXECUTION_UDS_DEADLINE_EXCEEDED",
  INSTANCE_REJECTED: "EXECUTION_UDS_INSTANCE_REJECTED",
  INVALID_RESPONSE: "EXECUTION_UDS_INVALID_RESPONSE",
  REQUEST_FAILED: "EXECUTION_UDS_REQUEST_FAILED",
  SOCKET_EXISTS: "EXECUTION_UDS_SOCKET_EXISTS",
  SOCKET_REPLACED: "EXECUTION_UDS_SOCKET_REPLACED",
  TRANSPORT_UNAVAILABLE: "EXECUTION_WORKER_UNAVAILABLE",
} as const);

type ExecutionUdsErrorCode =
  (typeof EXECUTION_UDS_ERROR_CODES)[keyof typeof EXECUTION_UDS_ERROR_CODES];

export class ExecutionUdsError extends AuthenticatedUdsTransportError {
  declare readonly code: ExecutionUdsErrorCode;

  constructor(code: ExecutionUdsErrorCode, statusCode: number, cause?: unknown) {
    super(code, statusCode, cause);
    this.name = "ExecutionUdsError";
  }
}

export interface ExecutionUdsCredential extends AuthenticatedUdsCredential {}

export interface ExecutionUdsServerOptions {
  readonly runtimeDirectory: string;
  readonly socketName?: string;
  readonly credential: ExecutionUdsCredential;
  readonly allowedAgentServiceInstanceIds: readonly string[];
  readonly transport: ExecutionTransportPort;
  readonly maximumBodyBytes: number;
  readonly requestTimeoutMs: number;
}

export interface ExecutionUdsClientOptions {
  readonly socketPath: string;
  readonly credential: ExecutionUdsCredential;
  readonly agentServiceInstanceId: string;
  readonly maximumBodyBytes: number;
  readonly requestTimeoutMs: number;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.DEADLINE_EXCEEDED, 504)),
          timeoutMs,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function assertRequestMessage(input: unknown): ExecutionV2Request {
  const parsed = executionV2MessageSchema.parse(input);
  if (parsed.kind !== "request") {
    throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.REQUEST_FAILED, 400);
  }
  return parsed;
}

function assertResponseMessage(input: unknown): ExecutionV2Response {
  const parsed = executionV2MessageSchema.parse(input);
  if (parsed.kind !== "response") {
    throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.INVALID_RESPONSE, 502);
  }
  return parsed;
}

function assertEventMessage(input: unknown): ExecutionV2Event {
  const parsed = executionV2MessageSchema.parse(input);
  if (parsed.kind !== "event") {
    throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.INVALID_RESPONSE, 502);
  }
  return parsed;
}

export async function readRestrictedExecutionTokenFile(
  tokenPath: string,
): Promise<ExecutionUdsCredential> {
  const stats = await lstat(tokenPath).catch(() => undefined);
  if (!stats?.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
    throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.AUTHENTICATION_FAILED, 500);
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.AUTHENTICATION_FAILED, 500);
  }
  const parsed = JSON.parse(await readFile(tokenPath, "utf8")) as unknown;
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    typeof (parsed as { tokenRef?: unknown }).tokenRef !== "string" ||
    typeof (parsed as { tokenValue?: unknown }).tokenValue !== "string" ||
    Object.keys(parsed).some((key) => !["tokenRef", "tokenValue"].includes(key))
  ) {
    throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.AUTHENTICATION_FAILED, 500);
  }
  const credential = parsed as { readonly tokenRef: string; readonly tokenValue: string };
  if (credential.tokenRef.length === 0 || credential.tokenValue.length < 32) {
    throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.AUTHENTICATION_FAILED, 500);
  }
  return Object.freeze({ ...credential });
}

export class ExecutionUdsServer {
  readonly socketPath: string;
  private readonly options: ExecutionUdsServerOptions;
  private readonly uds: AuthenticatedUdsServer;

  constructor(options: ExecutionUdsServerOptions) {
    this.options = options;
    this.uds = new AuthenticatedUdsServer({
      runtimeDirectory: options.runtimeDirectory,
      socketName: options.socketName ?? "execution.sock",
      credential: options.credential,
      allowedPeerInstanceIds: options.allowedAgentServiceInstanceIds,
      peerInstanceHeader: "x-himawari-agent-service-instance",
      maximumBodyBytes: options.maximumBodyBytes,
      requestTimeoutMs: options.requestTimeoutMs,
      errorCodes: {
        AUTHENTICATION_FAILED: EXECUTION_UDS_ERROR_CODES.AUTHENTICATION_FAILED,
        BODY_TOO_LARGE: EXECUTION_UDS_ERROR_CODES.BODY_TOO_LARGE,
        DEADLINE_EXCEEDED: EXECUTION_UDS_ERROR_CODES.DEADLINE_EXCEEDED,
        INSTANCE_REJECTED: EXECUTION_UDS_ERROR_CODES.INSTANCE_REJECTED,
        REQUEST_FAILED: EXECUTION_UDS_ERROR_CODES.REQUEST_FAILED,
        SOCKET_EXISTS: EXECUTION_UDS_ERROR_CODES.SOCKET_EXISTS,
        SOCKET_REPLACED: EXECUTION_UDS_ERROR_CODES.SOCKET_REPLACED,
        TRANSPORT_UNAVAILABLE: EXECUTION_UDS_ERROR_CODES.TRANSPORT_UNAVAILABLE,
      },
      onRequest: (request, response, body) => this.handle(request, response, body),
    });
    this.socketPath = this.uds.socketPath;
  }

  async start(): Promise<void> {
    try {
      await this.uds.start();
    } catch (error) {
      if (error instanceof AuthenticatedUdsTransportError) {
        throw new ExecutionUdsError(error.code as ExecutionUdsErrorCode, error.statusCode, error);
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    try {
      await this.uds.stop();
    } catch (error) {
      if (error instanceof AuthenticatedUdsTransportError) {
        throw new ExecutionUdsError(error.code as ExecutionUdsErrorCode, error.statusCode, error);
      }
      throw error;
    }
  }

  private async handle(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
    body: Buffer,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://execution.local");
      if (request.method === "POST" && url.pathname === MESSAGE_PATH) {
        if (request.headers["content-type"]?.split(";", 1)[0] !== JSON_CONTENT_TYPE) {
          throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.CONTENT_TYPE_UNSUPPORTED, 415);
        }
        const message = assertRequestMessage(JSON.parse(body.toString("utf8")) as unknown);
        if (
          message.type === "worker.handshake" &&
          message.payload.bootTokenRef !== this.options.credential.tokenRef
        ) {
          throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.AUTHENTICATION_FAILED, 401);
        }
        const result = await withTimeout(
          this.options.transport.request(message),
          this.options.requestTimeoutMs,
        );
        const serialized = result === null ? null : executionV2MessageSchema.parse(result);
        response.writeHead(result === null ? 202 : 200, {
          "cache-control": "no-store",
          "content-type": JSON_CONTENT_TYPE,
          "x-content-type-options": "nosniff",
        });
        response.end(JSON.stringify({ message: serialized }));
        return;
      }
      if (request.method === "GET" && url.pathname === EVENTS_PATH) {
        if (request.headers[EVENTS_PAGINATION_HEADER] !== EVENTS_PAGINATION_VERSION) {
          throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.REQUEST_FAILED, 400);
        }
        const afterCursor = url.searchParams.get("afterCursor");
        const lines: string[] = [];
        const seen = new Set(afterCursor === null ? [] : [afterCursor]);
        let bytes = 0;
        let nextCursor: string | undefined;
        let more = false;
        for await (const input of this.options.transport.events(afterCursor)) {
          const event = assertEventMessage(input);
          const line = `${executionV2MessageSchema.serialize(event)}\n`;
          const length = Buffer.byteLength(line);
          if (length > this.options.maximumBodyBytes) {
            throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.BODY_TOO_LARGE, 413);
          }
          if (seen.has(event.payload.cursor)) {
            throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.CURSOR_INVALID, 502);
          }
          if (bytes + length > this.options.maximumBodyBytes) {
            more = true;
            break;
          }
          seen.add(event.payload.cursor);
          lines.push(line);
          bytes += length;
          nextCursor = event.payload.cursor;
        }
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": NDJSON_CONTENT_TYPE,
          "x-content-type-options": "nosniff",
          [EVENTS_PAGINATION_HEADER]: EVENTS_PAGINATION_VERSION,
          [EVENTS_PAGE_HEADER]: more ? "more" : "complete",
          ...(nextCursor === undefined
            ? {}
            : { [EVENTS_NEXT_CURSOR_HEADER]: encodeURIComponent(nextCursor) }),
        });
        response.end(lines.join(""));
        return;
      }
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      throw error instanceof ExecutionUdsError
        ? error
        : new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.REQUEST_FAILED, 400, error);
    }
  }
}

interface RawHttpResponse {
  readonly headers: import("node:http").IncomingHttpHeaders;
  readonly statusCode: number;
  readonly contentType: string | undefined;
  readonly body: string;
}

export class ExecutionUdsClient implements ExecutionTransportPort {
  readonly adapterIdentity = "execution-v2-http-json-over-uds";
  readonly schemaVersion = EXECUTION_V2_SCHEMA_VERSION;
  private readonly options: ExecutionUdsClientOptions;
  private readonly uds: AuthenticatedUdsClient;
  private connected = false;

  constructor(options: ExecutionUdsClientOptions) {
    this.options = options;
    this.uds = new AuthenticatedUdsClient({
      socketPath: options.socketPath,
      credential: options.credential,
      peerInstanceId: options.agentServiceInstanceId,
      peerInstanceHeader: "x-himawari-agent-service-instance",
      maximumBodyBytes: options.maximumBodyBytes,
      requestTimeoutMs: options.requestTimeoutMs,
      errorCodes: {
        BODY_TOO_LARGE: EXECUTION_UDS_ERROR_CODES.BODY_TOO_LARGE,
        DEADLINE_EXCEEDED: EXECUTION_UDS_ERROR_CODES.DEADLINE_EXCEEDED,
        TRANSPORT_UNAVAILABLE: EXECUTION_UDS_ERROR_CODES.TRANSPORT_UNAVAILABLE,
      },
    });
  }

  isReady(): boolean {
    return this.connected;
  }

  async connect(
    handshake: Extract<ExecutionV2Request, { type: "worker.handshake" }>,
  ): Promise<Extract<ExecutionV2Response, { type: "worker.handshake.accepted" }>> {
    if (handshake.payload.agentServiceInstanceId !== this.options.agentServiceInstanceId) {
      throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.INSTANCE_REJECTED, 400);
    }
    if (handshake.payload.bootTokenRef !== this.options.credential.tokenRef) {
      throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.AUTHENTICATION_FAILED, 400);
    }
    const response = await this.request(handshake);
    if (response?.type !== "worker.handshake.accepted") {
      throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.INVALID_RESPONSE, 502);
    }
    this.connected = response.payload.ready;
    return response;
  }

  async request(message: ExecutionV2Request): Promise<ExecutionV2Response | null> {
    const parsed = assertRequestMessage(message);
    if (parsed.type === "work.execute" && Date.now() >= Date.parse(parsed.payload.deadlineAt)) {
      throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.DEADLINE_EXCEEDED, 408);
    }
    const body = executionV2MessageSchema.serialize(parsed);
    if (Buffer.byteLength(body) > this.options.maximumBodyBytes) {
      throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.BODY_TOO_LARGE, 413);
    }
    const raw = await this.send({ method: "POST", path: MESSAGE_PATH, body });
    if (raw.statusCode !== 200 && raw.statusCode !== 202) this.throwRemote(raw);
    if (raw.contentType?.split(";", 1)[0] !== JSON_CONTENT_TYPE) {
      throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.INVALID_RESPONSE, 502);
    }
    const envelope = JSON.parse(raw.body) as { readonly message?: unknown };
    return envelope.message === null ? null : assertResponseMessage(envelope.message);
  }

  events(afterCursor: string | null): AsyncIterable<ExecutionV2Event> {
    return {
      [Symbol.asyncIterator]: () => {
        const controller = new AbortController();
        const iterator = this.readEventPages(afterCursor, controller.signal);
        return {
          next: () => iterator.next(),
          return: () => {
            controller.abort();
            return iterator.return();
          },
          throw: (error: unknown) => {
            controller.abort();
            return iterator.throw(error);
          },
        };
      },
    };
  }

  private async *readEventPages(
    afterCursor: string | null,
    signal: AbortSignal,
  ): AsyncGenerator<ExecutionV2Event, void> {
    const deadline = performance.now() + this.options.requestTimeoutMs;
    const seen = new Set<string>(afterCursor === null ? [] : [afterCursor]);
    let cursor = afterCursor;
    while (true) {
      signal.throwIfAborted();
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.DEADLINE_EXCEEDED, 504);
      }
      const query = cursor === null ? "" : `?afterCursor=${encodeURIComponent(cursor)}`;
      const raw = await this.send({
        method: "GET",
        path: `${EVENTS_PATH}${query}`,
        headers: { [EVENTS_PAGINATION_HEADER]: EVENTS_PAGINATION_VERSION },
        signal,
        requestTimeoutMs: remaining,
      });
      if (raw.statusCode !== 200) this.throwRemote(raw);
      const page = raw.headers[EVENTS_PAGE_HEADER];
      if (
        raw.contentType?.split(";", 1)[0] !== NDJSON_CONTENT_TYPE ||
        raw.headers[EVENTS_PAGINATION_HEADER] !== EVENTS_PAGINATION_VERSION ||
        (page !== "more" && page !== "complete")
      ) {
        throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.INVALID_RESPONSE, 502);
      }
      const events = raw.body
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => assertEventMessage(JSON.parse(line) as unknown));
      for (const event of events) {
        if (seen.has(event.payload.cursor)) {
          throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.CURSOR_INVALID, 502);
        }
        seen.add(event.payload.cursor);
      }
      const lastCursor = events.at(-1)?.payload.cursor;
      const nextCursor = raw.headers[EVENTS_NEXT_CURSOR_HEADER];
      if (lastCursor === undefined) {
        if (page === "more" || nextCursor !== undefined) {
          throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.CURSOR_INVALID, 502);
        }
        return;
      }
      if (nextCursor !== encodeURIComponent(lastCursor)) {
        throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.CURSOR_INVALID, 502);
      }
      for (const event of events) {
        signal.throwIfAborted();
        if (performance.now() >= deadline) {
          throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.DEADLINE_EXCEEDED, 504);
        }
        yield event;
      }
      if (page === "complete") return;
      cursor = lastCursor;
    }
  }

  disconnect(): void {
    this.connected = false;
  }

  private async send(input: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
    readonly requestTimeoutMs?: number;
  }): Promise<RawHttpResponse> {
    try {
      const inputRequest = {
        method: input.method,
        path: input.path,
        contentType: JSON_CONTENT_TYPE,
        ...(input.headers === undefined ? {} : { headers: input.headers }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: input.requestTimeoutMs }),
        ...(input.body === undefined ? {} : { body: Buffer.from(input.body) }),
      } as const;
      const response = await this.uds.request(inputRequest);
      return {
        statusCode: response.statusCode,
        headers: response.headers,
        contentType: response.contentType,
        body: response.body.toString("utf8"),
      };
    } catch (error) {
      this.connected = false;
      if (error instanceof AuthenticatedUdsTransportError) {
        throw new ExecutionUdsError(error.code as ExecutionUdsErrorCode, error.statusCode, error);
      }
      throw error;
    }
  }

  private throwRemote(response: RawHttpResponse): never {
    let code: ExecutionUdsErrorCode = EXECUTION_UDS_ERROR_CODES.REQUEST_FAILED;
    try {
      const parsed = JSON.parse(response.body) as { readonly error?: { readonly code?: unknown } };
      if (
        typeof parsed.error?.code === "string" &&
        Object.values(EXECUTION_UDS_ERROR_CODES).includes(
          parsed.error.code as ExecutionUdsErrorCode,
        )
      ) {
        code = parsed.error.code as ExecutionUdsErrorCode;
      }
    } catch {
      code = EXECUTION_UDS_ERROR_CODES.INVALID_RESPONSE;
    }
    throw new ExecutionUdsError(code, response.statusCode);
  }
}
