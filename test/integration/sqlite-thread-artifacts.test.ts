import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  GatewayAuthenticationContext,
  PayloadProtectorPort,
  PayloadStorePort,
  RuntimeRequest,
  ThreadArtifactRegistration,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId, type ProductThreadMessage } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { BrowserThreadFiles } from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionUploadedFiles } from "../../apps/agent-service/src/production-uploaded-files.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-thread-artifacts");
const AGENT_ID = createAgentId("agent-thread-artifacts");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const T0 = "2026-10-28T05:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function artifact(
  id: string,
  overrides: Partial<ThreadArtifactRegistration> = {},
): ThreadArtifactRegistration {
  return {
    id,
    threadId: "thread-1",
    runId: "run-1",
    toolCallId: `call-${id}`,
    source: "bash",
    path: "game/index.html",
    kind: "web",
    mediaType: "text/html",
    sizeBytes: 10,
    sha256: SHA_A,
    copyRef: `copy-${id}`,
    overlapped: false,
    createdAt: T0,
    ...overrides,
  };
}

describe("[FD-1] thread artifact storage", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function open() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-thread-artifacts-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    for (const thread of ["thread-1", "thread-2"])
      database
        .prepare(
          `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
           VALUES (?, ?, ?, 1, 'open', ?, ?)`,
        )
        .run(thread, OWNER_ID, AGENT_ID, T0, T0);
    database.pragma("foreign_keys = OFF");
    for (const [run, thread] of [
      ["run-1", "thread-1"],
      ["run-2", "thread-1"],
      ["run-3", "thread-2"],
    ])
      database
        .prepare(
          `INSERT INTO runs (
             id, owner_id, agent_id, thread_id, session_id, trigger_id, revision, status,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 1, 'completed', ?, ?)`,
        )
        .run(run, OWNER_ID, AGENT_ID, thread, `session-${run}`, `trigger-${run}`, T0, T0);
    database.pragma("foreign_keys = ON");
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => T0,
    });
    return { stateRoot, repository, store: repository.threadArtifacts() };
  }

  it("[FD-1] adds a version only when the content changes and replays the same call", async () => {
    const { repository, store } = await open();
    try {
      const first = await store.register({ ...scope, artifact: artifact("a1") });
      expect(first).toMatchObject({ created: true, artifact: { version: 1 } });
      expect(
        await store.register({
          ...scope,
          artifact: artifact("a1-again", { toolCallId: "call-a1" }),
        }),
      ).toMatchObject({ created: false, artifact: { id: "a1", version: 1 } });
      expect(
        await store.register({
          ...scope,
          artifact: artifact("a2", { runId: "run-2", createdAt: "2026-10-28T05:01:00.000Z" }),
        }),
      ).toMatchObject({ created: false, artifact: { id: "a1" } });
      const changed = await store.register({
        ...scope,
        artifact: artifact("a3", {
          runId: "run-2",
          sha256: SHA_B,
          overlapped: true,
          createdAt: "2026-10-28T05:02:00.000Z",
        }),
      });
      expect(changed).toMatchObject({
        created: true,
        artifact: { id: "a3", version: 2, overlapped: true, turn: 2 },
      });
      expect(first.artifact.turn).toBe(1);
      expect(
        (await store.versions({ ...scope, threadId: "thread-1", path: "game/index.html" })).map(
          ({ id, version }) => [id, version],
        ),
      ).toEqual([
        ["a1", 1],
        ["a3", 2],
      ]);
      expect(
        await store.latest({ ...scope, threadId: "thread-1", path: "game/index.html" }),
      ).toMatchObject({ id: "a3", sha256: SHA_B });
      const oversized = await store.register({
        ...scope,
        artifact: artifact("a4", {
          runId: "run-2",
          sha256: null,
          copyRef: null,
          sizeBytes: 40 * 1024 * 1024,
          createdAt: "2026-10-28T05:03:00.000Z",
        }),
      });
      expect(oversized).toMatchObject({
        created: true,
        artifact: { version: 3, copyRef: null, sha256: null },
      });
    } finally {
      await repository.close();
    }
  });

  it("[FD-1] hides a file after it is deleted and registers it again when it comes back", async () => {
    const { repository, store } = await open();
    try {
      await store.register({ ...scope, artifact: artifact("d1", { path: "a.docx" }) });
      await store.register({ ...scope, artifact: artifact("d2", { path: "b.docx" }) });
      expect(
        await store.markDeleted({
          ...scope,
          threadId: "thread-1",
          paths: ["a.docx", "missing.docx"],
          deletedAt: "2026-10-28T05:05:00.000Z",
        }),
      ).toBe(1);
      const page = await store.list({
        ...scope,
        threadId: "thread-1",
        kind: null,
        search: null,
        before: null,
        limit: 50,
      });
      expect(page.items.map(({ path, deletedAt }) => [path, deletedAt !== null]).sort()).toEqual([
        ["a.docx", true],
        ["b.docx", false],
      ]);
      const back = await store.register({
        ...scope,
        artifact: artifact("d3", { path: "a.docx", runId: "run-2", toolCallId: "call-d3" }),
      });
      expect(back).toMatchObject({
        created: true,
        artifact: { version: 2, deletedAt: null },
      });
      expect(
        await store.markDeleted({
          ...scope,
          threadId: "thread-2",
          paths: ["a.docx"],
          deletedAt: "2026-10-28T05:06:00.000Z",
        }),
      ).toBe(0);
    } finally {
      await repository.close();
    }
  });

  it("[FD-1] lists newest first across conversations with kind, name and page filters", async () => {
    const { repository, store } = await open();
    try {
      await store.register({ ...scope, artifact: artifact("w1") });
      await store.register({
        ...scope,
        artifact: artifact("i1", {
          path: "out/chart.png",
          kind: "image",
          mediaType: "image/png",
          createdAt: "2026-10-28T05:01:00.000Z",
        }),
      });
      await store.register({
        ...scope,
        artifact: artifact("d1", {
          runId: "run-3",
          threadId: "thread-2",
          path: "notes/100%_plan.md",
          kind: "document",
          mediaType: "text/markdown",
          createdAt: "2026-10-28T05:02:00.000Z",
        }),
      });
      const all = await store.list({
        ...scope,
        threadId: null,
        kind: null,
        search: null,
        before: null,
        limit: 2,
      });
      expect(all.items.map(({ id }) => id)).toEqual(["d1", "i1"]);
      expect(all.nextCursor).not.toBeNull();
      const rest = await store.list({
        ...scope,
        threadId: null,
        kind: null,
        search: null,
        before: all.nextCursor,
        limit: 2,
      });
      expect(rest).toMatchObject({ items: [{ id: "w1" }], nextCursor: null });
      expect(
        (
          await store.list({
            ...scope,
            threadId: "thread-1",
            kind: null,
            search: null,
            before: null,
            limit: 10,
          })
        ).items.map(({ id }) => id),
      ).toEqual(["i1", "w1"]);
      expect(
        (
          await store.list({
            ...scope,
            threadId: null,
            kind: "image",
            search: null,
            before: null,
            limit: 10,
          })
        ).items.map(({ id }) => id),
      ).toEqual(["i1"]);
      expect(
        (
          await store.list({
            ...scope,
            threadId: null,
            kind: null,
            search: "100%",
            before: null,
            limit: 10,
          })
        ).items.map(({ id }) => id),
      ).toEqual(["d1"]);
      await expect(
        store.list({ ...scope, threadId: null, kind: null, search: null, before: "x", limit: 10 }),
      ).rejects.toThrow();
    } finally {
      await repository.close();
    }
  });

  it("[UI-32] records the files the owner attached to a message and serves an image as an image", async () => {
    const { repository, store } = await open();
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const payloads: Record<string, { ref: string; contentType: string; text: string }> = {
        "message-1": {
          ref: "message-1",
          contentType: "text/plain",
          text: [
            "看看这张图和报告",
            '<file name="IMG_0412.jpg" ref="image-1" bytes="7" kind="image"/>',
            '<file name="报告.pdf" ref="text-1" bytes="2048" kind="pdf" truncated="1"/>',
            '<file name="notes.md" ref="text-2" bytes="5" kind="text"/>',
          ].join("\n\n"),
        },
        "image-1": {
          ref: "image-1",
          contentType: "text/x-himawari-image",
          text: `data:image/png;base64,${png.toString("base64")}`,
        },
        "text-2": { ref: "text-2", contentType: "text/x-himawari-attachment", text: "# hi\n" },
      };
      const protector = {
        unprotect: async ({ payload }: { payload: { ref: string } }) =>
          new TextEncoder().encode(payloads[payload.ref]?.text ?? ""),
      } as unknown as PayloadProtectorPort;
      const payloadStore = {
        get: async (ref: string) => payloads[ref],
      } as unknown as PayloadStorePort;
      let next = 0;
      const uploads = new ProductionUploadedFiles({
        threads: {
          listMessages: async () => [
            {
              role: "owner",
              runId: "run-2",
              status: "committed",
              contentRef: "message-1",
              sequence: 3,
              committedAt: "2026-10-28T05:09:00.000Z",
            } as unknown as ProductThreadMessage,
          ],
        },
        payloads: payloadStore,
        protector,
        store,
        ids: { next: (scope: string) => `${scope}-${++next}` },
        now: () => T0,
      });
      const request = {
        ...scope,
        threadId: "thread-1",
        runId: "run-2",
      } as unknown as RuntimeRequest;
      await uploads.start(request);
      await uploads.start(request);
      const query = {
        ...scope,
        threadId: null,
        kind: null,
        search: null,
        before: null,
        limit: 10,
      } as const;
      const uploaded = (await store.list({ ...query, origin: "uploaded" })).items;
      expect(uploaded.map(({ path, kind, source, turn }) => [path, kind, source, turn])).toEqual([
        ["notes.md", "document", "upload", 2],
        ["报告.pdf.txt", "document", "upload", 2],
        ["IMG_0412.jpg", "image", "upload", 2],
      ]);
      expect((await store.list({ ...query, origin: "generated" })).items).toEqual([]);
      const files = new BrowserThreadFiles({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        store,
        payloads: () => payloadStore,
        protector,
        ticketKey: new Uint8Array(32).fill(7),
        now: () => T0,
      });
      const image = uploaded.find(({ kind }) => kind === "image");
      if (!image) throw new Error("missing uploaded image");
      const content = await files.content({
        authentication: null as unknown as GatewayAuthenticationContext,
        agentId: AGENT_ID,
        fileId: image.id,
        download: false,
      });
      expect(content).toMatchObject({ mediaType: "image/png", disposition: "inline" });
      expect(Buffer.from(content.bytes)).toEqual(png);
    } finally {
      await repository.close();
    }
  });
});
