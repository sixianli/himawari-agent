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

const LEDGER_TABLES = [
  "decision_ledger",
  "decision_signals",
  "source_insights",
  "proactive_processed_messages",
  "decision_ledger_payloads",
  "muse_reference_entries",
] as const;

function dumpLedgerTables(database: ReturnType<typeof openQualifiedDatabase>) {
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

async function openMigrated(seedLedger = true) {
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
  if (seedLedger) {
    database
      .prepare(
        `INSERT INTO payloads (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
          content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at, content_type)
         VALUES ('payload-x', ?, ?, 'private', 'sqlite_blob', X'00', 'sha256:x', 'fixture', 'fixture-key', 'active', ?, 'text/plain')`,
      )
      .run(OWNER, AGENT, T0);
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
  const before = dumpLedgerTables(database);
  database.pragma("foreign_keys = ON");
  const snapshot = await createVerifiedMigrationSnapshot(
    database,
    path.join(directory, "snapshot.sqlite"),
  );
  applyMigrations(database, migrations, { snapshot });
  database.pragma("foreign_keys = OFF");
  return { database, before };
}

function addMemory(
  database: ReturnType<typeof openQualifiedDatabase>,
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
  database: ReturnType<typeof openQualifiedDatabase>,
  ruleId: string,
  memoryId: string,
) {
  database
    .prepare("UPDATE rule_book_rules SET source_memory_id = ? WHERE rule_id = ?")
    .run(memoryId, ruleId);
}

function rule(database: ReturnType<typeof openQualifiedDatabase>, ruleId: string) {
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

function history(database: ReturnType<typeof openQualifiedDatabase>, ruleId: string) {
  return database
    .prepare(
      `SELECT revision, status, source_memory_id AS memoryId, change_reason AS reason, changed_at AS changedAt
       FROM rule_book_history WHERE rule_id = ? ORDER BY revision`,
    )
    .all(ruleId);
}

describe("rule memory review", () => {
  it("[P2-2] keeps existing rules and history when the link columns are added", async () => {
    const { database, before } = await openMigrated();
    expect(dumpLedgerTables(database)).toEqual(before);
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
      const { database } = await openMigrated();
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
    const { database } = await openMigrated();
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

  it("[P2-2][P4-1] records one review per episode but moves the rule to a new revision on every later change, including the memory coming back", async () => {
    const { database } = await openMigrated();
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
    expect(rule(database, "r-edit")).toMatchObject({ revision: 4, status: "needs_review" });
    expect(history(database, "r-edit")).toHaveLength(4);
    expect(
      database
        .prepare("SELECT COUNT(*) FROM decision_ledger WHERE kind = 'rule_review'")
        .pluck()
        .get(),
    ).toBe(1);
    database.close();
  });

  it("[P2-2] permanently deleting a rule memory also puts its rule into review", async () => {
    const { database } = await openMigrated();
    addMemory(database, "m-rule", "rule");
    addMemory(database, "m-pref", "preference");
    addMemory(database, "m-unrelated", "rule");
    link(database, "r-edit", "m-rule");
    link(database, "r-other", "m-pref");
    database.prepare("DELETE FROM memory_records WHERE id = 'm-unrelated'").run();
    database.prepare("DELETE FROM memory_records WHERE id = 'm-pref'").run();
    expect(rule(database, "r-edit").status).toBe("active");
    expect(rule(database, "r-other").status).toBe("active");
    database.prepare("DELETE FROM memory_records WHERE id = 'm-rule'").run();
    expect(rule(database, "r-edit")).toMatchObject({
      revision: 2,
      status: "needs_review",
      memoryId: "m-rule",
    });
    expect(history(database, "r-edit")).toMatchObject([
      { revision: 1, status: "active" },
      { revision: 2, status: "needs_review", memoryId: "m-rule", reason: "memory_removed" },
    ]);
    expect(
      database
        .prepare("SELECT reason_code, subject_ref FROM decision_ledger WHERE kind = 'rule_review'")
        .all(),
    ).toEqual([{ reason_code: "memory_removed", subject_ref: "r-edit" }]);
    const stamps = database
      .prepare(
        "SELECT (SELECT checked_at FROM decision_ledger WHERE kind = 'rule_review') AS checked, (SELECT changed_at FROM rule_book_history WHERE rule_id = 'r-edit' AND revision = 2) AS changed, (SELECT updated_at FROM rule_book_rules WHERE rule_id = 'r-edit') AS updated",
      )
      .get() as Record<string, string>;
    for (const stamp of Object.values(stamps))
      expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    database.close();
  });

  it("[P2-2][P4-1] permanently deleting a rule memory whose rule already waits for review adds a revision but no second review", async () => {
    const { database } = await openMigrated();
    addMemory(database, "m-rule", "rule");
    link(database, "r-edit", "m-rule");
    database
      .prepare(
        "UPDATE memory_records SET status = 'trashed', revision = 2, updated_at = ? WHERE id = 'm-rule'",
      )
      .run(T1);
    database.prepare("DELETE FROM memory_records WHERE id = 'm-rule'").run();
    expect(rule(database, "r-edit")).toMatchObject({ revision: 3, status: "needs_review" });
    expect(history(database, "r-edit")).toHaveLength(3);
    expect(
      database
        .prepare("SELECT reason_code FROM decision_ledger WHERE kind = 'rule_review'")
        .pluck()
        .all(),
    ).toEqual(["memory_removed"]);
    database.close();
  });

  it.each([
    ["agents", AGENT],
    ["owners", OWNER],
  ] as const)(
    "[P2-2] deleting the %s after a rule memory was removed leaves no rule rows behind",
    async (table, id) => {
      const { database } = await openMigrated(false);
      addMemory(database, "m-rule", "rule");
      link(database, "r-edit", "m-rule");
      database.pragma("foreign_keys = ON");
      database.prepare("DELETE FROM memory_records WHERE id = 'm-rule'").run();
      expect(rule(database, "r-edit").status).toBe("needs_review");
      database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      for (const leftover of ["rule_book_rules", "rule_book_history", "decision_ledger"])
        expect(database.prepare(`SELECT COUNT(*) FROM ${leftover}`).pluck().get(), leftover).toBe(
          0,
        );
      expect(database.pragma("foreign_key_check")).toEqual([]);
      database.close();
    },
  );

  it.each([
    ["agents", AGENT],
    ["owners", OWNER],
  ] as const)(
    "[P2-2] deleting the %s together with a linked rule memory is not blocked by the review triggers",
    async (table, id) => {
      const { database } = await openMigrated(false);
      addMemory(database, "m-rule", "rule");
      link(database, "r-edit", "m-rule");
      database.pragma("foreign_keys = ON");
      database.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
      for (const leftover of [
        "rule_book_rules",
        "rule_book_history",
        "decision_ledger",
        "memory_records",
      ])
        expect(database.prepare(`SELECT COUNT(*) FROM ${leftover}`).pluck().get(), leftover).toBe(
          0,
        );
      database.close();
    },
  );
});
