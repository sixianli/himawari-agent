import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { outputPath } from "./context.mjs";
import {
  existingInside,
  fileSha256,
  parseArguments,
  readJson,
  repositoryRoot,
  validateRecord,
} from "./contracts.mjs";
import { verifyInstalledTools } from "./install-tools.mjs";
import { reportEntry } from "./run.mjs";
import { assertPublicArtifacts, redactText } from "./security-redaction.mjs";

export function redactReport(text, kind, sentinels) {
  if (kind !== "json") return redactText(text, { sentinels });
  const parsed = JSON.parse(text);
  const canonical = JSON.stringify(parsed);
  // JSON.parse validated the grammar; preserve string tokens while removing only external whitespace.
  const compact = text.replace(/"(?:[^"\\]|\\.)*"|[ \t\r\n]+/gu, (token) =>
    token.startsWith('"') ? token : "",
  );
  let changed = false;
  const redacted = JSON.stringify(
    parsed,
    (_key, value) => {
      if (typeof value !== "string") return value;
      const output = redactText(value, { sentinels });
      if (output !== value) changed = true;
      return output;
    },
    2,
  );
  if (
    !changed &&
    compact === canonical &&
    redactText(text, { sentinels }) === text &&
    redactText(canonical, { sentinels }) === canonical
  )
    return text;
  return `${redacted}\n`;
}

