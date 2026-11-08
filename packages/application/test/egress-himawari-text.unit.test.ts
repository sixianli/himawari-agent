import {
  CHAT_RUNTIME_ENVIRONMENT_FOOTER,
  CHAT_RUNTIME_ENVIRONMENT_HEADER,
  CHAT_RUNTIME_ENVIRONMENT_MARKER,
} from "@himawari-agent/prompt-catalog";
import { redactForEgress } from "@himawari-agent/sensitive-capture";
import { describe, expect, it } from "vitest";
import { EGRESS_PLACEHOLDER_LEGEND, EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE } from "../src/index.js";

describe("Himawari outbound text", () => {
  it("keeps the code window of the runtime environment block apart from the owner message, and still masks a value the owner named as a code everywhere", () => {
    const environment = [
      CHAT_RUNTIME_ENVIRONMENT_MARKER.text,
      CHAT_RUNTIME_ENVIRONMENT_HEADER.text,
      "- 工作目录：/home/andy/482910。",
      "- 抓取网页：已开启，网址发送给 Exa 代为抓取，一次最多返回约 5120 KiB。",
      CHAT_RUNTIME_ENVIRONMENT_FOOTER.text,
    ].join("\n");
    const turn = (withEnvironment: boolean, owner: string) =>
      [
        "<himawari-context>",
        "以下是资料。",
        "- 主人的验证码习惯：常用短信。",
        ...(withEnvironment ? [environment] : []),
        "</himawari-context>",
        "",
        "<owner-message>",
        owner,
        "</owner-message>",
      ].join("\n");
    const ownerPart = (text: string) => text.slice(text.indexOf("<owner-message>"));
    const contextPart = (text: string) => text.slice(0, text.indexOf("</himawari-context>"));
    const egress = (text: string) =>
      redactForEgress(text, {
        tag: (kind, value) => `${kind}-${value.length}`,
        known: new Map(),
        table: new Map(),
      }).text;
    for (const owner of ["482910 是验证码", "你好", "5120"]) {
      const withBlock = egress(turn(true, owner));
      const withoutBlock = egress(turn(false, owner));
      expect(ownerPart(withBlock)).toBe(ownerPart(withoutBlock));
      expect(egress(turn(true, owner))).toBe(withBlock);
      expect(withBlock).toContain("约 5120 KiB。");
    }
    expect(contextPart(egress(turn(true, "你好")))).toContain("/home/andy/482910。");
    expect(contextPart(egress(turn(true, "5120")))).toBe(contextPart(egress(turn(true, "你好"))));
    expect(contextPart(egress(turn(true, "482910 是验证码")))).not.toContain("482910");
    expect(CHAT_RUNTIME_ENVIRONMENT_FOOTER.text).not.toMatch(/\d/u);
    expect(CHAT_RUNTIME_ENVIRONMENT_FOOTER.text.length).toBeGreaterThanOrEqual(40);
  });

  it("states what the placeholders mean in one fixed sentence", () => {
    for (const legend of [EGRESS_PLACEHOLDER_LEGEND, EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE]) {
      expect(legend).toContain("[验证码#abcdefgh]");
      expect(legend).toContain("不要要求主人核实");
      expect(legend).not.toContain("用户");
      expect(legend).toContain("不要换成示例");
      expect(legend).not.toContain("不要猜测");
      expect(legend).not.toMatch(/\d{4}-\d{2}-\d{2}/u);
    }
    expect(EGRESS_PLACEHOLDER_LEGEND_WITH_RESTORE).toContain("显示给主人时会换回原值");
    expect(EGRESS_PLACEHOLDER_LEGEND).not.toContain("换回原值");
  });
});
