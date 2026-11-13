import { PERCEPTION_CONFIGURATION_RANGES } from "@himawari-agent/application";
import {
  type GatewayV2Command,
  type GatewayV2Query,
  type GatewayV2Snapshot,
  gatewayV2MessageSchema,
} from "@himawari-agent/gateway-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionPerceptionControl } from "../../apps/agent-service/src/production-perception-control.ts";
import {
  agentId,
  type Harness,
  harness,
  ownerId,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
} from "../fixtures/device-api-harness.ts";
import {
  atOffset,
  ingest,
  perceptionScope,
  power,
  utterance,
} from "../fixtures/perception-test-client.ts";

afterEach(removeDeviceHarnessDirectories);

function message(kind: "command" | "query", type: string, payload: unknown, actorType = "owner") {
  return gatewayV2MessageSchema.parse({
    schemaVersion: "gateway.v2",
    kind,
    type,
    messageId: `message-${type}`,
    correlationId: `correlation-${type}`,
    causationId: null,
    dataClassification: "private",
    risk: "medium",
    authorizationRef: kind === "command" ? "authorization-01" : null,
    scope: { ownerId, agentId },
    authority: { deploymentId: "deployment-device-api", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType, actorId: "owner-subject" },
    ...(kind === "command" ? { idempotencyKey: `idempotency-${type}-${Math.random()}` } : {}),
    payload,
  });
}

function control(h: Harness) {
  return new ProductionPerceptionControl({
    configuration: { ownerId, agentId },
    perception: h.perception,
    perceptionConfiguration: () => h.perceptionConfiguration.current,
    readText: h.readText,
    clock: { now: () => h.clock.now() },
  });
}

async function read<TType extends GatewayV2Snapshot["type"]>(
  h: Harness,
  type: string,
  expected: TType,
  payload: unknown = {},
): Promise<Extract<GatewayV2Snapshot, { type: TType }>["payload"]> {
  const snapshot = await control(h).query(message("query", type, payload) as GatewayV2Query);
  gatewayV2MessageSchema.parse(snapshot);
  if (snapshot.type !== expected) throw new Error(`unexpected snapshot ${snapshot.type}`);
  return snapshot.payload as never;
}

function change(h: Harness, payload: Record<string, unknown>, actorType = "owner") {
  return control(h).execute(
    message(
      "command",
      "perception.settings.change",
      { sense: null, enabled: null, until: null, key: null, value: null, ...payload },
      actorType,
    ) as GatewayV2Command,
  );
}

