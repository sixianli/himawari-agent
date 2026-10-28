import { describe, expect, it, vi } from "vitest";
import { loadCalibration, loadDataset } from "./cases.ts";
import {
  calibrateDecisionJudge,
  calibrateReasoningJudge,
  type DecisionJudge,
  type JudgeQuestion,
  judgeAnswer,
  type ReasoningJudge,
} from "./judge.ts";

const dataset = loadDataset();
const calibration = loadCalibration();
const expectedByAnswer = new Map(
  calibration.samples.map((sample) => [`${sample.rule}\n${sample.answer}`, sample.expected]),
);

function expected(question: JudgeQuestion): boolean {
  const value = expectedByAnswer.get(`${question.rule.id}\n${question.answer}`);
  if (value === undefined) throw new Error("unknown sample");
  return value;
}

function decisionJudge(probability: (question: JudgeQuestion) => number): DecisionJudge {
  return {
    identity: { id: "typesafe-ai/jev", version: "fixture" },
    decide: vi.fn(async (questions: readonly JudgeQuestion[]) => questions.map(probability)),
  };
}

function reasoningJudge(passed: (question: JudgeQuestion) => boolean): ReasoningJudge {
  return {
    identity: { id: "fixture/reasoning", version: "fixture" },
    judge: vi.fn(async (question: JudgeQuestion) => ({
      passed: passed(question),
      quote: question.answer.slice(0, 10),
      reason: "fixture",
    })),
  };
}

const rule = dataset.judgeRules[0];
if (!rule) throw new Error("no judge rules");

describe("Jarvis Test two-tier judge", () => {
  it("accepts a confident pass from the decision judge without asking the reasoning judge", async () => {
    const reasoning = reasoningJudge(() => false);
    const verdicts = await judgeAnswer([{ rule, evidence: "e", answer: "a" }], {
      decision: decisionJudge(() => 0.9),
      reasoning,
    });
    expect(verdicts).toEqual([
      expect.objectContaining({ passed: true, tier: "decision", probability: 0.9, quote: null }),
    ]);
    expect(reasoning.judge).not.toHaveBeenCalled();
  });

  it.each([
    [0.1, "a confident failure"],
    [0.5, "an uncertain answer"],
  ])("sends %s (%s) to the reasoning judge, which decides and quotes", async (probability) => {
    const reasoning = reasoningJudge(() => true);
    const verdicts = await judgeAnswer([{ rule, evidence: "e", answer: "原句在这里" }], {
      decision: decisionJudge(() => probability),
      reasoning,
    });
    expect(verdicts).toEqual([
      expect.objectContaining({
        passed: true,
        tier: "escalated",
        probability,
        quote: "原句在这里",
      }),
    ]);
    expect(reasoning.judge).toHaveBeenCalledTimes(1);
  });

  it("uses only the reasoning judge when the decision judge is not qualified", async () => {
    const verdicts = await judgeAnswer([{ rule, evidence: "e", answer: "a" }], {
      decision: null,
      reasoning: reasoningJudge(() => false),
    });
    expect(verdicts).toEqual([
      expect.objectContaining({ passed: false, tier: "reasoning_only", probability: null }),
    ]);
  });

  it("qualifies a decision judge that agrees with every calibration label", async () => {
    const result = await calibrateDecisionJudge(
      decisionJudge((question) => (expected(question) ? 0.97 : 0.03)),
      dataset.judgeRules,
      calibration.samples,
    );
    expect(result).toMatchObject({ qualified: true, confidentMistakes: [], uncertain: [] });
    expect(result.details).toHaveLength(calibration.samples.length);
  });

  it("disqualifies a decision judge that confidently misreads one negation trap", async () => {
    const result = await calibrateDecisionJudge(
      decisionJudge((question) =>
        question.answer.startsWith("不是已退款") ? 0.05 : expected(question) ? 0.97 : 0.03,
      ),
      dataset.judgeRules,
      calibration.samples,
    );
    expect(result.qualified).toBe(false);
    expect(result.confidentMistakes).toEqual(["state-03"]);
  });

  it("disqualifies a decision judge that is unsure about more than a fifth of the samples", async () => {
    let index = 0;
    const result = await calibrateDecisionJudge(
      decisionJudge((question) => {
        index += 1;
        if (index % 4 === 0) return 0.5;
        return expected(question) ? 0.97 : 0.03;
      }),
      dataset.judgeRules,
      calibration.samples,
    );
    expect(result.confidentMistakes).toEqual([]);
    expect(result.uncertain.length).toBeGreaterThan(calibration.samples.length * 0.2);
    expect(result.qualified).toBe(false);
  });

  it("invalidates the round when the reasoning judge misjudges any calibration sample", async () => {
    expect(
      await calibrateReasoningJudge(
        reasoningJudge((question) => expected(question)),
        dataset.judgeRules,
        calibration.samples,
      ),
    ).toMatchObject({ qualified: true, confidentMistakes: [], uncertain: [] });
    const flipped = await calibrateReasoningJudge(
      reasoningJudge((question) =>
        question.answer.includes("处理中") ? false : expected(question),
      ),
      dataset.judgeRules,
      calibration.samples,
    );
    expect(flipped.qualified).toBe(false);
    expect(flipped.confidentMistakes).toEqual(["state-05"]);
  });
});
