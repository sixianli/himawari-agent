import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMMENT_MARKER,
  driftAgainstChanges,
  driftInPullRequest,
  driftSinceVerified,
  renderMarkdown,
} from "../../scripts/docs-drift.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function commit(root, files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "change");
  return git(root, "rev-parse", "HEAD");
}

function doc(covers, verifiedAt = "") {
  return `---\nstatus: active\ncovers: "${covers}"\nverified_at: "${verifiedAt}"\n---\n\n# x\n`;
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "docs-drift-"));
  roots.push(root);
  git(root, "init", "-q", "-b", "main");
  const base = commit(root, {
    "packages/a/src/a.ts": "1",
    "packages/b/src/b.ts": "1",
    "docs/adr/0001-a.md": doc("packages/a/src/a.ts"),
    "docs/adr/0002-b.md": doc("packages/b"),
  });
  return { root, base };
}

describe("改了文档覆盖的代码却没改文档时提醒", () => {
  it("只列出代码被改、自己没被改的文档", () => {
    const { root, base } = repository();
    commit(root, {
      "packages/a/src/a.ts": "2",
      "packages/b/src/b.ts": "2",
      "docs/adr/0002-b.md": `${doc("packages/b")}改了\n`,
    });
    expect(driftInPullRequest(root, base)).toEqual([
      { file: "docs/adr/0001-a.md", code: ["packages/a/src/a.ts"] },
    ]);
  });

  it("没改到覆盖的代码时没有提醒，输出为空", () => {
    const { root, base } = repository();
    commit(root, { "README.md": "x" });
    const drift = driftInPullRequest(root, base);
    expect(drift).toEqual([]);
    expect(renderMarkdown(drift, "h")).toBe("");
  });

  it("目录写在 covers 里时，目录下的文件都算；名字只是前缀相同的不算", () => {
    expect(
      driftAgainstChanges(
        [{ file: "docs/x.md", covers: ["packages/b"], verifiedAt: "" }],
        ["packages/b/src/b.ts", "packages/bb/c.ts"],
      ),
    ).toEqual([{ file: "docs/x.md", code: ["packages/b/src/b.ts"] }]);
    expect(
      driftAgainstChanges(
        [{ file: "docs/y.md", covers: ["packages/*/src/**"], verifiedAt: "" }],
        ["packages/b/src/deep/b.ts", "packages/b/test/b.ts"],
      ),
    ).toEqual([{ file: "docs/y.md", code: ["packages/b/src/deep/b.ts"] }]);
  });

  it("大功能收尾时列出 verified_at 之后覆盖的代码改过的文档", () => {
    const { root } = repository();
    const verified = git(root, "rev-parse", "HEAD");
    commit(root, {
      "docs/adr/0001-a.md": doc("packages/a/src/a.ts", verified),
      "docs/adr/0002-b.md": doc("packages/b", verified),
    });
    commit(root, { "packages/b/src/b.ts": "3" });
    expect(driftSinceVerified(root)).toEqual([
      { file: "docs/adr/0002-b.md", code: ["packages/b/src/b.ts"] },
    ]);
  });

  it("评论带固定标记，超过五个文件时只列前五个并写总数", () => {
    const text = renderMarkdown(
      [{ file: "docs/x.md", code: ["a", "b", "c", "d", "e", "f"] }],
      "标题",
    );
    expect(text.startsWith(COMMENT_MARKER)).toBe(true);
    expect(text).toContain("`docs/x.md`：`a`、`b`、`c`、`d`、`e` 等 6 个文件");
  });
});
