import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createVerifiedMigrationSnapshot,
  loadBundledMigrations,
  openQualifiedDatabase,
  readMigrationLedger,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];
const NOW = "2026-09-05T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function legacyDatabase() {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-model-budget-migration-"));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, "product.sqlite");
  const snapshotPath = path.join(directory, "pre-migration.sqlite");
  const database = openQualifiedDatabase(databasePath);
  const migrations = await loadBundledMigrations();
  applyMigrations(database, migrations.slice(0, 21));
  database.prepare("INSERT INTO owners (id, revision) VALUES ('owner-budget-migration', 0)").run();
  database
    .prepare(
      "INSERT INTO agents (id, owner_id, revision) VALUES ('agent-budget-migration', 'owner-budget-migration', 0)",
    )
    .run();
  database
    .prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, lifecycle_state, created_at, content_type
      ) VALUES ('payload-budget-migration', 'owner-budget-migration', 'agent-budget-migration',
        'private', 'sqlite_blob', X'00', 'sha256:budget-migration', 'active', ?,
        'application/octet-stream')`,
    )
    .run(NOW);
  database
    .prepare(
      `INSERT INTO deployments (
        id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
      ) VALUES ('deployment-budget-migration', 'owner-budget-migration',
        'agent-budget-migration', 0, 'active', 1, 1)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO scheduled_jobs (
        id, owner_id, agent_id, thread_id, revision, status, authorization_ref,
        definition_ref, next_occurrence_at
      ) VALUES ('job-budget-migration', 'owner-budget-migration', 'agent-budget-migration',
        NULL, 0, 'active', 'authorization-budget-migration',
        'payload-budget-migration', ?)`,
    )
    .run(NOW);
  database
    .prepare(
      `INSERT INTO job_occurrences (
        id, job_id, owner_id, agent_id, revision, stable_key, status,
        deployment_id, authority_epoch, fencing_token, category,
        data_classification, foreground, parallel_safe, estimated_cost_micros,
        reserved_cost_micros, spent_cost_micros, attempt_count, next_retry_at,
        deadline_at, run_id, work_lease_id, work_lease_holder_id,
        work_lease_acquired_at, work_lease_expires_at, last_error_code, record_json
      ) VALUES ('occurrence-budget-migration', 'job-budget-migration',
        'owner-budget-migration', 'agent-budget-migration', 1,
        'stable-budget-migration', 'completed', 'deployment-budget-migration',
        1, 1, 'monitor', 'private', 0, 0, 100, 40, 60, 1, NULL, ?, NULL,
        NULL, NULL, NULL, NULL, NULL, '{"status":"completed"}')`,
    )
    .run(NOW);
  return { database, databasePath, snapshotPath, migrations };
}

describe("model budget migration", () => {
  it("backfills historical occurrence reserved and spent facts without resetting them", async () => {
    const resource = await legacyDatabase();
    const snapshot = await createVerifiedMigrationSnapshot(
      resource.database,
      resource.snapshotPath,
    );
    expect(applyMigrations(resource.database, resource.migrations, { snapshot })).toMatchObject({
      appliedSequences: [22, 23],
      currentSequence: 23,
    });
    expect(
      resource.database
        .prepare(
          `SELECT parent_kind AS parentKind, occurrence_id AS occurrenceId,
            data_classification AS dataClassification,
            reserved_cost_micros AS reservedCostMicros,
            spent_cost_micros AS spentCostMicros, status
           FROM model_budget_accounts WHERE account_id = 'occurrence:occurrence-budget-migration'`,
        )
        .get(),
    ).toEqual({
      parentKind: "occurrence",
      occurrenceId: "occurrence-budget-migration",
      dataClassification: "private",
      reservedCostMicros: 40,
      spentCostMicros: 60,
      status: "active",
    });
    expect(readMigrationLedger(resource.database)).toHaveLength(23);
    resource.database.close();
  });

  it("rolls back the new ledger when legacy cost facts exceed safe integers", async () => {
    const resource = await legacyDatabase();
    resource.database
      .prepare("UPDATE job_occurrences SET reserved_cost_micros = ? WHERE id = ?")
      .run(Number.MAX_SAFE_INTEGER + 1, "occurrence-budget-migration");
    const snapshot = await createVerifiedMigrationSnapshot(
      resource.database,
      resource.snapshotPath,
    );
    expect(() => applyMigrations(resource.database, resource.migrations, { snapshot })).toThrow();
    expect(readMigrationLedger(resource.database)).toHaveLength(21);
    expect(
      resource.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_budget_accounts'",
        )
        .get(),
    ).toBeUndefined();
    resource.database.close();
  });

  it("rolls back when legacy reserved and spent totals overflow the safe integer range", async () => {
    const resource = await legacyDatabase();
    resource.database
      .prepare(
        "UPDATE job_occurrences SET reserved_cost_micros = ?, spent_cost_micros = ? WHERE id = ?",
      )
      .run(Number.MAX_SAFE_INTEGER - 1, 2, "occurrence-budget-migration");
    const snapshot = await createVerifiedMigrationSnapshot(
      resource.database,
      resource.snapshotPath,
    );
    expect(() => applyMigrations(resource.database, resource.migrations, { snapshot })).toThrow();
    expect(readMigrationLedger(resource.database)).toHaveLength(21);
    expect(
      resource.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'model_budget_accounts'",
        )
        .get(),
    ).toBeUndefined();
    resource.database.close();
  });

  it("rolls back every migration effect when legacy scope totals overflow", async () => {
    const resource = await legacyDatabase();
    resource.database
      .prepare(
        "UPDATE job_occurrences SET reserved_cost_micros = ?, spent_cost_micros = 0 WHERE id = ?",
      )
      .run(Number.MAX_SAFE_INTEGER - 1, "occurrence-budget-migration");
    resource.database
      .prepare(
        `INSERT INTO job_occurrences (
          id, job_id, owner_id, agent_id, revision, stable_key, status,
          deployment_id, authority_epoch, fencing_token, category,
          data_classification, foreground, parallel_safe, estimated_cost_micros,
          reserved_cost_micros, spent_cost_micros, attempt_count, next_retry_at,
          deadline_at, run_id, work_lease_id, work_lease_holder_id,
          work_lease_acquired_at, work_lease_expires_at, last_error_code, record_json
        ) SELECT 'occurrence-budget-migration-overflow', job_id, owner_id, agent_id, 1,
          'stable-budget-migration-overflow', status, deployment_id, authority_epoch,
          fencing_token, category, data_classification, foreground, parallel_safe,
          estimated_cost_micros, 2, 0, attempt_count, next_retry_at, deadline_at,
          run_id, work_lease_id, work_lease_holder_id, work_lease_acquired_at,
          work_lease_expires_at, last_error_code, record_json
        FROM job_occurrences WHERE id = 'occurrence-budget-migration'`,
      )
      .run();
    const snapshot = await createVerifiedMigrationSnapshot(
      resource.database,
      resource.snapshotPath,
    );
    expect(() => applyMigrations(resource.database, resource.migrations, { snapshot })).toThrow();
    expect(readMigrationLedger(resource.database)).toHaveLength(21);
    expect(
      resource.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('model_budget_accounts', 'model_budget_allocations')",
        )
        .all(),
    ).toEqual([]);
    expect(
      resource.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'job_occurrences_scope_identity'",
        )
        .get(),
    ).toBeUndefined();
    expect(
      resource.database
        .prepare("SELECT COUNT(*) FROM job_occurrences WHERE owner_id = ? AND agent_id = ?")
        .pluck()
        .get("owner-budget-migration", "agent-budget-migration"),
    ).toBe(2);
    resource.database.close();
  });
});
