import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WebPushSendRequest } from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { ManualClock } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createMuseChannelPushSource } from "../../apps/agent-service/src/production-muse-intake.ts";
import {
  ProductionWebPush,
  WebPushPresence,
} from "../../apps/agent-service/src/production-web-push.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-muse-push");
const AGENT_ID = createAgentId("agent-muse-push");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const T0 = "2026-11-01T00:00:00.000Z";
const ORIGIN = "https://himawari.example";
const HOUR = 3_600_000;

describe("Muse channel outage push", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup(options: { feature?: boolean; kinds?: ("reminder" | "run")[] } = {}) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-muse-push-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database.close();
    const clock = new ManualClock(T0);
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    closers.push(() => repository.close());
    const store = repository.museIntake();
    const webPushStore = repository.webPush();
    const sent: WebPushSendRequest[] = [];
    const failures: unknown[] = [];
    const push = new ProductionWebPush({
      ...scope,
      store: webPushStore,
      sender: {
        publicKey: "public-key",
        send: async (request) => {
          sent.push(request);
          return { kind: "sent" };
        },
      },
      presence: new WebPushPresence(),
      reminders: { listDue: async () => [], read: async () => undefined },
      memories: { readMany: async () => [] },
      readMemoryText: async () => undefined,
      listApprovals: async () => [],
      awaitingCount: async () => 0,
      runThread: async () => null,
      threadTitle: async () => null,
      readMessageText: async () => undefined,
      ...(options.feature === false
        ? {}
        : { museChannel: createMuseChannelPushSource({ scope, store }) }),
      publicOrigin: ORIGIN,
      timeZone: "Asia/Tokyo",
      now: () => clock.now(),
      onFailure: (error) => failures.push(error),
    });
    await webPushStore.saveSubscription({
      ...scope,
      id: "iphone",
      endpoint: "https://web.push.apple.com/iphone",
      p256dh: "key-iphone",
      auth: "auth-iphone",
      locale: "zh-CN",
      deviceLabel: "iPhone",
      now: T0,
    });
    await webPushStore.writeKinds({ ...scope, kinds: options.kinds ?? ["reminder"], now: T0 });
    const heartbeat = (seq: number) =>
      store.ingestBatch({
        ...scope,
        batchId: `batch-${seq}`,
        senderId: "muse",
        batchSeq: seq,
        sentAt: clock.now(),
        receivedAt: clock.now(),
        rejectedCount: 0,
        droppedFieldCount: 0,
        items: [],
      });
    const at = async (offsetMs: number) => {
      clock.set(new Date(Date.parse(T0) + offsetMs).toISOString());
      await push.tick();
    };
    return { store, sent, failures, heartbeat, at };
  }

  it("pushes once when no batch arrived for 3 hours, not before, and not again while the outage lasts", async () => {
    const h = await setup();
    await h.heartbeat(1);
    await h.at(2 * HOUR);
    await h.at(2.9 * HOUR);
    expect(h.sent).toEqual([]);
    await h.at(3 * HOUR);
    expect(h.sent).toHaveLength(1);
    const notification = JSON.parse(h.sent[0]?.payload ?? "{}").notification;
    expect(notification).toMatchObject({
      title: "Muse 通道中断",
      navigate: `${ORIGIN}/`,
      lang: "zh-CN",
    });
    expect(notification.body).toContain("3 小时没有数据");
    await h.at(3.5 * HOUR);
    await h.at(8 * HOUR);
    expect(h.sent).toHaveLength(1);
    expect(h.failures).toEqual([]);
  });

  it("pushes again for a second outage after the channel recovered", async () => {
    const h = await setup();
    await h.heartbeat(1);
    await h.at(3 * HOUR);
    expect(h.sent).toHaveLength(1);
    await h.at(4 * HOUR);
    await h.heartbeat(2);
    await h.at(5 * HOUR);
    expect(h.sent).toHaveLength(1);
    await h.at(6.9 * HOUR);
    expect(h.sent).toHaveLength(1);
    await h.at(7 * HOUR);
    expect(h.sent).toHaveLength(2);
  });

  it("stays silent when no batch ever arrived, when paused, when the feature is off, and when reminders are switched off", async () => {
    const never = await setup();
    await never.at(10 * HOUR);
    expect(never.sent).toEqual([]);

    const paused = await setup();
    await paused.heartbeat(1);
    await paused.store.setPaused({ ...scope, paused: true });
    await paused.at(10 * HOUR);
    expect(paused.sent).toEqual([]);

    const off = await setup({ feature: false });
    await off.heartbeat(1);
    await off.at(10 * HOUR);
    expect(off.sent).toEqual([]);

    const muted = await setup({ kinds: ["run"] });
    await muted.heartbeat(1);
    await muted.at(10 * HOUR);
    expect(muted.sent).toEqual([]);
  });
});
