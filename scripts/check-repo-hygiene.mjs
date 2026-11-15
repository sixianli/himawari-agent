import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function currentRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}
const CONFIG_PATH = "scripts/repo-hygiene/config.json";

function git(root, args, input) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function repositoryPath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.startsWith("./") &&
    !value.split("/").some((part) => part === ".." || part === "." || part.includes("*"))
  );
}

export function parseConfig(text) {
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error("REPO_HYGIENE_CONFIG_INVALID json");
  }
  const problems = [];
  if (config?.schemaVersion !== 1) problems.push("schemaVersion");
  if (!positiveInteger(config?.maxFileBytes)) problems.push("maxFileBytes");
  if (!positiveInteger(config?.maxChangeBytes)) problems.push("maxChangeBytes");
  for (const key of ["generatedPaths", "mustBeIgnored"]) {
    if (
      !Array.isArray(config?.[key]) ||
      !config[key].every((entry) => repositoryPath(entry) && entry.endsWith("/"))
    )
      problems.push(key);
  }
  if (
    !Array.isArray(config?.generatedExtensions) ||
    !config.generatedExtensions.every((entry) => /^\.[a-z0-9]+$/.test(entry))
  )
    problems.push("generatedExtensions");
  if (
    !Array.isArray(config?.allowedLarge) ||
    !config.allowedLarge.every(
      (entry) =>
        repositoryPath(entry?.path) &&
        typeof entry?.reason === "string" &&
        entry.reason.trim().length > 0,
    )
  )
    problems.push("allowedLarge");
  if (problems.length > 0) throw new Error(`REPO_HYGIENE_CONFIG_INVALID ${problems.join(",")}`);
  return config;
}

export function loadConfig(root) {
  let text;
  try {
    text = readFileSync(join(root, CONFIG_PATH), "utf8");
  } catch {
    throw new Error(`REPO_HYGIENE_CONFIG_MISSING ${CONFIG_PATH}`);
  }
  return parseConfig(text);
}

export function resolveBase({ root, env = process.env }) {
  const reference = env.HIMAWARI_REPO_HYGIENE_BASE ?? "origin/main";
  try {
    return git(root, ["merge-base", "HEAD", reference]).trim();
  } catch {
    throw new Error(
      `REPO_HYGIENE_BASE_MISSING ${reference}（先 git fetch origin main，或用 HIMAWARI_REPO_HYGIENE_BASE 指定基准提交）`,
    );
  }
}

function matchesPrefix(path, prefix) {
  return prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix;
}

export function changedBlobs(root, base) {
  const raw = git(root, ["diff", "--raw", "-z", "-M", "--no-abbrev", `${base}...HEAD`]);
  const fields = raw.split("\0");
  const changes = [];
  for (let index = 0; index < fields.length - 1; ) {
    const header = fields[index];
    if (!header.startsWith(":")) {
      index += 1;
      continue;
    }
    const [, , , blob, status] = header.slice(1).split(" ");
    const kind = status[0];
    const paths = kind === "R" || kind === "C" ? 2 : 1;
    const path = fields[index + paths];
    index += paths + 1;
    if (kind === "D") continue;
    if (kind === "R" && status === "R100") continue;
    changes.push({ path, blob });
  }
  if (changes.length === 0) return [];
  const sizes = git(
    root,
    ["cat-file", "--batch-check=%(objectname) %(objectsize)"],
    `${changes.map((change) => change.blob).join("\n")}\n`,
  )
    .trim()
    .split("\n");
  return changes.map((change, position) => ({
    ...change,
    bytes: Number(sizes[position].split(" ")[1]),
  }));
}

export function trackedFiles(root) {
  return git(root, ["ls-files", "-z"]).split("\0").filter(Boolean);
}

export function ignoredPaths(root, paths) {
  if (paths.length === 0) return new Set();
  try {
    return new Set(
      git(root, ["check-ignore", "--no-index", "-z", "--stdin"], `${paths.join("\0")}\0`)
        .split("\0")
        .filter(Boolean),
    );
  } catch (error) {
    if (error.status === 1) return new Set();
    throw error;
  }
}

export function evaluate({ config, changes, tracked, ignored }) {
  const findings = [];
  const allowed = (path) => config.allowedLarge.some((entry) => matchesPrefix(path, entry.path));
  let changeBytes = 0;
  for (const change of changes) {
    if (allowed(change.path)) continue;
    changeBytes += change.bytes;
    if (change.bytes > config.maxFileBytes)
      findings.push(
        `REPO_HYGIENE_FILE_TOO_LARGE ${change.path} bytes=${change.bytes} limit=${config.maxFileBytes}`,
      );
  }
  if (changeBytes > config.maxChangeBytes)
    findings.push(
      `REPO_HYGIENE_CHANGE_TOO_LARGE bytes=${changeBytes} limit=${config.maxChangeBytes}`,
    );
  for (const path of tracked) {
    const generatedPath = config.generatedPaths.find((prefix) => path.startsWith(prefix));
    const extension = config.generatedExtensions.find((suffix) =>
      path.toLowerCase().endsWith(suffix),
    );
    if (generatedPath || extension)
      findings.push(`REPO_HYGIENE_TRACKED_GENERATED ${path} (${generatedPath ?? extension})`);
    const local = config.mustBeIgnored.find((prefix) => path.startsWith(prefix));
    if (local) findings.push(`REPO_HYGIENE_LOCAL_DIR_TRACKED ${path} (${local})`);
  }
  for (const prefix of config.mustBeIgnored) {
    if (!ignored.has(`${prefix}probe`))
      findings.push(`REPO_HYGIENE_LOCAL_DIR_NOT_IGNORED ${prefix}`);
  }
  return { findings, changeBytes, changedFiles: changes.length };
}

export function checkRepository({ root, env = process.env }) {
  const config = loadConfig(root);
  const base = resolveBase({ root, env });
  const changes = changedBlobs(root, base);
  const tracked = trackedFiles(root);
  const ignored = ignoredPaths(
    root,
    config.mustBeIgnored.map((prefix) => `${prefix}probe`),
  );
  return { base, ...evaluate({ config, changes, tracked, ignored }) };
}

function main() {
  let result;
  try {
    result = checkRepository({ root: currentRoot() });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  for (const finding of result.findings) process.stderr.write(`${finding}\n`);
  if (result.findings.length > 0) {
    process.stderr.write(
      `REPO_HYGIENE_FAILED findings=${result.findings.length}：截图、录屏、编译缓存不进仓库（见 docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md）；确实要提交的大文件，在 ${CONFIG_PATH} 的 allowedLarge 里按路径登记理由\n`,
    );
    return 1;
  }
  process.stdout.write(
    `REPO_HYGIENE_PASSED base=${result.base.slice(0, 12)} changed=${result.changedFiles} bytes=${result.changeBytes}\n`,
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
