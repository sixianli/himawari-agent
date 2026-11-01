import type { Context } from "@earendil-works/pi-ai";
import { EGRESS_PLACEHOLDER_LEGEND } from "@himawari-agent/application/runtime-port";
import { describe, expect, it } from "vitest";
import { redactModelContext } from "../src/egress-context.js";

const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });
const toolResult = (text: string) => ({
  role: "toolResult" as const,
  toolCallId: "call-1",
  toolName: "read",
  content: [{ type: "text" as const, text }],
  isError: false,
  timestamp: 2,
});

describe("model context redaction", () => {
  it("redacts user text, tool results and tool-call arguments", () => {
    const context = {
      systemPrompt: "你是 Himawari",
      messages: [
        user("我的卡号 4111 1111 1111 1111"),
        toolResult("验证码 482910"),
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-2",
              name: "bash",
              arguments: { command: "login --password: hunter2" },
            },
          ],
        },
      ],
    } as unknown as Context;
    const redacted = redactModelContext(context);
    const text = JSON.stringify(redacted.messages);
    expect(text).not.toContain("4111 1111");
    expect(text).not.toContain("482910");
    expect(text).not.toContain("hunter2");
    expect(text).toContain("[银行卡 尾号1111]");
  });

  it("always appends the same legend, even when nothing is redacted", () => {
    const clean = redactModelContext({ systemPrompt: "S", messages: [user("你好")] } as Context);
    const dirty = redactModelContext({
      systemPrompt: "S",
      messages: [user("验证码 482910")],
    } as Context);
    expect(clean.systemPrompt).toBe(`S\n\n${EGRESS_PLACEHOLDER_LEGEND}`);
    expect(dirty.systemPrompt).toBe(clean.systemPrompt);
  });

  it("keeps earlier messages byte-identical when a later message is appended (KV-cache prefix)", () => {
    const history = [user("验证码 482910"), toolResult("订单号 20261101123456")];
    const turnOne = redactModelContext({ systemPrompt: "S", messages: history } as Context);
    const turnTwo = redactModelContext({
      systemPrompt: "S",
      messages: [...history, user("谢谢，密码：abc123")],
    } as Context);
    expect(JSON.stringify(turnTwo.messages.slice(0, 2))).toBe(JSON.stringify(turnOne.messages));
    expect(turnTwo.systemPrompt).toBe(turnOne.systemPrompt);
  });

  it("does not touch thinking blocks or unchanged messages", () => {
    const thinking = {
      role: "assistant",
      content: [{ type: "thinking", thinking: "验证码 482910", thinkingSignature: "sig" }],
    };
    const plain = user("你好");
    const redacted = redactModelContext({
      messages: [thinking, plain],
    } as unknown as Context);
    expect(redacted.messages[0]).toBe(thinking);
    expect(redacted.messages[1]).toBe(plain);
  });
});
