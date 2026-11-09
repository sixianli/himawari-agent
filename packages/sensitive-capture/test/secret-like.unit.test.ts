import { describe, expect, it } from "vitest";
import { isSafeToIndex, looksLikeSecretToken } from "../src/secret-like.ts";

describe("words kept out of the search index", () => {
  it("treats long letter-digit mixes, long digit runs and very long tokens as secrets", () => {
    for (const word of [
      "x9Kq2mVb7Lp4Wz",
      "abc12345",
      "AbCdEf1234567890GhIj",
      "13800138000",
      "482910",
      "dGhpcyBpcyBhIGxvbmcgdG9rZW4",
    ])
      expect(looksLikeSecretToken(word), word).toBe(true);
  });

  it("keeps ordinary words, short numbers, product names and Chinese", () => {
    for (const word of [
      "iphone15",
      "Pixel",
      "2026",
      "1111",
      "covid19",
      "青霉素",
      "gpt-4o",
      "Hermes",
    ])
      expect(looksLikeSecretToken(word), word).toBe(false);
  });

  it("refuses a name the masking rules would change or that holds a secret-like part", () => {
    expect(isSafeToIndex("小葵")).toBe(true);
    expect(isSafeToIndex("Pixel 9")).toBe(true);
    expect(isSafeToIndex("密码：hunter22")).toBe(false);
    expect(isSafeToIndex("6222020200112233445")).toBe(false);
    expect(isSafeToIndex("备用 x9Kq2mVb7Lp4Wz")).toBe(false);
  });
});
