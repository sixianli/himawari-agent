import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile as readFileAsync } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";

export const MINIMUM_SQLITE_VERSION = "3.51.3" as const;
export const MIGRATION_PHASES = ["expand", "backfill", "verify", "contract"] as const;

export type MigrationPhase = (typeof MIGRATION_PHASES)[number];
export type SqliteDatabase = InstanceType<typeof BetterSqlite3>;

export const SQLITE_MIGRATION_ERROR_CODES = Object.freeze({
  DEFINITION_GAP: "SQLITE_MIGRATION_DEFINITION_GAP",
  DEFINITION_INVALID: "SQLITE_MIGRATION_DEFINITION_INVALID",
  DIGEST_MISMATCH: "SQLITE_MIGRATION_DIGEST_MISMATCH",
  UNKNOWN_APPLIED_MIGRATION: "SQLITE_MIGRATION_UNKNOWN_APPLIED",
  LEDGER_GAP: "SQLITE_MIGRATION_LEDGER_GAP",
  SNAPSHOT_REQUIRED: "SQLITE_MIGRATION_SNAPSHOT_REQUIRED",
  SNAPSHOT_INVALID: "SQLITE_MIGRATION_SNAPSHOT_INVALID",
  WRITER_TOO_OLD: "SQLITE_MIGRATION_WRITER_TOO_OLD",
  SCHEMA_NOT_CURRENT: "SQLITE_MIGRATION_SCHEMA_NOT_CURRENT",
  UNMANAGED_SCHEMA: "SQLITE_MIGRATION_UNMANAGED_SCHEMA",
  SQLITE_VERSION_UNSAFE: "SQLITE_MIGRATION_SQLITE_VERSION_UNSAFE",
  INTEGRITY_CHECK_FAILED: "SQLITE_MIGRATION_INTEGRITY_CHECK_FAILED",
} as const);

export type SqliteMigrationErrorCode =
  (typeof SQLITE_MIGRATION_ERROR_CODES)[keyof typeof SQLITE_MIGRATION_ERROR_CODES];

export class SqliteMigrationError extends Error {
  readonly code: SqliteMigrationErrorCode;
  readonly details: Readonly<Record<string, string>>;

