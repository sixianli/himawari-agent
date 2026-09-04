import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  verify: vi.fn(),
  source: vi.fn(),
  extracted: vi.fn(),
  archive: vi.fn(),
  package: vi.fn(),
  manifest: vi.fn(),
  policy: vi.fn(),
  config: vi.fn(),
  context: vi.fn(),
}));
vi.mock("../../scripts/ci/context.mjs", () => ({
  verifyContext: mocks.context,
  outputPath: (output, root) => path.resolve(root, output),
}));
vi.mock("../../scripts/ci/check-policy.mjs", () => ({
  resolvePolicySource: mocks.policy,
  validateVitestProjects: mocks.config,
}));
vi.mock("../../scripts/ci/execute.mjs", async (original) => ({
  ...(await original()),
  execute: mocks.execute,
}));
vi.mock("../../scripts/ci/verify-artifact.mjs", async (original) => ({
  ...(await original()),
  verifyArtifact: mocks.verify,
  verifyExtractedArtifact: mocks.extracted,
  sourceTreeDigest: mocks.source,
  runArchiveTool: mocks.archive,
}));
vi.mock("../../scripts/package-node-runtime.mjs", () => ({ packageNodeRuntime: mocks.package }));
vi.mock("../../scripts/generate-artifact-manifest.mjs", () => ({
  generateArtifactManifest: mocks.manifest,
}));

import { digestFile } from "../../scripts/ci/artifact-files.mjs";
import { browserMain, runBrowser } from "../../scripts/ci/browser.mjs";
import { build, buildMain } from "../../scripts/ci/build.mjs";
import { runTests, testMain } from "../../scripts/ci/test.mjs";

