import { describe, expect, it } from "vitest";
import {
  PROACTIVE_BODY_OMISSION_MARKER,
  plainModelText,
  windowMailBody,
} from "../src/services/proactive-mail-body.ts";

describe("[OM-12] mail body window and model text cleanup", () => {
  it("returns a short body unchanged", () => {
    expect(windowMailBody("短い本文", 100)).toEqual({ text: "短い本文", truncated: false });
  });

  it("keeps the head and the tail within the limit, cutting on characters rather than code units", () => {
    const body = `${"あ".repeat(500)}😀${"い".repeat(500)}`;
    const result = windowMailBody(body, 200);
    expect(result.truncated).toBe(true);
    expect(Array.from(result.text)).toHaveLength(200);
    expect(result.text).toContain(PROACTIVE_BODY_OMISSION_MARKER);
    expect(result.text.startsWith("あ")).toBe(true);
    expect(result.text.endsWith("い")).toBe(true);
    expect(windowMailBody(body, 200)).toEqual(result);
  });

  it("strips markup, links and hidden characters from model-written text", () => {
    expect(
      plainModelText("<b>点击</b> https://evil.example/x?a=1 确认​ 请见 www.evil.example/y", 200),
    ).toBe("点击 确认 请见");
    expect(plainModelText("plain text", 5)).toBe("plain");
  });
});
