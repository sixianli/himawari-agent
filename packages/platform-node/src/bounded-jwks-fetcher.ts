import type { JwksFetcher } from "./identity-gateway.js";

export const BOUNDED_JWKS_ERROR_CODES = Object.freeze({
  URL_REJECTED: "BOUNDED_JWKS_URL_REJECTED",
  REQUEST_FAILED: "BOUNDED_JWKS_REQUEST_FAILED",
  RESPONSE_INVALID: "BOUNDED_JWKS_RESPONSE_INVALID",
  BODY_TOO_LARGE: "BOUNDED_JWKS_BODY_TOO_LARGE",
  TIMEOUT: "BOUNDED_JWKS_TIMEOUT",
} as const);

export type BoundedJwksErrorCode =
  (typeof BOUNDED_JWKS_ERROR_CODES)[keyof typeof BOUNDED_JWKS_ERROR_CODES];

export class BoundedJwksError extends Error {
  readonly code: BoundedJwksErrorCode;

  constructor(code: BoundedJwksErrorCode) {
    super(code);
    this.name = "BoundedJwksError";
    this.code = code;
  }
}

export interface BoundedJwksFetcherOptions {
  readonly allowedUrl: string;
  readonly timeoutMilliseconds: number;
  readonly maximumBodyBytes: number;
  readonly fetchImplementation?: typeof globalThis.fetch;
}

function assertOptions(options: BoundedJwksFetcherOptions): void {
  let allowed: URL;
  try {
    allowed = new URL(options.allowedUrl);
  } catch {
    throw new BoundedJwksError(BOUNDED_JWKS_ERROR_CODES.URL_REJECTED);
  }
  if (
    allowed.protocol !== "https:" ||
    allowed.href !== options.allowedUrl ||
    allowed.username ||
    allowed.password ||
    allowed.search ||
    allowed.hash ||
    !Number.isSafeInteger(options.timeoutMilliseconds) ||
    options.timeoutMilliseconds < 1 ||
    options.timeoutMilliseconds > 10_000 ||
    !Number.isSafeInteger(options.maximumBodyBytes) ||
    options.maximumBodyBytes < 1 ||
    options.maximumBodyBytes > 1024 * 1024
  ) {
    throw new BoundedJwksError(BOUNDED_JWKS_ERROR_CODES.URL_REJECTED);
  }
}

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  await body.cancel().catch(() => undefined);
}

function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  if (signal.aborted) return Promise.reject(new BoundedJwksError(BOUNDED_JWKS_ERROR_CODES.TIMEOUT));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      void reader.cancel().catch(() => undefined);
      reject(new BoundedJwksError(BOUNDED_JWKS_ERROR_CODES.TIMEOUT));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readBody(
  response: Response,
  maximumBodyBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBodyBytes) {
      await cancelBody(response.body);
      throw new BoundedJwksError(BOUNDED_JWKS_ERROR_CODES.BODY_TOO_LARGE);
    }
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumBodyBytes) {
      throw new BoundedJwksError(BOUNDED_JWKS_ERROR_CODES.BODY_TOO_LARGE);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await readChunk(reader, signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBodyBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BoundedJwksError(BOUNDED_JWKS_ERROR_CODES.BODY_TOO_LARGE);
      }
      chunks.push(next.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The abort path may still be settling the pending read.
    }
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new BoundedJwksError(BOUNDED_JWKS_ERROR_CODES.RESPONSE_INVALID);
  }
}

export class BoundedJwksFetcher implements JwksFetcher {
  readonly #allowedUrl: string;
  readonly #timeoutMilliseconds: number;
  readonly #maximumBodyBytes: number;
  readonly #fetchImplementation: typeof globalThis.fetch;

  constructor(options: BoundedJwksFetcherOptions) {
    assertOptions(options);
    this.#allowedUrl = new URL(options.allowedUrl).href;
    this.#timeoutMilliseconds = options.timeoutMilliseconds;
    this.#maximumBodyBytes = options.maximumBodyBytes;
    this.#fetchImplementation = options.fetchImplementation ?? globalThis.fetch;
    if (typeof this.#fetchImplementation !== "function") {
      throw new BoundedJwksError(BOUNDED_JWKS_ERROR_CODES.REQUEST_FAILED);
    }
  }

  async fetch(url: URL): Promise<unknown> {
    if (url.href !== this.#allowedUrl) {
      throw new BoundedJwksError(BOUNDED_JWKS_ERROR_CODES.URL_REJECTED);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMilliseconds);
    try {
      let response: Response;
      try {
        response = await this.#fetchImplementation(url, {
          method: "GET",
          headers: { accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        });
      } catch (_error) {
        if (controller.signal.aborted) {
          throw new BoundedJwksError(BOUNDED_JWKS_ERROR_CODES.TIMEOUT);
        }
        throw new BoundedJwksError(BOUNDED_JWKS_ERROR_CODES.REQUEST_FAILED);
      }
      if (!response.ok) {
        await cancelBody(response.body);
        throw new BoundedJwksError(BOUNDED_JWKS_ERROR_CODES.RESPONSE_INVALID);
      }
      const body = await readBody(response, this.#maximumBodyBytes, controller.signal);
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new BoundedJwksError(BOUNDED_JWKS_ERROR_CODES.RESPONSE_INVALID);
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
}
