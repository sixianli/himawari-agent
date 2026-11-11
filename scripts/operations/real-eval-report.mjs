import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

export const SCORE_COLUMNS = Object.freeze(["fixed", "fresh", "abstain", "retrieval"]);

function jstDay(instant) {
  return new Date(Date.parse(instant) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function score(value) {
  if (
    typeof value !== "object" ||
    value === null ||
    !Number.isSafeInteger(value.successes) ||
    !Number.isSafeInteger(value.samples)
  )
    return null;
  return {
    successes: value.successes,
    samples: value.samples,
    value: value.enough === true && typeof value.value === "number" ? value.value : null,
    low: typeof value.low === "number" ? value.low : null,
    high: typeof value.high === "number" ? value.high : null,
  };
}

export function readRuns(database, { limit = 52 } = {}) {
  return database
    .prepare(
      `SELECT id, started_at AS startedAt, finished_at AS finishedAt, outcome, trigger, model,
        cost_micros AS costMicros, summary
      FROM real_eval_runs ORDER BY started_at DESC, id DESC LIMIT ?`,
    )
    .all(limit)
    .map((row) => {
      const summary = JSON.parse(row.summary);
      const scores = summary.scores ?? {};
      return {
        id: row.id,
        day: jstDay(row.startedAt),
        startedAt: row.startedAt,
        outcome: row.outcome,
        trigger: row.trigger,
        model: row.model,
        costMicros: row.costMicros,
        items: Number.isSafeInteger(summary.items) ? summary.items : 0,
        added: Number.isSafeInteger(summary.added) ? summary.added : 0,
        retired: Number.isSafeInteger(summary.retired) ? summary.retired : 0,
        scores: Object.fromEntries(SCORE_COLUMNS.map((key) => [key, score(scores[key])])),
      };
    });
}

function percent(entry) {
  if (entry === null) return "无数据";
  if (entry.value === null) return `样本不足(${entry.samples})`;
  const interval =
    entry.low === null || entry.high === null
      ? ""
      : ` [${(entry.low * 100).toFixed(0)}–${(entry.high * 100).toFixed(0)}]`;
  return `${(entry.value * 100).toFixed(1)}%${interval} (${entry.successes}/${entry.samples})`;
}

export function renderTable(rows) {
  const header = [
    "日期(JST)",
    "触发",
    "结果",
    "模型",
    "费用(美元)",
    "计分题",
    "新增题",
    "退役题",
    "固定面板答对率",
    "本周新题答对率",
    "拒答题答对率",
    "检索命中率",
  ];
  const lines = [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const row of rows)
    lines.push(
      `| ${[
        row.day,
        row.trigger,
        row.outcome,
        row.model,
        (row.costMicros / 1_000_000).toFixed(4),
        row.items,
        row.added,
        row.retired,
        ...SCORE_COLUMNS.map((key) => percent(row.scores[key])),
      ].join(" | ")} |`,
    );
  return lines.join("\n");
}

function parseArguments(argv) {
  const options = { file: null, limit: 52, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--limit") options.limit = Number(argv[++index]);
    else if (options.file === null) options.file = argument;
    else throw new TypeError(`Unexpected argument ${argument}`);
  }
  if (options.file === null || !Number.isSafeInteger(options.limit) || options.limit < 1)
    throw new TypeError("Usage: real-eval-report.mjs <product.sqlite> [--limit N] [--json]");
  return options;
}

export function main(argv = process.argv.slice(2), output = process.stdout) {
  const options = parseArguments(argv);
  const database = new Database(path.resolve(options.file), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const rows = readRuns(database, options);
    output.write(options.json ? `${JSON.stringify(rows, null, 2)}\n` : `${renderTable(rows)}\n`);
  } finally {
    database.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
