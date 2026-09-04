import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { verifyContext } from "./context.mjs";
import { enumerateLockDependencies, loadReviewedExceptions } from "./security-exceptions.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assert = (condition, code) => {
  if (!condition) throw new Error(code);
};

/** Each archive gets its own exact member/finding ledger. No execution context means no exceptions. */
export function createPublishedFixtureReview({ root, context, now } = {}) {
  if (!context) return null;
  verifyContext(context, { root });
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const dependencies = enumerateLockDependencies(lock);
  const rules = parse(readFileSync(join(root, "ci/rules/semgrep.yml"), "utf8"));
  const reviewed = loadReviewedExceptions({
    root,
    context,
    now,
    dependencies,
    ruleIds: rules.rules.map((rule) => rule.id),
  });
  const entries = reviewed.exceptions.filter(
    (entry) => entry.kind === "published-synthetic-fixture",
  );
  const expected = new Map();
  for (const entry of entries) {
    const dependency = lock.packages[entry.packageLockPath];
    assert(
      dependency.integrity === entry.integrity && dependency.resolved === entry.sourceUrl,
      "PUBLIC_FIXTURE_PACKAGE_SOURCE_CHANGED",
    );
    assert(!expected.has(entry.path), "PUBLIC_FIXTURE_MEMBER_DUPLICATE");
    expected.set(entry.path, entry);
  }
  const consumed = new Set();
  let findingCount = 0;
  return {
    inspect({ name, bytes, findings }) {
      // A sentinel is an actual sensitive-payload marker, regardless of any reviewed fixture.
      assert(
        !findings.some((finding) => finding.rule === "sentinel"),
        "PUBLIC_ARTIFACT_CONTAINS_SECRET",
      );
      const entry = expected.get(name);
      if (!entry) {
        assert(findings.length === 0, "PUBLIC_ARTIFACT_CONTAINS_SECRET");
        return;
      }
      assert(!consumed.has(name), "PUBLIC_FIXTURE_MEMBER_DUPLICATE");
      assert(sha256(bytes) === entry.fileSha256, "PUBLIC_FIXTURE_MEMBER_CHANGED");
      const actual = new Map();
      for (const finding of findings) {
        const key = `${finding.rule}:${finding.digest}`;
        actual.set(key, (actual.get(key) ?? 0) + 1);
      }
      assert(
        actual.size === entry.findings.length &&
          entry.findings.every(
            (finding) => actual.get(`${finding.rule}:${finding.digest}`) === finding.count,
          ),
        "PUBLIC_FIXTURE_FINDINGS_CHANGED",
      );
      consumed.add(name);
      findingCount += findings.length;
    },
    finish() {
      assert(consumed.size === expected.size, "PUBLIC_FIXTURE_MEMBER_MISSING");
      return {
        schemaVersion: 1,
        policySha256: reviewed.sha256,
        sourceSha: reviewed.sourceSha,
        approvalBasis: reviewed.approvalBasis,
        reviewStatus: reviewed.reviewStatus,
        candidateDiffers: reviewed.candidateDiffers,
        context,
        packageLockSha256: sha256(readFileSync(join(root, "package-lock.json"))),
        memberCount: consumed.size,
        findingCount,
      };
    },
  };
}
