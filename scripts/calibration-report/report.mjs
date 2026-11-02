import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  buildReport,
  currentCommit,
  DEFAULT_MINIMUM_SAMPLES,
  findScopes,
  HISTORY_SCHEMA,
  historyRecord,
  readWindow,
  resolveWindow,
  sameMeasurement,
  summarizeDecisions,
  summarizeMuse,
} from "./calibration.mjs";

const OPTIONS = new Set([
  "db",
  "owner",
  "agent",
  "days",
  "end",
  "min-samples",
  "history",
  "out-dir",
  "no-record",
]);

export function parseArguments(argv) {
  const options = new Map();
  for (const argument of argv) {
    const [key, value = "1"] = argument.replace(/^--/u, "").split("=");
    if (!OPTIONS.has(key)) throw new TypeError(`CALIBRATION_UNKNOWN_OPTION：不认识的参数 --${key}`);
    options.set(key, value);
  }
  if (!options.has("db"))
    throw new TypeError(
      "CALIBRATION_DB_REQUIRED：用法：report.mjs --db=<product.sqlite> [--owner=<id> --agent=<id>] [--days=7] [--end=YYYY-MM-DD] [--min-samples=5] [--no-record]",
    );
  return options;
}

function readHistory(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

export function run(
  argv,
  { now = new Date(), output = process.stdout, root = process.cwd() } = {},
) {
  const options = parseArguments(argv);
  const minimumSamples = Number(options.get("min-samples") ?? DEFAULT_MINIMUM_SAMPLES);
  if (!Number.isInteger(minimumSamples) || minimumSamples < 1)
    throw new RangeError("CALIBRATION_MIN_SAMPLES：最小样本数必须是正整数");
  const window = resolveWindow({
    end: options.get("end"),
    days: Number(options.get("days") ?? 7),
    now,
  });
  const database = new Database(path.resolve(options.get("db")), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    let scope;
    if (options.has("owner") && options.has("agent"))
      scope = { ownerId: options.get("owner"), agentId: options.get("agent") };
    else {
      const scopes = findScopes(database);
      if (scopes.length !== 1)
        throw new Error(
          `CALIBRATION_SCOPE：数据库里有 ${scopes.length} 个所有者和智能体组合，请用 --owner 和 --agent 指定。${scopes.map((s) => `${s.ownerId}/${s.agentId}`).join("、")}`,
        );
      scope = scopes[0];
    }
    const data = readWindow(database, { ...scope, start: window.start, end: window.end });
    const decisions = summarizeDecisions(data.decisions, minimumSamples);
    const muse = summarizeMuse(data.entries, data.mailJudgments, minimumSamples);
    const historyFile = path.resolve(
      root,
      options.get("history") ?? "evals/calibration/history.jsonl",
    );
    const history = readHistory(historyFile).filter(
      (entry) =>
        entry.schema === HISTORY_SCHEMA &&
        entry.ownerId === scope.ownerId &&
        entry.agentId === scope.agentId,
    );
    const previous = history
      .filter((entry) => entry.window.end < window.end)
      .sort((a, b) => (a.window.end < b.window.end ? -1 : 1))
      .at(-1);
    const markdown = buildReport({ window, scope, decisions, muse, minimumSamples, previous });
    output.write(`${markdown}\n`);
    if (!options.has("no-record")) {
      const record = historyRecord({
        window,
        scope,
        decisions,
        muse,
        minimumSamples,
        commit: currentCommit(),
        recordedAt: now.toISOString(),
      });
      const outDirectory = path.resolve(
        root,
        options.get("out-dir") ?? "evals/calibration/reports",
      );
      mkdirSync(outDirectory, { recursive: true });
      writeFileSync(path.join(outDirectory, `${window.endDate}.md`), `${markdown}\n`);
      const latestForWindow = history.filter((entry) => entry.window.end === window.end).at(-1);
      if (latestForWindow && sameMeasurement(latestForWindow, record))
        output.write("历史记录：这个窗口的数据和上一次记录相同，没有重复追加。\n");
      else {
        mkdirSync(path.dirname(historyFile), { recursive: true });
        appendFileSync(historyFile, `${JSON.stringify(record)}\n`);
        output.write(`历史记录：已追加到 ${path.relative(root, historyFile)}。\n`);
      }
    }
    return { window, decisions, muse };
  } finally {
    database.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
