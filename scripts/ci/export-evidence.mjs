import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";
import { aggregate, readReportEnvelopes } from "./aggregate.mjs";
import { resolvePolicySource } from "./check-policy.mjs";
import { outputPath } from "./context.mjs";
import {
  existingInside,
  fileSha256,
  parseArguments,
  readJson,
  repositoryRoot,
  validateRecord,
} from "./contracts.mjs";
import { validateQualityPolicy } from "./quality-policy.mjs";

export function validateRunMetadata(metadata, context, defaultBranch) {
  if (
    String(metadata.id) !== context.runId ||
    metadata.run_attempt !== context.attempt ||
    metadata.head_sha !== context.testedSha ||
    metadata.head_branch !== defaultBranch ||
    metadata.event !== "push" ||
    metadata.status !== "completed" ||
    metadata.conclusion !== "success" ||
    metadata.repository?.full_name !== context.repository ||
    metadata.path !== ".github/workflows/ci.yml"
  )
    throw new Error("CI_HANDOFF_DEFAULT_BRANCH_RUN_MISMATCH");
  const expectedUrl = `https://github.com/${context.repository}/actions/runs/${context.runId}`;
  if (metadata.html_url !== expectedUrl) throw new Error("CI_HANDOFF_RUN_URL_MISMATCH");
}

export async function readHostedMetadata({
  runId,
  output,
  env = process.env,
  root = repositoryRoot,
}) {
  if (
    !/^[1-9][0-9]*$/u.test(runId ?? "") ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(env.GITHUB_REPOSITORY ?? "")
  )
    throw new Error("CI_HANDOFF_RUN_ID_REQUIRED");
  if (!env.GITHUB_TOKEN) throw new Error("CI_HANDOFF_READ_TOKEN_REQUIRED");
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs/${runId}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) throw new Error(`CI_HANDOFF_METADATA_HTTP:${response.status}`);
  const data = await response.json();
  const metadata = Object.fromEntries(
    [
      "id",
      "run_attempt",
      "head_sha",
      "head_branch",
      "event",
      "status",
      "conclusion",
      "html_url",
      "path",
      "created_at",
      "updated_at",
    ].map((key) => [key, data[key]]),
  );
  metadata.repository = { full_name: data.repository?.full_name };
  if (
    !Number.isSafeInteger(metadata.run_attempt) ||
    metadata.run_attempt < 1 ||
    !/^[a-f0-9]{40}$/u.test(metadata.head_sha ?? "")
  )
    throw new Error("CI_HANDOFF_METADATA_INVALID");
  const filename = outputPath(output, root);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      `attempt=${metadata.run_attempt}\nsha=${metadata.head_sha}\n`,
    );
  return metadata;
}

