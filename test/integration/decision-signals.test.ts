import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildReport,
  DEFAULT_MINIMUM_SAMPLES,
  resolveWindow,
  summarizeDecisions,
  summarizeImplicit,
} from "@himawari-agent/calibration";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { recordDecisionSignal } from "../../packages/persistence-sqlite/src/decision-signals.ts";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-signals");
const AGENT_ID = createAgentId("agent-signals");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const T0 = "2026-11-02T00:00:00.000Z";
const SENT = "2026-11-02T00:10:00.000Z";
const OPENED = "2026-11-02T00:40:00.000Z";
const SINCE = "1970-01-01T00:00:00.000Z";

const counts = {
  fetched: 1,
  skipped: 0,
  judged: 1,
  act: 1,
  know: 0,
  check: 0,
  ignore: 0,
  floorRaised: 0,
  pushed: 1,
};

describe.each(["worker", "direct"] as const)("[P0-11] decision signals through %s", (execution) => {
  useSqliteContractExecution(execution);
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-decision-signals-"));
    directories.push(stateRoot);
    const file = path.join(stateRoot, "product.sqlite");
    const database = openQualifiedDatabase(file);
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT_ID, OWNER_ID);
    const insertPayload = database.prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
        encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
      ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key',
        'active', ?, 'text/plain')`,
    );
    for (const ref of ["content-1", "content-2"])
      insertPayload.run(ref, OWNER_ID, AGENT_ID, `sha256:${ref}`, T0);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => T0,
    });
    const raw = () => openQualifiedDatabase(file);

    const record = async (input: {
      readonly id: string;
      readonly checkedAt?: string;
      readonly verdict: "pushed" | "silent";
      readonly pushSourceKey?: string | null;
      readonly insights?: { id: string; threadId: string; contentRef: string }[];
      readonly repliedThreads?: { threadId: string; receivedAt: string }[];
    }) =>
      repository.proactive().record({
        ...scope,
        decision: {
          id: input.id,
          scenario: "gmail",
          checkedAt: input.checkedAt ?? T0,
          counts: input.verdict === "silent" ? { ...counts, act: 0, pushed: 0 } : counts,
          verdict: input.verdict,
          reasonCode: "fixture",
          pushSourceKey: input.pushSourceKey ?? null,
          costMicros: 0,
          durationMs: 1,
          ownerRating: null,
          ratedAt: null,
        },
        inputs: {
          ruleIds: [],
          sourceIds: [],
          floorHits: {},
          memoryInjected: false,
          memoryIds: [],
          usedMemoryIds: [],
          memoryByMail: {},
          memoryRecall: "off",
        },
        modelPayloads: [],
        processed: [],
        insights: (input.insights ?? []).map((insight) => ({
          ...insight,
          lastMessageId: `message-${insight.id}`,
          result: "act" as const,
          floorRaised: false,
          dueAt: null,
          priority: null,
          push: false,
        })),
        repliedThreads: input.repliedThreads ?? [],
        push: null,
        cursor: null,
      });

    const addFeedback = (sourceKey: string, tag: string) => {
      const database = raw();
      database
        .prepare(
          `INSERT INTO web_push_feedback (
            owner_id, agent_id, source_key, tag, kind, source_ref, thread_id, channel,
            first_sent_at, devices, opened_at, dismissed_at, updated_at
          ) VALUES (?, ?, ?, ?, 'reminder', 'insight', NULL, 'web_push', ?, 1, NULL, NULL, ?)`,
        )
        .run(OWNER_ID, AGENT_ID, sourceKey, tag, SENT, SENT);
      database.close();
    };

    const markPushed = (...insightIds: string[]) => {
      const database = raw();
      for (const id of insightIds)
        database
          .prepare("UPDATE source_insights SET push_source_key = ? WHERE id = ?")
          .run(`proactive:push-${id}`, id);
      database.close();
    };

    const signals = (decisionIds: readonly string[]) =>
      repository.decisionLedger().listSignals({ ...scope, decisionIds });
    return { repository, raw, record, addFeedback, markPushed, signals };
  }

  it("records an opened signal on the decision that sent the push, with the delay", async () => {
    const { repository, record, addFeedback, signals } = await fixture();
    try {
      await record({
        id: "decision-1",
        verdict: "pushed",
        pushSourceKey: "proactive:push-1",
        insights: [{ id: "insight-1", threadId: "thread-1", contentRef: "content-1" }],
      });
      addFeedback("proactive:push-1", "tag-1");
      const push = repository.webPush();
      await push.recordReactions({
        ...scope,
        reactions: [{ tag: "tag-1", reaction: "opened", occurredAt: OPENED }],
        now: OPENED,
      });
      expect(await signals(["decision-1"])).toEqual([
        {
          decisionId: "decision-1",
          signal: "opened",
          occurredAt: OPENED,
          delayMs: 30 * 60_000,
          detail: {},
        },
      ]);
      await push.recordReactions({
        ...scope,
        reactions: [{ tag: "tag-1", reaction: "opened", occurredAt: "2026-11-02T05:00:00.000Z" }],
        now: "2026-11-02T05:00:00.000Z",
      });
      expect(await signals(["decision-1"])).toHaveLength(1);
    } finally {
      await repository.close();
    }
  });

  it("[negative] records nothing for a dismissed push, an unknown tag or a decision that sent no push", async () => {
    const { repository, record, addFeedback, signals } = await fixture();
    try {
      await record({ id: "decision-quiet", verdict: "silent" });
      await record({
        id: "decision-sent",
        verdict: "pushed",
        pushSourceKey: "proactive:push-2",
      });
      addFeedback("proactive:push-2", "tag-2");
      addFeedback("approval:other", "tag-other");
      await repository.webPush().recordReactions({
        ...scope,
        reactions: [
          { tag: "tag-2", reaction: "dismissed", occurredAt: OPENED },
          { tag: "tag-other", reaction: "opened", occurredAt: OPENED },
          { tag: "tag-missing", reaction: "opened", occurredAt: OPENED },
        ],
        now: OPENED,
      });
      expect(await signals(["decision-quiet", "decision-sent"])).toEqual([]);
    } finally {
      await repository.close();
    }
  });

  it("records an undone signal only when done or muted is reversed", async () => {
    const { repository, record, markPushed, signals } = await fixture();
    try {
      await record({
        id: "decision-1",
        verdict: "pushed",
        insights: [
          { id: "insight-1", threadId: "thread-1", contentRef: "content-1" },
          { id: "insight-2", threadId: "thread-2", contentRef: "content-2" },
          { id: "insight-3", threadId: "thread-3", contentRef: "content-2" },
        ],
      });
      markPushed("insight-1", "insight-2");
      const proactive = repository.proactive();
      await proactive.updateInsight({
        ...scope,
        insightId: "insight-1",
        status: "open",
        now: "2026-11-02T01:00:00.000Z",
      });
      expect(await signals(["decision-1"])).toEqual([]);
      await proactive.updateInsight({
        ...scope,
        insightId: "insight-1",
        status: "done",
        now: "2026-11-02T01:00:00.000Z",
      });
      expect(await signals(["decision-1"])).toEqual([]);
      await proactive.updateInsight({
        ...scope,
        insightId: "insight-1",
        status: "open",
        now: "2026-11-02T01:00:30.000Z",
      });
      await proactive.updateInsight({
        ...scope,
        insightId: "insight-2",
        status: "muted",
        now: "2026-11-02T02:00:00.000Z",
      });
      await proactive.updateInsight({
        ...scope,
        insightId: "insight-2",
        status: "open",
        now: "2026-11-02T02:00:10.000Z",
      });
      await proactive.updateInsight({
        ...scope,
        insightId: "insight-2",
        rating: "useful",
        now: "2026-11-02T03:00:00.000Z",
      });
      await proactive.updateInsight({
        ...scope,
        insightId: "insight-3",
        status: "done",
        now: "2026-11-02T03:30:00.000Z",
      });
      await proactive.updateInsight({
        ...scope,
        insightId: "insight-3",
        status: "open",
        now: "2026-11-02T03:30:05.000Z",
      });
      expect(
        (await signals(["decision-1"])).map(({ signal, delayMs, detail }) => ({
          signal,
          delayMs,
          detail,
        })),
      ).toEqual([
        { signal: "undone", delayMs: 30_000, detail: { from: "done" } },
        { signal: "undone", delayMs: 10_000, detail: { from: "muted" } },
      ]);
    } finally {
      await repository.close();
    }
  });

  it("records a replied signal once, with the time of the reply, only for a waiting reminder", async () => {
    const { repository, record, markPushed, signals } = await fixture();
    try {
      await record({
        id: "decision-1",
        verdict: "pushed",
        insights: [
          { id: "insight-1", threadId: "thread-1", contentRef: "content-1" },
          { id: "insight-2", threadId: "thread-2", contentRef: "content-2" },
          { id: "insight-3", threadId: "thread-3", contentRef: "content-2" },
        ],
      });
      markPushed("insight-1", "insight-2");
      await repository.proactive().updateInsight({
        ...scope,
        insightId: "insight-2",
        status: "done",
        now: "2026-11-02T00:30:00.000Z",
      });
      const repliedAt = "2026-11-02T04:00:00.000Z";
      const replies = [
        { threadId: "thread-1", receivedAt: repliedAt },
        { threadId: "thread-2", receivedAt: repliedAt },
        { threadId: "thread-3", receivedAt: repliedAt },
        { threadId: "thread-unknown", receivedAt: repliedAt },
      ];
      await record({
        id: "decision-2",
        checkedAt: "2026-11-02T04:05:00.000Z",
        verdict: "silent",
        repliedThreads: replies,
      });
      await record({
        id: "decision-3",
        checkedAt: "2026-11-02T04:20:00.000Z",
        verdict: "silent",
        repliedThreads: replies,
      });
      expect(
        (await signals(["decision-1", "decision-2", "decision-3"])).map(
          ({ decisionId, signal, occurredAt, delayMs }) => ({
            decisionId,
            signal,
            occurredAt,
            delayMs,
          }),
        ),
      ).toEqual([
        {
          decisionId: "decision-1",
          signal: "replied",
          occurredAt: repliedAt,
          delayMs: 4 * 3_600_000,
        },
      ]);
    } finally {
      await repository.close();
    }
  });

  it("never changes or deletes a signal on its own, and removes them with the decision", async () => {
    const { repository, raw, record, addFeedback, signals } = await fixture();
    try {
      await record({
        id: "decision-1",
        verdict: "pushed",
        pushSourceKey: "proactive:push-1",
      });
      addFeedback("proactive:push-1", "tag-1");
      await repository.webPush().recordReactions({
        ...scope,
        reactions: [{ tag: "tag-1", reaction: "opened", occurredAt: OPENED }],
        now: OPENED,
      });
      const database = raw();
      expect(() => database.prepare("UPDATE decision_signals SET delay_ms = 0").run()).toThrow(
        /DECISION_SIGNAL_IMMUTABLE/u,
      );
      expect(() => database.prepare("DELETE FROM decision_signals").run()).toThrow(
        /DECISION_SIGNAL_IMMUTABLE/u,
      );
      database.close();
      expect(await signals(["decision-1"])).toHaveLength(1);
      await repository.proactive().clearRecords({ ...scope, source: "gmail" });
      expect(await signals(["decision-1"])).toEqual([]);
    } finally {
      await repository.close();
    }
  });

  it.each([
    ["the Agent", "DELETE FROM agents WHERE id = ?", AGENT_ID],
    ["the whole account", "DELETE FROM owners WHERE id = ?", OWNER_ID],
  ])("removes the signals when %s is deleted", async (_name, statement, id) => {
    const { repository, raw, record, addFeedback } = await fixture();
    try {
      await record({ id: "decision-1", verdict: "pushed", pushSourceKey: "proactive:push-1" });
      addFeedback("proactive:push-1", "tag-1");
      await repository.webPush().recordReactions({
        ...scope,
        reactions: [{ tag: "tag-1", reaction: "opened", occurredAt: OPENED }],
        now: OPENED,
      });
      const database = raw();
      expect(database.prepare("SELECT count(*) AS n FROM decision_signals").get()).toEqual({
        n: 1,
      });
      database.exec("DELETE FROM payloads");
      database.prepare(statement).run(id);
      expect(database.prepare("SELECT count(*) AS n FROM decision_signals").get()).toEqual({
        n: 0,
      });
      database.close();
    } finally {
      await repository.close();
    }
  });

  it("keeps one row when the same signal is replayed on the same decision and source", async () => {
    const { repository, raw, record, signals } = await fixture();
    try {
      await record({ id: "decision-1", verdict: "pushed" });
      const database = raw();
      const replay = () =>
        recordDecisionSignal(database, {
          ...scope,
          decisionId: "decision-1",
          signal: "opened",
          occurredAt: OPENED,
          delayMs: 0,
          detail: {},
          sourceRef: "proactive:push-1",
          recordedAt: OPENED,
        });
      expect(replay()).toBe(true);
      expect(replay()).toBe(false);
      database.close();
      expect(await signals(["decision-1"])).toHaveLength(1);
      await repository.proactive().clearRecords({ ...scope, source: "gmail" });
      expect(await signals(["decision-1"])).toEqual([]);
    } finally {
      await repository.close();
    }
  });

  it("[negative] counts a decision only after its push was really sent, and keeps other signals apart", async () => {
    const { repository, record, markPushed, addFeedback } = await fixture();
    try {
      await record({
        id: "decision-1",
        verdict: "pushed",
        pushSourceKey: "proactive:push-1",
        insights: [{ id: "insight-1", threadId: "thread-1", contentRef: "content-1" }],
      });
      markPushed("insight-1");
      const database = repository.proactive();
      const reverse = async (done: string, open: string) => {
        await database.updateInsight({
          ...scope,
          insightId: "insight-1",
          status: "done",
          now: done,
        });
        await database.updateInsight({
          ...scope,
          insightId: "insight-1",
          status: "open",
          now: open,
        });
      };
      await reverse("2026-11-02T01:00:00.000Z", "2026-11-02T01:00:10.000Z");
      const window = resolveWindow({ end: "2026-11-03", days: 7 });
      const read = async () => {
        const rows = await repository
          .decisionLedger()
          .readCalibrationRows({ ...scope, start: window.start, end: window.end });
        return summarizeImplicit(rows.decisions, rows.signals, DEFAULT_MINIMUM_SAMPLES);
      };
      const queued = await read();
      expect(queued.pushedDecisions).toBe(0);
      expect(queued.otherDecisionEvents).toBe(1);
      expect(queued.signals.map(({ decisions }) => decisions)).toEqual([0, 0, 0]);
      addFeedback("proactive:push-1", "tag-1");
      const sent = await read();
      expect(sent.pushedDecisions).toBe(1);
      expect(sent.otherDecisionEvents).toBe(0);
      expect(sent.signals.map(({ decisions }) => decisions)).toEqual([0, 1, 0]);
    } finally {
      await repository.close();
    }
  });

  it("keeps a reversal on the decision that sent the push when a later check updates the reminder", async () => {
    const { repository, raw, record, addFeedback, signals } = await fixture();
    try {
      const insights = [{ id: "insight-1", threadId: "thread-1", contentRef: "content-1" }];
      await record({
        id: "decision-1",
        verdict: "pushed",
        pushSourceKey: "proactive:push-1",
        insights,
      });
      const database = raw();
      database
        .prepare("UPDATE source_insights SET push_source_key = 'proactive:push-1' WHERE id = ?")
        .run("insight-1");
      database.close();
      addFeedback("proactive:push-1", "tag-1");
      await record({
        id: "decision-2",
        checkedAt: "2026-11-02T00:30:00.000Z",
        verdict: "silent",
        insights,
      });
      const proactive = repository.proactive();
      await proactive.updateInsight({
        ...scope,
        insightId: "insight-1",
        status: "done",
        now: "2026-11-02T01:00:00.000Z",
      });
      await proactive.updateInsight({
        ...scope,
        insightId: "insight-1",
        status: "open",
        now: "2026-11-02T01:00:20.000Z",
      });
      const rows = await signals(["decision-1", "decision-2"]);
      expect(rows.map(({ decisionId, signal }) => ({ decisionId, signal }))).toEqual([
        { decisionId: "decision-1", signal: "undone" },
      ]);
      const window = resolveWindow({ end: "2026-11-03", days: 7 });
      const snapshot = await repository
        .decisionLedger()
        .readCalibrationRows({ ...scope, start: window.start, end: window.end });
      const implicit = summarizeImplicit(
        snapshot.decisions,
        snapshot.signals,
        DEFAULT_MINIMUM_SAMPLES,
      );
      expect(implicit.pushedDecisions).toBe(1);
      expect(implicit.otherDecisionEvents).toBe(0);
      expect(implicit.signals.map(({ decisions }) => decisions)).toEqual([0, 1, 0]);
    } finally {
      await repository.close();
    }
  });

  it("looks decisions up by push source key through an index", async () => {
    const { repository, raw } = await fixture();
    try {
      const database = raw();
      const plan = database
        .prepare(
          `EXPLAIN QUERY PLAN SELECT id FROM decision_ledger
           WHERE owner_id = ? AND agent_id = ? AND push_source_key = ?`,
        )
        .all(OWNER_ID, AGENT_ID, "proactive:push-1") as { detail: string }[];
      database.close();
      expect(plan.map(({ detail }) => detail).join(" ")).toContain(
        "decision_ledger_push_source_key",
      );
    } finally {
      await repository.close();
    }
  });

  it("backfills opened signals from earlier push feedback, and only the opened ones", async () => {
    const { repository, raw, record, addFeedback, signals } = await fixture();
    try {
      await record({ id: "decision-1", verdict: "pushed", pushSourceKey: "proactive:push-1" });
      await record({ id: "decision-2", verdict: "pushed", pushSourceKey: "proactive:push-2" });
      addFeedback("proactive:push-1", "tag-1");
      addFeedback("proactive:push-2", "tag-2");
      const database = raw();
      database
        .prepare("UPDATE web_push_feedback SET opened_at = ? WHERE source_key = ?")
        .run(OPENED, "proactive:push-1");
      const migration = (await loadBundledMigrations()).find(
        (entry) => entry.name === "decision_signals",
      );
      const backfill = migration?.sql.slice(migration.sql.indexOf("INSERT INTO decision_signals"));
      expect(backfill).toBeDefined();
      database.exec(backfill as string);
      database.close();
      const rows = await signals(["decision-1", "decision-2"]);
      expect(
        rows.map(({ decisionId, signal, delayMs, detail }) => ({
          decisionId,
          signal,
          delayMs,
          detail,
        })),
      ).toEqual([
        {
          decisionId: "decision-1",
          signal: "opened",
          delayMs: 30 * 60_000,
          detail: { backfilled: true },
        },
      ]);
    } finally {
      await repository.close();
    }
  });

  it("reports observed signals apart from the owner's ratings and never moves the rating shares", async () => {
    const { repository, record, addFeedback } = await fixture();
    try {
      for (let index = 1; index <= 6; index += 1)
        await record({
          id: `decision-${index}`,
          verdict: "pushed",
          pushSourceKey: `proactive:push-${index}`,
        });
      for (let index = 1; index <= 5; index += 1)
        addFeedback(`proactive:push-${index}`, `tag-${index}`);
      const ratings = (rating: "useful" | "unneeded" | null) =>
        repository.proactive().rateDecision({
          ...scope,
          decisionId: "decision-5",
          rating,
          now: OPENED,
        });
      await ratings("unneeded");
      const window = resolveWindow({ end: "2026-11-03", days: 7 });
      const read = async () => {
        const rows = await repository
          .decisionLedger()
          .readCalibrationRows({ ...scope, start: window.start, end: window.end });
        return {
          rows,
          groups: summarizeDecisions(rows.decisions, DEFAULT_MINIMUM_SAMPLES),
          implicit: summarizeImplicit(rows.decisions, rows.signals, DEFAULT_MINIMUM_SAMPLES),
        };
      };
      const before = await read();
      expect(before.implicit.signals.map(({ decisions }) => decisions)).toEqual([0, 0, 0]);
      await repository.webPush().recordReactions({
        ...scope,
        reactions: [
          { tag: "tag-1", reaction: "opened", occurredAt: OPENED },
          { tag: "tag-2", reaction: "opened", occurredAt: "2026-11-02T00:20:00.000Z" },
        ],
        now: OPENED,
      });
      const after = await read();
      expect(after.groups).toEqual(before.groups);
      expect(after.implicit).toMatchObject({
        pushedDecisions: 5,
        otherDecisionEvents: 0,
        signals: [
          { signal: "opened", decisions: 2, events: 2, medianDelayMs: 20 * 60_000 },
          { signal: "undone", decisions: 0, events: 0, medianDelayMs: null },
          { signal: "replied", decisions: 0, events: 0, medianDelayMs: null },
        ],
      });
      expect(after.implicit.signals[0]?.rate.enough).toBe(true);
      const markdown = buildReport({
        window,
        scope: { ownerId: OWNER_ID, agentId: AGENT_ID },
        decisions: after.groups,
        implicit: after.implicit,
        minimumSamples: DEFAULT_MINIMUM_SAMPLES,
      });
      expect(markdown).toContain("## 观察信号（不是打分）");
      expect(markdown).toContain("| 点开了推送 | 2 |");
      expect(markdown).toContain("不当作你的评价");
      const ratedAtSince = await repository
        .proactive()
        .listDecisions({ ...scope, since: SINCE, limit: 10 });
      expect(ratedAtSince.filter(({ ownerRating }) => ownerRating !== null)).toHaveLength(1);
    } finally {
      await repository.close();
    }
  });
});
