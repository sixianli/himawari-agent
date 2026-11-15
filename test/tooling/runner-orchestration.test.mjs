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

import { withHost } from "./artifact-host.mjs";

vi.mock("../../scripts/ci/platforms.mjs", async (original) =>
  (await import("./artifact-host.mjs")).artifactCapablePlatforms(await original()),
);
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
        [new Error("primary build failure"), new Error(`cleanup Bearer ${"s".repeat(32)}`)],
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
  runTests: async ({ output, artifact, projects, related, shard }) => {
    state.related = related;
    state.shard = shard;
    const report = path.join(output, "tests.json");
    write(report, { status: "passed" });
    return {
      artifact: { path: artifact },
      exitCode: state.pipelineExitCode,
      counts: {
        files: projects.length,
        executed: projects.length,
        passed: projects.length,
        failed: 0,
        skipped: 0,
      },
      projects: projects.map((id) => ({
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
      checks: state.failSecurity
        ? [
            { id: "gitleaks", status: "passed" },
            { id: "semgrep", status: "infrastructure_failed", error: "SECURITY_SCANNER_FAILED" },
            {
              id: "security-exceptions",
              status: "infrastructure_failed",
              error: "Unexpected token } in JSON at position 41 of the reviewed baseline",
            },
          ]
        : [{ id: "gitleaks", status: "passed" }],
    };
  },
}));

import { createContext } from "../../scripts/ci/context.mjs";
import { repositoryRoot, sha256 } from "../../scripts/ci/contracts.mjs";
import { startHostLoad } from "../../scripts/ci/host-load.mjs";
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
    ...(checkId === "tests"
      ? {
          matrixKey: "others",
          artifact: path.join(state.root, "runtime.tar.gz"),
          coverage: "measure",
        }
      : {}),
    ...extra,
  });

