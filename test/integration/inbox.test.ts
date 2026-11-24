import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentId,
  createAuthorityLeaseId,
  createDeploymentId,
  createOwnerId,
} from "@himawari-agent/domain";
import {
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { createReferenceAdapterSet } from "@himawari-agent/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ProductionInbox } from "../../apps/agent-service/src/production-inbox.ts";
import { productionInbox } from "../../apps/agent-service/src/production-inbox-composition.ts";
import {
  INBOX_SETTING_TEXT,
  ProductionInboxControl,
  ProductionInboxSettings,
} from "../../apps/agent-service/src/production-inbox-settings.ts";
import {
  type InboxDelivery,
  type InboxDeliveryResult,
  InboxLoop,
  ProductionInboxWorker,
} from "../../apps/agent-service/src/production-inbox-worker.ts";
import { copyMigratedDatabase } from "../fixtures/sqlite-migrated-template.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-inbox");
const AGENT_ID = createAgentId("agent-inbox");
const DEPLOYMENT_ID = createDeploymentId("deployment-inbox");
const START = "2026-11-24T00:00:00.000Z";
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };

interface Delivered {
  readonly threadId: string | null;
  readonly fromOwner: boolean;
  readonly refs: readonly string[];
  readonly summaries: readonly string[];
  readonly external: readonly boolean[];
}

