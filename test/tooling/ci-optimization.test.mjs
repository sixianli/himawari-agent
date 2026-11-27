import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DRAFT_SKIP_CONDITION } from "../../scripts/ci/check-policy.mjs";
import { githubExpression } from "../../scripts/ci/contracts.mjs";
import { gateLock } from "../../scripts/ci/install-gate-dependencies.mjs";
import { confirmMain, publishMainMetadata } from "../../scripts/ci/main-confirm.mjs";
import {
  validateCallerGrantsCalledPermissions,
  validateMainWorkflow,
} from "../../scripts/ci/main-workflow.mjs";

const temporary = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
const scratch = () => {
  const root = mkdtempSync(path.join(tmpdir(), "main-report-test-"));
  temporary.push(root);
  return root;
};
const usesGitHubCache = (step) => /^actions\/cache[@/]/u.test(step.uses ?? "");

it("main 确认保留受控失败报告，不把缺少资格写成成功", async () => {
  const root = scratch();
  await expect(confirmMain({ root })).rejects.toThrow("MAIN_EVIDENCE_NO_LONGER_VALID");
  const result = JSON.parse(readFileSync(path.join(root, ".ci-output/main-public/failure.json")));
  expect(result).toEqual({
    kind: "main-confirmation",
    status: "failed",
    reason: "MAIN_EVIDENCE_NO_LONGER_VALID",
  });
  expect(existsSync(path.join(root, ".ci-output/main-public/summary.json"))).toBe(false);
});

it("main 报告只在公开输出检查通过后发布", async () => {
  const root = scratch();
  await publishMainMetadata({ root, name: "summary.json", value: { status: "passed", count: 4 } });
  expect(JSON.parse(readFileSync(path.join(root, ".ci-output/main-public/summary.json")))).toEqual({
    status: "passed",
    count: 4,
  });
  await expect(publishMainMetadata({ root, name: "../escape.json", value: {} })).rejects.toThrow(
    "MAIN_METADATA_NAME",
  );
  expect(existsSync(path.join(root, ".ci-output/escape.json"))).toBe(false);
});

const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
describe("CI 最小依赖安装", () => {
  it("保留锁文件中的版本和完整性，只安装报告校验依赖", () => {
    const result = gateLock(lock);
    expect(Object.keys(result.manifest.dependencies).sort()).toEqual(["ajv", "typescript", "yaml"]);
    expect(Object.keys(result.lock.packages).length).toBeLessThan(15);
    for (const [location, entry] of Object.entries(result.lock.packages)) {
      if (location) expect(entry).toEqual(lock.packages[location]);
    }
    expect(result.lock.packages["node_modules/better-sqlite3"]).toBeUndefined();
    expect(result.lock.packages["node_modules/ajv/node_modules/fast-uri"]).toBeDefined();
  });
  it.each(["hasInstallScript", "link"])("拒绝需要额外执行的依赖：%s", (field) => {
    const value = structuredClone(lock);
    value.packages["node_modules/ajv"][field] = true;
    expect(() => gateLock(value)).toThrow("GATE_DEPENDENCY_UNSAFE");
  });
  it("拒绝缺失的传递依赖", () => {
    const value = structuredClone(lock);
    delete value.packages["node_modules/json-schema-traverse"];
    expect(() => gateLock(value)).toThrow("GATE_DEPENDENCY_MISSING");
  });
});
it("完整 CI 只用 GitHub 缓存在本次运行的作业之间传报告和构建、只装最小汇总依赖，并保留全部检查", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  expect(workflow.on.push).toBeUndefined();
  expect(workflow.on.workflow_call).toBeDefined();
  expect(Object.keys(workflow.jobs)).toHaveLength(7);
  expect(
    workflow.jobs.required.steps.some((s) => s.run?.includes("install-gate-dependencies.mjs")),
  ).toBe(true);
  expect(
    workflow.jobs.required.steps.some((s) => s.run?.includes("install-dependencies.mjs")),
  ).toBe(false);
  const runScoped = `${githubExpression("github.run_id")}-${githubExpression("github.run_attempt")}`;
  for (const job of Object.values(workflow.jobs))
    for (const step of job.steps.filter(usesGitHubCache)) {
      expect(step.uses).toMatch(/^actions\/cache\/(?:save|restore)@[0-9a-f]{40}$/u);
      if (step.with.key.startsWith("ci-share-")) {
        expect(step.with.key.startsWith(`ci-share-${runScoped}-`)).toBe(true);
        expect(
          step.with.path.startsWith(`${githubExpression("runner.temp")}/ci-share/${runScoped}/`),
        ).toBe(true);
        expect(step.with["restore-keys"]).toBeUndefined();
      } else {
        expect(step.uses.startsWith("actions/cache/restore@")).toBe(true);
        expect(downloadCaches[step.with.key.split("-v1-")[0]]).toBe(step.with.path);
      }
    }
});

