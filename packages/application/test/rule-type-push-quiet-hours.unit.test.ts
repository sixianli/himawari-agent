import { describe, expect, it } from "vitest";
import { assertRuleExamples } from "../src/rules/rule-book.js";
import { RuleJudge } from "../src/rules/rule-judge.js";
import {
  ownerRuleRecord,
  parseOwnerRuleParameters,
  RuleTypeError,
  unreadablePushRule,
  writableRuleType,
} from "../src/rules/rule-types.js";
import { PushGate, pushClassOf, pushDeliveryFacts } from "../src/services/web-push-gate.js";

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const NIGHT = {
  type: "push_quiet_hours",
  summary: "夜里 23 点到早上 7 点，任务完成和邮件提醒等到早上再推",
  params: { periods: [{ days: ALL_DAYS, start: "23:00", end: "07:00" }] },
};

function record(parameters: unknown = NIGHT) {
  return ownerRuleRecord({
    ruleId: "owner:night",
    revision: 3,
    status: "active",
    source: "chat:thread-1",
    parameters,
  });
}

function judge(pushClass: string, at: string, rule = record()) {
  return new RuleJudge().decide(
    "push_delivery",
    pushDeliveryFacts(pushClass as never, at, "Asia/Tokyo"),
    [rule],
  );
}

