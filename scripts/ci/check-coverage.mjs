import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePolicySource } from "./check-policy.mjs";
import { outputPath } from "./context.mjs";
import {
  contextIdentity,
  parseArguments,
  readJson,
  repositoryRoot,
  safeRelativePath,
  sha256,
  validateRecord,
} from "./contracts.mjs";
import {
  analyzeCoverage,
  coverageDigest,
  evaluateCoverage,
  inCoverageScope,
  mappingIdentity,
  strategyDigest,
  validateCoveragePolicy,
  verifyLcov,
} from "./coverage-model.mjs";

const assert = (condition, message) => {
  if (!condition) throw new Error(`COVERAGE_INVALID: ${message}`);
};
const git = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export function collectSources(root, policy) {
  const sourceRoot = realpathSync(root);
  const sources = new Map();
  const walk = (relative) => {
    const directory = path.join(sourceRoot, relative);
    if (!existsSync(directory)) return;
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", "coverage", ".git"].includes(item.name)) continue;
      const filename = path.posix.join(relative, item.name);
      const actual = path.join(sourceRoot, filename);
      assert(!item.isSymbolicLink(), `symbolic link in production source: ${filename}`);
      if (item.isDirectory()) walk(filename);
      else if (item.isFile() && inCoverageScope(filename, policy))
        sources.set(filename, readFileSync(actual, "utf8"));
    }
  };
  for (const relative of ["apps", "packages", "scripts/ci"]) walk(relative);
  assert(sources.size > 0, "production source inventory is empty");
  return sources;
}

export function sourceTreeDigest(sources) {
  return sha256(
    [...sources]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([filename, source]) => `${filename}\0${sha256(source)}\n`)
      .join(""),
  );
}

function collectTestSources(root, policy) {
  const selected = policy.testProjects.filter((project) =>
    ["unit", "contracts", "tooling"].includes(project.id),
  );
  const files = new Map();
  const walk = (relative) => {
    if (!existsSync(path.join(root, relative))) return;
    for (const item of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (["node_modules", "dist", ".git"].includes(item.name)) continue;
      const filename = path.posix.join(relative, item.name);
      assert(!item.isSymbolicLink(), `symbolic link in test inventory: ${filename}`);
      if (item.isDirectory()) walk(filename);
      else if (
        item.isFile() &&
        selected.some(
          (project) =>
            project.include.some((glob) => path.matchesGlob(filename, glob)) &&
            !project.exclude.some((glob) => path.matchesGlob(filename, glob)),
        )
      )
        files.set(filename, readFileSync(path.join(root, filename), "utf8"));
    }
  };
  for (const directory of ["apps", "packages", "test"]) walk(directory);
  return files;
}

export function verifyCoverageTools(root, policy) {
  assert(
    policy.provider.version === "4.1.9" && policy.provider.mapping === mappingIdentity,
    "unsupported or incomparable coverage mapping/tool version",
  );
  const lock = readJson(path.join(root, "package-lock.json"));
  const expected = {
    vitest: "4.1.9",
    "@vitest/coverage-v8": "4.1.9",
    "ast-v8-to-istanbul": "1.0.5",
  };
  for (const [name, version] of Object.entries(expected)) {
    const relative = `node_modules/${name}`;
    assert(lock.packages?.[relative]?.version === version, `locked coverage tool differs: ${name}`);
    const location = path.join(root, relative);
    assert(
      realpathSync(location).startsWith(`${realpathSync(root)}${path.sep}`),
      `coverage tool escaped checkout: ${name}`,
    );
    assert(
      readJson(path.join(location, "package.json")).version === version,
      `installed coverage tool differs: ${name}`,
    );
  }
  return expected;
}

