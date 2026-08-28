import { parseAnswerLocaleSettingIntent } from "../src/services/thread-command-service.js";
import { describe, expect, it } from "vitest";

describe("Thread answer locale intent", () => {
  it("recognizes only explicit setting changes instead of input or UI language", () => {
    expect(parseAnswerLocaleSettingIntent("把回答语言切换为日语")).toBe("ja");
    expect(parseAnswerLocaleSettingIntent("Please respond in English")).toBe("en");
    expect(parseAnswerLocaleSettingIntent("回答言語を中国語にして")).toBe("zh-CN");
    expect(parseAnswerLocaleSettingIntent("I wrote this message in English")).toBeNull();
    expect(parseAnswerLocaleSettingIntent("UI locale: ja")).toBeNull();
  });
});