const directories = [];
const ids = ["unit", "contracts", "integration", "e2e", "pi-compat"];
const context = {
  repository: "owner/repository",
  event: "workflow_dispatch",
  runId: "123",
  attempt: 1,
  testedSha: "a".repeat(40),
  headSha: "a".repeat(40),
  baseSha: "b".repeat(40),
  policySha256: "c".repeat(64),
  toolchainSha256: "d".repeat(64),
  initialization: true,
};
const runtime = {
  entrypoints: { himawari: "cli.js", agentService: "service.js", executionWorker: "worker.js" },
  externalDependencyClosure: {},
};
const browserReport = (engine) => ({
  status: "passed",
  scope: "fixture-only",
  engine,
  profile: engine,
  browserVersion: "123.0",
  locales: ["zh-CN", "en", "ja"],
  keyboard: ["visible-focus", "settings-tabs-roving"],
  axeViolations: 0,
  keyboardFocus: { visible: true, accessibleName: "Settings" },
  journeys: ["workspace"],
  routeStates: ["loading"],
  sse: ["reconnect"],
  responsive: ["desktop"],
  surfaces: ["settings"],
});
async function put(filename, content) {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content);
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "himawari-pipeline-"));
  directories.push(root);
  await put(path.join(root, "package-lock.json"), "{}");
  await put(path.join(root, "package.json"), '{"type":"module"}');
  await put(path.join(root, "vitest.workspace.ts"), "export default {};\n");
  for (const id of ids) await put(path.join(root, "test", `${id}.test.ts`), "export {};\n");
  execFileSync("git", ["init", "--quiet", root]);
  const artifact = path.join(root, "input.tar.gz");
  await put(artifact, "immutable artifact");
  const sha256 = await digestFile(artifact);
  mocks.verify.mockImplementation(async ({ extractTo }) => {
    if (extractTo) await put(path.join(extractTo, "browser/index.html"), "fixture");
    return { sha256, manifest: { platform: { os: process.platform } } };
  });
  mocks.source.mockResolvedValue("f".repeat(64));
  mocks.policy.mockReturnValue({
    policy: {
      checks: [{ id: "test", projects: ids }],
      testProjects: ids.map((id) => ({ id, include: [`test/${id}.test.ts`], exclude: [] })),
    },
  });
  mocks.package.mockImplementation(async ({ runtimeRoot }) => {
    await put(path.join(runtimeRoot, "runtime-manifest.json"), JSON.stringify(runtime));
    await put(path.join(runtimeRoot, "cli.js"), "compiled fresh");
    await put(
      path.join(
        runtimeRoot,
        "node_modules/@himawari-agent/persistence-sqlite/dist/migrations/0001.sql",
      ),
      "CREATE TABLE fixture(value);",
    );
  });
  mocks.manifest.mockImplementation(async ({ output }) => {
    await put(output, JSON.stringify({ runtime }));
    return { runtime };
  });
  mocks.archive.mockImplementation((_operation, _source, target) =>
    writeFileSync(target, "packed immutable fixture"),
  );
  mocks.execute.mockImplementation(async (_command, args, { log }) => {
    await put(
      log,
      JSON.stringify({ entryGzipBytes: 12, totalGzipBytes: 34 }) +
        "\n" +
        JSON.stringify({ exitCode: 0 }) +
        "\n",
    );
    if (args[0].endsWith("vite.js"))
      await put(path.join(args.at(-1), "index.html"), "<html>compiled</html>");
    if (args.includes("--project")) {
      const id = args[args.indexOf("--project") + 1];
      const json = args.find((arg) => arg.startsWith("--outputFile.json=")).split("=")[1];
      const junit = args.find((arg) => arg.startsWith("--outputFile.junit=")).split("=")[1];
      await put(
        json,
        JSON.stringify({
          success: true,
          testResults: [
            {
              name: path.join(root, `test/${id}.test.ts`),
              assertionResults: [{ status: "passed" }],
            },
          ],
        }),
      );
      await put(junit, "<testsuites/>");
    }
    if (args[0].endsWith("qualify-control-center-browser.mjs"))
      await put(
        path.join(args[args.indexOf("--report-directory") + 1], "browser.json"),
        JSON.stringify(browserReport(args[1])),
      );
    return { exitCode: 0, durationMs: 1 };
  });
  return { root, artifact, context, output: ".ci-output/check" };
}
beforeEach(() => vi.resetAllMocks());
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("build process contract", () => {
  it.each([
    ["build", buildMain],
    ["test", testMain],
    ["browser", browserMain],
  ])("validates %s command arguments and serializes the actual outcome", async (name, main) => {
    const options = await fixture();
    const contextFile = path.join(options.root, "context.json");
    await put(contextFile, JSON.stringify(context));
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const environment = { root: options.root, stdout, stderr };
    expect(await main(["--shell", "anything"], environment)).toBe(1);
    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("Invalid or duplicate argument"),
    );
    const args = ["--context", contextFile, "--output", options.output];
    if (name !== "build") args.push("--artifact", options.artifact);
    if (name === "browser") args.push("--engine", "chromium", "--port", "0");
    expect(await main(args, environment)).toBe(0);
    const result = JSON.parse(stdout.write.mock.calls[0][0]);
    expect(result.exitCode).toBe(0);
    expect(result.counts.executed).toBeGreaterThan(0);
  });
  it("compiles into fresh output, probes packaged SQLite and publishes one verified archive", async () => {
    const options = await fixture();
    const result = await build(options);
    expect(result.exitCode).toBe(0);
    expect(result.counts).toMatchObject({ executed: 7, passed: 7, failed: 0, skipped: 0 });
    expect(result.sha256).toBe(await digestFile(result.archive));
    expect(existsSync(path.join(options.root, options.output, "work"))).toBe(false);
    expect(mocks.execute.mock.calls[0][1].slice(-2)).toEqual([
      "--outDir",
      path.join(options.root, options.output, "work/compiled"),
    ]);
    expect(mocks.package.mock.calls[0][0].buildRoot).toContain("work/compiled");
    const probe = mocks.execute.mock.calls.find((call) => call[2].log.endsWith("native-probe.log"));
    expect(probe[2].cwd).toContain("payload/runtime");
    expect(probe[2].env).toMatchObject({ NODE_PATH: "", NODE_OPTIONS: "" });
    expect(mocks.extracted).toHaveBeenCalledOnce();
    expect(mocks.archive).toHaveBeenCalledOnce();
    expect(result.reports.filter((entry) => entry.kind === "artifact")).toHaveLength(1);
    await expect(build(options)).rejects.toThrow(/EEXIST/u);
  });
  it.each(["compile-node", "compile-browser", "browser-budget", "native-probe"])(
    "rejects %s failure and cleans temporary compilation",
    async (name) => {
      const options = await fixture();
      const original = mocks.execute.getMockImplementation();
      mocks.execute.mockImplementation(async (...args) => {
        const result = await original(...args);
        return args[2].log.endsWith(`${name}.log`) ? { ...result, exitCode: 2 } : result;
      });
      await expect(build(options)).rejects.toThrow(`CI_COMMAND_FAILED:${name}:2`);
      expect(mocks.archive).not.toHaveBeenCalled();
      expect(existsSync(path.join(options.root, options.output, "work"))).toBe(false);
    },
  );
  it.each([false, true])(
    "coordinates its own cleanup and preserves both failures: build failure=%s",
    async (failBuild) => {
      const options = await fixture();
      if (failBuild) mocks.execute.mockRejectedValue(new Error("primary build failure"));
      const work = path.join(options.root, options.output, "work");
      const cleanupError = new Error("owned cleanup failure");
      const cleanupCoordinator = vi.fn(async (reason, operation) => {
        expect(reason).toBe("build-work-cleanup");
        expect(existsSync(work)).toBe(true);
        await operation();
        expect(existsSync(work)).toBe(false);
        throw cleanupError;
      });
      const error = await build({ ...options, cleanupCoordinator }).catch((failure) => failure);
      expect(cleanupCoordinator).toHaveBeenCalledOnce();
      if (failBuild) {
        expect(error).toBeInstanceOf(AggregateError);
        expect(error.message).toBe("CI_BUILD_AND_CLEANUP_FAILED");
        expect(error.errors.map((cause) => cause.message)).toEqual([
          "primary build failure",
          "owned cleanup failure",
        ]);
      } else expect(error).toBe(cleanupError);
    },
  );
  it("rejects source changes before archive publication", async () => {
    const options = await fixture();
    mocks.source.mockResolvedValueOnce("f".repeat(64)).mockResolvedValueOnce("e".repeat(64));
    await expect(build(options)).rejects.toThrow("BUILD_INPUT_CHANGED_DURING_BUILD");
    expect(existsSync(path.join(options.root, options.output, "build.json"))).toBe(false);
  });
});

