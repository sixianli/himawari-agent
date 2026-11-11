import { describe, expect, it } from "vitest";
import type { CalibrationGroup, CalibrationRating } from "../src/index.js";
import {
  acceptsPrereview,
  historyConflict,
  minimumAgreementToPass,
  minimumPairsToPass,
  type PrereviewPair,
  type PrereviewWeekRow,
  type PrereviewRating,
  prereviewGate,
  summarizePrereviewAgreement,
  summarizePrereviewWeek,
  wouldHide,
} from "../src/prereview.js";
import { proportion } from "../src/index.js";

const options = { agreementPermille: 900, confidencePermille: 800 };

function pairs(
  group: CalibrationGroup,
  count: number,
  model: PrereviewRating,
  owner: CalibrationRating | null,
  confidencePermille = 950,
): PrereviewPair[] {
  return Array.from({ length: count }, () => ({
    group,
    model,
    confidencePermille,
    historyConflict: false,
    owner,
  }));
}

function groupOf(rows: readonly PrereviewPair[], group: CalibrationGroup) {
  const found = summarizePrereviewAgreement(rows, options).find((entry) => entry.group === group);
  if (found === undefined) throw new Error(group);
  return found;
}

describe("model prereview agreement", () => {
  it("accepts only the ratings that apply to the group plus unsure", () => {
    expect(acceptsPrereview("proactive_silent", "missed")).toBe(true);
    expect(acceptsPrereview("proactive_silent", "unneeded")).toBe(false);
    expect(acceptsPrereview("memory_kept", "missed")).toBe(false);
    expect(acceptsPrereview("memory_kept", "unsure")).toBe(true);
  });

  it("needs at least 35 straight agreements before a 90% lower bound can pass", () => {
    expect(minimumAgreementToPass(30, 900)).toBeNull();
    expect(minimumAgreementToPass(35, 900)).toBe(1);
    const at100 = minimumAgreementToPass(100, 900);
    expect(at100).not.toBeNull();
    expect(at100 as number).toBeGreaterThan(0.94);
  });

  it("reports agreement, kappa and balanced accuracy on the applicable pair only", () => {
    const rows = [
      ...pairs("memory_kept", 40, "useful", "useful"),
      ...pairs("memory_kept", 8, "unneeded", "unneeded"),
      ...pairs("memory_kept", 2, "useful", "unneeded"),
      ...pairs("memory_kept", 5, "unsure", "useful", 0),
      ...pairs("memory_kept", 3, "useful", null),
    ];
    const summary = groupOf(rows, "memory_kept");
    expect(summary.prereviewed).toBe(58);
    expect(summary.unsure).toBe(5);
    expect(summary.paired).toBe(50);
    expect(summary.agreement.successes).toBe(48);
    expect(summary.balancedAccuracy).toBeCloseTo((1 + 0.8) / 2, 6);
    expect(summary.kappa).not.toBeNull();
    expect(summary.kappa as number).toBeGreaterThan(0.8);
    expect(
      summary.confusion.find((cell) => cell.model === "useful" && cell.owner === "unneeded")?.count,
    ).toBe(2);
  });

  it("opens the gate when the hidden part beats both 90% and the owner's own useful share", () => {
    const rows = [
      ...pairs("consolidation", 200, "useful", "useful"),
      ...pairs("consolidation", 100, "unneeded", "unneeded"),
    ];
    expect(groupOf(rows, "consolidation").gate).toMatchObject({ open: true, reason: "open" });
  });

  it("keeps the gate shut for a model that always says useful, even at 95% agreement", () => {
    const rows = [
      ...pairs("memory_kept", 190, "useful", "useful"),
      ...pairs("memory_kept", 10, "useful", "unneeded"),
    ];
    const summary = groupOf(rows, "memory_kept");
    expect(summary.agreement.value).toBeCloseTo(0.95, 6);
    expect(summary.gate).toMatchObject({ open: false, reason: "not_above_baseline" });
  });

  it("keeps the gate shut below the threshold and with too few pairs", () => {
    const below = [
      ...pairs("memory_skipped", 85, "useful", "useful"),
      ...pairs("memory_skipped", 15, "useful", "missed"),
      ...pairs("memory_skipped", 100, "missed", "missed"),
    ];
    expect(groupOf(below, "memory_skipped").gate.reason).toBe("below_threshold");
    const few = [
      ...pairs("memory_skipped", 20, "useful", "useful"),
      ...pairs("memory_skipped", 20, "missed", "missed"),
    ];
    expect(groupOf(few, "memory_skipped").gate).toMatchObject({
      open: false,
      reason: "insufficient",
    });
    expect(groupOf([], "memory_skipped").gate.reason).toBe("insufficient");
  });

  it("only counts confident, history-consistent useful verdicts as the part that would be hidden", () => {
    expect(
      wouldHide({ model: "useful", confidencePermille: 800, historyConflict: false }, 800),
    ).toBe(true);
    expect(
      wouldHide({ model: "useful", confidencePermille: 799, historyConflict: false }, 800),
    ).toBe(false);
    expect(
      wouldHide({ model: "useful", confidencePermille: 990, historyConflict: true }, 800),
    ).toBe(false);
    expect(
      wouldHide({ model: "missed", confidencePermille: 990, historyConflict: false }, 800),
    ).toBe(false);
  });

  it("flags a useful verdict that goes against the owner's clear majority in that bucket", () => {
    const history: CalibrationRating[] = [
      ...Array<CalibrationRating>(12).fill("unneeded"),
      ...Array<CalibrationRating>(8).fill("useful"),
    ];
    expect(historyConflict("useful", history, 20)).toBe(true);
    expect(historyConflict("useful", history.slice(0, 19), 20)).toBe(false);
    expect(historyConflict("unneeded", history, 20)).toBe(false);
    const tie: CalibrationRating[] = [
      ...Array<CalibrationRating>(10).fill("unneeded"),
      ...Array<CalibrationRating>(10).fill("useful"),
    ];
    expect(historyConflict("useful", tie, 20)).toBe(false);
  });

  it("does not open without a baseline to beat", () => {
    expect(prereviewGate(proportion(100, 100, 1), proportion(0, 0, 1), 900).open).toBe(false);
  });
});

