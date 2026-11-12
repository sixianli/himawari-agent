import { describe, expect, it } from "vitest";
import { RuleJudge } from "../src/rules/rule-judge.js";
import {
  enforceableOwnerRule,
  ownerRuleRecord,
  parseOwnerRuleParameters,
  unreadablePushRule,
} from "../src/rules/rule-types.js";
import { PushGate, pushDeliveryFacts } from "../src/services/web-push-gate.js";

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const BASE = {
  type: "push_quiet_hours",
  summary: "今晚别提醒我",
  params: { periods: [{ days: ALL_DAYS, start: "23:00", end: "07:00" }] },
};

function row(parameters: unknown) {
  return {
    ruleId: "owner:night",
    revision: 1,
    status: "active" as const,
    source: "chat:thread-1",
    parameters,
  };
}

describe("[RS-1] rule expiry", () => {
  it("normalizes the expiry to UTC and keeps the record readable after it passes", () => {
    const parameters = { ...BASE, expiresAt: "2026-11-12T07:00:00+09:00" };
    expect(parseOwnerRuleParameters(parameters).expiresAt).toBe("2026-11-11T22:00:00.000Z");
    expect(ownerRuleRecord(row(parameters)).expiresAt).toBe("2026-11-11T22:00:00.000Z");
    expect(ownerRuleRecord(row(BASE)).expiresAt).toBeNull();
    expect(unreadablePushRule(row(parameters))).toBe(false);
  });

  it("rejects unknown top-level keys and malformed expiries", () => {
    expect(() => parseOwnerRuleParameters({ ...BASE, sneaky: true })).toThrow();
    expect(() => parseOwnerRuleParameters({ ...BASE, expiresAt: "tomorrow" })).toThrow();
    expect(() => parseOwnerRuleParameters({ ...BASE, expiresAt: "2026-11-12T07:00" })).toThrow();
    expect(() => parseOwnerRuleParameters({ ...BASE, expiresAt: 5 })).toThrow();
  });

  it("stops enforcing at the expiry instant, not before", () => {
    const parameters = { ...BASE, expiresAt: "2026-11-11T22:00:00.000Z" };
    expect(
      enforceableOwnerRule(row(parameters), undefined, "2026-11-11T21:59:59.000Z"),
    ).toBeDefined();
    expect(
      enforceableOwnerRule(row(parameters), undefined, "2026-11-11T22:00:00.000Z"),
    ).toBeUndefined();
    expect(enforceableOwnerRule(row(parameters))).toBeDefined();
    expect(enforceableOwnerRule(row(BASE), undefined, "2030-01-01T00:00:00.000Z")).toBeDefined();
  });

  it("lets the judge skip an expired rule when given the instant", () => {
    const rule = ownerRuleRecord(row({ ...BASE, expiresAt: "2026-11-11T22:00:00.000Z" }));
    const facts = pushDeliveryFacts("run_result", "2026-11-11T16:00:00.000Z", "Asia/Tokyo");
    const judge = new RuleJudge();
    expect(
      judge.decide("push_delivery", facts, [rule], "2026-11-11T16:00:00.000Z").hits,
    ).toHaveLength(1);
    expect(
      judge.decide("push_delivery", facts, [rule], "2026-11-11T22:00:00.000Z").hits,
    ).toHaveLength(0);
  });

  it("releases a push at the expiry minute when the rule ends before the quiet period does", () => {
    const rule = ownerRuleRecord(row({ ...BASE, expiresAt: "2026-11-11T21:30:00.000Z" }));
    const decision = new PushGate().decide({
      pushClass: "run_result",
      now: "2026-11-11T14:30:30.000Z",
      timeZone: "Asia/Tokyo",
      rules: [rule],
    });
    expect(decision).toMatchObject({ action: "defer", until: "2026-11-11T21:30:00.000Z" });
    expect(
      new PushGate().decide({
        pushClass: "run_result",
        now: "2026-11-11T21:30:00.000Z",
        timeZone: "Asia/Tokyo",
        rules: [rule],
      }),
    ).toEqual({ action: "deliver", failed: false });
  });
});
