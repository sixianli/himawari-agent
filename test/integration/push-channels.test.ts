import { createECDH, createHash, randomBytes, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  APPLE_PUSH_CONFIGURATION_DEFAULTS,
  type ApplePushConfiguration,
  type ApprovalRequest,
  type DeviceActionRecord,
  herWordsPushKey,
  type MemoryReminder,
  type ProductMemoryRecord,
  type PushGate,
} from "@himawari-agent/application";
import {
  createAgentId,
  createDeviceId,
  createOwnerId,
  createSessionId,
} from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  createApplePushSender,
  createWebPushSender,
  type DeviceNotificationFrame,
  DeviceNotificationHub,
  DevicePresence,
  notificationActionHash,
} from "@himawari-agent/platform-node";
import type { ThreadBackgroundWork } from "@himawari-agent/gateway-contracts";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { MAC_PLACEMENT_LIMIT, MacPlacement } from "../../apps/agent-service/src/mac-placement.ts";
import {
  applePushAlertPayload,
  ProductionApplePush,
} from "../../apps/agent-service/src/production-apple-push.ts";
import {
  clip,
  ProductionWebPush,
  WebPushPresence,
  webPushTopic,
} from "../../apps/agent-service/src/production-web-push.ts";
import { type ApnsStub, startApnsStub } from "../fixtures/apns-stub.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-push-channels");
const AGENT_ID = createAgentId("agent-push-channels");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const START = "2026-11-01T00:59:00.000Z";
const T0 = "2026-11-01T01:00:00.000Z";
const ORIGIN = "https://himawari.siyi.win";
const TOPIC = "win.siyi.himawari";
const IPHONE = "dev_iphone0000000000000000";
const WATCH = "dev_watch00000000000000000";
const SECOND = "dev_second0000000000000000";

const at = (base: string, seconds: number) =>
  new Date(Date.parse(base) + seconds * 1_000).toISOString();
const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("MISSING_ALERT");
  return value;
};

