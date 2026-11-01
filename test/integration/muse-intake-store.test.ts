import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MuseIntakeItemWrite } from "@himawari-agent/application";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-muse");
const OTHER_OWNER_ID = createOwnerId("owner-other");
const AGENT_ID = createAgentId("agent-muse");
const OTHER_AGENT_ID = createAgentId("agent-other");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const SINCE = "1970-01-01T00:00:00.000Z";
const T0 = "2026-11-01T00:00:00.000Z";
const HOUR = 3_600_000;

function at(offsetMs: number): string {
  return new Date(Date.parse(T0) + offsetMs).toISOString();
}

function item(
  naturalKey: string,
  overrides: Partial<MuseIntakeItemWrite> = {},
): MuseIntakeItemWrite {
  return {
    kind: "proactive",
    naturalKey,
    state: "delivered",
    reasonCode: null,
    decision: "send",
    reasonEnum: "changed",
    priority: "regular",
    occurredAt: at(60_000),
    scheduledFor: null,
    startedAt: null,
    preparedAt: at(30_000),
    handoffAcceptedAt: at(45_000),
    eventAt: at(-3_600_000),
    titleRef: `title-${naturalKey}`,
    textRef: `text-${naturalKey}`,
    textWithheld: false,
    options: ["ok"],
    sources: { occurred_at: "system_record", text: "chat_record" },
    contentDigest: `digest-${naturalKey}`,
    ...overrides,
  };
}

function batch(
  seq: number,
  items: readonly MuseIntakeItemWrite[],
  overrides: Record<string, unknown> = {},
) {
  return {
    ...scope,
    batchId: `batch-${seq}-${items.length}-${Math.random().toString(36).slice(2)}`,
    senderId: "muse",
    batchSeq: seq,
    sentAt: at(seq * 1000),
    receivedAt: at(seq * 1000 + 500),
    rejectedCount: 0,
    droppedFieldCount: 0,
    items,
    ...overrides,
  };
}

