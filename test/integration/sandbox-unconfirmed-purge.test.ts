import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import {
  acquireStateRootLock,
  applyMigrations,
  loadBundledMigrations,
  openQualifiedDatabase,
} from "@himawari-agent/persistence-sqlite";
import { CONFIGURATION_SCHEMA_VERSION, initializeStateRoot } from "@himawari-agent/platform-node";
import { afterEach, describe, expect, it } from "vitest";
import { RUN_RESOURCES_RELEASED_SQL } from "../../packages/persistence-sqlite/src/sqlite-run-resource-guard.ts";
import { runAdminCli } from "../../apps/admin-cli/src/index.ts";

const OWNER = "owner-sandbox-purge";
const AGENT = "agent-sandbox-purge";
const OTHER_OWNER = "owner-sandbox-purge-other";
const OTHER_AGENT = "agent-sandbox-purge-other";
const T0 = "2026-09-20T00:00:00.000Z";
const NOW = "2026-09-26T12:00:00.000Z";
const IN_SCOPE = ["job-lost", "job-reconciling"];
const SANDBOX_TABLES = [
  "sandbox_execution_records",
  "sandbox_workspace_occupancy",
  "sandbox_workspace_barriers",
  "sandbox_execution_observations",
  "sandbox_operation_observations",
  "sandbox_execution_intents",
  "sandbox_release_receipts",
  "sandbox_reservation_release_receipts",
] as const;
const OTHER_TABLES = [
  "owners",
  "agents",
  "threads",
  "runs",
  "sandbox_admission_queue",
  "sandbox_queue_authority_bindings",
  "capability_invocation_receipts",
  "payloads",
] as const;

type Database = ReturnType<typeof openQualifiedDatabase>;
type Rows = Record<string, Record<string, unknown>[]>;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sink() {
  let value = "";
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        value += chunk.toString();
        callback();
      },
    }),
    value: () => value,
  };
}

