import { describe, expect, it } from "vitest";
import { isSafeToIndex, looksLikeSecretToken, maskForIndex } from "../src/secret-like.ts";

describe("words kept out of the search index", () => {
  it("treats letter-digit mixes of 8 or more, long digit runs and very long tokens as secrets", () => {
    for (const word of [
      "x9Kq2mVb7Lp4Wz",
      "abc12345",
      "hunter22",
      "AbCdEf1234567890GhIj",
      "13800138000",
      "482910",
      "dGhpcyBpcyBhIGxvbmcgdG9rZW4",
      "abcd-efgh-ijkl-mnop-qrst-uvwx",
    ])
      expect(looksLikeSecretToken(word), word).toBe(true);
  });

  it("keeps ordinary words, short numbers, dates, times and Chinese", () => {
    for (const word of [
      "Pixel",
      "2026",
      "1111",
      "covid19",
      "2026-11-09",
      "14:30:00",
      "青霉素",
      "wi-fi6",
      "Hermes",
    ])
      expect(looksLikeSecretToken(word), word).toBe(false);
  });

  it("masks a password everywhere it repeats and drops whole secret-like runs before words are split", () => {
    const masked = maskForIndex(
      "网银密码是 hunter22，记不住就看 hunter22 那张纸；令牌 abcd-efgh-ijkl-mnop-qrst-uvwx；2026-11-09 去医院",
    );
    expect(masked).not.toMatch(/hunter22|abcd|uvwx/u);
    expect(masked).toContain("2026-11-09");
    expect(masked).toContain("去医院");
    expect(maskForIndex("卡号 4111 1111 1111 1111")).toBe("卡号 4111 1111 1111 1111");
    expect(maskForIndex("Wi-Fi 密码：sunflower，客人来了就告诉他 sunflower")).not.toContain(
      "sunflower",
    );
  });

  it("removes a repeated value even when its first sighting runs into punctuation or more text", () => {
    const glued = maskForIndex("Wi-Fi 密码是sunflower。客人来了就告诉他 sunflower");
    expect(glued).not.toContain("sunflower");
    expect(maskForIndex("验证码是4829。刚才念的 4829 别外传")).not.toContain("4829");
    expect(maskForIndex("password=hunter2x 之后只写 hunter2x")).not.toContain("hunter2x");
    expect(maskForIndex("密码是sunflower…后来单独写 sunflower")).not.toContain("sunflower");
    const middle = maskForIndex("密码是aaa。sunflower。bbb，客人来了就告诉他 sunflower 客人来了");
    expect(middle).not.toContain("sunflower");
    expect(middle).toContain("客人来了");
    expect(maskForIndex("密码是sunflower。客人来了 后来客人来了")).toContain("后来客人来了");
  });

  it("removes repeats only as whole words and never inside a masked placeholder", () => {
    const placeholder = maskForIndex("验证码是1111，卡号 4111 1111 1111 1111");
    expect(placeholder).toContain("[验证码]");
    expect(placeholder).toContain("卡号 4111");
    expect(placeholder).not.toMatch(/(?<!\d)1111(?!\d)/u);
    const contest = maskForIndex("密码是test，周末的 contest 别忘了");
    expect(contest).toContain("contest");
    expect(maskForIndex("备注 [x9Kq2mVb7Lp4Wz]")).not.toContain("x9Kq2mVb7Lp4Wz");
    expect(maskForIndex("Wi-Fi 密码：sunflower，备注[写 sunflower 的纸]")).not.toContain(
      "sunflower",
    );
  });

  it("refuses a name the masking rules would change or that holds a secret-like part", () => {
    expect(isSafeToIndex("小葵")).toBe(true);
    expect(isSafeToIndex("Pixel 9")).toBe(true);
    expect(isSafeToIndex("密码：hunter22")).toBe(false);
    expect(isSafeToIndex("6222020200112233445")).toBe(false);
    expect(isSafeToIndex("备用 x9Kq2mVb7Lp4Wz")).toBe(false);
    expect(isSafeToIndex("[hunter2x]")).toBe(false);
    expect(maskForIndex("密码是[sunflower]，忘了就念 sunflower")).not.toContain("sunflower");
    expect(isSafeToIndex("密码是[hunter2]")).toBe(false);
    expect(maskForIndex("密码：[由系统自动生成]，由系统自动生成")).not.toContain("由系统自动生成");
  });
});
