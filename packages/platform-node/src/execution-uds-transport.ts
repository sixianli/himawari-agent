import { timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, readFile, unlink } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import type { ExecutionTransportPort } from "@himawari-agent/application";
import {
  EXECUTION_V2_SCHEMA_VERSION,
  type ExecutionV2Event,
  type ExecutionV2Request,
  type ExecutionV2Response,
  executionV2MessageSchema,
} from "@himawari-agent/execution-contracts";

const MESSAGE_PATH = "/execution/v2/messages";
const EVENTS_PATH = "/execution/v2/events";
const JSON_CONTENT_TYPE = "application/json";
const NDJSON_CONTENT_TYPE = "application/x-ndjson";

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

export class ExecutionUdsError extends Error {
  readonly code: ExecutionUdsErrorCode;
  readonly statusCode: number;

  constructor(code: ExecutionUdsErrorCode, statusCode: number, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "ExecutionUdsError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ExecutionUdsCredential {
  readonly tokenRef: string;
  readonly tokenValue: string;
}

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

interface SocketIdentity {
  readonly dev: number;
  readonly ino: number;
}

async function socketAcceptsConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const finish = (active: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(active);
    };
    socket.setTimeout(100, () => finish(true));
    socket.once("connect", () => finish(true));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code !== "ECONNREFUSED" && error.code !== "ENOENT");
    });
  });
}

function stableEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function bearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length);
}

function responseError(response: ServerResponse, error: ExecutionUdsError): void {
  response.writeHead(error.statusCode, {
    "cache-control": "no-store",
    "content-type": JSON_CONTENT_TYPE,
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify({ error: { code: error.code } }));
}

async function readBoundedBody(request: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > limit) {
      throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.BODY_TOO_LARGE, 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
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
  const stats = await lstat(tokenPath);
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
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
  private server: http.Server | null = null;
  private socketIdentity: SocketIdentity | null = null;

  constructor(options: ExecutionUdsServerOptions) {
    if (!path.isAbsolute(options.runtimeDirectory)) {
      throw new TypeError("Execution UDS runtime directory must be absolute");
    }
    if (!Number.isSafeInteger(options.maximumBodyBytes) || options.maximumBodyBytes < 1) {
      throw new TypeError("Execution UDS maximum body bytes must be a positive integer");
    }
    if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1) {
      throw new TypeError("Execution UDS timeout must be a positive integer");
    }
    this.options = options;
    this.socketPath = path.join(options.runtimeDirectory, options.socketName ?? "execution.sock");
  }

  async start(): Promise<void> {
    if (this.server) return;
    await mkdir(this.options.runtimeDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.options.runtimeDirectory, 0o700);
    try {
      const existing = await lstat(this.socketPath);
      if (
        !existing.isSocket() ||
        (typeof process.getuid === "function" && existing.uid !== process.getuid()) ||
        (await socketAcceptsConnections(this.socketPath))
      ) {
        throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.SOCKET_EXISTS, 500);
      }
      const unchanged = await lstat(this.socketPath);
      if (unchanged.dev !== existing.dev || unchanged.ino !== existing.ino) {
        throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.SOCKET_REPLACED, 500);
      }
      await unlink(this.socketPath);
    } catch (error) {
      if (error instanceof ExecutionUdsError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    const server = http.createServer((request, response) => {
      void this.handle(request, response);
    });
    server.requestTimeout = this.options.requestTimeoutMs;
    server.headersTimeout = this.options.requestTimeoutMs;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    });
    await chmod(this.socketPath, 0o600);
    const stats = await lstat(this.socketPath);
    this.socketIdentity = { dev: stats.dev, ino: stats.ino };
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    const current = await lstat(this.socketPath);
    const expected = this.socketIdentity;
    if (!expected || current.dev !== expected.dev || current.ino !== expected.ino) {
      throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.SOCKET_REPLACED, 500);
    }
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    try {
      await unlink(this.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      this.socketIdentity = null;
    }
  }

  private authenticate(request: IncomingMessage): void {
    const token = bearerToken(request);
    if (token === null || !stableEqual(token, this.options.credential.tokenValue)) {
      throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.AUTHENTICATION_FAILED, 401);
    }
    const instanceId = request.headers["x-himawari-agent-service-instance"];
    if (
      typeof instanceId !== "string" ||
      !this.options.allowedAgentServiceInstanceIds.includes(instanceId)
    ) {
      throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.INSTANCE_REJECTED, 403);
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      this.authenticate(request);
      const url = new URL(request.url ?? "/", "http://execution.local");
      if (request.method === "POST" && url.pathname === MESSAGE_PATH) {
        if (request.headers["content-type"]?.split(";", 1)[0] !== JSON_CONTENT_TYPE) {
          throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.CONTENT_TYPE_UNSUPPORTED, 415);
        }
        const body = await readBoundedBody(request, this.options.maximumBodyBytes);
        const message = assertRequestMessage(JSON.parse(body) as unknown);
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
        const afterCursor = url.searchParams.get("afterCursor");
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": NDJSON_CONTENT_TYPE,
          "x-content-type-options": "nosniff",
        });
        for await (const event of this.options.transport.events(afterCursor)) {
          response.write(`${executionV2MessageSchema.serialize(event)}\n`);
        }
        response.end();
        return;
      }
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      responseError(
        response,
        error instanceof ExecutionUdsError
          ? error
          : new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.REQUEST_FAILED, 400, error),
      );
    }
  }
}

