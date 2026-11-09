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

const directories: string[] = [];
const T0 = "2026-11-01T00:00:00.000Z";
const OWNER = "owner-reminder-migration";
const AGENT = "agent-reminder-migration";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("memory reminder cancelled migration", () => {
  it("[P1-4] keeps old reminders and lets a reminder be cancelled", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-reminder-migration-"));
    directories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    const migrations = await loadBundledMigrations();
    const sequence = migrations.findIndex(({ name }) => name === "memory_reminder_cancelled");
    expect(sequence).toBeGreaterThan(0);
    applyMigrations(database, migrations.slice(0, sequence));
    database.pragma("foreign_keys = OFF");
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT, OWNER);
    const insertMemory = database.prepare(
      `INSERT INTO memory_records (id, owner_id, agent_id, revision, status, content_ref,
        classification, inference, confidence_permille, policy_version, updated_at)
       VALUES (?, ?, ?, 1, 'active', 'payload-x', 'private', 0, 800, 'p', ?)`,
    );
    for (const id of ["m-scheduled", "m-dismissed", "m-cancelled"])
      insertMemory.run(id, OWNER, AGENT, T0);
    const insertReminder = database.prepare(
      `INSERT INTO memory_reminders (id, owner_id, agent_id, memory_id, due_at, remind_at,
        repeat, status, dismissed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'none', ?, ?, ?, ?)`,
    );
    insertReminder.run("r-1", OWNER, AGENT, "m-scheduled", T0, T0, "scheduled", null, T0, T0);
    insertReminder.run("r-2", OWNER, AGENT, "m-dismissed", T0, T0, "dismissed", T0, T0, T0);
    expect(() =>
      insertReminder.run("r-3", OWNER, AGENT, "m-cancelled", T0, T0, "cancelled", T0, T0, T0),
    ).toThrow();

    const snapshot = await createVerifiedMigrationSnapshot(
      database,
      path.join(directory, "snapshot.sqlite"),
    );
    applyMigrations(database, migrations, { snapshot });

    const rows = database
      .prepare("SELECT id, status, dismissed_at AS dismissedAt FROM memory_reminders ORDER BY id")
      .all();
    expect(rows).toEqual([
      { id: "r-1", status: "scheduled", dismissedAt: null },
      { id: "r-2", status: "dismissed", dismissedAt: T0 },
    ]);
    insertReminder.run("r-3", OWNER, AGENT, "m-cancelled", T0, T0, "cancelled", T0, T0, T0);
    expect(() =>
      insertReminder.run("r-4", OWNER, AGENT, "m-cancelled", T0, T0, "cancelled", null, T0, T0),
    ).toThrow();
    const indexes = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
      .all("memory_reminders") as { name: string }[];
    expect(indexes.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["memory_reminders_due_index", "memory_reminders_agenda_index"]),
    );
    expect(database.pragma("foreign_key_check(memory_reminders)")).toEqual([]);
    database.close();
  });
});
