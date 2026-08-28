import {
  ApplicationPortError,
  PORT_ERROR_CODES,
  type PayloadRef,
  type PublicWebAdapterPort,
  type WebContentDigestPort,
  type WebSearchCandidate,
} from "@himawari-agent/application";
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
  readonly #fetch: typeof globalThis.fetch;
  readonly #search: WebSearchProvider;
  readonly #payloads: ProtectedWebBodyWriter;
  readonly #digest: WebContentDigestPort;
  readonly #resolver: PublicHostResolver;
  readonly #allowPrivateOrigins: ReadonlySet<string>;

  constructor(input: {
    readonly fetch: typeof globalThis.fetch;
    readonly search: WebSearchProvider;
    readonly payloads: ProtectedWebBodyWriter;
    readonly digest: WebContentDigestPort;
    readonly resolver: PublicHostResolver;
    readonly allowPrivateOrigins?: readonly string[];
  }) {
    this.#fetch = input.fetch;
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
    let current = await this.#safeUrl(input.requestedUrl);
    const redirectChain: string[] = [];
    let response: Response | undefined;
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
      response = await this.#fetch(current, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        headers: {
          accept: "text/html,text/plain,application/json;q=0.9",
          "user-agent": "Himawari-Agent-Public-Research/0.2",
        },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS) this.#reject("WEB_REDIRECT_LIMIT");
      current = await this.#safeUrl(new URL(location, current).toString());
      redirectChain.push(current);
    }
    if (!response) this.#reject("WEB_RESPONSE_MISSING");
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
    if (!ALLOWED_CONTENT_TYPES.includes(contentType)) this.#reject("WEB_CONTENT_TYPE_UNSUPPORTED");
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (declaredLength > input.maximumBytes) this.#reject("WEB_RESOURCE_TOO_LARGE");
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > input.maximumBytes) this.#reject("WEB_RESOURCE_TOO_LARGE");
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
    const canonicalUrl = response.url || current;
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
  }

  async #safeUrl(value: string): Promise<string> {
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
      (addresses.length === 0 || addresses.some(isPrivateAddress))
    ) {
      this.#reject("WEB_SSRF_TARGET_BLOCKED");
    }
    return url.toString();
  }

  #reject(reason: string): never {
    throw new ApplicationPortError(PORT_ERROR_CODES.INVALID_OPERATION, reason);
  }
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (
    normalized === "::1" ||
    normalized === "0.0.0.0" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  ) {
    return true;
  }
  const octets = normalized.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return false;
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}
