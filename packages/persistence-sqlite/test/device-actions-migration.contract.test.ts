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
const T0 = "2026-11-13T00:00:00.000Z";
const OWNER = "owner-device-actions-migration";
const AGENT = "agent-device-actions-migration";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function insertLedger(
  database: ReturnType<typeof openQualifiedDatabase>,
  id: string,
  kind: string,
  outcome: string,
) {
  database
    .prepare(
      `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, checked_at, counts, outcome,
        reason_code, inputs, cost_micros, duration_ms)
       VALUES (?, ?, ?, ?, ?, '{}', ?, 'fixture', '{}', 0, 0)`,
    )
    .run(id, OWNER, AGENT, kind, T0, outcome);
}

function widenLedgerLikeMain(database: ReturnType<typeof openQualifiedDatabase>) {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'decision_ledger'")
    .get() as { sql: string };
  const kinds = row.sql.replace("'rule_review',", "'rule_review', 'memory_review',");
  const outcomes = kinds.replace(
    "(kind = 'rule_review' AND outcome = 'needs_review') OR",
    `(kind = 'rule_review' AND outcome IN (
      'needs_review', 'suspended', 'cleared', 'recheck_failed', 'owner_adopted',
      'owner_confirmed', 'owner_restored'
    )) OR
    (kind = 'memory_review' AND outcome IN (
      'flagged', 'owner_edited', 'owner_dismissed', 'owner_reported_missed'
    )) OR`,
  );
  expect(outcomes).not.toBe(row.sql);
  expect(outcomes).toContain("'memory_review' AND outcome");
  expect(outcomes).toContain("'rule_review', 'memory_review',");
  database.unsafeMode(true);
  database.pragma("writable_schema = ON");
  database
    .prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'decision_ledger'")
    .run(outcomes);
  database.pragma("writable_schema = OFF");
  database.unsafeMode(false);
}

describe("device actions migration", () => {
  it("[iOS-9A] keeps decision records of kinds other branches added when the ledger is rebuilt, and accepts device_action", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-device-actions-migration-"));
    directories.push(directory);
    const file = path.join(directory, "product.sqlite");
    let database = openQualifiedDatabase(file);
    const migrations = await loadBundledMigrations();
    const sequence = migrations.findIndex(({ name }) => name === "device_actions");
    expect(sequence).toBeGreaterThan(0);
    applyMigrations(database, migrations.slice(0, sequence));
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT, OWNER);
    widenLedgerLikeMain(database);
    database.close();
    database = openQualifiedDatabase(file);
    insertLedger(database, "d-memory-review", "memory_review", "flagged");
    insertLedger(database, "d-rule-cleared", "rule_review", "cleared");
    insertLedger(database, "d-rule-restored", "rule_review", "owner_restored");
    const snapshot = await createVerifiedMigrationSnapshot(
      database,
      path.join(directory, "snapshot.sqlite"),
    );
    applyMigrations(database, migrations, { snapshot });
    expect(
      database.prepare("SELECT id, kind, outcome FROM decision_ledger ORDER BY id").all(),
    ).toEqual([
      { id: "d-memory-review", kind: "memory_review", outcome: "flagged" },
      { id: "d-rule-cleared", kind: "rule_review", outcome: "cleared" },
      { id: "d-rule-restored", kind: "rule_review", outcome: "owner_restored" },
    ]);
    insertLedger(database, "d-device", "device_action", "queued");
    expect(() => insertLedger(database, "d-bad-kind", "not_a_kind", "queued")).toThrow();
    expect(() => insertLedger(database, "d-bad-outcome", "device_action", "flagged")).toThrow();
    database.close();
  });
});
