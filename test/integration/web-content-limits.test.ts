import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect } from "node:net";
import type { WebProviderId } from "@himawari-agent/application";
import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionHostWeb } from "../../apps/agent-service/src/production-host-web.js";

type Reply = { readonly status: number; readonly body?: unknown; readonly raw?: string };
type Fixture = (request: IncomingMessage, body: string) => Reply;

const pageUrl = "https://example.org/long";
const window = 100 * 1024;
const pageContent = Array.from(
  { length: 26000 },
  (_, index) => `第${index}段 東京 tokyo 😀 ${"é".repeat(index % 5)}\n`,
).join("");
const exaHeader = `# Long page\nURL: ${pageUrl}\n\n`;

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function host(fixture: Fixture) {
  const seen: Array<{ readonly url: string; readonly body: string }> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString();
      seen.push({ url: request.url ?? "", body });
      const reply = fixture(request, body);
      if (reply.raw !== undefined)
        response.writeHead(reply.status, { "content-type": "application/json" }).end(reply.raw);
      else if (reply.body === undefined) response.writeHead(reply.status).end();
      else
        response
          .writeHead(reply.status, { "content-type": "application/json" })
          .end(JSON.stringify(reply.body));
    })().catch(() => response.writeHead(500).end());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture listener missing");
  const dispatcher = new Agent({
    connect: (_options, callback) => {
      const socket = connect(address.port, "127.0.0.1");
      socket.once("connect", () => callback(null, socket));
      socket.once("error", (error) => callback(error, null));
    },
  });
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    () => dispatcher.close(),
  );
  const web = createProductionHostWeb({
    secrets: { resolve: async () => "fixture-credential-0123456789" },
    dispatcher,
  });
  const call = (
    provider: WebProviderId,
    tool: "web_search" | "web_fetch",
    args: Record<string, unknown>,
  ) =>
    web.execute({
      tool,
      arguments: args,
      providers: [provider],
      secrets: [{ provider: "deepseek", secretRef: "fixture", secretVersion: "1", purpose: "web" }],
      maximumBytes: window,
    });
  return { call, seen };
}

type ExaCall = { readonly name: string; readonly arguments: Record<string, unknown> };

function exa(onCall: (call: ExaCall) => { readonly text: string; readonly isError?: boolean }) {
  return (_request: IncomingMessage, body: string): Reply => {
    const message = JSON.parse(body) as {
      id?: number;
      method: string;
      params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
    };
    if (message.method === "notifications/initialized") return { status: 202 };
    if (message.method === "initialize")
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "content-limit-fixture", version: "1" },
          },
        },
      };
    if (message.method === "tools/list")
      return {
        status: 200,
        body: {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [
              {
                name: "web_search_exa",
                inputSchema: {
                  type: "object",
                  properties: { query: {}, numResults: {}, objective: {} },
                },
              },
              {
                name: "web_fetch_exa",
                inputSchema: { type: "object", properties: { urls: {}, maxCharacters: {} } },
              },
            ],
          },
        },
      };
    const reply = onCall({
      name: message.params?.name ?? "",
      arguments: message.params?.arguments ?? {},
    });
    return {
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: reply.text }],
          ...(reply.isError ? { isError: true } : {}),
        },
      },
    };
  };
}

const exaPage = exa((call) => ({
  text: exaHeader + pageContent.slice(0, Number(call.arguments["maxCharacters"] ?? 3000)),
}));

const deepseekPage =
  (content: string): Fixture =>
  (request) =>
    request.url === "/v1/tools/fetch"
      ? { status: 200, body: { title: "Long page", content } }
      : { status: 404 };

const parsed = (output: string) => JSON.parse(output) as Record<string, unknown>;

async function readWholePage(
  call: Awaited<ReturnType<typeof host>>["call"],
  provider: WebProviderId,
) {
  const parts: string[] = [];
  let offset: number | undefined;
  for (let calls = 0; calls < 20; calls++) {
    const outcome = await call(provider, "web_fetch", {
      url: pageUrl,
      ...(offset === undefined ? {} : { offset }),
    });
    expect(outcome, outcome.output).toMatchObject({ ok: true });
    const body = parsed(outcome.output);
    const markdown = String(body["markdown"]);
    expect(Buffer.byteLength(markdown)).toBeLessThanOrEqual(window);
    expect(markdown).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    parts.push(markdown);
    if (!body["truncated"]) {
      expect(body["nextOffset"]).toBeUndefined();
      return parts;
    }
    expect(typeof body["nextOffset"]).toBe("number");
    expect(String(body["continuation"])).toContain(`offset=${body["nextOffset"]}`);
    offset = body["nextOffset"] as number;
  }
  throw new Error("page never finished");
}

describe("[NL-11] web_fetch returns 100 KiB windows the model can continue from", () => {
  it.each([
    ["exa-public", exaPage, exaHeader + pageContent],
    ["deepseek", deepseekPage(pageContent), pageContent],
  ] as const)(
    "[NL-11] %s splits a long mixed-script page into full windows that join back without a broken character",
    async (provider, fixture, whole) => {
      const { call } = await host(fixture);
      const parts = await readWholePage(call, provider);
      expect(parts.join("")).toBe(whole);
      expect(parts.length).toBeGreaterThan(5);
      for (const part of parts.slice(0, -1))
        expect(Buffer.byteLength(part)).toBeGreaterThan(window - 4);
    },
  );

  it("[NL-11] asks Exa for a character count that covers the requested window and offset", async () => {
    const { call, seen } = await host(exaPage);
    await call("exa-public", "web_fetch", { url: pageUrl, offset: 5000 });
    const requested = seen
      .filter(({ body }) => body !== "")
      .map(({ body }) => JSON.parse(body) as { params?: { arguments?: Record<string, unknown> } })
      .map((message) => message.params?.arguments?.["maxCharacters"])
      .find((value) => value !== undefined);
    expect(requested).toBe(5000 + window + 1);
  });

  it("[NL-11] returns an empty final window for an offset past the end of the page", async () => {
    const { call } = await host(deepseekPage("short page"));
    const outcome = await call("deepseek", "web_fetch", { url: pageUrl, offset: 999 });
    expect(parsed(outcome.output)).toMatchObject({ markdown: "", truncated: false });
  });
});

