import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { scanMachineSecrets } from "../../scripts/ci/check-security.mjs";
import { applyMachineReview } from "../../scripts/ci/security-owner-review.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each([1, 0, 2, "changed"])(
  "merged baseline still verifies approved occurrence count: %s",
  (count) => {
    const root = mkdtempSync(join(tmpdir(), "himawari-machine-baseline-"));
    roots.push(root);
    const git = (...args) =>
      execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    mkdirSync(join(root, "scripts"));
    copyFileSync(
      resolve("scripts/scan-machine-secrets.mjs"),
      join(root, "scripts/scan-machine-secrets.mjs"),
    );
    const literal = `password = "${"synthetic".repeat(3)}"`;
    const entry = {
      kind: "machine-secret",
      id: "credential-assignment",
      path: "fixture.txt",
      digest: createHash("sha256").update(literal).digest("hex"),
      count: 1,
    };
    const baseline = JSON.stringify([
      { file: entry.path, ruleId: entry.id, digest: entry.digest, count: 1 },
    ]);
    writeFileSync(join(root, "scripts/machine-secret-scan-baseline.json"), baseline);
    git("add", ".");
    git("commit", "-qm", "accepted baseline");
    const snapshot = join(root, "snapshot");
    mkdirSync(snapshot);
    execFileSync("git", ["init", "-q", snapshot]);
    writeFileSync(
      join(snapshot, "fixture.txt"),
      count === "changed"
        ? literal.replace("synthetic", "different")
        : `${literal}\n`.repeat(count),
    );
    const result = scanMachineSecrets({
      root,
      snapshot,
      context: { baseSha: git("rev-parse", "HEAD") },
      env: process.env,
      node: process.execPath,
      machineExceptions: [entry],
    });
    if (count === 1) {
      expect(result.findings).toHaveLength(1);
      expect(applyMachineReview(result.findings, [entry])[0].excepted).toBe(true);
    } else expect(() => applyMachineReview(result.findings, [entry])).toThrow();
    expect(readFileSync(join(root, "scripts/machine-secret-scan-baseline.json"), "utf8")).toBe(
      baseline,
    );
  },
);
