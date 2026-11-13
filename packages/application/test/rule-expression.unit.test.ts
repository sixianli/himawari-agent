import { describe, expect, it } from "vitest";
import { RULE_FIELD_CATALOG, RULE_GATES } from "../src/rules/field-catalog.js";
import {
  compileRuleExpression,
  RULE_EXPRESSION_MAX_LENGTH,
  RuleExpressionError,
} from "../src/rules/rule-expression.js";

const MAIL = {
  sender_address: "boss@corp.example.com",
  sender_domain: "corp.example.com",
  text: "Invoice for 引落 \n see attached",
  content_folded: "invoice for 引落 \n see attached",
  text_words: ["invoice", "for", "see", "attached"],
  content_words: ["invoice", "for", "see", "attached"],
  money_state: "unknown",
  amount_state: "missing",
  amount_minor: 0,
  amount_currency: "",
};
const TIME = { local_minutes: 1400, local_weekday: 2, local_previous_weekday: 1 };

function evaluates(gate: "mail_item" | "mail_delivery", source: string, facts: object): boolean {
  return compileRuleExpression(gate, source).evaluate(facts as never);
}

function rejected(gate: "mail_item" | "mail_delivery", source: string): string {
  try {
    compileRuleExpression(gate, source);
  } catch (error) {
    expect(error).toBeInstanceOf(RuleExpressionError);
    return (error as RuleExpressionError).reason;
  }
  throw new Error(`规则表达式本应被拒绝：${source}`);
}

describe("rule expression", () => {
  it("[HR-1] evaluates the operators and string functions the rule book relies on, as the CEL spec defines them", () => {
    expect(evaluates("mail_delivery", "local_minutes >= 1380 || local_minutes < 420", TIME)).toBe(
      true,
    );
    expect(evaluates("mail_delivery", "local_minutes >= 1380 && local_weekday == 3", TIME)).toBe(
      false,
    );
    expect(evaluates("mail_delivery", "!(local_weekday in [0, 6])", TIME)).toBe(true);
    expect(evaluates("mail_delivery", "local_weekday in [1, 2] ? true : false", TIME)).toBe(true);
    expect(evaluates("mail_item", 'sender_domain.endsWith(".example.com")', MAIL)).toBe(true);
    expect(evaluates("mail_item", 'sender_domain.startsWith("corp.")', MAIL)).toBe(true);
    expect(evaluates("mail_item", 'text.contains("引落")', MAIL)).toBe(true);
    expect(evaluates("mail_item", 'size(text_words) == 4 && "invoice" in text_words', MAIL)).toBe(
      true,
    );
    expect(evaluates("mail_item", '["a.com", "b.com"].exists(d, sender_domain == d)', MAIL)).toBe(
      false,
    );
    expect(evaluates("mail_item", "text_words.all(w, size(w) > 2)", MAIL)).toBe(true);
    expect(evaluates("mail_item", 'false && sender_domain.endsWith("x")', MAIL)).toBe(false);
    expect(evaluates("mail_item", 'true || sender_domain.endsWith("x")', MAIL)).toBe(true);
  });

  it("[HR-1] refuses anything outside the whitelist even though CEL itself would run it", () => {
    const outsideWhitelist: readonly (readonly ["mail_item" | "mail_delivery", string])[] = [
      ["mail_item", 'text.matches("(a+)+$")'],
      ["mail_delivery", "int(local_minutes) > 1"],
      ["mail_delivery", "double(local_minutes) > 1.0"],
      ["mail_delivery", "string(local_minutes) == '1'"],
      ["mail_delivery", 'bytes("a") == bytes("a")'],
      ["mail_delivery", "dyn(local_minutes) == 1"],
      ["mail_delivery", "type(local_minutes) == int"],
      ["mail_delivery", "has({'a': 1}.a)"],
      ["mail_delivery", "local_minutes * 2 > 1"],
      ["mail_delivery", "local_minutes / 2 > 1"],
      ["mail_delivery", "local_minutes % 2 == 0"],
      ["mail_delivery", "{'a': 1}.a == 1"],
      ["mail_delivery", "[1, 2][0] == 1"],
      ["mail_item", '["x"].exists(v, text.matches("a"))'],
      ["mail_delivery", '["x"].all(v, int(local_minutes) > 0)'],
    ];
    for (const [gate, source] of outsideWhitelist)
      expect(rejected(gate, source), source).toBe("not_allowed");
    expect(rejected("mail_delivery", "local_minutes == 1.5")).not.toBe("");
  });

  it("[HR-1] reports which part is wrong: unknown field, wrong type, wrong result type, too long", () => {
    expect(rejected("mail_delivery", "no_such_field > 1")).toBe("type");
    expect(rejected("mail_delivery", 'local_minutes + "a" == "b"')).toBe("type");
    expect(rejected("mail_delivery", "local_minutes + 1")).toBe("type");
    expect(rejected("mail_delivery", "local_minutes >=")).toBe("syntax");
    expect(
      rejected("mail_delivery", `local_minutes > ${"1".repeat(RULE_EXPRESSION_MAX_LENGTH)}`),
    ).toBe("too_long");
    expect(rejected("mail_delivery", "")).toBe("too_long");
  });

  it("[HR-1] only lets a rule read the fields of its own gate", () => {
    expect(rejected("mail_item", "local_minutes > 1")).toBe("type");
    expect(rejected("mail_delivery", 'sender_domain == "a"')).toBe("type");
    for (const gate of RULE_GATES) expect(RULE_FIELD_CATALOG[gate].length).toBeGreaterThan(0);
  });

  it("[HR-1] does not run a rule whose facts are missing or of the wrong type", () => {
    const rule = compileRuleExpression("mail_delivery", "local_minutes > 1");
    expect(() => rule.evaluate({ local_weekday: 1, local_previous_weekday: 0 })).toThrow(
      RuleExpressionError,
    );
    expect(() => rule.evaluate({ ...TIME, local_minutes: 1.5 as never } as never)).toThrow(
      RuleExpressionError,
    );
    expect(() => rule.evaluate({ ...TIME, local_minutes: "5" as never })).toThrow(
      RuleExpressionError,
    );
  });

  it("[HR-1] stops a pathological expression at parse time instead of running it", () => {
    expect(rejected("mail_delivery", `${"(".repeat(200)}true${")".repeat(200)}`)).not.toBe("");
    expect(
      rejected(
        "mail_item",
        `[${Array.from({ length: 400 }, (_, i) => `"w${i}"`).join(",")}].exists(w, w == text)`,
      ),
    ).not.toBe("");
  });
});
