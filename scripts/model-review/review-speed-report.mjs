#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MEDIUM_HIGH = new Set(["medium-high"]);

function readJsonLines(path) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {}
  }
  return rows;
}

export function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const sum = (values) => values.reduce((total, value) => total + (Number(value) || 0), 0);

export function mediumHighCount(reviewsDir, pr, round) {
  const file = join(reviewsDir, `pr-${pr}`, `round-${round}`, "verdicts.jsonl");
  if (!existsSync(file)) return null;
  const rows = readJsonLines(file);
  return rows.filter(
    (row) => row.valid === true && row.class === "error" && MEDIUM_HIGH.has(row.severity),
  ).length;
}

const hasTime = (record) => typeof record.at === "string" && Number.isFinite(Date.parse(record.at));

function roundGroups(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.pr}\0${row.round}`;
    const group = groups.get(key);
    const end = Date.parse(row.at);
    if (group) {
      group.end = Math.max(group.end, end);
      group.rows.push(row);
    } else groups.set(key, { pr: row.pr, round: row.round, end, rows: [row] });
  }
  return [...groups.values()].sort((a, b) => a.end - b.end);
}

function intervals(rows) {
  const lastEnd = new Map();
  const result = [];
  for (const group of roundGroups(rows)) {
    const before = lastEnd.get(group.pr);
    result.push({ group, sincePreviousMs: before === undefined ? null : group.end - before });
    lastEnd.set(group.pr, group.end);
  }
  return result;
}

export function loadRounds(reviewsDir) {
  if (!existsSync(reviewsDir)) return [];
  const rounds = new Map();
  const retry = new Map();
  for (const entry of readdirSync(reviewsDir)) {
    const match = /^pr-(\d+)$/.exec(entry);
    if (!match) continue;
    const pr = Number(match[1]);
    const records = readJsonLines(join(reviewsDir, entry, "usage.jsonl")).filter(
      (record) => record.mode === "code-review",
    );
    for (const record of records) {
      if (!hasTime(record)) continue;
      if (record.outcome !== "ok") {
        const retryKey = `${pr}\0${record.round}`;
        retry.set(retryKey, (retry.get(retryKey) ?? 0) + (Number(record.cost) || 0));
        continue;
      }
      const key = `${pr}\0${record.round}\0${record.model}`;
      const earlier = rounds.get(key);
      if (!earlier || record.at > earlier.at) rounds.set(key, { pr, ...record });
    }
  }
  const sorted = [...rounds.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const { group, sincePreviousMs } of intervals(sorted)) {
    const mediumHigh = mediumHighCount(reviewsDir, group.pr, group.round);
    const retryCost = retry.get(`${group.pr}\0${group.round}`) ?? 0;
    group.rows.forEach((round, index) => {
      round.sincePreviousMs = sincePreviousMs;
      round.mediumHigh = mediumHigh;
      round.retryCost = index === 0 ? retryCost : 0;
    });
  }
  return sorted;
}

function cohortStats(rounds, label) {
  const byPr = new Map();
  for (const round of rounds) byPr.set(round.pr, [...(byPr.get(round.pr) ?? []), round]);
  const groups = roundGroups(rounds);
  const distinctPerPr = new Map();
  for (const group of groups) distinctPerPr.set(group.pr, (distinctPerPr.get(group.pr) ?? 0) + 1);
  const incremental = rounds.filter((round) => round.previous);
  const full = rounds.filter((round) => !round.previous);
  const input = sum(rounds.map((round) => round.input));
  const cacheRead = sum(rounds.map((round) => round.cacheRead));
  const turnaround = intervals(rounds)
    .filter(({ sincePreviousMs }) => sincePreviousMs !== null && sincePreviousMs < 6 * 3600_000)
    .map(({ sincePreviousMs }) => sincePreviousMs / 60_000);
  const judged = groups
    .map((group) => group.rows[0].mediumHigh)
    .filter((count) => Number.isFinite(count));
  const runSeconds = rounds
    .filter((round) => Number.isFinite(round.runMs))
    .map((r) => r.runMs / 1000);
  const checked = rounds.filter((round) => round.selfCheckMs !== undefined);
  const labelled = rounds.filter((round) => round.selfCheckCache !== undefined);
  const hits = labelled.filter((round) => round.selfCheckCache === "hit").length;
  return {
    label,
    prs: byPr.size,
    modelRuns: rounds.length,
    rounds: groups.length,
    roundsPerPr: byPr.size ? groups.length / byPr.size : null,
    stepsFull: median(full.map((round) => round.steps)),
    stepsIncremental: median(incremental.map((round) => round.steps)),
    costFull: median(full.map((round) => round.cost)),
    costIncremental: median(incremental.map((round) => round.cost)),
    costPerPr: median(
      [...byPr.values()].map((list) =>
        sum(list.map((round) => (Number(round.cost) || 0) + round.retryCost)),
      ),
    ),
    inputPerRound: median(rounds.map((round) => round.input)),
    cacheHitRate: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : null,
    turnaroundMin: median(turnaround),
    runSeconds: median(runSeconds),
    mediumHighPerRound: judged.length ? sum(judged) / judged.length : null,
    roundsWithoutVerdicts: groups.length - judged.length,
    selfCheckSeconds: median(checked.map((round) => round.selfCheckMs / 1000)),
    selfCheckHitRate: labelled.length ? hits / labelled.length : null,
  };
}

export function compare(rounds, cutIso) {
  const cutMs = Date.parse(cutIso);
  if (!Number.isFinite(cutMs)) throw new Error(`REVIEW_SPEED_REPORT_INVALID_CUT ${cutIso}`);
  const before = rounds.filter((round) => Date.parse(round.at) < cutMs);
  const after = rounds.filter((round) => Date.parse(round.at) >= cutMs);
  return [
    cohortStats(before, `优化前（${cutIso} 之前）`),
    cohortStats(after, `优化后（${cutIso} 起）`),
  ];
}

const fmt = (value, digits = 1) =>
  value === null || value === undefined ? "-" : Number(value).toFixed(digits);

export function renderTable(stats) {
  const rows = [
    ["复核过的 PR 数", (s) => s.prs, 0],
    ["复核轮数（同一轮多个模型只算一轮）", (s) => s.rounds, 0],
    ["模型运行次数", (s) => s.modelRuns, 0],
    ["每个 PR 平均轮数", (s) => s.roundsPerPr, 2],
    ["全量轮 步数中位", (s) => s.stepsFull, 0],
    ["增量轮 步数中位", (s) => s.stepsIncremental, 0],
    ["全量轮 费用中位（美元）", (s) => s.costFull, 3],
    ["增量轮 费用中位（美元）", (s) => s.costIncremental, 3],
    ["每个 PR 复核费用中位（美元，含失败重试）", (s) => s.costPerPr, 3],
    ["每轮输入 token 中位", (s) => s.inputPerRound, 0],
    ["缓存命中率（缓存读 /（输入 + 缓存读））", (s) => s.cacheHitRate, 3],
    ["从上一轮到这一轮的间隔中位（分钟，不含超过 6 小时的）", (s) => s.turnaroundMin, 1],
    ["一次模型运行时长中位（秒，只有新记录有）", (s) => s.runSeconds, 0],
    ["每轮成立的中高意见数（平均，没有 verdicts.jsonl 的轮不算）", (s) => s.mediumHighPerRound, 2],
    ["没有 verdicts.jsonl 的轮数", (s) => s.roundsWithoutVerdicts, 0],
    ["自检耗时中位（秒，只有新记录有）", (s) => s.selfCheckSeconds, 0],
    ["自检缓存命中比例（只有新记录有）", (s) => s.selfCheckHitRate, 2],
  ];
  const header = `| 指标 | ${stats.map((s) => s.label).join(" | ")} |`;
  const divider = `| --- | ${stats.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    ([name, pick, digits]) => `| ${name} | ${stats.map((s) => fmt(pick(s), digits)).join(" | ")} |`,
  );
  return [header, divider, ...body].join("\n");
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function renderCsv(rounds) {
  const columns = [
    "pr",
    "round",
    "at",
    "model",
    "incremental",
    "steps",
    "input",
    "output",
    "reasoning",
    "cacheRead",
    "cacheWrite",
    "cost",
    "runMs",
    "selfCheckMs",
    "selfCheckCache",
    "sincePreviousMs",
    "mediumHigh",
  ];
  const lines = [columns.join(",")];
  for (const round of rounds) {
    lines.push(
      columns
        .map((column) => {
          if (column === "incremental") return round.previous ? 1 : 0;
          return csvCell(round[column]);
        })
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const option = (name) => {
    const at = args.indexOf(name);
    return at === -1 ? null : args[at + 1];
  };
  const reviewsDir = option("--reviews-dir") ?? ".agents/reviews";
  const cut = option("--cut");
  if (cut !== null && !Number.isFinite(Date.parse(cut))) {
    console.error(`REVIEW_SPEED_REPORT_INVALID_CUT ${cut}`);
    process.exitCode = 2;
    return;
  }
  const rounds = loadRounds(reviewsDir);
  if (args.includes("--csv")) {
    const cutMs = cut ? Date.parse(cut) : null;
    process.stdout.write(
      renderCsv(cutMs === null ? rounds : rounds.filter((round) => Date.parse(round.at) < cutMs)),
    );
    return;
  }
  if (!cut) {
    console.error("REVIEW_SPEED_REPORT needs --cut <ISO time> (or --csv)");
    process.exitCode = 2;
    return;
  }
  console.log(renderTable(compare(rounds, cut)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
