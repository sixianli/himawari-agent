import { describe, expect, it } from "vitest";
import {
  ExaPublicSearchAdapter,
  parseExaSearchResults,
  SANDBOX_PROXY,
} from "../src/exa-public-search.js";
import { publicSearchFailure } from "../src/web-provider-failure.js";

const exaFreeRateLimitNotice =
  "You've hit Exa's free MCP rate limit. To continue using without limits, create your own Exa API key.\n\nFix: Create API key at https://dashboard.exa.ai/api-keys , and then update Exa MCP URL to this https://mcp.exa.ai/mcp?exaApiKey=YOUR_EXA_API_KEY";

describe("public search provider boundary", () => {
  it("preserves source dates and marks excerpts as unopened", () => {
    const results = parseExaSearchResults(
      "Title: Tokyo forecast\nURL: https://example.org/weather\nPublished: 2026-09-11\nHighlights:\nForecast excerpt\n\n---\n\nTitle: Second\nURL: https://example.org/other\nHighlights:\nOther",
      1,
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      url: "https://example.org/weather",
      openedResourceId: null,
      resultRank: 1,
    });
    expect(results[0]?.summary).toContain("Published: 2026-09-11");
  });
  it("does not fabricate a successful empty search from a changed provider format", () => {
    expect(() => parseExaSearchResults("Provider unavailable", 5)).toThrow(
      "WEB_SEARCH_RESPONSE_UNRECOGNIZED",
    );
  });
  it("[R2-T13] reports the free MCP rate-limit notice as a rate limit, not a changed format", () => {
    expect(() => parseExaSearchResults(exaFreeRateLimitNotice, 3)).toThrow(
      "WEB_SEARCH_RATE_LIMITED",
    );
    expect(() =>
      parseExaSearchResults(exaFreeRateLimitNotice.replace("rate limit", "usage limit"), 3),
    ).toThrow("WEB_SEARCH_RESPONSE_UNRECOGNIZED");
    expect(() => parseExaSearchResults(" \n ", 3)).not.toThrow();
    expect(() =>
      parseExaSearchResults(`${exaFreeRateLimitNotice}\n${"x".repeat(4096)}`, 3),
    ).toThrow("WEB_SEARCH_RESPONSE_UNRECOGNIZED");
  });
  it("[R2-T13] keeps real results whose excerpts mention a rate limit", () => {
    const results = parseExaSearchResults(
      `Title: Exa limits\nURL: https://example.org/limits\nHighlights:\n${exaFreeRateLimitNotice}`,
      3,
    );
    expect(results).toMatchObject([{ title: "Exa limits", url: "https://example.org/limits" }]);
  });
  it.each([
    ["2026-09-12T07:45:00.000Z", "2026-09-12T07:45:00.000Z (UTC)"],
    ["2026-09-12T07:45:00Z", "2026-09-12T07:45:00Z (UTC)"],
    ["2026-09-12", "2026-09-12"],
    ["2026-09-12T16:45:00+09:00", "2026-09-12T16:45:00+09:00"],
    ["N/A", "N/A"],
  ])(
    "makes explicit UTC publication time readable without inventing a zone: %s",
    (raw, expected) => {
      const excerpt = "Forecast excerpt\nPublished: 2026-09-12T01:00:00Z";
      const [result] = parseExaSearchResults(
        `Title: Forecast\nURL: https://example.org/weather\nPublished: ${raw}\nHighlights:\n${excerpt}`,
        1,
      );
      expect(result?.summary).toContain(`Published: ${expected}\nHighlights:\n${excerpt}`);
    },
  );
  it("rejects credential-bearing source URLs", () => {
    expect(() =>
      parseExaSearchResults("Title: Unsafe\nURL: https://user:password@example.org/x", 5),
    ).toThrow();
  });
  it("rejects unbounded or secret-bearing queries before opening a connection", async () => {
    const adapter = new ExaPublicSearchAdapter({ dispatcher: SANDBOX_PROXY });
    for (const input of [
      { query: "", limit: 5 },
      { query: "weather", limit: 1.5 },
      { query: "weather", limit: 11 },
      { query: "x".repeat(4097), limit: 5 },
      { query: "sk-" + "a".repeat(40), limit: 5 },
    ])
      await expect(adapter.search(input)).rejects.toThrow("WEB_SEARCH_INPUT_INVALID");
  });
});

describe("[R2-T13] public search failure reports", () => {
  it("tells the model about a rate limit and hides every other failure detail", () => {
    expect(publicSearchFailure(new Error("WEB_SEARCH_RATE_LIMITED"))).toEqual({
      code: "WEB_SEARCH_RATE_LIMITED",
      output: JSON.stringify({
        error: "WEB_SEARCH_RATE_LIMITED",
        message: "公开搜索服务正在限流，请等几秒再搜一次，不要连续重试。",
      }),
    });
    for (const error of [
      new Error("WEB_SEARCH_RESPONSE_UNRECOGNIZED"),
      new Error("connect http://user:secret@127.0.0.1:4321 failed"),
      Object.assign(new Error("x"), { cause: new Error("WEB_SEARCH_RATE_LIMITED") }),
      "WEB_SEARCH_RATE_LIMITED",
      undefined,
    ])
      expect(publicSearchFailure(error)).toEqual({
        code: "WEB_SEARCH_UNAVAILABLE",
        output: JSON.stringify({
          error: "WEB_SEARCH_UNAVAILABLE",
          message: "搜索服务暂时不可用，马上重试大概率仍会失败，请稍后再试。",
        }),
      });
  });
});
