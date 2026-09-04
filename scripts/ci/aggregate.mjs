import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePolicySource, validatePolicy } from "./check-policy.mjs";
import {
  contextIdentity,
  existingInside,
  expectedMembers,
  identityFields,
  memberId,
  parseArguments,
  readJson,
  repositoryRoot,
  safeRelativePath,
  sha256,
  validateRecord,
} from "./contracts.mjs";

const countsProblems = (counts) => {
  const problems = [];
  if (counts.files < 1 || counts.executed < 1) problems.push("No actual files or executed units");
  if (counts.executed !== counts.passed + counts.failed)
    problems.push("Executed count contradicts passed/failed counts");
  if (counts.failed !== 0 || counts.skipped !== 0)
    problems.push("Failed or skipped units are not a complete success");
  return problems;
};

/** Pure gate decision. artifacts contain independently measured file hashes, never worker claims. */
export function aggregate({ policy, context, needs, reports, toolchainLock }) {
  validatePolicy(policy);
  validateRecord("Context", context);
  if (!policy.events.includes(context.event)) throw new Error("CI_EVENT_UNSUPPORTED");
  if (!toolchainLock?.node?.baseline || !toolchainLock?.npm?.version)
    throw new Error("Missing expected toolchain identity");
  const expected = expectedMembers(policy);
  const byId = new Map(expected.map((entry) => [entry.id, entry]));
  const failures = [];
  const observed = [];
  const entries = new Map();
  const fail = (checkId, matrixKey, source, reason) =>
    failures.push({ checkId, matrixKey, source, reason });
  const expectedJobs = policy.checks
    .filter((check) => check.id !== "required")
    .map((check) => check.id);
  if (!needs || typeof needs !== "object" || Array.isArray(needs))
    fail("required", "default", "needs", "Missing or invalid needs data");
  else {
    for (const id of expectedJobs)
      if (needs[id]?.result !== "success")
        fail(
          id,
          "*",
          "needs",
          `Upstream result is ${needs[id]?.result ?? "missing"}; only success is accepted`,
        );
    for (const id of Object.keys(needs))
      if (!expectedJobs.includes(id)) fail(id, "*", "needs", "Unknown upstream job");
  }
  if (!Array.isArray(reports)) fail("required", "default", "reports", "Reports must be an array");
  for (const [index, envelope] of (Array.isArray(reports) ? reports : []).entries()) {
    const source =
      typeof envelope?.source === "string" && envelope.source
        ? envelope.source
        : `reports[${index}]`;
    let result;
    try {
      result = validateRecord("CheckResult", envelope?.result);
    } catch (error) {
      fail("unknown", "unknown", source, error.message);
      continue;
    }
    const { checkId, matrixKey } = result;
    const id = memberId(checkId, matrixKey);
    observed.push(id);
    const expectation = byId.get(id);
    if (!expectation) {
      fail(checkId, matrixKey, source, "Unknown or substituted matrix member");
      continue;
    }
    if (entries.has(id)) {
      fail(checkId, matrixKey, source, "Duplicate matrix member report");
      continue;
    }
    entries.set(id, { result, source });
    for (const field of identityFields)
      if (result[field] !== context[field])
        fail(
          checkId,
          matrixKey,
          source,
          `Identity mismatch: ${field}${field === "attempt" ? "; rerun the complete workflow" : ""}`,
        );
    if (result.status !== "passed")
      fail(checkId, matrixKey, source, `Terminal status is ${result.status}`);
    if (result.exitCode !== 0)
      fail(checkId, matrixKey, source, `Command exit code is ${result.exitCode}`);
    for (const reason of countsProblems(result.counts)) fail(checkId, matrixKey, source, reason);
    const { check, member } = expectation;
    for (const field of ["node", "os", "arch"])
      if (result.toolchain[field] !== member[field])
        fail(checkId, matrixKey, source, `Actual toolchain differs from matrix: ${field}`);
    if (result.toolchain.npm !== toolchainLock.npm.version)
      fail(checkId, matrixKey, source, "Actual npm differs from toolchain lock");
    // The supported Node 22 baseline and floor both use ABI 127.
    if (result.toolchain.abi !== "127")
      fail(checkId, matrixKey, source, "Actual Node ABI differs from supported Node 22 ABI 127");
    const projectIds = result.projects.map((project) => project.id);
    if (new Set(projectIds).size !== projectIds.length)
      fail(checkId, matrixKey, source, "Duplicate project counts");
    if (JSON.stringify([...projectIds].sort()) !== JSON.stringify([...check.projects].sort()))
      fail(checkId, matrixKey, source, "Project count set differs from policy");
    for (const project of result.projects)
      for (const reason of countsProblems(project.counts))
        fail(checkId, matrixKey, source, `${project.id}: ${reason}`);
    if (result.projects.length)
      for (const field of ["files", "executed", "passed", "failed", "skipped"]) {
        const sum = result.projects.reduce((total, project) => total + project.counts[field], 0);
        if (result.counts[field] !== sum)
          fail(checkId, matrixKey, source, `Project totals contradict check ${field}`);
      }
    const evidence = new Map();
    if (!Array.isArray(envelope.artifacts))
      fail(checkId, matrixKey, source, "Missing independently verified evidence");
    for (const item of Array.isArray(envelope.artifacts) ? envelope.artifacts : []) {
      if (
        !item ||
        !safeRelativePath(item.path) ||
        !/^[a-f0-9]{64}$/u.test(item.sha256) ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes < 1
      ) {
        fail(checkId, matrixKey, source, "Invalid measured evidence identity");
        continue;
      }
      if (evidence.has(item.path))
        fail(checkId, matrixKey, source, `Duplicate measured evidence: ${item.path}`);
      evidence.set(item.path, item);
    }
    const reportPaths = new Set();
    for (const report of result.reports) {
      if (!safeRelativePath(report.path))
        fail(checkId, matrixKey, source, `Unsafe report path: ${report.path}`);
      if (reportPaths.has(report.path))
        fail(checkId, matrixKey, source, `Duplicate report path: ${report.path}`);
      reportPaths.add(report.path);
      const actual = evidence.get(report.path);
      if (!actual || actual.sha256 !== report.sha256 || actual.bytes !== report.bytes)
        fail(checkId, matrixKey, source, `Missing or modified evidence: ${report.path}`);
    }
    for (const pathname of evidence.keys())
      if (!reportPaths.has(pathname))
        fail(checkId, matrixKey, source, `Unknown measured evidence: ${pathname}`);
    for (const kind of check.outputs)
      if (!result.reports.some((report) => report.kind === kind))
        fail(checkId, matrixKey, source, `Missing ${kind} output`);
    const artifactIds = new Set();
    for (const artifact of result.artifacts) {
      const artifactId = `${artifact.role}/${artifact.platform}`;
      if (artifactIds.has(artifactId))
        fail(checkId, matrixKey, source, `Duplicate artifact identity: ${artifactId}`);
      artifactIds.add(artifactId);
      if (
        !result.reports.some(
          (report) =>
            report.path === artifact.path &&
            report.kind === "artifact" &&
            report.sha256 === artifact.sha256,
        )
      )
        fail(checkId, matrixKey, source, "Artifact identity is not bound to verified report bytes");
    }
  }
  const missing = expected.filter(({ id }) => !entries.has(id)).map(({ id }) => id);
  for (const id of missing) {
    const { check, member } = byId.get(id);
    fail(check.id, member.key, "reports", "Missing required matrix member report");
  }
  const builds = new Map();
  for (const { check, member, id } of expected) {
    const entry = entries.get(id);
    if (!entry) continue;
    const { result, source } = entry;
    if (check.id === "build") {
      const matching = result.artifacts.filter(
        (artifact) => artifact.role === "produced" && artifact.platform === member.key,
      );
      if (matching.length !== 1 || result.artifacts.length !== 1)
        fail(
          check.id,
          member.key,
          source,
          "Build must produce exactly one matching platform artifact",
        );
      else builds.set(member.key, matching[0].sha256);
    }
  }
  for (const { check, member, id } of expected) {
    const entry = entries.get(id);
    if (!entry) continue;
    const { result, source } = entry;
    if (["test", "browser"].includes(check.id)) {
      const platform = check.id === "browser" ? "linux-x64" : member.key;
      const matching = result.artifacts.filter(
        (artifact) => artifact.role === "consumed" && artifact.platform === platform,
      );
      if (
        matching.length !== 1 ||
        result.artifacts.length !== 1 ||
        !builds.has(platform) ||
        matching[0].sha256 !== builds.get(platform)
      )
        fail(
          check.id,
          member.key,
          source,
          "Consumer artifact differs from this attempt's platform build",
        );
    } else if (check.id !== "build" && result.artifacts.length !== 0)
      fail(check.id, member.key, source, "Unexpected cross-job artifact claim");
  }
  const summary = {
    schemaVersion: 1,
    ...contextIdentity(context),
    status: failures.length ? "failed" : "passed",
    expected: expected.map(({ id }) => id),
    observed,
    missing,
    failures,
    checks: expected.map(({ check, member }) => {
      const reasons = failures
        .filter(
          (failure) =>
            failure.checkId === check.id && [member.key, "*"].includes(failure.matrixKey),
        )
        .map((failure) => failure.reason);
      return {
        checkId: check.id,
        matrixKey: member.key,
        status: reasons.length ? "failed" : "passed",
        reasons,
      };
    }),
  };
  return validateRecord("GateSummary", summary);
}

