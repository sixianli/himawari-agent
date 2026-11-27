import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { repositoryRoot } from "../../scripts/ci/contracts.mjs";

const script = path.join(repositoryRoot, "scripts/ci/apple-required.mjs");
const run = (needs) =>
  spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, APPLE_NEEDS: JSON.stringify(needs) },
  });
const needs = (client, iphone, audit) => ({
  changes: { result: "success", outputs: { client: String(client) } },
  iphone: { result: iphone, outputs: {} },
  "iphone-accessibility": { result: audit, outputs: {} },
});

describe("apple/required：iPhone 编译和三片无障碍审计汇成一项检查", () => {
  it("改了 iPhone 客户端，编译和审计都成功才通过", () => {
    const result = run(needs(true, "success", "success"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("APPLE_REQUIRED_PASSED client=true");
  });
  it.each([
    ["failure", "success"],
    ["success", "failure"],
    ["success", "cancelled"],
    ["success", "skipped"],
  ])("改了 iPhone 客户端时，编译 %s、审计 %s 都判失败", (iphone, audit) => {
    const result = run(needs(true, iphone, audit));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("APPLE_REQUIRED_FAILED");
  });
  it("没改 iPhone 客户端时，Mac 作业跳过也通过", () => {
    const result = run(needs(false, "skipped", "skipped"));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("APPLE_REQUIRED_PASSED client=false");
  });
  it("判断改动范围的作业没成功（草稿或失败）就判失败", () => {
    const result = run({
      changes: { result: "skipped", outputs: {} },
      iphone: { result: "skipped", outputs: {} },
      "iphone-accessibility": { result: "skipped", outputs: {} },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("APPLE_REQUIRED_FAILED changes=skipped");
  });
  it("工作流里的 apple/required 在标准机器上、等所有作业跑完、用这个脚本判定", () => {
    const workflow = parse(
      readFileSync(path.join(repositoryRoot, ".github/workflows/apple.yml"), "utf8"),
    );
    const job = workflow.jobs.required;
    expect(job.name).toBe("apple/required");
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job.if).toContain("always()");
    expect(job.needs).toEqual(["changes", "iphone", "iphone-accessibility"]);
    const step = job.steps.find((s) =>
      String(s.run ?? "").includes("scripts/ci/apple-required.mjs"),
    );
    expect(step.env.APPLE_NEEDS).toContain("toJSON(needs)");
  });
});
