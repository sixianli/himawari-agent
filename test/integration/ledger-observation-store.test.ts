import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
  SqliteProductStateRepository,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { useSqliteContractExecution } from "./sqlite-contract-execution.fixture.ts";

const OWNER_ID = createOwnerId("owner-observation");
const AGENT_ID = createAgentId("agent-observation");
const scope = { ownerId: OWNER_ID, agentId: AGENT_ID };
const T0 = "2026-11-05T15:00:00.000Z";
const DAY = {
  day: "2026-11-06",
  start: "2026-11-05T15:00:00.000Z",
  end: "2026-11-06T15:00:00.000Z",
};

describe.each(["worker", "direct"] as const)("ledger observation store through %s", (execution) => {
  useSqliteContractExecution(execution);
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function fixture() {
    const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-observation-"));
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
    for (const ref of ["account-1", "token-1"])
      insertPayload.run(ref, OWNER_ID, AGENT_ID, `sha256:${ref}`, T0);
    database.close();
    const repository = await SqliteProductStateRepository.open({
      stateRoot,
      minimumFreeBytes: 0,
      now: () => T0,
    });
    const raw = () => openQualifiedDatabase(file);
    return { repository, observation: repository.ledgerObservation(), raw };
  }

  function proactiveRow(raw: ReturnType<typeof openQualifiedDatabase>, id: string, at: string) {
    raw
      .prepare(
        `INSERT INTO decision_ledger (
          id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, outcome,
          reason_code, inputs, cost_micros, duration_ms
        ) VALUES (?, ?, ?, 'proactive', 'gmail', ?, '{}', 'silent', NULL, 'NO_NEW_MAIL', '{}', 0, 1)`,
      )
      .run(id, OWNER_ID, AGENT_ID, at);
  }

  it("keeps the start day once set and refuses a second start", async () => {
    const { repository, observation, raw } = await fixture();
    try {
      expect(await observation.readStart(scope)).toBeNull();
      const start = {
        ...scope,
        startDay: "2026-11-06",
        setAt: T0,
        serviceRevision: "41a6ce3",
        firstBootAt: "2026-11-05T03:00:00.000Z",
      };
      await observation.setStart(start);
      expect(await observation.readStart(scope)).toEqual(start);
      await expect(observation.setStart({ ...start, startDay: "2026-11-09" })).rejects.toThrow(
        /LEDGER_OBSERVATION_START_ALREADY_SET/,
      );
      const database = raw();
      try {
        expect(() =>
          database.prepare("UPDATE ledger_observation_start SET start_day = '2026-11-09'").run(),
        ).toThrow(/LEDGER_OBSERVATION_START_IMMUTABLE/);
        expect(() => database.prepare("DELETE FROM ledger_observation_start").run()).toThrow(
          /LEDGER_OBSERVATION_START_IMMUTABLE/,
        );
      } finally {
        database.close();
      }
      expect((await observation.readStart(scope))?.startDay).toBe("2026-11-06");
    } finally {
      await repository.close();
    }
  });

  it("records one heartbeat row per hour and the first time the service was seen", async () => {
    const { repository, observation } = await fixture();
    try {
      for (const at of [
        "2026-11-05T15:01:00.000Z",
        "2026-11-05T15:46:00.000Z",
        "2026-11-05T16:02:00.000Z",
      ])
        await observation.beat({ ...scope, at, serviceRevision: "41a6ce3" });
      expect(await observation.firstHeartbeat(scope)).toBe("2026-11-05T15:01:00.000Z");
      const facts = await observation.readDayFacts({ ...scope, ...DAY, until: DAY.end });
      expect(facts.heartbeatHours).toEqual([
        "2026-11-05T15:00:00.000Z",
        "2026-11-05T16:00:00.000Z",
      ]);
    } finally {
      await repository.close();
    }
  });

  it("writes an event only when a switch or connection really changes", async () => {
    const { repository, observation } = await fixture();
    try {
      const proactive = repository.proactive();
      const settings = { ...scope, quietHours: [], importantSenders: [] };
      await observation.ensureSnapshot({ ...scope, at: T0 });
      await proactive.writeSettings({
        ...settings,
        enabled: true,
        now: "2026-11-05T16:00:00.000Z",
      });
      await proactive.writeSettings({
        ...settings,
        enabled: true,
        now: "2026-11-05T16:10:00.000Z",
      });
      await proactive.saveConnection({
        ...scope,
        connection: {
          source: "gmail",
          accountRef: "account-1",
          tokenRef: "token-1",
          cursor: null,
          status: "connected",
          connectedAt: "2026-11-05T16:20:00.000Z",
          updatedAt: "2026-11-05T16:20:00.000Z",
        },
      });
      await proactive.markConnection({
        ...scope,
        source: "gmail",
        status: "connected",
        cursor: "c-1",
        now: "2026-11-05T16:30:00.000Z",
      });
      await proactive.markConnection({
        ...scope,
        source: "gmail",
        status: "needs_reconnect",
        cursor: null,
        now: "2026-11-05T17:00:00.000Z",
      });
      await repository.memoryBook().writeSettings({
        ...scope,
        capturePaused: true,
        updatedAt: "2026-11-05T18:00:00.000Z",
      });
      await observation.ensureSnapshot({ ...scope, at: "2026-11-05T19:00:00.000Z" });
      const events = await observation.listEvents({ ...scope, since: T0 });
      expect(events.map(({ kind, occurredAt }) => [kind, occurredAt])).toEqual([
        ["state_snapshot", T0],
        ["proactive_enabled", "2026-11-05T16:00:00.000Z"],
        ["source_connected", "2026-11-05T16:20:00.000Z"],
        ["source_needs_reconnect", "2026-11-05T17:00:00.000Z"],
        ["memory_capture_paused", "2026-11-05T18:00:00.000Z"],
      ]);
      expect(events[0]?.detail).toEqual({
        capturePaused: false,
        proactiveEnabled: false,
        sourceStatus: "disconnected",
      });
    } finally {
      await repository.close();
    }
  });

  it("counts cleared proactive rows in an event and reads the day facts", async () => {
    const { repository, observation, raw } = await fixture();
    try {
      const database = raw();
      try {
        proactiveRow(database, "p-1", "2026-11-05T15:10:00.000Z");
        proactiveRow(database, "p-2", "2026-11-05T15:25:00.000Z");
        proactiveRow(database, "p-outside", "2026-11-06T15:00:00.000Z");
        database
          .prepare(
            `INSERT INTO memory_consolidation_runs (
              id, owner_id, agent_id, day, trigger_run_id, status, reviewed_through,
              model_called, change_count, error_code, started_at, finished_at
            ) VALUES ('memory-consolidation:agent-observation:2026-11-06', ?, ?, '2026-11-06',
              'run-1', 'completed', NULL, 1, 2, NULL, '2026-11-06T01:00:00.000Z',
              '2026-11-06T01:05:00.000Z')`,
          )
          .run(OWNER_ID, AGENT_ID);
        database
          .prepare(
            `INSERT INTO decision_ledger (
              id, owner_id, agent_id, kind, checked_at, counts, outcome, reason_code, inputs,
              cost_micros, duration_ms
            ) VALUES ('c-1', ?, ?, 'consolidation', '2026-11-06T01:04:00.000Z', '{}', 'merge',
              'merged', json_object('memoryIds', json_array(), 'ruleIds', json_array(),
              'batchId', 'memory-consolidation:agent-observation:2026-11-06'), 0, 0)`,
          )
          .run(OWNER_ID, AGENT_ID);
      } finally {
        database.close();
      }
      const facts = await observation.readDayFacts({ ...scope, ...DAY, until: DAY.end });
      expect(facts.proactiveTimes).toEqual([
        "2026-11-05T15:10:00.000Z",
        "2026-11-05T15:25:00.000Z",
      ]);
      expect(facts.counts).toEqual({ consolidation: 1, proactive: 2 });
      expect(facts.malformedTimes).toBe(0);
      expect(facts.consolidationRuns).toEqual([
        expect.objectContaining({ status: "completed", changeCount: 2, ledgerRows: 1 }),
      ]);
      await repository.proactive().clearRecords({ ...scope, source: "gmail" });
      const events = await observation.listEvents({
        ...scope,
        since: "1970-01-01T00:00:00.000Z",
      });
      expect(events.map(({ kind, detail }) => [kind, detail])).toEqual([
        ["proactive_records_cleared", { source: "gmail", rows: 3 }],
      ]);
      expect(await observation.countDays({ ...scope, days: [DAY] })).toEqual({
        "2026-11-06": { consolidation: 1 },
      });
    } finally {
      await repository.close();
    }
  });

  it("appends checks that can never be changed or deleted", async () => {
    const { repository, observation, raw } = await fixture();
    try {
      const check = {
        id: "check-1",
        ...scope,
        day: "2026-11-06",
        checkedAt: "2026-11-06T16:00:00.000Z",
        serviceRevision: "41a6ce3",
        status: "pass" as const,
        checks: [
          {
            code: "service_running",
            status: "pass" as const,
            reason: "all_hours",
            facts: { missingHours: 0 },
          },
        ],
        counts: { proactive: 96 },
      };
      await observation.appendCheck(check);
      await observation.appendCheck({
        ...check,
        id: "check-2",
        checkedAt: "2026-11-06T17:00:00.000Z",
        status: "fail",
      });
      expect((await observation.listChecks(scope)).map(({ id, status }) => [id, status])).toEqual([
        ["check-1", "pass"],
        ["check-2", "fail"],
      ]);
      await expect(
        observation.appendCheck({ ...check, id: "check-3", status: "great" as never }),
      ).rejects.toThrow();
      const database = raw();
      try {
        expect(() =>
          database.prepare("UPDATE ledger_observation_checks SET status = 'pass'").run(),
        ).toThrow(/LEDGER_OBSERVATION_CHECK_IMMUTABLE/);
        expect(() => database.prepare("DELETE FROM ledger_observation_checks").run()).toThrow(
          /LEDGER_OBSERVATION_CHECK_IMMUTABLE/,
        );
      } finally {
        database.close();
      }
    } finally {
      await repository.close();
    }
  });

  it("writes the first state snapshot even when another event came first, and keeps same-moment events in order", async () => {
    const { repository, observation, raw } = await fixture();
    try {
      const database = raw();
      try {
        database
          .prepare(
            `INSERT INTO observation_events (id, owner_id, agent_id, kind, occurred_at, sequence, detail)
             VALUES ('early', ?, ?, 'consolidation_failed', ?, 1, '{}')`,
          )
          .run(OWNER_ID, AGENT_ID, T0);
      } finally {
        database.close();
      }
      await observation.ensureSnapshot({ ...scope, at: "2026-11-05T15:01:00.000Z" });
      const settings = { ...scope, quietHours: [], importantSenders: [] };
      const same = "2026-11-05T16:00:00.000Z";
      for (let index = 0; index < 10; index += 1) {
        await repository.proactive().writeSettings({ ...settings, enabled: true, now: same });
        await repository.proactive().writeSettings({ ...settings, enabled: false, now: same });
      }
      const kinds = (
        await observation.listEvents({ ...scope, since: "1970-01-01T00:00:00.000Z" })
      ).map(({ kind }) => kind);
      expect(kinds.slice(0, 2)).toEqual(["consolidation_failed", "state_snapshot"]);
      expect(kinds.slice(2)).toEqual(
        Array.from({ length: 20 }, (_, index) =>
          index % 2 === 0 ? "proactive_enabled" : "proactive_disabled",
        ),
      );
    } finally {
      await repository.close();
    }
  });

  it("writes no clear event when there were no Gmail records to clear", async () => {
    const { repository, observation } = await fixture();
    try {
      await repository.proactive().clearRecords({ ...scope, source: "gmail" });
      expect(await observation.listEvents({ ...scope, since: "1970-01-01T00:00:00.000Z" })).toEqual(
        [],
      );
    } finally {
      await repository.close();
    }
  });

  it("refuses changes to recorded events, rejects a repeated sequence and orders same-moment events by sequence", async () => {
    const { repository, observation, raw } = await fixture();
    try {
      const database = raw();
      try {
        const insert = database.prepare(
          `INSERT INTO observation_events (id, owner_id, agent_id, kind, occurred_at, sequence, detail)
           VALUES (?, ?, ?, ?, ?, ?, '{}')`,
        );
        insert.run("later", OWNER_ID, AGENT_ID, "proactive_enabled", T0, 5);
        insert.run("earlier", OWNER_ID, AGENT_ID, "proactive_disabled", T0, 3);
        expect(() => insert.run("again", OWNER_ID, AGENT_ID, "proactive_enabled", T0, 5)).toThrow(
          /UNIQUE/,
        );
        expect(() =>
          database.prepare("UPDATE observation_events SET kind = 'proactive_enabled'").run(),
        ).toThrow(/OBSERVATION_EVENT_IMMUTABLE/);
        expect(() => database.prepare("DELETE FROM observation_events").run()).toThrow(
          /OBSERVATION_EVENT_IMMUTABLE/,
        );
      } finally {
        database.close();
      }
      expect((await observation.listEvents({ ...scope, since: T0 })).map(({ id }) => id)).toEqual([
        "earlier",
        "later",
      ]);
    } finally {
      await repository.close();
    }
  });
});

