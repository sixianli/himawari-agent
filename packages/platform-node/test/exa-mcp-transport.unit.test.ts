import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  connect: vi.fn(),
  callTool: vi.fn(),
  closeClient: vi.fn(),
  closeProxy: vi.fn(),
  proxyFetch: vi.fn(),
  proxyCreated: vi.fn(),
  fetch: undefined as typeof globalThis.fetch | undefined,
}));
vi.mock("@modelcontextprotocol/client", () => ({
  Client: class {
    connect = state.connect;
    callTool = state.callTool;
    close = state.closeClient;
  },
  StreamableHTTPClientTransport: class {
    constructor(_endpoint: URL, options: { fetch: typeof globalThis.fetch }) {
      state.fetch = options.fetch;
    }
  },
}));
vi.mock("undici", () => ({
  fetch: state.proxyFetch,
  ProxyAgent: class {
    constructor(options: unknown) {
      state.proxyCreated(options);
    }
    close = state.closeProxy;
  },
}));

import { ExaPublicSearchAdapter } from "../src/exa-public-search.js";

const endpoint = "https://mcp.exa.ai/mcp";
const searchText =
  "Title: Tokyo weather\nURL: https://example.test/weather\nHighlights:\nCurrent forecast";
beforeEach(() => {
  vi.resetAllMocks();
  state.fetch = undefined;
  vi.stubEnv("HTTPS_PROXY", "http://fixture:fixture@127.0.0.1:4321");
  state.connect.mockResolvedValue(undefined);
  state.closeClient.mockResolvedValue(undefined);
  state.closeProxy.mockResolvedValue(undefined);
  state.callTool.mockResolvedValue({ content: [{ type: "text", text: searchText }] });
  state.proxyFetch.mockResolvedValue(new Response("mcp response"));
});
afterEach(() => vi.unstubAllEnvs());
const search = () => new ExaPublicSearchAdapter().search({ query: " Tokyo weather ", limit: 2 });
function transportFetch() {
  if (!state.fetch) throw new Error("Transport not constructed");
  return state.fetch;
}

describe("public search MCP adapter transport contract", () => {
  it("sends only the approved query through the pinned authenticated loopback proxy", async () => {
    const results = await search();
    expect(results).toMatchObject([
      { title: "Tokyo weather", url: "https://example.test/weather", openedResourceId: null },
    ]);
    expect(state.proxyCreated).toHaveBeenCalledExactlyOnceWith({
      uri: "http://127.0.0.1:4321/",
      token: `Basic ${Buffer.from("fixture:fixture").toString("base64")}`,
    });
    expect(state.callTool).toHaveBeenCalledExactlyOnceWith(
      {
        name: "web_search_exa",
        arguments: { query: "Tokyo weather", objective: expect.any(String), numResults: 2 },
      },
      { timeout: 30000 },
    );
    const signal = new AbortController().signal;
    const received = await transportFetch()(endpoint, {
      method: "POST",
      body: "approved request",
      headers: { "content-type": "application/json" },
      signal,
    });
    expect(await received.text()).toBe("mcp response");
    expect(state.proxyFetch).toHaveBeenCalledExactlyOnceWith(endpoint, {
      method: "POST",
      body: "approved request",
      headers: { "content-type": "application/json" },
      signal,
      redirect: "error",
      dispatcher: expect.any(Object),
    });
    expect(state.closeClient).toHaveBeenCalledOnce();
    expect(state.closeProxy).toHaveBeenCalledOnce();
  });
  it.each([
    undefined,
    "https://fixture:fixture@127.0.0.1:4321",
    "http://fixture:fixture@external.example.test:4321",
    "http://127.0.0.1:4321",
    "http://fixture@127.0.0.1:4321",
    "http://:fixture@127.0.0.1:4321",
  ])("rejects unapproved proxy configuration %s before connecting", async (proxy) => {
    vi.stubEnv("HTTPS_PROXY", proxy);
    await expect(search()).rejects.toThrow(
      proxy ? "WEB_SEARCH_SANDBOX_PROXY_INVALID" : "WEB_SEARCH_SANDBOX_PROXY_REQUIRED",
    );
    expect(state.proxyCreated).not.toHaveBeenCalled();
    expect(state.connect).not.toHaveBeenCalled();
  });
  it.each(["connect", "callTool"] as const)(
    "closes both resources when %s fails",
    async (point) => {
      state[point].mockRejectedValueOnce(new Error("provider unavailable"));
      await expect(search()).rejects.toThrow("provider unavailable");
      expect(state.closeClient).toHaveBeenCalledOnce();
      expect(state.closeProxy).toHaveBeenCalledOnce();
    },
  );
  it("still closes the proxy when the MCP client fails to close", async () => {
    state.closeClient.mockRejectedValueOnce(new Error("close failed"));
    expect(await search()).toHaveLength(1);
    expect(state.closeProxy).toHaveBeenCalledOnce();
  });
  it.each([{ isError: true, content: [] }, { content: null }, { content: "invalid" }])(
    "rejects provider failures instead of producing an empty success %j",
    async (result) => {
      state.callTool.mockResolvedValueOnce(result);
      await expect(search()).rejects.toThrow("WEB_SEARCH_PROVIDER_FAILED");
      expect(state.closeClient).toHaveBeenCalledOnce();
      expect(state.closeProxy).toHaveBeenCalledOnce();
    },
  );
  it("keeps non-text MCP items out of search excerpts", async () => {
    state.callTool.mockResolvedValueOnce({
      content: [
        { type: "image", data: "image-data" },
        { type: "text", text: searchText },
      ],
    });
    expect(await search()).toHaveLength(1);
  });
  it("rejects secret-bearing provider text before displaying it", async () => {
    state.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: searchText + "\nsk-" + "a".repeat(40) }],
    });
    await expect(search()).rejects.toThrow("WEB_SEARCH_OUTPUT_REDACTED");
    expect(state.closeProxy).toHaveBeenCalledOnce();
  });
  it("refuses a changed MCP endpoint and non-text request bodies before egress", async () => {
    await search();
    await expect(transportFetch()("https://other.example.test/mcp")).rejects.toThrow(
      "WEB_SEARCH_ENDPOINT_CHANGED",
    );
    await expect(transportFetch()(endpoint, { body: new Uint8Array([1]) })).rejects.toThrow(
      "WEB_SEARCH_REQUEST_INVALID",
    );
    expect(state.proxyFetch).not.toHaveBeenCalled();
  });
  it("preserves a bodyless response and does not invent request fields", async () => {
    await search();
    state.proxyFetch.mockResolvedValueOnce(
      new Response(null, { status: 204, headers: { "x-fixture": "value" } }),
    );
    const result = await transportFetch()(endpoint);
    expect(result.status).toBe(204);
    expect(result.body).toBeNull();
    expect(result.headers.get("x-fixture")).toBe("value");
    expect(state.proxyFetch).toHaveBeenCalledWith(endpoint, {
      headers: {},
      redirect: "error",
      dispatcher: expect.any(Object),
    });
  });
  it.each([256 * 1024, 256 * 1024 + 1])(
    "enforces the streaming response limit at %i bytes",
    async (size) => {
      await search();
      state.proxyFetch.mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(size - 1));
              controller.enqueue(new Uint8Array(1));
              controller.close();
            },
          }),
        ),
      );
      const result = await transportFetch()(endpoint);
      if (size === 256 * 1024) expect((await result.arrayBuffer()).byteLength).toBe(size);
      else await expect(result.arrayBuffer()).rejects.toThrow("WEB_SEARCH_RESPONSE_LIMIT");
    },
  );
});
