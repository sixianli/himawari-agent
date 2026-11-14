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
const OWNER = "owner-consolidation-hold";
const AGENT = "agent-consolidation-hold";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const TABLES = [
  "decision_ledger",
  "decision_signals",
  "proactive_push_backoff",
  "source_insights",
  "proactive_processed_messages",
  "decision_ledger_payloads",
  "muse_reference_entries",
  "memory_consolidation_runs",
  "memory_consolidation_changes",
  "memory_consolidation_change_basis",
] as const;

type Database = ReturnType<typeof openQualifiedDatabase>;

function dump(database: Database) {
  return {
    ...Object.fromEntries(
      TABLES.map((table) => [table, database.prepare(`SELECT * FROM ${table}`).all()]),
    ),
    schemaNames: database
      .prepare(
        `SELECT type, name, tbl_name, sql FROM sqlite_master
         WHERE tbl_name IN (${TABLES.map(() => "?").join(", ")})
           AND name NOT LIKE 'sqlite_autoindex%'
         ORDER BY name`,
      )
      .all(...TABLES)
      .map((row) => {
        const entry = row as { sql: string | null };
        return {
          ...entry,
          sql: entry.sql
            ?.replace(/\s+/gu, " ")
            .replace(/, 'hold'/gu, "")
            .replace(/, 'web_push'/gu, "")
            .replace(/ OR \(kind = 'web_push' AND outcome = 'deferred'\)/gu, ""),
        };
      }),
  };
}

function seed(database: Database) {
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT, OWNER);
  database
    .prepare(
      `INSERT INTO payloads (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at, content_type)
       VALUES ('payload-x', ?, ?, 'private', 'sqlite_blob', X'00', 'sha256:x', 'fixture', 'fixture-key', 'active', ?, 'text/plain')`,
    )
    .run(OWNER, AGENT, T0);
  const insertMemory = database.prepare(
    `INSERT INTO memory_records (id, owner_id, agent_id, revision, status, content_ref, classification,
      inference, confidence_permille, policy_version, updated_at)
     VALUES (?, ?, ?, 1, 'active', 'payload-x', 'private', 0, 1000, 'memory-policy-v1', ?)`,
  );
  insertMemory.run("memory-old", OWNER, AGENT, T0);
  insertMemory.run("memory-new", OWNER, AGENT, T0);
  database
    .prepare(
      `INSERT INTO memory_consolidation_runs (id, owner_id, agent_id, day, trigger_run_id, status,
        reviewed_through, model_called, change_count, error_code, started_at, finished_at)
       VALUES ('run-1', ?, ?, '2026-11-01', 'trigger-1', 'completed', ?, 1, 1, NULL, ?, ?)`,
    )
    .run(OWNER, AGENT, T0, T0, T0);
  database
    .prepare(
      `INSERT INTO memory_consolidation_changes (id, consolidation_id, owner_id, agent_id, memory_id,
        related_memory_id, action, before_revision, after_revision, before_status,
        before_superseded_by, before_valid_to, created_at, undone_at)
       VALUES ('change-1', 'run-1', ?, ?, 'memory-old', 'memory-new', 'supersede', 1, 2, 'active',
        NULL, NULL, ?, NULL)`,
    )
    .run(OWNER, AGENT, T0);
  database
    .prepare(
      `INSERT INTO memory_consolidation_change_basis (change_id, position, memory_id)
       VALUES ('change-1', 0, 'memory-old'), ('change-1', 1, 'memory-new')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, checked_at, counts, outcome, reason_code,
        subject_ref, inputs, cost_micros, duration_ms, owner_rating, rated_at)
       VALUES ('d-supersede', ?, ?, 'consolidation', ?, '{}', 'supersede', 'consolidation_supersede',
        'memory-old', '{"memoryIds":["memory-old","memory-new"],"ruleIds":[],"resultMemoryIds":["memory-new"]}',
        0, 0, 'useful', ?)`,
    )
    .run(OWNER, AGENT, T0, T0);
  database
    .prepare(
      `INSERT INTO decision_signals (id, owner_id, agent_id, decision_id, signal, occurred_at, delay_ms, detail, source_ref, recorded_at)
       VALUES ('sig-1', ?, ?, 'd-supersede', 'undone', ?, 5, '{}', 'ref-1', ?)`,
    )
    .run(OWNER, AGENT, "2026-11-01T00:00:01.000Z", "2026-11-01T00:00:02.000Z");
  database
    .prepare(
      `INSERT INTO proactive_push_backoff (owner_id, agent_id, class_key, stage, since_at, step_decision_id, ignored_count, updated_at)
       VALUES (?, ?, 'c', 1, ?, 'd-supersede', 3, ?)`,
    )
    .run(OWNER, AGENT, T0, T0);
  database
    .prepare(
      `INSERT INTO source_insights (id, owner_id, agent_id, source, thread_id, last_message_id, result,
        floor_raised, content_ref, due_at, priority, status, decision_id, owner_rating, push_source_key,
        created_at, updated_at, push_class)
       VALUES ('si-1', ?, ?, 'gmail', 't-1', 'm-1', 'act', 1, 'payload-x', ?, 'high', 'open', 'd-supersede', 'useful', 'k-1', ?, ?, 'pc')`,
    )
    .run(OWNER, AGENT, T0, T0, T0);
  database
    .prepare(
      `INSERT INTO proactive_processed_messages (owner_id, agent_id, source, message_id, thread_id,
        decision_id, outcome, skip_reason, header_ref, processed_at, reviewed_at, owner_rating, received_at)
       VALUES (?, ?, 'gmail', 'm-1', 't-1', 'd-supersede', 'act', NULL, 'payload-x', ?, ?, 'missed', ?)`,
    )
    .run(OWNER, AGENT, T0, T0, T0);
  database
    .prepare(
      `INSERT INTO decision_ledger_payloads (decision_id, sequence, role, payload_ref)
       VALUES ('d-supersede', 0, 'model_input', 'payload-x')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO muse_reference_entries (id, owner_id, agent_id, muse_at, muse_reminded, timing_ok,
        content_ok, content_ref, note_ref, paired_decision_id, intake_item_key, recorded_at, paired_message_id)
       VALUES ('muse-1', ?, ?, ?, 1, 1, 1, 'payload-x', 'payload-x', 'd-supersede', 'intake-1', ?, 'm-1')`,
    )
    .run(OWNER, AGENT, T0, T0);
}