describe("[P0-8] observation rows when the Agent or the whole account is deleted", () => {
  it.each([
    ["the Agent", "DELETE FROM agents WHERE id = ?", AGENT_ID],
    ["the whole account", "DELETE FROM owners WHERE id = ?", OWNER_ID],
  ] as const)("removes every observation row when %s is deleted", async (_label, sql, id) => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-observation-cascade-"));
    try {
      const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
      try {
        applyMigrations(database, await loadBundledMigrations());
        database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
        database
          .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
          .run(AGENT_ID, OWNER_ID);
        database
          .prepare(
            `INSERT INTO ledger_observation_start (
              owner_id, agent_id, start_day, set_at, service_revision, first_boot_at
            ) VALUES (?, ?, '2026-11-06', ?, 'r1', ?)`,
          )
          .run(OWNER_ID, AGENT_ID, T0, T0);
        database
          .prepare(
            `INSERT INTO service_heartbeats (
              owner_id, agent_id, hour_start, first_seen_at, last_seen_at, service_revision
            ) VALUES (?, ?, '2026-11-05T15:00:00.000Z', ?, ?, 'r1')`,
          )
          .run(OWNER_ID, AGENT_ID, T0, T0);
        database
          .prepare(
            `INSERT INTO ledger_observation_checks (
              id, owner_id, agent_id, day, checked_at, service_revision, status, checks, counts
            ) VALUES ('c1', ?, ?, '2026-11-06', ?, 'r1', 'pass', '[]', '{}')`,
          )
          .run(OWNER_ID, AGENT_ID, T0);
        database
          .prepare(
            `INSERT INTO observation_events (id, owner_id, agent_id, kind, occurred_at, sequence, detail)
             VALUES ('e1', ?, ?, 'state_snapshot', ?, 1, '{}')`,
          )
          .run(OWNER_ID, AGENT_ID, T0);
        database.prepare(sql).run(id);
        for (const table of [
          "ledger_observation_start",
          "service_heartbeats",
          "ledger_observation_checks",
          "observation_events",
        ])
          expect(database.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
      } finally {
        database.close();
      }
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
