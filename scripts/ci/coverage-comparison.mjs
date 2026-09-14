import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { collectSources, createSnapshot, sourceTreeDigest } from "./check-coverage.mjs";
import { createContext } from "./context.mjs";
import { readJson, sha256 } from "./contracts.mjs";

// Remeasure the accepted production tree; never replace it with candidate sources.
// The caller owns cleanup after the comparison verifier has consumed the evidence.
export async function prepareCoverageComparison({
  root,
  context,
  policy,
  acceptedPolicy,
  tools,
  toolsDirectory,
  env,
  output,
  command,
  own,
}) {
  const baseline = acceptedPolicy?.baseline;
  if (!baseline || !/^[a-f0-9]{40}$/u.test(baseline.sourceSha))
    throw new Error("CI_COMPARISON_BASELINE_REQUIRED");
  const directory = mkdtempSync(path.join(path.dirname(root), ".himawari-coverage-"));
  own(directory);
  const checkout = path.join(directory, "source");
  const comparisonEnv = { ...env, GITHUB_ACTIONS: "false" };
  for (const key of Object.keys(comparisonEnv))
    if (key.startsWith("GITHUB_") && key !== "GITHUB_ACTIONS") delete comparisonEnv[key];
  const run = (name, executable, args, cwd = root) =>
    command(`comparison-${name}`, executable, args, { cwd, env: comparisonEnv });
  await run("clone", "/usr/bin/git", ["clone", "--no-checkout", "--shared", root, checkout]);
  try {
    execFileSync("git", ["cat-file", "-e", `${baseline.sourceSha}^{commit}`], {
      cwd: checkout,
      stdio: "pipe",
    });
  } catch {
    // Historical GitHub PR merge commits need not be in a regular branch fetch.
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(context.repository))
      throw new Error("CI_COMPARISON_REPOSITORY_INVALID");
    await run(
      "fetch",
      "/usr/bin/git",
      ["fetch", "--no-tags", `https://github.com/${context.repository}.git`, baseline.sourceSha],
      checkout,
    );
  }
  await run("checkout", "/usr/bin/git", ["checkout", "--detach", baseline.sourceSha], checkout);
  if (sourceTreeDigest(collectSources(checkout, acceptedPolicy)) !== baseline.sourceTreeSha256)
    throw new Error("CI_COMPARISON_SOURCE_MISMATCH");
  const evidence = path.join(checkout, ".ci-output/comparison");
  mkdirSync(evidence, { recursive: true });
  const identity = createContext({ root: checkout, base: baseline.sourceSha, env: comparisonEnv });
  const write = (name, value) =>
    writeFileSync(path.join(evidence, name), `${JSON.stringify(value)}\n`, { flag: "wx" });
  write("context.json", identity);
  write("harness-repairs.json", repairBaselineHarness(checkout, baseline.sourceSha));
  await run(
    "install",
    tools.node,
    [
      path.join(root, "scripts/ci/install-dependencies.mjs"),
      "--root",
      checkout,
      "--tools",
      toolsDirectory,
      "--evidence",
      path.join(evidence, "installation"),
    ],
    checkout,
  );
  await run(
    "build",
    tools.node,
    [
      path.join(checkout, "scripts/ci/build.mjs"),
      "--context",
      path.join(evidence, "context.json"),
      "--output",
      path.join(evidence, "build"),
    ],
    checkout,
  );
  const archives = readdirSync(path.join(evidence, "build")).filter((name) =>
    name.endsWith(".tar.gz"),
  );
  if (archives.length !== 1) throw new Error("CI_COMPARISON_ARTIFACT_REQUIRED");
  const archive = path.join(evidence, "build", archives[0]);
  comparisonEnv.HIMAWARI_TEST_ARTIFACT = archive;
  comparisonEnv.HIMAWARI_TEST_CONTEXT = path.join(evidence, "context.json");
  const originalPolicy = readJson(path.join(checkout, "ci/coverage-policy.json"));
  for (const key of ["provider", "include", "exclude"])
    if (JSON.stringify(originalPolicy[key]) !== JSON.stringify(policy[key]))
      throw new Error(`CI_COMPARISON_COLLECTION_DIFFERS:${key}`);
  write("snapshot.json", createSnapshot({ root: checkout, context: identity, policy }));
  await run(
    "tests",
    tools.node,
    [
      path.join(checkout, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "vitest.workspace.ts",
      ...policy.projects.flatMap((id) => ["--project", id]),
      "--maxWorkers",
      "2",
      "--coverage",
      "--coverage.reportsDirectory",
      path.join(evidence, "coverage"),
      "--reporter=json",
      `--outputFile=${path.join(evidence, "tests.json")}`,
    ],
    checkout,
  );
  const prefix = ".ci-output/comparison/";
  const manifest = {
    root: checkout,
    context: `${prefix}context.json`,
    snapshot: `${prefix}snapshot.json`,
    tests: `${prefix}tests.json`,
    report: `${prefix}coverage/coverage-final.json`,
    lcov: `${prefix}coverage/lcov.info`,
  };
  const filename = path.join(output, "comparison-manifest.json");
  writeFileSync(filename, JSON.stringify(manifest), { flag: "wx" });
  return { filename, evidence };
}

