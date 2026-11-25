import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WebPushOutboxItem } from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  createVerifiedMigrationSnapshot,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-web-push");
const AGENT_ID = createAgentId("agent-web-push");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const T0 = "2026-10-26T12:00:00.000Z";
const T1 = "2026-10-26T12:01:00.000Z";
const T2 = "2026-10-26T12:06:00.000Z";

const item = (sourceKey: string, expiresAt = "2026-10-26T18:00:00.000Z"): WebPushOutboxItem => ({
  ...scope,
  sourceKey,
  kind: "reminder",
  sourceRef: sourceKey,
  threadId: null,
  createdAt: T0,
  expiresAt,
});

describe("[WP-2] web push storage", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function open() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-web-push-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => T0,
    });
    return { stateRoot, repository, store: repository.webPush() };
  }

  const subscription = (id: string, endpoint: string, locale: "zh-CN" | "en" | "ja" = "zh-CN") => ({
    ...scope,
    id,
    endpoint,
    p256dh: `key-${id}`,
    auth: `auth-${id}`,
    locale,
    deviceLabel: `device ${id}`,
    now: T0,
  });

  it("[WP-2] keeps one subscription per endpoint and reactivates a paused device on resubscribe", async () => {
    const { repository, store } = await open();
    try {
      await store.saveSubscription(subscription("s1", "https://push.example/a"));
      await store.markSubscription({
        ...scope,
        subscriptionId: "s1",
        state: "paused",
        failureCode: "WEB_PUSH_HTTP_403",
        deliveredAt: null,
        now: T1,
      });
      const again = await store.saveSubscription({
        ...subscription("s9", "https://push.example/a", "ja"),
        now: T2,
      });
      expect(again).toMatchObject({
        id: "s1",
        locale: "ja",
        state: "active",
        failureCode: null,
        p256dh: "key-s9",
        createdAt: T0,
        updatedAt: T2,
      });
      expect(await store.listSubscriptions(scope)).toHaveLength(1);
      await expect(
        store.saveSubscription(subscription("s2", "http://push.example/b")),
      ).rejects.toThrow();
      expect(await store.removeSubscription({ ...scope, subscriptionId: "s1" })).toBe(true);
      expect(await store.listSubscriptions(scope)).toEqual([]);
    } finally {
      await repository.close();
    }
  });

  it("[WP-2] keeps one set of kinds per account: all on by default, shared by every device, saved once", async () => {
    const { repository, store } = await open();
    try {
      expect(await store.readKinds(scope)).toEqual(["reminder", "approval", "run"]);
      await store.saveSubscription(subscription("s1", "https://push.example/a"));
      await store.saveSubscription(subscription("s2", "https://push.example/b"));
      expect(
        await store.writeKinds({ ...scope, kinds: ["reminder", "approval"], now: T1 }),
      ).toEqual(["reminder", "approval"]);
      await store.saveSubscription(subscription("s3", "https://push.example/c"));
      await store.saveSubscription(subscription("s1", "https://push.example/a"));
      expect(await store.readKinds(scope)).toEqual(["reminder", "approval"]);
      await expect(
        store.writeKinds({ ...scope, kinds: ["nope" as "run"], now: T1 }),
      ).rejects.toThrow();
      expect(await store.setKind({ ...scope, kind: "run", enabled: true, now: T2 })).toEqual([
        "reminder",
        "approval",
        "run",
      ]);
      expect(await store.setKind({ ...scope, kind: "approval", enabled: false, now: T2 })).toEqual([
        "reminder",
        "run",
      ]);
      expect(await store.writeKinds({ ...scope, kinds: [], now: T2 })).toEqual([]);
    } finally {
      await repository.close();
    }
  });

  it("[WP-2] the migration that made kinds account-wide keeps a kind off when any device had it off", async () => {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-web-push-migrate-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    const migrations = await loadBundledMigrations();
    applyMigrations(database, migrations.slice(0, 70));
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    const insert = database.prepare(
      `INSERT INTO web_push_subscriptions (id, owner_id, agent_id, endpoint, p256dh, auth, locale,
         device_label, notify_reminder, notify_approval, notify_run, state, failure_code,
         created_at, updated_at, last_delivered_at)
       VALUES (?, ?, ?, ?, 'k', 'a', 'zh-CN', 'd', ?, 1, ?, 'active', NULL, ?, ?, NULL)`,
    );
    insert.run("mac", OWNER_ID, AGENT_ID, "https://push.example/mac", 1, 0, T0, T0);
    insert.run("phone", OWNER_ID, AGENT_ID, "https://push.example/phone", 0, 1, T0, T1);
    const snapshot = await createVerifiedMigrationSnapshot(
      database,
      path.join(stateRoot, "pre-migration.sqlite"),
    );
    applyMigrations(database, migrations, { snapshot });
    expect(
      database
        .prepare(
          "SELECT notify_reminder AS reminder, notify_approval AS approval, notify_run AS run FROM web_push_account_kinds",
        )
        .all(),
    ).toEqual([{ reminder: 0, approval: 1, run: 0 }]);
    database.close();
  });

  it("[WP-2] enqueues each source once, advances the cursor with it and lists due pairs per device", async () => {
    const { repository, store } = await open();
    try {
      await store.saveSubscription(subscription("s1", "https://push.example/a"));
      await store.saveSubscription(subscription("s2", "https://push.example/b"));
      expect(await store.readCursor({ ...scope, source: "finished-runs" })).toBeNull();
      expect(
        await store.enqueue({
          ...scope,
          items: [item("reminder:r1:x"), item("reminder:r2:x")],
          cursor: { source: "finished-runs", value: "c-10" },
          now: T0,
        }),
      ).toBe(2);
      expect(
        await store.enqueue({
          ...scope,
          items: [item("reminder:r1:x")],
          cursor: { source: "finished-runs", value: "c-11" },
          now: T1,
        }),
      ).toBe(0);
      expect(await store.readCursor({ ...scope, source: "finished-runs" })).toBe("c-11");
      const due = await store.listDue({ ...scope, now: T1, limit: 50 });
      expect(due.map(({ item, subscription }) => `${item.sourceKey}@${subscription.id}`)).toEqual([
        "reminder:r1:x@s1",
        "reminder:r1:x@s2",
        "reminder:r2:x@s1",
        "reminder:r2:x@s2",
      ]);
      expect(due[0]?.attempt).toBeNull();
    } finally {
      await repository.close();
    }
  });

  it("[WP-2] never reopens a finished attempt, waits for a retry time and survives a restart", async () => {
    const { stateRoot, repository, store } = await open();
    await store.saveSubscription(subscription("s1", "https://push.example/a"));
    await store.enqueue({
      ...scope,
      items: [item("approval:a1"), item("run:r1:completed")],
      cursor: null,
      now: T0,
    });
    const base = { ...scope, subscriptionId: "s1", lastCode: null, tag: "tag-base", now: T1 };
    expect(
      await store.recordAttempt({
        ...base,
        sourceKey: "approval:a1",
        status: "sent",
        attempts: 1,
        nextAttemptAt: null,
      }),
    ).toBe(true);
    expect(
      await store.recordAttempt({
        ...base,
        sourceKey: "approval:a1",
        status: "pending",
        attempts: 2,
        nextAttemptAt: T1,
      }),
    ).toBe(false);
    await store.recordAttempt({
      ...base,
      sourceKey: "run:r1:completed",
      status: "pending",
      attempts: 1,
      nextAttemptAt: T2,
      lastCode: "WEB_PUSH_HTTP_503",
    });
    expect(await store.listDue({ ...scope, now: T1, limit: 50 })).toEqual([]);
    expect(
      await store.recordAttempt({
        ...base,
        sourceKey: "missing",
        status: "sent",
        attempts: 1,
        nextAttemptAt: null,
      }),
    ).toBe(false);
    await repository.close();

    const reopened = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => T2,
    });
    try {
      const due = await reopened.webPush().listDue({ ...scope, now: T2, limit: 50 });
      expect(due).toHaveLength(1);
      expect(due[0]).toMatchObject({
        item: { sourceKey: "run:r1:completed" },
        attempt: { status: "pending", attempts: 1, lastCode: "WEB_PUSH_HTTP_503" },
      });
    } finally {
      await reopened.close();
    }
  });

  it("[WP-2] skips paused devices and prunes expired items with their attempts", async () => {
    const { stateRoot, repository, store } = await open();
    try {
      await store.saveSubscription(subscription("s1", "https://push.example/a"));
      await store.saveSubscription(subscription("s2", "https://push.example/b"));
      await store.markSubscription({
        ...scope,
        subscriptionId: "s2",
        state: "paused",
        failureCode: "WEB_PUSH_HTTP_403",
        deliveredAt: null,
        now: T1,
      });
      await store.enqueue({
        ...scope,
        items: [item("reminder:old:x", T0), item("reminder:new:x")],
        cursor: null,
        now: T0,
      });
      await store.recordAttempt({
        ...scope,
        sourceKey: "reminder:old:x",
        subscriptionId: "s1",
        status: "expired",
        attempts: 0,
        nextAttemptAt: null,
        lastCode: null,
        tag: "tag-old",
        now: T1,
      });
      const due = await store.listDue({ ...scope, now: T1, limit: 50 });
      expect(due.map(({ item, subscription }) => `${item.sourceKey}@${subscription.id}`)).toEqual([
        "reminder:new:x@s1",
      ]);
      expect(await store.prune({ ...scope, expiredBefore: T1, limit: 200 })).toBe(1);
      const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
      try {
        expect(database.prepare("SELECT count(*) FROM web_push_attempts").pluck().get()).toBe(0);
        expect(database.prepare("SELECT source_key FROM web_push_outbox").pluck().all()).toEqual([
          "reminder:new:x",
        ]);
      } finally {
        database.close();
      }
    } finally {
      await repository.close();
    }
  });

  it("[WP-11] keeps one feedback row per delivered notification, first reaction wins, and outlives the outbox", async () => {
    const { stateRoot, repository, store } = await open();
    try {
      await store.saveSubscription(subscription("s1", "https://push.example/a"));
      await store.saveSubscription(subscription("s2", "https://push.example/b"));
      await store.enqueue({
        ...scope,
        items: [
          item("reminder:r1:x", T1),
          { ...item("run:r9:completed", T1), kind: "run", threadId: "thread-9" },
          item("approval:a2", T1),
        ],
        cursor: null,
        now: T0,
      });
      const attempt = (
        sourceKey: string,
        subscriptionId: string,
        status: "sent" | "suppressed" | "failed",
        tag: string,
      ) =>
        store.recordAttempt({
          ...scope,
          sourceKey,
          subscriptionId,
          status,
          attempts: status === "suppressed" ? 0 : 1,
          nextAttemptAt: null,
          lastCode: null,
          tag,
          now: T0,
        });
      await attempt("reminder:r1:x", "s1", "sent", "tag-r1");
      await attempt("reminder:r1:x", "s2", "sent", "tag-r1");
      await attempt("run:r9:completed", "s1", "sent", "tag-r9");
      await attempt("run:r9:completed", "s1", "sent", "tag-r9");
      await attempt("approval:a2", "s1", "suppressed", "tag-a2");
      await attempt("approval:a2", "s2", "failed", "tag-a2");

      expect(
        await store.recordReactions({
          ...scope,
          reactions: [
            { tag: "tag-r1", reaction: "opened", occurredAt: T1 },
            { tag: "tag-r1", reaction: "opened", occurredAt: T2 },
            { tag: "tag-r9", reaction: "dismissed", occurredAt: "2026-10-26T11:00:00.000Z" },
            { tag: "tag-r9", reaction: "opened", occurredAt: "2026-10-27T00:00:00.000Z" },
            { tag: "tag-a2", reaction: "opened", occurredAt: T1 },
            { tag: "unknown", reaction: "opened", occurredAt: T1 },
          ],
          now: T2,
        }),
      ).toBe(3);
      expect(await store.prune({ ...scope, expiredBefore: T2, limit: 200 })).toBe(3);
      expect(await store.listFeedback({ ...scope, sentFrom: T0, limit: 50 })).toEqual([
        {
          sourceKey: "reminder:r1:x",
          tag: "tag-r1",
          kind: "reminder",
          sourceRef: "reminder:r1:x",
          threadId: null,
          channel: "web_push",
          firstSentAt: T0,
          devices: 2,
          openedAt: T1,
          dismissedAt: null,
        },
        {
          sourceKey: "run:r9:completed",
          tag: "tag-r9",
          kind: "run",
          sourceRef: "run:r9:completed",
          threadId: "thread-9",
          channel: "web_push",
          firstSentAt: T0,
          devices: 1,
          openedAt: T2,
          dismissedAt: T0,
        },
      ]);
      expect(await store.listFeedback({ ...scope, sentFrom: T1, limit: 50 })).toEqual([]);
      const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
      try {
        expect(database.prepare("SELECT count(*) FROM web_push_outbox").pluck().get()).toBe(0);
      } finally {
        database.close();
      }
    } finally {
      await repository.close();
    }
  });

  it("[WP-2] lists finished runs with a thread in finish order after a cursor", async () => {
    const { stateRoot, repository, store } = await open();
    await repository.payloadStore(OWNER_ID, AGENT_ID).put(
      await createReferenceAdapterSet().payloadProtector.protect({
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        ref: "payload",
        dataClassification: "private",
        contentType: "text/plain",
        plaintext: new TextEncoder().encode("hello"),
        createdAt: T0,
      }),
    );
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    try {
      database
        .prepare(
          `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
           VALUES ('thread-1', ?, ?, 1, 'open', ?, ?)`,
        )
        .run(OWNER_ID, AGENT_ID, T0, T0);
      const run = (id: string, threadId: string | null, status: string, updatedAt: string) => {
        database
          .prepare(
            `INSERT INTO triggers (
              id, owner_id, agent_id, thread_id, idempotency_key, source_type, source_id,
              payload_ref, source_proof_ref, occurred_at
            ) VALUES (?, ?, ?, ?, ?, 'user_message', ?, 'payload', 'proof', ?)`,
          )
          .run(`trigger-${id}`, OWNER_ID, AGENT_ID, threadId, `key-${id}`, id, T0);
        database
          .prepare(
            `INSERT INTO runs (
              id, owner_id, agent_id, thread_id, session_id, trigger_id, revision, status,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'session', ?, 1, ?, ?, ?)`,
          )
          .run(id, OWNER_ID, AGENT_ID, threadId, `trigger-${id}`, status, T0, updatedAt);
      };
      run("run-b", "thread-1", "completed", T1);
      run("run-a", "thread-1", "failed", T1);
      run("run-c", "thread-1", "cancelled", T1);
      run("run-d", "thread-1", "running", T1);
      run("run-e", null, "completed", T1);
      run("run-f", "thread-1", "completed", T2);
      database
        .prepare(
          `INSERT INTO run_coordination_checkpoints
            (run_id,owner_id,agent_id,revision,phase,runtime_event_count,terminal_status,diagnostic_code,updated_at)
           VALUES ('run-a',?,?,1,'failed',1,'failed','RUNTIME_TOOL_RESULT_UNKNOWN',?)`,
        )
        .run(OWNER_ID, AGENT_ID, T1);
      database
        .prepare(
          `INSERT INTO turns (id, owner_id, agent_id, thread_id, session_id, run_id, turn_index)
           VALUES ('turn-b', ?, ?, 'thread-1', 'session', 'run-b', 1)`,
        )
        .run(OWNER_ID, AGENT_ID);
      const message = (id: string, sequence: number, role: string, status: string, internal = 0) =>
        database
          .prepare(
            `INSERT INTO thread_messages (
              id, owner_id, agent_id, thread_id, revision, sequence, role, content_ref,
              classification, committed_at, turn_id, run_id, message_status, internal
            ) VALUES (?, ?, ?, 'thread-1', 1, ?, ?, 'payload', 'private', ?, 'turn-b', 'run-b', ?, ?)`,
          )
          .run(id, OWNER_ID, AGENT_ID, sequence, role, T1, status, internal);
      message("asked-b", 1, "owner", "committed");
      message("said-b", 2, "agent", "committed");
      message("cut-b", 3, "agent", "partial");
      message("inner-b", 4, "agent", "committed", 1);
      const first = await store.listFinishedRuns({ ...scope, afterCursor: T0, limit: 2 });
      expect(first).toEqual([
        {
          runId: "run-a",
          threadId: "thread-1",
          status: "failed",
          resultUnconfirmed: true,
          startedBy: "user_message",
          replyMessageId: null,
          finishedAt: T1,
          cursor: `${T1}|run-a`,
        },
        {
          runId: "run-b",
          threadId: "thread-1",
          status: "completed",
          resultUnconfirmed: false,
          startedBy: "user_message",
          replyMessageId: "said-b",
          finishedAt: T1,
          cursor: `${T1}|run-b`,
        },
      ]);
      const next = await store.listFinishedRuns({
        ...scope,
        afterCursor: first[1]?.cursor ?? "",
        limit: 10,
      });
      expect(next.map(({ runId }) => runId)).toEqual(["run-f"]);
    } finally {
      database.close();
      await repository.close();
    }
  });
});
