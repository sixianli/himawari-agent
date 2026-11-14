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

function permille(probability: unknown): number {
  if (
    typeof probability !== "number" ||
    !Number.isFinite(probability) ||
    probability < 0 ||
    probability > 1
  )
    throw new OwnerIntentDecisionFailure("OWNER_INTENT_ANSWER_INVALID");
  return Math.round(probability * 1000);
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
  let explicit: number;
  const options = answer["probabilities"];
  if (Array.isArray(options)) {
    const found = new Map<string, number>();
    for (const option of options as readonly unknown[]) {
      if (!isRecord(option) || typeof option["value"] !== "string")
        throw new OwnerIntentDecisionFailure("OWNER_INTENT_ANSWER_INVALID");
      if (
        option["value"] !== OWNER_INTENT_CHOICE_EXPLICIT &&
        option["value"] !== OWNER_INTENT_CHOICE_NOT_EXPLICIT
      )
        throw new OwnerIntentDecisionFailure("OWNER_INTENT_ANSWER_INVALID");
      found.set(option["value"], permille(option["probability"]));
    }
    const yes = found.get(OWNER_INTENT_CHOICE_EXPLICIT);
    if (yes === undefined) throw new OwnerIntentDecisionFailure("OWNER_INTENT_ANSWER_INVALID");
    explicit = yes;
  } else {
    const choice = answer["choice"];
    if (choice === OWNER_INTENT_CHOICE_NOT_EXPLICIT)
      explicit = 1000 - permille(answer["confidence"]);
    else if (choice === OWNER_INTENT_CHOICE_EXPLICIT) explicit = permille(answer["confidence"]);
    else throw new OwnerIntentDecisionFailure("OWNER_INTENT_ANSWER_INVALID");
  }
  return Object.freeze({
    verdict: explicit >= 500 ? "explicit" : "not_explicit",
    confidence: explicit >= 500 ? explicit : 1000 - explicit,
    quote: null,
  });
}
