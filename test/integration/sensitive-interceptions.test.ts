import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SensitiveInterceptionObservation } from "@himawari-agent/application";
import { createAgentId, createOwnerId, createRunId, createThreadId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteGovernedDeletionAdapter,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-sensitive-log");
const AGENT_ID = createAgentId("agent-sensitive-log");
const OTHER_AGENT_ID = createAgentId("agent-sensitive-log-other");
const THREAD_ID = createThreadId("thread-sensitive-log");
const KEPT_THREAD_ID = createThreadId("thread-sensitive-log-kept");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const T0 = "2026-11-05T01:00:00.000Z";
const T1 = "2026-11-05T02:00:00.000Z";
const T2 = "2026-11-05T03:00:00.000Z";

function observation(
  overrides: Partial<SensitiveInterceptionObservation> = {},
): SensitiveInterceptionObservation {
  return {
    threadId: THREAD_ID,
    source: "chat",
    purpose: "chat",
    part: "owner_message",
    category: "password",
    ruleId: "password",
    fingerprint: "a".repeat(32),
    outcome: "masked",
    occurrences: 1,
    ...overrides,
  };
}

describe("[SI-1] sensitive interception records", () => {
  useSqliteContractExecution("direct");
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function open() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-sensitive-log-"));
    roots.push(stateRoot);
    await mkdir(path.join(stateRoot, "data"), { recursive: true });
    const databasePath = path.join(stateRoot, "data", "product.sqlite");
    const database = openQualifiedDatabase(databasePath);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    for (const agent of [AGENT_ID, OTHER_AGENT_ID])
      database
        .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
        .run(agent, OWNER_ID);
    for (const thread of [THREAD_ID, KEPT_THREAD_ID])
      database
        .prepare(
          `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
           VALUES (?, ?, ?, 0, 'open', ?, ?)`,
        )
        .run(thread, OWNER_ID, AGENT_ID, T0, T0);
    database
      .prepare(
        `INSERT INTO payloads (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
           content_digest, lifecycle_state, created_at, content_type)
         VALUES ('payload-si-trigger', ?, ?, 'private', 'sqlite_blob', X'00',
           'sha256:si-trigger', 'active', ?, 'application/octet-stream')`,
      )
      .run(OWNER_ID, AGENT_ID, T0);
    database
      .prepare(
        `INSERT INTO triggers (id, owner_id, agent_id, thread_id, idempotency_key, source_type,
           source_id, payload_ref, source_proof_ref, occurred_at)
         VALUES ('trigger-si', ?, ?, ?, 'trigger-si', 'user_message', 'fixture-si',
           'payload-si-trigger', 'proof-si', ?)`,
      )
      .run(OWNER_ID, AGENT_ID, THREAD_ID, T0);
    database
      .prepare(
        `INSERT INTO runs (id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
           status, created_at, updated_at)
         VALUES ('run-si', ?, ?, ?, 'session-si', 'trigger-si', 1, 'running', ?, ?)`,
      )
      .run(OWNER_ID, AGENT_ID, THREAD_ID, T0, T0);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      databasePath,
      minimumFreeBytes: 0,
      now: () => T0,
    });
    const count = (sql: string): number => {
      const reader = new Database(databasePath, { readonly: true });
      try {
        return reader.prepare(sql).pluck().get() as number;
      } finally {
        reader.close();
      }
    };
    return {
      stateRoot,
      databasePath,
      repository,
      store: repository.sensitiveInterceptions(),
      count,
    };
  }

  it("keeps one row for the same value sent again and adds up how often it was seen", async () => {
    const { repository, store } = await open();
    try {
      for (const now of [T0, T1, T2])
        expect(await store.record({ ...scope, observations: [observation()], now })).toEqual({
          recorded: 1,
          skipped: 0,
        });
      await store.record({
        ...scope,
        observations: [observation({ fingerprint: "b".repeat(32), occurrences: 2 })],
        now: T1,
      });
      const page = await store.list({ ...scope, limit: 10, before: null });
      expect(page.next).toBeNull();
      expect(page.items).toHaveLength(2);
      expect(
        page.items.map(({ firstSeenAt, lastSeenAt, seenCount }) => ({
          firstSeenAt,
          lastSeenAt,
          seenCount,
        })),
      ).toEqual([
        { firstSeenAt: T1, lastSeenAt: T1, seenCount: 2 },
        { firstSeenAt: T0, lastSeenAt: T2, seenCount: 3 },
      ]);
      expect(Object.keys(page.items[0] ?? {})).not.toContain("fingerprint");
    } finally {
      await repository.close();
    }
  });

  it("pages from the newest first sighting without skipping or repeating rows", async () => {
    const { repository, store } = await open();
    try {
      const observations = Array.from({ length: 5 }, (_, index) =>
        observation({ fingerprint: String(index).repeat(16) }),
      );
      await store.record({ ...scope, observations: observations.slice(0, 3), now: T0 });
      await store.record({ ...scope, observations: observations.slice(3), now: T1 });
      const seen: string[] = [];
      let before = null;
      do {
        const page = await store.list({ ...scope, limit: 2, before });
        seen.push(...page.items.map(({ id }) => id));
        before = page.next;
      } while (before);
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
      const firstPage = await store.list({ ...scope, limit: 2, before: null });
      expect(firstPage.items.every(({ firstSeenAt }) => firstSeenAt === T1)).toBe(true);
    } finally {
      await repository.close();
    }
  });

  it("keeps each agent's records apart and clears only the asked agent", async () => {
    const { repository, store } = await open();
    try {
      await store.record({
        ...scope,
        observations: [observation(), observation({ threadId: null, source: "mail" })],
        now: T0,
      });
      await store.record({
        ownerId: OWNER_ID,
        agentId: OTHER_AGENT_ID,
        observations: [observation({ threadId: null, source: "background" })],
        now: T0,
      });
      expect(await store.summarize(scope)).toEqual({ masked: 2, withheld: 0, not_saved: 0 });
      expect(await store.clear(scope)).toEqual({ cleared: 2 });
      expect(await store.summarize(scope)).toEqual({ masked: 0, withheld: 0, not_saved: 0 });
      expect((await store.list({ ...scope, limit: 10, before: null })).items).toEqual([]);
      expect(
        (await store.list({ ownerId: OWNER_ID, agentId: OTHER_AGENT_ID, limit: 10, before: null }))
          .items,
      ).toHaveLength(1);
    } finally {
      await repository.close();
    }
  });

  it("skips a record whose conversation no longer exists instead of failing the batch", async () => {
    const { repository, store } = await open();
    try {
      expect(
        await store.record({
          ...scope,
          observations: [
            observation({ threadId: createThreadId("thread-gone") }),
            observation({ fingerprint: "c".repeat(32) }),
          ],
          now: T0,
        }),
      ).toEqual({ recorded: 1, skipped: 1 });
    } finally {
      await repository.close();
    }
  });

  it("finds the conversation a run belongs to, and keeps the record after the run alone is deleted", async () => {
    const { repository, store, databasePath } = await open();
    try {
      const threadId = await store.threadOfRun({ ...scope, runId: createRunId("run-si") });
      expect(threadId).toBe(THREAD_ID);
      expect(await store.threadOfRun({ ...scope, runId: createRunId("run-unknown") })).toBeNull();
      expect(
        await store.threadOfRun({
          ownerId: OWNER_ID,
          agentId: OTHER_AGENT_ID,
          runId: createRunId("run-si"),
        }),
      ).toBeNull();
      const writer = new Database(databasePath);
      try {
        writer.prepare("DELETE FROM runs WHERE id = 'run-si'").run();
      } finally {
        writer.close();
      }
      const result = await store.record({
        ...scope,
        observations: [observation({ threadId, source: "background", purpose: "action-review" })],
        now: T0,
      });
      expect(result).toEqual({ recorded: 1, skipped: 0 });
      const { items } = await store.list({ ...scope, limit: 10, before: null });
      expect(items.map(({ threadId: filed }) => filed)).toEqual([THREAD_ID]);
    } finally {
      await repository.close();
    }
  });

  it("keeps one row when a value is caught by a different rule in the same place", async () => {
    const { repository, store } = await open();
    try {
      await store.record({ ...scope, observations: [observation()], now: T0 });
      await store.record({
        ...scope,
        observations: [observation({ ruleId: "named-earlier" })],
        now: T1,
      });
      const { items } = await store.list({ ...scope, limit: 10, before: null });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ ruleId: "password", seenCount: 2, lastSeenAt: T1 });
    } finally {
      await repository.close();
    }
  });

  it("refuses records that do not fit the fixed fields", async () => {
    const { repository, store } = await open();
    try {
      for (const bad of [
        observation({ category: "phone" as never }),
        observation({ part: "title" as never }),
        observation({ fingerprint: "482910" }),
        observation({ fingerprint: "密码hunter22abc".padEnd(32, "x") }),
        observation({ occurrences: 0 }),
        observation({ ruleId: "" }),
      ])
        await expect(store.record({ ...scope, observations: [bad], now: T0 })).rejects.toThrow();
      await expect(
        store.record({ ...scope, observations: [observation()], now: "2026-11-05" }),
      ).rejects.toThrow();
      await expect(store.list({ ...scope, limit: 101, before: null })).rejects.toThrow();
    } finally {
      await repository.close();
    }
  });

  it("removes a conversation's records when the conversation is deleted and keeps the rest", async () => {
    const resource = await open();
    try {
      await resource.store.record({
        ...scope,
        observations: [
          observation(),
          observation({ threadId: KEPT_THREAD_ID }),
          observation({ threadId: null, source: "mail", part: "mail", purpose: "mail-judgment" }),
          observation({
            threadId: THREAD_ID,
            source: "background",
            purpose: "thread-title",
            fingerprint: "f".repeat(32),
          }),
        ],
        now: T0,
      });
      await resource.repository.close();
      const deletion = new SqliteGovernedDeletionAdapter({
        stateRoot: resource.stateRoot,
        databasePath: resource.databasePath,
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        now: () => T1,
      });
      await deletion.deleteImmediately({ objectType: "thread", objectId: THREAD_ID });
      expect(resource.count("SELECT COUNT(*) FROM sensitive_interceptions")).toBe(2);
      expect(
        resource.count(
          `SELECT COUNT(*) FROM sensitive_interceptions WHERE thread_id = '${THREAD_ID}'`,
        ),
      ).toBe(0);
    } finally {
      await resource.repository.close().catch(() => undefined);
    }
  });
});
