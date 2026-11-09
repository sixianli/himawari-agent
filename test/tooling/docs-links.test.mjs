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

  it("ignores indented and quoted fenced blocks but not a fence-like inline span", () => {
    const root = fixture({
      "docs/a.md":
        "- 项\n  ```md\n  [x](nope.md)\n  ```\n> ```\n> [y](nope.md)\n> ```\n用 ```code``` 表示 [z](nope.md)\n",
    });
    expect(checkDocsLinks({ root }).errors).toEqual(["DOCS_LINK_MISSING docs/a.md -> nope.md"]);
  });

  it("understands angle-bracket, parenthesised, escaped and titled targets", () => {
    const root = fixture({
      "docs/a.md":
        "[1](<has space.md>) [2](b(1).md) [3](c\\(2\\).md) [4]( d.md ) [5](d.md 'title') [6](<gone one.md>)\n",
      "docs/has space.md": "",
      "docs/b(1).md": "",
      "docs/c(2).md": "",
      "docs/d.md": "",
    });
    expect(checkDocsLinks({ root })).toEqual({
      checked: 6,
      errors: ["DOCS_LINK_MISSING docs/a.md -> gone one.md"],
    });
  });

  it("checks reference-style definitions", () => {
    const root = fixture({
      "docs/a.md": "[甲][r1] [乙][r2]\n\n[r1]: b.md\n[r2]: gone.md\n[r3]: https://example.com\n",
      "docs/b.md": "",
    });
    expect(checkDocsLinks({ root }).errors).toEqual(["DOCS_LINK_MISSING docs/a.md -> gone.md"]);
  });

  it("matches GitHub anchors for duplicate headings and headings that contain links", () => {
    const root = fixture({
      "docs/a.md": "[1](b.md#重复) [2](b.md#重复-1) [3](b.md#重复-2) [4](b.md#带链接的标题)\n",
      "docs/b.md": "## 重复\n## 重复\n## [带链接的标题](x/very-long.md)\n",
      "docs/x/very-long.md": "",
    });
    expect(checkDocsLinks({ root }).errors).toEqual([
      "DOCS_ANCHOR_MISSING docs/a.md -> b.md#重复-2",
    ]);
  });

  it("treats targets outside the repository as missing and root-relative ones as repo-relative", () => {
    const root = fixture({
      "docs/a.md": "[1](../../outside.md) [2](/docs/b.md) [3](//example.com/x)\n",
      "docs/b.md": "",
    });
    expect(checkDocsLinks({ root }).errors).toEqual([
      "DOCS_LINK_MISSING docs/a.md -> ../../outside.md",
    ]);
  });

  it("still validates links from docs into docs/archive", () => {
    const root = fixture({
      "docs/a.md": "[1](archive/old.md#gone) [2](archive/missing.md)\n",
      "docs/archive/old.md": "## 有\n",
    });
    expect(checkDocsLinks({ root }).errors).toEqual([
      "DOCS_ANCHOR_MISSING docs/a.md -> archive/old.md#gone",
      "DOCS_LINK_MISSING docs/a.md -> archive/missing.md",
    ]);
  });
});
