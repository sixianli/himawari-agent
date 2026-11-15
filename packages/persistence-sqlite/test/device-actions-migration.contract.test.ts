import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, loadBundledMigrations, openQualifiedDatabase } from "../src/index.ts";

const directories: string[] = [];
const T0 = "2026-11-14T00:00:00.000Z";
const OWNER = "owner-device-actions-migration";
const AGENT = "agent-device-actions-migration";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("device actions migration", () => {
  it("[iOS-9A] registers device_action and its outcomes in the decision ledger reference tables without touching other kinds", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-device-actions-migration-"));
    directories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT, OWNER);
    const insert = (id: string, kind: string, outcome: string) =>
      database
        .prepare(
          `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, checked_at, counts, outcome,
            reason_code, inputs, cost_micros, duration_ms)
           VALUES (?, ?, ?, ?, ?, '{}', ?, 'fixture', '{}', 0, 0)`,
        )
        .run(id, OWNER, AGENT, kind, T0, outcome);
    expect(
      database
        .prepare(
          "SELECT outcome FROM decision_ledger_outcomes WHERE kind = 'device_action' ORDER BY outcome",
        )
        .all()
        .map((row) => (row as { outcome: string }).outcome),
    ).toEqual([
      "delivered",
      "expired",
      "failed",
      "policy_changed",
      "queued",
      "rejected",
      "result_unknown",
      "succeeded",
      "waiting_owner",
    ]);
    insert("d-device", "device_action", "queued");
    insert("d-memory-review", "memory_review", "flagged");
    insert("d-rule-cleared", "rule_review", "cleared");
    expect(() => insert("d-bad-outcome", "device_action", "flagged")).toThrow();
    expect(() => insert("d-bad-kind", "not_a_kind", "queued")).toThrow();
    database.close();
  });
});
