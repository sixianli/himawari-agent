import { timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";

export const AUTHENTICATED_UDS_ERROR_CODES = Object.freeze({
  AUTHENTICATION_FAILED: "UDS_AUTHENTICATION_FAILED",
  BODY_TOO_LARGE: "UDS_BODY_TOO_LARGE",
  DEADLINE_EXCEEDED: "UDS_DEADLINE_EXCEEDED",
  INSTANCE_REJECTED: "UDS_INSTANCE_REJECTED",
  REQUEST_FAILED: "UDS_REQUEST_FAILED",
  SOCKET_EXISTS: "UDS_SOCKET_EXISTS",
  SOCKET_REPLACED: "UDS_SOCKET_REPLACED",
  TRANSPORT_UNAVAILABLE: "UDS_TRANSPORT_UNAVAILABLE",
} as const);

export type AuthenticatedUdsErrorCode =
  (typeof AUTHENTICATED_UDS_ERROR_CODES)[keyof typeof AUTHENTICATED_UDS_ERROR_CODES];

export type AuthenticatedUdsErrorCodeOverrides = Partial<
  Record<keyof typeof AUTHENTICATED_UDS_ERROR_CODES, string>
>;

export class AuthenticatedUdsTransportError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "AuthenticatedUdsTransportError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface AuthenticatedUdsCredential {
  readonly tokenRef: string;
  readonly tokenValue: string;
}

export type AuthenticatedUdsRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  body: Buffer,
) => Promise<void>;

export interface AuthenticatedUdsServerOptions {
  readonly runtimeDirectory: string;
  readonly socketName?: string;
  readonly credential: AuthenticatedUdsCredential;
  readonly allowedPeerInstanceIds: readonly string[];
  readonly peerInstanceHeader: string;
  readonly maximumBodyBytes: number;
  readonly requestTimeoutMs: number;
  readonly errorCodes?: AuthenticatedUdsErrorCodeOverrides;
  readonly onRequest: AuthenticatedUdsRequestHandler;
}

export interface AuthenticatedUdsClientOptions {
  readonly socketPath: string;
  readonly credential: AuthenticatedUdsCredential;
  readonly peerInstanceId: string;
  readonly peerInstanceHeader: string;
  readonly maximumBodyBytes: number;
  readonly requestTimeoutMs: number;
  readonly errorCodes?: AuthenticatedUdsErrorCodeOverrides;
}

export interface AuthenticatedUdsHttpResponse {
  readonly statusCode: number;
  readonly contentType: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

interface SocketIdentity {
  readonly dev: number;
  readonly ino: number;
}

function errorCode(
  overrides: AuthenticatedUdsErrorCodeOverrides | undefined,
  key: keyof typeof AUTHENTICATED_UDS_ERROR_CODES,
): string {
  return overrides?.[key] ?? AUTHENTICATED_UDS_ERROR_CODES[key];
}

function errorFor(
  overrides: AuthenticatedUdsErrorCodeOverrides | undefined,
  key: keyof typeof AUTHENTICATED_UDS_ERROR_CODES,
  statusCode: number,
  cause?: unknown,
): AuthenticatedUdsTransportError {
  return new AuthenticatedUdsTransportError(errorCode(overrides, key), statusCode, cause);
}

function stableEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function assertCredential(credential: AuthenticatedUdsCredential): void {
  if (credential.tokenRef.length === 0 || Buffer.byteLength(credential.tokenValue) < 32) {
    throw new TypeError("Authenticated UDS credential must contain a scoped token");
  }
}

function bearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length);
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

