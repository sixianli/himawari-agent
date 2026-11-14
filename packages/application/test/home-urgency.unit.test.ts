import { HOME_URGENCY } from "@himawari-agent/prompt-catalog";
import { describe, expect, it } from "vitest";
import {
  acceptsHomeAffirmLabel,
  DEFAULT_HOME_URGENCY,
  type HomeUrgencyCandidate,
  homeUrgencyPrompt,
  homeUrgencyPromptId,
  parseHomeUrgency,
} from "../src/services/home-urgency.js";

const mail: HomeUrgencyCandidate = {
  key: "insight:1",
  kind: "heads_up",
  deadline: "2026-11-12T03:00:00.000Z",
  dataClassification: "private",
  digestBasis: "田中把会改到 15:00",
  facts: { text: "田中把会改到 15:00", source: "gmail" },
};
const approval: HomeUrgencyCandidate = {
  key: "approval:9",
  kind: "approval",
  deadline: null,
  dataClassification: "private",
  digestBasis: "hash-9",
  facts: { operation: "send", recipients: ["tanaka@example.com"], capability: "mail" },
  approvalRequestId: "9",
};
const base = {
  now: "2026-11-12T01:00:00.000Z",
  timeZone: "Asia/Tokyo",
  locale: "zh-CN",
  affirmMax: 6,
};

function sections(prompt: string) {
  const lines = prompt.slice(HOME_URGENCY.text.length + 1).split("\n");
  return {
    reference: JSON.parse(lines[1] as string) as Record<string, unknown>[],
    fresh: JSON.parse(lines[3] as string) as Record<string, unknown>[],
    last: JSON.parse(lines[4] as string) as Record<string, unknown>,
    lines,
  };
}

describe("[home-urgency] scoring prompt", () => {
  it("puts the fixed text first, then scored items, then new items, and the time last", () => {
    const prompt = homeUrgencyPrompt({
      ...base,
      reference: [{ candidate: mail, disclosed: true, score: 700 }],
      fresh: [{ candidate: approval, disclosed: true }],
    });
    expect(prompt.startsWith(`${HOME_URGENCY.text}\n参照：\n`)).toBe(true);
    const { reference, fresh, last, lines } = sections(prompt);
    expect(lines).toHaveLength(5);
    expect(reference).toEqual([
      {
        score: 700,
        kind: "heads_up",
        deadline: "2026-11-12T03:00:00.000Z",
        facts: { source: "gmail", text: "田中把会改到 15:00" },
      },
    ]);
    expect(fresh).toEqual([
      {
        n: 1,
        kind: "approval",
        deadline: null,
        facts: { capability: "mail", operation: "send", recipients: ["tanaka@example.com"] },
        copy: true,
      },
    ]);
    expect(last).toEqual({
      now: base.now,
      timeZone: "Asia/Tokyo",
      language: "zh-CN",
      affirmMax: 6,
    });
  });

  it("gives the same bytes whatever order the facts were built in", () => {
    const reordered = {
      ...approval,
      facts: { capability: "mail", recipients: ["tanaka@example.com"], operation: "send" },
    };
    const one = homeUrgencyPrompt({
      ...base,
      reference: [],
      fresh: [{ candidate: approval, disclosed: true }],
    });
    const two = homeUrgencyPrompt({
      ...base,
      reference: [],
      fresh: [{ candidate: reordered, disclosed: true }],
    });
    expect(one).toBe(two);
  });

  it("only the last line changes when the time changes", () => {
    const input = { reference: [], fresh: [{ candidate: mail, disclosed: true }] };
    const one = homeUrgencyPrompt({ ...base, ...input });
    const two = homeUrgencyPrompt({ ...base, ...input, now: "2026-11-12T02:00:00.000Z" });
    expect(one.slice(0, one.lastIndexOf("\n"))).toBe(two.slice(0, two.lastIndexOf("\n")));
    expect(one).not.toBe(two);
  });

  it("[negative] sends only the kind and deadline of an item the model may not read, and asks for no wording", () => {
    const secret = { ...approval, facts: { operation: "绝密操作" } };
    const prompt = homeUrgencyPrompt({
      ...base,
      reference: [
        { candidate: { ...mail, facts: { text: "绝密邮件" } }, disclosed: false, score: 1 },
      ],
      fresh: [{ candidate: secret, disclosed: false }],
    });
    expect(prompt).not.toContain("绝密");
    const { reference, fresh } = sections(prompt);
    expect(reference).toEqual([
      { score: 1, kind: "heads_up", deadline: "2026-11-12T03:00:00.000Z" },
    ]);
    expect(fresh).toEqual([{ n: 1, kind: "approval", deadline: null }]);
  });

  it("masks a card number inside nested facts before it reaches the model", () => {
    const prompt = homeUrgencyPrompt({
      ...base,
      reference: [],
      fresh: [
        {
          candidate: { ...mail, facts: { detail: { lines: ["卡号 4111 1111 1111 1111 的账单"] } } },
          disclosed: true,
        },
      ],
    });
    expect(prompt).not.toContain("4111 1111 1111 1111");
  });

  it("changes the prompt id when the fixed text changes", () => {
    const id = homeUrgencyPromptId((text) => `${text.length}`.padStart(12, "0"));
    expect(id).toBe(`home.urgency@${`${HOME_URGENCY.text.length}`.padStart(12, "0")}`);
  });
});

