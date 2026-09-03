import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runBrowser } from "./browser.mjs";
import { build } from "./build.mjs";
import { resolvePolicySource } from "./check-policy.mjs";
import { runSecurityChecks } from "./check-security.mjs";
import { createContext, outputPath, verifyContext } from "./context.mjs";
import {
  contextIdentity,
  existingInside,
  fileSha256,
  parseArguments,
  readJson,
  repositoryRoot,
  validateRecord,
} from "./contracts.mjs";
import { execute, sumCounts, vitestCounts } from "./execute.mjs";
import { isolatedEnvironment, verifyInstalledTools } from "./install-tools.mjs";
import { observeResources } from "./resources.mjs";
import { redactText } from "./security-redaction.mjs";
import { runTests } from "./test.mjs";

const json = (filename, value) =>
  writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const emptyCounts = () => ({ files: 0, executed: 0, passed: 0, failed: 0, skipped: 0 });

export function selectCheck(policy, id, key) {
  const check = policy.checks.find((entry) => entry.id === id && entry.id !== "required");
  if (!check) throw new Error(`CI_CHECK_UNSUPPORTED:${id}`);
  const member = check.members.find((entry) => entry.key === (key ?? "default"));
  if (!member) throw new Error(`CI_MATRIX_UNSUPPORTED:${id}/${key}`);
  return { check, member };
}

export function reportEntry(filename, kind, output) {
  const target = realpathSync(filename);
  const relative = path.relative(realpathSync(output), target);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !statSync(target).isFile()
  )
    throw new Error("CI_REPORT_OUTSIDE_CHECK_DIRECTORY");
  return {
    path: relative.split(path.sep).join("/"),
    kind,
    sha256: fileSha256(target),
    bytes: statSync(target).size,
  };
}

