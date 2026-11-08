import { describe, expect, it } from "vitest";
import {
  classificationWithIdentifiers,
  containsCredential,
  containsRestrictedIdentifier,
  isSensitiveFieldName,
  isSensitiveQueryParameter,
  isSensitiveTraceKey,
  mentionsSensitiveMaterial,
  redactWebContentSecrets,
} from "../src/index.js";

describe("storage-boundary identifiers", () => {
  it("treats any 16 to 19 digit run or a Chinese identity number shape as restricted, separators included", () => {
    expect(containsRestrictedIdentifier("主人的银行卡号是 6222020200112233445")).toBe(true);
    expect(containsRestrictedIdentifier("卡号 6222-0202-0011-2233")).toBe(true);
    expect(containsRestrictedIdentifier("身份证 110101199003071234")).toBe(true);
  });

  it("REVERSE: leaves short numbers, dates and ordinary text alone", () => {
    expect(containsRestrictedIdentifier("订单 20261105 已发货")).toBe(false);
    expect(containsRestrictedIdentifier("电话 090-1234-5678")).toBe(false);
    expect(containsRestrictedIdentifier("明天下午三点开会")).toBe(false);
  });
});

describe("import hints", () => {
  it("flags lines that mention a password, a card or a long number", () => {
    expect(mentionsSensitiveMaterial("家里的 Wi-Fi 密码要换")).toBe(true);
    expect(mentionsSensitiveMaterial("卡号记在本子上")).toBe(true);
    expect(mentionsSensitiveMaterial("会员号 123456789012345")).toBe(true);
  });

  it("REVERSE: leaves ordinary preferences alone", () => {
    expect(mentionsSensitiveMaterial("喜欢喝无糖咖啡")).toBe(false);
  });
});

describe("diagnostic field names and web content", () => {
  it("marks credential-looking field and query names as sensitive", () => {
    expect(isSensitiveFieldName("Authorization")).toBe(true);
    expect(isSensitiveFieldName("x_api_key")).toBe(true);
    expect(isSensitiveQueryParameter("X-Amz-Signature")).toBe(true);
  });

  it("REVERSE: leaves ordinary names alone", () => {
    expect(isSensitiveFieldName("model")).toBe(false);
    expect(isSensitiveQueryParameter("page")).toBe(false);
  });

  it("removes secrets from fetched web content and reports that it did", () => {
    const page = ["password", "hunter2hunter2"].join("=");
    const result = redactWebContentSecrets(`login with ${page} today`);
    expect(result).toEqual({ text: "login with [REDACTED_MACHINE_SECRET] today", found: true });
    expect(redactWebContentSecrets("nothing to see")).toEqual({
      text: "nothing to see",
      found: false,
    });
  });
});

describe("trace field names", () => {
  it("matches credential field names after removing case and separators", () => {
    expect(isSensitiveTraceKey("Client-Secret")).toBe(true);
    expect(isSensitiveTraceKey("set_cookie")).toBe(true);
    expect(isSensitiveTraceKey("api_key")).toBe(true);
  });

  it("REVERSE: matches whole names only, unlike the diagnostic field rule", () => {
    expect(isSensitiveTraceKey("tokenizer")).toBe(false);
    expect(isSensitiveTraceKey("keyboard")).toBe(false);
  });
});

describe("classificationWithIdentifiers", () => {
  it("[mask-not-block] raises private text holding a card or identity number to sensitive", () => {
    expect(classificationWithIdentifiers("卡号 6222020200112233445", "private")).toBe("sensitive");
    expect(classificationWithIdentifiers("身份证 110101199003071234", "private")).toBe("sensitive");
  });

  it("[mask-not-block] raises private text holding a password, a key or a code to sensitive", () => {
    const key = ["sk", "proj", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
    expect(classificationWithIdentifiers("主人家的 Wi-Fi 密码是 abc12345", "private")).toBe(
      "sensitive",
    );
    expect(classificationWithIdentifiers(`主人的接口密钥是 ${key}`, "private")).toBe("sensitive");
    expect(classificationWithIdentifiers("482910 是验证码", "public")).toBe("sensitive");
    expect(containsCredential("我的密码: hunter2abc")).toBe(true);
  });

  it("REVERSE: ordinary words near the same topics stay private", () => {
    expect(containsCredential("主人喜欢在咖啡馆改密码管理器的设置")).toBe(false);
    expect(classificationWithIdentifiers("主人最喜欢的颜色是蓝色", "private")).toBe("private");
    expect(classificationWithIdentifiers("主人的订单号是 12345", "private")).toBe("private");
  });

  it("leaves ordinary text and already stricter levels as they are", () => {
    expect(classificationWithIdentifiers("订单号 12345", "private")).toBe("private");
    expect(classificationWithIdentifiers("卡号 6222020200112233445", "restricted")).toBe(
      "restricted",
    );
    expect(classificationWithIdentifiers("卡号 6222020200112233445", "sensitive")).toBe(
      "sensitive",
    );
  });
});
