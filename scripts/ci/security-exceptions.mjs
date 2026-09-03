import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv from "ajv";
import { resolvePolicySource } from "./check-policy.mjs";
import { repositoryRoot, safeRelativePath } from "./contracts.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exceptionPath = "ci/security-exceptions.json";
const validateExceptionSchema = new Ajv({ allErrors: true, strict: true }).compile(
  JSON.parse(readFileSync(join(repositoryRoot, "ci/security-exceptions.schema.json"), "utf8")),
);
function assert(condition, code) {
  if (!condition) throw new Error(code);
}
function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_PAGER: "cat",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("SECURITY_GIT_COMMAND_FAILED");
  }
}
export const publishedRules = [
  "credential-literal",
  "private-key",
  "bearer-token",
  "jwt-token",
  "openai-key",
  "github-token",
  "aws-key",
];
function validatePublishedEntry(entry, dependencies) {
  assert(
    exactPath(entry.packageLockPath) &&
      entry.packageLockPath.startsWith("node_modules/") &&
      exactPath(entry.archiveMember) &&
      entry.archiveMember.startsWith("package/") &&
      entry.path === `runtime/${entry.packageLockPath}/${entry.archiveMember.slice(8)}`,
    "PUBLIC_FIXTURE_PATH_INVALID",
  );
  assert(
    dependencies.some(
      (dependency) =>
        dependency.path === entry.packageLockPath &&
        dependency.name === entry.package &&
        dependency.version === entry.version,
    ),
    "SECURITY_EXCEPTION_DEPENDENCY_UNKNOWN",
  );
  const identities = new Set();
  for (const finding of entry.findings) {
    assert(publishedRules.includes(finding.rule), "PUBLIC_FIXTURE_RULE_UNKNOWN");
    const identity = `${finding.rule}:${finding.digest}`;
    assert(!identities.has(identity), "PUBLIC_FIXTURE_FINDING_DUPLICATE");
    identities.add(identity);
  }
}

function exactPath(path) {
  return safeRelativePath(path) && !/[*?[\]{}]/.test(path);
}

export function enumerateLockDependencies(lock) {
  assert(
    lock?.lockfileVersion === 3 && lock.packages && typeof lock.packages === "object",
    "ADVISORY_LOCK_INVALID",
  );
  const dependencies = [];
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.includes("node_modules/") || entry.link) continue;
    const name = entry.name ?? path.slice(path.lastIndexOf("node_modules/") + 13);
    assert(
      exactPath(path) &&
        /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) &&
        /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(entry.version),
      "ADVISORY_DEPENDENCY_IDENTITY_INVALID",
    );
    assert(
      entry.resolved?.startsWith("https://registry.npmjs.org/") &&
        typeof entry.integrity === "string",
      "ADVISORY_DEPENDENCY_SOURCE_INVALID",
    );
    dependencies.push({
      path,
      name,
      version: entry.version,
      dev: entry.dev === true,
      optional: entry.optional === true,
    });
  }
  assert(dependencies.length > 0, "ADVISORY_EMPTY_LOCK");
  return dependencies;
}

