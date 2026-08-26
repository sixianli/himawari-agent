import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MIGRATION_PHASES,
  SQLITE_MIGRATION_ERROR_CODES,
  SqliteMigrationError,
  applyMigrations,
  assertWritableSchema,
  createVerifiedMigrationSnapshot,
  loadBundledMigrations,
  openQualifiedDatabase,
  readMigrationLedger,
  readSqliteRuntimeStatus,
  schemaCatalog,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryDatabase() {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-sqlite-migration-"));
  temporaryDirectories.push(directory);
  return {
    directory,
    databasePath: path.join(directory, "product.sqlite"),
    snapshotPath: path.join(directory, "pre-migration.sqlite"),
  };
}

function expectMigrationCode(action: () => unknown, code: string) {
  try {
    action();
    throw new Error("Expected a SqliteMigrationError");
  } catch (error) {
    expect(error).toBeInstanceOf(SqliteMigrationError);
    expect((error as SqliteMigrationError).code).toBe(code);
  }
}

describe("immutable SQLite migration engine", () => {
  it("creates the complete normalized schema with qualified pragmas and catalog coverage", async () => {
    const { databasePath } = await temporaryDatabase();
    const database = openQualifiedDatabase(databasePath);
    const migrations = await loadBundledMigrations();

    expect(applyMigrations(database, migrations)).toEqual({
      appliedSequences: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      currentSequence: 9,
    });
    expect(readSqliteRuntimeStatus(database)).toMatchObject({
      foreignKeys: true,
      journalMode: "wal",
      synchronous: "full",
      quickCheck: "ok",
    });
    expect(readMigrationLedger(database)).toHaveLength(9);

    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => (row as { name: string }).name)
      .sort();
    expect(tables).toEqual(schemaCatalog.map(({ table }) => table).sort());
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(() =>
      database
        .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
        .run("agent-orphan", "owner-missing"),
    ).toThrow();

    database.close();
  });

  it("requires and verifies a same-host snapshot before upgrading an existing schema", async () => {
    const { databasePath, snapshotPath } = await temporaryDatabase();
    const database = openQualifiedDatabase(databasePath);
    const migrations = await loadBundledMigrations();
    applyMigrations(database, migrations.slice(0, 1));
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run("owner-01");

    expectMigrationCode(
      () => applyMigrations(database, migrations),
      SQLITE_MIGRATION_ERROR_CODES.SNAPSHOT_REQUIRED,
    );
    const snapshot = await createVerifiedMigrationSnapshot(database, snapshotPath);
    expect(applyMigrations(database, migrations, { snapshot })).toEqual({
      appliedSequences: [2, 3, 4, 5, 6, 7, 8, 9],
      currentSequence: 9,
    });
    expect(database.prepare("SELECT id FROM owners").pluck().all()).toEqual(["owner-01"]);
    expect(database.prepare("SELECT COUNT(*) FROM storage_health_samples").pluck().get()).toBe(0);

    database.close();
  });

  it("is idempotent after the schema is current", async () => {
    const { databasePath } = await temporaryDatabase();
    const database = openQualifiedDatabase(databasePath);
    const migrations = await loadBundledMigrations();
    applyMigrations(database, migrations);

    expect(applyMigrations(database, migrations)).toEqual({
      appliedSequences: [],
      currentSequence: 9,
    });

    database.close();
  });

  it("rejects definition gaps and modified historical SQL", async () => {
    const { databasePath } = await temporaryDatabase();
    const database = openQualifiedDatabase(databasePath);
    const migrations = await loadBundledMigrations();
    const secondMigration = migrations[1];
    if (!secondMigration) throw new Error("Expected a second bundled migration");

    expectMigrationCode(
      () => applyMigrations(database, [secondMigration]),
      SQLITE_MIGRATION_ERROR_CODES.DEFINITION_GAP,
    );
    applyMigrations(database, migrations);
    const modified = migrations.map((migration, index) =>
      index === 0 ? { ...migration, sql: `${migration.sql}\n-- modified` } : migration,
    );
    expectMigrationCode(
      () => applyMigrations(database, modified),
      SQLITE_MIGRATION_ERROR_CODES.DIGEST_MISMATCH,
    );
    expect(MIGRATION_PHASES).toEqual(["expand", "backfill", "verify", "contract"]);
    const invalidPhaseOrder = migrations.map((migration, index) => ({
      ...migration,
      changeSet: "same-change-set",
      phase: index === 0 ? ("backfill" as const) : ("expand" as const),
    }));
    expectMigrationCode(
      () => applyMigrations(database, invalidPhaseOrder),
      SQLITE_MIGRATION_ERROR_CODES.DEFINITION_INVALID,
    );

    database.close();
  });

  it("rejects corrupted ledger rows, unknown newer schema and an old writer", async () => {
    const { databasePath } = await temporaryDatabase();
    const database = openQualifiedDatabase(databasePath);
    const migrations = await loadBundledMigrations();
    const firstMigration = migrations[0];
    if (!firstMigration) throw new Error("Expected a first bundled migration");
    applyMigrations(database, migrations);

    database
      .prepare("UPDATE schema_migration_ledger SET digest = ? WHERE sequence = 1")
      .run("sha256-corrupted");
    expectMigrationCode(
      () => applyMigrations(database, migrations),
      SQLITE_MIGRATION_ERROR_CODES.DIGEST_MISMATCH,
    );
    database
      .prepare("UPDATE schema_migration_ledger SET digest = ? WHERE sequence = 1")
      .run(firstMigration.digest);
    expectMigrationCode(
      () => assertWritableSchema(database, 1),
      SQLITE_MIGRATION_ERROR_CODES.WRITER_TOO_OLD,
    );
    database
      .prepare(
        "INSERT INTO schema_migration_ledger (sequence, name, phase, digest, applied_at) VALUES (10, 'future', 'expand', 'sha256-future', ?)",
      )
      .run("2026-08-26T00:00:00.000Z");
    expectMigrationCode(
      () => applyMigrations(database, migrations),
      SQLITE_MIGRATION_ERROR_CODES.UNKNOWN_APPLIED_MIGRATION,
    );

    database.close();
  });

  it("bounds concurrent startup contention without leaving partial schema", async () => {
    const { databasePath } = await temporaryDatabase();
    const first = openQualifiedDatabase(databasePath);
    const second = openQualifiedDatabase(databasePath);
    const migrations = await loadBundledMigrations();

    first.exec("BEGIN IMMEDIATE");
    second.pragma("busy_timeout = 1");
    expect(() => applyMigrations(second, migrations)).toThrow();
    first.exec("ROLLBACK");

    expect(applyMigrations(second, migrations).currentSequence).toBe(9);
    expect(second.pragma("foreign_key_check")).toEqual([]);
    expect(readMigrationLedger(second)).toHaveLength(9);

    first.close();
    second.close();
  });
});
