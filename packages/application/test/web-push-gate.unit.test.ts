import { describe, expect, it } from "vitest";
import { ownerRuleRecord } from "../src/rules/rule-types.js";
import { PUSH_DEFER_CAP_MS, PushGate } from "../src/services/web-push-gate.js";

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

function rule(periods: unknown, classes?: string[]) {
  return ownerRuleRecord({
    ruleId: "owner:night",
    revision: 2,
    status: "active",
    source: "test",
    parameters: {
      type: "push_quiet_hours",
      summary: "夜里别提醒我",
      params: { periods, ...(classes ? { classes } : {}) },
    },
  });
}

const NIGHT = rule([{ days: ALL_DAYS, start: "23:00", end: "07:00" }]);

describe("[HR-4] push gate", () => {
  const gate = new PushGate();
  const at = (
    now: string,
    pushClass: "run_result" | "mail_reminder" | "scheduled_reminder",
    rules = [NIGHT],
    timeZone = "Asia/Tokyo",
  ) => gate.decide({ pushClass, now, timeZone, rules });

  it("defers a 23:30 task result to 07:00 local and names the rule version", () => {
    expect(at("2026-11-11T14:30:30.000Z", "run_result")).toEqual({
      action: "defer",
      until: "2026-11-11T22:00:00.000Z",
      capped: false,
      ruleRefs: ["owner:night@2"],
    });
  });

  it("names every rule that held the push, including one that starts after the first ends", () => {
    const late = ownerRuleRecord({
      ruleId: "owner:late",
      revision: 1,
      status: "active",
      source: "test",
      parameters: {
        type: "push_quiet_hours",
        summary: "凌晨别提醒我",
        params: { periods: [{ days: ALL_DAYS, start: "02:00", end: "07:00" }] },
      },
    });
    const early = rule([{ days: ALL_DAYS, start: "23:00", end: "02:00" }]);
    const decision = at("2026-11-11T14:30:00.000Z", "run_result", [early, late]);
    expect(decision).toEqual({
      action: "defer",
      until: "2026-11-11T22:00:00.000Z",
      capped: false,
      ruleRefs: ["owner:late@1", "owner:night@2"],
    });
  });

  it("delivers outside the quiet period and the instant it ends", () => {
    expect(at("2026-11-11T03:00:00.000Z", "run_result")).toEqual({
      action: "deliver",
      failed: false,
    });
    expect(at("2026-11-11T22:00:00.000Z", "run_result")).toEqual({
      action: "deliver",
      failed: false,
    });
  });

  it("defers across a second consecutive period but caps at 24 hours", () => {
    const always = rule([
      { days: ALL_DAYS, start: "00:00", end: "23:59" },
      { days: ALL_DAYS, start: "23:59", end: "00:00" },
    ]);
    const decision = at("2026-11-11T14:30:00.000Z", "run_result", [always]);
    expect(decision.action).toBe("defer");
    if (decision.action === "defer") {
      expect(decision.capped).toBe(true);
      expect(Date.parse(decision.until) - Date.parse("2026-11-11T14:30:00.000Z")).toBe(
        PUSH_DEFER_CAP_MS,
      );
    }
  });

  it("follows the owner's time zone across a daylight-saving change", () => {
    const decision = gate.decide({
      pushClass: "mail_reminder",
      now: "2026-03-08T09:30:00.000Z",
      timeZone: "America/New_York",
      rules: [rule([{ days: ALL_DAYS, start: "01:00", end: "07:00" }])],
    });
    expect(decision).toMatchObject({ action: "defer", until: "2026-03-08T11:00:00.000Z" });
  });

  it("REVERSE: a rule whose class list does not include the push is ignored", () => {
    expect(at("2026-11-11T14:30:00.000Z", "scheduled_reminder")).toEqual({
      action: "deliver",
      failed: false,
    });
  });

  it("REVERSE: a broken rule delivers the push and reports the failure", () => {
    const broken = { ...NIGHT, expression: "nonsense(" };
    expect(at("2026-11-11T14:30:00.000Z", "run_result", [broken])).toEqual({
      action: "deliver",
      failed: true,
    });
  });
});
