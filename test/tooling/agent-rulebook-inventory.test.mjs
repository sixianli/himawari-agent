import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkInventory } from "../../scripts/check-agent-rulebook-inventory.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(inventory) {
  const root = mkdtempSync(join(tmpdir(), "rulebook-inventory-"));
  roots.push(root);
  mkdirSync(join(root, "docs/adr"), { recursive: true });
  mkdirSync(join(root, "packages/demo/test"), { recursive: true });
  writeFileSync(join(root, "docs/adr/0001-demo.md"), '<a id="decision"></a>\n# ADR\n');
  writeFileSync(join(root, "docs/incidents-and-gates.md"), "| I-7 | row |\n");
  writeFileSync(
    join(root, "packages/demo/test/demo.unit.test.ts"),
    'it("[PG-8] keeps the list", () => {});\n',
  );
  writeFileSync(join(root, "docs/agent-rulebook-inventory.md"), inventory);
  return root;
}

const VALID = [
  '<a id="top"></a>',
  "[ADR](adr/0001-demo.md#decision) [self](#top)",
  "`demo.unit.test.ts` PG-8 I-7",
].join("\n");

describe("agent rulebook inventory check", () => {
  it("passes when links, anchors, test files and ids all exist", () => {
    expect(checkInventory(fixture(VALID))).toEqual([]);
  });

  it("rejects a link to a missing file, a missing anchor, a missing test file and missing ids", () => {
    const problems = checkInventory(
      fixture(
        [
          "[a](adr/0002-none.md) [b](adr/0001-demo.md#nope) [c](#gone)",
          "`absent.unit.test.ts` PG-99 OM-1 I-999",
        ].join("\n"),
      ),
    );
    expect(problems).toEqual([
      "LINK_FILE_MISSING adr/0002-none.md",
      "LINK_ANCHOR_MISSING adr/0001-demo.md#nope",
      "LINK_ANCHOR_MISSING #gone",
      "TEST_FILE_MISSING absent.unit.test.ts",
      "TEST_ID_MISSING PG-99",
      "TEST_ID_MISSING OM-1",
      "INCIDENT_ID_MISSING I-999",
    ]);
  });

  it("matches test ids exactly and ignores the check's own test file", () => {
    const root = fixture("PG-1 PG-8 PG-80 OM-5");
    writeFileSync(join(root, "packages/demo/test/other.unit.test.ts"), "[PG-10] [PG-800]\n");
    mkdirSync(join(root, "test/tooling"), { recursive: true });
    writeFileSync(join(root, "test/tooling/agent-rulebook-inventory.test.mjs"), "OM-5\n");
    expect(checkInventory(root)).toEqual([
      "TEST_ID_MISSING PG-1",
      "TEST_ID_MISSING PG-80",
      "TEST_ID_MISSING OM-5",
    ]);
  });

  it("checks ids with lowercase suffixes and does not follow symbolic links", () => {
    const root = fixture("PA-2b PA-2c");
    writeFileSync(join(root, "packages/demo/test/suffix.unit.test.ts"), "[PA-2b]\n");
    const outside = mkdtempSync(join(tmpdir(), "rulebook-outside-"));
    roots.push(outside);
    mkdirSync(join(outside, "test"));
    writeFileSync(join(outside, "test/linked.test.ts"), "[PA-2c]\n");
    symlinkSync(join(outside, "test"), join(root, "packages/demo/linked"));
    expect(checkInventory(root)).toEqual(["TEST_ID_MISSING PA-2c"]);
  });
});
