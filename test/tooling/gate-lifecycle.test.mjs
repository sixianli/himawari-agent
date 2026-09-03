import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

const state = vi.hoisted(() => ({
  root: "",
  calls: [],
  admissions: [],
  mockAdmission: false,
  fail: "",
  exitCode: 0,
  installationError: false,
}));
const originalRoot = path.resolve(import.meta.dirname, "../..");
const write = (filename, value) => {
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
};
const count = () => ({ files: 1, executed: 1, passed: 1, failed: 0, skipped: 0 });
vi.mock("../../scripts/ci/contracts.mjs", async (original) => ({
  ...(await original()),
  get repositoryRoot() {
    return state.root;
  },
}));
vi.mock("../../scripts/ci/install-tools.mjs", async (original) => ({
  ...(await original()),
  verifyInstalledTools: (options) => {
    state.calls.push({ name: "tools", ...options });
    if (state.installationError) throw new Error("controlled unverified installation");
    return {
      node: process.versions.node,
      executables: {
        node: process.execPath,
        npmCli: path.join(state.root, "npm.mjs"),
        python: "/fixture/verified/python",
        actionlint: "/fixture/actionlint",
      },
    };
  },
}));
vi.mock("../../scripts/ci/security-redaction.mjs", async (original) => {
  const actual = await original();
  return {
    ...actual,
    assertPublicArtifacts: async (options) => {
      state.admissions.push(options);
      return state.mockAdmission ? options.entries : actual.assertPublicArtifacts(options);
    },
  };
});
vi.mock("../../scripts/ci/execute.mjs", async (original) => ({
  ...(await original()),
  execute: async (executable, args, options) => {
    const name = path.basename(options.log, ".log");
    const temporary = options.env?.TMPDIR;
    state.calls.push({
      name,
      executable,
      args,
      options,
      temporary: temporary && {
        path: realpathSync(temporary),
        mode: statSync(temporary).mode & 0o777,
      },
    });
    write(options.log, "controlled child log\n");
    if (name === state.fail) return { exitCode: 9, durationMs: 1 };
    const report = args.find(
      (arg) => arg.startsWith("--outputFile.json=") || arg.startsWith("--outputFile="),
    );
    if (report) {
      const names = {
        unit: "packages/example/test/a.unit.test.ts",
        contracts: "packages/example/test/a.contract.test.ts",
        tooling: "test/tooling/a.test.mjs",
        "qualification-scale": "test/integration/scale-qualification.test.ts",
      };
      const projects = args.flatMap((arg, index) => (arg === "--project" ? [args[index + 1]] : []));
      write(report.slice(report.indexOf("=") + 1), {
        success: true,
        testResults: projects.map((project) => ({
          name: path.join(state.root, names[project]),
          assertionResults: [{ status: "passed" }],
        })),
      });
    }
    const junit = args.find((arg) => arg.startsWith("--outputFile.junit="));
    if (junit) write(junit.slice(junit.indexOf("=") + 1), "<testsuites/>\n");
    if (options.env?.HIMAWARI_SCALE_EVIDENCE_PATH)
      write(options.env.HIMAWARI_SCALE_EVIDENCE_PATH, { fixture: "controlled measurement" });
    return { exitCode: 0, durationMs: 1 };
  },
}));
vi.mock("../../scripts/ci/build.mjs", () => ({
  build: async ({ output }) => {
    const archive = write(path.join(output, "runtime.tar.gz"), "synthetic archive");
    const report = write(path.join(output, "build.json"), { status: "passed" });
    return {
      exitCode: state.exitCode,
      archive,
      counts: count(),
      reports: [
        { path: report, kind: "json" },
        { path: archive, kind: "artifact" },
      ],
    };
  },
}));
vi.mock("../../scripts/ci/test.mjs", () => ({
  runTests: async ({ output, artifact }) => {
    const report = write(path.join(output, "tests.json"), { status: "passed" });
    const junit = write(path.join(output, "tests.xml"), "<testsuites/>\n");
    const projects = ["unit", "contracts", "integration", "e2e", "pi-compat"].map((id) => ({
      id,
      counts: count(),
    }));
    return {
      exitCode: state.exitCode,
      artifact: { path: artifact },
      counts: { files: 5, executed: 5, passed: 5, failed: 0, skipped: 0 },
      projects,
      reports: [
        { path: report, kind: "json" },
        { path: junit, kind: "junit" },
      ],
    };
  },
}));

