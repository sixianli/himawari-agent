import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runAllChecks, stepNames } from "../../scripts/run-all-checks.mjs";

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

describe("npm run check", () => {
  it("runs every step even after one fails and reports each failure", () => {
    const ran = [];
    const lines = [];
    const status = runAllChecks(
      ["format:check", "lint", "check:boundaries"],
      (name) => {
        ran.push(name);
        return name === "format:check" ? 1 : 0;
      },
      (line) => lines.push(line),
    );
    expect(ran).toEqual(["format:check", "lint", "check:boundaries"]);
    expect(status).toBe(1);
    expect(lines).toEqual([
      "CHECK_FAILED format:check exit=1",
      "CHECK_SUMMARY 1 of 3 steps failed",
    ]);
  });

  it("reports a later failure that an earlier failure used to hide", () => {
    const lines = [];
    const status = runAllChecks(
      ["format:check", "check:boundaries"],
      () => 1,
      (line) => lines.push(line),
    );
    expect(status).toBe(1);
    expect(lines).toContain("CHECK_FAILED check:boundaries exit=1");
  });

  it("succeeds only when every step passes", () => {
    const lines = [];
    expect(
      runAllChecks(
        ["a", "b"],
        () => 0,
        (line) => lines.push(line),
      ),
    ).toBe(0);
    expect(lines).toEqual(["CHECK_ALL_PASSED 2 steps"]);
  });

  it("is wired so that npm run check uses the runner and every step is a real npm script", () => {
    expect(manifest.scripts.check).toBe("node scripts/run-all-checks.mjs");
    const names = stepNames(manifest.scripts["check:steps"]);
    expect(names).toContain("check:boundaries");
    expect(names).toContain("check:delivery-packet");
    expect(names).toContain("check:check-runner");
    for (const name of names) expect(manifest.scripts[name], name).toBeTypeOf("string");
  });

  it("refuses a step that is not a plain npm script", () => {
    expect(() => stepNames("npm run a && node b.mjs")).toThrow("CHECK_STEP_NOT_AN_NPM_SCRIPT");
  });
});
