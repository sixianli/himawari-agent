import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  createVerifiedMigrationSnapshot,
  loadBundledMigrations,
  type MigrationDefinition,
  openQualifiedDatabase,
  readMigrationLedger,
  SQLITE_MIGRATION_ERROR_CODES,
  type SqliteDatabase,
  SqliteMigrationError,
} from "../src/index.ts";

const directories: string[] = [];
const T0 = "2026-11-01T00:00:00.000Z";
const OWNER = "owner-direct-generation";
const AGENT = "agent-direct-generation";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function beforeDirectGenerations() {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-direct-generation-"));
  directories.push(directory);
  const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
  const migrations = await loadBundledMigrations();
  const index = migrations.findIndex(({ name }) => name === "direct_memory_generations");
  expect(index).toBeGreaterThan(0);
  applyMigrations(database, migrations.slice(0, index));
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT, OWNER);
  database
    .prepare(
      `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
       VALUES ('thread-1', ?, ?, 1, 'open', ?, ?)`,
    )
    .run(OWNER, AGENT, T0, T0);
  database
    .prepare(
      `INSERT INTO thread_checkpoint_jobs (id, generation_id, owner_id, agent_id, thread_id, revision,
        source_watermark, policy_version, status, attempt_count, requested_at)
       VALUES ('checkpoint-1', 'generation-1', ?, ?, 'thread-1', 1, 1, 'p', 'completed', 1, ?)`,
    )
    .run(OWNER, AGENT, T0);
  database
    .prepare(
      `INSERT INTO memory_generations (id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
        model_descriptor_ref, policy_version, output_ref)
       VALUES ('generation-1', 'checkpoint-1', ?, ?, 'thread-1', 'completed', 'model', 'p', NULL)`,
    )
    .run(OWNER, AGENT);
  database
    .prepare(
      `INSERT INTO payloads (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at, content_type)
       VALUES ('payload-x', ?, ?, 'private', 'sqlite_blob', X'00', 'sha256:x', 'fixture', 'fixture-key', 'active', ?, 'text/plain')`,
    )
    .run(OWNER, AGENT, T0);
  database
    .prepare(
      `INSERT INTO memory_records (id, owner_id, agent_id, revision, status, content_ref,
        classification, inference, confidence_permille, policy_version, updated_at)
       VALUES ('memory-1', ?, ?, 1, 'active', 'payload-x', 'private', 0, 900, 'p', ?)`,
    )
    .run(OWNER, AGENT, T0);
  database
    .prepare(
      `INSERT INTO memory_projection_jobs (id, memory_id, memory_revision, generation_id, operation,
        status, attempt_count)
       VALUES ('job-1', 'memory-1', 1, 'generation-1', 'upsert', 'completed', 1)`,
    )
    .run();
  const snapshot = await createVerifiedMigrationSnapshot(
    database,
    path.join(directory, "snapshot.sqlite"),
  );
  return { database, migrations, index, snapshot };
}

function projectionJobs(database: SqliteDatabase) {
  return database
    .prepare("SELECT id, generation_id AS generationId FROM memory_projection_jobs")
    .all();
}

function insertDirect(database: SqliteDatabase, id: string) {
  database
    .prepare(
      `INSERT INTO memory_generations (id, checkpoint_job_id, owner_id, agent_id, thread_id, status,
        model_descriptor_ref, policy_version, output_ref)
       VALUES (?, NULL, ?, ?, NULL, 'completed', 'owner-direct', 'memory-direct.v1', NULL)`,
    )
    .run(id, OWNER, AGENT);
}

describe("direct memory generations migration", () => {
  it("[FIRST] keeps existing generations and the jobs under them, and accepts a generation with no thread", async () => {
    const { database, migrations, snapshot } = await beforeDirectGenerations();
    applyMigrations(database, migrations, { snapshot });

    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(projectionJobs(database)).toEqual([{ id: "job-1", generationId: "generation-1" }]);
    expect(
      database.prepare("SELECT id, thread_id AS threadId FROM memory_generations").all(),
    ).toEqual([{ id: "generation-1", threadId: "thread-1" }]);

    insertDirect(database, "memory-direct:owner:agent");
    expect(() =>
      database
        .prepare(
          `INSERT INTO memory_generations (id, checkpoint_job_id, owner_id, agent_id, thread_id,
            status, model_descriptor_ref, policy_version, output_ref)
           VALUES ('half', NULL, ?, ?, 'thread-1', 'completed', 'm', 'p', NULL)`,
        )
        .run(OWNER, AGENT),
    ).toThrow();
    expect(database.pragma("foreign_key_check")).toEqual([]);

    database
      .prepare(
        `INSERT INTO memory_projection_jobs (id, memory_id, memory_revision, generation_id,
          operation, status, attempt_count)
         VALUES ('job-direct', 'memory-1', 2, 'memory-direct:owner:agent', 'upsert', 'pending', 0)`,
      )
      .run();
    database.prepare("DELETE FROM threads WHERE id = 'thread-1'").run();
    expect(projectionJobs(database)).toEqual([
      { id: "job-direct", generationId: "memory-direct:owner:agent" },
    ]);
    database.close();
  });

  it("loses the child rows when the same rebuild runs without declaring it, which is why the engine needs rebuilds", async () => {
    const { database, migrations, index, snapshot } = await beforeDirectGenerations();
    const undeclared = migrations.map((migration, position) => {
      if (position !== index) return migration;
      const { rebuilds: _dropped, ...rest } = migration;
      return rest;
    });
    expect(migrations[index]?.rebuilds).toEqual(["memory_generations"]);
    applyMigrations(database, undeclared, { snapshot });
    expect(projectionJobs(database)).toEqual([]);
    database.close();
  });

  it("rolls a rebuild back and turns foreign keys on again when it leaves a broken reference", async () => {
    const { database, migrations, index, snapshot } = await beforeDirectGenerations();
    const target = migrations[index] as MigrationDefinition;
    const sql = `${target.sql}\nDELETE FROM memory_generations;\n`;
    const broken = migrations.map((migration, position) =>
      position === index
        ? { ...migration, sql, digest: createHash("sha256").update(sql).digest("hex") }
        : migration,
    );
    const before = readMigrationLedger(database).length;
    try {
      applyMigrations(database, broken, { snapshot });
      throw new Error("Expected a SqliteMigrationError");
    } catch (error) {
      expect(error).toBeInstanceOf(SqliteMigrationError);
      expect((error as SqliteMigrationError).code).toBe(
        SQLITE_MIGRATION_ERROR_CODES.INTEGRITY_CHECK_FAILED,
      );
    }
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(readMigrationLedger(database)).toHaveLength(before);
    expect(projectionJobs(database)).toEqual([{ id: "job-1", generationId: "generation-1" }]);
    expect(() => insertDirect(database, "too-early")).toThrow();
    database.close();
  });
});
