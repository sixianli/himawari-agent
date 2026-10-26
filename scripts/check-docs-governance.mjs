import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillValidator = path.join(
  repositoryRoot,
  ".claude/skills/document-governance/scripts/validate_docs.py",
);
const fastModeDeferredRunbookFindings = [
  /^docs\/runbooks\/[^/]+\.md: contract_sha256 does not match the current Runbook and contract sources$/,
  /^docs\/runbooks\/[^/]+\.md: contract path does not exist: .+$/,
];

export function deliveryMode(root) {
  const file = path.join(root, "DELIVERY_MODE");
  return existsSync(file) && readFileSync(file, "utf8").trim() === "fast" ? "fast" : "full";
}

export function checkDocsGovernance({ root = repositoryRoot, validator = skillValidator } = {}) {
  const mode = deliveryMode(root);
  const run = spawnSync(
    "python3",
    ["-E", "-s", "-B", validator, root, "--strict", "--format", "json"],
    { encoding: "utf8" },
  );
  if (run.error) throw new Error(`DOCS_GOVERNANCE_VALIDATOR_FAILED: ${run.error.message}`);
  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    throw new Error(
      `DOCS_GOVERNANCE_VALIDATOR_FAILED: ${run.stderr.trim() || `exit status ${run.status}`}`,
    );
  }
  const findings = [...report.errors, ...report.warnings];
  const deferred =
    mode === "fast"
      ? findings.filter((finding) =>
          fastModeDeferredRunbookFindings.some((pattern) => pattern.test(finding)),
        )
      : [];
  const blocking = findings.filter((finding) => !deferred.includes(finding));
  return { mode, blocking, deferred };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { mode, blocking, deferred } = checkDocsGovernance();
  for (const finding of deferred) console.log(`DEFERRED (fast mode Runbook seal): ${finding}`);
  if (blocking.length > 0) {
    console.error(`Documentation governance check failed in ${mode} mode:`);
    for (const finding of blocking) console.error(`- ${finding}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Documentation governance check passed in ${mode} mode; ${deferred.length} Runbook seal finding(s) deferred.`,
    );
  }
}
