import { readdir } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { ownerDayBounds } from "@himawari-agent/application";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Harness,
  harness,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
} from "../fixtures/device-api-harness.ts";
import {
  beginUpload,
  deviceGet,
  devicePost,
  ingest,
  perceptionScope,
  power,
  sha256,
  upload,
  utterance,
} from "../fixtures/perception-test-client.ts";

afterEach(removeDeviceHarnessDirectories);

async function setLimit(h: Harness, key: string, value: number | null) {
  const settings = await h.perception.settings(perceptionScope);
  return h.perception.changeSettings(perceptionScope, settings.revision, {
    kind: "limit",
    key,
    value,
  });
}

async function limitView(h: Harness, key: string) {
  const usage = await h.perception.usage(perceptionScope);
  const view = usage.limits.find((limit) => limit.key === key);
  if (!view) throw new Error(`missing ${key}`);
  return view;
}

describe("usage limits", () => {
  it("reports zero usage for every limit before anything is recorded", async () => {
    const h = await harness();
    const usage = await h.perception.usage(perceptionScope);
    expect(usage.limits.length).toBeGreaterThan(5);
    expect(usage.limits.every(({ used }) => used === 0)).toBe(true);
    expect(usage.limits.every(({ state }) => state === "ok")).toBe(true);
    expect(usage.limits.some(({ key }) => key === "proactive.dailyCostMicros")).toBe(false);
  });

  it("stops low value records first when the daily record limit is reached and resumes the next owner day", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await setLimit(h, "perception.records.daily", 3);
    const records = [
      power(h, -9),
      utterance(h, "一", { seconds: -8 }),
      power(h, -7),
      utterance(h, "二", { seconds: -6 }),
      utterance(h, "三", { seconds: -5 }),
    ];
    const result = await ingest(h, client, records);
    expect(result.outcomes.map(({ outcome }) => outcome)).toEqual([
      "limit_reached",
      "stored",
      "limit_reached",
      "stored",
      "stored",
    ]);
    expect(result.reached).toEqual(["perception.records.daily"]);
    const stopped = await limitView(h, "perception.records.daily");
    expect([stopped.used, stopped.limit, stopped.state]).toEqual([3, 3, "stopped"]);
    const more = await ingest(h, client, [utterance(h, "四", { seconds: -4 })]);
    expect(more.outcomes[0]?.outcome).toBe("limit_reached");
    h.clock.set(stopped.resetsAt);
    const nextDay = await ingest(h, client, [utterance(h, "新的一天")]);
    expect(nextDay.outcomes[0]?.outcome).toBe("stored");
    const fresh = await limitView(h, "perception.records.daily");
    expect([fresh.used, fresh.state]).toEqual([1, "ok"]);
  });

  it("stops speech at the daily audio limit while other records keep arriving", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await setLimit(h, "perception.audio.daily", 3000);
    const result = await ingest(h, client, [
      utterance(h, "第一句", { seconds: -5, durationMs: 2000 }),
      utterance(h, "第二句", { seconds: -4, durationMs: 2000 }),
      power(h, -3),
    ]);
    expect(result.outcomes.map(({ outcome }) => outcome)).toEqual([
      "stored",
      "limit_reached",
      "stored",
    ]);
    expect(result.reached).toEqual(["perception.audio.daily"]);
    expect((await limitView(h, "perception.audio.daily")).used).toBe(2000);
  });

  it("warns once when usage comes near a limit and never for usage below the threshold", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await setLimit(h, "perception.records.daily", 10);
    await ingest(
      h,
      client,
      Array.from({ length: 7 }, (_, index) => power(h, -20 + index)),
    );
    expect(h.limitWarnings).toEqual([]);
    expect((await limitView(h, "perception.records.daily")).state).toBe("ok");
    await ingest(h, client, [power(h, -5)]);
    expect(h.limitWarnings).toEqual([
      { event: "perception.limit_near", key: "perception.records.daily", used: 8, limit: 10 },
    ]);
    expect((await limitView(h, "perception.records.daily")).state).toBe("near");
    await ingest(h, client, [power(h, -4)]);
    expect(h.limitWarnings).toHaveLength(1);
  });

  it("starts a new period at owner midnight, including a 25 hour day when clocks change", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    h.clock.set("2026-11-12T14:59:30.000Z");
    await ingest(h, client, [power(h, -1)]);
    const before = await limitView(h, "perception.records.daily");
    expect(before.used).toBe(1);
    expect(before.resetsAt).toBe("2026-11-12T15:00:00.000Z");
    h.clock.set("2026-11-12T15:00:30.000Z");
    expect((await limitView(h, "perception.records.daily")).used).toBe(0);
    expect((await h.perception.status(perceptionScope)).day).toBe("2026-11-13");

    expect(ownerDayBounds("2026-11-01T12:00:00.000Z", "America/New_York")).toEqual({
      day: "2026-11-01",
      start: "2026-11-01T04:00:00.000Z",
      end: "2026-11-02T05:00:00.000Z",
    });
    expect(ownerDayBounds("2026-03-08T12:00:00.000Z", "America/New_York")).toEqual({
      day: "2026-03-08",
      start: "2026-03-08T05:00:00.000Z",
      end: "2026-03-09T04:00:00.000Z",
    });
  });

  it("never lets overlapping reservations pass the limit", async () => {
    const h = await harness();
    const store = h.repository.perception();
    const periodStart = ownerDayBounds(h.clock.now(), h.timeZone.current).start;
    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        store.reserveUsage({
          ...perceptionScope,
          key: "perception.images.daily",
          periodStart,
          amount: 1,
          limit: 10,
        }),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(10);
    expect((await limitView(h, "perception.images.daily")).used).toBe(10);
    expect(
      await store.reserveUsage({
        ...perceptionScope,
        key: "perception.images.daily",
        periodStart,
        amount: 0,
        limit: 10,
      }),
    ).toBe(true);
  });

  it("records a limit change as a decision and refuses values outside the allowed range", async () => {
    const h = await harness();
    const ledger = h.repository.decisionLedger();
    const read = async () =>
      (
        await ledger.list({
          ...perceptionScope,
          kind: "limit_change",
          since: "2026-01-01T00:00:00.000Z",
          limit: 10,
        })
      ).map(({ outcome, reasonCode, subjectRef, inputs }) => ({
        outcome,
        reasonCode,
        subjectRef,
        limitChange: inputs.limitChange,
      }));
    expect(await read()).toEqual([]);
    await setLimit(h, "perception.images.daily", 500);
    expect(await read()).toEqual([]);
    await setLimit(h, "perception.images.daily", 200);
    expect(await read()).toEqual([
      {
        outcome: "changed",
        reasonCode: "limit_changed_by_owner",
        subjectRef: "limit:perception.images.daily",
        limitChange: { key: "perception.images.daily", from: 500, to: 200 },
      },
    ]);
    expect((await limitView(h, "perception.images.daily")).limit).toBe(200);
    await setLimit(h, "perception.images.daily", null);
    expect((await limitView(h, "perception.images.daily")).limit).toBe(500);
    expect(await read()).toHaveLength(2);
    for (const [key, value] of [
      ["perception.images.daily", -1],
      ["perception.images.daily", 100_001],
      ["perception.images.daily", 1.5],
      ["device.battery.listening", 20],
      ["proactive.dailyCostMicros", 5],
      ["perception.unknown", 5],
    ] as const)
      await expect(setLimit(h, key, value)).rejects.toMatchObject({
        code: "PERCEPTION_SETTINGS_INVALID",
      });
    expect(await read()).toHaveLength(2);
  });

  it("refuses a media file once the daily media bytes are used up", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await setLimit(h, "perception.media.daily_bytes", 40);
    const send = async (content: string, batchId: string) => {
      const bytes = Buffer.from(content);
      const begun = await beginUpload(h, client, {
        purpose: "media",
        sha256: sha256(bytes),
        bytes: bytes.length,
        batchId,
        mediaKind: "image",
      });
      expect(begun.status, JSON.stringify(begun.body)).toBe(201);
      return upload(h, begun.target, bytes);
    };
    const first = await send("a".repeat(30), "media-batch-000000000a");
    expect(first.body).toMatchObject({ stored: true, reached: [] });
    const second = await send("b".repeat(30), "media-batch-000000000b");
    expect(second.body).toMatchObject({
      stored: false,
      reached: ["perception.media.daily_bytes"],
    });
    expect((await limitView(h, "perception.media.daily_bytes")).used).toBe(30);
    expect(await readdir(path.join(h.stateRoot, "device-uploads", "media"))).toEqual([
      sha256(Buffer.from("a".repeat(30))),
    ]);
  });

  it("counts every image and screen capture against the daily image limit and never audio", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await setLimit(h, "perception.images.daily", 2);
    const send = async (content: string, batchId: string, mediaKind: string) => {
      const bytes = Buffer.from(content);
      const begun = await beginUpload(h, client, {
        purpose: "media",
        sha256: sha256(bytes),
        bytes: bytes.length,
        batchId,
        mediaKind,
        ...(mediaKind === "audio" ? { durationMs: 1000 } : {}),
      });
      expect(begun.status, JSON.stringify(begun.body)).toBe(201);
      return (await upload(h, begun.target, bytes)).body;
    };
    expect(await send("image-one", "media-batch-00000000i1", "image")).toMatchObject({
      stored: true,
    });
    expect(await send("screen-one", "media-batch-00000000i2", "screen")).toMatchObject({
      stored: true,
    });
    expect(await send("image-two", "media-batch-00000000i3", "image")).toMatchObject({
      stored: false,
      reached: ["perception.images.daily"],
    });
    expect(await send("some-audio", "media-batch-00000000i4", "audio")).toMatchObject({
      stored: true,
    });
    expect((await limitView(h, "perception.images.daily")).used).toBe(2);
    expect((await readdir(path.join(h.stateRoot, "device-uploads", "media"))).sort()).toEqual(
      ["image-one", "screen-one", "some-audio"].map((text) => sha256(Buffer.from(text))).sort(),
    );
  });

  it("keeps no stored text for records the daily limit turned away", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await setLimit(h, "perception.records.daily", 1);
    const result = await ingest(h, client, [
      utterance(h, "留下的一句", { seconds: -8 }),
      utterance(h, "被挡下的一句", { seconds: -6 }),
      utterance(h, "也被挡下的一句", { seconds: -4 }),
    ]);
    expect(result.outcomes.map(({ outcome }) => outcome)).toEqual([
      "stored",
      "limit_reached",
      "limit_reached",
    ]);
    const database = new Database(path.join(h.stateRoot, "product.sqlite"), { readonly: true });
    try {
      expect(
        database
          .prepare(
            `SELECT (SELECT COUNT(*) FROM payloads WHERE ref LIKE 'payload:http:%') AS payloads,
                    (SELECT COUNT(*) FROM perception_records WHERE content_ref IS NOT NULL) AS texts`,
          )
          .get(),
      ).toEqual({ payloads: 1, texts: 1 });
    } finally {
      database.close();
    }
  });

  it("serves usage and configuration to a device and takes the numbers a device reports", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await ingest(h, client, [power(h, -1)]);
    const reported = await devicePost(h, client, "usage/report", {
      "device.queue.bytes": 4096,
      "device.battery.listening": 35,
    });
    expect(reported.status, JSON.stringify(reported.body)).toBe(200);
    const usage = await deviceGet(h, client, "usage");
    expect(usage.status).toBe(200);
    const limits = usage.body["limits"] as { key: string; used: number; devices: unknown[] }[];
    expect(limits.find(({ key }) => key === "perception.records.daily")?.used).toBe(1);
    expect(limits.find(({ key }) => key === "device.queue.bytes")).toMatchObject({
      used: 4096,
      devices: [{ deviceId: client.deviceId, used: 4096 }],
    });
    for (const body of [
      { "perception.records.daily": 1 },
      { "device.battery.listening": 101 },
      { "device.queue.bytes": -1 },
      {},
    ]) {
      const refused = await devicePost(h, client, "usage/report", body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
    const config = await deviceGet(h, client, "config");
    expect(config.status).toBe(200);
    const perception = config.body["perception"] as {
      state: string;
      senses: { sense: string; enabled: boolean }[];
      usageLimits: { key: string }[];
    };
    expect(perception.state).toBe("sensing");
    expect(perception.senses.every(({ enabled }) => enabled)).toBe(true);
    expect(perception.usageLimits.map(({ key }) => key)).toContain("perception.audio.daily");
  });
});
