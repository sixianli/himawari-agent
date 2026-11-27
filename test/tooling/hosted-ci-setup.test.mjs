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
    ["ci.yml", ["static", "tests", "tooling"]],
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
    expect(text).toContain("install-deps chromium");
  });
});

describe("Mac 安装包发布工作流", () => {
  const text = readFileSync(path.join(repositoryRoot, ".github/workflows/mac-release.yml"), "utf8");
  const workflow = parse(text);
  const job = workflow.jobs.publish;
  it("只在 main 上、免费的标准 Mac 机器上跑，只有发布这一步能写仓库", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["publish"]);
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on.pull_request).toBeUndefined();
    expect(job["runs-on"]).toBe(macRunnerLabel);
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "write" });
    expect(() => validateHostedRunners({ "mac-release.yml": text })).not.toThrow();
  });
  it("缺任何一把密钥就只警告、不出包", () => {
    const check = job.steps.find((step) => step.id === "keys");
    for (const name of [
      "ASC_KEY_ID",
      "ASC_ISSUER_ID",
      "ASC_KEY_P8",
      "MAC_DEVELOPER_ID_P12",
      "MAC_DEVELOPER_ID_P12_PASSWORD",
      "SPARKLE_PRIVATE_KEY",
      "HIMAWARI_UPDATE_KEY",
    ]) {
      expect(check.run).toContain(name);
      expect(Object.keys(check.env)).toContain(name);
    }
    for (const step of job.steps.slice(job.steps.indexOf(check) + 1)) {
      expect(step.if).toContain("steps.keys.outputs.ready == 'true'");
    }
  });
  it("App 读的更新清单地址就是发布步骤上传 appcast.xml 的那个 release", () => {
    expect(workflow.env.HIMAWARI_UPDATE_FEED).toContain(
      "/releases/download/mac-updates/appcast.xml",
    );
    const publish = job.steps.at(-1).run;
    expect(publish).toContain("gh release upload mac-updates");
    expect(publish).toContain('gh release create "mac-$HIMAWARI_BUILD_NUMBER"');
    expect(workflow.env.HIMAWARI_DOWNLOAD_BASE).toMatch(
      /\/releases\/download\/mac-\$\{\{ github\.run_number \}\}$/u,
    );
    const plist = readFileSync(
      path.join(repositoryRoot, "clients/apple/App/macOS/Info.plist"),
      "utf8",
    );
    expect(plist).toContain("<string>$(HIMAWARI_UPDATE_FEED)</string>");
    expect(plist).toContain("<string>$(HIMAWARI_UPDATE_KEY)</string>");
  });
  it("等苹果公证至少 2 小时，整个任务比公证多留 1 小时给归档和发布", () => {
    const script = readFileSync(
      path.join(repositoryRoot, "clients/apple/scripts/mac-release.sh"),
      "utf8",
    );
    const wait = script.match(/notarytool submit[\s\S]*?--timeout (\d+)([mh])/u);
    expect(wait).not.toBeNull();
    const waitMinutes = Number(wait[1]) * (wait[2] === "h" ? 60 : 1);
    expect(waitMinutes).toBeGreaterThanOrEqual(120);
    expect(job["timeout-minutes"]).toBeGreaterThanOrEqual(waitMinutes + 60);
  });
});

