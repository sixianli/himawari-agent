import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  buildReport,
  currentCommit,
  DEFAULT_MINIMUM_SAMPLES,
  DEFAULT_PREREVIEW_AGREEMENT_PERMILLE,
  DEFAULT_PREREVIEW_CONFIDENCE_PERMILLE,
  findScopes,
  historyRecord,
  prereviewReportLines,
  READABLE_HISTORY_SCHEMAS,
  readWindow,
  resolveWindow,
  sameMeasurement,
  summarizeDecisions,
  summarizeImplicit,
  summarizePrereviewWeek,
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
  "revision",
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
      "CALIBRATION_DB_REQUIRED：用法：report.mjs --db=<product.sqlite> [--owner=<id> --agent=<id>] [--days=7] [--end=YYYY-MM-DD] [--min-samples=5] [--revision=<提交号>] [--no-record]",
    );
  return options;
}

function readHistory(file, output) {
  if (!existsSync(file)) return [];
  const records = [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (!line.trim()) return;
      try {
        records.push(JSON.parse(line));
      } catch {
        output.write(`历史记录第 ${index + 1} 行不是有效的 JSON，已跳过（文件没有被改动）。\n`);
      }
    });
  return records;
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
    if (options.has("owner") !== options.has("agent"))
      throw new TypeError("CALIBRATION_SCOPE：--owner 和 --agent 要一起给，或者都不给。");
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
    const implicit = summarizeImplicit(data.decisions, data.signals, minimumSamples);
    const prereview = summarizePrereviewWeek(data.prereviews, {
      agreementPermille: DEFAULT_PREREVIEW_AGREEMENT_PERMILLE,
      confidencePermille: DEFAULT_PREREVIEW_CONFIDENCE_PERMILLE,
    });
    const historyFile = path.resolve(
      root,
      options.get("history") ?? "evals/calibration/history.jsonl",
    );
    const history = readHistory(historyFile, output).filter(
      (entry) =>
        READABLE_HISTORY_SCHEMAS.includes(entry.schema) &&
        entry.ownerId === scope.ownerId &&
        entry.agentId === scope.agentId,
    );
    const previous = history
      .filter((entry) => entry.window.end < window.end)
      .sort((a, b) => (a.window.end < b.window.end ? -1 : 1))
      .at(-1);
    const markdown = buildReport({
      window,
      scope,
      decisions,
      implicit,
      minimumSamples,
      previous,
      sections: prereviewReportLines(prereview),
    });
    output.write(`${markdown}\n`);
    if (!options.has("no-record")) {
      const record = historyRecord({
        window,
        scope,
        decisions,
        implicit,
        minimumSamples,
        commit: options.get("revision") ?? currentCommit(root),
        recordedAt: now.toISOString(),
        prereview,
      });
      const outDirectory = path.resolve(
        root,
        options.get("out-dir") ?? "evals/calibration/reports",
      );
      mkdirSync(outDirectory, { recursive: true });
      const suffix = options.has("agent")
        ? `-${scope.ownerId}-${scope.agentId}`.replace(/[^A-Za-z0-9._-]/gu, "_")
        : "";
      writeFileSync(path.join(outDirectory, `${window.endDate}${suffix}.md`), `${markdown}\n`);
      const latestForWindow = history.filter((entry) => entry.window.end === window.end).at(-1);
      if (latestForWindow && sameMeasurement(latestForWindow, record))
        output.write("历史记录：这个窗口的数据和上一次记录相同，没有重复追加。\n");
      else {
        mkdirSync(path.dirname(historyFile), { recursive: true });
        appendFileSync(historyFile, `${JSON.stringify(record)}\n`);
        output.write(`历史记录：已追加到 ${path.relative(root, historyFile)}。\n`);
      }
    }
    return { window, decisions, prereview };
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
