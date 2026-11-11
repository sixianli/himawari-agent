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
const T2 = "2026-11-03T00:00:00.000Z";
const OWNER = "owner-rule-review";
const AGENT = "agent-rule-review";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function openMigrated() {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-rule-review-"));
  directories.push(directory);
  const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
  const migrations = await loadBundledMigrations();
  const sequence = migrations.findIndex(({ name }) => name === "rule_book_memory_link");
  expect(sequence).toBeGreaterThan(0);
  applyMigrations(database, migrations.slice(0, sequence));
  database.pragma("foreign_keys = OFF");
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT, OWNER);
  const insertRule = database.prepare(
    `INSERT INTO rule_book_rules (owner_id, agent_id, rule_id, revision, parameters, status, source, updated_at)
     VALUES (?, ?, ?, 1, '{"senders":["bank.example"]}', 'active', 'owner setting', ?)`,
  );
  const insertHistory = database.prepare(
    `INSERT INTO rule_book_history (owner_id, agent_id, rule_id, revision, parameters, status, source, changed_at)
     VALUES (?, ?, ?, 1, '{"senders":["bank.example"]}', 'active', 'owner setting', ?)`,
  );
  for (const ruleId of ["floor_important_sender", "r-edit", "r-other"]) {
    insertRule.run(OWNER, AGENT, ruleId, T0);
    insertHistory.run(OWNER, AGENT, ruleId, T0);
  }
  database
    .prepare(
      `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, checked_at, counts, outcome, reason_code, inputs, cost_micros, duration_ms)
       VALUES ('d-old', ?, ?, 'external_read', ?, '{}', 'read', 'seed', '{"memoryIds":[],"ruleIds":[]}', 0, 0)`,
    )
    .run(OWNER, AGENT, T0);
  database
    .prepare(
      `INSERT INTO decision_signals (id, owner_id, agent_id, decision_id, signal, occurred_at, delay_ms, detail, source_ref, recorded_at)
       VALUES ('sig-1', ?, ?, 'd-old', 'opened', ?, 5, '{}', 'ref-1', ?)`,
    )
    .run(OWNER, AGENT, "2026-11-01T00:00:01.000Z", "2026-11-01T00:00:02.000Z");
  database
    .prepare(
      `INSERT INTO proactive_push_backoff (owner_id, agent_id, class_key, stage, since_at, step_decision_id, ignored_count, updated_at)
       VALUES (?, ?, 'c', 1, ?, 'd-old', 3, ?)`,
    )
    .run(OWNER, AGENT, T0, T0);
  database.pragma("foreign_keys = ON");
  const snapshot = await createVerifiedMigrationSnapshot(
    database,
    path.join(directory, "snapshot.sqlite"),
  );
  applyMigrations(database, migrations, { snapshot });
  database.pragma("foreign_keys = OFF");
  return database;
}

function addMemory(
  database: Awaited<ReturnType<typeof openMigrated>>,
  id: string,
  category: string,
) {
  database
    .prepare(
      `INSERT INTO memory_records (id, owner_id, agent_id, revision, status, content_ref,
        classification, inference, confidence_permille, policy_version, updated_at, category)
       VALUES (?, ?, ?, 1, 'active', 'payload-a', 'private', 0, 900, 'p', ?, ?)`,
    )
    .run(id, OWNER, AGENT, T0, category);
}

function link(
  database: Awaited<ReturnType<typeof openMigrated>>,
  ruleId: string,
  memoryId: string,
) {
  database
    .prepare("UPDATE rule_book_rules SET source_memory_id = ? WHERE rule_id = ?")
    .run(memoryId, ruleId);
}

function rule(database: Awaited<ReturnType<typeof openMigrated>>, ruleId: string) {
  return database
    .prepare(
      "SELECT revision, status, source_memory_id AS memoryId, updated_at AS updatedAt FROM rule_book_rules WHERE rule_id = ?",
    )
    .get(ruleId) as {
    revision: number;
    status: string;
    memoryId: string | null;
    updatedAt: string;
  };
}

function history(database: Awaited<ReturnType<typeof openMigrated>>, ruleId: string) {
  return database
    .prepare(
      `SELECT revision, status, source_memory_id AS memoryId, change_reason AS reason, changed_at AS changedAt
       FROM rule_book_history WHERE rule_id = ? ORDER BY revision`,
    )
    .all(ruleId);
}

