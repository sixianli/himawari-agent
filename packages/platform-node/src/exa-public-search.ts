import { setTimeout as delay } from "node:timers/promises";
import type {
  PublicWebAdapterPort,
  WebFetchProvider,
  WebFetchResult,
  WebSearchCandidate,
  WebSearchProvider,
} from "@himawari-agent/application";
import { scanMachineSecrets, WEB_PROVIDERS } from "@himawari-agent/application";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { type Dispatcher, ProxyAgent, fetch as proxyFetch } from "undici";
import { readonlyNetworkRetryDelay } from "./readonly-network-retry.js";

const endpoint = "https://mcp.exa.ai/mcp";
const rateLimitNotice = /\brate[- ]limit/i;
const rateLimitBackoffMs = 1000;
const minimumRetryCallMs = 5000;
const fetchToolNames = ["web_fetch_exa", "crawling_exa"] as const;

export function publicSearchFailure(error: unknown): {
  readonly code: "WEB_SEARCH_RATE_LIMITED" | "WEB_SEARCH_FAILED";
  readonly output: string;
} {
  return error instanceof Error && /RATE_LIMITED$/.test(error.message)
    ? {
        code: "WEB_SEARCH_RATE_LIMITED",
        output: JSON.stringify({
          error: "WEB_SEARCH_RATE_LIMITED",
          message: "公开搜索服务正在限流，请稍等片刻再搜索。",
        }),
      }
    : {
        code: "WEB_SEARCH_FAILED",
        output: JSON.stringify({
          error: "WEB_SEARCH_FAILED",
          message: "公开网页搜索失败。",
        }),
      };
}

export function publicFetchFailure(error: unknown): {
  readonly code: "WEB_FETCH_RATE_LIMITED" | "WEB_FETCH_FAILED";
  readonly output: string;
} {
  return error instanceof Error && /RATE_LIMITED$/.test(error.message)
    ? {
        code: "WEB_FETCH_RATE_LIMITED",
        output: JSON.stringify({
          error: "WEB_FETCH_RATE_LIMITED",
          message: "读网页服务正在限流，请稍等片刻再试。",
        }),
      }
    : {
        code: "WEB_FETCH_FAILED",
        output: JSON.stringify({
          error: "WEB_FETCH_FAILED",
          message: "读取网页失败。",
        }),
      };
}

export function parseExaSearchResults(text: string, limit: number): readonly WebSearchCandidate[] {
  if (Buffer.byteLength(text) > 128 * 1024) throw new Error("WEB_SEARCH_OUTPUT_LIMIT");
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

export function truncateUtf8(text: string, maximumBytes: number) {
  const bytes = Buffer.from(text);
  if (bytes.length <= maximumBytes) return { text, truncated: false };
  return {
    text: new TextDecoder("utf-8").decode(bytes.subarray(0, maximumBytes)).replace(/�$/, ""),
    truncated: true,
  };
}

export function parseExaFetchResult(
  text: string,
  url: string,
  maximumBytes: number,
): WebFetchResult {
  if (!text.trim()) throw new Error("WEB_FETCH_RESPONSE_UNRECOGNIZED");
  if (Buffer.byteLength(text) <= 4096 && rateLimitNotice.test(text) && !/^Title:/m.test(text))
    throw new Error("WEB_FETCH_RATE_LIMITED");
  const title = (/^Title:\s*(.+)$/m.exec(text)?.[1] ?? "").slice(0, 1024);
  const body = truncateUtf8(text, maximumBytes);
  return { url, title, markdown: body.text, truncated: body.truncated };
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

export function providerDispatchers(shared: Dispatcher | undefined, prefix: string) {
  if (shared) return { next: (): Dispatcher => shared, close: async () => {} };
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
  readonly #dispatcher: Dispatcher | undefined;

  constructor(options: { readonly dispatcher?: Dispatcher } = {}) {
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
            publicSearchFailure(error).code !== "WEB_SEARCH_RATE_LIMITED" ||
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
    readonly maximumBytes: number;
    readonly signal?: AbortSignal;
  }): Promise<WebFetchResult> {
    if (
      !Number.isSafeInteger(input.maximumBytes) ||
      input.maximumBytes < 1 ||
      input.maximumBytes > 48 * 1024
    )
      throw new Error("WEB_FETCH_INPUT_INVALID");
    const url = validatePublicFetchUrl(input.url);
    let toolName: string | undefined;
    let toolArguments: Record<string, unknown> | undefined;
    return this.#session(
      "WEB_FETCH",
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
          ...("maxCharacters" in properties ? { maxCharacters: input.maximumBytes } : {}),
        };
        const result = await session.client.callTool(
          { name: toolName, arguments: toolArguments },
          { timeout: 30000 },
        );
        if (result.isError || !Array.isArray(result.content))
          throw new Error("WEB_FETCH_PROVIDER_FAILED");
        const text = result.content
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\n\n");
        if (scanMachineSecrets(text).length) throw new Error("WEB_FETCH_OUTPUT_REDACTED");
        return parseExaFetchResult(text, url, input.maximumBytes);
      },
    );
  }

  async #session<T>(
    prefix: "WEB_SEARCH" | "WEB_FETCH",
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
                if (total > 256 * 1024) throw new Error(`${prefix}_RESPONSE_LIMIT`);
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
    } finally {
      await client.close().catch(() => undefined);
      await dispatchers.close();
    }
  }
}
