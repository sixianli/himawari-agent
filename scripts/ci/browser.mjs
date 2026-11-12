import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { digestFile } from "./artifact-files.mjs";
import { outputPath, verifyContext } from "./context.mjs";
import { parseArguments, repositoryRoot } from "./contracts.mjs";
import { execute } from "./execute.mjs";
import { artifactPlatformKey } from "./platforms.mjs";
import { verifyArtifact } from "./verify-artifact.mjs";

export async function browserReportFiles(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort()
    .map((file) => ({ path: file, kind: file.endsWith(".json") ? "json" : "diagnostic" }));
}

export function browserCounts(report, engine) {
  if (
    !report ||
    report.status !== "passed" ||
    report.scope !== "fixture-only" ||
    report.engine !== (["chrome", "edge"].includes(engine) ? "chromium" : engine) ||
    report.profile !== engine ||
    !report.browserVersion
  )
    throw new Error("CI_BROWSER_IDENTITY_OR_STATUS_INVALID");
  for (const [key, expected] of [
    ["locales", ["zh-CN", "en", "ja"]],
    ["keyboard", ["visible-focus", "settings-keyboard-navigation"]],
  ]) {
    if (JSON.stringify(report[key]) !== JSON.stringify(expected))
      throw new Error(`CI_BROWSER_COVERAGE_MISSING:${key}`);
  }
  if (
    report.axeViolations !== 0 ||
    !report.keyboardFocus?.visible ||
    !report.keyboardFocus?.accessibleName
  )
    throw new Error("CI_BROWSER_ACCESSIBILITY_FAILED");
  for (const key of ["journeys", "routeStates", "sse", "responsive", "surfaces"])
    if (
      !Array.isArray(report[key]) ||
      report[key].length === 0 ||
      new Set(report[key].map((entry) => JSON.stringify(entry))).size !== report[key].length
    )
      throw new Error(`CI_BROWSER_EMPTY_OR_DUPLICATE_SCENARIOS:${key}`);
  const executed = [
    "journeys",
    "routeStates",
    "sse",
    "responsive",
    "surfaces",
    "locales",
    "keyboard",
  ].reduce((total, key) => total + report[key].length, 0);
  return { files: 1, executed, passed: executed, failed: 0, skipped: 0 };
}

export async function runBrowser({
  root = repositoryRoot,
  artifact,
  output,
  context,
  engine,
  port = 0,
} = {}) {
  verifyContext(context, { root });
  if (!["chromium", "firefox", "webkit", "chrome", "edge"].includes(engine))
    throw new Error("CI_BROWSER_ENGINE_UNSUPPORTED");
  if (process.env.HIMAWARI_FIREFOX_EXECUTABLE)
    throw new Error("CI_BROWSER_EXECUTABLE_OVERRIDE_FORBIDDEN");
  const destination = outputPath(output, root);
  await mkdir(path.dirname(destination), { recursive: true });
  await mkdir(destination, { recursive: false });
  const payload = path.join(destination, "payload");
  try {
    const verified = await verifyArtifact({ archive: artifact, root, context, extractTo: payload });
    const archive = path.join(destination, path.basename(artifact));
    await copyFile(artifact, archive);
    if ((await digestFile(archive)) !== verified.sha256)
      throw new Error("CI_BROWSER_ARTIFACT_COPY_CHANGED");
    const log = path.join(destination, "browser.log");
    const reportDirectory = path.join(destination, "reports");
    const outcome = await execute(
      process.execPath,
      [
        path.join(root, "scripts/qualify-control-center-browser.mjs"),
        engine,
        "--static-root",
        path.join(payload, "browser"),
        "--report-directory",
        reportDirectory,
        "--port",
        String(port),
      ],
      { cwd: root, env: process.env, log, timeoutMs: 300_000 },
    );
    const report = JSON.parse(await readFile(path.join(reportDirectory, "browser.json"), "utf8"));
    const counts =
      outcome.exitCode === 0
        ? browserCounts(report, engine)
        : { files: 1, executed: 1, passed: 0, failed: 1, skipped: 0 };
    if (
      (await digestFile(artifact)) !== verified.sha256 ||
      (await digestFile(archive)) !== verified.sha256
    )
      throw new Error("CI_BROWSER_ARCHIVE_CHANGED");
    const reports = [
      { path: archive, kind: "artifact" },
      { path: log, kind: "diagnostic" },
    ];
    reports.push(...(await browserReportFiles(reportDirectory)));
    const summary = path.join(destination, "browser-execution.json");
    await writeFile(
      summary,
      `${JSON.stringify({ ...outcome, counts, archiveSha256: verified.sha256, scope: "fixture-only" }, null, 2)}\n`,
    );
    reports.push({ path: summary, kind: "json" });
    return {
      counts,
      projects: [],
      reports,
      artifact: {
        path: archive,
        sha256: verified.sha256,
        platform: artifactPlatformKey(
          verified.manifest.platform.os,
          verified.manifest.platform.arch,
        ),
      },
      exitCode: outcome.exitCode,
    };
  } finally {
    await rm(payload, { recursive: true, force: true });
  }
}

export async function browserMain(
  argv = process.argv.slice(2),
  { root = repositoryRoot, stdout = process.stdout, stderr = process.stderr } = {},
) {
  try {
    const args = parseArguments(argv, [
      "--artifact",
      "--output",
      "--context",
      "--engine",
      "--port",
    ]);
    const result = await runBrowser({
      root,
      artifact: args["--artifact"],
      output: args["--output"],
      context: JSON.parse(await readFile(args["--context"], "utf8")),
      engine: args["--engine"],
      port: args["--port"] === undefined ? 0 : Number(args["--port"]),
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    return result.exitCode;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await browserMain();
}
