import { afterEach, describe, expect, it } from "vitest";
import {
  type Harness,
  harness,
  type PairedClient,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
} from "../fixtures/device-api-harness.ts";
import { devicePost, perceptionScope } from "../fixtures/perception-test-client.ts";

afterEach(removeDeviceHarnessDirectories);

async function setup() {
  const h = await harness();
  const client = await pairAndConfirm(h);
  const created = await devicePost(h, client, "threads", {
    requestId: "device-request-prefetch-0001",
    answerLocale: "zh-CN",
  });
  const threadId = (created.body["payload"] as { threadId: string }).threadId;
  return { h, client, threadId };
}

const partial = (h: Harness, client: PairedClient, utteranceId: string, text: string) =>
  devicePost(h, client, "utterances/partial", { utteranceId, text });

async function storedPerception(h: Harness) {
  const page = await h.perception.listDay({
    scope: perceptionScope,
    day: null,
    sense: null,
    types: ["speech.utterance"],
    cursor: null,
  });
  return page.rows;
}

describe("[iOS-8] getting ready while the owner is still talking", () => {
  it("prepares the search for the latest half sentence and reuses it for the same final words", async () => {
    const { h, client, threadId } = await setup();
    expect((await partial(h, client, "utt-prefetch-1", "帮我把明天")).body).toEqual({
      prepared: true,
      reason: null,
    });
    await partial(h, client, "utt-prefetch-1", "帮我把明天的会改到下午");
    expect(h.embeddedQueries).toEqual(["帮我把明天", "帮我把明天的会改到下午"]);
    expect(h.prefetch.preparedCount(client.deviceId)).toBe(1);
    const sent = await devicePost(h, client, "messages", {
      messageId: "device-message-prefetch-0001",
      threadId,
      expectedRevision: 1,
      text: "帮我把明天的会改到下午",
      utteranceId: "utt-prefetch-1",
      voice: { trigger: "hands_on" },
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    const reused = await h.queryEmbedder.embedQuery("帮我把明天的会改到下午");
    expect(Array.from(reused)).toEqual([11, 1]);
    expect(h.embeddedQueries).toHaveLength(2);
  });

  it("does the search again when the owner changed their mind before finishing", async () => {
    const { h, client, threadId } = await setup();
    await partial(h, client, "utt-prefetch-2", "帮我订明天的");
    await devicePost(h, client, "messages", {
      messageId: "device-message-prefetch-0002",
      threadId,
      expectedRevision: 1,
      text: "算了，帮我查一下天气",
      utteranceId: "utt-prefetch-2",
    });
    await h.queryEmbedder.embedQuery("算了，帮我查一下天气");
    expect(h.embeddedQueries).toEqual(["帮我订明天的", "算了 帮我查一下天气"]);
  });

  it("reuses the prepared search when the final words only add punctuation, so the request matches a cold search", async () => {
    const { h, client, threadId } = await setup();
    await partial(h, client, "utt-prefetch-6", "帮我把明天的会改到下午");
    await devicePost(h, client, "messages", {
      messageId: "device-message-prefetch-0006",
      threadId,
      expectedRevision: 1,
      text: "帮我把明天的会改到下午。",
      utteranceId: "utt-prefetch-6",
      voice: { trigger: "hands_on" },
    });
    const reused = Array.from(await h.queryEmbedder.embedQuery("帮我把明天的会改到下午。"));
    expect(h.embeddedQueries).toEqual(["帮我把明天的会改到下午"]);

    const cold = await setup();
    await devicePost(cold.h, cold.client, "messages", {
      messageId: "device-message-prefetch-0007",
      threadId: cold.threadId,
      expectedRevision: 1,
      text: "帮我把明天的会改到下午。",
      utteranceId: "utt-prefetch-7",
      voice: { trigger: "hands_on" },
    });
    const fresh = Array.from(await cold.h.queryEmbedder.embedQuery("帮我把明天的会改到下午。"));
    expect(reused).toEqual(fresh);
  });

  it("never keeps a half sentence as a conversation message or a perception record", async () => {
    const { h, client } = await setup();
    await partial(h, client, "utt-prefetch-3", "我在想要不要");
    expect(await storedPerception(h)).toEqual([]);
    const threads = await devicePost(h, client, "threads", {
      requestId: "device-request-prefetch-0001",
      answerLocale: "zh-CN",
    });
    expect(threads.body["payload"]).toMatchObject({ replayed: true });
  });

  it("stops preparing once the day's perception model cost limit is used up", async () => {
    const { h, client } = await setup();
    const settings = await h.perception.settings(perceptionScope);
    await h.perception.changeSettings(perceptionScope, settings.revision, {
      kind: "limit",
      key: "perception.model_cost.daily",
      value: 10,
    });
    expect((await partial(h, client, "utt-prefetch-4", "一二三四五六")).body).toEqual({
      prepared: true,
      reason: null,
    });
    expect((await partial(h, client, "utt-prefetch-4", "一二三四五六七八")).body).toEqual({
      prepared: false,
      reason: "limit_reached",
    });
    expect(h.embeddedQueries).toEqual(["一二三四五六"]);
  });

  it("refuses malformed half sentences", async () => {
    const { h, client } = await setup();
    for (const body of [
      { utteranceId: "bad id!", text: "你好" },
      { utteranceId: "utt-prefetch-5", text: "   " },
      { utteranceId: "utt-prefetch-5", text: "x".repeat(64 * 1024 + 1) },
      { utteranceId: "utt-prefetch-5", text: "你好", extra: 1 },
      { text: "你好" },
    ])
      expect((await devicePost(h, client, "utterances/partial", body)).status).toBe(400);
    expect(h.embeddedQueries).toEqual([]);
  });
});
