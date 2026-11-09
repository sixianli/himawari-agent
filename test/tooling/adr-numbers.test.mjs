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
  for (const name of names)
    writeFileSync(join(root, "docs/adr", name), `# ADR ${name.slice(0, 4)}：标题\n\n## 结论\n`);
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

  it("reports an ADR whose title number differs from its file name number", () => {
    const root = fixture(["0001-a.md", "0002-b.md"]);
    writeFileSync(join(root, "docs/adr/0002-b.md"), "# ADR 0003：改过号忘了改标题\n");
    const { errors } = checkAdrNumbers({ root });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^ADR_NUMBER_TITLE docs\/adr\/0002-b\.md .*0003.*0002/);
    writeFileSync(join(root, "docs/adr/0002-b.md"), "# 没有编号的标题\n");
    expect(checkAdrNumbers({ root }).errors[0]).toMatch(/^ADR_NUMBER_TITLE /);
  });

  it("reports a docs link that still points at an old ADR file name or a missing heading", () => {
    const root = fixture(["0001-a.md", "0002-b.md"]);
    mkdirSync(join(root, "docs/execution/specs"), { recursive: true });
    mkdirSync(join(root, "docs/archive"), { recursive: true });
    writeFileSync(
      join(root, "docs/execution/specs/s.md"),
      "[好](../../adr/0001-a.md#结论) [旧名](../../adr/0003-old.md) [锚点](../../adr/0001-a.md#不存在) [错层](../adr/0001-a.md)\n",
    );
    writeFileSync(join(root, "docs/archive/old.md"), "[旧](../adr/0009-gone.md)\n");
    const { errors } = checkAdrNumbers({ root });
    expect(errors).toEqual([
      "ADR_LINK_MISSING docs/execution/specs/s.md -> ../../adr/0003-old.md",
      "ADR_LINK_ANCHOR_MISSING docs/execution/specs/s.md -> ../../adr/0001-a.md#不存在",
      "ADR_LINK_MISSING docs/execution/specs/s.md -> ../adr/0001-a.md",
    ]);
  });

  it("passes on this repository", () => {
    expect(checkAdrNumbers().errors).toEqual([]);
  });
});
