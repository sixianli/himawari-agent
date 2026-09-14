import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  root: "",
  calls: [],
  fail: "",
  failSecurity: false,
  testReportFailure: "",
  empty: false,
  pipelineExitCode: 0,
  writtenCandidateFailure: false,
  failCleanup: false,
  cleanupPaths: [],
  candidateFault: "",
  failBuildAndCleanup: false,
  artifactFailure: false,
  verified: [],
  parallel: undefined,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original();
  return {
    ...actual,
    rmSync: (target, options) => {
      if (state.failCleanup && path.basename(String(target)).startsWith("hci-")) {
        state.cleanupPaths.push(target);
        const error = new Error("synthetic temporary cleanup failure");
        error.code = "EPERM";
        throw error;
      }
      return actual.rmSync(target, options);
    },
  };
});
vi.mock("../../scripts/ci/check-policy.mjs", async (original) => {
  const actual = await original();
  return {
    ...actual,
    resolvePolicySource: (options) => {
      const value = actual.resolvePolicySource(options);
      if (!state.parallel) return value;
      const coverage = JSON.parse(
        readFileSync(path.join(options.root, "ci/coverage-policy.json"), "utf8"),
      );
      return { ...value, coverage: { ...coverage, projects: ["unit", "contracts", "tooling"] } };
    },
  };
});
vi.mock("../../scripts/ci/coverage-comparison.mjs", async (original) => ({
  ...(await original()),
  prepareCoverageComparison: async ({ output, own }) => {
    if (!state.parallel) throw new Error("unexpected comparison");
    state.parallel.started = true;
    const owned = mkdtempSync(path.join(state.root, "comparison-owned-"));
    own(owned);
    state.parallel.owned = owned;
    await state.parallel.releaseComparison.promise;
    if (state.parallel.failComparison) throw new Error("CI_COMPARISON_FIXTURE_FAILED");
    const filename = path.join(output, "comparison-manifest.json");
    write(filename, { root: owned });
    return { filename };
  },
}));
const write = (filename, value) => {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
};
const counts = () => ({
  files: 1,
  executed: state.empty ? 0 : 1,
  passed: state.empty ? 0 : 1,
  failed: 0,
  skipped: 0,
});

