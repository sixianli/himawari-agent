import { describe, expect, it } from "vitest";
import { processStepKind, processStepText } from "../src/process-step.js";

describe("[ICON-3] step text when the model gave none", () => {
  it.each([
    ["web_search", "zh-CN", "搜索网页"],
    ["web_search", "en", "Searching the web"],
    ["bash", "ja", "コマンド実行"],
    ["authorized_mail_send", "zh-CN", "执行已授权的操作"],
    ["restaurant_search", "en", "Using a tool"],
    ["web_search", "fr", "搜索网页"],
  ])("names %s in %s", (tool, locale, text) => {
    expect(processStepText(tool, locale)).toBe(text);
  });

  it("does not treat object built-ins as tool names", () => {
    expect(processStepKind("constructor")).toBe("other");
    expect(processStepKind("toString")).toBe("other");
  });
});
