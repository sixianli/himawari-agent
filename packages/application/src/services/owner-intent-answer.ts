import {
  OWNER_INTENT_VERDICTS,
  type OwnerIntentAnswer,
  type OwnerIntentVerdict,
} from "../ports/owner-intent-check.js";

export type OwnerIntentRejection =
  | "answer_invalid"
  | "confidence_below_threshold"
  | "not_explicit"
  | "quote_missing"
  | "quote_not_from_owner";

export type OwnerIntentOutcome =
  | { readonly confirmed: true; readonly answer: OwnerIntentAnswer }
  | { readonly confirmed: false; readonly reason: OwnerIntentRejection };

const MAXIMUM_QUOTE_LENGTH = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseOwnerIntentAnswer(raw: unknown): OwnerIntentAnswer | undefined {
  if (!isRecord(raw)) return undefined;
  const keys = Object.keys(raw);
  if (keys.some((key) => key !== "verdict" && key !== "confidence" && key !== "quote"))
    return undefined;
  const { verdict, confidence, quote } = raw;
  if (!(OWNER_INTENT_VERDICTS as readonly unknown[]).includes(verdict)) return undefined;
  if (
    typeof confidence !== "number" ||
    !Number.isInteger(confidence) ||
    confidence < 0 ||
    confidence > 1000
  )
    return undefined;
  if (quote !== null && quote !== undefined && typeof quote !== "string") return undefined;
  return Object.freeze({
    verdict: verdict as OwnerIntentVerdict,
    confidence,
    quote: typeof quote === "string" ? quote : null,
  });
}

export function judgeOwnerIntent(
  raw: unknown,
  ownerWords: readonly string[],
  minimumConfidence: number,
): OwnerIntentOutcome {
  const answer = parseOwnerIntentAnswer(raw);
  if (!answer) return { confirmed: false, reason: "answer_invalid" };
  if (answer.verdict !== "explicit") return { confirmed: false, reason: "not_explicit" };
  if (answer.confidence < minimumConfidence)
    return { confirmed: false, reason: "confidence_below_threshold" };
  const quote = answer.quote?.trim() ?? "";
  if (quote.length > MAXIMUM_QUOTE_LENGTH) return { confirmed: false, reason: "quote_missing" };
  if (quote.length > 0 && !ownerWords.some((words) => words.includes(quote)))
    return { confirmed: false, reason: "quote_not_from_owner" };
  return { confirmed: true, answer };
}

export const OWNER_INTENT_CHOICE_EXPLICIT = "explicit";
export const OWNER_INTENT_CHOICE_NOT_EXPLICIT = "not_explicit";
export const OWNER_INTENT_QUESTION_NAME = "owner_intent";

export class OwnerIntentDecisionFailure extends Error {
  constructor(code: string) {
    super(code);
    this.name = "OwnerIntentDecisionFailure";
  }
}

function unitProbability(probability: unknown): number {
  if (
    typeof probability !== "number" ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  )
    throw new OwnerIntentDecisionFailure("OWNER_INTENT_ANSWER_INVALID");
  return probability;
}

function invalidAnswer(): never {
  throw new OwnerIntentDecisionFailure("OWNER_INTENT_ANSWER_INVALID");
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

export function parseOwnerIntentDecision(body: unknown, model: string): OwnerIntentAnswer {
  if (!isRecord(body) || body["model"] !== model)
    throw new OwnerIntentDecisionFailure("OWNER_INTENT_MODEL_MISMATCH");
  const answers = body["answers"];
  if (!Array.isArray(answers) || answers.length !== 1)
    throw new OwnerIntentDecisionFailure("OWNER_INTENT_ANSWER_COUNT");
  const answer: unknown = answers[0];
  if (
    !isRecord(answer) ||
    answer["type"] === "refusal" ||
    answer["type"] !== "choice" ||
    answer["name"] !== OWNER_INTENT_QUESTION_NAME
  )
    throw new OwnerIntentDecisionFailure("OWNER_INTENT_ANSWER_INVALID");
  const choice = answer["choice"];
  if (choice !== OWNER_INTENT_CHOICE_EXPLICIT && choice !== OWNER_INTENT_CHOICE_NOT_EXPLICIT)
    invalidAnswer();
  const confidence = unitProbability(answer["confidence"]);
  const table = probabilityTable(answer["probabilities"]);
  const yes = table.get(OWNER_INTENT_CHOICE_EXPLICIT);
  const no = table.get(OWNER_INTENT_CHOICE_NOT_EXPLICIT);
  if (table.size !== 2 || yes === undefined || no === undefined) invalidAnswer();
  if (Math.abs(yes + no - 1) > 0.001) invalidAnswer();
  if ((choice === OWNER_INTENT_CHOICE_EXPLICIT ? yes : no) < Math.max(yes, no)) invalidAnswer();
  if (Math.abs(confidence - Math.max(yes, no)) > 0.001) invalidAnswer();
  const isExplicit = yes > no;
  const explicit = Math.round(yes * 1000);
  return Object.freeze({
    verdict: isExplicit ? "explicit" : "not_explicit",
    confidence: isExplicit ? explicit : 1000 - explicit,
    quote: null,
  });
}
