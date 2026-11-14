import { describe, expect, it } from "vitest";
import { MISSING_AMOUNT, parseMailAmount, toMinorUnits } from "../src/rules/amount.js";
import { RULE_GATES } from "../src/rules/field-catalog.js";
import {
  amountThresholdRule,
  assertRuleExamples,
  assertRuleShape,
  BUILT_IN_RULES,
  importantSenderRule,
  mailItemFacts,
  quietHoursRule,
  RULE_IDS,
  type RuleRecord,
  ruleBookFor,
  ruleIsEnforced,
} from "../src/rules/rule-book.js";
import { RuleExpressionError } from "../src/rules/rule-expression.js";
import { RuleJudge } from "../src/rules/rule-judge.js";
import { ruleKindOf } from "../src/rules/rule-version.js";
import { suppressPushHits } from "../src/services/proactive-rules.js";

const DEFAULT_SETTINGS = {
  quietHours: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" }],
  quietHoursRevision: 0,
  importantSenders: [],
  importantSendersRevision: 0,
};

const ITEM = { fromAddress: "a@b.com", subject: "Invoice due", snippet: "" };

describe("rule registry", () => {
  it("[HR-1] gives every rule a source, a gate of the catalog, a valid expression, and examples that hit and do not hit", () => {
    for (const rule of ruleBookFor(DEFAULT_SETTINGS)) {
      expect(rule.source.length, rule.id).toBeGreaterThan(0);
      expect(RULE_GATES, rule.id).toContain(rule.gate);
      expect(rule.revision, rule.id).toBeGreaterThanOrEqual(0);
      assertRuleExamples(rule);
    }
    for (const rule of BUILT_IN_RULES) {
      expect(
        rule.examples.some(({ hit }) => hit),
        rule.id,
      ).toBe(true);
      expect(
        rule.examples.some(({ hit }) => !hit),
        rule.id,
      ).toBe(true);
    }
  });

  it("[HR-1] keeps rule ids unique and gives every rule in the book a known kind", () => {
    const rules = ruleBookFor(DEFAULT_SETTINGS);
    expect(new Set(rules.map(({ id }) => id)).size).toBe(rules.length);
    for (const rule of rules) expect(ruleKindOf(rule.id), rule.id).not.toBe("unknown");
    expect(rules.map(({ id }) => id)).toEqual([
      RULE_IDS.importantSender,
      RULE_IDS.publicDomain,
      RULE_IDS.moneyWords,
      RULE_IDS.quietHours,
    ]);
  });

  it("[HR-1] refuses a rule whose example is wrong, so a broken rule cannot become active", () => {
    const [publicDomain] = BUILT_IN_RULES as readonly [RuleRecord, ...RuleRecord[]];
    const broken: RuleRecord = {
      ...publicDomain,
      examples: publicDomain.examples.map((example) => ({
        ...example,
        hit: !example.hit,
      })),
    };
    expect(() => assertRuleExamples(broken)).toThrow(/例子不符/u);
    expect(() => assertRuleExamples({ ...publicDomain, expression: "false" })).toThrow(/例子不符/u);
    expect(() =>
      assertRuleExamples({
        ...publicDomain,
        expression: 'sender_domain.matches("x")',
      }),
    ).toThrow(RuleExpressionError);
  });

  it("[HR-1] builds a rule from the largest settings the store accepts without hitting a limit", () => {
    const tricky = 'é\\"\u0001/\u2028😀';
    const senders = [
      ...Array.from({ length: 100 }, (_, index) =>
        `${String(index).padStart(3, "0")}${tricky.repeat(40)}`.slice(0, 254),
      ),
      ...Array.from({ length: 100 }, (_, index) =>
        `${String(index).padStart(3, "0")}${"\u0001".repeat(254)}`.slice(0, 254),
      ),
    ];
    expect(new Set(senders.map((sender) => sender.toLowerCase())).size).toBe(200);
    const rules = ruleBookFor({
      quietHours: Array.from({ length: 8 }, (_, index) => ({
        days: [0, 1, 2, 3, 4, 5, 6],
        start: `${String(index).padStart(2, "0")}:00`,
        end: `${String(index + 1).padStart(2, "0")}:30`,
      })),
      quietHoursRevision: 1,
      importantSenders: senders,
      importantSendersRevision: 1,
    });
    const judge = new RuleJudge();
    expect(() =>
      judge.decide(
        "mail_item",
        {
          sender_address: "a@b.c",
          sender_domain: "b.c",
          text: "",
          content_folded: "",
          text_words: [],
          content_words: [],
          money_state: "unknown",
          amount_state: "missing",
          amount_minor: 0,
          amount_currency: "",
        },
        rules,
      ),
    ).not.toThrow();
    expect(
      judge
        .decide(
          "mail_delivery",
          { local_minutes: 90, local_weekday: 1, local_previous_weekday: 0 },
          rules,
        )
        .hits.map(({ id }) => id),
    ).toEqual([RULE_IDS.quietHours]);
  });

  it("[HR-1] leaves out a sender with a lone surrogate instead of failing to compile", () => {
    const rule = importantSenderRule(["\ud800@example.com", "example.com"], 1);
    const facts = {
      sender_address: "a@example.com",
      sender_domain: "example.com",
      text: "",
      content_folded: "",
      text_words: [],
      content_words: [],
      money_state: "unknown",
      amount_state: "missing",
      amount_minor: 0,
      amount_currency: "",
    };
    expect(new RuleJudge().decide("mail_item", facts, [rule]).hits).toHaveLength(1);
  });

  it("[HR-1] treats a quiet period whose start equals its end as never quiet", () => {
    const rules = ruleBookFor({
      quietHours: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "09:00", end: "09:00" }],
      quietHoursRevision: 1,
      importantSenders: [],
      importantSendersRevision: 1,
    });
    const judge = new RuleJudge();
    for (const minutes of [0, 540, 600, 1439])
      expect(
        judge.decide(
          "mail_delivery",
          {
            local_minutes: minutes,
            local_weekday: 1,
            local_previous_weekday: 0,
          },
          rules,
        ).hits,
      ).toEqual([]);
  });

  it("[HR-1] does not run a retired rule and carries the revision of the rule that hit", () => {
    const rule = importantSenderRule(["example.com"], 7);
    const facts = {
      sender_address: "a@example.com",
      sender_domain: "example.com",
      text: "",
      content_folded: "",
      text_words: [],
      content_words: [],
      money_state: "unknown",
      amount_state: "missing",
      amount_minor: 0,
      amount_currency: "",
    };
    const judge = new RuleJudge();
    expect(judge.decide("mail_item", facts, [rule]).hits).toEqual([
      { id: RULE_IDS.importantSender, revision: 7, outcome: "raise_floor" },
    ]);
    expect(judge.decide("mail_item", facts, [{ ...rule, status: "retired" }]).hits).toEqual([]);
    expect(judge.decide("mail_delivery", facts, [rule]).hits).toEqual([]);
  });

  it("[P2-2] keeps running a rule that is waiting for review and never runs a retired one", () => {
    const rule = importantSenderRule(["example.com"], 8);
    const facts = {
      sender_address: "a@example.com",
      sender_domain: "example.com",
      text: "",
      content_folded: "",
      text_words: [],
      content_words: [],
      money_state: "unknown",
      amount_state: "missing",
      amount_minor: 0,
      amount_currency: "",
    };
    const judge = new RuleJudge();
    const hits = [{ id: RULE_IDS.importantSender, revision: 8, outcome: "raise_floor" }];
    expect(judge.decide("mail_item", facts, [{ ...rule, status: "needs_review" }]).hits).toEqual(
      hits,
    );
    expect(judge.decide("mail_item", facts, [{ ...rule, status: "retired" }]).hits).toEqual([]);
    expect(ruleIsEnforced("active")).toBe(true);
    expect(ruleIsEnforced("needs_review")).toBe(true);
    expect(ruleIsEnforced("retired")).toBe(false);
  });

  it("[HR-1] never lets a user rule set the outcome of another gate: quiet hours only defer", () => {
    expect(quietHoursRule([], 1).outcome).toBe("defer_to_quiet_hours");
    expect(importantSenderRule([], 1).outcome).toBe("raise_floor");
  });

  it("[HR-2] turns a decimal string into minor units with a fixed currency table and refuses what it cannot read", () => {
    expect(toMinorUnits("1000", "JPY")).toBe(1000);
    expect(toMinorUnits("12.34", "USD")).toBe(1234);
    expect(toMinorUnits("12.3", "CNY")).toBe(1230);
    expect(toMinorUnits("1.234", "KWD")).toBe(1234);
    expect(toMinorUnits("12.345", "USD")).toBeUndefined();
    expect(toMinorUnits("1000.5", "JPY")).toBeUndefined();
    expect(toMinorUnits("5", "XYZ")).toBeUndefined();
    expect(toMinorUnits("-5", "USD")).toBeUndefined();
    expect(toMinorUnits("1,000", "USD")).toBeUndefined();
    expect(toMinorUnits("1e3", "USD")).toBeUndefined();
    expect(toMinorUnits("9".repeat(16), "USD")).toBeUndefined();
    expect(toMinorUnits(100, "USD")).toBeUndefined();
  });

  it("[HR-2] reads a model amount as known only when it is sure and the body was read in full", () => {
    const raw = { value: "100.00", currency: "cny", confidence: "sure" };
    expect(parseMailAmount(raw, true)).toEqual({ state: "known", minor: 10000, currency: "CNY" });
    expect(parseMailAmount(raw, false).state).toBe("uncertain");
    expect(parseMailAmount({ ...raw, confidence: "unsure" }, true).state).toBe("uncertain");
    expect(parseMailAmount({ ...raw, currency: "XYZ" }, true)).toEqual(MISSING_AMOUNT);
    expect(parseMailAmount({ ...raw, value: "abc" }, true)).toEqual(MISSING_AMOUNT);
    expect(parseMailAmount(undefined, true)).toEqual(MISSING_AMOUNT);
    expect(parseMailAmount("100", true)).toEqual(MISSING_AMOUNT);
    expect(parseMailAmount([], true)).toEqual(MISSING_AMOUNT);
  });

  it("[HR-2] always supplies the three amount fields, as missing when the model gave none", () => {
    expect(mailItemFacts(ITEM)).toMatchObject({
      money_state: "unknown",
      amount_state: "missing",
      amount_minor: 0,
      amount_currency: "",
    });
    expect(mailItemFacts(ITEM, { state: "known", minor: 500, currency: "JPY" })).toMatchObject({
      money_state: "unknown",
      amount_state: "known",
      amount_minor: 500,
      amount_currency: "JPY",
    });
    expect(mailItemFacts(ITEM, { state: "uncertain", minor: 500, currency: "JPY" })).toMatchObject({
      money_state: "unknown",
      amount_state: "uncertain",
      amount_minor: 0,
      amount_currency: "JPY",
    });
  });

  it("[HR-2] hits a small known amount only: boundary, other currency, unsure and missing amounts do not hit", () => {
    const rule = amountThresholdRule({ currency: "JPY", minor: 1000 }, 1, "测试");
    assertRuleExamples(rule);
    const judge = new RuleJudge();
    const hit = (amount: Parameters<typeof mailItemFacts>[1]) =>
      judge.decide("mail_item", mailItemFacts(ITEM, amount), [rule]).hits.length === 1;
    expect(hit({ state: "known", minor: 999, currency: "JPY" })).toBe(true);
    expect(hit({ state: "known", minor: 1000, currency: "JPY" })).toBe(false);
    expect(hit({ state: "known", minor: 1, currency: "USD" })).toBe(false);
    expect(hit({ state: "uncertain", minor: 1, currency: "JPY" })).toBe(false);
    expect(hit(undefined)).toBe(false);
    expect(rule.outcome).toBe("suppress_push");
  });

  it("[HR-2] refuses an outcome the gate cannot take and a threshold that cannot be built", () => {
    const rule = amountThresholdRule({ currency: "JPY", minor: 1000 }, 1, "测试");
    expect(() => assertRuleShape({ ...rule, outcome: "defer_to_quiet_hours" })).toThrow(/闸门/u);
    expect(() => assertRuleShape({ ...rule, gate: "mail_delivery" })).toThrow(/闸门/u);
    expect(() => amountThresholdRule({ currency: "XYZ", minor: 1 }, 1, "测试")).toThrow(/币种/u);
    expect(() => amountThresholdRule({ currency: "JPY", minor: -1 }, 1, "测试")).toThrow(/整数/u);
  });

  it("[HR-2] never runs a rule that reads an amount field unless the amount is known, whatever the expression says", () => {
    const rule = amountThresholdRule({ currency: "JPY", minor: 1000 }, 1, "测试");
    const judge = new RuleJudge();
    const expressions = [
      'amount_minor < 1000 || amount_state == "known"',
      'amount_state == "known" || amount_minor < 1000',
      '!(amount_state == "known" && amount_minor >= 1000)',
      'amount_state == "known" && amount_minor < 1000 || text.contains("invoice")',
      'amount_state == "uncertain"',
      'amount_state != "known"',
      'amount_state == "missing" && text.contains("Invoice")',
      "amount_state == 'uncertain'",
      'amount_currency == ""',
      "text_words.all(w, size(w) > 100) || amount_minor == 0",
    ];
    const unreadable = [
      mailItemFacts(ITEM),
      mailItemFacts(ITEM, { state: "uncertain", minor: 500, currency: "JPY" }),
    ];
    for (const expression of expressions)
      for (const facts of unreadable)
        expect(
          judge.decide("mail_item", facts, [{ ...rule, expression }]).hits,
          `${expression} ${JSON.stringify(facts)}`,
        ).toEqual([]);
    expect(
      judge.decide(
        "mail_item",
        mailItemFacts(ITEM, { state: "known", minor: 5, currency: "JPY" }),
        [
          {
            ...rule,
            expression:
              'amount_state == "known" && amount_minor < 1000 || text.contains("Invoice")',
          },
        ],
      ).hits,
    ).toHaveLength(1);
  });

  it("[HR-2] refuses an amount that only overflows after the decimals are added, and a limit with no room for an example", () => {
    expect(toMinorUnits("100000000000000.5", "KWD")).toBeUndefined();
    expect(() =>
      amountThresholdRule({ currency: "JPY", minor: Number.MAX_SAFE_INTEGER }, 1, "测试"),
    ).toThrow(/整数/u);
    expect(() =>
      assertRuleExamples(
        amountThresholdRule({ currency: "JPY", minor: Number.MAX_SAFE_INTEGER - 1 }, 1, "测试"),
      ),
    ).not.toThrow();
  });

  it("[HR-2] lists each suppressing rule once and at most sixteen times, so the decision record can always be written", () => {
    const rules = Array.from({ length: 20 }, (_, index) => ({
      ...amountThresholdRule({ currency: "JPY", minor: 1000 + index }, 1, "测试"),
      id: `suppress_small_amount_${String(index).padStart(2, "0")}`,
    }));
    const amount = { state: "known", minor: 1, currency: "JPY" } as const;
    expect(suppressPushHits(ITEM as never, amount, [...rules, ...rules])).toHaveLength(16);
    const [one] = rules as [RuleRecord];
    expect(suppressPushHits(ITEM as never, amount, [one, one])).toEqual([`${one.id}@1`]);
  });

  it("[HR-2] still runs a rule that only mentions an amount field name inside a text literal", () => {
    const rule = amountThresholdRule({ currency: "JPY", minor: 1000 }, 1, "测试");
    const facts = mailItemFacts({ ...ITEM, subject: "amount_minor amount_state" });
    for (const expression of ['text.contains("amount_minor")', "text.contains('amount_state')"])
      expect(
        new RuleJudge().decide("mail_item", facts, [{ ...rule, expression }]).hits,
        expression,
      ).toHaveLength(1);
  });
});
