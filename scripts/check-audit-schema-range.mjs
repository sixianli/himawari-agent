import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = "packages/persistence-sqlite/src/migrations";
const ENGINE = "packages/persistence-sqlite/src/migration-engine.ts";
const AUDIT_SCRIPT = "scripts/operations/workspace-lifecycle-audit.mjs";

function declaredList(source, name) {
  const match = new RegExp(`export const ${name} = Object\\.freeze\\(\\[([^\\]]*)\\]\\);`).exec(
    source,
  );
  return match ? [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]) : null;
}

export function checkAuditSchemaRange({ root = repositoryRoot } = {}) {
  const engine = readFileSync(path.join(root, ENGINE), "utf8");
  const legacy = Math.max(
    0,
    ...[...engine.matchAll(/^\s+sequence: (\d+),/gm)].map((m) => Number(m[1])),
  );
  const audit = readFileSync(path.join(root, AUDIT_SCRIPT), "utf8");
  const declaredMatch = /export const LEGACY_MIGRATION_COUNT = (\d+);/.exec(audit);
  const declared = declaredMatch ? Number(declaredMatch[1]) : null;
  const tables = declaredList(audit, "AUDIT_READ_TABLES") ?? [];
  const reviewed = declaredList(audit, "AUDIT_REVIEWED_MIGRATIONS") ?? [];
  const files = readdirSync(path.join(root, MIGRATIONS));
  const numberedBeyondLegacy = files
    .map((name) => /^(\d{4})_.+\.sql$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter((number) => number > legacy);
  const unreviewed = [];
  for (const name of files) {
    const match = /^(\d{14})_.+\.sql$/.exec(name);
    if (!match) continue;
    const sql = readFileSync(path.join(root, MIGRATIONS, name), "utf8");
    const touched = tables.filter((table) => new RegExp(`\\b${table}\\b`).test(sql));
    if (touched.length > 0 && !reviewed.includes(match[1]))
      unreviewed.push({ id: match[1], tables: touched });
  }
  return {
    legacy,
    declared,
    numberedBeyondLegacy,
    unreviewed,
    passed:
      declared === legacy &&
      tables.length > 0 &&
      numberedBeyondLegacy.length === 0 &&
      unreviewed.length === 0,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkAuditSchemaRange();
  if (result.declared !== result.legacy)
    process.stderr.write(
      `AUDIT_SCHEMA_RANGE_STALE 旧清单有 ${result.legacy} 个迁移，但 ${AUDIT_SCRIPT} 的 LEGACY_MIGRATION_COUNT 是 ${result.declared}。\n`,
    );
  if (result.numberedBeyondLegacy.length > 0)
    process.stderr.write(
      `MIGRATION_NUMBERED_FILE_ADDED 旧清单只到 ${result.legacy}，新迁移用 npm run migration:new 生成时间戳文件名：${result.numberedBeyondLegacy.join(",")}\n`,
    );
  for (const entry of result.unreviewed)
    process.stderr.write(
      `AUDIT_SCHEMA_RANGE_UNREVIEWED 迁移 ${entry.id} 碰了审计脚本读的表（${entry.tables.join(",")}）。先看审计脚本还能不能读，再把 ${entry.id} 加进 ${AUDIT_SCRIPT} 的 AUDIT_REVIEWED_MIGRATIONS，提交说明写明看过的结论（事故 I-46）。\n`,
    );
  process.stdout.write(
    `AUDIT_SCHEMA_RANGE ${result.passed ? "passed" : "failed"} legacy=${result.legacy} declared=${result.declared} unreviewed=${result.unreviewed.length}\n`,
  );
  process.exitCode = result.passed ? 0 : 1;
}