export function createSnapshot({ root, context, policy, sourceState = "commit" }) {
  validateRecord("Context", context);
  validateCoveragePolicy(policy);
  assert(["commit", "working-tree"].includes(sourceState), "invalid source state");
  assert(
    sha256(readFileSync(path.join(root, "ci/toolchain-lock.json"))) === context.toolchainSha256,
    "toolchain does not match context",
  );
  const tested = git(root, ["rev-parse", "--verify", `${context.testedSha}^{commit}`]).trim();
  assert(
    tested === context.testedSha && git(root, ["rev-parse", "HEAD"]).trim() === tested,
    "checkout does not match tested SHA",
  );
  const sources = collectSources(root, policy);
  if (sourceState === "commit")
    for (const [filename, source] of sources) {
      assert(
        git(root, ["show", `${tested}:${filename}`]) === source,
        `production source differs from tested commit: ${filename}`,
      );
    }
  return {
    schemaVersion: 1,
    capturedAt: Date.now(),
    ...contextIdentity(context),
    sourceState,
    strategySha256: strategyDigest(policy),
    sourceTreeSha256: sourceTreeDigest(sources),
    files: Object.fromEntries([...sources].map(([filename, source]) => [filename, sha256(source)])),
    inputs: Object.fromEntries([
      ...["package.json", "package-lock.json", "vitest.workspace.ts", "ci/policy.json"].map(
        (filename) => [filename, sha256(readFileSync(path.join(root, filename)))],
      ),
      ...[...collectTestSources(root, readJson(path.join(root, "ci/policy.json")))].map(
        ([filename, source]) => [filename, sha256(source)],
      ),
    ]),
    tools: verifyCoverageTools(root, policy),
  };
}

export function verifySnapshot(snapshot, current) {
  assert(
    snapshot &&
      typeof snapshot === "object" &&
      JSON.stringify(Object.keys(snapshot).sort()) === JSON.stringify(Object.keys(current).sort()),
    "invalid measurement snapshot fields",
  );
  assert(
    Number.isSafeInteger(snapshot.capturedAt) &&
      snapshot.capturedAt > 0 &&
      snapshot.capturedAt <= current.capturedAt,
    "invalid snapshot capture time",
  );
  for (const key of Object.keys(current).filter((key) => key !== "capturedAt"))
    assert(
      JSON.stringify(snapshot[key]) === JSON.stringify(current[key]),
      `measurement snapshot changed: ${key}`,
    );
  return true;
}

export function verifyReportProvenance(report, coverage, snapshot) {
  assert(
    Number.isSafeInteger(report.startTime) &&
      report.startTime >= snapshot.capturedAt &&
      report.startTime <= Date.now(),
    "coverage test run predates its source snapshot",
  );
  assert(
    report.coverageMap && coverageDigest(report.coverageMap) === coverageDigest(coverage),
    "coverage JSON differs from measured test run",
  );
}

export function parseDiffHunks(text) {
  const hunks = [];
  for (const line of text.split("\n")) {
    assert(
      !/^Binary files .+ and .+ differ$/u.test(line) && line !== "GIT binary patch",
      "binary production source cannot be mapped",
    );
    if (!line.startsWith("@@")) continue;
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/u.exec(line);
    assert(match, "malformed git hunk");
    const [, oldStart, oldCount = "1", newStart, newCount = "1"] = match;
    hunks.push({
      oldStart: Number(oldStart),
      oldCount: Number(oldCount),
      newStart: Number(newStart),
      newCount: Number(newCount),
    });
  }
  return hunks;
}

export function mapLineToTested(line, hunks) {
  let offset = 0;
  for (const hunk of hunks) {
    if (hunk.oldCount === 0) {
      if (line > hunk.oldStart) offset += hunk.newCount;
    } else if (line >= hunk.oldStart && line < hunk.oldStart + hunk.oldCount) {
      throw new Error(
        "COVERAGE_INCOMPARABLE: PR head change was modified in tested merge; changed location cannot be mapped exactly",
      );
    } else if (line >= hunk.oldStart + hunk.oldCount) offset += hunk.newCount - hunk.oldCount;
  }
  return line + offset;
}

