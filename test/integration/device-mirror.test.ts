import { afterEach, describe, expect, it } from "vitest";
import {
  type Harness,
  harness,
  type PairedClient,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
} from "../fixtures/device-api-harness.ts";
import { atOffset, devicePost, perceptionScope } from "../fixtures/perception-test-client.ts";

afterEach(removeDeviceHarnessDirectories);

function reminder(externalId: string, version: number, title: string) {
  return { externalId, version, data: { title, completed: false } };
}

async function titles(h: Harness) {
  const items = await h.repository.perception().listMirror({
    ...perceptionScope,
    kind: "reminder",
    includeDeleted: false,
  });
  return items.map(({ externalId, data }) => [externalId, data?.["title"]]);
}

async function sync(h: Harness, client: PairedClient, body: Record<string, unknown>) {
  return devicePost(h, client, "mirror", { kind: "reminder", ...body });
}

describe("device mirror and track", () => {
  it("replaces the set on a full sync only after the final batch", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const first = await sync(h, client, {
      mode: "full",
      syncId: "sync-0000000000000001",
      final: true,
      items: [reminder("a", 1, "买牛奶"), reminder("b", 1, "交房租"), reminder("c", 1, "取快递")],
    });
    expect(first.body).toEqual({ applied: 3, stale: 0, removed: 0, active: 3 });
    const partial = await sync(h, client, {
      mode: "full",
      syncId: "sync-0000000000000002",
      final: false,
      items: [reminder("a", 1, "买牛奶")],
    });
    expect(partial.body).toEqual({ applied: 0, stale: 1, removed: 0, active: 3 });
    expect(await titles(h)).toHaveLength(3);
    const last = await sync(h, client, {
      mode: "full",
      syncId: "sync-0000000000000002",
      final: true,
      items: [reminder("b", 2, "交房租和水费")],
    });
    expect(last.body).toEqual({ applied: 1, stale: 0, removed: 1, active: 2 });
    expect(await titles(h)).toEqual([
      ["a", "买牛奶"],
      ["b", "交房租和水费"],
    ]);
  });

  it("applies newer versions, ignores older ones and removes deleted items on a delta sync", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    await sync(h, client, {
      mode: "delta",
      syncId: "sync-0000000000000001",
      final: true,
      items: [reminder("a", 5, "新标题"), reminder("b", 1, "留着")],
    });
    const stale = await sync(h, client, {
      mode: "delta",
      syncId: "sync-0000000000000002",
      final: true,
      items: [reminder("a", 4, "旧标题"), { externalId: "b", version: 2, deleted: true }],
    });
    expect(stale.body).toEqual({ applied: 1, stale: 1, removed: 0, active: 1 });
    expect(await titles(h)).toEqual([["a", "新标题"]]);
  });

  it("refuses unknown kinds, unknown fields, duplicates and oversized batches", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const base = { mode: "delta", syncId: "sync-0000000000000001", final: true };
    for (const body of [
      { ...base, kind: "note", items: [] },
      {
        ...base,
        items: [{ externalId: "a", version: 1, data: { title: "x", completed: false, extra: 1 } }],
      },
      { ...base, items: [{ externalId: "a", version: 1, data: { title: "x" } }] },
      { ...base, items: [reminder("a", 1, "x"), reminder("a", 2, "y")] },
      {
        ...base,
        items: [
          { externalId: "a", version: 1, deleted: true, data: { title: "x", completed: true } },
        ],
      },
      { ...base, more: true, items: [] },
    ]) {
      const refused = await sync(h, client, body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
    h.configuration.current = {
      ...h.configuration.current,
      limits: { ...h.configuration.current.limits, "device.mirror.batch_items": 1 },
    };
    const tooMany = await sync(h, client, {
      ...base,
      items: [reminder("a", 1, "x"), reminder("b", 1, "y")],
    });
    expect(tooMany.status).toBe(413);
    expect(tooMany.code).toBe("DEVICE_BATCH_TOO_LARGE");
    expect(await titles(h)).toEqual([]);
  });

  it("stores track points once, stops at the daily limit and drops points past retention", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const points = [
      { occurredAt: atOffset(h, -30), latitude: 35.1, longitude: 139.1 },
      { occurredAt: atOffset(h, -20), latitude: 35.2, longitude: 139.2, speedMetersPerSecond: 1.4 },
    ];
    const first = await devicePost(h, client, "track", { points });
    expect(first.body).toEqual({ stored: 2, duplicates: 0, limitReached: 0 });
    const again = await devicePost(h, client, "track", { points });
    expect(again.body).toEqual({ stored: 0, duplicates: 2, limitReached: 0 });
    const settings = await h.perception.settings(perceptionScope);
    await h.perception.changeSettings(perceptionScope, settings.revision, {
      kind: "limit",
      key: "perception.track.daily",
      value: 3,
    });
    const limited = await devicePost(h, client, "track", {
      points: [
        { occurredAt: atOffset(h, -10), latitude: 35.3, longitude: 139.3 },
        { occurredAt: atOffset(h, -5), latitude: 35.4, longitude: 139.4 },
      ],
    });
    expect(limited.body).toEqual({ stored: 1, duplicates: 0, limitReached: 1 });
    const day = (await h.perception.status(perceptionScope)).day;
    expect(await h.repository.perception().countTrackPoints({ ...perceptionScope, day })).toBe(3);
    for (const bad of [
      { occurredAt: atOffset(h, -1), latitude: 91, longitude: 0 },
      { occurredAt: atOffset(h, -1), latitude: 0, longitude: 0, heading: 3 },
      { occurredAt: "yesterday", latitude: 0, longitude: 0 },
    ]) {
      const refused = await devicePost(h, client, "track", { points: [bad] });
      expect(refused.status, JSON.stringify(bad)).toBe(400);
    }
    h.clock.advance((h.perceptionConfiguration.current.trackRetentionDays + 1) * 86_400_000);
    const pruned = await h.perception.prune(perceptionScope);
    expect(pruned.trackPoints).toBe(3);
    expect(await h.repository.perception().countTrackPoints({ ...perceptionScope, day })).toBe(0);
  });
});
