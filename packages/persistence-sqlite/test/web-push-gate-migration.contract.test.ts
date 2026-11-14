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
const OWNER = "owner-web-push-gate";
const AGENT = "agent-web-push-gate";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function openMigrated() {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-web-push-gate-"));
  directories.push(directory);
  const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
  const migrations = await loadBundledMigrations();
  const sequence = migrations.findIndex(({ name }) => name === "web_push_gate");
  expect(sequence).toBeGreaterThan(0);
  applyMigrations(database, migrations.slice(0, sequence));
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT, OWNER);
  database
    .prepare(
      `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, scenario, checked_at, counts, verdict,
        reason_code, inputs, cost_micros, duration_ms)
       VALUES ('d-mail', ?, ?, 'proactive', 'gmail', ?, '{}', 'pushed', 'mail_pushed',
        '{"memoryIds":[],"ruleIds":[]}', 0, 0)`,
    )
    .run(OWNER, AGENT, T0);
  database
    .prepare(
      `INSERT INTO decision_signals (id, owner_id, agent_id, decision_id, signal, occurred_at, delay_ms,
        detail, source_ref, recorded_at)
       VALUES ('sig-1', ?, ?, 'd-mail', 'opened', ?, 5, '{}', 'ref-1', ?)`,
    )
    .run(OWNER, AGENT, T0, T0);
  database
    .prepare(
      `INSERT INTO decision_prereviews (id, owner_id, agent_id, decision_id, calibration_group, status,
        rating, confidence_permille, history_conflict, model_ref, prompt_id, text_digest,
        data_classification, cost_micros, duration_ms, created_at)
       VALUES ('pre-1', ?, ?, 'd-mail', 'proactive_pushed', 'done', 'useful', 900, 0, 'model', 'prompt',
        '${"a".repeat(64)}', 'private', 0, 0, ?)`,
    )
    .run(OWNER, AGENT, T0);
  const snapshot = await createVerifiedMigrationSnapshot(
    database,
    path.join(directory, "snapshot.sqlite"),
  );
  applyMigrations(database, migrations, { snapshot });
  return database;
}

describe("web push gate migration", () => {
  it("[HR-4] keeps every decision record, signal and pre-review and adds the web push kind without rebuilding", async () => {
    const database = await openMigrated();
    expect(database.prepare("SELECT count(*) FROM decision_ledger").pluck().get()).toBe(1);
    expect(database.prepare("SELECT count(*) FROM decision_signals").pluck().get()).toBe(1);
    expect(database.prepare("SELECT count(*) FROM decision_prereviews").pluck().get()).toBe(1);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(() =>
      database.prepare("UPDATE decision_prereviews SET rating = 'unneeded'").run(),
    ).toThrow(/DECISION_PREREVIEW_IMMUTABLE/u);
    expect(() => database.prepare("UPDATE decision_signals SET delay_ms = 9").run()).toThrow(
      /DECISION_SIGNAL_IMMUTABLE/u,
    );
  });

  it("[HR-4] accepts a deferred web push record and REVERSE: refuses any other outcome for that kind", async () => {
    const database = await openMigrated();
    const insert = (id: string, kind: string, outcome: string) =>
      database
        .prepare(
          `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, checked_at, counts, outcome,
            reason_code, inputs, cost_micros, duration_ms)
           VALUES (?, ?, ?, ?, ?, '{}', ?, 'push_quiet_hours', '{"memoryIds":[],"ruleIds":[]}', 0, 0)`,
        )
        .run(id, OWNER, AGENT, kind, T0, outcome);
    insert("d-push", "web_push", "deferred");
    expect(() => insert("d-push-sent", "web_push", "sent")).toThrow();
    expect(() => insert("d-other", "rule_review", "deferred")).toThrow();
  });
});
