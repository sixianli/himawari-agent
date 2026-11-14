import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkWordLists,
  findWordLists,
  readRegister,
} from "../../scripts/check-meaning-word-lists.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HEADER = "| 文件 | 名字 | 类别 | 理由 | 期限 |\n| --- | --- | --- | --- | --- |\n";
const FILE = "apps/agent-service/src/rules.ts";
const WORD_LIST = 'const ONE_OFF_MARKERS = ["这封", "这次", "今天", "this time"];\n';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "word-lists-"));
  roots.push(root);
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(join(root, dirname(relative)), { recursive: true });
    writeFileSync(join(root, relative), text);
  }
  return root;
}

const register = (...rows) => ({ "docs/meaning-word-lists.md": HEADER + rows.join("\n") + "\n" });
const row = (symbol, kind, deadline = "") =>
  `| \`${FILE}\` | \`${symbol}\` | ${kind} | 理由 | ${deadline} |`;

describe("meaning word list check", () => {
  it("[reverse case] fails when a word list that guesses the owner's meaning is not registered", () => {
    const root = fixture({ [FILE]: WORD_LIST, ...register(row("OTHER", "格式解析")) });
    const { errors } = checkWordLists({ root });
    expect(
      errors.some((error) => error.startsWith(`WORD_LIST_UNREGISTERED ${FILE}:1 ONE_OFF_MARKERS`)),
    ).toBe(true);
    expect(errors.some((error) => error.startsWith("WORD_LIST_ROW_STALE"))).toBe(true);
  });

  it("finds named lists, multi-language regular expressions and runs of natural-language literals", () => {
    const text = [
      "const QUIET = /别提醒我|不要提醒我|don't remind me/u;",
      "const LATER = [",
      '  "明天",',
      '  "后天",',
      '  "下周",',
      '  "next week",',
      "];",
      "const KEYS = [",
      '  "memory.read",',
      '  "memory.write",',
      '  "memory.undo",',
      '  "memory.list",',
      "];",
    ].join("\n");
    expect(findWordLists(text, "a.ts").map(({ symbol, shape }) => [symbol, shape])).toEqual([
      ["QUIET", "regex-alternatives"],
      ["LATER", "literal-array"],
    ]);
  });

  it("passes when the list is registered with an allowed kind", () => {
    const root = fixture({ [FILE]: WORD_LIST, ...register(row("ONE_OFF_MARKERS", "检索分词")) });
    expect(checkWordLists({ root }).errors).toEqual([]);
  });

  it("rejects an unknown kind such as understanding the user's meaning", () => {
    const root = fixture({
      [FILE]: WORD_LIST,
      ...register(row("ONE_OFF_MARKERS", "理解用户意思")),
    });
    expect(checkWordLists({ root }).errors[0]).toMatch(/^WORD_LIST_KIND_INVALID/);
  });

  it("allows a pending removal until its deadline passes, and a not yet merged list may be pre-registered", () => {
    const files = {
      [FILE]: WORD_LIST,
      ...register(
        row("ONE_OFF_MARKERS", "待删除", "2026-11-30"),
        row("NOT_MERGED_YET", "待删除", "2026-11-30"),
      ),
    };
    const root = fixture(files);
    expect(checkWordLists({ root, today: new Date("2026-11-20T00:00:00Z") }).errors).toEqual([]);
    expect(
      checkWordLists({ root, today: new Date("2026-12-01T00:00:00Z") }).errors.map(
        (error) => error.split(" ")[0],
      ),
    ).toEqual(["WORD_LIST_DEADLINE_PASSED"]);
  });

  it("requires a deadline on a pending removal and a reason on every row", () => {
    const { errors } = readRegister(
      `${HEADER}| \`a.ts\` | \`X\` | 待删除 | 理由 | |\n| \`b.ts\` | \`Y\` | 格式解析 | | |\n`,
    );
    expect(errors.map((error) => error.split(" ")[0])).toEqual([
      "WORD_LIST_DEADLINE_MISSING",
      "WORD_LIST_REASON_EMPTY",
    ]);
  });

  it("ignores test files and comments", () => {
    const root = fixture({
      "apps/agent-service/test/rules.test.ts": WORD_LIST,
      [FILE]: "// const ONE_OFF_MARKERS = ['这封', '这次', '今天'];\n",
      ...register(row("OTHER", "待删除", "2099-01-01")),
    });
    expect(checkWordLists({ root }).errors).toEqual([]);
  });
});