function configuration(stateRoot: string) {
  const model = (ref: string, role: "primary" | "embedding") =>
    role === "embedding"
      ? {
          ref,
          role,
          provider: "provider-local",
          model: ref,
          version: "snapshot-1",
          capabilities: ["embedding"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          dimensions: 1536,
          allowedDataClassifications: ["public", "private", "sensitive", "restricted"],
          disclosure: "local_only",
          secretRef: null,
        }
      : {
          ref,
          role,
          provider: "provider-local",
          model: ref,
          version: "snapshot-1",
          priority: 1,
          name: "Primary fixture",
          api: "openai-completions",
          reasoning: false,
          input: ["text"],
          capabilities: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 1024,
          allowedDataClassifications: ["public", "private"],
          disclosure: "local_only",
          secretRef: null,
        };
  return {
    schemaVersion: CONFIGURATION_SCHEMA_VERSION,
    deploymentId: "deployment-sandbox-purge",
    ownerId: OWNER,
    agentId: AGENT,
    stateRoot,
    runtimeDirectory: path.join(stateRoot, "runtime"),
    cacheDirectory: path.join(stateRoot, "cache"),
    publicOrigin: "http://127.0.0.1",
    publicMode: false,
    modelDescriptors: [model("model-primary", "primary"), model("model-embedding", "embedding")],
    memory: {
      adapter: "mem0-oss",
      version: "3.3.1",
      storagePath: path.join(stateRoot, "data", "memory"),
      dimensions: 1536,
    },
    repositoryAllowlistRefs: [],
    secretReferences: [],
    budgets: {
      globalCostMicros: 0,
      perRunCostMicros: 0,
      perClassificationCostMicros: { public: 0, private: 0, sensitive: 0, restricted: 0 },
    },
    concurrency: { totalRuns: 1, foregroundReserved: 1, perCategory: {} },
    deadlines: { runMs: 1_000, workerRequestMs: 1_000, providerRequestMs: 1_000 },
  };
}

function claim(jobId: string, access: "read" | "write") {
  return {
    ref: `claim-${jobId}`,
    hostId: "host-local",
    canonicalRootId: `root-${jobId}`,
    access,
    lineage: [{ device: 1, inode: 2 }],
  };
}

function addRecord(
  database: Database,
  input: {
    readonly jobId: string;
    readonly runId: string;
    readonly threadId: string;
    readonly owner?: string;
    readonly agent?: string;
    readonly backendRef?: string;
    readonly preparation: "bound" | "legacy_bound" | "reserved";
    readonly supervision: string;
    readonly cleanup: string;
    readonly occupancyReleasedAt?: string | null;
  },
) {
  const owner = input.owner ?? OWNER;
  const agent = input.agent ?? AGENT;
  const started = input.preparation !== "reserved";
  const plan = {
    schemaVersion: "sandbox-execution.v2",
    backendRef: input.backendRef ?? "srt",
    identity: {
      jobId: input.jobId,
      ownerId: owner,
      agentId: agent,
      runId: input.runId,
      threadId: input.threadId,
      hostId: "host-local",
      toolCallId: `tool-${input.jobId}`,
    },
  };
  const facts =
    input.preparation === "reserved"
      ? { schemaVersion: "sandbox-preparation.v1", sequence: 1 }
      : {
          schemaVersion: "sandbox-execution-facts.v2",
          resource: { supervision: input.supervision, cleanup: input.cleanup, sequence: 1 },
        };
  database
    .prepare(
      `INSERT INTO sandbox_execution_records (
        job_id, attempt_id, receipt_ref, owner_id, agent_id, run_id, invocation_id,
        environment_id, resource_ref, plan_json, admission_json, start_policy_digest, started_at,
        facts_json, sequence, preparation_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, '{}', ?, ?, ?, 1, ?)`,
    )
    .run(
      input.jobId,
      `attempt-${input.jobId}`,
      `receipt-${input.jobId}`,
      owner,
      agent,
      input.runId,
      `invocation-${input.jobId}`,
      `environment-${input.jobId}`,
      JSON.stringify(plan),
      started ? "d".repeat(64) : null,
      started ? T0 : null,
      JSON.stringify(facts),
      input.preparation,
    );
  database
    .prepare(
      `INSERT INTO sandbox_workspace_occupancy (job_id, scope_ref, host_id, claim_json, released_at)
      VALUES (?, ?, 'host-local', ?, ?)`,
    )
    .run(
      input.jobId,
      `scope-${input.jobId}`,
      JSON.stringify(claim(input.jobId, "write")),
      input.occupancyReleasedAt ?? null,
    );
  database
    .prepare(
      "INSERT INTO sandbox_execution_observations (job_id, sequence, facts_json) VALUES (?, 1, ?)",
    )
    .run(input.jobId, JSON.stringify(facts));
}

function addUnresolvedControl(database: Database, jobId: string) {
  database
    .prepare(
      `INSERT INTO sandbox_workspace_barriers (job_id, barrier_id, kind, reason_code, created_at)
      VALUES (?, ?, 'control_unacknowledged', 'SANDBOX_CONTROL_ACK_PENDING', ?)`,
    )
    .run(jobId, `barrier-${jobId}`, T0);
  database
    .prepare(
      `INSERT INTO sandbox_execution_intents (
        intent_id, job_id, kind, sequence, operation_revision, authority_json, created_at, dispatched_at
      ) VALUES (?, ?, 'continue', 1, 0, '{}', ?, ?)`,
    )
    .run(`intent-${jobId}`, jobId, T0, T0);
  database
    .prepare(
      "INSERT INTO sandbox_operation_observations (job_id, revision, operation_json) VALUES (?, 1, '{}')",
    )
    .run(jobId);
}

function addAdmittedQueueEntry(database: Database, jobId: string, runId: string) {
  database
    .prepare(
      `INSERT INTO sandbox_admission_queue (
        job_id, owner_id, agent_id, run_id, host_id, handle_ref, deadline_at, status,
        request_json, claims_json
      ) VALUES (?, ?, ?, ?, 'host-local', 'handle-sandbox-purge', ?, 'admitted', '{}', '[]')`,
    )
    .run(jobId, OWNER, AGENT, runId, NOW);
}

async function prepareStateRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "himawari-sandbox-purge-cli-"));
  roots.push(root);
  const layout = await initializeStateRoot(root);
  const databasePath = path.join(layout.data, "product.sqlite");
  const database = openQualifiedDatabase(databasePath);
  applyMigrations(database, await loadBundledMigrations());
  database.pragma("foreign_keys = OFF");
  database
    .prepare("INSERT INTO owners (id, revision) VALUES (?, 0), (?, 0)")
    .run(OWNER, OTHER_OWNER);
  database
    .prepare("INSERT INTO agents (id, owner_id, revision) VALUES (?, ?, 0), (?, ?, 0)")
    .run(AGENT, OWNER, OTHER_AGENT, OTHER_OWNER);
  for (const [thread, owner, agent] of [
    ["thread-a", OWNER, AGENT],
    ["thread-b", OWNER, AGENT],
    ["thread-other", OTHER_OWNER, OTHER_AGENT],
  ] as const)
    database
      .prepare(
        `INSERT INTO threads (id, owner_id, agent_id, revision, status, created_at, updated_at)
        VALUES (?, ?, ?, 0, 'open', ?, ?)`,
      )
      .run(thread, owner, agent, T0, T0);
  for (const [run, thread, owner, agent, status] of [
    ["run-a", "thread-a", OWNER, AGENT, "reconciling_external_result"],
    ["run-b", "thread-b", OWNER, AGENT, "completed"],
    ["run-strict", "thread-b", OWNER, AGENT, "reconciling_external_result"],
    ["run-other", "thread-other", OTHER_OWNER, OTHER_AGENT, "reconciling_external_result"],
  ] as const)
    database
      .prepare(
        `INSERT INTO runs (
          id, owner_id, agent_id, thread_id, session_id, trigger_id, revision, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'session-sandbox-purge', ?, 0, ?, ?, ?)`,
      )
      .run(run, owner, agent, thread, `trigger-${run}`, status, T0, T0);

  addRecord(database, {
    jobId: "job-lost",
    runId: "run-a",
    threadId: "thread-a",
    preparation: "bound",
    supervision: "lost",
    cleanup: "unknown",
  });
  addUnresolvedControl(database, "job-lost");
  addAdmittedQueueEntry(database, "job-lost", "run-a");
  addRecord(database, {
    jobId: "job-reconciling",
    runId: "run-a",
    threadId: "thread-a",
    preparation: "legacy_bound",
    supervision: "reconciling",
    cleanup: "unknown",
  });
  addRecord(database, {
    jobId: "job-released",
    runId: "run-b",
    threadId: "thread-b",
    preparation: "bound",
    supervision: "released",
    cleanup: "process_group_gone",
    occupancyReleasedAt: T0,
  });
  database
    .prepare(
      `INSERT INTO sandbox_release_receipts (job_id, sequence, accepted_at, verification_json, authority_json)
      VALUES ('job-released', 1, ?, '{}', '{}')`,
    )
    .run(T0);
  addRecord(database, {
    jobId: "job-reserved",
    runId: "run-b",
    threadId: "thread-b",
    preparation: "reserved",
    supervision: "",
    cleanup: "",
  });
  addRecord(database, {
    jobId: "job-controlled",
    runId: "run-b",
    threadId: "thread-b",
    preparation: "bound",
    supervision: "controlled",
    cleanup: "pending",
  });
  addRecord(database, {
    jobId: "job-strict",
    runId: "run-strict",
    threadId: "thread-b",
    backendRef: "task-environment",
    preparation: "bound",
    supervision: "lost",
    cleanup: "unknown",
  });
  addRecord(database, {
    jobId: "job-other-owner",
    runId: "run-other",
    threadId: "thread-other",
    owner: OTHER_OWNER,
    agent: OTHER_AGENT,
    preparation: "bound",
    supervision: "lost",
    cleanup: "unknown",
  });
  database.close();
  const configurationPath = path.join(root, "configuration.json");
  await writeFile(configurationPath, `${JSON.stringify(configuration(root))}\n`, { mode: 0o600 });
  return { root, databasePath, configurationPath };
}

