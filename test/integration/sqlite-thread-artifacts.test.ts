import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ThreadArtifactRegistration } from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
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
});
