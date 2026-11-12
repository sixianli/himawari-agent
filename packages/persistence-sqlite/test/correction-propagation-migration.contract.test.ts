import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentId, OwnerId } from "@himawari-agent/domain";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  createVerifiedMigrationSnapshot,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "../src/index.ts";
import { SqliteCorrectionReviewOperations } from "../src/sqlite-correction-review-operations.ts";

const directories: string[] = [];
const OWNER = "owner-p41" as OwnerId;
const AGENT = "agent-p41" as AgentId;
const SCOPE = { ownerId: OWNER, agentId: AGENT };
const T0 = "2026-11-01T00:00:00.000Z";
const T1 = "2026-11-02T00:00:00.000Z";
const T2 = "2026-11-03T00:00:00.000Z";
const T3 = "2026-11-04T00:00:00.000Z";
const RULE = "owner:boss";
const BOSS = {
  type: "mail_must_notify",
  summary: "老板",
  params: { senderAddresses: ["a@x.com"] },
};
const NEW_BOSS = { ...BOSS, params: { senderAddresses: ["b@x.com"] } };

type Database = ReturnType<typeof openQualifiedDatabase>;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function payload(database: Database, ref: string) {
  database
    .prepare(
      `INSERT INTO payloads (ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at, content_type)
       VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'fixture', 'fixture-key', 'active', ?, 'text/plain')`,
    )
    .run(ref, OWNER, AGENT, `sha256:${ref}`, T0);
}

function memory(database: Database, id: string, category = "other") {
  payload(database, `payload:${id}`);
  database
    .prepare(
      `INSERT INTO memory_records (id, owner_id, agent_id, revision, status, content_ref,
        classification, inference, confidence_permille, policy_version, updated_at, category)
       VALUES (?, ?, ?, 1, 'active', ?, 'private', 0, 900, 'test', ?, ?)`,
    )
    .run(id, OWNER, AGENT, `payload:${id}`, T0, category);
}

let changeCount = 0;
function reflect(database: Database, memoryId: string, basis: readonly string[]) {
  changeCount += 1;
  const change = `change-${changeCount}`;
  database
    .prepare(
      `INSERT OR IGNORE INTO memory_consolidation_runs (id, owner_id, agent_id, day, trigger_run_id,
        status, model_called, started_at) VALUES ('run-1', ?, ?, '2026-11-01', 'r', 'completed', 1, ?)`,
    )
    .run(OWNER, AGENT, T0);
  database
    .prepare(
      `INSERT INTO memory_consolidation_changes (id, consolidation_id, owner_id, agent_id, memory_id,
        action, after_revision, created_at) VALUES (?, 'run-1', ?, ?, ?, 'reflect', 1, ?)`,
    )
    .run(change, OWNER, AGENT, memoryId, T0);
  const insertBasis = database.prepare(
    "INSERT INTO memory_consolidation_change_basis (change_id, position, memory_id) VALUES (?, ?, ?)",
  );
  for (const [position, upstream] of basis.entries()) insertBasis.run(change, position, upstream);
  return change;
}

function edit(database: Database, id: string, at: string) {
  const ref = `payload:${id}:${at}`;
  payload(database, ref);
  database
    .prepare(
      "UPDATE memory_records SET content_ref = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
    )
    .run(ref, at, id);
}

function rule(database: Database, source: string) {
  database
    .prepare(
      `INSERT INTO rule_book_rules (owner_id, agent_id, rule_id, revision, parameters, status, source,
        source_memory_id, updated_at) VALUES (?, ?, ?, 1, ?, 'active', 'owner sentence', ?, ?)`,
    )
    .run(OWNER, AGENT, RULE, JSON.stringify(BOSS), source, T0);
}

function ruleRow(database: Database) {
  return database
    .prepare(
      `SELECT status, revision, review_after AS reviewAfter, review_attempts AS attempts,
        suspend_reason AS suspendReason, parameters FROM rule_book_rules WHERE rule_id = ?`,
    )
    .get(RULE) as {
    status: string;
    revision: number;
    reviewAfter: string | null;
    attempts: number;
    suspendReason: string | null;
    parameters: string;
  };
}

function ledger(database: Database, kind: string) {
  return database
    .prepare(
      "SELECT outcome, reason_code AS reasonCode, subject_ref AS subjectRef FROM decision_ledger WHERE kind = ? ORDER BY rowid",
    )
    .all(kind);
}

