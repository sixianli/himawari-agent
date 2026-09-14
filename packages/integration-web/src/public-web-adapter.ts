import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type PayloadRef,
  type PublicWebAdapterPort,
  type WebContentDigestPort,
  type WebSearchCandidate,
} from "@himawari-agent/application";
import { isPublicWebAddress } from "./public-ip-address.js";
import type { PublicWebTransport } from "./public-web-transport.js";
import { extractUntrustedWebContent } from "./untrusted-content.js";

const ALLOWED_CONTENT_TYPES = ["text/html", "text/plain", "application/json"];
const MAX_REDIRECTS = 5;

export interface WebSearchProvider {
  search(input: {
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly WebSearchCandidate[]>;
}

export interface ProtectedWebBodyWriter {
  write(input: {
    readonly contentType: string;
    readonly plaintext: Uint8Array;
  }): Promise<PayloadRef>;
}

export interface PublicHostResolver {
  resolve(hostname: string): Promise<readonly string[]>;
}

export class BoundedPublicWebAdapter implements PublicWebAdapterPort {
  readonly #transport: PublicWebTransport;
  readonly #timeoutMs: number;
  readonly #search: WebSearchProvider;
  readonly #payloads: ProtectedWebBodyWriter;
  readonly #digest: WebContentDigestPort;
  readonly #resolver: PublicHostResolver;
  readonly #allowPrivateOrigins: ReadonlySet<string>;

  constructor(input: {
    readonly transport: PublicWebTransport;
    readonly timeoutMs?: number;
    readonly search: WebSearchProvider;
    readonly payloads: ProtectedWebBodyWriter;
    readonly digest: WebContentDigestPort;
    readonly resolver: PublicHostResolver;
    readonly allowPrivateOrigins?: readonly string[];
  }) {
    this.#transport = input.transport;
    this.#timeoutMs = input.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1 || this.#timeoutMs > 60_000)
      throw new RangeError("Invalid web timeout");
    this.#search = input.search;
    this.#payloads = input.payloads;
    this.#digest = input.digest;
    this.#resolver = input.resolver;
    this.#allowPrivateOrigins = new Set(input.allowPrivateOrigins ?? []);
  }

  search(input: { readonly query: string; readonly limit: number }) {
    return this.#search.search(input);
  }

  async open(input: { readonly requestedUrl: string; readonly maximumBytes: number }) {
    if (
      !Number.isSafeInteger(input.maximumBytes) ||
      input.maximumBytes < 1 ||
      input.maximumBytes > 16 * 1024 * 1024
    ) {
      throw new RangeError("Invalid web response size limit");
    }
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("WEB_REQUEST_TIMEOUT")),
      this.#timeoutMs,
    );
    let response: Response | undefined;
    try {
      let current = input.requestedUrl;
      const redirectChain: string[] = [];
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
        const target = await this.#abortable(this.#safeUrl(current), controller.signal);
        current = target.url;
        response = await this.#abortable(
          this.#transport.request({
            url: current,
            address: target.address,
            signal: controller.signal,
          }),
          controller.signal,
        );
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get("location");
        if (response.body) await this.#abortable(response.body.cancel(), controller.signal);
        if (!location || redirect === MAX_REDIRECTS) this.#reject("WEB_REDIRECT_LIMIT");
        current = new URL(location, current).toString();
        redirectChain.push(current);
      }
      if (!response) this.#reject("WEB_RESPONSE_MISSING");
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
      if (!ALLOWED_CONTENT_TYPES.includes(contentType))
        this.#reject("WEB_CONTENT_TYPE_UNSUPPORTED");
      if (![null, "identity"].includes(response.headers.get("content-encoding")))
        this.#reject("WEB_CONTENT_ENCODING_UNSUPPORTED");
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (
        !Number.isSafeInteger(declaredLength) ||
        declaredLength < 0 ||
        declaredLength > input.maximumBytes
      )
        this.#reject("WEB_RESOURCE_TOO_LARGE");
      const body = await this.#readBody(response, input.maximumBytes, controller.signal);
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(body);
      const extraction = extractUntrustedWebContent({
        contentType,
        body: raw,
        maximumCharacters: 200_000,
      });
      const protectedBodyRef = await this.#payloads.write({
        contentType: "text/plain; charset=utf-8",
        plaintext: new TextEncoder().encode(extraction.text),
      });
      const canonicalUrl = current;
      const title =
        contentType === "text/html"
          ? (raw
              .match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1]
              ?.replace(/\s+/g, " ")
              .trim() ?? new URL(canonicalUrl).hostname)
          : new URL(canonicalUrl).hostname;
      return Object.freeze({
        requestedUrl: input.requestedUrl,
        canonicalUrl,
        redirectChain: Object.freeze(redirectChain),
        origin: new URL(canonicalUrl).origin,
        statusCode: response.status,
        contentType,
        contentDigest: this.#digest.digest(extraction.text),
        sessionId: null,
        protectedBodyRef,
        title,
        selectedFragmentRefs: Object.freeze([`fragment:0:${extraction.text.length}`]),
        excludedReasonCodes: extraction.excludedReasonCodes,
      });
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (response?.body && !response.body.locked)
        void response.body.cancel().catch(() => undefined);
    }
  }

  async #readBody(
    response: Response,
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await this.#abortable(reader.read(), signal);
        if (done) break;
        size += value.byteLength;
        if (size > maximumBytes) this.#reject("WEB_RESOURCE_TOO_LARGE");
        chunks.push(value);
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return body;
    } finally {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async #abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) {
      void work.catch(() => undefined);
      signal.throwIfAborted();
    }
    let abort = () => {};
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  async #safeUrl(value: string): Promise<{ url: string; address: string }> {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.hostname.length === 0
    ) {
      this.#reject("WEB_URL_UNSAFE");
    }
    const addresses = await this.#resolver.resolve(url.hostname);
    if (
      !this.#allowPrivateOrigins.has(url.origin) &&
      (addresses.length === 0 || addresses.some((address) => !isPublicWebAddress(address)))
    ) {
      this.#reject("WEB_SSRF_TARGET_BLOCKED");
    }
    const address = addresses[0];
    if (!address) this.#reject("WEB_SSRF_TARGET_BLOCKED");
    return { url: url.toString(), address };
  }

  #reject(reason: string): never {
    throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, reason);
  }
}
