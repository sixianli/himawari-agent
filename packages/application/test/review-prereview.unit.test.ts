import { REVIEW_PREREVIEW } from "@himawari-agent/prompt-catalog";
import { describe, expect, it } from "vitest";
import {
  parsePrereview,
  prereviewAuditPicked,
  prereviewPrompt,
  prereviewPromptId,
} from "../src/services/review-prereview.js";

describe("[P4-8] model prereview prompt", () => {
  const subject = { group: "memory_kept" as const, category: "preference", text: "我喜欢吃牛肉" };

  it("puts the fixed catalogue text first and this item's data last", () => {
    const prompt = prereviewPrompt(subject);
    expect(prompt.startsWith(REVIEW_PREREVIEW.text)).toBe(true);
    const data = JSON.parse(prompt.slice(REVIEW_PREREVIEW.text.length + 1));
    expect(data).toEqual({
      group: "memory_kept",
      options: ["useful", "unneeded", "unsure"],
      category: "preference",
      text: "我喜欢吃牛肉",
    });
  });

  it("gives the same bytes for the same item every time", () => {
    expect(prereviewPrompt(subject)).toBe(prereviewPrompt({ ...subject }));
  });

  it("[negative] never carries the owner's rating, even when the subject has one", () => {
    const prompt = prereviewPrompt({ ...subject, ownerRating: "unneeded" } as typeof subject);
    expect(prompt).not.toContain("ownerRating");
    expect(prompt.slice(REVIEW_PREREVIEW.text.length)).not.toContain('unneeded"}');
  });

  it("[I-129] masks a password before it reaches the model and keeps a card number", () => {
    const prompt = prereviewPrompt({
      ...subject,
      text: "密码：Qz7mWx42Lp，卡号 4111 1111 1111 1111 的账单",
    });
    expect(prompt).not.toContain("Qz7mWx42Lp");
    expect(prompt).toContain("4111 1111 1111 1111");
  });
});

describe("[P4-8] reading the model's prereview", () => {
  it("accepts a rating that applies to the group", () => {
    expect(parsePrereview('{"rating":"missed","confidence":870}', "memory_skipped")).toEqual({
      rating: "missed",
      confidencePermille: 870,
    });
    expect(parsePrereview('好的：{"rating":"unsure","confidence":300}', "memory_kept")).toEqual({
      rating: "unsure",
      confidencePermille: 0,
    });
  });

  it("[negative] rejects ratings that do not apply, bad confidence and plain text", () => {
    expect(
      parsePrereview('{"rating":"unneeded","confidence":900}', "proactive_silent"),
    ).toBeUndefined();
    expect(parsePrereview('{"rating":"useful","confidence":0.9}', "memory_kept")).toBeUndefined();
    expect(parsePrereview('{"rating":"useful","confidence":1001}', "memory_kept")).toBeUndefined();
    expect(parsePrereview('{"rating":"useful"}', "memory_kept")).toBeUndefined();
    expect(parsePrereview("有用", "memory_kept")).toBeUndefined();
    expect(parsePrereview('{"rating":"useful","confidence":900', "memory_kept")).toBeUndefined();
  });
});

describe("[P4-8] audit sample", () => {
  const keys = Array.from({ length: 5_000 }, (_, index) => `ledger:decision-${index}`);

  it("picks about the configured share, the same keys every time", () => {
    const picked = keys.filter((key) => prereviewAuditPicked("o:a", key, 200));
    expect(picked.length / keys.length).toBeGreaterThan(0.17);
    expect(picked.length / keys.length).toBeLessThan(0.23);
    expect(keys.filter((key) => prereviewAuditPicked("o:a", key, 200))).toEqual(picked);
  });

  it("picks every key at 1000 and a strict subset of the 200 pick at 100", () => {
    expect(keys.every((key) => prereviewAuditPicked("o:a", key, 1_000))).toBe(true);
    const small = new Set(keys.filter((key) => prereviewAuditPicked("o:a", key, 100)));
    const large = new Set(keys.filter((key) => prereviewAuditPicked("o:a", key, 200)));
    expect([...small].every((key) => large.has(key))).toBe(true);
  });
});

describe("[P4-8] prompt version", () => {
  const plain = (text: string) => text;

  it("covers the fixed text and the rating options offered to the model", () => {
    const id = prereviewPromptId(plain);
    expect(id.startsWith(`${REVIEW_PREREVIEW.id}@`)).toBe(true);
    const seen: string[] = [];
    prereviewPromptId((text) => {
      seen.push(text);
      return "0".repeat(64);
    });
    expect(seen[0]?.startsWith(REVIEW_PREREVIEW.text)).toBe(true);
    expect(seen[0]).toContain('["memory_kept",["useful","unneeded","unsure"]]');
  });
});
