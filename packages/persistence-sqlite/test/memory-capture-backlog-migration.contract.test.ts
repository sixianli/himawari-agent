import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  createVerifiedMigrationSnapshot,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "../src/index.ts";

const directories: string[] = [];
const T0 = "2026-11-01T00:00:00.000Z";
const T1 = "2026-11-02T00:00:00.000Z";
const OWNER = "owner-capture-backlog";
const AGENT = "agent-capture-backlog";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const LEDGER_TABLES = [
  "decision_ledger",
  "decision_signals",
  "source_insights",
  "proactive_processed_messages",
  "decision_ledger_payloads",
  "muse_reference_entries",
] as const;

type Database = ReturnType<typeof openQualifiedDatabase>;

function dumpLedgerTables(database: Database) {
  return {
    ...Object.fromEntries(
      LEDGER_TABLES.map((table) => [table, database.prepare(`SELECT * FROM ${table}`).all()]),
    ),
    schemaNames: database
      .prepare(
        `SELECT type, name, tbl_name FROM sqlite_master
         WHERE tbl_name IN (${LEDGER_TABLES.map(() => "?").join(", ")})
           AND type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_autoindex%'
           AND name NOT LIKE 'decision_ledger_known_kind%'
         ORDER BY name`,
      )
      .all(...LEDGER_TABLES),
  };
}

function seedLedger(database: Database) {
  database
    .prepare(
      `INSERT INTO payloads (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at, content_type)
       VALUES ('payload-x', ?, ?, 'private', 'sqlite_blob', X'00', 'sha256:x', 'fixture', 'fixture-key', 'active', ?, 'text/plain')`,
    )
    .run(OWNER, AGENT, T0);
  const insertDecision = database.prepare(
    `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, checked_at, counts, outcome, reason_code, inputs, cost_micros, duration_ms)
     VALUES (?, ?, ?, ?, ?, '{}', ?, 'seed', '{"memoryIds":[],"ruleIds":[]}', 0, 0)`,
  );
  insertDecision.run("d-old", OWNER, AGENT, "external_read", T0, "read");
  insertDecision.run("d-kept", OWNER, AGENT, "memory_candidate", T0, "kept");
  database
    .prepare(
      `INSERT INTO decision_signals (id, owner_id, agent_id, decision_id, signal, occurred_at, delay_ms, detail, source_ref, recorded_at)
       VALUES ('sig-1', ?, ?, 'd-old', 'opened', ?, 5, '{}', 'ref-1', ?)`,
    )
    .run(OWNER, AGENT, "2026-11-01T00:00:01.000Z", "2026-11-01T00:00:02.000Z");
  database
    .prepare(
      `INSERT INTO source_insights (id, owner_id, agent_id, source, thread_id, last_message_id, result,
        floor_raised, content_ref, due_at, priority, status, decision_id, owner_rating, push_source_key,
        created_at, updated_at, push_class)
       VALUES ('si-1', ?, ?, 'gmail', 't-1', 'm-1', 'act', 1, 'payload-x', ?, 'high', 'open', 'd-old', 'useful', 'k-1', ?, ?, 'pc')`,
    )
    .run(OWNER, AGENT, T1, T0, T0);
  database
    .prepare(
      `INSERT INTO proactive_processed_messages (owner_id, agent_id, source, message_id, thread_id,
        decision_id, outcome, skip_reason, header_ref, processed_at, reviewed_at, owner_rating, received_at)
       VALUES (?, ?, 'gmail', 'm-1', 't-1', 'd-old', 'act', NULL, 'payload-x', ?, ?, 'missed', ?)`,
    )
    .run(OWNER, AGENT, T0, T1, T0);
  database
    .prepare(
      `INSERT INTO decision_ledger_payloads (decision_id, sequence, role, payload_ref)
       VALUES ('d-old', 0, 'model_input', 'payload-x')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO muse_reference_entries (id, owner_id, agent_id, muse_at, muse_reminded, timing_ok,
        content_ok, content_ref, note_ref, paired_decision_id, intake_item_key, recorded_at, paired_message_id)
       VALUES ('muse-1', ?, ?, ?, 1, 1, 1, 'payload-x', 'payload-x', 'd-old', 'intake-1', ?, 'm-1')`,
    )
    .run(OWNER, AGENT, T0, T0);
}