describe("inbox", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-inbox-"));
    directories.push(stateRoot);
    await mkdir(path.join(stateRoot, "data"));
    const file = path.join(stateRoot, "data", "product.sqlite");
    await copyMigratedDatabase(file);
    const database = openQualifiedDatabase(file);
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database
      .prepare(
        `INSERT INTO deployments
        (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token)
        VALUES (?, ?, ?, 0, 'active', 1, 1)`,
      )
      .run(DEPLOYMENT_ID, OWNER_ID, AGENT_ID);
    database
      .prepare(
        `INSERT INTO authority_leases
        (id, owner_id, agent_id, deployment_id, holder_id, authority_epoch, fencing_token,
          acquired_at, expires_at)
        VALUES (?, ?, ?, ?, 'holder-inbox', 1, 1, ?, '2026-11-25T00:00:00.000Z')`,
      )
      .run(createAuthorityLeaseId("lease-inbox"), OWNER_ID, AGENT_ID, DEPLOYMENT_ID, START);
    for (const thread of ["thread-a", "thread-b"])
      database
        .prepare(
          `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
           VALUES (?, ?, ?, 0, 'open', ?, ?)`,
        )
        .run(thread, OWNER_ID, AGENT_ID, START, START);
    database.close();
    const clock = { value: START };
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      databasePath: file,
      minimumFreeBytes: 0,
      now: () => clock.value,
    });
    closers.push(() => repository.close());
    const adapters = createReferenceAdapterSet();
    const payloads = repository.payloadStore(OWNER_ID, AGENT_ID);
    const store = repository.inbox();
    const register = (inbox: ProductionInbox) => {
      inbox.sources.register({
        kind: "email",
        describe: "新邮件",
        externalContent: true,
        fromOwner: false,
        priority: 5,
      });
      inbox.sources.register({
        kind: "owner_message",
        describe: "主人发来的消息",
        externalContent: false,
        fromOwner: true,
        priority: 1,
      });
      return inbox;
    };
    const make = (wrap?: (base: typeof store) => typeof store) =>
      register(
        new ProductionInbox({
          scope,
          store: wrap ? wrap(store) : store,
          payloads,
          protector: adapters.payloadProtector,
          clock: { now: () => clock.value },
        }),
      );
    const settings = new ProductionInboxSettings({
      scope,
      store,
      configuration: undefined,
      clock: { now: () => clock.value },
      enabled: true,
    });
    const worker = (
      inbox: ProductionInbox,
      delivery: InboxDelivery,
      extra: Partial<ConstructorParameters<typeof ProductionInboxWorker>[0]> = {},
    ) =>
      new ProductionInboxWorker({
        scope,
        inbox,
        store,
        payloads,
        protector: adapters.payloadProtector,
        clock: { now: () => clock.value },
        delivery,
        runTimeoutMs: 60_000,
        overrides: () => settings.overrides(),
        ...extra,
      });
    const rows = () => {
      const handle = openQualifiedDatabase(file);
      try {
        return handle
          .prepare(
            `SELECT source_ref AS ref, status, outcome, attempts, run_id AS runId,
               reason_code AS reasonCode
             FROM inbox_events ORDER BY created_at, rowid`,
          )
          .all() as {
          ref: string;
          status: string;
          outcome: string | null;
          attempts: number;
          runId: string | null;
          reasonCode: string | null;
        }[];
      } finally {
        handle.close();
      }
    };
    const tables = () => {
      const handle = openQualifiedDatabase(file);
      try {
        return (
          handle
            .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
            .all() as {
            name: string;
          }[]
        ).map((row) => row.name);
      } finally {
        handle.close();
      }
    };
    return {
      clock,
      store,
      payloads,
      protector: adapters.payloadProtector,
      register,
      make,
      settings,
      worker,
      rows,
      tables,
    };
  }

  const mail = (ref: string, extra: Record<string, unknown> = {}) => ({
    sourceKind: "email",
    sourceRef: ref,
    sourceVersion: "1",
    summary: `邮件 ${ref} 的简要`,
    ...extra,
  });
  const said = (ref: string) => ({
    sourceKind: "owner_message",
    sourceRef: ref,
    sourceVersion: "1",
    summary: `主人说 ${ref}`,
  });

  function recorder(answer: (call: number) => InboxDeliveryResult = () => handled) {
    const calls: Delivered[] = [];
    const delivery: InboxDelivery = {
      deliver: async ({ threadId, fromOwner, events }) => {
        calls.push({
          threadId,
          fromOwner,
          refs: events.map((event) => event.entry.sourceRef),
          summaries: events.map((event) => event.summary),
          external: events.map((event) => event.entry.externalContent),
        });
        return answer(calls.length);
      },
    };
    return { calls, delivery };
  }
  const handled: InboxDeliveryResult = {
    status: "handled",
    outcome: "silent",
    reasonCode: "nothing_new",
    runId: "run-1",
  };

  it("renames the old table, drops the daily counter and its declined table", async () => {
    const { tables } = await fixture();
    const names = tables();
    expect(names).toEqual(
      expect.arrayContaining(["inbox_events", "inbox_events_queue", "inbox_settings"]),
    );
    for (const gone of [
      "think_inbox",
      "think_inbox_declined",
      "think_inbox_queue",
      "think_inbox_day",
      "think_settings",
    ])
      expect(names).not.toContain(gone);
  });

  it("keeps one row when the same email is read twice and never turns anything away", async () => {
    const { make, rows } = await fixture();
    const inbox = make();
    const first = await inbox.submit(mail("mail-1"));
    const again = await inbox.submit(mail("mail-1"));
    expect(first).toMatchObject({ accepted: true, duplicate: false });
    expect(again).toMatchObject({ accepted: true, duplicate: true });
    for (let index = 0; index < 120; index += 1) await inbox.submit(mail(`bulk-${index}`));
    expect(rows()).toHaveLength(121);
    expect(rows().every((row) => row.status === "queued")).toBe(true);
  });

  it("refuses an owner source marked as outside content and unregistered sources", async () => {
    const { make } = await fixture();
    const inbox = make();
    expect(await inbox.submit({ ...said("m"), externalContent: true })).toEqual({
      accepted: false,
      reason: "INBOX_OWNER_SOURCE_CANNOT_BE_OUTSIDE",
    });
    expect(await inbox.submit({ ...mail("m"), sourceKind: "calendar" })).toEqual({
      accepted: false,
      reason: "INBOX_SOURCE_UNREGISTERED",
    });
    expect(() =>
      inbox.sources.register({
        kind: "weird",
        describe: "x",
        externalContent: true,
        fromOwner: true,
        priority: 1,
      }),
    ).toThrow("cannot be both");
  });

  it("takes 20 of 25 waiting emails in one run and the other 5 in the next, none lost or repeated", async () => {
    const { make, worker, clock, rows } = await fixture();
    const inbox = make();
    for (let index = 0; index < 25; index += 1) {
      clock.value = new Date(Date.parse(START) + index * 1000).toISOString();
      await inbox.submit(mail(`m-${String(index).padStart(2, "0")}`));
    }
    const { calls, delivery } = recorder();
    const work = worker(inbox, delivery);
    const first = await work.claim();
    expect(first?.entries).toHaveLength(20);
    await work.handle(first as never);
    const second = await work.claim();
    expect(second?.entries).toHaveLength(5);
    await work.handle(second as never);
    expect(await work.claim()).toBeUndefined();
    const delivered = calls.flatMap((call) => call.refs);
    expect(delivered).toEqual(rows().map((row) => row.ref));
    expect(new Set(delivered).size).toBe(25);
    expect(calls[0]?.summaries[0]).toBe("邮件 m-00 的简要");
    expect(calls[0]?.external.every(Boolean)).toBe(true);
    expect(rows().every((row) => row.status === "done" && row.runId === "run-1")).toBe(true);
  });

  it("follows a changed events-per-run setting on the next claim", async () => {
    const { make, worker, settings } = await fixture();
    const inbox = make();
    for (let index = 0; index < 4; index += 1) await inbox.submit(mail(`m-${index}`));
    const current = await settings.read();
    await settings.change(current.revision, "eventsPerRun", 3);
    const claim = await worker(inbox, recorder().delivery).claim();
    expect(claim?.entries).toHaveLength(3);
  });

  it("never mixes the owner's messages with outside events, and takes the owner's first", async () => {
    const { make, worker, clock } = await fixture();
    const inbox = make();
    await inbox.submit(mail("mail-early"));
    clock.value = "2026-11-24T00:00:05.000Z";
    await inbox.submit(said("hello"));
    await inbox.submit(said("again"));
    const { calls, delivery } = recorder();
    const work = worker(inbox, delivery);
    await work.handle((await work.claim()) as never);
    await work.handle((await work.claim()) as never);
    expect(calls).toEqual([
      expect.objectContaining({ fromOwner: true, refs: ["hello", "again"] }),
      expect.objectContaining({ fromOwner: false, refs: ["mail-early"] }),
    ]);
  });

  it("runs one batch per conversation at a time but lets another conversation go ahead", async () => {
    const { make, worker } = await fixture();
    const inbox = make();
    await inbox.submit(mail("a-1", { threadId: "thread-a" }));
    await inbox.submit(mail("b-1", { threadId: "thread-b" }));
    const work = worker(inbox, recorder().delivery);
    const first = await work.claim();
    await inbox.submit(mail("a-2", { threadId: "thread-a" }));
    const second = await work.claim();
    expect(first?.threadId).toBe("thread-a");
    expect(second?.threadId).toBe("thread-b");
    expect(await work.claim()).toBeUndefined();
    await work.handle(first as never);
    const third = await work.claim();
    expect(third?.entries.map((entry) => entry.sourceRef)).toEqual(["a-2"]);
  });

  it("puts events back on a failed run, gives up after the attempts run out, and yields without spending one", async () => {
    const { make, worker, rows } = await fixture();
    const inbox = make();
    await inbox.submit(mail("a"));
    const retry = recorder(() => ({ status: "retry", reasonCode: "run_failed" }));
    const failing = worker(inbox, retry.delivery, { maxAttempts: 2 });
    await failing.handle((await failing.claim()) as never);
    expect(rows()[0]).toMatchObject({ status: "queued", attempts: 1 });
    await failing.handle((await failing.claim()) as never);
    expect(rows()[0]).toMatchObject({ status: "failed", attempts: 2 });

    await inbox.submit(mail("b"));
    const yielding = worker(inbox, recorder(() => ({ status: "yield" })).delivery);
    await yielding.handle((await yielding.claim()) as never);
    await yielding.handle((await yielding.claim()) as never);
    expect(rows()[1]).toMatchObject({ ref: "b", status: "queued", attempts: 0 });
  });

  it("treats a throwing delivery as a failed run and an unregistered source as failed", async () => {
    const { make, worker, rows, store, payloads, protector, clock } = await fixture();
    const inbox = make();
    await inbox.submit(mail("a"));
    const work = worker(
      inbox,
      {
        deliver: async () => {
          throw new Error("model down");
        },
      },
      { maxAttempts: 3 },
    );
    expect(await work.handle((await work.claim()) as never)).toMatchObject({ result: "retry" });
    expect(rows()[0]).toMatchObject({ status: "queued", attempts: 1 });
    const ownerOnly = new ProductionInbox({
      scope,
      store,
      payloads,
      protector,
      clock: { now: () => clock.value },
    });
    const { calls, delivery } = recorder();
    const lonely = worker(ownerOnly, delivery);
    expect(await lonely.handle((await lonely.claim()) as never)).toMatchObject({
      result: "failed",
    });
    expect(calls).toHaveLength(0);
    expect(rows()[0]).toMatchObject({ status: "failed" });
  });

  it("does not take back a run that is still inside its time limit, even with a shorter stalled setting", async () => {
    const { register, store, payloads, protector, worker, settings, clock, rows } = await fixture();
    const inbox = register(
      new ProductionInbox({
        scope,
        store,
        payloads,
        protector,
        clock: { now: () => clock.value },
        overrides: () => settings.overrides(),
      }),
    );
    await settings.change(0, "stalledAfterMinutes", 1);
    await inbox.submit(mail("slow", { threadId: "thread-a" }));
    const work = worker(inbox, recorder().delivery, { runTimeoutMs: 10 * 60_000 });
    expect((await work.claim())?.entries.map((entry) => entry.sourceRef)).toEqual(["slow"]);
    clock.value = "2026-11-24T00:05:00.000Z";
    expect(await work.claim()).toBeUndefined();
    expect(rows()[0]).toMatchObject({ status: "running", attempts: 1 });
    clock.value = "2026-11-24T00:11:00.000Z";
    expect((await work.claim())?.entries.map((entry) => entry.sourceRef)).toEqual(["slow"]);
    expect(rows()[0]).toMatchObject({ status: "running", attempts: 2 });
  });

  it("records a handled run whose result the store refuses as done, and never delivers it again", async () => {
    const { make, worker, rows } = await fixture();
    const inbox = make();
    await inbox.submit(mail("odd"));
    const { calls, delivery } = recorder(() => ({
      status: "handled",
      outcome: "Not A Code",
      reasonCode: "",
      runId: "",
    }));
    const work = worker(inbox, delivery);
    expect(await work.handle((await work.claim()) as never)).toMatchObject({
      status: "done",
      result: "handled",
    });
    expect(rows()[0]).toMatchObject({
      status: "done",
      outcome: null,
      reasonCode: "result_invalid",
      runId: null,
    });
    expect(await work.claim()).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("keeps the delivered outcome when recording it fails once, and never delivers it again", async () => {
    const { make, worker, rows, store } = await fixture();
    const inbox = make();
    await inbox.submit(mail("busy"));
    const handled = { outcome: "replied", reasonCode: "answered", runId: "run-busy" };
    const { calls, delivery } = recorder(() => ({ status: "handled", ...handled }));
    let locked = true;
    const finish: typeof store.finish = async (input) => {
      if (!locked) return store.finish(input);
      locked = false;
      throw new Error("database is locked");
    };
    const failures: unknown[] = [];
    const onFailure = (_entryId: string, error: unknown) => failures.push(error);
    const work = worker(inbox, delivery, { store: { ...store, finish }, onFailure });
    expect(await work.handle((await work.claim()) as never)).toMatchObject({ result: "handled" });
    expect(rows()[0]).toMatchObject({ status: "done", ...handled });
    expect(failures).toHaveLength(1);
    expect(await work.claim()).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("wakes the worker as soon as something is written, without waiting for the idle check", async () => {
    const { store, payloads, protector, register, settings, clock } = await fixture();
    let resolveDelivered: (refs: readonly string[]) => void = () => undefined;
    const delivered = new Promise<readonly string[]>((resolve) => {
      resolveDelivered = resolve;
    });
    const wired = productionInbox({
      configuration: {
        ownerId: OWNER_ID,
        agentId: AGENT_ID,
        runPolicy: { inbox: { idleSeconds: 86_400 } },
      } as never,
      repository: { inbox: () => store },
      payloads,
      protector,
      clock: () => clock.value,
      settings,
      delivery: {
        deliver: async ({ events }) => {
          resolveDelivered(events.map((event) => event.entry.sourceRef));
          return handled;
        },
      },
    });
    register(wired.inbox);
    wired.loop?.start();
    try {
      await wired.inbox.submit(mail("woken"));
      expect(await delivered).toEqual(["woken"]);
    } finally {
      await wired.loop?.stop();
    }
  });

  it("waits for the next check instead of taking a yielded batch straight back", async () => {
    let held = false;
    let claims = 0;
    let handles = 0;
    const batch = { threadId: null, fromOwner: false, entries: [] };
    const loop = new InboxLoop({
      worker: {
        claim: async () => {
          claims += 1;
          if (held) return undefined;
          held = true;
          return batch;
        },
        handle: async () => {
          handles += 1;
          held = handles >= 5;
          return { status: "done", entryIds: [], result: "yield" };
        },
      },
      intervalMs: 86_400_000,
      onFailure: () => undefined,
    });
    loop.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await loop.stop();
    expect(handles).toBeLessThanOrEqual(2);
    expect(claims).toBeLessThanOrEqual(2);
  });

  it("keeps the loop alive when a claim throws and reports it", async () => {
    const failures: unknown[] = [];
    let calls = 0;
    let resolveSecond: () => void = () => undefined;
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const loop = new InboxLoop({
      worker: {
        claim: async () => {
          calls += 1;
          if (calls === 1) throw new Error("boom");
          resolveSecond();
          return undefined;
        },
        handle: async () => ({ status: "done", entryIds: [], result: "handled" }),
      },
      intervalMs: 1,
      onFailure: (error) => {
        failures.push(error);
        throw new Error("diagnostic output closed");
      },
    });
    loop.start();
    await second;
    await loop.stop();
    expect(failures).toHaveLength(1);
  });

  it("refuses the removed queue, daily and expiry settings and lists only the inbox settings", async () => {
    const { settings } = await fixture();
    const view = await settings.read();
    expect(view.items.map((item) => item.key)).toEqual([
      "eventsPerRun",
      "stalledAfterMinutes",
      "maxAttempts",
      "summaryCharacters",
      "idleSeconds",
      "runTimeoutMinutes",
    ]);
    expect(Object.keys(INBOX_SETTING_TEXT)).toEqual(view.items.map((item) => item.key));
    expect(view.items[0]).toMatchObject({ value: 20, defaultValue: 20, minimum: 1 });
    for (const removed of ["queueLimit", "dailyLimit", "expiresAfterHours", "yesAtLeastPermille"])
      await expect(settings.change(view.revision, removed, 5)).rejects.toThrow(
        "INBOX_SETTING_UNKNOWN",
      );
  });

  it("answers the settings query the iPhone already sends", async () => {
    const { settings } = await fixture();
    const control = new ProductionInboxControl({
      settings,
      scope,
      clock: { now: () => START },
    });
    const snapshot = await control.query({
      schemaVersion: "gateway.v2",
      kind: "query",
      type: "think.settings.read",
      messageId: "message-read",
      correlationId: "correlation-read",
      causationId: null,
      dataClassification: "private",
      risk: "low",
      authorizationRef: null,
      scope,
      authority: { deploymentId: DEPLOYMENT_ID, authorityEpoch: 1, fencingToken: 1 },
      actor: { actorType: "owner", actorId: OWNER_ID },
      payload: {},
    } as never);
    expect(snapshot.type).toBe("think.settings.snapshot");
    expect((snapshot.payload as { enabled: boolean }).enabled).toBe(true);
  });
});