describe("perception gateway operations", () => {
  it("reports status with the count the day list returns, and both drop when a row is removed", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const empty = await read(h, "perception.status.read", "perception.status.snapshot");
    expect([empty.state, empty.todayCount, empty.pausedUntil]).toEqual(["sensing", 0, null]);
    expect(empty.senses).toEqual(empty.availableSenses);
    const lone = power(h, -9);
    await ingest(h, client, [lone, utterance(h, "周六七点和小林吃饭", { seconds: -8 })]);
    const status = await read(h, "perception.status.read", "perception.status.snapshot");
    const day = await read(h, "perception.day.read", "perception.day.snapshot", {
      day: null,
      sense: null,
      types: null,
      cursor: null,
    });
    expect(status.todayCount).toBe(2);
    expect(day.total).toBe(status.todayCount);
    expect(day.rows).toHaveLength(status.todayCount);
    expect(day.day).toBe(status.day);
    await h.repository.perception().setRecordStatus({
      ...perceptionScope,
      recordId: lone.id,
      status: "deleted",
    });
    const after = await read(h, "perception.status.read", "perception.status.snapshot");
    const dayAfter = await read(h, "perception.day.read", "perception.day.snapshot", {
      day: null,
      sense: null,
      types: null,
      cursor: null,
    });
    expect(after.todayCount).toBe(1);
    expect(dayAfter.rows).toHaveLength(1);
    const counted = Object.fromEntries(day.senseCounts.map(({ sense, count }) => [sense, count]));
    expect(day.senseCounts.map(({ sense }) => sense)).toEqual(empty.availableSenses);
    for (const sense of empty.availableSenses) {
      const filtered = await read(h, "perception.day.read", "perception.day.snapshot", {
        day: null,
        sense,
        types: null,
        cursor: null,
      });
      expect([sense, filtered.total]).toEqual([
        sense,
        dayAfter.senseCounts.find((row) => row.sense === sense)?.count,
      ]);
    }
    expect(counted["hearing"]).toBe(1);
    expect(Object.values(counted).reduce((sum, count) => sum + count, 0)).toBe(2);
    expect(dayAfter.senseCounts.reduce((sum, { count }) => sum + count, 0)).toBe(1);
  });

  it("returns clipped text in the day list, full text in the episode and nothing for an unknown episode", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const long = "很".repeat(h.perceptionConfiguration.current.previewCharacters + 50);
    const spoken = utterance(h, long, { seconds: -5 });
    await ingest(h, client, [spoken]);
    const flat = await read(h, "perception.day.read", "perception.day.snapshot", {
      day: null,
      sense: "hearing",
      types: null,
      cursor: null,
    });
    const preview = flat.rows[0]?.record;
    expect(preview?.textTruncated).toBe(true);
    expect([...(preview?.text ?? "")]).toHaveLength(
      h.perceptionConfiguration.current.previewCharacters,
    );
    expect(preview?.evidence).toEqual([{ name: "durationMs", value: "2000" }]);
    const grouped = await read(h, "perception.day.read", "perception.day.snapshot", {
      day: null,
      sense: null,
      types: null,
      cursor: null,
    });
    const episodeId = grouped.rows[0]?.episode?.id ?? "";
    const limit = h.perceptionConfiguration.current.previewCharacters;
    expect(grouped.rows[0]?.episode).toMatchObject({
      recordCount: 1,
      senses: ["hearing"],
      types: ["speech.utterance"],
      deviceIds: [client.deviceId],
      preview: [...long].slice(0, limit).join(""),
      previewTruncated: true,
      summary: null,
      summarySource: "none",
    });
    const episode = await read(h, "perception.episode.read", "perception.episode.snapshot", {
      episodeId,
      cursor: null,
    });
    expect(episode.records.map(({ id, text, textTruncated }) => [id, text, textTruncated])).toEqual(
      [[spoken.id, long, false]],
    );
    const missing = await read(h, "perception.episode.read", "perception.episode.snapshot", {
      episodeId: "episode:00000000000000000000000000000000",
      cursor: null,
    });
    expect([missing.episode, missing.records]).toEqual([null, []]);
    await ingest(h, client, [utterance(h, "第二句", { seconds: -4 })]);
    await h.repository.perception().setRecordStatus({
      ...perceptionScope,
      recordId: spoken.id,
      status: "deleted",
    });
    const afterDelete = await read(h, "perception.episode.read", "perception.episode.snapshot", {
      episodeId,
      cursor: null,
    });
    expect(afterDelete.episode).toMatchObject({
      recordCount: 1,
      preview: "第二句",
      previewTruncated: false,
    });
    expect(afterDelete.records.map(({ text }) => text)).toEqual(["第二句"]);
  });

  it("changes a limit, a sense, a pause and a retention through one command and shows them in the snapshots", async () => {
    const h = await harness();
    let revision = (await read(h, "perception.status.read", "perception.status.snapshot")).revision;
    const next = async (payload: Record<string, unknown>) => {
      await change(h, { expectedRevision: revision, ...payload });
      revision += 1;
    };
    await next({ kind: "limit", key: "perception.images.daily", value: 120 });
    const usage = await read(h, "perception.usage.read", "perception.usage.snapshot");
    const images = usage.limits.find(({ key }) => key === "perception.images.daily");
    expect([images?.limit, images?.defaultLimit, images?.used, images?.state]).toEqual([
      120,
      500,
      0,
      "ok",
    ]);
    expect(usage.revision).toBe(revision);
    await next({ kind: "sense", sense: "vision", enabled: false });
    await next({ kind: "retention", key: "track", value: 14 });
    const until = atOffset(h, 1800);
    await next({ kind: "pause", until });
    const status = await read(h, "perception.status.read", "perception.status.snapshot");
    expect([status.state, status.pausedUntil]).toEqual(["paused", until]);
    expect(status.senses).not.toContain("vision");
    expect(status.retention.find(({ key }) => key === "track")).toMatchObject({
      days: 14,
      defaultDays: h.perceptionConfiguration.current.trackRetentionDays,
      minDays: PERCEPTION_CONFIGURATION_RANGES.trackRetentionDays[0],
      maxDays: PERCEPTION_CONFIGURATION_RANGES.trackRetentionDays[1],
    });
    await next({ kind: "resume" });
    expect((await read(h, "perception.status.read", "perception.status.snapshot")).state).toBe(
      "sensing",
    );
  });

  it("refuses a change from a non-owner, with a stale revision or with values that do not fit", async () => {
    const h = await harness();
    await expect(
      change(h, { expectedRevision: 0, kind: "resume" }, "system"),
    ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
    await change(h, { expectedRevision: 0, kind: "resume" });
    await expect(change(h, { expectedRevision: 0, kind: "resume" })).rejects.toMatchObject({
      code: "PORT_CONFLICT",
    });
    for (const payload of [
      { kind: "sense", sense: "smell", enabled: false },
      { kind: "sense", sense: "vision" },
      { kind: "pause" },
      { kind: "pause", until: atOffset(h, -60) },
      { kind: "retention", key: "speech", value: 3 },
      {
        kind: "retention",
        key: "track",
        value: PERCEPTION_CONFIGURATION_RANGES.trackRetentionDays[1] + 1,
      },
      { kind: "limit", key: "device.battery.listening", value: 10 },
      { kind: "limit", key: "perception.images.daily", value: 100_001 },
      { kind: "limit" },
    ])
      await expect(
        change(h, { expectedRevision: 1, ...payload }),
        JSON.stringify(payload),
      ).rejects.toMatchObject({ code: "PORT_INVALID_OPERATION" });
    expect((await read(h, "perception.status.read", "perception.status.snapshot")).revision).toBe(
      1,
    );
  });
});
