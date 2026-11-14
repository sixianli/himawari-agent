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
const T1 = "2026-11-01T00:00:01.000Z";
const OWNER = "owner-source-registry";
const AGENT = "agent-source-registry";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const TABLES = [
  "decision_ledger",
  "decision_ledger_payloads",
  "decision_signals",
  "decision_prereviews",
  "muse_reference_entries",
  "proactive_push_backoff",
  "proactive_connections",
  "proactive_processed_messages",
  "source_insights",
] as const;

type Database = ReturnType<typeof openQualifiedDatabase>;

function rows(database: Database) {
  return Object.fromEntries(
    TABLES.map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}

function insertLedgerOutcome(
  database: Database,
  kind: string,
  outcome: string,
  prefix = "before",
): string {
  const id = `${prefix}-${kind}-${outcome}`;
  database
    .prepare(
      `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, checked_at, counts, outcome,
        reason_code, inputs, cost_micros, duration_ms)
       VALUES (?, ?, ?, ?, ?, '{}', ?, 'FIXTURE', '{"memoryIds":[],"ruleIds":[]}', 0, 0)`,
    )
    .run(id, OWNER, AGENT, kind, T1, outcome);
  return id;
}

function insertEveryAcceptedOutcome(database: Database): readonly string[] {
  const pairs = database
    .prepare("SELECT kind, outcome FROM decision_ledger_outcomes ORDER BY kind, outcome")
    .all() as { kind: string; outcome: string }[];
  return pairs.map(({ kind, outcome }) => insertLedgerOutcome(database, kind, outcome));
}

function schema(database: Database) {
  return database
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE tbl_name IN (${TABLES.map(() => "?").join(", ")})
         AND name NOT LIKE 'sqlite_autoindex%'
       ORDER BY name`,
    )
    .all(...TABLES)
    .map((row) => {
      const entry = row as { name: string; sql: string | null };
      return { ...entry, sql: entry.sql?.replace(/\s+/gu, " ") ?? null };
    });
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
  database
    .prepare(
      `INSERT INTO proactive_connections (owner_id, agent_id, source, account_ref, token_ref, cursor,
        status, connected_at, updated_at)
       VALUES (?, ?, 'gmail', 'payload-x', 'payload-x', 'history-7', 'needs_reconnect', ?, ?)`,
    )
    .run(OWNER, AGENT, T0, T1);
  database
    .prepare(
      `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict,
        outcome, reason_code, subject_ref, inputs, reason_ref, content_ref, push_source_key,
        cost_micros, duration_ms, owner_rating, rated_at)
       VALUES ('d-mail', ?, ?, 'proactive', 'gmail', ?, '{"fetched":2}', 'pushed', NULL, 'URGENT',
        NULL, '{"memoryIds":[],"ruleIds":["r-1"]}', NULL, NULL, 'proactive:push-1', 321, 45, 'useful', ?)`,
    )
    .run(OWNER, AGENT, T0, T1);
  database
    .prepare(
      `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, checked_at, counts, outcome, reason_code,
        subject_ref, inputs, reason_ref, content_ref, cost_micros, duration_ms, category,
        confidence_permille, inferred)
       VALUES ('d-memory', ?, ?, 'memory_candidate', ?, '{}', 'kept', 'kept_fact', 'memory-1',
        '{"memoryIds":[],"ruleIds":[]}', 'payload-x', 'payload-x', 7, 9, 'preference', 870, 1)`,
    )
    .run(OWNER, AGENT, T1);
  database
    .prepare(
      `INSERT INTO decision_ledger_payloads (decision_id, sequence, role, payload_ref)
       VALUES ('d-mail', 0, 'model_input', 'payload-x'), ('d-mail', 1, 'model_output', 'payload-x')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO proactive_processed_messages (owner_id, agent_id, source, message_id, thread_id,
        decision_id, outcome, skip_reason, header_ref, processed_at, reviewed_at, owner_rating, received_at)
       VALUES (?, ?, 'gmail', 'm-1', 't-1', 'd-mail', 'act', NULL, NULL, ?, NULL, NULL, ?),
              (?, ?, 'gmail', 'm-2', 't-2', 'd-mail', 'skipped', 'category', 'payload-x', ?, ?, 'missed', NULL)`,
    )
    .run(OWNER, AGENT, T0, T0, OWNER, AGENT, T0, T1);
  database
    .prepare(
      `INSERT INTO source_insights (id, owner_id, agent_id, source, thread_id, last_message_id, result,
        floor_raised, content_ref, due_at, priority, status, decision_id, owner_rating, push_source_key,
        created_at, updated_at, push_class)
       VALUES ('si-1', ?, ?, 'gmail', 't-1', 'm-1', 'act', 1, 'payload-x', ?, 'high', 'open', 'd-mail',
        'useful', 'proactive:push-1', ?, ?, 'due:example.com')`,
    )
    .run(OWNER, AGENT, T1, T0, T1);
  database
    .prepare(
      `INSERT INTO decision_signals (id, owner_id, agent_id, decision_id, signal, occurred_at, delay_ms,
        detail, source_ref, recorded_at)
       VALUES ('sig-1', ?, ?, 'd-mail', 'replied', ?, 5, '{}', 'si-1@x', ?)`,
    )
    .run(OWNER, AGENT, T1, T1);
  database
    .prepare(
      `INSERT INTO proactive_push_backoff (owner_id, agent_id, class_key, stage, since_at,
        step_decision_id, ignored_count, updated_at)
       VALUES (?, ?, 'due:example.com', 1, ?, 'd-mail', 3, ?)`,
    )
    .run(OWNER, AGENT, T0, T1);
  database
    .prepare(
      `INSERT INTO muse_reference_entries (id, owner_id, agent_id, muse_at, muse_reminded, timing_ok,
        content_ok, content_ref, note_ref, paired_decision_id, intake_item_key, recorded_at, paired_message_id)
       VALUES ('muse-1', ?, ?, ?, 1, 1, 0, 'payload-x', NULL, 'd-mail', 'intake-1', ?, 'm-1')`,
    )
    .run(OWNER, AGENT, T0, T1);
  const digest = "a".repeat(64);
  database
    .prepare(
      `INSERT INTO decision_prereviews (id, owner_id, agent_id, decision_id, mail_source, message_id,
        calibration_group, category, status, rating, confidence_permille, history_conflict,
        failure_code, model_ref, prompt_id, text_digest, data_classification, cost_micros, duration_ms,
        created_at)
       VALUES ('pre-decision', ?, ?, 'd-mail', NULL, NULL, 'proactive_pushed', NULL, 'done', 'useful',
        900, 0, NULL, 'model-a', 'prompt-a', ?, 'private', 3, 4, ?),
              ('pre-mail', ?, ?, NULL, 'gmail', 'm-2', 'proactive_silent', NULL, 'failed', NULL,
        NULL, NULL, 'MODEL_FAILED', 'model-a', 'prompt-a', ?, 'private', 0, 1, ?)`,
    )
    .run(OWNER, AGENT, digest, T1, OWNER, AGENT, digest, T1);
}

async function openMigrated(extra: (database: Database) => void = () => undefined) {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-source-registry-"));
  directories.push(directory);
  const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
  const migrations = await loadBundledMigrations();
  const sequence = migrations.findIndex(({ name }) => name === "proactive_source_registry");
  expect(sequence).toBeGreaterThan(0);
  applyMigrations(database, migrations.slice(0, sequence));
  seed(database);
  extra(database);
  const before = { rows: rows(database), schema: schema(database) };
  const snapshot = await createVerifiedMigrationSnapshot(
    database,
    path.join(directory, "snapshot.sqlite"),
  );
  applyMigrations(database, migrations.slice(0, sequence + 1), { snapshot });
  return { database, before };
}

const NAME_CHECK = (column: string) =>
  `length(${column}) BETWEEN 1 AND 64 AND ${column} GLOB '[a-z]*' AND ${column} NOT GLOB '*[^a-z0-9_]*'`;

function withGmailConstraint(sql: string | null): string | null {
  return (
    sql
      ?.replace(
        `agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, source TEXT NOT NULL CHECK ( ${NAME_CHECK("source")} ), class_key`,
        "agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, class_key",
      )
      .replace(
        "PRIMARY KEY (owner_id, agent_id, source, class_key)",
        "PRIMARY KEY (owner_id, agent_id, class_key)",
      )
      .replaceAll(`( ${NAME_CHECK("source")} )`, "(source IN ('gmail'))")
      .replace(
        `( scenario IS NULL OR (${NAME_CHECK("scenario")}) )`,
        "(scenario IS NULL OR scenario IN ('gmail'))",
      )
      .replace(
        `( mail_source IS NULL OR (${NAME_CHECK("mail_source")}) )`,
        "(mail_source IS NULL OR mail_source IN ('gmail'))",
      ) ?? null
  );
}

describe("[iOS-7] proactive source registry migration", () => {
  it("[iOS-7] keeps every row of every rebuilt table with the same values", async () => {
    const { database, before } = await openMigrated();
    const after = rows(database);
    for (const table of TABLES) {
      expect((before.rows[table] as unknown[]).length, table).toBeGreaterThan(0);
      expect(
        table === "proactive_push_backoff"
          ? (after[table] as Record<string, unknown>[]).map(({ source, ...kept }) => {
              expect(source).toBe("gmail");
              return kept;
            })
          : after[table],
        table,
      ).toEqual(before.rows[table]);
    }
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("[iOS-7] changes nothing in the rebuilt tables except the source name constraints and the source column on backoff", async () => {
    const { database, before } = await openMigrated();
    const after = schema(database);
    expect(after.map(({ name }) => name)).toEqual(before.schema.map(({ name }) => name));
    expect(after.map((entry) => ({ ...entry, sql: withGmailConstraint(entry.sql) }))).toEqual(
      before.schema,
    );
    expect(after.some(({ sql }) => sql?.includes("'gmail'"))).toBe(false);
    database.close();
  });

  it("[iOS-7] keeps every decision kind and outcome the ledger accepted before, rows and all", async () => {
    let accepted: readonly string[] = [];
    const { database } = await openMigrated((opened) => {
      accepted = insertEveryAcceptedOutcome(opened);
    });
    expect(accepted.length).toBeGreaterThan(30);
    const kept = database
      .prepare("SELECT id FROM decision_ledger WHERE reason_code = 'FIXTURE' ORDER BY id")
      .pluck()
      .all();
    expect(kept).toEqual([...accepted].sort());
    for (const [kind, outcome] of [
      ["memory_review", "flagged"],
      ["rule_review", "cleared"],
      ["rule_review", "owner_restored"],
    ] as const)
      expect(
        () => insertLedgerOutcome(database, kind, outcome, "after"),
        `${kind}/${outcome}`,
      ).not.toThrow();
    expect(() => insertLedgerOutcome(database, "memory_review", "owner_forgot", "after")).toThrow(
      /DECISION_LEDGER_UNKNOWN_KIND_OR_OUTCOME/u,
    );
    database.close();
  });

  it("[iOS-7] keeps the triggers that protect prereviews and signals", async () => {
    const { database } = await openMigrated();
    expect(() => database.prepare("UPDATE decision_prereviews SET cost_micros = 9").run()).toThrow(
      /DECISION_PREREVIEW_IMMUTABLE/u,
    );
    expect(() => database.prepare("UPDATE decision_signals SET delay_ms = 9").run()).toThrow(
      /DECISION_SIGNAL_IMMUTABLE/u,
    );
    database.close();
  });

  it("[iOS-7] accepts another well-formed source name and still refuses a malformed one", async () => {
    const { database } = await openMigrated();
    const connect = database.prepare(
      `INSERT INTO proactive_connections (owner_id, agent_id, source, account_ref, token_ref, cursor,
        status, connected_at, updated_at)
       VALUES (?, ?, ?, 'payload-x', 'payload-x', NULL, 'connected', ?, ?)`,
    );
    expect(() => connect.run(OWNER, AGENT, "test_notes", T0, T0)).not.toThrow();
    for (const bad of ["", "Gmail", "9lives", "has space", "x".repeat(65)])
      expect(() => connect.run(OWNER, AGENT, bad, T0, T0), bad).toThrow(/CHECK constraint/u);
    const settings = database.prepare(
      `INSERT INTO proactive_source_settings (owner_id, agent_id, source, enabled, per_day, per_check,
        updated_at) VALUES (?, ?, ?, 1, ?, 5, ?)`,
    );
    expect(() => settings.run(OWNER, AGENT, "gmail", 10, T0)).not.toThrow();
    expect(() => settings.run(OWNER, AGENT, "test_notes", 0, T0)).toThrow(/CHECK constraint/u);
    database.close();
  });
});
