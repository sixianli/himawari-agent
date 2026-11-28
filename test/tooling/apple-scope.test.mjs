import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditCheckPrefixes,
  changedFiles,
  mainCheckPrefixes,
  sinceAuditBase,
  sinceGreenBase,
  touchesAppleClient,
} from "../../scripts/ci/apple-scope.mjs";
import { repositoryRoot } from "../../scripts/ci/contracts.mjs";

describe("Apple 工作流按改动决定要不要占 Mac 机器", () => {
  it("改了 iPhone 客户端、Apple 工作流或这个判断脚本时要跑", () => {
    expect(touchesAppleClient(["src/a.ts", "clients/apple/Sources/X.swift"])).toBe(true);
    expect(touchesAppleClient([".github/workflows/apple.yml"])).toBe(true);
    expect(touchesAppleClient(["scripts/ci/apple-scope.mjs"])).toBe(true);
    expect(touchesAppleClient(["scripts/ci/main-green.mjs"])).toBe(true);
  });
  it("main 上从 Apple 检查上次全部通过的提交算起；查不到或查询出错时返回空，照跑", async () => {
    const seen = [];
    const find = async (input) => {
      seen.push(input);
      return "a".repeat(40);
    };
    expect(await sinceGreenBase({ repo: "o/r", runId: "9", find })).toBe("a".repeat(40));
    expect(seen[0]).toMatchObject({ repo: "o/r", workflow: "apple.yml", runId: "9" });
    expect(seen[0].prefixes).toEqual(mainCheckPrefixes);
    expect(await sinceGreenBase({ repo: "o/r", runId: "9", find: async () => null })).toBeNull();
    expect(
      await sinceGreenBase({
        repo: "o/r",
        runId: "9",
        find: async () => {
          throw new Error("HTTP 502");
        },
      }),
    ).toBeNull();
    expect(touchesAppleClient(changedFiles(null, "HEAD"))).toBe(true);
  });
  it("凌晨审计从上次审计过的定时运行算起；查询出错时返回空，照跑", async () => {
    const seen = [];
    const find = async (input) => {
      seen.push(input);
      return "b".repeat(40);
    };
    expect(await sinceAuditBase({ repo: "o/r", runId: "9", find })).toBe("b".repeat(40));
    expect(seen[0]).toMatchObject({
      repo: "o/r",
      workflow: "apple.yml",
      job: auditCheckPrefixes[0],
      event: "schedule",
      runId: "9",
    });
    expect(
      await sinceAuditBase({
        repo: "o/r",
        runId: "9",
        find: async () => {
          throw new Error("HTTP 502");
        },
      }),
    ).toBeNull();
  });
  it("只改服务端、网页、文档或别的工作流时不跑", () => {
    expect(touchesAppleClient(["src/server.ts", "docs/a.md", ".github/workflows/ci.yml"])).toBe(
      false,
    );
    expect(touchesAppleClient(["clients/applesauce/x", "web/clients/apple/x"])).toBe(false);
  });
  it("说不清改了什么时宁可跑", () => {
    expect(touchesAppleClient(null)).toBe(true);
    expect(changedFiles("", "HEAD")).toBeNull();
    expect(changedFiles("0000000000000000000000000000000000000000", "HEAD")).toBeNull();
    expect(
      changedFiles("abc", "HEAD", () => {
        throw new Error("fetch failed");
      }),
    ).toBeNull();
  });
  it("在真实 git 仓库里从命令行读出两次提交之间的改动", () => {
    const remote = mkdtempSync(path.join(tmpdir(), "apple-scope-"));
    const git = (...args) =>
      execFileSync("git", ["-C", remote, ...args], { encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "t");
    writeFileSync(path.join(remote, "server.ts"), "1");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const clone = mkdtempSync(path.join(tmpdir(), "apple-scope-clone-"));
    execFileSync("git", ["clone", "-q", remote, clone]);
    const run = () =>
      spawnSync("node", [path.join(repositoryRoot, "scripts/ci/apple-scope.mjs"), base, "HEAD"], {
        cwd: clone,
        encoding: "utf8",
      });
    const commit = (file) => {
      mkdirSync(path.dirname(path.join(clone, file)), { recursive: true });
      writeFileSync(path.join(clone, file), "2");
      execFileSync("git", ["-C", clone, "add", "."]);
      execFileSync("git", [
        "-C",
        clone,
        "-c",
        "user.email=t@example.invalid",
        "-c",
        "user.name=t",
        "commit",
        "-qm",
        file,
      ]);
    };
    const head = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const unchanged = spawnSync(
      "node",
      [path.join(repositoryRoot, "scripts/ci/apple-scope.mjs"), head, "HEAD"],
      { cwd: clone, encoding: "utf8" },
    );
    expect(unchanged.stdout).toBe(`client=false\nbase=${head}\n`);
    commit("server.ts");
    expect(run().stdout).toBe(`client=false\nbase=${base}\n`);
    commit("clients/apple/Sources/App.swift");
    const result = run();
    expect(result.stdout).toBe(`client=true\nbase=${base}\n`);
    expect(result.stderr).toContain(`APPLE_SCOPE client=true base=${base} files=2`);
  });
});
