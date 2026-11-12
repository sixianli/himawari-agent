import {
  buildPortableExport,
  DataExportError,
  importPortableExport,
  MANIFEST_FILE,
  type PortableFiles,
  parsePortable,
  sha256Hex,
} from "@himawari-agent/persistence-sqlite";
import { createDataExportTextPolicy } from "@himawari-agent/platform-node";
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { openSide, putPayload, type Side } from "./data-export-fixture.ts";

const PASSPHRASE = "测试口令-correct horse battery staple";
const NOW = "2026-11-10T00:00:00.000Z";
const AT = Date.parse("2026-11-09T03:00:00.000Z");
const decoder = new TextDecoder();
const encoder = new TextEncoder();
const directories: string[] = [];
const deviceId = `dev_${"P".repeat(22)}`;
const recordId = `perception:${"a".repeat(32)}`;
const episodeId = `episode:${"b".repeat(32)}`;
const grantHash = "c".repeat(64);
const mediaDigest = "d".repeat(64);
const SPOKEN = "周六七点和小林吃饭";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function side(suffix: string): Promise<Side> {
  const opened = await openSide(suffix);
  directories.push(opened.directory);
  return opened;
}

async function seeded(): Promise<Side> {
  const source = await side("perception-source");
  const scope = [source.ownerId, source.agentId] as const;
  const run = (sql: string, ...values: unknown[]) => source.database.prepare(sql).run(...values);
  run(
    `INSERT INTO paired_devices
       (id, owner_id, agent_id, revision, kind, name, release_channel, device_public_key,
        confirm_public_key, status, supported_actions, paired_at, last_seen_at)
     VALUES (?, ?, ?, 0, 'iphone', 'Andy iPhone', 'direct', ?, ?, 'pending', '[]', ?, ?)`,
    deviceId,
    ...scope,
    `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${"D".repeat(86)}==`,
    `MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE${"C".repeat(86)}==`,
    NOW,
    NOW,
  );
  const contentRef = await putPayload(source, "payload:perception-export-1", SPOKEN);
  run(
    `INSERT INTO perception_episodes
       (id, owner_id, agent_id, started_at_ms, ended_at_ms, local_day, record_count, status)
     VALUES (?, ?, ?, ?, ?, '2026-11-09', 1, 'active')`,
    episodeId,
    ...scope,
    AT,
    AT,
  );
  const record = (id: string, status: string, ref: string | null) =>
    run(
      `INSERT INTO perception_records
         (id, owner_id, agent_id, device_id, type, origin, capture_source, occurred_at_ms,
          received_at_ms, occurred_at_device, local_day, confidence, speaker_kind, speaker_ref,
          episode_id, content_ref, data_classification, evidence, status)
       VALUES (?, ?, ?, ?, 'speech.utterance', 'other', 'device_microphone', ?, ?, ?,
               '2026-11-09', 870, 'unknown', NULL, ?, ?, 'private', ?, ?)`,
      id,
      ...scope,
      deviceId,
      AT,
      AT + 500,
      "2026-11-09T12:00:00+09:00",
      episodeId,
      ref,
      JSON.stringify({ durationMs: 2100 }),
      status,
    );
  record(recordId, "active", contentRef);
  record(`perception:${"e".repeat(32)}`, "deleted", null);
  run(
    `INSERT INTO device_mirror_items
       (owner_id, agent_id, device_id, kind, external_id, version, deleted, data, sync_id,
        updated_at_ms)
     VALUES (?, ?, ?, 'reminder', 'reminder-1', 3, 0, ?, 'sync-0000000000000001', ?),
            (?, ?, ?, 'reminder', 'reminder-2', 4, 1, NULL, 'sync-0000000000000001', ?)`,
    ...scope,
    deviceId,
    JSON.stringify({ title: "交房租", completed: false }),
    AT,
    ...scope,
    deviceId,
    AT,
  );
  run(
    `INSERT INTO location_track_points
       (owner_id, agent_id, device_id, occurred_at_ms, latitude_e7, longitude_e7, accuracy_dm,
        speed_cms, local_day)
     VALUES (?, ?, ?, ?, 356800000, 1397600000, 125, NULL, '2026-11-09')`,
    ...scope,
    deviceId,
    AT,
  );
  run(
    `INSERT INTO perception_settings
       (owner_id, agent_id, revision, disabled_senses, paused_from, paused_until, retention_days,
        limit_overrides, updated_at)
     VALUES (?, ?, 2, '["vision"]', NULL, NULL, '{"track":30}',
             '{"perception.images.daily":200}', ?)`,
    ...scope,
    NOW,
  );
  run(
    `INSERT INTO limit_usage (owner_id, agent_id, key, period_start, device_id, used)
     VALUES (?, ?, 'perception.records.daily', '2026-11-08T15:00:00.000Z', '', 2),
            (?, ?, 'device.queue.bytes', '2026-11-08T15:00:00.000Z', ?, 4096)`,
    ...scope,
    ...scope,
    deviceId,
  );
  run(
    `INSERT INTO device_upload_grants
       (token_hash, owner_id, agent_id, device_id, purpose, sha256, bytes, record_id_first,
        record_id_last, batch_id, media_kind, media_ms, created_at, expires_at, used_at, result)
     VALUES (?, ?, ?, ?, 'media', ?, 10, NULL, NULL, 'media-batch-0000000001', 'audio', 1000,
             ?, '2026-11-17T00:00:00.000Z', NULL, NULL)`,
    grantHash,
    ...scope,
    deviceId,
    mediaDigest,
    NOW,
  );
  run(
    `INSERT INTO perception_media_items
       (id, owner_id, agent_id, device_id, kind, bytes, sha256, milliseconds, received_at, status)
     VALUES (?, ?, ?, ?, 'audio', 10, ?, 1000, ?, 'pending')`,
    `media:${mediaDigest}`,
    ...scope,
    deviceId,
    mediaDigest,
    NOW,
  );
  return source;
}

