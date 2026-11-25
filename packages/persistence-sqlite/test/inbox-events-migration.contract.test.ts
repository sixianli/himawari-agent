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
const AT = "2026-11-20T00:00:00.000Z";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("inbox_events migration", () => {
  it("carries the old think inbox rows and settings over and drops the daily counters", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-inbox-events-migration-"));
    temporaryDirectories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    const migrations = await loadBundledMigrations();
    const target = migrations.findIndex((migration) => migration.name === "inbox_events");
    expect(target).toBeGreaterThan(0);
    applyMigrations(database, migrations.slice(0, target));
    database.prepare("INSERT INTO owners (id, revision) VALUES ('owner', 0)").run();
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES ('agent', 'owner', 0)")
      .run();
    const insert = database.prepare(
      `INSERT INTO think_inbox (id, owner_id, agent_id, source_kind, source_ref, source_version,
         external_content, summary_ref, status, reason_code, attempts, day, created_at, updated_at)
       VALUES (?, 'owner', 'agent', 'email', ?, '1', 1, NULL, ?, NULL, 1, '2026-11-20', ?, ?)`,
    );
    for (const [ref, status] of [
      ["queued", "queued"],
      ["thinking", "thinking"],
      ["proposed", "proposed"],
      ["skipped", "skipped"],
      ["expired", "expired"],
      ["failed", "failed"],
    ])
      insert.run(`think:${ref}`, ref, status, AT, AT);
    database
      .prepare(
        `INSERT INTO think_inbox_declined (owner_id, agent_id, day, reason_code, declined)
         VALUES ('owner', 'agent', '2026-11-20', 'queue_full', 3)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO think_settings (owner_id, agent_id, revision, overrides, updated_at)
         VALUES ('owner', 'agent', 2, ?, ?)`,
      )
      .run(JSON.stringify({ queueLimit: 9, dailyLimit: 9, maxAttempts: 5, idleSeconds: 30 }), AT);

    const snapshot = await createVerifiedMigrationSnapshot(
      database,
      path.join(directory, "pre-migration.sqlite"),
    );
    applyMigrations(database, migrations, { snapshot });

    expect(
      database
        .prepare(
          "SELECT source_ref AS ref, status, outcome, from_owner AS fromOwner FROM inbox_events ORDER BY rowid",
        )
        .all(),
    ).toEqual([
      { ref: "queued", status: "queued", outcome: null, fromOwner: 0 },
      { ref: "thinking", status: "queued", outcome: null, fromOwner: 0 },
      { ref: "proposed", status: "done", outcome: "proposed", fromOwner: 0 },
      { ref: "skipped", status: "done", outcome: "silent", fromOwner: 0 },
      { ref: "expired", status: "done", outcome: "silent", fromOwner: 0 },
      { ref: "failed", status: "failed", outcome: null, fromOwner: 0 },
    ]);
    expect(
      JSON.parse(
        (database.prepare("SELECT overrides FROM inbox_settings").get() as { overrides: string })
          .overrides,
      ),
    ).toEqual({ maxAttempts: 5, idleSeconds: 30 });
    const names = database
      .prepare("SELECT name FROM sqlite_master")
      .all()
      .map((row) => (row as { name: string }).name);
    for (const gone of ["think_inbox", "think_inbox_declined", "think_settings", "think_inbox_day"])
      expect(names).not.toContain(gone);
    expect(names).toContain("inbox_events_queue");
    database.close();
  });
});
