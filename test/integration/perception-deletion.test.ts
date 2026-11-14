import { readdir } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Harness,
  harness,
  type PairedClient,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
} from "../fixtures/device-api-harness.ts";
import {
  atOffset,
  beginUpload,
  deviceGet,
  devicePost,
  ingest,
  ndjson,
  perceptionScope,
  power,
  sha256,
  upload,
  utterance,
  visit,
} from "../fixtures/perception-test-client.ts";

afterEach(removeDeviceHarnessDirectories);

function sql(h: Harness, statement: string, ...parameters: unknown[]): unknown[] {
  const database = new Database(path.join(h.stateRoot, "product.sqlite"), { readonly: true });
  try {
    return database
      .prepare(statement)
      .raw(false)
      .all(...parameters);
  } finally {
    database.close();
  }
}

function scalar(h: Harness, statement: string, ...parameters: unknown[]): unknown {
  const row = sql(h, statement, ...parameters)[0] as Record<string, unknown> | undefined;
  return row ? Object.values(row)[0] : undefined;
}

const empty = { ids: [] as string[], episodeId: null, day: null, deviceId: null, types: [] };

async function remaining(h: Harness) {
  return h.perception.listDay({
    scope: perceptionScope,
    day: null,
    sense: null,
    types: null,
    cursor: null,
  });
}

async function tracks(h: Harness, client: PairedClient, seconds: readonly number[], batch: string) {
  const points = ndjson(
    seconds.map((offset) => ({
      occurredAt: atOffset(h, offset),
      latitude: 35.1,
      longitude: 139.1,
    })),
  );
  const begun = await beginUpload(h, client, {
    purpose: "track",
    sha256: sha256(points),
    bytes: points.length,
    batchId: batch,
  });
  expect(begun.status, JSON.stringify(begun.body)).toBe(201);
  return upload(h, begun.target, points);
}

function trackCount(h: Harness, day: string): Promise<number> {
  return h.repository.perception().countTrackPoints({ ...perceptionScope, day });
}

