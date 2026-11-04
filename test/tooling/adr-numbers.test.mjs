import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkAdrNumbers, findAdrNumberProblems } from "../../scripts/check-adr-numbers.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(names) {
  const root = mkdtempSync(join(tmpdir(), "adr-numbers-"));
  roots.push(root);
  mkdirSync(join(root, "docs/adr"), { recursive: true });
  for (const name of names) writeFileSync(join(root, "docs/adr", name), "# ADR\n");
  return root;
}

describe("ADR number check", () => {
  it("passes when every ADR has its own number", () => {
    expect(findAdrNumberProblems(["0001-first.md", "0002-second.md", "README.txt"]).errors).toEqual(
      [],
    );
  });

  it("reports two ADRs that share a number, naming both files", () => {
    const { errors } = findAdrNumberProblems([
      "0148-send-every-model-request-through-one-in-process-egress.md",
      "0148-bring-related-memories-into-gmail-checks.md",
      "0149-append-only-model-requests.md",
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^ADR_NUMBER_DUPLICATE 0148 /);
    expect(errors[0]).toContain("docs/adr/0148-bring-related-memories-into-gmail-checks.md");
    expect(errors[0]).toContain(
      "docs/adr/0148-send-every-model-request-through-one-in-process-egress.md",
    );
  });

  it("reports a file name that is not a four-digit number followed by a short name", () => {
    expect(findAdrNumberProblems(["148-short.md"]).errors[0]).toMatch(/^ADR_NUMBER_NAME /);
    expect(findAdrNumberProblems(["0148_Short.md"]).errors[0]).toMatch(/^ADR_NUMBER_NAME /);
  });

  it("fails on an empty or missing ADR directory instead of passing silently", () => {
    expect(checkAdrNumbers({ root: fixture([]) }).errors[0]).toMatch(/^ADR_NUMBER_NO_FILES /);
    const empty = mkdtempSync(join(tmpdir(), "adr-numbers-"));
    roots.push(empty);
    expect(checkAdrNumbers({ root: empty }).errors[0]).toMatch(/^ADR_NUMBER_NO_DIRECTORY /);
  });

  it("runs the real command line entry: exits 1 on a shared number and 0 when numbers are unique", () => {
    const script = fileURLToPath(new URL("../../scripts/check-adr-numbers.mjs", import.meta.url));
    const run = (root) =>
      spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8", cwd: tmpdir() });
    const shared = run(fixture(["0001-a.md", "0001-b.md"]));
    expect(shared.status).toBe(1);
    expect(shared.stderr).toContain("ADR_NUMBER_DUPLICATE 0001");
    expect(shared.stdout).toContain("ADR_NUMBERS failed");
    const unique = run(fixture(["0001-a.md", "0002-b.md"]));
    expect(unique.status).toBe(0);
    expect(unique.stdout).toContain("ADR_NUMBERS passed");
  });

  it("refuses any argument other than --root <directory> instead of silently checking the repository", () => {
    const script = fileURLToPath(new URL("../../scripts/check-adr-numbers.mjs", import.meta.url));
    for (const args of [["--root"], [`--root=${tmpdir()}`], ["--rooot", tmpdir()], ["extra"]]) {
      const run = spawnSync(process.execPath, [script, ...args], {
        encoding: "utf8",
        cwd: tmpdir(),
      });
      expect(run.status, args.join(" ")).toBe(2);
      expect(run.stderr).toContain("ADR_NUMBER_ROOT_MISSING");
    }
  });

  it("passes on this repository", () => {
    expect(checkAdrNumbers().errors).toEqual([]);
  });
});
