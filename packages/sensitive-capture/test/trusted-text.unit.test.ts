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

  it("[I-78] picks the longest trusted text at the same place, whatever the order of the list", () => {
    const long = `${FIXED}验证码 482910`;
    expect(redactForEgress(long, { trusted: [FIXED, long] }).text).toBe(long);
    expect(redactForEgress(long, { trusted: [long, FIXED] }).text).toBe(long);
    expect(redactForEgress(long, { trusted: [FIXED] }).text).toBe(`${FIXED}验证码 [验证码]`);
  });

  it("[I-78] still lets a keyword in untrusted text reach a code on the other side of trusted text", () => {
    const input = `验证码${FIXED}482910`;
    expect(redactForEgress(input, { trusted: [FIXED] }).text).toBe(`验证码${FIXED}[验证码]`);
  });

  it("[I-78] treats an empty trusted entry as nothing, and picks a filler the input does not already hold", () => {
    expect(redactForEgress("验证码 482910", { trusted: [""] }).text).toBe("验证码 [验证码]");
    const odd = `\uFFFF\uFFFE${FIXED}{"n":"482910"}`;
    expect(redactForEgress(odd, { trusted: [FIXED] }).text).toBe(odd);
    const crowded = [
      "\uFFFF",
      "\uFFFE",
      ...Array.from({ length: 32 }, (_, index) => String.fromCharCode(0xfdd0 + index)),
    ].join("");
    const full = `${crowded}${FIXED}{"n":"482910"}`;
    expect(redactForEgress(full, { trusted: [FIXED] })).toEqual(redactForEgress(full));
  });

  it("[I-78] falls back to checking everything when a rule would run into trusted text", () => {
    const fence = (word: string) =>
      `${"-".repeat(5)}${word} ${["PRIVATE", "KEY"].join(" ")}${"-".repeat(5)}`;
    const key = `${fence("BEGIN")}\n${FIXED}\n${fence("END")}`;
    expect(redactForEgress(key, { trusted: [FIXED] })).toEqual(redactForEgress(key));
    expect(redactForEgress(key, { trusted: [FIXED] }).text).toBe("[密钥]");
    const password = `密码：${FIXED}hunter22abc`;
    expect(redactForEgress(password, { trusted: [FIXED] })).toEqual(redactForEgress(password));
    expect(redactForEgress(password, { trusted: [FIXED] }).text).toMatch(/^密码：\[密码\]/u);
  });

  it("[I-78] still masks a password or a private key that carries the filler character", () => {
    const password = "密码：\uFFFFhunter22abc";
    expect(redactForEgress(password, { trusted: [FIXED] }).text).toBe("密码：[密码]");
    const fence = (word: string) =>
      `${"-".repeat(5)}${word} ${["PRIVATE", "KEY"].join(" ")}${"-".repeat(5)}`;
    const key = `${fence("BEGIN")}\nabc\uFFFFdef\n${fence("END")}`;
    expect(redactForEgress(key, { trusted: [FIXED] }).text).toBe("[密钥]");
  });

  it("[I-78] leaves no record of the rehearsal it runs before trusting the text", () => {
    const seen: string[] = [];
    const known = new Map<string, string>();
    const table = new Map<string, string>();
    redactForEgress(`密码：${FIXED}hunter22abc`, {
      trusted: [FIXED],
      known,
      table,
      tag: () => "abcdefgh",
      observe: ({ value }) => seen.push(value),
    });
    expect(seen).toHaveLength(1);
    expect(table.size).toBe(1);
  });

  it("[I-78] behaves exactly as before when nothing trusted appears", () => {
    for (const input of ["验证码 482910", "你好 1000", "密码：hunter22", ""])
      expect(redactForEgress(input, { trusted: [FIXED] })).toEqual(redactForEgress(input));
  });
});
