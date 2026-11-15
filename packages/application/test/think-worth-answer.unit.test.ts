import { describe, expect, it } from "vitest";

import {
  judgeThinkWorth,
  parseThinkWorthDecision,
  ThinkWorthDecisionFailure,
} from "../src/index.js";

const MODEL = "typesafe-ai/jev";

const body = (worth: number, extra: Record<string, unknown> = {}) => ({
  model: MODEL,
  answers: [
    {
      type: "choice",
      name: "think_worth",
      choice: worth >= 0.5 ? "worth" : "not_worth",
      confidence: Math.max(worth, 1 - worth),
      probabilities: [
        { value: "worth", probability: worth },
        { value: "not_worth", probability: 1 - worth },
      ],
      ...extra,
    },
  ],
});

describe("think worth answer", () => {
  it("turns the model's probability into permille and judges it against two thresholds", () => {
    const answer = parseThinkWorthDecision(body(0.82), MODEL);
    expect(answer.worthPermille).toBe(820);
    const thresholds = { yesAtLeastPermille: 700, noAtMostPermille: 300 };
    expect(judgeThinkWorth(answer, thresholds)).toBe("think");
    expect(judgeThinkWorth({ worthPermille: 700 }, thresholds)).toBe("think");
    expect(judgeThinkWorth({ worthPermille: 699 }, thresholds)).toBe("unsure");
    expect(judgeThinkWorth({ worthPermille: 301 }, thresholds)).toBe("unsure");
    expect(judgeThinkWorth({ worthPermille: 300 }, thresholds)).toBe("skip");
  });

  it("accepts the probabilities as an object as well as a list", () => {
    const object = body(0.9);
    (object.answers[0] as Record<string, unknown>)["probabilities"] = {
      worth: 0.9,
      not_worth: 0.1,
    };
    expect(parseThinkWorthDecision(object, MODEL).worthPermille).toBe(900);
  });

  it("rejects an answer that is not exactly one well-formed choice from this model", () => {
    const bad: unknown[] = [
      null,
      { ...body(0.9), model: "someone-else" },
      { model: MODEL, answers: [] },
      { model: MODEL, answers: [body(0.9).answers[0], body(0.9).answers[0]] },
      body(0.9, { name: "other_question" }),
      body(0.9, { type: "refusal" }),
      body(0.9, { choice: "maybe" }),
      body(0.9, { choice: "not_worth" }),
      body(0.9, { confidence: 2 }),
      body(0.9, { probabilities: [{ value: "worth", probability: 0.9 }] }),
      body(0.9, {
        probabilities: [
          { value: "worth", probability: 0.9 },
          { value: "not_worth", probability: 0.5 },
        ],
      }),
      body(0.9, {
        probabilities: [
          { value: "worth", probability: 0.9 },
          { value: "worth", probability: 0.1 },
        ],
      }),
    ];
    for (const value of bad)
      expect(() => parseThinkWorthDecision(value, MODEL)).toThrow(ThinkWorthDecisionFailure);
  });
});
