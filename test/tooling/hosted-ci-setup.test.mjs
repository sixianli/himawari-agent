import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import {
  validateAppleAuditSchedule,
  validateAppleMacSlots,
  validateHostedRunners,
  validateManualMacRunsSupersede,
} from "../../scripts/ci/check-policy.mjs";
import {
  githubExpression,
  linuxRunnerLabel,
  macRunnerLabel,
  repositoryRoot,
} from "../../scripts/ci/contracts.mjs";

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
  const { publish, check, finish } = workflow.jobs;
  const releaseScript = readFileSync(
    path.join(repositoryRoot, "clients/apple/scripts/mac-release.sh"),
    "utf8",
  );
  it("只在 main 上、免费的标准机器上跑；查公证状态用 Linux 机器，只有出包和收尾用 Mac 机器", () => {
    expect(Object.keys(workflow.jobs)).toEqual(["publish", "check", "finish"]);
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on.pull_request).toBeUndefined();
    expect(publish["runs-on"]).toBe(macRunnerLabel);
    expect(finish["runs-on"]).toBe(macRunnerLabel);
    expect(check["runs-on"]).toBe(linuxRunnerLabel);
    expect(publish.if).toContain("github.ref == 'refs/heads/main'");
    expect(publish.if).toContain("github.event_name != 'schedule'");
    expect(check.if).toContain("github.event_name == 'schedule' || inputs.mode == 'check'");
    expect(publish.if).toContain("inputs.mode != 'check'");
    expect(workflow.on.workflow_dispatch.inputs.mode.options).toEqual(["build", "check"]);
    expect(workflow.on.workflow_dispatch.inputs.mode.default).toBe("build");
    expect(finish.needs).toBe("check");
    expect(finish.if).toContain("needs.check.outputs.outcome == 'accepted'");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(check.permissions).toEqual({ contents: "read", actions: "read" });
    expect(() => validateHostedRunners({ "mac-release.yml": text })).not.toThrow();
  });
  it("缺任何一把密钥就只警告、不出包", () => {
    const keys = publish.steps.find((step) => step.id === "keys");
    for (const name of [
      "ASC_KEY_ID",
      "ASC_ISSUER_ID",
      "ASC_KEY_P8",
      "MAC_DEVELOPER_ID_P12",
      "MAC_DEVELOPER_ID_P12_PASSWORD",
      "SPARKLE_PRIVATE_KEY",
      "HIMAWARI_UPDATE_KEY",
    ]) {
      expect(keys.run).toContain(name);
      expect(Object.keys(keys.env)).toContain(name);
    }
    for (const step of publish.steps.slice(publish.steps.indexOf(keys) + 1)) {
      expect(step.if).toContain("steps.keys.outputs.ready == 'true'");
    }
  });
  it("Mac 机器上最多等公证 15 分钟；没好就把签好的 App 存起来，不再占着机器干等", () => {
    expect(releaseScript).not.toContain("--wait");
    expect(releaseScript).toContain("HIMAWARI_NOTARY_WAIT_SECONDS:-900");
    expect(publish["timeout-minutes"]).toBeLessThanOrEqual(90);
    const park = publish.steps.find((step) =>
      String(step.uses ?? "").startsWith("actions/upload-artifact@"),
    );
    expect(park.if).toContain("steps.build.outputs.notarized == 'false'");
    expect(park.with.name).toContain("env.HIMAWARI_PENDING_ARTIFACT");
    const status = check.steps.find((step) => step.id === "status");
    expect(status.run).toBe("node clients/apple/scripts/notary-status.mjs");
    expect(workflow.on.schedule.length).toBe(1);
  });
  it("直接发布和收尾发布用同一个脚本，App 读的更新清单地址就是它上传 appcast.xml 的那个 release", () => {
    expect(workflow.env.HIMAWARI_UPDATE_FEED).toContain(
      "/releases/download/mac-updates/appcast.xml",
    );
    for (const job of [publish, finish]) {
      expect(job.steps.at(-1).run).toBe("clients/apple/scripts/mac-publish.sh");
      expect(Object.keys(job.steps.at(-1).env)).toContain("SUPERSEDES_RUN");
    }
    const publishScript = readFileSync(
      path.join(repositoryRoot, "clients/apple/scripts/mac-publish.sh"),
      "utf8",
    );
    expect(publishScript).toContain("gh release upload mac-updates");
    expect(publishScript).toContain('gh release create "mac-$BUILD"');
    expect(releaseScript).toContain(
      'url="$HIMAWARI_RELEASE_BASE/mac-$HIMAWARI_BUILD_NUMBER/$zip_name"',
    );
    const plist = readFileSync(
      path.join(repositoryRoot, "clients/apple/App/macOS/Info.plist"),
      "utf8",
    );
    expect(plist).toContain("<string>$(HIMAWARI_UPDATE_FEED)</string>");
    expect(plist).toContain("<string>$(HIMAWARI_UPDATE_KEY)</string>");
  });
});

