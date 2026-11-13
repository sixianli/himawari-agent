import { describe, expect, it } from "vitest";
import {
  IMPORT_DUPLICATE_DEFAULTS,
  ImportDuplicateDecisionFailure,
  importDuplicateVerdict,
  parseImportDuplicateAnswers,
} from "../src/index.js";

const model = "typesafe-ai/jev";
const keys = ["m0", "m1"];

describe("[A4] memory import duplicate answers", () => {
  it("reads the best matching existing memory and its probability from a choice answer", () => {
    const [answer] = parseImportDuplicateAnswers(
      {
        model,
        answers: [
          {
            type: "choice",
            name: "c0",
            choice: "m1",
            probabilities: [
              { value: "m0", probability: 0.1 },
              { value: "m1", probability: 0.82 },
              { value: "none", probability: 0.08 },
            ],
          },
        ],
      },
      model,
      1,
      keys,
    );
    expect(answer).toEqual({ matchKey: "m1", probabilityPermille: 820 });
  });

  it("treats none as no match and a refusal as unanswered", () => {
    const answers = parseImportDuplicateAnswers(
      {
        model,
        answers: [
          {
            type: "choice",
            name: "c0",
            choice: "none",
            probabilities: [{ value: "none", probability: 0.97 }],
          },
          { type: "refusal", name: "c1" },
        ],
      },
      model,
      2,
      keys,
    );
    expect(answers[0]).toEqual({ matchKey: null, probabilityPermille: 0 });
    expect(answers[1]).toBeUndefined();
  });

  it("REVERSE: rejects a wrong model, a wrong count, an unknown choice and a bad probability", () => {
    const good = {
      type: "choice",
      name: "c0",
      choice: "m0",
      probabilities: [{ value: "m0", probability: 0.9 }],
    };
    const parse =
      (body: unknown, count = 1) =>
      () =>
        parseImportDuplicateAnswers(body, model, count, keys);
    expect(parse({ model: "other", answers: [good] })).toThrow(ImportDuplicateDecisionFailure);
    expect(parse({ model, answers: [good, good] })).toThrow("IMPORT_DUPLICATE_ANSWER_COUNT");
    expect(
      parse({ model, answers: [{ ...good, probabilities: [{ value: "m9", probability: 0.9 }] }] }),
    ).toThrow("IMPORT_DUPLICATE_ANSWER_INVALID");
    expect(
      parse({ model, answers: [{ ...good, probabilities: [{ value: "m0", probability: 1.4 }] }] }),
    ).toThrow("IMPORT_DUPLICATE_ANSWER_INVALID");
    expect(parse({ model, answers: [{ ...good, name: "c5" }] })).toThrow(
      "IMPORT_DUPLICATE_ANSWER_INVALID",
    );
  });

  it("calls it the same thing only at or above the yes line, and different at or below the no line", () => {
    const at = (permille: number) =>
      importDuplicateVerdict(
        { matchKey: "m0", probabilityPermille: permille },
        IMPORT_DUPLICATE_DEFAULTS,
      );
    expect(at(700)).toBe("same");
    expect(at(699)).toBe("unsure");
    expect(at(301)).toBe("unsure");
    expect(at(300)).toBe("different");
    expect(
      importDuplicateVerdict({ matchKey: null, probabilityPermille: 0 }, IMPORT_DUPLICATE_DEFAULTS),
    ).toBe("different");
    expect(importDuplicateVerdict(undefined, IMPORT_DUPLICATE_DEFAULTS)).toBe("skipped");
  });
});
