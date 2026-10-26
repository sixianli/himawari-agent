import { WEB_PROVIDERS, WebProviderError, type WebProviderId } from "@himawari-agent/application";
import { describe, expect, it, vi } from "vitest";
import {
  runWebProviderChain,
  searchWithProviders,
  type WebProvider,
  WebProviderChainError,
} from "../src/web-provider-chain.js";
import { webProviderFailure } from "../src/web-provider-failure.js";

function provider(id: WebProviderId, search: WebProvider["search"]): WebProvider {
  return { descriptor: WEB_PROVIDERS[id], search, fetch: vi.fn() };
}
const result = [
  { url: "https://example.org/", title: "t", summary: "s", resultRank: 1, openedResourceId: null },
];

describe("web provider fallback chain", () => {
  it("moves to the next provider only after a retryable failure and reports the attempt", async () => {
    const exa = vi.fn(async () => {
      throw new Error("WEB_SEARCH_RATE_LIMITED");
    });
    const deepseek = vi.fn(async () => result);
    const searched = await searchWithProviders({
      providers: ["exa-public", "deepseek"],
      query: "q",
      limit: 1,
      create: (id) => provider(id, id === "exa-public" ? exa : deepseek),
    });
    expect(searched).toEqual({
      provider: "deepseek",
      result,
      attempts: [{ provider: "exa-public", code: "RATE_LIMITED" }],
    });
  });
  it.each(["WEB_SEARCH_INPUT_INVALID", "WEB_SEARCH_OUTPUT_REDACTED"])(
    "stops at %s instead of sending the query to another provider",
    async (message) => {
      const deepseek = vi.fn(async () => result);
      const failing = searchWithProviders({
        providers: ["exa-public", "deepseek"],
        query: "q",
        limit: 1,
        create: (id) =>
          provider(
            id,
            id === "exa-public"
              ? async () => {
                  throw new Error(message);
                }
              : deepseek,
          ),
      });
      await expect(failing).rejects.toBeInstanceOf(WebProviderChainError);
      expect(deepseek).not.toHaveBeenCalled();
    },
  );
  it("does not start another provider when the shared budget cannot cover an attempt", async () => {
    let now = 0;
    const deepseek = vi.fn(async () => result);
    await expect(
      runWebProviderChain({
        providers: ["exa-public", "deepseek"],
        create: (id) => provider(id, deepseek),
        attempt: async (entry) => {
          if (entry.descriptor.id === "exa-public") {
            now = 41000;
            throw new Error("WEB_SEARCH_TIMEOUT");
          }
          return entry.search({ query: "q", limit: 1, signal: AbortSignal.timeout(1000) });
        },
        now: () => now,
      }),
    ).rejects.toMatchObject({ attempts: [{ provider: "exa-public", code: "TIMEOUT" }] });
    expect(deepseek).not.toHaveBeenCalled();
  });
  it("treats a missing provider secret as unavailable so the chain can continue", () => {
    expect(webProviderFailure(new WebProviderError("UNAVAILABLE")).fallback).toBe(true);
    expect(webProviderFailure(new Error("connect ECONNRESET")).code).toBe("UNAVAILABLE");
    expect(webProviderFailure(new Error("WEB_SEARCH_INPUT_UNSUPPORTED")).fallback).toBe(true);
  });
});
