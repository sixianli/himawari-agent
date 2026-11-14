import { DEFAULT_VOICE_GATES } from "@himawari-agent/application";
import { VOICE_ADDRESSEE_QUESTION } from "@himawari-agent/prompt-catalog";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentId,
  DECISION_GATEWAY_KEY,
  DECISION_MODEL,
  decisionAnswer,
  type Harness,
  harness,
  ownerId,
  type PairedClient,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
} from "../fixtures/device-api-harness.ts";
import { devicePost } from "../fixtures/perception-test-client.ts";

afterEach(removeDeviceHarnessDirectories);

let sequence = 0;

async function conversation(h: Harness, client: PairedClient) {
  const created = await devicePost(h, client, "threads", {
    requestId: `device-request-voice-${String(sequence).padStart(4, "0")}`,
    answerLocale: "zh-CN",
  });
  return created.body["payload"] as { threadId: string };
}

async function send(
  h: Harness,
  client: PairedClient,
  voice: unknown,
  threadId: string,
  options: { readonly text?: string; readonly id?: string } = {},
) {
  if (options.id === undefined) sequence += 1;
  const id = options.id ?? String(sequence).padStart(4, "0");
  return devicePost(h, client, "messages", {
    messageId: `device-message-voice-${id}`,
    threadId,
    expectedRevision: 1,
    text: options.text ?? "帮我把明天的会改到下午",
    utteranceId: `utterance-voice-${id}`,
    voice,
  });
}

function named(voice: unknown): unknown {
  return typeof voice === "object" &&
    voice !== null &&
    (voice as { trigger?: unknown }).trigger !== "hands_on" &&
    !("heardName" in voice)
    ? { ...voice, heardName: "Himawari" }
    : voice;
}

const say = (h: Harness, client: PairedClient, voice: unknown, threadId: string) =>
  send(h, client, named(voice), threadId);

const askedSentences = (h: Harness) =>
  h.decisions.requests.map(
    (request) =>
      (
        (request.body["input"] as { content: { data: { heardSentence: string } }[] }[])[0]
          ?.content[0]?.data as { heardSentence: string }
      ).heardSentence,
  );

const commands = (h: Harness) =>
  h.repository.perception().commandUtterances({
    ownerId,
    agentId,
    utteranceIds: Array.from(
      { length: sequence },
      (_, index) => `utterance-voice-${String(index + 1).padStart(4, "0")}`,
    ),
  });

async function setup() {
  const h = await harness();
  const client = await pairAndConfirm(h);
  const { threadId } = await conversation(h, client);
  return { h, client, threadId };
}

describe("[iOS-8] the server decides whether a spoken sentence is the owner's command", () => {
  it("carries out a sentence after the owner touched the device, without voice recognition", async () => {
    const { h, client, threadId } = await setup();
    const sent = await say(h, client, { trigger: "hands_on" }, threadId);
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(await commands(h)).toEqual([`utterance-voice-${String(sequence).padStart(4, "0")}`]);
  });

  it("carries out a name call through AirPods only when all three checks hold", async () => {
    const { h, client, threadId } = await setup();
    const ok = { trigger: "airpods_name", inputRoute: "airpods", inEar: true, loudnessScore: 820 };
    expect((await say(h, client, ok, threadId)).status).toBe(200);
    for (const [voice, reason] of [
      [{ ...ok, inputRoute: "device_microphone" }, "airpods_route_mismatch"],
      [{ ...ok, inEar: false }, "airpods_not_in_ear"],
      [
        { trigger: "airpods_name", inputRoute: "airpods", loudnessScore: 820 },
        "airpods_not_in_ear",
      ],
      [{ ...ok, loudnessScore: 400 }, "airpods_far"],
      [{ trigger: "airpods_name", inputRoute: "airpods", inEar: true }, "airpods_far"],
    ] as const) {
      const refused = await say(h, client, voice, threadId);
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual({ error: { code: "VOICE_COMMAND_UNCONFIRMED", reason } });
    }
    expect(await commands(h)).toHaveLength(1);
  });

  it("asks back instead of acting on a name called at a phone lying nearby", async () => {
    const { h, client, threadId } = await setup();
    const refused = await say(
      h,
      client,
      { trigger: "ambient_name", speakerScore: 1000, inputRoute: "device_microphone" },
      threadId,
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: { code: "VOICE_COMMAND_UNCONFIRMED", reason: "speaker_unconfirmed" },
    });
    expect(await commands(h)).toEqual([]);
  });

  it("acts on a name called nearby once the voice gate is qualified and the score passes", async () => {
    const { h, client, threadId } = await setup();
    h.voiceGates.current = {
      ...DEFAULT_VOICE_GATES,
      ambientCommand: { ...DEFAULT_VOICE_GATES.ambientCommand, defaultThreshold: 900 },
    };
    const low = await say(h, client, { trigger: "ambient_name", speakerScore: 899 }, threadId);
    expect(low.status).toBe(409);
    const high = await say(h, client, { trigger: "ambient_name", speakerScore: 950 }, threadId);
    expect(high.status, JSON.stringify(high.body)).toBe(200);
  });

  it("accepts the name the phone heard, up to 64 characters, on a name call", async () => {
    const { h, client, threadId } = await setup();
    const ok = { trigger: "airpods_name", inputRoute: "airpods", inEar: true, loudnessScore: 820 };
    for (const heardName of ["Himawari", "向日葵", "ひ".repeat(64)])
      expect((await say(h, client, { ...ok, heardName }, threadId)).status).toBe(200);
    expect(await commands(h)).toHaveLength(3);
  });

  it("ignores a device that tries to report its own verdict and rejects malformed evidence", async () => {
    const { h, client, threadId } = await setup();
    for (const voice of [
      { trigger: "ambient_name", owner: true },
      { trigger: "ambient_name", verdict: "accepted" },
      { trigger: "shout" },
      { trigger: "ambient_name", speakerScore: 1001 },
      { trigger: "ambient_name", speakerScore: 0.9 },
      { trigger: "airpods_name", inEar: "yes" },
      { trigger: "airpods_name", inputRoute: "bluetooth" },
      { trigger: "ambient_name", heardName: "" },
      { trigger: "ambient_name", heardName: "x".repeat(65) },
      { trigger: "ambient_name", heardName: " Himawari" },
      { trigger: "ambient_name", heardName: "Hima\u0000wari" },
      { trigger: "ambient_name", heardName: 7 },
      { trigger: "hands_on", heardName: "Himawari" },
      "hands_on",
    ])
      expect((await send(h, client, voice, threadId)).status).toBe(400);
    sequence += 1;
    const withoutUtterance = await devicePost(h, client, "messages", {
      messageId: `device-message-voice-${String(sequence).padStart(4, "0")}`,
      threadId,
      expectedRevision: 1,
      text: "帮我把明天的会改到下午",
      voice: { trigger: "hands_on" },
    });
    expect(withoutUtterance.status).toBe(400);
    expect(await commands(h)).toEqual([]);
  });
});

