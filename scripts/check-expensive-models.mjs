import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCANNED_DIRECTORIES = Object.freeze([
  "apps",
  "packages",
  "scripts",
  "test",
  "evals",
  "tools",
  "ci",
  "config",
]);
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "evidence",
  ".ci-output",
]);
const SCANNED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonl",
  ".sh",
  ".py",
  ".yaml",
  ".yml",
  ".toml",
  ".env",
]);
export const HISTORICAL_RECORDS = Object.freeze([/^evals\/[^/]+\/history\.jsonl$/]);
const OWN_TEST = "test/tooling/expensive-models.test.mjs";
export const EXPENSIVE_MODEL_PATTERNS = Object.freeze([
  /(?<![\w./@-])(?:anthropic|openai)\/[A-Za-z0-9][\w.-]*/gi,
  /(?<![\w./@-])(?:claude-(?:opus|sonnet|haiku|fable)|gpt-\d)[\w.-]*/gi,
]);

function scannedFiles(root, relative, files) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return;
  if (statSync(absolute).isFile()) {
    files.push(relative);
    return;
  }
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) scannedFiles(root, child, files);
    } else if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(child);
    }
  }
}

function rootConfigFiles(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        SCANNED_EXTENSIONS.has(path.extname(entry.name)) &&
        entry.name !== "package-lock.json",
    )
    .map((entry) => entry.name);
}

export function findExpensiveModels({ root = repositoryRoot } = {}) {
  const files = rootConfigFiles(root);
  for (const directory of SCANNED_DIRECTORIES) scannedFiles(root, directory, files);
  const findings = [];
  for (const file of files) {
    if (file === OWN_TEST || HISTORICAL_RECORDS.some((pattern) => pattern.test(file))) continue;
    const lines = readFileSync(path.join(root, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      for (const pattern of EXPENSIVE_MODEL_PATTERNS)
        for (const match of line.matchAll(pattern))
          findings.push({ file, line: index + 1, model: match[0] });
    });
  }
  return { files: files.length, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { files, findings } = findExpensiveModels();
  for (const finding of findings)
    process.stderr.write(
      `EXPENSIVE_MODEL_FORBIDDEN ${finding.file}:${finding.line} ${finding.model}\n`,
    );
  if (findings.length > 0)
    process.stderr.write(
      "Claude、OpenAI 等贵模型禁止出现在代码、脚本、评测和配置里（Andy 2026-10-29 决定，ADR 0111、事故 I-19）。改用 test/fixtures/jarvis-test/models.json 等集中配置里的低价模型。\n",
    );
  process.stdout.write(
    `EXPENSIVE_MODELS ${findings.length === 0 ? "passed" : "failed"} files=${files} findings=${findings.length}\n`,
  );
  process.exitCode = findings.length === 0 ? 0 : 1;
}