export function retainComparisonEvidence(evidence, output) {
  const retained = [];
  for (const [relative, name, kind] of [
    ["harness-repairs.json", "comparison-harness-repairs.json", "json"],
    ["context.json", "comparison-context.json", "json"],
    ["snapshot.json", "comparison-snapshot.json", "json"],
    ["tests.json", "comparison-tests.json", "json"],
    ["coverage/coverage-final.json", "comparison-coverage.json", "json"],
    ["coverage/lcov.info", "comparison-lcov.info", "lcov"],
  ]) {
    const source = path.join(evidence, relative);
    if (!existsSync(source)) continue;
    const destination = path.join(output, name);
    copyFileSync(source, destination);
    retained.push({ path: destination, kind });
  }
  return retained;
}

// These two test-only repairs retain every original assertion while allowing
// measurement under the same restrictive umask and per-file test deadlines.
export function repairBaselineHarness(root, sourceSha) {
  if (sourceSha !== "c9723c9054f1552b3c2356f26e86ddc9efca61ad") return [];
  const repairs = [
    {
      path: "test/tooling/policy.test.mjs",
      before: "791f8b7c334d4087d19c000327ce412d523667284bec001bf9dc3d2af3302e50",
      after: "7268fe05ea6e726e01ab50794382fff7e05d56402ecb44ac2823068dec196293",
    },
    {
      path: "test/tooling/artifact.test.mjs",
      before: "fcd750efa38e119b53265bf98c7170955177a1a4f04087ab07c4fa1a0fb339fd",
      after: "b344d70e1287425819e0d448cec02107543e96b036b994aae4f43af8eb490c63",
    },
  ];
  for (const repair of repairs)
    if (sha256(readFileSync(path.join(root, repair.path))) !== repair.before)
      throw new Error(`CI_COMPARISON_HARNESS_SOURCE_CHANGED:${repair.path}`);
  execFileSync(
    "git",
    ["apply", "--", path.join(import.meta.dirname, "coverage-baseline-harness.patch")],
    { cwd: root, stdio: "pipe" },
  );
  const changed = execFileSync("git", ["diff", "--name-only"], {
    cwd: root,
    encoding: "utf8",
    stdio: "pipe",
  })
    .trim()
    .split("\n")
    .sort();
  if (JSON.stringify(changed) !== JSON.stringify(repairs.map((entry) => entry.path).sort()))
    throw new Error("CI_COMPARISON_HARNESS_SCOPE_CHANGED");
  for (const repair of repairs)
    if (sha256(readFileSync(path.join(root, repair.path))) !== repair.after)
      throw new Error(`CI_COMPARISON_HARNESS_REPAIR_CHANGED:${repair.path}`);
  return repairs;
}