describe("共享runner的调度、来源和失败传播", () => {
  it("passes an explicit test root and its temporary directory to child processes", async () => {
    vi.stubEnv("HIMAWARI_TEST_TEMP_ROOT", state.root);
    try {
      const result = await run("policy");
      expect(result.status).toBe("passed");
      const childEnvironment = state.calls[0].env;
      const childTemporaryDirectory = execFileSync(
        process.execPath,
        ["-p", "require('node:os').tmpdir()"],
        { env: childEnvironment, encoding: "utf8" },
      ).trim();
      expect(path.dirname(childTemporaryDirectory)).toBe(state.root);
      expect(path.basename(childTemporaryDirectory)).toMatch(/^hci-/);
      expect(childEnvironment.HIMAWARI_TEST_TEMP_ROOT).toBe(state.root);
      expect(existsSync(childTemporaryDirectory)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

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
      const pending = run("tests");
      try {
        await state.parallel.coverageReached.promise;
        expect(state.parallel.started).toBe(true);
        expect(existsSync(state.parallel.owned)).toBe(true);
        expect(state.calls.some(({ name }) => name === "coverage-policy")).toBe(false);
        state.parallel.releaseCoverage.resolve();
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
  it("[ADR-0267] tooling 只跑 tooling 测试，不跑 policy 检查", async () => {
    const result = await run("tooling");
    expect(result.status).toBe("passed");
    expect(result.projects.map((entry) => entry.id)).toEqual(["tooling"]);
    expect(state.calls.map((entry) => entry.name)).toEqual(["vitest-tooling"]);
  });
  it("[ADR-0267] tests 不带 --coverage measure 时只跑测试，不量覆盖率", async () => {
    const result = await run("tests", { coverage: undefined });
    expect(result.status).toBe("passed");
    expect(state.calls.map(({ name }) => name)).toEqual([]);
    expect(result.projects.map(({ id }) => id)).toEqual(["unit", "contracts", "e2e", "pi-compat"]);
    expect(state.shard).toBeUndefined();
    expect(result.reports.some((entry) => entry.path.includes("coverage-final.json"))).toBe(false);
    const declared = JSON.parse(readFileSync("ci/policy.json", "utf8")).checks.find(
      (check) => check.id === "tests",
    ).outputs;
    for (const kind of declared)
      expect([kind, result.reports.some((entry) => entry.kind === kind)]).toEqual([kind, true]);
  });
  it("[ADR-0268] PR 上 tooling 没有相关测试时不启动 vitest，结果记下相关范围和零计数", async () => {
    const result = await run("tooling", {
      planScope: () => ({ related: new Map([["tooling", []]]), reason: "related" }),
    });
    expect(
      JSON.parse(readFileSync(path.join(state.root, ".ci-output/tooling/details.json"), "utf8")),
    ).toMatchObject({ failures: [] });
    expect(result.status).toBe("passed");
    expect(state.calls).toEqual([]);
    expect(result.relatedProjects).toEqual(["tooling"]);
    expect(result.projects).toEqual([
      { id: "tooling", counts: { files: 0, executed: 0, passed: 0, failed: 0, skipped: 0 } },
    ]);
  });
  it("[ADR-0268] tooling 只把相关测试文件交给 vitest；不是相关范围时不带文件", async () => {
    await run("tooling", {
      planScope: () => ({
        related: new Map([["tooling", ["test/tooling/example.test.mjs"]]]),
        reason: "related",
      }),
    });
    expect(state.calls[0].args.at(-1)).toBe("test/tooling/example.test.mjs");
    state.calls.length = 0;
    const full = await run("tooling", {
      output: ".ci-output/tooling-full",
      planScope: () => ({ related: new Map(), reason: "full-event" }),
    });
    expect(state.calls[0].args.at(-1)).toMatch(/^--outputFile\.junit=/);
    expect(full.relatedProjects).toBeUndefined();
  });
  it("[ADR-0268] tests 不量覆盖率时把相关范围交给 runTests，量覆盖率时不选范围", async () => {
    const asked = [];
    const planScope = ({ projects }) => {
      asked.push(projects);
      return { related: new Map([["integration", []]]), reason: "related" };
    };
    const plain = await run("tests", {
      coverage: undefined,
      matrixKey: "integration-2",
      planScope,
    });
    expect(asked).toEqual([["integration"]]);
    expect([...state.related]).toEqual([["integration", []]]);
    expect(state.shard).toEqual({ index: 2, count: 2 });
    expect(plain.relatedProjects).toEqual(["integration"]);
    await run("tests", {
      output: ".ci-output/tests-measure",
      matrixKey: "integration-2",
      planScope,
    });
    expect(asked).toHaveLength(1);
    expect(state.related.size).toBe(0);
    expect(state.shard).toBeUndefined();
  });
  it.each([
    ["policy", "measure"],
    ["tests", "always"],
  ])("[ADR-0267] 拒绝%s的覆盖率选项%s，不启动命令", async (checkId, coverage) => {
    await expect(run(checkId, { coverage })).rejects.toThrow("CI_COVERAGE_OPTION_INVALID");
    expect(state.calls).toEqual([]);
  });
  it("tests 在缺少构建归档时拒绝启动", async () => {
    await expect(run("tests", { artifact: undefined })).rejects.toThrow("CI_ARTIFACT_REQUIRED");
    expect(state.calls).toEqual([]);
  });

  it("rejects scheduled quality before creating or executing a required CI check", async () => {
    await expect(run("policy", { context: { ...context, event: "schedule" } })).rejects.toThrow(
      "CI_EVENT_UNSUPPORTED",
    );
    expect(state.calls).toEqual([]);
    expect(existsSync(path.join(state.root, ".ci-output/policy"))).toBe(false);
  });
  it("rejects build, browser and tests on linux-arm64 before creating output or executing anything", async () => {
    await withHost("linux", "arm64", async () => {
      for (const checkId of ["build", "browser", "tests"]) {
        await expect(run(checkId)).rejects.toThrow("CI_ARTIFACT_PLATFORM_UNSUPPORTED: linux-arm64");
        expect(existsSync(path.join(state.root, `.ci-output/${checkId}`))).toBe(false);
      }
      expect(state.calls).toEqual([]);
    });
  });

  it("tests 在归档身份不符时失败，不开始快照或测试", async () => {
    state.artifactFailure = true;
    const result = await run("tests");
    expect(result.status).toBe("infrastructure_failed");
    expect(state.calls).toEqual([]);
    expect(state.verified[0].context).toEqual(context);
  });
  it("tests 量覆盖率时使用已核验的归档和同次 context，记录消费摘要", async () => {
    const result = await run("tests");
    expect(result.status).toBe("passed");
    const collection = state.calls.find(({ name }) => name === "coverage");
    expect(collection.env.HIMAWARI_TEST_ARTIFACT).toBe(
      path.join(state.root, ".ci-output/tests/runtime.tar.gz"),
    );
    expect(JSON.parse(readFileSync(collection.env.HIMAWARI_TEST_CONTEXT, "utf8"))).toEqual(context);
    expect(result.artifacts[0]).toMatchObject({
      role: "consumed",
      sha256: sha256("artifact fixture"),
    });
    expect(collection.args).toContain("integration");
  });
  it("policy只校验固定合同，不跑测试；子进程不继承凭据", async () => {
    const result = await run("policy");
    expect(result.status).toBe("passed");
    expect(result.projects).toEqual([]);
    expect(state.calls.map((entry) => entry.name)).toEqual(["policy", "toolchain"]);
    expect(state.calls[0].args).toContain(context.baseSha);
    expect(state.calls[0].env).not.toHaveProperty("OPENAI_API_KEY");
    expect(state.calls[0].env.HOME).toContain(".ci-output");
  });
  it.each(["failed", "passed", "missing", "malformed"])(
    "tooling 保留失败进程的退出码与有效测试计数：%s",
    async (report) => {
      state.testReportFailure = report;
      const result = await run("tooling");
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
        readFileSync(path.join(state.root, ".ci-output/tooling/details.json"), "utf8"),
      );
      expect(details.failures).toContain("CI_COMMAND_FAILED:vitest-tooling");
      if (report === "malformed")
        expect(
          details.failures.some((failure) => failure.startsWith("CI_TEST_REPORT_INVALID:tooling:")),
        ).toBe(true);
    },
  );
  it.each(["failed", "passed", "missing", "malformed"])(
    "覆盖率进程失败时保留实际测试计数与退出码，e2e 和 pi-compat 照常执行：%s",
    async (report) => {
      state.testReportFailure = report;
      const result = await run("tests");
      expect(result).toMatchObject({ status: "failed", exitCode: 7 });
      expect(result.counts).toEqual(
        report === "failed"
          ? { files: 5, executed: 8, passed: 5, failed: 3, skipped: 0 }
          : report === "passed"
            ? { files: 5, executed: 5, passed: 5, failed: 0, skipped: 0 }
            : { files: 2, executed: 2, passed: 2, failed: 0, skipped: 0 },
      );
      expect(result.projects.map(({ id }) => id)).toEqual(
        ["failed", "passed"].includes(report)
          ? ["unit", "contracts", "integration", "e2e", "pi-compat"]
          : ["e2e", "pi-compat"],
      );
      expect(state.calls.map(({ name }) => name)).toEqual(["coverage-snapshot", "coverage"]);
      const details = JSON.parse(
        readFileSync(path.join(state.root, ".ci-output/tests/details.json"), "utf8"),
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
  it("覆盖率通过而 e2e、pi-compat 进程非零时记为测试失败并保留它的退出码", async () => {
    state.pipelineExitCode = 3;
    const result = await run("tests");
    expect(result).toMatchObject({ status: "failed", exitCode: 3 });
    expect(result.projects.map(({ id }) => id)).toEqual([
      "unit",
      "contracts",
      "integration",
      "e2e",
      "pi-compat",
    ]);
    const details = JSON.parse(
      readFileSync(path.join(state.root, ".ci-output/tests/details.json"), "utf8"),
    );
    expect(details.failures).toContain("CI_TEST_INCOMPLETE:e2e,pi-compat");
  });
  it("只有覆盖率比较失败而 e2e、pi-compat 进程非零时保留 e2e、pi-compat 的退出码", async () => {
    const released = () => ({ promise: Promise.resolve(), resolve: () => {} });
    state.parallel = {
      started: false,
      coverageReached: released(),
      releaseCoverage: released(),
      releaseComparison: released(),
      failComparison: true,
    };
    state.pipelineExitCode = 3;
    const result = await run("tests");
    expect(result).toMatchObject({ status: "failed", exitCode: 3 });
    const details = JSON.parse(
      readFileSync(path.join(state.root, ".ci-output/tests/details.json"), "utf8"),
    );
    expect(details.failures).toEqual(
      expect.arrayContaining(["CI_COMPARISON_FIXTURE_FAILED", "CI_TEST_INCOMPLETE:e2e,pi-compat"]),
    );
  });
  it("覆盖率进程和 e2e、pi-compat 都失败时保留覆盖率进程的退出码", async () => {
    state.testReportFailure = "failed";
    state.pipelineExitCode = 3;
    const result = await run("tests");
    expect(result).toMatchObject({ status: "failed", exitCode: 7 });
    const details = JSON.parse(
      readFileSync(path.join(state.root, ".ci-output/tests/details.json"), "utf8"),
    );
    expect(details.failures).toEqual(
      expect.arrayContaining(["CI_COMMAND_FAILED:coverage", "CI_TEST_INCOMPLETE:e2e,pi-compat"]),
    );
  });
  it("static调用原有检查和actionlint，不执行报告中的shell", async () => {
    const result = await run("static");
    expect(result.status).toBe("passed");
    expect(result.counts.executed).toBe(3);
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
  it("同一归档的build、browser分别记录produced/consumed身份", async () => {
    const platform = process.platform === "darwin" ? "macos-arm64" : "linux-x64";
    const build = await run("build", { matrixKey: platform });
    const artifact = path.join(state.root, ".ci-output/build", build.artifacts[0].path);
    const browser = await run("browser", { matrixKey: "chromium", artifact });
    expect([build, browser].map((result) => result.status)).toEqual(["passed", "passed"]);
    expect(browser.artifacts[0].sha256).toBe(build.artifacts[0].sha256);
    expect(build.artifacts[0].role).toBe("produced");
    expect(browser.artifacts[0].role).toBe("consumed");
  });
  it("coverage先绑定源码快照，四个project合并后再判定覆盖率", async () => {
    const result = await run("tests");
    expect(result.status).toBe("passed");
    expect(result.projects.map((entry) => entry.id)).toEqual([
      "unit",
      "contracts",
      "integration",
      "e2e",
      "pi-compat",
    ]);
    expect(state.calls.map((entry) => entry.name)).toEqual([
      "coverage-snapshot",
      "coverage",
      "coverage-policy",
    ]);
    expect(
      state.calls[1].args.filter((_arg, index, args) => args[index - 1] === "--project"),
    ).toEqual(["unit", "contracts", "tooling", "integration"]);
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
    const result = await run("tests", { baselineCandidate: "initial-only" });
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
      path.join(state.root, ".ci-output/tests/initial-coverage-baseline.json"),
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
    const result = await run("tests", { baselineCandidate: "initial-only" });
    expect(result).toMatchObject({ status: "passed", initialization: false });
    expect(state.calls.map(({ name }) => name)).toEqual([
      "coverage-snapshot",
      "coverage",
      "coverage-policy",
    ]);
    expect(state.calls[2].args).not.toContain("--mode");
    expect(state.calls[2].args).not.toContain("--baseline-output");
    expect(
      existsSync(path.join(state.root, ".ci-output/tests/initial-coverage-baseline.json")),
    ).toBe(false);
    expect(result.reports.some((entry) => entry.path === "initial-coverage-baseline.json")).toBe(
      false,
    );
    expect(readFileSync(path.join(state.root, "ci/coverage-policy.json"))).toEqual(baseline);
  });
  it("覆盖率判定失败保留非零退出码但不登记不存在的候选", async () => {
    state.fail = "coverage-policy";
    const result = await run("tests", { baselineCandidate: "initial-only" });
    expect(result).toMatchObject({ status: "failed", exitCode: 7 });
    expect(result.reports.some((entry) => entry.path === "coverage-policy.log")).toBe(true);
    expect(result.reports.some((entry) => entry.path === "initial-coverage-baseline.json")).toBe(
      false,
    );
    expect(
      existsSync(path.join(state.root, ".ci-output/tests/initial-coverage-baseline.json")),
    ).toBe(false);
  });
  it.each([
    ["候选写完后子进程非零", "writtenCandidateFailure", "failed", 7],
    ["后续临时目录清理失败", "failCleanup", "infrastructure_failed", 1],
  ])("%s时不公开已写入候选，并保留其他诊断", async (_name, failure, status, exitCode) => {
    state[failure] = true;
    const result = await run("tests", { baselineCandidate: "initial-only" });
    expect(result).toMatchObject({ status, exitCode });
    const candidate = path.join(state.root, ".ci-output/tests/initial-coverage-baseline.json");
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
        readFileSync(path.join(state.root, ".ci-output/tests/details.json"), "utf8"),
      );
      expect(details.failures).toContain("CI_TEMP_CLEANUP_FAILED:EPERM");
    }
  });
  it.each(["missing", "malformed", "unmeasured"])(
    "候选输出%s时，即使子进程exit0也必须失败",
    async (fault) => {
      state.candidateFault = fault;
      const result = await run("tests", { baselineCandidate: "initial-only" });
      expect(result.status).not.toBe("passed");
      expect(result.exitCode).not.toBe(0);
      expect(result.reports.some((entry) => entry.path === "initial-coverage-baseline.json")).toBe(
        false,
      );
      expect(result.reports.some((entry) => entry.path === "coverage-check.json")).toBe(true);
      const details = JSON.parse(
        readFileSync(path.join(state.root, ".ci-output/tests/details.json"), "utf8"),
      );
      expect(details.commands.find((entry) => entry.name === "coverage-policy").exitCode).toBe(0);
      expect(details.failures).toHaveLength(1);
    },
  );
  it.each([
    ["tests", "always"],
    ["tests", true],
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
    const written = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      expect(await run("security", { output: ".ci-output/security-fail" })).toMatchObject({
        status: "failed",
        retryCount: 0,
      });
      expect(written.mock.calls.map(([text]) => text)).toEqual([
        "security scan semgrep: infrastructure_failed SECURITY_SCANNER_FAILED\n",
        "security scan security-exceptions: infrastructure_failed\n",
      ]);
    } finally {
      written.mockRestore();
    }
    state.empty = true;
    expect(
      (
        await run("build", {
          matrixKey: process.platform === "darwin" ? "macos-arm64" : "linux-x64",
        })
      ).status,
    ).not.toBe("passed");
  });
  it("托管平台身份错误直接拒绝，退役的 node-floor 和 test 检查不再受理", async () => {
    const other = process.platform === "darwin" ? "linux-x64" : "macos-arm64";
    const wrong = await run("build", { matrixKey: other, hosted: true });
    expect(wrong.status).toBe("infrastructure_failed");
    expect(state.calls).toEqual([]);
    await expect(run("node-floor")).rejects.toThrow("CI_CHECK_UNSUPPORTED:node-floor");
    await expect(run("test")).rejects.toThrow("CI_CHECK_UNSUPPORTED:test");
  });
});

describe("job log records how busy the machine was", () => {
  it("CI_HOST_LOAD 一行写明核数、平均和峰值负载、内存峰值和采样数", () => {
    const loads = [1, 3, 2];
    let clock = 0;
    const stop = startHostLoad({
      intervalMs: 3_600_000,
      loadAverage: () => loads.shift() ?? 2,
      freeMemory: () => 6 * 1024 ** 3,
      totalMemory: () => 8 * 1024 ** 3,
      cpuCount: () => 4,
      now: () => {
        clock += 30_000;
        return clock;
      },
    });
    expect(stop()).toBe(
      "CI_HOST_LOAD cpus=4 loadAvg1Mean=2.00 loadAvg1Peak=3.00 loadPerCpuMean=0.50 memUsedPeakMiB=2048 memTotalMiB=8192 samples=2 seconds=30",
    );
  });
});
