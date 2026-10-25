import { describe, expect, it } from "vitest";
import { parseMemoryCandidates, quoteFromOwnerMessage } from "../src/production-memory-capture.js";

describe("memory evidence from the Owner's own words", () => {
  it("accepts a verbatim quote regardless of spacing, punctuation and width", () => {
    const message = "请记住，我最喜欢的颜色是蓝色。另外我女儿叫小葵。";
    expect(quoteFromOwnerMessage("我最喜欢的颜色是蓝色", message)).toBe(true);
    expect(quoteFromOwnerMessage("“我 最喜欢的颜色，是蓝色”", message)).toBe(true);
    expect(quoteFromOwnerMessage("我叫ANDY", "我叫 Ａｎｄｙ")).toBe(true);
  });

  it("rejects paraphrases, inventions and fragments that are too short", () => {
    const message = "请记住，我最喜欢的颜色是蓝色。另外我女儿叫小葵。";
    expect(quoteFromOwnerMessage("我喜欢蓝色", message)).toBe(false);
    expect(quoteFromOwnerMessage("我住在杭州西湖边上", message)).toBe(false);
    expect(quoteFromOwnerMessage("蓝色", message)).toBe(false);
    expect(quoteFromOwnerMessage("", "绿色")).toBe(false);
    expect(quoteFromOwnerMessage("绿色", "绿色")).toBe(true);
  });

  it("keeps verified candidates with their attributes and counts the rest", () => {
    const parsed = parseMemoryCandidates({
      output: JSON.stringify({
        memories: [
          {
            kind: "durable_fact",
            decision: "create",
            text: "主人的女儿叫小葵",
            classification: "private",
            confidence: 950,
            category: "relationship",
            importance: 1200,
            entities: ["小葵", "小葵", " ", "Ｈｅｒｍｅｓ"],
            validFrom: "2026-11-01",
            quote: "另外我女儿叫小葵",
          },
          {
            kind: "durable_fact",
            decision: "create",
            text: "主人住在杭州",
            classification: "private",
            confidence: 950,
            quote: "我住在杭州",
          },
          {
            kind: "durable_fact",
            decision: "create",
            text: "主人的银行卡号是 6222020200112233445",
            classification: "restricted",
            confidence: 990,
          },
        ],
      }),
      sourceRef: "payload-owner",
      sourceClassification: "private",
      existingIds: new Set(),
      ownerMessage: "请记住，我最喜欢的颜色是蓝色。另外我女儿叫小葵。",
    });
    expect(parsed.unverifiedEvidence).toBe(1);
    expect(
      parsed.candidates.map(({ text, dataClassification }) => [text, dataClassification]),
    ).toEqual([
      ["主人的女儿叫小葵", "private"],
      ["主人的银行卡号是 6222020200112233445", "restricted"],
    ]);
    expect(parsed.candidates[0]?.attributes).toEqual({
      category: "relationship",
      importancePermille: 1000,
      entities: ["小葵", "Hermes"],
      validFrom: "2026-11-01",
      validTo: null,
      supersededBy: null,
      evidenceVerified: true,
    });
  });
  it("turns a changed fact into a new memory that supersedes the old one", () => {
    const parsed = parseMemoryCandidates({
      output: JSON.stringify({
        memories: [
          {
            kind: "durable_fact",
            decision: "supersede",
            existingMemoryId: "memory-phone",
            text: "主人现在用 Pixel 9",
            classification: "private",
            confidence: 950,
            category: "preference",
            importance: 500,
            entities: ["Pixel 9"],
            validFrom: null,
            quote: "我已经换成 Pixel 9 了",
          },
          {
            kind: "durable_fact",
            decision: "supersede",
            existingMemoryId: "memory-unknown",
            text: "主人现在住在杭州",
            classification: "private",
            confidence: 950,
            quote: "我已经换成 Pixel 9 了",
          },
        ],
      }),
      sourceRef: "payload-owner",
      sourceClassification: "private",
      existingIds: new Set(["memory-phone"]),
      ownerMessage: "我已经换成 Pixel 9 了",
    });
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[0]).toMatchObject({
      decision: "create",
      existingMemoryId: null,
      supersedes: "memory-phone",
    });
    expect(parsed.candidates[1]).toMatchObject({ decision: "create", existingMemoryId: null });
    expect(parsed.candidates[1]).not.toHaveProperty("supersedes");
  });
});