vi.mock("../../scripts/ci/install-tools.mjs", async (original) => ({
  ...(await original()),
  verifyInstalledTools: async () => ({
    node: process.versions.node,
    executables: {
      node: process.execPath,
      npmCli: path.join(state.root, "npm.mjs"),
      python: "/fixture/python",
      actionlint: "/fixture/actionlint",
    },
  }),
}));
vi.mock("../../scripts/ci/execute.mjs", async (original) => ({
  ...(await original()),
  execute: async (executable, args, options) => {
    const name = path.basename(options.log, ".log");
    state.calls.push({ name, executable, args, env: options.env });
    write(options.log, "controlled child output\n");
    if (name === "coverage" && state.parallel) {
      state.parallel.coverageReached.resolve();
      await state.parallel.releaseCoverage.promise;
    }
    if (name === state.fail) return { exitCode: 7, durationMs: 1 };
    const json = args.find(
      (arg) => arg.startsWith("--outputFile.json=") || arg.startsWith("--outputFile="),
    );
    if (json && state.testReportFailure !== "missing") {
      const projects = args.flatMap((arg, index) => (arg === "--project" ? [args[index + 1]] : []));
      const names = {
        unit: "packages/example/src/example.unit.test.ts",
        contracts: "packages/example/src/example.contract.test.ts",
        tooling: "test/tooling/example.test.mjs",
        integration: "test/integration/example.test.ts",
      };
      write(json.slice(json.indexOf("=") + 1), {
        success: state.testReportFailure !== "failed",
        testResults: projects.map((project) => ({
          name: path.join(state.root, names[project]),
          assertionResults:
            state.testReportFailure === "failed"
              ? [{ status: "passed" }, { status: "failed" }]
              : [{ status: "passed" }],
        })),
      });
    }
    if (json && state.testReportFailure === "malformed")
      write(json.slice(json.indexOf("=") + 1), "{broken");
    if (json && state.testReportFailure) return { exitCode: 7, durationMs: 1 };
    const junit = args.find((arg) => arg.startsWith("--outputFile.junit="));
    if (junit) write(junit.slice(junit.indexOf("=") + 1), "<testsuites/>\n");
    if (name === "coverage") {
      const output = args[args.indexOf("--coverage.reportsDirectory") + 1];
      write(path.join(output, "coverage-final.json"), { fixture: true });
      write(path.join(output, "lcov.info"), "TN:fixture\nend_of_record\n");
    }
    if (["coverage-snapshot", "coverage-policy"].includes(name))
      write(args[args.indexOf("--output") + 1], { status: "passed" });
    if (
      name === "coverage-policy" &&
      args.includes("--baseline-output") &&
      state.candidateFault !== "missing"
    ) {
      const candidate = JSON.parse(
        readFileSync(path.join(state.root, "ci/coverage-policy.json"), "utf8"),
      );
      if (state.candidateFault === "unmeasured") candidate.baseline = null;
      write(
        args[args.indexOf("--baseline-output") + 1],
        state.candidateFault === "malformed" ? "{malformed" : candidate,
      );
    }
    if (name === "coverage-policy" && state.writtenCandidateFailure)
      return { exitCode: 7, durationMs: 1 };
    return { exitCode: 0, durationMs: 1 };
  },
}));
vi.mock("../../scripts/ci/build.mjs", () => ({
  build: async ({ output, cleanupCoordinator }) => {
    await cleanupCoordinator("build-work-cleanup", async () => {});
    if (state.failBuildAndCleanup)
      throw new AggregateError(
        [new Error("primary build failure"), new Error("cleanup Bearer " + "s".repeat(32))],
        "CI_BUILD_AND_CLEANUP_FAILED",
      );
    const archive = path.join(output, "runtime.tar.gz");
    write(archive, "artifact fixture");
    const report = path.join(output, "build.json");
    write(report, { status: "passed" });
    return {
      archive,
      exitCode: state.pipelineExitCode,
      counts: counts(),
      projects: [],
      reports: [
        { path: report, kind: "json" },
        { path: archive, kind: "artifact" },
      ],
    };
  },
}));
vi.mock("../../scripts/ci/verify-artifact.mjs", () => ({
  verifyArtifact: async (options) => {
    state.verified.push(options);
    if (state.artifactFailure) throw new Error("ARTIFACT_CONTEXT_MISMATCH");
    return { sha256: sha256(readFileSync(options.archive)) };
  },
}));
vi.mock("../../scripts/ci/test.mjs", () => ({
  runTests: async ({ output, artifact }) => {
    const report = path.join(output, "tests.json");
    write(report, { status: "passed" });
    return {
      artifact: { path: artifact },
      exitCode: state.pipelineExitCode,
      counts: { files: 5, executed: 5, passed: 5, failed: 0, skipped: 0 },
      projects: ["unit", "contracts", "integration", "e2e", "pi-compat"].map((id) => ({
        id,
        counts: counts(),
      })),
      reports: [{ path: report, kind: "json" }],
    };
  },
}));
vi.mock("../../scripts/ci/browser.mjs", () => ({
  runBrowser: async ({ output, artifact, engine }) => {
    const report = path.join(output, "browser.json");
    write(report, { engine });
    return {
      artifact: { path: artifact },
      exitCode: state.pipelineExitCode,
      counts: counts(),
      reports: [{ path: report, kind: "json" }],
    };
  },
}));
vi.mock("../../scripts/ci/check-security.mjs", () => ({
  runSecurityChecks: async ({ outputDirectory }) => {
    const reportPath = path.join(outputDirectory, "security-report.json");
    write(reportPath, { status: state.failSecurity ? "failed" : "passed" });
    return {
      status: state.failSecurity ? "failed" : "passed",
      scannedCount: 42,
      retryCount: 0,
      reportPath,
      checks: [{ status: state.failSecurity ? "failed" : "passed" }],
    };
  },
}));

