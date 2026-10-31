import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repositoryRoot } from "../../scripts/ci/contracts.mjs";
import {
  scoreRun,
  scoreStable,
  validateDataset,
} from "../../scripts/evals/memory-capture-score.mjs";

const dataset = JSON.parse(
  readFileSync(path.join(repositoryRoot, "test/fixtures/memory-capture-eval/dataset.json"), "utf8"),
);

function perfectResults() {
  return dataset.items.map((item) => ({
    id: item.id,
    candidates: item.expect.memories.map((expected) => ({
      text: expected.keyFacts.map((alternatives) => alternatives[0]).join(" "),
      decision: expected.decision,
      classification: expected.classification,
      category: expected.category,
      dueAt: expected.dueAtPrefix ? `${expected.dueAtPrefix}T00:00:00+09:00` : null,
      existingMemoryId: expected.existingMemoryId ?? null,
    })),
  }));
}

describe("memory capture evaluation dataset", () => {
  it("has no validation errors and 60 positives and 60 negatives", () => {
    expect(validateDataset(dataset)).toEqual([]);
    expect(dataset.items.filter((item) => item.expect.remember)).toHaveLength(60);
    expect(dataset.items.filter((item) => !item.expect.remember)).toHaveLength(60);
  });

  it("scores a perfect run as full marks", () => {
    const score = scoreRun(dataset, perfectResults());
    expect(score.recall).toBe(1);
    expect(score.memoryRecall).toBe(1);
    expect(score.falseMemoryRate).toBe(0);
    expect(score.secretLeaks).toBe(0);
    expect(score.sensitiveDowngrades).toBe(0);
    expect(score.decisionAccuracy).toBe(1);
    expect(score.classificationAccuracy).toBe(1);
    expect(score.dueAtAccuracy).toBe(1);
    expect(score.extraCandidates).toBe(0);
  });

  it("scores an empty run as zero recall and no false memories", () => {
    const score = scoreRun(dataset, []);
    expect(score.recall).toBe(0);
    expect(score.falseMemoryRate).toBe(0);
  });

  it("counts false memories, secret leaks and sensitive downgrades", () => {
    const results = perfectResults();
    const negative = dataset.items.find((item) => item.expect.forbiddenText?.length);
    results.find((result) => result.id === negative.id).candidates = [
      { text: negative.expect.forbiddenText[0], decision: "create", classification: "private" },
    ];
    const sensitive = dataset.items.find((item) =>
      item.expect.memories.some((memory) => memory.classification === "sensitive"),
    );
    for (const candidate of results.find((result) => result.id === sensitive.id).candidates)
      candidate.classification = "private";
    const score = scoreRun(dataset, results);
    expect(score.secretLeaks).toBe(1);
    expect(score.falseMemoryRate).toBeCloseTo(1 / 60);
    expect(score.sensitiveDowngrades).toBeGreaterThanOrEqual(1);
  });

  it("measures stability across runs", () => {
    const good = perfectResults();
    const degraded = perfectResults().map((result, index) =>
      index === 0 ? { ...result, candidates: [] } : result,
    );
    const stable = scoreStable(dataset, [good, degraded]);
    const firstIsPositive = dataset.items[0].expect.remember;
    expect(stable.passAll).toBeCloseTo(firstIsPositive ? 119 / 120 : 1);
  });

  it("rejects a malformed dataset", () => {
    const broken = structuredClone(dataset);
    broken.items[1].id = broken.items[0].id;
    expect(validateDataset(broken)).toContain(`${broken.items[0].id}: duplicate id`);
  });
});
