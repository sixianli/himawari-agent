import { setTimeout as delay } from "node:timers/promises";
import {
  type PublicWebAdapterPort,
  WEB_FETCH_MAXIMUM_BYTES,
  WEB_FETCH_MAXIMUM_OFFSET,
  WEB_PROVIDERS,
  type WebFetchProvider,
  type WebFetchResult,
  type WebSearchCandidate,
  type WebSearchProvider,
} from "@himawari-agent/application";
import { scanMachineSecrets } from "@himawari-agent/sensitive-capture";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type Dispatcher, ProxyAgent, fetch as proxyFetch } from "undici";
import { readonlyNetworkRetryDelay } from "./readonly-network-retry.js";
import { webProviderFailure } from "./web-provider-failure.js";

const endpoint = "https://mcp.exa.ai/mcp";
const rateLimitNotice = /\brate[- ]limit/i;
const rateLimitBackoffMs = 1000;
const minimumRetryCallMs = 5000;
const fetchToolNames = ["web_fetch_exa", "crawling_exa"] as const;
const searchResponseLimit = 1024 * 1024;
const fetchResponseLimitCeiling = 16 * 1024 * 1024;
const crawlFailure = /^Error fetching URL/;

export function parseExaSearchResults(text: string, limit: number): readonly WebSearchCandidate[] {
  const results: WebSearchCandidate[] = [];
  for (const part of text.split(/\n\s*---\s*\n/)) {
    const title = /^Title:\s*(.+)$/m.exec(part)?.[1];
    const rawUrl = /^URL:\s*(\S+)$/m.exec(part)?.[1];
    if (!title || !rawUrl) continue;
    const url = new URL(rawUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) continue;
    const highlights = part.indexOf("\nHighlights:");
    const headerEnd = highlights < 0 ? part.length : highlights;
    const summary =
      part
        .slice(0, headerEnd)
        .replace(
          /^Published: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/m,
          "Published: $1 (UTC)",
        ) + part.slice(headerEnd);
    results.push({
      url: url.href,
      title: title.slice(0, 1024),
      summary: summary.slice(0, 12000),
      resultRank: results.length + 1,
      openedResourceId: null,
    });
    if (results.length >= limit) break;
  }
  if (!results.length && text.trim())
    throw new Error(
      Buffer.byteLength(text) <= 4096 && rateLimitNotice.test(text)
        ? "WEB_SEARCH_RATE_LIMITED"
        : "WEB_SEARCH_RESPONSE_UNRECOGNIZED",
    );
  return results;
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

export function pageWindow(text: string, offset: number, maximumBytes: number) {
  let start = Math.min(offset, text.length);
  if (
    start > 0 &&
    isLowSurrogate(text.charCodeAt(start)) &&
    isHighSurrogate(text.charCodeAt(start - 1))
  )
    start -= 1;
  let end = start;
  let bytes = 0;
  while (end < text.length) {
    const point = text.codePointAt(end) ?? 0;
    const width = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (bytes + width > maximumBytes) break;
    bytes += width;
    end += point >= 0x10000 ? 2 : 1;
  }
  return {
    markdown: text.slice(start, end),
    truncated: end < text.length,
    nextOffset: end < text.length ? end : null,
  };
}

export function validateFetchWindow(input: {
  readonly offset: number;
  readonly maximumBytes: number;
}) {
  if (
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < 1 ||
    input.maximumBytes > WEB_FETCH_MAXIMUM_BYTES ||
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    input.offset > WEB_FETCH_MAXIMUM_OFFSET
  )
    throw new Error("WEB_FETCH_INPUT_INVALID");
}

export function parseExaFetchResult(
  text: string,
  url: string,
  offset: number,
  maximumBytes: number,
): WebFetchResult {
  if (!text.trim()) throw new Error("WEB_FETCH_RESPONSE_UNRECOGNIZED");
  if (Buffer.byteLength(text) <= 4096 && rateLimitNotice.test(text) && !/^Title:/m.test(text))
    throw new Error("WEB_FETCH_RATE_LIMITED");
  const title = (/^Title:\s*(.+)$/m.exec(text)?.[1] ?? /^# (.+)$/.exec(text)?.[1] ?? "").slice(
    0,
    1024,
  );
  return { url, title, ...pageWindow(text, offset, maximumBytes) };
}

export function validatePublicFetchUrl(value: string): string {
  if (Buffer.byteLength(value) > 8192 || scanMachineSecrets(value).length)
    throw new Error("WEB_FETCH_INPUT_INVALID");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("WEB_FETCH_INPUT_INVALID");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !host ||
    !host.includes(".") ||
    host === "localhost" ||
    /\.(localhost|local|internal|lan|home|arpa)$/.test(host) ||
    /^(0|10|127)\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(
      host,
    ) ||
    host.includes(":")
  )
    throw new Error("WEB_FETCH_INPUT_INVALID");
  return url.href;
}

