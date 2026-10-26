import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  connect: vi.fn(),
  callTool: vi.fn(),
  listTools: vi.fn(),
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
    listTools = state.listTools;
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

import { ExaPublicSearchAdapter, SANDBOX_PROXY } from "../src/exa-public-search.js";

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
const search = () =>
  new ExaPublicSearchAdapter({ dispatcher: SANDBOX_PROXY }).search({
    query: " Tokyo weather ",
    limit: 2,
  });
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
      signal: expect.any(AbortSignal),
      redirect: "error",
      dispatcher: expect.any(Object),
    });
    expect(state.closeClient).toHaveBeenCalledOnce();
    expect(state.closeProxy).toHaveBeenCalledOnce();
  });
  it("[NL-2] sends through a shared service dispatcher without a sandbox proxy and keeps it open", async () => {
    vi.stubEnv("HTTPS_PROXY", undefined);
    const shared = { close: vi.fn() } as unknown as import("undici").Dispatcher;
    await new ExaPublicSearchAdapter({ dispatcher: shared }).search({
      query: "Tokyo weather",
      limit: 2,
    });
    await transportFetch()(endpoint, { method: "POST", body: "approved request" });
    expect(state.proxyFetch).toHaveBeenCalledExactlyOnceWith(
      endpoint,
      expect.objectContaining({ dispatcher: shared, redirect: "error" }),
    );
    expect(state.proxyCreated).not.toHaveBeenCalled();
    expect(shared.close).not.toHaveBeenCalled();
    expect(state.closeClient).toHaveBeenCalledOnce();
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
      signal: expect.any(AbortSignal),
      redirect: "error",
      dispatcher: expect.any(Object),
    });
  });
  it.each([1024 * 1024, 1024 * 1024 + 1])(
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
      if (size === 1024 * 1024) expect((await result.arrayBuffer()).byteLength).toBe(size);
      else await expect(result.arrayBuffer()).rejects.toThrow("WEB_SEARCH_RESPONSE_LIMIT");
    },
  );
});

describe("fixed readonly search retries", () => {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: { query: "Tokyo weather", numResults: 2 },
    },
  });
  it("retries the same fixed search once through a fresh authenticated proxy", async () => {
    state.proxyFetch.mockResolvedValueOnce(new Response("busy", { status: 503 }));
    state.callTool.mockImplementationOnce(async () => {
      const response = await transportFetch()(endpoint, { method: "POST", body });
      expect(response.ok).toBe(true);
      return { content: [{ type: "text", text: searchText }] };
    });
    expect(await search()).toHaveLength(1);
    expect(state.proxyFetch).toHaveBeenCalledTimes(2);
    expect(state.proxyFetch.mock.calls.map(([, init]) => init.body)).toEqual([body, body]);
    expect(state.callTool).toHaveBeenCalledOnce();
    expect(state.proxyCreated).toHaveBeenCalledTimes(2);
    expect(state.proxyFetch.mock.calls[1]?.[1]?.dispatcher).not.toBe(
      state.proxyFetch.mock.calls[0]?.[1]?.dispatcher,
    );
    expect(state.closeProxy).toHaveBeenCalledTimes(2);
  });
  it("does not retry arbitrary MCP operations", async () => {
    state.proxyFetch.mockResolvedValue(new Response("busy", { status: 503 }));
    state.callTool.mockImplementationOnce(async () => {
      const response = await transportFetch()(endpoint, {
        method: "POST",
        body: body.replace("web_search_exa", "write_file"),
      });
      expect(response.status).toBe(503);
      return { content: [{ type: "text", text: searchText }] };
    });
    await search();
    expect(state.proxyFetch).toHaveBeenCalledOnce();
  });
  it("caps attempts and does not turn a provider failure into empty success", async () => {
    state.proxyFetch.mockResolvedValue(new Response("busy", { status: 503 }));
    state.callTool.mockImplementationOnce(async () => {
      const response = await transportFetch()(endpoint, { method: "POST", body });
      if (!response.ok) throw new Error("provider unavailable");
      return { content: [] };
    });
    await expect(search()).rejects.toThrow("provider unavailable");
    expect(state.proxyFetch).toHaveBeenCalledTimes(2);
    expect(state.closeClient).toHaveBeenCalledOnce();
    expect(state.closeProxy).toHaveBeenCalledTimes(2);
  });
});