async function stagedPublication(output, root, prepare) {
  const target = outputPath(output, root);
  if (existsSync(target)) throw new Error("CI_PUBLIC_OUTPUT_EXISTS");
  mkdirSync(path.dirname(target), { recursive: true });
  const staging = mkdtempSync(path.join(path.dirname(target), ".publish-"));
  try {
    const result = await prepare(staging);
    if (existsSync(target)) throw new Error("CI_PUBLIC_OUTPUT_EXISTS");
    renameSync(staging, target);
    return result;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function publish({ input, output, root = repositoryRoot, sentinels = [], python }) {
  return stagedPublication(output, root, async (directory) => {
    const result = validateRecord("CheckResult", readJson(path.join(input, "result.json")));
    const reports = path.join(directory, "reports");
    const diagnostics = path.join(directory, "diagnostics");
    mkdirSync(reports, { recursive: true });
    mkdirSync(diagnostics);
    const entries = [];
    const retained = [];
    for (const report of result.reports) {
      const source = existingInside(input, report.path);
      if (fileSha256(source) !== report.sha256)
        throw new Error(`CI_PUBLIC_SOURCE_CHANGED:${report.path}`);
      const diagnostic = /\.(?:png|jpe?g|webp|zip)$/u.test(report.path);
      const target = path.join(diagnostic ? diagnostics : reports, report.path);
      mkdirSync(path.dirname(target), { recursive: true });
      const binary = diagnostic || report.kind === "artifact";
      if (binary) copyFileSync(source, target);
      else
        writeFileSync(target, redactReport(readFileSync(source, "utf8"), report.kind, sentinels), {
          flag: "wx",
        });
      const kind =
        report.kind === "artifact"
          ? "artifact"
          : report.kind === "diagnostic"
            ? diagnostic
              ? report.path.endsWith(".zip")
                ? "trace"
                : "screenshot"
              : "log"
            : report.kind;
      entries.push({
        path: path.relative(directory, target),
        kind,
        classification:
          report.kind === "artifact" ? "build" : diagnostic ? "synthetic" : "redacted",
        sha256: fileSha256(target),
      });
      if (!diagnostic) retained.push(reportEntry(target, report.kind, reports));
    }
    const published = { ...result, reports: retained };
    validateRecord("CheckResult", published);
    const resultPath = path.join(reports, "result.json");
    writeFileSync(resultPath, `${JSON.stringify(published, null, 2)}\n`, { flag: "wx" });
    entries.push({
      path: "reports/result.json",
      kind: "json",
      classification: "redacted",
      sha256: fileSha256(resultPath),
    });
    const publicReviews = [];
    await assertPublicArtifacts({
      root: directory,
      entries,
      allowed: entries.map(({ path: pathname, kind }) => ({ path: pathname, kind })),
      sentinels,
      python,
      context: Object.fromEntries(
        [
          "repository",
          "event",
          "runId",
          "attempt",
          "testedSha",
          "headSha",
          "baseSha",
          "policySha256",
          "toolchainSha256",
          "initialization",
        ].map((key) => [key, result[key]]),
      ),
      policyRoot: root,
      onReview: (review) => publicReviews.push(review),
    });
    if (publicReviews.length) {
      const reviewPath = path.join(reports, "public-review.json");
      writeFileSync(
        reviewPath,
        `${JSON.stringify({ schemaVersion: 1, reviews: publicReviews }, null, 2)}\n`,
        { flag: "wx" },
      );
      retained.push(reportEntry(reviewPath, "json", reports));
      validateRecord("CheckResult", published);
      writeFileSync(resultPath, `${JSON.stringify(published, null, 2)}\n`);
      const metadata = [reviewPath, resultPath].map((file) => ({
        path: path.relative(directory, file),
        kind: "json",
        classification: "redacted",
        sha256: fileSha256(file),
      }));
      await assertPublicArtifacts({
        root: directory,
        entries: metadata,
        allowed: metadata.map(({ path: pathname, kind }) => ({ path: pathname, kind })),
        sentinels,
      });
    }
    return published;
  });
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv, ["--input", "--output", "--mode", "--tools"]);
  if (!args["--input"] || !args["--output"]) throw new Error("CI_PUBLIC_INPUT_REQUIRED");
  const python = args["--tools"]
    ? verifyInstalledTools({ directory: args["--tools"] }).executables.python
    : undefined;
  if (args["--mode"] === "quality")
    return publishQuality({ input: args["--input"], output: args["--output"], python });
  if (args["--mode"] && args["--mode"] !== "check") throw new Error("CI_PUBLIC_MODE_INVALID");
  return publish({ input: args["--input"], output: args["--output"], python });
}

export async function publishQuality({
  input,
  output,
  root = repositoryRoot,
  sentinels = [],
  python,
}) {
  return stagedPublication(output, root, async (directory) => {
    const report = readJson(path.join(input, "quality.json"));
    const expected = [
      "quality.json",
      "tests.json",
      "measurement.json",
      ...(report.commands ?? []).map(({ name }) => `${name}.log`),
    ];
    for (const observation of report.observations ?? [])
      for (const entry of observation.reports ?? []) {
        if (
          entry.sha256 &&
          fileSha256(existingInside(input, path.relative(input, entry.path))) !== entry.sha256
        )
          throw new Error("CI_QUALITY_REPORT_CHANGED");
        if (entry.kind !== "artifact") expected.push(path.relative(input, entry.path));
      }
    const entries = [];
    for (const relative of [...new Set(expected)]) {
      if (!existsSync(path.join(input, relative))) continue;
      const source = existingInside(input, relative);
      const diagnostic = /\.(png|jpe?g|webp|zip)$/u.test(relative);
      const target = path.join(directory, diagnostic ? "diagnostics" : "reports", relative);
      mkdirSync(path.dirname(target), { recursive: true });
      if (diagnostic) copyFileSync(source, target);
      else
        writeFileSync(
          target,
          redactReport(
            readFileSync(source, "utf8"),
            relative.endsWith(".json") ? "json" : "log",
            sentinels,
          ),
          {
            flag: "wx",
          },
        );
      const kind = diagnostic
        ? relative.endsWith(".zip")
          ? "trace"
          : "screenshot"
        : relative.endsWith(".json")
          ? "json"
          : relative.endsWith(".xml")
            ? "junit"
            : "log";
      entries.push({
        path: path.relative(directory, target),
        kind,
        classification: diagnostic ? "synthetic" : "redacted",
        sha256: fileSha256(target),
      });
    }
    await assertPublicArtifacts({
      root: directory,
      entries,
      allowed: entries.map(({ path: pathname, kind }) => ({ path: pathname, kind })),
      sentinels,
      python,
      context: report.context,
      policyRoot: root,
    });
    return entries;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${redactText(error.message)}\n`);
    process.exitCode = 1;
  }
}
