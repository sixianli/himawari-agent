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
import {
  localDay,
  ProductionThinkInbox,
} from "../../apps/agent-service/src/production-think-inbox.ts";
import { copyMigratedDatabase } from "../fixtures/sqlite-migrated-template.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-think-inbox");
const AGENT_ID = createAgentId("agent-think-inbox");
const DEPLOYMENT_ID = createDeploymentId("deployment-think-inbox");
const START = "2026-11-14T00:00:00.000Z";

describe("think inbox", () => {
  useSqliteContractExecution("direct");
  const directories: string[] = [];
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-think-inbox-"));
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
        VALUES (?, ?, ?, ?, 'holder-think-inbox', 1, 1, ?, '2026-11-15T00:00:00.000Z')`,
      )
      .run(createAuthorityLeaseId("lease-think-inbox"), OWNER_ID, AGENT_ID, DEPLOYMENT_ID, START);
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
    const make = (
      limits?: ConstructorParameters<typeof ProductionThinkInbox>[0]["limits"],
      wrap?: (
        store: ReturnType<typeof repository.thinkInbox>,
      ) => ReturnType<typeof repository.thinkInbox>,
    ) => {
      const inbox = new ProductionThinkInbox({
        scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
        store: wrap ? wrap(repository.thinkInbox()) : repository.thinkInbox(),
        payloads,
        protector: adapters.payloadProtector,
        clock: { now: () => clock.value },
        timeZone: "Asia/Tokyo",
        ...(limits ? { limits } : {}),
      });
      inbox.sources.register({
        kind: "email",
        describe: "新邮件",
        externalContent: true,
      });
      inbox.sources.register({
        kind: "memory",
        describe: "新记忆",
        externalContent: false,
      });
      return inbox;
    };
    const thinkPayloads = () => {
      const handle = openQualifiedDatabase(file);
      try {
        return (
          handle
            .prepare("SELECT COUNT(*) AS count FROM payloads WHERE ref LIKE 'think-summary:%'")
            .get() as { count: number }
        ).count;
      } finally {
        handle.close();
      }
    };
    return {
      repository,
      payloads,
      clock,
      make,
      thinkPayloads,
      store: repository.thinkInbox(),
    };
  }

  const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
  const mail = (ref: string, version = "1") => ({
    sourceKind: "email",
    sourceRef: ref,
    sourceVersion: version,
    summary: `邮件 ${ref} 的摘要`,
  });

  it("accepts a registered source, keeps the summary protected and marks outside content", async () => {
    const { make, store, payloads } = await fixture();
    const inbox = make();
    const result = await inbox.submit(mail("mail-1"));
    expect(result).toMatchObject({ accepted: true, duplicate: false });
    const claimed = await store.claimNext({ ...scope, now: START });
    expect(claimed).toMatchObject({
      sourceKind: "email",
      externalContent: true,
      status: "thinking",
      attempts: 1,
    });
    expect(await payloads.get(claimed?.summaryRef as never)).toBeDefined();
    const memory = await inbox.submit({
      sourceKind: "memory",
      sourceRef: "memory-1",
      sourceVersion: "1",
      summary: "新记忆",
    });
    const next = await store.claimNext({ ...scope, now: START });
    expect(memory.accepted && next?.externalContent).toBe(false);
  });

  it("turns away a source nobody registered and an empty summary", async () => {
    const { make, store } = await fixture();
    const inbox = make();
    expect(await inbox.submit({ ...mail("m"), sourceKind: "calendar" })).toEqual({
      accepted: false,
      reason: "THINK_SOURCE_UNREGISTERED",
    });
    expect(await inbox.submit({ ...mail("m"), summary: "   " })).toEqual({
      accepted: false,
      reason: "THINK_SUMMARY_EMPTY",
    });
    expect((await store.usage({ ...scope, day: "2026-11-14" })).acceptedToday).toBe(0);
  });

  it("does not queue the same source version twice but accepts a new version", async () => {
    const { make, store } = await fixture();
    const inbox = make();
    await inbox.submit(mail("mail-1"));
    expect(await inbox.submit(mail("mail-1"))).toMatchObject({
      accepted: true,
      duplicate: true,
    });
    expect(await inbox.submit(mail("mail-1", "2"))).toMatchObject({
      accepted: true,
      duplicate: false,
    });
    expect((await store.usage({ ...scope, day: "2026-11-14" })).queued).toBe(2);
  });

  it("takes two identical submits at once without failing or writing a second summary", async () => {
    const { make, thinkPayloads } = await fixture();
    const inbox = make();
    const [first, second] = await Promise.all([inbox.submit(mail("a")), inbox.submit(mail("a"))]);
    expect(first.accepted && second.accepted).toBe(true);
    expect([first, second].filter((r) => r.accepted && r.duplicate)).toHaveLength(1);
    expect(thinkPayloads()).toBe(1);
  });

  it("leaves no summary behind when the enqueue step throws", async () => {
    const { make, thinkPayloads } = await fixture();
    const inbox = make(undefined, (real) => {
      return {
        ...real,
        enqueue: async () => {
          throw new Error("disk full");
        },
      };
    });
    await expect(inbox.submit(mail("a"))).rejects.toThrow("disk full");
    expect(thinkPayloads()).toBe(0);
  });

  it("leaves no summary behind when a settled entry is submitted again", async () => {
    const { make, store, thinkPayloads } = await fixture();
    const inbox = make();
    await inbox.submit(mail("a"));
    const claimed = await store.claimNext({ ...scope, now: START });
    await store.finish({
      ...scope,
      id: claimed?.id as string,
      to: "skipped",
      reasonCode: "x",
      now: START,
    });
    await inbox.maintain();
    expect(thinkPayloads()).toBe(0);
    expect(await inbox.submit(mail("a"))).toMatchObject({
      accepted: true,
      duplicate: true,
    });
    expect(thinkPayloads()).toBe(0);
  });

  it("drops the summary it just wrote when the queue is full but keeps queued ones", async () => {
    const { make, thinkPayloads } = await fixture();
    const inbox = make({ queueLimit: 1, dailyLimit: 10 });
    await inbox.submit(mail("a"));
    expect(await inbox.submit(mail("b"))).toEqual({
      accepted: false,
      reason: "THINK_QUEUE_FULL",
    });
    expect(thinkPayloads()).toBe(1);
  });

  it("rejects input of the wrong type and counts thinking entries in usage", async () => {
    const { make, store } = await fixture();
    const inbox = make();
    expect(await inbox.submit({ ...mail("a"), externalContent: "true" } as never)).toEqual({
      accepted: false,
      reason: "THINK_INPUT_INVALID",
    });
    expect(await inbox.submit({ ...mail("a"), summary: 5 } as never)).toEqual({
      accepted: false,
      reason: "THINK_INPUT_INVALID",
    });
    await inbox.submit(mail("a"));
    await store.claimNext({ ...scope, now: START });
    expect(await inbox.usage()).toMatchObject({ queued: 0, thinking: 1 });
  });

  it("refuses when the queue is full and counts what was turned away", async () => {
    const { make } = await fixture();
    const inbox = make({ queueLimit: 2, dailyLimit: 10 });
    await inbox.submit(mail("a"));
    await inbox.submit(mail("b"));
    expect(await inbox.submit(mail("c"))).toEqual({
      accepted: false,
      reason: "THINK_QUEUE_FULL",
    });
    const usage = await inbox.usage();
    expect(usage).toMatchObject({
      queued: 2,
      acceptedToday: 2,
      declinedToday: { queue_full: 1 },
    });
  });

  it("stops at the daily limit even when the queue drains", async () => {
    const { make, store } = await fixture();
    const inbox = make({ queueLimit: 5, dailyLimit: 2 });
    await inbox.submit(mail("a"));
    const first = await store.claimNext({ ...scope, now: START });
    await store.finish({
      ...scope,
      id: first?.id as string,
      to: "skipped",
      reasonCode: "no",
      now: START,
    });
    await inbox.submit(mail("b"));
    expect(await inbox.submit(mail("c"))).toEqual({
      accepted: false,
      reason: "THINK_DAILY_LIMIT",
    });
    expect((await inbox.usage()).declinedToday).toEqual({ daily_limit: 1 });
  });

  it("counts the limit by the owner's local day", async () => {
    const { make, clock } = await fixture();
    const inbox = make({ queueLimit: 5, dailyLimit: 1 });
    clock.value = "2026-11-14T14:30:00.000Z";
    expect(localDay(clock.value, "Asia/Tokyo")).toBe("2026-11-14");
    await inbox.submit(mail("a"));
    expect((await inbox.submit(mail("b"))).accepted).toBe(false);
    clock.value = "2026-11-14T15:30:00.000Z";
    expect(localDay(clock.value, "Asia/Tokyo")).toBe("2026-11-15");
    expect((await inbox.submit(mail("b"))).accepted).toBe(true);
  });

  it("settles an entry once and never finishes one that is not being thought about", async () => {
    const { make, store } = await fixture();
    const inbox = make();
    await inbox.submit(mail("a"));
    const queued = await store.claimNext({ ...scope, now: START });
    const id = queued?.id as string;
    expect(
      await store.finish({
        ...scope,
        id,
        to: "proposed",
        reasonCode: "ok",
        now: START,
      }),
    ).toMatchObject({ status: "proposed" });
    expect(
      await store.finish({
        ...scope,
        id,
        to: "failed",
        reasonCode: "late",
        now: START,
      }),
    ).toBeUndefined();
    expect(await store.claimNext({ ...scope, now: START })).toBeUndefined();
  });

  it("recovers a stalled entry, fails it after the attempts run out, and expires old ones", async () => {
    const { make, store, clock, payloads } = await fixture();
    const inbox = make({
      maxAttempts: 2,
      stalledAfterMinutes: 10,
      expiresAfterHours: 1,
    });
    await inbox.submit(mail("a"));
    await inbox.submit(mail("old"));
    const taken = await store.claimNext({ ...scope, now: clock.value });
    clock.value = "2026-11-14T00:05:00.000Z";
    expect(await inbox.maintain()).toMatchObject({ recovered: 0 });
    clock.value = "2026-11-14T00:20:00.000Z";
    expect((await inbox.maintain()).recovered).toBe(1);
    const again = await store.claimNext({ ...scope, now: clock.value });
    expect(again?.id).toBe(taken?.id);
    expect(again?.attempts).toBe(2);
    clock.value = "2026-11-14T00:40:00.000Z";
    await inbox.maintain();
    expect((await inbox.usage()).byStatus).toMatchObject({ failed: 1 });
    clock.value = "2026-11-14T01:30:00.000Z";
    expect((await inbox.maintain()).expired).toBe(1);
    expect((await inbox.usage()).byStatus).toMatchObject({
      failed: 1,
      expired: 1,
    });
    expect(await payloads.get(again?.summaryRef as never)).toBeUndefined();
  });

  it("never reaches across owners", async () => {
    const { make, store } = await fixture();
    await make().submit(mail("a"));
    const other = { ownerId: createOwnerId("someone-else"), agentId: AGENT_ID };
    expect(await store.claimNext({ ...other, now: START })).toBeUndefined();
  });
});
