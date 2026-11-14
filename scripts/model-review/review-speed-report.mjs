#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const MEDIUM_HIGH = new Set(["medium-high", "medium", "high"]);

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
  const rows = readJsonLines(join(reviewsDir, `pr-${pr}`, `round-${round}`, "verdicts.jsonl"));
  return rows.filter(
    (row) => row.valid === true && row.class === "error" && MEDIUM_HIGH.has(row.severity),
  ).length;
}

export function loadRounds(reviewsDir) {
  if (!existsSync(reviewsDir)) return [];
  const rounds = new Map();
  const spend = new Map();
  for (const entry of readdirSync(reviewsDir)) {
    const match = /^pr-(\d+)$/.exec(entry);
    if (!match) continue;
    const pr = Number(match[1]);
    const records = readJsonLines(join(reviewsDir, entry, "usage.jsonl")).filter(
      (record) => record.mode === "code-review",
    );
    for (const record of records) {
      spend.set(pr, (spend.get(pr) ?? 0) + (Number(record.cost) || 0));
      if (record.outcome !== "ok") continue;
      const key = `${pr}\0${record.round}\0${record.model}`;
      const earlier = rounds.get(key);
      if (!earlier || record.at > earlier.at) rounds.set(key, { pr, ...record });
    }
  }
  const sorted = [...rounds.values()].sort((a, b) => a.at.localeCompare(b.at));
  const lastAt = new Map();
  for (const round of sorted) {
    const before = lastAt.get(round.pr);
    round.sincePreviousMs = before === undefined ? null : Date.parse(round.at) - before;
    lastAt.set(round.pr, Date.parse(round.at));
    round.mediumHigh = mediumHighCount(reviewsDir, round.pr, round.round);
    round.prSpend = spend.get(round.pr) ?? 0;
  }
  return sorted;
}

function cohortStats(rounds, label) {
  const byPr = new Map();
  for (const round of rounds) byPr.set(round.pr, [...(byPr.get(round.pr) ?? []), round]);
  const incremental = rounds.filter((round) => round.previous);
  const full = rounds.filter((round) => !round.previous);
  const input = sum(rounds.map((round) => round.input));
  const cacheRead = sum(rounds.map((round) => round.cacheRead));
  const turnaround = rounds
    .filter((round) => round.sincePreviousMs !== null && round.sincePreviousMs < 6 * 3600_000)
    .map((round) => round.sincePreviousMs / 60_000);
  const runSeconds = rounds
    .filter((round) => Number.isFinite(round.runMs))
    .map((r) => r.runMs / 1000);
  const checked = rounds.filter((round) => round.selfCheckMs !== undefined);
  const labelled = rounds.filter((round) => round.selfCheckCache !== undefined);
  const hits = labelled.filter((round) => round.selfCheckCache === "hit").length;
  return {
    label,
    prs: byPr.size,
    rounds: rounds.length,
    roundsPerPr: byPr.size ? rounds.length / byPr.size : null,
    stepsFull: median(full.map((round) => round.steps)),
    stepsIncremental: median(incremental.map((round) => round.steps)),
    costFull: median(full.map((round) => round.cost)),
    costIncremental: median(incremental.map((round) => round.cost)),
    costPerPr: median([...byPr.values()].map((list) => sum(list.map((round) => round.cost)))),
    inputPerRound: median(rounds.map((round) => round.input)),
    cacheHitRate: input + cacheRead > 0 ? cacheRead / (input + cacheRead) : null,
    turnaroundMin: median(turnaround),
    runSeconds: median(runSeconds),
    mediumHighPerRound: rounds.length
      ? sum(rounds.map((round) => round.mediumHigh)) / rounds.length
      : null,
    selfCheckSeconds: median(checked.map((round) => round.selfCheckMs / 1000)),
    selfCheckHitRate: labelled.length ? hits / labelled.length : null,
  };
}

export function compare(rounds, cutIso) {
  const before = rounds.filter((round) => round.at < cutIso);
  const after = rounds.filter((round) => round.at >= cutIso);
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
    ["复核轮数", (s) => s.rounds, 0],
    ["每个 PR 平均轮数", (s) => s.roundsPerPr, 2],
    ["全量轮 步数中位", (s) => s.stepsFull, 0],
    ["增量轮 步数中位", (s) => s.stepsIncremental, 0],
    ["全量轮 费用中位（美元）", (s) => s.costFull, 3],
    ["增量轮 费用中位（美元）", (s) => s.costIncremental, 3],
    ["每个 PR 复核费用中位（美元）", (s) => s.costPerPr, 3],
    ["每轮输入 token 中位", (s) => s.inputPerRound, 0],
    ["缓存命中率（缓存读 /（输入 + 缓存读））", (s) => s.cacheHitRate, 3],
    ["从上一轮到这一轮的间隔中位（分钟，不含超过 6 小时的）", (s) => s.turnaroundMin, 1],
    ["DeepSeek 一次运行时长中位（秒，只有新记录有）", (s) => s.runSeconds, 0],
    ["每轮成立的中高意见数（平均）", (s) => s.mediumHighPerRound, 2],
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
          return round[column] ?? "";
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
  const rounds = loadRounds(reviewsDir);
  if (args.includes("--csv")) {
    process.stdout.write(renderCsv(cut ? rounds.filter((round) => round.at < cut) : rounds));
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
