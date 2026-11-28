import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodeIndex,
  checkDocsCodeRefs,
  classifyReference,
  mainlineRef,
} from "../../scripts/check-docs-code-refs.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function write(root, files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
}

function repository(codeFiles, docs) {
  const root = mkdtempSync(join(tmpdir(), "docs-code-refs-"));
  roots.push(root);
  write(root, codeFiles);
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
  const head = git(root, "rev-parse", "HEAD");
  write(root, docs(head));
  return root;
}

function adr(verifiedAt, body, covers = "") {
  return `---\nstatus: active\ndate: "2026-11-25"\ncovers: "${covers}"\nverified_at: "${verifiedAt}"\n---\n\n${body}\n`;
}

const code = {
  "package.json": JSON.stringify({ scripts: { "check:real": "true" } }),
  "packages/memory/src/store.ts":
    'export function saveMemory() {}\nconst REASON = "mcp_proposal_";\nexport const SAVE_LIMIT = 3;\n',
  ".gitignore": "local/\n",
};

describe("文档里写的路径、命令、名字要在代码里找得到", () => {
  it("全部找得到时通过", () => {
    const root = repository(code, (head) => ({
      "docs/adr/0001-a.md": adr(
        head,
        "见 `packages/memory/src/store.ts`、`store.ts`、`saveMemory()`、`SAVE_LIMIT`、`npm run check:real`、`local/cache`。",
        "packages/memory/src/store.ts",
      ),
    }));
    expect(checkDocsCodeRefs({ root }).errors).toEqual([]);
  });

  it("代码里删掉的路径、函数、命令、常量都报出来", () => {
    const root = repository(code, (head) => ({
      "docs/adr/0001-a.md": adr(
        head,
        "见 `packages/memory/src/gone.ts`、`gone.ts`、`loadMemory()`、`GONE_LIMIT`、`npm run check:gone`。",
      ),
    }));
    expect(checkDocsCodeRefs({ root }).errors).toEqual([
      "DOCS_CODE_REF_MISSING docs/adr/0001-a.md -> path packages/memory/src/gone.ts",
      "DOCS_CODE_REF_MISSING docs/adr/0001-a.md -> file gone.ts",
      "DOCS_CODE_REF_MISSING docs/adr/0001-a.md -> name loadMemory",
      "DOCS_CODE_REF_MISSING docs/adr/0001-a.md -> name GONE_LIMIT",
      "DOCS_CODE_REF_MISSING docs/adr/0001-a.md -> script check:gone",
    ]);
  });

  it("带固定提交链接的历史名字、代码块和普通文字不查；代码用前缀拼出来的名字算找得到", () => {
    const root = repository(code, (head) => ({
      "docs/adr/0001-a.md": adr(
        head,
        "[`loadMemory()`](https://github.com/o/r/blob/abc/x.ts) 已删。\n\n```\nGONE_LIMIT\n```\n\n普通文字 loadMemory。`mcp_proposal_kept`。",
      ),
    }));
    expect(checkDocsCodeRefs({ root }).errors).toEqual([]);
  });

  it("规格、计划、想法、待办不查名字；历史类文档也查；ADR 和操作手册必须写两个字段", () => {
    const root = repository(code, () => ({
      "docs/backlog/BL-1.md": '---\nstatus: active\ndate: "2026-11-25"\n---\n\n`loadMemory()`\n',
      "docs/execution/specs/s.md":
        '---\nstatus: active\ndate: "2026-11-25"\n---\n\n`loadMemory()`\n',
      "docs/lessons.md": adr("", "`oldName()`"),
      "docs/adr/0001-a.md": '---\nstatus: active\ndate: "2026-11-25"\n---\n\n`loadMemory()`\n',
      "docs/runbooks/r.md": adr("", "x"),
    }));
    expect(checkDocsCodeRefs({ root }).errors).toEqual([
      "DOCS_COVERS_FIELD_MISSING docs/adr/0001-a.md",
      "DOCS_VERIFIED_AT_EMPTY docs/adr/0001-a.md",
      "DOCS_CODE_REF_MISSING docs/adr/0001-a.md -> name loadMemory",
      "DOCS_CODE_REF_MISSING docs/lessons.md -> name oldName",
      "DOCS_VERIFIED_AT_EMPTY docs/runbooks/r.md",
    ]);
  });

  it("豁免文件里的名字、排除目录里的文档、正在实现的文档不报；covers 可以写通配", () => {
    const root = repository(code, (head) => ({
      "docs/.governance-references-ignore": "# 上游\ndocs/sdk.md\nupstream*\n",
      "docs/.governance-exclude": "docs/assets\n",
      "docs/assets/x.md": adr(head, "`goneName()`"),
      "docs/adr/0001-a.md": adr(head, "`docs/sdk.md` 和 `upstreamThing()`", "packages/**/*.ts"),
      "docs/adr/0002-b.md": `${adr(head, "`notYetBuilt()`", "packages/new/x.ts").replace("---\n\n", "implementation: in_progress\n---\n\n")}`,
      "docs/adr/0003-c.md": adr(head, "x", "packages/**/*.py"),
    }));
    expect(checkDocsCodeRefs({ root }).errors).toEqual([
      "DOCS_COVERS_MISSING docs/adr/0003-c.md -> packages/**/*.py",
    ]);
  });

  it("covers 写的文件不存在、verified_at 不是提交号或仓库里没有这个提交时报错", () => {
    const root = repository(code, () => ({
      "docs/adr/0001-a.md": adr("abc", "x", "packages/memory/src/gone.ts"),
      "docs/adr/0002-b.md": adr("1".repeat(40), "x"),
    }));
    expect(checkDocsCodeRefs({ root }).errors).toEqual([
      "DOCS_VERIFIED_AT_INVALID docs/adr/0001-a.md -> abc",
      "DOCS_COVERS_MISSING docs/adr/0001-a.md -> packages/memory/src/gone.ts",
      `DOCS_VERIFIED_AT_UNKNOWN docs/adr/0002-b.md -> ${"1".repeat(40)}`,
    ]);
  });

  it("文档里的名字能在已声明的依赖里找到也算", () => {
    const root = repository(
      { ...code, "package.json": JSON.stringify({ dependencies: { "dep-lib": "1.0.0" } }) },
      (head) => ({ "docs/adr/0001-a.md": adr(head, "`createDepThing()`") }),
    );
    mkdirSync(join(root, "node_modules/dep-lib"), { recursive: true });
    writeFileSync(
      join(root, "node_modules/dep-lib/index.d.ts"),
      "export declare function createDepThing(): void;\n",
    );
    expect(checkDocsCodeRefs({ root, index: buildCodeIndex(root) }).errors).toEqual([]);
  });
});

