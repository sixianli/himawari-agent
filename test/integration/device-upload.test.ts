import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  harness,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
  web,
} from "../fixtures/device-api-harness.ts";
import {
  atOffset,
  beginUpload,
  ndjson,
  perceptionScope,
  power,
  recordId,
  sha256,
  upload,
} from "../fixtures/perception-test-client.ts";

afterEach(removeDeviceHarnessDirectories);

function sortedIds(count: number): string[] {
  return Array.from({ length: count }, () => recordId()).sort();
}

async function perceptionFile(h: Awaited<ReturnType<typeof harness>>, count = 3) {
  const ids = sortedIds(count);
  const records = ids.map((id, index) => power(h, -count + index, id));
  const bytes = ndjson(records);
  return { ids, records, bytes };
}

describe("device background uploads", () => {
  it("accepts a file days after the grant was issued and processes a repeat only once", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const file = await perceptionFile(h);
    const begun = await beginUpload(h, client, {
      purpose: "perception",
      sha256: sha256(file.bytes),
      bytes: file.bytes.length,
      recordIdFirst: file.ids[0],
      recordIdLast: file.ids.at(-1),
    });
    expect(begun.status, JSON.stringify(begun.body)).toBe(201);
    h.clock.advance(5 * 86_400_000);
    const first = await upload(h, begun.target, file.bytes);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body["counts"]).toEqual({ stored: 3 });
    const again = await upload(h, begun.target, file.bytes);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
    const known = await h.repository.perception().knownRecordIds({
      ...perceptionScope,
      ids: file.ids,
    });
    expect(known).toHaveLength(3);
    expect(await readdir(path.join(h.stateRoot, "device-uploads", "incoming"))).toEqual([]);
  });

  it("accepts a gzip file and refuses one that expands past the hard limit", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const file = await perceptionFile(h, 4);
    const packed = gzipSync(file.bytes);
    const begun = await beginUpload(h, client, {
      purpose: "perception",
      sha256: sha256(packed),
      bytes: packed.length,
      recordIdFirst: file.ids[0],
      recordIdLast: file.ids.at(-1),
    });
    const stored = await upload(h, begun.target, packed, { "content-encoding": "gzip" });
    expect(stored.status, JSON.stringify(stored.body)).toBe(200);
    expect(stored.body["counts"]).toEqual({ stored: 4 });

    h.configuration.current = {
      ...h.configuration.current,
      limits: { ...h.configuration.current.limits, "device.upload.expanded_bytes": 1024 },
    };
    const bomb = gzipSync(Buffer.alloc(200_000, 0x20));
    const second = await beginUpload(h, client, {
      purpose: "perception",
      sha256: sha256(bomb),
      bytes: bomb.length,
      recordIdFirst: file.ids[0],
      recordIdLast: file.ids.at(-1),
    });
    const refused = await upload(h, second.target, bomb, { "content-encoding": "gzip" });
    expect(refused.status).toBe(413);
    expect(refused.code).toBe("DEVICE_UPLOAD_EXPANDED_TOO_LARGE");
    expect(await readdir(path.join(h.stateRoot, "device-uploads", "incoming"))).toEqual([]);
  });

  it("refuses a wrong digest, an expired grant, a revoked device, another path and an oversized body", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const file = await perceptionFile(h);
    const body = {
      purpose: "perception",
      sha256: sha256(file.bytes),
      bytes: file.bytes.length,
      recordIdFirst: file.ids[0],
      recordIdLast: file.ids.at(-1),
    };

    const tampered = Buffer.from(file.bytes);
    tampered[tampered.length - 2] = tampered[tampered.length - 2] === 0x31 ? 0x32 : 0x31;
    const digest = await beginUpload(h, client, body);
    const mismatch = await upload(h, digest.target, tampered);
    expect(mismatch.status).toBe(422);
    expect(mismatch.code).toBe("DEVICE_UPLOAD_DIGEST_MISMATCH");

    const larger = await upload(h, digest.target, Buffer.concat([file.bytes, Buffer.from("\n")]));
    expect(larger.status).toBe(413);
    expect(larger.code).toBe("DEVICE_UPLOAD_TOO_LARGE");

    const wrongPath = await upload(
      h,
      { ...digest.target, path: "/api/device/v1/track" },
      file.bytes,
    );
    expect(wrongPath.status).toBe(403);
    expect(wrongPath.code).toBe("DEVICE_UPLOAD_GRANT_PATH");

    const otherRoute = await h.app.inject({
      method: "GET",
      url: "/api/device/v1/usage",
      headers: { host: new URL(h.origin).host, [digest.target.header]: digest.target.grant },
    });
    expect(otherRoute.statusCode).toBe(403);

    const unknown = await upload(h, { ...digest.target, grant: "A".repeat(43) }, file.bytes);
    expect(unknown.status).toBe(401);
    expect(unknown.code).toBe("DEVICE_UPLOAD_GRANT_INVALID");

    const expiring = await beginUpload(h, client, body);
    h.clock.advance((h.perceptionConfiguration.current.uploadGrantTtlSeconds + 1) * 1000);
    const expired = await upload(h, expiring.target, file.bytes);
    expect(expired.status).toBe(401);
    expect(expired.code).toBe("DEVICE_UPLOAD_GRANT_EXPIRED");

    const revoking = await beginUpload(h, client, body);
    expect(revoking.status).toBe(201);
    const revoked = await web(h, "revoke", {
      deviceId: client.deviceId,
      expectedRevision: client.revision,
    });
    expect(revoked.status).toBe(200);
    const afterRevoke = await upload(h, revoking.target, file.bytes);
    expect(afterRevoke.status).toBe(401);
    expect(afterRevoke.code).toBe("DEVICE_UPLOAD_GRANT_INVALID");

    const known = await h.repository.perception().knownRecordIds({
      ...perceptionScope,
      ids: file.ids,
    });
    expect(known).toEqual([]);
  });

  it("takes a file larger than a signed request may be and refuses a single line that large", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const requestLimit = h.configuration.current.limits["device.request.body_bytes"];
    const audio = Buffer.alloc(requestLimit * 17, 7);
    const media = await beginUpload(h, client, {
      purpose: "media",
      sha256: sha256(audio),
      bytes: audio.length,
      batchId: "media-batch-000000big1",
      mediaKind: "audio",
      durationMs: 1000,
    });
    expect(media.status, JSON.stringify(media.body)).toBe(201);
    expect((await upload(h, media.target, audio)).body).toMatchObject({ stored: true });

    const id = recordId();
    const line = Buffer.from(
      `${JSON.stringify({ ...power(h, -1, id), padding: "x".repeat(requestLimit) })}\n`,
    );
    const begun = await beginUpload(h, client, {
      purpose: "perception",
      sha256: sha256(line),
      bytes: line.length,
      recordIdFirst: id,
      recordIdLast: id,
    });
    expect(begun.status, JSON.stringify(begun.body)).toBe(201);
    const refused = await upload(h, begun.target, line);
    expect([refused.status, refused.code, refused.body["error"]]).toEqual([
      413,
      "DEVICE_UPLOAD_EXPANDED_TOO_LARGE",
      expect.objectContaining({ key: "device.request.body_bytes", limit: requestLimit }),
    ]);
    expect(await readdir(path.join(h.stateRoot, "device-uploads", "incoming"))).toEqual([]);
  });

  it("deletes raw media past its retention and files no record points at", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const bytes = Buffer.from("kept-image");
    const begun = await beginUpload(h, client, {
      purpose: "media",
      sha256: sha256(bytes),
      bytes: bytes.length,
      batchId: "media-batch-0000000ret1",
      mediaKind: "image",
    });
    expect(begun.status, JSON.stringify(begun.body)).toBe(201);
    expect((await upload(h, begun.target, bytes)).body).toMatchObject({ stored: true });
    const directory = path.join(h.stateRoot, "device-uploads", "media");
    const stray = sha256(Buffer.from("no-row-for-this"));
    await writeFile(path.join(directory, stray), "left behind");
    expect((await readdir(directory)).sort()).toEqual([sha256(bytes), stray].sort());
    expect((await h.perception.prune(perceptionScope)).media).toBe(0);
    expect(await readdir(directory)).toEqual([sha256(bytes)]);
    h.clock.advance((h.perceptionConfiguration.current.mediaRetentionDays + 1) * 86_400_000);
    expect((await h.perception.prune(perceptionScope)).media).toBe(1);
    expect(await readdir(directory)).toEqual([]);
  });

  it("keeps the file when the same bytes arrive twice at once", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const bytes = Buffer.from("the-same-picture");
    const begin = async (batchId: string) => {
      const begun = await beginUpload(h, client, {
        purpose: "media",
        sha256: sha256(bytes),
        bytes: bytes.length,
        batchId,
        mediaKind: "image",
      });
      expect(begun.status, JSON.stringify(begun.body)).toBe(201);
      return begun.target;
    };
    const targets = [await begin("media-batch-00000same1"), await begin("media-batch-00000same2")];
    const results = await Promise.all(targets.map((target) => upload(h, target, bytes)));
    expect(
      results
        .map(({ body }) => [body["stored"], body["duplicate"]])
        .sort((a, b) => Number(b[0]) - Number(a[0])),
    ).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(await readdir(path.join(h.stateRoot, "device-uploads", "media"))).toEqual([
      sha256(bytes),
    ]);
    await h.perception.prune(perceptionScope);
    expect(await readdir(path.join(h.stateRoot, "device-uploads", "media"))).toEqual([
      sha256(bytes),
    ]);
  });

  it("keeps a stored file when the same bytes are refused by a limit or swept at the same moment", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const settings = await h.perception.settings(perceptionScope);
    await h.perception.changeSettings(perceptionScope, settings.revision, {
      kind: "limit",
      key: "perception.images.daily",
      value: 0,
    });
    const directory = path.join(h.stateRoot, "device-uploads", "media");
    for (let round = 0; round < 8; round += 1) {
      const bytes = Buffer.from(`one-recording-two-kinds-${round}`);
      const begin = async (batchId: string, kind: object) => {
        const begun = await beginUpload(h, client, {
          purpose: "media",
          sha256: sha256(bytes),
          bytes: bytes.length,
          batchId,
          ...kind,
        });
        expect(begun.status, JSON.stringify(begun.body)).toBe(201);
        return begun.target;
      };
      const image = await begin(`media-batch-0000mixi${round}`, { mediaKind: "image" });
      const audio = await begin(`media-batch-0000mixa${round}`, {
        mediaKind: "audio",
        durationMs: 1000,
      });
      const [refused, kept] = await Promise.all([
        upload(h, image, bytes),
        upload(h, audio, bytes),
        h.perception.prune(perceptionScope),
      ]);
      expect(kept.body, JSON.stringify(kept.body)).toMatchObject({ stored: true });
      expect(refused.body["stored"]).toBe(false);
      expect(await readdir(directory)).toContain(sha256(bytes));
    }
    await h.perception.prune(perceptionScope);
    expect((await readdir(directory)).length).toBe(8);
  });

  it("refuses records outside the id range the grant was issued for", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const file = await perceptionFile(h, 3);
    const begun = await beginUpload(h, client, {
      purpose: "perception",
      sha256: sha256(file.bytes),
      bytes: file.bytes.length,
      recordIdFirst: file.ids[0],
      recordIdLast: file.ids[1],
    });
    const refused = await upload(h, begun.target, file.bytes);
    expect(refused.status).toBe(400);
    expect(refused.error?.["reason"]).toBe("id_range");
  });

  it("takes a track batch id only once and stores a media file under its digest", async () => {
    const h = await harness();
    const client = await pairAndConfirm(h);
    const points = ndjson([
      { occurredAt: atOffset(h, -20), latitude: 35.1, longitude: 139.1 },
      { occurredAt: atOffset(h, -10), latitude: 35.2, longitude: 139.2, accuracyMeters: 12.5 },
    ]);
    const batchId = "track-batch-0000000001";
    const track = await beginUpload(h, client, {
      purpose: "track",
      sha256: sha256(points),
      bytes: points.length,
      batchId,
    });
    expect(track.status, JSON.stringify(track.body)).toBe(201);
    const stored = await upload(h, track.target, points);
    expect(stored.body).toMatchObject({ purpose: "track", stored: 2, duplicates: 0 });
    const reused = await beginUpload(h, client, {
      purpose: "track",
      sha256: sha256(points),
      bytes: points.length,
      batchId,
    });
    expect(reused.status).toBe(409);
    expect(reused.code).toBe("DEVICE_UPLOAD_BATCH_USED");

    const audio = Buffer.from("not-really-audio-but-bytes");
    const media = await beginUpload(h, client, {
      purpose: "media",
      sha256: sha256(audio),
      bytes: audio.length,
      batchId: "media-batch-0000000001",
      mediaKind: "audio",
      durationMs: 30_000,
    });
    expect(media.status, JSON.stringify(media.body)).toBe(201);
    const received = await upload(h, media.target, audio);
    expect(received.body).toMatchObject({ purpose: "media", stored: true, duplicate: false });
    expect(await readdir(path.join(h.stateRoot, "device-uploads", "media"))).toEqual([
      sha256(audio),
    ]);
    const pending = await h.repository.perception().listMedia({
      ...perceptionScope,
      status: "pending",
    });
    expect(pending.map(({ sha256: digest, kind }) => [digest, kind])).toEqual([
      [sha256(audio), "audio"],
    ]);
    const withoutGrant = await h.app.inject({
      method: "POST",
      url: "/api/device/v1/perception/media",
      headers: { host: new URL(h.origin).host, "content-type": "application/octet-stream" },
      payload: audio,
    });
    expect(withoutGrant.statusCode).toBe(401);
  });
});
