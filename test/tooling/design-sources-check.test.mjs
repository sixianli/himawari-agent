import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { checkDesignSources, findWebReferences } from "../../scripts/check-design-sources.mjs";

const oldGuideSentence =
  "iPhone、Apple Watch、Mac 上的 App 另有几条自己的规则，在苹果客户端一节；那一节没写到的，照网页的规则。";

it("rejects the old guide sentence that sent App design back to the web rules", () => {
  expect(findWebReferences(oldGuideSentence, "docs/ui-ux-design-guide.md")).toEqual([
    { file: "docs/ui-ux-design-guide.md", line: 1, code: "web-rules", text: "照网页" },
  ]);
});

it("rejects references to the web code, the web baselines and the web design rules", () => {
  for (const [line, code] of [
    ["造型照 `apps/control-center/src/rounded.css`", "web-code"],
    ["先读 [网页设计基线](.agents/instructions/web-design-baselines.md)", "web-baseline"],
    ["造型沿用网页设计规范第 41 条", "web-rules"],
    ["这里的“Himawari 网页”指 Andy 日常聊天用的网页", "web-rules"],
    ["要附上在真实网页上的正向和反向两种验收结果", "web-rules"],
  ]) {
    expect(findWebReferences(line, "x.md").map((problem) => problem.code)).toContain(code);
  }
});

it("lets through web pages as content and the rule that forbids embedding the web", () => {
  for (const line of [
    "分享面板：网页、链接、文字、图片都行",
    "App 的每一页都用原生界面做，不把网页嵌进来，也不照搬网页的布局",
    "设备感知到的内容（听到的话、网页、短信）只作为工具结果追加在末尾",
  ]) {
    expect(findWebReferences(line, "x.md")).toEqual([]);
  }
});

it("scans the design guide, AGENTS.md, rules, instructions and Apple design notes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "design-sources-"));
  try {
    await mkdir(path.join(root, "docs/assets/apple-clients/v1"), { recursive: true });
    await mkdir(path.join(root, ".claude/rules"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# 项目指令\n");
    await writeFile(
      path.join(root, "docs/ui-ux-design-guide.md"),
      `# 规范\n\n${oldGuideSentence}\n`,
    );
    await writeFile(
      path.join(root, "docs/assets/apple-clients/v1/notes.md"),
      "照 control-center 的布局\n",
    );
    await writeFile(path.join(root, ".claude/rules/a.md"), "没有问题\n");
    const problems = await checkDesignSources(root);
    expect(problems.map((problem) => `${problem.file}:${problem.line}`)).toEqual([
      "docs/ui-ux-design-guide.md:3",
      "docs/assets/apple-clients/v1/notes.md:1",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("the repository's design sources do not lean on the web", async () => {
  expect(await checkDesignSources()).toEqual([]);
});