function commitAll(root, message) {
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function squashMergedRepository() {
  const root = repository(code, () => ({}));
  const base = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-q", "-b", "feature");
  write(root, { "packages/memory/src/extra.ts": "export const EXTRA = 1;\n" });
  const branchCommit = commitAll(root, "feature work");
  git(root, "checkout", "-q", "--detach", base);
  git(root, "merge", "-q", "--squash", "feature");
  const squashCommit = commitAll(root, "feature work (#751)");
  git(root, "update-ref", "refs/remotes/origin/main", squashCommit);
  return { root, branchCommit, squashCommit };
}

describe("verified_at 要写 main 上的提交（I-261128-mxs1）", () => {
  it("写的是压缩合并前分支上的提交时报错：合并后 main 上没有这个提交", () => {
    const { root, branchCommit } = squashMergedRepository();
    write(root, { "docs/adr/0311-x.md": adr(branchCommit, "x", "packages/memory/src/extra.ts") });
    expect(checkDocsCodeRefs({ root, mainline: "origin/main" }).errors).toEqual([
      `DOCS_VERIFIED_AT_OFF_MAINLINE docs/adr/0311-x.md -> ${branchCommit} not on origin/main`,
    ]);
  });

  it("写的是 main 上的提交时通过", () => {
    const { root, squashCommit } = squashMergedRepository();
    write(root, { "docs/adr/0311-x.md": adr(squashCommit, "x", "packages/memory/src/extra.ts") });
    expect(checkDocsCodeRefs({ root, mainline: "origin/main" }).errors).toEqual([]);
  });

  it("PR 上对照 PR 的目标分支，其他时候对照 origin/main；没有这个引用时不查", () => {
    const { root } = squashMergedRepository();
    expect(mainlineRef(root, {})).toBe("origin/main");
    expect(mainlineRef(root, { GITHUB_BASE_REF: "release" })).toBe("");
    git(root, "update-ref", "refs/remotes/origin/release", "HEAD");
    expect(mainlineRef(root, { GITHUB_BASE_REF: "release" })).toBe("origin/release");
  });
});

describe("哪些反引号内容算代码引用", () => {
  it.each([
    ["npm run check:docs", { kind: "script", value: "check:docs" }],
    ["node scripts/a.mjs --x", { kind: "path", value: "scripts/a.mjs" }],
    ["packages/a/src/b.ts:12", { kind: "path", value: "packages/a/src/b.ts" }],
    ["b.ts", { kind: "file", value: "b.ts" }],
    ["runPolicy.inbox", { kind: "name", value: "runPolicy.inbox" }],
    ["HISTORY_ROW_CHANGED", { kind: "name", value: "HISTORY_ROW_CHANGED" }],
    ["fast", null],
    ["git push origin main", null],
    ["<path>", null],
    ["example.com", null],
  ])("%s", (text, expected) => {
    expect(classifyReference(text)).toEqual(expected);
  });
});