async function openMigrated() {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-consolidation-hold-"));
  directories.push(directory);
  const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
  const migrations = await loadBundledMigrations();
  const sequence = migrations.findIndex(({ name }) => name === "consolidation_hold");
  expect(sequence).toBeGreaterThan(0);
  applyMigrations(database, migrations.slice(0, sequence));
  seed(database);
  const before = dump(database);
  const snapshot = await createVerifiedMigrationSnapshot(
    database,
    path.join(directory, "snapshot.sqlite"),
  );
  applyMigrations(database, migrations.slice(0, sequence + 1), { snapshot });
  return { database, before };
}

function insertHold(database: Database, action: string) {
  database
    .prepare(
      `INSERT INTO memory_consolidation_changes (id, consolidation_id, owner_id, agent_id, memory_id,
        related_memory_id, action, before_revision, after_revision, before_status,
        before_superseded_by, before_valid_to, created_at, undone_at)
       VALUES (?, 'run-1', ?, ?, 'memory-new', 'memory-old', ?, 1, 2, 'active', NULL, NULL, ?, NULL)`,
    )
    .run(`change-${action}`, OWNER, AGENT, action, T0);
  database
    .prepare(
      `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, checked_at, counts, outcome, reason_code,
        subject_ref, inputs, cost_micros, duration_ms)
       VALUES (?, ?, ?, 'consolidation', ?, '{}', ?, ?, 'memory-new', '{"memoryIds":[],"ruleIds":[]}', 0, 0)`,
    )
    .run(`d-${action}`, OWNER, AGENT, T0, action, `consolidation_${action}`);
}

describe("consolidation hold migration", () => {
  it("[P3-8] keeps every consolidation change, its basis, every decision record and the six tables that point at it when the tables are rebuilt", async () => {
    const { database, before } = await openMigrated();
    expect(dump(database)).toEqual(before);
    expect(() => database.prepare("UPDATE decision_signals SET delay_ms = 9").run()).toThrow(
      /DECISION_SIGNAL_IMMUTABLE/u,
    );
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(database.prepare("SELECT count(*) FROM source_insights").pluck().get()).toBe(1);
    database.prepare("DELETE FROM memory_consolidation_changes WHERE id = 'change-1'").run();
    expect(
      database.prepare("SELECT count(*) FROM memory_consolidation_change_basis").pluck().get(),
    ).toBe(0);
    database.close();
  });

  it("[P3-8] accepts a hold change and a hold decision record", async () => {
    const { database } = await openMigrated();
    insertHold(database, "hold");
    expect(
      database
        .prepare("SELECT action FROM memory_consolidation_changes WHERE id = 'change-hold'")
        .pluck()
        .get(),
    ).toBe("hold");
    expect(
      database.prepare("SELECT outcome FROM decision_ledger WHERE id = 'd-hold'").pluck().get(),
    ).toBe("hold");
    database.close();
  });

  it("[P3-8] still rejects a consolidation action it does not know", async () => {
    const { database } = await openMigrated();
    expect(() => insertHold(database, "pending")).toThrow(/CHECK/u);
    expect(() =>
      database
        .prepare(
          `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, checked_at, counts, outcome, reason_code,
            subject_ref, inputs, cost_micros, duration_ms)
           VALUES ('d-pending', ?, ?, 'consolidation', ?, '{}', 'pending', 'consolidation_pending',
            'memory-new', '{"memoryIds":[],"ruleIds":[]}', 0, 0)`,
        )
        .run(OWNER, AGENT, T0),
    ).toThrow(/CHECK/u);
    database.close();
  });
});
