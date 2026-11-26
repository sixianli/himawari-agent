import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { changedFiles, touchesAppleClient } from "../../scripts/ci/apple-scope.mjs";
import { repositoryRoot } from "../../scripts/ci/contracts.mjs";

describe("Apple 工作流按改动决定要不要占 Mac 机器", () => {
  it("改了 iPhone 客户端、Apple 工作流或这个判断脚本时要跑", () => {
    expect(touchesAppleClient(["src/a.ts", "clients/apple/Sources/X.swift"])).toBe(true);
    expect(touchesAppleClient([".github/workflows/apple.yml"])).toBe(true);
    expect(touchesAppleClient(["scripts/ci/apple-scope.mjs"])).toBe(true);
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
    commit("server.ts");
    expect(run().stdout).toBe("client=false\n");
    commit("clients/apple/Sources/App.swift");
    const result = run();
    expect(result.stdout).toBe("client=true\n");
    expect(result.stderr).toContain("APPLE_SCOPE client=true files=2");
  });
});
