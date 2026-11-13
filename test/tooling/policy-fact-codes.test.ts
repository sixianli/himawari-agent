import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILT_IN_ACTION_RULES,
  isPolicyFactCode,
  POLICY_FACT_REGISTRY,
} from "@himawari-agent/application";
import { expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FACT_LITERAL =
  /code:\s*"([a-z0-9_]+)"\s*,\s*minimumRisk\b|minimumRisk:[^}]*?code:\s*"([a-z0-9_]+)"/gs;
const RULE_FACT = /"([a-z0-9_]+)" in facts/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory())
      return ["node_modules", "dist", "test"].includes(entry.name) ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

function unregisteredFactCodes(
  files: readonly { readonly file: string; readonly text: string }[],
): string[] {
  return files.flatMap(({ file, text }) =>
    [...text.matchAll(FACT_LITERAL)]
      .map((match) => match[1] ?? match[2] ?? "")
      .filter((code) => !isPolicyFactCode(code))
      .map((code) => `${file}: ${code}`),
  );
}

it("[ADR-0257] every policy fact code written in the source is in the fact registry", () => {
  const files = ["apps", "packages"].flatMap((root) =>
    sourceFiles(path.join(ROOT, root)).map((file) => ({
      file: path.relative(ROOT, file),
      text: readFileSync(file, "utf8"),
    })),
  );
  expect(files.some(({ text }) => [...text.matchAll(FACT_LITERAL)].length > 0)).toBe(true);
  expect(unregisteredFactCodes(files)).toEqual([]);
});

it("[ADR-0257] the scan reports a fact code that is not registered", () => {
  expect(
    unregisteredFactCodes([
      {
        file: "sample.ts",
        text: 'facts: [{ code: "made_up_fact", minimumRisk: "LOW", source: "runtime" }]',
      },
    ]),
  ).toEqual(["sample.ts: made_up_fact"]);
});

it("[ADR-0257] every fact code a built-in action rule looks for is registered and labelled in three languages", () => {
  const named = BUILT_IN_ACTION_RULES.flatMap(({ expression }) =>
    [...expression.matchAll(RULE_FACT)].map((match) => match[1] ?? ""),
  );
  expect(named.length).toBeGreaterThan(0);
  expect(named.filter((code) => !isPolicyFactCode(code))).toEqual([]);
  for (const { label } of POLICY_FACT_REGISTRY)
    expect([label.zh, label.en, label.ja].every((text) => text.length > 0)).toBe(true);
});
