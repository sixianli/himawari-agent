import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProactiveSeal } from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
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
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  MUSE_INTAKE_PATH,
  ProductionMuseIntake,
  registerMuseIntakeRoute,
} from "../../apps/agent-service/src/production-muse-intake.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-muse-http");
const AGENT_ID = createAgentId("agent-muse-http");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const SINCE = "1970-01-01T00:00:00.000Z";
const NOW = "2026-11-01T09:00:00.000Z";
const SECRET = "muse-intake-test-secret-0123456789abcdef";
const AUTH = { authorization: `Bearer ${SECRET}`, "content-type": "application/json" };

function field(value: unknown, source = "system_record") {
  return { value, source };
}

function proactive(id: string, overrides: Record<string, unknown> = {}) {
  return {
    type: "muse_proactive_item",
    submission_id: field(id),
    edition_id: field("phase-1"),
    item_title: field("GitHub 存储已满", "chat_record"),
    queue_state: field("delivered"),
    reason_enum: field("changed"),
    decision: field("send"),
    priority: field("regular"),
    prepared_at_utc: field("2026-11-01T08:19:00.123Z"),
    handoff_accepted_at_utc: field("2026-11-01T08:19:31.000Z"),
    outcome_recorded_at_utc: field("2026-11-01T08:20:08.200Z"),
    event_received_at_utc: field("2026-11-01T03:20:42.000Z"),
    options_offered: field(["不用管"], "chat_record"),
    delivered_text: field("GitHub 存储 100%，今天处理。", "chat_record"),
    ...overrides,
  };
}

function batch(seq: number, items: readonly unknown[] = [], extra: Record<string, unknown> = {}) {
  return {
    sender_id: "muse",
    batch_seq: seq,
    sent_at_utc: "2026-11-01T09:00:00.000Z",
    cursor: "c1",
    items,
    ...extra,
  };
}

