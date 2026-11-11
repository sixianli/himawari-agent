import { describe, expect, it } from "vitest";
import { mailItemFacts } from "../src/rules/rule-book.js";
import { RuleJudge } from "../src/rules/rule-judge.js";
import {
  ownerRuleRecord,
  RULE_TYPES,
  ruleType,
  RuleTypeError,
  writableRuleType,
} from "../src/rules/rule-types.js";
import { floorHitIds, mustNotifyHitIds } from "../src/services/proactive-rules.js";

const IMMIGRATION = {
  type: "mail_must_notify",
  summary: "日本入管局相关的邮件一律提醒",
  params: {
    senderDomains: ["isa.go.jp", "MOJ.GO.JP"],
    phrases: ["出入国在留管理", "在留資格", "在留カード"],
  },
};

function record(parameters: unknown = IMMIGRATION) {
  return ownerRuleRecord({
    ruleId: "owner:abc",
    revision: 1,
    status: "active",
    source: "chat:thread-1",
    parameters,
  });
}

function item(fromAddress: string, subject: string, snippet = "") {
  return {
    messageId: "m",
    threadId: "t",
    from: fromAddress,
    fromAddress,
    subject,
    snippet,
    receivedAt: "2026-11-11T00:00:00.000Z",
    labels: [],
    categories: [],
    link: "https://mail.google.com/",
    body: null,
  } as unknown as Parameters<typeof floorHitIds>[0];
}

describe("[rule-type:mail_must_notify]", () => {
  it("is registered with a test file and requires a notification on the mail gate", () => {
    const definition = writableRuleType("mail_must_notify");
    expect(definition.gate).toBe("mail_item");
    expect(definition.outcome).toBe("require_notify");
    expect(definition.tests).toBe(
      "packages/application/test/rule-type-mail-must-notify.unit.test.ts",
    );
  });

  it("hits a subdomain of a listed sender domain and a folded phrase, misses unrelated mail", () => {
    const rule = record();
    const judge = new RuleJudge();
    const hit = (facts: ReturnType<typeof mailItemFacts>) =>
      judge.decide("mail_item", facts, [rule]).hits.length > 0;
    expect(
      hit(mailItemFacts({ fromAddress: "no-reply@mail.isa.go.jp", subject: "x", snippet: "" })),
    ).toBe(true);
    expect(hit(mailItemFacts({ fromAddress: "a@moj.go.jp", subject: "x", snippet: "" }))).toBe(
      true,
    );
    expect(
      hit(
        mailItemFacts({
          fromAddress: "office@gyosei.example",
          subject: "在留ｶｰﾄﾞの更新について",
          snippet: "",
        }),
      ),
    ).toBe(true);
    expect(
      hit(mailItemFacts({ fromAddress: "a@notisa.go.jp", subject: "Lunch", snippet: "" })),
    ).toBe(false);
    expect(
      hit(mailItemFacts({ fromAddress: "a@example.com", subject: "Weekly digest", snippet: "" })),
    ).toBe(false);
  });

  it("is reported as a notify hit with its revision and never as a floor hit", () => {
    const rule = record();
    expect(mustNotifyHitIds(item("info@isa.go.jp", "お知らせ"), [rule])).toEqual(["owner:abc@1"]);
    expect(mustNotifyHitIds(item("info@example.com", "お知らせ"), [rule])).toEqual([]);
    expect(floorHitIds(item("info@isa.go.jp", "お知らせ"), [rule])).toEqual([]);
  });

  it("matches a phrase that only appears in the body", () => {
    const rule = record();
    const mail = {
      ...item("office@gyosei.example", "ご案内"),
      body: "在留資格の更新手続きについてご連絡します",
    } as Parameters<typeof mustNotifyHitIds>[0];
    expect(mustNotifyHitIds(mail, [rule])).toEqual(["owner:abc@1"]);
  });

  it("matches English words as whole words only", () => {
    const rule = record({
      type: "mail_must_notify",
      summary: "订阅相关的必须提醒",
      params: { words: ["subscription", "renewal"], phrases: ["サブスク", "订阅"] },
    });
    const judge = new RuleJudge();
    const hits = (subject: string) =>
      judge.decide(
        "mail_item",
        mailItemFacts({ fromAddress: "a@b.example", subject, snippet: "" }),
        [rule],
      ).hits.length;
    expect(hits("Your Subscription renews tomorrow")).toBe(1);
    expect(hits("subscriptions newsletter")).toBe(0);
    expect(hits("サブスクの料金改定")).toBe(1);
    expect(hits("Lunch")).toBe(0);
  });

  it("refuses parameters it cannot enforce", () => {
    const refuse = (params: unknown) => {
      expect(() => record({ type: "mail_must_notify", summary: "s", params })).toThrow(
        RuleTypeError,
      );
    };
    refuse({});
    refuse({ senderDomains: [] });
    refuse({ senderDomains: ["not a domain"] });
    refuse({ senderAddresses: ["nobody"] });
    refuse({ words: ["two words"] });
    refuse({ phrases: ["x".repeat(65)] });
    refuse({ phrases: Array.from({ length: 33 }, (_, index) => `p${index}`) });
    refuse({ regex: [".*"] });
    refuse({ phrases: ["\ud800"] });
    expect(() =>
      record({ type: "mail_must_notify", summary: "", params: { words: ["a"] } }),
    ).toThrow(RuleTypeError);
  });

  it("generates its own examples that the judge reproduces", () => {
    const rule = record();
    expect(rule.examples.some(({ hit }) => hit)).toBe(true);
    expect(rule.examples.some(({ hit }) => !hit)).toBe(true);
  });

  it("refuses an untested type when writing and an unknown type when reading", () => {
    const untested = [{ ...ruleType("mail_must_notify"), tests: null }];
    expect(() => writableRuleType("mail_must_notify", untested)).toThrow(
      expect.objectContaining({ code: "RULE_TYPE_UNTESTED" }),
    );
    expect(() => writableRuleType("mail_unknown", RULE_TYPES)).toThrow(
      expect.objectContaining({ code: "RULE_TYPE_UNKNOWN" }),
    );
  });
});