export function exportEvidence({
  reports,
  gate,
  metadata,
  output,
  root = repositoryRoot,
  now = Date.now(),
  pending = [],
}) {
  const context = validateRecord("Context", readJson(path.join(gate, "context.json")));
  if (context.event !== "push") throw new Error("CI_HANDOFF_PUSH_EVIDENCE_REQUIRED");
  const policy = validateQualityPolicy(readJson(path.join(root, "ci/quality-policy.json")));
  validateRunMetadata(metadata, context, policy.defaultBranch);
  const created = Date.parse(metadata.created_at);
  if (
    !Number.isFinite(created) ||
    created > now ||
    now - created >= policy.retentionDays.reports * 86_400_000
  )
    throw new Error("CI_HANDOFF_EVIDENCE_EXPIRED");
  const source = resolvePolicySource({ root, base: context.baseSha });
  if (
    source.policySha256 !== context.policySha256 ||
    source.initialization !== context.initialization ||
    fileSha256(path.join(root, "ci/toolchain-lock.json")) !== context.toolchainSha256
  )
    throw new Error("CI_HANDOFF_POLICY_IDENTITY_MISMATCH");
  const envelopes = readReportEnvelopes(reports);
  const summary = aggregate({
    policy: source.policy,
    context,
    needs: readJson(path.join(gate, "needs.json")),
    reports: envelopes,
    toolchainLock: readJson(path.join(root, "ci/toolchain-lock.json")),
  });
  if (
    summary.status !== "passed" ||
    JSON.stringify(summary) !== JSON.stringify(readJson(path.join(gate, "summary.json")))
  )
    throw new Error("CI_HANDOFF_GATE_INCOMPLETE_OR_CHANGED");
  if (pending.length) throw new Error("CI_HANDOFF_REQUIRED_WORK_PENDING");
  const security = envelopes.find((entry) => entry.result.checkId === "security");
  const securityFile = security.result.reports.find(
    (entry) => entry.kind === "json" && entry.path.endsWith("security-report.json"),
  );
  if (!securityFile) throw new Error("CI_HANDOFF_SECURITY_REPORT_REQUIRED");
  const securityPath = existingInside(
    path.dirname(path.join(reports, security.source)),
    securityFile.path,
  );
  const securityReport = readJson(securityPath);
  const scannedAt = Date.parse(securityReport.scannedAt);
  if (
    !Number.isFinite(scannedAt) ||
    scannedAt > now ||
    now - scannedAt > policy.securityFreshnessHours * 3_600_000 ||
    securityReport.status !== "passed" ||
    securityReport.context?.testedSha !== context.testedSha
  )
    throw new Error("CI_HANDOFF_SECURITY_STALE_OR_UNBOUND");
  const evidence = {
    schemaVersion: 1,
    kind: "ci-evidence",
    context,
    defaultBranch: policy.defaultBranch,
    runUrl: metadata.html_url,
    createdAt: new Date(now).toISOString(),
    securityScannedAt: securityReport.scannedAt,
    expiresAt: new Date(created + policy.retentionDays.reports * 86_400_000).toISOString(),
    status: "ci_verified",
    productQualification: "not_assessed",
    persistence: "transfer_required_before_expiry",
    platforms: envelopes
      .filter((entry) => entry.result.checkId === "build")
      .map((entry) => ({
        platform: entry.result.matrixKey,
        archiveSha256: entry.result.artifacts[0].sha256,
        reportSha256: fileSha256(path.join(reports, entry.source)),
      })),
    checks: envelopes.map((entry) => ({
      checkId: entry.result.checkId,
      matrixKey: entry.result.matrixKey,
      reportSha256: fileSha256(path.join(reports, entry.source)),
    })),
    pending: [
      "S9 Mac/Hermes 平台 conformance",
      "S9 正式浏览器和人工 WCAG",
      "S9 两次七天 soak 与升级恢复",
      "Owner 签署",
      "转存到另行批准的持久证据位置并重新核验",
    ],
  };
  const validate = new Ajv({ allErrors: true }).compile(
    readJson(path.join(root, "ci/evidence.schema.json")),
  );
  if (!validate(evidence)) throw new Error(`CI_HANDOFF_SCHEMA:${JSON.stringify(validate.errors)}`);
  const filename = outputPath(output, root);
  mkdirSync(path.dirname(filename), { recursive: true });
  writeFileSync(filename, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  return evidence;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv, [
    "--mode",
    "--run-id",
    "--metadata",
    "--reports",
    "--gate",
    "--output",
  ]);
  if (!args["--output"]) throw new Error("CI_HANDOFF_OUTPUT_REQUIRED");
  if (args["--mode"] === "metadata")
    return readHostedMetadata({ runId: args["--run-id"], output: args["--output"] });
  if (args["--mode"] && args["--mode"] !== "export") throw new Error("CI_HANDOFF_MODE_INVALID");
  if (!args["--reports"] || !args["--gate"] || !args["--metadata"])
    throw new Error("CI_HANDOFF_INPUT_REQUIRED");
  return exportEvidence({
    reports: args["--reports"],
    gate: args["--gate"],
    metadata: readJson(args["--metadata"]),
    output: args["--output"],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
