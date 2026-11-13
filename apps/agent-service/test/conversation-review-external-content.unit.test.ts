import { expect, it } from "vitest";
import { parseConversationReview } from "../src/production-memory-conversation-review.js";

const message = {
  id: "message-1",
  role: "owner",
  contentRef: "payload-owner-1",
  dataClassification: "private",
  committedAt: "2026-11-13T00:00:00.000Z",
} as never;

const output = JSON.stringify({
  memories: [
    {
      messageId: "message-1",
      kind: "durable_fact",
      decision: "create",
      text: "主人最喜欢的颜色是蓝色",
      classification: "private",
      confidence: 950,
      explicit: true,
      quote: "我最喜欢的颜色是蓝色",
    },
  ],
});

function parse(externalOrigins?: readonly string[]) {
  return parseConversationReview({
    output,
    messages: [{ message, text: "请记住，我最喜欢的颜色是蓝色。" }],
    existing: [],
    timeZone: "Asia/Tokyo",
    newMemoriesAllowed: 5,
    ...(externalOrigins ? { externalOrigins } : {}),
  });
}

it("[ADR-0257] marks memories the conversation review writes from a conversation that read outside content", () => {
  const [group] = parse(["web_fetch"]).groups;
  expect(group?.parsed.candidates[0]?.sourceRefs).toEqual([
    "payload-owner-1",
    "external-content:payload-owner-1|web_fetch",
  ]);
});

it("[ADR-0257] REVERSE: leaves review memories unmarked when the conversation read nothing from outside", () => {
  const [group] = parse().groups;
  expect(group?.parsed.candidates[0]?.sourceRefs).toEqual(["payload-owner-1"]);
});