describe("[IOS-4] push channels", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup(
    overrides: Partial<ApplePushConfiguration> = {},
    pushOptions: Partial<ConstructorParameters<typeof ProductionWebPush>[0]> = {},
    appleOptions: Partial<ConstructorParameters<typeof ProductionApplePush>[0]> = {},
  ) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-push-channels-"));
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
    const sessions = repository.sessionDeviceState();
    const webDevice = await sessions.saveDevice(
      {
        id: createDeviceId("device:web-browser"),
        ownerId: OWNER_ID,
        label: "Browser",
        status: "active",
        firstSeenAt: START,
        lastSeenAt: START,
      },
      null,
    );
    const webSession = await sessions.saveSession(
      {
        id: createSessionId("session:web-browser"),
        ownerId: OWNER_ID,
        deviceId: webDevice.id,
        authenticationRef: `sha256:${hex("web")}`,
        status: "active",
        firstAuthenticatedAt: START,
        lastActiveAt: START,
        recentAuthenticatedAt: START,
        revokedAt: null,
      },
      null,
    );
    const sql = <T>(run: (database: ReturnType<typeof openQualifiedDatabase>) => T): T => {
      const seed = openQualifiedDatabase(file);
      try {
        return run(seed);
      } finally {
        seed.close();
      }
    };
    const device = (id: string, kind: "iphone" | "watch" | "mac", companionOf?: string) =>
      sql((seed) =>
        seed
          .prepare(
            `INSERT INTO paired_devices (
              id, owner_id, agent_id, revision, kind, name, release_channel, device_public_key,
              confirm_public_key, status, supported_actions, web_device_id, web_session_id,
              paired_at, confirmed_at, revoked_at, last_seen_at, companion_of
            ) VALUES (?, ?, ?, 1, ?, ?, 'direct', ?, ?, 'active', '[]', ?, ?, ?, ?, NULL, NULL, ?)`,
          )
          .run(
            id,
            OWNER_ID,
            AGENT_ID,
            kind,
            id,
            `device-key-${id}`,
            `confirm-key-${id}`,
            webDevice.id,
            webSession.id,
            START,
            START,
            companionOf ?? null,
          ),
      );
    const run = (id: string, status: string, createdAt: string) =>
      sql((seed) => {
        seed
          .prepare(
            `INSERT INTO triggers (
              id, owner_id, agent_id, thread_id, idempotency_key, source_type, source_id,
              payload_ref, source_proof_ref, occurred_at
            ) VALUES (?, ?, ?, 'thread-1', ?, 'user_message', ?, 'payload', 'proof', ?)`,
          )
          .run(`trigger-${id}`, OWNER_ID, AGENT_ID, `key-${id}`, id, createdAt);
        seed
          .prepare(
            `INSERT INTO runs (
              id, owner_id, agent_id, thread_id, session_id, trigger_id, revision, status,
              created_at, updated_at
            ) VALUES (?, ?, ?, 'thread-1', 'session', ?, 2, ?, ?, ?)`,
          )
          .run(id, OWNER_ID, AGENT_ID, `trigger-${id}`, status, createdAt, createdAt);
      });
    const setRunStatus = (id: string, status: string, updatedAt: string) =>
      sql((seed) =>
        seed
          .prepare(
            "UPDATE runs SET status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
          )
          .run(status, updatedAt, id),
      );

    const apns: ApnsStub = await startApnsStub();
    closers.push(() => apns.close());
    const configuration: ApplePushConfiguration = {
      teamId: "TEAM123456",
      keyId: "KEY1234567",
      secretRef: "apple-push-key",
      topics: [TOPIC],
      environments: ["development", "production"],
      ...APPLE_PUSH_CONFIGURATION_DEFAULTS,
      ...overrides,
    };
    const appleSender = createApplePushSender({
      teamId: configuration.teamId,
      keyId: configuration.keyId,
      signingKey: apns.signingKeyPem,
      requestTimeoutSeconds: configuration.requestTimeoutSeconds,
      origins: apns.origins,
      now: () => Date.parse(clock),
    });
    closers.push(async () => appleSender.close());

    const webRequests: string[] = [];
    const webUrgencies: string[] = [];
    const webServer: Server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        webRequests.push(request.url ?? "");
        webUrgencies.push(String(request.headers["urgency"] ?? ""));
        response.writeHead(201).end();
      });
    });
    await new Promise<void>((resolve) => webServer.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise((resolve) => webServer.close(() => resolve())));
    const webOrigin = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;
    const webSender = createWebPushSender({
      privateKey: randomBytes(32),
      subject: "mailto:owner@example.com",
      fetch: (url, init) =>
        fetch(String(url).replace("https://push.example", webOrigin), init as RequestInit),
    });

    const reminders: MemoryReminder[] = [];
    const memories: ProductMemoryRecord[] = [];
    const approvals: ApprovalRequest[] = [];
    const presence = new WebPushPresence();
    const failures: unknown[] = [];
    const deliveries: { pushType: string; kind: string; code?: string }[] = [];
    const store = repository.webPush();
    const appleStore = repository.applePush();
    const applePush = new ProductionApplePush({
      ...scope,
      store: appleStore,
      sender: appleSender,
      configuration: () => configuration,
      threadTitle: async () => ({ title: "查下周东京天气" }),
      publicOrigin: ORIGIN,
      now: () => clock,
      onDelivery: (outcome) => deliveries.push(outcome),
      onFailure: (error) => failures.push(error),
      ...appleOptions,
    });
    const awaiting: { value: number | undefined; calls: number } = { value: 1, calls: 0 };
    const push = new ProductionWebPush({
      ...scope,
      store,
      sender: webSender,
      presence,
      ...pushOptions,
      awaitingCount: async () => {
        awaiting.calls += 1;
        return awaiting.value;
      },
      companion: applePush,
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
      runThread: async () => "thread-1",
      threadTitle: async () => ({ title: "查下周东京天气" }),
      readMessage:
        pushOptions.readMessage ??
        (async (threadId, messageId) =>
          threadId === "thread-1" && messageId === "assistant:said"
            ? { dataClassification: "private", readText: async () => "明早 9 点那班改好了。" }
            : undefined),
      publicOrigin: ORIGIN,
      timeZone: "Asia/Shanghai",
      now: () => clock,
      onFailure: (error) => failures.push(error),
    });
    const register = (
      deviceId: string,
      pushType: "alert" | "widgets" | "liveactivity",
      activityRef = "",
      seed = `${deviceId}:${pushType}:${activityRef}`,
    ) =>
      appleStore.saveRegistration({
        ...scope,
        id: `apn_${hex(seed).slice(0, 22)}`,
        deviceId,
        pushType,
        activityRef,
        token: hex(seed),
        environment: "development",
        topic: TOPIC,
        locale: "zh-CN",
        activityLimit: configuration.liveActivityRegistrationsPerDevice,
        now: clock,
      });
    const subscribe = async (id: string) => {
      const keys = createECDH("prime256v1");
      keys.generateKeys();
      await store.saveSubscription({
        ...scope,
        id,
        endpoint: `https://push.example/${id}`,
        p256dh: keys.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
        locale: "zh-CN",
        deviceLabel: id,
        now: clock,
      });
      await store.writeKinds({ ...scope, kinds: ["reminder", "approval", "run"], now: clock });
    };
    const reminder = (id: string, remindAt = T0) => {
      memories.push({
        id: `memory-${id}`,
        status: "active",
        dataClassification: "private",
      } as unknown as ProductMemoryRecord);
      reminders.push({
        id,
        ...scope,
        memoryId: `memory-${id}` as MemoryReminder["memoryId"],
        dueAt: remindAt,
        remindAt,
        repeat: "none",
        status: "scheduled",
        dismissedAt: null,
        createdAt: START,
        updatedAt: START,
      });
    };
    const approval = (id: string, presenceRequired: boolean) =>
      approvals.push({
        id,
        ...scope,
        revision: 1,
        runId: "run-approval",
        status: "pending",
        expiresAt: at(T0, 3_600),
        finalRisk: "high",
        semanticSnapshotHash: `hash-${id}`,
        recentAuthenticationRequired: presenceRequired,
      } as unknown as ApprovalRequest);
    return {
      apns,
      webRequests,
      webUrgencies,
      store,
      appleStore,
      pairedDevices: repository.pairedDevices(),
      applePush,
      push,
      presence,
      failures,
      deliveries,
      approvals,
      reminders,
      awaiting,
      configuration,
      device,
      run,
      setRunStatus,
      register,
      subscribe,
      reminder,
      approval,
      sql,
      setClock: (value: string) => {
        clock = value;
      },
    };
  }

  it("[IOS-4] sends a reminder to the iPhone through APNs with a valid provider token, and not through web push", async () => {
    const context = await setup();
    context.device(IPHONE, "iphone");
    const registration = await context.register(IPHONE, "alert");
    await context.subscribe("laptop");
    context.setClock(T0);
    context.reminder("r1");
    await context.push.tick();
    await context.push.tick();

    const alerts = context.apns.ofType("alert");
    expect(alerts).toHaveLength(1);
    const [alert] = alerts;
    expect(alert?.token).toBe(registration.token);
    expect(alert?.headers).toMatchObject({
      ":method": "POST",
      "apns-topic": TOPIC,
      "apns-priority": "10",
      "apns-collapse-id": webPushTopic("reminder:r1:2026-11-01T01:00:00.000Z"),
    });
    const [head, claims, signature] = String(alert?.headers["authorization"])
      .replace(/^bearer /u, "")
      .split(".");
    expect(JSON.parse(Buffer.from(String(head), "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEY1234567",
    });
    expect(JSON.parse(Buffer.from(String(claims), "base64url").toString())).toEqual({
      iss: "TEAM123456",
      iat: Math.floor(Date.parse(T0) / 1_000),
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${head}.${claims}`),
        { key: context.apns.publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(String(signature), "base64url"),
      ),
    ).toBe(true);
    expect(alert?.json).toMatchObject({
      aps: {
        alert: { title: "Himawari 提醒", body: "text of memory-r1\n11/1周日 09:00" },
        badge: 1,
        category: "himawari.plain",
        "interruption-level": "active",
      },
      himawari: { v: 1, kind: "reminder", navigate: "/memory", actions: [] },
    });
    expect(context.webRequests).toEqual([]);
    expect(
      context.sql((database) =>
        database
          .prepare(
            `SELECT a.channel, a.push_type AS pushType, a.status, o.channel AS routed,
               f.channel AS feedbackChannel
             FROM web_push_attempts a
             JOIN web_push_outbox o ON o.source_key = a.source_key
             JOIN web_push_feedback f ON f.source_key = a.source_key`,
          )
          .all(),
      ),
    ).toEqual([
      {
        channel: "apns",
        pushType: "alert",
        status: "sent",
        routed: "apns",
        feedbackChannel: "apns",
      },
    ]);
    expect(context.failures).toEqual([]);
  });

  it("[SAID-1] puts her own words on the iPhone lock screen and records the push as sent in both push tables", async () => {
    const context = await setup();
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.setClock(T0);
    const sourceKey = await herWordsPushKey({ messageId: "assistant:said" });
    await context.store.enqueue({
      ...scope,
      items: [
        {
          ...scope,
          sourceKey,
          kind: "reminder",
          sourceRef: "assistant:said",
          threadId: "thread-1",
          createdAt: T0,
          expiresAt: at(T0, 3_600),
        },
      ],
      cursor: null,
      now: T0,
    });
    await context.push.tick();
    await context.push.tick();
    const alerts = context.apns.ofType("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.json).toMatchObject({
      aps: { alert: { title: "Himawari", body: "明早 9 点那班改好了。" } },
      himawari: { kind: "reminder", navigate: "/threads/thread-1" },
    });
    expect(
      context.sql((database) =>
        database
          .prepare(
            `SELECT a.status, f.kind FROM web_push_attempts a
             JOIN web_push_feedback f ON f.source_key = a.source_key
             WHERE a.source_key = ?`,
          )
          .all(sourceKey),
      ),
    ).toEqual([{ status: "sent", kind: "reminder" }]);
    expect(context.failures).toEqual([]);
  });

  it("[SAID-1] REVERSE: her words that fail to read are retried on the iPhone and do not hold back the pushes behind them", async () => {
    let brokenReads = 0;
    const unreadable = new Error("payload cannot be decrypted");
    const context = await setup(
      {},
      {
        readMessage: async (threadId, messageId) => {
          if (threadId !== "thread-1") return undefined;
          if (messageId === "assistant:broken")
            return {
              dataClassification: "private",
              readText: async () => {
                brokenReads += 1;
                if (brokenReads === 1) throw unreadable;
                return "这一条第二次才读出来。";
              },
            };
          if (messageId === "assistant:said")
            return { dataClassification: "private", readText: async () => "这一条照常推。" };
          return undefined;
        },
      },
    );
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.setClock(T0);
    const items = [];
    for (const messageId of ["assistant:broken", "assistant:said"])
      items.push({
        ...scope,
        sourceKey: await herWordsPushKey({ messageId }),
        kind: "reminder" as const,
        sourceRef: messageId,
        threadId: "thread-1",
        createdAt: T0,
        expiresAt: at(T0, 3_600),
      });
    await context.store.enqueue({ ...scope, items, cursor: null, now: T0 });
    await context.push.tick();
    await context.push.tick();
    const bodies = () =>
      context.apns
        .ofType("alert")
        .map((alert) => (alert.json["aps"] as { alert: { body: string } }).alert.body);
    expect(bodies()).toEqual(["这一条照常推。"]);
    expect(context.failures).toContain(unreadable);
    context.setClock(at(T0, 61));
    await context.push.tick();
    expect(bodies()).toEqual(["这一条照常推。", "这一条第二次才读出来。"]);
  });

  it("[IOS-4] gives each approval button its own one-time token and marks the presence-required approve button", async () => {
    const context = await setup();
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.setClock(T0);
    context.approval("plain", false);
    context.approval("present", true);
    await context.push.tick();

    const alerts = context.apns.ofType("alert");
    expect(alerts).toHaveLength(2);
    const actionsOf = (index: number) =>
      (alerts[index]?.json["himawari"] as { actions: Record<string, unknown>[] }).actions;
    const all = [...actionsOf(0), ...actionsOf(1)];
    expect(new Set(all.map(({ token }) => token)).size).toBe(4);
    expect(all.every(({ token }) => /^[A-Za-z0-9_-]{43}$/u.test(String(token)))).toBe(true);
    const labels = alerts
      .map((alert, index) => ({
        approval:
          (alert.headers["apns-collapse-id"] as string) === webPushTopic("approval:present:1")
            ? "present"
            : "plain",
        actions: actionsOf(index).map(({ action, label, ownerPresence, labelBasis, polarity }) => [
          action,
          label,
          ownerPresence,
          labelBasis,
          polarity,
        ]),
      }))
      .sort((left, right) => left.approval.localeCompare(right.approval));
    expect(labels.map(({ actions }) => actions)).toEqual([
      [
        ["approve", "同意", false, "catalog", "positive"],
        ["deny", "不同意", false, "catalog", "negative"],
      ],
      [
        ["approve", "看内容再定", true, "catalog", "positive"],
        ["deny", "不同意", false, "catalog", "negative"],
      ],
    ]);
    expect(alerts[0]?.json["aps"]).toMatchObject({
      category: "himawari.actions",
      "interruption-level": "time-sensitive",
    });
    const stored = context.sql((database) =>
      database
        .prepare(
          `SELECT token_hash AS tokenHash, device_id AS deviceId, action,
             owner_presence AS ownerPresence, approval_request_id AS approvalId,
             approval_revision AS revision, approval_snapshot_hash AS snapshotHash,
             expires_at AS expiresAt, used_at AS usedAt
           FROM notification_action_tokens`,
        )
        .all(),
    ) as Record<string, unknown>[];
    expect(stored).toHaveLength(4);
    expect(stored.map(({ tokenHash }) => tokenHash).sort()).toEqual(
      all.map(({ token }) => notificationActionHash(String(token))).sort(),
    );
    expect(JSON.stringify(stored)).not.toContain(String(all[0]?.["token"]));
    expect(
      stored.every(
        (row) =>
          row["deviceId"] === IPHONE &&
          row["usedAt"] === null &&
          row["revision"] === 1 &&
          row["expiresAt"] === at(T0, 3_600),
      ),
    ).toBe(true);
    expect(
      stored
        .filter(({ ownerPresence }) => ownerPresence === 1)
        .map(({ action, approvalId, snapshotHash }) => [action, approvalId, snapshotHash]),
    ).toEqual([["approve", "present", "hash-present"]]);
  });

  it("[IOS-4] falls back to web push when no iPhone can take the alert, and never targets a watch or a revoked phone", async () => {
    const context = await setup();
    context.device(IPHONE, "iphone");
    context.device(WATCH, "watch", IPHONE);
    context.device(SECOND, "iphone");
    await context.register(WATCH, "alert");
    await context.register(SECOND, "alert");
    context.sql((database) =>
      database
        .prepare("UPDATE paired_devices SET status = 'revoked', revoked_at = ? WHERE id = ?")
        .run(START, SECOND),
    );
    await context.subscribe("laptop");
    context.setClock(T0);
    context.reminder("r1");
    await context.push.tick();
    await context.push.tick();

    expect(context.apns.requests).toEqual([]);
    expect(context.webRequests).toEqual(["/laptop"]);
    expect(
      context.sql((database) =>
        database.prepare("SELECT channel FROM web_push_outbox").pluck().all(),
      ),
    ).toEqual(["web_push"]);
  });

  it("[IOS-4] disables a token Apple reports gone and delivers the same notification through web push instead", async () => {
    const context = await setup();
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    await context.subscribe("laptop");
    context.apns.respond = () => ({ status: 410, reason: "Unregistered" });
    context.setClock(T0);
    context.reminder("r1");
    await context.push.tick();
    await context.push.tick();

    expect(context.apns.ofType("alert")).toHaveLength(1);
    expect(context.webRequests).toEqual(["/laptop"]);
    expect(
      context.sql((database) =>
        database.prepare("SELECT status, failure_code AS code FROM apns_registrations").all(),
      ),
    ).toEqual([{ status: "disabled", code: "APNS_410_Unregistered" }]);
    expect(await context.appleStore.listRegistrations({ ...scope, pushType: "alert" })).toEqual([]);
  });

  it("[IOS-4] retries after a server error and sends nothing while Himawari is on screen", async () => {
    const context = await setup();
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.setClock(T0);
    context.presence.beat(`device:${IPHONE}`, true, T0);
    context.reminder("seen");
    await context.push.tick();
    expect(context.apns.requests).toEqual([]);
    expect(
      context.sql((database) =>
        database.prepare("SELECT status FROM web_push_attempts").pluck().all(),
      ),
    ).toEqual(["suppressed"]);

    context.presence.beat(`device:${IPHONE}`, false, T0);
    context.apns.respond = () => ({ status: 503, reason: "ServiceUnavailable" });
    context.reminder("later", at(T0, 1));
    context.setClock(at(T0, 1));
    await context.push.tick();
    expect(context.apns.ofType("alert")).toHaveLength(1);
    context.apns.respond = () => ({ status: 200 });
    context.setClock(at(T0, 30));
    await context.push.tick();
    expect(context.apns.ofType("alert")).toHaveLength(1);
    context.setClock(at(T0, 62));
    await context.push.tick();
    expect(context.apns.ofType("alert")).toHaveLength(2);
    expect(
      context.sql((database) =>
        database
          .prepare("SELECT status, attempts FROM web_push_attempts ORDER BY source_key")
          .all(),
      ),
    ).toEqual([
      { status: "sent", attempts: 2 },
      { status: "suppressed", attempts: 0 },
    ]);
  });

  it("[IOS-4] refreshes widgets only when the home content changed and no more often than the configured interval", async () => {
    const context = await setup({ widgetRefreshMinimumSeconds: 600 });
    context.device(IPHONE, "iphone");
    const registration = await context.register(IPHONE, "widgets");
    context.setClock(T0);
    await context.push.tick();
    const widgets = () => context.apns.ofType("widgets");
    expect(widgets()).toHaveLength(1);
    expect(widgets()[0]?.token).toBe(registration.token);
    expect(widgets()[0]?.headers).toMatchObject({
      "apns-topic": `${TOPIC}.push-type.widgets`,
      "apns-priority": "5",
    });
    expect(widgets()[0]?.json).toEqual({ aps: { "content-changed": true } });

    context.setClock(at(T0, 700));
    await context.push.tick();
    expect(widgets()).toHaveLength(1);

    context.approval("a1", false);
    context.setClock(at(T0, 710));
    await context.push.tick();
    expect(widgets()).toHaveLength(2);

    context.approvals.length = 0;
    context.setClock(at(T0, 720));
    await context.push.tick();
    expect(widgets()).toHaveLength(2);
    context.setClock(at(T0, 1_320));
    await context.push.tick();
    expect(widgets()).toHaveLength(3);
    context.setClock(at(T0, 3_000));
    await context.push.tick();
    expect(widgets()).toHaveLength(3);
  });

  it("[IOS-4] starts a Live Activity only for a run that has gone on long enough, updates it on a phase change and ends it once", async () => {
    const context = await setup({
      liveActivityStartAfterSeconds: 30,
      liveActivityUpdateMinimumSeconds: 15,
    });
    context.device(IPHONE, "iphone");
    const starter = await context.register(IPHONE, "liveactivity");
    context.run("run-before-start", "running", at(START, -600));
    context.setClock(T0);
    context.run("run-long", "running", T0);
    const activity = () => context.apns.ofType("liveactivity");
    context.setClock(at(T0, 20));
    await context.push.tick();
    expect(activity()).toEqual([]);

    context.setClock(at(T0, 31));
    await context.push.tick();
    await context.push.tick();
    expect(activity()).toHaveLength(1);
    expect(activity()[0]?.token).toBe(starter.token);
    expect(activity()[0]?.headers["apns-topic"]).toBe(`${TOPIC}.push-type.liveactivity`);
    expect(activity()[0]?.json["aps"]).toMatchObject({
      event: "start",
      timestamp: Math.floor(Date.parse(at(T0, 31)) / 1_000),
      "attributes-type": "RunProgressAttributes",
      attributes: { runId: "run-long", threadId: "thread-1", title: "查下周东京天气" },
      "content-state": { phase: "working" },
      alert: { title: "Himawari 正在处理", body: "查下周东京天气" },
    });

    const update = await context.register(IPHONE, "liveactivity", "run-long");
    context.setClock(at(T0, 40));
    await context.push.tick();
    expect(activity()).toHaveLength(2);
    expect(activity()[1]?.token).toBe(update.token);
    expect(activity()[1]?.json["aps"]).toMatchObject({
      event: "update",
      "content-state": { phase: "working" },
    });
    await context.push.tick();
    expect(activity()).toHaveLength(2);

    context.setRunStatus("run-long", "awaiting_approval", at(T0, 41));
    context.setClock(at(T0, 45));
    await context.push.tick();
    expect(activity()).toHaveLength(2);
    context.setClock(at(T0, 56));
    await context.push.tick();
    expect(activity()).toHaveLength(3);
    expect(activity()[2]?.headers["apns-priority"]).toBe("10");
    expect(activity()[2]?.json["aps"]).toMatchObject({
      event: "update",
      "content-state": { phase: "waiting_for_owner" },
    });

    context.setRunStatus("run-long", "completed", at(T0, 57));
    context.setClock(at(T0, 58));
    await context.push.tick();
    expect(activity()).toHaveLength(4);
    expect(activity()[3]?.json["aps"]).toMatchObject({
      event: "end",
      "content-state": { phase: "completed" },
    });
    expect(
      await context.appleStore.listRegistrations({
        ...scope,
        pushType: "liveactivity",
        activityRef: "run-long",
      }),
    ).toEqual([]);
    context.setClock(at(T0, 120));
    await context.push.tick();
    expect(activity()).toHaveLength(4);
  });

  it("[IOS-4] leaves the runs of her background work to the background work Live Activity", async () => {
    const context = await setup({ liveActivityStartAfterSeconds: 30 });
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "liveactivity");
    context.setClock(T0);
    context.run("run-background", "running", T0);
    context.sql((seed) =>
      seed
        .prepare(
          `INSERT INTO subthreads (
            thread_id, owner_id, agent_id, parent_thread_id, matter, open_key, opened_by_run_id,
            brief_ref, classification, status, created_at, updated_at
          ) VALUES ('thread-1', ?, ?, 'thread-1', 'matter', 'open-key', 'run-main', 'brief',
            'private', 'open', ?, ?)`,
        )
        .run(OWNER_ID, AGENT_ID, T0, T0),
    );
    context.setClock(at(T0, 31));
    await context.push.tick();
    await context.push.tick();
    expect(context.apns.ofType("liveactivity")).toEqual([]);
  });

  it("[IOS-4] does not start a Live Activity while Himawari is on screen", async () => {
    const context = await setup({ liveActivityStartAfterSeconds: 30 });
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "liveactivity");
    context.setClock(T0);
    context.run("run-watched", "running", T0);
    context.setClock(at(T0, 31));
    context.presence.beat(`device:${IPHONE}`, true, at(T0, 31));
    await context.push.tick();
    expect(context.apns.requests).toEqual([]);
  });

  it("[IOS-4] tells a device to wipe its local data only after it is revoked, and a revoked device loses its tokens", async () => {
    const context = await setup();
    context.device(IPHONE, "iphone");
    const registration = await context.register(IPHONE, "alert");
    context.setClock(T0);
    context.approval("a1", false);
    await context.push.tick();
    expect(
      context.sql((database) =>
        database.prepare("SELECT count(*) FROM notification_action_tokens").pluck().get(),
      ),
    ).toBe(2);

    const sendWipe = await context.applePush.prepareWipe(IPHONE);
    expect(context.apns.ofType("background")).toEqual([]);
    const devices = context.sql((database) =>
      database.prepare("SELECT revision FROM paired_devices WHERE id = ?").pluck().get(IPHONE),
    ) as number;
    const repositoryDevices = context.pairedDevices;
    await repositoryDevices.revokeDevice({
      ...scope,
      deviceId: IPHONE,
      expectedRevision: devices,
      now: T0,
    });
    await sendWipe();
    const [wipe] = context.apns.ofType("background");
    expect(context.apns.ofType("background")).toHaveLength(1);
    expect(wipe?.token).toBe(registration.token);
    expect(wipe?.headers["apns-priority"]).toBe("5");
    expect(wipe?.json).toEqual({
      aps: { "content-available": 1 },
      himawari: { v: 1, command: "wipe_local_data", deviceId: IPHONE },
    });
    expect(
      context.sql((database) =>
        database.prepare("SELECT status, failure_code AS code FROM apns_registrations").all(),
      ),
    ).toEqual([{ status: "disabled", code: "DEVICE_REVOKED" }]);
    expect(
      context.sql((database) =>
        database.prepare("SELECT count(*) FROM notification_action_tokens").pluck().get(),
      ),
    ).toBe(0);
  });

  it("[IOS-4] asks the owner to open the app for a waiting device action with generic text, and puts nothing private on the lock screen", async () => {
    const context = await setup();
    context.device(IPHONE, "iphone");
    const registration = await context.register(IPHONE, "alert");
    context.setClock(T0);
    const record = (id: string, ownerPresence: boolean) =>
      ({
        id,
        deviceId: IPHONE,
        ownerPresence,
        expiresAt: "2026-11-13T00:10:00.000Z",
        action: "calendar.delete",
        arguments: { eventId: "牙医复诊" },
      }) as unknown as DeviceActionRecord;
    await context.applePush.requestOpen({ record: record("dact_" + "a".repeat(32), false) });
    await context.applePush.requestOpen({ record: record("dact_" + "b".repeat(32), true) });
    const sent = context.apns.ofType("alert");
    expect(sent).toHaveLength(2);
    expect(sent.map(({ token }) => token)).toEqual([registration.token, registration.token]);
    expect(sent.map(({ headers }) => headers["apns-priority"])).toEqual(["10", "10"]);
    expect(
      sent.map(({ json }) => (json as { aps: Record<string, unknown> }).aps["interruption-level"]),
    ).toEqual(["active", "time-sensitive"]);
    const first = sent[0]?.json as {
      aps: { alert: { title: string; body: string } };
      himawari: Record<string, unknown>;
    };
    expect(first.himawari).toMatchObject({
      kind: "device_action",
      actionId: "dact_" + "a".repeat(32),
      actions: [],
    });
    expect(JSON.stringify(first)).not.toContain("牙医复诊");
    expect(JSON.stringify(first)).not.toContain("calendar");
    expect(first.aps.alert.title.length).toBeGreaterThan(0);
  });

  it("[IOS-4] REVERSE: sends no open request to a device with no usable alert token, and none to another device's token", async () => {
    const context = await setup();
    context.device(IPHONE, "iphone");
    context.setClock(T0);
    const record = {
      id: "dact_" + "c".repeat(32),
      deviceId: IPHONE,
      ownerPresence: false,
      expiresAt: "2026-11-13T00:10:00.000Z",
    } as unknown as DeviceActionRecord;
    await context.applePush.requestOpen({ record });
    expect(context.apns.ofType("alert")).toEqual([]);
    context.device(WATCH, "watch");
    await context.register(WATCH, "alert");
    await context.applePush.requestOpen({ record });
    expect(context.apns.ofType("alert")).toEqual([]);
  });

  it("[IOS-4] replaces the unused button tokens when an approval alert is sent again after a server error", async () => {
    const context = await setup();
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.setClock(T0);
    context.approval("a1", false);
    context.apns.respond = () => ({ status: 503, reason: "ServiceUnavailable" });
    await context.push.tick();
    context.apns.respond = () => ({ status: 200 });
    context.setClock(at(T0, 62));
    await context.push.tick();
    const alerts = context.apns.ofType("alert");
    expect(alerts).toHaveLength(2);
    const sentTokens = (
      (alerts[1]?.json["himawari"] as { actions: { token: string }[] }).actions ?? []
    ).map(({ token }) => createHash("sha256").update(token, "utf8").digest("hex"));
    expect(
      context.sql((database) =>
        database
          .prepare("SELECT token_hash FROM notification_action_tokens ORDER BY token_hash")
          .pluck()
          .all(),
      ),
    ).toEqual([...sentTokens].sort());
  });

  it("[IOS-4] tries to start a Live Activity again after a temporary Apple error", async () => {
    const context = await setup({ liveActivityStartAfterSeconds: 30 });
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "liveactivity");
    context.setClock(T0);
    context.run("run-long", "running", T0);
    context.setClock(at(T0, 31));
    context.apns.respond = () => ({ status: 503, reason: "ServiceUnavailable" });
    await context.push.tick();
    expect(context.apns.ofType("liveactivity")).toHaveLength(1);
    context.apns.respond = () => ({ status: 200 });
    context.setClock(at(T0, 60));
    await context.push.tick();
    expect(context.apns.ofType("liveactivity")).toHaveLength(1);
    context.setClock(at(T0, 92));
    await context.push.tick();
    await context.push.tick();
    expect(context.apns.ofType("liveactivity")).toHaveLength(2);
  });

  it("[IOS-4] keeps only the newest Live Activity registrations of a device, up to the configured number", async () => {
    const context = await setup({ liveActivityRegistrationsPerDevice: 2 });
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "liveactivity");
    for (const [index, ref] of ["run-1", "run-2", "run-3"].entries()) {
      context.setClock(at(T0, index));
      await context.register(IPHONE, "liveactivity", ref);
    }
    expect(
      context.sql((database) =>
        database
          .prepare("SELECT activity_ref FROM apns_registrations ORDER BY activity_ref")
          .pluck()
          .all(),
      ),
    ).toEqual(["", "run-2", "run-3"]);
  });

  it("[IOS-4] shortens a very long title as well as the body so the alert still fits Apple's size limit", () => {
    const payload = applePushAlertPayload({
      title: "标题".repeat(3_000),
      body: "正文".repeat(3_000),
      navigate: "/threads/thread-1",
      tag: "tag-1",
      kind: "reminder",
      badge: 1,
      actions: [],
    });
    expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(4_096);
    expect(JSON.parse(payload).aps.alert.title.endsWith("…")).toBe(true);
  });

  it("[IOS-4] stops trying to start a Live Activity after Apple keeps rate limiting it", async () => {
    const context = await setup({ liveActivityStartAfterSeconds: 30 });
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "liveactivity");
    context.setClock(T0);
    context.run("run-long", "running", T0);
    context.apns.respond = () => ({ status: 429, reason: "TooManyRequests" });
    for (const seconds of [31, 60, 92, 200, 400, 700, 1_400, 2_400, 4_800]) {
      context.setClock(at(T0, seconds));
      await context.push.tick();
    }
    expect(context.apns.ofType("liveactivity")).toHaveLength(4);
  });

  it("[IOS-4] waits before sending a Live Activity update again after a server error, and gives up on that phase after the last retry", async () => {
    const context = await setup({ liveActivityUpdateMinimumSeconds: 1 });
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "liveactivity", "run-long");
    context.setClock(T0);
    context.run("run-long", "running", T0);
    context.apns.respond = () => ({ status: 503, reason: "ServiceUnavailable" });
    for (const seconds of [1, 11, 21, 62, 100, 400, 1_400, 2_400, 4_800]) {
      context.setClock(at(T0, seconds));
      await context.push.tick();
    }
    expect(context.apns.ofType("liveactivity")).toHaveLength(4);
  });

  it("[IOS-4] still delivers through web push when the Apple side throws", async () => {
    const context = await setup();
    await context.subscribe("laptop");
    const broken = new Error("APPLE_SIDE_BROKEN");
    (context.applePush as { deliver: unknown }).deliver = async () => {
      throw broken;
    };
    context.setClock(T0);
    context.reminder("r1");
    await context.push.tick();
    expect(context.webRequests).toEqual(["/laptop"]);
    expect(context.failures).toContain(broken);
  });

  it("[IOS-4] puts the count of things waiting for the owner on the badge, and leaves the badge out when that count cannot be read in full", async () => {
    const context = await setup();
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.setClock(T0);
    context.awaiting.value = 7;
    context.reminder("counted");
    await context.push.tick();
    const [first] = context.apns.ofType("alert");
    expect((first?.json["aps"] as { badge?: number }).badge).toBe(7);

    context.awaiting.value = undefined;
    context.reminder("unknown", at(T0, 1));
    context.setClock(at(T0, 1));
    await context.push.tick();
    const second = context.apns.ofType("alert")[1];
    expect(second).toBeDefined();
    expect(Object.keys(second?.json["aps"] as object)).not.toContain("badge");
  });

  it("[IOS-4] does not read the count when nothing is sent", async () => {
    const context = await setup();
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.setClock(T0);
    await context.push.tick();
    expect(context.awaiting.calls).toBe(0);
  });
  it("[IOS-4] holds a task result for the iPhone while the push gate defers it, and sends it once the hold ends", async () => {
    let action: "defer" | "deliver" = "defer";
    const gate = {
      decide: () =>
        action === "defer"
          ? { action: "defer" as const, until: at(T0, 600), ruleRefs: ["owner:night"] }
          : { action: "deliver" as const },
    } as unknown as PushGate;
    const context = await setup(
      {},
      { gate, readPushRules: async () => [], timeZone: "Asia/Tokyo" },
    );
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.setClock(at(T0, -100));
    context.run("run-gated", "running", at(T0, -100));
    context.setClock(T0);
    context.setRunStatus("run-gated", "completed", T0);
    await context.push.tick();
    await context.push.tick();
    expect(context.apns.ofType("alert")).toEqual([]);

    action = "deliver";
    context.setClock(at(T0, 601));
    await context.push.tick();
    await context.push.tick();
    expect(context.apns.ofType("alert")).toHaveLength(1);
  });

  it("[IOS-4] REVERSE: sends a task result to the iPhone at once when the push gate lets it through", async () => {
    const gate = { decide: () => ({ action: "deliver" as const }) } as unknown as PushGate;
    const context = await setup({}, { gate, readPushRules: async () => [] });
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.setClock(at(T0, -100));
    context.run("run-open", "running", at(T0, -100));
    context.setClock(T0);
    context.setRunStatus("run-open", "completed", T0);
    await context.push.tick();
    await context.push.tick();
    expect(context.apns.ofType("alert")).toHaveLength(1);
  });
  it("[IOS-4] uses the model-written approve button text for a plain approval, keeps the sentence off the lock screen, and keeps the fixed text when the owner must be present", async () => {
    const asked: string[] = [];
    const context = await setup(
      {},
      {},
      {
        approvalCopy: async ({ approvalRequestId }) => {
          asked.push(approvalRequestId);
          return { affirmLabel: "发出去" };
        },
      },
    );
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.setClock(T0);
    context.approval("plain", false);
    context.approval("present", true);
    await context.push.tick();
    const alerts = context.apns.ofType("alert");
    type Payload = {
      actions: { action: string; label: string; labelBasis: string; ownerPresence: boolean }[];
    };
    const approveOf = (alert: (typeof alerts)[number]) =>
      (alert.json["himawari"] as Payload).actions.find(({ action }) => action === "approve");
    const plain = must(alerts.find((alert) => approveOf(alert)?.ownerPresence === false));
    const present = must(alerts.find((alert) => approveOf(alert)?.ownerPresence === true));
    expect(approveOf(plain)).toMatchObject({ label: "发出去", labelBasis: "model" });
    expect(approveOf(present)).toMatchObject({ label: "看内容再定", labelBasis: "catalog" });
    expect(
      (plain.json["himawari"] as Payload).actions.find(({ action }) => action === "deny"),
    ).toMatchObject({
      label: "不同意",
      labelBasis: "catalog",
    });
    expect((plain.json["aps"] as { alert: { body: string } }).alert.body).toBe("查下周东京天气");
    expect(asked).toEqual(["plain"]);
  });

  it.each([
    ["the read throws", async () => Promise.reject(new Error("COPY_UNAVAILABLE")), 1],
    ["no label was written", async () => ({ affirmLabel: null }), 0],
    ["the label is blank", async () => ({ affirmLabel: "   " }), 0],
    ["the label has no visible character", async () => ({ affirmLabel: "\u200B" }), 0],
    ["the label is only a filler character", async () => ({ affirmLabel: "\u3164" }), 0],
  ])(
    "[IOS-4] REVERSE: falls back to the fixed approve text when %s",
    async (_name, approvalCopy, failureCount) => {
      const context = await setup({}, {}, { approvalCopy });
      context.device(IPHONE, "iphone");
      await context.register(IPHONE, "alert");
      context.setClock(T0);
      context.approval("plain", false);
      await context.push.tick();
      const [alert] = context.apns.ofType("alert");
      const actions = (
        alert?.json["himawari"] as {
          actions: { action: string; label: string; labelBasis: string }[];
        }
      ).actions;
      expect(actions.find(({ action }) => action === "approve")).toMatchObject({
        label: "同意",
        labelBasis: "catalog",
      });
      expect(context.failures).toHaveLength(failureCount);
    },
  );
  function macSetup(nowMs: () => number = () => Date.parse(T0)) {
    const hub = new DeviceNotificationHub();
    const presence = new DevicePresence();
    const frames: DeviceNotificationFrame[] = [];
    const byDevice = new Map<string, DeviceNotificationFrame[]>();
    const placement = new MacPlacement({
      hub,
      presence,
      windowMilliseconds: () => 300_000,
      nowMilliseconds: nowMs,
    });
    const connect = (deviceId: string) => {
      const listening = hub.listen(deviceId);
      const own: DeviceNotificationFrame[] = [];
      byDevice.set(deviceId, own);
      void (async () => {
        while (true) {
          const frame = await listening.next();
          frames.push(frame);
          own.push(frame);
        }
      })();
      closers.push(async () => listening.close());
      return () => listening.close();
    };
    return { hub, presence, frames, byDevice, placement, connect };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("[IOS-9] rings only the Mac when it is connected and had input recently, and not the iPhone", async () => {
    const mac = macSetup();
    const context = await setup({}, { placement: mac.placement });
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.reminder("mac");
    context.setClock(T0);
    mac.connect("dev_mac");
    mac.presence.record("dev_mac", Date.parse(T0) - 60_000);
    await context.push.tick();
    await context.push.tick();
    await settle();
    expect(context.apns.ofType("alert")).toEqual([]);
    expect(mac.frames).toHaveLength(1);
    expect(mac.frames[0]).toMatchObject({
      event: "notification.deliver",
      data: { id: webPushTopic(`reminder:mac:${T0}`), kind: "reminder" },
    });
  });

  it("[IOS-9] REVERSE: sends to the iPhone when the Mac is connected but had no input within the window", async () => {
    const mac = macSetup();
    const context = await setup({}, { placement: mac.placement });
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.reminder("away");
    context.setClock(T0);
    mac.connect("dev_mac");
    mac.presence.record("dev_mac", Date.parse(T0) - 600_000);
    await context.push.tick();
    await settle();
    expect(mac.frames).toEqual([]);
    expect(context.apns.ofType("alert")).toHaveLength(1);
  });

  it("[IOS-9] REVERSE: sends to the iPhone when the Mac had input but has no open stream", async () => {
    const mac = macSetup();
    const context = await setup({}, { placement: mac.placement });
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.reminder("closed");
    context.setClock(T0);
    mac.presence.record("dev_mac", Date.parse(T0) - 10_000);
    await context.push.tick();
    await settle();
    expect(mac.frames).toEqual([]);
    expect(context.apns.ofType("alert")).toHaveLength(1);
  });

  it("[IOS-9] tells the Mac to withdraw a notification once the reminder is settled", async () => {
    const mac = macSetup();
    const context = await setup({}, { placement: mac.placement });
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.reminder("gone");
    context.setClock(T0);
    mac.connect("dev_mac");
    mac.presence.record("dev_mac", Date.parse(T0) - 1_000);
    await context.push.tick();
    await settle();
    expect(mac.frames).toHaveLength(1);
    const [reminder] = context.reminders;
    if (reminder) Object.assign(reminder, { status: "done" });
    await context.push.tick();
    await settle();
    expect(mac.frames.map((frame) => frame.event)).toEqual([
      "notification.deliver",
      "notification.withdraw",
    ]);
  });

  it("[IOS-9] sends to only the Mac with the newest input when two Macs qualify", async () => {
    const mac = macSetup();
    const context = await setup({}, { placement: mac.placement });
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.reminder("two");
    context.setClock(T0);
    mac.connect("dev_old");
    mac.connect("dev_new");
    mac.presence.record("dev_old", Date.parse(T0) - 200_000);
    mac.presence.record("dev_new", Date.parse(T0) - 5_000);
    await context.push.tick();
    await settle();
    expect(mac.frames).toHaveLength(1);
    expect(mac.byDevice.get("dev_new")?.map((frame) => frame.event)).toEqual([
      "notification.deliver",
    ]);
    expect(mac.byDevice.get("dev_old")).toEqual([]);
    expect(context.apns.ofType("alert")).toEqual([]);
  });

  it("[IOS-9] a pile of notifications placed on the Mac does not keep a new one from reaching the iPhone", async () => {
    const mac = macSetup();
    const context = await setup({}, { placement: mac.placement });
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.setClock(T0);
    const disconnect = mac.connect("dev_mac");
    mac.presence.record("dev_mac", Date.parse(T0) - 1_000);
    for (let index = 0; index < 60; index += 1) context.reminder(`pile${index}`);
    await context.push.tick();
    await context.push.tick();
    await settle();
    expect(mac.frames).toHaveLength(60);
    disconnect();
    await settle();
    context.reminder("late", at(T0, 60));
    context.setClock(at(T0, 60));
    await context.push.tick();
    expect(context.apns.ofType("alert")).toHaveLength(1);
    expect(context.apns.ofType("alert")[0]?.json).toMatchObject({
      notificationId: webPushTopic(`reminder:late:${at(T0, 60)}`),
    });
  });

  it("[IOS-9] with two iPhones and the Mac holding many notifications, a new one still reaches both iPhones", async () => {
    const mac = macSetup();
    const context = await setup({}, { placement: mac.placement });
    context.device(IPHONE, "iphone");
    context.device(SECOND, "iphone");
    await context.register(IPHONE, "alert");
    await context.register(SECOND, "alert");
    context.setClock(T0);
    const disconnect = mac.connect("dev_mac");
    mac.presence.record("dev_mac", Date.parse(T0) - 1_000);
    for (let index = 0; index < 60; index += 1) context.reminder(`pile${index}`);
    for (let round = 0; round < 3; round += 1) await context.push.tick();
    await settle();
    expect(mac.frames).toHaveLength(60);
    disconnect();
    await settle();
    context.reminder("late", at(T0, 60));
    context.setClock(at(T0, 60));
    await context.push.tick();
    expect(context.apns.ofType("alert")).toHaveLength(2);
  });

  it("[IOS-9] once the Mac holds its limit, further notifications go to the iPhone and none is placed twice", async () => {
    const mac = macSetup();
    const context = await setup({}, { placement: mac.placement });
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.setClock(T0);
    mac.connect("dev_mac");
    mac.presence.record("dev_mac", Date.parse(T0) - 1_000);
    const total = MAC_PLACEMENT_LIMIT + 5;
    for (let index = 0; index < total; index += 1) context.reminder(`full${index}`);
    for (let round = 0; round < 5; round += 1) await context.push.tick();
    await settle();
    expect(mac.frames).toHaveLength(MAC_PLACEMENT_LIMIT);
    expect(mac.frames.every((frame) => frame.event === "notification.deliver")).toBe(true);
    expect(context.apns.ofType("alert")).toHaveLength(5);
  });

  it("[IOS-9] cuts a Mac title and body to their byte limits without breaking a character", () => {
    const long = "日本語".repeat(2_000);
    const cut = clip(long, 2_048);
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(2_048);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toContain("\uFFFD");
    expect(clip("short", 256)).toBe("short");
  });

  it("[IOS-9] tells the Mac to withdraw when the notification life ends while the reminder is still open", async () => {
    let nowMs = Date.parse(T0);
    const mac = macSetup(() => nowMs);
    const context = await setup({}, { placement: mac.placement });
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.reminder("stale");
    context.setClock(T0);
    mac.connect("dev_mac");
    mac.presence.record("dev_mac", nowMs - 1_000);
    await context.push.tick();
    await settle();
    nowMs += 7 * 3_600_000;
    context.setClock(new Date(nowMs).toISOString());
    await context.push.tick();
    await settle();
    expect(mac.frames.map((frame) => frame.event)).toEqual([
      "notification.deliver",
      "notification.withdraw",
    ]);
  });

  it("[IOS-9] answers which notification ids are settled, and leaves live and unknown ids out", async () => {
    const context = await setup();
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.reminder("live");
    context.reminder("done");
    context.setClock(T0);
    await context.push.tick();
    const liveId = webPushTopic(`reminder:live:${T0}`);
    const doneId = webPushTopic(`reminder:done:${T0}`);
    const reminder = context.reminders.find(({ id }) => id === "done");
    if (reminder) Object.assign(reminder, { status: "done" });
    expect(await context.push.settled([liveId, doneId, "unknown_id"])).toEqual([doneId]);
    expect(await context.push.settled([])).toEqual([]);
  });

  it("[IOS-9] puts the notification id at the top level of an alert push", async () => {
    const context = await setup();
    context.device(IPHONE, "iphone");
    await context.register(IPHONE, "alert");
    context.reminder("id");
    context.setClock(T0);
    await context.push.tick();
    const [alert] = context.apns.ofType("alert");
    expect(alert?.json["notificationId"]).toBe(webPushTopic(`reminder:id:${T0}`));
  });
  describe("[IOS-4] background work Live Activity", () => {
    type Work = ThreadBackgroundWork;
    type Row = Work["matters"][number]["subthreads"][number];
    const subthread = (overrides: Partial<Row> = {}): Row => ({
      subthreadId: "sub-1",
      status: "open",
      activity: "running",
      openedAt: START,
      updatedAt: START,
      progress: null,
      progressAt: null,
      runCount: 1,
      spentMicros: 0,
      budgetMicros: 1_000,
      title: "订东京酒店",
      runs: [],
      exchanges: [],
      tasks: [
        { number: 1, status: "completed", subject: "查价格", activeForm: "正在查价格" },
        { number: 2, status: "in_progress", subject: "比较房型", activeForm: "正在比较房型" },
        { number: 3, status: "pending", subject: "下单", activeForm: "正在下单" },
      ],
      ...overrides,
    });
    const work = (...rows: Row[]): Work => ({
      matters: [{ matter: "订东京酒店", subthreads: rows }],
    });
    const prepare = async (rows: { current: Work }) => {
      const context = await setup(
        { liveActivityStartAfterSeconds: 30, liveActivityUpdateMinimumSeconds: 15 },
        {},
        { backgroundWork: async () => rows.current },
      );
      context.device(IPHONE, "iphone");
      const starter = await context.appleStore.saveBackgroundActivity({
        ...scope,
        id: `bwa_${hex("starter").slice(0, 22)}`,
        deviceId: IPHONE,
        subthreadId: "",
        token: hex("starter"),
        environment: "development",
        topic: TOPIC,
        locale: "zh-CN",
        startedAt: null,
        activityLimit: context.configuration.liveActivityRegistrationsPerDevice,
        now: START,
      });
      const report = (subthreadId: string) =>
        context.appleStore.saveBackgroundActivity({
          ...scope,
          id: `bwa_${hex(`update:${subthreadId}`).slice(0, 22)}`,
          deviceId: IPHONE,
          subthreadId,
          token: hex(`update:${subthreadId}`),
          environment: "development",
          topic: TOPIC,
          locale: "zh-CN",
          startedAt: null,
          activityLimit: context.configuration.liveActivityRegistrationsPerDevice,
          now: START,
        });
      return { context, starter, report, activity: () => context.apns.ofType("liveactivity") };
    };

    it("starts once after the work has gone on long enough, follows each step, and ends when it is finished", async () => {
      const rows = { current: work(subthread()) };
      const { context, starter, report, activity } = await prepare(rows);
      context.setClock(T0);
      await context.push.tick();
      context.setClock(at(T0, 20));
      await context.push.tick();
      expect(activity()).toEqual([]);

      context.setClock(at(T0, 31));
      await context.push.tick();
      await context.push.tick();
      expect(activity()).toHaveLength(1);
      expect(activity()[0]?.token).toBe(starter.token);
      expect(activity()[0]?.headers["apns-priority"]).toBe("10");
      expect(activity()[0]?.json["aps"]).toMatchObject({
        event: "start",
        "attributes-type": "BackgroundWorkAttributes",
        attributes: { subthreadId: "sub-1", matter: "订东京酒店", title: "订东京酒店" },
        "content-state": {
          phase: "working",
          step: 2,
          stepCount: 3,
          completedCount: 1,
          activity: "正在比较房型",
        },
      });

      context.setClock(at(T0, 60));
      await context.push.tick();
      expect(activity()).toHaveLength(1);

      const update = await report("sub-1");
      await context.push.tick();
      expect(activity()).toHaveLength(1);

      rows.current = work(
        subthread({
          tasks: [
            { number: 1, status: "completed", subject: "查价格", activeForm: "正在查价格" },
            { number: 2, status: "completed", subject: "比较房型", activeForm: "正在比较房型" },
            { number: 3, status: "in_progress", subject: "下单", activeForm: "正在下单" },
          ],
        }),
      );
      context.setClock(at(T0, 70));
      await context.push.tick();
      expect(activity()).toHaveLength(2);
      expect(activity()[1]?.token).toBe(update.token);
      expect(activity()[1]?.headers["apns-priority"]).toBe("5");
      expect(activity()[1]?.json["aps"]).toMatchObject({
        event: "update",
        "content-state": { phase: "working", step: 3, stepCount: 3, completedCount: 2 },
      });
      await context.push.tick();
      expect(activity()).toHaveLength(2);

      rows.current = work(
        subthread({
          activity: "waiting_answer",
          tasks: rows.current.matters[0]?.subthreads[0]?.tasks ?? [],
        }),
      );
      context.setClock(at(T0, 75));
      await context.push.tick();
      expect(activity()).toHaveLength(2);
      context.setClock(at(T0, 90));
      await context.push.tick();
      expect(activity()).toHaveLength(3);
      expect(activity()[2]?.headers["apns-priority"]).toBe("10");
      expect(activity()[2]?.json["aps"]).toMatchObject({
        event: "update",
        "content-state": { phase: "waiting_for_owner" },
      });

      rows.current = work(
        subthread({
          status: "returned",
          activity: "finished",
          tasks: (rows.current.matters[0]?.subthreads[0]?.tasks ?? []).map((task) => ({
            ...task,
            status: "completed" as const,
          })),
        }),
      );
      context.setClock(at(T0, 95));
      await context.push.tick();
      expect(activity()).toHaveLength(4);
      expect(activity()[3]?.json["aps"]).toMatchObject({
        event: "end",
        "dismissal-date": Math.floor(Date.parse(at(T0, 95)) / 1_000) + 30,
        "content-state": { phase: "finished", step: 3, stepCount: 3, completedCount: 3 },
      });
      expect(await context.appleStore.listBackgroundActivities(scope)).toEqual([
        expect.objectContaining({ subthreadId: "" }),
      ]);
      context.setClock(at(T0, 200));
      await context.push.tick();
      expect(activity()).toHaveLength(4);
    });

    it("does not start while Himawari is on screen, for work that is not running, or without a push-to-start token", async () => {
      const rows = { current: work(subthread()) };
      const { context, activity } = await prepare(rows);
      context.setClock(T0);
      await context.push.tick();
      context.setClock(at(T0, 31));
      context.presence.beat(`device:${IPHONE}`, true, at(T0, 31));
      await context.push.tick();
      expect(activity()).toEqual([]);

      const idle = { current: work(subthread({ activity: "idle" })) };
      const second = await prepare(idle);
      second.context.setClock(T0);
      await second.context.push.tick();
      second.context.setClock(at(T0, 120));
      await second.context.push.tick();
      expect(second.activity()).toEqual([]);

      const bare = { current: work(subthread()) };
      const third = await setup(
        { liveActivityStartAfterSeconds: 30 },
        {},
        {
          backgroundWork: async () => bare.current,
        },
      );
      third.device(IPHONE, "iphone");
      third.setClock(T0);
      await third.push.tick();
      third.setClock(at(T0, 120));
      await third.push.tick();
      expect(third.apns.ofType("liveactivity")).toEqual([]);
    });

    it("does not start the same work twice when the phone never reports an update token, and forgets it when the work is over", async () => {
      const rows = { current: work(subthread()) };
      const { context, activity } = await prepare(rows);
      context.setClock(T0);
      await context.push.tick();
      context.setClock(at(T0, 31));
      await context.push.tick();
      expect(activity()).toHaveLength(1);
      expect(await context.appleStore.listBackgroundActivities(scope)).toHaveLength(2);
      context.setClock(at(T0, 31 + context.configuration.liveActivityStaleAfterSeconds * 3));
      await context.push.tick();
      await context.push.tick();
      expect(activity()).toHaveLength(1);
      expect(await context.appleStore.listBackgroundActivities(scope)).toHaveLength(2);

      rows.current = work(subthread({ status: "stopped", activity: "finished" }));
      context.setClock(at(T0, 31 + context.configuration.liveActivityStaleAfterSeconds * 3 + 5));
      await context.push.tick();
      expect(activity()).toHaveLength(1);
      expect(await context.appleStore.listBackgroundActivities(scope)).toHaveLength(1);
    });
  });
});
