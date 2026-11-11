import { describe, expect, it } from "vitest";
import { maskForExternalRead } from "../src/production-mcp-read.js";

const WIFI_VALUE = "Sunflower-8841";

describe("[P5-1] masking what an external MCP read returns", () => {
  it("masks a named password wherever it appears in the response, before or after it is named", () => {
    const masked = JSON.stringify(
      maskForExternalRead({
        memories: [
          { text: `路由器背面贴着 ${WIFI_VALUE}` },
          { text: `家里 Wi-Fi 密码：${WIFI_VALUE}` },
          { text: `客人来了就告诉他 ${WIFI_VALUE}` },
        ],
      }),
    );
    expect(masked).not.toContain(WIFI_VALUE);
    expect(masked).toContain("路由器背面贴着");
  });

  it("masks a machine credential the text rules do not name", () => {
    const leaked = ["ghp", "a1B2c3D4e5".repeat(4)].join("_");
    const masked = JSON.stringify(maskForExternalRead({ text: `部署用的令牌是 ${leaked}` }));
    expect(masked).not.toContain(leaked);
  });

  it("leaves ordinary text, numbers and booleans as they are", () => {
    const value = { today: "2026-11-11", more: true, count: 3, text: "明天上午十点去牙医复诊" };
    expect(maskForExternalRead(value)).toEqual(value);
  });
});

describe("[P5-A] masking across the fields of one response", () => {
  const code = "482910";

  it("masks a value everywhere in start_here when only one field names it", () => {
    const masked = JSON.stringify(
      maskForExternalRead({
        profile: { sections: [{ items: [`备用手机尾号提示 ${code}`] }] },
        rules: { items: [] },
        today: { reminders: [{ text: `${code} 是验证码` }] },
      }),
    );
    expect(masked).not.toContain(code);
  });

  it("REVERSE: a response that names nothing sensitive keeps every field as it is", () => {
    const value = { profile: { items: ["住在东京"] }, today: { reminders: [{ text: "开会" }] } };
    expect(maskForExternalRead(value)).toEqual(value);
  });
});
