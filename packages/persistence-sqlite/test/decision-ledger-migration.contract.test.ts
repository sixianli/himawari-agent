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

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const T0 = "2026-10-31T00:00:00.000Z";

describe("decision ledger migration 0069", () => {
  it("keeps Gmail decisions, insights and processed messages and repoints their foreign keys", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-decision-ledger-"));
    directories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    try {
      const migrations = await loadBundledMigrations();
      applyMigrations(database, migrations.slice(0, 68));
      database.prepare("INSERT INTO owners (id, revision) VALUES ('o', 0)").run();
      database.prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('a', 'o', 0)").run();
      database
        .prepare(
          `INSERT INTO payloads (
            ref, owner_id, agent_id, classification, storage_kind, ciphertext, content_digest,
            encryption_algorithm, key_ref, lifecycle_state, created_at, content_type
          ) VALUES ('p1', 'o', 'a', 'private', 'sqlite_blob', X'00', 'sha256:p1', 'fixture',
            'fixture-key', 'active', ?, 'text/plain')`,
        )
        .run(T0);
      database
        .prepare(
          `INSERT INTO proactive_decisions (
            id, owner_id, agent_id, scenario, checked_at, counts, verdict, reason_code,
            push_source_key, cost_micros, duration_ms, owner_rating, rated_at
          ) VALUES ('d1', 'o', 'a', 'gmail', ?, '{"fetched":2}', 'pushed', 'model_judged',
            'push-key', 1234, 56, 'useful', ?)`,
        )
        .run(T0, T0);
      database
        .prepare(
          `INSERT INTO source_insights (
            id, owner_id, agent_id, source, thread_id, last_message_id, result, floor_raised,
            content_ref, due_at, priority, status, decision_id, owner_rating, push_source_key,
            created_at, updated_at
          ) VALUES ('i1', 'o', 'a', 'gmail', 't1', 'm1', 'act', 1, 'p1', NULL, 'high', 'open',
            'd1', 'missed', NULL, ?, ?)`,
        )
        .run(T0, T0);
      database
        .prepare(
          `INSERT INTO proactive_processed_messages (
            owner_id, agent_id, source, message_id, thread_id, decision_id, outcome, skip_reason,
            header_ref, processed_at, reviewed_at, owner_rating
          ) VALUES ('o', 'a', 'gmail', 'm1', 't1', 'd1', 'act', NULL, 'p1', ?, NULL, NULL)`,
        )
        .run(T0);
      const snapshot = await createVerifiedMigrationSnapshot(
        database,
        path.join(directory, "pre-migration.sqlite"),
      );
      expect(
        applyMigrations(database, migrations.slice(0, 69), { snapshot }).appliedSequences,
      ).toEqual([69]);

      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(
        database
          .prepare(
            `SELECT id, kind, scenario, verdict, outcome, reason_code AS reasonCode, counts,
              push_source_key AS pushSourceKey, cost_micros AS costMicros, duration_ms AS durationMs,
              owner_rating AS ownerRating, rated_at AS ratedAt, inputs
             FROM decision_ledger`,
          )
          .all(),
      ).toEqual([
        {
          id: "d1",
          kind: "proactive",
          scenario: "gmail",
          verdict: "pushed",
          outcome: null,
          reasonCode: "model_judged",
          counts: '{"fetched":2}',
          pushSourceKey: "push-key",
          costMicros: 1234,
          durationMs: 56,
          ownerRating: "useful",
          ratedAt: T0,
          inputs: "{}",
        },
      ]);
      expect(
        database
          .prepare("SELECT id, decision_id AS d, owner_rating AS r FROM source_insights")
          .all(),
      ).toEqual([{ id: "i1", d: "d1", r: "missed" }]);
      expect(
        database
          .prepare("SELECT message_id AS m, decision_id AS d FROM proactive_processed_messages")
          .all(),
      ).toEqual([{ m: "m1", d: "d1" }]);
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE name = 'proactive_decisions'").all(),
      ).toEqual([]);
      expect(
        database
          .prepare("SELECT name FROM sqlite_master WHERE name LIKE '%\\_keep' ESCAPE '\\'")
          .all(),
      ).toEqual([]);

      database.prepare("DELETE FROM decision_ledger WHERE id = 'd1'").run();
      expect(database.prepare("SELECT count(*) FROM source_insights").pluck().get()).toBe(0);
      expect(
        database.prepare("SELECT count(*) FROM proactive_processed_messages").pluck().get(),
      ).toBe(0);
    } finally {
      database.close();
    }
  });

  it("only accepts outcomes that belong to the decision kind", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-decision-ledger-"));
    directories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    try {
      applyMigrations(database, await loadBundledMigrations());
      database.prepare("INSERT INTO owners (id, revision) VALUES ('o', 0)").run();
      database.prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('a', 'o', 0)").run();
      const insert = (
        kind: string,
        outcome: string | null,
        verdict: string | null,
        scenario: string | null,
      ) =>
        database
          .prepare(
            `INSERT INTO decision_ledger (
              id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict, outcome,
              reason_code, inputs, cost_micros, duration_ms
            ) VALUES (?, 'o', 'a', ?, ?, ?, '{}', ?, ?, 'r', '{}', 0, 0)`,
          )
          .run(`${kind}-${outcome}-${verdict}`, kind, scenario, T0, verdict, outcome);
      expect(() => insert("memory_candidate", "kept", null, null)).not.toThrow();
      expect(() => insert("consolidation", "merge", null, null)).not.toThrow();
      expect(() => insert("proactive", null, "silent", "gmail")).not.toThrow();
      expect(() => insert("memory_candidate", "merge", null, null)).toThrow();
      expect(() => insert("consolidation", "kept", null, null)).toThrow();
      expect(() => insert("proactive", "kept", "silent", "gmail")).toThrow();
      expect(() => insert("memory_candidate", "kept", "silent", null)).toThrow();
      expect(() => insert("external_read", "kept", null, null)).toThrow();
      expect(() => insert("rule_review", "needs_review", null, null)).not.toThrow();
      expect(() => insert("rule_review", "kept", null, null)).toThrow();
      expect(() => insert("memory_candidate", "needs_review", null, null)).toThrow();
      expect(() => insert("unknown_kind", "kept", null, null)).toThrow();
    } finally {
      database.close();
    }
  });

  it("limits candidate columns to memory candidates and to valid values", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-decision-ledger-"));
    directories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    try {
      applyMigrations(database, await loadBundledMigrations());
      database.prepare("INSERT INTO owners (id, revision) VALUES ('o', 0)").run();
      database.prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('a', 'o', 0)").run();
      let counter = 0;
      const nextCounter = () => {
        counter += 1;
        return counter;
      };
      const insert = (
        kind: string,
        outcome: string,
        category: string | null,
        confidence: number | null,
        inferred: number | null,
      ) =>
        database
          .prepare(
            `INSERT INTO decision_ledger (
              id, owner_id, agent_id, kind, checked_at, counts, outcome, reason_code, inputs,
              cost_micros, duration_ms, category, confidence_permille, inferred
            ) VALUES (?, 'o', 'a', ?, ?, '{}', ?, 'r', '{}', 0, 0, ?, ?, ?)`,
          )
          .run(`row-${nextCounter()}`, kind, T0, outcome, category, confidence, inferred);
      expect(() => insert("memory_candidate", "kept", "preference", 700, 1)).not.toThrow();
      expect(() => insert("memory_candidate", "discarded", null, null, null)).not.toThrow();
      expect(() => insert("memory_candidate", "kept", "other", 0, 0)).not.toThrow();
      expect(() => insert("memory_candidate", "kept", "other", 1000, 0)).not.toThrow();
      expect(() => insert("memory_candidate", "kept", "hobby", null, null)).toThrow();
      expect(() => insert("memory_candidate", "kept", null, 1001, null)).toThrow();
      expect(() => insert("memory_candidate", "kept", null, -1, null)).toThrow();
      expect(() => insert("memory_candidate", "kept", null, null, 2)).toThrow();
      expect(() => insert("consolidation", "merge", "preference", null, null)).toThrow();
      expect(() => insert("consolidation", "merge", null, 500, null)).toThrow();
      expect(() => insert("consolidation", "merge", null, null, 1)).toThrow();
      expect(() => insert("consolidation", "merge", null, null, null)).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("drops the Muse comparison tables and their pushes and keeps every other push", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-drop-muse-"));
    directories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    try {
      const migrations = await loadBundledMigrations();
      const sequence = migrations.findIndex(({ name }) => name === "drop_muse_comparison");
      expect(sequence).toBeGreaterThan(0);
      applyMigrations(database, migrations.slice(0, sequence));
      database.prepare("INSERT INTO owners (id, revision) VALUES ('o', 0)").run();
      database.prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('a', 'o', 0)").run();
      database
        .prepare(
          `INSERT INTO muse_reference_entries (id, owner_id, agent_id, muse_at, muse_reminded, recorded_at)
           VALUES ('muse-1', 'o', 'a', ?, 0, ?)`,
        )
        .run(T0, T0);
      const insertOutbox = database.prepare(
        `INSERT INTO web_push_outbox (
          owner_id, agent_id, source_key, kind, source_ref, thread_id, created_at, expires_at
        ) VALUES ('o', 'a', ?, 'reminder', ?, NULL, ?, ?)`,
      );
      insertOutbox.run("muse-channel:down:1", "muse-channel", T0, T0);
      insertOutbox.run("reminder:r1", "r1", T0, T0);
      database.pragma("foreign_keys = ON");
      const snapshot = await createVerifiedMigrationSnapshot(
        database,
        path.join(directory, "snapshot.sqlite"),
      );
      applyMigrations(database, migrations, { snapshot });
      const left = database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE name LIKE 'muse%' OR name LIKE 'gap_case%' ORDER BY name`,
        )
        .all();
      expect(left).toEqual([]);
      expect(
        database.prepare("SELECT source_key AS key FROM web_push_outbox ORDER BY key").all(),
      ).toEqual([{ key: "reminder:r1" }]);
    } finally {
      database.close();
    }
  });

  it("migration 0073 adds a nullable paired mail column and keeps existing Muse entries", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-muse-paired-message-"));
    directories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    try {
      const migrations = await loadBundledMigrations();
      const before = migrations.findIndex((migration) => migration.sequence === 73);
      expect(before).toBeGreaterThan(0);
      applyMigrations(database, migrations.slice(0, before));
      database.prepare("INSERT INTO owners (id, revision) VALUES ('o', 0)").run();
      database.prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('a', 'o', 0)").run();
      database
        .prepare(
          `INSERT INTO muse_reference_entries (id, owner_id, agent_id, muse_at, muse_reminded, recorded_at)
           VALUES ('old', 'o', 'a', ?, 0, ?)`,
        )
        .run(T0, T0);
      const snapshot = await createVerifiedMigrationSnapshot(
        database,
        path.join(directory, "pre-0073.sqlite"),
      );
      expect(
        applyMigrations(database, migrations.slice(0, before + 1), { snapshot }).appliedSequences,
      ).toEqual([73]);
      const row = database
        .prepare(
          "SELECT paired_message_id AS pairedMessageId FROM muse_reference_entries WHERE id = 'old'",
        )
        .get() as { pairedMessageId: string | null };
      expect(row.pairedMessageId).toBeNull();
      const insert = (id: string, value: string) =>
        database
          .prepare(
            `INSERT INTO muse_reference_entries (id, owner_id, agent_id, muse_at, muse_reminded, paired_message_id, recorded_at)
             VALUES (?, 'o', 'a', ?, 0, ?, ?)`,
          )
          .run(id, T0, value, T0);
      expect(() => insert("ok", "gmail-message-1")).not.toThrow();
      expect(() => insert("empty", "")).toThrow();
      expect(() => insert("long", "x".repeat(257))).toThrow();
    } finally {
      database.close();
    }
  });
});
