import {
  type OwnerRuleParameters,
  ownerRuleRecord,
  parseOwnerRuleParameters,
  RULE_TYPES,
  type RuleTypeDefinition,
  RuleTypeError,
  writableRuleType,
} from "./rule-types.js";

export const RULE_REVIEW_SOFT_TYPE = "soft";

export type RuleReviewVerdict =
  | { readonly kind: "same" }
  | { readonly kind: "changed"; readonly suggestion: OwnerRuleParameters }
  | { readonly kind: "not_standing" }
  | { readonly kind: "invalid"; readonly reason: string };

function invalid(reason: string): RuleReviewVerdict {
  return Object.freeze({ kind: "invalid", reason });
}

function sameRule(left: OwnerRuleParameters, right: OwnerRuleParameters): boolean {
  return left.type === right.type && JSON.stringify(left.params) === JSON.stringify(right.params);
}

export function parseRuleReviewAnswer(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed);
}

export function judgeRuleReview(
  current: unknown,
  answer: unknown,
  registry: readonly RuleTypeDefinition[] = RULE_TYPES,
): RuleReviewVerdict {
  let existing: OwnerRuleParameters;
  try {
    existing = parseOwnerRuleParameters(current, registry);
  } catch (error) {
    if (error instanceof RuleTypeError) return invalid("current_rule_invalid");
    throw error;
  }
  if (typeof answer !== "object" || answer === null || Array.isArray(answer))
    return invalid("answer_not_object");
  const record = answer as Record<string, unknown>;
  if (typeof record["standing"] !== "boolean") return invalid("standing_missing");
  if (record["standing"] === false || record["type"] === RULE_REVIEW_SOFT_TYPE)
    return Object.freeze({ kind: "not_standing" });
  let suggestion: OwnerRuleParameters;
  try {
    if (typeof record["type"] !== "string") return invalid("type_missing");
    writableRuleType(record["type"], registry);
    const parsed = parseOwnerRuleParameters(
      {
        type: record["type"],
        params: record["params"],
        summary: record["summary"],
      },
      registry,
    );
    suggestion = Object.freeze({
      type: parsed.type,
      params: parsed.params,
      summary: parsed.summary,
    });
    ownerRuleRecord(
      {
        ruleId: "owner:review",
        revision: 1,
        status: "active",
        source: "review",
        parameters: suggestion,
      },
      registry,
    );
  } catch (error) {
    if (error instanceof RuleTypeError) return invalid(error.code);
    throw error;
  }
  if (sameRule(existing, suggestion)) return Object.freeze({ kind: "same" });
  return Object.freeze({ kind: "changed", suggestion });
}
