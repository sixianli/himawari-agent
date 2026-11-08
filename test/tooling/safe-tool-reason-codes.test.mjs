import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const codes = (module) => {
  const source = readFileSync(
    new URL(`../../packages/application/src/services/${module}`, import.meta.url),
    "utf8",
  );
  const start = source.indexOf("const SAFE_TOOL_REASON_CODES = new Set([");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("]);", start);
  expect(end).toBeGreaterThan(start);
  return source
    .slice(source.indexOf("[", start) + 1, end)
    .split(",")
    .map((entry) => entry.trim().replaceAll('"', ""))
    .filter((entry) => entry.length > 0);
};

it("[I-84] keeps the two copies of the allowlisted tool failure reasons identical", () => {
  const state = codes("thread-execution-state.ts");
  expect(state).toContain("SANDBOX_OUTPUT_LIMIT");
  expect(state).toContain("SANDBOX_CPU_TIME_LIMIT");
  expect(codes("thread-execution-projection.ts")).toEqual(state);
});
