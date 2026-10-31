import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = "packages/persistence-sqlite/src/migrations";
const AUDIT_SCRIPT = "scripts/operations/workspace-lifecycle-audit.mjs";

export function checkAuditSchemaRange({ root = repositoryRoot } = {}) {
  const sequences = readdirSync(path.join(root, MIGRATIONS))
    .map((name) => /^(\d{4})_.+\.sql$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  const latest = Math.max(...sequences);
  const declared = /export const SUPPORTED_SCHEMA_MAX = (\d+);/.exec(
    readFileSync(path.join(root, AUDIT_SCRIPT), "utf8"),
  );
  const supported = declared ? Number(declared[1]) : null;
  return { latest, supported, passed: supported === latest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkAuditSchemaRange();
  if (!result.passed)
    process.stderr.write(
      `AUDIT_SCHEMA_RANGE_STALE 数据库迁移已到 ${result.latest}，但 ${AUDIT_SCRIPT} 的 SUPPORTED_SCHEMA_MAX 是 ${result.supported}。先看新迁移有没有改审计脚本读的表（sandbox_*、执行与环境相关表），再把 SUPPORTED_SCHEMA_MAX 改成 ${result.latest}，提交说明写明看过的结论（事故 I-46）。\n`,
    );
  process.stdout.write(
    `AUDIT_SCHEMA_RANGE ${result.passed ? "passed" : "failed"} latest=${result.latest} supported=${result.supported}\n`,
  );
  process.exitCode = result.passed ? 0 : 1;
}
