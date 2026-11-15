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
const OWNER = "owner-suggestion-migration";
const AGENT = "agent-suggestion-migration";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("person suggestion id migration", () => {
  it("shortens ids over 128 characters and leaves short ones alone", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-suggestion-migration-"));
    directories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    const migrations = await loadBundledMigrations();
    const sequence = migrations.findIndex(({ name }) => name === "shorten_person_suggestion_ids");
    expect(sequence).toBeGreaterThan(0);
    applyMigrations(database, migrations.slice(0, sequence));
    database.pragma("foreign_keys = OFF");
    const insert = database.prepare(
      `INSERT INTO memory_person_suggestions (id, owner_id, agent_id, person_id, candidate_id,
        status, created_at, decided_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)`,
    );
    const longId = `person-suggestion:${"p".repeat(60)}:${"c".repeat(60)}`;
    expect(longId.length).toBeGreaterThan(128);
    insert.run(longId, OWNER, AGENT, "person-a", "person-b", T0);
    insert.run("person-suggestion:short", OWNER, AGENT, "person-c", "person-d", T0);

    database.pragma("foreign_keys = ON");
    const snapshot = await createVerifiedMigrationSnapshot(
      database,
      path.join(directory, "snapshot.sqlite"),
    );
    applyMigrations(database, migrations, { snapshot });

    const rows = database
      .prepare("SELECT id, person_id FROM memory_person_suggestions ORDER BY person_id")
      .all() as { id: string; person_id: string }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toMatch(/^person-suggestion:[0-9a-f]{32}$/);
    expect(rows[1]?.id).toBe("person-suggestion:short");
    database.close();
  });
});