describe("[rule-type:push_quiet_hours]", () => {
  it("is registered with a test file and defers on the push gate", () => {
    const definition = writableRuleType("push_quiet_hours");
    expect(definition.gate).toBe("push_delivery");
    expect(definition.outcome).toBe("defer_to_quiet_hours");
    expect(definition.tests).toBe(
      "packages/application/test/rule-type-push-quiet-hours.unit.test.ts",
    );
  });

  it("defaults to run results and mail reminders, and its own examples reproduce under the judge", () => {
    const rule = record();
    assertRuleExamples(rule);
    expect(rule.examples.some(({ hit }) => hit)).toBe(true);
    expect(rule.examples.some(({ hit }) => !hit)).toBe(true);
    expect(judge("run_result", "2026-11-11T14:30:00.000Z").hits).toHaveLength(1);
    expect(judge("mail_reminder", "2026-11-11T14:30:00.000Z").hits).toHaveLength(1);
    expect(judge("scheduled_reminder", "2026-11-11T14:30:00.000Z").hits).toHaveLength(0);
  });

  it("includes the owner's own scheduled reminders only when the owner asks for them", () => {
    const rule = record({
      ...NIGHT,
      params: { ...NIGHT.params, classes: ["scheduled_reminder"] },
    });
    assertRuleExamples(rule);
    expect(judge("scheduled_reminder", "2026-11-11T14:30:00.000Z", rule).hits).toHaveLength(1);
    expect(judge("run_result", "2026-11-11T14:30:00.000Z", rule).hits).toHaveLength(0);
  });

  it("uses the quiet period start inclusive and end exclusive across midnight", () => {
    expect(judge("run_result", "2026-11-11T13:59:00.000Z").hits).toHaveLength(0);
    expect(judge("run_result", "2026-11-11T14:00:00.000Z").hits).toHaveLength(1);
    expect(judge("run_result", "2026-11-11T21:59:00.000Z").hits).toHaveLength(1);
    expect(judge("run_result", "2026-11-11T22:00:00.000Z").hits).toHaveLength(0);
  });

  it("REVERSE: approvals and Muse outages are never handed to rules, even by a rule that names them", () => {
    const rule = ownerRuleRecord({
      ruleId: "owner:hostile",
      revision: 1,
      status: "active",
      source: "test",
      parameters: NIGHT,
    });
    const hostile = {
      ...rule,
      expression: 'push_class == "approval" || push_class == "muse_outage"',
    };
    const gate = new PushGate();
    for (const pushClass of ["approval", "muse_outage", "unknown"] as const)
      expect(
        gate.decide({
          pushClass,
          now: "2026-11-11T14:30:00.000Z",
          timeZone: "Asia/Tokyo",
          rules: [hostile],
        }),
      ).toEqual({ action: "deliver", failed: false });
    expect(pushClassOf({ kind: "approval", sourceKey: "approval:a1" })).toBe("approval");
    expect(pushClassOf({ kind: "reminder", sourceKey: "muse-channel:2026" })).toBe("muse_outage");
    expect(pushClassOf({ kind: "reminder", sourceKey: "something:else" })).toBe("unknown");
    expect(pushClassOf({ kind: "reminder", sourceKey: "said:7:message3:m-11:1" })).toBe(
      "her_words",
    );
    expect(pushClassOf({ kind: "run", sourceKey: "said:7:message3:m-11:1" })).toBe("unknown");
  });

  it.each([
    ["no periods", { periods: [] }],
    ["start equals end", { periods: [{ days: ALL_DAYS, start: "07:00", end: "07:00" }] }],
    ["bad clock", { periods: [{ days: ALL_DAYS, start: "25:00", end: "07:00" }] }],
    ["bad weekday", { periods: [{ days: [7], start: "23:00", end: "07:00" }] }],
    [
      "approval as a class",
      { periods: [{ days: ALL_DAYS, start: "23:00", end: "07:00" }], classes: ["approval"] },
    ],
    ["unknown key", { periods: [{ days: ALL_DAYS, start: "23:00", end: "07:00" }], extra: 1 }],
  ])("REVERSE: rejects %s", (_name, params) => {
    expect(() => record({ ...NIGHT, params })).toThrow(RuleTypeError);
  });

  it("refuses day and class lists longer than the real ones", () => {
    const longDays = {
      periods: [{ days: [0, 1, 2, 3, 4, 5, 6, 0], start: "23:00", end: "07:00" }],
    };
    expect(() => record({ ...NIGHT, params: longDays })).toThrow(RuleTypeError);
    const longClasses = {
      ...NIGHT.params,
      classes: ["run_result", "mail_reminder", "scheduled_reminder", "her_words", "run_result"],
    };
    expect(() => record({ ...NIGHT, params: longClasses })).toThrow(RuleTypeError);
  });

  it("[SAID-2] keeps her words quiet by default and stores a rule that names every class", () => {
    const night = "2026-11-11T14:30:00.000Z";
    expect(judge("her_words", night).hits).toHaveLength(1);
    const every = record({
      ...NIGHT,
      params: {
        ...NIGHT.params,
        classes: ["her_words", "scheduled_reminder", "mail_reminder", "run_result"],
      },
    });
    assertRuleExamples(every);
    for (const pushClass of ["her_words", "scheduled_reminder", "mail_reminder", "run_result"])
      expect(judge(pushClass, night, every).hits).toHaveLength(1);
    const storedBefore = record({
      ...NIGHT,
      params: { ...NIGHT.params, classes: ["mail_reminder", "run_result"] },
    });
    expect(judge("her_words", night, storedBefore).hits).toHaveLength(1);
    const remindersOnly = record({
      ...NIGHT,
      params: { ...NIGHT.params, classes: ["scheduled_reminder", "mail_reminder"] },
    });
    expect(judge("her_words", night, remindersOnly).hits).toHaveLength(0);
  });

  it("[SAID-2] stores a rule that names no classes without classes, so it keeps following the default list", () => {
    const parsed = parseOwnerRuleParameters(NIGHT);
    expect(JSON.parse(JSON.stringify(parsed.params))).toEqual(NIGHT.params);
    const stored = record(
      JSON.parse(
        JSON.stringify({ type: parsed.type, params: parsed.params, summary: parsed.summary }),
      ),
    );
    expect(judge("her_words", "2026-11-11T14:30:00.000Z", stored).hits).toHaveLength(1);
    const named = parseOwnerRuleParameters({
      ...NIGHT,
      params: { ...NIGHT.params, classes: ["run_result", "mail_reminder"] },
    });
    expect(named.params).toMatchObject({ classes: ["run_result", "mail_reminder"] });
  });

  it("[HR-4] tells a stored push rule it cannot read from a healthy one, a retired one and a mail rule", () => {
    const row = (parameters: unknown, status: "active" | "retired" = "active") => ({
      ruleId: "owner:night",
      revision: 1,
      status,
      source: "chat:thread-1",
      parameters,
    });
    expect(unreadablePushRule(row(NIGHT))).toBe(false);
    expect(
      unreadablePushRule(
        row({ ...NIGHT, params: { periods: [{ days: [0], start: "25:00", end: "07:00" }] } }),
      ),
    ).toBe(true);
    expect(unreadablePushRule(row({ ...NIGHT, params: { periods: [] } }, "retired"))).toBe(false);
    expect(
      unreadablePushRule(row({ type: "mail_must_notify", summary: "x", params: { phrases: [] } })),
    ).toBe(false);
    expect(unreadablePushRule(row("not an object"))).toBe(false);
    expect(
      unreadablePushRule(
        row({ type: "push_quiet_hourz", summary: "push_quiet_hours", params: {} }),
      ),
    ).toBe(true);
    expect(unreadablePushRule(row("push_quiet_hours 坏了"))).toBe(true);
    expect(unreadablePushRule(row({ type: "push_quiet_hour", summary: "夜里", params: {} }))).toBe(
      true,
    );
    expect(
      unreadablePushRule(
        row({ type: "mail_must_notify", summary: "mail", params: { phrases: [] } }),
      ),
    ).toBe(false);
  });
});
