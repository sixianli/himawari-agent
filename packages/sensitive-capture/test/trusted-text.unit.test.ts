import { describe, expect, it } from "vitest";
import { redactForEgress } from "../src/index.js";

const FIXED = "数字字段只写整数，证件号码、密码和验证码用 restricted。";

describe("trusted text in outbound redaction", () => {
  it("[I-78] keeps a keyword at the end of trusted text away from a number that starts the data", () => {
    const input = `${FIXED}{"n":"482910"}`;
    expect(redactForEgress(input, { trusted: [FIXED] }).text).toBe(input);
    expect(redactForEgress(input).text).not.toContain("482910");
  });

  it("[I-78] still masks a keyword and a code that both sit in the data", () => {
    const input = `${FIXED}{"ownerMessage":"我的验证码是 482910"}`;
    const result = redactForEgress(input, { trusted: [FIXED] });
    expect(result.text).toBe(`${FIXED}{"ownerMessage":"我的验证码是 [验证码]"}`);
    expect(result.findings).toEqual([{ kind: "verification-code", count: 1 }]);
  });

  it("[I-78] never changes the trusted text, even when it holds a value named elsewhere", () => {
    const fixed = "示例里的 482910 只是格式说明，不是任何人的真实号码。";
    const known = new Map<string, string>();
    const input = `${fixed}\n482910 是验证码`;
    const result = redactForEgress(input, {
      trusted: [fixed],
      known,
      table: new Map(),
      tag: () => "abcdefgh",
    });
    expect(result.text).toBe(`${fixed}\n[验证码#abcdefgh] 是验证码`);
  });

  it("[I-78] masks a named code in data before the trusted text as well as after it", () => {
    const input = `旧号码 482910\n${FIXED}\n482910 是验证码`;
    const result = redactForEgress(input, {
      trusted: [FIXED],
      known: new Map(),
      table: new Map(),
      tag: () => "abcdefgh",
    });
    expect(result.text).toBe(`旧号码 [验证码#abcdefgh]\n${FIXED}\n[验证码#abcdefgh] 是验证码`);
  });

  it("[I-78] picks the longest trusted text at the same place and the leftmost when two overlap", () => {
    const long = `${FIXED}以上。`;
    const input = `${long}验证码 482910`;
    expect(redactForEgress(input, { trusted: [FIXED, long] }).text).toBe(`${long}验证码 [验证码]`);
    expect(redactForEgress(input, { trusted: [long, FIXED] }).text).toBe(
      redactForEgress(input, { trusted: [FIXED, long] }).text,
    );
  });

  it("[I-78] still lets a keyword in untrusted text reach a code on the other side of trusted text", () => {
    const input = `验证码${FIXED}482910`;
    expect(redactForEgress(input, { trusted: [FIXED] }).text).toBe(`验证码${FIXED}[验证码]`);
  });

  it("[I-78] treats an empty trusted entry as nothing, and input that already holds the filler as untrusted", () => {
    expect(redactForEgress("验证码 482910", { trusted: [""] }).text).toBe("验证码 [验证码]");
    const odd = `\uFFFF${FIXED}{"n":"482910"}`;
    expect(redactForEgress(odd, { trusted: [FIXED] })).toEqual(redactForEgress(odd));
  });

  it("[I-78] does not let a private key block or a password value swallow trusted text", () => {
    const fence = (word: string) =>
      `${"-".repeat(5)}${word} ${["PRIVATE", "KEY"].join(" ")}${"-".repeat(5)}`;
    const key = `${fence("BEGIN")}\n${FIXED}\n${fence("END")}`;
    expect(redactForEgress(key, { trusted: [FIXED] }).text).toBe(key);
    const password = `密码：${FIXED}`;
    expect(redactForEgress(password, { trusted: [FIXED] }).text).toBe(password);
  });

  it("[I-78] behaves exactly as before when nothing trusted appears", () => {
    for (const input of ["验证码 482910", "你好 1000", "密码：hunter22", ""])
      expect(redactForEgress(input, { trusted: [FIXED] })).toEqual(redactForEgress(input));
  });
});
