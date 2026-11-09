import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkDocsLinks } from "../../scripts/check-docs-links.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "docs-links-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  return root;
}

describe("docs link check", () => {
  it("passes when every relative link and anchor exists", () => {
    const root = fixture({
      "docs/a.md":
        '见 [B](b/b.md#第一节)、[自己](#top)、[官网](https://example.com)。\n<a id="top"></a>\n',
      "docs/b/b.md": "## 第一节\n",
    });
    expect(checkDocsLinks({ root })).toEqual({ checked: 2, errors: [] });
  });

  it("fails when a linked file is gone, including a nested one", () => {
    const root = fixture({
      "docs/adr/0001-x.md": "[旧手册](../runbooks/gone.md) 和 [证据](../../.ci-output/x.md)",
    });
    expect(checkDocsLinks({ root }).errors).toEqual([
      "DOCS_LINK_MISSING docs/adr/0001-x.md -> ../runbooks/gone.md",
      "DOCS_LINK_MISSING docs/adr/0001-x.md -> ../../.ci-output/x.md",
    ]);
  });

  it("fails when an anchor disappears", () => {
    const root = fixture({
      "docs/a.md": "[x](b.md#gone)",
      "docs/b.md": "## 有\n",
    });
    expect(checkDocsLinks({ root }).errors).toEqual(["DOCS_ANCHOR_MISSING docs/a.md -> b.md#gone"]);
  });

  it("ignores code spans, fenced blocks and docs/archive", () => {
    const root = fixture({
      "docs/a.md": "`[x](nope.md)`\n```\n[y](nope.md)\n```\n",
      "docs/archive/old.md": "[z](nope.md)",
    });
    expect(checkDocsLinks({ root })).toEqual({ checked: 0, errors: [] });
  });
});
