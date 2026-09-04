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
  contexts: [],
  fail: "",
  security: "passed",
  version: "",
  installError: false,
  skip: false,
  browserError: false,
  browserOutcome: {},
  rejectRun: false,
  event: "workflow_dispatch",
}));
const originalRoot = path.resolve(import.meta.dirname, "../..");
const write = (name, value) => {
  mkdirSync(path.dirname(name), { recursive: true });
  writeFileSync(name, typeof value === "string" ? value : JSON.stringify(value));
};
const identity = () => ({
  repository: "example/fixture",
  event: state.event,
  runId: "1",
  attempt: 1,
  testedSha: "a".repeat(40),
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  initialization: false,
  policySha256: "c".repeat(64),
  toolchainSha256: "d".repeat(64),
});
vi.mock("../../scripts/ci/contracts.mjs", async (original) => ({
  ...(await original()),
  get repositoryRoot() {
    return state.root;
  },
}));
vi.mock("../../scripts/ci/context.mjs", async (original) => ({
  ...(await original()),
  createContext: (options) => {
    state.contexts.push(options);
    return identity();
  },
  verifyContext: (value) => {
    state.contexts.push({ verified: value });
    if (value.testedSha !== identity().testedSha) throw new Error("CI_CONTEXT_MISMATCH:testedSha");
    return value;
  },
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original()),
  execFileSync: (executable, args) => {
    state.calls.push({ name: "version", executable, args });
    return state.version;
  },
}));
vi.mock("../../scripts/ci/install-tools.mjs", async (original) => ({
  ...(await original()),
  verifyInstalledTools: async () => {
    if (state.installError) throw new Error("controlled missing tool");
    return {
      executables: { node: "/fixture/node", npmCli: "/fixture/npm.mjs", python: "/fixture/python" },
    };
  },
  downloadArtifact: async (artifact, directory) => {
    state.calls.push({ name: "download", artifact });
    const archive = path.join(directory, "fixture.tar.xz");
    write(archive, "offline archive fixture");
    return archive;
  },
  extractArchive: (archive, prefix) => {
    state.calls.push({ name: "extract", archive, prefix });
    mkdirSync(prefix, { recursive: true });
  },
}));
vi.mock("../../scripts/ci/execute.mjs", async (original) => ({
  ...(await original()),
  execute: async (executable, args, options) => {
    const name = path.basename(options.log, ".log");
    state.calls.push({ name, executable, args, ...options });
    write(options.log, "offline child fixture\n");
    if (state.fail === name) return { exitCode: 7, durationMs: 2 };
    const tests = args.find((arg) => arg.startsWith("--outputFile="));
    if (tests)
      write(tests.slice(tests.indexOf("=") + 1), {
        success: true,
        testResults: [
          {
            name: "fixture.test.ts",
            assertionResults: [{ status: state.skip ? "pending" : "passed" }],
          },
        ],
      });
    for (const [key, value] of Object.entries(options.env))
      if (key.endsWith("_EVIDENCE_PATH")) write(value, { status: "measured", fixture: true });
    return { exitCode: 0, durationMs: 2 };
  },
}));
vi.mock("../../scripts/ci/check-security.mjs", () => ({
  runSecurityChecks: async (options) => {
    state.calls.push({ name: "security", ...options });
    return { status: state.security, checks: [] };
  },
}));
vi.mock("../../scripts/ci/browser.mjs", () => ({
  runBrowser: async (options) => {
    state.calls.push({ name: "browser", env: { ...process.env }, ...options });
    if (state.browserError) throw new Error("controlled browser failure");
    for (const report of state.browserOutcome.reports ?? [])
      write(report.path, { fixture: true, exitCode: state.browserOutcome.exitCode });
    return {
      engine: options.engine,
      exitCode: 0,
      counts: { files: 1, executed: 1, passed: 1, failed: 0, skipped: 0 },
      ...state.browserOutcome,
    };
  },
}));
vi.mock("../../scripts/ci/run.mjs", () => ({
  runCheck: async (options) => {
    state.calls.push({ name: "check", ...options });
    if (state.rejectRun) throw new Error("controlled runner rejection");
    return {
      checkId: options.checkId,
      matrixKey: options.matrixKey,
      status: state.fail === options.checkId ? "failed" : "passed",
      durationMs: 2,
      artifacts: options.checkId === "build" ? [{ path: "runtime.tar.gz" }] : [],
    };
  },
}));

