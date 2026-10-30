import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export const MINIMUM_CACHEABLE_INPUT_TOKENS = 1024;
export const MINIMUM_REPORTED_REQUESTS = 5;
export const GROUPINGS = Object.freeze(["purpose", "model", "day", "purpose-model"]);

const GROUP_EXPRESSIONS = Object.freeze({
  purpose: "purpose",
  model: "model",
  day: "date(occurred_at, '+9 hours')",
  "purpose-model": "purpose || ' / ' || model",
});

export function summarize(database, { grouping = "purpose", since = null, until = null } = {}) {
  const expression = GROUP_EXPRESSIONS[grouping];
  if (expression === undefined) throw new TypeError(`Unknown grouping ${grouping}`);
  return database
    .prepare(
      `WITH numbered AS (
         SELECT *, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY occurred_at, invocation_id) AS position
         FROM model_usage_observations
         WHERE (:since IS NULL OR occurred_at >= :since) AND (:until IS NULL OR occurred_at < :until)
       )
       SELECT ${expression} AS "group",
         COUNT(*) AS requests,
         SUM(cache_reported) AS reported,
         SUM(CASE WHEN cache_reported = 1 AND input_tokens >= :minimum THEN 1 ELSE 0 END) AS measured,
         SUM(CASE WHEN cache_reported = 1 AND input_tokens >= :minimum THEN input_tokens ELSE 0 END) AS measuredInput,
         SUM(CASE WHEN cache_reported = 1 AND input_tokens >= :minimum THEN cache_read_tokens ELSE 0 END) AS measuredCacheRead,
         SUM(CASE WHEN cache_reported = 1 AND input_tokens >= :minimum AND position > 1 THEN 1 ELSE 0 END) AS followUps,
         SUM(CASE WHEN cache_reported = 1 AND input_tokens >= :minimum AND position > 1 THEN input_tokens ELSE 0 END) AS followUpInput,
         SUM(CASE WHEN cache_reported = 1 AND input_tokens >= :minimum AND position > 1 THEN cache_read_tokens ELSE 0 END) AS followUpCacheRead,
         SUM(CASE WHEN cache_reported = 1 AND input_tokens < :minimum THEN 1 ELSE 0 END) AS tooShort
       FROM numbered
       GROUP BY "group"
       ORDER BY "group"`,
    )
    .all({ since, until, minimum: MINIMUM_CACHEABLE_INPUT_TOKENS })
    .map((row) => ({
      group: row.group,
      requests: row.requests,
      reported: row.reported,
      unreported: row.requests - row.reported,
      tooShort: row.tooShort,
      measured: row.measured,
      hitRate: rate(row.measured, row.measuredCacheRead, row.measuredInput),
      followUps: row.followUps,
      followUpHitRate: rate(row.followUps, row.followUpCacheRead, row.followUpInput),
    }));
}

function rate(samples, cacheRead, input) {
  return samples >= MINIMUM_REPORTED_REQUESTS && input > 0 ? cacheRead / input : null;
}

function percent(value, samples) {
  return value === null ? `样本不足(${samples})` : `${(value * 100).toFixed(1)}%`;
}

export function renderTable(rows) {
  const header = [
    "分组",
    "请求数",
    "已上报",
    "未上报",
    "过短(<1024)",
    "参与统计",
    "命中率",
    "同一次运行内后续请求",
    "后续命中率",
  ];
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const row of rows) {
    lines.push(
      `| ${[
        row.group,
        row.requests,
        row.reported,
        row.unreported,
        row.tooShort,
        row.measured,
        percent(row.hitRate, row.measured),
        row.followUps,
        percent(row.followUpHitRate, row.followUps),
      ].join(" | ")} |`,
    );
  }
  return lines.join("\n");
}

function parseArguments(argv) {
  const options = { grouping: "purpose", since: null, until: null, json: false, file: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--by") options.grouping = argv[++index];
    else if (argument === "--since") options.since = argv[++index];
    else if (argument === "--until") options.until = argv[++index];
    else if (options.file === null) options.file = argument;
    else throw new TypeError(`Unexpected argument ${argument}`);
  }
  if (options.file === null)
    throw new TypeError(
      "Usage: cache-hit-report.mjs <product.sqlite> [--by purpose|model|day|purpose-model] [--since ISO] [--until ISO] [--json]",
    );
  return options;
}

export function main(argv = process.argv.slice(2), output = process.stdout) {
  const options = parseArguments(argv);
  const database = new Database(path.resolve(options.file), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const rows = summarize(database, options);
    output.write(options.json ? `${JSON.stringify(rows, null, 2)}\n` : `${renderTable(rows)}\n`);
  } finally {
    database.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