import { createContext } from "../../scripts/ci/context.mjs";
import { repositoryRoot, sha256 } from "../../scripts/ci/contracts.mjs";
import { runCheck } from "../../scripts/ci/run.mjs";

let context;
beforeEach(() => {
  state.parallel = undefined;
  state.failBuildAndCleanup = false;
  state.artifactFailure = false;
  state.verified = [];
  state.root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "himawari-orchestration-")));
  state.calls = [];
  state.fail = "";
  state.failSecurity = false;
  state.testReportFailure = "";
  state.empty = false;
  state.pipelineExitCode = 0;
  state.writtenCandidateFailure = false;
  state.failCleanup = false;
  state.cleanupPaths = [];
  state.candidateFault = "";
  const git = (...args) => execFileSync("git", args, { cwd: state.root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  write(path.join(state.root, "README.md"), "fixture");
  git("add", "README.md");
  git("commit", "-qm", "fixture");
  mkdirSync(path.join(state.root, "ci"));
  for (const filename of ["policy.json", "coverage-policy.json", "toolchain-lock.json"])
    copyFileSync(path.join(repositoryRoot, "ci", filename), path.join(state.root, "ci", filename));
  write(path.join(state.root, "runtime.tar.gz"), "artifact fixture");
  write(path.join(state.root, "npm.mjs"), "process.stdout.write('11.8.0')");
  context = createContext({ root: state.root });
});
afterEach(() => {
  state.failCleanup = false;
  for (const directory of state.cleanupPaths) rmSync(directory, { recursive: true, force: true });
  rmSync(state.root, { recursive: true, force: true });
});
const run = (checkId, extra = {}) =>
  runCheck({
    root: state.root,
    context,
    checkId,
    output: `.ci-output/${checkId}`,
    toolsDirectory: state.root,
    hosted: false,
    ...(checkId === "coverage" ? { artifact: path.join(state.root, "runtime.tar.gz") } : {}),
    ...extra,
  });

