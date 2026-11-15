import { ownerDayBounds } from "@himawari-agent/application";
import { createOwnerId } from "@himawari-agent/domain";
import { afterEach, describe, expect, it } from "vitest";
import {
  harness,
  ownerSpokenAt,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
} from "../fixtures/device-api-harness.ts";
import {
  devicePost,
  ingest,
  perceptionScope,
  power,
  utterance,
  visit,
} from "../fixtures/perception-test-client.ts";

afterEach(removeDeviceHarnessDirectories);

describe("perception records", () => {
  it("stores a batch once and reports repeats as duplicates", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const records = [utterance(h, "明天下午三点开会"), power(h, 1)];
    const first = await ingest(h, client, records);
    expect(first.outcomes.map(({ outcome }) => outcome)).toEqual(["stored", "stored"]);
    const second = await ingest(h, client, records);
    expect(second.outcomes.map(({ outcome }) => outcome)).toEqual(["duplicate", "duplicate"]);
    const page = await h.perception.listDay({
      scope: perceptionScope,
      day: null,
      sense: null,
      types: null,
      cursor: null,
    });
    expect(page.total).toBe(2);
    expect(page.rows).toHaveLength(2);
    const ids = records.map(({ id }) => id);
    const store = h.repository.perception();
    expect([...(await store.knownRecordIds({ ...perceptionScope, ids }))].sort()).toEqual(
      [...ids].sort(),
    );
    expect(
      await store.knownRecordIds({
        ...perceptionScope,
        ownerId: createOwnerId("owner-someone-else"),
        ids,
      }),
    ).toEqual([]);
  });

  it("keeps every record as origin other until owner voice recognition is qualified", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const claimed = utterance(h, "我说的话", { speaker: { kind: "owner", score: 1000 } });
    await ingest(h, client, [claimed]);
    h.voiceGates.current = ownerSpokenAt(800);
    const qualified = utterance(h, "资格通过后我说的话", {
      seconds: 1,
      speaker: { kind: "owner", score: 900 },
    });
    const unsure = utterance(h, "分数不够的话", {
      seconds: 1,
      speaker: { kind: "owner", score: 799 },
    });
    const unscored = utterance(h, "没带分数的话", { seconds: 1, speaker: { kind: "owner" } });
    const stranger = utterance(h, "别人说的话", { seconds: 2, speaker: { kind: "unknown" } });
    const environment = power(h, 3);
    await ingest(h, client, [qualified, unsure, unscored, stranger, environment]);
    const page = await h.perception.listDay({
      scope: perceptionScope,
      day: null,
      sense: null,
      types: ["speech.utterance", "context.power"],
      cursor: null,
    });
    const origins = new Map(
      page.rows.flatMap((row) =>
        row.kind === "record" ? [[row.record.id, row.record.origin]] : [],
      ),
    );
    expect(origins.get(claimed.id)).toBe("other");
    expect(origins.get(qualified.id)).toBe("owner_spoken");
    expect(origins.get(unsure.id)).toBe("other");
    expect(origins.get(unscored.id)).toBe("other");
    expect(origins.get(stranger.id)).toBe("other");
    expect(origins.get(environment.id)).toBe("other");
  });

  it("rejects a device supplied origin and every unknown field", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    for (const record of [
      { ...utterance(h, "x"), origin: "owner_spoken" },
      { ...utterance(h, "x"), extra: 1 },
      { ...power(h), evidence: { batteryPercent: 80, charging: false, more: 1 } },
      { ...power(h), text: "环境记录不带文字" },
      { ...utterance(h, "x"), type: "speech.unknown" },
      { ...utterance(h, "x"), id: "short" },
      { ...utterance(h, "x"), occurredAt: "2030-01-01T00:00:00.000Z" },
      { ...utterance(h, "x"), speaker: { kind: "contact" } },
    ]) {
      const result = await devicePost(h, client, "perception", { records: [record] });
      expect(result.status, JSON.stringify(record)).toBe(400);
      expect(result.code).toBe("DEVICE_REQUEST_INVALID");
    }
    const page = await h.perception.listDay({
      scope: perceptionScope,
      day: null,
      sense: null,
      types: null,
      cursor: null,
    });
    expect(page.total).toBe(0);
  });

  it("groups speech into one episode per conversation and splits on silence and on a visit", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const silence = h.perceptionConfiguration.current.episodeSilenceSeconds;
    const first = utterance(h, "第一句", { seconds: -3 * silence - 60 });
    const second = utterance(h, "第二句", { seconds: -3 * silence - 30 });
    const afterSilence = utterance(h, "隔了很久", { seconds: -silence - 40 });
    const boundary = visit(h, -30);
    const afterVisit = utterance(h, "到了新地方", { seconds: -20 });
    await ingest(h, client, [first, second, afterSilence, boundary, afterVisit]);
    const page = await h.perception.listDay({
      scope: perceptionScope,
      day: null,
      sense: null,
      types: null,
      cursor: null,
    });
    const episodes = page.rows.flatMap((row) => (row.kind === "episode" ? [row.episode] : []));
    expect(episodes.map(({ recordCount }) => recordCount).sort()).toEqual([1, 1, 2]);
    expect(page.rows.filter((row) => row.kind === "record")).toHaveLength(1);
    expect(page.total).toBe(4);
    const pair = episodes.find(({ recordCount }) => recordCount === 2);
    const detail = await h.perception.readEpisode({
      scope: perceptionScope,
      episodeId: pair?.id ?? "",
      cursor: null,
    });
    expect(detail?.records.map(({ id }) => id)).toEqual([first.id, second.id]);
  });

  it("ends an episode at the owner's midnight so each day lists its own records", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const midnight = Date.parse(ownerDayBounds(h.clock.now(), h.timeZone.current).start);
    const offset = (seconds: number) =>
      Math.round((midnight - Date.parse(h.clock.now())) / 1000) + seconds;
    const before = utterance(h, "睡前说的", { seconds: offset(-10) });
    const after = utterance(h, "过了零点说的", { seconds: offset(10) });
    const result = await ingest(h, client, [before, after]);
    expect(result.outcomes.map(({ outcome }) => outcome)).toEqual(["stored", "stored"]);
    const today = ownerDayBounds(h.clock.now(), h.timeZone.current).day;
    const yesterday = ownerDayBounds(
      new Date(midnight - 1000).toISOString(),
      h.timeZone.current,
    ).day;
    const texts = async (day: string) => {
      const page = await h.perception.listDay({
        scope: perceptionScope,
        day,
        sense: null,
        types: null,
        cursor: null,
      });
      const rows = await Promise.all(
        page.rows.map(async (row) =>
          row.kind === "episode"
            ? [row.episode.recordCount, await h.readText(row.overview.lead?.contentRef ?? "")]
            : ["record"],
        ),
      );
      return [page.total, rows];
    };
    expect(await texts(yesterday)).toEqual([1, [[1, "睡前说的"]]]);
    expect(await texts(today)).toEqual([1, [[1, "过了零点说的"]]]);
    expect((await h.perception.status(perceptionScope)).todayCount).toBe(1);
  });

  it("counts today with the same query the list uses and both drop together when a row is removed", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const lone = power(h, -5);
    const spoken = utterance(h, "一句话", { seconds: -4 });
    await ingest(h, client, [lone, spoken, visit(h, -3)]);
    const before = await h.perception.status(perceptionScope);
    const listBefore = await h.perception.listDay({
      scope: perceptionScope,
      day: null,
      sense: null,
      types: null,
      cursor: null,
    });
    expect(before.todayCount).toBe(3);
    expect(listBefore.rows).toHaveLength(before.todayCount);
    await h.repository.perception().setRecordStatus({
      ...perceptionScope,
      recordId: lone.id,
      status: "deleted",
    });
    const after = await h.perception.status(perceptionScope);
    const listAfter = await h.perception.listDay({
      scope: perceptionScope,
      day: null,
      sense: null,
      types: null,
      cursor: null,
    });
    expect(after.todayCount).toBe(2);
    expect(listAfter.rows).toHaveLength(2);
    await h.repository.perception().setRecordStatus({
      ...perceptionScope,
      recordId: spoken.id,
      status: "deleted",
    });
    expect((await h.perception.status(perceptionScope)).todayCount).toBe(1);
  });

  it("shows nothing for a day with no records and for a sense with no records", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    expect((await h.perception.status(perceptionScope)).todayCount).toBe(0);
    await ingest(h, client, [power(h)]);
    const other = await h.perception.listDay({
      scope: perceptionScope,
      day: "2020-01-01",
      sense: null,
      types: null,
      cursor: null,
    });
    expect(other.total).toBe(0);
    expect(other.rows).toEqual([]);
    const hearing = await h.perception.listDay({
      scope: perceptionScope,
      day: null,
      sense: "hearing",
      types: null,
      cursor: null,
    });
    expect(hearing.rows).toEqual([]);
  });

  it("drops records for a sense that is off and for the paused window, and reports the state", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    let settings = await h.perception.settings(perceptionScope);
    settings = await h.perception.changeSettings(perceptionScope, settings.revision, {
      kind: "sense",
      sense: "hearing",
      enabled: false,
    });
    const off = await ingest(h, client, [utterance(h, "不该存"), power(h, 1)]);
    expect(off.outcomes.map(({ outcome }) => outcome)).toEqual(["sense_off", "stored"]);
    const status = await h.perception.status(perceptionScope);
    expect(status.state).toBe("sensing");
    expect(status.senses).not.toContain("hearing");
    expect(status.senses[0]).toBe("location");
    const until = new Date(Date.parse(h.clock.now()) + 600_000).toISOString();
    settings = await h.perception.changeSettings(perceptionScope, settings.revision, {
      kind: "pause",
      until,
    });
    const paused = await h.perception.status(perceptionScope);
    expect(paused.state).toBe("paused");
    expect(paused.pausedUntil).toBe(until);
    const during = await ingest(h, client, [power(h, 2), power(h, -60)]);
    expect(during.outcomes.map(({ outcome }) => outcome)).toEqual(["paused", "stored"]);
    await h.perception.changeSettings(perceptionScope, settings.revision, { kind: "resume" });
    expect((await h.perception.status(perceptionScope)).state).toBe("sensing");
    const resumed = await ingest(h, client, [power(h, 3)]);
    expect(resumed.outcomes[0]?.outcome).toBe("stored");
  });

  it("rejects a settings change made against a stale revision", async () => {
    const h = await harness();
    const settings = await h.perception.settings(perceptionScope);
    await h.perception.changeSettings(perceptionScope, settings.revision, { kind: "resume" });
    await expect(
      h.perception.changeSettings(perceptionScope, settings.revision, { kind: "resume" }),
    ).rejects.toMatchObject({ code: "PORT_CONFLICT" });
  });

  it("removes surroundings records past their retention and keeps speech", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const old = power(h, 0);
    const speech = utterance(h, "留着", { seconds: 1 });
    await ingest(h, client, [old, speech]);
    const days = h.perceptionConfiguration.current.surroundingsRetentionDays;
    h.clock.advance((days + 1) * 86_400_000);
    const result = await h.perception.prune(perceptionScope);
    expect(result.records).toBe(1);
    const known = await h.repository.perception().knownRecordIds({
      ...perceptionScope,
      ids: [old.id, speech.id],
    });
    expect(known).toEqual([speech.id]);
  });

  it("refuses a batch larger than the configured hard limit", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    h.configuration.current = {
      ...h.configuration.current,
      limits: { ...h.configuration.current.limits, "device.perception.batch_records": 2 },
    };
    const result = await devicePost(h, client, "perception", {
      records: [power(h, 0), power(h, 1), power(h, 2)],
    });
    expect(result.status).toBe(413);
    expect(result.code).toBe("DEVICE_BATCH_TOO_LARGE");
  });
});
