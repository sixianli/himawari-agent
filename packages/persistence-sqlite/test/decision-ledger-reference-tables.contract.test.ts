import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DECISION_KINDS, DECISION_OUTCOMES } from "@himawari-agent/application/decision-ledger";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  createVerifiedMigrationSnapshot,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "../src/index.ts";

const directories: string[] = [];
const T0 = "2026-11-01T00:00:00.000Z";
const OWNER = "owner-reference-tables";
const AGENT = "agent-reference-tables";
const MIGRATION = "decision_ledger_reference_tables";

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
  return Object.fromEntries(
    TABLES.map((table) => [table, database.prepare(`SELECT * FROM ${table}`).all()]),
  );
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

async function openMigrated(options: { readonly allMigrations?: boolean } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-reference-tables-"));
  directories.push(directory);
  const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
  const migrations = await loadBundledMigrations();
  const sequence = migrations.findIndex(({ name }) => name === MIGRATION);
  expect(sequence).toBeGreaterThan(0);
  applyMigrations(database, migrations.slice(0, sequence));
  seed(database);
  const before = dump(database);
  const snapshot = await createVerifiedMigrationSnapshot(
    database,
    path.join(directory, "snapshot.sqlite"),
  );
  applyMigrations(database, options.allMigrations ? migrations : migrations.slice(0, sequence + 1), {
    snapshot,
  });
  return { database, before };
}

function insertDecision(database: Database, id: string, kind: string, outcome: string | null) {
  database
    .prepare(
      `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, scenario, verdict, checked_at, counts, outcome,
        reason_code, subject_ref, inputs, cost_micros, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, 'reason', 'memory-new', '{"memoryIds":[],"ruleIds":[]}', 0, 0)`,
    )
    .run(
      id,
      OWNER,
      AGENT,
      kind,
      kind === "proactive" ? "gmail" : null,
      kind === "proactive" ? "silent" : null,
      T0,
      outcome,
    );
}

