import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createContext } from "./context.mjs";
import { existingInside, fileSha256, readJson } from "./contracts.mjs";
import { execute, vitestCounts } from "./execute.mjs";
import { isolatedEnvironment, verifyInstalledTools } from "./install-tools.mjs";
import { main as verifyMainEvidence } from "./main-evidence.mjs";
import { main as publish, redactReport } from "./publish.mjs";
import { runCheck } from "./run.mjs";
import { assertPublicArtifacts } from "./security-redaction.mjs";

export async function publishMainMetadata({ root, name, value }) {
  const parent = path.join(root, ".ci-output/main-check");
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(path.join(parent, "metadata-"));
  if (!["smoke.json", "summary.json", "failure.json"].includes(name))
    throw new Error("MAIN_METADATA_NAME");
  const file = path.join(staging, name);
  writeFileSync(file, redactReport(JSON.stringify(value), "json"));
  await assertPublicArtifacts({
    root: staging,
    entries: [{ path: name, kind: "json", classification: "redacted", sha256: fileSha256(file) }],
    allowed: [{ path: name, kind: "json" }],
  });
  const destination = path.join(root, ".ci-output/main-public");
  mkdirSync(destination, { recursive: true });
  copyFileSync(file, path.join(destination, name));
}

export async function confirmMain({ root = process.cwd(), base } = {}) {
  try {
    const decision = await verifyMainEvidence(["verify"], { root });
    if (decision.mode !== "light") throw new Error("MAIN_EVIDENCE_NO_LONGER_VALID");
    const context = createContext({ root, base });
    return await runMainChecks({ root, context, decision });
  } catch (error) {
    await publishMainMetadata({
      root,
      name: "failure.json",
      value: {
        kind: "main-confirmation",
        status: "failed",
        reason: /^MAIN_[A-Z_]+(?::[a-z-]+)?$/.test(error.message)
          ? error.message
          : "MAIN_CONFIRMATION_FAILED",
      },
    });
    throw error;
  }
}

export async function runMainChecks({ root = process.cwd(), context, decision }) {
  const output = path.join(root, ".ci-output/main-check");
  const toolsDirectory = path.join(root, ".ci-output/tools");
  const installation = await verifyInstalledTools({ root, directory: toolsDirectory });
  const results = {};
  for (const [checkId, matrixKey] of [
    ["build", "linux-x64"],
    ["security", "default"],
  ]) {
    const directory = path.join(output, checkId);
    results[checkId] = await runCheck({
      root,
      checkId,
      matrixKey,
      output: directory,
      toolsDirectory,
      context,
    });
    await publish([
      "--input",
      directory,
      "--output",
      path.join(root, ".ci-output/main-public", checkId),
      "--tools",
      toolsDirectory,
    ]);
    if (results[checkId].status !== "passed") throw new Error(`MAIN_CHECK_FAILED:${checkId}`);
  }
  const artifact = existingInside(path.join(output, "build"), results.build.artifacts[0].path);
  const smoke = path.join(output, "smoke");
  mkdirSync(smoke, { recursive: true });
  const filename = "test/integration/installable-node-services.test.ts";
  const report = path.join(smoke, "tests.json");
  const env = {
    ...isolatedEnvironment(path.join(smoke, "environment"), path.join(toolsDirectory, "bin")),
    HIMAWARI_CI_PYTHON: installation.executables.python,
    HIMAWARI_TEST_ARTIFACT: artifact,
    HIMAWARI_TEST_CONTEXT: path.join(output, "build/context.json"),
  };
  const outcome = await execute(
    installation.executables.node,
    [
      path.join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "vitest.workspace.ts",
      "--project",
      "integration",
      filename,
      "--maxWorkers",
      "1",
      "--retry",
      "0",
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    { cwd: root, env, log: path.join(smoke, "check.log"), timeoutMs: 300_000 },
  );
  if (existsSync(report))
    await publishMainMetadata({ root, name: "smoke.json", value: readJson(report) });
  if (outcome.exitCode !== 0 || outcome.error || outcome.termination)
    throw new Error("MAIN_SMOKE_FAILED");
  const data = readJson(report);
  const counts = vitestCounts(data);
  if (
    counts.failed ||
    counts.skipped ||
    counts.files !== 1 ||
    path.relative(root, data.testResults[0].name).split(path.sep).join("/") !== filename
  )
    throw new Error("MAIN_SMOKE_INCOMPLETE");
  const summary = {
    schemaVersion: 1,
    kind: "main-confirmation",
    status: "passed",
    context,
    priorPr: decision.pr,
    priorRunId: decision.runId,
    priorAttempt: decision.attempt,
    artifactSha256: fileSha256(artifact),
    smoke: counts,
  };
  await publishMainMetadata({ root, name: "summary.json", value: summary });
  return summary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  console.log(JSON.stringify(await confirmMain()));
}
