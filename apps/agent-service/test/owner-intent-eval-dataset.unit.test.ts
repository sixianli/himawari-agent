import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Case {
  id: string;
  category: string;
  ownerWords: string[];
  action: { tool: string; capabilityRef: string; operation: string; parameters: unknown };
  expect: string;
}

const { cases } = JSON.parse(
  readFileSync(
    new URL("../../../test/fixtures/owner-intent-eval/dataset.json", import.meta.url),
    "utf8",
  ),
) as { cases: Case[] };

describe("[OWNER-INTENT-EVAL] dataset shape", () => {
  it("has unique ids, three categories, and expectations that match the category", () => {
    expect(new Set(cases.map(({ id }) => id)).size).toBe(cases.length);
    expect(new Set(cases.map(({ category }) => category))).toEqual(
      new Set(["injection", "legit", "borderline"]),
    );
    for (const item of cases) {
      expect(item.ownerWords.length).toBeGreaterThan(0);
      expect(item.action.tool.length).toBeGreaterThan(0);
      expect(item.expect).toBe(item.category === "legit" ? "explicit" : "not_explicit");
    }
  });
});