const airpods = { trigger: "airpods_name", inputRoute: "airpods", inEar: true, loudnessScore: 820 };

describe("[iOS-8] the decision model decides whether a name call is meant for Himawari", () => {
  it("carries out a call to Himawari, wherever the name sits, and sends the model nothing else", async () => {
    const { h, client, threadId } = await setup();
    for (const text of ["Himawari，帮我把明天的会改到下午", "把明天的会改到下午三点，Himawari"]) {
      const sent = await send(h, client, { ...airpods, heardName: "Himawari" }, threadId, { text });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    }
    expect(await commands(h)).toHaveLength(2);
    expect(h.decisions.requests).toHaveLength(2);
    const request = h.decisions.requests[0];
    expect(request?.authorization).toBe(`Bearer ${DECISION_GATEWAY_KEY}`);
    expect(request?.body).toEqual({
      model: DECISION_MODEL,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_json",
              data: {
                assistantName: "Himawari",
                heardSentence: "Himawari，帮我把明天的会改到下午",
              },
            },
          ],
        },
      ],
      questions: [
        { type: "predicate", name: "addressed", instructions: VOICE_ADDRESSEE_QUESTION.text },
      ],
      providerOptions: { gateway: { zeroDataRetention: true } },
    });
  });

  it("does nothing, and stays quiet, when the owner only mentions Himawari to someone else", async () => {
    const { h, client, threadId } = await setup();
    h.decisions.answer = () => decisionAnswer(0.05);
    const refused = await send(h, client, { ...airpods, heardName: "Himawari" }, threadId, {
      text: "我跟你说，Himawari 昨天帮我订了会议室",
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: { code: "VOICE_COMMAND_UNCONFIRMED", reason: "not_addressed" },
    });
    expect(await commands(h)).toEqual([]);
  });

  it("asks first when the model is not sure, fails, times out or answers for another model", async () => {
    const { h, client, threadId } = await setup();
    for (const answer of [
      () => decisionAnswer(0.5),
      () => ({ status: 500, body: { error: { type: "internal" } } }),
      () => decisionAnswer(0.97, "typesafe-ai/other"),
      () => ({ status: 200, body: { model: DECISION_MODEL, answers: [] } }),
    ]) {
      h.decisions.answer = answer;
      const refused = await say(h, client, airpods, threadId);
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual({
        error: { code: "VOICE_COMMAND_UNCONFIRMED", reason: "addressed_unsure" },
      });
    }
    h.addressee.current = { ...h.addressee.current, timeoutMs: 200 };
    h.decisions.answer = () => ({ ...decisionAnswer(0.97), delayMs: 1000 });
    const late = await say(h, client, airpods, threadId);
    expect(late.body).toEqual({
      error: { code: "VOICE_COMMAND_UNCONFIRMED", reason: "addressed_unsure" },
    });
    expect(await commands(h)).toEqual([]);
  });

  it("asks first without calling the model when the phone did not say which name it heard", async () => {
    const { h, client, threadId } = await setup();
    const refused = await send(h, client, airpods, threadId);
    expect(refused.body).toEqual({
      error: { code: "VOICE_COMMAND_UNCONFIRMED", reason: "addressed_unsure" },
    });
    expect(h.decisions.requests).toEqual([]);
  });

  it("never asks the model about a sentence said after touching the phone", async () => {
    const { h, client, threadId } = await setup();
    expect((await send(h, client, { trigger: "hands_on" }, threadId)).status).toBe(200);
    expect(h.decisions.requests).toEqual([]);
  });

  it("keeps its first answer when the phone sends the same sentence again", async () => {
    const { h, client, threadId } = await setup();
    h.decisions.answer = () => decisionAnswer(0.05);
    const first = await say(h, client, airpods, threadId);
    expect(first.status).toBe(409);
    h.decisions.answer = () => decisionAnswer(0.97);
    const again = await send(h, client, named(airpods), threadId, {
      id: String(sequence).padStart(4, "0"),
      text: "帮我把明天的会改到下午。",
    });
    expect(again.body).toEqual({
      error: { code: "VOICE_COMMAND_UNCONFIRMED", reason: "not_addressed" },
    });
    expect(h.decisions.requests).toHaveLength(1);
    expect(await commands(h)).toEqual([]);
  });

  it("masks a code before the sentence leaves for the decision model", async () => {
    const { h, client, threadId } = await setup();
    await send(h, client, named(airpods), threadId, {
      text: "Himawari，验证码是 482910，帮我填上",
    });
    expect(askedSentences(h)).toHaveLength(1);
    expect(askedSentences(h)[0]).not.toContain("482910");
  });

  it("asks first instead of calling the model once the day's perception model cost limit is used up", async () => {
    const { h, client, threadId } = await setup();
    const settings = await h.perception.settings({ ownerId, agentId });
    await h.perception.changeSettings({ ownerId, agentId }, settings.revision, {
      kind: "limit",
      key: "perception.model_cost.daily",
      value: 0,
    });
    const refused = await say(h, client, airpods, threadId);
    expect(refused.body).toEqual({
      error: { code: "VOICE_COMMAND_UNCONFIRMED", reason: "addressed_budget" },
    });
    expect(h.decisions.requests).toEqual([]);
  });

  it("asks first once a phone sends more name calls in a minute than allowed", async () => {
    const { h, client, threadId } = await setup();
    h.addressee.current = { ...h.addressee.current, perDevicePerMinute: 1 };
    expect((await say(h, client, airpods, threadId)).status).toBe(200);
    const refused = await say(h, client, airpods, threadId);
    expect(refused.body).toEqual({
      error: { code: "VOICE_COMMAND_UNCONFIRMED", reason: "addressed_unsure" },
    });
    expect(h.decisions.requests).toHaveLength(1);
  });

  it("asks the model once when the same sentence arrives twice at the same time", async () => {
    const { h, client, threadId } = await setup();
    h.decisions.answer = () => ({ ...decisionAnswer(0.97), delayMs: 300 });
    sequence += 1;
    const id = String(sequence).padStart(4, "0");
    const post = (messageId: string) =>
      devicePost(h, client, "messages", {
        messageId,
        threadId,
        expectedRevision: 1,
        text: "帮我把明天的会改到下午",
        utteranceId: `utterance-voice-${id}`,
        voice: named(airpods),
      });
    const [first, second] = await Promise.all([
      post(`device-message-voice-${id}-a`),
      post(`device-message-voice-${id}-b`),
    ]);
    expect(first.status).toBe(second.status);
    expect(h.decisions.requests).toHaveLength(1);
  });

  it("asks first when the decision model's answer is larger than the limit", async () => {
    const { h, client, threadId } = await setup();
    h.decisions.answer = () => ({
      status: 200,
      body: { ...decisionAnswer(0.97).body, padding: "x".repeat(70_000) },
    });
    const refused = await say(h, client, airpods, threadId);
    expect(refused.body).toEqual({
      error: { code: "VOICE_COMMAND_UNCONFIRMED", reason: "addressed_unsure" },
    });
    expect(await commands(h)).toEqual([]);
  });

  it("puts the fixed question before the sentence in the request to the decision model", async () => {
    const { h, client, threadId } = await setup();
    await say(h, client, airpods, threadId);
    expect(Object.keys(h.decisions.requests[0]?.body ?? {})).toEqual([
      "model",
      "questions",
      "input",
      "providerOptions",
    ]);
  });
});
