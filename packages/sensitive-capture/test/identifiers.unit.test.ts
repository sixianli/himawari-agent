import { describe, expect, it } from "vitest";
import { containsRestrictedIdentifier, mentionsSensitiveMaterial } from "../src/index.js";

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