describe("iPhone 工作流", () => {
  const workflow = parse(
    readFileSync(path.join(repositoryRoot, ".github/workflows/apple.yml"), "utf8"),
  );
  it("main 上同时只跑一次，排队的只留最新一次；最新一次从这些检查上次全部通过的提交算改动，跳过的推送不会漏审", () => {
    const group = workflow.concurrency.group;
    expect(group).toContain("github.event_name");
    expect(group).toContain("github.event.pull_request.number || github.ref");
    expect(group).not.toContain("github.sha");
    expect(workflow.concurrency["cancel-in-progress"]).toBe(
      githubExpression(
        "github.event_name == 'pull_request' || github.event_name == 'workflow_dispatch' && github.ref != 'refs/heads/main'",
      ),
    );
    const scope = workflow.jobs.changes.steps.at(-1);
    expect(scope.env.BASE).toContain("github.event_name == 'push' && '--since-green'");
    expect(scope.env.BASE).not.toContain("github.event.before");
    expect(scope.env.GH_TOKEN).toContain("github.token");
    expect(workflow.jobs.changes.permissions).toEqual({ contents: "read", actions: "read" });
  });

  it("只在免费的标准机器上跑，只读权限，跳过草稿，没碰 iPhone 客户端时不占 Mac 机器", () => {
    expect(Object.keys(workflow.jobs)).toEqual([
      "changes",
      "iphone",
      "iphone-accessibility-build",
      "iphone-accessibility",
      "scroll",
      "claim",
    ]);
    const { changes, claim, ...macJobs } = workflow.jobs;
    expect(claim["runs-on"]).toBe("ubuntu-24.04");
    expect(changes["runs-on"]).toBe("ubuntu-24.04");
    expect(changes.if).toContain("github.event.pull_request.draft != true");
    expect(changes.steps.at(-1).run).toContain("scripts/ci/apple-scope.mjs");
    for (const job of Object.values(macJobs)) {
      expect(job["runs-on"]).toBe(macRunnerLabel);
      expect([job.needs].flat()).toContain("changes");
      expect(job.if).toContain("needs.changes.outputs.client == 'true'");
    }
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.values(macJobs).every((job) => job.permissions === undefined)).toBe(true);
    expect(() =>
      validateHostedRunners({
        "apple.yml": readFileSync(path.join(repositoryRoot, ".github/workflows/apple.yml"), "utf8"),
      }),
    ).not.toThrow();
  });

  it("PR 上只开一台 Mac：单元测试、iPhone 和 Mac 两个 App 的编译都在 apple/iphone 里，审计和测速只在 main 和手动触发时跑", () => {
    const macJobs = Object.entries(workflow.jobs).filter(
      ([, job]) => job["runs-on"] === macRunnerLabel,
    );
    const onPullRequest = macJobs.filter(
      ([, job]) => !job.if.includes("github.event_name != 'pull_request'"),
    );
    expect(onPullRequest.map(([id]) => id)).toEqual(["iphone"]);
    expect(onPullRequest[0][1].strategy).toBeUndefined();
    for (const id of ["iphone-accessibility", "scroll"]) {
      expect(workflow.jobs[id].if).toContain("github.event_name != 'pull_request'");
    }
    expect(Object.keys(workflow.on)).toContain("workflow_dispatch");
    const builds = workflow.jobs.iphone.steps
      .map((step) => step.run ?? "")
      .filter((run) => run.startsWith("xcodebuild build"));
    expect(builds.some((run) => run.includes("-scheme Himawari "))).toBe(true);
    expect(builds.some((run) => run.includes("-scheme HimawariMac"))).toBe(true);
  });

  it("main 上审计、测速或编译失败时，自动在改了苹果客户端的 PR 上留言请它的线程认领", () => {
    const claim = workflow.jobs.claim;
    expect(claim["runs-on"]).toBe("ubuntu-24.04");
    expect(claim.needs).toEqual([
      "iphone",
      "iphone-accessibility-build",
      "iphone-accessibility",
      "scroll",
    ]);
    expect(claim.if).toContain("failure()");
    expect(claim.if).toContain("github.event_name == 'push'");
    expect(claim.if).toContain("github.event_name == 'schedule'");
    expect(claim.if).toContain("refs/heads/main");
    expect(claim.permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "write",
    });
    const claimRun = claim.steps.at(-1).run;
    expect(claimRun).toContain(
      "node scripts/ci/main-claim.mjs apple.yml apple apple/iphone-accessibility-build apple/iphone-accessibility",
    );
    expect(claimRun).toContain(
      "node scripts/ci/main-claim.mjs apple.yml apple apple/iphone apple/scroll",
    );
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
  it("main 上的苹果检查排成一条队，同时只占一台 Mac，其余留给 PR 的 apple/iphone", () => {
    const text = readFileSync(path.join(repositoryRoot, ".github/workflows/apple.yml"), "utf8");
    expect(() => validateAppleMacSlots(text)).not.toThrow();
    const chain = ["iphone", "iphone-accessibility-build", "iphone-accessibility", "scroll"];
    for (const [index, id] of chain.entries()) {
      if (index === 0) continue;
      expect([workflow.jobs[id].needs].flat()).toContain(chain[index - 1]);
      expect(workflow.jobs[id].if).toContain("!cancelled()");
    }
    expect(workflow.jobs["iphone-accessibility"].strategy["max-parallel"]).toBe(1);
    expect(workflow.jobs["iphone-accessibility"].if).toContain(
      "needs.iphone-accessibility-build.result == 'success'",
    );
  });
  it.each([
    [
      "合并前的写法：编译、测速和 apple/iphone 同时开跑",
      (jobs) => {
        jobs["iphone-accessibility-build"].needs = "changes";
        jobs.scroll.needs = "changes";
      },
      "main starts 3 Mac jobs at once",
    ],
    [
      "三份审计同时跑",
      (jobs) => {
        delete jobs["iphone-accessibility"].strategy["max-parallel"];
      },
      "set max-parallel: 1",
    ],
    [
      "前一个 Mac 作业失败就把后面的检查跳过",
      (jobs) => {
        jobs.scroll.if = jobs.scroll.if.replace("!cancelled() && ", "");
      },
      "add !cancelled()",
    ],
    [
      "PR 上开第二台 Mac",
      (jobs) => {
        jobs.scroll.if = jobs.scroll.if.replace("github.event_name != 'pull_request' && ", "");
      },
      "a pull request starts 2 Mac jobs",
    ],
  ])("拒绝%s", (_label, change, message) => {
    const changed = structuredClone(workflow);
    change(changed.jobs);
    expect(() => validateAppleMacSlots(stringify(changed))).toThrow(message);
  });
  it("无障碍审计每天凌晨 3 点（JST）跑一次，上次审计以后没有新提交就跳过，推送和 PR 都不跑", () => {
    const text = readFileSync(path.join(repositoryRoot, ".github/workflows/apple.yml"), "utf8");
    expect(() => validateAppleAuditSchedule(text)).not.toThrow();
    expect(workflow.on.schedule).toEqual([{ cron: "0 18 * * *" }]);
    expect(workflow.jobs.iphone.if).toContain("github.event_name != 'schedule'");
    expect(workflow.jobs.scroll.if).toContain("github.event_name != 'schedule'");
    expect(workflow.jobs.changes.steps.at(-1).env.BASE).toContain(
      "github.event_name == 'schedule' && '--since-audit'",
    );
  });
  it.each([
    [
      "没有定时触发",
      (changed) => {
        delete changed.on.schedule;
      },
      "runs nightly",
    ],
    [
      "推送到 main 时又跑审计",
      (changed) => {
        changed.jobs["iphone-accessibility"].if = changed.jobs["iphone-accessibility"].if.replace(
          "github.event_name != 'push' && ",
          "",
        );
      },
      "iphone-accessibility must not run on push",
    ],
    [
      "没有新提交也照跑",
      (changed) => {
        const step = changed.jobs.changes.steps.at(-1);
        step.env.BASE = step.env.BASE.replace(
          " || github.event_name == 'schedule' && '--since-audit'",
          "",
        );
      },
      "--since-audit",
    ],
    [
      "凌晨审计失败没人认领",
      (changed) => {
        changed.jobs.claim.if = changed.jobs.claim.if.replace(
          " || github.event_name == 'schedule'",
          "",
        );
      },
      "must be claimed",
    ],
  ])("凌晨审计的规则拒绝%s", (_label, change, message) => {
    const changed = structuredClone(workflow);
    change(changed);
    expect(() => validateAppleAuditSchedule(stringify(changed))).toThrow(message);
  });
  it("三份审计共用同一次运行里编译一次的 App，只重跑审计时也找得到那次编译", () => {
    const build = workflow.jobs["iphone-accessibility-build"];
    expect(build.needs).toEqual(["changes", "iphone"]);
    expect(build.if).toContain("github.event_name != 'pull_request'");
    const compile = build.steps.find((step) => step.run?.startsWith("xcodebuild"))?.run ?? "";
    expect(compile).toContain("xcodebuild build-for-testing");
    expect(compile).toContain("-scheme Himawari");
    expect(compile).toContain("generic/platform=iOS Simulator");
    expect(compile).toContain("CODE_SIGNING_ALLOWED=NO");
    const upload = build.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    expect(upload.with.name).toMatch(/^accessibility-build-\$\{\{ github\.run_attempt \}\}$/u);
    expect(upload.with["retention-days"]).toBe(1);
    expect(build.outputs.artifact).toBe(upload.with.name);
    const shards = workflow.jobs["iphone-accessibility"];
    expect(shards.needs).toEqual(["changes", "iphone-accessibility-build"]);
    const download = shards.steps.find((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    );
    expect(download.with.name).toContain("needs.iphone-accessibility-build.outputs.artifact");
    expect(shards.steps.some((step) => step.run?.includes("xcodebuild build"))).toBe(false);
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
      workflow.jobs.iphone.steps.find((step) => step.run?.includes("-scheme HimawariMac"))?.run ??
      "";
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
    const audit = shard.run;
    expect(audit).toContain("xcodebuild test-without-building");
    expect(audit).toContain("-xctestrun");
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

describe("TestFlight 工作流", () => {
  const workflow = parse(
    readFileSync(path.join(repositoryRoot, ".github/workflows/testflight.yml"), "utf8"),
  );
  it("PR 上不打 Release 归档，只在 main 和手动触发时跑", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(Object.keys(workflow.jobs)).toEqual(["upload", "claim"]);
  });
  it("main 上没有密钥时照样打 Release 归档、核对权限；有密钥时归档、核对后上传", () => {
    const steps = workflow.jobs.upload.steps;
    const archive = steps.find(
      (step) => step.run === "clients/apple/scripts/testflight.sh archive",
    );
    expect(archive.if).toContain("steps.keys.outputs.ready != 'true'");
    const upload = steps.find((step) => step.run === "clients/apple/scripts/testflight.sh upload");
    expect(upload.if).toContain("steps.keys.outputs.ready == 'true'");
    const script = readFileSync(
      path.join(repositoryRoot, "clients/apple/scripts/testflight.sh"),
      "utf8",
    );
    expect(script).toMatch(/archive_and_upload\(\) \{[^}]*archive_app/su);
    expect(script).toMatch(/archive_app\(\) \{[^}]*check_entitlements/su);
  });
  it("main 上失败时同样留言请改了苹果客户端的 PR 认领", () => {
    expect(workflow.jobs.claim.needs).toBe("upload");
    expect(workflow.jobs.claim.if).toContain("failure()");
    expect(workflow.jobs.claim.steps.at(-1).run).toBe(
      "node scripts/ci/main-claim.mjs testflight.yml apple testflight/upload",
    );
  });
});

describe("手动触发的 Mac 运行，同一分支新的一次取消旧的", () => {
  const read = (name) => readFileSync(path.join(repositoryRoot, ".github/workflows", name), "utf8");
  const all = Object.fromEntries(
    ["apple.yml", "apple-screens.yml", "mac-release.yml", "testflight.yml"].map((name) => [
      name,
      read(name),
    ]),
  );
  it("现有的苹果工作流都满足；只在 main 上出包的 Mac 安装包发布不要求取消", () => {
    expect(() => validateManualMacRunsSupersede(all)).not.toThrow();
    expect(parse(all["mac-release.yml"]).concurrency).toBeUndefined();
  });
  it.each([
    [
      "截图不取消旧的",
      "apple-screens.yml",
      (workflow) => {
        workflow.concurrency["cancel-in-progress"] = false;
      },
    ],
    [
      "苹果全套只取消 PR 上的旧运行",
      "apple.yml",
      (workflow) => {
        workflow.concurrency["cancel-in-progress"] = githubExpression(
          "github.event_name == 'pull_request'",
        );
      },
    ],
    [
      "并发组不按分支分",
      "apple-screens.yml",
      (workflow) => {
        workflow.concurrency.group = "apple-screens";
      },
    ],
  ])("拒绝%s", (_label, name, change) => {
    const workflow = parse(all[name]);
    change(workflow);
    expect(() => validateManualMacRunsSupersede({ [name]: stringify(workflow) })).toThrow(
      "MANUAL_MAC_RUN_SUPERSEDE",
    );
  });
});

describe("示例场景截图工作流", () => {
  const workflow = parse(
    readFileSync(path.join(repositoryRoot, ".github/workflows/apple-screens.yml"), "utf8"),
  );
  it("只能手动触发、只读权限，在免费的标准 Mac 机器上用 ui-review.sh 截深浅两张并上传", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    const job = workflow.jobs.screens;
    expect(job["runs-on"]).toBe(macRunnerLabel);
    const shoot = job.steps.find((step) =>
      step.run?.includes("clients/apple/scripts/ui-review.sh"),
    );
    expect(shoot.run).toContain('--only "$SCENES"');
    expect(shoot.env.SCENES).toContain("inputs.scenes");
    expect(shoot.env.TEXT_SIZE).toContain("inputs.text_size");
    expect(shoot.run).toContain('--text-size "$TEXT_SIZE"');
    const upload = job.steps.find((step) => step.with?.name === "apple-screens");
    expect(upload.if).toContain("always()");
  });
});