import { aggregate, readReportEnvelopes } from "../../scripts/ci/aggregate.mjs";
import { createContext } from "../../scripts/ci/context.mjs";
import {
  expectedMembers,
  fileSha256,
  githubExpression,
  readJson,
} from "../../scripts/ci/contracts.mjs";
import { publish, publishQuality } from "../../scripts/ci/publish.mjs";
import { reportEntry } from "../../scripts/ci/run.mjs";

let context;
beforeEach(() => {
  state.root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "himawari-gate-lifecycle-")));
  state.calls = [];
  state.admissions = [];
  state.mockAdmission = false;
  state.fail = "";
  state.exitCode = 0;
  state.installationError = false;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-03T12:00:00Z"));
  const git = (...args) => execFileSync("git", args, { cwd: state.root, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.name", "Gate fixture");
  git("config", "user.email", "gate@example.invalid");
  write(path.join(state.root, "README.md"), "synthetic lifecycle fixture\n");
  git("add", "README.md");
  git("commit", "-qm", "fixture base");
  mkdirSync(path.join(state.root, "ci"));
  for (const file of readdirSync(path.join(originalRoot, "ci")).filter((name) =>
    name.endsWith(".json"),
  ))
    copyFileSync(path.join(originalRoot, "ci", file), path.join(state.root, "ci", file));
  write(path.join(state.root, "npm.mjs"), "process.stdout.write('11.8.0')");
  vi.stubEnv("GITHUB_ACTIONS", "false");
  vi.stubEnv("HIMAWARI_CI_PYTHON", "");
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  context = createContext({ root: state.root, env: {} });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.exitCode = 0;
  rmSync(state.root, { recursive: true, force: true });
});
async function entry(filename, args) {
  const previous = process.argv;
  process.argv = [process.execPath, path.join(originalRoot, "scripts/ci", filename), ...args];
  try {
    vi.resetModules();
    const moduleName = filename.slice(0, -4);
    return await import(`../../scripts/ci/${moduleName}.mjs`);
  } finally {
    process.argv = previous;
  }
}
const platform = () => (process.platform === "darwin" ? "macos-arm64" : "linux-x64");
function reportFixture(extraReports = {}) {
  const input = path.join(state.root, ".ci-output/input");
  const items = [];
  for (const [name, [kind, content]] of Object.entries({
    "details.json": ["json", { status: "passed" }],
    ...extraReports,
  }))
    items.push(reportEntry(write(path.join(input, name), content), kind, input));
  const result = {
    schemaVersion: 1,
    checkId: "policy",
    matrixKey: "default",
    ...context,
    toolchain: {
      node: "22.22.3",
      npm: "11.8.0",
      os: "linux",
      arch: "x64",
      abi: "127",
      runnerImage: "fixture",
    },
    status: "passed",
    exitCode: 0,
    durationMs: 1,
    retryCount: 0,
    counts: count(),
    projects: [{ id: "tooling", counts: count() }],
    reports: items,
    artifacts: [],
  };
  write(path.join(input, "result.json"), result);
  return { input, result };
}
function gateFixture(event = "workflow_dispatch") {
  const policy = readJson(path.join(state.root, "ci/policy.json")),
    lock = readJson(path.join(state.root, "ci/toolchain-lock.json"));
  const identity = { ...context, event };
  const reports = path.join(state.root, ".ci-output/reports"),
    gate = path.join(state.root, ".ci-output/source-gate");
  for (const { check, member } of expectedMembers(policy)) {
    const output = path.join(reports, check.id, member.key),
      projects = check.projects.map((id) => ({ id, counts: count() })),
      total = Math.max(1, projects.length),
      artifactPlatform = check.id === "browser" ? "linux-x64" : member.key;
    const items = check.outputs.map((kind) => {
      const name = check.id === "security" ? "security-report.json" : `report.${kind}`;
      const contents =
        kind === "artifact"
          ? `synthetic archive ${artifactPlatform}`
          : check.id === "security"
            ? { status: "passed", scannedAt: new Date().toISOString(), context: identity }
            : { fixture: true };
      return reportEntry(write(path.join(output, name), contents), kind, output);
    });
    const archive = items.find((item) => item.kind === "artifact");
    write(path.join(output, "result.json"), {
      schemaVersion: 1,
      checkId: check.id,
      matrixKey: member.key,
      ...identity,
      toolchain: {
        node: member.node,
        npm: lock.npm.version,
        os: member.os,
        arch: member.arch,
        abi: "127",
        runnerImage: "fixture",
      },
      status: "passed",
      exitCode: 0,
      durationMs: 1,
      retryCount: 0,
      counts: { files: total, executed: total, passed: total, failed: 0, skipped: 0 },
      projects,
      reports: items,
      artifacts: archive
        ? [
            {
              role: check.id === "build" ? "produced" : "consumed",
              platform: artifactPlatform,
              path: archive.path,
              sha256: archive.sha256,
            },
          ]
        : [],
    });
  }
  const needs = Object.fromEntries(
    policy.checks
      .filter((check) => check.id !== "required")
      .map((check) => [check.id, { result: "success" }]),
  );
  const summary = aggregate({
    policy,
    context: identity,
    needs,
    reports: readReportEnvelopes(reports),
    toolchainLock: lock,
  });
  expect(summary.status).toBe("passed");
  write(path.join(gate, "context.json"), identity);
  write(path.join(gate, "needs.json"), needs);
  write(path.join(gate, "summary.json"), summary);
  const metadata = {
    id: Number(identity.runId),
    run_attempt: identity.attempt,
    head_sha: identity.testedSha,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    repository: { full_name: identity.repository },
    path: ".github/workflows/ci.yml",
    html_url: `https://github.com/${identity.repository}/actions/runs/${identity.runId}`,
    created_at: new Date(Date.now() - 1000).toISOString(),
  };
  return { reports, gate, needs, identity, metadata };
}