export async function runCheck({
  root = repositoryRoot,
  checkId,
  matrixKey,
  output,
  toolsDirectory,
  context,
  artifact,
  hosted = process.env.GITHUB_ACTIONS === "true",
}) {
  const directory = outputPath(output, root);
  const source = resolvePolicySource({ root, base: context.baseSha });
  const { check, member } = selectCheck(source.policy, checkId, matrixKey);
  if (existsSync(directory)) throw new Error("CI_OUTPUT_ALREADY_EXISTS");
  if (artifact && (!existsSync(artifact) || !statSync(artifact).isFile()))
    throw new Error("CI_ARTIFACT_INVALID");
  if (["test", "browser"].includes(checkId) && !artifact) throw new Error("CI_ARTIFACT_REQUIRED");
  mkdirSync(directory, { recursive: true });
  json(path.join(directory, "context.json"), context);
  const started = performance.now();
  const result = {
    schemaVersion: 1,
    checkId,
    matrixKey: member.key,
    ...contextIdentity(context),
    toolchain: {
      node: process.versions.node,
      npm: "unavailable",
      os: process.platform,
      arch: process.arch,
      abi: process.versions.modules,
      runnerImage: process.env.ImageVersion ?? "local",
    },
    status: "infrastructure_failed",
    exitCode: 1,
    durationMs: 0,
    retryCount: 0,
    counts: emptyCounts(),
    projects: [],
    reports: [],
    artifacts: [],
  };
  const details = {
    commands: [],
    failures: [],
    scope: hosted ? "hosted-policy-member" : "local-platform-evidence",
  };
  const files = [];
  const temporaryDirectory = mkdtempSync("/tmp/hci-");
  const stopResources = await observeResources({ root, toolsDirectory, temporaryDirectory });
  try {
    if (hosted && (member.os !== process.platform || member.arch !== process.arch))
      throw new Error("CI_RUNNER_PLATFORM_MISMATCH");
    const installation = await verifyInstalledTools({ directory: toolsDirectory, root });
    const tools = installation.executables;
    const env = {
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
          "GITHUB_REPOSITORY",
          "GITHUB_RUN_ID",
          "GITHUB_RUN_ATTEMPT",
        ]
          .filter((key) => process.env[key] !== undefined)
          .map((key) => [key, process.env[key]]),
      ),
      HIMAWARI_CI_PYTHON: tools.python,
      HIMAWARI_CI_NPM: tools.npmCli,
      PLAYWRIGHT_BROWSERS_PATH:
        process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(root, ".ci-output", "browsers"),
    };
    const version = execFileSync(tools.node, [tools.npmCli, "--version"], {
      env,
      encoding: "utf8",
    }).trim();
    if (
      process.versions.node !== member.node ||
      installation.node !== member.node ||
      version !== readJson(path.join(root, "ci/toolchain-lock.json")).npm.version
    )
      throw new Error("CI_EXECUTING_TOOLCHAIN_MISMATCH");
    result.toolchain.npm = version;
    const command = async (name, executable, args) => {
      const log = path.join(directory, `${name}.log`);
      const remaining = check.timeoutMinutes * 60_000 - (performance.now() - started);
      if (remaining <= 0) throw new Error("CI_CHECK_TIMEOUT");
      const outcome = await execute(executable, args, {
        cwd: root,
        env,
        log,
        timeoutMs: remaining,
      });
      files.push({ path: log, kind: "diagnostic" });
      details.commands.push({ name, ...outcome });
      if (outcome.exitCode !== 0) {
        result.status = outcome.error || outcome.termination ? "infrastructure_failed" : "failed";
        result.exitCode = outcome.exitCode;
        throw new Error(`CI_COMMAND_FAILED:${name}`);
      }
      return outcome;
    };
    const vitest = async (projects) => {
      for (const id of projects) {
        const filename = path.join(directory, `${id}.json`);
        const junit = path.join(directory, `${id}.xml`);
        const args = [
          path.join(root, "node_modules/vitest/vitest.mjs"),
          "run",
          "--config",
          "vitest.workspace.ts",
          "--project",
          id,
          "--maxWorkers",
          "2",
          "--reporter=json",
          "--reporter=junit",
          `--outputFile.json=${filename}`,
          `--outputFile.junit=${junit}`,
        ];
        files.push({ path: filename, kind: "json" }, { path: junit, kind: "junit" });
        await command(`vitest-${id}`, tools.node, args);
        const counts = vitestCounts(readJson(filename));
        if (counts.failed || counts.skipped) throw new Error(`CI_TEST_INCOMPLETE:${id}`);
        result.projects.push({ id, counts });
      }
      result.counts = sumCounts(result.projects);
    };
    if (checkId === "policy") {
      await command("policy", tools.node, [
        "scripts/ci/check-policy.mjs",
        "--base",
        context.baseSha,
      ]);
      await command("toolchain", tools.node, ["scripts/ci/install-tools.mjs", "--check"]);
      await command("governance-source", tools.node, ["scripts/ci/sync-governance.mjs", "--check"]);
      await vitest(check.projects);
    } else if (checkId === "static") {
      await command("check", tools.node, [tools.npmCli, "run", "check"]);
      await command("docs", tools.python, [
        "-E",
        "-s",
        "-B",
        "tools/document-governance/scripts/validate_docs.py",
        ".",
        "--strict",
      ]);
      await command("actionlint", tools.actionlint, [
        "-shellcheck=",
        ".github/workflows/ci.yml",
        ".github/workflows/quality.yml",
      ]);
      await command("diff", "git", ["diff", "--check"]);
      result.counts = { files: 4, executed: 4, passed: 4, failed: 0, skipped: 0 };
    } else if (checkId === "security") {
      const security = await runSecurityChecks({
        root,
        toolsDirectory,
        outputDirectory: path.join(directory, "security"),
        context,
      });
      files.push({ path: security.reportPath, kind: "json" });
      result.counts = {
        files: security.scannedCount,
        executed: security.checks.length,
        passed: security.checks.filter((entry) => entry.status === "passed").length,
        failed: security.checks.filter((entry) => entry.status !== "passed").length,
        skipped: 0,
      };
      if (security.status !== "passed") {
        result.status = security.status;
        throw new Error("CI_SECURITY_FAILED");
      }
    } else if (checkId === "coverage") {
      const coverageDirectory = path.join(directory, "coverage");
      const filename = path.join(directory, "tests.json");
      const snapshot = path.join(directory, "source-snapshot.json");
      const coverageReport = path.join(directory, "coverage-check.json");
      files.push(
        { path: filename, kind: "json" },
        { path: snapshot, kind: "json" },
        { path: coverageReport, kind: "json" },
        { path: path.join(coverageDirectory, "coverage-final.json"), kind: "json" },
        { path: path.join(coverageDirectory, "lcov.info"), kind: "lcov" },
      );
      await command("coverage-snapshot", tools.node, [
        "scripts/ci/check-coverage.mjs",
        "--mode",
        "snapshot",
        "--source-state",
        hosted ? "commit" : "working-tree",
        "--context",
        path.join(directory, "context.json"),
        "--output",
        snapshot,
      ]);
      await command("coverage", tools.node, [
        path.join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        "vitest.workspace.ts",
        ...check.projects.flatMap((id) => ["--project", id]),
        "--maxWorkers",
        "2",
        "--coverage",
        "--coverage.reportsDirectory",
        coverageDirectory,
        "--reporter=json",
        `--outputFile=${filename}`,
      ]);
      const testReport = readJson(filename);
      for (const id of check.projects) {
        const project = source.policy.testProjects.find((entry) => entry.id === id);
        const subset = testReport.testResults.filter((entry) => {
          const name = path.relative(root, entry.name).split(path.sep).join("/");
          return (
            project.include.some((glob) => path.matchesGlob(name, glob)) &&
            !project.exclude.some((glob) => path.matchesGlob(name, glob))
          );
        });
        if (!subset.length) throw new Error(`CI_COVERAGE_PROJECT_UNIDENTIFIED:${id}`);
        result.projects.push({ id, counts: vitestCounts({ success: true, testResults: subset }) });
      }
      result.counts = sumCounts(result.projects);
      await command("coverage-policy", tools.node, [
        "scripts/ci/check-coverage.mjs",
        "--context",
        path.join(directory, "context.json"),
        "--snapshot",
        snapshot,
        "--tests",
        filename,
        "--report",
        path.join(coverageDirectory, "coverage-final.json"),
        "--lcov",
        path.join(coverageDirectory, "lcov.info"),
        "--output",
        coverageReport,
      ]);
    } else {
      const previous = process.env;
      process.env = env;
      try {
        let outcome;
        if (checkId === "build" || checkId === "node-floor") {
          outcome = await build({ root, output: path.join(directory, "build"), context });
          if (checkId === "node-floor") {
            outcome = await runTests({
              root,
              artifact: outcome.archive,
              output: path.join(directory, "tests"),
              context,
            });
          }
        } else if (checkId === "test") {
          outcome = await runTests({
            root,
            artifact,
            output: path.join(directory, "tests"),
            context,
          });
        } else {
          outcome = await runBrowser({
            root,
            artifact,
            output: path.join(directory, "browser"),
            context,
            engine: member.browser,
            port: 0,
          });
        }
        result.counts = outcome.counts;
        result.projects = outcome.projects ?? [];
        for (const report of outcome.reports) if (report.kind !== "artifact") files.push(report);
        if (["build", "test", "browser"].includes(checkId)) {
          const archive = outcome.archive ?? outcome.artifact?.path ?? artifact;
          const retained = path.join(directory, path.basename(archive));
          if (path.resolve(archive) !== retained) copyFileSync(archive, retained);
          const entry = reportEntry(retained, "artifact", directory);
          files.push({ path: retained, kind: "artifact" });
          result.artifacts.push({
            role: checkId === "build" ? "produced" : "consumed",
            platform: process.platform === "darwin" ? "macos-arm64" : "linux-x64",
            path: entry.path,
            sha256: entry.sha256,
          });
        }
        if (outcome.exitCode !== 0) {
          result.status = "failed";
          result.exitCode =
            Number.isInteger(outcome.exitCode) && outcome.exitCode > 0 ? outcome.exitCode : 1;
          throw new Error(`CI_PIPELINE_FAILED:${checkId}:${result.exitCode}`);
        }
      } finally {
        process.env = previous;
      }
    }
    if (
      result.counts.files < 1 ||
      result.counts.executed < 1 ||
      result.counts.failed ||
      result.counts.skipped
    )
      throw new Error("CI_INCOMPLETE_EXECUTION");
    result.status = "passed";
    result.exitCode = 0;
  } catch (error) {
    details.failures.push(redactText(error.message));
  }
  details.resources = await stopResources();
  try {
    rmSync(temporaryDirectory, { recursive: true });
  } catch (error) {
    details.failures.push(`CI_TEMP_CLEANUP_FAILED:${error.code}`);
    result.status = "infrastructure_failed";
    result.exitCode = 1;
  }
  const detailsPath = path.join(directory, "details.json");
  json(detailsPath, details);
  files.push({ path: detailsPath, kind: "json" });
  for (const file of files)
    if (existsSync(file.path)) result.reports.push(reportEntry(file.path, file.kind, directory));
  result.durationMs = Math.round(performance.now() - started);
  validateRecord("CheckResult", result);
  json(path.join(directory, "result.json"), result);
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv, [
    "--check",
    "--matrix",
    "--base",
    "--context",
    "--output",
    "--tools",
    "--artifact",
    "--input",
  ]);
  for (const key of ["--check", "--output", "--tools"])
    if (!args[key]) throw new Error(`Missing argument: ${key}`);
  const context = args["--context"]
    ? verifyContext(readJson(args["--context"]))
    : createContext({ base: args["--base"] || undefined });
  let artifact = args["--artifact"] && path.resolve(args["--artifact"]);
  if (args["--input"]) {
    if (artifact) throw new Error("CI_ARTIFACT_INPUT_AMBIGUOUS");
    const producer = validateRecord("CheckResult", readJson(args["--input"]));
    const platform = process.platform === "darwin" ? "macos-arm64" : "linux-x64";
    if (
      producer.checkId !== "build" ||
      producer.matrixKey !== platform ||
      producer.status !== "passed" ||
      producer.artifacts.length !== 1
    )
      throw new Error("CI_ARTIFACT_PRODUCER_INVALID");
    for (const [key, value] of Object.entries(contextIdentity(context)))
      if (producer[key] !== value) throw new Error(`CI_ARTIFACT_CONTEXT_MISMATCH:${key}`);
    artifact = existingInside(path.dirname(args["--input"]), producer.artifacts[0].path);
    if (fileSha256(artifact) !== producer.artifacts[0].sha256)
      throw new Error("CI_ARTIFACT_TRANSFER_DIGEST_MISMATCH");
  }
  const result = await runCheck({
    checkId: args["--check"],
    matrixKey: args["--matrix"],
    output: args["--output"],
    toolsDirectory: path.resolve(args["--tools"]),
    context,
    artifact,
  });
  process.stdout.write(
    `${result.checkId}/${result.matrixKey}: ${result.status} (${result.counts.passed} passed, ${result.counts.failed} failed)\n`,
  );
  process.exitCode = result.exitCode;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${redactText(error.message)}\n`);
    process.exitCode = 1;
  }
}
