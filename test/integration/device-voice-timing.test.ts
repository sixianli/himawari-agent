import { createHash } from "node:crypto";
import { createSessionId } from "@himawari-agent/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentId,
  createThread,
  type Harness,
  harness,
  ownerId,
  type PairedClient,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
  send,
  signedRequest,
} from "../fixtures/device-api-harness.ts";

afterEach(removeDeviceHarnessDirectories);

const SAID = "2026-11-26T03:00:00.000Z";
const TEXT = "2026-11-26T03:00:01.200Z";
const SOUND = "2026-11-26T03:00:01.900Z";

const post = (h: Harness, client: PairedClient, path: string, body: unknown) =>
  send(
    h,
    signedRequest(h, client, {
      method: "POST",
      path: `/api/device/v1/${path}`,
      body: JSON.stringify(body),
    }),
  );

const get = (h: Harness, client: PairedClient, path: string) =>
  send(h, signedRequest(h, client, { method: "GET", path: `/api/device/v1/${path}` }));

async function answeredTurn(h: Harness, client: PairedClient, messageId: string) {
  await createThread(h, "thread-voice-timing");
  const sent = await post(h, client, "messages", {
    messageId,
    threadId: "thread-voice-timing",
    expectedRevision: 1,
    text: "今天东京天气怎么样",
    spoken: true,
  });
  expect(sent.statusCode, sent.body).toBe(200);
  const suffix = createHash("sha256")
    .update(`${client.deviceId}\n${messageId}`)
    .digest("hex")
    .slice(0, 40);
  const runId = `run:${suffix}`;
  const device = await h.repository.pairedDevices().readDevice(client.deviceId);
  const session = await h.repository
    .sessionDeviceState()
    .readSession(createSessionId(device?.webSessionId ?? ""));
  if (!session) throw new Error("NO_SESSION");
  const detail = await get(h, client, "threads/thread-voice-timing");
  const run = (detail.json().payload.runs as { runId: string }[]).find(
    (entry) => entry.runId === runId,
  );
  expect(run).toBeDefined();
  const trace = h.repository.traceStore();
  await trace.appendNext({
    id: `trace:started:${runId}`,
    schemaVersion: "trace.v1",
    ownerId,
    agentId,
    sessionId: session.id,
    threadId: "thread-voice-timing" as never,
    runId: runId as never,
    turnId: null,
    parentEventId: null,
    causationId: null,
    correlationId: "correlation:voice-timing" as never,
    occurredAt: SAID,
    recordedAt: SAID,
    actorId: "agent",
    dataClassification: "private",
    eventType: "runtime.turn_started",
    payloadRef: null,
  } as never);
  return runId;
}

describe("[VOICE-TIMING] the phone reports when she was heard", () => {
  it("records the three times on the answered turn and shows them in its execution record", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const runId = await answeredTurn(h, client, "device-message-timing-0001");
    const body = {
      messageId: "device-message-timing-0001",
      saidAt: SAID,
      firstTextAt: TEXT,
      firstSoundAt: SOUND,
    };
    expect((await post(h, client, "voice-timing", body)).statusCode).toBe(200);
    expect((await post(h, client, "voice-timing", body)).statusCode).toBe(200);
    const recorded = (await h.repository.traceStore().readRun(runId as never, 0, 20)).filter(
      ({ eventType }) => eventType === "device.voice_timing",
    );
    expect(recorded).toHaveLength(1);
    const steps = await get(h, client, `threads/thread-voice-timing/runs/${runId}/execution`);
    expect(steps.statusCode, steps.body).toBe(200);
    const records = steps.json().payload.records as { name: string; text: string }[];
    const timing = records.find(({ name }) => name === "device.voice_timing");
    expect(JSON.parse(timing?.text ?? "{}")).toEqual({
      messageId: "device-message-timing-0001",
      emittedAt: null,
      saidAt: SAID,
      firstTextAt: TEXT,
      firstSoundAt: SOUND,
    });
    await h.repository.close();
  });

  it("lists the latest turns newest first, caps the limit, and starts empty", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const empty = await get(h, client, "voice-timing");
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json().payload ?? empty.json()).toMatchObject({ items: [] });
    await answeredTurn(h, client, "device-message-timing-0010");
    await post(h, client, "voice-timing", {
      messageId: "device-message-timing-0010",
      saidAt: SAID,
      firstTextAt: TEXT,
      firstSoundAt: null,
    });
    const listed = await get(h, client, "voice-timing?limit=20");
    expect(listed.statusCode, listed.body).toBe(200);
    const body = listed.json();
    expect(body.payload ?? body).toEqual({
      items: [
        {
          messageId: "device-message-timing-0010",
          saidAt: SAID,
          firstTextAt: TEXT,
          firstSoundAt: null,
          emittedAt: null,
        },
      ],
    });
    for (const bad of ["limit=0", "limit=abc", "limit=-1", "limit=1000"])
      expect((await get(h, client, `voice-timing?${bad}`)).statusCode).toBe(
        bad === "limit=1000" ? 200 : 400,
      );
    await h.repository.close();
  });

  it("accepts a turn whose first sound never played, with firstSoundAt null", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await answeredTurn(h, client, "device-message-timing-0002");
    const sent = await post(h, client, "voice-timing", {
      messageId: "device-message-timing-0002",
      saidAt: SAID,
      firstTextAt: TEXT,
      firstSoundAt: null,
    });
    expect(sent.statusCode, sent.body).toBe(200);
    await h.repository.close();
  });

  it("turns away a turn that does not exist, and bad times", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await answeredTurn(h, client, "device-message-timing-0003");
    const good = {
      messageId: "device-message-timing-0003",
      saidAt: SAID,
      firstTextAt: TEXT,
      firstSoundAt: SOUND,
    };
    expect(
      (await post(h, client, "voice-timing", { ...good, messageId: "device-message-unknown-1" }))
        .statusCode,
    ).toBe(404);
    for (const bad of [
      { saidAt: "yesterday" },
      { firstTextAt: 12 },
      { firstSoundAt: "2026-11-26" },
      { messageId: "x" },
      { extra: true },
    ])
      expect((await post(h, client, "voice-timing", { ...good, ...bad })).statusCode).toBe(400);
    const missing: Record<string, unknown> = { ...good };
    delete missing["firstSoundAt"];
    expect((await post(h, client, "voice-timing", missing)).statusCode).toBe(400);
    const traced = await h.repository
      .traceStore()
      .readRun(
        `run:${createHash("sha256")
          .update(`${client.deviceId}\ndevice-message-timing-0003`)
          .digest("hex")
          .slice(0, 40)}` as never,
        0,
        20,
      );
    expect(traced.some(({ eventType }) => eventType === "device.voice_timing")).toBe(false);
    await h.repository.close();
  });
});