export function resolveCoverageDiff({ root, context, sources, sourceState = "commit" }) {
  validateRecord("Context", context);
  for (const sha of [context.baseSha, context.headSha, context.testedSha])
    assert(
      git(root, ["rev-parse", "--verify", `${sha}^{commit}`]).trim() === sha,
      "diff endpoint is not a verifiable commit",
    );
  const base =
    context.event === "pull_request"
      ? git(root, ["merge-base", context.baseSha, context.headSha]).trim()
      : context.baseSha;
  assert(/^[a-f0-9]{40}$/u.test(base), "diff base is missing");
  if (context.event === "push")
    assert(context.headSha === context.testedSha, "push must test its after SHA");
  const target = sourceState === "working-tree" ? [] : [context.headSha];
  const statusBytes = git(root, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--name-status",
    "-z",
    base,
    ...target,
  ]);
  const status = statusBytes.split("\0").filter(Boolean);
  assert(status.length % 2 === 0, "malformed changed-file list");
  const files = [];
  const changed = {};
  const deleted = [];
  const patches = [];
  for (let index = 0; index < status.length; index += 2) {
    const state = status[index];
    const filename = status[index + 1];
    assert(
      safeRelativePath(filename) && ["A", "M", "D", "T"].includes(state),
      `unsupported diff entry: ${filename}`,
    );
    files.push({ path: filename, status: state });
    if (state === "D") {
      deleted.push(filename);
      continue;
    }
    if (!sources.has(filename)) continue;
    const patch = git(root, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--unified=0",
      base,
      ...target,
      "--",
      filename,
    ]);
    patches.push(`${filename}\0${patch}`);
    const hunks = parseDiffHunks(patch);
    assert(
      hunks.length > 0 || patch.includes("old mode "),
      `changed source has no mapped hunk: ${filename}`,
    );
    const shift =
      sourceState === "commit" && context.headSha !== context.testedSha
        ? parseDiffHunks(
            git(root, [
              "diff",
              "--no-ext-diff",
              "--no-textconv",
              "--no-renames",
              "--unified=0",
              context.headSha,
              context.testedSha,
              "--",
              filename,
            ]),
          )
        : [];
    changed[filename] = hunks.flatMap((hunk) => {
      // Preserve each head line: merge-only insertions must not enter the PR denominator.
      if (hunk.newCount)
        return Array.from({ length: hunk.newCount }, (_, index) => {
          const line = mapLineToTested(hunk.newStart + index, shift);
          return { start: line, end: line, kind: "added" };
        });
      const boundary = mapLineToTested(hunk.newStart, shift);
      return [{ start: boundary, end: boundary, kind: "deletion-context" }];
    });
  }
  if (sourceState === "working-tree") {
    const tracked = new Set(git(root, ["ls-files", "-z"]).split("\0").filter(Boolean));
    for (const [filename, source] of sources)
      if (!tracked.has(filename)) {
        files.push({ path: filename, status: "A" });
        changed[filename] = [{ start: 1, end: source.split(/\r?\n/u).length, kind: "added" }];
        patches.push(`${filename}\0${sha256(source)}`);
      }
  }
  return {
    baseSha: base,
    headSha: context.headSha,
    testedSha: context.testedSha,
    sourceState,
    files,
    changed,
    deleted,
    sha256: sha256(`${statusBytes}\0${patches.sort().join("\0")}`),
  };
}

export function verifyTestRun(report, policy, root) {
  assert(
    report &&
      report.success === true &&
      report.numFailedTests === 0 &&
      report.numPendingTests === 0 &&
      report.numTodoTests === 0 &&
      report.numTotalTests > 0 &&
      Array.isArray(report.testResults),
    "coverage test run failed, skipped, or is empty",
  );
  const selected = policy.testProjects.filter((project) =>
    ["unit", "contracts", "tooling"].includes(project.id),
  );
  const counts = Object.fromEntries(
    selected.map((project) => [
      project.id,
      { files: 0, executed: 0, passed: 0, failed: 0, skipped: 0 },
    ]),
  );
  const paths = new Set();
  for (const file of report.testResults) {
    const filename = path.isAbsolute(file.name)
      ? path.relative(root, file.name).split(path.sep).join("/")
      : file.name;
    const projects = selected.filter(
      (project) =>
        project.include.some((glob) => path.matchesGlob(filename, glob)) &&
        !project.exclude.some((glob) => path.matchesGlob(filename, glob)),
    );
    assert(
      safeRelativePath(filename) && projects.length === 1 && !paths.has(filename),
      `unexpected/duplicate coverage test file: ${filename}`,
    );
    assert(
      file.status === "passed" &&
        Array.isArray(file.assertionResults) &&
        file.assertionResults.length > 0 &&
        file.assertionResults.every((test) => test.status === "passed"),
      `incomplete coverage test file: ${filename}`,
    );
    paths.add(filename);
    const value = counts[projects[0].id];
    value.files += 1;
    value.executed += file.assertionResults.length;
    value.passed += file.assertionResults.length;
  }
  assert(
    Object.values(counts).every((value) => value.executed > 0),
    "coverage must execute all three projects",
  );
  assert(
    Object.values(counts).reduce((sum, value) => sum + value.executed, 0) === report.numTotalTests,
    "coverage test totals contradict report",
  );
  const inventory = collectTestSources(root, policy);
  assert(
    inventory.size === paths.size && [...inventory.keys()].every((filename) => paths.has(filename)),
    "coverage test file inventory is incomplete",
  );
  return Object.entries(counts).map(([id, value]) => ({ id, counts: value }));
}

