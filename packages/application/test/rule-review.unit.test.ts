import { calibrationGroup } from "@himawari-agent/calibration";
import { describe, expect, it } from "vitest";
import { ruleIsEnforced } from "../src/rules/rule-book.js";
import { judgeRuleReview, parseRuleReviewAnswer } from "../src/rules/rule-review.js";
import { enforceableOwnerRule } from "../src/rules/rule-types.js";

const BOSS = {
  type: "mail_must_notify",
  summary: "老板的邮件一律提醒",
  params: { senderAddresses: ["boss@a.com"] },
};

describe("[P4-1] judgeRuleReview", () => {
  it("treats the same parameters in another order and case as the same rule", () => {
    const current = {
      ...BOSS,
      params: { senderAddresses: ["boss@a.com"], phrases: ["预算", "报销"] },
    };
    expect(
      judgeRuleReview(current, {
        standing: true,
        type: "mail_must_notify",
        summary: "换了说法",
        params: { phrases: ["报销", "预算", "预算"], senderAddresses: ["BOSS@A.COM"] },
      }),
    ).toEqual({ kind: "same" });
  });

  it("suggests the new parameters when the sender changed", () => {
    const verdict = judgeRuleReview(BOSS, {
      standing: true,
      type: "mail_must_notify",
      summary: "老板新邮箱的邮件一律提醒",
      params: { senderAddresses: ["boss@b.com"] },
    });
    expect(verdict.kind).toBe("changed");
    expect(verdict.kind === "changed" && verdict.suggestion.params.senderAddresses).toEqual([
      "boss@b.com",
    ]);
  });

  it("reports a rule the owner no longer wants", () => {
    expect(judgeRuleReview(BOSS, { standing: false })).toEqual({ kind: "not_standing" });
    expect(judgeRuleReview(BOSS, { standing: true, type: "soft" })).toEqual({
      kind: "not_standing",
    });
  });

  it("rejects malformed answers without suspending", () => {
    expect(judgeRuleReview(BOSS, "same").kind).toBe("invalid");
    expect(judgeRuleReview(BOSS, { type: "mail_must_notify" }).kind).toBe("invalid");
    expect(
      judgeRuleReview(BOSS, {
        standing: true,
        type: "mail_unknown",
        summary: "x",
        params: { senderAddresses: ["boss@b.com"] },
      }),
    ).toEqual({ kind: "invalid", reason: "RULE_TYPE_UNKNOWN" });
    expect(
      judgeRuleReview(BOSS, {
        standing: true,
        type: "mail_must_notify",
        summary: "x",
        params: { senderAddresses: [] },
      }).kind,
    ).toBe("invalid");
    expect(
      judgeRuleReview(BOSS, {
        standing: true,
        type: "mail_must_notify",
        summary: "x",
        params: { phrases: ["预算"], excludePhrases: ["预算"] },
      }).kind,
    ).toBe("invalid");
  });

  it("reads plain and fenced JSON answers", () => {
    expect(parseRuleReviewAnswer('{"standing":false}')).toEqual({ standing: false });
    expect(parseRuleReviewAnswer('```json\n{"standing":false}\n```')).toEqual({ standing: false });
    expect(() => parseRuleReviewAnswer("不是 JSON")).toThrow();
  });
});

describe("[P4-1] a suspended rule is not enforced anywhere", () => {
  const row = {
    ruleId: "owner:boss",
    revision: 3,
    source: "owner sentence",
    parameters: BOSS,
  };

  it("drops out of the enforced rules but stays readable", () => {
    expect(ruleIsEnforced("suspended")).toBe(false);
    expect(enforceableOwnerRule({ ...row, status: "suspended" })).toBeUndefined();
    expect(enforceableOwnerRule({ ...row, status: "needs_review" })?.id).toBe("owner:boss");
    expect(enforceableOwnerRule({ ...row, status: "active" })?.id).toBe("owner:boss");
  });

  it("keeps rule-review outcomes for the owner's own answers out of the daily ratings", () => {
    expect(
      calibrationGroup({
        kind: "rule_review",
        outcome: "suspended",
        ownerRating: null,
        delivered: false,
      }),
    ).toBe("rule_review");
    for (const outcome of ["owner_adopted", "owner_confirmed", "owner_restored"])
      expect(
        calibrationGroup({ kind: "rule_review", outcome, ownerRating: null, delivered: false }),
      ).toBeNull();
    expect(
      calibrationGroup({
        kind: "memory_review",
        outcome: "flagged",
        ownerRating: null,
        delivered: false,
      }),
    ).toBeNull();
  });
});