  constructor(
    code: SqliteMigrationErrorCode,
    message: string,
    details: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "SqliteMigrationError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export interface MigrationDefinition {
  readonly sequence: number;
  readonly name: string;
  readonly changeSet: string;
  readonly phase: MigrationPhase;
  readonly sql: string;
  readonly digest: string;
}

export interface MigrationLedgerRecord {
  readonly sequence: number;
  readonly name: string;
  readonly phase: MigrationPhase;
  readonly digest: string;
  readonly appliedAt: string;
}

export interface VerifiedMigrationSnapshot {
  readonly host: string;
  readonly sourceDatabasePath: string;
  readonly snapshotPath: string;
  readonly schemaSequence: number;
  readonly digest: string;
  readonly verifiedAt: string;
}

export interface MigrationResult {
  readonly appliedSequences: readonly number[];
  readonly currentSequence: number;
}

const bundledMigrationFiles = [
  {
    sequence: 1,
    name: "initial_product_schema",
    changeSet: "initial-product-schema",
    phase: "expand" as const,
    file: "0001_initial_product_schema.sql",
  },
  {
    sequence: 2,
    name: "storage_health_samples",
    changeSet: "storage-health-samples",
    phase: "expand" as const,
    file: "0002_storage_health_samples.sql",
  },
  {
    sequence: 3,
    name: "product_state_transaction_expand",
    changeSet: "product-state-transaction",
    phase: "expand" as const,
    file: "0003_product_state_transaction_expand.sql",
  },
  {
    sequence: 4,
    name: "product_state_transaction_backfill",
    changeSet: "product-state-transaction",
    phase: "backfill" as const,
    file: "0004_product_state_transaction_backfill.sql",
  },
  {
    sequence: 5,
    name: "product_state_transaction_verify",
    changeSet: "product-state-transaction",
    phase: "verify" as const,
    file: "0005_product_state_transaction_verify.sql",
  },
  {
    sequence: 6,
    name: "product_state_transaction_contract",
    changeSet: "product-state-transaction",
    phase: "contract" as const,
    file: "0006_product_state_transaction_contract.sql",
  },
  {
    sequence: 7,
    name: "durable_repository_records",
    changeSet: "durable-repository-records",
    phase: "expand" as const,
    file: "0007_durable_repository_records.sql",
  },
  {
    sequence: 8,
    name: "payload_envelope_metadata",
    changeSet: "payload-envelope-metadata",
    phase: "expand" as const,
    file: "0008_payload_envelope_metadata.sql",
  },
  {
    sequence: 9,
    name: "durable_background_recovery",
    changeSet: "durable-background-recovery",
    phase: "expand" as const,
    file: "0009_durable_background_recovery.sql",
  },
  {
    sequence: 10,
    name: "identity_bindings",
    changeSet: "identity-bindings",
    phase: "expand" as const,
    file: "0010_identity_bindings.sql",
  },
  {
    sequence: 11,
    name: "memory_projection_reliability",
    changeSet: "memory-projection-reliability",
    phase: "expand" as const,
    file: "0011_memory_projection_reliability.sql",
  },
  {
    sequence: 12,
    name: "sensitive_memory_approvals",
    changeSet: "sensitive-memory-approvals",
    phase: "expand" as const,
    file: "0012_sensitive_memory_approvals.sql",
  },
  {
    sequence: 13,
    name: "thread_distillation",
    changeSet: "thread-distillation",
    phase: "expand" as const,
    file: "0013_thread_distillation.sql",
  },
] as const;

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function validateDefinitions(migrations: readonly MigrationDefinition[]): void {
  const phases = new Set<string>(MIGRATION_PHASES);
  const phaseOrder = new Map(MIGRATION_PHASES.map((phase, index) => [phase, index]));
  const lastPhaseByChangeSet = new Map<string, number>();
  for (const [index, migration] of migrations.entries()) {
    const expectedSequence = index + 1;
    if (migration.sequence !== expectedSequence) {
      throw new SqliteMigrationError(
        SQLITE_MIGRATION_ERROR_CODES.DEFINITION_GAP,
        `Expected migration sequence ${expectedSequence}, received ${migration.sequence}`,
        { expectedSequence: String(expectedSequence), actualSequence: String(migration.sequence) },
      );
    }
    if (
      !/^[a-z][a-z0-9_]*$/.test(migration.name) ||
      !/^[a-z][a-z0-9-]*$/.test(migration.changeSet) ||
      !phases.has(migration.phase)
    ) {
      throw new SqliteMigrationError(
        SQLITE_MIGRATION_ERROR_CODES.DEFINITION_INVALID,
        `Migration ${migration.sequence} has invalid immutable metadata`,
        { sequence: String(migration.sequence), name: migration.name, phase: migration.phase },
      );
    }
    const currentPhase = phaseOrder.get(migration.phase) ?? -1;
    const lastPhase = lastPhaseByChangeSet.get(migration.changeSet) ?? -1;
    if (currentPhase < lastPhase) {
      throw new SqliteMigrationError(
        SQLITE_MIGRATION_ERROR_CODES.DEFINITION_INVALID,
        `Migration change set ${migration.changeSet} moves backward from a later phase`,
        { sequence: String(migration.sequence), changeSet: migration.changeSet },
      );
    }
    lastPhaseByChangeSet.set(migration.changeSet, currentPhase);
    const actualDigest = sha256(migration.sql);
    if (actualDigest !== migration.digest) {
      throw new SqliteMigrationError(
        SQLITE_MIGRATION_ERROR_CODES.DIGEST_MISMATCH,
        `Migration ${migration.sequence} SQL no longer matches its digest`,
        { sequence: String(migration.sequence), expected: migration.digest, actual: actualDigest },
      );
    }
  }
}

function applicationTables(database: SqliteDatabase): readonly string[] {
  return database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => (row as { name: string }).name);
}