interface RawHttpResponse {
  readonly statusCode: number;
  readonly contentType: string | undefined;
  readonly body: string;
}

export class ExecutionUdsClient implements ExecutionTransportPort {
  readonly adapterIdentity = "execution-v2-http-json-over-uds";
  readonly schemaVersion = EXECUTION_V2_SCHEMA_VERSION;
  private readonly options: ExecutionUdsClientOptions;
  private connected = false;

  constructor(options: ExecutionUdsClientOptions) {
    this.options = options;
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

  async *events(afterCursor: string | null): AsyncIterable<ExecutionV2Event> {
    const query = afterCursor === null ? "" : `?afterCursor=${encodeURIComponent(afterCursor)}`;
    const raw = await this.send({ method: "GET", path: `${EVENTS_PATH}${query}` });
    if (raw.statusCode !== 200) this.throwRemote(raw);
    if (raw.contentType?.split(";", 1)[0] !== NDJSON_CONTENT_TYPE) {
      throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.INVALID_RESPONSE, 502);
    }
    const seen = new Set<string>();
    for (const line of raw.body.split("\n")) {
      if (line.length === 0) continue;
      const event = assertEventMessage(JSON.parse(line) as unknown);
      const cursor = "cursor" in event.payload ? event.payload.cursor : null;
      if (cursor !== null && seen.has(cursor)) {
        throw new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.CURSOR_INVALID, 502);
      }
      if (cursor !== null) seen.add(cursor);
      yield event;
    }
  }

  disconnect(): void {
    this.connected = false;
  }

  private send(input: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: string;
  }): Promise<RawHttpResponse> {
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.options.socketPath,
          path: input.path,
          method: input.method,
          headers: {
            authorization: `Bearer ${this.options.credential.tokenValue}`,
            "content-type": JSON_CONTENT_TYPE,
            "x-himawari-agent-service-instance": this.options.agentServiceInstanceId,
            ...(input.body === undefined
              ? {}
              : { "content-length": String(Buffer.byteLength(input.body)) }),
          },
          timeout: this.options.requestTimeoutMs,
        },
        (response) => {
          void (async () => {
            try {
              const body = await readBoundedBody(response, this.options.maximumBodyBytes);
              resolve({
                statusCode: response.statusCode ?? 0,
                contentType: response.headers["content-type"],
                body,
              });
            } catch (error) {
              reject(error);
            }
          })();
        },
      );
      request.once("timeout", () => {
        request.destroy(new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.DEADLINE_EXCEEDED, 504));
      });
      request.once("error", (error) => {
        this.connected = false;
        reject(
          error instanceof ExecutionUdsError
            ? error
            : new ExecutionUdsError(EXECUTION_UDS_ERROR_CODES.TRANSPORT_UNAVAILABLE, 503, error),
        );
      });
      if (input.body !== undefined) request.write(input.body);
      request.end();
    });
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
