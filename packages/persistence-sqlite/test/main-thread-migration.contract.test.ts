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
const AT = "2026-11-24T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("main_thread migration", () => {
  it("marks every existing conversation for removal and keeps old messages visible", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-main-thread-migration-"));
    temporaryDirectories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    const migrations = await loadBundledMigrations();
    const target = migrations.findIndex((migration) => migration.name === "main_thread");
    expect(target).toBeGreaterThan(0);
    applyMigrations(database, migrations.slice(0, target));
    database.prepare("INSERT INTO owners (id, revision) VALUES ('owner', 0)").run();
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('agent', 'owner', 0)")
      .run();
    database
      .prepare(
        `INSERT INTO payloads (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
           content_digest, lifecycle_state, created_at)
         VALUES ('payload', 'owner', 'agent', 'private', 'sqlite_blob', X'00', 'sha256:p', 'active', ?)`,
      )
      .run(AT);
    const insertThread = database.prepare(
      `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at, origin)
       VALUES (?, 'owner', 'agent', 1, 'open', ?, ?, ?)`,
    );
    insertThread.run("thread:owner", AT, AT, "owner");
    insertThread.run("thread:think:1", AT, AT, "think");
    database
      .prepare(
        `INSERT INTO thread_messages (id, owner_id, agent_id, thread_id, revision, sequence, role,
           content_ref, classification, committed_at)
         VALUES ('message', 'owner', 'agent', 'thread:owner', 1, 1, 'owner', 'payload', 'private', ?)`,
      )
      .run(AT);

    const snapshot = await createVerifiedMigrationSnapshot(
      database,
      path.join(directory, "pre-migration.sqlite"),
    );
    applyMigrations(database, migrations, { snapshot });

    expect(database.prepare("SELECT id, origin FROM threads ORDER BY id").all()).toEqual([
      { id: "thread:owner", origin: "legacy" },
      { id: "thread:think:1", origin: "legacy" },
    ]);
    expect(database.prepare("SELECT id, internal FROM thread_messages").all()).toEqual([
      { id: "message", internal: 0 },
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM main_threads").get()).toEqual({
      count: 0,
    });
    expect(() =>
      database.prepare("UPDATE thread_messages SET internal = 2 WHERE id = 'message'").run(),
    ).toThrow(/CHECK/);
    database.close();
  });
});