export function verifyComparison({ root, policy, acceptedPolicy, testPolicy, manifest }) {
  assert(acceptedPolicy?.baseline, "comparison requires an accepted baseline");
  assert(
    manifest &&
      typeof manifest === "object" &&
      JSON.stringify(Object.keys(manifest).sort()) ===
        JSON.stringify(["root", "context", "snapshot", "report", "lcov", "tests"].sort()),
    "invalid comparison manifest",
  );
  const oldRoot = realpathSync(manifest.root);
  assert(
    oldRoot !== realpathSync(root) && !oldRoot.startsWith(`${realpathSync(root)}${path.sep}`),
    "comparison must use an isolated checkout",
  );
  const evidence = (key) => {
    assert(
      safeRelativePath(manifest[key]) && manifest[key].startsWith(".ci-output/"),
      "comparison evidence must be under its checkout .ci-output",
    );
    const actual = realpathSync(path.join(oldRoot, manifest[key]));
    assert(
      actual.startsWith(`${oldRoot}${path.sep}.ci-output${path.sep}`),
      "comparison evidence escaped isolated checkout",
    );
    return actual;
  };
  const context = readJson(evidence("context"));
  const snapshot = readJson(evidence("snapshot"));
  assert(snapshot.sourceState === "commit", "comparison must measure committed baseline sources");
  verifySnapshot(snapshot, createSnapshot({ root: oldRoot, context, policy }));
  const sources = collectSources(oldRoot, policy);
  const acceptedSourceTree = sourceTreeDigest(collectSources(oldRoot, acceptedPolicy));
  assert(
    acceptedSourceTree === acceptedPolicy.baseline.sourceTreeSha256,
    "comparison source tree differs from accepted baseline",
  );
  const testRun = readJson(evidence("tests"));
  verifyTestRun(testRun, testPolicy, oldRoot);
  const report = readFileSync(evidence("report"));
  verifyReportProvenance(testRun, JSON.parse(report), snapshot);
  const lcov = readFileSync(evidence("lcov"), "utf8");
  const analysis = analyzeCoverage({
    coverage: JSON.parse(report),
    sources,
    policy,
    root: oldRoot,
  });
  verifyLcov(lcov, analysis, oldRoot);
  verifySnapshot(snapshot, createSnapshot({ root: oldRoot, context, policy }));
  return {
    sourceTreeSha256: acceptedSourceTree,
    measuredSourceTreeSha256: analysis.sourceTreeSha256,
    strategySha256: strategyDigest(policy),
    reportSha256: sha256(report),
    lcovSha256: sha256(lcov),
    groups: analysis.groups,
  };
}