const downloadCaches = {
  "ci-tools": "~/.cache/himawari-ci/downloads",
  "ci-deps": "~/.cache/himawari-ci/npm\n.ci-output/browsers\n",
};

describe("依赖、工具和浏览器的下载缓存", () => {
  const ci = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const warm = parse(readFileSync(".github/workflows/ci-cache.yml", "utf8"));
  const restores = (job) =>
    job.steps.filter(
      (step) =>
        step.uses?.startsWith("actions/cache/restore@") && !step.with.key.startsWith("ci-share-"),
    );
  const cacheKind = (step) => step.with.key.split("-v1-")[0];

  it("PR 上的作业只读不写：装工具的作业都先取工具缓存，装依赖的作业再取依赖缓存", () => {
    for (const [id, job] of Object.entries(ci.jobs)) {
      const runs = job.steps.map((step) => step.run ?? "");
      const kinds = restores(job).map(cacheKind);
      const installsTools = runs.some((run) => run.includes("install-tools.mjs"));
      const installsDependencies = runs.some((run) => run.includes("install-dependencies.mjs"));
      expect([id, kinds]).toEqual([
        id,
        [...(installsTools ? ["ci-tools"] : []), ...(installsDependencies ? ["ci-deps"] : [])],
      ]);
      const firstInstall = runs.findIndex((run) => run.includes("install-tools.mjs"));
      for (const step of restores(job)) expect(job.steps.indexOf(step)).toBeLessThan(firstInstall);
      expect(
        job.steps.filter(
          (step) =>
            step.uses?.startsWith("actions/cache/save@") && !step.with.key.startsWith("ci-share-"),
        ),
      ).toEqual([]);
    }
  });

  it("只有 main 写缓存：预热工作流只在 main 推送和手动触发时跑，并且作业限定 main", () => {
    expect(Object.keys(warm.on).sort()).toEqual(["push", "workflow_dispatch"]);
    expect(warm.on.push.branches).toEqual(["main"]);
    expect(warm.permissions).toEqual({ contents: "read" });
    expect(warm.jobs.warm.if).toBe(githubExpression("github.ref == 'refs/heads/main'"));
    expect(warm.jobs.warm.strategy.matrix.include.map((entry) => entry.runner).sort()).toEqual([
      "ubuntu-24.04",
      "ubuntu-24.04-arm",
    ]);
  });

  it("预热和取用用同一组路径和键，键里带锁文件摘要和周号，换锁文件或过一周就存新的一份", () => {
    const saves = warm.jobs.warm.steps.filter((step) =>
      step.uses?.startsWith("actions/cache/save@"),
    );
    expect(saves.map(cacheKind).sort()).toEqual(["ci-deps", "ci-tools"]);
    for (const save of saves) {
      expect(save.with.path).toBe(downloadCaches[cacheKind(save)]);
      expect(save.with.key).toMatch(/hashFiles\([^)]*'ci\/toolchain-lock\.json'\)/u);
      expect(save.with.key.endsWith(githubExpression("steps.week.outputs.week"))).toBe(true);
      for (const job of Object.values(ci.jobs))
        for (const restore of restores(job).filter((step) => cacheKind(step) === cacheKind(save))) {
          expect(restore.with.key).toBe(save.with.key);
          expect(save.with.key.startsWith(restore.with["restore-keys"])).toBe(true);
        }
    }
    expect(saves.find((step) => cacheKind(step) === "ci-deps").with.key).toContain(
      "package-lock.json",
    );
  });

  it("取回的东西照样逐个核对：工具按锁文件摘要、npm 包按锁文件完整性校验，都不跳过", () => {
    for (const job of Object.values(ci.jobs)) {
      const runs = job.steps.map((step) => step.run ?? "");
      if (runs.some((run) => run.includes("install-dependencies.mjs")))
        expect(runs.find((run) => run.includes("install-dependencies.mjs"))).toContain(
          "--cache runner",
        );
    }
    const download = readFileSync("scripts/ci/verified-download.mjs", "utf8");
    expect(download).toContain("sha256Of(bytes) !== sha256");
    expect(readFileSync("scripts/ci/install-dependencies.mjs", "utf8")).toContain('"ci"');
  });
});

it("main 和质量工作流不用 GitHub 缓存，所有工作流都不上传或下载 GitHub 产物", () => {
  for (const uses of ["actions/cache@x", "actions/cache/restore@x", "actions/cache/save@x"])
    expect(usesGitHubCache({ uses })).toBe(true);
  for (const uses of ["actions/checkout@x", "actions/cachet@x", undefined])
    expect(usesGitHubCache({ uses })).toBe(false);
  for (const name of ["ci.yml", "main.yml", "quality.yml"]) {
    const workflow = parse(readFileSync(`.github/workflows/${name}`, "utf8"));
    const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
    if (name !== "ci.yml") expect(steps.filter(usesGitHubCache)).toEqual([]);
    expect(steps.filter((s) => /artifact/u.test(s.uses ?? ""))).toEqual([]);
    expect(steps.filter((s) => s.run?.includes("ci-summary.mjs")).length).toBeGreaterThan(0);
  }
});