describe("decision ledger reference tables migration", () => {
  it("keeps every decision record and the tables that point at it when the ledger is rebuilt", async () => {
    const { database, before } = await openMigrated();
    expect(dump(database)).toEqual(before);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(() => database.prepare("UPDATE decision_signals SET delay_ms = 9").run()).toThrow(
      /DECISION_SIGNAL_IMMUTABLE/u,
    );
    database.close();
  });

  it("holds exactly the kinds and outcomes the code knows", async () => {
    const { database } = await openMigrated({ allMigrations: true });
    expect(
      database.prepare("SELECT kind FROM decision_ledger_kinds ORDER BY kind").pluck().all(),
    ).toEqual([...DECISION_KINDS].sort());
    const expected = Object.entries(DECISION_OUTCOMES)
      .flatMap(([kind, outcomes]) => outcomes.map((outcome) => `${kind}/${outcome}`))
      .sort();
    expect(
      database
        .prepare("SELECT kind || '/' || outcome FROM decision_ledger_outcomes ORDER BY 1")
        .pluck()
        .all(),
    ).toEqual(expected);
    database.close();
  });

  it("keeps memory_review and rule_review rows when later migrations add kinds", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-reference-tables-"));
    directories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    const migrations = await loadBundledMigrations();
    const sequence = migrations.findIndex(({ name }) => name === MIGRATION);
    applyMigrations(database, migrations.slice(0, sequence + 1));
    seed(database);
    insertDecision(database, "d-memory-review", "memory_review", "flagged");
    insertDecision(database, "d-rule-review", "rule_review", "cleared");
    const snapshot = await createVerifiedMigrationSnapshot(
      database,
      path.join(directory, "snapshot.sqlite"),
    );
    applyMigrations(database, migrations, { snapshot });
    expect(
      database
        .prepare(
          "SELECT id, kind, outcome FROM decision_ledger WHERE id IN ('d-memory-review', 'd-rule-review') ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: "d-memory-review", kind: "memory_review", outcome: "flagged" },
      { id: "d-rule-review", kind: "rule_review", outcome: "cleared" },
    ]);
    insertDecision(database, "d-limit", "limit_change", "changed");
    insertDecision(database, "d-proposal", "proposal", "told");
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("rejects an unknown kind or outcome whether foreign keys are on or off", async () => {
    const { database } = await openMigrated();
    for (const foreignKeys of ["ON", "OFF"]) {
      database.pragma(`foreign_keys = ${foreignKeys}`);
      expect(() => insertDecision(database, `bad-kind-${foreignKeys}`, "invented", null)).toThrow();
      expect(() =>
        insertDecision(database, `bad-outcome-${foreignKeys}`, "consolidation", "invented"),
      ).toThrow(/DECISION_LEDGER_UNKNOWN_KIND_OR_OUTCOME|FOREIGN KEY/u);
      expect(() =>
        database
          .prepare("UPDATE decision_ledger SET outcome = 'invented' WHERE id = 'd-supersede'")
          .run(),
      ).toThrow(/DECISION_LEDGER_UNKNOWN_KIND_OR_OUTCOME|FOREIGN KEY/u);
      expect(() =>
        database
          .prepare("UPDATE decision_ledger SET kind = 'invented' WHERE id = 'd-supersede'")
          .run(),
      ).toThrow();
    }
    insertDecision(database, "good-proactive", "proactive", null);
    insertDecision(database, "good-hold", "consolidation", "hold");
    database.close();
  });

  it("accepts a new kind and outcome after one row is inserted each", async () => {
    const { database } = await openMigrated();
    expect(() => insertDecision(database, "d-new", "future_kind", "future_outcome")).toThrow();
    database.prepare("INSERT INTO decision_ledger_kinds (kind) VALUES ('future_kind')").run();
    expect(() => insertDecision(database, "d-new", "future_kind", "future_outcome")).toThrow();
    database
      .prepare(
        "INSERT INTO decision_ledger_outcomes (kind, outcome) VALUES ('future_kind', 'future_outcome')",
      )
      .run();
    insertDecision(database, "d-new", "future_kind", "future_outcome");
    database.close();
  });

  it("refuses to remove a kind or outcome a decision record still uses", async () => {
    const { database } = await openMigrated();
    expect(() =>
      database
        .prepare(
          "DELETE FROM decision_ledger_outcomes WHERE kind = 'consolidation' AND outcome = 'supersede'",
        )
        .run(),
    ).toThrow(/DECISION_LEDGER_OUTCOME_IN_USE/u);
    expect(() =>
      database.prepare("DELETE FROM decision_ledger_kinds WHERE kind = 'consolidation'").run(),
    ).toThrow(/DECISION_LEDGER_KIND_IN_USE/u);
    database.prepare("DELETE FROM decision_ledger_outcomes WHERE kind = 'external_read'").run();
    database.close();
  });

  it("refuses to remove or rename reference rows that are still referenced, with foreign keys off", async () => {
    const { database } = await openMigrated();
    database.pragma("foreign_keys = OFF");
    expect(() =>
      database.prepare("DELETE FROM decision_ledger_kinds WHERE kind = 'memory_review'").run(),
    ).toThrow(/DECISION_LEDGER_KIND_IN_USE/u);
    expect(() =>
      database
        .prepare("UPDATE decision_ledger_kinds SET kind = 'renamed' WHERE kind = 'memory_review'")
        .run(),
    ).toThrow(/DECISION_LEDGER_KIND_IN_USE/u);
    expect(() =>
      database
        .prepare(
          "UPDATE decision_ledger_outcomes SET outcome = 'renamed' WHERE kind = 'consolidation' AND outcome = 'supersede'",
        )
        .run(),
    ).toThrow(/DECISION_LEDGER_OUTCOME_IN_USE/u);
    database.close();
  });
});
