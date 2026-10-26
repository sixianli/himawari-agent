import type { ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import { expect, it } from "vitest";
import { formatTokens, turnSources, turnUsage } from "../src/turn-summary.js";

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
    cached: 7100,
    output: 1000,
    reasoning: 50,
    total: 9600,
    costUsd: 0.003,
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