function exportOf(from: Side) {
  return buildPortableExport({
    database: from.database,
    scope: { ownerId: from.ownerId, agentId: from.agentId },
    migrationSequence: from.migrationSequence,
    protector: from.protector,
    policy: createDataExportTextPolicy(),
    now: () => NOW,
    sealPassphrase: PASSPHRASE,
    withEvidence: false,
  });
}

function lines(files: PortableFiles, path: string): Record<string, unknown>[] {
  const text = decoder.decode(files.get(path));
  return text === ""
    ? []
    : text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("data export: perception", () => {
  it("[P1-6] exports perception records with their text, episodes, mirror items, track points, settings and usage", async () => {
    const source = await seeded();
    const { files, manifest } = await exportOf(source);
    expect(lines(files, "data/perception-records.jsonl")).toEqual([
      {
        id: recordId,
        type: "speech.utterance",
        origin: "other",
        captureSource: "device_microphone",
        occurredAt: "2026-11-09T03:00:00.000Z",
        deviceTime: "2026-11-09T12:00:00+09:00",
        localDay: "2026-11-09",
        deviceId,
        confidence: 870,
        speakerKind: "unknown",
        speakerRef: null,
        episodeId,
        classification: "private",
        evidence: { durationMs: 2100 },
        content: { classification: "private", contentType: "text/plain", text: SPOKEN },
      },
    ]);
    expect(lines(files, "data/perception-episodes.jsonl")).toHaveLength(1);
    expect(lines(files, "data/device-mirror-items.jsonl")).toEqual([
      {
        deviceId,
        kind: "reminder",
        externalId: "reminder-1",
        version: 3,
        updatedAt: "2026-11-09T03:00:00.000Z",
        data: { title: "交房租", completed: false },
      },
    ]);
    expect(lines(files, "data/track-points.jsonl")).toEqual([
      {
        deviceId,
        occurredAt: "2026-11-09T03:00:00.000Z",
        latitude: 35.68,
        longitude: 139.76,
        accuracyMeters: 12.5,
        speedMetersPerSecond: null,
      },
    ]);
    expect(lines(files, "data/perception-settings.jsonl")).toEqual([
      {
        disabledSenses: ["vision"],
        pausedFrom: null,
        pausedUntil: null,
        retentionDays: { track: 30 },
        limitOverrides: { "perception.images.daily": 200 },
        updatedAt: NOW,
      },
    ]);
    expect(lines(files, "data/limit-usage.jsonl")).toEqual([
      {
        key: "device.queue.bytes",
        periodStart: "2026-11-08T15:00:00.000Z",
        deviceId,
        used: 4096,
      },
      {
        key: "perception.records.daily",
        periodStart: "2026-11-08T15:00:00.000Z",
        deviceId: null,
        used: 2,
      },
    ]);
    expect(manifest.counts).toMatchObject({
      perceptionRecords: 1,
      perceptionEpisodes: 1,
      deviceMirrorItems: 1,
      trackPoints: 1,
      perceptionSettings: 1,
      limitUsage: 2,
    });
    expect(
      parsePortable(files, source.migrationSequence).perception.perceptionRecords,
    ).toHaveLength(1);
  });

  it("[P1-6][reverse] upload grants, raw media and deleted records appear in no exported file, and an empty store exports empty files", async () => {
    const source = await seeded();
    const { files, manifest } = await exportOf(source);
    for (const [path, bytes] of files) {
      const text = decoder.decode(bytes);
      for (const hidden of [grantHash, mediaDigest, "media-batch-0000000001", "e".repeat(32)])
        expect(text, path).not.toContain(hidden);
    }
    expect(manifest.omitted.map(({ what }) => what)).toContain(
      "上传凭据，和还没处理的原始音频、图片、屏幕画面",
    );
    const empty = await exportOf(await side("perception-empty"));
    for (const path of [
      "data/perception-records.jsonl",
      "data/perception-episodes.jsonl",
      "data/device-mirror-items.jsonl",
      "data/track-points.jsonl",
      "data/perception-settings.jsonl",
      "data/limit-usage.jsonl",
    ])
      expect(decoder.decode(empty.files.get(path)), path).toBe("");
    expect(empty.manifest.counts.perceptionRecords).toBe(0);
  });

  it("[P1-6][reverse] extraction progress and spoken-command utterance ids appear in no exported file", async () => {
    const source = await seeded();
    source.database
      .prepare(
        `INSERT INTO perception_extractions
           (episode_id, owner_id, agent_id, status, attempts, record_count, next_attempt_at,
            error_code, cost_micros, updated_at)
         VALUES (?, ?, ?, 'failed', 3, 1, NULL, 'EXTRACTION_HIDDEN_MARK', 4242, ?)`,
      )
      .run(episodeId, source.ownerId, source.agentId, NOW);
    source.database
      .prepare(
        `INSERT INTO perception_command_utterances (owner_id, agent_id, utterance_id, recorded_at)
         VALUES (?, ?, 'utterance-hidden-mark-0001', ?)`,
      )
      .run(source.ownerId, source.agentId, NOW);
    const { files } = await exportOf(source);
    expect(files.size).toBeGreaterThan(0);
    for (const [path, bytes] of files) {
      const text = decoder.decode(bytes);
      for (const hidden of ["EXTRACTION_HIDDEN_MARK", "utterance-hidden-mark-0001"])
        expect(text, path).not.toContain(hidden);
    }
  });

  it("[P1-6][reverse] a perception line with an unknown field is refused and import restores no perception data", async () => {
    const source = await seeded();
    const { files } = await exportOf(source);
    const target = await side("perception-not-restored");
    const result = await importPortableExport(files, {
      database: target.database,
      scope: { ownerId: target.ownerId, agentId: target.agentId },
      migrationSequence: target.migrationSequence,
      protector: target.protector,
      now: () => NOW,
      passphrase: PASSPHRASE,
    });
    expect(result.imported.perceptionRecords).toBe(0);
    expect(
      target.database.prepare("SELECT COUNT(*) AS count FROM perception_records").get(),
    ).toEqual({ count: 0 });
    const path = "data/perception-records.jsonl";
    const manifest = JSON.parse(decoder.decode(files.get(MANIFEST_FILE))) as {
      files: { path: string; bytes: number; sha256: string }[];
    };
    const tampered: PortableFiles = new Map(files);
    const changed = encoder.encode(
      decoder.decode(files.get(path)).replace('"type"', '"tokenHash":"x","type"'),
    );
    tampered.set(path, changed);
    for (const entry of manifest.files)
      if (entry.path === path) {
        entry.bytes = changed.byteLength;
        entry.sha256 = sha256Hex(changed);
      }
    tampered.set(MANIFEST_FILE, encoder.encode(JSON.stringify(manifest)));
    expect(() => parsePortable(files, source.migrationSequence)).not.toThrow();
    expect(() => parsePortable(tampered, source.migrationSequence)).toThrow(DataExportError);
  });
});