function ensureInternalSchema(database: SqliteDatabase): void {
  const existingTables = applicationTables(database);
  if (existingTables.length > 0 && !existingTables.includes("schema_migration_ledger")) {
    throw new SqliteMigrationError(
      SQLITE_MIGRATION_ERROR_CODES.UNMANAGED_SCHEMA,
      "Refusing to adopt a database that has product tables without a migration ledger",
      { tables: [...existingTables].sort().join(",") },
    );
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration_ledger (
      sequence INTEGER PRIMARY KEY CHECK (sequence >= 1),
      name TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('expand', 'backfill', 'verify', 'contract')),
      digest TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS schema_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
  `);
}

export function readMigrationLedger(database: SqliteDatabase): readonly MigrationLedgerRecord[] {
  const hasLedger = applicationTables(database).includes("schema_migration_ledger");
  if (!hasLedger) return [];
  return database
    .prepare(
      "SELECT sequence, name, phase, digest, applied_at AS appliedAt FROM schema_migration_ledger ORDER BY sequence",
    )
    .all() as MigrationLedgerRecord[];
}

function validateLedger(
  ledger: readonly MigrationLedgerRecord[],
  migrations: readonly MigrationDefinition[],
): void {
  for (const [index, record] of ledger.entries()) {
    const expectedSequence = index + 1;
    if (record.sequence !== expectedSequence) {
      throw new SqliteMigrationError(
        SQLITE_MIGRATION_ERROR_CODES.LEDGER_GAP,
        `Migration ledger has a gap before sequence ${record.sequence}`,
        { expectedSequence: String(expectedSequence), actualSequence: String(record.sequence) },
      );
    }
    const definition = migrations[index];
    if (!definition) {
      throw new SqliteMigrationError(
        SQLITE_MIGRATION_ERROR_CODES.UNKNOWN_APPLIED_MIGRATION,
        `Database contains unknown migration ${record.sequence}`,
        { sequence: String(record.sequence), name: record.name },
      );
    }
    if (
      definition.name !== record.name ||
      definition.phase !== record.phase ||
      definition.digest !== record.digest
    ) {
      throw new SqliteMigrationError(
        SQLITE_MIGRATION_ERROR_CODES.DIGEST_MISMATCH,
        `Applied migration ${record.sequence} does not match the immutable definition`,
        {
          sequence: String(record.sequence),
          expectedDigest: definition.digest,
          actualDigest: record.digest,
        },
      );
    }
  }
}

function readMetadataNumber(database: SqliteDatabase, key: string): number {
  const value = database
    .prepare("SELECT value FROM schema_metadata WHERE key = ?")
    .pluck()
    .get(key);
  return value === undefined ? 0 : Number(value);
}

function writeSchemaMetadata(database: SqliteDatabase, sequence: number, updatedAt: string): void {
  const statement = database.prepare(`
    INSERT INTO schema_metadata (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  statement.run("current_sequence", String(sequence), updatedAt);
  statement.run("minimum_writer_sequence", String(sequence), updatedAt);
}

function verifySnapshot(
  database: SqliteDatabase,
  snapshot: VerifiedMigrationSnapshot | undefined,
  currentSequence: number,
): void {
  if (!snapshot) {
    throw new SqliteMigrationError(
      SQLITE_MIGRATION_ERROR_CODES.SNAPSHOT_REQUIRED,
      "An existing schema must have a verified same-host snapshot before migration",
      { currentSequence: String(currentSequence) },
    );
  }
  let snapshotDigest: string;
  try {
    snapshotDigest = sha256(readFileSync(snapshot.snapshotPath));
  } catch (error) {
    throw new SqliteMigrationError(
      SQLITE_MIGRATION_ERROR_CODES.SNAPSHOT_INVALID,
      "The pre-migration snapshot cannot be read",
      { cause: error instanceof Error ? error.message : "unknown" },
    );
  }
  if (
    snapshot.host !== hostname() ||
    snapshot.sourceDatabasePath !== database.name ||
    snapshot.schemaSequence !== currentSequence ||
    snapshotDigest !== snapshot.digest
  ) {
    throw new SqliteMigrationError(
      SQLITE_MIGRATION_ERROR_CODES.SNAPSHOT_INVALID,
      "The pre-migration snapshot does not match the current database and ledger",
      {
        databasePath: database.name,
        snapshotSource: snapshot.sourceDatabasePath,
        currentSequence: String(currentSequence),
        snapshotSequence: String(snapshot.schemaSequence),
      },
    );
  }
  const snapshotDatabase = new BetterSqlite3(snapshot.snapshotPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    if (snapshotDatabase.pragma("integrity_check", { simple: true }) !== "ok") {
      throw new SqliteMigrationError(
        SQLITE_MIGRATION_ERROR_CODES.SNAPSHOT_INVALID,
        "The pre-migration snapshot failed integrity_check",
      );
    }
    const snapshotSequence = readMigrationLedger(snapshotDatabase).at(-1)?.sequence ?? 0;
    if (snapshotSequence !== snapshot.schemaSequence) {
      throw new SqliteMigrationError(
        SQLITE_MIGRATION_ERROR_CODES.SNAPSHOT_INVALID,
        "The pre-migration snapshot ledger does not match its declared sequence",
        {
          declaredSequence: String(snapshot.schemaSequence),
          actualSequence: String(snapshotSequence),
        },
      );
    }
  } finally {
    snapshotDatabase.close();
  }
}

export function applyMigrations(
  database: SqliteDatabase,
  migrations: readonly MigrationDefinition[],
  options: { readonly snapshot?: VerifiedMigrationSnapshot } = {},
): MigrationResult {
  validateDefinitions(migrations);
  ensureInternalSchema(database);
  const ledger = readMigrationLedger(database);
  validateLedger(ledger, migrations);
  const currentSequence = ledger.at(-1)?.sequence ?? 0;
  const pending = migrations.slice(currentSequence);

  if (pending.length === 0) {
    assertWritableSchema(database, migrations.length);
    return { appliedSequences: [], currentSequence };
  }
  if (currentSequence > 0) verifySnapshot(database, options.snapshot, currentSequence);

  const appliedSequences: number[] = [];
  for (const migration of pending) {
    const applyOne = database.transaction(() => {
      database.exec(migration.sql);
      const appliedAt = new Date().toISOString();
      database
        .prepare(
          "INSERT INTO schema_migration_ledger (sequence, name, phase, digest, applied_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(migration.sequence, migration.name, migration.phase, migration.digest, appliedAt);
      writeSchemaMetadata(database, migration.sequence, appliedAt);
    });
    applyOne.immediate();
    appliedSequences.push(migration.sequence);
  }

  assertWritableSchema(database, migrations.length);
  return { appliedSequences, currentSequence: migrations.length };
}

export function assertWritableSchema(database: SqliteDatabase, writerSequence: number): void {
  ensureInternalSchema(database);
  const currentSequence = readMigrationLedger(database).at(-1)?.sequence ?? 0;
  const minimumWriterSequence = readMetadataNumber(database, "minimum_writer_sequence");
  if (currentSequence > writerSequence || minimumWriterSequence > writerSequence) {
    throw new SqliteMigrationError(
      SQLITE_MIGRATION_ERROR_CODES.WRITER_TOO_OLD,
      "This binary is older than the database minimum writer sequence",
      {
        writerSequence: String(writerSequence),
        currentSequence: String(currentSequence),
        minimumWriterSequence: String(minimumWriterSequence),
      },
    );
  }
  if (currentSequence !== writerSequence) {
    throw new SqliteMigrationError(
      SQLITE_MIGRATION_ERROR_CODES.SCHEMA_NOT_CURRENT,
      "Writes are forbidden until every known migration is applied",
      { writerSequence: String(writerSequence), currentSequence: String(currentSequence) },
    );
  }
}

export function readSqliteRuntimeStatus(database: SqliteDatabase) {
  const sqliteVersion = database.prepare("SELECT sqlite_version()").pluck().get() as string;
  return Object.freeze({
    sqliteVersion,
    foreignKeys: database.pragma("foreign_keys", { simple: true }) === 1,
    journalMode: database.pragma("journal_mode", { simple: true }) as string,
    synchronous:
      database.pragma("synchronous", { simple: true }) === 2
        ? ("full" as const)
        : ("other" as const),
    busyTimeoutMs: database.pragma("busy_timeout", { simple: true }) as number,
    quickCheck: database.pragma("quick_check", { simple: true }) as string,
  });
}

export function openQualifiedDatabase(databasePath: string): SqliteDatabase {
  const database = new BetterSqlite3(path.resolve(databasePath));
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("busy_timeout = 5000");
  database.pragma("wal_autocheckpoint = 1000");
  const status = readSqliteRuntimeStatus(database);
  if (compareVersions(status.sqliteVersion, MINIMUM_SQLITE_VERSION) < 0) {
    database.close();
    throw new SqliteMigrationError(
      SQLITE_MIGRATION_ERROR_CODES.SQLITE_VERSION_UNSAFE,
      `SQLite ${status.sqliteVersion} is below the qualified minimum ${MINIMUM_SQLITE_VERSION}`,
      { sqliteVersion: status.sqliteVersion, minimum: MINIMUM_SQLITE_VERSION },
    );
  }
  if (
    !status.foreignKeys ||
    status.journalMode !== "wal" ||
    status.synchronous !== "full" ||
    status.quickCheck !== "ok"
  ) {
    database.close();
    throw new SqliteMigrationError(
      SQLITE_MIGRATION_ERROR_CODES.INTEGRITY_CHECK_FAILED,
      "SQLite runtime qualification pragmas or quick_check failed",
    );
  }
  return database;
}

export function inspectSqliteDatabaseReadOnly(databasePath: string) {
  const database = new BetterSqlite3(path.resolve(databasePath), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const tables = database
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .pluck()
      .all() as string[];
    const hasLedger = tables.includes("schema_migration_ledger");
    const ledger = hasLedger ? readMigrationLedger(database) : [];
    return Object.freeze({
      sqliteVersion: database.prepare("SELECT sqlite_version()").pluck().get() as string,
      quickCheck: database.pragma("quick_check", { simple: true }) as string,
      schemaSequence: ledger.at(-1)?.sequence ?? 0,
      migrationCount: ledger.length,
      managed: hasLedger,
      applicationTableCount: tables.length,
    });
  } finally {
    database.close();
  }
}

export async function createVerifiedMigrationSnapshot(
  database: SqliteDatabase,
  snapshotPath: string,
): Promise<VerifiedMigrationSnapshot> {
  if (database.pragma("integrity_check", { simple: true }) !== "ok") {
    throw new SqliteMigrationError(
      SQLITE_MIGRATION_ERROR_CODES.INTEGRITY_CHECK_FAILED,
      "Source database failed integrity_check before snapshot",
    );
  }
  const sourceSequence = readMigrationLedger(database).at(-1)?.sequence ?? 0;
  const absoluteSnapshotPath = path.resolve(snapshotPath);
  if (absoluteSnapshotPath === database.name) {
    throw new SqliteMigrationError(
      SQLITE_MIGRATION_ERROR_CODES.SNAPSHOT_INVALID,
      "The pre-migration snapshot must not overwrite the source database",
    );
  }
  await database.backup(absoluteSnapshotPath);
  const snapshotDatabase = new BetterSqlite3(absoluteSnapshotPath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    if (snapshotDatabase.pragma("integrity_check", { simple: true }) !== "ok") {
      throw new SqliteMigrationError(
        SQLITE_MIGRATION_ERROR_CODES.SNAPSHOT_INVALID,
        "Created snapshot failed integrity_check",
      );
    }
    const snapshotSequence = readMigrationLedger(snapshotDatabase).at(-1)?.sequence ?? 0;
    const sourceSequenceAfterBackup = readMigrationLedger(database).at(-1)?.sequence ?? 0;
    if (snapshotSequence !== sourceSequence || sourceSequenceAfterBackup !== sourceSequence) {
      throw new SqliteMigrationError(
        SQLITE_MIGRATION_ERROR_CODES.SNAPSHOT_INVALID,
        "The source schema changed while the pre-migration snapshot was created",
        {
          sourceSequence: String(sourceSequence),
          sourceSequenceAfterBackup: String(sourceSequenceAfterBackup),
          snapshotSequence: String(snapshotSequence),
        },
      );
    }
  } finally {
    snapshotDatabase.close();
  }
  return Object.freeze({
    host: hostname(),
    sourceDatabasePath: database.name,
    snapshotPath: absoluteSnapshotPath,
    schemaSequence: sourceSequence,
    digest: sha256(readFileSync(absoluteSnapshotPath)),
    verifiedAt: new Date().toISOString(),
  });
}

export async function loadBundledMigrations(): Promise<readonly MigrationDefinition[]> {
  const migrationDirectory = new URL("./migrations/", import.meta.url);
  const migrations = await Promise.all(
    bundledMigrationFiles.map(async (metadata) => {
      const sql = await readFileAsync(new URL(metadata.file, migrationDirectory), "utf8");
      return Object.freeze({ ...metadata, sql, digest: sha256(sql) });
    }),
  );
  validateDefinitions(migrations);
  return Object.freeze(migrations);
}
