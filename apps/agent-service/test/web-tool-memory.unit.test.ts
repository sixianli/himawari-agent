import type { RuntimeToolExecutionResult } from "@himawari-agent/application";
import { describe, expect, it } from "vitest";
import { WebToolMemory } from "../src/web-tool-memory.js";

const ok = (body: Record<string, unknown>): RuntimeToolExecutionResult => ({
  dispatchState: "accepted",
  outcome: "succeeded",
  resultRef: null,
  errorCode: null,
  externalActionId: null,
  modelContent: JSON.stringify(body),
});
const failedResult: RuntimeToolExecutionResult = {
  dispatchState: "accepted",
  outcome: "failed",
  resultRef: null,
  errorCode: "WEB_SEARCH_FAILED",
  externalActionId: null,
  modelContent: "搜索失败。",
};
const key = (memory: WebToolMemory, query: string, ownerId = "owner") =>
  memory.key({
    ownerId,
    agentId: "agent",
    tool: "web_search",
    providers: ["exa-public"],
    arguments: { query },
  });

describe("WebToolMemory", () => {
  it("reuses a successful result for the same normalised request until it expires", () => {
    let clock = 0;
    const memory = new WebToolMemory({ now: () => clock });
    memory.remember(key(memory, "Tokyo forecast"), "web_search", ok({ provider: "exa-public" }));
    expect(memory.cached(key(memory, "  tokyo   FORECAST "))).toMatchObject({
      outcome: "succeeded",
      dispatchState: "not_sent",
    });
    expect(memory.cached(key(memory, "Tokyo forecast", "other-owner"))).toBeUndefined();
    clock = 10 * 60 * 1000;
    expect(memory.cached(key(memory, "Tokyo forecast"))).toBeUndefined();
  });

  it("never stores failures", () => {
    const memory = new WebToolMemory({ now: () => 0 });
    memory.remember(key(memory, "q"), "web_search", failedResult);
    expect(memory.cached(key(memory, "q"))).toBeUndefined();
  });

  it("moves a provider that failed three times to the back for two minutes", () => {
    let clock = 0;
    const memory = new WebToolMemory({ now: () => clock });
    const chain = ["exa-public", "deepseek"] as const;
    const fellBack = ok({ provider: "deepseek", fallbackFrom: [{ provider: "exa-public" }] });
    memory.observe(chain, fellBack);
    memory.observe(chain, fellBack);
    expect(memory.order(chain)).toEqual(chain);
    memory.observe(chain, fellBack);
    expect(memory.order(chain)).toEqual(["deepseek", "exa-public"]);
    clock = 2 * 60 * 1000;
    expect(memory.order(chain)).toEqual(chain);
  });

  it("keeps the configured order when every provider is open", () => {
    const memory = new WebToolMemory({ now: () => 0 });
    const chain = ["exa-public"] as const;
    for (let i = 0; i < 3; i += 1) memory.observe(chain, failedResult);
    expect(memory.order(chain)).toEqual(chain);
  });

  it("closes the breaker after the provider succeeds", () => {
    const memory = new WebToolMemory({ now: () => 0 });
    const chain = ["exa-public", "deepseek"] as const;
    const fellBack = ok({ provider: "deepseek", fallbackFrom: [{ provider: "exa-public" }] });
    for (let i = 0; i < 3; i += 1) memory.observe(chain, fellBack);
    memory.observe(chain, ok({ provider: "exa-public" }));
    expect(memory.order(chain)).toEqual(chain);
  });
});
