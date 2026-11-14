import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  changedFiles,
  classifyChanges,
  listRelatedFiles,
  planTestScope,
  relatedEligibleProjects,
} from "../../scripts/ci/test-scope.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const context = (event = "pull_request") => ({
  event,
  baseSha: "b".repeat(40),
  testedSha: "t".repeat(40),
});

describe("PR 上测试范围的选择 [ADR-0268]", () => {
  it("只改源码和文档时可以只跑相关测试", () => {
    expect(
      classifyChanges([
        "packages/application/src/ports/memory-episodes.ts",
        "apps/agent-service/src/cache-hit-monitor.ts",
        "test/integration/example.test.ts",
        "docs/adr/0268-x.md",
        ".agents/reviews/pr-1/usage.jsonl",
      ]),
    ).toEqual({ full: false, fullFiles: [] });
  });

  it.each([
    "package.json",
    "package-lock.json",
    "vitest.workspace.ts",
    "packages/web/vite.config.ts",
    "scripts/operations/cache-hit-report.mjs",
    "packages/persistence-sqlite/migrations/0099.sql",
    "packages/prompt-catalog/prompts/system.txt",
    "test/fixtures/example.json",
    "ci/policy.json",
    ".github/workflows/ci.yml",
  ])("改了 %s 时跑全量", (file) => {
    expect(classifyChanges(["packages/x/src/a.ts", file])).toEqual({
      full: true,
      fullFiles: [file],
    });
  });

  it("不是 PR 的运行一律全量，不看改动", () => {
    let diffed = false;
    const plan = planTestScope({
      root: "/r",
      context: context("workflow_dispatch"),
      projects: ["integration"],
      diff: () => {
        diffed = true;
        return [];
      },
    });
    expect(plan.related.size).toBe(0);
    expect(diffed).toBe(false);
  });

  it("PR 改了源码时只给 integration、e2e、pi-compat、tooling 选相关测试，unit 和 contracts 照跑全量", () => {
    const asked = [];
    const plan = planTestScope({
      root: "/r",
      context: context(),
      projects: ["unit", "contracts", "integration", "e2e", "pi-compat", "tooling"],
      diff: (_root, base, tested) => {
        expect([base, tested]).toEqual(["b".repeat(40), "t".repeat(40)]);
        return ["packages/a/src/x.ts"];
      },
      list: ({ project, baseSha }) => {
        asked.push([project, baseSha]);
        return project === "integration" ? ["test/integration/x.test.ts"] : [];
      },
    });
    expect(asked.map(([id]) => id)).toEqual(relatedEligibleProjects);
    expect(asked.every(([, base]) => base === "b".repeat(40))).toBe(true);
    expect([...plan.related]).toEqual([
      ["integration", ["test/integration/x.test.ts"]],
      ["e2e", []],
      ["pi-compat", []],
      ["tooling", []],
    ]);
  });

  it("找相关测试失败的项目退回全量", () => {
    const plan = planTestScope({
      root: "/r",
      context: context(),
      projects: ["integration", "tooling"],
      diff: () => ["packages/a/src/x.ts"],
      list: ({ project }) => (project === "tooling" ? null : []),
    });
    expect([...plan.related.keys()]).toEqual(["integration"]);
    expect(plan.reason).toBe("related full-fallback tooling");
  });

  it("PR 改了非源码文件时全部项目全量", () => {
    const plan = planTestScope({
      root: "/r",
      context: context(),
      projects: ["integration"],
      diff: () => ["package.json"],
      list: () => {
        throw new Error("不该调用");
      },
    });
    expect(plan.related.size).toBe(0);
    expect(plan.reason).toBe("full-files package.json");
  });

  it("用 vitest list --changed 以 PR 基线找相关测试，输出改成仓库相对路径并去重排序；vitest 失败时返回 null", () => {
    const root = mkdtempSync(path.join(tmpdir(), "scope-"));
    directories.push(root);
    const calls = [];
    const run = (_node, args) => {
      calls.push(args);
      const output = args.find((arg) => arg.startsWith("--json=")).slice(7);
      writeFileSync(
        output,
        JSON.stringify([
          { file: path.join(root, "test/integration/b.test.ts") },
          { file: path.join(root, "test/integration/a.test.ts") },
          { file: path.join(root, "test/integration/b.test.ts") },
        ]),
      );
      return { status: 0 };
    };
    expect(
      listRelatedFiles({ root, project: "integration", baseSha: "b".repeat(40), run }),
    ).toEqual(["test/integration/a.test.ts", "test/integration/b.test.ts"]);
    expect(calls[0].slice(1)).toEqual([
      "list",
      "--config",
      "vitest.workspace.ts",
      "--project",
      "integration",
      "--filesOnly",
      calls[0][7],
      "--changed",
      "b".repeat(40),
    ]);
    expect(
      listRelatedFiles({
        root,
        project: "integration",
        baseSha: "b".repeat(40),
        run: () => ({ status: 1 }),
      }),
    ).toBeNull();
  });

  it("改名的文件新旧两个路径都算改动，把非源码文件改名成源码路径仍然全量", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ci-scope-git-"));
    directories.push(root);
    const git = (...args) =>
      execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@example.com",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@example.com",
        },
      }).trim();
    git("init", "--quiet");
    git("config", "diff.renames", "true");
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts/build.mjs"), "export const x = 1;\n".repeat(20));
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");
    const base = git("rev-parse", "HEAD");
    mkdirSync(path.join(root, "packages/a/src"), { recursive: true });
    git("mv", "scripts/build.mjs", "packages/a/src/build.mjs");
    git("commit", "--quiet", "-m", "move");
    const files = changedFiles(root, base, git("rev-parse", "HEAD"));
    expect(files.sort()).toEqual(["packages/a/src/build.mjs", "scripts/build.mjs"]);
    expect(classifyChanges(files).full).toBe(true);
  });
});