function readTables(databasePath: string, tables: readonly string[]): Rows {
  const database = openQualifiedDatabase(databasePath);
  try {
    return Object.fromEntries(
      tables.map((table) => [
        table,
        database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<
          string,
          unknown
        >[],
      ]),
    );
  } finally {
    database.close();
  }
}

function runResourcesReleased(databasePath: string, runId: string) {
  const database = openQualifiedDatabase(databasePath);
  try {
    return (
      database
        .prepare(`SELECT 1 FROM runs r WHERE r.id = @runId AND (${RUN_RESOURCES_RELEASED_SQL})`)
        .get({ runId, resourceNow: NOW }) !== undefined
    );
  } finally {
    database.close();
  }
}

async function cli(arguments_: string[]) {
  const output = sink();
  const error = sink();
  const code = await runAdminCli(arguments_, output.stream, error.stream);
  return { code, output: output.value(), error: error.value() };
}

async function list(configurationPath: string) {
  const result = await cli(["sandbox", "list-unconfirmed", "--config", configurationPath]);
  expect(result).toMatchObject({ code: 0, error: "" });
  return JSON.parse(result.output) as {
    command: string;
    digest: string;
    records: {
      jobId: string;
      runId: string;
      threadId: string | null;
      startedAt: string | null;
      directories: { hostId: string; canonicalRootId: string; access: string }[];
    }[];
    counts: Record<string, number>;
  };
}

