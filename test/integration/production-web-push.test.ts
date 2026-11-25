import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ApprovalRequest,
  MemoryReminder,
  ProductMemoryRecord,
  WebPushSendRequest,
  WebPushSendResult,
} from "@himawari-agent/application";
import { enforceableOwnerRule, herWordsPushKey } from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProductionWebPush,
  WebPushPresence,
  webPushTopic,
} from "../../apps/agent-service/src/production-web-push.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-web-push-dispatch");
const AGENT_ID = createAgentId("agent-web-push-dispatch");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const START = "2026-11-01T00:59:00.000Z";
const T0 = "2026-11-01T01:00:00.000Z";
const ORIGIN = "https://himawari.siyi.win";

const at = (base: string, seconds: number) =>
  new Date(Date.parse(base) + seconds * 1_000).toISOString();

class FakeSender {
  readonly publicKey = "public-key";
  readonly requests: WebPushSendRequest[] = [];
  respond: (request: WebPushSendRequest) => WebPushSendResult = () => ({ kind: "sent" });
  async send(request: WebPushSendRequest) {
    this.requests.push(request);
    return this.respond(request);
  }
  notifications() {
    return this.requests.map((request) => ({
      endpoint: request.endpoint,
      ...(JSON.parse(request.payload) as {
        web_push: number;
        notification: Record<string, string>;
      }),
    }));
  }
}