export function validateSecurityExceptions(
  value,
  { now = new Date(), ruleIds = [], dependencies = [] } = {},
) {
  assert(validateExceptionSchema(value), "SECURITY_EXCEPTION_SCHEMA_INVALID");
  const instant = new Date(now).getTime();
  assert(Number.isFinite(instant), "SECURITY_CLOCK_INVALID");
  const identities = new Set();
  if (value.proposal) {
    const proposed = new Date(value.proposal.proposedAt);
    assert(
      Number.isFinite(proposed.getTime()) &&
        proposed.getTime() <= instant &&
        proposed.toISOString().replace(".000", "") === value.proposal.proposedAt,
      "SECURITY_PROPOSAL_DATE_INVALID",
    );
    assert(
      value.exceptions.every(
        (entry) =>
          ["synthetic-secret", "published-synthetic-fixture"].includes(entry.kind) &&
          entry.owner === value.proposal.owner &&
          new Date(entry.expiresAt).getTime() - proposed.getTime() <= 30 * 86_400_000,
      ),
      "SECURITY_PROPOSAL_SCOPE_INVALID",
    );
  }
  for (const entry of value.exceptions) {
    assert(exactPath(entry.path), "SECURITY_EXCEPTION_PATH_NOT_EXACT");
    const expires = new Date(entry.expiresAt);
    assert(
      Number.isFinite(expires.getTime()) &&
        expires.toISOString().replace(".000", "") === entry.expiresAt &&
        expires.getTime() > instant,
      "SECURITY_EXCEPTION_EXPIRED_OR_INVALID",
    );
    if (entry.kind === "advisory") {
      assert(
        /^(?:GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}|npm:[0-9]+)$/.test(entry.id),
        "SECURITY_ADVISORY_ID_INVALID",
      );
      assert(
        dependencies.some(
          (dependency) =>
            dependency.path === entry.path &&
            dependency.name === entry.package &&
            dependency.version === entry.version,
        ),
        "SECURITY_EXCEPTION_DEPENDENCY_UNKNOWN",
      );
    } else if (entry.kind === "published-synthetic-fixture") {
      validatePublishedEntry(entry, dependencies);
    } else if (entry.kind === "semgrep") {
      assert(ruleIds.includes(entry.id), "SECURITY_EXCEPTION_RULE_UNKNOWN");
    } else {
      assert(/^[a-z0-9][a-z0-9-]*$/.test(entry.id), "SECURITY_SECRET_RULE_INVALID");
      assert(
        /^(?:test\/|ci\/rules\/fixtures\/|(?:apps|packages)\/[^/]+\/test\/)/.test(entry.path),
        "REAL_SECRET_CANNOT_BE_EXCEPTED",
      );
      const scopes = [entry.provenance.current, ...entry.provenance.history];
      assert(
        scopes.every((scope) => scope.count === scope.lines.length) &&
          new Set(entry.provenance.history.map((scope) => scope.sourceCommit)).size ===
            entry.provenance.history.length &&
          scopes.reduce((total, scope) => total + scope.count, 0) === entry.count,
        "SECURITY_PROVENANCE_COUNT_INVALID",
      );
    }
    const identity = [
      entry.kind,
      entry.id,
      entry.path,
      entry.package ?? "",
      entry.version ?? "",
      entry.digest ?? "",
    ].join("\0");
    assert(!identities.has(identity), "SECURITY_EXCEPTION_DUPLICATE");
    identities.add(identity);
  }
  return value.exceptions;
}

export function loadReviewedExceptions({
  root = repositoryRoot,
  context,
  now,
  ruleIds,
  dependencies,
}) {
  const source = resolvePolicySource({ root, base: context.baseSha });
  assert(source.initialization === context.initialization, "SECURITY_POLICY_SOURCE_MISMATCH");
  const available =
    git(root, ["ls-tree", "-r", "--name-only", context.baseSha, "--", exceptionPath]).trim() ===
    exceptionPath;
  assert(!source.initialization || !available, "SECURITY_PARTIAL_INITIALIZATION");
  const candidate = readFileSync(join(root, exceptionPath), "utf8");
  validateSecurityExceptions(JSON.parse(candidate), { now, ruleIds, dependencies });
  assert(available || source.initialization, "SECURITY_ACCEPTED_EXCEPTIONS_MISSING");
  const bytes = available ? git(root, ["show", `${context.baseSha}:${exceptionPath}`]) : candidate;
  const document = JSON.parse(bytes);
  const exceptions = validateSecurityExceptions(document, { now, ruleIds, dependencies });
  assert(
    available ||
      exceptions.length === 0 ||
      document.proposal?.status === "proposed_owner_review_required",
    "SECURITY_INITIAL_EXCEPTIONS_REQUIRE_PROPOSAL",
  );
  return {
    exceptions,
    sha256: sha256(bytes),
    sourceSha: available ? context.baseSha : null,
    initialization: !available,
    candidateDiffers: sha256(candidate) !== sha256(bytes),
    approvalBasis: available ? "accepted_base" : "initialization_proposal",
    reviewStatus: available ? "accepted_base" : (document.proposal?.status ?? "no_exceptions"),
    proposal: document.proposal ?? null,
  };
}
