import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const INVENTORY_PATH = "scripts/platform-assumptions.json";
export const SCANNED_DIRECTORIES = Object.freeze([
  "apps",
  "packages",
  "scripts",
  "test",
  "ci",
  ".github",
]);
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
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
  ".sh",
  ".py",
  ".yaml",
  ".yml",
]);
const SCANNED_FILENAMES = new Set(["Dockerfile", "Containerfile", "Makefile"]);
const EXCLUDED_FILES = new Set([
  INVENTORY_PATH,
  "scripts/check-platform-assumptions.mjs",
  "test/tooling/platform-assumptions.test.mjs",
]);
export const PLATFORM_ASSUMPTIONS = Object.freeze({
  lib64: /(?:\/|["'])lib64(?![\w-])/g,
  "linux-x64": /linux-x64/g,
  "arch-x64": /\barch\s*(?:[!=]==?|:)\s*["']?x64(?![\w-])/g,
  x86_64: /x86_64/gi,
  amd64: /amd64/gi,
  "fixed-hostname":
    /hostname\(\)\s*[!=]==?\s*["'](?!__PKT_)[^"'\n]+["']|[eE]qual\(\s*(?:[\w.]*\.)?(?:get)?hostname\(\)\s*,\s*["'](?!__PKT_)[^"'\n]+["']|\$\(hostname(?:\s+-\w+)?\)"?\s*(?:!?==?|-eq|-ne)\s*["']?(?!__PKT_)[^\s"']/g,
  "python-3.12.10-archive": /python-3\.12\.10\.tar\.gz/g,
});

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
    } else if (
      entry.isFile() &&
      (SCANNED_EXTENSIONS.has(path.extname(entry.name)) || SCANNED_FILENAMES.has(entry.name))
    ) {
      files.push(child);
    }
  }
}

export function scanPlatformAssumptions(root = repositoryRoot) {
  const files = [];
  for (const directory of SCANNED_DIRECTORIES) scannedFiles(root, directory, files);
  const observed = {};
  for (const name of Object.keys(PLATFORM_ASSUMPTIONS)) observed[name] = {};
  for (const file of files.sort()) {
    if (EXCLUDED_FILES.has(file)) continue;
    const text = readFileSync(path.join(root, file), "utf8");
    for (const [name, pattern] of Object.entries(PLATFORM_ASSUMPTIONS)) {
      const count = [...text.matchAll(pattern)].length;
      if (count > 0) observed[name][file] = count;
    }
  }
  return observed;
}

export function comparePlatformAssumptions(recorded, observed) {
  const problems = [];
  for (const name of Object.keys(PLATFORM_ASSUMPTIONS)) {
    const before = recorded[name] ?? {};
    const now = observed[name] ?? {};
    for (const file of [...new Set([...Object.keys(before), ...Object.keys(now)])].sort()) {
      const expected = before[file] ?? 0;
      const actual = now[file] ?? 0;
      if (actual > expected) problems.push({ kind: "added", name, file, expected, actual });
      else if (actual < expected) problems.push({ kind: "stale", name, file, expected, actual });
    }
  }
  for (const name of Object.keys(recorded))
    if (!Object.hasOwn(PLATFORM_ASSUMPTIONS, name))
      problems.push({ kind: "unknown", name, file: "", expected: 0, actual: 0 });
  return problems;
}

function describeProblem(problem) {
  if (problem.kind === "added")
    return `PLATFORM_ASSUMPTION_ADDED ${problem.name} ${problem.file} 清单记 ${problem.expected} 处，现在 ${problem.actual} 处：新写死了一处 x86 的目录、平台名或主机名。改成按机器或按目标平台取；确实只属于 x86 的，在 ${INVENTORY_PATH} 里改这一行的数并在 PR 里说明原因`;
  if (problem.kind === "stale")
    return `PLATFORM_ASSUMPTION_STALE ${problem.name} ${problem.file} 清单记 ${problem.expected} 处，现在 ${problem.actual} 处：去掉了写死的地方，把 ${INVENTORY_PATH} 里这一行改成现在的数（0 就删掉这一行）`;
  return `PLATFORM_ASSUMPTION_UNKNOWN ${problem.name} 清单里有检查不认识的类别`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInventory(inventory) {
  let text;
  try {
    text = readFileSync(inventory, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { state: "missing" };
    throw error;
  }
  let recorded;
  try {
    recorded = JSON.parse(text);
  } catch {
    return { state: "invalid" };
  }
  const wellFormed =
    isPlainObject(recorded) &&
    Object.values(recorded).every(
      (files) =>
        isPlainObject(files) &&
        Object.values(files).every((count) => Number.isInteger(count) && count > 0),
    );
  return wellFormed ? { state: "ok", recorded } : { state: "invalid" };
}

export function runPlatformAssumptionsCheck({
  root = repositoryRoot,
  write = false,
  log = console.log,
  error = console.error,
} = {}) {
  const observed = scanPlatformAssumptions(root);
  const inventory = path.join(root, INVENTORY_PATH);
  const { state, recorded } = readInventory(inventory);
  if (state === "invalid")
    error(
      `PLATFORM_ASSUMPTIONS_INVENTORY_INVALID ${INVENTORY_PATH} 必须是“类别 → 文件 → 正整数次数”的 JSON`,
    );
  if (write) {
    for (const problem of comparePlatformAssumptions(recorded ?? {}, observed))
      log(
        `PLATFORM_ASSUMPTIONS_CHANGED ${problem.kind} ${problem.name} ${problem.file} ${problem.expected} -> ${problem.actual}`,
      );
    const temporary = `${inventory}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(observed, null, 2)}\n`);
      renameSync(temporary, inventory);
    } finally {
      rmSync(temporary, { force: true });
    }
    log(`PLATFORM_ASSUMPTIONS written ${INVENTORY_PATH}`);
    return 0;
  }
  if (state === "invalid") return 1;
  if (state === "missing") {
    error(`PLATFORM_ASSUMPTIONS_INVENTORY_MISSING ${INVENTORY_PATH}`);
    return 1;
  }
  const problems = comparePlatformAssumptions(recorded, observed);
  for (const problem of problems) error(describeProblem(problem));
  if (problems.length > 0) return 1;
  const total = Object.values(observed).reduce(
    (sum, files) => sum + Object.values(files).reduce((inner, count) => inner + count, 0),
    0,
  );
  log(`PLATFORM_ASSUMPTIONS passed kinds=${Object.keys(observed).length} occurrences=${total}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rootFlag = process.argv.indexOf("--root");
  const rootValue = rootFlag > 0 ? process.argv[rootFlag + 1] : undefined;
  if (rootFlag > 0 && (rootValue === undefined || rootValue.startsWith("-"))) {
    console.error("PLATFORM_ASSUMPTIONS_USAGE --root 后面要跟一个目录");
    process.exitCode = 2;
  } else {
    process.exitCode = runPlatformAssumptionsCheck({
      root: rootValue === undefined ? repositoryRoot : path.resolve(rootValue),
      write: process.argv.includes("--write"),
    });
  }
}
