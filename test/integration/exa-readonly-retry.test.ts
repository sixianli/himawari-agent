import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ url: "" }));
// Replace only the external endpoint. Keep the actual SDK, HTTP client and
// authenticated CONNECT proxy; a single connection makes old tunnel reuse deterministic.
vi.mock("undici", async () => {
  const actual = await vi.importActual<typeof import("undici")>("undici");
  return {
    ...actual,
    ProxyAgent: class extends actual.ProxyAgent {
      constructor(options: ConstructorParameters<typeof actual.ProxyAgent>[0]) {
        if (typeof options === "string") throw new Error("unexpected proxy options");
        super({ ...options, connections: 1, proxyTunnel: true });
      }
    },
    fetch: (_url: string, init: Parameters<typeof actual.fetch>[1]) =>
      actual.fetch(fixture.url, init),
  };
});

import { ExaPublicSearchAdapter } from "../../packages/platform-node/src/exa-public-search.js";

afterEach(() => vi.unstubAllEnvs());

describe("fixed readonly search with installed MCP and CONNECT transport", () => {
  it.each([
    { status: 503, withdraw: false },
    { status: 403, withdraw: false },
    { status: 503, withdraw: true },
  ])("handles HTTP $status with withdrawal=$withdraw", async ({ status, withdraw }) => {
    const calls: Array<{ method: string; params?: { name?: string; arguments?: unknown } }> = [];
    const toolConnections: number[] = [];
    const sockets = new Set<Duplex>();
    let searches = 0;
    let revoked = false;
    let connections = 0;
    const server = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST") {
          response.writeHead(405).end();
          return;
        }
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const message = JSON.parse(Buffer.concat(chunks).toString());
        calls.push(message);
        if (message.method === "notifications/initialized") {
          response.writeHead(202).end();
          return;
        }
        if (message.method === "tools/call") {
          toolConnections.push(request.socket.remotePort ?? 0);
          if (++searches === 1) {
            revoked = withdraw;
            response.writeHead(status).end("provider unavailable");
            return;
          }
        }
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: message.params.protocolVersion,
                capabilities: { tools: {} },
                serverInfo: { name: "readonly-fixture", version: "1" },
              }
            : {
                content: [
                  {
                    type: "text",
                    text: "Title: Fixture source\nURL: https://example.test/read\nHighlights:\nFixture answer",
                  },
                ],
              };
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      })().catch(() => response.writeHead(500).end());
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture listener missing");
    const proxy = createServer((_request, response) => response.writeHead(405).end());
    proxy.on("connect", (request, client, head) => {
      connections++;
      sockets.add(client);
      client.on("close", () => sockets.delete(client));
      if (
        revoked ||
        request.url !== `127.0.0.1:${address.port}` ||
        request.headers["proxy-authorization"] !==
          `Basic ${Buffer.from("fixture:fixture").toString("base64")}`
      ) {
        client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const upstream = connect(address.port, "127.0.0.1", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream).pipe(client);
      });
      sockets.add(upstream);
      upstream.on("close", () => sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const proxyAddress = proxy.address();
    if (!proxyAddress || typeof proxyAddress === "string")
      throw new Error("proxy listener missing");
    fixture.url = `http://127.0.0.1:${address.port}/mcp`;
    vi.stubEnv("HTTPS_PROXY", `http://fixture:fixture@127.0.0.1:${proxyAddress.port}`);
    try {
      const result = new ExaPublicSearchAdapter().search({ query: "readonly fixture", limit: 1 });
      if (status === 503 && !withdraw)
        await expect(result).resolves.toMatchObject([
          { title: "Fixture source", url: "https://example.test/read" },
        ]);
      else await expect(result).rejects.toThrow();
      expect(calls.filter(({ method }) => method === "initialize")).toHaveLength(1);
      const tools = calls.filter(({ method }) => method === "tools/call");
      expect(tools).toHaveLength(status === 503 && !withdraw ? 2 : 1);
      expect(tools[0]?.params).toMatchObject({
        name: "web_search_exa",
        arguments: { query: "readonly fixture", numResults: 1 },
      });
      if (status === 503 && !withdraw) {
        expect(tools[1]).toEqual(tools[0]);
        expect(toolConnections[1]).not.toBe(toolConnections[0]);
      }
      expect(connections).toBe(status === 503 ? 2 : 1);
    } finally {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await Promise.all(
        [server, proxy].map(
          (listener) =>
            new Promise<void>((resolve, reject) =>
              listener.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
      );
    }
  });
});