describe("共享runner的调度、来源和失败传播", () => {
  it.each(["both pass", "candidate fails", "comparison fails"])(
    "迁移时并行采集，等待双方退出后才清理：%s",
    async (mode) => {
      const deferred = () => {
        let resolve;
        const promise = new Promise((done) => {
          resolve = done;
        });
        return { promise, resolve };
      };
      state.parallel = {
        started: false,
        coverageReached: deferred(),
        releaseCoverage: deferred(),
        releaseComparison: deferred(),
        failComparison: mode === "comparison fails",
      };
      if (mode === "candidate fails") state.fail = "coverage";
      const pending = run("coverage");
      try {
        await state.parallel.coverageReached.promise;
        expect(state.parallel.started).toBe(true);
        expect(existsSync(state.parallel.owned)).toBe(true);
        expect(state.calls.some(({ name }) => name === "coverage-policy")).toBe(false);
        state.parallel.releaseCoverage.resolve();
        // Comparison still owns its directory even if candidate collection failed.
        await new Promise((done) => setImmediate(done));
        expect(existsSync(state.parallel.owned)).toBe(true);
      } finally {
        state.parallel.releaseCoverage.resolve();
        state.parallel.releaseComparison.resolve();
        const result = await pending;
        expect(result.status).toBe(
          mode === "both pass"
            ? "passed"
            : mode === "candidate fails"
              ? "failed"
              : "infrastructure_failed",
        );
        expect(existsSync(state.parallel.owned)).toBe(false);
      }
    },
  );
  it("coverage 在缺少构建归档时拒绝启动采集", async () => {
    await expect(run("coverage", { artifact: undefined })).rejects.toThrow("CI_ARTIFACT_REQUIRED");
    expect(state.calls).toEqual([]);
  });

  it("rejects scheduled quality before creating or executing a required CI check", async () => {
    await expect(run("policy", { context: { ...context, event: "schedule" } })).rejects.toThrow(
      "CI_EVENT_UNSUPPORTED",
    );
    expect(state.calls).toEqual([]);
    expect(existsSync(path.join(state.root, ".ci-output/policy"))).toBe(false);
  });
  it("coverage 在归档身份不符时失败，不开始快照或测试", async () => {
    state.artifactFailure = true;
    const result = await run("coverage");
    expect(result.status).toBe("infrastructure_failed");
    expect(state.calls).toEqual([]);
    expect(state.verified[0].context).toEqual(context);
  });
  it("coverage 使用已核验的归档和同次 context，记录消费摘要", async () => {
    const result = await run("coverage");
    expect(result.status).toBe("passed");
    const collection = state.calls.find(({ name }) => name === "coverage");
    expect(collection.env.HIMAWARI_TEST_ARTIFACT).toBe(
      path.join(state.root, ".ci-output/coverage/runtime.tar.gz"),
    );
    expect(JSON.parse(readFileSync(collection.env.HIMAWARI_TEST_CONTEXT, "utf8"))).toEqual(context);
    expect(result.artifacts[0]).toMatchObject({
      role: "consumed",
      sha256: sha256("artifact fixture"),
    });
    expect(collection.args).toContain("integration");
  });
  it("policy先校验固定合同，再运行tooling；子进程不继承凭据", async () => {
    const result = await run("policy");
    expect(result.status).toBe("passed");
    expect(result.projects.map((entry) => entry.id)).toEqual(["tooling"]);
    expect(state.calls.map((entry) => entry.name)).toEqual([
      "policy",
      "toolchain",
      "governance-source",
      "vitest-tooling",
    ]);
    expect(state.calls[0].args).toContain(context.baseSha);
    expect(state.calls[0].env).not.toHaveProperty("OPENAI_API_KEY");
    expect(state.calls[0].env.HOME).toContain(".ci-output");
  });
  it.each(["failed", "passed", "missing", "malformed"])(
    "保留失败进程的退出码与有效测试计数：%s",
    async (report) => {
      state.testReportFailure = report;
      const result = await run("policy");
      expect(result).toMatchObject({ status: "failed", exitCode: 7 });
      const expected =
        report === "failed"
          ? { files: 1, executed: 2, passed: 1, failed: 1, skipped: 0 }
          : report === "passed"
            ? { files: 1, executed: 1, passed: 1, failed: 0, skipped: 0 }
            : { files: 0, executed: 0, passed: 0, failed: 0, skipped: 0 };
      expect(result.counts).toEqual(expected);
      expect(result.projects).toEqual(
        ["failed", "passed"].includes(report) ? [{ id: "tooling", counts: expected }] : [],
      );
      const details = JSON.parse(
        readFileSync(path.join(state.root, ".ci-output/policy/details.json"), "utf8"),
      );
      expect(details.failures).toContain("CI_COMMAND_FAILED:vitest-tooling");
      if (report === "malformed")
        expect(
          details.failures.some((failure) => failure.startsWith("CI_TEST_REPORT_INVALID:tooling:")),
        ).toBe(true);
    },
  );
  it.each(["failed", "passed", "missing", "malformed"])(
    "覆盖率进程失败时保留四组实际测试计数与退出码：%s",
    async (report) => {
      state.testReportFailure = report;
      const result = await run("coverage");
      expect(result).toMatchObject({ status: "failed", exitCode: 7 });
      expect(result.counts).toEqual(
        report === "failed"
          ? { files: 4, executed: 8, passed: 4, failed: 4, skipped: 0 }
          : report === "passed"
            ? { files: 4, executed: 4, passed: 4, failed: 0, skipped: 0 }
            : { files: 0, executed: 0, passed: 0, failed: 0, skipped: 0 },
      );
      expect(result.projects.map(({ id }) => id)).toEqual(
        ["failed", "passed"].includes(report)
          ? ["unit", "contracts", "tooling", "integration"]
          : [],
      );
      expect(state.calls.map(({ name }) => name)).toEqual(["coverage-snapshot", "coverage"]);
      const details = JSON.parse(
        readFileSync(path.join(state.root, ".ci-output/coverage/details.json"), "utf8"),
      );
      expect(details.failures).toContain("CI_COMMAND_FAILED:coverage");
      if (["missing", "malformed"].includes(report))
        expect(
          details.failures.some((failure) =>
            failure.startsWith("CI_TEST_REPORT_INVALID:coverage:"),
          ),
        ).toBe(true);
    },
  );
  it("static调用原有检查、原始治理脚本和actionlint，不执行报告中的shell", async () => {
    const result = await run("static");
    expect(result.status).toBe("passed");
    expect(result.counts.executed).toBe(4);
    expect(state.calls.find((entry) => entry.name === "docs").args).toEqual([
      "-E",
      "-s",
      "-B",
      "tools/document-governance/scripts/validate_docs.py",
      ".",
      "--strict",
    ]);
    expect(state.calls.find((entry) => entry.name === "actionlint").args).toContain(
      ".github/workflows/quality.yml",
    );
  });
  it("任一命令非零使检查失败，并保留原始退出码和日志", async () => {
    state.fail = "toolchain";
    const result = await run("policy");
    expect(result).toMatchObject({ status: "failed", exitCode: 7 });
    expect(state.calls.map((entry) => entry.name)).toEqual(["policy", "toolchain"]);
    expect(result.reports.some((entry) => entry.path === "toolchain.log")).toBe(true);
    expect(readFileSync(path.join(state.root, ".ci-output/policy/details.json"), "utf8")).toContain(
      "CI_COMMAND_FAILED:toolchain",
    );
  });
  it("构建和清理双失败保留脱敏子原因与暂停报告", async () => {
    state.failBuildAndCleanup = true;
    const platform = process.platform === "darwin" ? "macos-arm64" : "linux-x64";
    const result = await run("build", { matrixKey: platform });
    expect(result.status).toBe("infrastructure_failed");
    const details = JSON.parse(
      readFileSync(path.join(state.root, ".ci-output/build/details.json"), "utf8"),
    );
    expect(details.failures).toEqual([
      "CI_BUILD_AND_CLEANUP_FAILED",
      "primary build failure",
      "cleanup [REDACTED]",
    ]);
    expect(details.resources.pauses.entries[0]).toMatchObject({
      reason: "build-work-cleanup",
      outcome: "passed",
    });
  });
  it("同一归档的build、test、browser分别记录produced/consumed身份", async () => {
    const platform = process.platform === "darwin" ? "macos-arm64" : "linux-x64";
    const build = await run("build", { matrixKey: platform });
    const artifact = path.join(state.root, ".ci-output/build", build.artifacts[0].path);
    const test = await run("test", { matrixKey: platform, artifact });
    const browser = await run("browser", { matrixKey: "chromium", artifact });
    expect([build, test, browser].map((result) => result.status)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    expect(test.artifacts[0].sha256).toBe(build.artifacts[0].sha256);
    expect(browser.artifacts[0].sha256).toBe(build.artifacts[0].sha256);
    expect(build.artifacts[0].role).toBe("produced");
    expect(test.artifacts[0].role).toBe("consumed");
    expect(test.projects).toHaveLength(5);
  });
  it("coverage先绑定源码快照，四个project合并后再判定覆盖率", async () => {
    const result = await run("coverage");
    expect(result.status).toBe("passed");
    expect(result.projects.map((entry) => entry.id)).toEqual([
      "unit",
      "contracts",
      "tooling",
      "integration",
    ]);
    expect(state.calls.map((entry) => entry.name)).toEqual([
      "coverage-snapshot",
      "coverage",
      "coverage-policy",
    ]);
    const args = state.calls[2].args;
    expect(args).toContain("--snapshot");
    expect(args).toContain("--tests");
    expect(state.calls[0].args).toContain("working-tree");
    expect(result.reports.some((entry) => entry.kind === "lcov")).toBe(true);
    expect(args).not.toContain("--mode");
    expect(result.reports.some((entry) => entry.path === "initial-coverage-baseline.json")).toBe(
      false,
    );
  });
  it("initial-only仅在合法初始化中用同份报告生成并登记候选", async () => {
    const baseline = readFileSync(path.join(state.root, "ci/coverage-policy.json"));
    const result = await run("coverage", { baselineCandidate: "initial-only" });
    expect(result).toMatchObject({ status: "passed", initialization: true });
    expect(state.calls.map(({ name }) => name)).toEqual([
      "coverage-snapshot",
      "coverage",
      "coverage-policy",
    ]);
    const [snapshot, collection, evaluation] = state.calls;
    const arg = (args, name) => args[args.indexOf(name) + 1];
    expect(arg(evaluation.args, "--mode")).toBe("measure");
    expect(arg(evaluation.args, "--snapshot")).toBe(arg(snapshot.args, "--output"));
    expect(arg(evaluation.args, "--tests")).toBe(
      collection.args
        .find((value) => value.startsWith("--outputFile="))
        .slice("--outputFile=".length),
    );
    expect(arg(evaluation.args, "--report")).toBe(
      path.join(arg(collection.args, "--coverage.reportsDirectory"), "coverage-final.json"),
    );
    expect(arg(evaluation.args, "--lcov")).toBe(
      path.join(arg(collection.args, "--coverage.reportsDirectory"), "lcov.info"),
    );
    const candidatePath = arg(evaluation.args, "--baseline-output");
    expect(candidatePath).toBe(
      path.join(state.root, ".ci-output/coverage/initial-coverage-baseline.json"),
    );
    const bytes = readFileSync(candidatePath);
    expect(result.reports.find((entry) => entry.path === "initial-coverage-baseline.json")).toEqual(
      {
        path: "initial-coverage-baseline.json",
        kind: "json",
        bytes: bytes.length,
        sha256: sha256(bytes),
      },
    );
    expect(readFileSync(path.join(state.root, "ci/coverage-policy.json"))).toEqual(baseline);
  });
  it("已接受基线时initial-only继续常规检查且不生成候选或改写基线", async () => {
    const git = (...args) => execFileSync("git", args, { cwd: state.root, stdio: "pipe" });
    git("add", "ci");
    git("commit", "-qm", "accept policy");
    context = createContext({ root: state.root });
    const baseline = readFileSync(path.join(state.root, "ci/coverage-policy.json"));
    const result = await run("coverage", { baselineCandidate: "initial-only" });
    expect(result).toMatchObject({ status: "passed", initialization: false });
    expect(state.calls.map(({ name }) => name)).toEqual([
      "coverage-snapshot",
      "coverage",
      "coverage-policy",
    ]);
    expect(state.calls[2].args).not.toContain("--mode");
    expect(state.calls[2].args).not.toContain("--baseline-output");
    expect(
      existsSync(path.join(state.root, ".ci-output/coverage/initial-coverage-baseline.json")),
    ).toBe(false);
    expect(result.reports.some((entry) => entry.path === "initial-coverage-baseline.json")).toBe(
      false,
    );
    expect(readFileSync(path.join(state.root, "ci/coverage-policy.json"))).toEqual(baseline);
  });
  it("覆盖率判定失败保留非零退出码但不登记不存在的候选", async () => {
    state.fail = "coverage-policy";
    const result = await run("coverage", { baselineCandidate: "initial-only" });
    expect(result).toMatchObject({ status: "failed", exitCode: 7 });
    expect(result.reports.some((entry) => entry.path === "coverage-policy.log")).toBe(true);
    expect(result.reports.some((entry) => entry.path === "initial-coverage-baseline.json")).toBe(
      false,
    );
    expect(
      existsSync(path.join(state.root, ".ci-output/coverage/initial-coverage-baseline.json")),
    ).toBe(false);
  });
  it.each([
    ["候选写完后子进程非零", "writtenCandidateFailure", "failed", 7],
    ["后续临时目录清理失败", "failCleanup", "infrastructure_failed", 1],
  ])("%s时不公开已写入候选，并保留其他诊断", async (_name, failure, status, exitCode) => {
    state[failure] = true;
    const result = await run("coverage", { baselineCandidate: "initial-only" });
    expect(result).toMatchObject({ status, exitCode });
    const candidate = path.join(state.root, ".ci-output/coverage/initial-coverage-baseline.json");
    expect(JSON.parse(readFileSync(candidate, "utf8")).baseline).not.toBeNull();
    expect(result.reports.some((entry) => entry.path === "initial-coverage-baseline.json")).toBe(
      false,
    );
    expect(result.reports.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([
        "tests.json",
        "source-snapshot.json",
        "coverage-check.json",
        "coverage/coverage-final.json",
        "coverage/lcov.info",
        "coverage-policy.log",
        "details.json",
      ]),
    );
    if (failure === "failCleanup") {
      const details = JSON.parse(
        readFileSync(path.join(state.root, ".ci-output/coverage/details.json"), "utf8"),
      );
      expect(details.failures).toContain("CI_TEMP_CLEANUP_FAILED:EPERM");
    }
  });
  it.each(["missing", "malformed", "unmeasured"])(
    "候选输出%s时，即使子进程exit0也必须失败",
    async (fault) => {
      state.candidateFault = fault;
      const result = await run("coverage", { baselineCandidate: "initial-only" });
      expect(result.status).not.toBe("passed");
      expect(result.exitCode).not.toBe(0);
      expect(result.reports.some((entry) => entry.path === "initial-coverage-baseline.json")).toBe(
        false,
      );
      expect(result.reports.some((entry) => entry.path === "coverage-check.json")).toBe(true);
      const details = JSON.parse(
        readFileSync(path.join(state.root, ".ci-output/coverage/details.json"), "utf8"),
      );
      expect(details.commands.find((entry) => entry.name === "coverage-policy").exitCode).toBe(0);
      expect(details.failures).toHaveLength(1);
    },
  );
  it.each([
    ["coverage", "always"],
    ["coverage", true],
    ["policy", "initial-only"],
  ])("拒绝%s的非法候选模式%s，不启动命令", async (checkId, baselineCandidate) => {
    await expect(run(checkId, { baselineCandidate })).rejects.toThrow(
      "CI_INITIAL_BASELINE_CANDIDATE_OPTION_INVALID",
    );
    expect(state.calls).toEqual([]);
    expect(existsSync(path.join(state.root, ".ci-output", checkId))).toBe(false);
  });
  it("子执行器报告用例通过但进程非零时仍失败并保留报告", async () => {
    state.pipelineExitCode = 7;
    const result = await run("build", {
      matrixKey: process.platform === "darwin" ? "macos-arm64" : "linux-x64",
    });
    expect(result).toMatchObject({ status: "failed", exitCode: 7 });
    expect(result.counts.failed).toBe(0);
    expect(result.reports.some((entry) => entry.path === "build/build.json")).toBe(true);
  });
  it("安全发现和空执行不能变成通过", async () => {
    expect(await run("security")).toMatchObject({ status: "passed", retryCount: 0 });
    state.failSecurity = true;
    expect(await run("security", { output: ".ci-output/security-fail" })).toMatchObject({
      status: "failed",
      retryCount: 0,
    });
    state.empty = true;
    expect(
      (
        await run("build", {
          matrixKey: process.platform === "darwin" ? "macos-arm64" : "linux-x64",
        })
      ).status,
    ).not.toBe("passed");
  });
  it("托管平台与Node floor身份错误直接拒绝", async () => {
    const other = process.platform === "darwin" ? "linux-x64" : "macos-arm64";
    const wrong = await run("build", { matrixKey: other, hosted: true });
    expect(wrong.status).toBe("infrastructure_failed");
    expect(state.calls).toEqual([]);
    expect((await run("node-floor")).status).toBe("infrastructure_failed");
  });
});
