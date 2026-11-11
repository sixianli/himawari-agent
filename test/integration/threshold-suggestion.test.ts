import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  MEMORY_AUTO_COMMIT_GATE,
  requiredSamples,
  wilsonInterval,
  worstCaseIntervalWidth,
} from "../../scripts/calibration-report/calibration.mjs";
import { parseArguments, run } from "../../scripts/calibration-report/thresholds.mjs";

const NOW = new Date("2026-11-11T03:00:00.000Z");
const AT = "2026-11-05T03:00:00.000Z";

interface Row {
  readonly outcome: "kept" | "discarded";
  readonly reason: string;
  readonly score: number | null;
  readonly rating: "useful" | "unneeded" | "missed" | null;
  readonly category?: string;
}

describe("[P4-4] threshold suggestion", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "himawari-thresholds-"));
    directories.push(root);
    const databasePath = path.join(root, "product.sqlite");
    const database = openQualifiedDatabase(databasePath);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES ('o', 0)").run();
    database.prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('a', 'o', 0)").run();
    return { databasePath, database };
  }

  let counter = 0;
  function addMemory(database: Database.Database, row: Row, id = `m${++counter}`) {
    database
      .prepare(
        `INSERT INTO decision_ledger (
          id, owner_id, agent_id, kind, checked_at, counts, outcome, reason_code, inputs,
          cost_micros, duration_ms, owner_rating, rated_at, category, confidence_permille
        ) VALUES (?, 'o', 'a', 'memory_candidate', ?, '{}', ?, ?, '{}', 0, 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        AT,
        row.outcome,
        row.reason,
        row.rating,
        row.rating === null ? null : AT,
        row.category ?? "preference",
        row.score,
      );
    return id;
  }

  function addOther(
    database: Database.Database,
    kind: string,
    outcome: string,
    rating: string | null,
  ) {
    counter += 1;
    database
      .prepare(
        `INSERT INTO decision_ledger (
          id, owner_id, agent_id, kind, checked_at, counts, outcome, reason_code, inputs,
          cost_micros, duration_ms, owner_rating, rated_at
        ) VALUES (?, 'o', 'a', ?, ?, '{}', ?, 'fixture', '{}', 0, 0, ?, ?)`,
      )
      .run(`x${counter}`, kind, AT, outcome, rating, rating === null ? null : AT);
  }

  function kept(score: number, rating: Row["rating"]): Row {
    return {
      outcome: "kept",
      reason: score >= 850 ? "auto_committed" : "kept_tentative",
      score,
      rating,
    };
  }
  function dropped(score: number, rating: Row["rating"]): Row {
    return { outcome: "discarded", reason: "confidence_below_threshold", score, rating };
  }

  function capture() {
    let text = "";
    return {
      output: {
        write(chunk: string) {
          text += chunk;
        },
      },
      text: () => text,
    };
  }

  it("derives N from the 10-point interval width and nothing smaller satisfies it", () => {
    const n = requiredSamples();
    expect(worstCaseIntervalWidth(n)).toBeLessThanOrEqual(0.1);
    expect(worstCaseIntervalWidth(n - 1)).toBeGreaterThan(0.1);
    const interval = wilsonInterval(Math.floor(n / 2), n);
    expect(interval).not.toBeNull();
    expect((interval?.high ?? 1) - (interval?.low ?? 0)).toBeLessThanOrEqual(0.1);
    expect(n).toBeGreaterThan(300);
    expect(n).toBeLessThan(400);
    expect(requiredSamples(0.2)).toBeLessThan(n);
  });

  it("refuses to give a number when rated samples are fewer than N", async () => {
    const { databasePath, database } = await fixture();
    for (let index = 0; index < 20; index += 1) addMemory(database, kept(900, "unneeded"));
    database.close();
    const sink = capture();
    const result = run([`--db=${databasePath}`], { now: NOW, output: sink.output });
    const overall = result.analyses[0]?.overall;
    expect(overall?.enough).toBe(false);
    expect(overall?.suggestions).toEqual([]);
    expect(sink.text()).toContain(
      `样本不足：已评价并由门槛决定的有 20 条，需要至少 ${result.required} 条，不给建议值。`,
    );
    expect(sink.text()).not.toContain("建议门槛");
  });

  it("draws the trade-off curve, suggests per cost ratio and replays past decisions", async () => {
    const { databasePath, database } = await fixture();
    const n = requiredSamples();
    const ids = {
      unneededAuto: [] as string[],
      usefulAuto: [] as string[],
      missedLow: [] as string[],
    };
    const highNoise = 100;
    for (let index = 0; index < highNoise; index += 1)
      ids.unneededAuto.push(addMemory(database, kept(860, "unneeded")));
    for (let index = 0; index < 10; index += 1)
      ids.usefulAuto.push(addMemory(database, kept(880, "useful")));
    for (let index = 0; index < 40; index += 1)
      ids.missedLow.push(addMemory(database, dropped(700, "missed")));
    const filler = n - highNoise - 10 - 40;
    for (let index = 0; index < filler; index += 1) addMemory(database, dropped(300, "useful"));
    addMemory(database, kept(950, null));
    addMemory(database, {
      outcome: "kept",
      reason: "explicitly_approved",
      score: 100,
      rating: "useful",
    });
    addMemory(database, {
      outcome: "kept",
      reason: "auto_committed",
      score: null,
      rating: "useful",
    });
    addMemory(database, kept(900, "missed"));
    addOther(database, "consolidation", "merge", "useful");
    addOther(database, "external_read", "read", null);
    database.close();

    const sink = capture();
    const result = run([`--db=${databasePath}`], { now: NOW, output: sink.output });
    const analysis = result.analyses[0];
    expect(analysis?.gate.key).toBe(MEMORY_AUTO_COMMIT_GATE.key);
    expect(analysis?.unrated).toBe(1);
    expect(analysis?.notGated).toBe(1);
    expect(analysis?.missingScore).toBe(1);
    expect(analysis?.mismatchedRating).toBe(1);
    const overall = analysis?.overall;
    expect(overall?.samples).toBe(n);
    expect(overall?.enough).toBe(true);
    expect(overall?.currentPoint).toMatchObject({ threshold: 850, disturbances: 100, misses: 40 });
    const at = (threshold: number) => overall?.curve.find((point) => point.threshold === threshold);
    expect(at(700)).toMatchObject({ disturbances: 100, misses: 0 });
    expect(at(880)).toMatchObject({ disturbances: 0, misses: 40 });
    expect(at(1001)).toMatchObject({ disturbances: 0, misses: 50 });
    expect(at(0)).toMatchObject({ disturbances: 100 + filler, misses: 0 });
    for (const point of overall?.curve ?? []) {
      const width = (point.disturbanceRate.high ?? 1) - (point.disturbanceRate.low ?? 0);
      expect(width).toBeLessThanOrEqual(0.1);
    }

    const byRatio = new Map(overall?.suggestions.map((item) => [item.missCostRatio, item]));
    expect(byRatio.get(1)?.threshold).toBe(861);
    expect(byRatio.get(2)?.threshold).toBe(861);
    expect(byRatio.get(5)?.threshold).toBe(700);
    const strict = byRatio.get(1);
    expect(
      strict?.flips
        .filter((flip) => flip.change === "unneededBlocked")
        .map((flip) => flip.id)
        .sort(),
    ).toEqual([...ids.unneededAuto].sort());
    expect(strict?.flips.some((flip) => flip.change === "usefulSilenced")).toBe(false);
    const loose = byRatio.get(5);
    expect(
      loose?.flips
        .filter((flip) => flip.change === "missedCaught")
        .map((flip) => flip.id)
        .sort(),
    ).toEqual([...ids.missedLow].sort());
    expect(loose?.flips.every((flip) => flip.correctAfter)).toBe(true);

    const text = sink.text();
    expect(text).toContain("**漏一条按多扰 1、2 次算：建议门槛 861**（现在 850）");
    expect(text).toContain("**漏一条按多扰 5 次算：建议门槛 700**（现在 850）");
    expect(text).toContain("已评「不需要」的会被挡住（100 条）");
    expect(text).toContain("已评「漏了」的会被补上（40 条）");
    expect(text).toContain("这里只给建议，不会改任何门槛。");
    expect(result.ungated.map((entry) => entry.kind)).toEqual(["consolidation", "external_read"]);
    expect(text).toContain(
      "- external_read：共 1 条，已评价 0 条。这类决策没有记录分数，画不出门槛曲线。",
    );
  });

  it("lists useful decisions that a stricter threshold would silence", async () => {
    const { databasePath, database } = await fixture();
    const n = requiredSamples();
    const silenced = addMemory(database, kept(860, "useful"));
    for (let index = 0; index < 60; index += 1) addMemory(database, kept(860, "unneeded"));
    for (let index = 0; index < n - 61; index += 1) addMemory(database, dropped(200, "useful"));
    database.close();
    const sink = capture();
    const result = run([`--db=${databasePath}`, "--miss-cost=1"], {
      now: NOW,
      output: sink.output,
    });
    const suggestion = result.analyses[0]?.overall.suggestions[0];
    expect(suggestion?.threshold).toBe(861);
    expect(suggestion?.flips.find((flip) => flip.id === silenced)?.change).toBe("usefulSilenced");
    expect(sink.text()).toContain(`已评「有用」的会变成沉默（1 条）：${silenced}（分数 860）`);
  });

  it("runs as a plain node program", async () => {
    const { databasePath, database } = await fixture();
    addMemory(database, kept(900, "useful"));
    database.close();
    const { stdout } = await promisify(execFile)(process.execPath, [
      path.resolve("scripts/calibration-report/thresholds.mjs"),
      `--db=${databasePath}`,
    ]);
    expect(stdout).toContain("# 门槛建议值");
    expect(stdout).toContain("样本不足：已评价并由门槛决定的有 1 条");
  });

  it("keeps the live auto-commit threshold in one place", () => {
    expect(MEMORY_AUTO_COMMIT_GATE.defaultThreshold).toBe(850);
    expect(MEMORY_AUTO_COMMIT_GATE.decisionKind).toBe("memory_candidate");
  });

  it("rejects bad arguments", () => {
    expect(() => parseArguments([])).toThrow("THRESHOLD_DB_REQUIRED");
    expect(() => parseArguments(["--db=x", "--end=2026-11-01"])).toThrow("THRESHOLD_WINDOW");
    expect(() => parseArguments(["--db=x", "--nope"])).toThrow("THRESHOLD_UNKNOWN_OPTION");
  });
});
