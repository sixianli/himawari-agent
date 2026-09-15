import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeRelativePath } from "./contracts.mjs";

const repository = "sixianli/himawari-agent";
const owner = { login: "sixianli", id: 30715326 };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assert = (condition, code) => {
  if (!condition) throw new Error(code);
};

/** Public API, fixed origin, TLS verification and no credentials or redirects. */
export function readReviewComment(commentId) {
  assert(Number.isSafeInteger(commentId) && commentId > 0, "SECURITY_REVIEW_COMMENT_INVALID");
  let response;
  try {
    response = execFileSync(
      "/usr/bin/curl",
      [
        "--disable",
        "--fail",
        "--silent",
        "--show-error",
        "--connect-timeout",
        "5",
        "--max-time",
        "15",
        "--retry",
        "2",
        "--retry-max-time",
        "40",
        "--proto",
        "=https",
        "--header",
        "Accept: application/vnd.github+json",
        "--write-out",
        "\\n%{http_code}",
        `https://api.github.com/repos/${repository}/issues/comments/${commentId}`,
      ],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 55_000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    // Never expose the response body, stderr, or process arguments in public logs.
    const http = String(error.stdout ?? "")
      .trimEnd()
      .slice(-3);
    const reason =
      error.status === 22
        ? ({ 403: "HTTP_FORBIDDEN", 404: "HTTP_NOT_FOUND", 429: "HTTP_RATE_LIMITED" }[http] ??
          (/^5\d\d$/.test(http) ? "HTTP_SERVER_ERROR" : "HTTP_REJECTED"))
        : error.status === 28 || error.code === "ETIMEDOUT"
          ? "TRANSPORT_TIMEOUT"
          : [35, 51, 60].includes(error.status)
            ? "TLS_FAILED"
            : "UNAVAILABLE";
    throw new Error(`SECURITY_REVIEW_${reason}`);
  }
  const separator = response.lastIndexOf("\n");
  assert(
    separator >= 0 && response.slice(separator + 1).trim() === "200",
    "SECURITY_REVIEW_HTTP_REJECTED",
  );
  try {
    return JSON.parse(response.slice(0, separator));
  } catch {
    throw new Error("SECURITY_REVIEW_INVALID_RESPONSE");
  }
}

/** The checkout only locates evidence; it cannot assert that an owner approved it. */
export function loadOwnerReview({
  root,
  context,
  now = new Date(),
  readComment = readReviewComment,
}) {
  const path = join(root, ".github/security-review-manifest.json");
  const referencePath = join(root, ".github/security-review-comment.json");
  if (!existsSync(path) && !existsSync(referencePath)) return null;
  assert(existsSync(path) && existsSync(referencePath), "SECURITY_REVIEW_INCOMPLETE");
  const bytes = readFileSync(path);
  const manifest = JSON.parse(bytes);
  const { commentId } = JSON.parse(readFileSync(referencePath));
  assert(Number.isSafeInteger(commentId) && commentId > 0, "SECURITY_REVIEW_COMMENT_INVALID");
  assert(
    context.repository === repository &&
      manifest.repository === repository &&
      Number.isSafeInteger(manifest.pullRequest) &&
      manifest.pullRequest > 0 &&
      /^[a-f0-9]{40}$/.test(manifest.sourceHead) &&
      Array.isArray(manifest.entries) &&
      manifest.entries.length > 0,
    "SECURITY_REVIEW_MANIFEST_INVALID",
  );
  const acceptedBytes = (relative) => {
    try {
      return execFileSync("git", ["show", `${context.baseSha}:${relative}`], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return null;
    }
  };
  const inherited =
    bytes.equals(acceptedBytes(".github/security-review-manifest.json") ?? Buffer.alloc(0)) &&
    readFileSync(referencePath).equals(
      acceptedBytes(".github/security-review-comment.json") ?? Buffer.alloc(0),
    );
  if (context.event === "pull_request" && !inherited) {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    assert(
      event.number === manifest.pullRequest && event.pull_request?.head?.sha === context.headSha,
      "SECURITY_REVIEW_PR_MISMATCH",
    );
  }
  const comment = readComment(commentId);
  const reference = `https://github.com/${repository}/pull/${manifest.pullRequest}#issuecomment-${commentId}`;
  assert(
    comment.id === commentId &&
      comment.user?.id === owner.id &&
      comment.user?.login === owner.login &&
      comment.user?.type === "User" &&
      comment.issue_url ===
        `https://api.github.com/repos/${repository}/issues/${manifest.pullRequest}` &&
      comment.html_url === reference,
    "SECURITY_REVIEW_IDENTITY_MISMATCH",
  );
  const parts =
    typeof comment.body === "string"
      ? comment.body.split("<!-- himawari-security-review-v1 -->")
      : [];
  assert(parts.length === 2, "SECURITY_REVIEW_RECORD_MISSING");
  const block = parts[1].trimStart();
  const end = block.indexOf("\n```", 8);
  assert(block.startsWith("```json\n") && end > 8, "SECURITY_REVIEW_RECORD_MISSING");
  const approval = JSON.parse(block.slice(8, end));
  assert(
    approval.schemaVersion === 1 &&
      approval.decision === "approved" &&
      approval.repository === repository &&
      approval.pullRequest === manifest.pullRequest &&
      approval.sourceHead === manifest.sourceHead &&
      approval.manifestSha256 === sha256(bytes),
    "SECURITY_REVIEW_SCOPE_MISMATCH",
  );
  const created = Date.parse(comment.created_at);
  const expires = Date.parse(approval.expiresAt);
  const instant = new Date(now).getTime();
  assert(
    Number.isFinite(instant) &&
      created <= instant &&
      expires > instant &&
      expires > created &&
      expires - created <= 30 * 86_400_000 &&
      /^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(approval.expiresAt),
    "SECURITY_REVIEW_EXPIRED",
  );
  assert(/^[a-f0-9]{40}$/.test(context.headSha), "SECURITY_REVIEW_HEAD_INVALID");
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", manifest.sourceHead, context.headSha], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("SECURITY_REVIEW_SOURCE_UNRELATED");
  }
  const common = {
    owner: owner.login,
    reviewReference: reference,
    expiresAt: approval.expiresAt,
    reason: "仓库所有者批准的精确测试或文档值；源码、内容摘要及数量仍逐项验证。",
  };
  const exceptions = [];
  const machineExceptions = [];
  const current = manifest.entries.filter(
    (entry) => entry.kind === "secret" && entry.scope === "current",
  );
  for (const entry of manifest.entries) {
    if (entry.kind === "machine-secret") {
      assert(
        entry.id === "credential-assignment" &&
          safeRelativePath(entry.path) &&
          !/[*?[\]{}]/.test(entry.path) &&
          /^[a-f0-9]{64}$/.test(entry.digest) &&
          Number.isSafeInteger(entry.count) &&
          entry.count > 0,
        "SECURITY_REVIEW_MACHINE_INVALID",
      );
      machineExceptions.push(entry);
    } else if (entry.kind === "secret") {
      assert(
        ["current", "history"].includes(entry.scope) &&
          current.filter(
            (item) =>
              item.path === entry.path && item.digest === entry.digest && item.id === entry.id,
          ).length === 1,
        "SECURITY_REVIEW_SECRET_INVALID",
      );
      if (entry.scope === "history") continue;
      const history = manifest.entries.filter(
        (item) =>
          item.kind === "secret" &&
          item.scope === "history" &&
          item.path === entry.path &&
          item.id === entry.id &&
          item.digest === entry.digest,
      );
      exceptions.push({
        ...common,
        kind: "synthetic-secret",
        id: entry.id,
        path: entry.path,
        digest: entry.digest,
        count: 1 + history.length,
        provenance: {
          classification: "synthetic-boot-token",
          current: { sourceCommit: manifest.sourceHead, lines: [entry.line], count: 1 },
          history: history.map((item) => ({
            sourceCommit: item.commit,
            lines: [item.line],
            count: 1,
          })),
        },
      });
    } else {
      assert(
        entry.classification === "published documentation example seed" &&
          entry.archiveMember?.startsWith("package/"),
        "SECURITY_REVIEW_KIND_INVALID",
      );
      const packageLockPath = `node_modules/${entry.package}`;
      exceptions.push({
        ...common,
        kind: "published-synthetic-fixture",
        id: "published-synthetic-fixture",
        path: `runtime/${packageLockPath}/${entry.archiveMember.slice(8)}`,
        package: entry.package,
        version: entry.version,
        packageLockPath,
        integrity: entry.integrity,
        sourceUrl: entry.sourceUrl,
        archiveMember: entry.archiveMember,
        fileSha256: entry.fileSha256,
        findings: [{ rule: "credential-literal", digest: entry.findingDigest, count: 1 }],
        sourceProofSha256: sha256(bytes),
        sourceReview: entry.verification,
      });
    }
  }
  assert(
    new Set(machineExceptions.map((entry) => `${entry.path}:${entry.id}:${entry.digest}`)).size ===
      machineExceptions.length,
    "SECURITY_REVIEW_MACHINE_DUPLICATE",
  );
  return {
    exceptions,
    machineExceptions,
    sourceSha: manifest.sourceHead,
    sha256: sha256(bytes),
    reference,
    expiresAt: approval.expiresAt,
  };
}

/** Keep scanner findings visible and require the exact approved count, including disappearance. */
export function applyMachineReview(findings, entries = []) {
  const consumed = new Set();
  const result = findings.map((finding) => {
    const index = entries.findIndex(
      (entry) =>
        finding.kind === "machine-secret" &&
        entry.id === finding.id &&
        entry.path === finding.path &&
        entry.digest === finding.digest,
    );
    if (index < 0) return finding;
    assert(
      !consumed.has(index) && finding.count === entries[index].count,
      "SECURITY_REVIEW_MACHINE_COUNT_CHANGED",
    );
    consumed.add(index);
    return { ...finding, excepted: true, classification: "owner-reviewed-machine-finding" };
  });
  assert(consumed.size === entries.length, "SECURITY_REVIEW_MACHINE_FINDING_MISSING");
  return result;
}