export function sandboxProxy(prefix: string) {
  const proxyUrl = process.env["HTTPS_PROXY"];
  if (!proxyUrl) throw new Error(`${prefix}_SANDBOX_PROXY_REQUIRED`);
  const proxy = new URL(proxyUrl);
  if (
    proxy.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(proxy.hostname) ||
    !proxy.username ||
    !proxy.password
  )
    throw new Error(`${prefix}_SANDBOX_PROXY_INVALID`);
  const token = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
  proxy.username = "";
  proxy.password = "";
  return { uri: proxy.href, token };
}

export const SANDBOX_PROXY = "sandbox-proxy";
export type WebProviderDispatcher = Dispatcher | typeof SANDBOX_PROXY;

export function providerDispatchers(transport: WebProviderDispatcher, prefix: string) {
  if (transport !== SANDBOX_PROXY)
    return { next: (): Dispatcher => transport, close: async () => {} };
  const proxy = sandboxProxy(prefix);
  const owned: ProxyAgent[] = [];
  return {
    next: (): Dispatcher => {
      const created = new ProxyAgent(proxy);
      owned.push(created);
      return created;
    },
    close: async () => {
      await Promise.all(owned.map((entry) => entry.close()));
    },
  };
}

type McpMessage = {
  readonly method?: unknown;
  readonly params?: { readonly name?: unknown; readonly arguments?: Record<string, unknown> };
};

interface ExaSession {
  readonly client: Client;
  readonly deadline: number;
  readonly lifetime: AbortSignal;
  renew(): void;
}

