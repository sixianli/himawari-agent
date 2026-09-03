import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { digestFile } from "./artifact-files.mjs";
import { resolvePolicySource, validateVitestProjects } from "./check-policy.mjs";
import { outputPath, verifyContext } from "./context.mjs";
import { parseArguments, repositoryRoot } from "./contracts.mjs";
import { execute, sumCounts, vitestCounts } from "./execute.mjs";
import { verifyArtifact } from "./verify-artifact.mjs";

export const parseVitestReport = vitestCounts;

export async function runTests({ root = repositoryRoot, artifact, output, context } = {}) {
  verifyContext(context, { root });
  const destination = outputPath(output, root);
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(destination, { recursive: false });
  const policy = resolvePolicySource({ root, base: context.baseSha }).policy;
  const config = await import(pathToFileURL(path.join(root, "vitest.workspace.ts")).href);
  validateVitestProjects(policy, config.default);
  const verified = await verifyArtifact({ archive: artifact, root, context });
  const archive = path.join(destination, path.basename(artifact));
  await copyFile(artifact, archive);
  if ((await digestFile(archive)) !== verified.sha256)
    throw new Error("CI_TEST_ARTIFACT_COPY_CHANGED");
  const contextPath = path.join(destination, "context.json");
  await writeFile(contextPath, `${JSON.stringify(context)}\n`);
  const projects = [];
  const reports = [{ path: archive, kind: "artifact" }];
  const outcomes = [];
  const trackedFiles = [
    ...new Set(
      execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: root,
        encoding: "utf8",
      })
        .split("\0")
        .filter(Boolean),
    ),
  ];
  const selection = policy.checks.find((check) => check.id === "test").projects;
  for (const id of selection) {
    const json = path.join(destination, `${id}.json`);
    const junit = path.join(destination, `${id}.xml`);
    const log = path.join(destination, `${id}.log`);
    const outcome = await execute(
      process.execPath,
      [
        path.join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "--config",
        "vitest.workspace.ts",
        "--project",
        id,
        "--maxWorkers",
        "1",
        "--retry",
        "0",
        "--reporter=json",
        "--reporter=junit",
        `--outputFile.json=${json}`,
        `--outputFile.junit=${junit}`,
      ],
      {
        cwd: root,
        log,
        timeoutMs: 300_000,
        env: {
          ...process.env,
          NODE_PATH: "",
          NODE_OPTIONS: "",
          HIMAWARI_TEST_ARTIFACT: archive,
          HIMAWARI_TEST_CONTEXT: contextPath,
        },
      },
    );
    outcomes.push({ id, ...outcome });
    const report = JSON.parse(await readFile(json, "utf8"));
    const counts = parseVitestReport(report);
    if (outcome.exitCode === 0 && (counts.failed || counts.skipped))
      throw new Error(`CI_TEST_EXIT_CONTRADICTION:${id}`);
    const expected = policy.testProjects.find((project) => project.id === id);
    const expectedFiles = trackedFiles
      .filter(
        (filename) =>
          expected.include.some((glob) => path.matchesGlob(filename, glob)) &&
          !expected.exclude.some((glob) => path.matchesGlob(filename, glob)),
      )
      .sort();
    const actualFiles = report.testResults
      .map((file) => path.relative(root, file.name).split(path.sep).join("/"))
      .sort();
    if (JSON.stringify(expectedFiles) !== JSON.stringify(actualFiles))
      throw new Error(`CI_TEST_FILE_SET_MISMATCH:${id}`);
    for (const file of report.testResults) {
      const relative = path.relative(root, file.name).split(path.sep).join("/");
      if (
        !expected.include.some((glob) => path.matchesGlob(relative, glob)) ||
        expected.exclude.some((glob) => path.matchesGlob(relative, glob))
      )
        throw new Error(`CI_TEST_UNEXPECTED_FILE:${relative}`);
    }
    projects.push({ id, counts });
    reports.push(
      { path: json, kind: "json" },
      { path: junit, kind: "junit" },
      { path: log, kind: "diagnostic" },
    );
  }
  if (
    (await digestFile(archive)) !== verified.sha256 ||
    (await digestFile(artifact)) !== verified.sha256
  )
    throw new Error("CI_TEST_ARCHIVE_CHANGED");
  const counts = sumCounts(projects);
  const exitCode =
    outcomes.some((outcome) => outcome.exitCode !== 0) || counts.failed || counts.skipped ? 1 : 0;
  const summary = path.join(destination, "tests.json");
  await writeFile(
    summary,
    `${JSON.stringify({ status: exitCode ? "failed" : "passed", counts, projects, outcomes, archiveSha256: verified.sha256 }, null, 2)}\n`,
  );
  reports.push({ path: summary, kind: "json" });
  return {
    counts,
    projects,
    reports,
    artifact: {
      path: archive,
      sha256: verified.sha256,
      platform: verified.manifest.platform.os === "darwin" ? "macos-arm64" : "linux-x64",
    },
    exitCode,
  };
}

export async function testMain(
  argv = process.argv.slice(2),
  { root = repositoryRoot, stdout = process.stdout, stderr = process.stderr } = {},
) {
  try {
    const args = parseArguments(argv, ["--artifact", "--output", "--context"]);
    const result = await runTests({
      root,
      artifact: args["--artifact"],
      output: args["--output"],
      context: JSON.parse(await readFile(args["--context"], "utf8")),
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    return result.exitCode;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await testMain();
}