describe("perception deletion", () => {
  it("deletes chosen records, hides them at once and reports what was removed", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const keep = utterance(h, "留下的话", { seconds: 0 });
    const drop = utterance(h, "要删的话", { seconds: 1 });
    const other = power(h, 2);
    await ingest(h, client, [keep, drop, other]);
    const plan = await h.perception.planDeletion(perceptionScope, {
      ...empty,
      kind: "records",
      ids: [drop.id, other.id],
    });
    expect(plan).toMatchObject({
      status: "planned",
      plan: { records: 2, trackPoints: 0, media: 0 },
    });
    const done = await h.perception.deleteRecords(perceptionScope, plan.id);
    expect(done.status).toBe("verified");
    expect(done.receipt).toEqual({ records: 2, trackPoints: 0, media: 0 });
    const page = await remaining(h);
    expect(page.total).toBe(1);
    const store = h.repository.perception();
    expect(await store.knownRecordIds({ ...perceptionScope, ids: [keep.id, drop.id] })).toEqual([
      keep.id,
    ]);
    const again = await h.perception.deleteRecords(perceptionScope, plan.id);
    expect(again.status).toBe("verified");
    expect(again.receipt).toEqual(done.receipt);
  });

  it("removes the text of deleted records and counts an episode down to nothing", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const first = utterance(h, "第一句", { seconds: 0 });
    const second = utterance(h, "第二句", { seconds: 5 });
    await ingest(h, client, [first, second]);
    const page = await remaining(h);
    const episode = page.rows.find((row) => row.kind === "episode");
    expect(episode?.kind === "episode" && episode.episode.recordCount).toBe(2);
    const episodeId = episode?.kind === "episode" ? episode.episode.id : "";
    const refs = (
      sql(h, "SELECT content_ref FROM perception_records WHERE content_ref IS NOT NULL") as {
        content_ref: string;
      }[]
    ).map((row) => row.content_ref);
    expect(refs).toHaveLength(2);
    const plan = await h.perception.planDeletion(perceptionScope, {
      ...empty,
      kind: "episode",
      episodeId,
    });
    expect(plan.plan.records).toBe(2);
    await h.perception.deleteRecords(perceptionScope, plan.id);
    expect((await remaining(h)).total).toBe(0);
    expect(
      scalar(
        h,
        "SELECT COUNT(*) FROM payloads WHERE ref IN (SELECT value FROM json_each(?))",
        JSON.stringify(refs),
      ),
    ).toBe(0);
    expect(
      sql(h, "SELECT status, record_count FROM perception_episodes WHERE id = ?", episodeId),
    ).toEqual([{ status: "deleted", record_count: 0 }]);
  });

  it("deletes a whole day of one device with its track points and leaves the other day", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await ingest(h, client, [utterance(h, "今天的话"), visit(h, 3)]);
    const stored = await tracks(h, client, [-20, -10], "track-batch-0000000001");
    expect(stored.body).toMatchObject({ stored: 2 });
    const day = (await remaining(h)).day;
    expect(await trackCount(h, day)).toBe(2);
    const plan = await h.perception.planDeletion(perceptionScope, {
      ...empty,
      kind: "day",
      day,
      deviceId: client.deviceId,
    });
    expect(plan.plan).toEqual({ records: 2, trackPoints: 2, media: 0 });
    const done = await h.perception.deleteRecords(perceptionScope, plan.id);
    expect(done.receipt).toEqual({ records: 2, trackPoints: 2, media: 0 });
    expect(await trackCount(h, day)).toBe(0);
    expect((await remaining(h)).total).toBe(0);
  });

  it("deletes by type, takes track points only for location types and keeps the other devices", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await ingest(h, client, [power(h, 0), power(h, 1), utterance(h, "话"), visit(h, 2)]);
    await tracks(h, client, [-20], "track-batch-0000000002");
    const day = (await remaining(h)).day;
    const environment = await h.perception.planDeletion(perceptionScope, {
      ...empty,
      kind: "types",
      types: ["context.power"],
    });
    expect(environment.plan).toEqual({ records: 2, trackPoints: 0, media: 0 });
    await h.perception.deleteRecords(perceptionScope, environment.id);
    expect(await trackCount(h, day)).toBe(1);
    const location = await h.perception.planDeletion(perceptionScope, {
      ...empty,
      kind: "types",
      types: ["location.visit"],
    });
    expect(location.plan).toEqual({ records: 1, trackPoints: 1, media: 0 });
    await h.perception.deleteRecords(perceptionScope, location.id);
    expect(await trackCount(h, day)).toBe(0);
    expect((await remaining(h)).total).toBe(1);
  });

  it("refuses an unknown device, an unknown episode, bad shapes and too many ids", async () => {
    const h = await harness();
    await pairAndConfirm(h);
    const plan = (target: unknown) => h.perception.planDeletion(perceptionScope, target);
    for (const target of [
      { ...empty, kind: "day", day: "2026-11-12", deviceId: "device-someone-else" },
      { ...empty, kind: "episode", episodeId: `episode:${"0".repeat(32)}` },
      { ...empty, kind: "records", ids: [] },
      { ...empty, kind: "records", ids: ["nope"] },
      { ...empty, kind: "records", ids: ["perception:aaaaaaaaaaaaaaaa"], day: "2026-11-12" },
      { ...empty, kind: "records", ids: ["perception:aaaaaaaaaaaaaaaa"], deviceId: "x" },
      { ...empty, kind: "day", day: "2026-13-40" },
      { ...empty, kind: "day", day: "2026-11-12", types: ["context.power"] },
      { ...empty, kind: "types", types: [] },
      { ...empty, kind: "types", types: ["speech.unknown"] },
      { ...empty, kind: "types", types: ["context.power", "context.power"] },
      { ...empty, kind: "everything" },
      { ...empty, kind: "types", types: ["context.power"], extra: 1 },
      { kind: "day", day: "2026-11-12" },
      null,
    ])
      await expect(plan(target), JSON.stringify(target)).rejects.toThrow();
    const tooMany = Array.from(
      { length: 501 },
      (_, index) => `perception:${String(index).padStart(20, "a")}`,
    );
    await expect(plan({ ...empty, kind: "records", ids: tooMany })).rejects.toThrow();
    expect(scalar(h, "SELECT COUNT(*) FROM perception_deletions")).toBe(0);
  });

  it("does not delete data recorded after the plan and refuses an expired or unknown plan", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await ingest(h, client, [utterance(h, "早先的话", { seconds: -60 })]);
    const day = (await remaining(h)).day;
    const plan = await h.perception.planDeletion(perceptionScope, { ...empty, kind: "day", day });
    h.clock.advance(1000);
    const later = utterance(h, "计划之后说的话", { seconds: 0 });
    await ingest(h, client, [later]);
    const done = await h.perception.deleteRecords(perceptionScope, plan.id);
    expect(done.receipt?.records).toBe(1);
    const page = await remaining(h);
    expect(page.total).toBe(1);
    const stale = await h.perception.planDeletion(perceptionScope, { ...empty, kind: "day", day });
    h.clock.advance(10 * 60 * 1000 + 1000);
    await expect(h.perception.deleteRecords(perceptionScope, stale.id)).rejects.toThrow(
      /PLAN_EXPIRED/u,
    );
    await expect(h.perception.deleteRecords(perceptionScope, "f".repeat(32))).rejects.toThrow(
      /DELETION_UNKNOWN/u,
    );
    expect((await remaining(h)).total).toBe(1);
  });

  it("refuses to take back deleted records when an offline device sends them again", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const sent = utterance(h, "删掉的话", { seconds: -30 });
    const kept = utterance(h, "没删的话", { seconds: -20 });
    await ingest(h, client, [sent, kept]);
    const plan = await h.perception.planDeletion(perceptionScope, {
      ...empty,
      kind: "records",
      ids: [sent.id],
    });
    await h.perception.deleteRecords(perceptionScope, plan.id);
    const again = await ingest(h, client, [sent, kept]);
    expect(again.outcomes).toEqual([
      { id: sent.id, outcome: "suppressed_by_deletion" },
      { id: kept.id, outcome: "duplicate" },
    ]);
    const dayPlan = await h.perception.planDeletion(perceptionScope, {
      ...empty,
      kind: "day",
      day: (await remaining(h)).day,
    });
    await h.perception.deleteRecords(perceptionScope, dayPlan.id);
    const lateOld = utterance(h, "离线时说的旧话", { seconds: -40 });
    const fresh = utterance(h, "之后说的新话", { seconds: 5 });
    const late = await ingest(h, client, [lateOld, fresh]);
    expect(late.outcomes).toEqual([
      { id: lateOld.id, outcome: "suppressed_by_deletion" },
      { id: fresh.id, outcome: "stored" },
    ]);
    expect((await remaining(h)).total).toBe(1);
  });

  it("deletes the raw file that was uploaded for a record, but not one another record still uses", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const first = utterance(h, "有录音的话", { seconds: -30 });
    const second = utterance(h, "共用录音的话", { seconds: -20 });
    await ingest(h, client, [first, second]);
    const audio = Buffer.from("raw-audio-bytes-for-deletion");
    const begun = await beginUpload(h, client, {
      purpose: "media",
      sha256: sha256(audio),
      bytes: audio.length,
      batchId: "media-batch-0000000010",
      mediaKind: "audio",
      durationMs: 5000,
      recordIds: [first.id, second.id],
    });
    expect(begun.status, JSON.stringify(begun.body)).toBe(201);
    expect((await upload(h, begun.target, audio)).body).toMatchObject({ stored: true });
    const directory = path.join(h.stateRoot, "device-uploads", "media");
    expect(await readdir(directory)).toEqual([sha256(audio)]);
    const partial = await h.perception.planDeletion(perceptionScope, {
      ...empty,
      kind: "records",
      ids: [first.id],
    });
    expect(partial.plan.media).toBe(0);
    await h.perception.deleteRecords(perceptionScope, partial.id);
    expect(await readdir(directory)).toEqual([sha256(audio)]);
    const rest = await h.perception.planDeletion(perceptionScope, {
      ...empty,
      kind: "records",
      ids: [second.id],
    });
    expect(rest.plan.media).toBe(1);
    const done = await h.perception.deleteRecords(perceptionScope, rest.id);
    expect(done.receipt?.media).toBe(1);
    expect(await readdir(directory)).toEqual([]);
    expect(
      await h.repository.perception().listMedia({ ...perceptionScope, status: "pending" }),
    ).toEqual([]);
  });

  it("finishes a deletion that stopped half way when the service starts again", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const records = [0, 1, 2, 3].map((index) => utterance(h, `话${index}`, { seconds: index }));
    await ingest(h, client, records);
    const plan = await h.perception.planDeletion(perceptionScope, {
      ...empty,
      kind: "records",
      ids: records.map(({ id }) => id),
    });
    const store = h.repository.perception();
    const started = await store.startDeletion({
      ...perceptionScope,
      id: plan.id,
      trackTypes: ["location.visit"],
      now: h.clock.now(),
    });
    expect(started).toMatchObject({ status: "running", pendingPayloads: 4 });
    expect((await remaining(h)).total).toBe(0);
    expect(await store.openDeletions(perceptionScope)).toEqual([plan.id]);
    const step = await store.cleanDeletion({
      ...perceptionScope,
      id: plan.id,
      now: h.clock.now(),
      chunk: 1,
    });
    expect(step.deletion).toMatchObject({ status: "running", pendingPayloads: 3 });
    expect(await h.perception.resumeDeletions(perceptionScope)).toBe(1);
    const read = await h.perception.readDeletion(perceptionScope, plan.id);
    expect(read).toMatchObject({ status: "verified", pendingPayloads: 0 });
    expect(read?.receipt).toEqual({ records: 4, trackPoints: 0, media: 0 });
    expect(await store.openDeletions(perceptionScope)).toEqual([]);
  });

  it("lets a device read what to remove from its own copy, one page after another", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const first = utterance(h, "一", { seconds: -30 });
    await ingest(h, client, [first, power(h, -20)]);
    const none = await deviceGet(h, client, "perception/deletions");
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ revision: 0, scopes: [] });
    const plan = await h.perception.planDeletion(perceptionScope, {
      ...empty,
      kind: "records",
      ids: [first.id],
    });
    await h.perception.deleteRecords(perceptionScope, plan.id);
    const types = await h.perception.planDeletion(perceptionScope, {
      ...empty,
      kind: "types",
      types: ["context.power"],
      deviceId: client.deviceId,
    });
    await h.perception.deleteRecords(perceptionScope, types.id);
    const all = await deviceGet(h, client, "perception/deletions?after=0");
    const body = all.body as {
      revision: number;
      scopes: { revision: number; kind: string; recordIds: string[]; types: string[] }[];
    };
    expect(body.revision).toBe(2);
    expect(body.scopes.map(({ kind }) => kind)).toEqual(["records", "types"]);
    expect(body.scopes[0]?.recordIds).toEqual([first.id]);
    expect(body.scopes[1]?.types).toEqual(["context.power"]);
    const next = await deviceGet(
      h,
      client,
      `perception/deletions?after=${body.scopes[0]?.revision}`,
    );
    expect((next.body as { scopes: unknown[] }).scopes).toHaveLength(1);
    const config = await deviceGet(h, client, "config");
    expect(
      (config.body as { perception: { deletionRevision: number } }).perception.deletionRevision,
    ).toBe(2);
    for (const bad of ["after=-1", "after=x", "after=1&after=2", "other=1"])
      expect((await deviceGet(h, client, `perception/deletions?${bad}`)).status, bad).toBe(400);
  });

  it("refuses a media upload that lists bad record ids", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const audio = Buffer.from("bytes");
    for (const recordIds of [["nope"], "perception:aaaaaaaaaaaaaaaa", [1]]) {
      const begun = await devicePost(h, client, "uploads/begin", {
        purpose: "media",
        sha256: sha256(audio),
        bytes: audio.length,
        batchId: "media-batch-0000000020",
        mediaKind: "image",
        recordIds,
      });
      expect(begun.status, JSON.stringify(recordIds)).toBe(400);
    }
    const onRecords = await devicePost(h, client, "uploads/begin", {
      purpose: "track",
      sha256: sha256(audio),
      bytes: audio.length,
      batchId: "track-batch-0000000030",
      recordIds: ["perception:aaaaaaaaaaaaaaaa"],
    });
    expect(onRecords.status).toBe(400);
  });
});
