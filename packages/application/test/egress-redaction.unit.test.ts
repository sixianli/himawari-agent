import { describe, expect, it } from "vitest";
import {
  EGRESS_PLACEHOLDER_LEGEND,
  EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE,
  redactForEgress,
} from "../src/index.js";

const positives: ReadonlyArray<readonly [string, string, string]> = [
  ["验证码中文", "您的验证码是 482910，5 分钟内有效", "您的验证码是 [验证码]，5 分钟内有效"],
  ["验证码在数字后", "482910 is your verification code", "[验证码] is your verification code"],
  [
    "验证码日文",
    "認証コード: 123456 を入力してください",
    "認証コード: [验证码] を入力してください",
  ],
  ["OTP", "Your OTP is 7391", "Your OTP is [验证码]"],
  [
    "Google 前缀",
    "G-123456 is your Google verification code",
    "G-[验证码] is your Google verification code",
  ],
  ["Visa 空格", "卡号 4111 1111 1111 1111 已绑定", "卡号 [银行卡 尾号1111] 已绑定"],
  ["Visa 横线", "card 4111-1111-1111-1111", "card [银行卡 尾号1111]"],
  [
    "卡号和验证码相邻",
    "验证码 482910\n卡号 4111 1111 1111 1111",
    "验证码 [验证码]\n卡号 [银行卡 尾号1111]",
  ],
  ["Amex", "amex 378282246310005", "amex [银行卡 尾号0005]"],
  ["银联", "6222021234567890128", "[银行卡 尾号0128]"],
  ["半角冒号密码", "password: hunter2", "password: [密码]"],
  ["全角冒号密码", "密码：abc123", "密码：[密码]"],
  ["密码是", "我的密码是 Zx9!qq", "我的密码是 [密码]"],
  ["日文密码", "パスワード：secret99", "パスワード：[密码]"],
  ["口令", "口令：Tr0ub4dor", "口令：[密码]"],
  ["PIN 码", "PIN码是 482915", "PIN码是 [密码]"],
  ["PIN 码带空格", "PIN 码：4829", "PIN 码：[密码]"],
  ["安全码", "安全码为 77aa88bb", "安全码为 [密码]"],
  ["授权码", "授权码：abcd1234efgh", "授权码：[密码]"],
  ["日文暗証番号", "暗証番号：4829", "暗証番号：[密码]"],
  ["韩文密码", "비밀번호: hunter22", "비밀번호: [密码]"],
  [
    "OpenAI key",
    `key ${["sk", "proj", "abcdefghijklmnopqrstuvwxyz012345"].join("-")}`,
    "key [密钥]",
  ],
  [
    "Bearer",
    `Authorization: ${["Bearer", "abcdefghijklmnop1234"].join(" ")}`,
    "Authorization: [密钥]",
  ],
  ["身份证", "身份证 11010519491231002X", "身份证 [证件号]"],
  ["IBAN", "IBAN GB82 WEST 1234 5698 7654 32", "IBAN [证件号]"],
  ["个人番号", "マイナンバー 123456789018 です", "マイナンバー [证件号] です"],
];

const negatives: readonly string[] = [
  "订单号 20261101123456 已发货",
  "快递单号 SF1234567890123",
  "ISBN 978-4-87311-865-7",
  "时间戳 1793525345141",
  "版本 v2.2.361 发布于 2026-11-01",
  "坐标 35.6812, 139.7671",
  "邮编 100-0001 东京都千代田区",
  "电话 090-1234-5678",
  "16 位订单号 1234567890123456",
  "请在 2026 年 11 月前提交",
  "验证码邮件的格式说明（没有数字）",
  "会议 14:30 开始，房间 2048",
  "邮箱 andy@example.com 姓名 山田太郎 地址 东京都港区 1-2-3",
  "密码规则：至少 8 位",
  "口令规则说明见下文",
  "授权码的有效期是多久",
  "12 位数字 123456789012 不是个人番号",
];