describe("unconfirmed SRT record purge admin CLI", () => {
  it("lists exactly the unconfirmed SRT records of this agent without changing the database", async () => {
    const { databasePath, configurationPath } = await prepareStateRoot();
    const before = readTables(databasePath, [...SANDBOX_TABLES, ...OTHER_TABLES]);

    const listed = await list(configurationPath);

    expect(listed.command).toBe("sandbox.list-unconfirmed");
    expect(listed.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(listed.records).toEqual([
      {
        jobId: "job-lost",
        runId: "run-a",
        threadId: "thread-a",
        startedAt: T0,
        directories: [{ hostId: "host-local", canonicalRootId: "root-job-lost", access: "write" }],
      },
      {
        jobId: "job-reconciling",
        runId: "run-a",
        threadId: "thread-a",
        startedAt: T0,
        directories: [
          { hostId: "host-local", canonicalRootId: "root-job-reconciling", access: "write" },
        ],
      },
    ]);
    expect(listed.counts).toEqual({
      sandbox_execution_records: 2,
      sandbox_workspace_occupancy: 2,
      sandbox_workspace_barriers: 1,
      sandbox_execution_observations: 2,
      sandbox_operation_observations: 1,
      sandbox_execution_intents: 1,
    });
    expect((await list(configurationPath)).digest).toBe(listed.digest);
    expect(readTables(databasePath, [...SANDBOX_TABLES, ...OTHER_TABLES])).toEqual(before);
  });

  it("deletes nothing without the listed digest, with a stale digest or while the service holds the state root", async () => {
    const { root, databasePath, configurationPath } = await prepareStateRoot();
    const listed = await list(configurationPath);
    const purge = (digest?: string) =>
      cli([
        "sandbox",
        "purge-unconfirmed",
        "--config",
        configurationPath,
        ...(digest ? ["--digest", digest] : []),
      ]);
    const tables = [...SANDBOX_TABLES, ...OTHER_TABLES, "deletion_tombstones", "audit_records"];
    const before = readTables(databasePath, tables);

    expect(await purge()).toMatchObject({
      code: 1,
      error: expect.stringContaining("ADMIN_ARGUMENT_INVALID"),
    });
    expect(await purge(`sha256:${"0".repeat(64)}`)).toMatchObject({
      code: 1,
      error: expect.stringContaining("SANDBOX_PURGE_DIGEST_MISMATCH"),
    });
    const lock = await acquireStateRootLock(root);
    try {
      expect(await purge(listed.digest)).toMatchObject({
        code: 1,
        error: expect.stringContaining("ADMIN_TARGET_NOT_STOPPED"),
      });
    } finally {
      await lock.release();
    }
    expect(readTables(databasePath, tables)).toEqual(before);

    const database = openQualifiedDatabase(databasePath);
    database.pragma("foreign_keys = OFF");
    addRecord(database, {
      jobId: "job-lost-later",
      runId: "run-b",
      threadId: "thread-b",
      preparation: "bound",
      supervision: "lost",
      cleanup: "unknown",
    });
    database.close();
    const changed = readTables(databasePath, tables);
    expect(await purge(listed.digest)).toMatchObject({
      code: 1,
      error: expect.stringContaining("SANDBOX_PURGE_DIGEST_MISMATCH"),
    });
    expect(readTables(databasePath, tables)).toEqual(changed);
  });

  it("deletes only the listed records and their own rows, records the deletion and frees their Run", async () => {
    const { databasePath, configurationPath } = await prepareStateRoot();
    const before = readTables(databasePath, [...SANDBOX_TABLES, ...OTHER_TABLES]);
    expect(runResourcesReleased(databasePath, "run-a")).toBe(false);
    const listed = await list(configurationPath);

    const purged = await cli([
      "sandbox",
      "purge-unconfirmed",
      "--config",
      configurationPath,
      "--digest",
      listed.digest,
    ]);

    expect(purged).toMatchObject({ code: 0, error: "" });
    const [plan, result] = purged.output.trim().split("\n");
    expect(JSON.parse(plan as string)).toMatchObject({
      event: "mutation.plan",
      action: "sandbox.purge-unconfirmed",
      confirmation: listed.digest,
    });
    expect(JSON.parse(result as string)).toEqual({
      outputSchemaVersion: 1,
      command: "sandbox.purge-unconfirmed",
      digest: listed.digest,
      deletedJobIds: IN_SCOPE,
      counts: listed.counts,
    });
    const after = readTables(databasePath, [...SANDBOX_TABLES, ...OTHER_TABLES]);
    for (const table of SANDBOX_TABLES)
      expect(after[table], table).toEqual(
        before[table]?.filter((row) => !IN_SCOPE.includes(row["job_id"] as string)),
      );
    for (const table of OTHER_TABLES) expect(after[table], table).toEqual(before[table]);

    const { deletion_tombstones: tombstones, audit_records: audits } = readTables(databasePath, [
      "deletion_tombstones",
      "audit_records",
    ]);
    expect(
      tombstones?.map((row) => [row["object_type"], row["object_id"], row["status"]]).sort(),
    ).toEqual([
      ["sandbox_execution", "job-lost", "verified"],
      ["sandbox_execution", "job-reconciling", "verified"],
      ["sandbox_unconfirmed_purge", listed.digest, "verified"],
    ]);
    const summary = tombstones?.find((row) => row["object_type"] === "sandbox_unconfirmed_purge");
    expect(JSON.parse(summary?.["record_json"] as string)).toEqual({
      schemaVersion: "sandbox-unconfirmed-purge.v1",
      digest: listed.digest,
      jobIds: IN_SCOPE,
      counts: listed.counts,
    });
    const marker = tombstones?.find((row) => row["object_id"] === "job-lost");
    expect(JSON.parse(marker?.["record_json"] as string)).toMatchObject({
      schemaVersion: "sandbox-execution-deletion.v1",
      purgeDigest: listed.digest,
      plan: { identity: { jobId: "job-lost", runId: "run-a", threadId: "thread-a" } },
    });
    expect(audits).toEqual([
      expect.objectContaining({
        owner_id: OWNER,
        agent_id: AGENT,
        action: "sandbox.unconfirmed_records_deleted",
        target_ref: listed.digest,
        outcome: "completed",
        detail_ref: null,
      }),
    ]);

    expect(runResourcesReleased(databasePath, "run-a")).toBe(true);
    expect(runResourcesReleased(databasePath, "run-strict")).toBe(false);
    expect(runResourcesReleased(databasePath, "run-other")).toBe(false);
    const empty = await list(configurationPath);
    expect(empty.records).toEqual([]);
    expect(empty.digest).not.toBe(listed.digest);
  });
});
