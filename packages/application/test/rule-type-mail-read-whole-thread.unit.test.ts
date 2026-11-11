import { describe, expect, it } from "vitest";
import { mailItemFacts } from "../src/rules/rule-book.js";
import { RuleJudge } from "../src/rules/rule-judge.js";
import { ownerRuleRecord, RuleTypeError, writableRuleType } from "../src/rules/rule-types.js";
import {
  floorHitIds,
  mustNotifyHitIds,
  wholeThreadHitIds,
} from "../src/services/proactive-rules.js";

const REFUND = {
  type: "mail_read_whole_thread",
  summary: "涉及退款的邮件先读完整个邮件串再判断",
  params: {
    phrases: ["退款", "返金", "払い戻し", "退货"],
    words: ["refund", "refunded", "chargeback"],
  },
};

function record(parameters: unknown = REFUND, status: "active" | "needs_review" = "active") {
  return ownerRuleRecord({
    ruleId: "owner:refund",
    revision: 2,
    status,
    source: "chat:thread-1",
    parameters,
  });
}

function item(subject: string, body: string | null = null, fromAddress = "shop@example.com") {
  return {
    messageId: "m",
    threadId: "t",
    from: fromAddress,
    fromAddress,
    subject,
    snippet: "",
    receivedAt: "2026-11-11T00:00:00.000Z",
    labels: [],
    categories: [],
    link: "https://mail.google.com/",
    body,
  } as unknown as Parameters<typeof wholeThreadHitIds>[0];
}

describe("[rule-type:mail_read_whole_thread]", () => {
  it("is registered with a test file and asks for the whole thread on the mail gate", () => {
    const definition = writableRuleType("mail_read_whole_thread");
    expect(definition.gate).toBe("mail_item");
    expect(definition.outcome).toBe("require_whole_thread");
    expect(definition.tests).toBe(
      "packages/application/test/rule-type-mail-read-whole-thread.unit.test.ts",
    );
  });

  it("hits refund wording in Chinese, Japanese and English, in the subject or only in the body", () => {
    const rule = record();
    expect(wholeThreadHitIds(item("返金のご案内"), [rule])).toEqual(["owner:refund@2"]);
    expect(wholeThreadHitIds(item("Your order", "We have refunded $12."), [rule])).toEqual([
      "owner:refund@2",
    ]);
    expect(wholeThreadHitIds(item("关于订单", "已为您办理退款"), [rule])).toEqual([
      "owner:refund@2",
    ]);
    expect(wholeThreadHitIds(item("Weekly digest", "nothing here"), [rule])).toEqual([]);
    expect(wholeThreadHitIds(item("Refundable deposit info"), [rule])).toEqual([]);
  });

  it("is reported only as a whole-thread hit, never as a notify or floor hit", () => {
    const rule = record();
    const mail = item("返金のご案内");
    expect(mustNotifyHitIds(mail, [rule])).toEqual([]);
    expect(floorHitIds(mail, [rule])).toEqual([]);
  });

  it("keeps enforcing a rule that waits for review", () => {
    const rule = record(REFUND, "needs_review");
    expect(wholeThreadHitIds(item("返金のご案内"), [rule])).toEqual(["owner:refund@2"]);
  });

  it("skips mail that contains an excluded phrase", () => {
    const rule = record({
      ...REFUND,
      params: { ...REFUND.params, excludePhrases: ["newsletter"] },
    });
    expect(wholeThreadHitIds(item("返金のご案内"), [rule])).toEqual(["owner:refund@2"]);
    expect(wholeThreadHitIds(item("Newsletter: 返金特集"), [rule])).toEqual([]);
    expect(rule.examples.filter(({ hit }) => !hit).length).toBeGreaterThanOrEqual(2);
  });

  it("refuses an exclusion that cancels every hit and phrases too short to mean anything", () => {
    expect(() =>
      record({ ...REFUND, params: { phrases: ["返金"], excludePhrases: ["返金"] } }),
    ).toThrow(RuleTypeError);
    expect(() => record({ ...REFUND, params: { phrases: ["退"] } })).toThrow(RuleTypeError);
    expect(() => record({ ...REFUND, params: { phrases: ["返‮金"] } })).toThrow(RuleTypeError);
  });

  it("matches the same mail the judge sees through the generated expression", () => {
    const rule = record();
    const judge = new RuleJudge();
    const facts = mailItemFacts({
      fromAddress: "a@b.example",
      subject: "ﾍﾝｷﾝ",
      snippet: "払い戻し",
    });
    expect(judge.decide("mail_item", facts, [rule]).hits).toEqual([
      expect.objectContaining({ id: "owner:refund", outcome: "require_whole_thread" }),
    ]);
  });
});
