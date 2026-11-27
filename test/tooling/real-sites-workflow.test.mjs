import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { repositoryRoot } from "../../scripts/ci/contracts.mjs";

const realSiteTests = [
  {
    file: "test/integration/browser-tool-real-sites.test.ts",
    project: "qualification-browser-real-sites",
  },
  {
    file: "test/integration/browser-vault.test.ts",
    project: "qualification-browser-vault-real-sites",
  },
];
const read = (relative) => readFileSync(path.join(repositoryRoot, relative), "utf8");
const workflow = parse(read(".github/workflows/real-sites.yml"));
const policy = JSON.parse(read("ci/policy.json"));

describe("访问真实外网的浏览器工具测试", () => {
  it("不进 PR 的合并门槛：从 integration 排除，单独登记成自己的项目", () => {
    const integration = policy.testProjects.find((entry) => entry.id === "integration");
    for (const { file, project } of realSiteTests) {
      expect(integration.exclude).toContain(file);
      expect(policy.registeredTests.find((entry) => entry.path === file)).toMatchObject({
        kind: "qualification",
        project,
        allowedModifiers: [],
      });
    }
  });

  it("main 每次推送都跑，PR 上不跑，可以手动触发", () => {
    expect(Object.keys(workflow.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.on.push.paths).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("在免费的标准 Linux 机器上先准备沙箱和浏览器，再不重试地跑这个项目", () => {
    const job = workflow.jobs.run;
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    const runs = job.steps.map((step) => String(step.run ?? ""));
    const prepare = runs.findIndex((run) =>
      run.startsWith("sudo bash scripts/ci/prepare-hosted.sh "),
    );
    const browser = runs.findIndex((run) => run.includes("playwright/cli.js install"));
    const test = runs.findIndex((run) => run.includes("--project qualification-browser"));
    expect(prepare).toBeGreaterThanOrEqual(0);
    expect(browser).toBeGreaterThan(prepare);
    expect(test).toBeGreaterThan(browser);
    for (const { project } of realSiteTests) expect(runs[test]).toContain(`--project ${project}`);
    expect(runs[test]).toContain("--retry 0");
  });

  it("static 检查用 actionlint 检查这个工作流", () => {
    expect(read("scripts/ci/run.mjs")).toContain('".github/workflows/real-sites.yml"');
  });

  it("main 上失败时在上次通过以来合进 main 的每个 PR 上留言请它认领", () => {
    const claim = workflow.jobs.claim;
    expect(claim.needs).toBe("run");
    expect(claim.if).toContain("failure()");
    expect(claim.if).toContain("github.event_name == 'push'");
    expect(claim.if).toContain("refs/heads/main");
    expect(claim["runs-on"]).toBe("ubuntu-24.04");
    expect(claim.permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "write",
    });
    expect(claim.steps.at(-1).run).toBe(
      "node scripts/ci/main-claim.mjs real-sites.yml any real-sites/run",
    );
  });
});
