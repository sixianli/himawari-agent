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

const directories: string[] = [];
const T0 = "2026-09-04T00:00:00.000Z";
const OWNER_ID = "owner-srt-release-migration";
const AGENT_ID = "agent-srt-release-migration";

const AUTHORITY = JSON.stringify({ kind: "fixture" });
const PROOF = JSON.stringify({ kind: "fixture-proof" });

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function digest(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function seedProductRows(database: ReturnType<typeof openQualifiedDatabase>) {
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at
      ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'fixture',
        'fixture-key', 'active', ?)`,
    )
    .run("payload-srt-release", OWNER_ID, AGENT_ID, "sha256:payload-srt-release", T0);
  database
    .prepare(
      `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
       VALUES (?, ?, ?, 0, 'open', ?, ?)`,
    )
    .run("thread-srt-release", OWNER_ID, AGENT_ID, T0, T0);
  database
    .prepare(
      `INSERT INTO triggers (
        id, owner_id, agent_id, thread_id, idempotency_key, source_type,
        source_id, payload_ref, source_proof_ref, occurred_at
      ) VALUES (?, ?, ?, ?, ?, 'user_message', 'fixture', ?, 'fixture-proof', ?)`,
    )
    .run(
      "trigger-srt-release",
      OWNER_ID,
      AGENT_ID,
      "thread-srt-release",
      "trigger-srt-release",
      "payload-srt-release",
      T0,
    );
  database
    .prepare(
      `INSERT INTO runs (
        id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'session-srt-release', ?, 1, 'running', ?, ?)`,
    )
    .run(
      "run-srt-release",
      OWNER_ID,
      AGENT_ID,
      "thread-srt-release",
      "trigger-srt-release",
      T0,
      T0,
    );
  database
    .prepare(
      `INSERT INTO execution_jobs (execution_job_id, owner_id, agent_id, run_id, host_id, created_at)
       VALUES (?, ?, ?, ?, 'host-srt-release', ?)`,
    )
    .run("job-srt-release", OWNER_ID, AGENT_ID, "run-srt-release", T0);
}

function insertEnvironment(
  database: ReturnType<typeof openQualifiedDatabase>,
  environmentId: string,
  backendRef: string,
  options: {
    readonly generation?: number;
    readonly role?: "primary" | "network_helper";
    readonly state?: string;
  } = {},
) {
  const generation = options.generation ?? 1;
  database
    .prepare(
      `INSERT INTO execution_environments (
        environment_id, execution_job_id, role, generation, state, rotation_reason, backend_ref,
        envelope_json, envelope_digest, policy_digest, image_digest, runner_digest, deadline_at,
        create_intent_id, create_dispatched_at, locator_json, stop_fence, created_at, updated_at
      ) VALUES (?, 'job-srt-release', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 1, ?, ?)`,
    )
    .run(
      environmentId,
      options.role ?? "primary",
      generation,
      options.state ?? "stop_requested",
      generation === 1 ? "initial" : "failure",
      backendRef,
      JSON.stringify({ directories: [], network: [], resources: {} }),
      digest("e"),
      digest("a"),
      digest("b"),
      digest("c"),
      "2026-09-04T01:00:00.000Z",
      `create-${environmentId}`,
      T0,
      T0,
    );
  database
    .prepare(
      `INSERT INTO execution_environment_stop_intents (
        environment_id, stop_fence, stop_intent_id, reason, stopped_resource_refs_json,
        requested_at, acknowledged_at, authority_json
      ) VALUES (?, 1, ?, 'failure', '[]', ?, ?, ?)`,
    )
    .run(environmentId, `stop-${environmentId}`, T0, T0, AUTHORITY);
}

function insertReceipt(
  database: ReturnType<typeof openQualifiedDatabase>,
  environmentId: string,
  basis: string,
  proof: string | null,
) {
  database
    .prepare(
      `INSERT INTO execution_environment_release_receipts (
        environment_id, basis, stop_fence, accepted_at, proof_json, authority_json
      ) VALUES (?, ?, 1, ?, ?, ?)`,
    )
    .run(environmentId, basis, T0, proof, AUTHORITY);
}

function triggerNames(database: ReturnType<typeof openQualifiedDatabase>): string[] {
  return database
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE 'execution_environment%' ORDER BY name",
    )
    .pluck()
    .all() as string[];
}

function receiptRows(database: ReturnType<typeof openQualifiedDatabase>) {
  return database
    .prepare("SELECT * FROM execution_environment_release_receipts ORDER BY environment_id")
    .all();
}

describe("migration 0051 accepts the SRT process-group stop proof", () => {
  it("keeps existing release receipts and their triggers while admitting process_group_gone", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-srt-release-migration-"));
    directories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    try {
      const migrations = await loadBundledMigrations();
      applyMigrations(database, migrations.slice(0, 50));
      seedProductRows(database);
      insertEnvironment(database, "environment-create-not-dispatched", "container", {
        state: "released",
      });
      insertEnvironment(database, "environment-never-created", "container", {
        generation: 2,
        state: "released",
      });
      insertEnvironment(database, "environment-verified-stopped", "container", {
        generation: 3,
        state: "released",
      });
      insertReceipt(database, "environment-create-not-dispatched", "create_not_dispatched", null);
      insertReceipt(database, "environment-never-created", "never_created", PROOF);
      insertReceipt(database, "environment-verified-stopped", "verified_stopped", PROOF);
      const before = receiptRows(database);
      expect(before).toHaveLength(3);
      const snapshot = await createVerifiedMigrationSnapshot(
        database,
        path.join(directory, "pre-migration.sqlite"),
      );

      expect(applyMigrations(database, migrations, { snapshot })).toEqual({
        appliedSequences: [51],
        currentSequence: 51,
      });
      expect(readMigrationLedger(database).at(-1)?.sequence).toBe(51);
      expect(receiptRows(database)).toEqual(before);
      expect(database.pragma("foreign_key_check")).toEqual([]);

      expect(triggerNames(database)).toEqual([
        "execution_environment_create_after_stop",
        "execution_environment_delete_guard",
        "execution_environment_fence_monotonic",
        "execution_environment_identity_immutable",
        "execution_environment_lease_release",
        "execution_environment_previous_released",
        "execution_environment_release_final",
        "execution_environment_release_receipt_immutable",
        "execution_environment_stop_intent_immutable",
      ]);

      expect(() =>
        database
          .prepare(
            "UPDATE execution_environment_release_receipts SET accepted_at=? WHERE environment_id=?",
          )
          .run("2026-09-04T02:00:00.000Z", "environment-never-created"),
      ).toThrow(/immutable/);

      insertEnvironment(database, "environment-unreceipted", "container", {
        role: "network_helper",
      });
      expect(() =>
        database
          .prepare("UPDATE execution_environments SET state='released' WHERE environment_id=?")
          .run("environment-unreceipted"),
      ).toThrow(/release receipt/);

      database
        .prepare(
          "INSERT INTO execution_environment_leases (environment_id, scope_ref, host_id, claim_json) VALUES (?,?,?,?)",
        )
        .run(
          "environment-unreceipted",
          "lease-srt-release",
          "host-srt-release",
          JSON.stringify({ ref: "lease-srt-release" }),
        );
      expect(() =>
        database
          .prepare(
            "UPDATE execution_environment_leases SET released_at=? WHERE environment_id=? AND scope_ref=?",
          )
          .run(T0, "environment-unreceipted", "lease-srt-release"),
      ).toThrow(/release receipt/);

      expect(() =>
        database
          .prepare(
            "INSERT INTO execution_environment_release_receipts (environment_id,basis,stop_fence,accepted_at,proof_json,authority_json) VALUES (?,?,?,?,?,?)",
          )
          .run("environment-unreceipted", "rubbish", 1, T0, PROOF, AUTHORITY),
      ).toThrow(/CHECK constraint failed/);

      insertEnvironment(database, "environment-srt-stopped", "srt-task-environment", {
        generation: 4,
      });
      insertReceipt(database, "environment-srt-stopped", "process_group_gone", PROOF);
      expect(
        database
          .prepare(
            "SELECT basis FROM execution_environment_release_receipts WHERE environment_id=?",
          )
          .pluck()
          .get("environment-srt-stopped"),
      ).toBe("process_group_gone");
      expect(database.pragma("foreign_key_check")).toEqual([]);
      expect(receiptRows(database)).toHaveLength(4);
    } finally {
      database.close();
    }
  });
});