describe("[WP-3] web push dispatch", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-web-push-dispatch-"));
    directories.push(stateRoot);
    const file = path.join(stateRoot, "product.sqlite");
    const database = openQualifiedDatabase(file);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database
      .prepare(
        `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
         VALUES ('thread-1', ?, ?, 1, 'open', ?, ?)`,
      )
      .run(OWNER_ID, AGENT_ID, START, START);
    database.close();
    let clock = START;
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => clock,
    });
    closers.push(() => repository.close());
    await repository.payloadStore(OWNER_ID, AGENT_ID).put(
      await createReferenceAdapterSet().payloadProtector.protect({
        ...scope,
        ref: "payload",
        dataClassification: "private",
        contentType: "text/plain",
        plaintext: new TextEncoder().encode("hello"),
        createdAt: START,
      }),
    );
    const store = repository.webPush();
    const protector = createReferenceAdapterSet().payloadProtector;
    const finishRun = (
      id: string,
      status: "completed" | "failed" | "cancelled",
      when: string,
      startedBy: "user_message" | "schedule" | "external_event" = "user_message",
    ) => {
      const seed = openQualifiedDatabase(file);
      try {
        seed
          .prepare(
            `INSERT INTO triggers (
              id, owner_id, agent_id, thread_id, idempotency_key, source_type, source_id,
              payload_ref, source_proof_ref, occurred_at
            ) VALUES (?, ?, ?, 'thread-1', ?, ?, ?, 'payload', 'proof', ?)`,
          )
          .run(`trigger-${id}`, OWNER_ID, AGENT_ID, `key-${id}`, startedBy, id, when);
        seed
          .prepare(
            `INSERT INTO runs (
              id, owner_id, agent_id, thread_id, session_id, trigger_id, revision, status,
              created_at, updated_at
            ) VALUES (?, ?, ?, 'thread-1', 'session', ?, 2, ?, ?, ?)`,
          )
          .run(id, OWNER_ID, AGENT_ID, `trigger-${id}`, status, when, when);
      } finally {
        seed.close();
      }
    };
    let sequence = 0;
    const say = async (
      runId: string,
      text: string,
      role: "agent" | "owner" = "agent",
      messageId = `assistant:${runId}:${role}`,
      classification: "private" | "sensitive" | "restricted" = "private",
    ) => {
      sequence += 1;
      await repository.payloadStore(OWNER_ID, AGENT_ID).put(
        await protector.protect({
          ...scope,
          ref: `said-${messageId}`,
          dataClassification: classification,
          contentType: "text/plain",
          plaintext: new TextEncoder().encode(text),
          createdAt: START,
        }),
      );
      const seed = openQualifiedDatabase(file);
      try {
        seed
          .prepare(
            `INSERT OR IGNORE INTO turns (
              id, owner_id, agent_id, thread_id, session_id, run_id, turn_index, committed_at
            ) VALUES (?, ?, ?, 'thread-1', 'session', ?, ?, NULL)`,
          )
          .run(`turn-${runId}`, OWNER_ID, AGENT_ID, runId, sequence);
        seed
          .prepare(
            `INSERT INTO thread_messages (
              id, owner_id, agent_id, thread_id, revision, sequence, role, content_ref,
              classification, committed_at, turn_id, run_id, message_status
            ) VALUES (?, ?, ?, 'thread-1', 1, ?, ?, ?, ?, ?, ?, ?, 'committed')`,
          )
          .run(
            messageId,
            OWNER_ID,
            AGENT_ID,
            sequence,
            role,
            `said-${messageId}`,
            classification,
            START,
            `turn-${runId}`,
            runId,
          );
      } finally {
        seed.close();
      }
      return messageId;
    };
    const unsay = (messageId: string) => {
      const seed = openQualifiedDatabase(file);
      try {
        seed.prepare("DELETE FROM thread_messages WHERE id = ?").run(messageId);
      } finally {
        seed.close();
      }
    };
    const readMessage = async (threadId: string, messageId: string) => {
      const [message] = await repository.threadRepository().readCommittedMessagesByIds({
        ...scope,
        threadId: threadId as never,
        messageIds: [messageId as never],
      });
      if (message?.role !== "agent") return undefined;
      return {
        dataClassification: message.dataClassification,
        readText: async () => {
          const payload = await repository.payloadStore(OWNER_ID, AGENT_ID).get(message.contentRef);
          return payload
            ? new TextDecoder().decode(await protector.unprotect({ ...scope, payload }))
            : undefined;
        },
      };
    };
    const reminders: MemoryReminder[] = [];
    const memories: ProductMemoryRecord[] = [];
    const approvals: ApprovalRequest[] = [];
    const titles = new Map<string, string | null>([["thread-1", "查下周东京天气"]]);
    const sender = new FakeSender();
    const presence = new WebPushPresence();
    const failures: unknown[] = [];
    const create = (extra: Partial<ConstructorParameters<typeof ProductionWebPush>[0]> = {}) =>
      new ProductionWebPush({
        ...scope,
        store,
        sender,
        presence,
        reminders: {
          listDue: async ({ now }) =>
            reminders.filter(
              (reminder) => reminder.status === "scheduled" && reminder.remindAt <= now,
            ),
          read: async (id) => reminders.find((reminder) => reminder.id === id),
        },
        memories: {
          readMany: async ({ memoryIds }) => memories.filter(({ id }) => memoryIds.includes(id)),
        },
        readMemoryText: async (memory) => `text of ${memory.id}`,
        listApprovals: async () => approvals,
        awaitingCount: async () => 7,
        runThread: async () => "thread-1",
        threadTitle: async (threadId) =>
          titles.has(threadId) ? { title: titles.get(threadId) ?? null } : null,
        readMessage,
        publicOrigin: ORIGIN,
        timeZone: "Asia/Shanghai",
        now: () => clock,
        onFailure: (error) => failures.push(error),
        ...extra,
      });
    const subscribe = (
      id: string,
      locale: "zh-CN" | "en" | "ja",
      kinds: readonly ("reminder" | "approval" | "run")[] = ["reminder", "approval", "run"],
    ) =>
      store
        .saveSubscription({
          ...scope,
          id,
          endpoint: `https://push.example/${id}`,
          p256dh: `key-${id}`,
          auth: `auth-${id}`,
          locale,
          deviceLabel: id,
          now: clock,
        })
        .then(async (saved) => {
          await store.writeKinds({ ...scope, kinds, now: clock });
          return saved;
        });
    const reminder = (id: string, classification: ProductMemoryRecord["dataClassification"]) => {
      memories.push({
        id: `memory-${id}`,
        status: "active",
        dataClassification: classification,
      } as unknown as ProductMemoryRecord);
      reminders.push({
        id,
        ...scope,
        memoryId: `memory-${id}` as MemoryReminder["memoryId"],
        dueAt: "2026-11-01T01:00:00.000Z",
        remindAt: T0,
        repeat: "none",
        status: "scheduled",
        dismissedAt: null,
        createdAt: START,
        updatedAt: START,
      });
    };
    const approval = (id: string, risk: string, expiresAt = at(T0, 3_600)) =>
      approvals.push({
        id,
        ...scope,
        runId: "run-approval",
        status: "pending",
        expiresAt,
        finalRisk: risk,
      } as unknown as ApprovalRequest);
    const rules = {
      write(
        ruleId: string,
        parameters: unknown,
        status: "active" | "needs_review" | "retired" = "active",
      ) {
        const database = openQualifiedDatabase(file);
        try {
          database
            .prepare(
              `INSERT INTO rule_book_rules (
                owner_id, agent_id, rule_id, revision, parameters, status, source, source_memory_id,
                updated_at, review_after
              ) VALUES (?, ?, ?, 1, ?, ?, 'test', NULL, ?, ?)
              ON CONFLICT (owner_id, agent_id, rule_id) DO UPDATE SET
                revision = revision + 1, parameters = excluded.parameters,
                status = excluded.status, updated_at = excluded.updated_at,
                review_after = excluded.review_after`,
            )
            .run(
              OWNER_ID,
              AGENT_ID,
              ruleId,
              JSON.stringify(parameters),
              status,
              clock,
              status === "needs_review" ? clock : null,
            );
        } finally {
          database.close();
        }
      },
      read: async () =>
        (await repository.ownerRules().list({ ...scope, includeRetired: false })).flatMap((row) => {
          const rule = enforceableOwnerRule(row);
          return rule?.gate === "push_delivery" ? [rule] : [];
        }),
      exec(statement: string) {
        const database = openQualifiedDatabase(file);
        try {
          database.exec(statement);
        } finally {
          database.close();
        }
      },
      ledger() {
        const database = openQualifiedDatabase(file);
        try {
          return database
            .prepare(
              `SELECT kind, outcome, reason_code AS reasonCode, subject_ref AS subjectRef,
                      json_extract(inputs, '$.ruleIds') AS ruleIds
               FROM decision_ledger WHERE kind = 'web_push'`,
            )
            .all() as {
            kind: string;
            outcome: string;
            reasonCode: string;
            subjectRef: string;
            ruleIds: string;
          }[];
        } finally {
          database.close();
        }
      },
      outbox(prefix: string, heldOnly = false) {
        const database = openQualifiedDatabase(file);
        try {
          return database
            .prepare(
              `SELECT defer_until AS deferUntil, expires_at AS expiresAt, defer_rule_refs AS refs
               FROM web_push_outbox
               WHERE source_key LIKE ? || '%' AND (? = 0 OR defer_until IS NOT NULL)`,
            )
            .get(prefix, heldOnly ? 1 : 0) as
            | { deferUntil: string | null; expiresAt: string; refs: string | null }
            | undefined;
        } finally {
          database.close();
        }
      },
    };
    return {
      store,
      rules,
      sender,
      presence,
      failures,
      approvals,
      reminders,
      titles,
      create,
      subscribe,
      reminder,
      approval,
      finishRun,
      say,
      unsay,
      readMessage,
      setClock: (value: string) => {
        clock = value;
      },
    };
  }

  it("[WP-3] pushes a reminder, an approval and finished runs once per device in its language", async () => {
    const context = await setup();
    await context.subscribe("phone", "zh-CN");
    await context.subscribe("laptop", "en");
    context.finishRun("run-old", "completed", at(START, -60));
    const push = context.create();
    await push.tick();
    expect(context.sender.requests).toEqual([]);

    context.setClock(T0);
    context.reminder("r1", "private");
    context.approval("a1", "high");
    context.finishRun("run-ok", "completed", at(T0, -5));
    context.finishRun("run-bad", "failed", at(T0, -4));
    context.finishRun("run-stopped", "cancelled", at(T0, -3));
    await push.tick();
    await push.tick();

    const sent = context.sender.notifications();
    expect(sent).toHaveLength(8);
    expect(sent.every((message) => message.web_push === 8030)).toBe(true);
    const phone = sent.filter(({ endpoint }) => endpoint.endsWith("/phone"));
    expect(phone.map(({ notification }) => [notification["title"], notification["body"]])).toEqual([
      ["等你审批 · 高风险", "查下周东京天气"],
      ["Himawari 提醒", "text of memory-r1\n11/1周日 09:00"],
      ["没有完成", "查下周东京天气"],
      ["已完成", "查下周东京天气"],
    ]);
    expect(phone[1]?.notification).toMatchObject({
      navigate: `${ORIGIN}/memory`,
      lang: "zh-CN",
      app_badge: "7",
    });
    expect(phone[0]?.notification["navigate"]).toBe(`${ORIGIN}/threads/thread-1`);
    const laptop = sent.filter(({ endpoint }) => endpoint.endsWith("/laptop"));
    expect(laptop.map(({ notification }) => notification["title"])).toEqual([
      "Waiting for your approval · High risk",
      "Himawari reminder",
      "Didn't finish",
      "Done",
    ]);
    const approvalRequest = context.sender.requests.find(({ payload }) =>
      payload.includes("等你审批"),
    );
    expect(approvalRequest).toMatchObject({
      urgency: "high",
      ttlSeconds: 3_600,
      topic: webPushTopic("approval:a1"),
    });
    expect(webPushTopic("approval:a1")).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(context.sender.requests.find(({ payload }) => payload.includes("已完成"))?.urgency).toBe(
      "normal",
    );
    expect(context.failures).toEqual([]);
    const feedback = await context.store.listFeedback({ ...scope, sentFrom: START, limit: 50 });
    expect(
      feedback.map(({ kind, devices, tag, sourceKey }) => [
        kind,
        devices,
        tag === webPushTopic(sourceKey),
      ]),
    ).toEqual([
      ["approval", 2, true],
      ["reminder", 2, true],
      ["run", 2, true],
      ["run", 2, true],
    ]);

    const restarted = context.create();
    context.setClock(at(T0, 30));
    await restarted.tick();
    expect(context.sender.requests).toHaveLength(8);
  });

  it("[HOME-count] sends no badge when the home count is unavailable or cannot be read, and reads it only when something is sent", async () => {
    const context = await setup();
    await context.subscribe("phone", "zh-CN");
    context.setClock(T0);
    let reads = 0;
    const unavailable = context.create({
      awaitingCount: async () => {
        reads += 1;
        return undefined;
      },
    });
    await unavailable.tick();
    expect(reads).toBe(0);
    context.reminder("r1", "private");
    await unavailable.tick();
    await unavailable.tick();
    expect(reads).toBe(1);
    expect(context.sender.notifications()).toHaveLength(1);
    expect("app_badge" in (context.sender.notifications()[0]?.notification ?? {})).toBe(false);
    expect(context.failures).toEqual([]);

    context.approval("a1", "high");
    const broken = context.create({
      awaitingCount: async () => {
        throw new Error("home count down");
      },
    });
    await broken.tick();
    await broken.tick();
    const sent = context.sender.notifications();
    expect(sent).toHaveLength(2);
    expect("app_badge" in (sent[1]?.notification ?? {})).toBe(false);
    expect(context.failures).toEqual([new Error("home count down")]);
  });

  it("[WP-3] hides sensitive reminders and suppresses everything while a page is visible", async () => {
    const context = await setup();
    await context.subscribe("phone", "ja");
    const push = context.create();
    await push.tick();
    context.setClock(T0);
    context.reminder("secret", "sensitive");
    await push.tick();
    expect(context.sender.notifications()[0]?.notification).toMatchObject({
      title: "Himawari リマインダー",
      body: "非公開のリマインダーがあります",
    });

    context.presence.beat("tab-1", true, T0);
    context.approval("a2", "low");
    context.setClock(at(T0, 40));
    await push.tick();
    context.presence.beat("tab-1", false, at(T0, 41));
    context.setClock(at(T0, 50));
    await push.tick();
    expect(context.sender.requests).toHaveLength(1);
  });

  it("[WP-3] sends every device only the kinds the account turned on, and never later", async () => {
    const context = await setup();
    await context.subscribe("phone", "zh-CN", ["approval"]);
    const push = context.create();
    await push.tick();
    context.setClock(T0);
    context.reminder("r-off", "private");
    context.approval("a-on", "low");
    context.finishRun("run-off", "completed", at(T0, -5));
    await push.tick();
    expect(context.sender.notifications().map(({ notification }) => notification["title"])).toEqual(
      ["等你审批 · 低风险"],
    );
    await context.subscribe("phone", "zh-CN", ["reminder", "approval", "run"]);
    context.setClock(at(T0, 30));
    await push.tick();
    expect(context.sender.requests).toHaveLength(1);
  });

  it("[WP-3] writes every device's notification in the language the account chose, not the one saved when the device subscribed", async () => {
    const context = await setup();
    await context.subscribe("phone", "zh-CN");
    const push = context.create({ readLocale: async () => "ja" });
    await push.tick();
    context.setClock(T0);
    context.approval("a1", "high");
    await push.tick();
    expect(context.sender.notifications().map(({ notification }) => notification["title"])).toEqual(
      ["承認待ち · 高リスク"],
    );
  });

  it("[WP-3] sends nothing while every kind is off, and falls back to the device language when the account has none", async () => {
    const context = await setup();
    await context.subscribe("phone", "ja", []);
    const push = context.create({ readLocale: async () => null });
    await push.tick();
    context.setClock(T0);
    context.reminder("r-off", "private");
    context.approval("a-off", "low");
    context.finishRun("run-off", "completed", at(T0, -5));
    await push.tick();
    expect(context.sender.requests).toEqual([]);
    await context.subscribe("phone", "ja", ["approval"]);
    context.approval("a-on", "low");
    context.setClock(at(T0, 30));
    await push.tick();
    expect(context.sender.notifications().map(({ notification }) => notification["title"])).toEqual(
      ["承認待ち · 低リスク"],
    );
  });

  it("[WP-3] expires work that was handled before it could be sent", async () => {
    const context = await setup();
    await context.subscribe("phone", "zh-CN");
    const push = context.create();
    await push.tick();
    context.setClock(T0);
    context.approval("a3", "medium");
    context.reminder("r3", "private");
    context.sender.respond = () => ({ kind: "retry", code: "WEB_PUSH_HTTP_503" });
    await push.tick();
    expect(context.sender.requests).toHaveLength(2);
    context.approvals.splice(0);
    const [reminder] = context.reminders;
    if (reminder) context.reminders[0] = { ...reminder, status: "dismissed" };
    context.sender.respond = () => ({ kind: "sent" });
    context.setClock(at(T0, 61));
    await push.tick();
    context.setClock(at(T0, 3_600));
    await push.tick();
    expect(context.sender.requests).toHaveLength(2);
  });

  it("[WP-3] retries server errors after 1, 5 and 15 minutes and then gives up", async () => {
    const context = await setup();
    await context.subscribe("phone", "zh-CN");
    const push = context.create();
    await push.tick();
    context.setClock(T0);
    context.approval("a4", "high", at(T0, 7_200));
    context.sender.respond = () => ({ kind: "retry", code: "WEB_PUSH_HTTP_503" });
    for (const seconds of [0, 59, 60, 359, 360, 1_259, 1_260, 3_000]) {
      context.setClock(at(T0, seconds));
      await push.tick();
    }
    expect(context.sender.requests).toHaveLength(4);
  });

  it("[WP-3] waits for Retry-After, removes gone devices, pauses rejected ones until the next restart", async () => {
    const context = await setup();
    await context.subscribe("gone", "zh-CN");
    await context.subscribe("limited", "zh-CN");
    await context.subscribe("rejected", "zh-CN");
    const push = context.create();
    await push.tick();
    context.setClock(T0);
    context.approval("a5", "high");
    context.sender.respond = ({ endpoint }) =>
      endpoint.endsWith("/gone")
        ? { kind: "gone", code: "WEB_PUSH_HTTP_410" }
        : endpoint.endsWith("/limited")
          ? { kind: "rate_limited", code: "WEB_PUSH_HTTP_429", retryAfterSeconds: 120 }
          : { kind: "rejected", code: "WEB_PUSH_HTTP_403" };
    await push.tick();
    const subscriptions = await context.store.listSubscriptions(scope);
    expect(subscriptions.map(({ id, state, failureCode }) => [id, state, failureCode])).toEqual([
      ["limited", "active", null],
      ["rejected", "paused", "WEB_PUSH_HTTP_403"],
    ]);
    context.sender.respond = () => ({ kind: "sent" });
    context.setClock(at(T0, 119));
    await push.tick();
    expect(context.sender.requests).toHaveLength(3);
    context.setClock(at(T0, 120));
    await push.tick();
    expect(context.sender.requests.map(({ endpoint }) => endpoint).at(-1)).toBe(
      "https://push.example/limited",
    );
    expect(context.sender.requests).toHaveLength(4);

    const restarted = context.create();
    context.setClock(at(T0, 130));
    context.approval("a6", "low");
    await restarted.tick();
    expect((await context.store.listSubscriptions(scope)).map(({ state }) => state)).toEqual([
      "active",
      "active",
    ]);
    expect(
      context.sender.requests.slice(4).map(({ endpoint }) => endpoint.split("/").at(-1)),
    ).toEqual(["limited", "rejected"]);
  });

  it("[WP-3] sends a test notification to one device without the presence rule", async () => {
    const context = await setup();
    const device = await context.subscribe("phone", "en");
    context.presence.beat("tab", true, START);
    const push = context.create();
    expect(await push.sendTest(device.id)).toEqual({ kind: "sent" });
    expect(context.sender.notifications()[0]?.notification).toMatchObject({
      title: "Notifications are on",
      navigate: `${ORIGIN}/`,
    });
    expect((await context.store.listSubscriptions(scope))[0]?.lastDeliveredAt).toBe(START);
  });
  const NIGHT_JST = {
    type: "push_quiet_hours",
    summary: "夜里别提醒我",
    params: { periods: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "23:00", end: "07:00" }] },
  };
  const BEFORE_NIGHT = "2026-11-11T14:00:00.000Z";
  const NIGHT = "2026-11-11T14:30:00.000Z";
  const MORNING = "2026-11-11T22:00:00.000Z";

  it("[HR-4] holds a task result until the owner's quiet hours end, writes the deferral once, then sends it to every device", async () => {
    const context = await setup();
    const deferCalls: string[] = [];
    const counted = {
      ...context.store,
      deferItem: (...input: Parameters<typeof context.store.deferItem>) => {
        deferCalls.push(input[0].sourceKey);
        return context.store.deferItem(...input);
      },
    };
    const push = context.create({
      store: counted,
      timeZone: "Asia/Tokyo",
      readPushRules: context.rules.read,
    });
    context.setClock(BEFORE_NIGHT);
    await context.subscribe("phone", "zh-CN");
    await context.subscribe("laptop", "en");
    context.rules.write("owner:night", NIGHT_JST);
    await push.tick();
    context.setClock(NIGHT);
    context.finishRun("run-night", "completed", at(NIGHT, -5));
    await push.tick();
    await push.tick();
    context.setClock(at(NIGHT, 3_000));
    await push.tick();
    expect(context.sender.requests).toEqual([]);
    expect(deferCalls).toHaveLength(1);
    expect(context.rules.outbox("run:")).toMatchObject({
      deferUntil: MORNING,
      refs: JSON.stringify(["owner:night@1"]),
    });
    expect(context.rules.ledger()).toEqual([
      {
        kind: "web_push",
        outcome: "deferred",
        reasonCode: "push_quiet_hours",
        subjectRef: expect.stringMatching(/^run:/),
        ruleIds: JSON.stringify(["owner:night@1"]),
      },
    ]);
    context.setClock(MORNING);
    await push.tick();
    await push.tick();
    expect(
      context.sender
        .notifications()
        .map(({ notification }) => notification["title"])
        .sort(),
    ).toEqual(["Done", "已完成"]);
    expect(context.failures).toEqual([]);
  });

  it("[HR-4] REVERSE: sends the same task result at once when no rule is set, and never holds an approval", async () => {
    const context = await setup();
    const push = context.create({ timeZone: "Asia/Tokyo", readPushRules: context.rules.read });
    context.setClock(BEFORE_NIGHT);
    await context.subscribe("phone", "zh-CN");
    await push.tick();
    context.setClock(NIGHT);
    context.finishRun("run-plain", "completed", at(NIGHT, -5));
    await push.tick();
    expect(context.sender.requests).toHaveLength(1);
    expect(context.rules.ledger()).toEqual([]);

    context.rules.write("owner:night", NIGHT_JST);
    context.approval("a-night", "high", at(NIGHT, 3_600));
    context.finishRun("run-held", "failed", at(NIGHT, -4));
    context.setClock(at(NIGHT, 20));
    await push.tick();
    const titles = context.sender.notifications().map(({ notification }) => notification["title"]);
    expect(titles).toEqual(["已完成", "等你审批 · 高风险"]);
    expect(context.rules.outbox("run:")).toBeDefined();
    expect(context.rules.ledger().map(({ subjectRef }) => subjectRef)).toEqual([
      "run:run-held:failed",
    ]);
  });

  it("[SAID-1] pushes her reply to the owner's message as her own words, once, and never the canned done line", async () => {
    const context = await setup();
    await context.subscribe("phone", "zh-CN");
    const push = context.create();
    await push.tick();
    context.setClock(T0);
    context.finishRun("run-asked", "completed", at(T0, -5));
    await context.say("run-asked", "明天东京晴，最高 14 度，带件薄外套就行。");
    await push.tick();
    await push.tick();
    expect(context.sender.notifications().map(({ notification }) => notification)).toEqual([
      expect.objectContaining({
        title: "Himawari",
        body: "明天东京晴，最高 14 度，带件薄外套就行。",
        navigate: `${ORIGIN}/threads/thread-1`,
      }),
    ]);
    const key = await herWordsPushKey({ messageId: "assistant:run-asked:agent" });
    expect(key.startsWith("said:")).toBe(true);
    expect(context.rules.outbox("said:")).toBeDefined();
    expect(
      await context.store.enqueue({
        ...scope,
        items: [
          {
            ...scope,
            sourceKey: key,
            kind: "reminder",
            sourceRef: "assistant:run-asked:agent",
            threadId: "thread-1",
            createdAt: T0,
            expiresAt: at(T0, 3_600),
          },
        ],
        cursor: null,
        now: T0,
      }),
    ).toBe(0);
    context.setClock(at(T0, 30));
    await push.tick();
    expect(context.sender.requests).toHaveLength(1);
    expect(context.failures).toEqual([]);
  });

  it("[SAID-1] REVERSE: a run started by an outside event pushes nothing, a scheduled run keeps its done line, and a deleted reply is never pushed", async () => {
    const context = await setup();
    await context.subscribe("phone", "zh-CN");
    const push = context.create();
    await push.tick();
    context.setClock(T0);
    context.finishRun("run-mail", "completed", at(T0, -6), "external_event");
    await context.say("run-mail", "这封邮件不用管。");
    context.finishRun("run-timer", "completed", at(T0, -5), "schedule");
    await context.store.enqueue({
      ...scope,
      items: [
        {
          ...scope,
          sourceKey: await herWordsPushKey({ messageId: "assistant:deleted" }),
          kind: "reminder",
          sourceRef: "assistant:deleted",
          threadId: "thread-1",
          createdAt: T0,
          expiresAt: at(T0, 3_600),
        },
      ],
      cursor: null,
      now: T0,
    });
    await push.tick();
    await push.tick();
    expect(context.sender.notifications().map(({ notification }) => notification["title"])).toEqual(
      ["已完成"],
    );
    expect(context.rules.outbox("said:7:message")).toBeDefined();
  });

  it("[SAID-1] REVERSE: an internal message between the main conversation and a sub-thread is never pushed", async () => {
    const context = await setup();
    await context.subscribe("phone", "zh-CN");
    const push = context.create({
      readMessage: async (threadId, messageId) =>
        messageId === "assistant:inner"
          ? {
              dataClassification: "private",
              internal: true,
              readText: async () => "子线程：邮件已经看完了。",
            }
          : context.readMessage(threadId, messageId),
    });
    await push.tick();
    context.setClock(T0);
    context.finishRun("run-fine", "completed", at(T0, -5));
    await context.say("run-fine", "这一条照常推。");
    await context.store.enqueue({
      ...scope,
      items: [
        {
          ...scope,
          sourceKey: await herWordsPushKey({ messageId: "assistant:inner" }),
          kind: "reminder",
          sourceRef: "assistant:inner",
          threadId: "thread-1",
          createdAt: T0,
          expiresAt: at(T0, 3_600),
        },
      ],
      cursor: null,
      now: T0,
    });
    await push.tick();
    await push.tick();
    expect(context.sender.notifications().map(({ notification }) => notification["body"])).toEqual([
      "这一条照常推。",
    ]);
  });

  it("[SAID-1] REVERSE: a sensitive or restricted reply never puts its words on the lock screen", async () => {
    const context = await setup();
    await context.subscribe("phone", "zh-CN");
    const push = context.create();
    await push.tick();
    context.setClock(T0);
    context.finishRun("run-secret", "completed", at(T0, -6));
    await context.say(
      "run-secret",
      "你的护照号是 TK1234567。",
      "agent",
      "assistant:run-secret:agent",
      "sensitive",
    );
    context.finishRun("run-locked", "completed", at(T0, -5));
    await context.say(
      "run-locked",
      "银行卡密码已经改好。",
      "agent",
      "assistant:run-locked:agent",
      "restricted",
    );
    await push.tick();
    await push.tick();
    const bodies = context.sender
      .notifications()
      .map(({ notification }) => String(notification["body"]));
    expect(bodies).toEqual(["你有一条私密消息", "你有一条私密消息"]);
    expect(bodies.join("\n")).not.toContain("TK1234567");
    expect(context.failures).toEqual([]);
  });

  it("[SAID-1] REVERSE: a reply whose words fail to read is retried, does not hold back the pushes behind it, and is given up only after the last retry", async () => {
    const context = await setup();
    await context.subscribe("phone", "zh-CN");
    const unreadable = new Error("payload cannot be decrypted");
    let flakyReads = 0;
    const push = context.create({
      readMessage: async (threadId, messageId) => {
        if (messageId === "assistant:run-broken:agent")
          return {
            dataClassification: "private",
            readText: async () => {
              throw unreadable;
            },
          };
        if (messageId === "assistant:run-flaky:agent")
          return {
            dataClassification: "private",
            readText: async () => {
              flakyReads += 1;
              if (flakyReads === 1) throw unreadable;
              return "这一条第二次才读出来。";
            },
          };
        return context.readMessage(threadId, messageId);
      },
    });
    await push.tick();
    context.setClock(T0);
    context.finishRun("run-broken", "completed", at(T0, -7));
    await context.say("run-broken", "这一条一直读不出来。");
    context.finishRun("run-flaky", "completed", at(T0, -6));
    await context.say("run-flaky", "这一条第二次才读出来。");
    context.finishRun("run-fine", "completed", at(T0, -5));
    await context.say("run-fine", "这一条照常推。");
    await push.tick();
    await push.tick();
    const bodies = () =>
      context.sender.notifications().map(({ notification }) => notification["body"]);
    expect(bodies()).toEqual(["这一条照常推。"]);
    const brokenId = webPushTopic(
      await herWordsPushKey({ messageId: "assistant:run-broken:agent" }),
    );
    expect(await push.settled([brokenId])).toEqual([]);
    context.setClock(at(T0, 61));
    await push.tick();
    expect(bodies()).toEqual(["这一条照常推。", "这一条第二次才读出来。"]);
    for (const seconds of [61 + 301, 61 + 301 + 901, 61 + 301 + 901 + 3_600]) {
      context.setClock(at(T0, seconds));
      await push.tick();
    }
    expect(bodies()).toEqual(["这一条照常推。", "这一条第二次才读出来。"]);
    expect(context.failures).toEqual(Array.from({ length: 6 }, () => unreadable));
  });

  it("[SAID-2] holds her words through the owner's quiet hours by default and sends them once when the hours end", async () => {
    const context = await setup();
    const push = context.create({ timeZone: "Asia/Tokyo", readPushRules: context.rules.read });
    context.setClock(BEFORE_NIGHT);
    await context.subscribe("phone", "zh-CN");
    context.rules.write("owner:night", NIGHT_JST);
    await push.tick();
    context.setClock(NIGHT);
    context.finishRun("run-night-words", "completed", at(NIGHT, -5));
    await context.say("run-night-words", "机票改好了，明早 9 点那班。");
    await push.tick();
    context.setClock(at(NIGHT, 3_000));
    await push.tick();
    expect(context.sender.requests).toEqual([]);
    expect(context.rules.outbox("said:")).toMatchObject({ deferUntil: MORNING });
    context.setClock(MORNING);
    await push.tick();
    await push.tick();
    expect(context.sender.notifications().map(({ notification }) => notification["body"])).toEqual([
      "机票改好了，明早 9 点那班。",
    ]);
  });

  it("[SAID-2] holds her reply under a quiet-hours rule stored before her words existed, because her reply replaced the task result push", async () => {
    const context = await setup();
    const push = context.create({ timeZone: "Asia/Tokyo", readPushRules: context.rules.read });
    context.setClock(BEFORE_NIGHT);
    await context.subscribe("phone", "zh-CN");
    context.rules.write("owner:night-stored", {
      ...NIGHT_JST,
      params: { ...NIGHT_JST.params, classes: ["mail_reminder", "run_result"] },
    });
    await push.tick();
    context.setClock(NIGHT);
    context.finishRun("run-night-stored", "completed", at(NIGHT, -5));
    await context.say("run-night-stored", "明天的会改到下午了。");
    await push.tick();
    expect(context.sender.requests).toEqual([]);
    expect(context.rules.outbox("said:")).toMatchObject({ deferUntil: MORNING });
  });

  it("[SAID-2] REVERSE: a quiet-hours rule that leaves out task results lets her words through", async () => {
    const context = await setup();
    const push = context.create({ timeZone: "Asia/Tokyo", readPushRules: context.rules.read });
    context.setClock(BEFORE_NIGHT);
    await context.subscribe("phone", "zh-CN");
    context.rules.write("owner:night-old", {
      ...NIGHT_JST,
      params: {
        ...NIGHT_JST.params,
        classes: ["scheduled_reminder", "mail_reminder"],
      },
    });
    await push.tick();
    context.setClock(NIGHT);
    context.finishRun("run-night-open", "completed", at(NIGHT, -5));
    await context.say("run-night-open", "已经帮你订好了。");
    await push.tick();
    expect(context.sender.notifications().map(({ notification }) => notification["body"])).toEqual([
      "已经帮你订好了。",
    ]);
    expect(context.rules.ledger()).toEqual([]);
  });

  it("[SAID-3] does not push her reply while the owner has the app open, and does not send it later when quiet hours end", async () => {
    const context = await setup();
    const push = context.create({ timeZone: "Asia/Tokyo", readPushRules: context.rules.read });
    context.setClock(BEFORE_NIGHT);
    await context.subscribe("phone", "zh-CN");
    context.rules.write("owner:night", NIGHT_JST);
    await push.tick();
    context.setClock(NIGHT);
    context.presence.beat("device:iphone", true, NIGHT);
    context.finishRun("run-watching", "completed", at(NIGHT, -5));
    await context.say("run-watching", "好的，记下了。");
    await push.tick();
    context.presence.beat("device:iphone", false, at(NIGHT, 10));
    context.setClock(MORNING);
    await push.tick();
    expect(context.sender.requests).toEqual([]);
    expect(context.rules.ledger()).toEqual([]);
  });

  it("[HR-4] REVERSE: a deferral whose decision record cannot be written is rolled back, and the push is sent at once with a failure report", async () => {
    const context = await setup();
    const reported: string[] = [];
    const push = context.create({
      timeZone: "Asia/Tokyo",
      readPushRules: context.rules.read,
      onGateFailure: ({ sourceKey }) => reported.push(sourceKey),
    });
    context.setClock(BEFORE_NIGHT);
    await context.subscribe("phone", "zh-CN");
    context.rules.write("owner:night", NIGHT_JST);
    await push.tick();
    context.rules.exec(
      `CREATE TRIGGER block_web_push_record BEFORE INSERT ON decision_ledger
       WHEN NEW.kind = 'web_push' BEGIN SELECT RAISE(ABORT, 'LEDGER_BLOCKED'); END`,
    );
    context.setClock(NIGHT);
    context.finishRun("run-night", "completed", at(NIGHT, -5));
    await push.tick();
    expect(context.rules.outbox("run:")?.deferUntil).toBeNull();
    expect(context.rules.ledger()).toEqual([]);
    expect(context.sender.requests).toHaveLength(1);
    expect(reported).toEqual([expect.stringMatching(/^run:/)]);
    expect(context.failures).toEqual([]);
  });

  it("[HR-4] judges a push class once per round, however many pushes of that class are due", async () => {
    const context = await setup();
    let reads = 0;
    const push = context.create({
      timeZone: "Asia/Tokyo",
      readPushRules: async () => {
        reads += 1;
        return context.rules.read();
      },
    });
    context.setClock(BEFORE_NIGHT);
    await context.subscribe("phone", "zh-CN");
    context.rules.write("owner:night", NIGHT_JST);
    await push.tick();
    context.setClock(NIGHT);
    context.finishRun("run-a", "completed", at(NIGHT, -5));
    context.finishRun("run-b", "failed", at(NIGHT, -4));
    reads = 0;
    await push.tick();
    expect(reads).toBe(1);
    expect(context.rules.ledger()).toHaveLength(2);
    expect(context.sender.requests).toEqual([]);
  });

  it("[HR-4] releases held pushes at once when the rule is withdrawn", async () => {
    const context = await setup();
    const push = context.create({ timeZone: "Asia/Tokyo", readPushRules: context.rules.read });
    context.setClock(BEFORE_NIGHT);
    await context.subscribe("phone", "zh-CN");
    context.rules.write("owner:night", NIGHT_JST);
    await push.tick();
    context.setClock(NIGHT);
    context.finishRun("run-night", "completed", at(NIGHT, -5));
    await push.tick();
    expect(context.sender.requests).toEqual([]);
    context.setClock(at(NIGHT, 600));
    context.rules.write("owner:night", NIGHT_JST, "retired");
    expect(context.rules.outbox("run:")?.deferUntil).toBeNull();
    await push.tick();
    expect(context.sender.requests).toHaveLength(1);
  });

  it("[HR-4] REVERSE: a rule withdrawn between reading and deferring leaves no stale hold, and the push goes out next round", async () => {
    const context = await setup();
    let withdraw = false;
    const push = context.create({
      timeZone: "Asia/Tokyo",
      readPushRules: async () => {
        const rules = await context.rules.read();
        if (withdraw) context.rules.write("owner:night", NIGHT_JST, "retired");
        return rules;
      },
    });
    context.setClock(BEFORE_NIGHT);
    await context.subscribe("phone", "zh-CN");
    context.rules.write("owner:night", NIGHT_JST);
    await push.tick();
    context.setClock(NIGHT);
    context.finishRun("run-race", "completed", at(NIGHT, -5));
    withdraw = true;
    await push.tick();
    expect(context.rules.outbox("run:")?.deferUntil).toBeNull();
    expect(context.rules.ledger()).toEqual([]);
    expect(context.sender.requests).toEqual([]);
    withdraw = false;
    await push.tick();
    expect(context.sender.requests).toHaveLength(1);
  });

  it("[HR-4] sends a device that subscribed during the hold only when the hold ends", async () => {
    const context = await setup();
    const push = context.create({ timeZone: "Asia/Tokyo", readPushRules: context.rules.read });
    context.setClock(BEFORE_NIGHT);
    await context.subscribe("phone", "zh-CN");
    context.rules.write("owner:night", NIGHT_JST);
    await push.tick();
    context.setClock(NIGHT);
    context.finishRun("run-night", "completed", at(NIGHT, -5));
    await push.tick();
    context.setClock(at(NIGHT, 600));
    await context.subscribe("tablet", "en");
    await push.tick();
    expect(context.sender.requests).toEqual([]);
    context.setClock(MORNING);
    await push.tick();
    expect(context.sender.notifications().map(({ endpoint }) => endpoint.split("/").pop())).toEqual(
      ["phone", "tablet"],
    );
  });

  it("[HR-4] lets the owner's own reminder be held only when the rule names it, and keeps the held reminder alive past its six hours", async () => {
    const context = await setup();
    const push = context.create({ timeZone: "Asia/Tokyo", readPushRules: context.rules.read });
    context.setClock(BEFORE_NIGHT);
    await context.subscribe("phone", "zh-CN");
    context.rules.write("owner:night", NIGHT_JST);
    await push.tick();
    context.setClock(NIGHT);
    context.reminder("r-night", "private");
    context.reminders[0] = { ...context.reminders[0], remindAt: NIGHT } as MemoryReminder;
    await push.tick();
    expect(context.sender.requests).toHaveLength(1);

    context.rules.write("owner:night", {
      ...NIGHT_JST,
      params: { ...NIGHT_JST.params, classes: ["scheduled_reminder"] },
    });
    context.reminder("r-held", "private");
    context.reminders[1] = { ...context.reminders[1], remindAt: at(NIGHT, 60) } as MemoryReminder;
    context.setClock(at(NIGHT, 120));
    await push.tick();
    expect(context.sender.requests).toHaveLength(1);
    const held = context.rules.outbox("reminder:", true);
    expect(held?.deferUntil).toBe(MORNING);
    expect(Date.parse(held?.expiresAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(MORNING) + 3_600_000,
    );
    context.setClock(MORNING);
    await push.tick();
    expect(context.sender.requests).toHaveLength(2);
  });

  it("[HR-4] holds a push for a rule that needs review exactly as for an active one, and lengthens its life", async () => {
    const context = await setup();
    const push = context.create({ timeZone: "Asia/Tokyo", readPushRules: context.rules.read });
    context.setClock(BEFORE_NIGHT);
    await context.subscribe("phone", "zh-CN");
    context.rules.write("owner:night", NIGHT_JST, "needs_review");
    await push.tick();
    context.setClock(NIGHT);
    context.finishRun("run-review", "completed", at(NIGHT, -5));
    await push.tick();
    const held = context.rules.outbox("run:");
    expect(held?.deferUntil).toBe(MORNING);
    expect(Date.parse(held?.expiresAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(MORNING) + 3_600_000,
    );
    expect(context.rules.ledger()).toHaveLength(1);
    expect(context.sender.requests).toEqual([]);
  });

  it("[HR-4] REVERSE: a rule store that fails never stops pushes, and the failure is reported", async () => {
    const context = await setup();
    const reported: string[] = [];
    const push = context.create({
      timeZone: "Asia/Tokyo",
      readPushRules: async () => {
        throw new Error("rule store down");
      },
      onGateFailure: ({ sourceKey }) => reported.push(sourceKey),
    });
    context.setClock(BEFORE_NIGHT);
    await context.subscribe("phone", "zh-CN");
    await push.tick();
    context.setClock(NIGHT);
    context.finishRun("run-night", "completed", at(NIGHT, -5));
    await push.tick();
    expect(context.sender.requests).toHaveLength(1);
    expect(reported).toHaveLength(1);
    expect(context.failures).toEqual([]);
  });
});
