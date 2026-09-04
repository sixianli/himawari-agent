import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { outputPath, verifyContext } from "./context.mjs";
import { parseArguments, safeRelativePath } from "./contracts.mjs";
import {
  isolatedEnvironment,
  loadToolchainLock,
  verifyInstalledTools,
  verifyRuleFiles,
} from "./install-tools.mjs";
import { enumerateLockDependencies, loadReviewedExceptions } from "./security-exceptions.mjs";

export {
  enumerateLockDependencies,
  loadReviewedExceptions,
  validateSecurityExceptions,
} from "./security-exceptions.mjs";

import { assertPublicArtifacts, redactText } from "./security-redaction.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const advisoryEndpoint = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
const severities = ["info", "low", "moderate", "high", "critical"];
const syntheticMarker = "HIMAWARISYNTHETICONLY";
const networkErrorNames = new Set([
  "Error",
  "TypeError",
  "AbortError",
  "TimeoutError",
  "AggregateError",
  "ConnectTimeoutError",
  "HeadersTimeoutError",
  "BodyTimeoutError",
  "SocketError",
]);
const networkErrorCodes = new Set([
  "ABORT_ERR",
  "UND_ERR_ABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EPIPE",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  20,
  23,
]);

function networkErrorIdentity(error) {
  return {
    name: networkErrorNames.has(error?.name) ? error.name : "unknown",
    code: networkErrorCodes.has(error?.code) ? error.code : "unknown",
  };
}

class AdvisoryNetworkError extends Error {
  constructor(error, { phase, signal, started, body }) {
    super(
      phase === "fetch-response"
        ? "ADVISORY_NETWORK_UNAVAILABLE"
        : "ADVISORY_RESPONSE_BODY_UNAVAILABLE",
    );
    const errors = [];
    for (let current = error; errors.length < 3; current = current?.cause) {
      errors.push(networkErrorIdentity(current));
      if (current?.cause == null) break;
    }
    this.diagnostic = {
      endpoint: advisoryEndpoint,
      requestSha256: sha256(body),
      timeoutMs: 60_000,
      elapsedMs: Math.round(performance.now() - started),
      phase,
      signal: {
        aborted: signal.aborted,
        reason: signal.aborted ? networkErrorIdentity(signal.reason) : null,
      },
      errors,
    };
    this.deadlineExpired =
      phase === "fetch-response" &&
      signal.aborted &&
      error === signal.reason &&
      signal.reason?.name === "TimeoutError" &&
      signal.reason?.code === 23;
  }
}

class AdvisoryRequestError extends Error {
  constructor(error, requestAttempts) {
    super(/^[A-Z_]+$/.test(error.message) ? error.message : "SECURITY_SCANNER_FAILED");
    this.requestAttempts = requestAttempts;
    this.retryCount = requestAttempts.length - 1;
    this.requestBudgetMs = 121_000;
    if (error instanceof AdvisoryNetworkError) this.diagnostic = error.diagnostic;
  }
}

