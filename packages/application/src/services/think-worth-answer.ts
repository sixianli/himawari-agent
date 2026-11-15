import type { ThinkWorthAnswer } from "../ports/think-worth.js";

export const THINK_WORTH_QUESTION_NAME = "think_worth";
export const THINK_WORTH_CHOICE_WORTH = "worth";
export const THINK_WORTH_CHOICE_NOT_WORTH = "not_worth";

export type ThinkWorthVerdict = "think" | "skip" | "unsure";

export class ThinkWorthDecisionFailure extends Error {
  constructor(code: string) {
    super(code);
    this.name = "ThinkWorthDecisionFailure";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidAnswer(): never {
  throw new ThinkWorthDecisionFailure("THINK_WORTH_ANSWER_INVALID");
}

function unitProbability(probability: unknown): number {
  if (
    typeof probability !== "number" ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  )
    return invalidAnswer();
  return probability;
}

function probabilityTable(options: unknown): Map<string, number> {
  const found = new Map<string, number>();
  if (Array.isArray(options)) {
    for (const option of options as readonly unknown[]) {
      if (!isRecord(option) || typeof option["value"] !== "string") invalidAnswer();
      if (found.has(option["value"])) invalidAnswer();
      found.set(option["value"], unitProbability(option["probability"]));
    }
  } else if (isRecord(options)) {
    for (const [value, probability] of Object.entries(options))
      found.set(value, unitProbability(probability));
  } else invalidAnswer();
  return found;
}

export function parseThinkWorthDecision(body: unknown, model: string): ThinkWorthAnswer {
  if (!isRecord(body) || body["model"] !== model)
    throw new ThinkWorthDecisionFailure("THINK_WORTH_MODEL_MISMATCH");
  const answers = body["answers"];
  if (!Array.isArray(answers) || answers.length !== 1)
    throw new ThinkWorthDecisionFailure("THINK_WORTH_ANSWER_COUNT");
  const answer: unknown = answers[0];
  if (
    !isRecord(answer) ||
    answer["type"] !== "choice" ||
    answer["name"] !== THINK_WORTH_QUESTION_NAME
  )
    return invalidAnswer();
  const choice = answer["choice"];
  if (choice !== THINK_WORTH_CHOICE_WORTH && choice !== THINK_WORTH_CHOICE_NOT_WORTH)
    return invalidAnswer();
  unitProbability(answer["confidence"]);
  const table = probabilityTable(answer["probabilities"]);
  const yes = table.get(THINK_WORTH_CHOICE_WORTH);
  const no = table.get(THINK_WORTH_CHOICE_NOT_WORTH);
  if (table.size !== 2 || yes === undefined || no === undefined) return invalidAnswer();
  if (Math.abs(yes + no - 1) > 0.001) return invalidAnswer();
  if ((choice === THINK_WORTH_CHOICE_WORTH ? yes : no) < Math.max(yes, no)) return invalidAnswer();
  return Object.freeze({ worthPermille: Math.round(yes * 1000) });
}

export function judgeThinkWorth(
  answer: ThinkWorthAnswer,
  thresholds: { readonly yesAtLeastPermille: number; readonly noAtMostPermille: number },
): ThinkWorthVerdict {
  if (answer.worthPermille >= thresholds.yesAtLeastPermille) return "think";
  if (answer.worthPermille <= thresholds.noAtMostPermille) return "skip";
  return "unsure";
}