describe("[home-urgency] reading the model's reply", () => {
  it("reads a score, a sentence and a button label per numbered item", () => {
    const replies = parseHomeUrgency(
      '好的 {"items":[{"n":1,"score":640,"sentence":"给田中发确认邮件","affirm":"发出去"},{"n":2,"score":0}]}',
      2,
    );
    expect(replies.get(1)).toEqual({ score: 640, sentence: "给田中发确认邮件", affirm: "发出去" });
    expect(replies.get(2)).toEqual({ score: 0, sentence: null, affirm: null });
  });

  it("[negative] drops invented numbers, repeats, and scores outside 0 to 1000", () => {
    const replies = parseHomeUrgency(
      JSON.stringify({
        items: [
          { n: 1, score: 500 },
          { n: 1, score: 900 },
          { n: 3, score: 100 },
          { n: 0, score: 100 },
          { n: 2, score: 1001 },
          { n: 2.5, score: 10 },
          "junk",
        ],
      }),
      2,
    );
    expect([...replies.entries()]).toEqual([[1, { score: 500, sentence: null, affirm: null }]]);
  });

  it("[negative] returns nothing for empty, non-JSON or wrongly shaped output", () => {
    for (const output of ["", "no json", "{bad", "[]", '{"items":{}}', '{"items":"x"}'])
      expect(parseHomeUrgency(output, 3).size).toBe(0);
  });

  it("[negative] keeps the score but drops wording that is empty, multi-line or too long", () => {
    const replies = parseHomeUrgency(
      JSON.stringify({
        items: [
          { n: 1, score: 1, sentence: "  ", affirm: "a\nb" },
          { n: 2, score: 2, sentence: "x".repeat(401), affirm: "y".repeat(65) },
          { n: 3, score: 3, sentence: 7, affirm: { text: "x" } },
        ],
      }),
      3,
    );
    for (const n of [1, 2, 3])
      expect(replies.get(n)).toEqual({ score: n, sentence: null, affirm: null });
  });
});

describe("[home-urgency] accepting a model-written button label", () => {
  const limits = DEFAULT_HOME_URGENCY.affirmLabelMax;
  const accept = (label: string | null, locale: string, negativeLabel = "不同意") =>
    acceptsHomeAffirmLabel({ label, locale, limits, negativeLabel });

  it("accepts a label exactly at the limit of each language", () => {
    expect(accept("改到九点四十", "zh-CN")).toBe(true);
    expect(accept("九時四十分に変更", "ja", "同意しない")).toBe(true);
    expect(accept("Move it to 09:40", "en", "Decline")).toBe(true);
  });

  it("[negative] rejects a label that has no visible character", () => {
    expect(accept("\u200B", "zh-CN")).toBe(false);
    expect(accept("\u2060\u200D", "en", "Decline")).toBe(false);
    expect(accept("\u3164", "zh-CN")).toBe(false);
    expect(accept("\u2800", "zh-CN")).toBe(false);
    expect(accept("\uFE0F", "zh-CN")).toBe(false);
    expect(accept("发出去👨‍👩‍👧", "zh-CN")).toBe(true);
  });

  it("[negative] rejects a label one character over the limit of each language", () => {
    expect(accept("改到九点四十分", "zh-CN")).toBe(false);
    expect(accept("九時四十分に変更だ", "ja", "同意しない")).toBe(false);
    expect(accept("Move it to 09:40!", "en", "Decline")).toBe(false);
  });

  it("[negative] rejects a missing label, an untrimmed one, the negative wording, and an unknown language", () => {
    expect(accept(null, "zh-CN")).toBe(false);
    expect(accept(" 发出去", "zh-CN")).toBe(false);
    expect(accept("不同意", "zh-CN")).toBe(false);
    expect(accept("decline", "en", "Decline")).toBe(false);
    expect(accept("发出去", "fr")).toBe(false);
  });

  it("counts an emoji sequence as one character", () => {
    expect(accept("发出去👨‍👩‍👧", "zh-CN")).toBe(true);
  });

  it("[negative] rejects a label carrying a direction override, here or in the model's reply", () => {
    for (const mark of ["\u202E", "\u2067", "\u200F", "\u061C"]) {
      expect(accept(`发${mark}出去`, "zh-CN")).toBe(false);
      expect(
        parseHomeUrgency(
          JSON.stringify({ items: [{ n: 1, score: 1, affirm: `发${mark}出去` }] }),
          1,
        ).get(1)?.affirm,
      ).toBeNull();
    }
  });
});
