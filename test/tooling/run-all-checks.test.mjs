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

  it("repeats the end of each failed step's output after the summary so a truncated log still shows why", () => {
    const lines = [];
    const output = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
    const status = runAllChecks(
      ["check:delivery-deploy", "lint"],
      (name) =>
        name === "lint" ? { status: 0, output: "fine" } : { status: 1, output: `${output}\n` },
      (line) => lines.push(line),
    );
    expect(status).toBe(1);
    const start = lines.indexOf("CHECK_FAILED_OUTPUT check:delivery-deploy last 80 lines");
    expect(start).toBeGreaterThan(lines.indexOf("CHECK_SUMMARY 1 of 2 steps failed"));
    expect(lines.slice(start + 1)).toEqual(
      Array.from({ length: 80 }, (_, index) => `line ${index + 21}`),
    );
    expect(lines.join("\n")).not.toContain("fine");
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
    expect(names).toContain("check:probe-sources");
    expect(manifest.scripts["check:probe-sources"]).toBe(
      "node scripts/check-probe-sources.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/probe-sources.test.mjs",
    );
    for (const [name, file] of [
      ["check:delivery-packet", "test_make_packet.py"],
      ["check:delivery-deploy", "test_deploy.py"],
      ["check:delivery-rollback", "test_rollback.py"],
      ["check:delivery-cleanup", "test_release_cleanup.py"],
      ["check:untested-claims", "test_untested_claims.py"],
    ]) {
      expect(names).toContain(name);
      expect(manifest.scripts[name], name).toBe(`python3 -I scripts/delivery-mode/${file}`);
    }
    expect(names).toContain("check:check-runner");
    expect(names).toContain("check:security-review");
    expect(manifest.scripts["check:security-review"]).toBe(
      "vitest run --config vitest.workspace.ts --project tooling test/tooling/security-review.test.mjs",
    );
    expect(names).toContain("check:docs-links");
    for (const name of names) expect(manifest.scripts[name], name).toBeTypeOf("string");
  });

  it("refuses a step that is not a plain npm script", () => {
    expect(() => stepNames("npm run a && node b.mjs")).toThrow("CHECK_STEP_NOT_AN_NPM_SCRIPT");
  });

  it("gives every tsc run in the typecheck step a fixed heap limit above the 2.5 GB it needs", () => {
    const runs = manifest.scripts.typecheck.split(" && ");
    expect(runs).toHaveLength(2);
    for (const run of runs)
      expect(run).toMatch(
        /^node --max-old-space-size=4096 node_modules\/typescript\/bin\/tsc -p \S+$/,
      );
  });
});