function exactPath(path) {
  return safeRelativePath(path) && !/[*?[\]{}]/.test(path);
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function execute(command, args, { root, env, timeout = 120_000 }) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
  // Never expose an external command's error object: it can contain captured source or credentials.
  assert(
    !result.error && result.signal === null && Number.isInteger(result.status),
    "SECURITY_COMMAND_UNAVAILABLE",
  );
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(root, args) {
  const result = execute("git", args, {
    root,
    env: {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_PAGER: "cat",
    },
  });
  assert(result.exitCode === 0, "SECURITY_GIT_COMMAND_FAILED");
  return result.stdout;
}

export function evaluateAdvisories({ response, dependencies, satisfies, validRange }) {
  assert(
    response && typeof response === "object" && !Array.isArray(response),
    "ADVISORY_RESPONSE_INVALID",
  );
  const names = new Set(dependencies.map((entry) => entry.name));
  const findings = [];
  const seen = new Set();
  for (const [name, advisories] of Object.entries(response)) {
    assert(names.has(name) && Array.isArray(advisories), "ADVISORY_RESPONSE_UNKNOWN_PACKAGE");
    for (const advisory of advisories) {
      assert(
        advisory &&
          Number.isSafeInteger(advisory.id) &&
          typeof advisory.url === "string" &&
          typeof advisory.title === "string" &&
          severities.includes(advisory.severity) &&
          (advisory.name === undefined || advisory.name === name) &&
          typeof advisory.vulnerable_versions === "string" &&
          validRange(advisory.vulnerable_versions),
        "ADVISORY_RECORD_INCOMPLETE",
      );
      const url = new URL(advisory.url);
      assert(
        url.protocol === "https:" &&
          ["github.com", "www.npmjs.com", "npmjs.com"].includes(url.hostname) &&
          !url.username &&
          !url.password,
        "ADVISORY_URL_INVALID",
      );
      const ghsa = url.pathname.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/)?.[0];
      const id = ghsa ?? `npm:${advisory.id}`;
      for (const dependency of dependencies.filter(
        (entry) =>
          entry.name === name &&
          satisfies(entry.version, advisory.vulnerable_versions, { includePrerelease: true }),
      )) {
        const identity = `${id}\0${dependency.path}`;
        assert(!seen.has(identity), "ADVISORY_RESPONSE_DUPLICATE");
        seen.add(identity);
        findings.push({
          kind: "advisory",
          id,
          path: dependency.path,
          package: name,
          version: dependency.version,
          severity: advisory.severity,
          title: redactText(advisory.title),
          url: advisory.url,
          blocking: ["high", "critical"].includes(advisory.severity),
        });
      }
    }
  }
  return findings;
}

