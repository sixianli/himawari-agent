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
