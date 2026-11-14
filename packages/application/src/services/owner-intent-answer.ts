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
  if (quote.length === 0 || quote.length > MAXIMUM_QUOTE_LENGTH)
    return { confirmed: false, reason: "quote_missing" };
  if (!ownerWords.some((words) => words.includes(quote)))
    return { confirmed: false, reason: "quote_not_from_owner" };
  return { confirmed: true, answer };
}