describe.each(["worker", "direct"] as const)("Muse intake store through %s", (execution) => {
  useSqliteContractExecution(execution);
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-muse-intake-"));
    directories.push(stateRoot);
    const database = openQualifiedDatabase(path.join(stateRoot, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    for (const owner of [OWNER_ID, OTHER_OWNER_ID])
      database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(owner);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(OTHER_AGENT_ID, OTHER_OWNER_ID);
    const insertPayload = database.prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
        encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
      ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
        'active', ?, 'text/plain')`,
    );
    for (const key of ["a", "b", "c", "dup", "x"])
      for (const prefix of ["title", "text"])
        insertPayload.run(`${prefix}-${key}`, OWNER_ID, AGENT_ID, `sha256:${prefix}-${key}`, T0);
    insertPayload.run("title-z", OWNER_ID, AGENT_ID, "sha256:title-z", T0);
    insertPayload.run("text-z", OWNER_ID, AGENT_ID, "sha256:text-z", T0);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => T0,
    });
    return { repository, intake: repository.museIntake() };
  }

  it("stores a batch, lists it back, and treats a resent batch and a resent item as duplicates", async () => {
    const { repository, intake } = await fixture();
    try {
      const first = await intake.ingestBatch(batch(1, [item("a"), item("b")]));
      expect(first).toMatchObject({ status: "accepted", accepted: 2, duplicate: 0, conflict: 0 });
      const listed = await intake.listItems({ ...scope, since: SINCE, limit: 10 });
      expect(listed.map((entry) => entry.intakeItemKey).sort()).toEqual([
        "proactive:a",
        "proactive:b",
      ]);
      expect(listed[0]).toMatchObject({ timingOk: null, contentOk: null, ratedAt: null });

      const sameSeq = await intake.ingestBatch(batch(1, [item("a"), item("b")]));
      expect(sameSeq).toMatchObject({ status: "replay", expectedNextSeq: 2 });
      expect([...sameSeq.unusedRefs].sort()).toEqual(["text-a", "text-b", "title-a", "title-b"]);

      const resent = await intake.ingestBatch(batch(2, [item("a"), item("c")]));
      expect(resent).toMatchObject({ status: "accepted", accepted: 1, duplicate: 1, conflict: 0 });
      expect([...resent.unusedRefs].sort()).toEqual(["text-a", "title-a"]);
      expect(await intake.listItems({ ...scope, since: SINCE, limit: 10 })).toHaveLength(3);
    } finally {
      await repository.close();
    }
  });

  it("keeps the stored item and counts a conflict when the same key arrives with other content", async () => {
    const { repository, intake } = await fixture();
    try {
      await intake.ingestBatch(batch(1, [item("a")]));
      const outcome = await intake.ingestBatch(
        batch(2, [item("a", { contentDigest: "digest-changed", textRef: "text-x" })]),
      );
      expect(outcome).toMatchObject({ status: "accepted", accepted: 0, conflict: 1 });
      expect(outcome.unusedRefs).toContain("text-x");
      const [stored] = await intake.listItems({ ...scope, since: SINCE, limit: 10 });
      expect(stored?.textRef).toBe("text-a");
    } finally {
      await repository.close();
    }
  });

  it("records a sequence gap once and keeps accepting; an empty batch is a heartbeat", async () => {
    const { repository, intake } = await fixture();
    try {
      await intake.ingestBatch(batch(1, []));
      const gapped = await intake.ingestBatch(batch(4, [item("a")]));
      expect(gapped).toMatchObject({ status: "accepted", gap: true, expectedNextSeq: 5 });
      const status = await intake.channelStatus({ ...scope, now: at(HOUR / 2) });
      expect(status).toMatchObject({ state: "ok", lastSeq: 4, gapCount: 1 });
      const late = await intake.ingestBatch(batch(2, [item("b")]));
      expect(late).toMatchObject({ status: "accepted", gap: false, expectedNextSeq: 5 });
    } finally {
      await repository.close();
    }
  });

  it("rejects unknown senders, unknown states and malformed items", async () => {
    const { repository, intake } = await fixture();
    try {
      await expect(intake.ingestBatch(batch(1, [], { senderId: "other" }))).rejects.toThrow();
      await expect(
        intake.ingestBatch(batch(1, [item("a", { state: "succeeded" })])),
      ).rejects.toThrow();
      await expect(
        intake.ingestBatch(
          batch(1, [item("a", { sources: { text: "made_up" as "derived" } })]),
        ),
      ).rejects.toThrow();
      await expect(intake.ingestBatch(batch(0, []))).rejects.toThrow();
      expect(await intake.listItems({ ...scope, since: SINCE, limit: 10 })).toEqual([]);
      expect((await intake.channelStatus({ ...scope, now: T0 })).state).toBe("never");
    } finally {
      await repository.close();
    }
  });

  it("stores scheduled runs and keeps them apart from proactive items with the same key", async () => {
    const { repository, intake } = await fixture();
    try {
      const outcome = await intake.ingestBatch(
        batch(1, [
          item("a"),
          item("a", {
            kind: "scheduled",
            state: "succeeded",
            decision: null,
            reasonEnum: null,
            priority: null,
            scheduledFor: at(0),
            startedAt: at(-1000),
            titleRef: null,
            textRef: null,
          }),
        ]),
      );
      expect(outcome).toMatchObject({ accepted: 2 });
    } finally {
      await repository.close();
    }
  });

  it("pauses without deleting, rejects batches while paused, and resumes", async () => {
    const { repository, intake } = await fixture();
    try {
      await intake.ingestBatch(batch(1, [item("a")]));
      await intake.setPaused({ ...scope, paused: true });
      const paused = await intake.ingestBatch(batch(2, [item("b")]));
      expect(paused).toMatchObject({ status: "paused" });
      expect(paused.unusedRefs).toEqual(["title-b", "text-b"]);
      expect((await intake.channelStatus({ ...scope, now: at(1000) })).state).toBe("paused");
      expect(await intake.listItems({ ...scope, since: SINCE, limit: 10 })).toHaveLength(1);
      await intake.setPaused({ ...scope, paused: false });
      expect(await intake.ingestBatch(batch(2, [item("b")]))).toMatchObject({ status: "accepted" });
    } finally {
      await repository.close();
    }
  });

  it("marks the channel stale at 2.5 hours and notifies once at 3 hours; a new batch ends the outage", async () => {
    const { repository, intake } = await fixture();
    try {
      expect(await intake.checkChannel({ ...scope, now: at(10 * HOUR) })).toMatchObject({
        state: "never",
        notify: false,
      });
      await intake.ingestBatch(batch(1, []));
      const received = at(1500);
      const check = (offset: number) => intake.checkChannel({ ...scope, now: at(offset) });
      expect(await check(1500 + 2 * HOUR)).toMatchObject({ state: "ok", notify: false });
      expect(await check(1500 + 2.5 * HOUR)).toMatchObject({ state: "stale", notify: false });
      const down = await check(1500 + 3 * HOUR);
      expect(down).toMatchObject({ state: "down", notify: true });
      expect(down.outageStartedAt).toBe(at(1500 + 2.5 * HOUR));
      expect(await check(1500 + 4 * HOUR)).toMatchObject({ state: "down", notify: false });
      expect((await intake.channelStatus({ ...scope, now: at(1500 + 4 * HOUR) })).lastBatchAt).toBe(
        received,
      );
      await intake.ingestBatch(batch(2, [], { receivedAt: at(1500 + 5 * HOUR) }));
      expect(await check(1500 + 5.5 * HOUR)).toMatchObject({
        state: "ok",
        notify: false,
        outageNotifiedAt: null,
      });
      expect(await check(1500 + 8.5 * HOUR)).toMatchObject({ state: "down", notify: true });
    } finally {
      await repository.close();
    }
  });

  it("writes a Muse reference entry when both judgments are given, and removes it when both are cleared", async () => {
    const { repository, intake } = await fixture();
    try {
      await intake.ingestBatch(batch(1, [item("a")]));
      const rate = (timingOk: boolean | null, contentOk: boolean | null, id = "rating-1") =>
        intake.rate({
          ...scope,
          kind: "proactive",
          naturalKey: "a",
          timingOk,
          contentOk,
          entryId: id,
          now: at(5000),
        });
      expect(await rate(true, false)).toBe(true);
      const [rated] = await intake.listItems({ ...scope, since: SINCE, limit: 10 });
      expect(rated).toMatchObject({ timingOk: true, contentOk: false, ratedAt: at(5000) });
      const entries = await repository
        .decisionLedger()
        .listMuse({ ...scope, since: SINCE, limit: 10 });
      expect(entries).toMatchObject([
        { id: "rating-1", intakeItemKey: "proactive:a", museReminded: true, contentRef: null },
      ]);
      expect(await rate(false, false, "rating-2")).toBe(true);
      expect(
        (await repository.decisionLedger().listMuse({ ...scope, since: SINCE, limit: 10 })).map(
          (entry) => entry.id,
        ),
      ).toEqual(["rating-2"]);
      expect(
        await intake.listItems({ ...scope, since: SINCE, limit: 10, unratedOnly: true }),
      ).toEqual([]);
      expect(await rate(null, null)).toBe(true);
      expect(
        await repository.decisionLedger().listMuse({ ...scope, since: SINCE, limit: 10 }),
      ).toEqual([]);
      expect(
        await intake.listItems({ ...scope, since: SINCE, limit: 10, unratedOnly: true }),
      ).toHaveLength(1);
      await expect(rate(true, null)).rejects.toThrow();
    } finally {
      await repository.close();
    }
  });

  it("refuses to rate an item that does not exist or belongs to another owner", async () => {
    const { repository, intake } = await fixture();
    try {
      await intake.ingestBatch(batch(1, [item("a")]));
      const foreign = {
        ownerId: OTHER_OWNER_ID,
        agentId: OTHER_AGENT_ID,
        kind: "proactive" as const,
        naturalKey: "a",
        timingOk: true,
        contentOk: true,
        entryId: "rating-foreign",
        now: at(5000),
      };
      expect(await intake.rate(foreign)).toBe(false);
      expect(await intake.rate({ ...foreign, ...scope, naturalKey: "missing" })).toBe(false);
      expect(
        await intake.listItems({
          ownerId: OTHER_OWNER_ID,
          agentId: OTHER_AGENT_ID,
          since: SINCE,
          limit: 10,
        }),
      ).toEqual([]);
    } finally {
      await repository.close();
    }
  });

  it("clears every received item and its ratings, returns the payload refs, and keeps hand-recorded entries", async () => {
    const { repository, intake } = await fixture();
    try {
      await intake.ingestBatch(batch(1, [item("a"), item("b")]));
      await intake.rate({
        ...scope,
        kind: "proactive",
        naturalKey: "a",
        timingOk: true,
        contentOk: true,
        entryId: "rating-1",
        now: at(5000),
      });
      await repository.decisionLedger().recordMuse({
        id: "manual-1",
        ...scope,
        museAt: at(1000),
        museReminded: true,
        timingOk: true,
        contentOk: true,
        contentRef: "text-z",
        noteRef: null,
        pairedDecisionId: null,
        recordedAt: at(2000),
      });
      await intake.setPaused({ ...scope, paused: true });
      const cleared = await intake.clearAll(scope);
      expect([...cleared.refs].sort()).toEqual(["text-a", "text-b", "title-a", "title-b"]);
      expect(await intake.listItems({ ...scope, since: SINCE, limit: 10 })).toEqual([]);
      expect(
        (await repository.decisionLedger().listMuse({ ...scope, since: SINCE, limit: 10 })).map(
          (entry) => entry.id,
        ),
      ).toEqual(["manual-1"]);
      const status = await intake.channelStatus({ ...scope, now: at(6000) });
      expect(status).toMatchObject({ lastBatchAt: null, lastSeq: 0, gapCount: 0, paused: true });
      await intake.setPaused({ ...scope, paused: false });
      expect(await intake.ingestBatch(batch(1, [item("a")]))).toMatchObject({ status: "accepted" });
    } finally {
      await repository.close();
    }
  });
});
