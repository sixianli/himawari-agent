import { describe, expect, it } from "vitest";
import { ExaPublicSearchAdapter, parseExaSearchResults } from "../src/exa-public-search.js";

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
    expect(() => parseExaSearchResults("x".repeat(131073), 5)).toThrow("WEB_SEARCH_OUTPUT_LIMIT");
  });
  it("rejects credential-bearing source URLs", () => {
    expect(() =>
      parseExaSearchResults("Title: Unsafe\nURL: https://user:password@example.org/x", 5),
    ).toThrow();
  });
  it("rejects unbounded or secret-bearing queries before opening a connection", async () => {
    const adapter = new ExaPublicSearchAdapter();
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