it("propagates cancellation of the original MCP request during retry admission", async () => {
  const controller = new AbortController();
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "web_search_exa",
      arguments: { query: "Tokyo weather", numResults: 2 },
    },
  });
  state.proxyFetch.mockImplementation(async () => {
    controller.abort(new Error("fixture cancellation"));
    return new Response("busy", { status: 503 });
  });
  state.callTool.mockImplementationOnce(async () => {
    await transportFetch()(endpoint, { method: "POST", body, signal: controller.signal });
    throw new Error("unexpected completion");
  });
  await expect(search()).rejects.toThrow("fixture cancellation");
  expect(state.proxyFetch).toHaveBeenCalledOnce();
  const sent = state.proxyFetch.mock.calls[0]?.[1]?.signal;
  expect(sent?.aborted).toBe(true);
  expect(state.closeClient).toHaveBeenCalledOnce();
  expect(state.closeProxy).toHaveBeenCalledOnce();
});

describe("[R2-T13] free MCP rate-limit notices", () => {
  const notice = {
    content: [
      {
        type: "text",
        text: "You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key.",
      },
    ],
  };
  it("retries the same search once through a fresh authenticated proxy", async () => {
    state.callTool.mockResolvedValueOnce(notice);
    expect(await search()).toMatchObject([{ title: "Tokyo weather" }]);
    expect(state.callTool).toHaveBeenCalledTimes(2);
    expect(state.callTool.mock.calls[1]).toEqual(state.callTool.mock.calls[0]);
    expect(state.proxyCreated).toHaveBeenCalledTimes(2);
    expect(state.closeClient).toHaveBeenCalledOnce();
    expect(state.closeProxy).toHaveBeenCalledTimes(2);
  });
  it("stops after one retry and reports the rate limit", async () => {
    state.callTool.mockResolvedValue(notice);
    await expect(search()).rejects.toThrow("WEB_SEARCH_RATE_LIMITED");
    expect(state.callTool).toHaveBeenCalledTimes(2);
    expect(state.closeProxy).toHaveBeenCalledTimes(2);
  });
  it("does not retry when the original search budget cannot cover the wait", async () => {
    const start = performance.now();
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValueOnce(start);
    clock.mockReturnValue(start + 44500);
    state.callTool.mockResolvedValue(notice);
    await expect(search()).rejects.toThrow("WEB_SEARCH_RATE_LIMITED");
    expect(state.callTool).toHaveBeenCalledOnce();
    expect(state.proxyCreated).toHaveBeenCalledOnce();
    clock.mockRestore();
  });
});

describe("public page fetch through Exa", () => {
  const page = "Title: Example page\nURL: https://example.org/a\nText: Hello world";
  const fetchPage = (maximumBytes = 1024) =>
    new ExaPublicSearchAdapter({ dispatcher: SANDBOX_PROXY }).fetch({
      url: "https://example.org/a",
      offset: 0,
      maximumBytes,
    });
  it.each([
    [
      "web_fetch_exa",
      { urls: {}, maxCharacters: {} },
      { urls: ["https://example.org/a"], maxCharacters: 1025 },
    ],
    ["crawling_exa", { url: {} }, { url: "https://example.org/a" }],
  ])(
    "uses the advertised %s tool with only the approved address",
    async (name, properties, args) => {
      state.listTools.mockResolvedValue({
        tools: [{ name, inputSchema: { type: "object", properties } }, { name: "write_file" }],
      });
      state.callTool.mockResolvedValue({ content: [{ type: "text", text: page }] });
      expect(await fetchPage()).toEqual({
        url: "https://example.org/a",
        title: "Example page",
        markdown: page,
        truncated: false,
        nextOffset: null,
      });
      expect(state.callTool).toHaveBeenCalledExactlyOnceWith(
        { name, arguments: args },
        { timeout: 30000 },
      );
      expect(state.closeProxy).toHaveBeenCalledOnce();
    },
  );
  it("fails closed when the server advertises no page reading tool", async () => {
    state.listTools.mockResolvedValue({ tools: [{ name: "web_search_exa" }] });
    await expect(fetchPage()).rejects.toThrow("WEB_FETCH_PROVIDER_FAILED");
    expect(state.callTool).not.toHaveBeenCalled();
  });
  it("caps the page and rejects secret-bearing page text", async () => {
    state.listTools.mockResolvedValue({ tools: [{ name: "crawling_exa", inputSchema: {} }] });
    state.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: page + "x".repeat(99) }],
    });
    expect(await fetchPage(32)).toMatchObject({ truncated: true });
    state.callTool.mockResolvedValueOnce({
      content: [{ type: "text", text: page + "\nsk-" + "a".repeat(40) }],
    });
    await expect(fetchPage()).rejects.toThrow("WEB_FETCH_OUTPUT_REDACTED");
  });
  it("does not open a connection for a private address", async () => {
    await expect(
      new ExaPublicSearchAdapter({ dispatcher: SANDBOX_PROXY }).fetch({
        url: "http://127.0.0.1/",
        offset: 0,
        maximumBytes: 1024,
      }),
    ).rejects.toThrow("WEB_FETCH_INPUT_INVALID");
    expect(state.proxyCreated).not.toHaveBeenCalled();
  });
});