export class ExaPublicSearchAdapter
  implements Pick<PublicWebAdapterPort, "search">, WebSearchProvider, WebFetchProvider
{
  readonly descriptor = WEB_PROVIDERS["exa-public"];
  readonly #dispatcher: WebProviderDispatcher;

  constructor(options: { readonly dispatcher: WebProviderDispatcher }) {
    this.#dispatcher = options.dispatcher;
  }

  async search(input: {
    readonly query: string;
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<readonly WebSearchCandidate[]> {
    if (
      !input.query.trim() ||
      Buffer.byteLength(input.query) > 4096 ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 10 ||
      scanMachineSecrets(input.query).length
    )
      throw new Error("WEB_SEARCH_INPUT_INVALID");
    const query = input.query.trim();
    const limit = input.limit;
    return this.#session(
      "WEB_SEARCH",
      searchResponseLimit,
      (message) =>
        message.method === "tools/call" &&
        message.params?.name === "web_search_exa" &&
        message.params?.arguments?.["query"] === query &&
        message.params?.arguments?.["numResults"] === limit,
      input.signal,
      async (session) => {
        const callSearch = async () => {
          const result = await session.client.callTool(
            {
              name: "web_search_exa",
              arguments: {
                query,
                objective:
                  "Find current public sources matching the query. Return titles, source URLs, publication dates and relevant excerpts.",
                numResults: limit,
              },
            },
            { timeout: 30000 },
          );
          if (result.isError || !Array.isArray(result.content))
            throw new Error("WEB_SEARCH_PROVIDER_FAILED");
          const text = result.content
            .filter((item) => item.type === "text")
            .map((item) => item.text)
            .join("\n\n---\n\n");
          if (scanMachineSecrets(text).length) throw new Error("WEB_SEARCH_OUTPUT_REDACTED");
          return parseExaSearchResults(text, limit);
        };
        try {
          return await callSearch();
        } catch (error) {
          if (
            webProviderFailure(error).code !== "RATE_LIMITED" ||
            session.deadline - performance.now() < rateLimitBackoffMs + minimumRetryCallMs
          )
            throw error;
        }
        await delay(rateLimitBackoffMs, undefined, { signal: session.lifetime });
        session.renew();
        return await callSearch();
      },
    );
  }

  async fetch(input: {
    readonly url: string;
    readonly offset: number;
    readonly maximumBytes: number;
    readonly signal?: AbortSignal;
  }): Promise<WebFetchResult> {
    validateFetchWindow(input);
    const url = validatePublicFetchUrl(input.url);
    const characters = input.offset + input.maximumBytes + 1;
    let toolName: string | undefined;
    let toolArguments: Record<string, unknown> | undefined;
    return this.#session(
      "WEB_FETCH",
      Math.min(fetchResponseLimitCeiling, 6 * characters + 64 * 1024),
      (message) =>
        message.method === "tools/list" ||
        (message.method === "tools/call" &&
          toolName !== undefined &&
          message.params?.name === toolName &&
          JSON.stringify(message.params?.arguments) === JSON.stringify(toolArguments)),
      input.signal,
      async (session) => {
        const listed = await session.client.listTools(undefined, { timeout: 15000 });
        const tool = fetchToolNames
          .map((name) => listed.tools.find((entry) => entry.name === name))
          .find((entry) => entry !== undefined);
        if (!tool) throw new Error("WEB_FETCH_PROVIDER_FAILED");
        const properties = (tool.inputSchema?.properties ?? {}) as Record<string, unknown>;
        toolName = tool.name;
        toolArguments = {
          ...("urls" in properties ? { urls: [url] } : { url }),
          ...("maxCharacters" in properties ? { maxCharacters: characters } : {}),
        };
        const result = await session.client.callTool(
          { name: toolName, arguments: toolArguments },
          { timeout: 30000 },
        );
        if (!Array.isArray(result.content)) throw new Error("WEB_FETCH_PROVIDER_FAILED");
        const text = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n\n");
        if (result.isError)
          throw new Error(
            !crawlFailure.test(text)
              ? "WEB_FETCH_PROVIDER_FAILED"
              : /TIMEOUT/i.test(text)
                ? "WEB_FETCH_TIMEOUT"
                : "WEB_FETCH_UNREACHABLE",
          );
        if (scanMachineSecrets(text).length) throw new Error("WEB_FETCH_OUTPUT_REDACTED");
        return parseExaFetchResult(text, url, input.offset, input.maximumBytes);
      },
    );
  }

  async #session<T>(
    prefix: "WEB_SEARCH" | "WEB_FETCH",
    responseLimit: number,
    readonly: (message: McpMessage) => boolean,
    external: AbortSignal | undefined,
    work: (session: ExaSession) => Promise<T>,
  ): Promise<T> {
    const dispatchers = providerDispatchers(this.#dispatcher, prefix);
    const deadline = performance.now() + 45000;
    const lifetime = external
      ? AbortSignal.any([external, AbortSignal.timeout(45000)])
      : AbortSignal.timeout(45000);
    let retried = false;
    let oversized = false;
    let dispatcher = dispatchers.next();
    const client = new Client({ name: "himawari-public-search", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      fetch: async (url, init) => {
        if (String(url) !== endpoint) throw new Error(`${prefix}_ENDPOINT_CHANGED`);
        if (init?.body !== undefined && init.body !== null && typeof init.body !== "string")
          throw new Error(`${prefix}_REQUEST_INVALID`);
        let replayable = false;
        if (init?.method === "POST" && typeof init.body === "string") {
          try {
            replayable = readonly(JSON.parse(init.body) as McpMessage);
          } catch {
            replayable = false;
          }
        }
        const signal = init?.signal ? AbortSignal.any([init.signal, lifetime]) : lifetime;
        const send = () => {
          signal.throwIfAborted();
          if (performance.now() >= deadline) throw new Error(`${prefix}_TIMEOUT`);
          return proxyFetch(String(url), {
            ...(init?.method ? { method: init.method } : {}),
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            ...(typeof init?.body === "string" ? { body: init.body } : {}),
            signal,
            redirect: "error",
            dispatcher,
          });
        };
        let response: Awaited<ReturnType<typeof proxyFetch>> | undefined;
        let failure: unknown;
        try {
          response = await send();
        } catch (error) {
          failure = error;
        }
        signal.throwIfAborted();
        const backoff =
          replayable && !retried ? readonlyNetworkRetryDelay(response, failure) : null;
        if (backoff !== null && !signal.aborted && deadline - performance.now() > backoff) {
          retried = true;
          await response?.body?.cancel().catch(() => undefined);
          await delay(backoff, undefined, { signal });
          signal.throwIfAborted();
          dispatcher = dispatchers.next();
          response = await send();
        }
        if (!response) throw failure;
        if (!response.body)
          return new Response(null, {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
          });
        let total = 0;
        return new Response(
          response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                total += chunk.byteLength;
                if (total > responseLimit) {
                  oversized = true;
                  throw new Error(`${prefix}_RESPONSE_LIMIT`);
                }
                controller.enqueue(chunk);
              },
            }),
          ),
          {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
          },
        );
      },
    });
    try {
      await client.connect(transport, { timeout: 15000 });
      return await work({
        client,
        deadline,
        lifetime,
        renew: () => {
          dispatcher = dispatchers.next();
        },
      });
    } catch (error) {
      if (oversized) throw new Error(`${prefix}_RESPONSE_LIMIT`);
      throw error;
    } finally {
      await client.close().catch(() => undefined);
      await dispatchers.close();
    }
  }
}
