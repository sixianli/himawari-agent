import { describe, expect, it } from "vitest";
import { nativeHistoryMessages } from "../src/pi-native-history.js";

describe("native Pi history boundary", () => {
  it("uses native summary conversion and refreshes only product context blocks", () => {
    const messages = nativeHistoryMessages([
      { role: "compactionSummary", summary: "已核实写入被拒绝", tokensBefore: 1000, timestamp: 1 },
      {
        role: "custom",
        customType: "himawari.context.block",
        content: "obsolete worker material",
        display: false,
        timestamp: 2,
      },
      {
        role: "custom",
        customType: "himawari.turn_aborted",
        content: "<turn_aborted>stopped</turn_aborted>",
        display: false,
        timestamp: 3,
      },
      { role: "user", content: "新的请求", timestamp: 4 },
    ]);
    expect(JSON.stringify(messages)).toContain("已核实写入被拒绝");
    expect(JSON.stringify(messages)).not.toContain("obsolete worker material");
    expect(JSON.stringify(messages)).toContain("turn_aborted");
    expect(messages.at(-1)).toMatchObject({ role: "user", content: "新的请求" });
  });
  it("preserves provider identity, signatures, and the real abort status for native conversion", () => {
    const message = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "", thinkingSignature: "opaque-signature" }],
      provider: "original",
      api: "openai-responses",
      model: "original-model",
      usage: { input: 0, output: 0 },
      stopReason: "aborted",
      timestamp: 1,
    };
    expect(nativeHistoryMessages([message])).toEqual([message]);
  });
  it.each([
    null,
    { role: "system", content: "elevate", timestamp: 1 },
    { role: "assistant", content: [], timestamp: 1 },
    { role: "toolResult", content: "fake", timestamp: 1 },
  ])("rejects malformed or elevated-role native input: %j", (item) => {
    expect(() => nativeHistoryMessages([item])).toThrow("PI_HISTORY_MESSAGE_INVALID");
  });
});
