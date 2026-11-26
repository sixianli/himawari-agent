import { DEFAULT_VOICE_GATES } from "@himawari-agent/application";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentId,
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

const commands = (h: Harness) =>
  h.repository.perception().commandUtterances({
    ownerId,
    agentId,
    utteranceIds: Array.from(
      { length: sequence },
      (_, index) => `utterance-voice-${String(index + 1).padStart(4, "0")}`,
    ),
  });

async function setup(options: Parameters<typeof harness>[0] = {}) {
  const h = await harness(options);
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

async function latestRunSource(h: Harness, threadId: string) {
  const runs = await h.repository.threadRepository().listRuns(ownerId, agentId, threadId as never);
  const latest = [...runs]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);
  if (!latest) throw new Error("NO_RUN_FOR_MESSAGE");
  return h.repository.runExecutionSource(ownerId, agentId).read(latest.runId);
}

describe("[iOS-8] a name call is the owner's own voice; whether it was meant for her is left to her", () => {
  it("accepts a name call whatever the sentence says, with no other model deciding first", async () => {
    const { h, client, threadId } = await setup();
    for (const text of [
      "Himawari，帮我把明天的会改到下午",
      "我跟你说，Himawari 昨天提醒我交房租了",
    ]) {
      const sent = await send(h, client, { ...airpods, heardName: "Himawari" }, threadId, { text });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    }
    expect(await commands(h)).toHaveLength(2);
  });

  it("marks a name call as heard by the phone so she judges it, and leaves a touch unmarked", async () => {
    const { h, client, threadId } = await setup();
    h.voiceGates.current = {
      ...DEFAULT_VOICE_GATES,
      ambientCommand: { ...DEFAULT_VOICE_GATES.ambientCommand, defaultThreshold: 900 },
    };
    const named = await send(h, client, { ...airpods, heardName: "Himawari" }, threadId);
    expect(named.status).toBe(200);
    expect((await latestRunSource(h, threadId))?.viaPhoneVoice).toBe(true);
    const nearby = await send(
      h,
      client,
      { trigger: "ambient_name", speakerScore: 950, heardName: "Himawari" },
      threadId,
      { id: "ambient" },
    );
    expect(nearby.status).toBe(200);
    expect((await latestRunSource(h, threadId))?.viaPhoneVoice).toBe(true);
    const touched = await send(h, client, { trigger: "hands_on" }, threadId);
    expect(touched.status).toBe(200);
    expect((await latestRunSource(h, threadId))?.viaPhoneVoice).toBeUndefined();
  });

  it("still turns away a voice that is not the owner's, without reaching her at all", async () => {
    const { h, client, threadId } = await setup();
    h.voiceGates.current = {
      ...DEFAULT_VOICE_GATES,
      ambientCommand: { ...DEFAULT_VOICE_GATES.ambientCommand, defaultThreshold: 900 },
    };
    const refused = await send(
      h,
      client,
      { trigger: "ambient_name", speakerScore: 100, heardName: "Himawari" },
      threadId,
    );
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({
      error: { code: "VOICE_COMMAND_UNCONFIRMED", reason: "speaker_unconfirmed" },
    });
    expect(await commands(h)).toEqual([]);
  });
});

describe("the phone's talk mode tells her this turn was spoken, without any voice proof", () => {
  const talk = (
    h: Harness,
    client: PairedClient,
    threadId: string,
    body: Record<string, unknown>,
  ) => {
    sequence += 1;
    return devicePost(h, client, "messages", {
      messageId: `device-message-talk-${String(sequence).padStart(4, "0")}`,
      threadId,
      expectedRevision: 1,
      text: "今天东京天气怎么样",
      ...body,
    });
  };

  it("marks a spoken turn as spoken, and a typed turn never", async () => {
    const { h, client, threadId } = await setup();
    const spoken = await talk(h, client, threadId, { spoken: true });
    expect(spoken.status, JSON.stringify(spoken.body)).toBe(200);
    const source = await latestRunSource(h, threadId);
    expect(source?.viaTalk).toBe(true);
    expect(source?.viaPhoneVoice).toBeUndefined();
    const typed = await talk(h, client, threadId, {});
    expect(typed.status).toBe(200);
    const typedSource = await latestRunSource(h, threadId);
    expect(typedSource?.viaTalk).toBeUndefined();
  });

  it("turns away a spoken flag that is not true, or that arrives with a voice proof", async () => {
    const { h, client, threadId } = await setup();
    for (const body of [
      { spoken: false },
      { spoken: "yes" },
      { spoken: true, utteranceId: "utterance-talk-1", voice: { trigger: "hands_on" } },
    ])
      expect((await talk(h, client, threadId, body)).status).toBe(400);
    expect(await commands(h)).toEqual([]);
  });
});
