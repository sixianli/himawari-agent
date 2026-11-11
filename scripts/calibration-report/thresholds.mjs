import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  analyzeGate,
  assertTimestampFormat,
  DEFAULT_INTERVAL_WIDTH_LIMIT,
  DEFAULT_MISS_COST_RATIOS,
  findScopes,
  requiredSamples,
  resolveWindow,
  THRESHOLD_GATES,
  THRESHOLD_SQL,
  thresholdReport,
  ungatedKinds,
} from "./calibration.mjs";

const OPTIONS = new Set(["db", "owner", "agent", "days", "end", "miss-cost"]);
const ALL_TIME = { start: "0000-01-01T00:00:00.000Z", end: "9999-12-31T23:59:59.999Z" };

export function parseArguments(argv) {
  const options = new Map();
  for (const argument of argv) {
    const [key, value = "1"] = argument.replace(/^--/u, "").split("=");
    if (!OPTIONS.has(key)) throw new TypeError(`THRESHOLD_UNKNOWN_OPTION：不认识的参数 --${key}`);
    options.set(key, value);
  }
  if (!options.has("db"))
    throw new TypeError(
      "THRESHOLD_DB_REQUIRED：用法：thresholds.mjs --db=<product.sqlite> [--owner=<id> --agent=<id>] [--days=N [--end=YYYY-MM-DD]] [--miss-cost=比值,比值]",
    );
  if (options.has("end") && !options.has("days"))
    throw new TypeError("THRESHOLD_WINDOW：--end 要和 --days 一起给；都不给时统计全部记录。");
  return options;
}

function parseRatios(value) {
  if (value === undefined) return DEFAULT_MISS_COST_RATIOS;
  const ratios = value.split(",").map((item) => Number(item.trim()));
  if (ratios.length === 0 || ratios.some((ratio) => !(Number.isFinite(ratio) && ratio > 0)))
    throw new RangeError(
      "THRESHOLD_MISS_COST：--miss-cost 要写正数，多个用逗号隔开，例如 --miss-cost=1,3",
    );
  return [...new Set(ratios)];
}

export function run(argv, { now = new Date(), output = process.stdout } = {}) {
  const options = parseArguments(argv);
  const missCostRatios = parseRatios(options.get("miss-cost"));
  const window = options.has("days")
    ? resolveWindow({ end: options.get("end"), days: Number(options.get("days")), now })
    : null;
  const range = window ?? ALL_TIME;
  const database = new Database(path.resolve(options.get("db")), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    if (options.has("owner") !== options.has("agent"))
      throw new TypeError("THRESHOLD_SCOPE：--owner 和 --agent 要一起给，或者都不给。");
    let scope;
    if (options.has("owner"))
      scope = { ownerId: options.get("owner"), agentId: options.get("agent") };
    else {
      const scopes = findScopes(database);
      if (scopes.length !== 1)
        throw new Error(
          `THRESHOLD_SCOPE：数据库里有 ${scopes.length} 个所有者和智能体组合，请用 --owner 和 --agent 指定。${scopes.map((s) => `${s.ownerId}/${s.agentId}`).join("、")}`,
        );
      scope = scopes[0];
    }
    const read = database.transaction(() => {
      assertTimestampFormat(database);
      const parameters = [scope.ownerId, scope.agentId, range.start, range.end];
      return {
        rows: database.prepare(THRESHOLD_SQL.rows).all(...parameters),
        counts: database.prepare(THRESHOLD_SQL.kindCounts).all(...parameters),
      };
    })();
    const required = requiredSamples(DEFAULT_INTERVAL_WIDTH_LIMIT);
    const analyses = THRESHOLD_GATES.map((gate) =>
      analyzeGate(gate, read.rows, { required, missCostRatios }),
    );
    const ungated = ungatedKinds(
      read.counts.map((entry) => ({
        kind: entry.kind,
        total: entry.total,
        rated: entry.rated ?? 0,
      })),
    );
    output.write(
      `${thresholdReport({ window, scope, analyses, ungated, required, widthLimit: DEFAULT_INTERVAL_WIDTH_LIMIT })}\n`,
    );
    return { required, analyses, ungated };
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
