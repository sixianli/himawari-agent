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
    for (const id of jobs)
      expect(
        workflow.jobs[id].steps.some((step) =>
          String(step.run ?? "").startsWith("sudo bash scripts/ci/prepare-hosted.sh "),
        ),
        `${file}/${id}`,
      ).toBe(true);
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
    expect(Object.keys(workflow.jobs)).toEqual(["iphone"]);
    const job = workflow.jobs.iphone;
    expect(job["runs-on"]).toBe(macRunnerLabel);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.if).toContain("github.event.pull_request.draft != true");
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
});
