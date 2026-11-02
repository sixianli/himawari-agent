import { describe, expect, it } from "vitest";
import { HIMAWARI_IDENTITY } from "../src/production-run-policy.js";

describe("HIMAWARI_IDENTITY memory and reminder claims", () => {
  it("does not promise that memory is saved automatically", () => {
    expect(HIMAWARI_IDENTITY).not.toContain("自动记进长期记忆");
    expect(HIMAWARI_IDENTITY).toContain("整理可能失败");
    expect(HIMAWARI_IDENTITY).toContain("不要说“已经记住了”");
  });
  it("tells the model it has no reminder tool and must not claim one was set", () => {
    expect(HIMAWARI_IDENTITY).toContain("没有设置提醒或定时任务的工具");
    expect(HIMAWARI_IDENTITY).toContain("不要说“已设好提醒”");
    expect(HIMAWARI_IDENTITY).toContain("请到提醒页确认");
  });
});