describe("Muse intake over HTTP", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function setup(register = true) {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-muse-http-"));
    directories.push(stateRoot);
    const databasePath = path.join(stateRoot, "product.sqlite");
    const database = openQualifiedDatabase(databasePath);
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
    const intake = new ProductionMuseIntake({ scope, store, seal, ids, clock, secret: SECRET });
    const app = Fastify({ logger: false });
    if (register) registerMuseIntakeRoute(app, intake);
    closers.push(() => app.close());
    await app.ready();
    const post = (payload: unknown, headers: Record<string, string> = AUTH) =>
      app.inject({
        method: "POST",
        url: MUSE_INTAKE_PATH,
        headers,
        payload: typeof payload === "string" ? payload : JSON.stringify(payload),
      });
    const counts = () => {
      const handle = openQualifiedDatabase(databasePath);
      try {
        const count = (table: string) =>
          handle.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;
        return {
          batches: count("muse_intake_batches"),
          items: count("muse_intake_items"),
          payloads: count("payloads"),
          dropped: handle
            .prepare("SELECT coalesce(sum(dropped_field_count), 0) FROM muse_intake_batches")
            .pluck()
            .get() as number,
        };
      } finally {
        handle.close();
      }
    };
    return { app, post, store, seal, clock, counts, repository };
  }

  it("stores a valid batch, seals the text, and answers a resent batch as a replay", async () => {
    const { post, store, seal, counts } = await setup();
    const response = await post(batch(1, [proactive("sub-1"), proactive("sub-2")]));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accepted: 2,
      duplicate: 0,
      conflict: 0,
      rejected: 0,
      expected_next_seq: 2,
    });
    const items = await store.listItems({ ...scope, since: SINCE, limit: 10 });
    expect(items).toHaveLength(2);
    const [first] = items;
    expect(first?.occurredAt).toBe("2026-11-01T08:20:08.200Z");
    expect(first?.eventAt).toBe("2026-11-01T03:20:42.000Z");
    expect(first?.sources["occurred_at"]).toBe("system_record");
    expect(first?.sources["text"]).toBe("chat_record");
    expect(first?.textRef).not.toBeNull();
    expect(await seal.open({ ...scope, ref: first?.textRef as string })).toBe(
      "GitHub 存储 100%，今天处理。",
    );
    expect(counts()).toMatchObject({ batches: 1, items: 2 });

    const again = await post(batch(1, [proactive("sub-1"), proactive("sub-2")]));
    expect(again.json()).toEqual({ replayed: true, expected_next_seq: 2 });
    expect(counts().payloads).toBe(4);
  });

  it("treats an empty batch as a heartbeat", async () => {
    const { post, store, clock } = await setup();
    expect((await post(batch(1))).statusCode).toBe(200);
    clock.advance(60_000);
    const status = await store.channelStatus({ ...scope, now: clock.now() });
    expect(status).toMatchObject({ state: "ok", lastSeq: 1 });
  });

  it("stores a scheduled run under its run id and keeps the job title as the title", async () => {
    const { post, store } = await setup();
    const run = {
      type: "muse_scheduled_run",
      run_id: field("run-1"),
      job_id: field("nightly-weather-umbrella"),
      trigger_reason: field("scheduled"),
      scheduled_for_utc: field("2026-10-31T13:00:00Z"),
      started_at_utc: field("2026-10-31T12:55:19Z"),
      finished_at_utc: field("2026-10-31T12:55:58Z"),
      status: field("succeeded"),
      delivered_text: field("明天出门提醒", "chat_record"),
    };
    expect((await post(batch(1, [run]))).json()).toMatchObject({ accepted: 1 });
    const [item] = await store.listItems({ ...scope, since: SINCE, limit: 10 });
    expect(item).toMatchObject({
      kind: "scheduled",
      state: "succeeded",
      occurredAt: "2026-10-31T12:55:58.000Z",
      scheduledFor: "2026-10-31T13:00:00.000Z",
    });
  });

  it("refuses requests without the secret, with a wrong secret, or with a malformed header, and writes nothing", async () => {
    const { post, counts } = await setup();
    const body = batch(1, [proactive("sub-1")]);
    expect((await post(body, { "content-type": "application/json" })).statusCode).toBe(401);
    expect(
      (await post(body, { authorization: "Bearer wrong", "content-type": "application/json" }))
        .statusCode,
    ).toBe(401);
    expect(
      (await post(body, { authorization: SECRET, "content-type": "application/json" })).statusCode,
    ).toBe(401);
    expect(counts()).toMatchObject({ batches: 0, items: 0, payloads: 0 });
  });

  it("rejects unknown queue states and unknown source labels per item and counts them", async () => {
    const { post, counts } = await setup();
    const response = await post(
      batch(1, [
        proactive("bad-state", { queue_state: field("exploded") }),
        proactive("bad-source", { item_title: field("x", "made_up_label") }),
        proactive("no-time", { outcome_recorded_at_utc: field("yesterday") }),
        proactive("good"),
        { type: "something_else" },
      ]),
    );
    expect(response.json()).toMatchObject({ accepted: 1, rejected: 4 });
    expect(counts().items).toBe(1);
  });

  it("drops task bodies and personal fields without storing them", async () => {
    const { post, counts } = await setup();
    const response = await post(
      batch(
        1,
        [
          proactive("sub-1", {
            layer_1_trigger_definition: field("每天 22:00 查天气，鼻炎"),
            layer_5_context_inputs: field({ health_facts_used: ["鼻炎"] }),
          }),
        ],
        { notes: "x" },
      ),
    );
    expect(response.json()).toMatchObject({ accepted: 1 });
    expect(counts()).toMatchObject({ dropped: 3, payloads: 2 });
  });

  it("keeps the first copy and counts a conflict when the same id comes back with other text", async () => {
    const { post, store } = await setup();
    await post(batch(1, [proactive("sub-1")]));
    const response = await post(
      batch(2, [proactive("sub-1", { delivered_text: field("完全不同的内容", "chat_record") })]),
    );
    expect(response.json()).toMatchObject({ accepted: 0, duplicate: 0, conflict: 1 });
    const [item] = await store.listItems({ ...scope, since: SINCE, limit: 10 });
    expect(item).toBeDefined();
  });

  it("does not store text that contains a machine secret and marks the item as withheld", async () => {
    const { post, store, counts } = await setup();
    const response = await post(
      batch(1, [
        proactive("sub-1", {
          delivered_text: field(
            `key: -----BEGIN ${"RSA PRIVATE"} KEY-----\nabc\n-----END ${"RSA PRIVATE"} KEY-----`,
            "chat_record",
          ),
        }),
      ]),
    );
    expect(response.json()).toMatchObject({ accepted: 1 });
    const [item] = await store.listItems({ ...scope, since: SINCE, limit: 10 });
    expect(item).toMatchObject({ textRef: null, titleRef: null, textWithheld: true });
    expect(counts().payloads).toBe(0);
  });

  it("answers 413 for an oversized body, 415 for a wrong content type, 400 for invalid JSON", async () => {
    const { post, counts } = await setup();
    const big = batch(1, [proactive("sub-1", { delivered_text: field("x".repeat(300_000)) })]);
    expect((await post(big)).statusCode).toBe(413);
    expect((await post("not json")).statusCode).toBe(400);
    expect(
      (
        await post("{}", {
          authorization: `Bearer ${SECRET}`,
          "content-type": "text/plain",
        })
      ).statusCode,
    ).toBe(415);
    expect((await post(batch(0))).statusCode).toBe(400);
    expect((await post({ ...batch(1), sender_id: "other" })).statusCode).toBe(400);
    expect(counts().batches).toBe(0);
  });

  it("limits authorized requests to 30 a minute and wrong-secret attempts to 60 a minute, separately", async () => {
    const { post, clock } = await setup();
    for (let seq = 1; seq <= 30; seq += 1) expect((await post(batch(seq))).statusCode).toBe(200);
    expect((await post(batch(31))).statusCode).toBe(429);
    for (let attempt = 0; attempt < 60; attempt += 1)
      expect((await post(batch(1), { authorization: "Bearer nope" })).statusCode).toBe(401);
    expect((await post(batch(1), { authorization: "Bearer nope" })).statusCode).toBe(429);
    clock.advance(61_000);
    expect((await post(batch(31))).statusCode).toBe(200);
  });

  it("answers 423 while paused and does not store, then accepts again after resuming", async () => {
    const { post, store, counts } = await setup();
    await store.setPaused({ ...scope, paused: true });
    const paused = await post(batch(1, [proactive("sub-1")]));
    expect(paused.statusCode).toBe(423);
    expect(counts()).toMatchObject({ batches: 0, items: 0, payloads: 0 });
    await store.setPaused({ ...scope, paused: false });
    expect((await post(batch(1, [proactive("sub-1")]))).statusCode).toBe(200);
  });

  it("has no route at all when the feature is not registered", async () => {
    const { post } = await setup(false);
    expect((await post(batch(1))).statusCode).toBe(404);
  });
});
