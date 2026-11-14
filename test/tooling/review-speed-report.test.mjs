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
            round: 3,
            at: "2026-11-14T16:00:00.000Z",
            previous: "abd",
            outcome: "failed",
          }),
          record({ mode: "low-fix", round: 4, at: "2026-11-14T16:10:00.000Z" }),
        ],
        {
          2: [
            { valid: true, class: "error", severity: "high" },
            { valid: true, class: "error", severity: "low" },
            { valid: false, class: "error", severity: "high" },
          ],
        },
      ],
    ]);
    try {
      const rounds = loadRounds(dir);
      expect(rounds.map((r) => r.round)).toEqual([1, 2]);
      expect(rounds[1].sincePreviousMs).toBe(30 * 60_000);
      expect(rounds[1].mediumHigh).toBe(1);
      expect(rounds[1].prSpend).toBeCloseTo(0.1 + 0.05 + 0.1);
      const [before, after] = compare(rounds, "2026-11-14T10:15:00.000Z");
      expect(before.rounds).toBe(1);
      expect(after.rounds).toBe(1);
      expect(after.costIncremental).toBe(0.05);
      expect(before.costFull).toBe(0.1);
      expect(before.cacheHitRate).toBe(0.75);
      expect(renderTable([before, after])).toContain("| 复核轮数 | 1 | 1 |");
      expect(renderCsv(rounds).split("\n")[0]).toContain("sincePreviousMs,mediumHigh");
      expect(renderCsv(rounds).split("\n")).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns nothing for a missing directory", () => {
    expect(loadRounds(join(tmpdir(), "no-such-reviews-dir"))).toEqual([]);
  });
});
