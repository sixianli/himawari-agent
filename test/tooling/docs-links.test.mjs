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

  it("ignores links inside any kind of code, including list fences and indented code", () => {
    const root = fixture({
      "docs/a.md":
        "- ```\n  [x](nope.md)\n  ```\n后 [真](gone.md)\n\n> ```\n> [y](nope.md)\n> ```\n\n    [c](nope.md)\n\n`` [q](nope.md) ``\n\n用 ```code``` 表示 [z](nope2.md)\n",
    });
    expect(checkDocsLinks({ root }).errors).toEqual([
      "DOCS_LINK_MISSING docs/a.md -> gone.md",
      "DOCS_LINK_MISSING docs/a.md -> nope2.md",
    ]);
  });

  it("understands angle-bracket, parenthesised, escaped and titled targets", () => {
    const root = fixture({
      "docs/a.md":
        "[1](<has space.md>) [2](b(1).md) [3](c\\(2\\).md) [4]( d.md ) [5](d.md 'title') [6](d.md \"title\") [7](d.md (title)) [8](<gone one.md>)\n",
      "docs/has space.md": "",
      "docs/b(1).md": "",
      "docs/c(2).md": "",
      "docs/d.md": "",
    });
    expect(checkDocsLinks({ root })).toEqual({
      checked: 5,
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

  it("treats targets outside the repository as missing even when the file exists", () => {
    const parent = mkdtempSync(join(tmpdir(), "docs-links-parent-"));
    roots.push(parent);
    mkdirSync(join(parent, "repo/docs"), { recursive: true });
    writeFileSync(join(parent, "outside.md"), "");
    writeFileSync(join(parent, "repo/docs/b.md"), "");
    writeFileSync(
      join(parent, "repo/docs/a.md"),
      "[1](../../outside.md) [2](/docs/b.md) [3](//example.com/x)\n",
    );
    expect(checkDocsLinks({ root: join(parent, "repo") }).errors).toEqual([
      "DOCS_LINK_MISSING docs/a.md -> ../../outside.md",
    ]);
  });

  it("does not treat footnotes as links, follows multi-line definitions, and ignores anchors written in code", () => {
    const root = fixture({
      "docs/a.md":
        '脚注[^1] [甲][r1] [跳](#fake) [真](#real)\n\n[^1]: 这是脚注正文\n[r1]:\n  gone.md\n\n`<a id="fake"></a>`\n\n<a id="real"></a>\n',
    });
    expect(checkDocsLinks({ root }).errors).toEqual([
      "DOCS_LINK_MISSING docs/a.md -> gone.md",
      "DOCS_ANCHOR_MISSING docs/a.md -> #fake",
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

  it("checks links in table cells, list items, block quotes and images, and unreferenced definitions", () => {
    const root = fixture({
      "docs/a.md":
        "| [h](g1.md) |\n| --- |\n| [c](g2.md) |\n\n- 项\n  - [n](g3.md)\n\n> [q](g4.md) ![i](g5.png)\n\n[^caret](g6.md)\n\n[d]: g7.md\n",
    });
    expect(checkDocsLinks({ root }).errors).toHaveLength(7);
  });

  it("keeps repository files whose names start with two dots and takes heading text without link syntax", () => {
    const root = fixture({
      "docs/a.md": "[1](..cache.md) [2](b.md#a-b-c) [3](b.md#x)\n",
      "docs/..cache.md": "",
      "docs/x.md": "",
      "docs/b.md": "## [a [b] c](x.md)\n",
    });
    expect(checkDocsLinks({ root }).errors).toEqual(["DOCS_ANCHOR_MISSING docs/a.md -> b.md#x"]);
  });

  it("fails when a link to a deleted document names a section but drops its anchor", () => {
    const base = "https://github.com/o/r/blob/abc/docs/execution/specs/old.md";
    const root = fixture({
      "docs/a.md": `[old.md「启动 监督」（已删除，链接指向删除前的版本）](${base}) [old.md「启动 监督」（已删除，链接指向删除前的版本）](${base}#%E5%90%AF%E5%8A%A8%20%E7%9B%91%E7%9D%A3) [old.md「profile」（已删除，链接指向删除前的版本）](${base}#profile) [old.md（已删除，链接指向删除前的版本）](${base})\n`,
    });
    expect(checkDocsLinks({ root })).toEqual({
      checked: 0,
      errors: [`DOCS_DELETED_LINK_SECTION_MISSING docs/a.md -> ${base}`],
    });
  });

  it("fails when a governed document path written as code no longer exists", () => {
    const root = fixture({
      "docs/a.md":
        "`docs/backlog/BL-1-gone.md` `docs/execution/specs/kept.md` `docs/runbooks/gone-runbook.md` `docs/adr/NNNN-*.md` `docs/execution/specs/<名字>.md` `docs/sdk.md`\n",
      "docs/execution/specs/kept.md": "",
    });
    expect(checkDocsLinks({ root })).toEqual({
      checked: 0,
      errors: [
        "DOCS_PATH_MISSING docs/a.md -> docs/backlog/BL-1-gone.md",
        "DOCS_PATH_MISSING docs/a.md -> docs/runbooks/gone-runbook.md",
      ],
    });
  });
});
