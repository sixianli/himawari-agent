import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  assertWritableSchema,
  bundledSchemaFingerprint,
  createVerifiedMigrationSnapshot,
  describeMigrationSet,
  LATEST_MIGRATION_SEQUENCE,
  LEGACY_MIGRATION_COUNT,
  loadBundledMigrations,
  type MigrationDefinition,
  migrationSetFingerprint,
  openQualifiedDatabase,
  readMigrationLedger,
  readSchemaIdentity,
  SQLITE_MIGRATION_ERROR_CODES,
  SqliteMigrationError,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function temporaryDatabase() {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-migration-ids-"));
  temporaryDirectories.push(directory);
  return {
    databasePath: path.join(directory, "product.sqlite"),
    snapshotPath: path.join(directory, "pre-migration.sqlite"),
  };
}

function timestamped(id: string, name: string, sql: string, position: number): MigrationDefinition {
  return Object.freeze({
    id,
    sequence: position,
    name,
    changeSet: name.replace(/_/g, "-"),
    phase: "expand" as const,
    sql,
    digest: createHash("sha256").update(sql).digest("hex"),
    file: `${id}_${name}.sql`,
  }) as MigrationDefinition;
}

function withNew(
  legacy: readonly MigrationDefinition[],
  entries: readonly { id: string; name: string; sql: string }[],
): MigrationDefinition[] {
  const sorted = [...entries].sort((left, right) => (left.id < right.id ? -1 : 1));
  return [
    ...legacy,
    ...sorted.map((entry, index) =>
      timestamped(entry.id, entry.name, entry.sql, legacy.length + index + 1),
    ),
  ];
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

const first = {
  id: "20261114010000",
  name: "first_table",
  sql: "CREATE TABLE first_table (id TEXT PRIMARY KEY) STRICT;",
};
const second = {
  id: "20261114020000",
  name: "second_table",
  sql: "CREATE TABLE second_table (id TEXT PRIMARY KEY) STRICT;",
};

describe("[MIGRATION-IDS] timestamped migrations", () => {
  it("loads the legacy list first and every timestamped file after it", async () => {
    const migrations = await loadBundledMigrations();
    expect(migrations.length).toBe(LATEST_MIGRATION_SEQUENCE);
    expect(migrations.slice(0, LEGACY_MIGRATION_COUNT).map((entry) => entry.id)).toEqual(
      Array.from({ length: LEGACY_MIGRATION_COUNT }, (_, index) =>
        String(index + 1).padStart(4, "0"),
      ),
    );
    for (const entry of migrations.slice(LEGACY_MIGRATION_COUNT)) {
      expect(entry.id).toMatch(/^\d{14}$/);
    }
  });

  it("records new migrations by id and keeps the legacy rows unchanged", async () => {
    const { databasePath, snapshotPath } = await temporaryDatabase();
    const database = openQualifiedDatabase(databasePath);
    try {
      const legacy = (await loadBundledMigrations()).slice(0, LEGACY_MIGRATION_COUNT);
      applyMigrations(database, legacy);
      expect(
        database
          .prepare(
            "SELECT 1 FROM pragma_table_info('schema_migration_ledger') WHERE name = 'migration_id'",
          )
          .get(),
      ).toEqual({ "1": 1 });
      const legacyRows = readMigrationLedger(database);
      const snapshot = await createVerifiedMigrationSnapshot(database, snapshotPath);
      const result = applyMigrations(database, withNew(legacy, [first]), { snapshot });
      expect(result).toEqual({
        appliedSequences: [LEGACY_MIGRATION_COUNT + 1],
        currentSequence: LEGACY_MIGRATION_COUNT + 1,
      });
      expect(readMigrationLedger(database).slice(0, LEGACY_MIGRATION_COUNT)).toEqual(legacyRows);
      expect(
        database
          .prepare("SELECT migration_id FROM schema_migration_ledger WHERE sequence = ?")
          .pluck()
          .get(LEGACY_MIGRATION_COUNT + 1),
      ).toBe(first.id);
      expect(
        database
          .prepare("SELECT COUNT(*) FROM schema_migration_ledger WHERE migration_id IS NULL")
          .pluck()
          .get(),
      ).toBe(LEGACY_MIGRATION_COUNT);
    } finally {
      database.close();
    }
  });

  it("runs a migration that merges late with a smaller id and reaches the same set", async () => {
    const { databasePath, snapshotPath } = await temporaryDatabase();
    const database = openQualifiedDatabase(databasePath);
    try {
      const legacy = (await loadBundledMigrations()).slice(0, LEGACY_MIGRATION_COUNT);
      applyMigrations(database, legacy);
      const snapshotOne = await createVerifiedMigrationSnapshot(database, snapshotPath);
      applyMigrations(database, withNew(legacy, [second]), { snapshot: snapshotOne });
      const lateSet = withNew(legacy, [first, second]);
      expectMigrationCode(
        () => applyMigrations(database, lateSet),
        SQLITE_MIGRATION_ERROR_CODES.SNAPSHOT_REQUIRED,
      );
      const snapshotTwo = await createVerifiedMigrationSnapshot(database, `${snapshotPath}-2`);
      expect(applyMigrations(database, lateSet, { snapshot: snapshotTwo })).toEqual({
        appliedSequences: [LEGACY_MIGRATION_COUNT + 2],
        currentSequence: LEGACY_MIGRATION_COUNT + 2,
      });
      expect(
        readMigrationLedger(database)
          .slice(LEGACY_MIGRATION_COUNT)
          .map((record) => [record.sequence, record.id]),
      ).toEqual([
        [LEGACY_MIGRATION_COUNT + 1, second.id],
        [LEGACY_MIGRATION_COUNT + 2, first.id],
      ]);
      expect(readSchemaIdentity(database).fingerprint).toBe(
        describeMigrationSet(lateSet).fingerprint,
      );
      expect(applyMigrations(database, lateSet)).toEqual({
        appliedSequences: [],
        currentSequence: LEGACY_MIGRATION_COUNT + 2,
      });
    } finally {
      database.close();
    }
  });

  it("refuses a database that holds a migration this binary does not know", async () => {
    const { databasePath, snapshotPath } = await temporaryDatabase();
    const database = openQualifiedDatabase(databasePath);
    try {
      const legacy = (await loadBundledMigrations()).slice(0, LEGACY_MIGRATION_COUNT);
      applyMigrations(database, legacy);
      const snapshot = await createVerifiedMigrationSnapshot(database, snapshotPath);
      applyMigrations(database, withNew(legacy, [first, second]), { snapshot });
      expectMigrationCode(
        () => applyMigrations(database, withNew(legacy, [first])),
        SQLITE_MIGRATION_ERROR_CODES.UNKNOWN_APPLIED_MIGRATION,
      );
    } finally {
      database.close();
    }
  });

  it("refuses a writer whose count matches but whose migration set differs", async () => {
    const { databasePath, snapshotPath } = await temporaryDatabase();
    const database = openQualifiedDatabase(databasePath);
    try {
      const legacy = (await loadBundledMigrations()).slice(0, LEGACY_MIGRATION_COUNT);
      applyMigrations(database, legacy);
      const snapshot = await createVerifiedMigrationSnapshot(database, snapshotPath);
      const applied = withNew(legacy, [first]);
      applyMigrations(database, applied, { snapshot });
      const other = withNew(legacy, [second]);
      expect(() =>
        assertWritableSchema(database, other.length, describeMigrationSet(other).fingerprint),
      ).toThrow(/different set/);
      expect(() =>
        assertWritableSchema(database, applied.length, describeMigrationSet(applied).fingerprint),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("rejects duplicate or out-of-order timestamped definitions", async () => {
    const { databasePath } = await temporaryDatabase();
    const database = openQualifiedDatabase(databasePath);
    try {
      const legacy = (await loadBundledMigrations()).slice(0, LEGACY_MIGRATION_COUNT);
      const duplicate = [
        ...legacy,
        timestamped(first.id, first.name, first.sql, legacy.length + 1),
        timestamped(first.id, "other_table", second.sql, legacy.length + 2),
      ];
      expectMigrationCode(
        () => applyMigrations(database, duplicate),
        SQLITE_MIGRATION_ERROR_CODES.DEFINITION_INVALID,
      );
      const unordered = [
        ...legacy,
        timestamped(second.id, second.name, second.sql, legacy.length + 1),
        timestamped(first.id, first.name, first.sql, legacy.length + 2),
      ];
      expectMigrationCode(
        () => applyMigrations(database, unordered),
        SQLITE_MIGRATION_ERROR_CODES.DEFINITION_INVALID,
      );
    } finally {
      database.close();
    }
  });

  it("computes the same fingerprint whatever order the rows were applied in", () => {
    const one = { id: "20261114010000", digest: "a" };
    const two = { id: "20261114020000", digest: "b" };
    expect(migrationSetFingerprint([one, two])).toBe(migrationSetFingerprint([two, one]));
    expect(migrationSetFingerprint([one, two])).not.toBe(
      migrationSetFingerprint([one, { ...two, digest: "c" }]),
    );
  });

  it("computes the bundled fingerprint synchronously the same way as the loaded set", async () => {
    const migrations = await loadBundledMigrations();
    expect(bundledSchemaFingerprint()).toBe(describeMigrationSet(migrations).fingerprint);
  });

  it("refuses a file it does not recognize when computing the bundled fingerprint", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-migration-dir-"));
    try {
      await writeFile(path.join(directory, "notes.txt"), "stray");
      expect(() => bundledSchemaFingerprint(pathToFileURL(`${directory}/`))).toThrow(
        "Unrecognized file in the migration directory: notes.txt",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
