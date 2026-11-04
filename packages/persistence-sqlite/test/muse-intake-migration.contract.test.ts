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

describe("Muse intake migration 0075", () => {
  it("upgrades a database at sequence 74 and keeps existing rows", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-muse-intake-migration-"));
    temporaryDirectories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    const migrations = await loadBundledMigrations();
    const before = migrations.filter((migration) => migration.sequence <= 74);
    applyMigrations(database, before);
    database.prepare("INSERT INTO owners (id, revision) VALUES ('owner-muse-up', 0)").run();
    database
      .prepare(
        "INSERT INTO agents (id, owner_id, revision) VALUES ('agent-muse-up', 'owner-muse-up', 0)",
      )
      .run();
    const tablesBefore = database
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'muse_intake_%'")
      .all();
    expect(tablesBefore).toEqual([]);

    const snapshot = await createVerifiedMigrationSnapshot(
      database,
      path.join(directory, "pre-migration.sqlite"),
    );
    applyMigrations(database, migrations, { snapshot });

    const tablesAfter = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'muse_intake_%'")
      .all()
      .map((row) => (row as { name: string }).name)
      .sort();
    expect(tablesAfter).toEqual([
      "muse_intake_batches",
      "muse_intake_channel",
      "muse_intake_conflicts",
      "muse_intake_items",
    ]);
    expect(database.prepare("SELECT id FROM agents").all()).toEqual([{ id: "agent-muse-up" }]);
    database.close();
  });
});