describe("iPhone 工作流", () => {
  const workflow = parse(
    readFileSync(path.join(repositoryRoot, ".github/workflows/apple.yml"), "utf8"),
  );
  it("main 上每次推送各自排队，排队中的运行不会被下一次推送顶掉", () => {
    const group = workflow.concurrency.group;
    expect(group).toContain("github.event.pull_request.number");
    expect(group).toContain("github.sha");
    expect(group).not.toContain("github.ref");
    expect(workflow.concurrency["cancel-in-progress"]).toContain(
      "github.event_name == 'pull_request'",
    );
  });

  it("只在免费的标准机器上跑，只读权限，跳过草稿，没碰 iPhone 客户端时不占 Mac 机器", () => {
    expect(Object.keys(workflow.jobs)).toEqual([
      "changes",
      "iphone",
      "mac",
      "iphone-accessibility",
      "scroll",
    ]);
    const { changes, ...macJobs } = workflow.jobs;
    expect(changes["runs-on"]).toBe("ubuntu-24.04");
    expect(changes.if).toContain("github.event.pull_request.draft != true");
    expect(changes.steps.at(-1).run).toContain("scripts/ci/apple-scope.mjs");
    for (const job of Object.values(macJobs)) {
      expect(job["runs-on"]).toBe(macRunnerLabel);
      expect(job.needs).toBe("changes");
      expect(job.if).toContain("needs.changes.outputs.client == 'true'");
    }
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(() =>
      validateHostedRunners({
        "apple.yml": readFileSync(path.join(repositoryRoot, ".github/workflows/apple.yml"), "utf8"),
      }),
    ).not.toThrow();
  });
  it("滚动测速作业用开了优化的调试版跑长对话滚动脚本，并上传结果", () => {
    const steps = workflow.jobs.scroll.steps;
    const build = steps.find((step) => step.run?.startsWith("xcodebuild build"))?.run ?? "";
    expect(build).toContain("-scheme Himawari ");
    expect(build).toContain("SWIFT_OPTIMIZATION_LEVEL=-O");
    expect(build).toContain("CODE_SIGNING_ALLOWED=NO");
    const bench =
      steps.find((step) => step.run?.startsWith("bash clients/apple/scripts/scroll-bench.sh"))
        ?.run ?? "";
    expect(bench).toContain("--loads realistic,plain");
    expect(steps.some((step) => step.with?.name === "scroll-bench")).toBe(true);
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
  it("深色那一遍审计真的在深色下跑：App 按启动参数切深色，不只靠模拟器的外观设置", () => {
    const audit = readFileSync(
      path.join(repositoryRoot, "clients/apple/App/UITests/AccessibilityAuditTests.swift"),
      "utf8",
    );
    expect(audit).toContain('"-HimawariDemoAppearance", appearance');
    expect(audit).toContain("launch(scene, appearance: mode.name)");
    const scenes = readFileSync(
      path.join(repositoryRoot, "clients/apple/Sources/HimawariShell/DemoScenes.swift"),
      "utf8",
    );
    expect(scenes).toContain('static let appearanceArgument = "-HimawariDemoAppearance"');
    expect(scenes).toContain(".preferredColorScheme(DemoScene.requestedColorScheme)");
  });
  it("不签名编译原生 Mac App 的 HimawariMac scheme", () => {
    const build =
      workflow.jobs.mac.steps.find((step) => step.run?.startsWith("xcodebuild build"))?.run ?? "";
    expect(workflow.jobs.mac.name).toBe("apple/mac");
    expect(build).toContain("-scheme HimawariMac");
    expect(build).toContain("generic/platform=macOS");
    expect(build).toContain("CODE_SIGNING_ALLOWED=NO");
    expect(
      readFileSync(
        path.join(
          repositoryRoot,
          "clients/apple/App/Himawari.xcodeproj/xcshareddata/xcschemes/HimawariMac.xcscheme",
        ),
        "utf8",
      ),
    ).toContain('BlueprintName = "HimawariMac"');
  });
  it("每个示例场景都跑苹果的无障碍审计，审计测试在 Himawari scheme 里", () => {
    const job = workflow.jobs["iphone-accessibility"];
    expect(job.name).toContain("apple/iphone-accessibility");
    expect(job.strategy.matrix.shard.length).toBeGreaterThan(1);
    const shard = job.steps.find((step) => step.run?.includes("xcodebuild test"));
    expect(shard.env.TEST_RUNNER_HIMAWARI_AUDIT_SHARD).toContain("matrix.shard");
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
