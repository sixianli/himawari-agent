import { describe, expect, it } from "vitest";
import {
  parseMemoryCandidates,
  quoteFromOwnerMessage,
  reminderSchedule,
} from "../src/production-memory-capture.js";

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
      parsed.rejectedCandidates.map(({ text, confidencePermille, inference }) => [
        text,
        confidencePermille,
        inference,
      ]),
    ).toEqual([["主人住在杭州", 950, false]]);
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
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]).toMatchObject({
      decision: "create",
      existingMemoryId: null,
      supersedes: "memory-phone",
    });
    expect(parsed.invalidCandidates).toBe(1);
  });

  it("[W-30] counts update, merge or supersede of a memory that does not exist as invalid instead of creating a new one", () => {
    const item = (decision: string, existingMemoryId: string | null) => ({
      kind: "durable_fact",
      decision,
      existingMemoryId,
      text: "主人现在用 Pixel 9",
      classification: "private",
      confidence: 950,
      quote: "我已经换成 Pixel 9 了",
    });
    const parse = (memories: readonly unknown[]) =>
      parseMemoryCandidates({
        output: JSON.stringify({ memories }),
        sourceRef: "payload-owner",
        sourceClassification: "private",
        existingIds: new Set(["memory-phone"]),
        ownerMessage: "我已经换成 Pixel 9 了",
      });
    const unknown = parse([
      item("update", "memory-unknown"),
      item("merge", "memory-unknown"),
      item("supersede", null),
      item("unchanged", "memory-unknown"),
    ]);
    expect(unknown.candidates).toEqual([]);
    expect(unknown.invalidCandidates).toBe(4);
    const known = parse([item("update", "memory-phone"), item("create", null)]);
    expect(known.invalidCandidates).toBe(0);
    expect(
      known.candidates.map(({ decision, existingMemoryId }) => [decision, existingMemoryId]),
    ).toEqual([
      ["update", "memory-phone"],
      ["create", null],
    ]);
  });

  it("keeps a one-off correction as a tentative rule and an explicit standing rule active", () => {
    const rule = (text: string, explicit: boolean) => ({
      kind: "decision",
      decision: "create",
      text,
      classification: "private",
      confidence: 950,
      explicit,
      category: "rule",
      importance: 800,
      quote: "以后回答都先说结论，这次也太长了",
    });
    const parsed = parseMemoryCandidates({
      output: JSON.stringify({
        memories: [rule("回答先说结论", true), rule("回答要简短", false)],
      }),
      sourceRef: "payload-owner",
      sourceClassification: "private",
      existingIds: new Set(),
      ownerMessage: "以后回答都先说结论，这次也太长了",
    });
    expect(parsed.candidates.map(({ attributes }) => attributes?.tentative)).toEqual([
      undefined,
      true,
    ]);
  });

  it("turns a local due time into a reminder an hour ahead and drops impossible dates", () => {
    const sentAt = "2026-10-25T12:00:00.000Z";
    expect(reminderSchedule("2026-10-30T15:00", "none", sentAt, "Asia/Shanghai")).toEqual({
      dueAt: "2026-10-30T07:00:00.000Z",
      remindAt: "2026-10-30T06:00:00.000Z",
      repeat: "none",
    });
    expect(reminderSchedule("2026-11-03", undefined, sentAt, "Asia/Shanghai")).toEqual({
      dueAt: "2026-11-03T01:00:00.000Z",
      remindAt: "2026-11-03T01:00:00.000Z",
      repeat: "none",
    });
    expect(reminderSchedule("2026-10-25T20:30", "none", sentAt, "Asia/Shanghai")).toEqual({
      dueAt: "2026-10-25T12:30:00.000Z",
      remindAt: sentAt,
      repeat: "none",
    });
    expect(reminderSchedule("2026-05-12", "yearly", sentAt, "Asia/Shanghai")?.dueAt).toBe(
      "2027-05-12T01:00:00.000Z",
    );
    expect(reminderSchedule("2026-10-25T19:30", "yearly", sentAt, "Asia/Shanghai")).toEqual({
      dueAt: "2027-10-25T11:30:00.000Z",
      remindAt: "2027-10-25T10:30:00.000Z",
      repeat: "yearly",
    });
    expect(reminderSchedule("1990-05-12", "yearly", sentAt, "Asia/Shanghai")).toEqual({
      dueAt: "2027-05-12T01:00:00.000Z",
      remindAt: "2027-05-12T01:00:00.000Z",
      repeat: "yearly",
    });
    expect(reminderSchedule("1826-11-01", "yearly", sentAt, "Asia/Shanghai")?.dueAt).toBe(
      "2026-11-01T01:00:00.000Z",
    );
    expect(reminderSchedule("1825-11-01", "yearly", sentAt, "Asia/Shanghai")).toBeUndefined();
    expect(reminderSchedule("2026-03-01", "yearly", sentAt, "Asia/Shanghai")).toEqual({
      dueAt: "2027-03-01T01:00:00.000Z",
      remindAt: "2027-03-01T01:00:00.000Z",
      repeat: "yearly",
    });
    expect(reminderSchedule("2026-10-01", "none", sentAt, "Asia/Shanghai")).toBeUndefined();
    expect(reminderSchedule("2030-01-01", "none", sentAt, "Asia/Shanghai")).toBeUndefined();
    expect(reminderSchedule("2026-10-30T25:00", "none", sentAt, "Asia/Shanghai")).toBeUndefined();
    expect(reminderSchedule("下周五", "none", sentAt, "Asia/Shanghai")).toBeUndefined();
    expect(reminderSchedule("2026-10-30", "none", undefined, "Asia/Shanghai")).toBeUndefined();
    const parsed = parseMemoryCandidates({
      output: JSON.stringify({
        memories: [
          {
            kind: "commitment",
            decision: "create",
            existingMemoryId: null,
            text: "主人周五下午三点要交季度报告",
            classification: "private",
            confidence: 950,
            category: "event",
            dueAt: "2026-10-30T15:00",
            quote: "周五下午三点要交季度报告",
          },
        ],
      }),
      sourceRef: "payload-1",
      sourceClassification: "private",
      existingIds: new Set(),
      ownerMessage: "我周五下午三点要交季度报告",
      sentAt,
      timeZone: "Asia/Shanghai",
    });
    expect(parsed.candidates[0]?.reminder).toEqual({
      dueAt: "2026-10-30T07:00:00.000Z",
      remindAt: "2026-10-30T06:00:00.000Z",
      repeat: "none",
    });
  });
});