export function readReportEnvelopes(directory) {
  const envelopes = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic link in reports: ${filename}`);
      if (entry.isDirectory()) walk(filename);
      else if (entry.name === "result.json") {
        const result = readJson(filename);
        // A malformed result is preserved for the gate's diagnostic, without trusting any paths in it.
        let artifacts = [];
        try {
          validateRecord("CheckResult", result);
          artifacts = result.reports.map((report) => {
            const target = existingInside(current, report.path);
            if (!statSync(target).isFile())
              throw new Error(`Evidence is not a file: ${report.path}`);
            const bytes = readFileSync(target);
            return { path: report.path, sha256: sha256(bytes), bytes: bytes.length };
          });
        } catch {
          /* The pure gate rejects malformed, missing, or unverifiable evidence. */
        }
        envelopes.push({ source: path.relative(directory, filename), result, artifacts });
      }
    }
  };
  walk(directory);
  return envelopes;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv, ["--context", "--needs", "--reports", "--output", "--root"]);
  for (const key of ["--context", "--needs", "--reports", "--output"])
    if (!args[key]) throw new Error(`Missing argument: ${key}`);
  const root = path.resolve(args["--root"] ?? repositoryRoot);
  const context = validateRecord("Context", readJson(args["--context"]));
  const source = resolvePolicySource({ root, base: context.baseSha });
  if (
    source.policySha256 !== context.policySha256 ||
    source.initialization !== context.initialization
  )
    throw new Error("Context does not identify accepted policy");
  const lockBytes = readFileSync(path.join(root, "ci/toolchain-lock.json"));
  if (sha256(lockBytes) !== context.toolchainSha256)
    throw new Error("Context does not identify current toolchain lock");
  const summary = aggregate({
    policy: source.policy,
    context,
    needs: readJson(args["--needs"]),
    reports: readReportEnvelopes(args["--reports"]),
    toolchainLock: JSON.parse(lockBytes),
  });
  const output = path.resolve(args["--output"]);
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(
    `${summary.status}: ${summary.observed.length}/${summary.expected.length} reports; ${summary.failures.length} failures\n`,
  );
  if (summary.status !== "passed") process.exitCode = 1;
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
