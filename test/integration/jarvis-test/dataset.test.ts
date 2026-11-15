import { MEMORY_CATEGORIES } from "@himawari-agent/application";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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
      expect(
        dataset.cases.filter((item) => item.scenario === scenario && !item.counterExample),
      ).toHaveLength(6);
    for (const item of dataset.cases)
      if (item.counterExample) expect(item.scenario, item.id).toBe("memory_correction");
  });

  it("gives every counter-example a standing preference and a one-off remark that replaces nothing", () => {
    const counterExamples = dataset.cases.filter(({ counterExample }) => counterExample);
    expect(counterExamples.length).toBeGreaterThanOrEqual(2);
    for (const item of counterExamples) {
      const memories = item.memories ?? [];
      expect(memories.length, item.id).toBeGreaterThanOrEqual(2);
      expect(
        memories.every(({ supersedes }) => supersedes === undefined),
        item.id,
      ).toBe(true);
      expect(item.context?.present.length ?? 0, item.id).toBeGreaterThan(0);
    }
  });

  it("builds every forgetting case as source, inference from it, then a correction of the source", () => {
    const cases = dataset.cases.filter(({ scenario }) => scenario === "forget_propagation");
    expect(cases.length).toBeGreaterThanOrEqual(4);
    for (const item of cases) {
      const memories = item.memories ?? [];
      const corrected = new Set(memories.flatMap(({ supersedes }) => supersedes ?? []));
      expect(corrected.size, item.id).toBeGreaterThan(0);
      const expected = memories
        .filter(({ derivedFrom = [] }) => derivedFrom.some((id) => corrected.has(id)))
        .map(({ id }) => id)
        .sort();
      expect(expected.length, item.id).toBeGreaterThan(0);
      expect([...(item.flagged ?? [])].sort(), item.id).toEqual(expected);
      for (const memory of memories) {
        const correction = memories.find(({ supersedes }) => supersedes === memory.id);
        for (const derived of memories.filter(({ derivedFrom = [] }) =>
          derivedFrom.includes(memory.id),
        )) {
          expect(memory.recordedAt < derived.recordedAt, derived.id).toBe(true);
          if (correction) expect(derived.recordedAt < correction.recordedAt, derived.id).toBe(true);
        }
      }
    }
    for (const item of dataset.cases)
      if (item.scenario !== "forget_propagation") expect(item.flagged, item.id).toBeUndefined();
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
    for (const item of dataset.cases.filter(
      ({ scenario, counterExample }) => scenario === "memory_correction" && !counterExample,
    )) {
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
    ]) {
      expect(ageInDays(memory.recordedAt), memory.id).toBeGreaterThan(0);
      expect(MEMORY_CATEGORIES, memory.id).toContain(memory.category);
    }
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

  it("lists all twelve vision tests in the coverage map, each pointing at real cases, real tests or a stated gap", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const coverage = JSON.parse(
      readFileSync(path.join(root, "test/fixtures/jarvis-test/coverage.json"), "utf8"),
    ) as {
      tests: {
        number: number;
        status: string;
        scenarios: string[];
        deterministicTests: string[];
        liveEvals: string[];
        gaps: string[];
      }[];
    };
    expect(coverage.tests.map(({ number }) => number)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    const vision = readFileSync(path.join(root, "docs/product-vision.md"), "utf8");
    const covered = new Set(dataset.cases.map(({ scenario }) => scenario));
    const claimed = new Set<string>();
    for (const test of coverage.tests) {
      expect(vision, String(test.number)).toMatch(new RegExp(`\\| ${test.number} \\|`, "u"));
      expect(["automated", "partial", "not_yet", "blocked"], String(test.number)).toContain(
        test.status,
      );
      for (const scenario of test.scenarios) {
        expect(covered, String(test.number)).toContain(scenario);
        claimed.add(scenario);
      }
      for (const file of [...test.deterministicTests, ...test.liveEvals])
        expect(existsSync(path.join(root, file)), file).toBe(true);
      if (test.status === "automated")
        expect(test.scenarios.length, String(test.number)).toBeGreaterThan(0);
      else expect(test.gaps.length, String(test.number)).toBeGreaterThan(0);
    }
    expect([...covered].filter((scenario) => !claimed.has(scenario))).toEqual([]);
  });

  it("gives the #3 mail interception set one target per case, quiet noise, and a case where nothing should be raised", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const intercept = JSON.parse(
      readFileSync(path.join(root, "test/fixtures/proactive-intercept-eval/dataset.json"), "utf8"),
    ) as {
      noise: { id: string }[];
      cases: {
        id: string;
        expect: string[] | null;
        target: { id: string } | null;
        memories: { id: string }[];
        memoryRequired?: boolean;
      }[];
    };
    const ids = [
      ...intercept.noise.map(({ id }) => id),
      ...intercept.cases.flatMap(({ target }) => (target ? [target.id] : [])),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(intercept.noise.length).toBeGreaterThan(0);
    for (const item of intercept.cases) {
      expect(item.target === null, item.id).toBe(item.expect === null);
      for (const result of item.expect ?? [])
        expect(["act", "know", "check", "ignore"], item.id).toContain(result);
      if (item.memoryRequired) expect(item.memories.length, item.id).toBeGreaterThan(0);
    }
    expect(intercept.cases.some(({ target }) => target === null)).toBe(true);
    expect(intercept.cases.some(({ expect: allowed }) => allowed?.includes("act") === false)).toBe(
      true,
    );
  });
});
