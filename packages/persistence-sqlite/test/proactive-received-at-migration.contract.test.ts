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

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Proactive processed received_at migration 0076", () => {
  it("adds an optional received_at column to a database at sequence 75", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-received-at-migration-"));
    temporaryDirectories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    const migrations = await loadBundledMigrations();
    applyMigrations(
      database,
      migrations.filter((migration) => migration.sequence <= 75),
    );
    const columnsBefore = database
      .prepare("SELECT name FROM pragma_table_info('proactive_processed_messages')")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(columnsBefore).not.toContain("received_at");

    const snapshot = await createVerifiedMigrationSnapshot(
      database,
      path.join(directory, "pre-migration.sqlite"),
    );
    applyMigrations(database, migrations, { snapshot });

    const column = database
      .prepare(
        "SELECT name, type, \"notnull\" AS required FROM pragma_table_info('proactive_processed_messages') WHERE name = 'received_at'",
      )
      .get();
    expect(column).toEqual({ name: "received_at", type: "TEXT", required: 0 });
    database.close();
  });
});
