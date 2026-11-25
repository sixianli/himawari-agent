import { describe, expect, it } from "vitest";
import {
  findSensitiveValues,
  locateMaskedValues,
  maskSensitiveTexts,
  namesRememberedValue,
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
  ["没有分隔符的密码", "Wi-Fi 密码 abc12345", "Wi-Fi 密码 [密码]"],
  ["英文 is", "my password is abc12345", "my password is [密码]"],
  ["英文 pwd 没有分隔符", "pwd hunter22abc", "pwd [密码]"],
  ["纯数字密码", "password 123456", "password [密码]"],
  ["密码改成", "密码改成 Zx9qq88", "密码改成 [密码]"],
  ["日文没有分隔符", "パスワード abc12345", "パスワード [密码]"],
  ["韩文密码是", "비밀번호는 abc12345", "비밀번호는 [密码]"],
  ["中文后面跟着密码", "我的密码 abc12345", "我的密码 [密码]"],
  ["句号收尾的值", "password is abc12345.", "password is [密码]."],
  ["英文紧贴中文关键词", "wifi密码 abc12345", "wifi密码 [密码]"],
  ["引号包住的值", 'password is "hunter22abc"', 'password is "[密码]"'],
  ["像重定向的值仍要遮", "password is 12<3456", "password is [密码]"],
  ["混合值只遮到非 ASCII 之前", "密码设为 abc12345中文", "密码设为 [密码]中文"],
  ["are", "the password are abc12345", "the password are [密码]"],
  ["was", "my password was abc12345", "my password was [密码]"],
  ["改为", "密码改为 Zx9qq88", "密码改为 [密码]"],
  ["韩文은", "비밀번호은 abc12345", "비밀번호은 [密码]"],
  ["4 个字符的带词值", "password is a123", "password is [密码]"],
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
  "the password is required",
  "password is incorrect, try again",
  "密码改成每月一次",
  "密码管理器 1Password 很好用",
  "密码 2026-11-08 更新",
  "password v2.0.1 发布",
  "密码 abc 很短",
  "密码 a1b2c 太短",
  "password is a1",
  "密码 我已经用了3年",
  "密码设为8位以上",
  "1Password hunter22abc",
  "notpassword abc12345",
  "pwd\nabc12345",
  "密码 https://example.com/reset?token=123456",
  "password is 2026-11-08T10:30",
  "密码 11/08/2026",
  "password is (2026-11-08)",
  'password is "https://example.com"',
  'password is "/home/user1"',
  "pwd 2>/dev/null",
  "password is 123.",
  'password is "a12',
  "密码 'abc12",
  "密码 12345.",
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

describe("reporting what was masked", () => {
  const mixed = [
    `密码：hunter22abc，卡号 4111 1111 1111 1111，验证码 482910`,
    `身份证 11010519491231002X，key ${["sk", "proj", "abcdefghijklmnopqrstuvwxyz012345"].join("-")}`,
  ].join("\n");

  it("reports each masked value with its kind and rule, and masks the same bytes as without a listener", () => {
    const seen: { kind: string; ruleId: string; value: string }[] = [];
    const known = new Map<string, string>();
    const observed = redactForEgress(mixed, {
      tag,
      known,
      observe: (sighting) => seen.push({ ...sighting }),
    }).text;
    expect(observed).toBe(redactForEgress(mixed, { tag, known: new Map() }).text);
    expect(seen.map(({ kind, ruleId }) => `${kind}/${ruleId}`).sort()).toEqual([
      "bank-card/bank-card",
      "identity-number/cn-identity-number",
      "machine-secret/openai-api-key",
      "password/password-keyword",
      "verification-code/verification-code-keyword",
    ]);
    expect(seen.find(({ kind }) => kind === "bank-card")?.value).toBe("4111111111111111");
    const later: string[] = [];
    redactForEgress("好的，hunter22abc 已经记下", {
      tag,
      known,
      observe: ({ ruleId, value }) => later.push(`${ruleId}:${value}`),
    });
    expect(later).toEqual(["named-earlier:hunter22abc"]);
  });

  it("still masks the same way when the listener throws", () => {
    const text = redactForEgress(mixed, {
      tag,
      observe: () => {
        throw new Error("listener failed");
      },
    }).text;
    expect(text).toBe(redactForEgress(mixed, { tag }).text);
  });

  it("reports nothing for text with nothing to mask", () => {
    const seen: unknown[] = [];
    redactForEgress("订单号 20261101123456 已发货", { observe: (sighting) => seen.push(sighting) });
    expect(seen).toEqual([]);
  });
});

describe("locating masked values in the masked text", () => {
  it("returns the same masked text and where each value's placeholder sits", () => {
    const key = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz012345"].join("-");
    const input = `密码：hunter22abc 和 key ${key}，卡号 4111 1111 1111 1111，又一个 key ${key}`;
    const located = locateMaskedValues(input);
    expect(located?.text).toBe(redactForEgress(input).text);
    expect(
      located?.spans.map(({ start, end, sighting }) => [
        located.text.slice(start, end),
        sighting.kind,
        sighting.value,
      ]),
    ).toEqual([
      ["[密码]", "password", "hunter22abc"],
      ["[密钥]", "machine-secret", key],
      ["[银行卡 尾号1111]", "bank-card", "4111111111111111"],
      ["[密钥]", "machine-secret", key],
    ]);
  });

  it("gives up instead of pairing a key with the wrong placeholder when it also sits inside a Bearer token", () => {
    const key = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz012345"].join("-");
    const github = ["ghp", "abcdefghijklmnopqrstuvwxyz0123"].join("_");
    const input = `Authorization: Bearer ${key}，然后 ${github}，最后单独的 ${key}`;
    expect(findSensitiveValues(input).map(({ ruleId }) => ruleId)).toEqual([
      "authorization-bearer",
      "openai-api-key",
      "github-token",
    ]);
    expect(locateMaskedValues(input)).toBeNull();
  });

  it("still locates a value that appears several times when every copy was masked", () => {
    const github = ["ghp", "abcdefghijklmnopqrstuvwxyz0123"].join("_");
    const located = locateMaskedValues(`${github} 和 ${github}`);
    expect(located?.spans.map(({ sighting }) => sighting.value)).toEqual([github, github]);
  });

  it("locates the looser password forms and keeps what followed the value", () => {
    const input = "Wi-Fi 密码 abc12345，still password is Zx9qq88.";
    const located = locateMaskedValues(input);
    expect(located?.text).toBe("Wi-Fi 密码 [密码]，still password is [密码].");
    expect(located?.spans.map(({ sighting }) => sighting.value)).toEqual(["abc12345", "Zx9qq88"]);
  });

  it("applies the looser password forms only from ruleset 2 and keeps the strict form in both", () => {
    const loose = "Wi-Fi 密码 abc12345，still password is Zx9qq88.";
    expect(redactForEgress(loose, { ruleset: 1 }).text).toBe(loose);
    expect(redactForEgress(loose, { ruleset: 2 }).text).toBe(redactForEgress(loose).text);
    expect(redactForEgress(loose).text).not.toContain("abc12345");
    const strict = "密码：hunter22abc";
    expect(redactForEgress(strict, { ruleset: 1 }).text).toBe("密码：[密码]");
    expect(redactForEgress(strict, { ruleset: 1 }).text).toBe(redactForEgress(strict).text);
  });

  it("keeps the bytes of earlier messages when a later one repeats the value", () => {
    const history = ["我们聊聊家里的网络", "Wi-Fi 密码 abc12345"];
    const run = (messages: readonly string[]) => {
      const known = new Map<string, string>();
      return messages.map((text) => redactForEgress(text, { tag, known }).text);
    };
    const earlier = run(history);
    const later = run([...history, "好的，abc12345 记下了"]);
    expect(earlier[1]).toContain("[密码#");
    expect(later.slice(0, 2)).toEqual(earlier);
    expect(later[2]).not.toContain("abc12345");
  });

  it("gives up instead of guessing when the text already holds a placeholder", () => {
    expect(locateMaskedValues("早就遮过的 [密钥] 和密码：hunter22abc")).toBeNull();
  });
});

describe("[P5-1] masking several texts that leave together", () => {
  const value = "Sunflower-8841";
  const named = `家里 Wi-Fi 密码：${value}`;
  const bare = `路由器背面贴着 ${value}`;

  it("masks a value named anywhere in the batch, in every text, whatever the order", () => {
    for (const batch of [
      [bare, named],
      [named, bare],
    ]) {
      const masked = maskSensitiveTexts(batch);
      expect(masked).toHaveLength(2);
      expect(masked.join("\n")).not.toContain(value);
    }
  });

  it("gives each text the same bytes whatever unrelated text is in the batch", () => {
    const alone = maskSensitiveTexts([named]);
    const withOthers = maskSensitiveTexts(["验证码 482910", named]);
    expect(withOthers[1]).toBe(alone[0]);
  });

  it("returns texts without anything sensitive unchanged and in order", () => {
    expect(maskSensitiveTexts(["明天上午十点去牙医复诊", "周六去京都"])).toEqual([
      "明天上午十点去牙医复诊",
      "周六去京都",
    ]);
  });
});

describe("texts whose masked values later texts rely on", () => {
  it("says so for a named password or verification code", () => {
    expect(namesRememberedValue("登录密码：Qz7mWx42Lp")).toBe(true);
    expect(namesRememberedValue("您的验证码是 482910")).toBe(true);
  });

  it("REVERSE: says no for plain text, a short password, or a card number that is masked on its own", () => {
    expect(namesRememberedValue("网页正文：lorem ipsum")).toBe(false);
    expect(namesRememberedValue("密码：abc12")).toBe(false);
    expect(namesRememberedValue("卡号 6222 0212 3456 7890 123")).toBe(false);
  });
});