it("main 的确认共用一个并发组、不掐正在跑的那次，所以连续合并时只留最新一次在等", () => {
  const text = readFileSync(".github/workflows/main.yml", "utf8");
  const tools = JSON.parse(readFileSync("ci/toolchain-lock.json", "utf8"));
  expect(validateMainWorkflow(text, tools)).toEqual({ jobs: 3 });
  expect(text).toContain("  group: main-confirmation\n  cancel-in-progress: false\n");
  expect(() =>
    validateMainWorkflow(
      text.replace(
        "group: main-confirmation\n",
        ["group: main-confirmation-$", "{{ github.run_id }}\n"].join(""),
      ),
      tools,
    ),
  ).toThrow("concurrency");
  expect(() =>
    validateMainWorkflow(
      text.replace("cancel-in-progress: false", "cancel-in-progress: true"),
      tools,
    ),
  ).toThrow("concurrency");
});

it("main 工作流不能隐藏检查失败或关闭完整 CI 回退", () => {
  const text = readFileSync(".github/workflows/main.yml", "utf8");
  const tools = JSON.parse(readFileSync("ci/toolchain-lock.json", "utf8"));
  expect(validateMainWorkflow(text, tools)).toEqual({ jobs: 3 });
  expect(() =>
    validateMainWorkflow(
      text.replace("always() && (needs.plan.result", "(needs.plan.result"),
      tools,
    ),
  ).toThrow("fallback");
  expect(() =>
    validateMainWorkflow(
      text.replace("run: .ci-output/tools/bin/node scripts/ci/main-confirm.mjs", "run: true"),
      tools,
    ),
  ).toThrow();
  expect(() =>
    validateMainWorkflow(
      text.replace(
        "runs-on: ubuntu-24.04\n    timeout-minutes: 90",
        "runs-on: ubuntu-24.04\n    timeout-minutes: 45",
      ),
      tools,
    ),
  ).toThrow("runtime");
  expect(() =>
    validateMainWorkflow(
      text.replace(
        "      - name: 把 main 确认报告写进作业摘要",
        "      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02\n        with:\n          path: .ci-output/main-public/\n      - name: 把 main 确认报告写进作业摘要",
      ),
      {
        ...tools,
        actions: [
          ...tools.actions,
          {
            repository: "actions/upload-artifact",
            sha: "ea165f8d65b6e75b540449e92b4886f43607fa02",
          },
        ],
      },
    ),
  ).toThrow("github-artifact");
  expect(() =>
    validateMainWorkflow(
      text.replace(
        "        run: node scripts/ci/main-evidence.mjs discover\n      - name: 在实际 main",
        "        run: echo skipped\n      - name: 在实际 main",
      ),
      tools,
    ),
  ).toThrow("confirmation");
  expect(() =>
    validateMainWorkflow(
      text.replace(
        '--title "main 确认报告" --from .ci-output/main-public',
        '--title "main 确认报告" --from .ci-output/other',
      ),
      tools,
    ),
  ).toThrow("job-summary");
});