describe("five-project execution contract", () => {
  it("runs exact projects with no retry, private installed-artifact paths and real report counts", async () => {
    const options = await fixture();
    vi.stubEnv("NODE_PATH", "/source-only/modules");
    const result = await runTests(options);
    expect(result.counts).toEqual({ files: 5, executed: 5, passed: 5, failed: 0, skipped: 0 });
    expect(result.projects.map((entry) => entry.id)).toEqual(ids);
    expect(mocks.config).toHaveBeenCalledOnce();
    for (const call of mocks.execute.mock.calls) {
      expect(call[1]).toContain("--retry");
      expect(call[2].env.NODE_PATH).toBe("");
      expect(call[2].env.HIMAWARI_TEST_ARTIFACT).toBe(result.artifact.path);
      expect(call[2].env.HIMAWARI_TEST_CONTEXT).toContain("context.json");
    }
    expect(result.reports.filter((entry) => entry.kind === "junit")).toHaveLength(5);
  });
  it("finishes other projects after failed assertions and returns failure", async () => {
    const options = await fixture();
    const original = mocks.execute.getMockImplementation();
    mocks.execute.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1].includes("integration")) {
        const json = args[1].find((arg) => arg.startsWith("--outputFile.json=")).split("=")[1];
        const report = JSON.parse(await readFile(json, "utf8"));
        report.success = false;
        report.testResults[0].assertionResults[0].status = "failed";
        await put(json, JSON.stringify(report));
        return { ...result, exitCode: 1 };
      }
      return result;
    });
    const result = await runTests(options);
    expect(result.exitCode).toBe(1);
    expect(result.counts.failed).toBe(1);
    expect(result.projects).toHaveLength(5);
  });
  it.each(["missing-file", "exit-contradiction", "mutated-archive"])(
    "rejects %s",
    async (fault) => {
      const options = await fixture();
      const original = mocks.execute.getMockImplementation();
      mocks.execute.mockImplementation(async (...args) => {
        const result = await original(...args);
        const json = args[1].find((arg) => arg.startsWith("--outputFile.json=")).split("=")[1];
        const report = JSON.parse(await readFile(json, "utf8"));
        if (fault === "missing-file")
          report.testResults[0].name = path.join(options.root, "test/not-selected.test.ts");
        if (fault === "exit-contradiction") {
          report.success = false;
          report.testResults[0].assertionResults[0].status = "failed";
        }
        if (fault === "mutated-archive") await put(options.artifact, "tampered");
        await put(json, JSON.stringify(report));
        return result;
      });
      await expect(runTests(options)).rejects.toThrow(
        {
          "missing-file": "CI_TEST_FILE_SET_MISMATCH",
          "exit-contradiction": "CI_TEST_EXIT_CONTRADICTION",
          "mutated-archive": "CI_TEST_ARCHIVE_CHANGED",
        }[fault],
      );
    },
  );
});

