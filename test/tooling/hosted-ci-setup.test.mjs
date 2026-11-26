import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validateHostedRunners } from "../../scripts/ci/check-policy.mjs";
import { macRunnerLabel, repositoryRoot } from "../../scripts/ci/contracts.mjs";

const script = path.join(repositoryRoot, "scripts/ci/prepare-hosted.sh");
const run = (args, env = {}) =>
  spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });

describe("托管机器的准备脚本", () => {
  it("不给 node 路径时以 64 退出，什么都不装", () => {
    const result = run([]);
    expect(result.status).toBe(64);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage: prepare-hosted.sh <node>");
  });
  it.each([
    ["ci.yml", ["static", "browser", "tests", "tooling"]],
    ["main.yml", ["confirm"]],
  ])("%s 里要沙箱或浏览器的作业都先跑准备脚本", (file, jobs) => {
    const workflow = parse(
      readFileSync(path.join(repositoryRoot, ".github/workflows", file), "utf8"),
    );
    for (const id of jobs) {
      const runs = workflow.jobs[id].steps.map((step) => String(step.run ?? ""));
      const prepare = runs.findIndex((run) =>
        run.startsWith("sudo bash scripts/ci/prepare-hosted.sh "),
      );
      const firstUse = runs.findIndex(
        (run) =>
          run.includes("scripts/ci/run.mjs") ||
          run.includes("scripts/ci/main-confirm.mjs") ||
          run.includes("playwright/cli.js install"),
      );
      expect(prepare, `${file}/${id}`).toBeGreaterThanOrEqual(0);
      expect(firstUse, `${file}/${id}`).toBeGreaterThan(prepare);
    }
  });
  it("node 不可执行时以 64 退出并说明原因", () => {
    const result = run(["/nonexistent/node"]);
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("CI_HOSTED_PREPARE_NODE_MISSING /nonexistent/node");
  });
  it("装沙箱测试要的包、只放宽 bwrap 的 AppArmor 限制，并装三种浏览器的系统依赖", () => {
    const text = readFileSync(script, "utf8");
    expect(text).toMatch(/apt-get install .*\bbubblewrap socat ripgrep apparmor-utils\b/u);
    expect(text).toContain("profile bwrap /usr/bin/bwrap flags=(unconfined) {");
    expect(text).toContain("install-deps chromium firefox webkit");
  });
});

describe("iPhone 工作流", () => {
  const workflow = parse(
    readFileSync(path.join(repositoryRoot, ".github/workflows/apple.yml"), "utf8"),
  );
  it("只在免费的 macOS 标准机器上跑，只读权限，跳过草稿", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["iphone", "iphone-accessibility"]);
    for (const job of Object.values(workflow.jobs)) {
      expect(job["runs-on"]).toBe(macRunnerLabel);
      expect(job.if).toContain("github.event.pull_request.draft != true");
    }
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(() =>
      validateHostedRunners({
        "apple.yml": readFileSync(path.join(repositoryRoot, ".github/workflows/apple.yml"), "utf8"),
      }),
    ).not.toThrow();
  });
  it("跑 HimawariCore 单元测试，并不签名编译 iPhone 的 Himawari scheme", () => {
    const steps = workflow.jobs.iphone.steps;
    expect(steps.find((step) => step.run === "swift test")?.["working-directory"]).toBe(
      "clients/apple",
    );
    const build = steps.find((step) => step.run?.startsWith("xcodebuild build"))?.run ?? "";
    expect(build).toContain("-scheme Himawari ");
    expect(build).toContain("generic/platform=iOS Simulator");
    expect(build).toContain("CODE_SIGNING_ALLOWED=NO");
    expect(
      readFileSync(
        path.join(
          repositoryRoot,
          "clients/apple/App/Himawari.xcodeproj/xcshareddata/xcschemes/Himawari.xcscheme",
        ),
        "utf8",
      ).length,
    ).toBeGreaterThan(0);
  });
  it("每个示例场景都跑苹果的无障碍审计，审计测试在 Himawari scheme 里", () => {
    const job = workflow.jobs["iphone-accessibility"];
    expect(job.name).toContain("apple/iphone-accessibility");
    expect(job.strategy.matrix.shard.length).toBeGreaterThan(1);
    const shard = job.steps.find((step) => step.run?.includes("xcodebuild test"));
    expect(shard.env.TEST_RUNNER_HIMAWARI_AUDIT_SHARD).toBe("${{ matrix.shard }}");
    const audit = job.steps.find((step) => step.run?.includes("xcodebuild test"))?.run ?? "";
    expect(audit).toContain("-scheme Himawari");
    expect(audit).toContain("-only-testing:HimawariUITests");
    expect(audit).toContain("set -o pipefail");
    const scheme = readFileSync(
      path.join(
        repositoryRoot,
        "clients/apple/App/Himawari.xcodeproj/xcshareddata/xcschemes/Himawari.xcscheme",
      ),
      "utf8",
    );
    expect(scheme).toContain('BlueprintName = "HimawariUITests"');
    const project = readFileSync(
      path.join(repositoryRoot, "clients/apple/App/Himawari.xcodeproj/project.pbxproj"),
      "utf8",
    );
    expect(project).toContain('productType = "com.apple.product-type.bundle.ui-testing";');
    expect(project).toContain("TEST_TARGET_NAME = Himawari;");
  });
});
