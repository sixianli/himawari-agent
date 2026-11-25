import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("release walkthrough locators", () => {
  it("is the only place the release walkthrough takes its page locators from", () => {
    const source = readFileSync(
      path.join(import.meta.dirname, "../integration/product-path-browser.test.ts"),
      "utf8",
    );
    const block = (start, end) => {
      const from = source.indexOf(start);
      const to = source.indexOf(end, from + start.length);
      if (from < 0 || to < 0) throw new Error(`RELEASE_WALKTHROUGH_SOURCE_MOVED ${start}`);
      return source.slice(from, to);
    };
    const parts = [
      block('productDescribe("product path: release acceptance in a real browser"', "\n});\n"),
      ...[
        "function composer(",
        "async function send(",
        "async function expectFinishedTurnShowsStep(",
        "async function openMainThread(",
        "async function openToolsSettings(",
        "async function closeSettings(",
        "async function searchToggleUsable(",
        "async function expectNewsSearchResults(",
      ].map((name) => block(name, "\n}\n")),
    ];
    for (const part of parts) {
      expect(part).not.toMatch(/getByRole\(/);
      expect(part).not.toMatch(/locator\(\s*["'`]/);
      expect(part).not.toMatch(/getByText\(\s*["'`][^"'`]*["'`]\s*\)/);
    }
  });
});
