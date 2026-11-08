import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export const SOURCE_STATES = Object.freeze([
  "jump",
  "reminder",
  "unavailable",
  "import",
  "owner",
  "deleted",
  "tidy",
]);

const STATE_EXPRESSION = `
  CASE
    WHEN m.import_batch_id IS NOT NULL THEN 'import'
    WHEN m.id LIKE 'memory:owner:%' THEN 'owner'
    WHEN m.source_thread_id IS NOT NULL THEN
      CASE WHEN EXISTS (
        SELECT 1 FROM memory_provenance p
        JOIN thread_messages t ON t.content_ref = p.source_id
        JOIN threads h ON h.id = t.thread_id
        WHERE p.memory_id = m.id AND t.thread_id = m.source_thread_id AND t.role = 'owner'
          AND t.message_status = 'committed' AND length(p.source_id) <= 512
          AND h.status NOT IN ('trashed', 'deletion_pending', 'deleted_verified')
      ) THEN 'jump'
      WHEN EXISTS (SELECT 1 FROM memory_provenance p WHERE p.memory_id = m.id)
        AND NOT EXISTS (
          SELECT 1 FROM memory_provenance p
          WHERE p.memory_id = m.id AND p.source_id NOT LIKE 'memory-content:reminder:%'
        ) THEN 'reminder'
      ELSE 'unavailable' END
    WHEN COALESCE((
      SELECT h.source_deleted FROM memory_history_events h
      WHERE h.memory_id = m.id ORDER BY h.occurred_at, h.rowid LIMIT 1
    ), 0) = 1 THEN 'deleted'
    ELSE 'tidy'
  END`;

export function countSources(database) {
  const counts = Object.fromEntries(SOURCE_STATES.map((state) => [state, 0]));
  for (const row of database
    .prepare(
      `SELECT ${STATE_EXPRESSION} AS state, COUNT(*) AS count
       FROM memory_records m WHERE m.status IN ('active', 'archived')
       GROUP BY state`,
    )
    .all())
    counts[row.state] = row.count;
  return { total: SOURCE_STATES.reduce((sum, state) => sum + counts[state], 0), ...counts };
}

export function renderCounts(counts) {
  const labels = {
    jump: "能跳到原话",
    reminder: "提醒创建，无原话",
    unavailable: "来源已不可查",
    import: "导入的，没有原话",
    owner: "手动添加的",
    deleted: "来源对话已删除",
    tidy: "整理记忆产生的",
  };
  const lines = ["| 类别 | 条数 |", "| --- | --- |"];
  for (const state of SOURCE_STATES) lines.push(`| ${labels[state]} | ${counts[state]} |`);
  lines.push(`| 合计（使用中和已归档） | ${counts.total} |`);
  return lines.join("\n");
}

export function main(argv = process.argv.slice(2), output = process.stdout) {
  const json = argv.includes("--json");
  const files = argv.filter((argument) => argument !== "--json");
  if (files.length !== 1)
    throw new TypeError("Usage: memory-source-report.mjs <product.sqlite> [--json]");
  const database = new Database(path.resolve(files[0]), { readonly: true, fileMustExist: true });
  try {
    const counts = countSources(database);
    output.write(json ? `${JSON.stringify(counts, null, 2)}\n` : `${renderCounts(counts)}\n`);
  } finally {
    database.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
