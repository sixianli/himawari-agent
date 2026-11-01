import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProactiveSeal, type MuseIntakeItemWrite } from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import type { GatewayV2Command, GatewayV2Query } from "@himawari-agent/gateway-contracts";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import {
  DeterministicIdGenerator,
  DeterministicPayloadProtector,
  ManualClock,
} from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionMuseControl } from "../../apps/agent-service/src/production-muse-intake-control.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-muse-control");
const AGENT_ID = createAgentId("agent-muse-control");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const NOW = "2026-11-08T00:00:00.000Z";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

function message(kind: "query" | "command", type: string, payload: unknown, ownerId = OWNER_ID) {
  return {
    schemaVersion: "gateway.v2",
    kind,
    type,
    messageId: `message-${type}`,
    correlationId: `correlation-${type}`,
    causationId: null,
    dataClassification: "private",
    risk: kind === "command" ? "medium" : "low",
    authorizationRef: null,
    scope: { ownerId, agentId: AGENT_ID },
    authority: { deploymentId: "deployment", authorityEpoch: 1, fencingToken: 1 },
    actor: { actorType: "owner", actorId: "owner-subject" },
    ...(kind === "command" ? { idempotencyKey: `idempotency-${type}` } : {}),
    payload,
  };
}

describe("Muse overview and commands", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-muse-control-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database.close();
    const clock = new ManualClock(NOW);
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => clock.now(),
    });
    closers.push(() => repository.close());
    const ids = new DeterministicIdGenerator();
    const seal = createProactiveSeal({
      payloads: repository.payloadStore(OWNER_ID, AGENT_ID),
      protector: new DeterministicPayloadProtector(),
      ids,
    });
    const store = repository.museIntake();
    const control = new ProductionMuseControl({ scope, store, seal, ids, clock });
    let seq = 0;
    const add = async (
      key: string,
      overrides: Partial<MuseIntakeItemWrite> = {},
      text: string | null = `text ${key}`,
    ) => {
      seq += 1;
      const textRef = text === null ? null : await seal.seal({ ...scope, text, at: NOW });
      const titleRef = await seal.seal({ ...scope, text: `title ${key}`, at: NOW });
      await store.ingestBatch({
        ...scope,
        batchId: `batch-${seq}`,
        senderId: "muse",
        batchSeq: seq,
        sentAt: NOW,
        receivedAt: NOW,
        rejectedCount: 0,
        droppedFieldCount: 0,
        items: [
          {
            kind: "proactive",
            naturalKey: key,
            state: "delivered",
            reasonCode: null,
            decision: "send",
            reasonEnum: null,
            priority: null,
            occurredAt: ago(HOUR),
            scheduledFor: null,
            startedAt: null,
            preparedAt: null,
            handoffAcceptedAt: null,
            eventAt: null,
            titleRef,
            textRef,
            textWithheld: false,
            options: [],
            sources: { occurred_at: "system_record" },
            contentDigest: `digest-${key}`,
            ...overrides,
          },
        ],
      });
    };
    const overview = async () => {
      const snapshot = await control.query(
        message("query", "muse.overview.read", {}) as GatewayV2Query,
      );
      if (snapshot.type !== "muse.overview.snapshot") throw new Error("unexpected snapshot");
      return snapshot.payload;
    };
    const command = (type: string, payload: unknown, ownerId = OWNER_ID) =>
      control.execute(message("command", type, payload, ownerId) as GatewayV2Command);
    return { add, overview, command, store, control };
  }

  it("counts only the last seven days, keeps suppressed separate, and lists unrated items first", async () => {
    const h = await setup();
    await h.add("recent-1");
    await h.add("recent-2", { occurredAt: ago(2 * DAY) });
    await h.add("old", { occurredAt: ago(10 * DAY) });
    await h.add("held", { state: "suppressed", reasonCode: "revalidation_declined" }, null);
    const first = await h.overview();
    expect(first).toMatchObject({
      channel: { state: "ok", gapCount: 0 },
      receivedWeek: 2,
      suppressedWeek: 1,
      pending: 3,
      delay: null,
    });
    expect(first.items.map((item) => item.naturalKey)).toEqual(["recent-1", "recent-2", "old"]);
    expect(first.items[0]).toMatchObject({ title: "title recent-1", text: "text recent-1" });

    await h.command("muse.item.rate", {
      kind: "proactive",
      naturalKey: "recent-1",
      timingOk: true,
      contentOk: false,
    });
    const second = await h.overview();
    expect(second.pending).toBe(2);
    expect(second.items.map((item) => item.naturalKey)).toEqual(["recent-2", "old", "recent-1"]);
    expect(second.items[2]).toMatchObject({ timingOk: true, contentOk: false });
  });

  it("shows the event-to-reminder delay only with ten counted samples, and ignores uncounted sources", async () => {
    const h = await setup();
    for (let index = 1; index <= 9; index += 1)
      await h.add(
        `d${index}`,
        {
          eventAt: ago(HOUR + index * 60_000 * 60),
          sources: { occurred_at: "system_record", event_at: "system_record" },
        },
        "t",
      );
    expect((await h.overview()).delay).toBeNull();
    await h.add(
      "d10",
      {
        eventAt: ago(HOUR + 10 * 60_000 * 60),
        sources: { occurred_at: "system_record", event_at: "written_after" },
      },
      "t",
    );
    expect((await h.overview()).delay).toBeNull();
    await h.add(
      "d11",
      {
        eventAt: ago(HOUR + 11 * 60_000 * 60),
        sources: { occurred_at: "system_record", event_at: "derived" },
      },
      "t",
    );
    expect((await h.overview()).delay).toEqual({ medianMinutes: 330, samples: 10 });
  });

  it("hides title and text of items whose text was withheld", async () => {
    const h = await setup();
    await h.add("secret", { textWithheld: true, titleRef: null, textRef: null }, null);
    const [item] = (await h.overview()).items;
    expect(item).toMatchObject({ withheld: true, title: null, text: null });
    expect(
      await h.command("muse.item.rate", {
        kind: "proactive",
        naturalKey: "secret",
        timingOk: false,
        contentOk: true,
      }),
    ).toMatchObject({ replayed: false });
  });

  it("refuses half ratings, ratings for items that do not exist, and ratings from another owner", async () => {
    const h = await setup();
    await h.add("a");
    await expect(
      h.command("muse.item.rate", {
        kind: "proactive",
        naturalKey: "a",
        timingOk: true,
        contentOk: null,
      }),
    ).rejects.toThrow("MUSE_RATING_INCOMPLETE");
    await expect(
      h.command("muse.item.rate", {
        kind: "proactive",
        naturalKey: "missing",
        timingOk: true,
        contentOk: true,
      }),
    ).rejects.toThrow("MUSE_ITEM_NOT_FOUND");
    await expect(
      h.command(
        "muse.item.rate",
        { kind: "proactive", naturalKey: "a", timingOk: true, contentOk: true },
        createOwnerId("someone-else"),
      ),
    ).rejects.toThrow("MUSE_OWNER_REQUIRED");
    expect((await h.overview()).pending).toBe(1);
  });

  it("clears an earlier rating, pauses the intake, and clears all received data", async () => {
    const h = await setup();
    await h.add("a");
    await h.command("muse.item.rate", {
      kind: "proactive",
      naturalKey: "a",
      timingOk: true,
      contentOk: true,
    });
    expect((await h.overview()).pending).toBe(0);
    await h.command("muse.item.rate", {
      kind: "proactive",
      naturalKey: "a",
      timingOk: null,
      contentOk: null,
    });
    expect((await h.overview()).pending).toBe(1);
    await h.command("muse.intake.set", { paused: true });
    expect((await h.overview()).channel.state).toBe("paused");
    await h.command("muse.data.clear", {});
    const cleared = await h.overview();
    expect(cleared).toMatchObject({ receivedWeek: 0, pending: 0, items: [] });
    expect(cleared.channel.state).toBe("paused");
  });

  it("reports a never-used channel without any numbers to show", async () => {
    const h = await setup();
    expect(await h.overview()).toMatchObject({
      channel: { state: "never", lastBatchAt: null },
      receivedWeek: 0,
      suppressedWeek: 0,
      pending: 0,
      items: [],
    });
  });
});