export async function readAuthenticatedUdsBody(
  request: AsyncIterable<Buffer | string>,
  limit: number,
  errorCodes?: AuthenticatedUdsErrorCodeOverrides,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > limit) {
      throw errorFor(errorCodes, "BODY_TOO_LARGE", 413);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function responseError(response: ServerResponse, error: AuthenticatedUdsTransportError): void {
  response.writeHead(error.statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify({ error: { code: error.code } }));
}

async function withAbsoluteTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  errorCodes: AuthenticatedUdsErrorCodeOverrides | undefined,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(errorFor(errorCodes, "DEADLINE_EXCEEDED", 504));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class AuthenticatedUdsServer {
  readonly socketPath: string;
  private readonly options: AuthenticatedUdsServerOptions;
  private server: http.Server | null = null;
  private socketIdentity: SocketIdentity | null = null;

  constructor(options: AuthenticatedUdsServerOptions) {
    if (!path.isAbsolute(options.runtimeDirectory)) {
      throw new TypeError("Authenticated UDS runtime directory must be absolute");
    }
    assertCredential(options.credential);
    if (!Number.isSafeInteger(options.maximumBodyBytes) || options.maximumBodyBytes < 1) {
      throw new TypeError("Authenticated UDS maximum body bytes must be a positive integer");
    }
    if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1) {
      throw new TypeError("Authenticated UDS timeout must be a positive integer");
    }
    if (options.peerInstanceHeader.length === 0) {
      throw new TypeError("Authenticated UDS peer instance header is required");
    }
    const socketName = options.socketName ?? "authenticated.sock";
    if (
      socketName.length === 0 ||
      socketName === "." ||
      socketName === ".." ||
      path.basename(socketName) !== socketName
    ) {
      throw new TypeError("Authenticated UDS socket name must stay inside the runtime directory");
    }
    this.options = options;
    this.socketPath = path.join(options.runtimeDirectory, socketName);
    // macOS sun_path has 104 bytes including NUL; Linux has 108. Node
    // can silently truncate an oversized address, so reject before binding.
    const maximumSocketPathBytes = process.platform === "darwin" ? 103 : 107;
    if (Buffer.byteLength(this.socketPath, "utf8") > maximumSocketPathBytes)
      throw new TypeError(`Authenticated UDS socket path exceeds ${maximumSocketPathBytes} bytes`);
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
        throw errorFor(this.options.errorCodes, "SOCKET_EXISTS", 500);
      }
      const unchanged = await lstat(this.socketPath);
      if (unchanged.dev !== existing.dev || unchanged.ino !== existing.ino) {
        throw errorFor(this.options.errorCodes, "SOCKET_REPLACED", 500);
      }
      await unlink(this.socketPath);
    } catch (error) {
      if (error instanceof AuthenticatedUdsTransportError) throw error;
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
      throw errorFor(this.options.errorCodes, "SOCKET_REPLACED", 500);
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
      throw errorFor(this.options.errorCodes, "AUTHENTICATION_FAILED", 401);
    }
    const instanceId = request.headers[this.options.peerInstanceHeader];
    if (
      typeof instanceId !== "string" ||
      !this.options.allowedPeerInstanceIds.includes(instanceId)
    ) {
      throw errorFor(this.options.errorCodes, "INSTANCE_REJECTED", 403);
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let deadlineExceeded = false;
    try {
      this.authenticate(request);
      await withAbsoluteTimeout(
        (async () => {
          const body = await readAuthenticatedUdsBody(
            request,
            this.options.maximumBodyBytes,
            this.options.errorCodes,
          );
          if (
            deadlineExceeded ||
            response.headersSent ||
            response.writableEnded ||
            response.destroyed
          ) {
            return;
          }
          await this.options.onRequest(request, response, body);
        })(),
        this.options.requestTimeoutMs,
        this.options.errorCodes,
        () => {
          deadlineExceeded = true;
        },
      );
    } catch (error) {
      if (
        error instanceof AuthenticatedUdsTransportError &&
        error.code === errorCode(this.options.errorCodes, "DEADLINE_EXCEEDED") &&
        !response.headersSent
      ) {
        responseError(response, error);
        return;
      }
      if (response.headersSent || response.writableEnded || response.destroyed) {
        response.destroy();
        return;
      }
      responseError(
        response,
        error instanceof AuthenticatedUdsTransportError
          ? error
          : errorFor(this.options.errorCodes, "REQUEST_FAILED", 400, error),
      );
    }
  }
}

export class AuthenticatedUdsClient {
  private readonly options: AuthenticatedUdsClientOptions;

  constructor(options: AuthenticatedUdsClientOptions) {
    assertCredential(options.credential);
    if (!Number.isSafeInteger(options.maximumBodyBytes) || options.maximumBodyBytes < 1) {
      throw new TypeError("Authenticated UDS maximum body bytes must be a positive integer");
    }
    if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1) {
      throw new TypeError("Authenticated UDS timeout must be a positive integer");
    }
    if (options.peerInstanceHeader.length === 0) {
      throw new TypeError("Authenticated UDS peer instance header is required");
    }
    this.options = options;
  }

  async request(input: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly body?: Uint8Array;
    readonly contentType?: string;
    readonly headers?: Readonly<Record<string, string>>;
  }): Promise<AuthenticatedUdsHttpResponse> {
    if (input.body && input.body.byteLength > this.options.maximumBodyBytes) {
      throw errorFor(this.options.errorCodes, "BODY_TOO_LARGE", 413);
    }
    return new Promise((resolve, reject) => {
      const body = input.body === undefined ? undefined : Buffer.from(input.body);
      let settled = false;
      let deadlineTimer: NodeJS.Timeout | undefined;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (deadlineTimer) clearTimeout(deadlineTimer);
        callback();
      };
      const request = http.request(
        {
          socketPath: this.options.socketPath,
          path: input.path,
          method: input.method,
          headers: {
            "content-type": input.contentType ?? "application/json",
            ...input.headers,
            authorization: `Bearer ${this.options.credential.tokenValue}`,
            [this.options.peerInstanceHeader]: this.options.peerInstanceId,
            ...(body === undefined ? {} : { "content-length": String(body.byteLength) }),
          },
          timeout: this.options.requestTimeoutMs,
        },
        (response) => {
          void (async () => {
            try {
              const responseBody = await readAuthenticatedUdsBody(
                response,
                this.options.maximumBodyBytes,
                this.options.errorCodes,
              );
              finish(() =>
                resolve({
                  statusCode: response.statusCode ?? 0,
                  contentType: response.headers["content-type"],
                  headers: response.headers,
                  body: responseBody,
                }),
              );
            } catch (error) {
              finish(() => reject(error));
            }
          })();
        },
      );
      deadlineTimer = setTimeout(() => {
        request.destroy(errorFor(this.options.errorCodes, "DEADLINE_EXCEEDED", 504));
      }, this.options.requestTimeoutMs);
      deadlineTimer.unref();
      request.once("timeout", () => {
        request.destroy(errorFor(this.options.errorCodes, "DEADLINE_EXCEEDED", 504));
      });
      request.once("error", (error) => {
        finish(() =>
          reject(
            error instanceof AuthenticatedUdsTransportError
              ? error
              : errorFor(this.options.errorCodes, "TRANSPORT_UNAVAILABLE", 503, error),
          ),
        );
      });
      request.end(body);
    });
  }
}