describe("[NL-11] too much provider content is truncated instead of failing the call", () => {
  it("[NL-11] keeps the first window of a DeepSeek page larger than the old 512 KiB response cap", async () => {
    const huge = "東京".repeat(400_000);
    const { call } = await host(deepseekPage(huge));
    const outcome = await call("deepseek", "web_fetch", { url: pageUrl });
    expect(outcome, outcome.output).toMatchObject({ ok: true });
    const body = parsed(outcome.output);
    expect(body).toMatchObject({ truncated: true });
    expect(String(body["markdown"])).toBe(huge.slice(0, Math.floor(window / 3)));
  });

  it("[NL-11] parses Exa search results whose text is larger than the old 128 KiB limit", async () => {
    const results = Array.from(
      { length: 10 },
      (_, index) =>
        `Title: Result ${index}\nURL: https://example.org/${index}\nHighlights:\n${"本文".repeat(8000)}`,
    ).join("\n\n---\n\n");
    expect(Buffer.byteLength(results)).toBeGreaterThan(128 * 1024);
    const { call } = await host(exa(() => ({ text: results })));
    const outcome = await call("exa-public", "web_search", { query: "Tokyo", limit: 10 });
    expect(outcome, outcome.output).toMatchObject({ ok: true });
    expect(parsed(outcome.output)["results"]).toHaveLength(10);
  });
});

const failures: ReadonlyArray<
  readonly [string, WebProviderId, "web_search" | "web_fetch", Fixture, string, RegExp]
> = [
  [
    "Exa cannot crawl the page",
    "exa-public",
    "web_fetch",
    exa(() => ({ text: `Error fetching URL(s): ${pageUrl}: CRAWL_NOT_FOUND`, isError: true })),
    "WEB_FETCH_UNREACHABLE",
    /换/,
  ],
  [
    "Exa crawl timed out",
    "exa-public",
    "web_fetch",
    exa(() => ({
      text: `Error fetching URL(s): ${pageUrl}: CRAWL_LIVECRAWL_TIMEOUT`,
      isError: true,
    })),
    "WEB_FETCH_TIMEOUT",
    /重试/,
  ],
  [
    "Exa returns more than the response cap",
    "exa-public",
    "web_fetch",
    exa(() => ({ text: exaHeader + "x".repeat(2 * 1024 * 1024) })),
    "WEB_FETCH_TOO_LARGE",
    /网址/,
  ],
  [
    "DeepSeek refuses the page",
    "deepseek",
    "web_fetch",
    () => ({ status: 403, body: { error: { message: "blocked by policy xyz" } } }),
    "WEB_FETCH_UNREACHABLE",
    /换/,
  ],
  [
    "DeepSeek finds no usable content",
    "deepseek",
    "web_fetch",
    () => ({ status: 404, body: { error: { message: "no content" } } }),
    "WEB_FETCH_UNREACHABLE",
    /换/,
  ],
  [
    "DeepSeek downstream timeout",
    "deepseek",
    "web_fetch",
    () => ({ status: 504, body: { error: { message: "upstream" } } }),
    "WEB_FETCH_TIMEOUT",
    /重试/,
  ],
  [
    "DeepSeek balance is empty",
    "deepseek",
    "web_search",
    () => ({ status: 402, body: { error: { message: "Insufficient Balance" } } }),
    "WEB_SEARCH_UNAVAILABLE",
    /稍后/,
  ],
  [
    "DeepSeek rate limit",
    "deepseek",
    "web_search",
    () => ({ status: 429, body: { error: { message: "qps" } } }),
    "WEB_SEARCH_RATE_LIMITED",
    /等/,
  ],
  [
    "DeepSeek server error",
    "deepseek",
    "web_fetch",
    () => ({ status: 500, body: { error: { message: "internal stack trace" } } }),
    "WEB_FETCH_UNAVAILABLE",
    /稍后/,
  ],
];

describe("[NL-11] failures tell the model what happened and what to do next", () => {
  it.each(failures)(
    "[NL-11] %s",
    async (_name, provider, tool, fixture, code, advice) => {
      const { call } = await host(fixture);
      const outcome = await call(
        provider,
        tool,
        tool === "web_search" ? { query: "Tokyo", limit: 3 } : { url: pageUrl },
      );
      expect(outcome).toMatchObject({ ok: false, code });
      const body = parsed(outcome.output);
      expect(Object.keys(body).sort()).toEqual(["error", "message"]);
      expect(body["error"]).toBe(code);
      expect(String(body["message"])).toMatch(advice);
      expect(outcome.output).not.toMatch(
        /CRAWL_|policy xyz|Insufficient|stack trace|qps|deepseek|exa\.ai|\b40[234]\b|\b50[04]\b/i,
      );
    },
    20_000,
  );
});