export async function fetchAdvisories({
  dependencies,
  satisfies,
  validRange,
  fetchImpl = fetch,
  now = new Date(),
}) {
  assert(dependencies.length > 0, "ADVISORY_EMPTY_REQUEST");
  const payload = {};
  for (const dependency of dependencies) {
    payload[dependency.name] ??= new Set();
    payload[dependency.name].add(dependency.version);
  }
  const body = JSON.stringify(
    Object.fromEntries(
      Object.entries(payload)
        .sort()
        .map(([name, versions]) => [name, [...versions].sort()]),
    ),
  );
  const requestAttempts = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const signal = AbortSignal.timeout(60_000);
    const started = performance.now();
    try {
      const request = async () => {
        let response;
        try {
          response = await fetchImpl(advisoryEndpoint, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body,
            signal,
          });
        } catch (error) {
          throw new AdvisoryNetworkError(error, { phase: "fetch-response", signal, started, body });
        }
        assert(response.ok, "ADVISORY_HTTP_FAILURE");
        let bytes;
        try {
          bytes = await response.text();
        } catch (error) {
          throw new AdvisoryNetworkError(error, { phase: "response-body", signal, started, body });
        }
        assert(
          bytes.length > 0 && bytes.length < 16 * 1024 * 1024,
          "ADVISORY_RESPONSE_EMPTY_OR_OVERSIZED",
        );
        let data;
        try {
          data = JSON.parse(bytes);
        } catch {
          throw new Error("ADVISORY_RESPONSE_NOT_JSON");
        }
        return {
          scannedCount: dependencies.length,
          packageNames: Object.keys(payload).length,
          endpoint: advisoryEndpoint,
          requestSha256: sha256(body),
          responseSha256: sha256(bytes),
          fetchedAt: new Date(now).toISOString(),
          findings: evaluateAdvisories({ response: data, dependencies, satisfies, validRange }),
        };
      };
      const result = await request();
      requestAttempts.push({
        attempt,
        status: "passed",
        requestSha256: result.requestSha256,
        responseSha256: result.responseSha256,
        durationMs: Math.round(performance.now() - started),
      });
      return { ...result, requestAttempts, retryCount: attempt - 1, requestBudgetMs: 121_000 };
    } catch (error) {
      requestAttempts.push({
        attempt,
        status: "failed",
        requestSha256: sha256(body),
        durationMs: Math.round(performance.now() - started),
        error: /^[A-Z_]+$/.test(error.message) ? error.message : "SECURITY_SCANNER_FAILED",
        ...(error instanceof AdvisoryNetworkError ? { diagnostic: error.diagnostic } : {}),
      });
      if (attempt === 2 || !(error instanceof AdvisoryNetworkError) || !error.deadlineExpired)
        throw new AdvisoryRequestError(error, requestAttempts);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

export function parseGitleaksReport({ bytes, exitCode, sourceRoot, scannedCount, scope }) {
  assert([0, 1].includes(exitCode), "GITLEAKS_TOOL_FAILED");
  assert(scannedCount > 0, "GITLEAKS_EMPTY_SCAN");
  let data;
  try {
    data = JSON.parse(bytes);
  } catch {
    throw new Error("GITLEAKS_REPORT_INVALID");
  }
  assert(Array.isArray(data), "GITLEAKS_REPORT_INVALID");
  assert(
    (data.length === 0 && exitCode === 0) || (data.length > 0 && exitCode === 1),
    "GITLEAKS_EXIT_REPORT_MISMATCH",
  );
  return data.map((finding) => {
    assert(
      finding &&
        typeof finding.RuleID === "string" &&
        typeof finding.File === "string" &&
        typeof finding.Secret === "string" &&
        finding.Secret.length > 0 &&
        finding.Secret !== "REDACTED" &&
        Number.isInteger(finding.StartLine) &&
        finding.StartLine > 0,
      "GITLEAKS_FINDING_INCOMPLETE",
    );
    const path = finding.File.startsWith(`${sourceRoot}/`)
      ? relative(sourceRoot, finding.File)
      : finding.File;
    assert(exactPath(path), "GITLEAKS_FINDING_PATH_INVALID");
    return {
      kind: "secret",
      id: finding.RuleID,
      path: redactText(path),
      line: finding.StartLine,
      digest: sha256(finding.Secret),
      synthetic: finding.Secret.includes(syntheticMarker),
      scope,
      commit: /^[a-f0-9]{40}$/.test(finding.Commit) ? finding.Commit : null,
      blocking: true,
    };
  });
}

export function validateGitleaksExecution({ stderr, scope, expectedCommits }) {
  const log = stderr.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
  assert(!/\bERR\b/.test(log), "GITLEAKS_INTERNAL_EXECUTION_FAILED");
  const scannedBytes = Number(log.match(/scanned ~(\d+) bytes \(/)?.[1]);
  assert(Number.isSafeInteger(scannedBytes) && scannedBytes > 0, "GITLEAKS_EMPTY_SCAN");
  if (scope === "current") return { scannedBytes };
  const scannedCommits = Number(log.match(/(\d+) commits? scanned\./)?.[1]);
  assert(
    Number.isSafeInteger(scannedCommits) && scannedCommits > 0 && scannedCommits <= expectedCommits,
    "GITLEAKS_HISTORY_EXECUTION_INCOMPLETE",
  );
  return { scannedBytes, scannedCommits };
}

export function parseSemgrepReport({ bytes, exitCode, expectedFiles, ruleIds, readSource }) {
  assert([0, 1].includes(exitCode), "SEMGREP_TOOL_FAILED");
  let data;
  try {
    data = JSON.parse(bytes);
  } catch {
    throw new Error("SEMGREP_REPORT_INVALID");
  }
  assert(
    data &&
      Array.isArray(data.results) &&
      Array.isArray(data.errors) &&
      Array.isArray(data.paths?.scanned),
    "SEMGREP_REPORT_INCOMPLETE",
  );
  assert(data.errors.length === 0, "SEMGREP_PARSE_OR_RULE_ERROR");
  assert(expectedFiles.length > 0 && data.paths.scanned.length > 0, "SEMGREP_EMPTY_SCAN");
  assert(
    JSON.stringify([...data.paths.scanned].sort()) === JSON.stringify([...expectedFiles].sort()),
    "SEMGREP_FILE_COVERAGE_INCOMPLETE",
  );
  assert(
    (data.results.length === 0 && exitCode === 0) || (data.results.length > 0 && exitCode === 1),
    "SEMGREP_EXIT_REPORT_MISMATCH",
  );
  return data.results.map((finding) => {
    assert(
      ruleIds.includes(finding.check_id) &&
        expectedFiles.includes(finding.path) &&
        Number.isInteger(finding.start?.line) &&
        Number.isInteger(finding.start?.offset) &&
        Number.isInteger(finding.end?.offset) &&
        finding.extra?.engine_kind === "OSS" &&
        typeof readSource === "function",
      "SEMGREP_FINDING_INCOMPLETE",
    );
    assert(finding.extra.is_ignored !== true, "SEMGREP_UNREVIEWED_SUPPRESSION");
    const source = Buffer.from(readSource(finding.path));
    assert(
      finding.start.offset >= 0 &&
        finding.end.offset > finding.start.offset &&
        finding.end.offset <= source.length,
      "SEMGREP_SOURCE_RANGE_INVALID",
    );
    return {
      kind: "semgrep",
      id: finding.check_id,
      path: finding.path,
      line: finding.start.line,
      digest: sha256(source.subarray(finding.start.offset, finding.end.offset)),
      severity: "high",
      blocking: true,
    };
  });
}

function classifiedLiteral(line, entry, baseline) {
  const literals = [...line.matchAll(/(["'`])([^"'`\\\r\n]*)\1/g)]
    .map((match) => match[2])
    .filter((literal) => sha256(literal) === entry.digest);
  if (literals.length !== 1) return false;
  const literal = literals[0];
  switch (entry.provenance.classification) {
    case "idempotency-fixture":
      return /\bidempotencyKey\b/.test(line);
    case "synthetic-boot-token":
      return /\btokenValue\b/.test(line) && /^([a-f0-9]{16})\1$/.test(literal);
    case "public-authentication-tag":
      return /\bwrapAuthenticationTag\b/.test(line);
    case "machine-baseline-fixture":
      return baseline.some(
        (item) =>
          item.file === entry.path &&
          item.ruleId === "jwt-token" &&
          entry.id === "jwt" &&
          item.digest === entry.digest &&
          item.count === 1,
      );
    case "synthetic-marker":
      return literal.includes(syntheticMarker);
    default:
      return false;
  }
}

/** A test directory is never proof. Reconstruct the exact literal in the immutable reviewed source. */
export function verifySyntheticProvenance({ root, baseSha, entry, findings }) {
  assert(
    root && /^[a-f0-9]{40}$/.test(baseSha) && entry.provenance,
    "SECURITY_SYNTHETIC_PROVENANCE_REQUIRED",
  );
  const baseline = JSON.parse(
    git(root, ["show", `${baseSha}:scripts/machine-secret-scan-baseline.json`]),
  );
  assert(Array.isArray(baseline), "SECURITY_SYNTHETIC_BASELINE_INVALID");
  for (const scope of [entry.provenance.current, ...entry.provenance.history]) {
    git(root, ["merge-base", "--is-ancestor", scope.sourceCommit, baseSha]);
    const lines = git(root, ["show", `${scope.sourceCommit}:${entry.path}`]).split(/\r?\n/);
    assert(
      scope.lines.every((line) => classifiedLiteral(lines[line - 1] ?? "", entry, baseline)),
      "REAL_SECRET_CANNOT_BE_EXCEPTED",
    );
  }
  const counts = new Map();
  for (const finding of findings) {
    const scope =
      finding.scope === "current"
        ? entry.provenance.current
        : entry.provenance.history.find((item) => item.sourceCommit === finding.commit);
    assert(scope, "SECURITY_EXCEPTION_HISTORY_EXPANDED");
    const key = finding.scope === "current" ? "current" : finding.commit;
    const count = (counts.get(key) ?? 0) + 1;
    assert(count <= scope.count, "SECURITY_EXCEPTION_SCOPE_EXPANDED");
    counts.set(key, count);
    const source =
      finding.scope === "current"
        ? readFileSync(join(root, entry.path), "utf8")
        : git(root, ["show", `${finding.commit}:${entry.path}`]);
    assert(
      classifiedLiteral(source.split(/\r?\n/)[finding.line - 1] ?? "", entry, baseline),
      "REAL_SECRET_CANNOT_BE_EXCEPTED",
    );
    if (finding.scope === "history")
      assert(scope.lines.includes(finding.line), "SECURITY_EXCEPTION_HISTORY_EXPANDED");
  }
  return true;
}

export function applySecurityExceptions(findings, exceptions, { root, baseSha } = {}) {
  exceptions = exceptions.filter((entry) => entry.kind !== "published-synthetic-fixture");
  const consumed = new Map();
  const proven = new Set();
  for (const [index, entry] of exceptions.entries()) {
    if (entry.kind !== "synthetic-secret" || !entry.provenance) continue;
    verifySyntheticProvenance({
      root,
      baseSha,
      entry,
      findings: findings.filter(
        (finding) =>
          finding.kind === "secret" &&
          finding.id === entry.id &&
          finding.path === entry.path &&
          finding.digest === entry.digest,
      ),
    });
    proven.add(index);
  }
  const result = findings.map((finding) => {
    const index = exceptions.findIndex(
      (entry) =>
        entry.id === finding.id &&
        entry.path === finding.path &&
        (entry.kind === "advisory"
          ? finding.kind === "advisory" &&
            entry.package === finding.package &&
            entry.version === finding.version
          : entry.digest === finding.digest &&
            (entry.kind === "semgrep" ? finding.kind === "semgrep" : finding.kind === "secret")),
    );
    if (index === -1) return { ...finding, excepted: false };
    const entry = exceptions[index];
    assert(
      entry.kind !== "synthetic-secret" || finding.synthetic === true || proven.has(index),
      "REAL_SECRET_CANNOT_BE_EXCEPTED",
    );
    const count = (consumed.get(index) ?? 0) + 1;
    assert(entry.kind === "advisory" || count <= entry.count, "SECURITY_EXCEPTION_SCOPE_EXPANDED");
    consumed.set(index, count);
    return {
      ...finding,
      synthetic: finding.kind === "secret" ? true : finding.synthetic,
      excepted: true,
      classification: entry.provenance?.classification,
      reviewReference: entry.reviewReference,
    };
  });
  assert(
    exceptions.every((_, index) => consumed.has(index)),
    "SECURITY_EXCEPTION_FINDING_UNKNOWN",
  );
  return result;
}

function snapshotCurrent(root, directory) {
  const files = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .split("\0")
    .filter(Boolean);
  assert(files.length > 0, "SECURITY_CURRENT_CONTENT_EMPTY");
  const copied = [];
  for (const path of new Set(files)) {
    assert(exactPath(path), "SECURITY_CURRENT_PATH_INVALID");
    if (!existsSync(join(root, path))) continue;
    assert(
      lstatSync(join(root, path)).isFile() &&
        realpathSync(join(root, path)) === join(realpathSync(root), path),
      "SECURITY_CURRENT_SYMLINK_UNSUPPORTED",
    );
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    copyFileSync(join(root, path), join(directory, path));
    copied.push(path);
  }
  assert(copied.length > 0, "SECURITY_CURRENT_CONTENT_EMPTY");
  git(directory, ["init", "-q"]);
  return copied.sort();
}

function scanGitleaks({ executable, root, scratch, env, files, context, config }) {
  const common = [
    "--config",
    config,
    "--ignore-gitleaks-allow",
    "--gitleaks-ignore-path",
    join(scratch, "no-gitleaks-ignore"),
    "--no-banner",
    "--no-color",
    "--log-level",
    "info",
    "--report-format",
    "json",
    "--redact=0",
  ];
  const currentPath = join(scratch, "current-raw.json");
  const snapshot = join(scratch, "snapshot");
  const current = execute(executable, ["dir", ...common, "--report-path", currentPath, snapshot], {
    root: scratch,
    env,
  });
  const currentExecution = validateGitleaksExecution({ stderr: current.stderr, scope: "current" });
  assert(existsSync(currentPath), "GITLEAKS_REPORT_MISSING");
  chmodSync(currentPath, 0o600);
  const currentFindings = parseGitleaksReport({
    bytes: readFileSync(currentPath, "utf8"),
    exitCode: current.exitCode,
    sourceRoot: snapshot,
    scannedCount: files.length,
    scope: "current",
  });
  assert(
    git(root, ["rev-parse", "--is-shallow-repository"]).trim() === "false",
    "GITLEAKS_HISTORY_SHALLOW",
  );
  let range = "--all";
  let commits;
  if (context.event === "pull_request") {
    const base = git(root, ["merge-base", context.baseSha, context.headSha]).trim();
    range = `${base}..${context.headSha}`;
    commits = Number(git(root, ["rev-list", "--count", range]).trim());
  } else commits = Number(git(root, ["rev-list", "--count", "--all"]).trim());
  assert(commits > 0, "GITLEAKS_HISTORY_EMPTY");
  const historyPath = join(scratch, "history-raw.json");
  const history = execute(
    executable,
    [
      "git",
      ...common,
      "--report-path",
      historyPath,
      "--log-opts",
      `--full-history --no-ext-diff ${range}`,
      root,
    ],
    { root: scratch, env },
  );
  const historyExecution = validateGitleaksExecution({
    stderr: history.stderr,
    scope: "history",
    expectedCommits: commits,
  });
  assert(existsSync(historyPath), "GITLEAKS_REPORT_MISSING");
  chmodSync(historyPath, 0o600);
  const historyFindings = parseGitleaksReport({
    bytes: readFileSync(historyPath, "utf8"),
    exitCode: history.exitCode,
    sourceRoot: root,
    scannedCount: commits,
    scope: "history",
  });
  return {
    scannedCount: files.length + commits,
    currentFiles: files.length,
    commits,
    range,
    execution: { current: currentExecution, history: historyExecution },
    findings: [...currentFindings, ...historyFindings],
  };
}

function scanMachineSecrets({ root, snapshot, env, node, context }) {
  for (const path of [
    "scripts/scan-machine-secrets.mjs",
    "scripts/machine-secret-scan-baseline.json",
  ]) {
    const accepted = git(root, ["show", `${context.baseSha}:${path}`]);
    mkdirSync(dirname(join(snapshot, path)), { recursive: true });
    writeFileSync(join(snapshot, path), accepted);
  }
  const result = execute(node, [join(snapshot, "scripts/scan-machine-secrets.mjs")], {
    root: snapshot,
    env,
  });
  assert([0, 1].includes(result.exitCode), "MACHINE_SECRET_TOOL_FAILED");
  let data;
  try {
    data = JSON.parse(result.exitCode === 0 ? result.stdout : result.stderr);
  } catch {
    throw new Error("MACHINE_SECRET_REPORT_INVALID");
  }
  if (result.exitCode === 0) {
    assert(data.status === "passed" && data.scannedFiles > 0, "MACHINE_SECRET_EMPTY_SCAN");
    return { scannedCount: data.scannedFiles, findings: [] };
  }
  assert(
    data.status === "failed" && Array.isArray(data.findings) && data.findings.length > 0,
    "MACHINE_SECRET_REPORT_INVALID",
  );
  return {
    scannedCount: Number(
      git(snapshot, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .split("\0")
        .filter(Boolean).length,
    ),
    findings: data.findings.map((finding) => {
      assert(
        exactPath(finding.file) &&
          /^[a-f0-9]{64}$/.test(finding.digest) &&
          typeof finding.ruleId === "string" &&
          Number.isInteger(finding.count),
        "MACHINE_SECRET_FINDING_INVALID",
      );
      return {
        kind: "machine-secret",
        id: finding.ruleId,
        path: redactText(finding.file),
        digest: finding.digest,
        count: finding.count,
        blocking: true,
      };
    }),
  };
}

function scanSemgrep({ executable, snapshot, env, files, ruleIds, config }) {
  const targets = files.filter(
    (path) =>
      /^(?:apps|packages)\/[^/]+\/src\/.*\.(?:[cm]?js|jsx|ts|tsx)$/.test(path) ||
      /^scripts\/ci\/.*\.mjs$/.test(path),
  );
  assert(targets.length > 0, "SEMGREP_EMPTY_SCAN");
  const result = execute(
    executable,
    [
      "scan",
      "--oss-only",
      "--strict",
      "--error",
      "--disable-nosem",
      "--no-git-ignore",
      "--no-rewrite-rule-ids",
      "--metrics=off",
      "--config",
      config,
      "--json",
      ...targets,
    ],
    { root: snapshot, env },
  );
  return {
    scannedCount: targets.length,
    rules: ruleIds,
    findings: parseSemgrepReport({
      bytes: result.stdout,
      exitCode: result.exitCode,
      expectedFiles: targets,
      ruleIds,
      readSource: (path) => readFileSync(join(snapshot, path)),
    }),
  };
}

/** Scanners finish independently; failure in one never turns another scanner's absence into success. */
export async function runSecurityChecks({
  root = repositoryRoot,
  toolsDirectory,
  outputDirectory,
  context,
  now = new Date(),
}) {
  const scannedAt = new Date().toISOString();
  verifyContext(context, { root });
  const output = outputPath(outputDirectory, root);
  assert(!existsSync(join(output, "security-report.json")), "SECURITY_REPORT_ALREADY_EXISTS");
  mkdirSync(output, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), "himawari-security-"));
  chmodSync(scratch, 0o700);
  const checks = [];
  let reviewed;
  let inputSha256;
  let infrastructureFailure = false;
  try {
    const lock = loadToolchainLock(root);
    verifyRuleFiles(root, lock);
    const verification = verifyInstalledTools({ directory: toolsDirectory, root });
    assert(
      verification.executables.gitleaks && verification.executables.semgrep,
      "SECURITY_SCANNER_MISSING",
    );
    const env = {
      ...isolatedEnvironment(scratch, join(toolsDirectory, "bin")),
      SSL_CERT_FILE: join(
        toolsDirectory,
        "semgrep",
        "lib",
        `python${lock.python.version.split(".").slice(0, 2).join(".")}`,
        "site-packages/certifi/cacert.pem",
      ),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_PAGER: "cat",
    };
    const rules = parse(readFileSync(join(root, "ci/rules/semgrep.yml"), "utf8"));
    assert(Array.isArray(rules.rules) && rules.rules.length > 0, "SEMGREP_RULES_EMPTY");
    const ruleIds = rules.rules.map((rule) => rule.id);
    assert(
      new Set(ruleIds).size === ruleIds.length &&
        ruleIds.every((id) => /^himawari\.[a-z0-9-]+$/.test(id)),
      "SEMGREP_RULE_ID_INVALID",
    );
    const dependencies = enumerateLockDependencies(
      JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")),
    );
    reviewed = loadReviewedExceptions({ root, context, now, ruleIds, dependencies });
    const snapshot = join(scratch, "snapshot");
    mkdirSync(snapshot);
    const files = snapshotCurrent(root, snapshot);
    inputSha256 = sha256(
      JSON.stringify(files.map((path) => [path, sha256(readFileSync(join(snapshot, path)))])),
    );
    const perform = async (id, work) => {
      const started = performance.now();
      try {
        const result = await work();
        checks.push({
          id,
          status: result.findings.some((finding) => finding.blocking) ? "failed" : "passed",
          durationMs: Math.round(performance.now() - started),
          ...result,
        });
      } catch (error) {
        infrastructureFailure = true;
        checks.push({
          id,
          status: "infrastructure_failed",
          durationMs: Math.round(performance.now() - started),
          scannedCount: 0,
          findings: [],
          error: /^[A-Z_]+$/.test(error.message) ? error.message : "SECURITY_SCANNER_FAILED",
          ...(error instanceof AdvisoryRequestError
            ? {
                diagnostic: error.diagnostic,
                requestAttempts: error.requestAttempts,
                retryCount: error.retryCount,
                requestBudgetMs: error.requestBudgetMs,
              }
            : {}),
        });
      }
    };
    await perform("machine-secrets", () =>
      scanMachineSecrets({ root, snapshot, env, node: verification.executables.node, context }),
    );
    await perform("gitleaks", () =>
      scanGitleaks({
        executable: verification.executables.gitleaks,
        root,
        scratch,
        env,
        files,
        context,
        config: join(root, "ci/rules/gitleaks.toml"),
      }),
    );
    await perform("semgrep", () =>
      scanSemgrep({
        executable: verification.executables.semgrep,
        snapshot,
        env,
        files,
        ruleIds,
        config: join(root, "ci/rules/semgrep.yml"),
      }),
    );
    const semver = createRequire(verification.executables.npmCli)("semver");
    await perform("npm-advisories", () =>
      fetchAdvisories({
        dependencies,
        satisfies: semver.satisfies,
        validRange: semver.validRange,
        now,
      }),
    );
  } catch (error) {
    infrastructureFailure = true;
    checks.push({
      id: "security-preflight",
      status: "infrastructure_failed",
      scannedCount: 0,
      findings: [],
      error: /^[A-Z_]+$/.test(error.message) ? error.message : "SECURITY_PREFLIGHT_FAILED",
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  let findings = checks.flatMap((check) => check.findings);
  try {
    findings = applySecurityExceptions(findings, reviewed?.exceptions ?? [], {
      root,
      baseSha: context.baseSha,
    });
  } catch (error) {
    infrastructureFailure = true;
    checks.push({
      id: "security-exceptions",
      status: "infrastructure_failed",
      scannedCount: 0,
      findings: [],
      error: error.message,
    });
  }
  const status = infrastructureFailure
    ? "infrastructure_failed"
    : findings.some((finding) => finding.blocking && !finding.excepted)
      ? "failed"
      : "passed";
  const findingIdentity = (finding) =>
    JSON.stringify([
      finding.kind,
      finding.id,
      finding.path,
      finding.digest,
      finding.scope,
      finding.commit,
      finding.line,
      finding.package,
      finding.version,
    ]);
  const evaluated = new Map(findings.map((finding) => [findingIdentity(finding), finding]));
  const checkSummaries = checks.map(({ findings: originals, ...check }) => {
    const current = originals.map((finding) => evaluated.get(findingIdentity(finding)) ?? finding);
    return {
      ...check,
      status:
        check.status === "infrastructure_failed"
          ? check.status
          : current.some((finding) => finding.blocking && !finding.excepted)
            ? "failed"
            : "passed",
      findingCount: current.length,
      exceptedCount: current.filter((finding) => finding.excepted).length,
    };
  });
  const report = {
    schemaVersion: 1,
    scannedAt,
    completedAt: new Date().toISOString(),
    status,
    scannedCount: checks.reduce((count, check) => count + check.scannedCount, 0),
    findingCount: findings.length,
    retryCount: checks.reduce((count, check) => count + (check.retryCount ?? 0), 0),
    inputSha256: inputSha256 ?? null,
    context,
    exceptions: reviewed ? { ...reviewed, exceptions: undefined } : null,
    checks: checkSummaries,
    findings,
  };
  const reportPath = join(output, "security-report.json");
  const text = `${JSON.stringify(report, null, 2)}\n`;
  assert(redactText(text) === text, "SECURITY_PUBLIC_REPORT_REQUIRES_REDACTION");
  writeFileSync(reportPath, text, { flag: "wx" });
  await assertPublicArtifacts({
    root: output,
    entries: [
      {
        path: "security-report.json",
        kind: "json",
        classification: "redacted",
        sha256: sha256(text),
      },
    ],
    allowed: [{ path: "security-report.json", kind: "json" }],
  });
  return {
    status,
    scannedCount: report.scannedCount,
    findingCount: findings.length,
    reportPath,
    retryCount: report.retryCount,
    reportSha256: sha256(text),
    checks: report.checks,
  };
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = parseArguments(process.argv.slice(2), ["--tools", "--output", "--context"]);
    assert(args["--tools"] && args["--output"] && args["--context"], "SECURITY_ARGUMENTS_REQUIRED");
    const result = await runSecurityChecks({
      toolsDirectory: resolve(args["--tools"]),
      outputDirectory: args["--output"],
      context: JSON.parse(readFileSync(args["--context"], "utf8")),
    });
    process.stdout.write(`${redactText(JSON.stringify(result))}\n`);
    process.exitCode = result.status === "passed" ? 0 : result.status === "failed" ? 1 : 2;
  } catch (error) {
    process.stderr.write(
      `${/^[A-Z_]+$/.test(error.message) ? error.message : "SECURITY_EXECUTION_FAILED"}\n`,
    );
    process.exitCode = 2;
  }
}
