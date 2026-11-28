import { describe, expect, it } from "vitest";
import {
  containsRestrictedIdentifier,
  isSensitiveFieldName,
  isSensitiveQueryParameter,
  isSensitiveTraceKey,
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