describe("browser process contract", () => {
  it("cleans extracted content when archive verification or copying fails", async () => {
    const options = await fixture();
    const original = mocks.verify.getMockImplementation();
    mocks.verify.mockImplementation(async (...args) => ({
      ...(await original(...args)),
      sha256: "0".repeat(64),
    }));
    await expect(runBrowser({ ...options, engine: "chromium" })).rejects.toThrow(
      "CI_BROWSER_ARTIFACT_COPY_CHANGED",
    );
    expect(existsSync(path.join(options.root, options.output, "payload"))).toBe(false);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it.each(["chromium", "firefox", "webkit"])(
    "consumes the same artifact for %s and cleans extracted payload",
    async (engine) => {
      const options = await fixture();
      const result = await runBrowser({ ...options, engine });
      expect(result.exitCode).toBe(0);
      expect(result.counts.executed).toBe(10);
      expect(result.artifact.sha256).toBe(await digestFile(options.artifact));
      expect(existsSync(path.join(options.root, options.output, "payload"))).toBe(false);
      const args = mocks.execute.mock.calls[0][1];
      expect(args[args.indexOf("--static-root") + 1]).toContain("payload/browser");
    },
  );
  it("retains failed report and diagnostics with failed counts", async () => {
    const options = await fixture();
    const original = mocks.execute.getMockImplementation();
    mocks.execute.mockImplementation(async (...args) => {
      await original(...args);
      const reportDir = args[1][args[1].indexOf("--report-directory") + 1];
      await put(path.join(reportDir, "browser.json"), JSON.stringify({ status: "failed" }));
      await put(path.join(reportDir, "failure.png"), "image");
      return { exitCode: 1, durationMs: 1 };
    });
    const result = await runBrowser({ ...options, engine: "chromium" });
    expect(result.counts.failed).toBe(1);
    expect(result.exitCode).toBe(1);
    expect(result.reports.some((entry) => entry.path.endsWith("failure.png"))).toBe(true);
  });
  it.each(["bad-engine", "executable-override", "mutated-archive"])("rejects %s", async (fault) => {
    const options = await fixture();
    if (fault === "executable-override")
      vi.stubEnv("HIMAWARI_FIREFOX_EXECUTABLE", "/unlocked/firefox");
    if (fault === "mutated-archive") {
      const original = mocks.execute.getMockImplementation();
      mocks.execute.mockImplementation(async (...args) => {
        const result = await original(...args);
        await put(options.artifact, "changed");
        return result;
      });
    }
    await expect(
      runBrowser({ ...options, engine: fault === "bad-engine" ? "unknown" : "chromium" }),
    ).rejects.toThrow(
      {
        "bad-engine": "CI_BROWSER_ENGINE_UNSUPPORTED",
        "executable-override": "CI_BROWSER_EXECUTABLE_OVERRIDE_FORBIDDEN",
        "mutated-archive": "CI_BROWSER_ARCHIVE_CHANGED",
      }[fault],
    );
  });
});
