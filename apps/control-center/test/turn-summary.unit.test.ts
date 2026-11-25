import type { ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import { expect, it } from "vitest";
import { formatTokens, servedModelName, turnSources, turnUsage } from "../src/turn-summary.js";

let sequence = 0;
const record = (overrides: Partial<ThreadExecutionRecord>): ThreadExecutionRecord => ({
  id: `record-${++sequence}`,
  sequence,
  itemId: `item-${sequence}`,
  kind: "status",
  phase: "updated",
  name: "",
  text: "",
  input: "",
  output: "",
  activity: "",
  activityIcon: "",
  occurredAt: "2026-10-26T12:00:00.000Z",
  ...overrides,
});
const usage = (value: Record<string, number>) =>
  record({ name: "runtime.usage", text: JSON.stringify(value) });

it("[UI-9] adds up every model call of the turn and counts cached input as input", () => {
  const total = turnUsage([
    usage({
      input: 1000,
      output: 200,
      cacheRead: 3000,
      cacheWrite: 0,
      reasoning: 50,
      costUsd: 0.001,
    }),
    record({ name: "runtime.turn_started" }),
    usage({
      input: 500,
      output: 800,
      cacheRead: 4000,
      cacheWrite: 100,
      reasoning: 0,
      costUsd: 0.002,
    }),
  ]);
  expect(total).toEqual({
    input: 8600,
    cacheRead: 7000,
    output: 1000,
    reasoning: 50,
    total: 9600,
    models: [],
  });
});

it("[UI-9] reports no usage when the turn has no usage record or the record is unreadable", () => {
  expect(turnUsage([record({ name: "runtime.turn_started" })])).toBeUndefined();
  expect(turnUsage([record({ name: "runtime.usage", text: "not json" })])).toBeUndefined();
});

it("[UI-9] writes token counts the way chat apps do", () => {
  expect(formatTokens(950)).toBe("950");
  expect(formatTokens(24_480)).toBe("24.5k");
  expect(formatTokens(1_250_000)).toBe("1.3M");
});

it("[UI-10] lists each web page the searches returned once, in result order", () => {
  const output = (results: { url: string; title: string }[]) =>
    JSON.stringify({ source: "Exa public web search", results });
  const sources = turnSources([
    record({
      kind: "tool",
      name: "web_search",
      phase: "completed",
      output: output([
        { url: "https://apnews.com/a", title: "AP headline" },
        { url: "https://www.reuters.com/b", title: "Reuters story" },
      ]),
    }),
    record({
      kind: "tool",
      name: "web_search",
      phase: "completed",
      output: output([
        { url: "https://apnews.com/a", title: "AP headline again" },
        { url: "javascript:alert(1)", title: "bad" },
        { url: "https://npr.org/c", title: "" },
      ]),
    }),
    record({ kind: "tool", name: "web_search", phase: "failed", output: "error" }),
    record({ kind: "tool", name: "read", phase: "completed", output: output([]) }),
  ]);
  expect(sources).toEqual([
    { url: "https://apnews.com/a", title: "AP headline", site: "apnews.com" },
    { url: "https://www.reuters.com/b", title: "Reuters story", site: "reuters.com" },
    { url: "https://npr.org/c", title: "npr.org", site: "npr.org" },
  ]);
});

it("[UI-10] names a source by its registrable domain, not the full host", () => {
  const sources = turnSources([
    record({
      kind: "tool",
      name: "web_search",
      phase: "completed",
      output: JSON.stringify({
        source: "Exa public web search",
        results: [
          { url: "https://www3.nhk.or.jp/news/html/20261028/k1.html", title: "NHK" },
          { url: "https://news.yahoo.co.jp/articles/abc", title: "Yahoo" },
          { url: "https://andy.github.io/post", title: "Blog" },
          { url: "http://192.168.1.20:8080/page", title: "Router" },
          { url: "http://localhost:3000/", title: "Local" },
        ],
      }),
    }),
  ]);
  expect(sources.map(({ site }) => site)).toEqual([
    "nhk.or.jp",
    "yahoo.co.jp",
    "andy.github.io",
    "192.168.1.20",
    "localhost",
  ]);
});

it("names the model that actually answered each call as the router reported it, once per distinct model", () => {
  const call = (servedModel?: string) =>
    record({
      name: "runtime.usage",
      text: JSON.stringify({ input: 1, output: 1, ...(servedModel ? { servedModel } : {}) }),
    });
  expect(
    turnUsage([
      call("workbuddy-ai/deepseek-v4.1-flash-sg"),
      call("workbuddy-ai/deepseek-v4.1-flash-sg"),
      call("opencode-go/deepseek-v4.1-flash"),
      call("opencode-go/glm-5.3-flash"),
      call(),
    ])?.models,
  ).toEqual(["deepseek-v4.1-flash-sg", "deepseek-v4.1-flash", "glm-5.3-flash"]);
  expect(turnUsage([call()])?.models).toEqual([]);
  expect(turnUsage([call("/"), call("a/")])?.models).toEqual([]);
  expect(servedModelName("opencode-zen/glm-5.3-flash-free")).toBe("glm-5.3-flash-free");
});
