import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compare,
  loadRounds,
  median,
  renderCsv,
  renderTable,
} from "../../scripts/model-review/review-speed-report.mjs";

function ledger(entries) {
  const dir = mkdtempSync(join(tmpdir(), "speed-report-"));
  for (const [pr, records, verdicts] of entries) {
    const prDir = join(dir, `pr-${pr}`);
    mkdirSync(prDir, { recursive: true });
    writeFileSync(join(prDir, "usage.jsonl"), records.map((r) => JSON.stringify(r)).join("\n"));
    for (const [round, rows] of Object.entries(verdicts ?? {})) {
      mkdirSync(join(prDir, `round-${round}`), { recursive: true });
      writeFileSync(
        join(prDir, `round-${round}`, "verdicts.jsonl"),
        rows.map((r) => JSON.stringify(r)).join("\n"),
      );
    }
  }
  return dir;
}

const record = (over) => ({
  mode: "code-review",
  model: "m",
  outcome: "ok",
  round: 1,
  at: "2026-11-14T10:00:00.000Z",
  steps: 30,
  input: 100,
  cacheRead: 300,
  cost: 0.1,
  ...over,
});

describe("review speed report", () => {
  it("takes medians of finite values only", () => {
    expect(median([3, 1, Number.NaN, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("builds per-round rows and splits cohorts at the cut", () => {
    const dir = ledger([
      [
        1,
        [
          record({ round: 1, at: "2026-11-14T10:00:00.000Z" }),
          record({
            round: 2,
            at: "2026-11-14T10:30:00.000Z",
            previous: "abc",
            cost: 0.05,
          }),
          record({
            round: 2,
            at: "2026-11-14T10:25:00.000Z",
            previous: "abc",
            outcome: "failed",
          }),
          record({ mode: "low-fix", round: 4, at: "2026-11-14T16:10:00.000Z" }),
        ],
        {
          2: [
            { valid: true, class: "error", severity: "medium-high" },
            { valid: true, class: "error", severity: "low" },
            { valid: false, class: "error", severity: "medium-high" },
          ],
        },
      ],
    ]);
    try {
      const rounds = loadRounds(dir);
      expect(rounds.map((r) => r.round)).toEqual([1, 2]);
      expect(rounds[1].sincePreviousMs).toBe(30 * 60_000);
      expect(rounds[1].mediumHigh).toBe(1);
      expect(rounds[1].retryCost).toBeCloseTo(0.1);
      expect(rounds[0].mediumHigh).toBeNull();
      const [before, after] = compare(rounds, "2026-11-14T10:15:00.000Z");
      expect(before.rounds).toBe(1);
      expect(after.rounds).toBe(1);
      expect(after.costIncremental).toBe(0.05);
      expect(before.costFull).toBe(0.1);
      expect(before.cacheHitRate).toBe(0.75);
      expect(renderTable([before, after])).toContain(
        "| 复核轮数（同一轮多个模型只算一轮） | 1 | 1 |",
      );
      expect(renderCsv(rounds).split("\n")[0]).toContain("sincePreviousMs,mediumHigh");
      expect(renderCsv(rounds).split("\n")).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts a round once when several models ran it, and counts failed retries in cost", () => {
    const dir = ledger([
      [
        7,
        [
          record({ model: "a", round: 1, at: "2026-11-14T10:00:00.000Z" }),
          record({ model: "b", round: 1, at: "2026-11-14T10:00:09.000Z" }),
          record({ model: "a", round: 2, at: "2026-11-14T10:40:00.000Z", previous: "x" }),
          record({ model: "a", round: 2, at: "2026-11-14T10:30:00.000Z", outcome: "failed" }),
        ],
        { 1: [{ valid: true, class: "error", severity: "medium-high" }], 2: [] },
      ],
    ]);
    try {
      const rounds = loadRounds(dir);
      expect(rounds).toHaveLength(3);
      const [stats] = compare(rounds, "2026-11-15T00:00:00.000Z");
      expect(stats.rounds).toBe(2);
      expect(stats.modelRuns).toBe(3);
      expect(stats.roundsPerPr).toBe(2);
      expect(stats.mediumHighPerRound).toBe(0.5);
      expect(stats.turnaroundMin).toBeCloseTo((40 * 60 - 9) / 60);
      expect(stats.costPerPr).toBeCloseTo(0.4);
      const [before, after] = compare(rounds, "2026-11-14T10:20:00.000Z");
      expect(before.turnaroundMin).toBeNull();
      expect(after.turnaroundMin).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count rounds without verdicts.jsonl as having no findings", () => {
    const dir = ledger([[8, [record({ round: 1 })], undefined]]);
    try {
      const [stats] = compare(loadRounds(dir), "2026-12-01T00:00:00.000Z");
      expect(stats.mediumHighPerRound).toBeNull();
      expect(stats.roundsWithoutVerdicts).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a cut that is not a time, and compares by time not by text", () => {
    expect(() => compare([], "soon")).toThrow("REVIEW_SPEED_REPORT_INVALID_CUT");
    const dir = ledger([[9, [record({ round: 1, at: "2026-11-14T10:00:00.000Z" })]]]);
    try {
      const [before, after] = compare(loadRounds(dir), "2026-11-14");
      expect(before.rounds).toBe(0);
      expect(after.rounds).toBe(1);
      const [before2] = compare(loadRounds(dir), "2026-11-14T20:00:00+09:00");
      expect(before2.rounds).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips records without a usable time and escapes csv cells", () => {
    const dir = ledger([
      [10, [record({ round: 1, at: undefined }), record({ round: 2, model: '=x,"y"' })]],
    ]);
    try {
      const rounds = loadRounds(dir);
      expect(rounds.map((r) => r.round)).toEqual([2]);
      expect(renderCsv(rounds).split("\n")[1]).toContain('"\'=x,""y"""');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns nothing for a missing directory", () => {
    expect(loadRounds(join(tmpdir(), "no-such-reviews-dir"))).toEqual([]);
  });
});