describe("outbound redaction", () => {
  it.each(positives)("redacts %s", (_name, input, expected) => {
    expect(redactForEgress(input).text).toBe(expected);
    expect(redactForEgress(input).findings.length).toBeGreaterThan(0);
  });

  it.each(negatives)("leaves benign text untouched: %s", (input) => {
    const result = redactForEgress(input);
    expect(result.text).toBe(input);
    expect(result.findings).toEqual([]);
  });

  it("never leaves the original sensitive value behind", () => {
    for (const [, input] of positives) {
      const digits = input.match(/\d{4,}/gu) ?? [];
      const out = redactForEgress(input).text;
      for (const run of digits) {
        if (!/尾号/u.test(out)) expect(out).not.toContain(run);
      }
    }
  });

  it("is deterministic and idempotent", () => {
    for (const [, input] of positives) {
      const once = redactForEgress(input).text;
      expect(redactForEgress(input).text).toBe(once);
      expect(redactForEgress(once).text).toBe(once);
    }
  });

  it("redacts a message the same way regardless of what surrounds it (KV-cache prefix stability)", () => {
    const first = "您的验证码是 482910";
    const second = "卡号 4111 1111 1111 1111";
    const followUp = "好的，谢谢";
    const redactedFirst = redactForEgress(first).text;
    const redactedSecond = redactForEgress(second).text;
    const turnOne = [redactedFirst, redactedSecond];
    const turnTwo = [first, second, followUp].map((message) => redactForEgress(message).text);
    expect(turnTwo.slice(0, 2)).toEqual(turnOne);
    expect(turnTwo.slice(0, 2).join("\n")).toBe(turnOne.join("\n"));
  });

  it("reports counts by kind without echoing values", () => {
    const result = redactForEgress("验证码 482910，密码：abc123，卡号 4111111111111111");
    expect(result.findings.map(({ kind }) => kind).sort()).toEqual([
      "bank-card",
      "password",
      "verification-code",
    ]);
    expect(JSON.stringify(result.findings)).not.toContain("482910");
  });

  it("states what the placeholders mean in one fixed sentence", () => {
    for (const legend of [EGRESS_PLACEHOLDER_LEGEND, EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE]) {
      expect(legend).toContain("[验证码#abcdefgh]");
      expect(legend).toContain("不要要求用户核实");
      expect(legend).toContain("不要换成示例");
      expect(legend).not.toContain("不要猜测");
      expect(legend).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
    }
    expect(EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE).toContain("显示给用户时会换回原值");
    expect(EGRESS_PLACEHOLDER_LEGEND).not.toContain("换回原值");
  });
});

const tag = (kind: string, value: string): string => {
  let hash = 7;
  for (const char of `${kind}\u0000${value}`) hash = (hash * 31 + char.charCodeAt(0)) % 2147483647;
  return Array.from({ length: 8 }, (_, index) =>
    String.fromCharCode(97 + (((hash >> index) + index * 3) % 26)),
  ).join("");
};

describe("stable placeholders", () => {
  it("gives the same value the same placeholder and different values different ones", () => {
    const first = redactForEgress("验证码 482910", { tag }).text;
    const again = redactForEgress("请用验证码 482910 登录", { tag }).text;
    const other = redactForEgress("验证码 573621", { tag }).text;
    const placeholder = first.slice(first.indexOf("["));
    expect(again).toContain(placeholder);
    expect(other).not.toContain(placeholder);
    expect(placeholder).toMatch(/^\[验证码#[a-z]{8}\]$/u);
  });

  it("never puts digits in the identifier so it cannot be mistaken for a code", () => {
    for (let index = 0; index < 200; index += 1) {
      const text = redactForEgress(`验证码 ${100000 + index * 37}`, { tag }).text;
      expect(text).toMatch(/^验证码 \[验证码#[a-z]{8}\]$/u);
    }
  });

  it("records the original value so it can be put back for display", () => {
    const table = new Map<string, string>();
    const result = redactForEgress("密码：hunter22abc，卡号 4111 1111 1111 1111", { tag, table });
    expect(result.text).not.toContain("hunter22abc");
    expect([...table.values()].sort()).toEqual(["4111 1111 1111 1111", "hunter22abc"]);
  });

  it("masks a value everywhere once it has been masked earlier, without looking ahead", () => {
    const known = new Map<string, string>();
    const first = redactForEgress("密码：hunter22abc", { tag, known }).text;
    const later = redactForEgress("好的，hunter22abc 已经记下", { tag, known }).text;
    expect(later).toBe(`好的，${first.slice(first.indexOf("["))} 已经记下`);
    const unrelated = redactForEgress("hunter22abcdef 是另一个词", { tag, known }).text;
    expect(unrelated).toBe("hunter22abcdef 是另一个词");
  });

  it("does not remember short values", () => {
    const known = new Map<string, string>();
    redactForEgress("验证码 4829", { tag, known });
    expect(redactForEgress("房间 4829", { tag, known }).text).toBe("房间 4829");
  });

  it("keeps machine secrets as one fixed marker that is never restorable", () => {
    const table = new Map<string, string>();
    const key = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz012345"].join("-");
    const result = redactForEgress(`key ${key}`, { tag, table });
    expect(result.text).toBe("key [密钥]");
    expect(table.size).toBe(0);
  });

  it("is a function of its own text and the earlier values only", () => {
    const known = new Map<string, string>();
    const history = ["密码：hunter22abc", "你好"];
    const turnOne = history.map((text) => redactForEgress(text, { tag, known }).text);
    const knownTwo = new Map<string, string>();
    const turnTwo = [...history, "新消息 hunter22abc"].map(
      (text) => redactForEgress(text, { tag, known: knownTwo }).text,
    );
    expect(turnTwo.slice(0, 2)).toEqual(turnOne);
  });
});
