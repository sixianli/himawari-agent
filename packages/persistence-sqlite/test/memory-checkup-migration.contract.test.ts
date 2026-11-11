import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { applyMigrations, loadBundledMigrations, openQualifiedDatabase } from "../src/index.ts";

const directories: string[] = [];
const T0 = "2026-11-08T15:00:00.000Z";
const OWNER = "owner-checkup-migration";
const AGENT = "agent-checkup-migration";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("memory checkup migration", () => {
  it("[P4-6] keeps one row per memory and week, and refuses rows that cannot be undone", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-checkup-migration-"));
    directories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    applyMigrations(database, await loadBundledMigrations());
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
    for (const id of ["m-1", "m-2"]) insertMemory.run(id, OWNER, AGENT, T0);
    database.pragma("foreign_keys = ON");
    const insert = database.prepare(
      `INSERT INTO memory_checkup_items (id, owner_id, agent_id, week_start, memory_id,
        related_memory_id, reason, action, before_state, handled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("c-1", OWNER, AGENT, T0, "m-1", "m-2", "conflict", null, null, null, T0);
    insert.run(
      "c-2",
      OWNER,
      AGENT,
      T0,
      "m-2",
      null,
      "unused",
      "confirm",
      '{"tentative":false}',
      T0,
      T0,
    );
    expect(() =>
      insert.run("c-3", OWNER, AGENT, T0, "m-1", null, "unused", null, null, null, T0),
    ).toThrow();
    expect(() =>
      insert.run(
        "c-4",
        OWNER,
        AGENT,
        "2026-11-15T15:00:00.000Z",
        "m-1",
        "m-2",
        "unused",
        null,
        null,
        null,
        T0,
      ),
    ).toThrow();
    expect(() =>
      insert.run(
        "c-5",
        OWNER,
        AGENT,
        "2026-11-15T15:00:00.000Z",
        "m-1",
        null,
        "unused",
        "confirm",
        null,
        T0,
        T0,
      ),
    ).toThrow();
    expect(() =>
      insert.run(
        "c-6",
        OWNER,
        AGENT,
        "2026-11-15T15:00:00.000Z",
        "m-1",
        null,
        "stale",
        null,
        null,
        null,
        T0,
      ),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO memory_checkup_items (id, owner_id, agent_id, week_start, memory_id,
            reason, action, kept_memory_id, before_state, handled_at, created_at)
           VALUES ('c-7', ?, ?, '2026-11-15T15:00:00.000Z', 'm-1', 'unused', 'confirm', 'm-1',
             '{"tentative":false}', ?, ?)`,
        )
        .run(OWNER, AGENT, T0, T0),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `INSERT INTO memory_checkup_items (id, owner_id, agent_id, week_start, memory_id,
            reason, action, kept_memory_id, before_state, handled_at, created_at)
           VALUES ('c-8', ?, ?, '2026-11-22T15:00:00.000Z', 'm-1', 'unused', NULL, 'm-1',
             NULL, NULL, ?)`,
        )
        .run(OWNER, AGENT, T0),
    ).toThrow();
    database.prepare("DELETE FROM memory_records WHERE id = 'm-2'").run();
    expect(
      database
        .prepare("SELECT id, related_memory_id AS related FROM memory_checkup_items ORDER BY id")
        .all(),
    ).toEqual([{ id: "c-1", related: null }]);
    database.close();
  });
});
