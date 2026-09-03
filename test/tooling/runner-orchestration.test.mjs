import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  root: "",
  calls: [],
  fail: "",
  failSecurity: false,
  empty: false,
  pipelineExitCode: 0,
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
    if (name === state.fail) return { exitCode: 7, durationMs: 1 };
    const json = args.find(
      (arg) => arg.startsWith("--outputFile.json=") || arg.startsWith("--outputFile="),
    );
    if (json) {
      const projects = args.flatMap((arg, index) => (arg === "--project" ? [args[index + 1]] : []));
      const names = {
        unit: "packages/example/src/example.unit.test.ts",
        contracts: "packages/example/src/example.contract.test.ts",
        tooling: "test/tooling/example.test.mjs",
      };
      write(json.slice(json.indexOf("=") + 1), {
        success: true,
        testResults: projects.map((project) => ({
          name: path.join(state.root, names[project]),
          assertionResults: [{ status: "passed" }],
        })),
      });
    }
    const junit = args.find((arg) => arg.startsWith("--outputFile.junit="));
    if (junit) write(junit.slice(junit.indexOf("=") + 1), "<testsuites/>\n");
    if (name === "coverage") {
      const output = args[args.indexOf("--coverage.reportsDirectory") + 1];
      write(path.join(output, "coverage-final.json"), { fixture: true });
      write(path.join(output, "lcov.info"), "TN:fixture\nend_of_record\n");
    }
    if (["coverage-snapshot", "coverage-policy"].includes(name))
      write(args[args.indexOf("--output") + 1], { status: "passed" });
    return { exitCode: 0, durationMs: 1 };
  },
}));
vi.mock("../../scripts/ci/build.mjs", () => ({
  build: async ({ output }) => {
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
      reportPath,
      checks: [{ status: state.failSecurity ? "failed" : "passed" }],
    };
  },
}));

import { createContext } from "../../scripts/ci/context.mjs";
import { repositoryRoot } from "../../scripts/ci/contracts.mjs";
import { runCheck } from "../../scripts/ci/run.mjs";

let context;
beforeEach(() => {
  state.root = mkdtempSync(path.join(os.tmpdir(), "himawari-orchestration-"));
  state.calls = [];
  state.fail = "";
  state.failSecurity = false;
  state.empty = false;
  state.pipelineExitCode = 0;
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
  write(path.join(state.root, "npm.mjs"), "process.stdout.write('11.8.0')");
  context = createContext({ root: state.root });
});
afterEach(() => rmSync(state.root, { recursive: true, force: true }));
const run = (checkId, extra = {}) =>
  runCheck({
    root: state.root,
    context,
    checkId,
    output: `.ci-output/${checkId}`,
    toolsDirectory: state.root,
    hosted: false,
    ...extra,
  });

describe("共享runner的调度、来源和失败传播", () => {
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
  it("coverage先绑定源码快照，三个project合并后再判定覆盖率", async () => {
    const result = await run("coverage");
    expect(result.status).toBe("passed");
    expect(result.projects.map((entry) => entry.id)).toEqual(["unit", "contracts", "tooling"]);
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
    expect((await run("security")).status).toBe("passed");
    state.failSecurity = true;
    expect((await run("security", { output: ".ci-output/security-fail" })).status).toBe("failed");
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
