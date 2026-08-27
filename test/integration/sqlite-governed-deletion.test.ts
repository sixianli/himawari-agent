import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAgentId, createOwnerId } from "@himawari-agent/domain";
import {
  GOVERNED_DELETION_ERROR_CODES,
  GovernedDeletionError,
  SqliteGovernedDeletionAdapter,
  applyMigrations,
  loadBundledMigrations,
  managedDeletionArtifactPath,
  openQualifiedDatabase,
  type GovernedDeletionTarget,
} from "@himawari-agent/persistence-sqlite";
import { afterEach, describe, expect, it } from "vitest";

const OWNER_ID = createOwnerId("owner-governed-deletion");
const AGENT_ID = createAgentId("agent-governed-deletion");
const T0 = "2026-08-01T00:00:00.000Z";
const T8 = "2026-08-09T00:00:00.000Z";
const roots: string[] = [];

interface Fixture {
  readonly stateRoot: string;
  readonly databasePath: string;
  readonly payloadFile: string;
  readonly adapter: SqliteGovernedDeletionAdapter;
  failTarget(target: GovernedDeletionTarget | null): void;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function insertPayload(
  database: ReturnType<typeof openQualifiedDatabase>,
  input: { readonly ref: string; readonly relativePath?: string },
): void {
  if (input.relativePath) {
    database
      .prepare(
        `INSERT INTO payloads (
          ref, owner_id, agent_id, classification, storage_kind, ciphertext,
          ciphertext_path, content_digest, encryption_algorithm, key_ref,
          lifecycle_state, created_at, content_type
        ) VALUES (?, ?, ?, 'private', 'ciphertext_file', NULL, ?, ?,
          'fixture', 'fixture-key', 'active', ?, 'text/plain')`,
      )
      .run(input.ref, OWNER_ID, AGENT_ID, input.relativePath, `sha256:${input.ref}`, T0);
    return;
  }
  database
    .prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        ciphertext_path, content_digest, encryption_algorithm, key_ref,
        lifecycle_state, created_at, content_type
      ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', NULL, ?,
        'fixture', 'fixture-key', 'active', ?, 'text/plain')`,
    )
    .run(input.ref, OWNER_ID, AGENT_ID, `sha256:${input.ref}`, T0);
}

async function fixture(): Promise<Fixture> {
  const stateRoot = await mkdtemp(path.join(tmpdir(), "himawari-governed-deletion-"));
  roots.push(stateRoot);
  await Promise.all(
    ["data", "runtime", "cache"].map((name) =>
      mkdir(path.join(stateRoot, name), { recursive: true, mode: 0o700 }),
    ),
  );
  const databasePath = path.join(stateRoot, "data", "product.sqlite");
  const payloadRelativePath = path.join("aa", "thread-message.ciphertext");
  const payloadFile = path.join(stateRoot, "data", "payload-ciphertext", payloadRelativePath);
  await mkdir(path.dirname(payloadFile), { recursive: true, mode: 0o700 });
  await writeFile(payloadFile, "owner-content", { mode: 0o600 });

  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare(
      `INSERT INTO deployments (
        id, owner_id, agent_id, revision, status, authority_epoch, fencing_token
      ) VALUES ('deployment-governed-deletion', ?, ?, 0, 'active', 1, 1)`,
    )
    .run(OWNER_ID, AGENT_ID);
  for (const payload of [
    { ref: "payload-thread-metadata" },
    { ref: "payload-thread-message", relativePath: payloadRelativePath },
    { ref: "payload-trigger" },
    { ref: "payload-run-checkpoint" },
    { ref: "payload-trace" },
    { ref: "payload-inbox" },
    { ref: "payload-task" },
    { ref: "payload-memory" },
  ]) {
    insertPayload(database, payload);
  }
  database
    .prepare(
      `INSERT INTO threads (
        id, owner_id, agent_id, revision, status, metadata_ref, created_at, updated_at
      ) VALUES ('thread-delete', ?, ?, 0, 'open', 'payload-thread-metadata', ?, ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T0, T0);
  database
    .prepare(
      `INSERT INTO thread_messages (
        id, owner_id, agent_id, thread_id, revision, sequence, role,
        content_ref, classification, committed_at
      ) VALUES ('message-delete', ?, ?, 'thread-delete', 0, 1, 'owner',
        'payload-thread-message', 'private', ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T0);
  database
    .prepare(
      `INSERT INTO triggers (
        id, owner_id, agent_id, thread_id, idempotency_key, source_type,
        source_id, payload_ref, source_proof_ref, occurred_at
      ) VALUES ('trigger-delete', ?, ?, 'thread-delete', 'trigger-delete',
        'user_message', 'fixture', 'payload-trigger', 'fixture-proof', ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T0);
  database
    .prepare(
      `INSERT INTO runs (
        id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
        status, created_at, updated_at
      ) VALUES ('run-delete', ?, ?, 'thread-delete', 'session-delete',
        'trigger-delete', 0, 'running', ?, ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T0, T0);
  database
    .prepare(
      `INSERT INTO run_checkpoints (
        id, owner_id, agent_id, run_id, revision, phase, checkpoint_ref, created_at
      ) VALUES ('checkpoint-delete', ?, ?, 'run-delete', 0, 'fixture',
        'payload-run-checkpoint', ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T0);
  database
    .prepare(
      `INSERT INTO trace_events (
        id, owner_id, agent_id, session_id, thread_id, run_id, sequence,
        event_type, classification, payload_ref, occurred_at, recorded_at
      ) VALUES ('trace-delete', ?, ?, 'session-delete', 'thread-delete', 'run-delete', 1,
        'fixture', 'private', 'payload-trace', ?, ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T0, T0);
  database
    .prepare(
      `INSERT INTO inbox_deliveries (
        id, owner_id, agent_id, run_id, revision, result_ref, status, created_at, updated_at
      ) VALUES ('inbox-delete', ?, ?, 'run-delete', 0, 'payload-inbox', 'pending', ?, ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T0, T0);
  database
    .prepare(
      `INSERT INTO scheduled_jobs (
        id, owner_id, agent_id, thread_id, revision, status, authorization_ref,
        definition_ref, next_occurrence_at
      ) VALUES ('task-delete', ?, ?, 'thread-delete', 0, 'active', 'fixture-auth',
        'payload-task', ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T8);
  database
    .prepare(
      `INSERT INTO job_occurrences (
        id, job_id, owner_id, agent_id, stable_key, status, deployment_id,
        authority_epoch, fencing_token, attempt_count, deadline_at, run_id
      ) VALUES ('occurrence-delete', 'task-delete', ?, ?, 'occurrence-delete', 'running',
        'deployment-governed-deletion', 1, 1, 1, ?, 'run-delete')`,
    )
    .run(OWNER_ID, AGENT_ID, T8);
  database
    .prepare(
      `INSERT INTO memory_records (
        id, owner_id, agent_id, revision, status, content_ref, classification,
        source_thread_id, inference, confidence_permille, policy_version,
        provider_record_id, updated_at
      ) VALUES ('memory-retained', ?, ?, 0, 'active', 'payload-memory', 'private',
        'thread-delete', 0, 1000, 'fixture', NULL, ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T0);
  database
    .prepare(
      `INSERT INTO memory_provenance (memory_id, source_type, source_id, source_deleted)
      VALUES ('memory-retained', 'message', 'message-delete', 0)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO reliable_events (
        id, owner_id, agent_id, idempotency_key, topic, payload_ref,
        publication_state, occurred_at
      ) VALUES ('event-delete', ?, ?, 'event-delete', 'inbox.changed',
        'payload-inbox', 'pending', ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T0);
  database
    .prepare(
      `INSERT INTO audit_records (
        id, owner_id, agent_id, action, target_ref, outcome, detail_ref, occurred_at
      ) VALUES ('audit-owner-content', ?, ?, 'fixture', 'thread-delete',
        'completed', 'payload-thread-message', ?)`,
    )
    .run(OWNER_ID, AGENT_ID, T0);
  database.close();

  for (const target of ["search", "cache", "archive"] as const) {
    const artifact = managedDeletionArtifactPath(
      target === "cache" ? path.join(stateRoot, "cache") : path.join(stateRoot, "data"),
      target,
      "thread",
      "thread-delete",
    );
    await mkdir(path.dirname(artifact), { recursive: true, mode: 0o700 });
    await writeFile(artifact, `derived-${target}`, { mode: 0o600 });
  }

  let failedTarget: GovernedDeletionTarget | null = null;
  return {
    stateRoot,
    databasePath,
    payloadFile,
    adapter: new SqliteGovernedDeletionAdapter({
      stateRoot,
      databasePath,
      ownerId: OWNER_ID,
      agentId: AGENT_ID,
      now: () => T0,
      fault: (target) => {
        if (target === failedTarget) throw new Error(`fixture-${target}-failure`);
      },
    }),
    failTarget(target) {
      failedTarget = target;
    },
  };
}

function scalar(databasePath: string, sql: string, ...parameters: readonly unknown[]): unknown {
  const database = openQualifiedDatabase(databasePath);
  try {
    return database
      .prepare(sql)
      .pluck()
      .get(...parameters);
  } finally {
    database.close();
  }
}

describe("SQLite governed deletion", () => {
  it("moves a Thread to seven-day Trash and restores it without deleting source content", async () => {
    const resource = await fixture();

    const trashed = await resource.adapter.trashThread("thread-delete");
    expect(trashed).toMatchObject({
      lifecycle: "trashed",
      purgeDeadlineAt: "2026-08-08T00:00:00.000Z",
      targets: {
        search: { status: "verified" },
        cache: { status: "verified" },
        payload: { status: "retained" },
      },
      associatedTaskIds: ["task-delete"],
      pausedTaskIds: ["task-delete"],
    });
    expect(
      scalar(resource.databasePath, "SELECT status FROM threads WHERE id = ?", "thread-delete"),
    ).toBe("trashed");
    expect(scalar(resource.databasePath, "SELECT COUNT(*) FROM thread_messages")).toBe(1);
    expect(
      scalar(resource.databasePath, "SELECT status FROM scheduled_jobs WHERE id = 'task-delete'"),
    ).toBe("paused");

    const restored = await resource.adapter.restoreThread("thread-delete");
    expect(restored.lifecycle).toBe("active");
    expect(
      scalar(resource.databasePath, "SELECT status FROM threads WHERE id = ?", "thread-delete"),
    ).toBe("open");
    expect(resource.adapter.inspect("thread", "thread-delete")).toBeUndefined();
    expect(
      scalar(resource.databasePath, "SELECT status FROM scheduled_jobs WHERE id = 'task-delete'"),
    ).toBe("active");
  });

  it("uses real inactive states for task and Memory Trash and restores prior visibility", async () => {
    const resource = await fixture();

    await expect(
      resource.adapter.trashObject({ objectType: "task", objectId: "task-delete" }),
    ).resolves.toMatchObject({ lifecycle: "trashed", priorProductStatus: "active" });
    expect(
      scalar(resource.databasePath, "SELECT status FROM scheduled_jobs WHERE id = 'task-delete'"),
    ).toBe("paused");
    await resource.adapter.restoreObject({ objectType: "task", objectId: "task-delete" });
    expect(
      scalar(resource.databasePath, "SELECT status FROM scheduled_jobs WHERE id = 'task-delete'"),
    ).toBe("active");

    await expect(
      resource.adapter.trashObject({ objectType: "memory", objectId: "memory-retained" }),
    ).resolves.toMatchObject({ lifecycle: "trashed", priorProductStatus: "active" });
    expect(
      scalar(
        resource.databasePath,
        "SELECT status FROM memory_records WHERE id = 'memory-retained'",
      ),
    ).toBe("trashed");
    await resource.adapter.restoreObject({ objectType: "memory", objectId: "memory-retained" });
    expect(
      scalar(
        resource.databasePath,
        "SELECT status FROM memory_records WHERE id = 'memory-retained'",
      ),
    ).toBe("active");
  });

  it("purges a real Thread graph and converges after a managed-target failure", async () => {
    const resource = await fixture();
    resource.failTarget("archive");

    const incomplete = await resource.adapter.deleteImmediately({
      objectType: "thread",
      objectId: "thread-delete",
    });
    expect(incomplete.lifecycle).toBe("deletion_pending");
    expect(incomplete.targets.archive).toMatchObject({ status: "failed", attempts: 1 });
    expect(incomplete.externalEffectTombstoneCount).toBe(1);
    expect(scalar(resource.databasePath, "SELECT COUNT(*) FROM threads")).toBe(0);
    expect(scalar(resource.databasePath, "SELECT COUNT(*) FROM runs")).toBe(0);
    expect(scalar(resource.databasePath, "SELECT COUNT(*) FROM trace_events")).toBe(0);
    expect(scalar(resource.databasePath, "SELECT COUNT(*) FROM inbox_deliveries")).toBe(0);
    expect(scalar(resource.databasePath, "SELECT COUNT(*) FROM scheduled_jobs")).toBe(0);
    expect(scalar(resource.databasePath, "SELECT source_deleted FROM memory_provenance")).toBe(1);
    expect(scalar(resource.databasePath, "SELECT source_thread_id FROM memory_records")).toBeNull();
    expect(
      scalar(resource.databasePath, "SELECT COUNT(*) FROM payloads WHERE ref = 'payload-memory'"),
    ).toBe(1);
    expect(
      scalar(resource.databasePath, "SELECT COUNT(*) FROM payloads WHERE ref = 'payload-inbox'"),
    ).toBe(0);
    await expect(
      writeFile(resource.payloadFile, "deleted-before-derived-retry", { flag: "wx" }),
    ).resolves.toBeUndefined();
    await rm(resource.payloadFile);

    resource.failTarget(null);
    const verified = await resource.adapter.deleteImmediately({
      objectType: "thread",
      objectId: "thread-delete",
    });
    expect(verified.lifecycle).toBe("deleted_verified");
    expect(verified.targets.archive).toMatchObject({ status: "verified", attempts: 2 });
    expect(
      scalar(
        resource.databasePath,
        "SELECT COUNT(*) FROM payloads WHERE ref = 'payload-thread-message'",
      ),
    ).toBe(0);
    await expect(
      writeFile(resource.payloadFile, "recreated", { flag: "wx" }),
    ).resolves.toBeUndefined();
    const auditTombstone = String(
      scalar(
        resource.databasePath,
        `SELECT target_ref FROM audit_records
        WHERE action = 'content.deleted_external_effect_tombstone'`,
      ),
    );
    expect(auditTombstone).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(auditTombstone).not.toContain("owner-content");
  });

  it("persists Memory provider cleanup and rejects deleting a referenced Payload directly", async () => {
    const resource = await fixture();
    const database = openQualifiedDatabase(resource.databasePath);
    database
      .prepare("UPDATE memory_records SET provider_record_id = 'provider-memory-01' WHERE id = ?")
      .run("memory-retained");
    database.close();

    const pending = await resource.adapter.deleteImmediately({
      objectType: "memory",
      objectId: "memory-retained",
    });
    expect(pending).toMatchObject({
      lifecycle: "deletion_pending",
      targets: {
        product: {
          status: "failed",
          errorCode: GOVERNED_DELETION_ERROR_CODES.PROVIDER_CLEANUP_REQUIRED,
        },
      },
    });
    expect(
      scalar(
        resource.databasePath,
        "SELECT status FROM memory_records WHERE id = ?",
        "memory-retained",
      ),
    ).toBe("deletion_pending");

    await expect(
      resource.adapter.deleteImmediately({ objectType: "payload", objectId: "payload-task" }),
    ).rejects.toMatchObject({
      name: GovernedDeletionError.name,
      code: GOVERNED_DELETION_ERROR_CODES.CONFLICT,
    });
    expect(
      scalar(resource.databasePath, "SELECT COUNT(*) FROM payloads WHERE ref = 'payload-task'"),
    ).toBe(1);
  });

  it("permanently deletes a task definition and its occurrence Run graph", async () => {
    const resource = await fixture();

    const report = await resource.adapter.deleteImmediately({
      objectType: "task",
      objectId: "task-delete",
    });
    expect(report.lifecycle).toBe("deleted_verified");
    expect(scalar(resource.databasePath, "SELECT COUNT(*) FROM scheduled_jobs")).toBe(0);
    expect(scalar(resource.databasePath, "SELECT COUNT(*) FROM job_occurrences")).toBe(0);
    expect(scalar(resource.databasePath, "SELECT COUNT(*) FROM runs")).toBe(0);
    expect(scalar(resource.databasePath, "SELECT COUNT(*) FROM trace_events")).toBe(0);
    expect(scalar(resource.databasePath, "SELECT COUNT(*) FROM inbox_deliveries")).toBe(0);
    expect(
      scalar(resource.databasePath, "SELECT COUNT(*) FROM payloads WHERE ref = 'payload-task'"),
    ).toBe(0);
  });

  it("purges Trash only after its retention deadline", async () => {
    const resource = await fixture();
    await resource.adapter.trashThread("thread-delete");

    expect(await resource.adapter.purgeExpiredTrash(T0)).toEqual([]);
    const reports = await resource.adapter.purgeExpiredTrash(T8);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.lifecycle).toBe("deleted_verified");
    expect(scalar(resource.databasePath, "SELECT COUNT(*) FROM threads")).toBe(0);
  });
});