describe("[I-93] main 调用完整 CI 时授予的权限覆盖 ci.yml 每个 job 要的权限，否则整轮 startup_failure", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const main = readFileSync(".github/workflows/main.yml", "utf8");
  const tools = JSON.parse(readFileSync("ci/toolchain-lock.json", "utf8"));
  const caller = (granted) =>
    `permissions:\n  contents: read\n  actions: read\njobs:\n  full:\n    uses: ./.github/workflows/ci.yml\n${granted}`;
  const called = (jobPermissions) =>
    `permissions:\n  contents: read\njobs:\n  required:\n    permissions:\n${jobPermissions}`;
  it("仓库里的 main.yml 和 ci.yml 通过，并且这项检查在 check:ci-policy 里", () => {
    expect(validateCallerGrantsCalledPermissions(main, ci)).toEqual({ scopes: 3 });
    expect(readFileSync("scripts/ci/check-policy.mjs", "utf8")).toContain(
      "validateCallerGrantsCalledPermissions(mainWorkflow",
    );
  });
  it("被调用方的 job 要 write、调用方只给 read 时失败", () => {
    expect(() =>
      validateCallerGrantsCalledPermissions(
        caller("    permissions:\n      contents: read\n      actions: read\n"),
        called("      actions: write\n"),
      ),
    ).toThrow("full-grants-actions-write");
  });
  it("调用方没写 job 级权限时按工作流级权限算", () => {
    expect(() =>
      validateCallerGrantsCalledPermissions(caller(""), called("      actions: write\n")),
    ).toThrow("full-grants-actions-write");
    expect(
      validateCallerGrantsCalledPermissions(caller(""), called("      actions: read\n")),
    ).toEqual({ scopes: 2 });
  });
  it("权限写成 write-all、read-all 这类字符串时按无效失败，空映射不申请任何权限", () => {
    for (const shorthand of ["write-all", "read-all"]) {
      expect(() =>
        validateCallerGrantsCalledPermissions(caller(""), `permissions: ${shorthand}\njobs: {}\n`),
      ).toThrow("full-grants-invalid");
      expect(() =>
        validateCallerGrantsCalledPermissions(
          `permissions: ${shorthand}\njobs:\n  full:\n    uses: x\n`,
          called("      actions: read\n"),
        ),
      ).toThrow("full-grants-invalid");
    }
    expect(
      validateCallerGrantsCalledPermissions(
        caller(""),
        "permissions: {}\njobs:\n  a:\n    permissions: {}\n",
      ),
    ).toEqual({ scopes: 2 });
  });
  it("被调用方顶层或 job 新增调用方没给的权限时失败", () => {
    expect(() =>
      validateCallerGrantsCalledPermissions(
        main,
        ci.replace("permissions:\n", "permissions:\n  issues: read\n"),
      ),
    ).toThrow("full-grants-issues-read");
  });
  it("完整 CI 的某个 job 重新申请 actions: write 时调用检查失败", () => {
    const writing = ci.replace(
      "  required:\n",
      "  required:\n    permissions:\n      contents: read\n      actions: write\n",
    );
    expect(writing).not.toBe(ci);
    expect(() => validateCallerGrantsCalledPermissions(main, writing)).toThrow(
      "full-grants-actions-write",
    );
  });
  it("main 的 full 不得单独授予权限", () => {
    const granted = main.replace(
      "    needs: plan\n    if:",
      "    needs: plan\n    permissions:\n      contents: read\n    if:",
    );
    expect(granted).not.toBe(main);
    expect(() => validateMainWorkflow(granted, tools)).toThrow("full-inputs");
  });
});

it("job 之间的文件经本次运行的缓存传递：汇总先取回再收齐再判定，任何 job 都没有写权限", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const steps = workflow.jobs.required.steps;
  const restores = steps.flatMap((step, index) =>
    usesGitHubCache(step) && step.with.key.startsWith("ci-share-") ? [index] : [],
  );
  const collect = steps.findIndex((step) => step.run?.includes("run-share.mjs collect"));
  const gate = steps.findIndex((step) => step.run?.includes("required.mjs"));
  expect(restores.length).toBe(8);
  expect(Math.max(...restores)).toBeLessThan(collect);
  expect(gate).toBeGreaterThan(collect);
  expect(steps.some((step) => step.run?.includes("run-share.mjs remove"))).toBe(false);
  for (const job of Object.values(workflow.jobs)) {
    expect(JSON.stringify(job.permissions ?? {})).not.toContain("write");
    for (const step of job.steps ?? [])
      expect(step.uses ?? "").not.toContain("actions/download-artifact");
  }
});

describe("草稿和被取消的运行不占 runner", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const entry = workflow.jobs.required.steps[0];
  const runEntry = (env) =>
    spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", entry.run], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...env },
    });
  it("汇总作业第一步就判草稿和被取消的运行失败，排在检出和装工具之前", () => {
    expect(entry.id).toBe("entry");
    expect(entry.uses).toBeUndefined();
    expect(workflow.on.pull_request.types).not.toContain("edited");
    for (const [id, job] of Object.entries(workflow.jobs))
      if (id !== "required") expect(job.if).toBe(githubExpression(DRAFT_SKIP_CONDITION));
  });
  it.each([
    [{ CI_DRAFT: "true", CI_CANCELLED: "false" }, 1, "CI_DRAFT_UNVERIFIED"],
    [{ CI_DRAFT: "false", CI_CANCELLED: "true" }, 1, "CI_UPSTREAM_CANCELLED"],
    [{ CI_DRAFT: "", CI_CANCELLED: "false" }, 1, "CI_DRAFT_UNVERIFIED"],
    [{ CI_DRAFT: "false", CI_CANCELLED: "" }, 1, "CI_UPSTREAM_CANCELLED"],
    [{ CI_DRAFT: "false", CI_CANCELLED: "false" }, 0, ""],
  ])("入口检查 %j 退出 %i", (env, status, marker) => {
    const result = runEntry(env);
    expect(result.status).toBe(status);
    if (marker) expect(result.stdout).toContain(marker);
    else expect(result.stdout).toBe("");
  });
});