import { fileSha256 } from "../../scripts/ci/contracts.mjs";
import { local, main as localMain } from "../../scripts/ci/local.mjs";
import { quality, main as qualityMain } from "../../scripts/ci/quality.mjs";
import { validateQualityPolicy } from "../../scripts/ci/quality-policy.mjs";

beforeEach(() => {
  state.root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "himawari-quality-local-")));
  state.calls = [];
  state.contexts = [];
  state.fail = "";
  state.security = "passed";
  state.installError = false;
  state.skip = false;
  state.browserError = false;
  state.browserOutcome = {};
  state.rejectRun = false;
  state.event = "workflow_dispatch";
  mkdirSync(path.join(state.root, "ci"));
  copyFileSync(
    path.join(originalRoot, "ci/quality-policy.json"),
    path.join(state.root, "ci/quality-policy.json"),
  );
  const policy = JSON.parse(readFileSync(path.join(state.root, "ci/quality-policy.json")));
  state.version = `v${policy.nodeObservation.version}\n`;
  write(path.join(state.root, "tools/installation.json"), { fixture: true });
  write(
    path.join(state.root, "docs/execution/evidence/historical.json"),
    "immutable historical evidence\n",
  );
  vi.stubEnv("GITHUB_ACTIONS", "false");
  vi.stubEnv("OPENAI_API_KEY", "fixture-do-not-inherit");
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
  rmSync(state.root, { recursive: true, force: true });
});
const runQuality = (check, extra = {}) =>
  quality({
    root: state.root,
    check,
    output: `.ci-output/${check}`,
    toolsDirectory: path.join(state.root, "tools"),
    base: "b".repeat(40),
    env: { GITHUB_ACTIONS: "false" },
    ...extra,
  });
const runLocal = (extra = {}) =>
  local({
    root: state.root,
    output: ".ci-output/local",
    toolsDirectory: path.join(state.root, "tools"),
    base: "b".repeat(40),
    ...extra,
  });

