import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { findGreenBase, findLastRanBase, getJson, getPages } from "./main-green.mjs";

const APPLE_CLIENT = [
  /^clients\/apple\//u,
  /^\.github\/workflows\/apple\.yml$/u,
  /^scripts\/ci\/apple-scope\.mjs$/u,
  /^scripts\/ci\/main-green\.mjs$/u,
];

export const mainCheckPrefixes = ["apple/iphone", "apple/scroll"];
export const auditCheckPrefixes = [
  "apple/iphone-accessibility-build",
  "apple/iphone-accessibility",
];

export function touchesAppleClient(files) {
  if (files === null) return true;
  return files.some((file) => APPLE_CLIENT.some((pattern) => pattern.test(file)));
}

export function changedFiles(base, head, git = execFileSync) {
  if (!base || /^0+$/u.test(base)) return null;
  try {
    git("git", ["fetch", "--no-tags", "--depth=1", "origin", base], { stdio: "ignore" });
    return String(git("git", ["diff", "--name-only", base, head], { encoding: "utf8" }))
      .split("\n")
      .filter(Boolean);
  } catch {
    return null;
  }
}

export async function sinceGreenBase({
  repo = process.env.GITHUB_REPOSITORY,
  runId = process.env.GITHUB_RUN_ID,
  find = findGreenBase,
} = {}) {
  try {
    return await find({
      repo,
      workflow: "apple.yml",
      prefixes: mainCheckPrefixes,
      runId,
      getJson,
      getPages,
    });
  } catch {
    return null;
  }
}

export async function sinceAuditBase({
  repo = process.env.GITHUB_REPOSITORY,
  runId = process.env.GITHUB_RUN_ID,
  find = findLastRanBase,
} = {}) {
  try {
    return await find({
      repo,
      workflow: "apple.yml",
      job: auditCheckPrefixes[0],
      event: "schedule",
      runId,
      getJson,
      getPages,
    });
  } catch {
    return null;
  }
}

const bases = { "--since-green": sinceGreenBase, "--since-audit": sinceAuditBase };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [first, head = "HEAD"] = process.argv.slice(2);
  const base = Object.hasOwn(bases, first ?? "") ? await bases[first]() : first;
  const files = changedFiles(base, head);
  const client = touchesAppleClient(files);
  process.stderr.write(
    `APPLE_SCOPE client=${client} base=${base || "none"} files=${files === null ? "unknown" : files.length}\n`,
  );
  process.stdout.write(`client=${client}\nbase=${base ?? ""}\n`);
}
