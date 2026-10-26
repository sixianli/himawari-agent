import type { WebSearchCandidate } from "./web.js";

export const WEB_PROVIDER_IDS = ["exa-public", "deepseek"] as const;
export type WebProviderId = (typeof WEB_PROVIDER_IDS)[number];
export type WebProviderOperation = "web_search" | "web_fetch";

export interface WebProviderDescriptor {
  readonly id: WebProviderId;
  readonly displayName: string;
  readonly recipient: string;
  readonly egress: readonly string[];
  readonly requiresSecret: boolean;
  readonly operations: readonly WebProviderOperation[];
  readonly maxQueryChars: number;
}

export const WEB_PROVIDERS: Readonly<Record<WebProviderId, WebProviderDescriptor>> = Object.freeze({
  "exa-public": Object.freeze({
    id: "exa-public",
    displayName: "Exa",
    recipient: "https://mcp.exa.ai",
    egress: Object.freeze(["mcp.exa.ai:443"]),
    requiresSecret: false,
    operations: Object.freeze(["web_search", "web_fetch"] as const),
    maxQueryChars: 4096,
  }),
  deepseek: Object.freeze({
    id: "deepseek",
    displayName: "DeepSeek",
    recipient: "https://api.deepseek.com",
    egress: Object.freeze(["api.deepseek.com:443"]),
    requiresSecret: true,
    operations: Object.freeze(["web_search", "web_fetch"] as const),
    maxQueryChars: 128,
  }),
});

export const DEFAULT_WEB_PROVIDERS: readonly WebProviderId[] = Object.freeze(["exa-public"]);

export function isWebProviderId(value: unknown): value is WebProviderId {
  return typeof value === "string" && (WEB_PROVIDER_IDS as readonly string[]).includes(value);
}

export function webProviderChain(providers: readonly WebProviderId[] | undefined) {
  return (providers ?? DEFAULT_WEB_PROVIDERS).map((id) => WEB_PROVIDERS[id]);
}

export function webProviderRecipients(providers: readonly WebProviderId[] | undefined) {
  return webProviderChain(providers).map((provider) => provider.recipient);
}

export function webProviderEgress(providers: readonly WebProviderId[] | undefined) {
  return [...new Set(webProviderChain(providers).flatMap((provider) => provider.egress))].sort();
}

export type WebProviderFailureCode =
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNAVAILABLE"
  | "INPUT_UNSUPPORTED"
  | "INPUT_INVALID"
  | "OUTPUT_REDACTED"
  | "PAGE_UNREACHABLE"
  | "CONTENT_TOO_LARGE";

const FALLBACK_CODES: ReadonlySet<WebProviderFailureCode> = new Set([
  "RATE_LIMITED",
  "TIMEOUT",
  "UNAVAILABLE",
  "INPUT_UNSUPPORTED",
  "PAGE_UNREACHABLE",
  "CONTENT_TOO_LARGE",
]);

export class WebProviderError extends Error {
  readonly code: WebProviderFailureCode;
  constructor(code: WebProviderFailureCode, detail?: string) {
    super(detail ?? code);
    this.name = "WebProviderError";
    this.code = code;
  }
  get fallback(): boolean {
    return FALLBACK_CODES.has(this.code);
  }
}

export interface WebFetchResult {
  readonly url: string;
  readonly title: string;
  readonly markdown: string;
  readonly truncated: boolean;
  readonly nextOffset: number | null;
}

export const WEB_FETCH_MAXIMUM_BYTES = 100 * 1024;
export const WEB_FETCH_MAXIMUM_OFFSET = 10_000_000;

export interface WebSearchProvider {
  readonly descriptor: WebProviderDescriptor;
  search(input: {
    readonly query: string;
    readonly limit: number;
    readonly signal: AbortSignal;
  }): Promise<readonly WebSearchCandidate[]>;
}

export interface WebFetchProvider {
  readonly descriptor: WebProviderDescriptor;
  fetch(input: {
    readonly url: string;
    readonly offset: number;
    readonly maximumBytes: number;
    readonly signal: AbortSignal;
  }): Promise<WebFetchResult>;
}
