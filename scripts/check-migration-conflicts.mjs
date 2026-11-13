import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEGACY_FILE,
  META_FILE,
  TIMESTAMP_FILE,
  analyzeMigrations,
} from "./migration-conflicts/analyze.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const directory = join(root, "packages/persistence-sqlite/src/migrations");

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function baseRef() {
  const flag = process.argv.indexOf("--base");
  if (flag !== -1) return process.argv[flag + 1];
  for (const candidate of ["origin/main", "main"]) {
    try {
      return git(["merge-base", "HEAD", candidate]);
    } catch {}
  }
  return null;
}

function baseFileNames(ref) {
  if (!ref) return null;
  const listing = git([
    "ls-tree",
    "--name-only",
    ref,
    "packages/persistence-sqlite/src/migrations/",
  ]);
  return new Set(listing.split("\n").map((line) => line.split("/").pop()));
}

export function loadEntries() {
  const names = readdirSync(directory);
  const legacy = names.filter((name) => LEGACY_FILE.test(name)).sort();
  const stamped = names.filter((name) => TIMESTAMP_FILE.test(name)).sort();
  const unknown = names.filter(
    (name) => !LEGACY_FILE.test(name) && !TIMESTAMP_FILE.test(name) && !META_FILE.test(name),
  );
  const toEntry = (file) => {
    const match = TIMESTAMP_FILE.exec(file);
    return {
      file,
      id: match ? match[1] : file.slice(0, 4),
      name: match ? match[2] : file.slice(5, -4),
      sql: readFileSync(join(directory, file), "utf8"),
    };
  };
  return { legacy: legacy.map(toEntry), stamped: stamped.map(toEntry), unknown };
}

export function loadMeta(entries) {
  const meta = {};
  for (const entry of entries) {
    const path = join(directory, `${entry.id}_${entry.name}.meta.json`);
    if (existsSync(path)) meta[entry.id] = JSON.parse(readFileSync(path, "utf8"));
  }
  return meta;
}

function main() {
  const { legacy, stamped, unknown } = loadEntries();
  const problems = unknown.map((name) => `UNRECOGNIZED_FILE ${name}`);
  const ref = baseRef();
  const known = baseFileNames(ref);
  const base = [...legacy, ...(known ? stamped.filter((entry) => known.has(entry.file)) : [])];
  const added = known ? stamped.filter((entry) => !known.has(entry.file)) : stamped;
  problems.push(...analyzeMigrations({ base, added, meta: loadMeta(added) }));
  if (problems.length > 0) {
    for (const problem of problems) console.error(`MIGRATION_CONFLICT ${problem}`);
    process.exit(1);
  }
  console.log(`MIGRATION_CONFLICTS passed base=${base.length} added=${added.length}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
