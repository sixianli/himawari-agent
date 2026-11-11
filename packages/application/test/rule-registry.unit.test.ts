import { describe, expect, it } from "vitest";
import { RULE_GATES } from "../src/rules/field-catalog.js";
import {
  assertRuleExamples,
  BUILT_IN_RULES,
  importantSenderRule,
  ruleIsEnforced,
  quietHoursRule,
  RULE_IDS,
  type RuleRecord,
  ruleBookFor,
} from "../src/rules/rule-book.js";
import { RuleJudge } from "../src/rules/rule-judge.js";
import { RuleExpressionError } from "../src/rules/rule-expression.js";
import { DECISION_RULE_CATALOG } from "../src/services/proactive-rules.js";

const DEFAULT_SETTINGS = {
  quietHours: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" }],
  quietHoursRevision: 0,
  importantSenders: [],
  importantSendersRevision: 0,
};

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

  it("[HR-1] keeps rule ids unique and every id the decision record can name in the registry with the same origin", () => {
    const rules = ruleBookFor(DEFAULT_SETTINGS);
    expect(new Set(rules.map(({ id }) => id)).size).toBe(rules.length);
    for (const [id, definition] of Object.entries(DECISION_RULE_CATALOG)) {
      const rule = rules.find((candidate) => candidate.id === id);
      expect(rule, id).toBeDefined();
      expect(rule?.origin).toBe(definition.origin);
    }
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
          text_words: [],
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
      text_words: [],
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
      text_words: [],
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
      text_words: [],
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
});
