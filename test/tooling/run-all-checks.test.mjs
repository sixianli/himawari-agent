import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FAILED_OUTPUT_BUDGET,
  runAllChecks,
  runStep,
  STEP_TAIL_BYTES,
  stepNames,
} from "../../scripts/run-all-checks.mjs";

const numbered = (count) => Array.from({ length: count }, (_, index) => `line ${index + 1}`);

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

describe("npm run check", () => {
  it("runs every step even after one fails and reports each failure", async () => {
    const ran = [];
    const lines = [];
    const status = await runAllChecks(
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

  it("reports a later failure that an earlier failure used to hide", async () => {
    const lines = [];
    const status = await runAllChecks(
      ["format:check", "check:boundaries"],
      () => 1,
      (line) => lines.push(line),
    );
    expect(status).toBe(1);
    expect(lines).toContain("CHECK_FAILED check:boundaries exit=1");
  });

  it("repeats the end of a failed step's output after the summary so a truncated log still shows why", async () => {
    const lines = [];
    const output = numbered(150).join("\n");
    const status = await runAllChecks(
      ["check:delivery-deploy", "lint"],
      (name) =>
        name === "lint" ? { status: 0, output: "fine" } : { status: 1, output: `${output}\n` },
      (line) => lines.push(line),
    );
    expect(status).toBe(1);
    const start = lines.indexOf(
      `CHECK_FAILED_OUTPUT check:delivery-deploy last ${FAILED_OUTPUT_BUDGET - 1} lines`,
    );
    expect(start).toBeGreaterThan(lines.indexOf("CHECK_SUMMARY 1 of 2 steps failed"));
    expect(lines.slice(start + 1)).toEqual(numbered(150).slice(-(FAILED_OUTPUT_BUDGET - 1)));
    expect(lines.join("\n")).not.toContain("fine");
  });

  it("splits the repeated lines between failed steps so every failure fits in the log's last lines", async () => {
    const lines = [];
    await runAllChecks(
      ["a", "b", "c", "d"],
      (name) => ({
        status: 1,
        output: numbered(100)
          .map((line) => `${name} ${line}`)
          .join("\n"),
      }),
      (line) => lines.push(line),
    );
    const repeated = lines.slice(lines.indexOf("CHECK_SUMMARY 4 of 4 steps failed") + 1);
    expect(repeated.length).toBeLessThanOrEqual(FAILED_OUTPUT_BUDGET);
    for (const name of ["a", "b", "c", "d"]) {
      expect(repeated).toContain(`CHECK_FAILED_OUTPUT ${name} last 24 lines`);
      expect(repeated).toContain(`${name} line 100`);
      expect(repeated).not.toContain(`${name} line 76`);
    }
  });

  it.each([25, 49, 60])(
    "keeps the repeated block, titles included, within the budget when %i steps fail",
    async (count) => {
      const lines = [];
      const names = Array.from({ length: count }, (_, index) => `step-${index}`);
      await runAllChecks(
        names,
        (name) => ({
          status: 1,
          output: numbered(10)
            .map((line) => `${name} ${line}`)
            .join("\n"),
        }),
        (line) => lines.push(line),
      );
      const repeated = lines.slice(
        lines.indexOf(`CHECK_SUMMARY ${count} of ${count} steps failed`) + 1,
      );
      expect(repeated.length).toBeLessThanOrEqual(FAILED_OUTPUT_BUDGET);
      if (count <= FAILED_OUTPUT_BUDGET / 2) expect(repeated).toContain(`step-0 line 10`);
      else expect(repeated).toEqual([]);
    },
  );

  it("prints no repeated block for a failed step that wrote nothing", async () => {
    const lines = [];
    await runAllChecks(
      ["a"],
      () => ({ status: 2, output: "\n" }),
      (line) => lines.push(line),
    );
    expect(lines).toEqual(["CHECK_FAILED a exit=2", "CHECK_SUMMARY 1 of 1 steps failed"]);
  });

  it("writes a real step's output before the step ends and keeps stdout and stderr", async () => {
    const written = [];
    let finished = false;
    const pending = runStep(
      process.execPath,
      [
        "-e",
        "console.log('out first'); setTimeout(() => { console.error('err last'); process.exit(3); }, 1500);",
      ],
      { write: (chunk) => written.push(chunk) },
    ).then((result) => {
      finished = true;
      return result;
    });
    await vi.waitFor(() => expect(written.join("")).toContain("out first"), { timeout: 1200 });
    expect(finished).toBe(false);
    const result = await pending;
    expect(result.status).toBe(3);
    expect(written.join("")).toContain("err last");
    expect(result.output).toContain("out first\n");
    expect(result.output).toContain("err last");
  });

  it("keeps a bounded tail even when a step writes one very long line", async () => {
    const result = await runStep(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(1024 * 1024) + 'END'); process.exitCode = 1;"],
      { write: () => {} },
    );
    expect(result.status).toBe(1);
    expect(result.output.length).toBe(STEP_TAIL_BYTES);
    expect(result.output.endsWith("END")).toBe(true);
  });

  it("reports a step that cannot start as a failure with the reason", async () => {
    const result = await runStep(path.join(tmpdir(), "no-such-command-for-check"), [], {
      write: () => {},
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("ENOENT");
  });

  it("succeeds only when every step passes", async () => {
    const lines = [];
    expect(
      await runAllChecks(
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
      ["check:delivery-shadow", "test_shadow_rehearsal.py"],
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
