import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runBrowser } from "./browser.mjs";
import { runSecurityChecks } from "./check-security.mjs";
import { createContext, outputPath } from "./context.mjs";
import { fileSha256, parseArguments, readJson, repositoryRoot } from "./contracts.mjs";
import { execute, vitestCounts } from "./execute.mjs";
import {
  downloadArtifact,
  extractArchive,
  isolatedEnvironment,
  verifyInstalledTools,
} from "./install-tools.mjs";
import { validateQualityPolicy } from "./quality-policy.mjs";
import { observeResources } from "./resources.mjs";
import { redactText } from "./security-redaction.mjs";

export async function quality({
  check,
  output,
  toolsDirectory,
  base,
  artifact,
  root = repositoryRoot,
  env = process.env,
}) {
  const policy = validateQualityPolicy(readJson(path.join(root, "ci/quality-policy.json")));
  if (!policy.checks.includes(check)) throw new Error("CI_QUALITY_CHECK_UNSUPPORTED");
  if (env.GITHUB_ACTIONS === "true" && env.GITHUB_REF !== `refs/heads/${policy.defaultBranch}`)
    throw new Error("CI_QUALITY_DEFAULT_BRANCH_REQUIRED");
  const context = createContext({ root, env, base });
  const directory = outputPath(output, root);
  if (existsSync(directory)) throw new Error("CI_QUALITY_OUTPUT_EXISTS");
  mkdirSync(directory, { recursive: true });
  const started = Date.now();
  const temporaryDirectory = mkdtempSync("/tmp/hci-");
  const resourceObserver = await observeResources({ root, toolsDirectory, temporaryDirectory });
  const report = {
    schemaVersion: 1,
    check,
    context,
    qualityPolicySha256: fileSha256(path.join(root, "ci/quality-policy.json")),
    startedAt: new Date(started).toISOString(),
    completedAt: null,
    status: "failed",
    commands: [],
    observations: [],
    hardware: {
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? "unavailable",
      memoryBytes: os.totalmem(),
      runnerImage: env.ImageVersion ?? "local",
    },
    performanceComparison: "not_comparable_without_same_hardware_policy_and_interleaved_samples",
    productQualification: "not_assessed",
    pending: ["S9 平台资格、正式浏览器、人工 WCAG、soak 与 Owner 签署"],
  };
  try {
    const installation = await verifyInstalledTools({ directory: toolsDirectory, root });
    const tools = installation.executables;
    const isolated = {
      ...isolatedEnvironment(
        path.join(directory, "environment"),
        path.join(toolsDirectory, "bin"),
        { temporaryDirectory },
      ),
      ...Object.fromEntries(
        [
          "GITHUB_ACTIONS",
          "GITHUB_EVENT_NAME",
          "GITHUB_EVENT_PATH",
          "GITHUB_SHA",
          "GITHUB_REF",
          "GITHUB_REPOSITORY",
          "GITHUB_RUN_ID",
          "GITHUB_RUN_ATTEMPT",
        ]
          .filter((key) => env[key] !== undefined)
          .map((key) => [key, env[key]]),
      ),
      HIMAWARI_CI_PYTHON: tools.python,
      HIMAWARI_CI_NPM: tools.npmCli,
      PLAYWRIGHT_BROWSERS_PATH:
        env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(root, ".ci-output/browsers"),
    };
    const run = async (name, executable, args, extra = {}) => {
      const result = await execute(executable, args, {
        cwd: root,
        env: { ...isolated, ...extra },
        log: path.join(directory, `${name}.log`),
        timeoutMs: policy.timeoutsMinutes[check] * 60_000 - (Date.now() - started),
      });
      report.commands.push({ name, ...result });
      if (result.exitCode !== 0) throw new Error(`CI_QUALITY_COMMAND_FAILED:${name}`);
    };
    if (check === "scale" || check === "thread-scale") {
      const prefix = check === "scale" ? "HIMAWARI_SCALE" : "HIMAWARI_THREAD_SCALE";
      const tests = path.join(directory, "tests.json");
      const evidence = path.join(directory, "measurement.json");
      await run(
        check,
        tools.node,
        [
          "node_modules/vitest/vitest.mjs",
          "run",
          "--config",
          "vitest.workspace.ts",
          "--project",
          check === "scale" ? "qualification-scale" : "qualification-thread-scale",
          "--maxWorkers",
          "1",
          "--reporter=json",
          `--outputFile=${tests}`,
        ],
        {
          [`${prefix}_QUALIFICATION`]: "1",
          [`${prefix}_WRITE_EVIDENCE`]: "1",
          [`${prefix}_EVIDENCE_PATH`]: evidence,
        },
      );
      report.observations.push({
        counts: vitestCounts(readJson(tests)),
        measurement: readJson(evidence),
        measurementSha256: fileSha256(evidence),
      });
    } else if (check === "dependencies") {
      const security = await runSecurityChecks({
        root,
        toolsDirectory,
        context,
        outputDirectory: path.join(directory, "security"),
      });
      report.observations.push({
        ...security,
        reports: [{ path: security.reportPath, kind: "json", sha256: security.reportSha256 }],
      });
      if (security.status !== "passed") throw new Error("CI_QUALITY_SECURITY_FAILED");
    } else if (check === "brands") {
      if (!artifact) throw new Error("CI_QUALITY_ARTIFACT_REQUIRED");
      const previous = process.env;
      process.env = isolated;
      try {
        for (const engine of policy.brands) {
          const outcome = await runBrowser({
            root,
            context,
            artifact,
            output: path.join(directory, engine),
            engine,
            port: 0,
          });
          report.observations.push(outcome);
          const counts = outcome.counts;
          if (
            outcome.exitCode !== 0 ||
            !counts ||
            ["files", "executed", "passed"].some(
              (field) => !Number.isSafeInteger(counts[field]) || counts[field] < 1,
            ) ||
            counts.passed !== counts.executed ||
            counts.failed !== 0 ||
            counts.skipped !== 0
          )
            throw new Error(`CI_QUALITY_BROWSER_FAILED:${engine}`);
        }
      } finally {
        process.env = previous;
      }
    } else {
      const observation = policy.nodeObservation;
      const platform = `${process.platform}-${process.arch}`;
      const distribution = observation.artifacts[platform];
      if (!distribution) throw new Error("CI_OBSERVATION_PLATFORM_UNAVAILABLE");
      const downloads = path.join(directory, "downloads");
      mkdirSync(downloads);
      const archive = await downloadArtifact(distribution, downloads);
      const prefix = path.join(directory, "node");
      extractArchive(archive, prefix);
      const executable = path.join(prefix, `node-v${observation.version}-${platform}`, "bin/node");
      const actual = execFileSync(executable, ["--version"], {
        env: isolated,
        encoding: "utf8",
      }).trim();
      if (actual !== `v${observation.version}`) throw new Error("CI_OBSERVATION_VERSION_MISMATCH");
      await run("node-typecheck", executable, [
        "node_modules/typescript/bin/tsc",
        "-p",
        "tsconfig.json",
      ]);
      await run("node-browser-typecheck", executable, [
        "node_modules/typescript/bin/tsc",
        "-p",
        "apps/control-center/tsconfig.json",
      ]);
      const tests = path.join(directory, "tests.json");
      await run("node-tooling", executable, [
        "node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "vitest.workspace.ts",
        "--project",
        "tooling",
        ...observation.testFiles,
        "--maxWorkers",
        "2",
        "--reporter=json",
        `--outputFile=${tests}`,
      ]);
      report.observations.push({
        node: actual.slice(1),
        counts: vitestCounts(readJson(tests)),
        scope: observation.scope,
        productSupported: false,
        sqliteAbiQualified: false,
      });
    }
    report.status = "passed";
  } catch (error) {
    report.error = redactText(error.message);
  }
  report.completedAt = new Date().toISOString();
  report.resources = await resourceObserver.stop();
  try {
    rmSync(temporaryDirectory, { recursive: true });
  } catch (error) {
    report.status = "failed";
    report.cleanupError = `CI_TEMP_CLEANUP_FAILED:${error.code}`;
  }
  writeFileSync(
    path.join(directory, "quality.json"),
    `${redactText(JSON.stringify(report, null, 2))}\n`,
    { flag: "wx" },
  );
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv, [
    "--check",
    "--output",
    "--tools",
    "--base",
    "--artifact",
    "--artifact-directory",
  ]);
  if (!args["--check"] || !args["--output"] || !args["--tools"])
    throw new Error("CI_QUALITY_ARGUMENTS_REQUIRED");
  let artifact = args["--artifact"];
  if (args["--artifact-directory"]) {
    if (artifact) throw new Error("CI_QUALITY_ARTIFACT_AMBIGUOUS");
    const directory = path.resolve(args["--artifact-directory"]);
    const archives = readdirSync(directory).filter((name) => name.endsWith(".tar.gz"));
    if (archives.length !== 1) throw new Error("CI_QUALITY_ARTIFACT_SET_INVALID");
    artifact = path.join(directory, archives[0]);
  }
  const report = await quality({
    check: args["--check"],
    output: args["--output"],
    toolsDirectory: path.resolve(args["--tools"]),
    base: args["--base"],
    artifact,
  });
  process.stdout.write(`${report.check}: ${report.status}\n`);
  process.exitCode = report.status === "passed" ? 0 : 1;
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${redactText(error.message)}\n`);
    process.exitCode = 1;
  }
}
