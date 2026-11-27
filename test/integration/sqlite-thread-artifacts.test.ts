import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type GatewayAuthenticationContext,
  type PayloadProtectorPort,
  type PayloadStorePort,
  type RuntimeRequest,
  THREAD_ARTIFACT_KINDS,
  THREAD_ARTIFACT_LIST_LIMIT,
  THREAD_ARTIFACT_ORIGINS,
  type ThreadArtifactRegistration,
} from "@himawari-agent/application";
import { createAgentId, createOwnerId, type ProductThreadMessage } from "@himawari-agent/domain";
import {
  FILE_LIST_KINDS,
  FILE_LIST_ORIGINS,
  FILE_LIST_PAGE_LIMIT,
  gatewayV2MessageSchema,
} from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { BrowserThreadFiles } from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { classifiedThreadTitleReader } from "../../apps/agent-service/src/classified-thread-title.ts";
import { ProductionFilesControl } from "../../apps/agent-service/src/production-files-control.ts";
import { ProductionThreadArtifacts } from "../../apps/agent-service/src/production-thread-artifacts.ts";
import { ProductionUploadedFiles } from "../../apps/agent-service/src/production-uploaded-files.ts";
import { newProtector } from "./data-export-fixture.ts";
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

  async function open(titleRefs: Readonly<Record<string, string>> = {}) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-thread-artifacts-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    for (const thread of new Set(["thread-1", "thread-2", ...Object.keys(titleRefs)]))
      database
        .prepare(
          `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
           VALUES (?, ?, ?, 1, 'open', ?, ?)`,
        )
        .run(thread, OWNER_ID, AGENT_ID, T0, T0);
    database.pragma("foreign_keys = OFF");
    for (const [thread, ref] of Object.entries(titleRefs))
      database.prepare("UPDATE threads SET title_ref = ? WHERE id = ?").run(ref, thread);
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

  it("[FD-1] a command that deletes a registered file hides it through the real store, and keeps the old version", async () => {
    const { repository, store } = await open();
    try {
      const files: Record<string, string> = { "a.docx": "one", "b.docx": "two" };
      let counter = 0;
      const artifacts = new ProductionThreadArtifacts({
        store,
        files: {
          readFile: async ({ relativePath }) => {
            const content = files[relativePath];
            if (content === undefined) throw new Error("MISSING");
            return new TextEncoder().encode(content);
          },
          inspectEntry: async ({ relativePath }) =>
            files[relativePath] === undefined ? null : "file",
        },
        ids: { next: (kind) => `${kind}:${++counter}` },
        now: () => T0,
        warn: () => {},
      });
      const base = {
        ...scope,
        threadId: "thread-1",
        runId: "run-1",
        toolCallId: "call-1",
        source: "bash" as const,
        grant: {} as never,
        overlapped: false,
        saveCopy: async (key: string) => ({ ref: key }),
      };
      await artifacts.record({
        ...base,
        candidates: [{ path: "a.docx" }, { path: "b.docx" }],
      });
      delete files["a.docx"];
      await artifacts.recordDeleted({ ...base, toolCallId: "call-2", paths: ["a.docx"] });
      const list = (
        await store.list({
          ...scope,
          threadId: "thread-1",
          kind: null,
          search: null,
          before: null,
          limit: 50,
        })
      ).items;
      expect(list.map(({ path, deletedAt }) => [path, deletedAt !== null]).sort()).toEqual([
        ["a.docx", true],
        ["b.docx", false],
      ]);
      files["old.docx"] = "gone soon";
      files["c.docx"] = "stays";
      await artifacts.record({
        ...base,
        toolCallId: "call-4",
        candidates: [{ path: "old.docx" }, { path: "c.docx" }],
      });
      delete files["old.docx"];
      delete files["b.docx"];
      expect(
        await artifacts.reconcileDeleted({
          ownerId: scope.ownerId,
          agentId: scope.agentId,
          grant: {} as never,
        }),
      ).toBe(2);
      expect(
        await artifacts.reconcileDeleted({
          ownerId: scope.ownerId,
          agentId: scope.agentId,
          grant: {} as never,
        }),
      ).toBe(0);
      const failing = new ProductionThreadArtifacts({
        store,
        files: {
          readFile: async () => new Uint8Array(),
          inspectEntry: async () => {
            throw new Error("HOST_READ_ROOT_IDENTITY_CHANGED");
          },
        },
        ids: { next: (kind) => `${kind}:x` },
        now: () => T0,
        warn: () => {},
      });
      await expect(
        failing.reconcileDeleted({
          ownerId: scope.ownerId,
          agentId: scope.agentId,
          grant: {} as never,
        }),
      ).rejects.toThrow("HOST_READ_ROOT_IDENTITY_CHANGED");
      const remaining = await store.latest({ ...scope, threadId: "thread-1", path: "c.docx" });
      expect(remaining?.deletedAt).toBeNull();
      const kept = await store.versions({ ...scope, threadId: "thread-1", path: "a.docx" });
      expect(kept).toMatchObject([{ version: 1, copyRef: expect.any(String) }]);
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

  it("[iOS] 网关文件列表：主人全部对话的文件按时间从新到旧分页，和网页文件列表同一份数据", async () => {
    const { repository, store } = await open({
      "thread-1": "title-thread-1",
      "thread-2": "title-thread-2",
      "thread-private": "title-private",
      "thread-restricted": "title-restricted",
      "thread-blank": "title-blank",
      "thread-json": "title-json",
    });
    try {
      const protector = newProtector();
      const titles = repository.payloadStore(OWNER_ID, AGENT_ID);
      const title = async (
        ref: string,
        text: string,
        dataClassification: "public" | "private" | "sensitive" | "restricted",
        contentType = "text/plain",
      ) => {
        await titles.put(
          await protector.protect({
            ownerId: OWNER_ID,
            agentId: AGENT_ID,
            ref,
            dataClassification,
            contentType,
            plaintext: new TextEncoder().encode(text),
            createdAt: T0,
          } as never),
        );
      };
      await title("title-thread-1", "  周五\u0007去大阪  ", "public");
      await title("title-thread-2", "体检结果", "sensitive");
      await title("title-private", "体检结果", "private");
      await title("title-restricted", "体检结果", "restricted");
      await title("title-blank", "   ", "public");
      await title("title-json", "体检结果", "public", "application/json");
      await store.register({ ...scope, artifact: artifact("w1") });
      await store.register({
        ...scope,
        artifact: artifact("u1", {
          source: "upload",
          path: "uploads/bad\u0007name.png",
          kind: "image",
          mediaType: "image/png",
          copyRef: null,
          createdAt: "2026-10-28T05:01:00.000Z",
        }),
      });
      await store.register({
        ...scope,
        artifact: artifact("d1", {
          runId: "run-3",
          threadId: "thread-2",
          path: "notes/plan.md",
          kind: "document",
          mediaType: "text/markdown",
          createdAt: "2026-10-28T05:02:00.000Z",
        }),
      });
      await store.markDeleted({
        ...scope,
        threadId: "thread-2",
        paths: ["notes/plan.md"],
        deletedAt: "2026-10-28T05:03:00.000Z",
      });
      const threadTitle = classifiedThreadTitleReader({
        configuration: scope,
        threads: repository.threadRepository(),
        payloads: titles,
        protector,
      });
      const control = new ProductionFilesControl({
        configuration: scope,
        store,
        threadTitle,
        clock: { now: () => T0 },
      });
      const signedIn = {
        authentication: {
          ownerId: OWNER_ID,
          subjectId: OWNER_ID,
          deviceId: "device-phone",
          authenticatedAt: T0,
          authenticationRef: "authentication:phone",
        },
      } as never;
      const query = (payload: Record<string, unknown>, ownerId: string = OWNER_ID) =>
        gatewayV2MessageSchema.parse({
          schemaVersion: "gateway.v2",
          kind: "query",
          type: "files.list.read",
          messageId: "message-files",
          correlationId: "correlation-files",
          causationId: null,
          dataClassification: "private",
          risk: "low",
          authorizationRef: null,
          scope: { ownerId, agentId: AGENT_ID },
          authority: { deploymentId: "deployment-01", authorityEpoch: 1, fencingToken: 1 },
          actor: { actorType: "owner", actorId: ownerId },
          payload: { kind: null, origin: null, before: null, search: null, limit: 2, ...payload },
        });
      const read = async (payload: Record<string, unknown>) => {
        const snapshot = gatewayV2MessageSchema.parse(
          await control.query(query(payload) as never, signedIn),
        );
        if (snapshot.type !== "files.list.snapshot") throw new Error("snapshot");
        return snapshot.payload;
      };
      const first = await read({});
      expect(first.files).toEqual([
        {
          fileId: "d1",
          threadId: "thread-2",
          threadTitle: null,
          name: "plan.md",
          kind: "document",
          origin: "generated",
          mediaType: "text/markdown",
          sizeBytes: 10,
          version: 1,
          createdAt: "2026-10-28T05:02:00.000Z",
          deleted: true,
          contentPath: "/api/files/v1/content/d1",
        },
        {
          fileId: "u1",
          threadId: "thread-1",
          threadTitle: "周五\uFFFD去大阪",
          name: "bad\uFFFDname.png",
          kind: "image",
          origin: "uploaded",
          mediaType: "image/png",
          sizeBytes: 10,
          version: 1,
          createdAt: "2026-10-28T05:01:00.000Z",
          deleted: false,
          contentPath: null,
        },
      ]);
      expect(first.nextCursor).not.toBeNull();
      const rest = await read({ before: first.nextCursor });
      expect(rest.files.map(({ fileId }) => fileId)).toEqual(["w1"]);
      expect(rest.nextCursor).toBeNull();
      expect((await read({ kind: "image", limit: 10 })).files.map(({ fileId }) => fileId)).toEqual([
        "u1",
      ]);
      expect(
        (await read({ origin: "generated", limit: 10 })).files.map(({ fileId }) => fileId),
      ).toEqual(["d1", "w1"]);
      expect((await read({ search: "plan", limit: 10 })).files.map(({ fileId }) => fileId)).toEqual(
        ["d1"],
      );
      expect((await read({ search: "tokyo", limit: 10 })).files).toEqual([]);
      const web = new BrowserThreadFiles({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        store,
        payloads: () => ({}) as PayloadStorePort,
        protector: {} as PayloadProtectorPort,
        ticketKey: new Uint8Array(32).fill(7),
        now: () => T0,
      });
      const webPage = await web.list({
        authentication: { ownerId: OWNER_ID } as unknown as GatewayAuthenticationContext,
        agentId: AGENT_ID,
        threadId: null,
        kind: null,
        origin: null,
        search: null,
        before: null,
        limit: 10,
      });
      expect((await read({ limit: 10 })).files.map(({ fileId }) => fileId)).toEqual(
        webPage.items.map(({ id }) => id),
      );
      await expect(
        control.query(query({}, "someone-else") as never, signedIn),
      ).rejects.toMatchObject({ code: "PORT_NOT_AUTHORITATIVE" });
      await expect(control.query(query({}) as never)).rejects.toMatchObject({
        code: "PORT_NOT_AUTHORITATIVE",
      });
      const otherOwner = { authentication: { ownerId: "someone-else" } } as never;
      await expect(control.query(query({}) as never, otherOwner)).rejects.toMatchObject({
        code: "PORT_NOT_AUTHORITATIVE",
      });
      const otherAgent = {
        ...(query({}) as object),
        scope: { ownerId: OWNER_ID, agentId: "agent-other" },
      };
      await expect(control.query(otherAgent as never, signedIn)).rejects.toMatchObject({
        code: "PORT_NOT_AUTHORITATIVE",
      });
      expect(await threadTitle("thread-private")).toBe("体检结果");
      expect(await threadTitle("thread-restricted")).toBeNull();
      expect(await threadTitle("thread-blank")).toBeNull();
      expect(await threadTitle("thread-json")).toBeNull();
      expect(await threadTitle("thread-missing")).toBeNull();
      expect([...FILE_LIST_KINDS]).toEqual([...THREAD_ARTIFACT_KINDS]);
      expect([...FILE_LIST_ORIGINS]).toEqual([...THREAD_ARTIFACT_ORIGINS]);
      expect(FILE_LIST_PAGE_LIMIT).toBeLessThanOrEqual(THREAD_ARTIFACT_LIST_LIMIT);
      expect(() => query({ before: "not a cursor" })).toThrow();
      expect(() => query({ limit: 101 })).toThrow();
      expect(() => query({ kind: "video" })).toThrow();
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