function writeOutput(root, filename, value, baseline = false) {
  const actual = path.resolve(root, filename);
  const relative = path.relative(root, actual).split(path.sep).join("/");
  assert(
    safeRelativePath(relative) &&
      (relative.startsWith(".ci-output/") || (baseline && relative === "ci/coverage-policy.json")),
    "output must be inside .ci-output or explicit coverage baseline",
  );
  if (relative.startsWith(".ci-output/")) outputPath(actual, root);
  else
    assert(
      realpathSync(path.dirname(actual)) === path.dirname(actual),
      "baseline parent is a symbolic link",
    );
  assert(
    !existsSync(actual) ||
      (baseline && !lstatSync(actual).isSymbolicLink() && lstatSync(actual).isFile()),
    "output already exists or is not a regular baseline file",
  );
  mkdirSync(path.dirname(actual), { recursive: true });
  writeFileSync(actual, `${JSON.stringify(value, null, 2)}\n`, { flag: baseline ? "w" : "wx" });
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv, [
    "--root",
    "--context",
    "--report",
    "--lcov",
    "--tests",
    "--snapshot",
    "--output",
    "--mode",
    "--source-state",
    "--baseline-output",
    "--comparison",
  ]);
  const root = realpathSync(path.resolve(args["--root"] ?? repositoryRoot));
  const mode = args["--mode"] ?? "check";
  assert(["snapshot", "check", "measure"].includes(mode), "unknown coverage mode");
  assert(args["--context"] && args["--output"], "context and output are required");
  assert(
    mode !== "measure" || args["--baseline-output"],
    "explicit measurement needs a baseline output",
  );
  assert(
    mode === "measure" || !args["--baseline-output"],
    "only explicit measurement can write a baseline",
  );
  const context = validateRecord("Context", readJson(args["--context"]));
  const policy = validateCoveragePolicy(readJson(path.join(root, "ci/coverage-policy.json")));
  const source = resolvePolicySource({ root, base: context.baseSha });
  assert(
    source.initialization === context.initialization &&
      source.policySha256 === context.policySha256,
    "context does not identify accepted policy",
  );
  const sourceState =
    args["--source-state"] ??
    (args["--snapshot"] ? readJson(args["--snapshot"]).sourceState : "commit");
  const current = createSnapshot({ root, context, policy, sourceState });
  if (mode === "snapshot") {
    writeOutput(root, args["--output"], current);
    return { status: "passed", snapshot: current };
  }
  for (const flag of ["--report", "--lcov", "--tests", "--snapshot"])
    assert(args[flag], `missing argument ${flag}`);
  verifySnapshot(readJson(args["--snapshot"]), current);
  const testRun = readJson(args["--tests"]);
  const projects = verifyTestRun(testRun, source.policy, root);
  const sources = collectSources(root, policy);
  const reportBytes = readFileSync(args["--report"]);
  const lcov = readFileSync(args["--lcov"], "utf8");
  verifyReportProvenance(testRun, JSON.parse(reportBytes), readJson(args["--snapshot"]));
  const analysis = analyzeCoverage({ coverage: JSON.parse(reportBytes), sources, policy, root });
  verifyLcov(lcov, analysis, root);
  const diff = resolveCoverageDiff({ root, context, sources, sourceState });
  const result = {
    schemaVersion: 1,
    ...contextIdentity(context),
    ...evaluateCoverage({
      acceptedPolicy: source.coverage,
      proposedPolicy: policy,
      analysis,
      changed: diff.changed,
      deleted: diff.deleted,
      initialization: source.initialization,
      comparison: args["--comparison"]
        ? verifyComparison({
            root,
            policy,
            acceptedPolicy: source.coverage,
            testPolicy: source.policy,
            manifest: readJson(args["--comparison"]),
          })
        : undefined,
    }),
    sourceState,
    sourceTreeSha256: analysis.sourceTreeSha256,
    reportSha256: sha256(reportBytes),
    lcovSha256: sha256(lcov),
    strategySha256: strategyDigest(policy),
    projects,
    files: Object.keys(analysis.files).length,
    diff,
  };
  // Recheck all sources after parsing the report; concurrent edits invalidate the measurement.
  verifySnapshot(current, createSnapshot({ root, context, policy, sourceState }));
  writeOutput(root, args["--output"], result);
  if (mode === "measure") {
    assert(args["--baseline-output"], "explicit measurement needs a baseline output");
    const measured = {
      ...policy,
      baseline: {
        sourceSha: context.testedSha,
        sourceState,
        sourceTreeSha256: analysis.sourceTreeSha256,
        reportSha256: result.reportSha256,
        lcovSha256: result.lcovSha256,
        strategySha256: result.strategySha256,
        measuredAt: new Date().toISOString(),
        groups: analysis.groups,
      },
    };
    validateCoveragePolicy(measured);
    writeOutput(root, args["--baseline-output"], measured, true);
  }
  process.stdout.write(
    `${JSON.stringify({ status: result.status, initialization: result.initialization, changedLines: result.changedLines.pct, changedFunctionBranches: result.changedFunctionBranches.pct, failures: result.failures }, null, 2)}\n`,
  );
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = main();
    if (result.status !== "passed") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