describe("periodic quality policy and evidence", () => {
  it("keeps enabled manual observation usable and preserves scheduled identity across brand isolation", async () => {
    const filename = path.join(state.root, "ci/quality-policy.json");
    const policy = JSON.parse(readFileSync(filename));
    policy.schedule.enabled = true;
    write(filename, policy);
    expect((await runQuality("scale")).status).toBe("passed");
    state.event = "schedule";
    const env = {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "schedule",
      GITHUB_REF: "refs/heads/main",
      GITHUB_SHA: identity().testedSha,
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_EVENT_PATH: "/fixture/event.json",
    };
    const result = await runQuality("brands", {
      artifact: "/fixture/runtime.tar.gz",
      env,
      base: identity().testedSha,
    });
    expect(result.status).toBe("passed");
    expect(result.context.event).toBe("schedule");
    expect(result.qualityPolicySha256).toBe(fileSha256(filename));
    const persisted = JSON.parse(
      readFileSync(path.join(state.root, ".ci-output/brands/quality.json")),
    );
    expect(persisted.context).toEqual(result.context);
    expect(persisted.qualityPolicySha256).toBe(result.qualityPolicySha256);
    for (const call of state.calls.filter((entry) => entry.name === "browser")) {
      expect(call.context.event).toBe("schedule");
      expect(call.env).toMatchObject(env);
      expect(call.env).not.toHaveProperty("OPENAI_API_KEY");
    }
    expect(
      readFileSync(path.join(state.root, "docs/execution/evidence/historical.json"), "utf8"),
    ).toBe("immutable historical evidence\n");
  });
  it("requires the exact authorized schedule, check sets and retention", () => {
    const policy = JSON.parse(readFileSync(path.join(state.root, "ci/quality-policy.json")));
    expect(validateQualityPolicy(policy)).toBe(policy);
    for (const mutate of [
      (p) => {
        p.schedule.enabled = "true";
      },
      (p) => {
        p.defaultBranch = "next";
      },
      (p) => {
        p.schedule.cron = "* * * * *";
      },
      (p) => {
        p.schedule.timezone = "local";
      },
      (p) => {
        p.checks.pop();
      },
      (p) => {
        p.brands.reverse();
      },
      (p) => {
        p.retentionDays.reports = 90;
      },
      (p) => {
        p.securityFreshnessHours = 25;
      },
    ]) {
      const copy = structuredClone(policy);
      mutate(copy);
      expect(() => validateQualityPolicy(copy)).toThrow();
    }
  });
  it("refuses unsupported checks, non-default hosted branches and reused outputs before work", async () => {
    await expect(runQuality("unknown")).rejects.toThrow("UNSUPPORTED");
    await expect(
      runQuality("scale", { env: { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/feature" } }),
    ).rejects.toThrow("DEFAULT_BRANCH");
    await expect(runQuality("scale", { output: "docs/execution/evidence" })).rejects.toThrow(
      "OUTSIDE",
    );
    mkdirSync(path.join(state.root, ".ci-output/scale"), { recursive: true });
    await expect(runQuality("scale")).rejects.toThrow("OUTPUT_EXISTS");
    expect(state.calls).toHaveLength(0);
  });
  it("runs both scale registrations only by explicit opt-in and writes fresh external evidence", async () => {
    for (const check of ["scale", "thread-scale"]) {
      const report = await runQuality(check);
      expect(report.status).toBe("passed");
      const call = state.calls.find((entry) => entry.name === check),
        prefix = check === "scale" ? "HIMAWARI_SCALE" : "HIMAWARI_THREAD_SCALE";
      expect(call.args).toContain(
        check === "scale" ? "qualification-scale" : "qualification-thread-scale",
      );
      expect(call.args).toContain("--maxWorkers");
      expect(call.timeoutMs).toBeGreaterThan(0);
      expect(call.env[`${prefix}_QUALIFICATION`]).toBe("1");
      expect(call.env[`${prefix}_WRITE_EVIDENCE`]).toBe("1");
      expect(call.env[`${prefix}_EVIDENCE_PATH`]).toBe(
        path.join(state.root, ".ci-output", check, "measurement.json"),
      );
      expect(call.env).not.toHaveProperty("OPENAI_API_KEY");
      expect(report.observations[0].measurementSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(report.productQualification).toBe("not_assessed");
      expect(report.performanceComparison).toContain("not_comparable");
      expect(report.pending.join(" ")).toContain("S9");
      expect(existsSync(path.join(state.root, ".ci-output", check, "quality.json"))).toBe(true);
    }
    expect(
      readFileSync(path.join(state.root, "docs/execution/evidence/historical.json"), "utf8"),
    ).toBe("immutable historical evidence\n");
  });
  it("retains nonzero child failures and failed infrastructure as failed reports", async () => {
    state.fail = "scale";
    const report = await runQuality("scale");
    expect(report.status).toBe("failed");
    expect(report.commands[0].exitCode).toBe(7);
    expect(report.error).toContain("COMMAND_FAILED:scale");
    state.installError = true;
    const installation = await runQuality("thread-scale");
    expect(installation.status).toBe("failed");
    expect(installation.commands).toEqual([]);
    expect(installation.error).toContain("missing tool");
    expect(
      JSON.parse(readFileSync(path.join(state.root, ".ci-output/scale/quality.json"))).status,
    ).toBe("failed");
  });
  it("does not treat skipped scale tests or security failure as successful observations", async () => {
    state.skip = true;
    expect((await runQuality("scale")).status).toBe("failed");
    for (const status of ["passed", "failed", "infrastructure_failed"]) {
      state.security = status;
      const report = await runQuality("dependencies", {
        output: `.ci-output/dependency-${status}`,
      });
      expect(report.status).toBe(status === "passed" ? "passed" : "failed");
      expect(report.observations[0].status).toBe(status);
    }
    const call = state.calls.find((entry) => entry.name === "security");
    expect(call.context.baseSha).toBe("b".repeat(40));
    expect(call.outputDirectory).toContain(".ci-output");
  });
  it("uses the same artifact for Chrome and Edge and restores process environment after failures", async () => {
    expect((await runQuality("brands")).error).toContain("ARTIFACT_REQUIRED");
    const original = process.env;
    const report = await runQuality("brands", {
      output: ".ci-output/brands-pass",
      artifact: "/fixture/runtime.tar.gz",
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF: "refs/heads/main",
        GITHUB_RUN_ID: "123",
        PLAYWRIGHT_BROWSERS_PATH: "/fixture/browsers",
      },
    });
    expect(report.status).toBe("passed");
    const calls = state.calls.filter((entry) => entry.name === "browser");
    expect(calls.map((entry) => entry.engine)).toEqual(["chrome", "edge"]);
    expect(
      calls.every((entry) => entry.artifact === "/fixture/runtime.tar.gz" && entry.port === 0),
    ).toBe(true);
    expect(calls[0].env.GITHUB_RUN_ID).toBe("123");
    expect(calls[0].env.GITHUB_REF).toBe("refs/heads/main");
    expect(calls[0].env).not.toHaveProperty("OPENAI_API_KEY");
    expect(process.env).toBe(original);
    state.browserError = true;
    const failure = await runQuality("brands", {
      output: ".ci-output/brands-fail",
      artifact: "/fixture/runtime.tar.gz",
    });
    expect(failure.status).toBe("failed");
    expect(process.env).toBe(original);
  });
  it("retains browser failure evidence and rejects nonzero, absent or contradictory outcomes", async () => {
    const counts = { files: 1, executed: 1, passed: 1, failed: 0, skipped: 0 };
    const failures = [
      { exitCode: 9, counts: { ...counts, passed: 0, failed: 1 } },
      { exitCode: 7, counts },
      { exitCode: undefined, counts },
      { exitCode: 0, counts: { ...counts, skipped: 1 } },
      { exitCode: 0, counts: { ...counts, executed: 2 } },
      { exitCode: 0, counts: { ...counts, files: 0 } },
      { exitCode: 0, counts: undefined },
    ];
    const original = process.env;
    for (const [index, failure] of failures.entries()) {
      const output = `.ci-output/browser-outcome-${index}`;
      const evidence = [{ path: path.join(state.root, output, "browser.json"), kind: "json" }];
      state.browserOutcome = { ...failure, reports: evidence };
      const report = await qualityMain([
        "--check",
        "brands",
        "--output",
        output,
        "--tools",
        path.join(state.root, "tools"),
        "--artifact",
        "/fixture/runtime.tar.gz",
      ]);
      expect(report.status).toBe("failed");
      expect(process.exitCode).toBe(1);
      expect(report.error).toBe("CI_QUALITY_BROWSER_FAILED:chrome");
      expect(report.observations).toEqual([{ engine: "chrome", ...failure, reports: evidence }]);
      const persisted = JSON.parse(readFileSync(path.join(state.root, output, "quality.json")));
      expect(persisted.status).toBe("failed");
      expect(persisted.observations[0].exitCode).toBe(failure.exitCode);
      expect(persisted.observations[0].reports).toEqual(evidence);
      expect(existsSync(evidence[0].path)).toBe(true);
      expect(process.env).toBe(original);
    }
  });
  it("observes a fixed Node distribution without asserting product or SQLite ABI qualification", async () => {
    const report = await runQuality("node-observation");
    expect(report.status).toBe("passed");
    expect(state.calls.map((entry) => entry.name)).toEqual([
      "download",
      "extract",
      "version",
      "node-typecheck",
      "node-browser-typecheck",
      "node-tooling",
    ]);
    expect(state.calls[0].artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.observations[0]).toMatchObject({
      productSupported: false,
      sqliteAbiQualified: false,
    });
    state.version = "v0.0.0\n";
    const failure = await runQuality("node-observation", {
      output: ".ci-output/node-wrong-version",
    });
    expect(failure.error).toContain("VERSION_MISMATCH");
    const policy = JSON.parse(readFileSync(path.join(state.root, "ci/quality-policy.json")));
    policy.nodeObservation.artifacts = {};
    write(path.join(state.root, "ci/quality-policy.json"), policy);
    expect(
      (await runQuality("node-observation", { output: ".ci-output/node-unsupported" })).error,
    ).toContain("PLATFORM_UNAVAILABLE");
  });
  it("CLI requires explicit output and an unambiguous archive set", async () => {
    await expect(qualityMain([])).rejects.toThrow("ARGUMENTS_REQUIRED");
    const args = [
      "--check",
      "brands",
      "--output",
      ".ci-output/cli",
      "--tools",
      path.join(state.root, "tools"),
    ];
    const archives = path.join(state.root, "archives");
    mkdirSync(archives);
    await expect(
      qualityMain([...args, "--artifact", "a", "--artifact-directory", archives]),
    ).rejects.toThrow("AMBIGUOUS");
    await expect(qualityMain([...args, "--artifact-directory", archives])).rejects.toThrow(
      "SET_INVALID",
    );
    write(path.join(archives, "runtime.tar.gz"), "fixture");
    expect((await qualityMain([...args, "--artifact-directory", archives])).status).toBe("passed");
    expect(process.exitCode).toBe(0);
    state.fail = "scale";
    expect(
      (
        await qualityMain([
          "--check",
          "scale",
          "--output",
          ".ci-output/cli-fail",
          "--tools",
          path.join(state.root, "tools"),
        ])
      ).status,
    ).toBe("failed");
    expect(process.exitCode).toBe(1);
  });
});

describe("local shared-runner boundary", () => {
  it("rejects unsupported physical platforms instead of relabeling their evidence", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const arch = Object.getOwnPropertyDescriptor(process, "arch");
    try {
      for (const [os, cpu] of [
        ["darwin", "x64"],
        ["linux", "arm64"],
        ["win32", "x64"],
      ]) {
        Object.defineProperty(process, "platform", { value: os });
        Object.defineProperty(process, "arch", { value: cpu });
        await expect(runLocal()).rejects.toThrow("PLATFORM_UNSUPPORTED");
      }
      expect(state.calls).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", platform);
      Object.defineProperty(process, "arch", arch);
    }
  });
  it("runs the full local graph with one build artifact and explicit hosted/S9 limitations", async () => {
    const summary = await runLocal();
    const calls = state.calls.filter((entry) => entry.name === "check");
    expect(calls.map((entry) => entry.checkId)).toEqual([
      "policy",
      "static",
      "build",
      "test",
      "browser",
      "browser",
      "browser",
      "coverage",
      "security",
    ]);
    expect(
      calls.filter((entry) => entry.checkId === "browser").map((entry) => entry.matrixKey),
    ).toEqual(["chromium", "firefox", "webkit"]);
    const consumers = calls.filter((entry) => ["test", "browser"].includes(entry.checkId));
    expect(new Set(consumers.map((entry) => entry.artifact)).size).toBe(1);
    expect(consumers[0].artifact).toContain("runtime.tar.gz");
    expect(calls.every((entry) => entry.hosted === false)).toBe(true);
    expect(summary).toMatchObject({
      status: "local_passed",
      scope: "local-platform-validation",
      hostedGate: "not_executed",
      enforcement: "not_configured",
    });
    expect(summary.pending.join(" ")).toContain("S9");
    expect(summary.pending.join(" ")).toContain("Linux Node floor");
    expect(existsSync(path.join(state.root, ".ci-output/local/local-summary.json"))).toBe(true);
  });
  it("selects individual checks and reuses a supplied archive without rebuilding", async () => {
    for (const check of ["policy", "static", "build", "coverage", "security"]) {
      state.calls = [];
      expect((await runLocal({ check, output: `.ci-output/local-${check}` })).status).toBe(
        "local_passed",
      );
      expect(state.calls.map((entry) => entry.checkId)).toEqual([check]);
    }
    state.calls = [];
    await runLocal({
      check: "test",
      artifact: "/fixture/existing.tar.gz",
      output: ".ci-output/local-test-artifact",
    });
    expect(state.calls.map((entry) => entry.checkId)).toEqual(["test"]);
    expect(state.calls[0].artifact).toBe("/fixture/existing.tar.gz");
    state.calls = [];
    await runLocal({ check: "test", output: ".ci-output/local-test-build" });
    expect(state.calls.map((entry) => entry.checkId)).toEqual(["build", "test"]);
  });
  it("does not run artifact consumers after failed build and preserves failed check outcomes", async () => {
    state.fail = "build";
    const failedBuild = await runLocal();
    expect(failedBuild.status).toBe("failed");
    expect(state.calls.some((entry) => ["test", "browser"].includes(entry.checkId))).toBe(false);
    expect(state.calls.map((entry) => entry.checkId)).toEqual([
      "policy",
      "static",
      "build",
      "coverage",
      "security",
    ]);
    state.fail = "security";
    expect(
      (await runLocal({ check: "security", output: ".ci-output/local-security" })).status,
    ).toBe("failed");
    state.rejectRun = true;
    await expect(runLocal({ check: "static", output: ".ci-output/local-reject" })).rejects.toThrow(
      "runner rejection",
    );
  });
  it("requires tools, local scope, valid context and a fresh output directory", async () => {
    await expect(runLocal({ check: "required" })).rejects.toThrow("UNSUPPORTED");
    await expect(runLocal({ toolsDirectory: path.join(state.root, "missing") })).rejects.toThrow(
      "TOOLS_REQUIRED",
    );
    vi.stubEnv("GITHUB_ACTIONS", "true");
    await expect(runLocal()).rejects.toThrow("CANNOT_REPLACE_HOSTED");
    vi.stubEnv("GITHUB_ACTIONS", "false");
    await expect(
      runLocal({ context: { ...identity(), testedSha: "0".repeat(40) } }),
    ).rejects.toThrow("CONTEXT_MISMATCH");
    await runLocal({ check: "policy", context: identity() });
    expect(state.contexts.some((entry) => entry.verified)).toBe(true);
    await expect(runLocal()).rejects.toThrow("OUTPUT_EXISTS");
    expect(
      readFileSync(path.join(state.root, "docs/execution/evidence/historical.json"), "utf8"),
    ).toBe("immutable historical evidence\n");
  });
  it("CLI honors explicit context and artifact, and maps failed summaries to a failing exit", async () => {
    const contextPath = path.join(state.root, "context.json");
    write(contextPath, identity());
    expect(
      (
        await localMain([
          "--check",
          "test",
          "--output",
          ".ci-output/local-cli",
          "--tools",
          path.join(state.root, "tools"),
          "--context",
          contextPath,
          "--artifact",
          path.join(state.root, "archive.tar.gz"),
        ])
      ).status,
    ).toBe("local_passed");
    expect(process.exitCode).toBe(0);
    vi.stubEnv("HIMAWARI_CI_TOOLS", path.join(state.root, "tools"));
    state.fail = "coverage";
    expect((await localMain(["--check", "coverage"])).status).toBe("failed");
    expect(process.exitCode).toBe(1);
  });
});
