import { describe, expect, it } from "vitest";
import { EGRESS_PLACEHOLDER_LEGEND, redactForEgress } from "../src/index.js";

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
    expect(EGRESS_PLACEHOLDER_LEGEND).toContain("[验证码]");
    expect(EGRESS_PLACEHOLDER_LEGEND).toContain("不要要求用户核实");
    expect(EGRESS_PLACEHOLDER_LEGEND).toContain("不要换成示例");
    expect(EGRESS_PLACEHOLDER_LEGEND).not.toContain("不要猜测");
    expect(EGRESS_PLACEHOLDER_LEGEND).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
  });
});
