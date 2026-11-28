import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { WEB_PROVIDERS, type WebProviderId } from "@himawari-agent/application";
import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { createProductionHostWeb } from "../../apps/agent-service/src/production-host-web.js";

type Reply = { readonly status: number; readonly body?: unknown };
type ProviderFixture = (request: IncomingMessage, body: string) => Reply;

const searchText = "Title: Tokyo forecast\nURL: https://example.org/weather\nHighlights:\nSunny";
const pageText = "Title: Tokyo page\nURL: https://example.org/page\n\nForecast body";

const exaFixture: ProviderFixture = (request, body) => {
  if (request.url !== "/mcp" || request.method !== "POST") return { status: 405 };
  const message = JSON.parse(body) as {
    id?: number;
    method: string;
    params?: { protocolVersion?: string; name?: string };
  };
  if (message.method === "notifications/initialized") return { status: 202 };
  const result =
    message.method === "initialize"
      ? {
          protocolVersion: message.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "shared-connection-fixture", version: "1" },
        }
      : message.method === "tools/list"
        ? {
            tools: [
              {
                name: "web_fetch_exa",
                inputSchema: { type: "object", properties: { urls: { type: "array" } } },
              },
            ],
          }
        : {
            content: [
              {
                type: "text",
                text: message.params?.name === "web_search_exa" ? searchText : pageText,
              },
            ],
          };
  return { status: 200, body: { jsonrpc: "2.0", id: message.id, result } };
};

const deepseekFixture: ProviderFixture = (request) =>
  request.url === "/v1/tools/search"
    ? {
        status: 200,
        body: {
          results: [
            { title: "Tokyo forecast", url: "https://example.org/weather", summary: "Sunny" },
          ],
        },
      }
    : request.url === "/v1/tools/fetch"
      ? { status: 200, body: { title: "Tokyo page", content: "Forecast body" } }
      : { status: 404 };

const fixtures: Readonly<Record<WebProviderId, ProviderFixture>> = {
  "exa-public": exaFixture,
  deepseek: deepseekFixture,
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function providerServer(fixture: ProviderFixture) {
  const accepted = new Set<Socket>();
  const handled: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      handled.push(`${request.method} ${request.url}`);
      const reply = fixture(request, Buffer.concat(chunks).toString());
      if (reply.body === undefined) response.writeHead(reply.status).end();
      else
        response
          .writeHead(reply.status, { "content-type": "application/json" })
          .end(JSON.stringify(reply.body));
    })().catch(() => response.writeHead(500).end());
  });
  server.on("connection", (socket: Socket) => accepted.add(socket));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture listener missing");
  cleanup.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return { port: address.port, accepted, handled };
}

const responseReturnedToPool = () => new Promise((resolve) => setImmediate(resolve));

function sharedDispatcher(port: number) {
  const dialed: string[] = [];
  const dispatcher = new Agent({
    connect: (options, callback) => {
      dialed.push(`${options.hostname}:${options.port || "443"}`);
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => callback(null, socket));
      socket.once("error", (error) => callback(error, null));
    },
  });
  cleanup.push(() => dispatcher.close());
  return { dispatcher, dialed };
}

describe("[NL-9] every web provider uses the shared service dispatcher", () => {
  it("[NL-9] has a connection fixture for every registered provider", () => {
    expect(Object.keys(fixtures).sort()).toEqual(Object.keys(WEB_PROVIDERS).sort());
  });

  it.each(Object.keys(WEB_PROVIDERS) as WebProviderId[])(
    "[NL-9] %s sends searches and page fetches through the shared dispatcher and reuses its connections",
    async (provider) => {
      const server = await providerServer(fixtures[provider]);
      const { dispatcher, dialed } = sharedDispatcher(server.port);
      const web = createProductionHostWeb({
        secrets: { resolve: async () => "fixture-credential-0123456789" },
        dispatcher,
      });
      const call = (tool: "web_search" | "web_fetch") =>
        web.execute({
          tool,
          arguments:
            tool === "web_search"
              ? { query: "Tokyo weather", limit: 1 }
              : { url: "https://example.org/page" },
          providers: [provider],
          secrets: [
            { provider: "deepseek", secretRef: "fixture", secretVersion: "1", purpose: "web" },
          ],
          maximumBytes: 32 * 1024,
        });

      const first = await call("web_search");
      expect(first, first.output).toMatchObject({ ok: true });
      const afterFirst = { dialed: dialed.length, accepted: server.accepted.size };
      expect(afterFirst.dialed).toBeGreaterThan(0);
      expect(afterFirst.accepted).toBe(afterFirst.dialed);

      for (const tool of ["web_fetch", "web_search", "web_fetch"] as const) {
        await responseReturnedToPool();
        const outcome = await call(tool);
        expect(outcome, outcome.output).toMatchObject({ ok: true });
      }

      expect(dialed).toHaveLength(afterFirst.dialed);
      expect(server.accepted.size).toBe(afterFirst.accepted);
      expect(new Set(dialed)).toEqual(new Set(WEB_PROVIDERS[provider].egress));
      expect(server.handled.length).toBeGreaterThanOrEqual(4);
    },
  );
});

describe("[I-130] a web search or page fetch that fails is reported to developers with its code", () => {
  it.each(Object.keys(WEB_PROVIDERS) as WebProviderId[])(
    "%s: a failing provider writes web.read_failed and a working one writes nothing",
    async (provider) => {
      let failing = true;
      const server = await providerServer((request, body) =>
        failing ? { status: 503 } : fixtures[provider](request, body),
      );
      const { dispatcher } = sharedDispatcher(server.port);
      const failures: unknown[] = [];
      const web = createProductionHostWeb({
        secrets: { resolve: async () => "fixture-credential-0123456789" },
        dispatcher,
        onReadFailed: (failure) => failures.push(failure),
      });
      const search = () =>
        web.execute({
          tool: "web_search",
          arguments: { query: "Tokyo weather", limit: 1 },
          providers: [provider],
          secrets: [
            { provider: "deepseek", secretRef: "fixture", secretVersion: "1", purpose: "web" },
          ],
          maximumBytes: 32 * 1024,
        });
      const failed = await search();
      expect(failed.ok).toBe(false);
      expect(failures).toEqual([
        { event: "web.read_failed", tool: "web_search", code: failed.code, providers: [provider] },
      ]);
      expect(failed.code).toMatch(/^[A-Z][A-Z0-9_]+$/u);
      failing = false;
      expect((await search()).ok).toBe(true);
      expect(failures).toHaveLength(1);
    },
  );
});
