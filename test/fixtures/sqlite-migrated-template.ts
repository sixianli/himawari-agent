import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import path from "node:path";
import {
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { testTemporaryRoot } from "@himawari-agent/testing/temporary-root";

let template: Promise<string> | undefined;

async function buildTemplate(): Promise<string> {
  const directory = await mkdtemp(path.join(testTemporaryRoot(), "sqlite-template-"));
  const databasePath = path.join(directory, "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  try {
    const migrations = await loadBundledMigrations();
    applyMigrations(database, migrations);
    database.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    database.close();
  }
  for (const name of await readdir(directory))
    if (name.endsWith("-wal") || name.endsWith("-shm"))
      throw new Error(`SQLITE_TEMPLATE_JOURNAL_RESIDUE: ${name}`);
  return databasePath;
}

export function migratedDatabaseTemplate(): Promise<string> {
  template ??= buildTemplate();
  return template;
}

export async function copyMigratedDatabase(databasePath: string): Promise<void> {
  await copyFile(await migratedDatabaseTemplate(), databasePath);
}