describe("publication admission is atomic and workflow-bound", { timeout: 30000 }, () => {
  it("keeps rejected binary reports private and removes every staging directory", async () => {
    const sentinel = "synthetic-private-material",
      { input } = reportFixture({ "failure.png": ["diagnostic", sentinel] });
    await expect(
      publish({ root: state.root, input, output: ".ci-output/public", sentinels: [sentinel] }),
    ).rejects.toThrow("CONTAINS_SECRET");
    expect(existsSync(path.join(state.root, ".ci-output/public"))).toBe(false);
    expect(
      readdirSync(path.join(state.root, ".ci-output")).some((name) => name.startsWith(".publish-")),
    ).toBe(false);
    expect(readFileSync(path.join(input, "failure.png"), "utf8")).toBe(sentinel);
  });
  it("publishes a complete security report, verifies its source digest and rejects later mutation", async () => {
    const input = path.join(state.root, ".ci-output/quality"),
      report = write(path.join(input, "security/security-report.json"), {
        findings: [{ id: "synthetic-advisory" }],
        scannedAt: new Date().toISOString(),
      });
    write(path.join(input, "quality.json"), {
      commands: [],
      observations: [{ reports: [{ path: report, kind: "json", sha256: fileSha256(report) }] }],
    });
    const entries = await publishQuality({
      root: state.root,
      input,
      output: ".ci-output/quality-public",
    });
    expect(entries.some((item) => item.path === "reports/security/security-report.json")).toBe(
      true,
    );
    expect(
      readJson(
        path.join(state.root, ".ci-output/quality-public/reports/security/security-report.json"),
      ).findings,
    ).toHaveLength(1);
    write(report, { changed: true });
    await expect(
      publishQuality({ root: state.root, input, output: ".ci-output/tampered" }),
    ).rejects.toThrow("REPORT_CHANGED");
    expect(existsSync(path.join(state.root, ".ci-output/tampered"))).toBe(false);
  });
  it("CLI obtains verified Python explicitly and never relies on an inherited interpreter", async () => {
    const { input } = reportFixture({ "runtime.tar.gz": ["artifact", "synthetic archive"] });
    state.mockAdmission = true;
    await entry("publish.mjs", [
      "--input",
      input,
      "--output",
      ".ci-output/cli-public",
      "--tools",
      path.join(state.root, "tools"),
    ]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(state.admissions.at(-1).python).toBe("/fixture/verified/python");
    expect(state.calls.some((call) => call.name === "tools")).toBe(true);
    state.installationError = true;
    await entry("publish.mjs", [
      "--input",
      input,
      "--output",
      ".ci-output/unverified",
      "--tools",
      path.join(state.root, "tools"),
    ]);
    expect(process.exitCode).toBe(1);
    expect(existsSync(path.join(state.root, ".ci-output/unverified"))).toBe(false);
  });
  it("CLI rejects missing/unknown modes and keeps the quality admission path explicit", async () => {
    await entry("publish.mjs", []);
    expect(process.exitCode).toBe(1);
    const input = path.join(state.root, ".ci-output/quality");
    write(path.join(input, "quality.json"), { observations: [], commands: [] });
    process.exitCode = 0;
    await entry("publish.mjs", [
      "--input",
      input,
      "--output",
      ".ci-output/quality-public",
      "--mode",
      "quality",
    ]);
    expect(
      existsSync(path.join(state.root, ".ci-output/quality-public/reports/quality.json")),
    ).toBe(true);
    await entry("publish.mjs", [
      "--input",
      input,
      "--output",
      ".ci-output/bad-mode",
      "--mode",
      "unknown",
    ]);
    expect(process.exitCode).toBe(1);
    expect(existsSync(path.join(state.root, ".ci-output/bad-mode"))).toBe(false);
  });
  it("every public upload in both workflows requires successful admission and explicit tool identity", () => {
    for (const name of ["ci.yml", "quality.yml"]) {
      const workflow = parse(
        readFileSync(path.join(originalRoot, ".github/workflows", name), "utf8"),
      );
      let publishers = 0;
      for (const job of Object.values(workflow.jobs)) {
        const publisher = job.steps.find((step) => step.run?.includes("scripts/ci/publish.mjs"));
        if (!publisher) continue;
        publishers++;
        expect(publisher.id).toBe("publish");
        expect(publisher.run).toContain("--tools .ci-output/tools");
        for (const step of job.steps.filter(
          (step) =>
            step.uses?.startsWith("actions/upload-artifact@") &&
            step.with.path.startsWith(".ci-output/public/"),
        ))
          expect(step.if).toBe(githubExpression("always() && steps.publish.outcome == 'success'"));
      }
      expect(publishers).toBe(name === "ci.yml" ? 8 : 5);
    }
  });
});

describe(
  "real entrypoints preserve context, outcome and evidence identity",
  { timeout: 30000 },
  () => {
    it.each(["policy", "scale"])(
      "%s uses a short private temporary directory outside a long checkout and cleans both outcomes",
      async (check) => {
        const previousRoot = state.root;
        state.root = `${previousRoot}-${"x".repeat(120)}`;
        renameSync(previousRoot, state.root);
        expect(Buffer.byteLength(state.root)).toBeGreaterThan(150);
        const callerTemporary = path.join(state.root, "caller-temporary");
        mkdirSync(callerTemporary);
        vi.stubEnv("TMPDIR", callerTemporary);
        const temporaryDirectories = new Set();
        for (const fails of [false, true]) {
          state.calls = [];
          state.fail = fails ? check : "";
          const output = `.ci-output/${check}-${fails ? "failure" : "success"}`;
          await entry(check === "policy" ? "run.mjs" : "quality.mjs", [
            "--check",
            check,
            "--tools",
            path.join(state.root, "tools"),
            "--base",
            context.baseSha,
            "--output",
            output,
          ]);
          const report = readJson(
            path.join(state.root, output, check === "policy" ? "result.json" : "quality.json"),
          );
          expect(report.status).toBe(fails ? "failed" : "passed");
          const children = state.calls.filter((call) => call.options?.env);
          expect(children.length).toBeGreaterThan(0);
          const paths = new Set(children.map((call) => call.temporary.path));
          expect(paths.size).toBe(1);
          for (const child of children) {
            expect(child.temporary.mode).toBe(0o700);
            expect(Buffer.byteLength(child.temporary.path)).toBeLessThan(50);
            expect(path.relative(state.root, child.temporary.path).startsWith("..")).toBe(true);
            expect(existsSync(child.temporary.path)).toBe(false);
            temporaryDirectories.add(child.temporary.path);
          }
          expect(process.env.TMPDIR).toBe(callerTemporary);
          expect(existsSync(callerTemporary)).toBe(true);
        }
        expect(temporaryDirectories.size).toBe(2);
      },
    );
    it("context CLI writes a verifiable fresh record and refuses missing or reused outputs", async () => {
      await entry("context.mjs", [
        "--base",
        context.baseSha,
        "--output",
        ".ci-output/context.json",
      ]);
      const actual = readJson(path.join(state.root, ".ci-output/context.json"));
      expect(actual).toEqual(context);
      await entry("context.mjs", ["--output", ".ci-output/context.json"]);
      expect(process.exitCode).toBe(1);
      expect(readJson(path.join(state.root, ".ci-output/context.json"))).toEqual(context);
      await entry("context.mjs", []);
      expect(process.exitCode).toBe(1);
    });
    it("artifact CLI appends only the platform's immutable numeric ID and rejects absent output", async () => {
      const output = path.join(state.root, "github-output");
      vi.stubEnv("GITHUB_OUTPUT", output);
      vi.stubEnv("CI_MATRIX", "linux-x64");
      vi.stubEnv("CI_ARTIFACT_ID", "123");
      await entry("artifact-output.mjs", []);
      expect(readFileSync(output, "utf8")).toBe("linux=123\n");
      vi.stubEnv("CI_MATRIX", "macos-arm64");
      vi.stubEnv("CI_ARTIFACT_ID", "456");
      await entry("artifact-output.mjs", []);
      expect(readFileSync(output, "utf8")).toBe("linux=123\nmacos=456\n");
      vi.stubEnv("GITHUB_OUTPUT", "");
      await entry("artifact-output.mjs", []);
      expect(process.exitCode).toBe(1);
      expect(readFileSync(output, "utf8")).not.toContain("undefined");
    });
    it("run CLI builds once, verifies producer identity and rejects altered or ambiguous transfers", async () => {
      const common = ["--tools", path.join(state.root, "tools"), "--base", context.baseSha];
      await entry("run.mjs", [
        ...common,
        "--check",
        "build",
        "--matrix",
        platform(),
        "--output",
        ".ci-output/build",
      ]);
      const producerPath = path.join(state.root, ".ci-output/build/result.json"),
        producer = readJson(producerPath);
      expect(producer.status).toBe("passed");
      await entry("run.mjs", [
        ...common,
        "--check",
        "test",
        "--matrix",
        platform(),
        "--output",
        ".ci-output/test",
        "--input",
        producerPath,
      ]);
      expect(
        readJson(path.join(state.root, ".ci-output/test/result.json")).artifacts[0].sha256,
      ).toBe(producer.artifacts[0].sha256);
      await entry("run.mjs", [
        ...common,
        "--check",
        "test",
        "--matrix",
        platform(),
        "--output",
        ".ci-output/ambiguous",
        "--input",
        producerPath,
        "--artifact",
        "archive.tar.gz",
      ]);
      expect(process.exitCode).toBe(1);
      write(producerPath, { ...producer, attempt: producer.attempt + 1 });
      await entry("run.mjs", [
        ...common,
        "--check",
        "test",
        "--matrix",
        platform(),
        "--output",
        ".ci-output/wrong-attempt",
        "--input",
        producerPath,
      ]);
      expect(process.stderr.write).toHaveBeenCalledWith(
        expect.stringContaining("CONTEXT_MISMATCH:attempt"),
      );
      write(producerPath, { ...producer, checkId: "test" });
      await entry("run.mjs", [
        ...common,
        "--check",
        "test",
        "--matrix",
        platform(),
        "--output",
        ".ci-output/wrong-producer",
        "--input",
        producerPath,
      ]);
      expect(process.stderr.write).toHaveBeenCalledWith(
        expect.stringContaining("PRODUCER_INVALID"),
      );
      write(producerPath, producer);
      write(path.join(path.dirname(producerPath), producer.artifacts[0].path), "tampered archive");
      await entry("run.mjs", [
        ...common,
        "--check",
        "test",
        "--matrix",
        platform(),
        "--output",
        ".ci-output/tampered",
        "--input",
        producerPath,
      ]);
      expect(process.stderr.write).toHaveBeenCalledWith(
        expect.stringContaining("TRANSFER_DIGEST_MISMATCH"),
      );
    });
    it("run CLI uses an explicit context and cannot turn a nonzero child outcome green", async () => {
      const contextPath = write(path.join(state.root, "context.json"), context),
        common = ["--tools", path.join(state.root, "tools"), "--context", contextPath];
      state.exitCode = 7;
      await entry("run.mjs", [
        ...common,
        "--check",
        "build",
        "--matrix",
        platform(),
        "--output",
        ".ci-output/failed-build",
      ]);
      expect(readJson(path.join(state.root, ".ci-output/failed-build/result.json"))).toMatchObject({
        status: "failed",
        exitCode: 7,
      });
      expect(process.exitCode).toBe(7);
      await entry("run.mjs", []);
      expect(process.exitCode).toBe(1);
    });
    it("required CLI writes a complete successful gate and rejects missing needs or failed jobs", async () => {
      const f = gateFixture();
      vi.stubEnv("CI_NEEDS", JSON.stringify(f.needs));
      await entry("required.mjs", [
        "--reports",
        f.reports,
        "--base",
        context.baseSha,
        "--output",
        ".ci-output/gate",
      ]);
      expect(process.exitCode).toBe(0);
      expect(readJson(path.join(state.root, ".ci-output/gate/summary.json")).status).toBe("passed");
      vi.stubEnv("CI_NEEDS", JSON.stringify({ ...f.needs, coverage: { result: "cancelled" } }));
      await entry("required.mjs", ["--reports", f.reports, "--output", ".ci-output/cancelled"]);
      expect(process.exitCode).toBe(1);
      expect(readJson(path.join(state.root, ".ci-output/cancelled/summary.json")).status).toBe(
        "failed",
      );
      vi.stubEnv("CI_NEEDS", "");
      await entry("required.mjs", ["--reports", f.reports, "--output", ".ci-output/missing-needs"]);
      expect(process.exitCode).toBe(1);
      expect(existsSync(path.join(state.root, ".ci-output/missing-needs"))).toBe(false);
    });
    it("export CLI revalidates a full default-branch run and metadata mode omits tokens", async () => {
      const f = gateFixture("push"),
        metadata = write(path.join(state.root, "metadata.json"), f.metadata);
      await entry("export-evidence.mjs", [
        "--metadata",
        metadata,
        "--reports",
        f.reports,
        "--gate",
        f.gate,
        "--output",
        ".ci-output/handoff.json",
      ]);
      expect(readJson(path.join(state.root, ".ci-output/handoff.json"))).toMatchObject({
        status: "ci_verified",
        productQualification: "not_assessed",
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({ ...f.metadata, token: "must-not-persist" }),
        })),
      );
      vi.stubEnv("GITHUB_REPOSITORY", f.identity.repository);
      vi.stubEnv("GITHUB_TOKEN", "synthetic-token");
      await entry("export-evidence.mjs", [
        "--mode",
        "metadata",
        "--run-id",
        f.identity.runId,
        "--output",
        ".ci-output/metadata.json",
      ]);
      expect(readFileSync(path.join(state.root, ".ci-output/metadata.json"), "utf8")).not.toContain(
        "must-not-persist",
      );
      await entry("export-evidence.mjs", [
        "--mode",
        "unknown",
        "--output",
        ".ci-output/bad-export.json",
      ]);
      expect(process.exitCode).toBe(1);
      await entry("export-evidence.mjs", []);
      expect(process.exitCode).toBe(1);
      await entry("export-evidence.mjs", ["--output", ".ci-output/missing-export-inputs"]);
      expect(process.exitCode).toBe(1);
    });
  },
);
