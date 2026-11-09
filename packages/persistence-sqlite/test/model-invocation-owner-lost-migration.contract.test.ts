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

const temporaryDirectories: string[] = [];
const T0 = "2026-11-08T00:00:00.000Z";
const OWNER_ID = "owner-owner-lost-migration";
const AGENT_ID = "agent-owner-lost-migration";
const RUN_ID = "run-owner-lost-migration";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function databaseBeforeOwnerLost() {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-owner-lost-migration-"));
  temporaryDirectories.push(directory);
  const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
  const migrations = await loadBundledMigrations();
  const target = migrations.findIndex(
    (migration) => migration.name === "model_invocation_owner_lost",
  );
  expect(target).toBeGreaterThan(0);
  applyMigrations(database, migrations.slice(0, target));
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO deployments (id, owner_id, agent_id, revision, status, authority_epoch, fencing_token)
       VALUES ('deployment-owner-lost', ?, ?, 0, 'active', 1, 1)`,
    )
    .run(OWNER_ID, AGENT_ID);
  database
    .prepare(
      `INSERT INTO authority_leases (id, owner_id, agent_id, deployment_id, holder_id,
        authority_epoch, fencing_token, acquired_at, expires_at, released_at)
       VALUES ('lease-owner-lost', ?, ?, 'deployment-owner-lost', 'holder', 1, 1, ?, ?, NULL)`,
    )
    .run(OWNER_ID, AGENT_ID, T0, T0);
  database
    .prepare(
      `INSERT INTO payloads (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, lifecycle_state, created_at, content_type)
       VALUES ('payload-owner-lost', ?, ?, 'private', 'sqlite_blob', X'00',
        'sha256:owner-lost', 'active', ?, 'application/octet-stream')`,
    )
    .run(OWNER_ID, AGENT_ID, T0);
  database
    .prepare(
      `INSERT INTO triggers (id, owner_id, agent_id, thread_id, idempotency_key, source_type,
        source_id, payload_ref, source_proof_ref, occurred_at)
       VALUES ('trigger-owner-lost', ?, ?, NULL, 'trigger-owner-lost', 'schedule',
        'owner-lost', 'payload-owner-lost', 'proof-owner-lost', ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T0);
  database
    .prepare(
      `INSERT INTO runs (id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
        status, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 'session-owner-lost', 'trigger-owner-lost', 1, 'running', ?, ?)`,
    )
    .run(RUN_ID, OWNER_ID, AGENT_ID, T0, T0);
  database
    .prepare(
      `INSERT INTO model_budget_accounts (owner_id, agent_id, account_id, parent_kind, run_id,
        data_classification, reserved_cost_micros, spent_cost_micros, status, revision)
       VALUES (?, ?, ?, 'run', ?, 'private', 300, 7, 'reconcile_required', 4)`,
    )
    .run(OWNER_ID, AGENT_ID, `run:${RUN_ID}`, RUN_ID);
  const allocations = [
    ["operation-started", "started", T0, null, null, null, null],
    ["operation-unknown", "unknown", T0, T0, null, null, "cancel_unresolved"],
    ["operation-settled", "settled", T0, null, T0, 7, null],
  ] as const;
  for (const [
    operationKey,
    status,
    startedAt,
    observedAt,
    settledAt,
    actual,
    reason,
  ] of allocations)
    database
      .prepare(
        `INSERT INTO model_budget_allocations (owner_id, agent_id, account_id, operation_key,
          model_ref, data_classification, estimated_cost_micros, actual_cost_micros, status,
          reserved_at, started_at, observed_at, settled_at, reason_code)
         VALUES (?, ?, ?, ?, 'model-ref', 'private', 100, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        OWNER_ID,
        AGENT_ID,
        `run:${RUN_ID}`,
        operationKey,
        actual,
        status,
        T0,
        startedAt,
        observedAt,
        settledAt,
        reason,
      );
  for (const [
    sequence,
    [operationKey, status, startedAt, observedAt, settledAt, actual, reason],
  ] of allocations.entries())
    database
      .prepare(
        `INSERT INTO model_invocation_identities (
          owner_id, agent_id, run_id, logical_slot, sequence, invocation_id, model_ref, provider,
          model, data_classification, source, ordinal, pricing_input, pricing_output,
          pricing_cache_read, pricing_cache_write, pricing_fingerprint, estimated_cost_micros,
          budget_account_id, budget_operation_key, authority_lease_id, authority_deployment_id,
          authority_epoch, authority_fencing_token, execution_lease_id,
          execution_expected_lease_revision, execution_authority_lease_id,
          execution_authority_fencing_token, execution_deployment_id, execution_authority_epoch,
          execution_fencing_token, execution_consumer_id, status, reserved_at, started_at,
          observed_at, settled_at, released_at, actual_cost_micros, reason_code
        ) VALUES (?, ?, ?, 'main', ?, ?, 'model-ref', 'provider', 'model', 'private',
          'model-port', ?, 1, 2, 0, 0, 'fingerprint', 100, ?, ?, 'lease-owner-lost',
          'deployment-owner-lost', 1, 1, 'execution-lease', 0, 'lease-owner-lost', 1,
          'deployment-owner-lost', 1, 1, 'consumer', ?, ?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(
        OWNER_ID,
        AGENT_ID,
        RUN_ID,
        sequence + 1,
        `invocation-${operationKey}`,
        sequence + 1,
        `run:${RUN_ID}`,
        operationKey,
        status,
        T0,
        startedAt,
        observedAt,
        settledAt,
        actual,
        reason,
      );
  return { database, directory, migrations };
}

function rows(database: ReturnType<typeof openQualifiedDatabase>) {
  return {
    allocations: database
      .prepare("SELECT * FROM model_budget_allocations ORDER BY operation_key")
      .all(),
    identities: database
      .prepare("SELECT * FROM model_invocation_identities ORDER BY invocation_id")
      .all(),
    accounts: database.prepare("SELECT * FROM model_budget_accounts ORDER BY account_id").all(),
  };
}

describe("model invocation owner_lost migration", () => {
  it("keeps every allocation and identity row and accepts the owner_lost reason", async () => {
    const resource = await databaseBeforeOwnerLost();
    const before = rows(resource.database);
    const snapshot = await createVerifiedMigrationSnapshot(
      resource.database,
      path.join(resource.directory, "pre-migration.sqlite"),
    );
    applyMigrations(resource.database, resource.migrations, { snapshot });
    expect(rows(resource.database)).toEqual(before);
    expect(resource.database.pragma("foreign_key_check")).toEqual([]);
    for (const table of ["model_budget_allocations", "model_invocation_identities"])
      resource.database
        .prepare(
          `UPDATE ${table} SET status = 'unknown', observed_at = ?, reason_code = 'owner_lost'
           WHERE ${table === "model_budget_allocations" ? "operation_key" : "budget_operation_key"} = 'operation-started'`,
        )
        .run(T0);
    expect(
      resource.database
        .prepare(
          "SELECT status, reason_code FROM model_invocation_identities WHERE budget_operation_key = 'operation-started'",
        )
        .get(),
    ).toEqual({ status: "unknown", reason_code: "owner_lost" });
    expect(() =>
      resource.database
        .prepare(
          "UPDATE model_budget_allocations SET reason_code = 'invented_reason' WHERE operation_key = 'operation-unknown'",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(
      resource.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('model_budget_allocations', 'model_invocation_identities') AND sql IS NOT NULL ORDER BY name",
        )
        .all(),
    ).toEqual([
      { name: "model_budget_allocations_scope" },
      { name: "model_invocation_identities_scope" },
      { name: "model_invocation_identities_status" },
    ]);
    resource.database.close();
  });
});
