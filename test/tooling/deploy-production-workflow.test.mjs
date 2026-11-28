import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { repositoryRoot } from "../../scripts/ci/contracts.mjs";

const workflow = parse(
  readFileSync(path.join(repositoryRoot, ".github/workflows/deploy-production.yml"), "utf8"),
);
const target = workflow.jobs.deploy.steps.find((step) => step.id === "target");
const directories = [];

function git(repo, ...args) {
  const child = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  expect(child.status, child.stderr).toBe(0);
  return child.stdout.trim();
}

function commit(repo, name) {
  writeFileSync(path.join(repo, name), name);
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", name);
  return git(repo, "rev-parse", "HEAD");
}

function repository() {
  const repo = mkdtempSync(path.join(os.tmpdir(), "deploy-target-"));
  directories.push(repo);
  git(repo, "init", "-q");
  return repo;
}

function choose(repo, environment) {
  const output = path.join(repo, ".output");
  const summary = path.join(repo, ".summary");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const child = spawnSync("bash", ["-e", "-o", "pipefail", "-c", target.run], {
    cwd: repo,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      INPUT_COMMIT: "",
      ...environment,
    },
  });
  expect(child.status, child.stderr).toBe(0);
  return Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=")),
  );
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("自动上线选哪个提交", () => {
  it("[I-120] main 在确认跑完前又有新合并时，仍上线刚确认通过的那个提交", () => {
    const repo = repository();
    const confirmed = commit(repo, "confirmed");
    commit(repo, "merged-later");
    const chosen = choose(repo, { EVENT_NAME: "workflow_run", RUN_SHA: confirmed });
    expect(chosen).toEqual({ skip: "false", commit: confirmed });
  });

  it("确认的提交就是 main 最新时照常上线", () => {
    const repo = repository();
    commit(repo, "first");
    const tip = commit(repo, "tip");
    expect(choose(repo, { EVENT_NAME: "workflow_run", RUN_SHA: tip })).toEqual({
      skip: "false",
      commit: tip,
    });
  });

  it("不在 main 上的提交不上线", () => {
    const repo = repository();
    const base = commit(repo, "base");
    git(repo, "checkout", "-q", "-b", "side");
    const side = commit(repo, "side");
    git(repo, "checkout", "-q", "-");
    git(repo, "reset", "-q", "--hard", base);
    commit(repo, "main-only");
    expect(choose(repo, { EVENT_NAME: "workflow_run", RUN_SHA: side })).toEqual({ skip: "true" });
  });

  it("手动触发不填提交时上线 main 最新", () => {
    const repo = repository();
    commit(repo, "first");
    const tip = commit(repo, "tip");
    expect(choose(repo, { EVENT_NAME: "workflow_dispatch", RUN_SHA: "" })).toEqual({
      skip: "false",
      commit: tip,
    });
  });

  it("同一时间只排一个待上线的运行，新的替换旧的，正在跑的不取消", () => {
    expect(workflow.concurrency).toEqual({
      group: "deploy-production",
      "cancel-in-progress": false,
    });
  });
});
