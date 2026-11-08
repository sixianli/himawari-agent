import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ fetch: vi.fn(), close: vi.fn() }));
vi.mock("undici", () => ({
  fetch: state.fetch,
  ProxyAgent: class {
    close = state.close;
  },
}));

import { DeepSeekWebProvider } from "../src/deepseek-web-provider.js";
import { SANDBOX_PROXY } from "../src/exa-public-search.js";

const key = ["fixture", "credential", "0123456789"].join("-");
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const provider = () => new DeepSeekWebProvider({ credential: key, dispatcher: SANDBOX_PROXY });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HTTPS_PROXY", "http://fixture:fixture@127.0.0.1:4321");
  state.close.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("DeepSeek search and fetch adapter", () => {
  it("[NL-2] uses a shared service dispatcher without a sandbox proxy and keeps it open", async () => {
    vi.stubEnv("HTTPS_PROXY", undefined);
    state.fetch.mockResolvedValue(json({ results: [] }));
    const shared = { close: vi.fn() } as unknown as import("undici").Dispatcher;
    await new DeepSeekWebProvider({ credential: key, dispatcher: shared })
      .search({ query: "Tokyo", limit: 1 })
      .catch(() => undefined);
    expect(state.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ dispatcher: shared }),
    );
    expect(shared.close).not.toHaveBeenCalled();
    expect(state.close).not.toHaveBeenCalled();
  });
  it("sends only the query and count to the fixed search endpoint through the sandbox proxy", async () => {
    state.fetch.mockResolvedValue(
      json({
        results: [
          {
            title: "Forecast",
            url: "https://example.org/weather",
            snippet: "short",
            summary: "Sunny tomorrow",
            site_name: "Example",
            date: "2026-10-24",
          },
          { title: "", url: "https://example.org/untitled" },
          { title: "Bad", url: "https://user:pw@example.org/" },
        ],
      }),
    );
    const results = await provider().search({ query: " Tokyo weather ", limit: 3 });
    expect(results).toEqual([
      {
        url: "https://example.org/weather",
        title: "Forecast",
        summary:
          "Title: Forecast\nURL: https://example.org/weather\nSite: Example\nPublished: 2026-10-24\nSummary:\nSunny tomorrow",
        resultRank: 1,
        openedResourceId: null,
      },
    ]);
    const [url, init] = state.fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(JSON.parse(init.body)).toEqual({
      query: "Tokyo weather",
      count: 3,
      need_content: false,
    });
    expect(init.headers.authorization).toBe(`Bearer ${key}`);
    expect(init.redirect).toBe("error");
    expect(state.close).toHaveBeenCalledOnce();
  });
  it("[mask-not-block] masks a secret in the query and a signed address before sending", async () => {
    const token = ["ghp", "_", "B".repeat(30)].join("");
    state.fetch.mockImplementation(async () => json({ results: [] }));
    await provider().search({ query: `repo ${token}`, limit: 1 });
    await provider().search({ query: `repo ${token}`, limit: 1 });
    const bodies = state.fetch.mock.calls.map(([, init]) => init.body as string);
    expect(bodies[0]).toBe(bodies[1]);
    expect(JSON.parse(bodies[0] ?? "{}")).toEqual({
      query: "repo [密钥]",
      count: 1,
      need_content: false,
    });
    state.fetch.mockResolvedValue(json({ title: "Page", content: "body" }));
    await provider().fetch({
      url: "https://user:pw@example.org/a?token=abcdef123456",
      offset: 0,
      maximumBytes: 64,
    });
    expect(JSON.parse(state.fetch.mock.calls[2]?.[1].body)).toEqual({
      url: "https://example.org/a?token=%5B%E5%AF%86%E7%A0%81%23aaaaaaaa%5D",
    });
  });
  it("[mask-not-block] rejects a query by its byte size before masking it", async () => {
    await expect(provider().search({ query: "あ".repeat(6000), limit: 1 })).rejects.toThrow(
      "WEB_SEARCH_INPUT_INVALID",
    );
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it("reports a query longer than 128 characters as unsupported without sending it", async () => {
    await expect(provider().search({ query: "a".repeat(129), limit: 1 })).rejects.toThrow(
      "WEB_SEARCH_INPUT_UNSUPPORTED",
    );
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it("retries once on 429 and then reports the rate limit", async () => {
    state.fetch.mockImplementation(async () => json({ error: "busy" }, 429));
    await expect(provider().search({ query: "q", limit: 1 })).rejects.toThrow(
      "WEB_SEARCH_RATE_LIMITED",
    );
    expect(state.fetch).toHaveBeenCalledTimes(2);
  });
  it("returns fetched Markdown capped at the configured size", async () => {
    state.fetch.mockResolvedValue(
      json({ title: "Page", content: "# Heading\n" + "x".repeat(200) }),
    );
    const page = await provider().fetch({
      url: "https://example.org/a",
      offset: 0,
      maximumBytes: 64,
    });
    expect(page).toMatchObject({ url: "https://example.org/a", title: "Page", truncated: true });
    expect(Buffer.byteLength(page.markdown)).toBeLessThanOrEqual(64);
    expect(JSON.parse(state.fetch.mock.calls[0]?.[1].body)).toEqual({
      url: "https://example.org/a",
    });
  });
  it("refuses private addresses and returns secret-bearing pages for egress to mask", async () => {
    await expect(
      provider().fetch({ url: "http://10.0.0.1/", offset: 0, maximumBytes: 1024 }),
    ).rejects.toThrow("WEB_FETCH_INPUT_INVALID");
    state.fetch.mockResolvedValue(
      json({ title: "Leak", content: `token ${"ghp_"}${"a".repeat(36)}` }),
    );
    const page = await provider().fetch({
      url: "https://example.org/",
      offset: 0,
      maximumBytes: 1024,
    });
    expect(page.markdown).toContain(`token ${"ghp_"}${"a".repeat(36)}`);
  });
});
