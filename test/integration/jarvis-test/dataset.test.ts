import { describe, expect, it } from "vitest";
import { loadCalibration, loadDataset } from "./cases.ts";

const DAY_MS = 86_400_000;
const dataset = loadDataset();
const calibration = loadCalibration();

function ageInDays(iso: string): number {
  return (Date.parse(dataset.today) - Date.parse(iso)) / DAY_MS;
}

describe("Jarvis Test dataset", () => {
  it("holds six uniquely named cases for each of the first three scenarios", () => {
    const ids = dataset.cases.map(({ id }) => id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scenario of ["memory_correction", "state_discipline", "failure_transparency"])
      expect(dataset.cases.filter((item) => item.scenario === scenario)).toHaveLength(6);
  });

  it("labels every next-step case as should or should not propose, with both labels in every question it asks", () => {
    const cases = dataset.cases.filter(({ scenario }) => scenario === "proactive_next_step");
    expect(cases.length).toBeGreaterThan(0);
    for (const item of cases) {
      expect(typeof item.shouldPropose, item.id).toBe("boolean");
      expect(item.toolResults?.length ?? 0, item.id).toBeGreaterThan(0);
      for (const prepared of item.toolResults ?? []) {
        expect(["web_search", "web_fetch"], item.id).toContain(prepared.tool);
        expect(prepared.outputs.length, item.id).toBeGreaterThan(0);
      }
      const sameQuestion = cases.filter(({ prompt }) => prompt === item.prompt);
      expect(
        sameQuestion.some(({ shouldPropose }) => shouldPropose === true),
        item.id,
      ).toBe(true);
      expect(
        sameQuestion.some(({ shouldPropose }) => shouldPropose === false),
        item.id,
      ).toBe(true);
    }
    for (const item of dataset.cases)
      if (item.scenario !== "proactive_next_step")
        expect(item.shouldPropose, item.id).toBeUndefined();
  });

  it("dates every correction three weeks back from the fixed today", () => {
    expect(dataset.today).toBe(new Date(dataset.today).toISOString());
    for (const item of dataset.cases.filter(({ scenario }) => scenario === "memory_correction")) {
      const memories = item.memories ?? [];
      const latest = memories[memories.length - 1];
      const replaced = memories.find(({ id }) => id === latest?.supersedes);
      expect(latest, item.id).toBeDefined();
      expect(replaced, item.id).toBeDefined();
      expect(ageInDays(latest?.recordedAt ?? ""), item.id).toBe(20);
      expect(ageInDays(replaced?.recordedAt ?? ""), item.id).toBeGreaterThanOrEqual(21);
      expect(item.context?.present, item.id).toEqual([latest?.id]);
      expect(item.prompt, item.id).not.toMatch(/纠正|之前说|记得/u);
    }
    for (const memory of [
      ...dataset.sharedMemories,
      ...dataset.cases.flatMap(({ memories = [] }) => memories),
    ])
      expect(ageInDays(memory.recordedAt), memory.id).toBeGreaterThan(0);
  });

  it("gives every state question files to read and every failure case a declared or real failure", () => {
    for (const item of dataset.cases) {
      const paths = (item.files ?? []).map(({ path }) => path);
      for (const required of item.answer.fullRead ?? []) expect(paths, item.id).toContain(required);
      if (item.scenario === "state_discipline")
        expect(item.answer.fullRead !== undefined || item.answer.searched === true, item.id).toBe(
          true,
        );
      if (item.scenario === "failure_transparency")
        expect(
          (item.failures?.length ?? 0) + (item.realFailures?.length ?? 0),
          item.id,
        ).toBeGreaterThan(0);
    }
  });

  it("judges every case against its own written expectations", () => {
    for (const item of dataset.cases) {
      expect(item.answer.expectations.length, item.id).toBeGreaterThan(0);
      expect(item.judgeRules[0], item.id).toBe("case_expectations_met");
      if (item.answer.fullRead)
        expect(item.answer.conclusionCues?.length ?? 0, item.id).toBeGreaterThan(0);
    }
  });

  it("calibrates every judge rule with at least eight samples of both labels", () => {
    const ruleIds = dataset.judgeRules.map(({ id }) => id);
    for (const item of dataset.cases)
      for (const rule of item.judgeRules) expect(ruleIds, item.id).toContain(rule);
    for (const rule of ruleIds) {
      const samples = calibration.samples.filter((sample) => sample.rule === rule);
      expect(samples.length, rule).toBeGreaterThanOrEqual(8);
      expect(
        samples.some(({ expected }) => expected),
        rule,
      ).toBe(true);
      expect(
        samples.some(({ expected }) => !expected),
        rule,
      ).toBe(true);
    }
    const sampleIds = calibration.samples.map(({ id }) => id);
    expect(new Set(sampleIds).size).toBe(sampleIds.length);
  });

  it("includes the Chinese negation and status traps in the state calibration", () => {
    const traps = new Set(
      calibration.samples
        .filter(({ rule }) => rule === "state_not_overclaimed")
        .map(({ trap }) => trap),
    );
    for (const trap of ["negation", "processing_vs_arrived", "submitted_vs_approved"])
      expect(traps).toContain(trap);
  });
});
