import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cellCount,
  checkMarkdownTables,
  findTableProblems,
} from "../../scripts/check-markdown-tables.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "markdown-tables-"));
  roots.push(root);
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(relative)), { recursive: true });
    writeFileSync(join(root, relative), text);
  }
  return root;
}

const positions = (text) =>
  findTableProblems(text).map(({ line, found, expected }) => ({ line, found, expected }));

const threeColumns = "| 检查 | 命令 | 拦什么 |\n| --- | --- | --- |\n| 甲 | `npm run a` | 乙 |\n";

describe("markdown table column check", () => {
  it("counts cells the way GitHub does, keeping escaped pipes inside a cell", () => {
    expect(cellCount("| a | b | c |")).toBe(3);
    expect(cellCount("a | b")).toBe(2);
    expect(cellCount("| `x \\| y` | b |")).toBe(2);
    expect(cellCount("| a | b \\|")).toBe(2);
    expect(cellCount("| a | b \\\\|")).toBe(2);
    expect(cellCount("| a | |")).toBe(2);
  });

  it("[reverse case] fails on tables indented inside a list, inside a quote, or without edge pipes", () => {
    const indented = "1. 第一步\n\n   | a | b |\n   | --- | --- |\n   | 1 | 2 | 3 |\n";
    const quoted = "> | a | b |\n> | --- | --- |\n> | 1 | 2 | 3 |\n";
    const bare = "a | b\n--- | ---\n1 | 2 | 3\n";
    for (const text of [indented, quoted, bare])
      expect(findTableProblems(text).map((problem) => problem.found)).toEqual([3]);
  });

  it("does not treat a heading underline or a horizontal rule as a table", () => {
    expect(findTableProblems("a | b | c\n---\n")).toEqual([]);
    expect(findTableProblems("文字\n\n---\n\n| x |\n")).toEqual([]);
  });

  it("[reverse case] keeps scanning after a fence line that carries a language name inside a fence", () => {
    const text =
      "````\n```js\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n````\n| c | d |\n| --- | --- |\n| 1 |\n";
    expect(positions(text)).toEqual([{ line: 9, found: 1, expected: 2 }]);
    const early = "```\n```js\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n```\n";
    expect(findTableProblems(early)).toEqual([]);
  });

  it("passes tables whose rows match the header", () => {
    expect(findTableProblems(threeColumns)).toEqual([]);
  });

  it("[reverse case] fails when a five-column row sits inside a three-column table", () => {
    const text = `${threeColumns}| 2026-10-30 | 问题 | 原因 | 改法 | 1 |\n| 丙 | 丁 | 戊 |\n`;
    expect(positions(text)).toEqual([{ line: 4, found: 5, expected: 3 }]);
  });

  it("[reverse case] fails on a row with fewer cells", () => {
    const text = "| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n";
    expect(positions(text)).toEqual([{ line: 3, found: 2, expected: 3 }]);
  });

  it("ignores text that GitHub does not render as a table", () => {
    const fenced = "```\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n```\n";
    const indentedCode = "文字\n\n    | a | b |\n    | --- | --- |\n    | 1 | 2 | 3 |\n";
    const quotedFenceInsideFence = "```\n> ```\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n```\n";
    const deepFenceInsideFence = "```\n      ```\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n```\n";
    for (const text of [fenced, indentedCode, quotedFenceInsideFence, deepFenceInsideFence])
      expect(findTableProblems(text)).toEqual([]);
  });

  it("[reverse case] fails when the delimiter row has a different number of columns, so GitHub shows plain text", () => {
    const text = "文字\n\n| a | b | c |\n| --- | --- |\n| 1 | 2 |\n";
    expect(positions(text)).toEqual([{ line: 4, found: 2, expected: 3 }]);
  });

  it("reports the line in the source file for tables in lists, quotes and after a copy in a code block", () => {
    const sameLineAsMarker = "- | a | b |\n  | --- | --- |\n  | 1 | 2 | 3 |\n";
    const afterCopyInFence =
      "```\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n";
    const quotedInList = "1. 一\n2. 二\n\n   > | a | b |\n   > | --- | --- |\n   > | 1 | 2 | 3 |\n";
    expect(positions(sameLineAsMarker)).toEqual([{ line: 3, found: 3, expected: 2 }]);
    expect(positions(afterCopyInFence)).toEqual([{ line: 9, found: 3, expected: 2 }]);
    expect(positions(quotedInList)).toEqual([{ line: 6, found: 3, expected: 2 }]);
  });

  it("[reverse case] still checks a table that follows a backtick line which is not a fence", () => {
    const text = "```a`b\n\n| a | b |\n| --- | --- |\n| 1 | 2 | 3 |\n";
    expect(positions(text)).toEqual([{ line: 5, found: 3, expected: 2 }]);
  });

  it("ends a table at a heading that follows it without a blank line", () => {
    const text = "| a | b |\n| --- | --- |\n| 1 | 2 |\n# 标题 | x | y\n";
    expect(findTableProblems(text)).toEqual([]);
  });

  it("reports the file and line for every document under docs", () => {
    const root = fixture({
      "docs/good.md": threeColumns,
      "docs/nested/bad.md": `${threeColumns}| 1 | 2 | 3 | 4 | 5 |\n`,
      "other/ignored.md": `${threeColumns}| 1 | 2 | 3 | 4 | 5 |\n`,
    });
    const { errors, scanned } = checkMarkdownTables({ root });
    expect(scanned).toBe(2);
    expect(errors).toEqual([
      "MARKDOWN_TABLE_COLUMNS docs/nested/bad.md:4 这一行有 5 列，表头是 3 列",
    ]);
  });

  it("[reverse case] fails when there is nothing to scan", () => {
    const { errors, scanned } = checkMarkdownTables({ root: fixture({ "other/a.md": "x\n" }) });
    expect(scanned).toBe(0);
    expect(errors).toEqual(["MARKDOWN_TABLES_NO_FILES docs/ 下没有找到任何 .md 文件"]);
  });

  it("passes on the repository as committed", () => {
    const run = spawnSync(process.execPath, ["scripts/check-markdown-tables.mjs"], {
      encoding: "utf8",
    });
    expect(run.stderr).toBe("");
    expect(run.stdout).toMatch(/^MARKDOWN_TABLES passed files=[1-9]\d* errors=0$/m);
    expect(run.status).toBe(0);
  });
});
