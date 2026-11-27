import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { repositoryRoot } from "../../scripts/ci/contracts.mjs";

const workflow = parse(readFileSync(path.join(repositoryRoot, ".github/workflows/ci.yml"), "utf8"));
const checkPolicy = (...args) =>
  spawnSync(process.execPath, ["scripts/ci/check-policy.mjs", "--base", "HEAD", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });

describe("policy 只做开跑前必须先过的工作流检查", () => {
  it("别的检查作业仍然先等 policy：改成收费机器标签的 PR 在它们开跑前就被拦下", () => {
    for (const id of ["static", "build", "tests", "tooling", "security"])
      expect([workflow.jobs[id].needs].flat()).toContain("policy");
  });

  it("policy 作业只装检查工作流要用的最小依赖，不装全部依赖", () => {
    const runs = workflow.jobs.policy.steps.map((step) => String(step.run ?? ""));
    expect(runs.some((run) => run.includes("scripts/ci/install-gate-dependencies.mjs"))).toBe(true);
    expect(runs.some((run) => run.includes("scripts/ci/install-dependencies.mjs"))).toBe(false);
  });

  it("policy 只核对工作流，测试清单的核对挪到 tooling，两边都进 ci/required", () => {
    const run = readFileSync(path.join(repositoryRoot, "scripts/ci/run.mjs"), "utf8");
    const policy = run.slice(
      run.indexOf('checkId === "policy"'),
      run.indexOf('checkId === "tooling"'),
    );
    const tooling = run.slice(
      run.indexOf('checkId === "tooling"'),
      run.indexOf('checkId === "static"'),
    );
    expect(policy).toContain('"--part",\n        "workflows"');
    expect(policy).not.toContain('"tests"');
    expect(tooling).toContain('"--part",\n        "tests"');
    expect(tooling.indexOf('"--part"')).toBeLessThan(tooling.indexOf("await vitest("));
  });

  it("两部分各自只做自己那一半，合起来等于不带参数时的全部检查", () => {
    const workflows = checkPolicy("--part", "workflows");
    expect(workflows.status, workflows.stderr).toBe(0);
    const first = JSON.parse(workflows.stdout);
    expect(first.parts).toEqual(["workflows"]);
    expect(first.files).toBeUndefined();
    const tests = checkPolicy("--part", "tests");
    expect(tests.status, tests.stderr).toBe(0);
    const second = JSON.parse(tests.stdout);
    expect(second.parts).toEqual(["tests"]);
    expect(second.files).toBeGreaterThan(0);
    const unknown = checkPolicy("--part", "runners");
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("CI_POLICY_PART_UNKNOWN");
  }, 60_000);
});
