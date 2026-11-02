import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkGlossary, findOldTerms, readGlossary } from "../../scripts/check-glossary.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const glossary = `# 词表

| 编号 | 新名 | 旧叫法 | 含义 | 检查范围 |
| --- | --- | --- | --- | --- |
| 1 | \`系统主动提醒\` \`主动提醒总次数\` | \`主动提醒\` | 含义 | 全部 |
| 2 | \`Should have\` | \`Should have told me\` | 含义 | 全部 |
| 3 | \`草稿未发布\` | \`候选未发布\` | 含义 | 仅界面 |
`;

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), "glossary-"));
  roots.push(root);
  const all = { "docs/glossary.md": glossary, ...files };
  for (const [relative, text] of Object.entries(all)) {
    mkdirSync(join(root, dirname(relative)), { recursive: true });
    writeFileSync(join(root, relative), text);
  }
  return root;
}

const INTERFACE = "apps/control-center/src/i18n/resources/zh-CN.ts";

describe("glossary check", () => {
  it("reads the old and new names from the glossary table", () => {
    const { entries, errors } = readGlossary(glossary);
    expect(errors).toEqual([]);
    expect(entries.map((entry) => [entry.id, entry.newNames, entry.oldNames])).toEqual([
      ["1", ["系统主动提醒", "主动提醒总次数"], ["主动提醒"]],
      ["2", ["Should have"], ["Should have told me"]],
      ["3", ["草稿未发布"], ["候选未发布"]],
    ]);
  });

  it("[reverse case] fails when a document or the interface uses an old name", () => {
    const root = fixture({
      "docs/design.md": "第一行\n打开主动提醒页\n",
      [INTERFACE]: '"chat.reason": "候选未发布"\n',
    });
    expect(checkGlossary({ root }).errors).toEqual([
      "GLOSSARY_OLD_TERM apps/control-center/src/i18n/resources/zh-CN.ts:1 旧叫法“候选未发布”应改为“草稿未发布”（词表第 3 条）",
      "GLOSSARY_OLD_TERM docs/design.md:2 旧叫法“主动提醒”应改为“系统主动提醒”（词表第 1 条）",
    ]);
  });

  it("passes when only the new names are used, even when a new name contains an old one", () => {
    const root = fixture({
      "docs/design.md": "系统主动提醒和主动提醒总次数\n",
      [INTERFACE]: '"chat.reason": "草稿未发布"\n',
    });
    expect(checkGlossary({ root })).toMatchObject({ errors: [] });
  });

  it("still reports an old name that merely starts with a new name", () => {
    const { entries } = readGlossary(glossary);
    expect(findOldTerms("Should have told me", entries)).toHaveLength(1);
    expect(findOldTerms("Should have", entries)).toHaveLength(0);
  });

  it("only checks interface-only terms in the interface files", () => {
    const root = fixture({ "docs/spec.md": "候选未发布是工程上的候选改动\n" });
    expect(checkGlossary({ root })).toMatchObject({ errors: [] });
  });

  it("leaves accepted decision records, archives, frozen prototypes and the glossary itself alone", () => {
    const root = fixture({
      "docs/adr/0001-x.md": "主动提醒\n",
      "docs/archive/old.md": "主动提醒\n",
      "docs/assets/v1/readme.md": "主动提醒\n",
      "docs/runbooks/x.md": "主动提醒\n",
      "docs/execution/plans/x.md": "主动提醒\n",
      "docs/product-vision.md": "主动提醒\n",
    });
    expect(checkGlossary({ root })).toMatchObject({ errors: [] });
  });

  it("refuses a missing glossary and an empty table", () => {
    const missing = mkdtempSync(join(tmpdir(), "glossary-"));
    roots.push(missing);
    expect(checkGlossary({ root: missing }).errors).toEqual(["GLOSSARY_MISSING docs/glossary.md"]);
    const empty = fixture({ "docs/glossary.md": "# 词表\n" });
    expect(checkGlossary({ root: empty }).errors).toEqual(["GLOSSARY_TABLE_EMPTY"]);
  });
});
