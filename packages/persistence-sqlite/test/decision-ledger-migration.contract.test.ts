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

  it("keeps Muse entries in the two allowed shapes and makes intake keys unique", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-decision-ledger-"));
    directories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    try {
      applyMigrations(database, await loadBundledMigrations());
      database.prepare("INSERT INTO owners (id, revision) VALUES ('o', 0), ('o2', 0)").run();
      database
        .prepare(
          "INSERT INTO agents (id, owner_id, revision) VALUES ('a', 'o', 0), ('a2', 'o2', 0)",
        )
        .run();
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
          `INSERT INTO decision_ledger (
            id, owner_id, agent_id, kind, checked_at, counts, outcome, reason_code, inputs,
            cost_micros, duration_ms
          ) VALUES ('d1', 'o', 'a', 'consolidation', ?, '{}', 'merge', 'r', '{}', 0, 0)`,
        )
        .run(T0);
      let counter = 0;
      const nextCounter = () => {
        counter += 1;
        return counter;
      };
      const insert = (input: {
        owner?: string;
        agent?: string;
        reminded: number;
        timing?: number | null;
        content?: number | null;
        contentRef?: string | null;
        paired?: string | null;
        key?: string | null;
      }) =>
        database
          .prepare(
            `INSERT INTO muse_reference_entries (
              id, owner_id, agent_id, muse_at, muse_reminded, timing_ok, content_ok, content_ref,
              paired_decision_id, intake_item_key, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            `muse-${nextCounter()}`,
            input.owner ?? "o",
            input.agent ?? "a",
            T0,
            input.reminded,
            input.timing ?? null,
            input.content ?? null,
            input.contentRef ?? null,
            input.paired ?? null,
            input.key ?? null,
            T0,
          );
      expect(() =>
        insert({ reminded: 1, timing: 1, content: 0, contentRef: "p1", paired: "d1" }),
      ).not.toThrow();
      expect(() => insert({ reminded: 0, paired: "d1" })).not.toThrow();
      expect(() => insert({ reminded: 1, timing: 1, content: 1 })).toThrow();
      expect(() => insert({ reminded: 1, timing: null, content: 1, contentRef: "p1" })).toThrow();
      expect(() => insert({ reminded: 1, timing: 1, content: null, contentRef: "p1" })).toThrow();
      expect(() => insert({ reminded: 0, paired: "d1", timing: 1 })).toThrow();
      expect(() => insert({ reminded: 0, paired: "d1", content: 1 })).toThrow();
      expect(() => insert({ reminded: 0, paired: "d1", contentRef: "p1" })).toThrow();
      expect(() =>
        insert({ reminded: 1, timing: 1, content: 1, contentRef: "p-missing" }),
      ).toThrow();

      expect(() =>
        insert({ reminded: 1, timing: 1, content: 1, key: "proactive:s1" }),
      ).not.toThrow();
      expect(() => insert({ reminded: 1, timing: 0, content: 1, key: "proactive:s1" })).toThrow();
      expect(() =>
        insert({
          owner: "o2",
          agent: "a2",
          reminded: 1,
          timing: 1,
          content: 1,
          key: "proactive:s1",
        }),
      ).not.toThrow();
      expect(() => insert({ reminded: 1, timing: 1, content: 1, key: "ab" })).toThrow();
      expect(() => insert({ reminded: 1, timing: 1, content: 1, contentRef: "p1" })).not.toThrow();
      expect(() => insert({ reminded: 1, timing: 1, content: 1, contentRef: "p1" })).not.toThrow();

      database.prepare("DELETE FROM decision_ledger WHERE id = 'd1'").run();
      const orphan = database
        .prepare("SELECT count(*) AS n FROM muse_reference_entries WHERE muse_reminded = 0")
        .get() as { n: number };
      expect(orphan.n).toBe(1);
    } finally {
      database.close();
    }
  });
});
