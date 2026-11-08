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

describe("Muse intake migrations", () => {
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

  it("adds the Gmail message id column at 79, keeps existing items, and refuses ids that are not ids", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-muse-gmail-migration-"));
    temporaryDirectories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    const migrations = await loadBundledMigrations();
    applyMigrations(
      database,
      migrations.filter((migration) => migration.sequence <= 78),
    );
    database.prepare("INSERT INTO owners (id, revision) VALUES ('owner-g', 0)").run();
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('agent-g', 'owner-g', 0)")
      .run();
    database
      .prepare(
        "INSERT INTO muse_intake_batches (id, owner_id, agent_id, sender_id, batch_seq, sent_at, received_at, item_count, accepted_count, duplicate_count, conflict_count, rejected_count, dropped_field_count) VALUES ('batch-g', 'owner-g', 'agent-g', 'muse', 1, '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 1, 1, 0, 0, 0, 0)",
      )
      .run();
    const insert = (key: string, gmail?: string) =>
      database
        .prepare(
          `INSERT INTO muse_intake_items (owner_id, agent_id, kind, natural_key, state, occurred_at,
             text_withheld, options, sources, content_digest, batch_id, received_at${gmail === undefined ? "" : ", gmail_message_id"})
           VALUES ('owner-g', 'agent-g', 'proactive', ?, 'delivered', '2026-11-01T00:00:00.000Z',
             0, '[]', '{}', 'digest-old', 'batch-g', '2026-11-01T00:00:00.000Z'${gmail === undefined ? "" : ", ?"})`,
        )
        .run(...(gmail === undefined ? [key] : [key, gmail]));
    insert("old");
    const snapshot = await createVerifiedMigrationSnapshot(
      database,
      path.join(directory, "pre-migration.sqlite"),
    );
    applyMigrations(database, migrations, { snapshot });
    expect(
      database
        .prepare("SELECT natural_key AS key, gmail_message_id AS gmail FROM muse_intake_items")
        .all(),
    ).toEqual([{ key: "old", gmail: null }]);
    insert("ok", "1a1b53d1b88e9acc");
    expect(() => insert("empty", "")).toThrow();
    expect(() => insert("long", "a".repeat(257))).toThrow();
    expect(() => insert("space", "a b")).toThrow();
    database.close();
  });
});