describe("[P4-8] weekly agreement and its bar", () => {
  const row = (modelRef: string, promptId: string, createdAt: string): PrereviewWeekRow => ({
    group: "memory_skipped",
    model: "useful",
    confidencePermille: 950,
    historyConflict: false,
    owner: "useful",
    modelRef,
    promptId,
    createdAt,
  });

  it("compares the version the service runs now, even when a newer one is in the window", () => {
    const rows = [
      row("model-a", "prompt-1", "2026-11-02T00:00:00.000Z"),
      row("model-a", "prompt-1", "2026-11-03T00:00:00.000Z"),
      row("model-b", "prompt-2", "2026-11-04T00:00:00.000Z"),
    ];
    const pinned = summarizePrereviewWeek(rows, options, {
      modelRef: "model-a",
      promptId: "prompt-1",
    });
    expect(pinned.version).toEqual({ modelRef: "model-a", promptId: "prompt-1" });
    expect(pinned.otherVersions).toBe(1);
    expect(summarizePrereviewWeek(rows, options).version).toEqual({
      modelRef: "model-b",
      promptId: "prompt-2",
    });
  });

  it("gives a finite minimum number of pairs for every bar the configuration accepts", () => {
    expect(minimumPairsToPass(900)).toBe(35);
    const strictest = minimumPairsToPass(999);
    expect(strictest).not.toBeNull();
    expect(Number.isSafeInteger(strictest)).toBe(true);
  });

  it("[negative] has no finite number of pairs for a 100% bar", () => {
    expect(minimumPairsToPass(1000)).toBeNull();
  });
});