async function openLatest() {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-p41-"));
  directories.push(directory);
  const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
  applyMigrations(database, await loadBundledMigrations());
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT, OWNER);
  const operations = new SqliteCorrectionReviewOperations(
    database,
    (code, message) => {
      throw new Error(`${code}: ${message}`);
    },
    () => undefined,
  );
  return {
    database,
    run: (operation: string, input: object) =>
      operations.execute(operation, { ...SCOPE, ...input }),
  };
}

function openItems(database: Database) {
  return database
    .prepare(
      `SELECT memory_id AS memoryId, upstream_memory_id AS upstream, depth, status
       FROM memory_review_items ORDER BY memory_id`,
    )
    .all();
}

describe("[P4-1] correction propagation in SQLite", () => {
  it("marks every memory down a three-level chain and leaves unrelated memories alone", async () => {
    const { database, run } = await openLatest();
    for (const id of ["m:a", "m:b", "m:c", "m:d", "m:e"]) memory(database, id);
    reflect(database, "m:b", ["m:a"]);
    reflect(database, "m:c", ["m:b"]);
    reflect(database, "m:e", ["m:d"]);
    edit(database, "m:a", T1);
    expect(openItems(database)).toEqual([
      { memoryId: "m:b", upstream: "m:a", depth: 1, status: "open" },
    ]);
    expect(run("memoryReview.expand", { now: T1, limit: 20 })).toBe(1);
    expect(openItems(database)).toEqual([
      { memoryId: "m:b", upstream: "m:a", depth: 1, status: "open" },
      { memoryId: "m:c", upstream: "m:a", depth: 2, status: "open" },
    ]);
    expect(run("memoryReview.expand", { now: T1, limit: 20 })).toBe(0);
    expect(ledger(database, "memory_review")).toEqual([
      { outcome: "flagged", reasonCode: "memory_edited", subjectRef: "m:a" },
    ]);
    database.close();
  });

  it("keeps the shortest path when a memory was reflected both from the edited memory and from one of its descendants", async () => {
    const { database, run } = await openLatest();
    for (const id of ["m:a", "m:b", "m:c", "m:d"]) memory(database, id);
    reflect(database, "m:b", ["m:a"]);
    reflect(database, "m:c", ["m:a", "m:b"]);
    reflect(database, "m:d", ["m:c"]);
    edit(database, "m:a", T1);
    while ((run("memoryReview.expand", { now: T1, limit: 20 }) as number) > 0);
    expect(openItems(database)).toEqual([
      { memoryId: "m:b", upstream: "m:a", depth: 1, status: "open" },
      { memoryId: "m:c", upstream: "m:a", depth: 1, status: "open" },
      { memoryId: "m:d", upstream: "m:a", depth: 2, status: "open" },
    ]);
    database.close();
  });

  it("does not mark memories when an unrelated field such as last use changes", async () => {
    const { database } = await openLatest();
    for (const id of ["m:a", "m:b"]) memory(database, id);
    reflect(database, "m:b", ["m:a"]);
    database
      .prepare("UPDATE memory_records SET last_used_at = ?, use_count = 3 WHERE id = 'm:a'")
      .run(T1);
    expect(openItems(database)).toEqual([]);
    database.close();
  });

  it("does not mark anything when the reflection that used the memory was undone", async () => {
    const { database } = await openLatest();
    for (const id of ["m:a", "m:b"]) memory(database, id);
    const change = reflect(database, "m:b", ["m:a"]);
    database
      .prepare("UPDATE memory_consolidation_changes SET undone_at = ? WHERE id = ?")
      .run(T0, change);
    edit(database, "m:a", T1);
    expect(openItems(database)).toEqual([]);
    database.close();
  });

  it("captures downstream memories before a hard delete removes the basis rows", async () => {
    const { database } = await openLatest();
    for (const id of ["m:a", "m:b"]) memory(database, id);
    reflect(database, "m:b", ["m:a"]);
    database.prepare("DELETE FROM memory_records WHERE id = 'm:a'").run();
    expect(openItems(database)).toEqual([
      { memoryId: "m:b", upstream: "m:a", depth: 1, status: "open" },
    ]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("counts the owner's answers on the list as agreement and keeps missed reports apart", async () => {
    const { database, run } = await openLatest();
    for (const id of ["m:a", "m:b", "m:c", "m:x"]) memory(database, id);
    reflect(database, "m:b", ["m:a"]);
    reflect(database, "m:c", ["m:a"]);
    edit(database, "m:a", T1);
    run("memoryReview.expand", { now: T1, limit: 20 });
    expect(
      run("memoryReview.resolve", { memoryId: "m:b", resolution: "owner_edited", now: T2 }),
    ).toBe(1);
    expect(
      run("memoryReview.resolve", { memoryId: "m:c", resolution: "owner_dismissed", now: T2 }),
    ).toBe(1);
    expect(
      run("memoryReview.resolve", { memoryId: "m:c", resolution: "owner_dismissed", now: T2 }),
    ).toBe(0);
    expect(
      run("memoryReview.reportMissed", { memoryId: "m:x", upstreamMemoryId: "m:a", now: T2 }),
    ).toBe(true);
    expect(
      run("memoryReview.reportMissed", { memoryId: "m:b", upstreamMemoryId: "m:a", now: T2 }),
    ).toBe(false);
    run("memoryReview.resolve", { memoryId: "m:x", resolution: "owner_edited", now: T3 });
    expect(run("memoryReview.agreement", {})).toEqual({
      handled: 2,
      agreed: 1,
      missed: 1,
      openMemories: 0,
      openRules: 0,
    });
    database.close();
  });

  it("starts with no samples so the page has nothing to show", async () => {
    const { database, run } = await openLatest();
    expect(run("memoryReview.agreement", {})).toEqual({
      handled: 0,
      agreed: 0,
      missed: 0,
      openMemories: 0,
      openRules: 0,
    });
    database.close();
  });

  it("puts the rule up for recheck when its source changes and suspends it with a suggestion", async () => {
    const { database, run } = await openLatest();
    memory(database, "m:rule", "rule");
    rule(database, "m:rule");
    edit(database, "m:rule", T1);
    expect(ruleRow(database)).toMatchObject({
      status: "needs_review",
      revision: 2,
      reviewAfter: T1,
    });
    expect(run("ruleReview.listDue", { now: T0, limit: 3 })).toEqual([]);
    const [due] = run("ruleReview.listDue", { now: T1, limit: 3 }) as { revision: number }[];
    expect(due).toMatchObject({ ruleId: RULE, revision: 2, status: "needs_review" });
    const resolve = (expectedRevision: number) =>
      run("ruleReview.resolve", {
        ruleId: RULE,
        expectedRevision,
        sourceMemoryId: "m:rule",
        sourceRevision: 2,
        resolution: { outcome: "suspended", reason: "parameters_changed", suggestion: NEW_BOSS },
        now: T2,
      });
    expect(resolve(1)).toBe(false);
    expect(resolve(2)).toBe(true);
    expect(ruleRow(database)).toMatchObject({
      status: "suspended",
      suspendReason: "parameters_changed",
      reviewAfter: null,
    });
    const [open] = run("ruleReview.listOpen", { limit: 10 }) as {
      suggestion: unknown;
      rechecking: boolean;
    }[];
    expect(open?.suggestion).toEqual(NEW_BOSS);
    expect(open?.rechecking).toBe(false);
    expect(
      run("ruleReview.act", { ruleId: RULE, expectedRevision: 3, action: "adopt", now: T3 }),
    ).toBe(true);
    expect(ruleRow(database)).toMatchObject({ status: "active", suspendReason: null });
    expect(JSON.parse(ruleRow(database).parameters)).toEqual(NEW_BOSS);
    expect(ledger(database, "rule_review")).toEqual([
      { outcome: "needs_review", reasonCode: "memory_edited", subjectRef: RULE },
      { outcome: "suspended", reasonCode: "parameters_changed", subjectRef: RULE },
      { outcome: "owner_adopted", reasonCode: "from_suspended", subjectRef: RULE },
    ]);
    expect(run("memoryReview.agreement", {})).toMatchObject({ handled: 1, agreed: 1 });
    database.close();
  });

  it("keeps a suspended rule suspended but due again when the owner edits the source once more", async () => {
    const { database, run } = await openLatest();
    memory(database, "m:rule", "rule");
    rule(database, "m:rule");
    edit(database, "m:rule", T1);
    run("ruleReview.resolve", {
      ruleId: RULE,
      expectedRevision: 2,
      sourceMemoryId: "m:rule",
      sourceRevision: 2,
      resolution: { outcome: "suspended", reason: "no_longer_standing", suggestion: null },
      now: T2,
    });
    edit(database, "m:rule", T3);
    expect(ruleRow(database)).toMatchObject({ status: "suspended", reviewAfter: T3, revision: 4 });
    expect(run("ruleReview.listDue", { now: T3, limit: 3 })).toHaveLength(1);
    database.close();
  });

  it("drops an old suggestion when the source changes again so it cannot be adopted before the new check, and writes one wait per cycle", async () => {
    const { database, run } = await openLatest();
    memory(database, "m:rule", "rule");
    rule(database, "m:rule");
    edit(database, "m:rule", T1);
    edit(database, "m:rule", T2);
    run("ruleReview.resolve", {
      ruleId: RULE,
      expectedRevision: 3,
      sourceMemoryId: "m:rule",
      sourceRevision: 3,
      resolution: { outcome: "suspended", reason: "parameters_changed", suggestion: NEW_BOSS },
      now: T2,
    });
    edit(database, "m:rule", T3);
    expect(ruleRow(database)).toMatchObject({ status: "suspended", revision: 5, reviewAfter: T3 });
    expect(
      database
        .prepare("SELECT suggestion FROM rule_book_rules WHERE rule_id = ?")
        .pluck()
        .get(RULE),
    ).toBeNull();
    expect(run("ruleReview.listOpen", { limit: 10 })).toMatchObject([
      { ruleId: RULE, status: "suspended", suggestion: null, rechecking: true },
    ]);
    expect(
      run("ruleReview.act", { ruleId: RULE, expectedRevision: 5, action: "adopt", now: T3 }),
    ).toBe(false);
    expect(ledger(database, "rule_review")).toEqual([
      { outcome: "needs_review", reasonCode: "memory_edited", subjectRef: RULE },
      { outcome: "suspended", reasonCode: "parameters_changed", subjectRef: RULE },
      { outcome: "needs_review", reasonCode: "memory_edited", subjectRef: RULE },
    ]);
    database.close();
  });

  it("stores a failed attempt whose reason is that the source memory could not be read", async () => {
    const { database, run } = await openLatest();
    memory(database, "m:rule", "rule");
    rule(database, "m:rule");
    edit(database, "m:rule", T1);
    expect(
      run("ruleReview.recordFailure", {
        ruleId: RULE,
        expectedRevision: 2,
        reason: "source_unreadable",
        retryAfter: T2,
        now: T1,
      }),
    ).toBe(true);
    expect(
      database
        .prepare("SELECT review_failure FROM rule_book_rules WHERE rule_id = ?")
        .pluck()
        .get(RULE),
    ).toBe("source_unreadable");
    expect(ruleRow(database)).toMatchObject({ status: "needs_review", attempts: 1 });
    database.close();
  });

  it("opens a handled memory again when its upstream changes once more, directly or down the chain", async () => {
    const { database, run } = await openLatest();
    for (const id of ["m:a", "m:b", "m:c"]) memory(database, id);
    reflect(database, "m:b", ["m:a"]);
    reflect(database, "m:c", ["m:b"]);
    edit(database, "m:a", T1);
    run("memoryReview.expand", { now: T1, limit: 20 });
    run("memoryReview.resolve", { memoryId: "m:b", resolution: "owner_dismissed", now: T2 });
    run("memoryReview.resolve", { memoryId: "m:c", resolution: "owner_dismissed", now: T2 });
    expect(openItems(database).map((row) => (row as { status: string }).status)).toEqual([
      "resolved",
      "resolved",
    ]);
    edit(database, "m:a", T3);
    run("memoryReview.expand", { now: T3, limit: 20 });
    expect(openItems(database)).toEqual([
      { memoryId: "m:b", upstream: "m:a", depth: 1, status: "open" },
      { memoryId: "m:c", upstream: "m:a", depth: 2, status: "open" },
    ]);
    database.close();
  });

  it("stops retrying after three failures, records it once and keeps the rule enforced", async () => {
    const { database, run } = await openLatest();
    memory(database, "m:rule", "rule");
    rule(database, "m:rule");
    edit(database, "m:rule", T1);
    for (let attempt = 0; attempt < 4; attempt += 1)
      run("ruleReview.recordFailure", {
        ruleId: RULE,
        expectedRevision: 2,
        reason: "model_failed",
        retryAfter: T1,
        now: T1,
      });
    expect(ruleRow(database)).toMatchObject({ status: "needs_review", attempts: 4 });
    expect(run("ruleReview.listDue", { now: T3, limit: 3 })).toEqual([]);
    expect(run("ruleReview.listOpen", { limit: 10 })).toMatchObject([
      { ruleId: RULE, status: "needs_review", rechecking: false },
    ]);
    expect(
      ledger(database, "rule_review").filter(
        (row) => (row as { outcome: string }).outcome === "recheck_failed",
      ),
    ).toHaveLength(1);
    database.close();
  });

  it("does not count the owner's answer on a rule the system never judged", async () => {
    const { database, run } = await openLatest();
    memory(database, "m:rule", "rule");
    rule(database, "m:rule");
    edit(database, "m:rule", T1);
    expect(
      run("ruleReview.act", { ruleId: RULE, expectedRevision: 2, action: "adopt", now: T2 }),
    ).toBe(false);
    expect(
      run("ruleReview.act", { ruleId: RULE, expectedRevision: 2, action: "restore", now: T2 }),
    ).toBe(true);
    expect(ruleRow(database)).toMatchObject({ status: "active", reviewAfter: null });
    expect(run("memoryReview.agreement", {})).toMatchObject({ handled: 0, agreed: 0 });
    database.close();
  });
});

describe("[P4-1] migration 0095 keeps existing data", () => {
  it("carries rules, decisions and pre-reviews across and makes pending rules due", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "himawari-p41-old-"));
    directories.push(directory);
    const database = openQualifiedDatabase(path.join(directory, "product.sqlite"));
    const migrations = await loadBundledMigrations();
    const sequence = migrations.findIndex(({ name }) => name === "correction_propagation");
    expect(sequence).toBeGreaterThan(0);
    applyMigrations(database, migrations.slice(0, sequence));
    database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER);
    database
      .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
      .run(AGENT, OWNER);
    database
      .prepare(
        `INSERT INTO rule_book_rules (owner_id, agent_id, rule_id, revision, parameters, status, source,
          source_memory_id, updated_at) VALUES (?, ?, ?, 2, ?, 'needs_review', 'owner sentence', 'm:rule', ?)`,
      )
      .run(OWNER, AGENT, RULE, JSON.stringify(BOSS), T1);
    database
      .prepare(
        `INSERT INTO decision_ledger (id, owner_id, agent_id, kind, checked_at, counts, outcome,
          reason_code, subject_ref, inputs, cost_micros, duration_ms)
         VALUES ('d-1', ?, ?, 'rule_review', ?, '{}', 'needs_review', 'memory_edited', ?, '{}', 0, 0)`,
      )
      .run(OWNER, AGENT, T1, RULE);
    database
      .prepare(
        `INSERT INTO decision_prereviews (id, owner_id, agent_id, decision_id, calibration_group,
          status, failure_code, model_ref, prompt_id, text_digest, data_classification, cost_micros,
          duration_ms, created_at)
         VALUES ('p-1', ?, ?, 'd-1', 'consolidation', 'failed', 'x', 'm', 'p', ?, 'private', 0, 0, ?)`,
      )
      .run(OWNER, AGENT, "0".repeat(64), T1);
    const snapshot = await createVerifiedMigrationSnapshot(
      database,
      path.join(directory, "snapshot.sqlite"),
    );
    applyMigrations(database, migrations, { snapshot });
    expect(ruleRow(database)).toMatchObject({
      status: "needs_review",
      reviewAfter: T1,
      attempts: 0,
    });
    expect(database.prepare("SELECT id FROM decision_ledger").all()).toEqual([{ id: "d-1" }]);
    expect(database.prepare("SELECT id, decision_id FROM decision_prereviews").all()).toEqual([
      { id: "p-1", decision_id: "d-1" },
    ]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(() => database.prepare("DELETE FROM decision_prereviews").run()).toThrow(
      "DECISION_PREREVIEW_IMMUTABLE",
    );
    database.close();
  });
});
