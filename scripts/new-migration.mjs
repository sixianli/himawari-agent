import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/persistence-sqlite/src/migrations",
);

export function nextMigrationId(existing, now = new Date()) {
  const stamp = now.toISOString().replace(/\D/g, "").slice(0, 14);
  const latest = existing
    .map((name) => /^(\d{14})_/.exec(name)?.[1])
    .filter(Boolean)
    .sort()
    .pop();
  if (latest && latest >= stamp) {
    const bumped = BigInt(latest) + 1n;
    return bumped.toString();
  }
  return stamp;
}

export function validName(name) {
  return typeof name === "string" && /^[a-z][a-z0-9_]*$/.test(name);
}

function mainNames() {
  try {
    return execFileSync(
      "git",
      ["ls-tree", "--name-only", "origin/main", "packages/persistence-sqlite/src/migrations/"],
      {
        cwd: join(directory, "../../../.."),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    )
      .split("\n")
      .map((line) => line.split("/").pop());
  } catch {
    return [];
  }
}

function main() {
  const name = process.argv[2];
  if (!validName(name)) {
    console.error("Usage: npm run migration:new -- <snake_case_name>");
    process.exit(2);
  }
  const id = nextMigrationId([...readdirSync(directory), ...mainNames()]);
  const file = join(directory, `${id}_${name}.sql`);
  writeFileSync(file, "", { flag: "wx" });
  console.log(file);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