async function openMigrated() {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-capture-backlog-"));
  directories.push(directory);
  const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
  const migrations = await loadBundledMigrations();
  const sequence = migrations.findIndex(({ name }) => name === "memory_capture_backlog");
  expect(sequence).toBeGreaterThan(0);
  applyMigrations(database, migrations.slice(0, sequence));
  database.pragma("foreign_keys = OFF");
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT, OWNER);
  database
    .prepare(
      `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
       VALUES ('thread-1', ?, ?, 0, 'open', ?, ?)`,
    )
    .run(OWNER, AGENT, T0, T0);
  seedLedger(database);
  const before = dumpLedgerTables(database);
  database.pragma("foreign_keys = ON");
  const snapshot = await createVerifiedMigrationSnapshot(
    database,
    path.join(directory, "snapshot.sqlite"),
  );
  applyMigrations(database, migrations, { snapshot });
  return { database, before };
}

function insertCaptureDecision(database: Database, id: string, outcome: string) {
  database
    .prepare(
      `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, checked_at, counts, outcome, reason_code, inputs, cost_micros, duration_ms)
       VALUES (?, ?, ?, 'memory_candidate', ?, '{}', ?, 'AI_GATEWAY_REQUEST_TIMEOUT', '{"memoryIds":[],"ruleIds":[]}', 0, 0)`,
    )
    .run(id, OWNER, AGENT, T1, outcome);
}

function insertBacklog(database: Database, generationId: string, sourceRunId: string) {
  database
    .prepare(
      `INSERT INTO memory_capture_backlog (generation_id, owner_id, agent_id, thread_id, source_run_id,
        attempts, last_error_code, created_at, updated_at)
       VALUES (?, ?, ?, 'thread-1', ?, 0, 'AI_GATEWAY_REQUEST_TIMEOUT', ?, ?)`,
    )
    .run(generationId, OWNER, AGENT, sourceRunId, T1, T1);
}

describe("memory capture backlog migration", () => {
  it("[P3-5] keeps every decision record and the six tables that point at it when the ledger is rebuilt", async () => {
    const { database, before } = await openMigrated();
    expect(dumpLedgerTables(database)).toEqual(before);
    expect(() => database.prepare("UPDATE decision_signals SET delay_ms = 9").run()).toThrow(
      /DECISION_SIGNAL_IMMUTABLE/u,
    );
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it.each(["capture_retrying", "capture_queued", "capture_gave_up"])(
    "[P3-5] accepts the %s outcome for a memory candidate",
    async (outcome) => {
      const { database } = await openMigrated();
      insertCaptureDecision(database, `d-${outcome}`, outcome);
      expect(
        database
          .prepare("SELECT outcome FROM decision_ledger WHERE id = ?")
          .pluck()
          .get(`d-${outcome}`),
      ).toBe(outcome);
      database.close();
    },
  );

  it("[P3-5] still rejects an outcome the memory candidate kind does not have", async () => {
    const { database } = await openMigrated();
    expect(() => insertCaptureDecision(database, "d-bad", "capture_lost")).toThrow(
      /DECISION_LEDGER_UNKNOWN_KIND_OR_OUTCOME/u,
    );
    database.close();
  });

  it("[P3-5] keeps one queued turn per run and drops it when its thread is deleted", async () => {
    const { database } = await openMigrated();
    insertBacklog(database, "memory-capture:run-1", "run-1");
    expect(() => insertBacklog(database, "memory-capture:other", "run-1")).toThrow(/UNIQUE/u);
    database.prepare("DELETE FROM threads WHERE id = 'thread-1'").run();
    expect(database.prepare("SELECT count(*) FROM memory_capture_backlog").pluck().get()).toBe(0);
    database.close();
  });
});
