import type { ThreadExecutionRecord } from "@himawari-agent/gateway-contracts";
import { getDomain } from "tldts";

export interface TurnUsage {
  readonly input: number;
  readonly cacheRead: number;
  readonly output: number;
  readonly reasoning: number;
  readonly total: number;
}

export interface TurnSource {
  readonly url: string;
  readonly title: string;
  readonly site: string;
}

const parse = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};
const count = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

export function turnUsage(records: readonly ThreadExecutionRecord[]): TurnUsage | undefined {
  const calls = records
    .filter((record) => record.kind === "status" && record.name === "runtime.usage")
    .map((record) => parse(record.text))
    .filter((value) => value !== undefined);
  if (!calls.length) return undefined;
  const sum = (key: string) => calls.reduce((total, call) => total + count(call[key]), 0);
  const cacheRead = sum("cacheRead");
  const input = sum("input") + cacheRead + sum("cacheWrite");
  const output = sum("output");
  return {
    input,
    cacheRead,
    output,
    reasoning: sum("reasoning"),
    total: input + output,
  };
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function turnSources(records: readonly ThreadExecutionRecord[]): readonly TurnSource[] {
  const sources = new Map<string, TurnSource>();
  for (const record of records) {
    if (record.kind !== "tool" || record.name !== "web_search" || record.phase !== "completed")
      continue;
    const results = parse(record.output)?.["results"];
    if (!Array.isArray(results)) continue;
    for (const result of results) {
      const entry = result && typeof result === "object" ? (result as Record<string, unknown>) : {};
      if (typeof entry["url"] !== "string") continue;
      let url: URL;
      try {
        url = new URL(entry["url"]);
      } catch {
        continue;
      }
      if (!["http:", "https:"].includes(url.protocol) || sources.has(url.href)) continue;
      const site = getDomain(url.hostname, { allowPrivateDomains: true }) ?? url.hostname;
      const title = typeof entry["title"] === "string" ? entry["title"].trim() : "";
      sources.set(url.href, { url: url.href, title: title || site, site });
    }
  }
  return [...sources.values()];
}
