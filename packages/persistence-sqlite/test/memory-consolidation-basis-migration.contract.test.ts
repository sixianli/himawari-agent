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
const OWNER = "owner-basis-migration";
const AGENT = "agent-basis-migration";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("memory consolidation basis migration", () => {
  it("[P1-2] fills the basis of old changes from the decision records and falls back to the change columns", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-basis-migration-"));
    directories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    const migrations = await loadBundledMigrations();
    const basisSequence = migrations.findIndex(({ name }) => name === "memory_consolidation_basis");
    expect(basisSequence).toBeGreaterThan(0);
    applyMigrations(database, migrations.slice(0, basisSequence));
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
    for (const id of ["m-a", "m-b", "m-c", "m-new"]) insertMemory.run(id, OWNER, AGENT, T0);
    database
      .prepare(
        `INSERT INTO memory_consolidation_runs (id, owner_id, agent_id, day, trigger_run_id,
          status, model_called, change_count, started_at)
         VALUES ('run-1', ?, ?, '2026-11-01', 'trigger', 'completed', 1, 3, ?)`,
      )
      .run(OWNER, AGENT, T0);
    const insertChange = database.prepare(
      `INSERT INTO memory_consolidation_changes (id, consolidation_id, owner_id, agent_id,
        memory_id, related_memory_id, action, before_revision, after_revision, created_at)
       VALUES (?, 'run-1', ?, ?, ?, ?, ?, ?, 2, ?)`,
    );
    insertChange.run("run-1:c1", OWNER, AGENT, "m-new", "m-a", "reflect", null, T0);
    insertChange.run(
      "run-1:c2",
      OWNER,
      AGENT,
      "m-b",
      "m-c",
      "merge",
      1,
      "2026-11-01T00:00:01.000Z",
    );
    insertChange.run(
      "run-1:c3",
      OWNER,
      AGENT,
      "m-c",
      null,
      "archive",
      1,
      "2026-11-01T00:00:02.000Z",
    );
    database
      .prepare(
        `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, checked_at, counts, outcome,
          reason_code, subject_ref, inputs, cost_micros, duration_ms)
         VALUES ('ledger:one', ?, ?, 'consolidation', ?, '{}', 'reflect', 'consolidation_reflect',
          'm-new', ?, 0, 0)`,
      )
      .run(
        OWNER,
        AGENT,
        T0,
        JSON.stringify({
          memoryIds: ["m-a", "m-b", "m-c"],
          ruleIds: [],
          batchId: "run-1",
          resultMemoryIds: ["m-new"],
        }),
      );
    database.pragma("foreign_keys = ON");

    const snapshot = await createVerifiedMigrationSnapshot(
      database,
      path.join(directory, "pre-basis.sqlite"),
    );
    applyMigrations(database, migrations.slice(0, basisSequence + 1), { snapshot });

    const basis = (changeId: string) =>
      database
        .prepare(
          "SELECT memory_id AS memoryId FROM memory_consolidation_change_basis WHERE change_id = ? ORDER BY position",
        )
        .all(changeId)
        .map((row) => (row as { memoryId: string }).memoryId);
    expect(basis("run-1:c1")).toEqual(["m-a", "m-b", "m-c"]);
    expect(basis("run-1:c2")).toEqual(["m-b", "m-c"]);
    expect(basis("run-1:c3")).toEqual(["m-c"]);
    expect(database.pragma("foreign_key_check(memory_consolidation_change_basis)")).toEqual([]);
  });
});
