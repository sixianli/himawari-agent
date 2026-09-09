import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyMigrations,
  createVerifiedMigrationSnapshot,
  loadBundledMigrations,
  openQualifiedDatabase,
  readMigrationLedger,
} from "../src/index.ts";

const directories: string[] = [];
const T0 = "2026-09-04T00:00:00.000Z";
const OWNER_ID = "owner-checkpoint-migration";
const AGENT_ID = "agent-checkpoint-migration";
const RUN_ID = "run-checkpoint-migration";
const THREAD_ID = "thread-checkpoint-migration";
const TRACE_ID = "trace-checkpoint-migration";
const CURRENT_SCHEMA_SEQUENCE = 28;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

interface LegacyFixtureOptions {
  readonly valueJson: string;
  readonly keyRunId?: string;
  readonly rowOwnerId?: string;
  readonly rowAgentId?: string;
  readonly withoutJsonCheck?: boolean;
}

async function legacyFixture(options: LegacyFixtureOptions) {
  const directory = await mkdtemp(path.join(tmpdir(), "himawari-checkpoint-migration-"));
  directories.push(directory);
  const databasePath = path.join(directory, "product.sqlite");
  const snapshotPath = path.join(directory, "pre-migration.sqlite");
  const bundled = await loadBundledMigrations();
  const legacy = bundled.map((migration) => {
    if (migration.sequence !== 3 || !options.withoutJsonCheck) return migration;
    const sql = migration.sql.replace(
      "value_json TEXT NOT NULL CHECK (json_valid(value_json))",
      "value_json TEXT NOT NULL",
    );
    return { ...migration, sql, digest: createHash("sha256").update(sql).digest("hex") };
  });
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, legacy.slice(0, 17));
  database.prepare("INSERT INTO owners (id, revision) VALUES (?, 0)").run(OWNER_ID);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run(AGENT_ID, OWNER_ID);
  database
    .prepare("INSERT INTO owners (id, revision) VALUES (?, 0)")
    .run("owner-checkpoint-migration-other");
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0)")
    .run("agent-checkpoint-migration-other", "owner-checkpoint-migration-other");
  database
    .prepare(
      `INSERT INTO payloads (
        ref, owner_id, agent_id, classification, storage_kind, ciphertext,
        content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at
      ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'fixture',
        'fixture-key', 'active', ?)`,
    )
    .run("payload-context", OWNER_ID, AGENT_ID, "sha256:payload-context", T0);
  for (const ref of [
    "payload-worker-proto",
    "payload-worker-secondary",
    "payload-answer",
    "payload-trace",
  ]) {
    database
      .prepare(
        `INSERT INTO payloads (
          ref, owner_id, agent_id, classification, storage_kind, ciphertext,
          content_digest, encryption_algorithm, key_ref, lifecycle_state, created_at
        ) VALUES (?, ?, ?, 'private', 'sqlite_blob', X'00', ?, 'fixture',
          'fixture-key', 'active', ?)`,
      )
      .run(ref, OWNER_ID, AGENT_ID, `sha256:${ref}`, T0);
  }
  database
    .prepare(
      `INSERT INTO threads (
        id, owner_id, agent_id, revision, status, created_at, updated_at
      ) VALUES (?, ?, ?, 0, 'open', ?, ?)`,
    )
    .run(THREAD_ID, OWNER_ID, AGENT_ID, T0, T0);
  database
    .prepare(
      `INSERT INTO triggers (
        id, owner_id, agent_id, thread_id, idempotency_key, source_type,
        source_id, payload_ref, source_proof_ref, occurred_at
      ) VALUES (?, ?, ?, ?, ?, 'user_message', 'fixture', ?, 'fixture-proof', ?)`,
    )
    .run(
      "trigger-checkpoint-migration",
      OWNER_ID,
      AGENT_ID,
      THREAD_ID,
      "trigger-checkpoint-migration",
      "payload-context",
      T0,
    );
  database
    .prepare(
      `INSERT INTO runs (
        id, owner_id, agent_id, thread_id, session_id, trigger_id, revision,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'session-checkpoint-migration', ?, 1, 'running', ?, ?)`,
    )
    .run(RUN_ID, OWNER_ID, AGENT_ID, THREAD_ID, "trigger-checkpoint-migration", T0, T0);
  database
    .prepare(
      `INSERT INTO trace_events (
        id, owner_id, agent_id, session_id, thread_id, run_id, turn_id,
        sequence, event_type, classification, payload_ref, occurred_at, recorded_at
      ) VALUES (?, ?, ?, 'session-checkpoint-migration', ?, ?, NULL, 1,
        'fixture', 'private', ?, ?, ?)`,
    )
    .run(TRACE_ID, OWNER_ID, AGENT_ID, THREAD_ID, RUN_ID, "payload-trace", T0, T0);
  const keyRunId = options.keyRunId ?? RUN_ID;
  const rowOwnerId = options.rowOwnerId ?? OWNER_ID;
  const rowAgentId = options.rowAgentId ?? AGENT_ID;
  database
    .prepare(
      `INSERT INTO product_state_records (
        key, owner_id, agent_id, revision, value_json, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(`run-checkpoint:${keyRunId}`, rowOwnerId, rowAgentId, options.valueJson, T0);
  const snapshot = await createVerifiedMigrationSnapshot(database, snapshotPath);
  return { database, databasePath, bundled: legacy, snapshot, keyRunId };
}

function validCheckpointJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    phase: "runtime_settled",
    contextRef: "payload-context",
    workerResults: Object.fromEntries([
      ["__proto__", "payload-worker-proto"],
      ["worker-secondary", "payload-worker-secondary"],
    ]),
    runtimeEventCount: 7,
    lastTraceEventId: TRACE_ID,
    terminalStatus: "completed",
    output: { kind: "assistant-answer", contentRef: "payload-answer" },
    diagnosticCode: null,
    ...overrides,
  });
}

describe("Run coordination checkpoint migration", () => {
  it("backfills a real Run and Trace, preserves worker logical IDs, and removes JSON truth", async () => {
    const fixture = await legacyFixture({ valueJson: validCheckpointJson() });
    expect(
      applyMigrations(fixture.database, fixture.bundled, { snapshot: fixture.snapshot }),
    ).toEqual({
      appliedSequences: Array.from(
        { length: CURRENT_SCHEMA_SEQUENCE - 17 },
        (_, index) => index + 18,
      ),
      currentSequence: CURRENT_SCHEMA_SEQUENCE,
    });
    expect(
      fixture.database
        .prepare(
          "SELECT run_id, revision, phase, context_ref, runtime_event_count, last_trace_event_id, terminal_status, output_kind, final_answer_ref FROM run_coordination_checkpoints",
        )
        .get(),
    ).toEqual({
      run_id: RUN_ID,
      revision: 1,
      phase: "runtime_settled",
      context_ref: "payload-context",
      runtime_event_count: 7,
      last_trace_event_id: TRACE_ID,
      terminal_status: "completed",
      output_kind: "assistant-answer",
      final_answer_ref: "payload-answer",
    });
    expect(
      fixture.database
        .prepare(
          "SELECT worker_run_id, result_ref FROM run_coordination_worker_results ORDER BY worker_run_id",
        )
        .all(),
    ).toEqual([
      { worker_run_id: "__proto__", result_ref: "payload-worker-proto" },
      { worker_run_id: "worker-secondary", result_ref: "payload-worker-secondary" },
    ]);
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM product_state_records WHERE key LIKE 'run-checkpoint:%'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(fixture.database.pragma("foreign_key_check")).toEqual([]);
    fixture.database.close();
  });

  it("records a diagnostic for a successful legacy checkpoint with no output", async () => {
    const valueJson = validCheckpointJson();
    const withoutOutput = JSON.stringify(
      Object.fromEntries(Object.entries(JSON.parse(valueJson)).filter(([key]) => key !== "output")),
    );
    const fixture = await legacyFixture({ valueJson: withoutOutput });
    applyMigrations(fixture.database, fixture.bundled, { snapshot: fixture.snapshot });
    expect(
      fixture.database
        .prepare(
          "SELECT output_kind, final_answer_ref, diagnostic_code FROM run_coordination_checkpoints",
        )
        .get(),
    ).toEqual({
      output_kind: null,
      final_answer_ref: null,
      diagnostic_code: "RUNTIME_COMPLETION_OUTPUT_MISSING",
    });
    fixture.database.close();
  });

  it("rejects recreating reserved JSON checkpoint truth after migration", async () => {
    const fixture = await legacyFixture({ valueJson: validCheckpointJson() });
    applyMigrations(fixture.database, fixture.bundled, { snapshot: fixture.snapshot });
    expect(() =>
      fixture.database
        .prepare(
          `INSERT INTO product_state_records (
            key, owner_id, agent_id, revision, value_json, updated_at
          ) VALUES ('run-checkpoint:run-checkpoint-migration', ?, ?, 2, ?, ?)`,
        )
        .run(OWNER_ID, AGENT_ID, validCheckpointJson(), T0),
    ).toThrow("typed store");
    fixture.database.close();
  });

  it.each([
    {
      name: "malformed JSON",
      valueJson: "{",
      withoutJsonCheck: true,
      code: "CHECKPOINT_MIGRATION_INVALID_JSON",
    },
    {
      name: "duplicate root keys",
      valueJson: `{"phase":"runtime_settled","phase":"runtime_running","contextRef":"payload-context","workerResults":{},"runtimeEventCount":1,"lastTraceEventId":null,"terminalStatus":null}`,
      code: "CHECKPOINT_MIGRATION_DUPLICATE_FIELD",
    },
    {
      name: "duplicate worker IDs",
      valueJson: `{"phase":"runtime_settled","contextRef":null,"workerResults":{"worker":"payload-worker-proto","worker":"payload-worker-secondary"},"runtimeEventCount":1,"lastTraceEventId":null,"terminalStatus":null,"output":null,"diagnosticCode":null}`,
      code: "CHECKPOINT_MIGRATION_DUPLICATE_WORKER_ID",
    },
    {
      name: "orphan Run",
      valueJson: validCheckpointJson(),
      keyRunId: "run-missing",
      code: "CHECKPOINT_MIGRATION_RUN_SCOPE",
    },
    {
      name: "cross-scope Run",
      valueJson: validCheckpointJson({ contextRef: null, output: null, lastTraceEventId: null }),
      rowOwnerId: "owner-checkpoint-migration-other",
      rowAgentId: "agent-checkpoint-migration-other",
      code: "CHECKPOINT_MIGRATION_RUN_SCOPE",
    },
    {
      name: "missing Payload",
      valueJson: validCheckpointJson({ contextRef: "payload-missing" }),
      code: "CHECKPOINT_MIGRATION_PAYLOAD_SCOPE",
    },
    {
      name: "unsafe integer",
      valueJson: validCheckpointJson({ runtimeEventCount: 9007199254740992 }),
      code: "CHECKPOINT_MIGRATION_UNSAFE_INTEGER",
    },
    {
      name: "empty diagnostic",
      valueJson: validCheckpointJson({ diagnosticCode: "" }),
      code: "CHECKPOINT_MIGRATION_EMPTY_FIELD",
    },
    {
      name: "Trace from another Run",
      valueJson: validCheckpointJson({ lastTraceEventId: "trace-other-run" }),
      code: "CHECKPOINT_MIGRATION_TRACE_SCOPE",
    },
  ] as const)("fails closed and rolls back for $name", async (testCase) => {
    const fixture = await legacyFixture(testCase);
    expect(() =>
      applyMigrations(fixture.database, fixture.bundled, { snapshot: fixture.snapshot }),
    ).toThrow(new RegExp(testCase.code));
    expect(readMigrationLedger(fixture.database).at(-1)?.sequence).toBe(17);
    expect(
      fixture.database
        .prepare("SELECT COUNT(*) AS count FROM product_state_records WHERE key = ?")
        .get(`run-checkpoint:${fixture.keyRunId}`),
    ).toEqual({ count: 1 });
    expect(
      fixture.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_coordination_checkpoints'",
        )
        .get(),
    ).toBeUndefined();
    fixture.database.close();
  });
});