describe("rule memory review", () => {
  it("[P2-2] keeps existing rules and history when the link columns are added", async () => {
    const database = await openMigrated();
    expect(rule(database, "r-edit")).toEqual({
      revision: 1,
      status: "active",
      memoryId: null,
      updatedAt: T0,
    });
    expect(history(database, "r-edit")).toEqual([
      { revision: 1, status: "active", memoryId: null, reason: null, changedAt: T0 },
    ]);
    expect(() => database.prepare("UPDATE rule_book_history SET parameters = '{}'").run()).toThrow(
      /RULE_BOOK_HISTORY_IMMUTABLE/u,
    );
    expect(database.prepare("SELECT id, kind, outcome FROM decision_ledger").all()).toEqual([
      { id: "d-old", kind: "external_read", outcome: "read" },
    ]);
    expect(database.prepare("SELECT id, decision_id AS d FROM decision_signals").all()).toEqual([
      { id: "sig-1", d: "d-old" },
    ]);
    expect(
      database.prepare("SELECT step_decision_id AS d FROM proactive_push_backoff").pluck().get(),
    ).toBe("d-old");
    expect(() => database.prepare("UPDATE decision_signals SET delay_ms = 9").run()).toThrow(
      /DECISION_SIGNAL_IMMUTABLE/u,
    );
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it.each([
    [
      "edited",
      "UPDATE memory_records SET content_ref = 'payload-b', revision = 2, updated_at = ?",
      "memory_edited",
    ],
    [
      "superseded",
      "UPDATE memory_records SET superseded_by = 'm-new', revision = 2, updated_at = ?",
      "memory_superseded",
    ],
    [
      "archived",
      "UPDATE memory_records SET status = 'archived', revision = 2, updated_at = ?",
      "memory_removed",
    ],
    [
      "trashed",
      "UPDATE memory_records SET status = 'trashed', revision = 2, updated_at = ?",
      "memory_removed",
    ],
    [
      "deleted",
      "UPDATE memory_records SET status = 'deletion_pending', revision = 2, updated_at = ?",
      "memory_removed",
    ],
    [
      "reclassified",
      "UPDATE memory_records SET category = 'preference', revision = 2, updated_at = ?",
      "memory_reclassified",
    ],
  ])(
    "[P2-2] a rule memory that is %s puts its hard rule into review",
    async (_name, sql, reason) => {
      const database = await openMigrated();
      addMemory(database, "m-rule", "rule");
      addMemory(database, "m-new", "rule");
      link(database, "r-edit", "m-rule");
      database.prepare(sql).run(T1);
      expect(rule(database, "r-edit")).toEqual({
        revision: 2,
        status: "needs_review",
        memoryId: "m-rule",
        updatedAt: T1,
      });
      expect(history(database, "r-edit")).toEqual([
        { revision: 1, status: "active", memoryId: null, reason: null, changedAt: T0 },
        { revision: 2, status: "needs_review", memoryId: "m-rule", reason, changedAt: T1 },
      ]);
      const decisions = database
        .prepare(
          `SELECT kind, outcome, reason_code AS reason, subject_ref AS subject, checked_at AS at, inputs
         FROM decision_ledger WHERE kind = 'rule_review'`,
        )
        .all() as { inputs: string }[];
      expect(decisions).toEqual([
        {
          kind: "rule_review",
          outcome: "needs_review",
          reason,
          subject: "r-edit",
          at: T1,
          inputs: JSON.stringify({
            memoryIds: ["m-rule"],
            ruleIds: ["r-edit"],
            batchId: null,
            resultMemoryIds: [],
          }),
        },
      ]);
      database.close();
    },
  );

  it("[P2-2] leaves rules alone for changes that do not touch the rule memory's meaning", async () => {
    const database = await openMigrated();
    addMemory(database, "m-rule", "rule");
    addMemory(database, "m-unrelated", "rule");
    addMemory(database, "m-pref", "preference");
    link(database, "r-edit", "m-rule");
    link(database, "r-other", "m-pref");
    database
      .prepare(
        "UPDATE memory_records SET importance_permille = 900, revision = 2, updated_at = ? WHERE id = 'm-rule'",
      )
      .run(T1);
    database
      .prepare(
        "UPDATE memory_records SET content_ref = 'payload-b', revision = 2, updated_at = ? WHERE id = 'm-unrelated'",
      )
      .run(T1);
    database
      .prepare(
        "UPDATE memory_records SET content_ref = 'payload-b', revision = 2, updated_at = ? WHERE id = 'm-pref'",
      )
      .run(T1);
    expect(rule(database, "r-edit").status).toBe("active");
    expect(rule(database, "r-edit").revision).toBe(1);
    expect(rule(database, "r-other").status).toBe("active");
    expect(rule(database, "floor_important_sender").revision).toBe(1);
    expect(history(database, "r-edit")).toHaveLength(1);
    expect(
      database
        .prepare("SELECT COUNT(*) FROM decision_ledger WHERE kind = 'rule_review'")
        .pluck()
        .get(),
    ).toBe(0);
    database.close();
  });

  it("[P2-2] puts a rule into review once and keeps it there when the memory comes back", async () => {
    const database = await openMigrated();
    addMemory(database, "m-rule", "rule");
    link(database, "r-edit", "m-rule");
    database
      .prepare(
        "UPDATE memory_records SET status = 'trashed', revision = 2, updated_at = ? WHERE id = 'm-rule'",
      )
      .run(T1);
    database
      .prepare(
        "UPDATE memory_records SET content_ref = 'payload-b', revision = 3, updated_at = ? WHERE id = 'm-rule'",
      )
      .run(T2);
    database
      .prepare(
        "UPDATE memory_records SET status = 'active', revision = 4, updated_at = ? WHERE id = 'm-rule'",
      )
      .run(T2);
    expect(rule(database, "r-edit")).toMatchObject({ revision: 2, status: "needs_review" });
    expect(history(database, "r-edit")).toHaveLength(2);
    expect(
      database
        .prepare("SELECT COUNT(*) FROM decision_ledger WHERE kind = 'rule_review'")
        .pluck()
        .get(),
    ).toBe(1);
    database.close();
  });
});
