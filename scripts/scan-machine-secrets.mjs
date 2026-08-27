import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const rules = Object.freeze([
  [
    "private-key-block",
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  ],
  ["authorization-bearer", /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi],
  ["jwt-token", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ["openai-api-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g],
  ["github-token", /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  [
    "credential-assignment",
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret|webhook[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}["']?/gi,
  ],
]);

const tracked = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  encoding: "buffer",
});
if (tracked.status !== 0) {
  process.stderr.write("machine-secret scan could not enumerate tracked files\n");
  process.exit(2);
}

let baseline = [];
try {
  baseline = JSON.parse(readFileSync("scripts/machine-secret-scan-baseline.json", "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const allowed = new Map(
  baseline.map((entry) => [`${entry.file}\0${entry.ruleId}\0${entry.digest}`, Number(entry.count)]),
);
const observed = new Map();
for (const file of tracked.stdout.toString("utf8").split("\0").filter(Boolean)) {
  // `git ls-files --cached` also reports tracked paths deleted in the current
  // worktree. A pre-commit scan must ignore those absent files instead of
  // failing before it can inspect the remaining content.
  if (!existsSync(file)) continue;
  const content = readFileSync(file);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  for (const [ruleId, pattern] of rules) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const digest = createHash("sha256").update(match[0]).digest("hex");
      const key = `${file}\0${ruleId}\0${digest}`;
      observed.set(key, (observed.get(key) ?? 0) + 1);
    }
  }
}

const findings = [];
for (const [key, count] of observed) {
  if (count <= (allowed.get(key) ?? 0)) continue;
  const [file, ruleId, digest] = key.split("\0");
  findings.push({ file, ruleId, digest, count });
}
if (findings.length > 0) {
  process.stderr.write(`${JSON.stringify({ status: "failed", findings })}\n`);
  process.exit(1);
}
process.stdout.write(
  `${JSON.stringify({ status: "passed", scannedFiles: tracked.stdout.toString("utf8").split("\0").filter(Boolean).length })}\n`,
);
