import { describe, expect, it } from "vitest";
import { HIMAWARI_IDENTITY } from "../src/production-run-policy.js";
import { reminderToolDescriptors } from "../src/production-reminder-writer.js";

describe("HIMAWARI_IDENTITY memory and reminder claims", () => {
  it("does not promise that memory is saved automatically", () => {
    expect(HIMAWARI_IDENTITY).not.toContain("自动记进长期记忆");
    expect(HIMAWARI_IDENTITY).toContain("整理可能失败");
    expect(HIMAWARI_IDENTITY).toContain("不要说“已经记住了”");
  });

  it("does not deny the reminder tools that production gives the model", () => {
    const toolNames = reminderToolDescriptors().map(({ name }) => name);
    expect(toolNames).toContain("reminder_set");
    expect(HIMAWARI_IDENTITY).not.toMatch(/没有[^。；\n]*提醒[^。；\n]*工具/u);
    expect(HIMAWARI_IDENTITY).toContain("reminder_set");
  });

  it("tells the model not to claim a reminder was set unless the tool succeeded", () => {
    expect(HIMAWARI_IDENTITY).toContain("不要说“已设好提醒”");
    expect(HIMAWARI_IDENTITY).toContain("把事项写进文件不算设了提醒");
  });

  it("defers to the tool's own failure note instead of one fixed fallback", () => {
    const failure = HIMAWARI_IDENTITY.slice(HIMAWARI_IDENTITY.indexOf("工具返回失败"));
    const failureSentence = failure.slice(0, failure.indexOf("。") + 1);
    expect(failureSentence).toContain("按工具返回的说明");
    expect(failureSentence).not.toContain("提醒页");
    expect(HIMAWARI_IDENTITY).toContain("本轮没有这个工具时");
  });
});
