import { describe, expect, it } from "vitest";
import {
  BUILT_IN_RULE_VALUES,
  importantSenderRule,
  quietHoursRule,
  RULE_IDS,
  runRuleExamples,
} from "../src/rules/rule-book.js";
import { parseRuleRef, type RuleBookVersion, ruleRef } from "../src/rules/rule-ref.js";
import { describeRuleVersion, ruleKindOf } from "../src/rules/rule-version.js";
import { floorHitRefs, quietHitRefs } from "../src/services/proactive-rules.js";

function stored(
  ruleId: string,
  revision: number,
  parameters: Record<string, unknown>,
  status: RuleBookVersion["status"] = "active",
): RuleBookVersion {
  return {
    ruleId,
    revision,
    parameters,
    status,
    sourceMemoryId: null,
    changedAt: "2026-11-10T01:00:00.000Z",
  };
}

describe("[P2-7] decision records point at a rule version", () => {
  it("[P2-7] writes a rule id with its revision and reads both back, and keeps a bare id as the current version", () => {
    expect(ruleRef("floor_money_words", 1)).toBe("floor_money_words@1");
    expect(parseRuleRef("floor_money_words@1")).toEqual({
      ruleId: "floor_money_words",
      revision: 1,
    });
    expect(parseRuleRef("quiet_hours@0")).toEqual({ ruleId: "quiet_hours", revision: 0 });
    expect(parseRuleRef("floor_money_words")).toEqual({
      ruleId: "floor_money_words",
      revision: null,
    });
    expect(parseRuleRef("a@b@x")).toEqual({ ruleId: "a@b@x", revision: null });
    expect(parseRuleRef("@3")).toEqual({ ruleId: "@3", revision: null });
    expect(parseRuleRef("x@01")).toEqual({ ruleId: "x@01", revision: null });
  });

  it("[P2-7] knows only rule-book ids as rule kinds, not object prototype names or memory discard reasons", () => {
    expect(ruleKindOf(RULE_IDS.importantSender)).toBe("important_sender");
    expect(ruleKindOf(RULE_IDS.amountThreshold)).toBe("amount_threshold");
    for (const unknown of [
      "constructor",
      "toString",
      "__proto__",
      "confidence_below_threshold",
      "secret_detected",
      "",
    ])
      expect(ruleKindOf(unknown)).toBe("unknown");
  });

  it("[P2-7] shows the money rule as one the model's yes/no feeds, with its source and passing examples", () => {
    const view = describeRuleVersion({ ruleId: RULE_IDS.moneyWords, revision: 2 }, undefined);
    expect(view).toMatchObject({
      kind: "money_words",
      origin: "built_in",
      status: "active",
      current: false,
      revision: 2,
      source: "ADR 0106 第 4 条；ADR 0209；ADR 0248",
      tests: { state: "passed", failedAt: null },
    });
    expect(view.tests.total).toBeGreaterThan(1);
    expect(view.wording?.values).toEqual([]);
    expect(BUILT_IN_RULE_VALUES[RULE_IDS.moneyWords]).toBeUndefined();
  });

  it("[P2-7] REVERSE: the word-list revision 1 of the money rule is no longer in the code", () => {
    const view = describeRuleVersion({ ruleId: RULE_IDS.moneyWords, revision: 1 }, undefined);
    expect(view.wording).toBeNull();
    expect(view.tests.state).toBe("unavailable");
  });

  it("[P2-7] refuses to describe a built-in revision the code does not have", () => {
    const view = describeRuleVersion({ ruleId: RULE_IDS.publicDomain, revision: 9 }, undefined);
    expect(view.wording).toBeNull();
    expect(view.tests.state).toBe("unavailable");
  });

  it("[P2-7] rebuilds an owner rule from the stored version, with generated examples that hit and miss", () => {
    const view = describeRuleVersion(
      { ruleId: RULE_IDS.importantSender, revision: 3 },
      stored(
        RULE_IDS.importantSender,
        3,
        { senders: ["boss@corp.example", "bank.example"] },
        "needs_review",
      ),
    );
    expect(view).toMatchObject({
      kind: "important_sender",
      origin: "owner_setting",
      status: "needs_review",
      changedAt: "2026-11-10T01:00:00.000Z",
      wording: { values: ["boss@corp.example", "bank.example"] },
      tests: { state: "passed", failedAt: null },
    });
    const rule = importantSenderRule(["boss@corp.example", "bank.example"], 3);
    expect(rule.examples.some(({ hit }) => hit)).toBe(true);
    expect(rule.examples.some(({ hit }) => !hit)).toBe(true);
    expect(view.tests.total).toBe(rule.examples.length);
  });

  it("[P2-7] reports a failing example by its number when the generated expression is wrong", () => {
    const rule = importantSenderRule(["bank.example"], 2);
    expect(runRuleExamples({ ...rule, expression: "false" })).toEqual({
      total: rule.examples.length,
      failedAt: 1,
    });
    const quiet = quietHoursRule([{ days: [1], start: "23:00", end: "07:00" }], 2);
    const run = runRuleExamples({ ...quiet, expression: "true" });
    expect(run.failedAt).not.toBeNull();
  });

  it("[P2-7] generates quiet-hour examples on both sides of each period, overnight included", () => {
    for (const periods of [
      [{ days: [1], start: "23:00", end: "07:00" }],
      [{ days: [0, 6], start: "12:00", end: "13:30" }],
      [
        { days: [2], start: "00:00", end: "06:00" },
        { days: [2], start: "22:00", end: "00:00" },
      ],
      [],
    ]) {
      const rule = quietHoursRule(periods, 1);
      expect(runRuleExamples(rule).failedAt, JSON.stringify(periods)).toBeNull();
      if (periods.length > 0) {
        expect(rule.examples.some(({ hit }) => hit)).toBe(true);
        expect(rule.examples.some(({ hit }) => !hit)).toBe(true);
      }
    }
  });

  it("[P2-7] says a rule cannot be checked when its stored parameters are unreadable or the version is missing", () => {
    expect(
      describeRuleVersion(
        { ruleId: RULE_IDS.quietHours, revision: 2 },
        stored(RULE_IDS.quietHours, 2, { periods: "bad" }),
      ).tests.state,
    ).toBe("unavailable");
    const missing = describeRuleVersion(
      { ruleId: RULE_IDS.importantSender, revision: 4 },
      undefined,
    );
    expect(missing.wording).toBeNull();
    expect(missing.tests.state).toBe("unavailable");
    const unknown = describeRuleVersion({ ruleId: "no_such_rule", revision: null }, undefined);
    expect(unknown).toMatchObject({ kind: "unknown", current: false, origin: null });
  });

  it("[P2-7] names floor hits and quiet hours by id and revision", () => {
    const rules = [
      importantSenderRule(["bank.example"], 5),
      quietHoursRule([{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }], 7),
    ];
    expect(
      floorHitRefs({ m1: [RULE_IDS.importantSender], m2: [RULE_IDS.importantSender] }, rules),
    ).toEqual(["floor_important_sender@5"]);
    expect(floorHitRefs({ m1: ["floor_not_in_book"] }, rules)).toEqual(["floor_not_in_book"]);
    expect(parseRuleRef(ruleRef("x".repeat(240), 12))).toEqual({
      ruleId: "x".repeat(240),
      revision: 12,
    });
    expect(() => ruleRef("x".repeat(241), 12)).toThrow(RangeError);
    for (const id of Object.values(RULE_IDS)) expect(id.length).toBeLessThanOrEqual(240);
    expect(quietHitRefs("2026-11-10T03:00:00.000Z", rules, "Asia/Tokyo")).toEqual([
      "quiet_hours@7",
    ]);
    expect(quietHitRefs("2026-11-10T03:00:00.000Z", [quietHoursRule([], 1)], "Asia/Tokyo")).toEqual(
      [],
    );
  });
});

describe("[P2-3] a rule the owner set in one sentence shows its kind in the decision chain", () => {
  it("[P2-3] reads the owner rule's type, wording and tests from its stored version", () => {
    const view = describeRuleVersion(
      parseRuleRef("owner:immigration@1"),
      stored("owner:immigration", 1, {
        type: "mail_must_notify",
        summary: "日本入管局相关的邮件一律提醒",
        params: { senderDomains: ["isa.go.jp"] },
      }),
    );
    expect(view).toMatchObject({
      kind: "mail_must_notify",
      revision: 1,
      origin: "owner_setting",
      wording: { values: ["日本入管局相关的邮件一律提醒"] },
      tests: { state: "passed" },
    });
  });

  it("[P2-3] REVERSE: an owner rule with a type it cannot read stays unknown and untested", () => {
    const view = describeRuleVersion(
      parseRuleRef("owner:broken@1"),
      stored("owner:broken", 1, { type: "mail_unknown", summary: "x", params: {} }),
    );
    expect(view).toMatchObject({ kind: "unknown", origin: null, tests: { state: "unavailable" } });
    expect(ruleKindOf("owner:immigration")).toBe("unknown");
  });
});
