import path from "node:path";
import { BrowserThreadFiles } from "@himawari-agent/platform-node";
import { openQualifiedDatabase } from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  DataExportJobs,
  deviceExportArchive,
} from "../../apps/agent-service/src/production-data-export.ts";
import {
  agentId,
  type Harness,
  harness,
  ownerId,
  type PairedClient,
  pairAndConfirm,
  removeDeviceHarnessDirectories,
  send,
  signedRequest,
  web,
} from "../fixtures/device-api-harness.ts";

afterEach(removeDeviceHarnessDirectories);

const NOW = "2026-11-12T00:00:00.000Z";
const ARCHIVE = Buffer.from("PK-fake-zip-bytes");

async function readyJobs() {
  const jobs = new DataExportJobs({
    ownerId,
    agentId,
    databasePath: "unused",
    protector: {} as never,
    now: () => NOW,
    build: async () => ({
      archive: ARCHIVE,
      fileName: "himawari-export-2026-11-12.zip",
      sha256: "0".repeat(64),
      memories: 3,
      rules: 1,
      withheld: 0,
    }),
  });
  const started = jobs.start("device-download-export-key");
  for (let attempt = 0; attempt < 50 && jobs.view(started.exportId).state !== "ready"; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(jobs.view(started.exportId).state).toBe("ready");
  return { jobs, exportId: started.exportId };
}

async function withDownloads() {
  const { jobs, exportId } = await readyJobs();
  const h = await harness({
    exportArchive: deviceExportArchive({ ownerId, jobs }),
    files: ({ repository, protector }) =>
      new BrowserThreadFiles({
        ownerId,
        agentId,
        store: repository.threadArtifacts(),
        payloads: () => repository.payloadStore(ownerId, agentId),
        protector,
        ticketKey: new Uint8Array(32).fill(7),
        now: () => NOW,
      }),
  });
  const client = await pairAndConfirm(h);
  return { h, client, exportId };
}

function get(h: Harness, client: PairedClient, path: string) {
  return send(h, signedRequest(h, client, { method: "GET", path }));
}

async function seedFile(h: Harness, client: PairedClient, content: string, slashId?: string) {
  const text = await send(
    h,
    signedRequest(h, client, {
      method: "POST",
      path: "/api/device/v1/payloads/text/new",
      body: JSON.stringify({
        idempotencyKey: "device-download-file-key-padding",
        content,
        dataClassification: "private",
      }),
    }),
  );
  expect(text.statusCode, text.body).toBe(201);
  const copyRef = (text.json() as { payloadRef: string }).payloadRef;
  const database = openQualifiedDatabase(path.join(h.stateRoot, "product.sqlite"));
  database
    .prepare(
      `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
       VALUES ('thread-download', ?, ?, 1, 'open', ?, ?)`,
    )
    .run(ownerId, agentId, NOW, NOW);
  database.pragma("foreign_keys = OFF");
  database
    .prepare(
      `INSERT INTO runs (
         id, owner_id, agent_id, thread_id, session_id, trigger_id, revision, status,
         created_at, updated_at
       ) VALUES ('run-download', ?, ?, 'thread-download', 'session-download', 'trigger-download', 1, 'completed', ?, ?)`,
    )
    .run(ownerId, agentId, NOW, NOW);
  database.close();
  const registered = await h.repository.threadArtifacts().register({
    ownerId,
    agentId,
    artifact: {
      id: "thread-artifact:5b0c4a3e-1f6d-4c1e-9a52-0d3c8e7b9a10",
      threadId: "thread-download",
      runId: "run-download",
      toolCallId: "call-download",
      source: "bash",
      path: "notes/大阪.txt",
      kind: "document",
      mediaType: "text/plain",
      sizeBytes: content.length,
      sha256: "a".repeat(64),
      copyRef,
      overlapped: false,
      createdAt: NOW,
    },
  });
  if (slashId) {
    await h.repository.threadArtifacts().register({
      ownerId,
      agentId,
      artifact: {
        ...registered.artifact,
        id: slashId,
        toolCallId: "call-download-slash",
        path: "notes/slash.txt",
      },
    });
  }
  return registered.artifact.id;
}

describe("[iOS-11] device-signed downloads of an export archive and a stored file", () => {
  it("serves a ready export archive and a stored file to a signed, confirmed device", async () => {
    const { h, client, exportId } = await withDownloads();
    const archive = await get(
      h,
      client,
      `/api/device/v1/data-export/archive?exportId=${encodeURIComponent(exportId)}`,
    );
    expect(archive.statusCode, archive.body).toBe(200);
    expect(archive.headers["content-type"]).toContain("application/zip");
    expect(archive.headers["content-disposition"]).toContain("himawari-export-2026-11-12.zip");
    expect(archive.headers["cache-control"]).toBe("no-store");
    expect(archive.rawPayload).toEqual(ARCHIVE);

    const fileId = await seedFile(h, client, "会面定在 14:00", "a/b");
    const file = await get(h, client, `/api/device/v1/files/content/${fileId}`);
    expect(file.statusCode, file.body).toBe(200);
    expect(file.headers["content-disposition"]).toContain("attachment");
    expect(file.headers["content-disposition"]).toContain(encodeURIComponent("大阪.txt"));
    expect(file.body).toBe("会面定在 14:00");
    const encoded = await get(
      h,
      client,
      `/api/device/v1/files/content/${encodeURIComponent(fileId)}`,
    );
    expect(encoded.statusCode, encoded.body).toBe(200);
    expect(encoded.body).toBe("会面定在 14:00");
    const slash = await get(h, client, "/api/device/v1/files/content/a%2Fb");
    expect(slash.statusCode, slash.body).toBe(404);
    await h.repository.close();
  });

  it("rejects what must not download: unsigned, replayed, unknown, malformed, extra query, revoked device", async () => {
    const { h, client, exportId } = await withDownloads();
    const archivePath = `/api/device/v1/data-export/archive?exportId=${encodeURIComponent(exportId)}`;

    const unsigned = await h.app.inject({
      method: "GET",
      url: archivePath,
      headers: { host: new URL(h.origin).host },
    });
    expect(unsigned.statusCode).toBeGreaterThanOrEqual(400);
    expect(unsigned.rawPayload).not.toEqual(ARCHIVE);

    const request = signedRequest(h, client, { method: "GET", path: archivePath });
    expect((await send(h, request)).statusCode).toBe(200);
    const replayed = await send(h, request);
    expect(replayed.statusCode).toBeGreaterThanOrEqual(400);
    expect(replayed.rawPayload).not.toEqual(ARCHIVE);

    const unknown = await get(
      h,
      client,
      "/api/device/v1/data-export/archive?exportId=data-export:AAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(unknown.statusCode).toBe(404);
    expect(
      (await get(h, client, "/api/device/v1/data-export/archive?exportId=not-an-id")).statusCode,
    ).toBe(400);
    expect((await get(h, client, "/api/device/v1/data-export/archive")).statusCode).toBe(400);
    expect((await get(h, client, `${archivePath}&download=1`)).statusCode).toBe(400);
    expect((await get(h, client, `${archivePath}&exportId=${exportId}`)).statusCode).toBe(400);

    expect(
      (await get(h, client, "/api/device/v1/files/content/file-does-not-exist")).statusCode,
    ).toBe(404);
    expect(
      (await get(h, client, "/api/device/v1/files/content/file-1?download=1")).statusCode,
    ).toBe(400);

    const revoked = await web(h, "revoke", {
      deviceId: client.deviceId,
      expectedRevision: client.revision,
    });
    expect(revoked.status).toBe(200);
    const after = await get(h, client, archivePath);
    expect(after.statusCode).toBe(403);
    expect(after.rawPayload).not.toEqual(ARCHIVE);
    await h.repository.close();
  });

  it("does not hand the archive to a different owner and is not installed without the ports", async () => {
    const { jobs, exportId } = await readyJobs();
    const asOtherOwner = deviceExportArchive({ ownerId: "someone-else" as never, jobs });
    expect(asOtherOwner({ authentication: { ownerId }, exportId })).toBeUndefined();
    expect(
      deviceExportArchive({ ownerId, jobs })({ authentication: { ownerId }, exportId })?.bytes,
    ).toEqual(ARCHIVE);

    const bare = await harness();
    const client = await pairAndConfirm(bare);
    expect(
      (
        await get(
          bare,
          client,
          `/api/device/v1/data-export/archive?exportId=${encodeURIComponent(exportId)}`,
        )
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (await get(bare, client, "/api/device/v1/files/content/file-download-1")).statusCode,
    ).toBeGreaterThanOrEqual(400);
    await bare.repository.close();
  });
});
