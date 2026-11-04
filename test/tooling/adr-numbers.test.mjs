import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("exits 1 from the command line when two ADRs share a number", () => {
    const root = fixture(["0001-a.md", "0001-b.md"]);
    const script = join(process.cwd(), "scripts/check-adr-numbers.mjs");
    const run = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { checkAdrNumbers } from ${JSON.stringify(script)}; const r = checkAdrNumbers({ root: ${JSON.stringify(root)} }); process.exitCode = r.errors.length === 0 ? 0 : 1;`,
      ],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(1);
  });

  it("passes on this repository", () => {
    expect(checkAdrNumbers().errors).toEqual([]);
  });
});
