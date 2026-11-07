import { setTimeout as delay } from "node:timers/promises";
import type {
  WebFetchProvider,
  WebFetchResult,
  WebSearchCandidate,
  WebSearchProvider,
} from "@himawari-agent/application";
import { WEB_PROVIDERS } from "@himawari-agent/application";
import { redactForExternalText } from "@himawari-agent/sensitive-capture";
import { fetch as proxyFetch } from "undici";
import {
  maskedPublicFetchUrl,
  pageWindow,
  providerDispatchers,
  validateFetchWindow,
  type WebProviderDispatcher,
} from "./exa-public-search.js";
import { readonlyNetworkRetryDelay } from "./readonly-network-retry.js";

const origin = "https://api.deepseek.com";
const responseLimit = 16 * 1024 * 1024;

async function boundedJson(response: Awaited<ReturnType<typeof proxyFetch>>, prefix: string) {
  if (!response.body) throw new Error(`${prefix}_RESPONSE_UNRECOGNIZED`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > responseLimit) throw new Error(`${prefix}_RESPONSE_LIMIT`);
    chunks.push(chunk);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${prefix}_RESPONSE_UNRECOGNIZED`);
  }
}

function statusFailure(status: number, prefix: "WEB_SEARCH" | "WEB_FETCH") {
  if ([400, 413, 422].includes(status)) return `${prefix}_INPUT_UNSUPPORTED`;
  if ([408, 504].includes(status)) return `${prefix}_TIMEOUT`;
  if (prefix === "WEB_FETCH" && [403, 404].includes(status)) return "WEB_FETCH_UNREACHABLE";
  return null;
}

const text = (value: unknown, limit: number) =>
  typeof value === "string" ? value.slice(0, limit) : "";

export class DeepSeekWebProvider implements WebSearchProvider, WebFetchProvider {
  readonly descriptor = WEB_PROVIDERS.deepseek;
  readonly #credential: string;
  readonly #dispatcher: WebProviderDispatcher;

  constructor(options: {
    readonly credential: string;
    readonly dispatcher: WebProviderDispatcher;
  }) {
    if (!/^[\x21-\x7e]{16,512}$/.test(options.credential))
      throw new Error("WEB_PROVIDER_SECRET_INVALID");
    this.#credential = options.credential;
    this.#dispatcher = options.dispatcher;
  }

  async search(input: {
    readonly query: string;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly WebSearchCandidate[]> {
    if (input.query.length > 4 * 4096) throw new Error("WEB_SEARCH_INPUT_INVALID");
    const query = redactForExternalText(input.query.trim()).text;
    if (!query || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 10)
      throw new Error("WEB_SEARCH_INPUT_INVALID");
    if ([...query].length > this.descriptor.maxQueryChars)
      throw new Error("WEB_SEARCH_INPUT_UNSUPPORTED");
    const body = await this.#post(
      "/v1/tools/search",
      { query, count: input.limit, need_content: false },
      "WEB_SEARCH",
      input.signal,
    );
    const results = (body as { results?: unknown }).results;
    if (!Array.isArray(results)) throw new Error("WEB_SEARCH_RESPONSE_UNRECOGNIZED");
    const candidates: WebSearchCandidate[] = [];
    for (const entry of results) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      let url: URL;
      try {
        url = new URL(text(item["url"], 8192));
      } catch {
        continue;
      }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue;
      const title = text(item["title"], 1024);
      if (!title) continue;
      const lines = [
        `Title: ${title}`,
        `URL: ${url.href}`,
        ...(text(item["site_name"], 256) ? [`Site: ${text(item["site_name"], 256)}`] : []),
        ...(text(item["date"], 64) ? [`Published: ${text(item["date"], 64)}`] : []),
        "Summary:",
        text(item["summary"], 8000) || text(item["snippet"], 4000),
      ];
      candidates.push({
        url: url.href,
        title,
        summary: lines.join("\n").slice(0, 12000),
        resultRank: candidates.length + 1,
        openedResourceId: null,
      });
      if (candidates.length >= input.limit) break;
    }
    if (!candidates.length && results.length) throw new Error("WEB_SEARCH_RESPONSE_UNRECOGNIZED");
    return candidates;
  }

  async fetch(input: {
    readonly url: string;
    readonly offset: number;
    readonly maximumBytes: number;
    readonly signal?: AbortSignal;
  }): Promise<WebFetchResult> {
    validateFetchWindow(input);
    const url = maskedPublicFetchUrl(input.url);
    const body = (await this.#post("/v1/tools/fetch", { url }, "WEB_FETCH", input.signal)) as {
      title?: unknown;
      content?: unknown;
    };
    if (typeof body.content !== "string" || !body.content.trim())
      throw new Error("WEB_FETCH_RESPONSE_UNRECOGNIZED");
    return {
      url,
      title: text(body.title, 1024),
      ...pageWindow(body.content, input.offset, input.maximumBytes),
    };
  }

  async #post(
    path: "/v1/tools/search" | "/v1/tools/fetch",
    payload: Record<string, unknown>,
    prefix: "WEB_SEARCH" | "WEB_FETCH",
    external: AbortSignal | undefined,
  ): Promise<unknown> {
    const dispatchers = providerDispatchers(this.#dispatcher, prefix);
    const signal = external
      ? AbortSignal.any([external, AbortSignal.timeout(45000)])
      : AbortSignal.timeout(45000);
    const deadline = performance.now() + 45000;
    const send = () => {
      signal.throwIfAborted();
      if (performance.now() >= deadline) throw new Error(`${prefix}_TIMEOUT`);
      const dispatcher = dispatchers.next();
      return proxyFetch(`${origin}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#credential}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal,
        redirect: "error",
        dispatcher,
      });
    };
    try {
      let response: Awaited<ReturnType<typeof proxyFetch>> | undefined;
      let failure: unknown;
      try {
        response = await send();
      } catch (error) {
        failure = error;
      }
      signal.throwIfAborted();
      const backoff = readonlyNetworkRetryDelay(response, failure);
      if (backoff !== null && deadline - performance.now() > backoff) {
        await response?.body?.cancel().catch(() => undefined);
        await delay(backoff, undefined, { signal });
        response = await send();
      }
      if (!response) throw failure;
      if (response.status === 429) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`${prefix}_RATE_LIMITED`);
      }
      const statusCode = statusFailure(response.status, prefix);
      if (statusCode) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(statusCode);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`${prefix}_PROVIDER_FAILED`);
      }
      return await boundedJson(response, prefix);
    } finally {
      await dispatchers.close();
    }
  }
}
