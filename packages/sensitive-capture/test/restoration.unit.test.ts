import { describe, expect, it } from "vitest";
import { placeholderTable, redactForEgress, restorePlaceholders } from "../src/index.js";

const tag = (kind: string, value: string) => {
  let hash = 0;
  for (const character of `${kind}\u0000${value}`)
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  let out = "";
  for (let index = 0; index < 8; index += 1) {
    out += String.fromCharCode(97 + (hash % 26));
    hash = Math.floor(hash / 26) + index * 7;
  }
  return out;
};

describe("placeholderTable and restorePlaceholders", () => {
  it("[mask-not-block] restores a placeholder the model copied into its answer", () => {
    const source = "我的密码: hunter2abc，验证码 482910 请保管";
    const masked = redactForEgress(source, { tag }).text;
    expect(masked).not.toContain("hunter2abc");
    const table = placeholderTable(source, tag);
    expect(restorePlaceholders(`记住 ${masked}`, table)).toBe(`记住 ${source}`);
  });

  it("builds the same table for the same text and key", () => {
    const source = "password: hunter2abc";
    expect([...placeholderTable(source, tag)]).toEqual([...placeholderTable(source, tag)]);
  });

  it("leaves a placeholder it cannot find, and leaves the unnumbered machine secret as is", () => {
    const token = ["ghp", "_", "C".repeat(30)].join("");
    const table = placeholderTable(`token ${token}`, tag);
    expect(table.size).toBe(0);
    expect(restorePlaceholders("见 [密码#zzzzzzzz] 和 [密钥]", table)).toBe(
      "见 [密码#zzzzzzzz] 和 [密钥]",
    );
  });

  it("returns text without a placeholder unchanged", () => {
    const table = placeholderTable("password: hunter2abc", tag);
    expect(restorePlaceholders("东京明天的天气", table)).toBe("东京明天的天气");
  });

  it("[mask-not-block] restores a value the prompt carried as a JSON string with its original bytes", () => {
    const password = 'a"b\\c\nd';
    const prompt = `说明\n${JSON.stringify({ ownerMessage: `我的密码: ${password} 好` })}`;
    const masked = redactForEgress(prompt, { tag }).text;
    const placeholder = masked.match(/\[密码#[^\]]+\]/u)?.[0];
    if (placeholder === undefined) throw new Error("Expected a masked password");
    const plain = placeholderTable(prompt, tag);
    expect(restorePlaceholders(placeholder, plain)).not.toBe(password);
    const decoded = placeholderTable(prompt, tag, { jsonEmbedded: true });
    expect(restorePlaceholders(placeholder, decoded)).toBe(password);
  });

  it("[mask-not-block] builds the table over the same text the egress masks, trusted prompt wording left out", () => {
    const wording = "验证码的有效期是 1000 秒，过期之后需要重新申请新的验证码，请按说明处理。";
    const prompt = `${wording}\n主人说：验证码 482910`;
    expect([...placeholderTable(prompt, tag).values()]).toContain("1000");
    const table = placeholderTable(prompt, tag, { trusted: [wording] });
    expect([...table.values()]).toEqual(["482910"]);
  });
});
